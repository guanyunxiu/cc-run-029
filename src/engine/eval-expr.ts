// ============================================================
// 表达式求值（三值逻辑）
// 编译后的表达式是一个函数：ExecRow => DBValue
// 布尔上下文中，比较类表达式返回 true/false/null(=UNKNOWN)
// ============================================================

import type { DBValue } from '../sql/types';
import { castValue, SQLError } from '../sql/types';
import { compareValues, sqlEquals } from './table-store';

/** 求值时的行：输出标签 -> 值 */
export type EvalRow = Record<string, DBValue>;

/** 聚合求值上下文（Aggregate 节点使用） */
export interface AggState {
  get(index: number): DBValue;
}

/** 子查询解析器（由物理计划层注入） */
export interface SubqueryResolver {
  /** 标量子查询 */
  scalar(id: number, row: EvalRow, outer: ExecFrame): DBValue;
  /** IN 子查询：true/false/null */
  inSub(id: number, value: DBValue, row: EvalRow, outer: ExecFrame): boolean | null;
  /** EXISTS */
  exists(id: number, row: EvalRow, outer: ExecFrame): boolean;
}

export interface ExecFrame {
  /** 外层行（相关子查询），由近及远 */
  outers: EvalRow[];
  /** 聚合值 */
  agg: AggState | null;
  /** 子查询 */
  sub: SubqueryResolver | null;
}

export type CompiledExpr = (row: EvalRow, frame: ExecFrame) => DBValue;

export const emptyFrame: ExecFrame = { outers: [], agg: null, sub: null };

/** 把任意值转换为布尔三值 */
export function truthy(v: DBValue): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  // 文本：'true'/'false'/其它（非标准，采用显式规则）
  const s = v.toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0' || s === '') return false;
  return null;
}

/** 3VL AND */
export function and3(a: boolean | null, b: boolean | null): boolean | null {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}
/** 3VL OR */
export function or3(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

// ------------------------------------------------------------
// 算术
// ------------------------------------------------------------
export function arithmetic(op: '+' | '-' | '*' | '/' | '%', a: DBValue, b: DBValue, pos: { line: number; column: number }): DBValue {
  if (a === null || b === null) return null;
  const x = toNumber(a, pos);
  const y = toNumber(b, pos);
  switch (op) {
    case '+': return maybeInt(x + y, a, b);
    case '-': return maybeInt(x - y, a, b);
    case '*': return maybeInt(x * y, a, b);
    case '/':
      if (y === 0) throw new SQLError('division by zero', pos, 'RUNTIME');
      return x / y; // 除法总是 REAL
    case '%': {
      if (y === 0) throw new SQLError('division by zero in modulo', pos, 'RUNTIME');
      return Math.trunc(x) % Math.trunc(y);
    }
  }
}

function maybeInt(result: number, a: DBValue, b: DBValue): DBValue {
  // 两个整数操作数 => 整数结果
  if (Number.isInteger(a) && Number.isInteger(b) && Number.isSafeInteger(result)) return result;
  return result;
}

function toNumber(v: DBValue, pos: { line: number; column: number }): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isNaN(n)) throw new SQLError(`cannot convert TEXT "${v}" to number`, pos, 'TYPE');
    return n;
  }
  throw new SQLError('cannot convert value to number', pos, 'TYPE');
}

/** 比较运算（返回三值） */
export function compare(
  op: '=' | '<>' | '<' | '<=' | '>' | '>=',
  a: DBValue, b: DBValue,
): boolean | null {
  const eq = sqlEquals(a, b);
  if (eq === null) return null; // 任一为 null
  switch (op) {
    case '=': return eq;
    case '<>': return !eq;
    default: {
      const c = compareValues(a, b);
      switch (op) {
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
      }
    }
  }
}

// ------------------------------------------------------------
// LIKE：% 任意序列，_ 单字符；大小写敏感
// ------------------------------------------------------------
export function like(value: DBValue, pattern: DBValue): boolean | null {
  if (value === null || pattern === null) return null;
  const s = String(value);
  const p = String(pattern);
  return likeMatch(s, p, 0, 0);
}

function likeMatch(s: string, p: string, si: number, pi: number): boolean {
  let i = si;
  let j = pi;
  let star = -1;
  let match = 0;
  while (i < s.length) {
    if (j < p.length && (p[j] === '_' || p[j] === s[i])) {
      i++; j++;
    } else if (j < p.length && p[j] === '%') {
      star = j;
      match = i;
      j++;
    } else if (star !== -1) {
      j = star + 1;
      match++;
      i = match;
    } else {
      return false;
    }
  }
  while (j < p.length && p[j] === '%') j++;
  return j === p.length;
}

/** CASE 类型转换包装 */
export function doCast(v: DBValue, type: 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN', pos: { line: number; column: number }): DBValue {
  return castValue(v, type, pos);
}
