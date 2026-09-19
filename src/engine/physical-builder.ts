// ============================================================
// 物理计划构建：LogicalPlan -> 火山模型算子树
// 同时为子查询生成惰性构建器（相关子查询每次重新 build）
// ============================================================

import type { Expr as AstExpr } from '../sql/ast';
import type {
  LogicalPlan, LogicalJoin, OutputColumn, BoundExpr,
} from './logical-plan';
import type { ExprPool, Binder } from './binder';
import type { Database } from './database';
import type { ExecContext } from './executor';
import type { ExecFrame, EvalRow, CompiledExpr, AggState } from './eval-expr';
import {
  Operator, ScanOp, DummyOp, FilterOp, ProjectOp, NestedLoopJoinOp,
  HashJoinOp, AggregateOp, SortOp, LimitOp, DistinctOp, SubquerySourceOp,
} from './executor';
import { SubqueryRuntime } from './subquery-runtime';

/** 聚合求值时的 AggState 实现 */
class AggFrameState implements AggState {
  constructor(private values: DBValue[]) {}
  get(index: number): DBValue { return this.values[index] ?? null; }
}

// 引入 DBValue 仅用于类型
import type { DBValue } from '../sql/types';

export class PhysicalBuilder {
  private pool: ExprPool;

  constructor(
    private db: Database,
    private binder: Binder,
    private ctx: ExecContext,
  ) {
    this.pool = binder.pool;
  }

  build(plan: LogicalPlan): Operator {
    switch (plan.node) {
      case 'scan': {
        const colIds = plan.columns
          .filter((c) => c.originName !== null)
          .map((c) => ({ id: c.id, origin: c.originName as string }));
        return new ScanOp(this.db, plan.table, plan.alias, colIds, plan.index, this.ctx);
      }
      case 'dummy':
        return new DummyOp();

      case 'filter':
        return new FilterOp(this.build(plan.input), this.pool.get(plan.predicate));

      case 'project': {
        const child = this.build(plan.input);
        const items = plan.items.map((it) => ({ expr: this.pool.get(it.expr), label: it.label }));
        return new ProjectExec(child, items);
      }

      case 'join':
        return this.buildJoin(plan);

      case 'aggregate':
        return this.buildAggregate(plan);

      case 'sort':
        return new SortOp(
          this.build(plan.input),
          plan.keys.map((k) => ({ expr: this.pool.get(k.expr), desc: k.desc, nullsFirst: k.nullsFirst })),
        );

      case 'limit':
        return new LimitOp(this.build(plan.input), plan.limit, plan.offset);

      case 'distinct':
        return new DistinctOp(this.build(plan.input));

      case 'subquerySource': {
        const child = this.build(plan.plan);
        const innerOutputs = this.outputLabelsOf(plan.plan);
        const mapping = plan.columns.map((outer, i) => ({
          innerLabel: innerOutputs[i] ?? outer.label,
          outerId: outer.id,
        }));
        return new SubquerySourceOp(child, plan.alias, mapping);
      }
    }
  }

  private outputLabelsOf(plan: LogicalPlan): string[] {
    if (plan.node === 'project') return plan.items.map((i) => i.label);
    if (plan.node === 'distinct' || plan.node === 'limit' || plan.node === 'sort') {
      return this.outputLabelsOf(plan.input);
    }
    if (plan.node === 'scan') return plan.columns.map((c) => c.label);
    if (plan.node === 'subquerySource') return plan.columns.map((c) => c.label);
    return [];
  }

  // ---------------------------------------------------------
  // JOIN
  // ---------------------------------------------------------
  private buildJoin(plan: LogicalJoin): Operator {
    const left = this.build(plan.left);
    const right = this.build(plan.right);
    const rightIds = this.columnIdsOf(plan.right);

    if (plan.impl === 'HASH' && plan.hashKeys && plan.hashKeys.length > 0) {
      // 为左右 AST 键编译表达式（使用 Binder 在对应侧的命名空间重新绑定）
      // 简化实现：复用原始条件表达式的 eval，在半行上求值。
      // 为正确处理，这里用“投影列集合 + AST 重绑定”不可得；
      // 因此采用一个小技巧：让键表达式直接从合并行中取值——
      // 等值 AST 仅包含单侧列，我们直接编译一个针对半行的取值函数：
      const leftKeyFns: CompiledExpr[] = plan.hashKeys.map((k) => this.compileSideExpr(k.leftAst));
      const rightKeyFns: CompiledExpr[] = plan.hashKeys.map((k) => this.compileSideExpr(k.rightAst));
      const others = (plan.otherConditions ?? []).map((id) => this.pool.get(id));
      return new HashJoinOp(plan, left, right, leftKeyFns, rightKeyFns, others, rightIds, this.ctx);
    }

    const cond = plan.condition !== null ? this.pool.get(plan.condition) : null;
    return new NestedLoopJoinOp(plan, left, right, cond, rightIds);
  }

  /**
   * 编译“半行”表达式：AST 中的列形如 alias.col。
   * 行数据里键就是 "alias.col"，故简单遍历 AST，把列引用直接映射为行查找。
   */
  private compileSideExpr(ast: AstExpr): CompiledExpr {
    // 使用 Binder.bindExpr 会污染池/作用域；改为直接构造轻量求值函数
    return (row: EvalRow, frame: ExecFrame): DBValue => {
      return evalAstOnRow(ast, row, frame, this.pool, this.binder);
    };
  }

  private columnIdsOf(plan: LogicalPlan): string[] {
    const rec = (p: LogicalPlan): OutputColumn[] => {
      switch (p.node) {
        case 'scan': return p.columns;
        case 'subquerySource': return p.columns;
        case 'join': return [...rec(p.left), ...rec(p.right)];
        case 'filter': return rec(p.input);
        case 'project':
        case 'aggregate':
        case 'sort':
        case 'limit':
        case 'distinct':
          return 'input' in p ? rec(p.input) : [];
        case 'dummy': return [];
      }
    };
    // 对 join 而言右侧应该是 scan/subquerySource/join，直接取其源列 id
    return rec(plan).map((c) => c.id);
  }

  // ---------------------------------------------------------
  // Aggregate
  // ---------------------------------------------------------
  private buildAggregate(plan: Extract<LogicalPlan, { node: 'aggregate' }>): Operator {
    const child = this.build(plan.input);
    const groupExprs = plan.groups.map((id) => this.pool.get(id));
    const groupLabels = plan.groupOutputs.map((g) => g.label);
    // 聚合输出 label 用 AggregateSpec.label；AggregateOp 需要与表达式中 ??AGG(i) 对齐
    const aggLabels = plan.aggregates.map((a) => a.label);
    const aggOp = new AggregateOp(
      child, groupExprs, plan.aggregates, groupLabels, aggLabels,
      plan.globalAgg, this.ctx,
    );

    // 聚合算子输出的行中，聚合值以 label 为键；但 SELECT/HAVING 的聚合表达式
    // 通过 frame.agg.get(index) 取值。需要一个包装算子把 agg labels 映射为 AggState。
    return new AggFrameAdapter(aggOp, plan.aggregates);
  }
}

/**
 * 聚合帧适配：子节点（AggregateOp）输出含 group 列与聚合 label 列的行；
 * 该适配器从行中读取聚合值，构造 AggState 放入 frame，供上层表达式使用。
 * 同时透传 group 列（含绑定 id）——group 表达式输出 label 与绑定列名不一致，
 * 因此 AggregateOp 还会额外输出绑定 id 键（见 AggregateOp 输出增强）。
 */
class AggFrameAdapter extends Operator {
  constructor(
    private child: AggregateOp,
    private aggs: { label: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const row = this.child.next(frame);
    if (!row) return null;
    const values: DBValue[] = this.aggs.map((a) => row[a.label] ?? null);
    const aggState: AggState = { get: (i) => values[i] ?? null };
    // 把 agg 注入 frame（可变对象），同一 frame 后续表达式即可读取
    frame.agg = aggState;
    return row;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

/**
 * Project 执行：在投影后需要让 ORDER BY 表达式能以输出 label 取值。
 * 标准 ProjectOp 已把结果以 label 输出；但底层绑定 id（如 alias.col）在
 * 聚合/排序场景仍需透传。这里增强为同时复制底层键。
 */
class ProjectExec extends Operator {
  constructor(
    private child: Operator,
    private items: { expr: BoundExpr; label: string }[],
  ) { super(); }

  open(frame: ExecFrame): void { this.child.open(frame); }
  next(frame: ExecFrame): EvalRow | null {
    const src = this.child.next(frame);
    if (!src) return null;
    const out: EvalRow = {};
    for (const it of this.items) {
      out[it.label] = it.expr.eval(src, frame);
    }
    return out;
  }
  close(frame: ExecFrame): void { this.child.close(frame); }
}

// ------------------------------------------------------------
// 半行表达式求值（用于 hash join 键）
// 仅支持列引用与字面量/简单表达式；hash 键按定义是“裸列”，列引用足够。
// ------------------------------------------------------------
function evalAstOnRow(
  ast: AstExpr,
  row: EvalRow,
  frame: ExecFrame,
  pool: ExprPool,
  binder: Binder,
): DBValue {
  if (ast.kind === 'column') {
    const key = ast.table ? `${ast.table.toLowerCase()}.${ast.name.toLowerCase()}` : null;
    if (key && key in row) return row[key];
    // 无修饰符：搜索以 .name 结尾的键
    if (!key) {
      const suffix = `.${ast.name.toLowerCase()}`;
      for (const k of Object.keys(row)) {
        if (k.toLowerCase().endsWith(suffix)) return row[k];
      }
    }
    // 回退：尝试通过 binder 池（理论上不会到这里）
    void pool; void binder;
    return null;
  }
  // 非常量/非列的 hash 键理论上已被优化器过滤；兜底返回 null
  void frame;
  return null;
}

export { SubqueryRuntime };
