// 递归下降语法分析器
import { Token, TokenKind, Lexer } from './lexer';
import { SqlError, SqlType, SqlValue } from './types';
import * as AST from './ast';
import { Expr, SelectStmt, Statement } from './ast';

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

export class Parser {
  private tokens: Token[] = [];
  private idx = 0;

  parse(sql: string): Statement[] {
    this.tokens = new Lexer(sql).tokenize();
    this.idx = 0;
    const stmts: Statement[] = [];
    if (this.peek().kind === TokenKind.EOF) return stmts;
    while (true) {
      stmts.push(this.parseStatement());
      if (this.matchPunct(';')) {
        if (this.peek().kind === TokenKind.EOF) break;
        continue;
      }
      if (this.peek().kind === TokenKind.EOF) break;
      throw this.error('语句之间缺少分号 ";"');
    }
    return stmts;
  }

  // ---------- 工具方法 ----------
  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.idx + ahead, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.idx++];
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.kind === TokenKind.Keyword && t.value === word;
  }

  private matchKeyword(word: string): boolean {
    if (this.isKeyword(word)) {
      this.next();
      return true;
    }
    return false;
  }

  private isPunct(p: string): boolean {
    const t = this.peek();
    return t.kind === TokenKind.Punct && t.value === p;
  }

  private matchPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.next();
      return true;
    }
    return false;
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t.kind === TokenKind.Op && t.value === op;
  }

  private expectKeyword(word: string): Token {
    if (!this.isKeyword(word)) throw this.error(`期望关键字 ${word}`);
    return this.next();
  }

  private expectPunct(p: string): Token {
    if (!this.isPunct(p)) throw this.error(`期望符号 "${p}"`);
    return this.next();
  }

  private error(message: string, token?: Token): SqlError {
    const t = token ?? this.peek();
    return new SqlError(message, t.line, t.column);
  }

  /** 消费标识符（普通标识符或被当作标识符的非保留关键字） */
  private parseName(allowKeyword = false): string {
    const t = this.peek();
    if (t.kind === TokenKind.Identifier) {
      this.next();
      return t.value;
    }
    if (allowKeyword && t.kind === TokenKind.Keyword) {
      this.next();
      return t.value;
    }
    throw this.error('期望标识符');
  }

  // ---------- 语句 ----------
  private parseStatement(): Statement {
    const t = this.peek();
    if (t.kind !== TokenKind.Keyword) throw this.error('期望 SQL 语句开头的关键字');
    switch (t.value) {
      case 'SELECT':
        return this.parseSelect();
      case 'INSERT':
        return this.parseInsert();
      case 'UPDATE':
        return this.parseUpdate();
      case 'DELETE':
        return this.parseDelete();
      case 'CREATE':
        return this.parseCreate();
      case 'DROP':
        return this.parseDrop();
      case 'BEGIN':
        this.next();
        this.matchKeyword('TRANSACTION');
        return { kind: 'txn', action: 'BEGIN' };
      case 'COMMIT':
        this.next();
        this.matchKeyword('TRANSACTION');
        return { kind: 'txn', action: 'COMMIT' };
      case 'ROLLBACK':
        this.next();
        this.matchKeyword('TRANSACTION');
        return { kind: 'txn', action: 'ROLLBACK' };
      case 'EXPLAIN': {
        this.next();
        const inner = this.parseStatement();
        return { kind: 'explain', inner };
      }
      default:
        throw this.error(`不支持的语句: ${t.value}`);
    }
  }

  // ---------- CREATE / DROP ----------
  private parseCreate(): Statement {
    this.expectKeyword('CREATE');
    let unique = false;
    if (this.matchKeyword('UNIQUE')) unique = true;
    if (this.matchKeyword('TABLE')) return this.parseCreateTable(false);
    if (this.matchKeyword('INDEX')) return this.parseCreateIndex(unique);
    throw this.error('CREATE 后期望 TABLE 或 INDEX');
  }

  private parseCreateTable(_unused: boolean): AST.CreateTableStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseName();
    this.expectPunct('(');
    const columns: AST.ColumnDef[] = [];
    let pkColumn: string | undefined;
    do {
      // 表级约束 PRIMARY KEY(col)
      if (this.isKeyword('PRIMARY')) {
        this.expectKeyword('PRIMARY');
        this.expectKeyword('KEY');
        this.expectPunct('(');
        pkColumn = this.parseName();
        this.expectPunct(')');
        continue;
      }
      const colName = this.parseName();
      const type = this.parseTypeName();
      const col: AST.ColumnDef = { name: colName, type, primaryKey: false, nullable: true, unique: false };
      this.parseColumnConstraints(col);
      columns.push(col);
    } while (this.matchPunct(','));
    this.expectPunct(')');
    if (pkColumn) {
      const c = columns.find((x) => x.name === pkColumn);
      if (!c) throw this.error(`主键列 ${pkColumn} 不存在`);
      c.primaryKey = true;
      c.nullable = false;
    }
    return { kind: 'createTable', ifNotExists, name, columns };
  }

  private parseIfNotExists(): boolean {
    if (this.matchKeyword('IF')) {
      this.expectKeyword('NOT');
      this.expectKeyword('EXISTS');
      return true;
    }
    return false;
  }

  private parseIfExists(): boolean {
    if (this.matchKeyword('IF')) {
      this.expectKeyword('EXISTS');
      return true;
    }
    return false;
  }

  private parseTypeName(): SqlType {
    const t = this.peek();
    if (t.kind !== TokenKind.Keyword || !['INTEGER', 'INT', 'REAL', 'TEXT', 'BOOLEAN'].includes(t.value)) {
      throw this.error('期望类型名 INTEGER / REAL / TEXT / BOOLEAN');
    }
    this.next();
    // 兼容 VARCHAR(n)、DECIMAL(p,s) 之类的长度声明
    if (this.matchPunct('(')) {
      while (!this.isPunct(')')) {
        if (this.peek().kind === TokenKind.EOF) throw this.error('类型声明缺少右括号');
        this.next();
      }
      this.expectPunct(')');
    }
    return (t.value === 'INT' ? 'INTEGER' : t.value) as SqlType;
  }

  private parseColumnConstraints(col: AST.ColumnDef): void {
    while (true) {
      if (this.matchKeyword('PRIMARY')) {
        this.expectKeyword('KEY');
        col.primaryKey = true;
        col.nullable = false;
      } else if (this.matchKeyword('NOT')) {
        this.expectKeyword('NULL');
        col.nullable = false;
      } else if (this.matchKeyword('UNIQUE')) {
        // UNIQUE 列允许 NULL（标准 SQL 语义），NOT NULL 需另行声明
        col.unique = true;
      } else if (this.matchKeyword('DEFAULT')) {
        const lit = this.parseLiteral();
        col.default = lit.value;
      } else if (this.matchKeyword('NULL')) {
        col.nullable = true;
      } else {
        break;
      }
    }
  }

  private parseCreateIndex(unique: boolean): AST.CreateIndexStmt {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseName();
    this.expectKeyword('ON');
    const table = this.parseName();
    this.expectPunct('(');
    const column = this.parseName();
    this.expectPunct(')');
    return { kind: 'createIndex', unique, ifNotExists, name, table, column };
  }

  private parseDrop(): Statement {
    this.expectKeyword('DROP');
    if (this.matchKeyword('TABLE')) {
      const ifExists = this.parseIfExists();
      const name = this.parseName();
      return { kind: 'dropTable', ifExists, name };
    }
    if (this.matchKeyword('INDEX')) {
      const ifExists = this.parseIfExists();
      const name = this.parseName();
      return { kind: 'dropIndex', ifExists, name };
    }
    throw this.error('DROP 后期望 TABLE 或 INDEX');
  }

  // ---------- INSERT ----------
  private parseInsert(): AST.InsertStmt {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const table = this.parseName();
    let columns: string[] | undefined;
    if (this.matchPunct('(')) {
      columns = [];
      do {
        columns.push(this.parseName());
      } while (this.matchPunct(','));
      this.expectPunct(')');
    }
    this.expectKeyword('VALUES');
    const rows: SqlValue[][] = [];
    do {
      this.expectPunct('(');
      const row: SqlValue[] = [];
      do {
        const lit = this.parseLiteral();
        row.push(lit.value);
      } while (this.matchPunct(','));
      this.expectPunct(')');
      rows.push(row);
    } while (this.matchPunct(','));
    return { kind: 'insert', table, columns, values: rows };
  }

  private parseLiteral(): AST.LiteralExpr {
    const t = this.peek();
    if (t.kind === TokenKind.Number) {
      this.next();
      const n = Number(t.value);
      if (Number.isNaN(n)) throw this.error(`非法数字 ${t.value}`, t);
      return { kind: 'literal', value: n };
    }
    if (t.kind === TokenKind.String) {
      this.next();
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === TokenKind.Keyword && (t.value === 'NULL' || t.value === 'TRUE' || t.value === 'FALSE')) {
      this.next();
      return { kind: 'literal', value: t.value === 'NULL' ? null : t.value === 'TRUE' };
    }
    // 允许 CAST 等表达式作为 DEFAULT？这里保持简单，只接受字面量
    throw this.error('期望字面量值（数字 / 字符串 / NULL / TRUE / FALSE）');
  }

  // ---------- UPDATE / DELETE ----------
  private parseUpdate(): AST.UpdateStmt {
    this.expectKeyword('UPDATE');
    const table = this.parseName();
    this.expectKeyword('SET');
    const sets: { column: string; expr: Expr }[] = [];
    do {
      const column = this.parseName();
      this.expectOp('=');
      const expr = this.parseExpr();
      sets.push({ column, expr });
    } while (this.matchPunct(','));
    let where: Expr | undefined;
    if (this.matchKeyword('WHERE')) where = this.parseExpr();
    return { kind: 'update', table, sets, where };
  }

  private parseDelete(): AST.DeleteStmt {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.parseName();
    let where: Expr | undefined;
    if (this.matchKeyword('WHERE')) where = this.parseExpr();
    return { kind: 'delete', table, where };
  }

  // ---------- SELECT ----------
  private parseSelect(): SelectStmt {
    this.expectKeyword('SELECT');
    const distinct = this.matchKeyword('DISTINCT');
    if (!distinct) this.matchKeyword('ALL');

    const selectList: AST.SelectItem[] = [];
    do {
      if (this.isOp('*')) {
        this.next();
        selectList.push({ expr: { kind: 'star' } });
        continue;
      }
      const expr = this.parseExpr();
      // table.*
      if (expr.kind === 'column' && expr.star) {
        selectList.push({ expr });
        continue;
      }
      let alias: string | undefined;
      if (this.matchKeyword('AS')) alias = this.parseName(true);
      else if (this.peek().kind === TokenKind.Identifier) alias = this.parseName();
      selectList.push({ expr, alias });
    } while (this.matchPunct(','));

    let from: AST.TableRef | AST.SubqueryRef | undefined;
    const joins: AST.JoinClause[] = [];
    if (this.matchKeyword('FROM')) {
      from = this.parseFromItem();
      while (true) {
        if (this.matchKeyword('INNER')) {
          this.expectKeyword('JOIN');
          joins.push({ joinKind: 'INNER', right: this.parseFromItem(), on: this.parseJoinOn() });
        } else if (this.matchKeyword('LEFT')) {
          this.matchKeyword('OUTER');
          this.expectKeyword('JOIN');
          joins.push({ joinKind: 'LEFT', right: this.parseFromItem(), on: this.parseJoinOn() });
        } else if (this.matchKeyword('JOIN')) {
          joins.push({ joinKind: 'INNER', right: this.parseFromItem(), on: this.parseJoinOn() });
        } else if (this.isPunct(',')) {
          this.next();
          joins.push({ joinKind: 'INNER', right: this.parseFromItem(), on: undefined }); // 逗号 = 笛卡尔积
        } else {
          break;
        }
      }
    }

    let where: Expr | undefined;
    if (this.matchKeyword('WHERE')) where = this.parseExpr();

    const groupBy: Expr[] = [];
    if (this.matchKeyword('GROUP')) {
      this.expectKeyword('BY');
      do {
        groupBy.push(this.parseExpr());
      } while (this.matchPunct(','));
    }

    let having: Expr | undefined;
    if (this.matchKeyword('HAVING')) having = this.parseExpr();

    const orderBy: { expr: Expr; desc: boolean }[] = [];
    if (this.matchKeyword('ORDER')) {
      this.expectKeyword('BY');
      do {
        const expr = this.parseExpr();
        let desc = false;
        if (this.matchKeyword('ASC')) desc = false;
        else if (this.matchKeyword('DESC')) desc = true;
        orderBy.push({ expr, desc });
      } while (this.matchPunct(','));
    }

    let limit: Expr | undefined;
    let offset: Expr | undefined;
    if (this.matchKeyword('LIMIT')) {
      limit = this.parseExpr();
      if (this.matchKeyword('OFFSET')) offset = this.parseExpr();
    } else if (this.matchKeyword('OFFSET')) {
      offset = this.parseExpr();
      if (this.matchKeyword('LIMIT')) limit = this.parseExpr();
    }

    return { kind: 'select', distinct, selectList, from, joins, where, groupBy, having, orderBy, limit, offset };
  }

  private parseJoinOn(): Expr {
    this.expectKeyword('ON');
    return this.parseExpr();
  }

  private parseFromItem(): AST.TableRef | AST.SubqueryRef {
    if (this.matchPunct('(')) {
      // (SELECT ...) AS alias
      if (this.isKeyword('SELECT')) {
        const subquery = this.parseSelect();
        this.expectPunct(')');
        let alias: string;
        if (this.matchKeyword('AS')) alias = this.parseName(true);
        else if (this.peek().kind === TokenKind.Identifier) alias = this.parseName();
        else throw this.error('子查询必须有别名');
        return { kind: 'subquery', subquery, alias };
      }
      // 括号包裹的 FROM 项（简化处理：仅透传）
      const inner = this.parseFromItem();
      this.expectPunct(')');
      let parenAlias: string | undefined;
      if (this.matchKeyword('AS')) parenAlias = this.parseName(true);
      else if (this.peek().kind === TokenKind.Identifier) parenAlias = this.parseName();
      if (inner.kind === 'subquery') {
        return { ...inner, alias: parenAlias ?? inner.alias };
      }
      return { ...inner, alias: parenAlias ?? inner.alias };
    }
    const name = this.parseName();
    let alias: string | undefined;
    if (this.matchKeyword('AS')) alias = this.parseName(true);
    else if (this.peek().kind === TokenKind.Identifier) alias = this.parseName();
    return { kind: 'table', name, alias };
  }

  private expectOp(op: string): void {
    if (!this.isOp(op)) throw this.error(`期望运算符 "${op}"`);
    this.next();
  }

  // ---------- 表达式（优先级爬升） ----------
  // OR < AND < NOT < 比较(= <> < > <= >=, IS, BETWEEN, IN, LIKE) < 加减 < 乘除模 < 一元 < 基本表达式
  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      this.next();
      const right = this.parseAnd();
      left = { kind: 'binary', op: 'OR', left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.isKeyword('AND')) {
      this.next();
      const right = this.parseNot();
      left = { kind: 'binary', op: 'AND', left, right };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.matchKeyword('NOT')) {
      return { kind: 'unary', op: 'NOT', expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    while (true) {
      // 普通比较
      const t = this.peek();
      if (t.kind === TokenKind.Op && ['=', '<>', '<', '>', '<=', '>='].includes(t.value)) {
        this.next();
        const right = this.parseAdditive();
        left = { kind: 'binary', op: t.value, left, right };
        continue;
      }
      let negated = false;
      if (this.isKeyword('NOT')) {
        // 仅在后面接 IN/BETWEEN/LIKE 时才消费
        const after = this.peek(1);
        if (after.kind === TokenKind.Keyword && ['IN', 'BETWEEN', 'LIKE'].includes(after.value)) {
          this.next();
          negated = true;
        } else {
          break;
        }
      }
      if (this.matchKeyword('IS')) {
        const isNot = this.matchKeyword('NOT');
        this.expectKeyword('NULL');
        left = { kind: 'isNull', expr: left, negated: isNot };
        continue;
      }
      if (this.matchKeyword('BETWEEN')) {
        const low = this.parseAdditive();
        this.expectKeyword('AND');
        const high = this.parseAdditive();
        left = { kind: 'between', expr: left, negated, low, high };
        continue;
      }
      if (this.matchKeyword('IN')) {
        if (this.isPunct('(') && this.peek(1).kind === TokenKind.Keyword && this.peek(1).value === 'SELECT') {
          this.expectPunct('(');
          const subquery = this.parseSelect();
          this.expectPunct(')');
          left = { kind: 'inSubquery', expr: left, negated, subquery };
        } else {
          this.expectPunct('(');
          const values: Expr[] = [];
          do {
            values.push(this.parseExpr());
          } while (this.matchPunct(','));
          this.expectPunct(')');
          left = { kind: 'inList', expr: left, negated, values };
        }
        continue;
      }
      if (this.matchKeyword('LIKE')) {
        const pattern = this.parseAdditive();
        left = { kind: 'like', expr: left, negated, pattern };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOp('-')) {
      this.next();
      return { kind: 'unary', op: '-', expr: this.parseUnary() };
    }
    if (this.isOp('+')) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === TokenKind.Number || t.kind === TokenKind.String) {
      return this.parseLiteral();
    }
    if (t.kind === TokenKind.Keyword) {
      if (t.value === 'NULL' || t.value === 'TRUE' || t.value === 'FALSE') return this.parseLiteral();
      if (t.value === 'CASE') return this.parseCase();
      if (t.value === 'CAST') return this.parseCast();
      if (t.value === 'EXISTS') {
        this.next();
        this.expectPunct('(');
        const subquery = this.parseSelect();
        this.expectPunct(')');
        return { kind: 'exists', negated: false, subquery };
      }
      if (AGGREGATES.has(t.value)) {
        // 聚合函数也可能作为普通名出现（MIN 等不是保留字冲突），这里按函数处理
        return this.parseFunctionCall();
      }
      // 允许关键字作列名（部分非保留字）
    }

    if (this.isPunct('(')) {
      this.next();
      if (this.isKeyword('SELECT')) {
        const subquery = this.parseSelect();
        this.expectPunct(')');
        return { kind: 'scalarSubquery', subquery };
      }
      const expr = this.parseExpr();
      this.expectPunct(')');
      return expr;
    }

    if (t.kind === TokenKind.Identifier) {
      this.next();
      // 普通函数调用（非聚合名）
      if (this.isPunct('(')) {
        // 不支持的用户函数——但允许 UPPER/LOWER/ABS/COALESCE 等内建函数
        return this.parseFunctionCallBody(t.value);
      }
      if (this.isPunct('.')) {
        this.next();
        if (this.isOp('*')) {
          this.next();
          return { kind: 'column', table: t.value, name: '*', star: true };
        }
        const col = this.expectColumnOrKeyword();
        return { kind: 'column', table: t.value, name: col };
      }
      return { kind: 'column', name: t.value };
    }

    throw this.error('期望表达式');
  }

  private expectColumnOrKeyword(): string {
    const t = this.peek();
    if (t.kind === TokenKind.Identifier) {
      this.next();
      return t.value;
    }
    if (t.kind === TokenKind.Keyword && !AGGREGATES.has(t.value)) {
      this.next();
      return t.value;
    }
    throw this.error('期望列名');
  }

  private parseFunctionCall(): Expr {
    const name = this.next().value;
    return this.parseFunctionCallBody(name);
  }

  private parseFunctionCallBody(name: string): Expr {
    this.expectPunct('(');
    const upper = name.toUpperCase();
    if (this.isOp('*')) {
      this.next();
      this.expectPunct(')');
      if (upper !== 'COUNT') throw this.error('只有 COUNT 支持 COUNT(*)');
      return { kind: 'func', name: 'COUNT', distinct: false, args: [], star: true };
    }
    const distinct = this.matchKeyword('DISTINCT');
    const args: Expr[] = [];
    if (!this.isPunct(')')) {
      do {
        args.push(this.parseExpr());
      } while (this.matchPunct(','));
    }
    this.expectPunct(')');
    if (AGGREGATES.has(upper)) {
      if (upper === 'COUNT' && args.length !== 1) throw this.error('COUNT 需要恰好一个参数（或 COUNT(*)）');
      if (upper !== 'COUNT' && args.length !== 1) throw this.error(`${upper} 需要恰好一个参数`);
    }
    return { kind: 'func', name: upper, distinct, args };
  }

  private parseCase(): Expr {
    this.expectKeyword('CASE');
    let operand: Expr | undefined;
    if (!this.isKeyword('WHEN')) operand = this.parseExpr();
    const whens: { when: Expr; then: Expr }[] = [];
    while (this.matchKeyword('WHEN')) {
      const when = this.parseExpr();
      this.expectKeyword('THEN');
      const then = this.parseExpr();
      whens.push({ when, then });
    }
    if (whens.length === 0) throw this.error('CASE 表达式至少需要一个 WHEN');
    let elseExpr: Expr | undefined;
    if (this.matchKeyword('ELSE')) elseExpr = this.parseExpr();
    this.expectKeyword('END');
    return { kind: 'case', operand, whens, else: elseExpr };
  }

  private parseCast(): Expr {
    this.expectKeyword('CAST');
    this.expectPunct('(');
    const expr = this.parseExpr();
    this.expectKeyword('AS');
    const type = this.parseTypeName();
    this.expectPunct(')');
    return { kind: 'cast', expr, type };
  }
}
