// ============================================================
// 递归下降语法分析器
// 文法（由低到高优先级）：
//   select  -> ...
//   expr    := or
//   or      := and (OR and)*
//   and     := not (AND not)*
//   not     := NOT not | comparison
//   comp    := between/IN/LIKE/IS 谓词链
//   add     := mul ((+|-||) mul)*
//   mul     := unary ((*|/|%) unary)*
//   unary   := (+|-) unary | postfix
//   postfix := primary (IS [NOT] NULL | [NOT] IN | [NOT] BETWEEN | [NOT] LIKE)
//   primary := literal | col | CASE | CAST | func | (expr|select)
// ============================================================

import type {
  Stmt, SelectStmt, SelectItem, TableRef, JoinRef, OrderItem, Expr,
  InsertStmt, UpdateStmt, DeleteStmt, CreateTableStmt, DropTableStmt,
  CreateIndexStmt, DropIndexStmt, Pos,
} from './ast';
import type { DataType } from './types';
import { Tokenizer, type Token } from './lexer';
import { SQLError } from './types';

export class Parser {
  private tokens: Token[];
  private i = 0;

  constructor(src: string) {
    this.tokens = new Tokenizer(src).tokenize();
  }

  parseStatements(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.is('EOF')) {
      while (this.consume('SEMI')) { /* 跳过空语句 */ }
      if (this.is('EOF')) break;
      stmts.push(this.parseStatement());
      if (!this.consume('SEMI')) {
        if (!this.is('EOF')) throw this.error('expected ";" or end of input');
      }
    }
    return stmts;
  }

  private parseStatement(): Stmt {
    if (this.isKw('EXPLAIN')) {
      const pos = this.pos();
      this.next();
      return { kind: 'explain', inner: this.parseStatement(), pos };
    }
    if (this.isKw('SELECT')) return this.parseSelect();
    if (this.isKw('INSERT')) return this.parseInsert();
    if (this.isKw('UPDATE')) return this.parseUpdate();
    if (this.isKw('DELETE')) return this.parseDelete();
    if (this.isKw('CREATE')) return this.parseCreate();
    if (this.isKw('DROP')) return this.parseDrop();
    if (this.isKw('BEGIN')) return this.parseTxn('BEGIN');
    if (this.isKw('COMMIT')) return this.parseTxn('COMMIT');
    if (this.isKw('ROLLBACK')) return this.parseTxn('ROLLBACK');
    throw this.error(`unexpected token "${this.cur().value || this.cur().kind}"`);
  }

  // ---------------- SELECT ----------------
  private parseSelect(): SelectStmt {
    const pos = this.pos();
    this.expectKw('SELECT');
    let distinct = false;
    if (this.consumeKw('DISTINCT')) distinct = true;
    else if (this.consumeKw('ALL')) { /* 默认行为 */ }

    const items: SelectItem[] = [this.parseSelectItem()];
    while (this.consume('COMMA')) items.push(this.parseSelectItem());

    let from: TableRef | null = null;
    if (this.consumeKw('FROM')) from = this.parseTableRef();

    let where: Expr | null = null;
    if (this.consumeKw('WHERE')) where = this.parseExpr();

    const groupBy: Expr[] = [];
    if (this.consumeKw('GROUP')) {
      this.expectKw('BY');
      groupBy.push(this.parseExpr());
      while (this.consume('COMMA')) groupBy.push(this.parseExpr());
    }

    let having: Expr | null = null;
    if (this.consumeKw('HAVING')) having = this.parseExpr();

    const orderBy: OrderItem[] = [];
    if (this.consumeKw('ORDER')) {
      this.expectKw('BY');
      orderBy.push(this.parseOrderItem());
      while (this.consume('COMMA')) orderBy.push(this.parseOrderItem());
    }

    let limit: Expr | null = null;
    let offset: Expr | null = null;
    if (this.consumeKw('LIMIT')) {
      limit = this.parseExpr();
      if (this.consumeKw('OFFSET')) {
        offset = this.parseExpr();
      } else if (this.consume('COMMA')) {
        // LIMIT off, count
        offset = limit;
        limit = this.parseExpr();
      }
    }
    if (this.consumeKw('OFFSET')) offset = this.parseExpr();

    return { kind: 'select', distinct, items, from, where, groupBy, having, orderBy, limit, offset, pos };
  }

  private parseSelectItem(): SelectItem {
    const pos = this.pos();
    const expr = this.parseExpr();
    let alias: string | null = null;
    if (this.consumeKw('AS')) {
      alias = this.parseAliasName();
    } else if (this.is('IDENT') || (this.is('KEYWORD') && !this.reservedAsAlias())) {
      // 隐式别名：SELECT a b
      alias = this.next().value;
    }
    return { expr, alias, pos };
  }

  private reservedAsAlias(): boolean {
    // 这些关键字即使出现在选择列表也不作为隐式别名
    const t = this.cur().upper;
    return ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'AS', 'ON', 'JOIN',
      'INNER', 'LEFT', 'RIGHT', 'UNION', 'WHEN', 'THEN', 'ELSE', 'END'].includes(t);
  }

  private parseAliasName(): string {
    const t = this.cur();
    if (t.kind === 'STRING') { this.next(); return t.value; }
    if (t.kind === 'IDENT' || t.kind === 'KEYWORD') { this.next(); return t.value; }
    throw this.error('expected alias name');
  }

  private parseTableRef(): TableRef {
    let left = this.parseTableAtom();
    for (;;) {
      if (this.isKw('INNER')) {
        const pos = this.pos();
        this.next();
        this.expectKw('JOIN');
        const right = this.parseTableAtom();
        const on = this.parseJoinOn();
        left = { kind: 'join', joinType: 'INNER', left, right, on, pos };
      } else if (this.isKw('LEFT')) {
        const pos = this.pos();
        this.next();
        this.consumeKw('OUTER');
        this.expectKw('JOIN');
        const right = this.parseTableAtom();
        const on = this.parseJoinOn();
        left = { kind: 'join', joinType: 'LEFT', left, right, on, pos };
      } else if (this.isKw('JOIN')) {
        const pos = this.pos();
        this.next();
        const right = this.parseTableAtom();
        const on = this.parseJoinOn();
        left = { kind: 'join', joinType: 'INNER', left, right, on, pos };
      } else if (this.consume('COMMA')) {
        // 隐式交叉连接（INNER JOIN ON TRUE 语义）
        const pos = this.pos();
        const right = this.parseTableAtom();
        left = { kind: 'join', joinType: 'INNER', left, right, on: null, pos };
      } else {
        break;
      }
    }
    return left;
  }

  private parseJoinOn(): Expr | null {
    if (this.consumeKw('ON')) return this.parseExpr();
    return null; // 无 ON 条件 => 笛卡尔积
  }

  private parseTableAtom(): TableRef {
    const pos = this.pos();
    if (this.consume('LPAREN')) {
      // 括号内可以是表连接或子查询
      if (this.isKw('SELECT')) {
        const sub = this.parseSelect();
        this.expect('RPAREN');
        let alias: string;
        if (this.consumeKw('AS')) alias = this.parseAliasName();
        else if (this.is('IDENT')) alias = this.next().value;
        else throw this.error('subquery in FROM must have an alias');
        return { kind: 'subquery', subquery: sub, alias, pos };
      }
      const inner = this.parseTableRef();
      this.expect('RPAREN');
      return inner;
    }
    if (this.isKw('SELECT')) {
      throw this.error('subquery in FROM must be wrapped in parentheses');
    }
    const name = this.parseName();
    let alias: string | null = null;
    if (this.consumeKw('AS')) alias = this.parseAliasName();
    else if (this.is('IDENT')) alias = this.next().value;
    return { kind: 'table', name, alias, pos };
  }

  private parseOrderItem(): OrderItem {
    const pos = this.pos();
    const expr = this.parseExpr();
    let desc = false;
    let nulls: OrderItem['nulls'] = null;
    if (this.consumeKw('ASC')) desc = false;
    else if (this.consumeKw('DESC')) desc = true;
    if (this.consumeKw('NULLS')) {
      if (this.consumeKw('FIRST')) nulls = 'FIRST';
      else { this.expectKw('LAST'); nulls = 'LAST'; }
    }
    return { expr, desc, nulls, pos };
  }

  // ---------------- INSERT ----------------
  private parseInsert(): InsertStmt {
    const pos = this.pos();
    this.expectKw('INSERT');
    this.expectKw('INTO');
    const table = this.parseName();

    let columns: string[] | null = null;
    if (this.consume('LPAREN')) {
      columns = [this.parseName()];
      while (this.consume('COMMA')) columns.push(this.parseName());
      this.expect('RPAREN');
    }

    let values: Expr[][] | null = null;
    let select: SelectStmt | null = null;
    if (this.consumeKw('VALUES')) {
      values = [this.parseValueList()];
      while (this.consume('COMMA')) values.push(this.parseValueList());
    } else if (this.isKw('SELECT')) {
      select = this.parseSelect();
    } else {
      throw this.error('expected VALUES or SELECT in INSERT');
    }
    return { kind: 'insert', table, columns, values, select, pos };
  }

  private parseValueList(): Expr[] {
    this.expect('LPAREN');
    const list = [this.parseExpr()];
    while (this.consume('COMMA')) list.push(this.parseExpr());
    this.expect('RPAREN');
    return list;
  }

  // ---------------- UPDATE ----------------
  private parseUpdate(): UpdateStmt {
    const pos = this.pos();
    this.expectKw('UPDATE');
    const table = this.parseName();
    this.expectKw('SET');
    const sets = [this.parseSetItem()];
    while (this.consume('COMMA')) sets.push(this.parseSetItem());
    let where: Expr | null = null;
    if (this.consumeKw('WHERE')) where = this.parseExpr();
    return { kind: 'update', table, sets, where, pos };
  }

  private parseSetItem() {
    const pos = this.pos();
    const column = this.parseName();
    this.expectOp('=');
    const value = this.parseExpr();
    return { column, value, pos };
  }

  // ---------------- DELETE ----------------
  private parseDelete(): DeleteStmt {
    const pos = this.pos();
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const table = this.parseName();
    let where: Expr | null = null;
    if (this.consumeKw('WHERE')) where = this.parseExpr();
    return { kind: 'delete', table, where, pos };
  }

  // ---------------- DDL ----------------
  private parseCreate(): Stmt {
    const pos = this.pos();
    this.expectKw('CREATE');
    if (this.consumeKw('UNIQUE')) {
      this.expectKw('INDEX');
      return this.parseCreateIndex(pos, true);
    }
    if (this.consumeKw('TABLE')) {
      const ifNotExists = this.consumeIfNotExists();
      const name = this.parseName();
      this.expect('LPAREN');
      const cols: CreateTableStmt['columns'] = [];
      let tablePrimaryKey: string[] | null = null;
      do {
        if (this.isKw('PRIMARY')) {
          this.next(); this.expectKw('KEY');
          this.expect('LPAREN');
          const pkCols = [this.parseName()];
          while (this.consume('COMMA')) pkCols.push(this.parseName());
          this.expect('RPAREN');
          if (pkCols.length > 1) throw this.error('only single-column primary keys are supported');
          tablePrimaryKey = pkCols;
        } else {
          cols.push(this.parseColumnDef());
        }
      } while (this.consume('COMMA'));
      this.expect('RPAREN');
      return { kind: 'createTable', name, ifNotExists, columns: cols, tablePrimaryKey, pos };
    }
    if (this.consumeKw('INDEX')) return this.parseCreateIndex(pos, false);
    throw this.error('expected TABLE or INDEX after CREATE');
  }

  private consumeIfNotExists(): boolean {
    if (this.isKw('IF')) {
      this.next(); this.expectKw('NOT'); this.expectKw('EXISTS');
      return true;
    }
    return false;
  }

  private parseColumnDef(): CreateTableStmt['columns'][number] {
    const name = this.parseName();
    const type = this.parseType();
    let primaryKey = false;
    let autoincrement = false;
    let notNull = false;
    let unique = false;
    // 列约束循环
    for (;;) {
      if (this.consumeKw('PRIMARY')) {
        this.expectKw('KEY');
        primaryKey = true;
        if (this.consumeKw('AUTOINCREMENT')) autoincrement = true;
      } else if (this.consumeKw('NOT')) {
        this.expectKw('NULL');
        notNull = true;
      } else if (this.consumeKw('UNIQUE')) {
        unique = true;
      } else if (this.consumeKw('NULL')) {
        // 显式 NULL 表示可空
      } else if (this.consumeKw('DEFAULT')) {
        // 跳过默认值表达式（解析一个 primary 即可）
        this.parseExpr();
      } else if (this.consumeKw('CHECK')) {
        this.expect('LPAREN');
        // CHECK(...) 内可能有括号，直接跳过到匹配的右括号
        let depth = 1;
        while (depth > 0 && !this.is('EOF')) {
          if (this.consume('LPAREN')) depth++;
          else if (this.consume('RPAREN')) depth--;
          else this.next();
        }
      } else {
        break;
      }
    }
    return { name, type, primaryKey, autoincrement, notNull, unique };
  }

  private parseType(): DataType {
    const t = this.cur();
    if (t.kind !== 'KEYWORD' && t.kind !== 'IDENT') {
      throw this.error('expected column type (INTEGER/REAL/TEXT/BOOLEAN)');
    }
    const name = t.upper;
    this.next();
    // 吞掉可选的 (n) / (p,s)
    if (this.consume('LPAREN')) {
      let depth = 1;
      while (depth > 0 && !this.is('EOF')) {
        if (this.consume('LPAREN')) depth++;
        else if (this.consume('RPAREN')) depth--;
        else this.next();
      }
    }
    const aliases: Record<string, DataType> = {
      INT: 'INTEGER', INTEGER: 'INTEGER', SMALLINT: 'INTEGER', BIGINT: 'INTEGER',
      TINYINT: 'INTEGER', NUMERIC: 'REAL', DECIMAL: 'REAL', REAL: 'REAL',
      FLOAT: 'REAL', DOUBLE: 'REAL', 'TEXT': 'TEXT', VARCHAR: 'TEXT', CHAR: 'TEXT',
      BOOLEAN: 'BOOLEAN', BOOL: 'BOOLEAN',
    };
    if (!(name in aliases)) throw this.errorAt(t, `unknown data type "${t.value}"`);
    return aliases[name];
  }

  private parseCreateIndex(pos: Pos, unique: boolean): CreateIndexStmt {
    const ifNotExists = this.consumeIfNotExists();
    const name = this.parseName();
    this.expectKw('ON');
    const table = this.parseName();
    this.expect('LPAREN');
    const column = this.parseName();
    if (this.consume('COMMA')) throw this.error('only single-column indexes are supported');
    this.expect('RPAREN');
    return { kind: 'createIndex', name, table, column, unique, ifNotExists, pos };
  }

  private parseDrop(): Stmt {
    const pos = this.pos();
    this.expectKw('DROP');
    if (this.consumeKw('TABLE')) {
      const ifExists = this.consumeIfExists();
      const name = this.parseName();
      const d: DropTableStmt = { kind: 'dropTable', name, ifExists, pos };
      return d;
    }
    if (this.consumeKw('INDEX')) {
      const ifExists = this.consumeIfExists();
      const name = this.parseName();
      const d: DropIndexStmt = { kind: 'dropIndex', name, ifExists, pos };
      return d;
    }
    throw this.error('expected TABLE or INDEX after DROP');
  }

  private consumeIfExists(): boolean {
    if (this.isKw('IF')) {
      this.next(); this.expectKw('EXISTS');
      return true;
    }
    return false;
  }

  private parseTxn(op: 'BEGIN' | 'COMMIT' | 'ROLLBACK'): Stmt {
    const pos = this.pos();
    this.next();
    this.consumeKw('TRANSACTION');
    return { kind: 'txn', op, pos };
  }

  // ---------------- 表达式 ----------------
  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKw('OR')) {
      const pos = this.pos();
      this.next();
      const right = this.parseAnd();
      left = { kind: 'logical', op: 'OR', left, right, pos };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKw('AND')) {
      const pos = this.pos();
      this.next();
      const right = this.parseNot();
      left = { kind: 'logical', op: 'AND', left, right, pos };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.consumeKw('NOT')) {
      const pos = this.pos();
      return { kind: 'not', expr: this.parseNot(), pos };
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Expr {
    let expr = this.parseAdd();
    for (;;) {
      const pos = this.pos();
      // IS [NOT] NULL / IS [NOT] TRUE / IS [NOT] FALSE
      if (this.consumeKw('IS')) {
        const neg = this.consumeKw('NOT');
        if (this.consumeKw('NULL')) {
          expr = { kind: 'isNull', expr, negated: neg, pos };
        } else if (this.isKw('TRUE') || this.isKw('FALSE')) {
          const want = this.next().upper === 'TRUE';
          expr = { kind: 'isBoolean', expr, negated: neg, want, pos };
        } else {
          throw this.error('expected NULL/TRUE/FALSE after IS');
        }
        continue;
      }

      // [NOT] BETWEEN
      let neg = false;
      if (this.isKw('NOT') && this.tokens[this.i + 1]?.upper === 'BETWEEN') {
        this.next(); neg = true;
      }
      if (this.consumeKw('BETWEEN')) {
        const low = this.parseAdd();
        this.expectKw('AND');
        const high = this.parseAdd();
        expr = { kind: 'between', expr, negated: neg, low, high, pos };
        continue;
      }
      if (neg) throw this.error('expected BETWEEN after NOT');

      // [NOT] IN
      neg = false;
      if (this.isKw('NOT') && this.tokens[this.i + 1]?.upper === 'IN') {
        this.next(); neg = true;
      }
      if (this.consumeKw('IN')) {
        if (this.consume('LPAREN')) {
          if (this.isKw('SELECT')) {
            const sub = this.parseSelect();
            this.expect('RPAREN');
            expr = { kind: 'inSubquery', expr, negated: neg, subquery: sub, pos };
          } else {
            const list = [this.parseExpr()];
            while (this.consume('COMMA')) list.push(this.parseExpr());
            this.expect('RPAREN');
            expr = { kind: 'inList', expr, negated: neg, list, pos };
          }
        } else {
          throw this.error('expected "(" after IN');
        }
        continue;
      }

      // [NOT] LIKE
      neg = false;
      if (this.isKw('NOT') && this.tokens[this.i + 1]?.upper === 'LIKE') {
        this.next(); neg = true;
      }
      if (this.consumeKw('LIKE')) {
        const pattern = this.parseAdd();
        expr = { kind: 'like', expr, negated: neg, pattern, pos };
        continue;
      }

      // 比较操作符
      if (this.isOp(['=', '<>', '<', '<=', '>', '>=', '!='])) {
        const opTok = this.next();
        const op = (opTok.value === '!=' ? '<>' : opTok.value) as
          '=' | '<>' | '<' | '<=' | '>' | '>=';
        const right = this.parseAdd();
        expr = { kind: 'binary', op, left: expr, right, pos };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.isOp(['+', '-', '||'])) {
      const pos = this.pos();
      const opTok = this.next();
      if (opTok.value === '||') throw this.errorAt(opTok, 'string concatenation "||" is not supported (use explicit CAST if needed)');
      const right = this.parseMul();
      left = { kind: 'binary', op: opTok.value as '+' | '-', left, right, pos };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (this.isOp(['/', '%']) || this.is('STAR')) {
      const pos = this.pos();
      const tok = this.next();
      const op = (tok.kind === 'STAR' ? '*' : tok.value) as '*' | '/' | '%';
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right, pos };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp(['+', '-'])) {
      const pos = this.pos();
      const op = this.next().value as '+' | '-';
      return { kind: 'unary', op, expr: this.parseUnary(), pos };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.cur();
    const pos = this.pos();

    if (t.kind === 'NUMBER') {
      this.next();
      const value = t.value.includes('.') || /[eE]/.test(t.value)
        ? parseFloat(t.value)
        : parseInt(t.value, 10);
      if (Number.isNaN(value)) throw this.errorAt(t, `invalid number literal "${t.value}"`);
      return { kind: 'literal', value, pos };
    }
    if (t.kind === 'STRING') {
      this.next();
      return { kind: 'literal', value: t.value, pos };
    }
    if (t.kind === 'KEYWORD' && (t.upper === 'TRUE' || t.upper === 'FALSE')) {
      this.next();
      return { kind: 'literal', value: t.upper === 'TRUE', pos };
    }
    if (t.kind === 'KEYWORD' && t.upper === 'NULL') {
      this.next();
      return { kind: 'literal', value: null, pos };
    }
    if (t.kind === 'LPAREN') {
      this.next();
      if (this.isKw('SELECT')) {
        const sub = this.parseSelect();
        this.expect('RPAREN');
        return { kind: 'scalarSubquery', subquery: sub, pos };
      }
      const e = this.parseExpr();
      this.expect('RPAREN');
      return e;
    }
    if (this.isKw('CASE')) return this.parseCase();
    if (this.isKw('CAST')) return this.parseCast();
    if (this.isKw('EXISTS')) {
      this.next();
      this.expect('LPAREN');
      const sub = this.parseSelect();
      this.expect('RPAREN');
      return { kind: 'exists', negated: false, subquery: sub, pos };
    }
    if (this.isKw('NOT') && this.tokens[this.i + 1]?.upper === 'EXISTS') {
      this.next(); this.next();
      this.expect('LPAREN');
      const sub = this.parseSelect();
      this.expect('RPAREN');
      return { kind: 'exists', negated: true, subquery: sub, pos };
    }

    // 标识符：列引用 或 函数调用
    if (t.kind === 'IDENT' || (t.kind === 'KEYWORD' && this.isFuncName(t.upper))) {
      return this.parseIdentOrFunc();
    }
    if (t.kind === 'STAR') {
      this.next();
      return { kind: 'star', table: null, pos };
    }

    throw this.error(`unexpected token "${t.value || t.kind}"`);
  }

  private isFuncName(upper: string): boolean {
    return ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(upper);
  }

  private parseIdentOrFunc(): Expr {
    const t = this.next();
    const pos = this.posOf(t);
    // 函数调用？
    if (this.is('LPAREN') && (t.kind === 'IDENT' || this.isFuncName(t.upper))) {
      const name = t.upper;
      this.next();
      const distinct = this.consumeKw('DISTINCT');
      let star = false;
      const args: Expr[] = [];
      if (this.consume('STAR')) {
        star = true;
      } else if (!this.is('RPAREN')) {
        args.push(this.parseExpr());
        while (this.consume('COMMA')) args.push(this.parseExpr());
      }
      this.expect('RPAREN');
      if (this.isFuncName(name)) {
        return { kind: 'func', name, distinct, args, star, pos };
      }
      throw this.errorAt(t, `unknown function "${t.value}" (supported: COUNT/SUM/AVG/MIN/MAX)`);
    }
    // 普通列引用：可能 table.column 或 table.*
    if (this.consume('DOT')) {
      if (this.consume('STAR')) {
        return { kind: 'star', table: t.value, pos };
      }
      const colTok = this.cur();
      if (colTok.kind !== 'IDENT' && colTok.kind !== 'KEYWORD') throw this.error('expected column name after "."');
      this.next();
      return { kind: 'column', table: t.value, name: colTok.value, pos };
    }
    // 未加引号的函数名裸写（如 select count 之类）当成列
    return { kind: 'column', table: null, name: t.value, pos };
  }

  private parseCase(): Expr {
    const pos = this.pos();
    this.expectKw('CASE');
    let operand: Expr | null = null;
    if (!this.isKw('WHEN')) operand = this.parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.consumeKw('WHEN')) {
      const when = this.parseExpr();
      this.expectKw('THEN');
      const then = this.parseExpr();
      whens.push({ when, then });
    }
    let elseExpr: Expr | null = null;
    if (this.consumeKw('ELSE')) elseExpr = this.parseExpr();
    this.expectKw('END');
    return { kind: 'case', operand, whens, elseExpr, pos };
  }

  private parseCast(): Expr {
    const pos = this.pos();
    this.expectKw('CAST');
    this.expect('LPAREN');
    const expr = this.parseExpr();
    this.expectKw('AS');
    const type = this.parseType();
    this.expect('RPAREN');
    return { kind: 'cast', expr, type, pos };
  }

  private parseName(): string {
    const t = this.cur();
    if (t.kind === 'IDENT' || t.kind === 'KEYWORD') {
      this.next();
      return t.value;
    }
    throw this.error(`expected name but found "${t.value || t.kind}"`);
  }

  // ---------------- token 工具 ----------------
  private cur(): Token { return this.tokens[this.i]; }
  private next(): Token { return this.tokens[this.i++]; }
  private is(kind: Token['kind']): boolean { return this.cur().kind === kind; }
  private isKw(kw: string): boolean {
    const t = this.cur();
    return t.kind === 'KEYWORD' && t.upper === kw;
  }
  private isOp(ops: string[]): boolean {
    const t = this.cur();
    return t.kind === 'OP' && ops.includes(t.value);
  }
  private consume(kind: Token['kind']): boolean {
    if (this.is(kind)) { this.i++; return true; }
    return false;
  }
  private consumeKw(kw: string): boolean {
    if (this.isKw(kw)) { this.i++; return true; }
    return false;
  }
  private expect(kind: Token['kind']): Token {
    if (!this.is(kind)) throw this.error(`expected "${this.kindText(kind)}" but found "${this.cur().value || this.cur().kind}"`);
    return this.next();
  }
  private expectOp(op: string): Token {
    if (!this.isOp([op])) throw this.error(`expected "${op}" but found "${this.cur().value || this.cur().kind}"`);
    return this.next();
  }
  private expectKw(kw: string): Token {
    if (!this.isKw(kw)) throw this.error(`expected "${kw}" but found "${this.cur().value || this.cur().kind}"`);
    return this.next();
  }
  private kindText(k: Token['kind']): string {
    return { LPAREN: '(', RPAREN: ')', COMMA: ',', DOT: '.', SEMI: ';', STAR: '*' }[k as string] ?? k;
  }
  private pos(): Pos {
    const t = this.cur();
    return { line: t.line, column: t.column };
  }
  private posOf(t: Token): Pos {
    return { line: t.line, column: t.column };
  }
  private error(message: string): SQLError {
    const t = this.cur();
    return new SQLError(message, { line: t.line, column: t.column }, 'SYNTAX');
  }
  private errorAt(t: Token, message: string): SQLError {
    return new SQLError(message, { line: t.line, column: t.column }, 'SYNTAX');
  }
}
