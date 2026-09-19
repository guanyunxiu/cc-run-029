// ============================================================
// 抽象语法树（AST）定义
// ============================================================

import type { DataType } from './types';

export interface Pos { line: number; column: number; }

// ---------------- 表达式 ----------------
export type Expr =
  | LiteralExpr
  | ColumnRefExpr
  | StarExpr
  | UnaryExpr
  | BinaryExpr
  | LogicalExpr
  | NotExpr
  | BetweenExpr
  | InListExpr
  | InSubqueryExpr
  | ExistsExpr
  | LikeExpr
  | IsNullExpr
  | IsBooleanExpr
  | CaseExpr
  | CastExpr
  | FuncCallExpr
  | SubqueryExpr;

export interface LiteralExpr {
  kind: 'literal';
  value: number | string | boolean | null;
  pos: Pos;
}

export interface ColumnRefExpr {
  kind: 'column';
  table: string | null;   // 限定符（原始名，可能带引号）
  name: string;           // 列名
  pos: Pos;
}

export interface StarExpr {
  kind: 'star';
  table: string | null;   // t.*
  pos: Pos;
}

export interface UnaryExpr {
  kind: 'unary';
  op: '+' | '-';
  expr: Expr;
  pos: Pos;
}

export interface BinaryExpr {
  kind: 'binary';
  op: '+' | '-' | '*' | '/' | '%' | '=' | '<>' | '<' | '<=' | '>' | '>=';
  left: Expr;
  right: Expr;
  pos: Pos;
}

export interface LogicalExpr {
  kind: 'logical';
  op: 'AND' | 'OR';
  left: Expr;
  right: Expr;
  pos: Pos;
}

export interface NotExpr {
  kind: 'not';
  expr: Expr;
  pos: Pos;
}

export interface BetweenExpr {
  kind: 'between';
  expr: Expr;
  negated: boolean;
  low: Expr;
  high: Expr;
  pos: Pos;
}

export interface InListExpr {
  kind: 'inList';
  expr: Expr;
  negated: boolean;
  list: Expr[];
  pos: Pos;
}

export interface InSubqueryExpr {
  kind: 'inSubquery';
  expr: Expr;
  negated: boolean;
  subquery: SelectStmt;
  pos: Pos;
}

export interface ExistsExpr {
  kind: 'exists';
  negated: boolean;
  subquery: SelectStmt;
  pos: Pos;
}

export interface LikeExpr {
  kind: 'like';
  expr: Expr;
  negated: boolean;
  pattern: Expr;
  pos: Pos;
}

export interface IsNullExpr {
  kind: 'isNull';
  expr: Expr;
  negated: boolean;
  pos: Pos;
}

export interface IsBooleanExpr {
  kind: 'isBoolean';
  expr: Expr;
  negated: boolean;
  want: boolean; // true: IS TRUE，false: IS FALSE
  pos: Pos;
}

export interface CaseExpr {
  kind: 'case';
  operand: Expr | null;          // 简单 CASE
  whens: { when: Expr; then: Expr }[];
  elseExpr: Expr | null;
  pos: Pos;
}

export interface CastExpr {
  kind: 'cast';
  expr: Expr;
  type: DataType;
  pos: Pos;
}

export interface FuncCallExpr {
  kind: 'func';
  name: string;                 // 大写：COUNT/SUM/...
  distinct: boolean;
  args: Expr[];                 // COUNT(*) 用 star
  star: boolean;
  pos: Pos;
}

export interface SubqueryExpr {
  kind: 'scalarSubquery';
  subquery: SelectStmt;
  pos: Pos;
}

// ---------------- SELECT 相关 ----------------
export interface SelectItem {
  expr: Expr;
  alias: string | null;
  pos: Pos;
}

export type TableRef =
  | { kind: 'table'; name: string; alias: string | null; pos: Pos }
  | { kind: 'subquery'; subquery: SelectStmt; alias: string; pos: Pos }
  | JoinRef;

export interface JoinRef {
  kind: 'join';
  joinType: 'INNER' | 'LEFT';
  left: TableRef;
  right: TableRef;
  on: Expr | null;
  pos: Pos;
}

export type OrderNulls = 'FIRST' | 'LAST' | null;

export interface OrderItem {
  expr: Expr;
  desc: boolean;
  nulls: OrderNulls;
  pos: Pos;
}

export interface SelectStmt {
  kind: 'select';
  distinct: boolean;
  items: SelectItem[];
  from: TableRef | null;
  where: Expr | null;
  groupBy: Expr[];
  having: Expr | null;
  orderBy: OrderItem[];
  limit: Expr | null;
  offset: Expr | null;
  pos: Pos;
}

// ---------------- DML / DDL / 事务 ----------------
export interface InsertStmt {
  kind: 'insert';
  table: string;
  columns: string[] | null;
  values: Expr[][] | null;       // VALUES (...),(...)
  select: SelectStmt | null;     // INSERT ... SELECT
  pos: Pos;
}

export interface UpdateStmt {
  kind: 'update';
  table: string;
  sets: { column: string; value: Expr; pos: Pos }[];
  where: Expr | null;
  pos: Pos;
}

export interface DeleteStmt {
  kind: 'delete';
  table: string;
  where: Expr | null;
  pos: Pos;
}

export interface CreateTableStmt {
  kind: 'createTable';
  name: string;
  ifNotExists: boolean;
  columns: {
    name: string;
    type: DataType;
    primaryKey: boolean;
    autoincrement: boolean;
    notNull: boolean;
    unique: boolean;
  }[];
  tablePrimaryKey: string[] | null;
  pos: Pos;
}

export interface DropTableStmt {
  kind: 'dropTable';
  name: string;
  ifExists: boolean;
  pos: Pos;
}

export interface CreateIndexStmt {
  kind: 'createIndex';
  name: string;
  table: string;
  column: string;
  unique: boolean;
  ifNotExists: boolean;
  pos: Pos;
}

export interface DropIndexStmt {
  kind: 'dropIndex';
  name: string;
  ifExists: boolean;
  pos: Pos;
}

export interface TxnStmt {
  kind: 'txn';
  op: 'BEGIN' | 'COMMIT' | 'ROLLBACK';
  pos: Pos;
}

export interface ExplainStmt {
  kind: 'explain';
  inner: Stmt;
  pos: Pos;
}

export type Stmt =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | DropTableStmt
  | CreateIndexStmt
  | DropIndexStmt
  | TxnStmt
  | ExplainStmt;
