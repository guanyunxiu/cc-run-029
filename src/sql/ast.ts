// AST 节点定义
import { SqlType, SqlValue } from './types';

// ---------- 表达式 ----------
export interface LiteralExpr {
  kind: 'literal';
  value: SqlValue;
}

export interface ColumnRefExpr {
  kind: 'column';
  table?: string; // 限定名 a.col 中的 a
  name: string;
  star?: boolean; // a.*
}

export interface StarExpr {
  kind: 'star';
}

export interface BinaryExpr {
  kind: 'binary';
  op: string; // + - * / % = <> < > <= >= AND OR
  left: Expr;
  right: Expr;
}

export interface UnaryExpr {
  kind: 'unary';
  op: 'NOT' | '-' | '+';
  expr: Expr;
}

export interface BetweenExpr {
  kind: 'between';
  expr: Expr;
  negated: boolean;
  low: Expr;
  high: Expr;
}

export interface InListExpr {
  kind: 'inList';
  expr: Expr;
  negated: boolean;
  values: Expr[];
}

export interface InSubqueryExpr {
  kind: 'inSubquery';
  expr: Expr;
  negated: boolean;
  subquery: SelectStmt;
}

export interface ExistsExpr {
  kind: 'exists';
  negated: boolean;
  subquery: SelectStmt;
}

export interface ScalarSubqueryExpr {
  kind: 'scalarSubquery';
  subquery: SelectStmt;
}

export interface LikeExpr {
  kind: 'like';
  expr: Expr;
  negated: boolean;
  pattern: Expr;
}

export interface IsNullExpr {
  kind: 'isNull';
  expr: Expr;
  negated: boolean;
}

export interface CaseExpr {
  kind: 'case';
  operand?: Expr; // 简单 CASE：CASE x WHEN v1 THEN ...
  whens: { when: Expr; then: Expr }[];
  else?: Expr;
}

export interface CastExpr {
  kind: 'cast';
  expr: Expr;
  type: SqlType;
}

export interface FunctionCallExpr {
  kind: 'func';
  name: string; // COUNT/SUM/AVG/MIN/MAX（聚合）或普通函数
  distinct: boolean;
  args: Expr[]; // COUNT(*) 时 args 为 star
  star?: boolean;
}

export type Expr =
  | LiteralExpr
  | ColumnRefExpr
  | StarExpr
  | BinaryExpr
  | UnaryExpr
  | BetweenExpr
  | InListExpr
  | InSubqueryExpr
  | ExistsExpr
  | ScalarSubqueryExpr
  | LikeExpr
  | IsNullExpr
  | CaseExpr
  | CastExpr
  | FunctionCallExpr;

// ---------- 查询结构 ----------
export interface SelectItem {
  expr: Expr;
  alias?: string;
}

export type JoinKind = 'INNER' | 'LEFT';

export interface TableRef {
  kind: 'table';
  name: string;
  alias?: string;
}

export interface SubqueryRef {
  kind: 'subquery';
  subquery: SelectStmt;
  alias: string;
}

export interface JoinClause {
  joinKind: JoinKind;
  right: TableRef | SubqueryRef;
  on?: Expr;
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  selectList: SelectItem[];
  from?: TableRef | SubqueryRef;
  joins: JoinClause[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: { expr: Expr; desc: boolean }[];
  limit?: Expr;
  offset?: Expr;
}

// ---------- DDL / DML ----------
export interface ColumnDef {
  name: string;
  type: SqlType;
  primaryKey: boolean;
  nullable: boolean;
  unique: boolean;
  default?: SqlValue;
}

export interface CreateTableStmt {
  kind: 'createTable';
  ifNotExists: boolean;
  name: string;
  columns: ColumnDef[];
}

export interface DropTableStmt {
  kind: 'dropTable';
  ifExists: boolean;
  name: string;
}

export interface CreateIndexStmt {
  kind: 'createIndex';
  unique: boolean;
  ifNotExists: boolean;
  name: string;
  table: string;
  column: string;
}

export interface DropIndexStmt {
  kind: 'dropIndex';
  ifExists: boolean;
  name: string;
}

export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns?: string[];
  values: SqlValue[][]; // 多行 VALUES
}

export interface UpdateStmt {
  kind: 'update';
  table: string;
  sets: { column: string; expr: Expr }[];
  where?: Expr;
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  where?: Expr;
}

export interface ExplainStmt {
  kind: 'explain';
  inner: Statement;
}

export interface TxnStmt {
  kind: 'txn';
  action: 'BEGIN' | 'COMMIT' | 'ROLLBACK';
}

export type Statement =
  | SelectStmt
  | CreateTableStmt
  | DropTableStmt
  | CreateIndexStmt
  | DropIndexStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | ExplainStmt
  | TxnStmt;
