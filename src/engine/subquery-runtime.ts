// ============================================================
// 子查询运行时
// 每个绑定阶段注册的子查询在此构建物理算子：
//   - 不相关子查询：缓存结果
//   - 相关子查询：每次按当前外层行重新执行
// ============================================================

import type { DBValue } from '../sql/types';
import { SQLError } from '../sql/types';
import type { EvalRow, ExecFrame, SubqueryResolver, AggState } from './eval-expr';
import type { Operator } from './executor';
import type { OutputColumn } from './logical-plan';
import { valueKey } from './executor';

export interface SubqueryPlanInfo {
  kind: 'scalar' | 'in' | 'exists';
  build: (frame: ExecFrame) => Operator;
  outputs: OutputColumn[];
  correlatedDepths: Set<number>;
}

export class SubqueryRuntime implements SubqueryResolver {
  private infos: SubqueryPlanInfo[] = [];
  /** 不相关子查询缓存：id -> 缓存结果 */
  private cache = new Map<number, CachedResult>();

  register(info: SubqueryPlanInfo): number {
    this.infos.push(info);
    return this.infos.length - 1;
  }

  private isCorrelated(id: number): boolean {
    return this.infos[id].correlatedDepths.size > 0;
  }

  private runRows(id: number, row: EvalRow, frame: ExecFrame): EvalRow[] {
    const info = this.infos[id];
    if (!this.isCorrelated(id)) {
      const cached = this.cache.get(id);
      if (cached) return cached.rows;
      const subFrame: ExecFrame = { outers: [...frame.outers, row], agg: null, sub: this };
      const op = info.build(subFrame);
      const rows = op.all(subFrame);
      this.cache.set(id, { rows });
      return rows;
    }
    // 相关：当前行作为最近外层
    const subFrame: ExecFrame = { outers: [...frame.outers, row], agg: null, sub: this };
    const op = info.build(subFrame);
    return op.all(subFrame);
  }

  scalar(id: number, row: EvalRow, frame: ExecFrame): DBValue {
    const info = this.infos[id];
    const rows = this.runRows(id, row, frame);
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new SQLError('scalar subquery returned more than 1 row', undefined, 'RUNTIME');
    }
    const first = rows[0];
    const label = info.outputs[0]?.label;
    if (label === undefined) return null;
    return first[label] ?? null;
  }

  inSub(id: number, value: DBValue, row: EvalRow, frame: ExecFrame): boolean | null {
    if (value === null) return null;
    const info = this.infos[id];
    const label = info.outputs[0]?.label;
    const rows = this.runRows(id, row, frame);
    let sawNull = false;
    for (const r of rows) {
      const v = label === undefined ? null : (r[label] ?? null);
      if (v === null) { sawNull = true; continue; }
      if (valueKey(v) === valueKey(value)) return true;
    }
    return sawNull ? null : false;
  }

  exists(id: number, row: EvalRow, frame: ExecFrame): boolean {
    return this.runRows(id, row, frame).length > 0;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

interface CachedResult {
  rows: EvalRow[];
}

/** 让 AggState 占位（未使用聚合时） */
export const noAgg: AggState = { get: () => null };
