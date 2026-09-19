// 执行器：绑定后的表达式、算子（火山模型 next()）、求值器
import { ColumnInfo, PlanNodeJSON, Row, SqlType, SqlValue, TableDef } from '../sql/types';
import * as AST from '../sql/ast';
import { Expr as AstExpr, SelectStmt } from '../sql/ast';
import {
  castValue,
  isNull,
  isTrue,
  sqlArith,
  sqlCompare,
  sqlLike,
  triAnd,
  triNot,
  triOr,
  typeOf,
} from './value';
import { evalScalarFunction, SCALAR_FUNCTIONS } from './functions';
import { Storage, StoredRow, TxnContext } from './storage';
import { SqlError } from '../sql/types';

// ---------- 绑定 ----------
export interface SourceMeta {
  alias: string; // 行环境中的键
  table?: string; // 真实表名（子查询源没有）
  columns: ColumnInfo[];
}

export interface Scope {
  sources: SourceMeta[];
  parent?: Scope;
}

export type BoundExpr =
  | { kind: 'literal'; value: SqlValue }
  | { kind: 'column'; source: string; name: string; type: SqlType | 'UNKNOWN' }
  | { kind: 'binary'; op: string; left: BoundExpr; right: BoundExpr }
  | { kind: 'unary'; op: 'NOT' | '-' | '+'; expr: BoundExpr }
  | { kind: 'between'; expr: BoundExpr; negated: boolean; low: BoundExpr; high: BoundExpr }
  | { kind: 'inList'; expr: BoundExpr; negated: boolean; values: BoundExpr[] }
  | { kind: 'inSub'; expr: BoundExpr; negated: boolean; plan: PreparedSubquery }
  | { kind: 'exists'; negated: boolean; plan: PreparedSubquery }
  | { kind: 'scalarSub'; plan: PreparedSubquery }
  | { kind: 'like'; expr: BoundExpr; negated: boolean; pattern: BoundExpr }
  | { kind: 'isNull'; expr: BoundExpr; negated: boolean }
  | { kind: 'case'; operand?: BoundExpr; whens: { when: BoundExpr; then: BoundExpr }[]; else?: BoundExpr }
  | { kind: 'cast'; expr: BoundExpr; type: SqlType }
  | { kind: 'func'; name: string; distinct: boolean; args: BoundExpr[]; star?: boolean }
  | { kind: 'aggRef'; index: number };

export interface PreparedSubquery {
  /** 用当前外层作用域构建执行计划（每次外层行求值时调用，支持关联子查询） */
  buildPlan: () => Promise<ExecPlan>;
  isCorrelated: boolean;
}

export interface ExecPlan {
  root: Operator;
  outputColumns: ColumnInfo[];
  scope: Scope;
}

export const AGG_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

/** 前向声明：planner 构建上下文的最小结构（避免 executor 反向依赖 planner） */
export interface SubqueryBuildApi {
  buildSubquery(stmt: SelectStmt, outer: Scope): Promise<ExecPlan>;
}

export class Binder {
  /** 由 Planner 注入：子查询计划构建入口（绑定期闭包直接捕获，避免全局状态串用） */
  subqueryApi: SubqueryBuildApi | null = null;

  findColumn(
    scope: Scope,
    table: string | undefined,
    name: string,
    allowOuter = true,
  ): { source: string; col: ColumnInfo } {
    if (table) {
      let s: Scope | undefined = scope;
      while (s) {
        const src = s.sources.find((x) => x.alias.toLowerCase() === table.toLowerCase());
        if (src) {
          const col = src.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (col) return { source: src.alias, col };
          throw new SqlError(`表别名 ${table} 中不存在列 ${name}`);
        }
        if (!allowOuter) break;
        s = s.parent;
      }
      throw new SqlError(`未知的表别名: ${table}`);
    }
    const matches: { source: string; col: ColumnInfo }[] = [];
    let s: Scope | undefined = scope;
    while (s) {
      for (const src of s.sources) {
        for (const col of src.columns) {
          if (col.name.toLowerCase() === name.toLowerCase()) matches.push({ source: src.alias, col });
        }
      }
      if (matches.length > 0) break; // 内层优先
      if (!allowOuter) break;
      s = s.parent;
    }
    if (matches.length === 0) throw new SqlError(`未知的列: ${name}`);
    if (matches.length > 1) throw new SqlError(`列名 ${name} 有歧义，请使用 表名.列名`);
    return matches[0];
  }

  sourceForTable(def: TableDef, alias?: string): SourceMeta {
    return {
      alias: alias ?? def.name,
      table: def.name,
      columns: def.columns.map((c) => ({ name: c.name, table: alias ?? def.name, type: c.type })),
    };
  }

  sourceForSubquery(plan: ExecPlan, alias: string): SourceMeta {
    return {
      alias,
      columns: plan.outputColumns.map((c) => ({ name: c.name, table: alias, type: c.type })),
    };
  }

  /** 绑定表达式；遇到聚合函数调用时登记到 aggMap 并替换为 aggRef */
  bindExpr(expr: AstExpr, scope: Scope, aggMap?: Map<AST.FunctionCallExpr, number>): BoundExpr {
    switch (expr.kind) {
      case 'literal':
        return { kind: 'literal', value: expr.value };
      case 'column': {
        if (expr.star) throw new SqlError('不能在此处使用 *');
        const found = this.findColumn(scope, expr.table, expr.name);
        return { kind: 'column', source: found.source, name: found.col.name, type: found.col.type };
      }
      case 'star':
        throw new SqlError('不能在此处使用 *');
      case 'binary':
        return {
          kind: 'binary',
          op: expr.op,
          left: this.bindExpr(expr.left, scope, aggMap),
          right: this.bindExpr(expr.right, scope, aggMap),
        };
      case 'unary':
        return { kind: 'unary', op: expr.op, expr: this.bindExpr(expr.expr, scope, aggMap) };
      case 'between':
        return {
          kind: 'between',
          negated: expr.negated,
          expr: this.bindExpr(expr.expr, scope, aggMap),
          low: this.bindExpr(expr.low, scope, aggMap),
          high: this.bindExpr(expr.high, scope, aggMap),
        };
      case 'inList':
        return {
          kind: 'inList',
          negated: expr.negated,
          expr: this.bindExpr(expr.expr, scope, aggMap),
          values: expr.values.map((v) => this.bindExpr(v, scope, aggMap)),
        };
      case 'like':
        return {
          kind: 'like',
          negated: expr.negated,
          expr: this.bindExpr(expr.expr, scope, aggMap),
          pattern: this.bindExpr(expr.pattern, scope, aggMap),
        };
      case 'isNull':
        return {
          kind: 'isNull',
          negated: expr.negated,
          expr: this.bindExpr(expr.expr, scope, aggMap),
        };
      case 'case':
        return {
          kind: 'case',
          operand: expr.operand ? this.bindExpr(expr.operand, scope, aggMap) : undefined,
          whens: expr.whens.map((w) => ({
            when: this.bindExpr(w.when, scope, aggMap),
            then: this.bindExpr(w.then, scope, aggMap),
          })),
          else: expr.else ? this.bindExpr(expr.else, scope, aggMap) : undefined,
        };
      case 'cast':
        return { kind: 'cast', type: expr.type, expr: this.bindExpr(expr.expr, scope, aggMap) };
      case 'func': {
        if (AGG_NAMES.has(expr.name)) {
          if (!aggMap) throw new SqlError(`聚合函数 ${expr.name} 不能出现在此处`);
          let idx = aggMap.get(expr);
          if (idx === undefined) {
            idx = aggMap.size;
            aggMap.set(expr, idx);
          }
          return { kind: 'aggRef', index: idx };
        }
        if (!SCALAR_FUNCTIONS.has(expr.name)) throw new SqlError(`未知函数: ${expr.name}`);
        if (expr.star) throw new SqlError('只有 COUNT 支持 * 参数');
        return {
          kind: 'func',
          name: expr.name,
          distinct: expr.distinct,
          args: expr.args.map((a) => this.bindExpr(a, scope, aggMap)),
        };
      }
      case 'inSubquery':
        return {
          kind: 'inSub',
          negated: expr.negated,
          expr: this.bindExpr(expr.expr, scope, aggMap),
          plan: this.prepareSubquery(expr.subquery, scope),
        };
      case 'exists':
        return { kind: 'exists', negated: expr.negated, plan: this.prepareSubquery(expr.subquery, scope) };
      case 'scalarSubquery':
        return { kind: 'scalarSub', plan: this.prepareSubquery(expr.subquery, scope) };
    }
  }

  prepareSubquery(stmt: SelectStmt, outerScope: Scope): PreparedSubquery {
    const refs = collectColumnRefs(stmt);
    const local = localAliases(stmt);
    // 限定名不在子查询 FROM 别名中 => 必然关联；非限定名保守视为可能关联
    let correlated = refs.some((r) => r.table && !local.includes(r.table.toLowerCase()));
    if (!correlated) correlated = refs.some((r) => !r.table);
    const api = this.subqueryApi;
    return {
      buildPlan: () => {
        if (!api) throw new Error('planner 未初始化');
        return api.buildSubquery(stmt, outerScope);
      },
      isCorrelated: correlated,
    };
  }
}

interface ColRef {
  table?: string;
  name: string;
}

function collectColumnRefs(stmt: SelectStmt): ColRef[] {
  const refs: ColRef[] = [];
  const walkExpr = (e: AstExpr): void => {
    switch (e.kind) {
      case 'column':
        if (!e.star) refs.push({ table: e.table, name: e.name });
        return;
      case 'binary':
        walkExpr(e.left);
        walkExpr(e.right);
        return;
      case 'unary':
        walkExpr(e.expr);
        return;
      case 'between':
        walkExpr(e.expr);
        walkExpr(e.low);
        walkExpr(e.high);
        return;
      case 'inList':
        walkExpr(e.expr);
        e.values.forEach(walkExpr);
        return;
      case 'like':
        walkExpr(e.expr);
        walkExpr(e.pattern);
        return;
      case 'isNull':
        walkExpr(e.expr);
        return;
      case 'case':
        if (e.operand) walkExpr(e.operand);
        e.whens.forEach((w) => {
          walkExpr(w.when);
          walkExpr(w.then);
        });
        if (e.else) walkExpr(e.else);
        return;
      case 'cast':
        walkExpr(e.expr);
        return;
      case 'func':
        e.args.forEach(walkExpr);
        return;
      default:
        return;
    }
  };
  for (const item of stmt.selectList) walkExpr(item.expr);
  if (stmt.where) walkExpr(stmt.where);
  stmt.groupBy.forEach(walkExpr);
  if (stmt.having) walkExpr(stmt.having);
  stmt.orderBy.forEach((o) => walkExpr(o.expr));
  if (stmt.from?.kind === 'subquery') refs.push(...collectColumnRefs(stmt.from.subquery));
  for (const j of stmt.joins) {
    if (j.on) walkExpr(j.on);
    if (j.right.kind === 'subquery') refs.push(...collectColumnRefs(j.right.subquery));
  }
  return refs;
}

function localAliases(stmt: SelectStmt): string[] {
  const aliases: string[] = [];
  if (stmt.from) {
    if (stmt.from.kind === 'table') aliases.push(stmt.from.alias ?? stmt.from.name);
    else aliases.push(stmt.from.alias);
  }
  for (const j of stmt.joins) {
    if (j.right.kind === 'table') aliases.push(j.right.alias ?? j.right.name);
    else aliases.push(j.right.alias);
  }
  return aliases.map((a) => a.toLowerCase());
}

// ---------- 求值环境 ----------
/**
 * 算子行：既可能是 {别名: {列: 值}} 的嵌套形式（扫描/连接），
 * 也可能是 {列: 值} 的扁平行（投影/去重/排序后）。
 * 聚合算子输出 { __group: {...} }。统一用宽松索引签名承载。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataRow = Record<string, any>;

export interface EvalEnv {
  row: DataRow;
  aggs?: SqlValue[];
}

export interface ExecContext {
  txn: TxnContext;
  storage: Storage;
  outerEnv?: DataRow; // 关联子查询的外层行（逐层合并）
  outerScope?: Scope; // 关联子查询绑定时使用的外层作用域
}

export async function evalExpr(expr: BoundExpr, env: EvalEnv, ctx: ExecContext): Promise<SqlValue> {
  switch (expr.kind) {
    case 'literal':
      return expr.value;
    case 'column': {
      // __flat：投影后的扁平行，直接按列名从行对象取值
      if (expr.source === '__flat') {
        const fr: DataRow | undefined = env.row.__flat;
        const v = fr ? fr[expr.name] : env.row[expr.name];
        return v === undefined ? null : (v as SqlValue);
      }
      const row: DataRow | undefined = env.row[expr.source] ?? ctx.outerEnv?.[expr.source];
      if (!row) throw new SqlError(`执行错误：缺少表别名 ${expr.source} 的行数据`);
      const v = row[expr.name];
      return v === undefined ? null : (v as SqlValue);
    }
    case 'aggRef':
      if (env.aggs === undefined) throw new SqlError('聚合结果不可用');
      return env.aggs[expr.index] ?? null;
    case 'unary': {
      const v = await evalExpr(expr.expr, env, ctx);
      if (expr.op === 'NOT') return triNot(toBool(v));
      if (v === null) return null;
      const n = typeof v === 'number' ? v : Number(v);
      return expr.op === '-' ? -n : +n;
    }
    case 'binary':
      return evalBinary(expr.op, expr.left, expr.right, env, ctx);
    case 'between': {
      const [v, lo, hi] = await Promise.all([
        evalExpr(expr.expr, env, ctx),
        evalExpr(expr.low, env, ctx),
        evalExpr(expr.high, env, ctx),
      ]);
      if (v === null || lo === null || hi === null) return null;
      const c1 = sqlCompare(v, lo);
      const c2 = sqlCompare(v, hi);
      if (c1 === null || c2 === null) return null;
      const result = c1 !== null && c2 !== null && c1 >= 0 && c2 <= 0;
      return expr.negated ? !result : result;
    }
    case 'inList': {
      const v = await evalExpr(expr.expr, env, ctx);
      let found = false;
      let hasNull = false;
      for (const item of expr.values) {
        const iv = await evalExpr(item, env, ctx);
        if (iv === null) {
          hasNull = true;
          continue;
        }
        if (v !== null && sqlCompare(v, iv) === 0) found = true;
      }
      if (v === null) return expr.negated ? (hasNull ? null : true) : null;
      if (expr.negated) {
        if (found) return false;
        return hasNull ? null : true;
      }
      return found ? true : hasNull ? null : false;
    }
    case 'like': {
      const [v, p] = await Promise.all([
        evalExpr(expr.expr, env, ctx),
        evalExpr(expr.pattern, env, ctx),
      ]);
      if (v === null || p === null) return null;
      const result = sqlLike(String(v), String(p));
      return expr.negated ? !result : result;
    }
    case 'isNull': {
      const v = await evalExpr(expr.expr, env, ctx);
      const result = v === null || v === undefined;
      return expr.negated ? !result : result;
    }
    case 'case': {
      if (expr.operand) {
        const ov = await evalExpr(expr.operand, env, ctx);
        for (const w of expr.whens) {
          const wv = await evalExpr(w.when, env, ctx);
          if (ov !== null && wv !== null && sqlCompare(ov, wv) === 0) {
            return evalExpr(w.then, env, ctx);
          }
        }
      } else {
        for (const w of expr.whens) {
          if (isTrue(await evalExpr(w.when, env, ctx))) return evalExpr(w.then, env, ctx);
        }
      }
      return expr.else ? evalExpr(expr.else, env, ctx) : null;
    }
    case 'cast': {
      try {
        return castValue(await evalExpr(expr.expr, env, ctx), expr.type);
      } catch (e) {
        throw new SqlError((e as Error).message);
      }
    }
    case 'func': {
      const args: SqlValue[] = [];
      for (const a of expr.args) args.push(await evalExpr(a, env, ctx));
      return evalScalarFunction(expr.name, args);
    }
    case 'inSub':
      return evalInSub(expr, env, ctx);
    case 'exists':
      return evalExists(expr, env, ctx);
    case 'scalarSub':
      return evalScalarSub(expr, env, ctx);
  }
}

function toBool(v: SqlValue): boolean | null {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toUpperCase();
  if (s === 'TRUE' || s === '1') return true;
  if (s === 'FALSE' || s === '0') return false;
  return null;
}

async function evalBinary(
  op: string,
  leftB: BoundExpr,
  rightB: BoundExpr,
  env: EvalEnv,
  ctx: ExecContext,
): Promise<SqlValue> {
  const [l, r] = await Promise.all([evalExpr(leftB, env, ctx), evalExpr(rightB, env, ctx)]);
  switch (op) {
    case 'AND':
      return triAnd(toBool(l), toBool(r));
    case 'OR':
      return triOr(toBool(l), toBool(r));
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return sqlArith(op, l, r);
    case '=':
    case '<>':
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const c = sqlCompare(l, r);
      if (c === null) return null;
      switch (op) {
        case '=':
          return c === 0;
        case '<>':
          return c !== 0;
        case '<':
          return c < 0;
        case '>':
          return c > 0;
        case '<=':
          return c <= 0;
        case '>=':
          return c >= 0;
      }
      return null;
    }
    default:
      throw new SqlError(`不支持的运算符 ${op}`);
  }
}

// ---------- 子查询执行 ----------
async function runSubqueryPlan(
  plan: ExecPlan,
  outerEnv: DataRow | undefined,
  ctx: ExecContext,
  outerScope: Scope,
): Promise<DataRow[]> {
  const subCtx: ExecContext = {
    txn: ctx.txn,
    storage: ctx.storage,
    outerEnv,
    outerScope: plan.scope.parent ?? outerScope,
  };
  const rows: DataRow[] = [];
  while (true) {
    const r = await plan.root.next(subCtx);
    if (r === null) break;
    rows.push(r);
  }
  return rows;
}

async function evalInSub(
  expr: Extract<BoundExpr, { kind: 'inSub' }>,
  env: EvalEnv,
  ctx: ExecContext,
): Promise<SqlValue> {
  const v = await evalExpr(expr.expr, env, ctx);
  const outerScope = ctx.outerScope ?? { sources: [] };
  const plan = await expr.plan.buildPlan();
  const outerEnv = mergeEnv(env, ctx);
  const rows = await runSubqueryPlan(plan, outerEnv, ctx, outerScope);
  if (rows.length === 0) return expr.negated ? true : false;
  if (v === null) return null;
  let hasNull = false;
  for (const row of rows) {
    const sv = firstValue(row, plan.outputColumns);
    if (sv === null) {
      hasNull = true;
      continue;
    }
    if (sqlCompare(v, sv) === 0) return !expr.negated;
  }
  if (expr.negated) return hasNull ? null : true;
  return hasNull ? null : false;
}

async function evalExists(
  expr: Extract<BoundExpr, { kind: 'exists' }>,
  env: EvalEnv,
  ctx: ExecContext,
): Promise<SqlValue> {
  const outerScope = ctx.outerScope ?? { sources: [] };
  const plan = await expr.plan.buildPlan();
  const outerEnv = mergeEnv(env, ctx);
  const rows = await runSubqueryPlan(plan, outerEnv, ctx, outerScope);
  const result = rows.length > 0;
  return expr.negated ? !result : result;
}

async function evalScalarSub(
  expr: Extract<BoundExpr, { kind: 'scalarSub' }>,
  env: EvalEnv,
  ctx: ExecContext,
): Promise<SqlValue> {
  const outerScope = ctx.outerScope ?? { sources: [] };
  const plan = await expr.plan.buildPlan();
  const outerEnv = mergeEnv(env, ctx);
  const rows = await runSubqueryPlan(plan, outerEnv, ctx, outerScope);
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new SqlError('标量子查询返回了多于一行');
  return firstValue(rows[0], plan.outputColumns);
}

function mergeEnv(env: EvalEnv, ctx: ExecContext): DataRow {
  return { ...(ctx.outerEnv ?? {}), ...env.row };
}

function firstValue(row: DataRow, columns?: ColumnInfo[]): SqlValue {
  const key = columns?.[0]?.name ?? Object.keys(row)[0];
  return row[key] ?? null;
}

// ---------- 算子（火山模型） ----------
export abstract class Operator {
  actualRows = 0;
  abstract describe(): { op: string; detail: string; indexUsed?: string };
  abstract next(ctx: ExecContext): Promise<DataRow | null>;
  abstract outputColumns(): ColumnInfo[];
  children(): Operator[] {
    return [];
  }
  async reset(): Promise<void> {
    /* 需要复扫的算子覆写 */
  }
  toJSON(): PlanNodeJSON {
    const d = this.describe();
    return {
      op: d.op,
      detail: d.detail,
      indexUsed: d.indexUsed,
      actualRows: this.actualRows,
      children: this.children().map((c) => c.toJSON()),
    };
  }
}

export class TableScanOp extends Operator {
  private buffer: StoredRow[] | null = null;
  private pos = 0;
  private started = false;

  constructor(
    private def: TableDef,
    private alias: string,
    private indexName: string | undefined,
    private indexLabel: string | undefined,
  ) {
    super();
  }

  outputColumns(): ColumnInfo[] {
    return this.def.columns.map((c) => ({ name: c.name, table: this.alias, type: c.type }));
  }

  describe() {
    return {
      op: this.indexName ? 'INDEX_SCAN' : 'TABLE_SCAN',
      detail: `表 ${this.def.name}${this.alias !== this.def.name ? ` AS ${this.alias}` : ''}（全量扫描后过滤）`,
      indexUsed: this.indexLabel,
    };
  }

  private async ensure(ctx: ExecContext): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.buffer = await ctx.storage.scan(ctx.txn, this.def.name, this.indexName ? { indexName: this.indexName } : {});
  }

  async reset(): Promise<void> {
    this.started = false;
    this.buffer = null;
    this.pos = 0;
    this.actualRows = 0;
  }

  async next(ctx: ExecContext): Promise<DataRow | null> {
    await this.ensure(ctx);
    const stored = this.buffer![this.pos++];
    if (!stored) return null;
    this.actualRows++;
    const row: Row = {};
    for (const c of this.def.columns) row[c.name] = stored[c.name] ?? null;
    return { [this.alias]: row };
  }
}

export class FilterOp extends Operator {
  constructor(
    private child: Operator,
    private predicate: BoundExpr,
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns() {
    return this.child.outputColumns();
  }
  describe() {
    return { op: 'FILTER', detail: '条件过滤' };
  }
  override async reset(): Promise<void> {
    this.actualRows = 0;
    await this.child.reset();
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    while (true) {
      const row = await this.child.next(ctx);
      if (!row) return null;
      if (isTrue(await evalExpr(this.predicate, { row }, ctx))) {
        this.actualRows++;
        return row;
      }
    }
  }
}

export interface Projection {
  expr: BoundExpr;
  name: string;
  isStar: boolean;
  starSource?: string;
}

export class ProjectOp extends Operator {
  constructor(
    private child: Operator,
    private projections: Projection[],
    private childSources: SourceMeta[],
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns(): ColumnInfo[] {
    const out: ColumnInfo[] = [];
    for (const p of this.projections) {
      if (p.isStar) {
        for (const c of this.child.outputColumns()) {
          if (!p.starSource || c.table === p.starSource) out.push({ ...c });
        }
      } else {
        out.push({ name: p.name, type: inferType(p.expr) });
      }
    }
    return out;
  }
  describe() {
    return { op: 'PROJECT', detail: `${this.projections.filter((p) => !p.isStar).length} 个输出表达式` };
  }
  override async reset(): Promise<void> {
    this.actualRows = 0;
    await this.child.reset();
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    const inner = await this.child.next(ctx);
    if (!inner) return null;
    // 聚合算子输出 { __group: {分组列+聚合列} }：求值时直接把 __group 作为行环境
    const env: EvalEnv = inner.__group
      ? { row: { __group: inner.__group as DataRow } }
      : { row: inner };
    const out: DataRow = {};
    for (const p of this.projections) {
      if (p.isStar) {
        for (const src of this.childSources) {
          if (p.starSource && src.alias !== p.starSource) continue;
          const r = inner[src.alias];
          if (r) for (const [k, v] of Object.entries(r)) out[k] = v;
        }
      } else {
        out[p.name] = await evalExpr(p.expr, env, ctx);
      }
    }
    this.actualRows++;
    return out;
  }
}

export class NestedLoopJoinOp extends Operator {
  private leftRow: DataRow | null = null;
  private initialized = false;
  private leftMatched = false; // 当前左行是否已有匹配（跨 next 调用保持）
  constructor(
    private left: Operator,
    private right: Operator,
    private kind: 'INNER' | 'LEFT',
    private condition: BoundExpr | undefined,
    private rightSources: SourceMeta[],
  ) {
    super();
  }
  override children() {
    return [this.left, this.right];
  }
  outputColumns(): ColumnInfo[] {
    return [...this.left.outputColumns(), ...this.right.outputColumns()];
  }
  describe() {
    return { op: this.kind === 'LEFT' ? 'LEFT_JOIN' : 'INNER_JOIN', detail: '嵌套循环连接' };
  }
  override async reset(): Promise<void> {
    this.actualRows = 0;
    this.leftRow = null;
    this.initialized = false;
    this.leftMatched = false;
    await this.left.reset();
    await this.right.reset();
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    if (!this.initialized) {
      this.initialized = true;
      this.leftRow = await this.left.next(ctx);
    }
    while (this.leftRow) {
      while (true) {
        const rightRow = await this.right.next(ctx);
        if (!rightRow) break;
        const merged = { ...this.leftRow, ...rightRow };
        if (!this.condition || isTrue(await evalExpr(this.condition, { row: merged }, ctx))) {
          this.leftMatched = true;
          this.actualRows++;
          return merged;
        }
      }
      if (this.kind === 'LEFT' && !this.leftMatched) {
        const nullRow: DataRow = {};
        for (const src of this.rightSources) {
          const r: DataRow = {};
          for (const c of src.columns) r[c.name] = null;
          nullRow[src.alias] = r;
        }
        const out = { ...this.leftRow, ...nullRow };
        this.advanceLeft(ctx);
        this.actualRows++;
        return out;
      }
      await this.advanceLeft(ctx);
    }
    return null;
  }

  private async advanceLeft(ctx: ExecContext): Promise<void> {
    this.leftRow = await this.left.next(ctx);
    this.leftMatched = false;
    await this.right.reset();
  }
}

export interface AggregateSpec {
  name: string;
  distinct: boolean;
  star: boolean;
  arg?: BoundExpr;
  alias: string;
}

interface GroupState {
  key: string;
  groupValues: SqlValue[];
  rows: DataRow[];
}

export class HashAggregateOp extends Operator {
  private groups: GroupState[] | null = null;
  private pos = 0;
  constructor(
    private child: Operator,
    private groupExprs: { expr: BoundExpr; name: string }[],
    private aggregates: AggregateSpec[],
    private having: BoundExpr | undefined,
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns(): ColumnInfo[] {
    const cols: ColumnInfo[] = this.groupExprs.map((g) => ({ name: g.name, type: inferType(g.expr) }));
    for (const a of this.aggregates) {
      const type: SqlType | 'UNKNOWN' =
        a.name === 'COUNT'
          ? 'INTEGER'
          : a.name === 'AVG'
            ? 'REAL'
            : a.arg
              ? inferType(a.arg)
              : 'UNKNOWN';
      cols.push({ name: a.alias, type });
    }
    return cols;
  }
  override async reset(): Promise<void> {
    this.groups = null;
    this.pos = 0;
    this.actualRows = 0;
    await this.child.reset();
  }
  describe() {
    return {
      op: 'HASH_AGGREGATE',
      detail:
        (this.groupExprs.length > 0 ? `GROUP BY ${this.groupExprs.length} 列` : '全局聚合') +
        (this.having ? ' + HAVING' : '') +
        `，${this.aggregates.length} 个聚合`,
    };
  }
  private async build(ctx: ExecContext): Promise<void> {
    if (this.groups) return;
    const map = new Map<string, GroupState>();
    const noGroup = this.groupExprs.length === 0;
    const single: GroupState = { key: '', groupValues: [], rows: [] };
    while (true) {
      const row = await this.child.next(ctx);
      if (!row) break;
      if (noGroup) {
        single.rows.push(row);
      } else {
        const vals: SqlValue[] = [];
        for (const g of this.groupExprs) vals.push(await evalExpr(g.expr, { row }, ctx));
        const key = vals.map(groupKey).join('');
        let gs = map.get(key);
        if (!gs) {
          gs = { key, groupValues: vals, rows: [] };
          map.set(key, gs);
        }
        gs.rows.push(row);
      }
    }
    this.groups = noGroup ? [single] : [...map.values()];
  }

  async next(ctx: ExecContext): Promise<DataRow | null> {
    await this.build(ctx);
    while (this.pos < this.groups!.length) {
      const gs = this.groups![this.pos++];
      const groupRow: DataRow = {};
      const aggValues: SqlValue[] = [];
      this.groupExprs.forEach((g, i) => (groupRow[g.name] = gs.groupValues[i]));
      for (const spec of this.aggregates) {
        const v = await computeAggregate(spec, gs.rows, ctx);
        aggValues.push(v);
        groupRow[spec.alias] = v;
      }
      if (this.having) {
        if (!isTrue(await evalExpr(this.having, { row: { __group: groupRow } }, ctx))) continue;
      }
      this.actualRows++;
      return { __group: groupRow };
    }
    return null;
  }
}

function groupKey(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  return `s:${v}`;
}

async function computeAggregate(spec: AggregateSpec, rows: DataRow[], ctx: ExecContext): Promise<SqlValue> {
  if (spec.name === 'COUNT' && spec.star) return rows.length;
  const values: SqlValue[] = [];
  for (const row of rows) {
    const v = spec.arg ? await evalExpr(spec.arg, { row }, ctx) : null;
    if (!isNull(v)) values.push(v);
  }
  if (spec.distinct) {
    const seen = new Set<string>();
    const dedup: SqlValue[] = [];
    for (const v of values) {
      const k = `${typeof v}:${String(v)}`;
      if (!seen.has(k)) {
        seen.add(k);
        dedup.push(v);
      }
    }
    values.length = 0;
    values.push(...dedup);
  }
  switch (spec.name) {
    case 'COUNT':
      return values.length;
    case 'SUM': {
      if (values.length === 0) return null;
      let sum = 0;
      for (const v of values) sum += typeof v === 'number' ? v : Number(v);
      return sum;
    }
    case 'AVG': {
      if (values.length === 0) return null;
      let sum = 0;
      for (const v of values) sum += typeof v === 'number' ? v : Number(v);
      return sum / values.length;
    }
    case 'MIN':
    case 'MAX': {
      if (values.length === 0) return null;
      let best = values[0];
      for (const v of values.slice(1)) {
        const c = sqlCompare(v, best);
        if (c === null) continue;
        if ((spec.name === 'MIN' && c < 0) || (spec.name === 'MAX' && c > 0)) best = v;
      }
      return best;
    }
    default:
      throw new SqlError(`不支持的聚合函数 ${spec.name}`);
  }
}

export class SortOp extends Operator {
  private buffer: DataRow[] | null = null;
  private pos = 0;
  /**
   * @param outputCols 投影输出列（__out 引用对应扁平行的键）
   * @param sources 投影前的源（用于排序键中引用源列的情况）
   */
  constructor(
    private child: Operator,
    private keys: { expr: BoundExpr; desc: boolean }[],
    private outputCols: ColumnInfo[] = [],
    private sources: SourceMeta[] = [],
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns() {
    return this.child.outputColumns();
  }
  describe() {
    return { op: 'SORT', detail: `ORDER BY ${this.keys.length} 个键` };
  }
  override async reset(): Promise<void> {
    this.buffer = null;
    this.pos = 0;
    this.actualRows = 0;
    await this.child.reset();
  }
  private makeEnv(row: DataRow): EvalEnv {
    // 投影后的扁平行：__flat 直接按键取值；各源别名用行自身兼容
    const rowEnv: DataRow = { __flat: row };
    for (const src of this.sources) rowEnv[src.alias] = row;
    // 聚合结果场景：行本身是 {__group:{...}}
    if (row.__group) rowEnv.__group = row.__group;
    return { row: rowEnv };
  }
  private async build(ctx: ExecContext): Promise<void> {
    if (this.buffer) return;
    const rawRows: DataRow[] = [];
    while (true) {
      const r = await this.child.next(ctx);
      if (!r) break;
      rawRows.push(r);
    }
    const keys = this.keys.map((k) => ({ desc: k.desc, expr: rewriteSortColumns(k.expr) }));
    // 预先异步求出每行的排序键值，再做同步比较
    const decorated = await Promise.all(
      rawRows.map(async (row) => {
        const env = this.makeEnv(row);
        const vals: SqlValue[] = [];
        for (const k of keys) vals.push(await evalExpr(k.expr, env, ctx));
        return { row, vals };
      }),
    );
    decorated.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const va = a.vals[i];
        const vb = b.vals[i];
        const desc = keys[i].desc;
        if (va === null && vb === null) continue;
        if (va === null) return desc ? 1 : -1;
        if (vb === null) return desc ? -1 : 1;
        const c = sqlCompare(va, vb);
        if (c === null || c === 0) continue;
        return desc ? -c : c;
      }
      return 0;
    });
    this.buffer = decorated.map((d) => d.row);
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    await this.build(ctx);
    const r = this.buffer![this.pos++] ?? null;
    if (r) this.actualRows++;
    return r;
  }
}

/** 把 ORDER BY 键中的 __out 引用改为 __flat（扁平行读取） */
function rewriteSortColumns(e: BoundExpr): BoundExpr {
  const walk = (x: BoundExpr): BoundExpr => {
    if (x.kind === 'column' && (x.source === '__out' || x.source === '__group')) {
      return { kind: 'column', source: '__flat', name: x.name, type: x.type };
    }
    switch (x.kind) {
      case 'binary':
        return { ...x, left: walk(x.left), right: walk(x.right) };
      case 'unary':
        return { ...x, expr: walk(x.expr) };
      case 'between':
        return { ...x, expr: walk(x.expr), low: walk(x.low), high: walk(x.high) };
      case 'inList':
        return { ...x, expr: walk(x.expr), values: x.values.map(walk) };
      case 'like':
        return { ...x, expr: walk(x.expr), pattern: walk(x.pattern) };
      case 'isNull':
        return { ...x, expr: walk(x.expr) };
      case 'case':
        return {
          ...x,
          operand: x.operand ? walk(x.operand) : undefined,
          whens: x.whens.map((w) => ({ when: walk(w.when), then: walk(w.then) })),
          else: x.else ? walk(x.else) : undefined,
        };
      case 'cast':
        return { ...x, expr: walk(x.expr) };
      case 'func':
        return { ...x, args: x.args.map(walk) };
      default:
        return x;
    }
  };
  return walk(e);
}

export class LimitOp extends Operator {
  private emitted = 0;
  constructor(
    private child: Operator,
    private limit: number | null,
    private offset: number,
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns() {
    return this.child.outputColumns();
  }
  describe() {
    return {
      op: 'LIMIT_OFFSET',
      detail: `LIMIT ${this.limit === null ? 'ALL' : this.limit} OFFSET ${this.offset}`,
    };
  }
  override async reset(): Promise<void> {
    this.emitted = 0;
    this.actualRows = 0;
    await this.child.reset();
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    while (this.offset > 0) {
      const r = await this.child.next(ctx);
      if (!r) return null;
      this.offset--;
    }
    if (this.limit !== null && this.emitted >= this.limit) return null;
    const r = await this.child.next(ctx);
    if (!r) return null;
    this.emitted++;
    this.actualRows++;
    return r;
  }
}

export class DistinctOp extends Operator {
  private seen = new Set<string>();
  constructor(
    private child: Operator,
    private childCols: ColumnInfo[],
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns() {
    return this.child.outputColumns();
  }
  describe() {
    return { op: 'DISTINCT', detail: '哈希去重' };
  }
  override async reset(): Promise<void> {
    this.seen.clear();
    this.actualRows = 0;
    await this.child.reset();
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    while (true) {
      const r = await this.child.next(ctx);
      if (!r) return null;
      const key = this.childCols.map((c) => (r[c.name] === null ? '' : String(r[c.name]))).join('');
      if (!this.seen.has(key)) {
        this.seen.add(key);
        this.actualRows++;
        return r;
      }
    }
  }
}

export function inferType(expr: BoundExpr): SqlType | 'UNKNOWN' {
  switch (expr.kind) {
    case 'literal': {
      const t = typeOf(expr.value);
      return t === 'NULL' ? 'UNKNOWN' : t;
    }
    case 'column':
      return expr.type;
    case 'cast':
      return expr.type;
    case 'binary':
      if (expr.op === 'AND' || expr.op === 'OR') return 'BOOLEAN';
      if (['=', '<>', '<', '>', '<=', '>='].includes(expr.op)) return 'BOOLEAN';
      return 'REAL';
    case 'unary':
      return expr.op === 'NOT' ? 'BOOLEAN' : 'REAL';
    case 'between':
    case 'like':
    case 'isNull':
    case 'inList':
    case 'inSub':
    case 'exists':
      return 'BOOLEAN';
    case 'func':
      if (expr.name === 'COUNT' || expr.name === 'LENGTH') return 'INTEGER';
      if (expr.name === 'AVG') return 'REAL';
      if (['UPPER', 'LOWER', 'TRIM'].includes(expr.name)) return 'TEXT';
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}
