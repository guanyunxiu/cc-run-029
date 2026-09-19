// ============================================================
// 火山模型（Volcano）执行器
// 每个算子实现 open()/next()/close()，逐行拉取。
// ============================================================

import type { DBValue, Row } from '../sql/types';
import { truthy } from './eval-expr';
import type { EvalRow, ExecFrame } from './eval-expr';
import type {
  LogicalPlan, LogicalJoin, BoundExpr, IndexUse, AggregateSpec,
} from './logical-plan';
import type { ExprPool } from './binder';
import type { Database, Transaction } from './database';
import { compareValues, sqlEquals } from './table-store';
import type { SubqueryRuntime } from './subquery-runtime';

export interface ExecStats {
  rowsScanned: number;
  rowsOutput: number;
  indexLookups: number;
  hashJoinsBuilt: number;
  hashJoinRows: number;
}

export interface ExecContext {
  db: Database;
  txn: Transaction;
  pool: ExprPool;
  stats: ExecStats;
  subqueries: SubqueryRuntime;
}

export abstract class Operator {
  abstract open(frame: ExecFrame): void;
  abstract next(frame: ExecFrame): EvalRow | null;
  close(_frame: ExecFrame): void { /* 默认无资源 */ }

  /** 拉取全部行（便捷方法） */
  all(frame: ExecFrame): EvalRow[] {
    this.open(frame);
    const out: EvalRow[] = [];
    let row: EvalRow | null;
    while ((row = this.next(frame))) out.push(row);
    this.close(frame);
    return out;
  }
}

// ------------------------------------------------------------
// Scan（支持索引访问）
// ------------------------------------------------------------
export class ScanOp extends Operator {
  private iterator: IterableIterator<{ pk: string; data: Row }> | null = null;
  private indexUse: IndexUse | null = null;
  private buffered: { pk: string; data: Row }[] | null = null;
  private bufPos = 0;
  private alias: string;
  private hiddenRowId: boolean;

  constructor(
    private db: Database,
    private tableName: string,
    alias: string,
    private columnIds: { id: string; origin: string }[],
    indexUse: IndexUse | undefined,
    private ctx: ExecContext,
  ) {
    super();
    this.alias = alias;
    this.indexUse = indexUse ?? null;
    const store = this.db.getTable(tableName);
    this.hiddenRowId = !store.def.primaryKey;
  }

  open(_frame: ExecFrame): void {
    const store = this.db.getTable(this.tableName);
    if (this.indexUse) {
      this.ctx.stats.indexLookups++;
      const col = this.indexUse.column;
      if (this.indexUse.access === 'EQ') {
        this.buffered = store.lookup(col, this.indexUse.eqValue ?? null).map((r) => ({ pk: r.pk, data: r.data }));
      } else if (this.indexUse.access === 'RANGE' && this.indexUse.range) {
        const r = this.indexUse.range;
        this.buffered = store.rangeLookup(col, r.low, r.high, r.lowInclusive, r.highInclusive)
          .map((x) => ({ pk: x.pk, data: x.data }));
      }
      this.bufPos = 0;
    } else {
      this.iterator = store.all()[Symbol.iterator]();
    }
  }

  next(_frame: ExecFrame): EvalRow | null {
    let raw: { pk: string; data: Row } | undefined;
    if (this.indexUse && this.buffered) {
      raw = this.buffered[this.bufPos++];
    } else if (this.iterator) {
      raw = this.iterator.next().value as { pk: string; data: Row } | undefined;
    }
    if (!raw) return null;
    this.ctx.stats.rowsScanned++;

    const out: EvalRow = {};
    for (const c of this.columnIds) {
      out[c.id] = raw.data[c.origin] ?? null;
    }
    // 物理 pk 以特殊键传递（UPDATE/DELETE 用）
    out[`${this.alias.toLowerCase()}.__pk__`] = raw.pk;
    if (this.hiddenRowId) {
      out[`${this.alias.toLowerCase()}.__rowid__`] = raw.data.__rowid__ ?? null;
    }
    return out;
  }
}

// ------------------------------------------------------------
// Dummy（无 FROM 的单行）
// ------------------------------------------------------------
export class DummyOp extends Operator {
  private emitted = false;
  open(): void { this.emitted = false; }
  next(): EvalRow | null {
    if (this.emitted) return null;
    this.emitted = true;
    return {};
  }
}

// ------------------------------------------------------------
// Filter
// ------------------------------------------------------------
export class FilterOp extends Operator {
  constructor(
    private child: Operator,
    private predicate: BoundExpr,
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    for (;;) {
      const row = this.child.next(frame);
      if (!row) return null;
      const v = this.predicate.eval(row, frame);
      if (truthy(v) === true) return row;
    }
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Project
// ------------------------------------------------------------
export class ProjectOp extends Operator {
  constructor(
    private child: Operator,
    private items: { expr: BoundExpr; label: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const row = this.child.next(frame);
    if (!row) return null;
    const out: EvalRow = {};
    for (const it of this.items) {
      out[it.label] = it.expr.eval(row, frame);
    }
    this.ctxPush(row, out);
    return out;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }

  private ctxPush(_src: EvalRow, _out: EvalRow): void { /* 占位 */ }
}

// ------------------------------------------------------------
// Nested Loop Join（INNER / LEFT）
// ------------------------------------------------------------
export class NestedLoopJoinOp extends Operator {
  private leftRow: EvalRow | null = null;
  private rightOpened = false;
  private leftMatched = false;
  private nullPadEmitted = false;

  constructor(
    private join: LogicalJoin,
    private left: Operator,
    private right: Operator,
    private condition: BoundExpr | null,
    private rightColumnIds: string[],
  ) { super(); }

  open(frame: ExecFrame): void {
    this.left.open(frame);
    this.leftRow = this.left.next(frame);
    this.rightOpened = false;
  }

  private openRight(frame: ExecFrame): void {
    this.right.open(frame);
    this.rightOpened = true;
  }
  private closeRight(frame: ExecFrame): void {
    if (this.rightOpened) {
      this.right.close(frame);
      this.rightOpened = false;
    }
  }

  next(frame: ExecFrame): EvalRow | null {
    while (this.leftRow) {
      if (!this.rightOpened) {
        this.openRight(frame);
        this.leftMatched = false;
        this.nullPadEmitted = false;
      }
      let rightRow: EvalRow | null;
      while ((rightRow = this.right.next(frame))) {
        const combined = { ...this.leftRow, ...rightRow };
        if (!this.condition || truthy(this.condition.eval(combined, frame)) === true) {
          this.leftMatched = true;
          return combined;
        }
      }
      this.closeRight(frame);
      if (!this.leftMatched && this.join.joinType === 'LEFT' && !this.nullPadEmitted) {
        this.nullPadEmitted = true;
        const out: EvalRow = { ...this.leftRow };
        for (const id of this.rightColumnIds) out[id] = null;
        this.leftRow = this.left.next(frame);
        return out;
      }
      this.leftRow = this.left.next(frame);
    }
    return null;
  }

  close(frame: ExecFrame): void {
    this.closeRight(frame);
    this.left.close(frame);
  }
}

// ------------------------------------------------------------
// Hash Join
// 构建阶段以右表为内侧（build 侧），探测左表
// ------------------------------------------------------------
type CompiledKeyExpr = (row: EvalRow, frame: ExecFrame) => DBValue;

export class HashJoinOp extends Operator {
  private hashTable = new Map<string, EvalRow[]>();
  private leftRow: EvalRow | null = null;
  private matches: EvalRow[] = [];
  private matchPos = 0;
  private leftMatched = false; // 当前左行是否已产出至少一条匹配
  private nullPadEmitted = false;

  constructor(
    private join: LogicalJoin,
    private left: Operator,
    private right: Operator,
    private leftKeys: CompiledKeyExpr[],
    private rightKeys: CompiledKeyExpr[],
    private others: BoundExpr[],
    private rightColumnIds: string[],
    private ctx: ExecContext,
  ) { super(); }

  open(frame: ExecFrame): void {
    this.hashTable.clear();
    this.right.open(frame);
    let r: EvalRow | null;
    while ((r = this.right.next(frame))) {
      // 任一连接键为 null => 永不匹配等值连接，不放入哈希表
      if (!this.keyHasNull(this.rightKeys, r, frame)) {
        const key = this.hashKey(this.rightKeys, r, frame);
        const bucket = this.hashTable.get(key) ?? [];
        bucket.push(r);
        this.hashTable.set(key, bucket);
      }
    }
    this.right.close(frame);
    this.ctx.stats.hashJoinsBuilt++;
    this.ctx.stats.hashJoinRows += this.hashTable.size;

    this.left.open(frame);
    this.loadNextLeft(frame);
  }

  private keyHasNull(fns: CompiledKeyExpr[], row: EvalRow, frame: ExecFrame): boolean {
    return fns.some((f) => f(row, frame) === null);
  }

  private loadNextLeft(frame: ExecFrame): void {
    this.leftRow = this.left.next(frame);
    this.matches = [];
    this.matchPos = 0;
    this.leftMatched = false;
    this.nullPadEmitted = false;
    if (this.leftRow) {
      if (!this.keyHasNull(this.leftKeys, this.leftRow, frame)) {
        const key = this.hashKey(this.leftKeys, this.leftRow, frame);
        this.matches = this.hashTable.get(key) ?? [];
      }
    }
  }

  next(frame: ExecFrame): EvalRow | null {
    while (this.leftRow) {
      // 遍历当前左行的候选右行
      while (this.matchPos < this.matches.length) {
        const rightRow = this.matches[this.matchPos++];
        const combined = { ...this.leftRow, ...rightRow };
        if (this.others.length === 0 || this.others.every((c) => truthy(c.eval(combined, frame)) === true)) {
          this.leftMatched = true;
          return combined;
        }
      }
      // LEFT JOIN：当前左行无任何匹配 => 输出一次右列全 NULL
      if (!this.leftMatched && this.join.joinType === 'LEFT' && !this.nullPadEmitted) {
        this.nullPadEmitted = true;
        return this.padRightWithNulls(this.leftRow);
      }
      this.loadNextLeft(frame);
    }
    return null;
  }

  private padRightWithNulls(leftRow: EvalRow): EvalRow {
    const out: EvalRow = { ...leftRow };
    for (const id of this.rightColumnIds) out[id] = null;
    return out;
  }

  close(frame: ExecFrame): void { this.left.close(frame); }

  private hashKey(fns: CompiledKeyExpr[], row: EvalRow, frame: ExecFrame): string {
    return fns.map((f) => valueKey(f(row, frame))).join('|');
  }
}

/** 分组/连接哈希键（null 参与匹配：null = null 在 JOIN ON 中不为真，故单独分组永不匹配） */
export function valueKey(v: DBValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return `b:${v ? 1 : 0}`;
  if (typeof v === 'number') return `n:${Object.is(v, -0) ? '0' : String(v)}`;
  return `s:${v}`;
}

// ------------------------------------------------------------
// Aggregate
// ------------------------------------------------------------
interface AggGroupState {
  groupKey: string;
  groupValues: DBValue[];
  /** 每个聚合一个累加状态 */
  states: AggAccumulator[];
  /** DISTINCT 聚合的已见值集合（与 aggs 下标对齐） */
  distinctSets: (Set<string> | null)[];
  representativeRow: EvalRow;
}

type AggAccumulator =
  | { kind: 'COUNT'; count: number }
  | { kind: 'SUM'; sum: number; isInt: boolean; seen: boolean }
  | { kind: 'AVG'; sum: number; count: number }
  | { kind: 'MINMAX'; min: DBValue; max: DBValue; seen: boolean };

export class AggregateOp extends Operator {
  private groups: AggGroupState[] = [];
  private pos = 0;
  private groupLabels: string[];
  private aggLabels: string[];

  constructor(
    private child: Operator,
    private groupExprs: BoundExpr[],
    private aggs: AggregateSpec[],
    groupLabels: string[],
    aggLabels: string[],
    private globalAgg: boolean,
    private ctx: ExecContext,
  ) {
    super();
    this.groupLabels = groupLabels;
    this.aggLabels = aggLabels;
  }

  open(frame: ExecFrame): void {
    this.child.open(frame);
    const map = new Map<string, AggGroupState>();
    this.groups = [];

    let row: EvalRow | null;
    while ((row = this.child.next(frame))) {
      const current: EvalRow = row;
      const groupValues = this.groupExprs.map((g) => g.eval(current, frame));
      // GROUP BY 中 null 分组（null 聚在一起）
      const key = groupValues.map(valueKey).join('|');
      let state = map.get(key);
      if (!state) {
        state = {
          groupKey: key,
          groupValues,
          states: this.aggs.map((a) => newAccumulator(a)),
          distinctSets: this.aggs.map((a) => (a.distinct ? new Set<string>() : null)),
          representativeRow: current,
        };
        map.set(key, state);
        this.groups.push(state);
      }
      for (let i = 0; i < this.aggs.length; i++) {
        const spec = this.aggs[i];
        let v: DBValue = null;
        if (spec.arg !== null) v = this.ctx.pool.get(spec.arg).eval(current, frame);
        // DISTINCT：非 null 值先去重（COUNT(*) 无 distinct）
        if (spec.distinct && spec.arg !== null) {
          if (v === null) continue;
          const set = state.distinctSets[i]!;
          const k = valueKey(v);
          if (set.has(k)) continue;
          set.add(k);
        }
        accumulate(state.states[i], spec, v);
      }
    }

    // 全局聚合（无 GROUP BY）：零行也要输出一行
    if (this.globalAgg && this.groups.length === 0) {
      this.groups = [{
        groupKey: '',
        groupValues: [],
        states: this.aggs.map((a) => newAccumulator(a)),
        distinctSets: this.aggs.map((a) => (a.distinct ? new Set<string>() : null)),
        representativeRow: {},
      }];
    }
    this.pos = 0;
  }

  next(frame: ExecFrame): EvalRow | null {
    if (this.pos >= this.groups.length) return null;
    const g = this.groups[this.pos++];
    const out: EvalRow = {};
    // 有 GROUP BY 时，透传分组代表行的源列。
    // 实用的函数依赖扩展：分组键（尤其主键）函数决定同表其它列。
    // 非分组列在语义上不保证唯一，此处取每组首行的值。
    if (!this.globalAgg) {
      for (const [k, v] of Object.entries(g.representativeRow)) {
        if (!k.endsWith('.__pk__')) out[k] = v;
      }
    }
    for (let i = 0; i < this.groupExprs.length; i++) {
      const value = g.groupValues[i];
      out[this.groupLabels[i]] = value;
      for (const refId of this.groupExprs[i].columnRefs) {
        if (!refId.startsWith('outer')) out[refId] = value;
      }
    }
    for (let i = 0; i < this.aggs.length; i++) {
      out[this.aggLabels[i]] = finalize(g.states[i], this.aggs[i]);
    }
    return out;
  }

  close(frame: ExecFrame): void { this.child.close(frame); }
}

function newAccumulator(spec: AggregateSpec): AggAccumulator {
  switch (spec.kind) {
    case 'COUNT': return { kind: 'COUNT', count: 0 };
    case 'SUM': return { kind: 'SUM', sum: 0, isInt: true, seen: false };
    case 'AVG': return { kind: 'AVG', sum: 0, count: 0 };
    case 'MIN':
    case 'MAX': return { kind: 'MINMAX', min: null, max: null, seen: false };
  }
}

function accumulate(acc: AggAccumulator, spec: AggregateSpec, v: DBValue): void {
  if (spec.kind === 'COUNT') {
    // COUNT(*) 始终计数；COUNT(expr) 跳过 null（DISTINCT 已在外层去重）
    if (acc.kind === 'COUNT' && (spec.arg === null || v !== null)) acc.count++;
    return;
  }
  if (v === null) return;
  switch (acc.kind) {
    case 'SUM':
      acc.seen = true;
      acc.sum += numeric(v);
      if (typeof v !== 'number' || !Number.isInteger(v)) acc.isInt = false;
      break;
    case 'AVG':
      acc.sum += numeric(v);
      acc.count++;
      break;
    case 'MINMAX':
      acc.seen = true;
      if (acc.min === null || compareValues(v, acc.min) < 0) acc.min = v;
      if (acc.max === null || compareValues(v, acc.max) > 0) acc.max = v;
      break;
    case 'COUNT': break;
  }
}

function numeric(v: DBValue): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v);
}

function finalize(acc: AggAccumulator, spec: AggregateSpec): DBValue {
  switch (acc.kind) {
    case 'COUNT': return acc.count;
    case 'SUM':
      if (!acc.seen) return null;
      return acc.sum;
    case 'AVG':
      if (acc.count === 0) return null;
      return acc.sum / acc.count; // REAL
    case 'MINMAX':
      return spec.kind === 'MIN' ? acc.min : acc.max;
  }
}

/** DISTINCT 聚合去重：按 (聚合下标, 值) 过滤输入行 */
export class DistinctAggregateOp extends Operator {
  constructor(
    private child: Operator,
    private specs: AggregateSpec[],
  ) { super(); }

  private seen: Set<string>[] = [];
  open(frame: ExecFrame): void {
    this.seen = this.specs.map(() => new Set());
    this.child.open(frame);
  }
  next(frame: ExecFrame): EvalRow | null {
    // 该算子实际由 AggregateOp 内部感知；这里不单独使用
    return this.child.next(frame);
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Sort
// ------------------------------------------------------------
export class SortOp extends Operator {
  private rows: EvalRow[] = [];
  private pos = 0;
  constructor(
    private child: Operator,
    private keys: { expr: BoundExpr; desc: boolean; nullsFirst: boolean }[],
  ) { super(); }

  open(frame: ExecFrame): void {
    this.rows = this.child.all(frame);
    // 稳定排序：索引作为最终 tiebreak
    this.rows.sort((a, b) => {
      for (const k of this.keys) {
        const av = k.expr.eval(a, frame);
        const bv = k.expr.eval(b, frame);
        if (av === null && bv === null) continue;
        if (av === null) return k.nullsFirst ? -1 : 1;
        if (bv === null) return k.nullsFirst ? 1 : -1;
        const c = compareValues(av, bv);
        if (c !== 0) return k.desc ? -c : c;
      }
      return 0;
    });
    this.pos = 0;
  }

  next(_frame: ExecFrame): EvalRow | null {
    return this.rows[this.pos++] ?? null;
  }

  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Limit / Offset
// ------------------------------------------------------------
export class LimitOp extends Operator {
  private skipped = 0;
  private emitted = 0;
  constructor(
    private child: Operator,
    private limit: number,
    private offset: number,
  ) { super(); }

  open(frame: ExecFrame): void {
    this.child.open(frame);
    this.skipped = 0;
    this.emitted = 0;
  }
  next(frame: ExecFrame): EvalRow | null {
    while (this.skipped < this.offset) {
      if (!this.child.next(frame)) return null;
      this.skipped++;
    }
    if (this.emitted >= this.limit) return null;
    const row = this.child.next(frame);
    if (row) this.emitted++;
    return row;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// Distinct
// ------------------------------------------------------------
export class DistinctOp extends Operator {
  private seen = new Set<string>();
  constructor(private child: Operator) { super(); }
  open(frame: ExecFrame): void {
    this.seen.clear();
    this.child.open(frame);
  }
  next(frame: ExecFrame): EvalRow | null {
    for (;;) {
      const row = this.child.next(frame);
      if (!row) return null;
      const key = Object.keys(row)
        .filter((k) => !k.endsWith('.__pk__'))
        .sort()
        .map((k) => `${k}=${valueKey(row[k])}`).join(';');
      if (!this.seen.has(key)) {
        this.seen.add(key);
        return row;
      }
    }
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// 子查询数据源（FROM 子查询）
// ------------------------------------------------------------
export class SubquerySourceOp extends Operator {
  constructor(
    private child: Operator,
    private alias: string,
    private mapping: { innerLabel: string; outerId: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const row = this.child.next(frame);
    if (!row) return null;
    const out: EvalRow = {};
    for (const m of this.mapping) {
      out[m.outerId] = row[m.innerLabel] ?? null;
    }
    return out;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}
