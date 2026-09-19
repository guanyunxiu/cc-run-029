// 逻辑计划 → 物理计划构建器（简单规则优化）
// 1) 选择下推：AND 拆分后，单表谓词下推为基表 FILTER；LEFT JOIN 右表谓词不下推
// 2) 索引选择：等值谓词按 主键 > 唯一索引 > 普通索引 选择；计划中标注 INDEX_SCAN
// 3) 聚合：GROUP BY/聚合函数 -> HASH_AGGREGATE，HAVING 在聚合阶段过滤
// 4) DISTINCT -> 哈希去重；ORDER BY -> SORT；LIMIT/OFFSET -> LIMIT_OFFSET
import { ColumnInfo, SqlError, SqlValue, TableDef, Row } from '../sql/types';
import * as AST from '../sql/ast';
import { Expr as AstExpr, SelectStmt } from '../sql/ast';
import { Storage } from './storage';
import {
  AggregateSpec,
  Binder,
  DataRow,
  BoundExpr,
  DistinctOp,
  ExecContext,
  ExecPlan,
  FilterOp,
  HashAggregateOp,
  LimitOp,
  NestedLoopJoinOp,
  Operator,
  ProjectOp,
  Projection,
  Scope,
  SourceMeta,
  SortOp,
  TableScanOp,
  evalExpr,
  inferType,
} from './executor';

/** 把派生表（子查询）的扁平行重新包到别名下：{alias: {...扁平字段}} */
class NestAliasOp extends Operator {
  constructor(
    private child: Operator,
    private alias: string,
    private cols: ColumnInfo[],
  ) {
    super();
  }
  override children() {
    return [this.child];
  }
  outputColumns() {
    return this.cols;
  }
  describe() {
    return { op: 'DERIVED_SCAN', detail: `派生表 ${this.alias}` };
  }
  async reset(): Promise<void> {
    const resetAll = async (op: Operator): Promise<void> => {
      await op.reset();
      for (const c of op.children()) await resetAll(c);
    };
    await resetAll(this.child);
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    const flat = await this.child.next(ctx);
    if (!flat) return null;
    this.actualRows++;
    const nested: DataRow = {};
    for (const c of this.cols) nested[c.name] = flat[c.name] ?? null;
    return { [this.alias]: nested };
  }
}

interface BuildCtx {
  storage: Storage;
  binder: Binder;
}

export class Planner {
  private buildCtx: BuildCtx;
  constructor(storage: Storage) {
    const binder = new Binder();
    this.buildCtx = { storage, binder };
    // 注入子查询构建入口（闭包直接捕获本 Planner 上下文，避免全局状态串用）
    binder.subqueryApi = {
      buildSubquery: (stmt, outer) => buildSelect(stmt, outer, this.buildCtx),
    };
  }

  planSelect(stmt: SelectStmt, outer?: Scope): Promise<ExecPlan> {
    return buildSelect(stmt, outer ?? { sources: [] }, this.buildCtx);
  }
}

/** 供子查询闭包使用的异步构建入口 */
async function buildSelect(stmt: SelectStmt, outer: Scope, bc: BuildCtx): Promise<ExecPlan> {
  const binder = bc.binder;

  // ---------- 无 FROM 子句 ----------
  if (!stmt.from) {
    if (stmt.joins.length || stmt.where || stmt.groupBy.length || stmt.having) {
      throw new SqlError('没有 FROM 子句时不能使用 JOIN/WHERE/GROUP BY/HAVING');
    }
    const scope: Scope = { sources: [], parent: outer };
    const projections: Projection[] = [];
    const outputColumns: ColumnInfo[] = [];
    for (let i = 0; i < stmt.selectList.length; i++) {
      const item = stmt.selectList[i];
      if (item.expr.kind === 'star') throw new SqlError('没有 FROM 子句时不能使用 *');
      const name = item.alias ?? defaultColName(item.expr, i);
      const bound = binder.bindExpr(item.expr, scope);
      projections.push({ expr: bound, name, isStar: false });
      outputColumns.push({ name, type: inferType(bound) });
    }
    let root: Operator = new ConstantScanOp(projections);
    if (stmt.distinct) root = new DistinctOp(root, outputColumns);
    root = wrapOrderLimit(stmt, root, outputColumns, scope, binder, false, null, null);
    return { root, outputColumns, scope };
  }

  const catalog = await bc.storage.getCatalog();

  // ---------- 构建 FROM 源（含派生表子查询） ----------
  const scope: Scope = { sources: [], parent: outer };
  interface BuiltSource {
    source: SourceMeta;
    def?: TableDef;
    buildScan: (indexName?: string) => Operator;
    subPlan?: ExecPlan;
  }
  const built: BuiltSource[] = [];

  const addItem = async (item: AST.TableRef | AST.SubqueryRef): Promise<BuiltSource> => {
    if (item.kind === 'table') {
      const def = catalog.tables[item.name];
      if (!def) throw new SqlError(`表 ${item.name} 不存在`);
      const source = binder.sourceForTable(def, item.alias);
      assertUniqueAlias(scope, source.alias);
      scope.sources.push(source);
      const bs: BuiltSource = {
        source,
        def,
        buildScan: (indexName?: string) => {
          const idx = indexName ? def.indexes.find((i) => i.name === indexName) : undefined;
          return new TableScanOp(
            def,
            source.alias,
            indexName,
            idx ? describeIndex(idx.name, idx.column, idx.unique) : undefined,
          );
        },
      };
      built.push(bs);
      return bs;
    }
    const subPlan = await buildSelect(item.subquery, scope, bc);
    const source = binder.sourceForSubquery(subPlan, item.alias);
    assertUniqueAlias(scope, source.alias);
    scope.sources.push(source);
    const alias = item.alias;
    const bs: BuiltSource = {
      source,
      subPlan,
      buildScan: () => new NestAliasOp(subPlan.root, alias, subPlan.outputColumns),
    };
    built.push(bs);
    return bs;
  };

  await addItem(stmt.from);
  for (const j of stmt.joins) await addItem(j.right);

  // ---------- WHERE 拆分与谓词下推 ----------
  const nullableSources = new Set<string>();
  for (const j of stmt.joins) {
    if (j.joinKind === 'LEFT') {
      nullableSources.add(j.right.kind === 'table' ? (j.right.alias ?? j.right.name) : j.right.alias);
    }
  }

  const conjuncts: AstExpr[] = [];
  if (stmt.where) splitAnd(stmt.where, conjuncts);

  const perSource = new Map<string, BoundExpr[]>();
  const residual: BoundExpr[] = [];
  for (const c of conjuncts) {
    const bound = binder.bindExpr(c, scope);
    const refs = new Set(
      collectRefs(c).map((r) => {
        // 只统计本层 source；关联引用的谓词不允许下推
        return resolveLocalSource(r, scope) ?? { outer: true };
      }),
    );
    const outerOnly = refs.size === 1 && [...refs][0] && typeof [...refs][0] === 'object' && 'outer' in ([...refs][0] as object);
    const localRefs = new Set<string>();
    let hasOuter = false;
    for (const r of collectRefs(c)) {
      const local = resolveLocalSource(r, scope);
      if (local) localRefs.add(local);
      else hasOuter = true;
    }
    void refs;
    void outerOnly;
    if (!hasOuter && localRefs.size === 1) {
      const src = [...localRefs][0];
      if (nullableSources.has(src)) residual.push(bound);
      else {
        const arr = perSource.get(src) ?? [];
        arr.push(bound);
        perSource.set(src, arr);
      }
    } else {
      residual.push(bound);
    }
  }

  // ---------- 构建扫描算子 + 索引选择 ----------
  const scanOps = new Map<string, Operator>();
  for (const bs of built) {
    let chosenIndex: string | undefined;
    if (bs.def) {
      const preds = perSource.get(bs.source.alias) ?? [];
      chosenIndex = chooseIndex(bs.def, preds);
    }
    let op = bs.buildScan(chosenIndex);
    const preds = perSource.get(bs.source.alias);
    if (preds && preds.length > 0) op = new FilterOp(op, combineConjuncts(preds));
    scanOps.set(bs.source.alias, op);
  }

  // ---------- JOIN ----------
  let root: Operator = scanOps.get(built[0].source.alias)!;
  for (const j of stmt.joins) {
    const alias = j.right.kind === 'table' ? (j.right.alias ?? j.right.name) : j.right.alias;
    const right = scanOps.get(alias)!;
    const rightSources = [built.find((b) => b.source.alias === alias)!.source];
    const cond = j.on ? binder.bindExpr(j.on, scope) : undefined;
    root = new NestedLoopJoinOp(root, right, j.joinKind, cond, rightSources);
  }
  if (residual.length > 0) root = new FilterOp(root, combineConjuncts(residual));

  // ---------- 聚合 ----------
  const hasAgg = stmt.groupBy.length > 0 || selectHasAggregate(stmt);
  let postGroupScope: Scope | null = null;
  let rewritePost: ((e: BoundExpr) => BoundExpr) | null = null;
  let sharedAggMap: Map<AST.FunctionCallExpr, number> | null = null;
  let groupNames: string[] = [];

  if (hasAgg) {
    const groupBound = stmt.groupBy.map((g) => binder.bindExpr(g, scope));
    groupNames = stmt.groupBy.map((g, i) => (g.kind === 'column' ? g.name : `__g${i}`));
    const groupExprs = groupBound.map((expr, i) => ({ expr, name: groupNames[i] }));

    // 收集全部聚合函数（select/having/order by），全程复用同一个 AST 节点 -> 索引映射
    const aggList: AggregateSpec[] = [];
    const aggAstMap = new Map<AST.FunctionCallExpr, number>();
    const collectAll = (e: AstExpr): void => {
      walkAggregateAsts(e, (f) => {
        if (!aggAstMap.has(f)) {
          const idx = aggAstMap.size;
          aggAstMap.set(f, idx);
          aggList.push({
            name: f.name,
            distinct: f.distinct,
            star: !!f.star,
            arg: f.star ? undefined : binder.bindExpr(f.args[0], scope),
            alias: `__agg${idx}`,
          });
        }
      });
    };
    stmt.selectList.forEach((s) => collectAll(s.expr));
    if (stmt.having) collectAll(stmt.having);
    stmt.orderBy.forEach((o) => collectAll(o.expr));

    const havingBound = stmt.having ? binder.bindExpr(stmt.having, scope, aggAstMap) : undefined;

    const groupCols = groupExprs.map((g) => ({
      name: g.name,
      table: '__group',
      type: inferType(g.expr),
    }));
    const aggCols: ColumnInfo[] = aggList.map((a) => ({
      name: a.alias,
      table: '__group',
      type:
        a.name === 'COUNT'
          ? 'INTEGER'
          : a.name === 'AVG'
            ? 'REAL'
            : a.arg
              ? inferType(a.arg)
              : 'UNKNOWN',
    }));
    postGroupScope = { sources: [{ alias: '__group', columns: [...groupCols, ...aggCols] }] };

    rewritePost = makePostAggregateRewriter(groupExprs, aggList);
    const havingPost = havingBound ? rewritePost(havingBound) : undefined;

    root = new HashAggregateOp(root, groupExprs, aggList, havingPost);
    // 保存聚合映射，供投影/排序绑定复用
    sharedAggMap = aggAstMap;
  } else if (stmt.having) {
    throw new SqlError('HAVING 只能配合 GROUP BY 或聚合函数使用');
  }

  // ---------- SELECT 投影 ----------
  const projections: Projection[] = [];
  const outputColumns: ColumnInfo[] = [];
  const outputAliasSet = new Set<string>();

  for (let i = 0; i < stmt.selectList.length; i++) {
    const item = stmt.selectList[i];
    const e0: AstExpr = item.expr;
    if (e0.kind === 'star') {
      projections.push({ expr: { kind: 'literal', value: null }, name: '*', isStar: true });
      for (const s of scope.sources) for (const c of s.columns) outputColumns.push({ name: c.name, type: c.type });
      continue;
    }
    if (e0.kind === 'column' && e0.star) {
      const src = scope.sources.find((s) => s.alias.toLowerCase() === e0.table!.toLowerCase());
      if (!src) throw new SqlError(`未知的表别名 ${e0.table}`);
      projections.push({
        expr: { kind: 'literal', value: null },
        name: `${src.alias}.*`,
        isStar: true,
        starSource: src.alias,
      });
      for (const c of src.columns) outputColumns.push({ name: c.name, type: c.type });
      continue;
    }
    const name = item.alias ?? defaultColName(item.expr, i);
    let bound: BoundExpr;
    if (hasAgg) {
      bound = binder.bindExpr(item.expr, scope, sharedAggMap ?? undefined);
      bound = rewritePost!(bound);
    } else {
      bound = binder.bindExpr(item.expr, scope);
    }
    projections.push({ expr: bound, name, isStar: false });
    outputColumns.push({ name, type: inferType(bound) });
    outputAliasSet.add(name.toLowerCase());
  }

  root = new ProjectOp(root, projections, scope.sources);
  if (stmt.distinct) root = new DistinctOp(root, outputColumns);

  // ---------- ORDER BY / LIMIT ----------
  root = wrapOrderLimit(
    stmt,
    root,
    outputColumns,
    scope,
    binder,
    hasAgg,
    rewritePost,
    sharedAggMap,
  );

  return { root, outputColumns, scope: postGroupScope ?? scope };
}

/**
 * 投影后绑定 ORDER BY：
 * - 裸标识符命中输出别名 -> 输出列引用
 * - 否则按源作用域绑定（聚合查询会被聚合重写器改写）
 */
function wrapOrderLimit(
  stmt: SelectStmt,
  root: Operator,
  outputColumns: ColumnInfo[],
  sourceScope: Scope,
  binder: Binder,
  hasAgg: boolean,
  rewritePost: ((e: BoundExpr) => BoundExpr) | null,
  aggAstMap: Map<AST.FunctionCallExpr, number> | null,
): Operator {
  let op = root;
  if (stmt.orderBy.length > 0) {
    const aliasMap = new Map<string, number>();
    outputColumns.forEach((c, i) => aliasMap.set(c.name.toLowerCase(), i));
    const keys = stmt.orderBy.map((o) => {
      let expr: BoundExpr;
      // 裸标识符命中输出别名：按别名排序（SQL 标准中 ORDER BY 别名优先）
      if (o.expr.kind === 'column' && !o.expr.table && aliasMap.has(o.expr.name.toLowerCase())) {
        expr = {
          kind: 'column',
          source: '__out',
          name: outputColumns[aliasMap.get(o.expr.name.toLowerCase())!].name,
          type: outputColumns[aliasMap.get(o.expr.name.toLowerCase())!].type,
        };
      } else if (hasAgg) {
        expr = rewritePost!(binder.bindExpr(o.expr, sourceScope, aggAstMap ?? undefined));
      } else {
        expr = binder.bindExpr(o.expr, sourceScope);
      }
      return { expr, desc: o.desc };
    });
    op = new SortOp(op, keys, outputColumns, sourceScope.sources);
  }
  let limit: number | null = null;
  let offset = 0;
  if (stmt.limit) limit = constInt(stmt.limit, 'LIMIT');
  if (stmt.offset) offset = constInt(stmt.offset, 'OFFSET');
  if (stmt.limit || stmt.offset) op = new LimitOp(op, limit, offset);
  return op;
}

function makePostAggregateRewriter(
  groupExprs: { expr: BoundExpr; name: string }[],
  aggList: AggregateSpec[],
): (e: BoundExpr) => BoundExpr {
  const groupKeys = new Map<string, string>();
  groupExprs.forEach((g) => groupKeys.set(structuralKey(g.expr), g.name));
  const walk = (x: BoundExpr): BoundExpr => {
    if (x.kind === 'aggRef') {
      const a = aggList[x.index];
      return { kind: 'column', source: '__group', name: a.alias, type: inferType({ kind: 'aggRef', index: x.index }) };
    }
    if (x.kind === 'column') {
      const gName = groupKeys.get(structuralKey(x));
      if (gName) return { kind: 'column', source: '__group', name: gName, type: x.type };
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
  return walk;
}

function structuralKey(e: BoundExpr): string {
  return JSON.stringify(e);
}

// ---------- 辅助：聚合 AST 遍历 ----------
const AGG_NAMES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

function walkAggregateAsts(e: AstExpr, onAgg: (f: AST.FunctionCallExpr) => void): void {
  switch (e.kind) {
    case 'func':
      if (AGG_NAMES.has(e.name)) {
        onAgg(e);
        // 聚合参数中不允许嵌套聚合
        return;
      }
      e.args.forEach((a) => walkAggregateAsts(a, onAgg));
      return;
    case 'binary':
      walkAggregateAsts(e.left, onAgg);
      walkAggregateAsts(e.right, onAgg);
      return;
    case 'unary':
      walkAggregateAsts(e.expr, onAgg);
      return;
    case 'between':
      walkAggregateAsts(e.expr, onAgg);
      walkAggregateAsts(e.low, onAgg);
      walkAggregateAsts(e.high, onAgg);
      return;
    case 'inList':
      walkAggregateAsts(e.expr, onAgg);
      e.values.forEach((v) => walkAggregateAsts(v, onAgg));
      return;
    case 'like':
      walkAggregateAsts(e.expr, onAgg);
      walkAggregateAsts(e.pattern, onAgg);
      return;
    case 'isNull':
      walkAggregateAsts(e.expr, onAgg);
      return;
    case 'case':
      if (e.operand) walkAggregateAsts(e.operand, onAgg);
      e.whens.forEach((w) => {
        walkAggregateAsts(w.when, onAgg);
        walkAggregateAsts(w.then, onAgg);
      });
      if (e.else) walkAggregateAsts(e.else, onAgg);
      return;
    case 'cast':
      walkAggregateAsts(e.expr, onAgg);
      return;
    default:
      return;
  }
}

function selectHasAggregate(stmt: SelectStmt): boolean {
  let found = false;
  const finder = (f: AST.FunctionCallExpr): void => {
    found = true;
    void f;
  };
  stmt.selectList.forEach((s) => walkAggregateAsts(s.expr, finder));
  if (stmt.having) walkAggregateAsts(stmt.having, finder);
  stmt.orderBy.forEach((o) => walkAggregateAsts(o.expr, finder));
  return found;
}

// ---------- 小工具 ----------
function assertUniqueAlias(scope: Scope, alias: string): void {
  if (scope.sources.some((s) => s.alias.toLowerCase() === alias.toLowerCase())) {
    throw new SqlError(`表别名 ${alias} 重复`);
  }
}

function splitAnd(expr: AstExpr, out: AstExpr[]): void {
  if (expr.kind === 'binary' && expr.op === 'AND') {
    splitAnd(expr.left, out);
    splitAnd(expr.right, out);
  } else {
    out.push(expr);
  }
}

function combineConjuncts(exprs: BoundExpr[]): BoundExpr {
  if (exprs.length === 1) return exprs[0];
  return exprs.slice(1).reduce((left, right) => ({ kind: 'binary', op: 'AND', left, right } as BoundExpr), exprs[0]);
}

function collectRefs(expr: AstExpr): { table?: string; name: string }[] {
  const refs: { table?: string; name: string }[] = [];
  const walk = (e: AstExpr): void => {
    switch (e.kind) {
      case 'column':
        if (!e.star) refs.push({ table: e.table, name: e.name });
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
      case 'unary':
        walk(e.expr);
        return;
      case 'between':
        walk(e.expr);
        walk(e.low);
        walk(e.high);
        return;
      case 'inList':
        walk(e.expr);
        e.values.forEach(walk);
        return;
      case 'like':
        walk(e.expr);
        walk(e.pattern);
        return;
      case 'isNull':
        walk(e.expr);
        return;
      case 'case':
        if (e.operand) walk(e.operand);
        e.whens.forEach((w) => {
          walk(w.when);
          walk(w.then);
        });
        if (e.else) walk(e.else);
        return;
      case 'cast':
        walk(e.expr);
        return;
      case 'func':
        e.args.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(expr);
  return refs;
}

function resolveLocalSource(ref: { table?: string; name: string }, scope: Scope): string | null {
  if (ref.table) {
    const src = scope.sources.find((s) => s.alias.toLowerCase() === ref.table!.toLowerCase());
    if (src && src.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase())) return src.alias;
    return null;
  }
  const matches = scope.sources.filter((s) =>
    s.columns.some((c) => c.name.toLowerCase() === ref.name.toLowerCase()),
  );
  if (matches.length > 1) throw new SqlError(`列 ${ref.name} 有歧义，请使用 表名.列名`);
  return matches[0]?.alias ?? null;
}

function chooseIndex(def: TableDef, preds: BoundExpr[]): string | undefined {
  let best: { name: string; rank: number } | undefined;
  for (const p of preds) {
    const col = extractEqualityColumn(p);
    if (!col) continue;
    const idx = def.indexes.find((i) => i.column === col);
    if (!idx) continue;
    const rank = def.columns.find((c) => c.primaryKey && c.name === col) ? 3 : idx.unique ? 2 : 1;
    if (!best || rank > best.rank) best = { name: idx.name, rank };
  }
  return best?.name;
}

function extractEqualityColumn(expr: BoundExpr): string | null {
  if (expr.kind !== 'binary' || expr.op !== '=') return null;
  if (expr.left.kind === 'column' && isConstExpr(expr.right)) return expr.left.name;
  if (expr.right.kind === 'column' && isConstExpr(expr.left)) return expr.right.name;
  return null;
}

function isConstExpr(expr: BoundExpr): boolean {
  switch (expr.kind) {
    case 'literal':
      return true;
    case 'cast':
      return isConstExpr(expr.expr);
    case 'unary':
      return isConstExpr(expr.expr);
    case 'binary':
      return isConstExpr(expr.left) && isConstExpr(expr.right);
    default:
      return false;
  }
}

function describeIndex(name: string, column: string, unique: boolean): string {
  return `${unique ? '唯一索引' : '普通索引'} ${name}（列 ${column}）`;
}

function defaultColName(expr: AstExpr, i: number): string {
  // 裸列直接用列名；其余表达式默认名带位置下标，保证输出列名唯一
  // （扁平行中重名列会互相覆盖）
  if (expr.kind === 'column') return expr.name;
  if (expr.kind === 'cast') return defaultColName(expr.expr, i);
  return `expr${i + 1}`;
}

function constInt(expr: AstExpr, label: string): number {
  const lit = (e: AstExpr): SqlValue | undefined => {
    if (e.kind === 'literal') return e.value;
    if (e.kind === 'unary' && e.op === '-' && e.expr.kind === 'literal') {
      return -(e.expr.value as number);
    }
    if (e.kind === 'cast' && e.expr.kind === 'literal') {
      // CAST 字面量（简化：直接取数值）
      const v = e.expr.value;
      return typeof v === 'number' ? Math.trunc(v) : Number(v);
    }
    return undefined;
  };
  const v = lit(expr);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new SqlError(`${label} 必须是非负整数常量`);
  }
  return v;
}

/** 无 FROM 子句的单行扫描算子 */
class ConstantScanOp extends Operator {
  private emitted = false;
  constructor(private projections: Projection[]) {
    super();
  }
  outputColumns(): ColumnInfo[] {
    return this.projections.map((p) => ({ name: p.name, type: inferType(p.expr) }));
  }
  describe() {
    return { op: 'CONSTANT_SCAN', detail: '无 FROM，单行结果' };
  }
  async next(ctx: ExecContext): Promise<DataRow | null> {
    if (this.emitted) return null;
    this.emitted = true;
    const out: DataRow = {};
    for (const p of this.projections) out[p.name] = await evalExpr(p.expr, { row: {} }, ctx);
    this.actualRows++;
    return out;
  }
}
