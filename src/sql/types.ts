// ============================================================
// 核心类型定义：SQL 类型、值、Schema、行
// ============================================================

/** 支持的数据类型 */
export type DataType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

/** 数据库值（NULL 用 null 表示） */
export type DBValue = number | string | boolean | null;

/** 数据行：列名（输出标签）-> 值 */
export type Row = Record<string, DBValue>;

/** 列定义 */
export interface ColumnDef {
  name: string;
  type: DataType;
  nullable: boolean;
  /** 若该列是（或属于）主键 */
  primaryKey: boolean;
  /** 建表时的声明序号 */
  ordinal: number;
}

/** 索引定义 */
export interface IndexDef {
  name: string;
  table: string;
  column: string;
  unique: boolean;
}

/** 表定义 */
export interface TableDef {
  name: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
  /** 单列主键列名；无主键表使用隐藏 rowid */
  primaryKey: string | null;
  autoincrement: boolean;
  /** 下一个 rowid 值 */
  seq: number;
}

export function columnByName(table: TableDef, name: string): ColumnDef | undefined {
  const lower = name.toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === lower);
}

// ------------------------------------------------------------
// 错误类型（携带行列号）
// ------------------------------------------------------------
export class SQLError extends Error {
  /** 1 起始行 */
  line: number;
  /** 1 起始列 */
  column: number;
  /** 错误分类，便于前端展示 */
  kind: 'SYNTAX' | 'BIND' | 'TYPE' | 'RUNTIME' | 'CONFLICT' | 'INTERNAL';

  constructor(
    message: string,
    pos: { line: number; column: number } = { line: 1, column: 1 },
    kind: SQLError['kind'] = 'RUNTIME',
  ) {
    super(message);
    this.name = 'SQLError';
    this.line = pos.line;
    this.column = pos.column;
    this.kind = kind;
  }

  toString(): string {
    return `${this.kind} ERROR [${this.line}:${this.column}] ${this.message}`;
  }
}

// ------------------------------------------------------------
// 类型转换
// ------------------------------------------------------------
export function inferTypeOf(v: DBValue): DataType | 'NULL' {
  if (v === null) return 'NULL';
  switch (typeof v) {
    case 'number':
      return Number.isInteger(v) ? 'INTEGER' : 'REAL';
    case 'boolean':
      return 'BOOLEAN';
    case 'string':
      return 'TEXT';
  }
}

/** 严格地把值转换为目标类型（用于 CAST / INSERT / UPDATE） */
export function castValue(v: DBValue, type: DataType, pos = { line: 1, column: 1 }): DBValue {
  if (v === null) return null;
  const t = typeof v;
  switch (type) {
    case 'INTEGER': {
      if (t === 'number') return Math.trunc(v as number);
      if (t === 'boolean') return (v as boolean) ? 1 : 0;
      if (t === 'string') {
        const n = parseIntSql(v as string);
        if (n === null || Number.isNaN(n)) throw new SQLError(`cannot cast TEXT "${v}" to INTEGER`, pos, 'TYPE');
        return n;
      }
      break;
    }
    case 'REAL': {
      if (t === 'number') return v;
      if (t === 'boolean') return (v as boolean) ? 1.0 : 0.0;
      if (t === 'string') {
        const n = parseFloatSql(v as string);
        if (n === null || Number.isNaN(n)) throw new SQLError(`cannot cast TEXT "${v}" to REAL`, pos, 'TYPE');
        return n;
      }
      break;
    }
    case 'TEXT': {
      if (t === 'string') return v;
      if (t === 'boolean') return (v as boolean) ? 'true' : 'false';
      if (t === 'number') return Number.isInteger(v as number) ? String(v) : String(v);
      break;
    }
    case 'BOOLEAN': {
      if (t === 'boolean') return v;
      if (t === 'number') {
        if (v === 0) return false;
        if (v === 1) return true;
        throw new SQLError(`cannot cast number ${v} to BOOLEAN (only 0/1)`, pos, 'TYPE');
      }
      if (t === 'string') {
        const s = (v as string).trim().toLowerCase();
        if (s === 'true' || s === '1') return true;
        if (s === 'false' || s === '0' || s === '') return false;
        throw new SQLError(`cannot cast TEXT "${v}" to BOOLEAN`, pos, 'TYPE');
      }
      break;
    }
  }
  throw new SQLError(`cannot cast ${inferTypeOf(v)} to ${type}`, pos, 'TYPE');
}

function parseIntSql(s: string): number | null {
  const t = s.trim();
  if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  // 允许 "12abc" 截断为 12（SQLite 风格）
  const m = /^[+-]?\d+/.exec(t);
  if (m) return parseInt(m[0], 10);
  if (/^[+-]?\s*infinity$/.test(t)) return Number.POSITIVE_INFINITY;
  return null;
}

function parseFloatSql(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  const m = /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(t);
  if (m) return Number(m[0]);
  return null;
}
