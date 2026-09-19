// SQL 值类型与表结构定义

export type SqlType = 'INTEGER' | 'REAL' | 'TEXT' | 'BOOLEAN';

export type SqlValue = number | string | boolean | null;

/** 运行时的列描述（计划/执行结果中使用） */
export interface ColumnInfo {
  name: string;
  table?: string;
  type: SqlType | 'UNKNOWN';
}

export interface TableColumn {
  name: string;
  type: SqlType;
  primaryKey?: boolean;
  nullable?: boolean;
  default?: SqlValue;
}

export interface IndexDef {
  name: string;
  table: string;
  column: string;
  unique: boolean;
}

export interface TableDef {
  name: string;
  columns: TableColumn[];
  indexes: IndexDef[];
}

/** 一行数据：列名 -> 值（不区分表别名的限定名在绑定阶段处理） */
export type Row = Record<string, SqlValue>;

/** 带表限定的行环境：表名/别名 -> Row */
export type RowEnv = Record<string, Row>;

/** 执行结果 */
export interface QueryResult {
  columns: ColumnInfo[];
  rows: SqlValue[][];
  rowCount: number;
  affectedRows?: number;
  message?: string;
  plan?: PlanNodeJSON;
}

/** 执行计划 JSON 节点（供 UI 展示） */
export interface PlanNodeJSON {
  op: string;
  detail: string;
  indexUsed?: string;
  estimatedRows?: number;
  actualRows?: number;
  children: PlanNodeJSON[];
}

export class SqlError extends Error {
  line: number;
  column: number;
  constructor(message: string, line = 0, column = 0) {
    super(line > 0 ? `第 ${line} 行第 ${column} 列: ${message}` : message);
    this.name = 'SqlError';
    this.line = line;
    this.column = column;
  }
}
