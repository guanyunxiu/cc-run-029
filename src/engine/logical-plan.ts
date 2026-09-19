// ============================================================
// 逻辑计划（Logical Plan）
// ============================================================

import type { DataType, DBValue } from '../sql/types';
import type { CompiledExpr } from './eval-expr';

/** 输出槽位描述（限定名与展示名） */
export interface OutputColumn {
  /** 唯一内部名（绑定阶段生成） */
  id: string;
  /** 展示名（结果表格的表头） */
  label: string;
  /** 来源表别名（null 表示表达式/子查询） */
  sourceAlias: string | null;
  /** 原始列名（表达式为 null） */
  originName: string | null;
  /** 数据类型（尽力推断） */
  type: DataType | 'NULL' | 'ANY';
}

// ---------------- 逻辑关系算子 ----------------
export interface LogicalScan {
  node: 'scan';
  table: string;            // 真实表名
  alias: string;            // 查询中的别名
  columns: OutputColumn[];
  /** 索引使用信息（优化器填充） */
  index?: IndexUse;
}

export interface LogicalSubquerySource {
  node: 'subquerySource';
  alias: string;
  plan: LogicalPlan;
  columns: OutputColumn[];
}

export interface LogicalFilter {
  node: 'filter';
  input: LogicalPlan;
  predicate: BoundExprRef; // 引用 BoundExpr 池中的编号
}

export interface LogicalProject {
  node: 'project';
  input: LogicalPlan;
  items: { expr: BoundExprRef; label: string; type: OutputColumn['type'] }[];
  distinct: boolean;
}

export interface LogicalJoin {
  node: 'join';
  joinType: 'INNER' | 'LEFT';
  left: LogicalPlan;
  right: LogicalPlan;
  condition: BoundExprRef | null;
  /** 物理实现提示（优化器） */
  impl?: 'NESTED_LOOP' | 'HASH';
  /** Hash join 的等值键（AST 表达式，分别相对左/右输入解析） */
  hashKeys?: { leftAst: import('../sql/ast').Expr; rightAst: import('../sql/ast').Expr }[];
  /** 其余非等值条件表达式（BoundExpr 编号） */
  otherConditions?: BoundExprRef[];
}

export interface LogicalAggregate {
  node: 'aggregate';
  input: LogicalPlan;
  groups: BoundExprRef[];
  aggregates: AggregateSpec[];
  /** 分组列在输出中的名字 */
  groupOutputs: { expr: BoundExprRef; label: string }[];
  /** 是否没有 GROUP BY 但存在聚合 */
  globalAgg: boolean;
}

export interface LogicalSort {
  node: 'sort';
  input: LogicalPlan;
  keys: { expr: BoundExprRef; desc: boolean; nullsFirst: boolean }[];
}

export interface LogicalLimit {
  node: 'limit';
  input: LogicalPlan;
  limit: number;
  offset: number;
}

export interface LogicalDistinct {
  node: 'distinct';
  input: LogicalPlan;
}

export interface LogicalDummy {
  node: 'dummy';
}

/** INSERT ... SELECT 的源 */
export interface LogicalDmlSource {
  node: 'dmlSource';
  select: LogicalPlan;
}

export type LogicalPlan =
  | LogicalScan
  | LogicalSubquerySource
  | LogicalFilter
  | LogicalProject
  | LogicalJoin
  | LogicalAggregate
  | LogicalSort
  | LogicalLimit
  | LogicalDistinct
  | LogicalDummy;

// ---------------- 绑定后的表达式 ----------------
export type BoundExprRef = number;

export interface BoundExpr {
  eval: CompiledExpr;
  /** 用于规则优化/计划展示的可读形式 */
  debug: string;
  /** 引用的列 id 集合（用于相关性判断） */
  columnRefs: Set<string>;
  /** 是否相关到外层（绑定后由 Binder 设置） */
  correlated?: boolean;
  /** 是否常量（无列引用、无子查询） */
  constant: boolean;
  /** 来源 AST（优化器用于谓词分析） */
  ast?: import('../sql/ast').Expr;
}

// ---------------- 聚合 ----------------
export type AggregateKind = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface AggregateSpec {
  kind: AggregateKind;
  distinct: boolean;
  /** COUNT(*) 的参数为 null */
  arg: BoundExprRef | null;
  /** 输出列名（如 "COUNT(*)"） */
  label: string;
  /** 返回类型 */
  type: DataType | 'ANY';
}

// ---------------- 索引使用 ----------------
export interface IndexUse {
  indexName: string;       // PRIMARY 或实际索引名
  column: string;
  kind: 'PRIMARY' | 'SECONDARY' | 'UNIQUE';
  access: 'EQ' | 'RANGE' | 'SCAN';
  detail: string;          // 例如 "id = 1"
  /** 估算扫描行数（用于计划展示） */
  estimatedRows: number | string;
  /** EQ 访问的值 */
  eqValue?: DBValue;
  /** RANGE 访问的上下界（null 表示无界） */
  range?: { low: DBValue; high: DBValue; lowInclusive: boolean; highInclusive: boolean };
}

// ---------------- 语句执行计划 ----------------
export interface InsertPlan {
  kind: 'insert';
  table: string;
  columns: string[] | null;
  values?: DBValue[][];          // 已求值/转换
  source?: LogicalPlan;          // INSERT SELECT
  rowsAffected: number;
}

export interface UpdatePlan {
  kind: 'update';
  table: string;
  scan: LogicalPlan;             // 产生 { __pk, ...列 }
  sets: { column: string; expr: BoundExprRef; pos: { line: number; column: number } }[];
  rowsAffected: number;
}

export interface DeletePlan {
  kind: 'delete';
  table: string;
  scan: LogicalPlan;
  rowsAffected: number;
}

export interface CreateTablePlan {
  kind: 'createTable';
  sql: import('../sql/ast').CreateTableStmt;
}
export interface DropTablePlan {
  kind: 'dropTable';
  sql: import('../sql/ast').DropTableStmt;
}
export interface CreateIndexPlan {
  kind: 'createIndex';
  sql: import('../sql/ast').CreateIndexStmt;
}
export interface DropIndexPlan {
  kind: 'dropIndex';
  sql: import('../sql/ast').DropIndexStmt;
}
export interface TxnPlan {
  kind: 'txn';
  op: 'BEGIN' | 'COMMIT' | 'ROLLBACK';
}

export type StatementPlan =
  | { kind: 'select'; plan: LogicalPlan; outputs: OutputColumn[] }
  | InsertPlan | UpdatePlan | DeletePlan
  | CreateTablePlan | DropTablePlan | CreateIndexPlan | DropIndexPlan
  | TxnPlan;
