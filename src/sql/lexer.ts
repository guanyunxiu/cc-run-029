// 词法分析器：将 SQL 文本切分为 Token 流，记录行列号
import { SqlError } from './types';

export enum TokenKind {
  Keyword,
  Identifier,
  Number,
  String,
  Parameter, // ? 占位符（预留）
  Op,
  Punct,
  EOF,
}

export interface Token {
  kind: TokenKind;
  value: string; // 标识符去掉引号、字符串去掉外层引号后的实际值
  raw: string; // 原始文本（关键字用大写）
  line: number;
  column: number;
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'DROP', 'INDEX', 'ON', 'IF', 'EXISTS', 'NOT', 'NULL',
  'AND', 'OR', 'IN', 'LIKE', 'BETWEEN', 'IS', 'AS', 'JOIN', 'INNER', 'LEFT',
  'OUTER', 'RIGHT', 'FULL', 'CROSS', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC',
  'DESC', 'LIMIT', 'OFFSET', 'DISTINCT', 'ALL', 'UNION', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'CAST', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'INTEGER', 'REAL',
  'TEXT', 'BOOLEAN', 'INT', 'PRIMARY', 'KEY', 'UNIQUE', 'DEFAULT', 'TRUE', 'FALSE',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'EXPLAIN', 'EXISTS_KW',
]);

// EXISTS 既做关键字又做函数式谓词，统一放进 KEYWORDS 集合处理
KEYWORDS.add('EXISTS');

export class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;

  constructor(private readonly src: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.src.length) break;
      const startLine = this.line;
      const startCol = this.col;
      const ch = this.src[this.pos];

      // 字符串字面量：'...'，'' 为转义单引号
      if (ch === "'") {
        tokens.push(this.readString(startLine, startCol));
        continue;
      }
      // 双引号 / 反引号标识符
      if (ch === '"' || ch === '`') {
        tokens.push(this.readQuotedIdent(ch, startLine, startCol));
        continue;
      }
      // 数字
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(this.src[this.pos + 1] ?? ''))) {
        tokens.push(this.readNumber(startLine, startCol));
        continue;
      }
      // 标识符 / 关键字
      if (/[\p{L}_]/u.test(ch)) {
        tokens.push(this.readWord(startLine, startCol));
        continue;
      }
      // 参数
      if (ch === '?') {
        this.advance();
        tokens.push({ kind: TokenKind.Parameter, value: '?', raw: '?', line: startLine, column: startCol });
        continue;
      }
      // 多字符运算符
      const two = this.src.slice(this.pos, this.pos + 2);
      if (['<=', '>=', '<>', '!=', '||'].includes(two)) {
        this.advance();
        this.advance();
        const op = two === '!=' ? '<>' : two;
        tokens.push({ kind: TokenKind.Op, value: op, raw: op, line: startLine, column: startCol });
        continue;
      }
      if ('+-*/%<>=!'.includes(ch)) {
        this.advance();
        tokens.push({ kind: TokenKind.Op, value: ch, raw: ch, line: startLine, column: startCol });
        continue;
      }
      if (',().;'.includes(ch)) {
        this.advance();
        tokens.push({ kind: TokenKind.Punct, value: ch, raw: ch, line: startLine, column: startCol });
        continue;
      }
      throw new SqlError(`无法识别的字符 "${ch}"`, startLine, startCol);
    }
    tokens.push({ kind: TokenKind.EOF, value: '', raw: '', line: this.line, column: this.col });
    return tokens;
  }

  private advance(): string {
    const ch = this.src[this.pos++];
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (/\s/.test(ch)) {
        this.advance();
        continue;
      }
      // -- 行注释
      if (ch === '-' && this.src[this.pos + 1] === '-') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.advance();
        continue;
      }
      // /* 块注释 */
      if (ch === '/' && this.src[this.pos + 1] === '*') {
        const sl = this.line;
        const sc = this.col;
        this.advance();
        this.advance();
        while (this.pos < this.src.length && !(this.src[this.pos] === '*' && this.src[this.pos + 1] === '/')) {
          this.advance();
        }
        if (this.pos >= this.src.length) throw new SqlError('块注释缺少结束符 */', sl, sc);
        this.advance();
        this.advance();
        continue;
      }
      break;
    }
  }

  private readString(line: number, column: number): Token {
    this.advance(); // 跳过开头的 '
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "'") {
        if (this.src[this.pos + 1] === "'") {
          value += "'";
          this.advance();
          this.advance();
        } else {
          this.advance();
          return { kind: TokenKind.String, value, raw: `'${value}'`, line, column };
        }
      } else {
        value += this.advance();
      }
    }
    throw new SqlError('字符串字面量缺少结束的单引号', line, column);
  }

  private readQuotedIdent(quote: string, line: number, column: number): Token {
    this.advance();
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === quote) {
        if (this.src[this.pos + 1] === quote) {
          value += quote;
          this.advance();
          this.advance();
        } else {
          this.advance();
          return { kind: TokenKind.Identifier, value, raw: value, line, column };
        }
      } else {
        value += this.advance();
      }
    }
    throw new SqlError(`引号标识符缺少结束符 ${quote}`, line, column);
  }

  private readNumber(line: number, column: number): Token {
    let raw = '';
    let dot = false;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) {
      if (this.src[this.pos] === '.') {
        if (dot) break;
        dot = true;
      }
      raw += this.advance();
    }
    // 科学计数法
    if ((this.src[this.pos] === 'e' || this.src[this.pos] === 'E')) {
      const savePos = this.pos;
      raw += this.advance();
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') raw += this.advance();
      if (!/[0-9]/.test(this.src[this.pos] ?? '')) {
        throw new SqlError('科学计数法指数部分缺少数字', line, column);
        void savePos;
      }
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) raw += this.advance();
    }
    return { kind: TokenKind.Number, value: raw, raw, line, column };
  }

  private readWord(line: number, column: number): Token {
    let raw = '';
    // 支持任意 Unicode 字母（含中文等）作为标识符
    while (this.pos < this.src.length && /[\p{L}0-9_]/u.test(this.src[this.pos])) {
      raw += this.advance();
    }
    const upper = raw.toUpperCase();
    if (KEYWORDS.has(upper)) {
      return { kind: TokenKind.Keyword, value: upper, raw: upper, line, column };
    }
    return { kind: TokenKind.Identifier, value: raw, raw, line, column };
  }
}
