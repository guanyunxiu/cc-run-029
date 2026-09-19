// SQL 值的类型转换、比较与三值逻辑
import { SqlType, SqlValue } from '../sql/types';

export type Trilean = boolean | null;

export function isNull(v: SqlValue): boolean {
  return v === null || v === undefined;
}

/** 三值逻辑 AND */
export function triAnd(a: Trilean, b: Trilean): Trilean {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

/** 三值逻辑 OR */
export function triOr(a: Trilean, b: Trilean): Trilean {
  if (a === true || b === true) return true;
  if (a === null || b === null) return null;
  return false;
}

export function triNot(a: Trilean): Trilean {
  if (a === null) return null;
  return !a;
}

/** WHERE/HAVING 条件成立判定：只有 true 通过（UNKNOWN 不通过） */
export function isTrue(v: SqlValue): boolean {
  return v === true;
}

export function typeOf(v: SqlValue): SqlType | 'NULL' {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return 'BOOLEAN';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  return 'TEXT';
}

export function castValue(v: SqlValue, type: SqlType): SqlValue {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'INTEGER': {
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return Math.trunc(v);
      const s = String(v).trim();
      if (s === '') return null;
      const n = Number(s);
      if (Number.isNaN(n)) throw new Error(`无法将 TEXT "${s}" 转换为 INTEGER`);
      return Math.trunc(n);
    }
    case 'REAL': {
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return v;
      const s = String(v).trim();
      if (s === '') return null;
      const n = Number(s);
      if (Number.isNaN(n)) throw new Error(`无法将 TEXT "${s}" 转换为 REAL`);
      return n;
    }
    case 'TEXT':
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      return String(v);
    case 'BOOLEAN': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      const s = String(v).trim().toUpperCase();
      if (s === 'TRUE' || s === '1') return true;
      if (s === 'FALSE' || s === '0') return false;
      if (s === '') return null;
      throw new Error(`无法将 TEXT "${s}" 转换为 BOOLEAN`);
    }
  }
}

/** 按列类型做类型亲和转换（写入存储时使用），宽松不抛错：失败保留原值 */
export function applyAffinity(v: SqlValue, type: SqlType): SqlValue {
  if (v === null || v === undefined) return null;
  try {
    return castValue(v, type);
  } catch {
    return v;
  }
}

/**
 * SQL 比较语义：
 * - 任一侧 NULL => null（三值逻辑）
 * - 同类型：数字按数值、文本按字典序、布尔按 false<true
 * - 跨类型：尽量转数值比较；无法转数值的文本按文本规则（与 SQLite 近似）
 */
export function sqlCompare(a: SqlValue, b: SqlValue): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  // 跨数值
  const an = toNumberLoose(a);
  const bn = toNumberLoose(b);
  if (an !== null && bn !== null) return an < bn ? -1 : an > bn ? 1 : 0;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

export function toNumberLoose(v: SqlValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

export function sqlEquals(a: SqlValue, b: SqlValue): boolean | null {
  const c = sqlCompare(a, b);
  return c === null ? null : c === 0;
}

/** LIKE：% 任意串，_ 单个字符；默认大小写不敏感（SQL 标准行为） */
export function sqlLike(value: string, pattern: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  // 转成正则（简单的通配符匹配，使用回溯 DP）
  return likeMatch(v, p);
}

function likeMatch(v: string, p: string): boolean {
  // 经典通配符 DP
  const n = v.length;
  const m = p.length;
  const dp: boolean[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(false));
  dp[0][0] = true;
  for (let j = 1; j <= m; j++) {
    if (p[j - 1] === '%') dp[0][j] = dp[0][j - 1];
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const pc = p[j - 1];
      if (pc === '%') {
        dp[i][j] = dp[i][j - 1] || dp[i - 1][j];
      } else if (pc === '_' || pc === v[i - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      }
    }
  }
  return dp[n][m];
}

/** 算术运算（NULL 传播；整数相除结果为 REAL 语义，除零返回 NULL） */
export function sqlArith(op: string, a: SqlValue, b: SqlValue): SqlValue {
  if (isNull(a) || isNull(b)) return null;
  const x = toNumberLoose(a);
  const y = toNumberLoose(b);
  if (x === null || y === null) return null;
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? null : x / y;
    case '%': return y === 0 ? null : x % y;
    default: throw new Error(`未知算术运算符 ${op}`);
  }
}

export function deepEqualValues(a: SqlValue, b: SqlValue): boolean {
  return sqlEquals(a, b) === true;
}
