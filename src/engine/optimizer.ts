// ============================================================
// 简单规则优化器（RBO）：
//   1. 常量折叠（无副作用的纯常量表达式预求值）
//   2. 谓词下推：把过滤条件下推到 Scan / Join 两侧
//   3. 索引选择：等值/范围谓词匹配主键或单列索引
//   4. JOIN 实现选择：等值连接使用 HASH，否则嵌套循环
//   5. LEFT JOIN 空条件检查
// 直接在逻辑计划上标注 index / impl 等物理信息
// ============================================================

import type { SQLError } from '../sql/types';
import type {
  LogicalPlan, LogicalFilter, LogicalJoin, LogicalScan, IndexUse,
} from './logical-plan';
import type { ExprPool } from './binder';
import type { Database } from './database';
import { emptyFrame } from './eval-expr';
import type { DBValue } from '../sql/types';

export interface OptimizerStats {
  foldedConstants: number;
  pushedPredicates: number;
  indexesUsed: IndexUse[];
  hashJoins: number;
  notes: string[];
}

export function optimize(plan: LogicalPlan, db: Database, pool: ExprPool): { plan: LogicalPlan; stats: OptimizerStats } {
  const stats: OptimizerStats = {
    foldedConstants: 0,
    pushedPredicates: 0,
    indexesUsed: [],
    hashJoins: 0,
    notes: [],
  };

  // 1. 常量折叠（先做，让下推可以识别更多简单谓词）
  foldConstants(plan, pool, stats);

  // 2. 谓词下推 + 索引选择
  const optimized = pushdown(plan, pool, db, stats, []);

  // 3. JOIN 物理实现
  chooseJoinImpl(optimized, pool, stats);

  return { plan: optimized, stats };
}

// ------------------------------------------------------------
// 常量折叠
// ------------------------------------------------------------
function foldConstants(plan: LogicalPlan, pool: ExprPool, stats: OptimizerStats): void {
  const visit = (id: number | null | undefined): void => {
    if (id === null || id === undefined) return;
    const b = pool.get(id);
    if (b.constant && !b.debug.startsWith('folded:')) {
      try {
        const v = b.eval({}, emptyFrame);
        const newId = pool.add({
          eval: () => v,
          debug: `folded:${b.debug}`,
          columnRefs: new Set(),
          constant: true,
        });
        // 原地替换（保持引用编号稳定）
        pool.exprs[id] = pool.exprs[newId];
        stats.foldedConstants++;
      } catch {
        // 常量表达式求值失败（如除零）则保留
      }
    }
  };

  walk(plan, (p) => {
    switch (p.node) {
      case 'filter': visit(p.predicate); break;
      case 'project':
        for (const it of p.items) visit(it.expr);
        break;
      case 'join':
        visit(p.condition);
        break;
      case 'aggregate':
        for (const g of p.groups) visit(g);
        for (const a of p.aggregates) visit(a.arg);
        break;
      case 'sort':
        for (const k of p.keys) visit(k.expr);
        break;
    }
  });
}

function walk(plan: LogicalPlan, fn: (p: LogicalPlan) => void): void {
  fn(plan);
  switch (plan.node) {
    case 'filter':
    case 'distinct':
    case 'limit':
      walk(plan.input, fn);
      break;
    case 'project':
      walk(plan.input, fn);
      break;
    case 'sort':
      walk(plan.input, fn);
      break;
    case 'join':
      walk(plan.left, fn);
      walk(plan.right, fn);
      break;
    case 'aggregate':
      walk(plan.input, fn);
      break;
    case 'subquerySource':
      walk(plan.plan, fn);
      break;
    case 'scan':
    case 'dummy':
      break;
  }
}

// ------------------------------------------------------------
// 谓词下推
// 简化策略（足够覆盖测试与展示）：
//   - Filter(Scan)：尝试从谓词中提取针对单列的等值/范围条件用于索引
//   - Filter(Join)：把仅引用单侧列的合取项下推
//   - 其余谓词保留
// ------------------------------------------------------------
interface Conjunct {
  exprId: number;
  /** 引用到的列 id 集合 */
  refs: Set<string>;
}

function pushdown(
  plan: LogicalPlan,
  pool: ExprPool,
  db: Database,
  stats: OptimizerStats,
  _ancestors: LogicalPlan[],
): LogicalPlan {
  switch (plan.node) {
    case 'scan':
    case 'dummy':
      return plan;

    case 'filter': {
      const inputPlan = pushdown(plan.input, pool, db, stats, []);
      const conjuncts = splitConjunction(plan.predicate, pool);

      // Filter 直接在 Scan 上：尝试索引选择
      if (inputPlan.node === 'scan') {
        const remaining = selectIndexForScan(inputPlan, conjuncts, pool, db, stats);
        if (remaining.length === 0) {
          stats.pushedPredicates += conjuncts.length - remaining.length;
          return inputPlan;
        }
        if (remaining.length === conjuncts.length) {
          return { ...plan, input: inputPlan };
        }
        stats.pushedPredicates += conjuncts.length - remaining.length;
        const pred = combineConjunction(remaining, pool);
        return pred === null ? inputPlan : { node: 'filter', input: inputPlan, predicate: pred };
      }

      // Filter 在 Join 上：拆分可下推项
      if (inputPlan.node === 'join') {
        const join = pushdownJoinFilter(inputPlan, conjuncts, pool, db, stats);
        const leftover = join.leftover;
        const newJoin: LogicalJoin = join.plan;
        if (leftover.length === 0) return newJoin;
        const pred = combineConjunction(leftover, pool);
        return pred === null ? newJoin : { node: 'filter', input: newJoin, predicate: pred };
      }

      return { ...plan, input: inputPlan };
    }

    case 'project':
      return { ...plan, input: pushdown(plan.input, pool, db, stats, []) };
    case 'aggregate':
      return { ...plan, input: pushdown(plan.input, pool, db, stats, []) };
    case 'sort':
      return { ...plan, input: pushdown(plan.input, pool, db, stats, []) };
    case 'limit':
      return { ...plan, input: pushdown(plan.input, pool, db, stats, []) };
    case 'distinct':
      return { ...plan, input: pushdown(plan.input, pool, db, stats, []) };
    case 'join': {
      const left = pushdown(plan.left, pool, db, stats, []);
      const right = pushdown(plan.right, pool, db, stats, []);
      return { ...plan, left, right };
    }
    case 'subquerySource':
      return { ...plan, plan: pushdown(plan.plan, pool, db, stats, []) };
  }
}

function splitConjunction(pred: number, pool: ExprPool): Conjunct[] {
  const b = pool.get(pred);
  if (b.debug.startsWith('__AND__')) {
    // combineConjunction 生成的合成 AND 标记
    const pair = (b as unknown as { __pair: [number, number] }).__pair;
    return [
      ...splitConjunction(pair[0], pool),
      ...splitConjunction(pair[1], pool),
    ];
  }
  return [{ exprId: pred, refs: new Set([...b.columnRefs].filter((r) => !r.startsWith('outer'))) }];
}

function combineConjunction(conjuncts: Conjunct[], pool: ExprPool): number | null {
  if (conjuncts.length === 0) return null;
  let acc = conjuncts[0].exprId;
  for (let i = 1; i < conjuncts.length; i++) {
    const r = conjuncts[i].exprId;
    const lb = pool.get(acc);
    const rb = pool.get(r);
    acc = pool.add({
      eval: (row, frame) => {
        const a = lb.eval(row, frame);
        if (a === false) return false;
        const bv = rb.eval(row, frame);
        if (a === null || bv === null) return bv === false ? false : null;
        return bv;
      },
      debug: '__AND__',
      columnRefs: new Set([...lb.columnRefs, ...rb.columnRefs]),
      constant: lb.constant && rb.constant,
    });
    (pool.exprs[acc] as unknown as { __pair: [number, number] }).__pair = [
      conjuncts[i - 1].exprId, r,
    ];
  }
  return acc;
}

// ------------------------------------------------------------
// 索引选择
// 识别形态（列在 scan 的别名命名空间内）：
//   col = const / const = col
//   col > const / >= / < / <=
//   col BETWEEN const AND const
// ------------------------------------------------------------
function selectIndexForScan(
  scan: LogicalScan,
  conjuncts: Conjunct[],
  pool: ExprPool,
  db: Database,
  stats: OptimizerStats,
): Conjunct[] {
  const store = db.getTable(scan.table);
  const aliasPrefix = `${scan.alias.toLowerCase()}.`;

  // 候选：列名(小写) -> 条件
  const eq = new Map<string, { value: DBValue; conj: Conjunct }>();
  const ranges: {
    col: string; low: DBValue; high: DBValue; lowInc: boolean; highInc: boolean; conj: Conjunct;
  }[] = [];

  const remaining: Conjunct[] = [];

  for (const conj of conjuncts) {
    const b = pool.get(conj.exprId);
    let matched = false;

    // 通过 AST 反查不可得（已编译），因此用 debug 结构识别。
    // BoundExpr 上挂有来源 AST 节点，直接使用即可。
    const ast = b.ast;
    if (ast) {
      const extracted = extractColumnCondition(ast, aliasPrefix);
      if (extracted) {
        const colLower = extracted.column.toLowerCase();
        if (store.hasIndexOn(colLower)) {
          if (extracted.kind === 'eq') {
            eq.set(colLower, { value: extracted.value, conj });
            matched = true;
          } else {
            ranges.push({
              col: colLower,
              low: extracted.low, high: extracted.high,
              lowInc: extracted.lowInc, highInc: extracted.highInc,
              conj,
            });
            matched = true;
          }
        }
      }
    }
    if (!matched) remaining.push(conj);
  }

  // 选一个最优索引（优先等值主键，其次等值唯一索引，再范围）
  let chosen: IndexUse | null = null;
  if (eq.size > 0) {
    const preferOrder = [
      store.def.primaryKey?.toLowerCase(),
      ...store.def.indexes.filter((i) => i.unique).map((i) => i.column.toLowerCase()),
      ...store.def.indexes.map((i) => i.column.toLowerCase()),
    ].filter(Boolean) as string[];

    for (const col of preferOrder) {
      const hit = eq.get(col);
      if (hit) {
        const idxDef = store.def.indexes.find((i) => i.column.toLowerCase() === col);
        const isPk = store.def.primaryKey?.toLowerCase() === col;
        const colName = store.def.columns.find((c) => c.name.toLowerCase() === col)?.name ?? col;
        chosen = {
          indexName: isPk ? `PRIMARY(${colName})` : idxDef!.name,
          column: colName,
          kind: isPk ? 'PRIMARY' : idxDef!.unique ? 'UNIQUE' : 'SECONDARY',
          access: 'EQ',
          detail: `${colName} = ${formatLit(hit.value)}`,
          estimatedRows: 1,
          eqValue: hit.value,
        };
        // 从 remaining 中移除该合取项（索引保证条件成立，但仍需要作为 residual 吗？
        // 对唯一索引等值查找最多 1 行且值相等，无需 residual；普通索引等值也保证相等，可移除）
        const idxToRemove = remaining.indexOf(hit.conj);
        if (idxToRemove >= 0) remaining.splice(idxToRemove, 1);
        break;
      }
    }
  } else if (ranges.length > 0) {
    for (const r of ranges) {
      if (store.hasIndexOn(r.col)) {
        const isPk = store.def.primaryKey?.toLowerCase() === r.col;
        const idxDef = store.def.indexes.find((i) => i.column.toLowerCase() === r.col);
        const colName = store.def.columns.find((c) => c.name.toLowerCase() === r.col)?.name ?? r.col;
        chosen = {
          indexName: isPk ? `PRIMARY(${colName})` : idxDef!.name,
          column: colName,
          kind: isPk ? 'PRIMARY' : idxDef!.unique ? 'UNIQUE' : 'SECONDARY',
          access: 'RANGE',
          detail: `${r.low === null ? '' : `${formatLit(r.low)} ${r.lowInc ? '<=' : '<'} `}${colName}${r.high === null ? '' : ` ${r.highInc ? '<=' : '<'} ${formatLit(r.high)}`}`,
          estimatedRows: '?',
          range: { low: r.low, high: r.high, lowInclusive: r.lowInc, highInclusive: r.highInc },
        };
        const idxToRemove = remaining.indexOf(r.conj);
        if (idxToRemove >= 0) remaining.splice(idxToRemove, 1);
        break;
      }
    }
  }

  if (chosen) {
    scan.index = chosen;
    stats.indexesUsed.push(chosen);
  }
  return remaining;
}

type ExtractedCondition =
  | { kind: 'eq'; column: string; value: DBValue }
  | { kind: 'range'; column: string; low: DBValue; high: DBValue; lowInc: boolean; highInc: boolean };

function extractColumnCondition(e: import('../sql/ast').Expr, aliasPrefix: string): ExtractedCondition | null {
  if (e.kind === 'binary' && ['=', '<', '<=', '>', '>='].includes(e.op)) {
    const leftCol = columnOf(e.left, aliasPrefix);
    const rightConst = constValueOf(e.right);
    const rightCol = columnOf(e.right, aliasPrefix);
    const leftConst = constValueOf(e.left);

    if (leftCol && rightConst !== NOT_CONST) {
      if (e.op === '=') return { kind: 'eq', column: leftCol, value: rightConst };
      const range = singleBound(leftCol, e.op as '<' | '<=' | '>' | '>=', rightConst, true);
      if (range) return range;
    }
    if (rightCol && leftConst !== NOT_CONST) {
      if (e.op === '=') return { kind: 'eq', column: rightCol, value: leftConst };
      // const < col  =>  col > const
      const flipped = flipOp(e.op as '<' | '<=' | '>' | '>=');
      const range = singleBound(rightCol, flipped, leftConst, true);
      if (range) return range;
    }
  }
  if (e.kind === 'between') {
    const col = columnOf(e.expr, aliasPrefix);
    const lo = constValueOf(e.low);
    const hi = constValueOf(e.high);
    if (col && lo !== NOT_CONST && hi !== NOT_CONST && !e.negated) {
      return { kind: 'range', column: col, low: lo, high: hi, lowInc: true, highInc: true };
    }
  }
  return null;
}

const NOT_CONST = Symbol('not-const');

function constValueOf(e: import('../sql/ast').Expr): DBValue | typeof NOT_CONST {
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'unary' && e.expr.kind === 'literal' && typeof e.expr.value === 'number') {
    return e.op === '-' ? -e.expr.value : e.expr.value;
  }
  return NOT_CONST;
}

function columnOf(e: import('../sql/ast').Expr, aliasPrefix: string): string | null {
  if (e.kind === 'column' && !e.table) return e.name;
  if (e.kind === 'column' && e.table) {
    // 仅当限定符与 scan 别名一致（不区分大小写）
    if (`${e.table.toLowerCase()}.` === aliasPrefix) return e.name;
  }
  return null;
}

function singleBound(
  col: string,
  op: '<' | '<=' | '>' | '>=',
  v: DBValue,
  _inc: boolean,
): ExtractedCondition | null {
  if (v === null) return null;
  if (op === '>') return { kind: 'range', column: col, low: v, high: null, lowInc: false, highInc: false };
  if (op === '>=') return { kind: 'range', column: col, low: v, high: null, lowInc: true, highInc: false };
  if (op === '<') return { kind: 'range', column: col, low: null, high: v, lowInc: false, highInc: false };
  return { kind: 'range', column: col, low: null, high: v, lowInc: false, highInc: true };
}

function flipOp(op: '<' | '<=' | '>' | '>='): '<' | '<=' | '>' | '>=' {
  return op === '<' ? '>' : op === '<=' ? '>=' : op === '>' ? '<' : '<=';
}

function formatLit(v: DBValue): string {
  if (v === null) return 'NULL';
  return typeof v === 'string' ? `'${v}'` : String(v);
}

// ------------------------------------------------------------
// Join 谓词下推
// ------------------------------------------------------------
function pushdownJoinFilter(
  join: LogicalJoin,
  conjuncts: Conjunct[],
  pool: ExprPool,
  db: Database,
  stats: OptimizerStats,
): { plan: LogicalJoin; leftover: Conjunct[] } {
  const leftCols = collectColumnIds(join.left);
  const rightCols = collectColumnIds(join.right);

  let leftFilters: Conjunct[] = [];
  let rightFilters: Conjunct[] = [];
  const leftover: Conjunct[] = [];

  for (const c of conjuncts) {
    let allLeft = true;
    let allRight = true;
    for (const ref of c.refs) {
      if (!leftCols.has(ref)) allLeft = false;
      if (!rightCols.has(ref)) allRight = false;
    }
    if (allLeft && c.refs.size > 0) leftFilters.push(c);
    else if (allRight && c.refs.size > 0) rightFilters.push(c);
    else leftover.push(c);
  }

  let left = join.left;
  let right = join.right;
  if (leftFilters.length > 0) {
    const pred = combineConjunction(leftFilters, pool);
    if (pred !== null) left = { node: 'filter', input: left, predicate: pred };
    stats.pushedPredicates += leftFilters.length;
  }
  if (rightFilters.length > 0 && join.joinType === 'INNER') {
    // LEFT JOIN 的右表条件不能直接下推（会改变外连接语义）
    const pred = combineConjunction(rightFilters, pool);
    if (pred !== null) right = { node: 'filter', input: right, predicate: pred };
    stats.pushedPredicates += rightFilters.length;
  } else if (rightFilters.length > 0) {
    leftover.push(...rightFilters);
  }

  left = pushdown(left, pool, db, stats, []);
  right = pushdown(right, pool, db, stats, []);
  return { plan: { ...join, left, right }, leftover };
}

function collectColumnIds(plan: LogicalPlan): Set<string> {
  const ids = new Set<string>();
  const addCols = (cols: { id: string }[]) => cols.forEach((c) => ids.add(c.id));
  const rec = (p: LogicalPlan) => {
    switch (p.node) {
      case 'scan': addCols(p.columns); break;
      case 'subquerySource': addCols(p.columns); break;
      case 'filter': rec(p.input); break;
      case 'project':
        // 投影后的列 id 是新生成的 out id；下推场景仅处理投影前的源列
        rec(p.input);
        break;
      case 'join': rec(p.left); rec(p.right); break;
      case 'aggregate': rec(p.input); break;
      case 'sort': rec(p.input); break;
      case 'limit':
      case 'distinct': rec(p.input); break;
      case 'dummy': break;
    }
  };
  rec(plan);
  return ids;
}

// ------------------------------------------------------------
// JOIN 实现选择
// 等值连接（两侧各只引用自己一侧列的 a.x = b.y）=> HASH
// ------------------------------------------------------------
function chooseJoinImpl(plan: LogicalPlan, pool: ExprPool, stats: OptimizerStats): void {
  walk(plan, (p) => {
    if (p.node !== 'join') return;
    chooseJoinImpl(p.left, pool, stats);
    chooseJoinImpl(p.right, pool, stats);

    if (p.condition === null) {
      p.impl = 'NESTED_LOOP'; // 笛卡尔积
      return;
    }
    const conjunctIds = collectTopLevelConjuncts(p.condition, pool);
    const leftCols = collectColumnIds(p.left);
    const rightCols = collectColumnIds(p.right);

    const hashKeys: NonNullable<LogicalJoin['hashKeys']> = [];
    const others: number[] = [];

    for (const id of conjunctIds) {
      const b = pool.get(id);
      const ast = b.ast;
      if (ast && ast.kind === 'binary' && ast.op === '=') {
        const lRefs = referencedBoundIds(ast.left, pool, leftCols, rightCols);
        const rRefs = referencedBoundIds(ast.right, pool, leftCols, rightCols);
        if (lRefs === 'left' && rRefs === 'right') {
          hashKeys.push({ leftAst: ast.left, rightAst: ast.right });
          continue;
        }
        if (lRefs === 'right' && rRefs === 'left') {
          hashKeys.push({ leftAst: ast.right, rightAst: ast.left });
          continue;
        }
      }
      others.push(id);
    }

    if (hashKeys.length > 0) {
      p.impl = 'HASH';
      p.hashKeys = hashKeys;
      p.otherConditions = others;
      stats.hashJoins++;
      stats.notes.push('hash join chosen for equi-join condition(s)');
    } else {
      p.impl = 'NESTED_LOOP';
      p.hashKeys = [];
      p.otherConditions = conjunctIds;
    }
  });
}

/**
 * 判断一个 AST 表达式引用的列全部落在哪一侧：
 * 仅当全部列 id 属于同一侧时返回 'left'/'right'，否则 'mixed'；无列引用返回 'const'
 */
function referencedBoundIds(
  e: import('../sql/ast').Expr,
  _pool: ExprPool,
  leftIds: Set<string>,
  rightIds: Set<string>,
): 'left' | 'right' | 'mixed' | 'const' {
  let side: 'left' | 'right' | 'const' = 'const';
  let mixed = false;
  const rec = (x: import('../sql/ast').Expr) => {
    if (x.kind === 'column') {
      // 构造绑定 id：table.name；无修饰符无法确定，保守处理
      if (x.table) {
        const id = `${x.table.toLowerCase()}.${x.name.toLowerCase()}`;
        if (leftIds.has(id)) {
          if (side === 'right') mixed = true;
          else if (side === 'const') side = 'left';
        } else if (rightIds.has(id)) {
          if (side === 'left') mixed = true;
          else if (side === 'const') side = 'right';
        }
      } else {
        const inLeft = [...leftIds].some((id) => id.endsWith(`.${x.name.toLowerCase()}`));
        const inRight = [...rightIds].some((id) => id.endsWith(`.${x.name.toLowerCase()}`));
        if (inLeft && inRight) mixed = true;
        else if (inLeft) { if (side === 'right') mixed = true; else if (side === 'const') side = 'left'; }
        else if (inRight) { if (side === 'left') mixed = true; else if (side === 'const') side = 'right'; }
      }
    }
    for (const child of childExprs(x)) rec(child);
  };
  rec(e);
  if (mixed) return 'mixed';
  return side;
}

function collectTopLevelConjuncts(pred: number, pool: ExprPool): number[] {
  const b = pool.get(pred);
  if (b.debug === '__AND__') {
    const pair = (b as unknown as { __pair?: [number, number] }).__pair;
    if (pair) return [...collectTopLevelConjuncts(pair[0], pool), ...collectTopLevelConjuncts(pair[1], pool)];
  }
  return [pred];
}

function childExprs(e: import('../sql/ast').Expr): import('../sql/ast').Expr[] {
  switch (e.kind) {
    case 'literal': case 'column': case 'star': return [];
    case 'unary': return [e.expr];
    case 'binary': case 'logical': return [e.left, e.right];
    case 'not': case 'isNull': case 'isBoolean': case 'cast': return [e.expr];
    case 'between': return [e.expr, e.low, e.high];
    case 'inList': return [e.expr, ...e.list];
    case 'like': return [e.expr, e.pattern];
    case 'case': return [
      ...(e.operand ? [e.operand] : []),
      ...e.whens.flatMap((w) => [w.when, w.then]),
      ...(e.elseExpr ? [e.elseExpr] : []),
    ];
    case 'func': return e.args;
    case 'inSubquery': case 'exists': case 'scalarSubquery': return [];
  }
}
