// ============================================================
// 词法分析器（Tokenizer）
// 产出带行列号的 Token，供语法分析和错误定位使用
// ============================================================

import { SQLError } from './types';

export type TokenKind =
  | 'IDENT' | 'KEYWORD' | 'NUMBER' | 'STRING' | 'BLOB_BIT'
  | 'PUNCT' | 'OP' | 'STAR' | 'COMMA' | 'LPAREN' | 'RPAREN' | 'DOT' | 'SEMI'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  value: string;        // 原始文本（字符串 token 为去引号后的内容）
  upper: string;        // 大写形式（IDENT/KEYWORD）
  line: number;         // 1 起始
  column: number;       // 1 起始
  endLine: number;
  endColumn: number;
  quoted: boolean;      // 是否为双引号/反引号标识符
}

export const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'DISTINCT', 'ALL', 'AS', 'AND', 'OR', 'NOT', 'IN',
  'BETWEEN', 'LIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'CAST', 'INTEGER', 'REAL', 'TEXT', 'BOOLEAN', 'JOIN',
  'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON', 'EXISTS', 'INSERT', 'INTO',
  'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'DROP',
  'IF', 'UNIQUE', 'PRIMARY', 'KEY', 'AUTOINCREMENT', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'TRANSACTION', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'NULLS', 'FIRST', 'LAST', 'EXPLAIN', 'DEFAULT',
]);

export class Tokenizer {
  private src: string;
  private pos = 0;
  private line = 1;
  private col = 1;
  private tokens: Token[] = [];

  constructor(src: string) {
    this.src = src;
  }

  tokenize(): Token[] {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') {
        this.advance();
      } else if (c === '\n') {
        this.advance();
        this.line++;
        this.col = 1;
      } else if (c === '-' && this.src[this.pos + 1] === '-') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.advance();
      } else if (c === '/' && this.src[this.pos + 1] === '*') {
        this.advance(); this.advance();
        while (this.pos < this.src.length && !(this.src[this.pos] === '*' && this.src[this.pos + 1] === '/')) {
          if (this.src[this.pos] === '\n') { this.advance(); this.line++; this.col = 1; }
          else this.advance();
        }
        if (this.pos < this.src.length) { this.advance(); this.advance(); }
      } else if (this.isDigit(c) || (c === '.' && this.isDigit(this.src[this.pos + 1]))) {
        this.readNumber();
      } else if (this.isIdentStart(c)) {
        this.readIdent();
      } else if (c === "'" || c === '"' || c === '`') {
        this.readQuoted(c);
      } else {
        this.readOperator();
      }
    }
    this.tokens.push({
      kind: 'EOF', value: '', upper: '', line: this.line, column: this.col,
      endLine: this.line, endColumn: this.col, quoted: false,
    });
    return this.tokens;
  }

  private advance(): string {
    const ch = this.src[this.pos++];
    this.col++;
    return ch;
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }
  private isIdentStart(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c >= '';
  }
  private isIdentPart(c: string): boolean {
    return this.isIdentStart(c) || this.isDigit(c) || c === '$';
  }

  private readNumber(): void {
    const start = this.snapshot();
    let isReal = false;
    while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.advance();
    if (this.src[this.pos] === '.') {
      isReal = true;
      this.advance();
      while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.advance();
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      const savePos = this.pos;
      const saveCol = this.col;
      this.advance();
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.advance();
      if (this.isDigit(this.src[this.pos])) {
        isReal = true;
        while (this.pos < this.src.length && this.isDigit(this.src[this.pos])) this.advance();
      } else {
        // 不是指数，回退
        this.pos = savePos;
        this.col = saveCol;
      }
    }
    const text = this.src.slice(start.offset, this.pos);
    this.emit(isReal ? 'NUMBER' : 'NUMBER', text, start, this.snapshot(), false);
  }

  private readIdent(): void {
    const start = this.snapshot();
    while (this.pos < this.src.length && this.isIdentPart(this.src[this.pos])) this.advance();
    const text = this.src.slice(start.offset, this.pos);
    const upper = text.toUpperCase();
    // 关键字后若紧跟字母（无空格），如 count(x) 没问题；这里分词依赖 isIdentPart
    this.emit(KEYWORDS.has(upper) ? 'KEYWORD' : 'IDENT', text, start, this.snapshot(), false);
  }

  private readQuoted(quote: string): void {
    const start = this.snapshot();
    const isString = quote === "'";
    this.advance(); // 开引号
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === quote) {
        if (this.src[this.pos + 1] === quote) { out += quote; this.advance(); this.advance(); }
        else { this.advance(); break; }
      } else {
        if (c === '\n') { this.advance(); this.line++; this.col = 1; out += '\n'; }
        else { out += this.advance(); }
      }
    }
    if (this.src[this.pos - 1] !== quote && this.pos >= this.src.length) {
      // 未闭合
    }
    if (isString) this.emit('STRING', out, start, this.snapshot(), false);
    else this.emit('IDENT', out, start, this.snapshot(), true);
  }

  private readOperator(): void {
    const start = this.snapshot();
    const c = this.advance();
    const two = c + (this.src[this.pos] ?? '');
    const three = two + (this.src[this.pos + 1] ?? '');

    // 多字符操作符
    if ((three === '<=>') || (three === '<>')) {
      // <> 为不等
      this.advance();
      this.emitOp('<>', start);
      return;
    }
    if (['<=', '>=', '!=', '<>'].includes(two)) {
      this.advance();
      this.emitOp(two === '!=' ? '<>' : two, start);
      return;
    }
    if (['||'].includes(two)) {
      this.advance();
      this.emitOp('||', start);
      return;
    }
    switch (c) {
      case '+': case '-': case '*': case '/': case '%':
      case '<': case '>': case '=':
        this.emitOp(c, start);
        return;
      case '(': this.emitPunct('LPAREN', c, start); return;
      case ')': this.emitPunct('RPAREN', c, start); return;
      case ',': this.emitPunct('COMMA', c, start); return;
      case '.': this.emitPunct('DOT', c, start); return;
      case ';': this.emitPunct('SEMI', c, start); return;
      default:
        throw new SQLError(
          `unexpected character "${c}"`,
          { line: start.line, column: start.col },
          'SYNTAX',
        );
    }
  }

  private emitOp(op: string, start: Snap): void {
    this.tokens.push({
      kind: op === '*' ? 'STAR' : 'OP',
      value: op, upper: op,
      line: start.line, column: start.col,
      endLine: this.line, endColumn: this.col, quoted: false,
    });
  }
  private emitPunct(kind: TokenKind, text: string, start: Snap): void {
    this.tokens.push({
      kind, value: text, upper: text,
      line: start.line, column: start.col,
      endLine: this.line, endColumn: this.col, quoted: false,
    });
  }
  private emit(kind: TokenKind, text: string, start: Snap, end: Snap, quoted: boolean): void {
    this.tokens.push({
      kind, value: text, upper: text.toUpperCase(),
      line: start.line, column: start.col,
      endLine: end.line, endColumn: end.col, quoted,
    });
  }

  private snapshot(): Snap {
    return { offset: this.pos, line: this.line, col: this.col };
  }
}

interface Snap { offset: number; line: number; col: number }
