// ============================================================
// Binder：AST -> 逻辑计划
// 职责：表名/列名解析、别名、作用域（含相关子查询外层）、
//       聚合提取与重写、表达式编译为 BoundExpr
// ============================================================

import type {
  Expr, SelectStmt, TableRef, Pos,
} from '../sql/ast';
import type { DBValue, Row } from '../sql/types';
import { SQLError } from '../sql/types';
import {
  arithmetic, compare, like, doCast, truthy, and3, or3,
  type CompiledExpr, type EvalRow, type ExecFrame,
} from './eval-expr';
import { sqlEquals } from './table-store';
import type {
  LogicalPlan, OutputColumn, BoundExpr, AggregateSpec,
} from './logical-plan';
import type { Database } from './database';

let uid = 0;
function genId(prefix: string): string {
  return `${prefix}_${++uid}`;
}

export class ExprPool {
  exprs: BoundExpr[] = [];

  add(e: {
    eval: CompiledExpr;
    debug: string;
    columnRefs: Set<string>;
    constant: boolean;
    ast?: Expr;
  }): number {
    const id = this.exprs.length;
    this.exprs.push({ correlated: false, ...e });
    return id;
  }

  get(id: number): BoundExpr {
    return this.exprs[id];
  }
}

// ------------------------------------------------------------
// 作用域：单层 FROM 源可见的列
// ------------------------------------------------------------
interface ScopeColumn {
  id: string;          // 行内取值键
  label: string;       // 输出标签
  origin: string;      // 原始列名（小写）
  source: string;      // 表别名（小写）
  type: OutputColumn['type'];
  /** 物理行取值键可能与 id 不同（scan 时 id 即 "alias.col"） */
}

class Scope {
  columns: ScopeColumn[] = [];
  /** 别名 -> 源（用于限定列名） */
  aliases = new Set<string>();

  addColumns(cols: OutputColumn[], alias: string): void {
    for (const c of cols) {
      this.columns.push({
        id: c.id,
        label: c.label,
        origin: (c.originName ?? c.label).toLowerCase(),
        source: alias.toLowerCase(),
        type: c.type,
      });
    }
    this.aliases.add(alias.toLowerCase());
  }

  resolveUnqualified(name: string): ScopeColumn[] {
    const lower = name.toLowerCase();
    return this.columns.filter((c) => c.origin === lower);
  }

  resolveQualified(source: string, name: string): ScopeColumn[] {
    const s = source.toLowerCase();
    const n = name.toLowerCase();
    return this.columns.filter((c) => c.source === s && c.origin === n);
  }
}

// ------------------------------------------------------------
// 子查询注册
// ------------------------------------------------------------
interface SubqueryInfo {
  kind: 'scalar' | 'in' | 'exists';
  /** 绑定后的子查询计划 */
  plan: LogicalPlan;
  outputs: OutputColumn[];
  /** 相关深度：引用了哪几层外层（1=直接外层） */
  correlatedDepths: Set<number>;
}

// ------------------------------------------------------------
// 聚合收集
// ------------------------------------------------------------
interface FoundAggregate {
  /** AST 节点引用（用对象身份） */
  node: Extract<Expr, { kind: 'func' }>;
  /** 编译参数（不做聚合调用，只取底层值） */
}

export class Binder {
  db: Database;
  pool = new ExprPool();
  subqueries: SubqueryInfo[] = [];
  /** 作用域栈：0 为最外层 */
  private scopes: Scope[] = [];
  /** 聚合收集栈（每层 SELECT 一个） */
  private aggContexts: AggContext[] = [];

  constructor(db: Database) {
    this.db = db;
  }

  // ---------------------------------------------------------
  // FROM 解析
  // ---------------------------------------------------------
  /** 绑定纯常量表达式（INSERT VALUES） */
  bindConstantExpr(e: Expr): number {
    return this.bindExpr(e);
  }

  bindSelect(stmt: SelectStmt): { plan: LogicalPlan; outputs: OutputColumn[] } {
    const scope = new Scope();
    this.scopes.push(scope);
    const aggCtx: AggContext = { aggregates: [], hasGroupBy: false, groupExprIds: [] };
    this.aggContexts.push(aggCtx);

    // 1. FROM
    let plan: LogicalPlan | null = null;
    if (stmt.from) {
      plan = this.bindTableRef(stmt.from, scope);
    } else {
      // 无 FROM：单行虚表
      plan = { node: 'dummy' };
    }

    // 2. WHERE（不允许聚合）
    if (stmt.where) {
      const savedAgg = aggCtx.allowAgg;
      aggCtx.allowAgg = false;
      const pred = this.bindExpr(stmt.where);
      aggCtx.allowAgg = savedAgg;
      if (this.pool.get(pred).debug.includes('??AGG')) {
        throw new SQLError('misuse of aggregate function in WHERE', stmt.where.pos, 'BIND');
      }
      plan = { node: 'filter', input: plan, predicate: pred };
    }

    // 3. GROUP BY
    if (stmt.groupBy.length > 0) {
      aggCtx.hasGroupBy = true;
      aggCtx.groupExprIds = stmt.groupBy.map((g) => this.bindExpr(g));
      plan = {
        node: 'aggregate',
        input: plan,
        groups: aggCtx.groupExprIds,
        aggregates: aggCtx.aggregates,
        groupOutputs: aggCtx.groupExprIds.map((id, i) => ({
          expr: id,
          label: this.groupLabel(stmt.groupBy[i]),
        })),
        globalAgg: false,
      };
    }

    // 4. SELECT 列表（先绑定表达式以收集聚合）
    const selectBound = stmt.items.map((item) => {
      const { id, isStar, starTable } = this.bindSelectExpr(item.expr);
      return { id, alias: item.alias, isStar, starTable, expr: item.expr, pos: item.pos };
    });

    // 星标展开在输出处理阶段
    if (!aggCtx.hasGroupBy && aggCtx.aggregates.length > 0) {
      plan = {
        node: 'aggregate',
        input: plan,
        groups: [],
        aggregates: aggCtx.aggregates,
        groupOutputs: [],
        globalAgg: true,
      };
    } else if (aggCtx.hasGroupBy) {
      // aggregates 可能在 SELECT 绑定后才收集完整，重建节点
      plan = this.attachAggregates(plan, aggCtx);
    }

    // 5. HAVING
    if (stmt.having) {
      const h = this.bindExpr(stmt.having);
      plan = { node: 'filter', input: plan, predicate: h };
    }

    // 6. 输出列与投影
    const outputs: OutputColumn[] = [];
    const projectItems: { expr: number; label: string; type: OutputColumn['type'] }[] = [];

    for (const item of selectBound) {
      if (item.isStar) {
        const stars = this.expandStar(item.starTable, scope);
        for (const sc of stars) {
          const label = this.uniqueLabel(sc.label, outputs);
          const colOutput: OutputColumn = {
            id: genId('out'),
            label,
            sourceAlias: sc.source,
            originName: sc.origin,
            type: sc.type,
          };
          outputs.push(colOutput);
          const refId = this.makeColumnRef(sc, item.pos);
          projectItems.push({ expr: refId, label, type: sc.type });
        }
      } else {
        const label = this.uniqueLabel(item.alias ?? this.defaultLabel(item.expr), outputs);
        const type = this.inferOutputType(item.expr, item.id, aggCtx);
        outputs.push({
          id: genId('out'),
          label,
          sourceAlias: null,
          originName: null,
          type,
        });
        projectItems.push({ expr: item.id, label, type });
      }
    }

    plan = { node: 'project', input: plan, items: projectItems, distinct: false };
    if (stmt.distinct) plan = { node: 'distinct', input: plan };

    // 7. ORDER BY
    if (stmt.orderBy.length > 0) {
      const keys = stmt.orderBy.map((o) => {
        let exprId: number;
        // 数字字面量：ORDER BY 序号
        if (o.expr.kind === 'literal' && typeof o.expr.value === 'number' && Number.isInteger(o.expr.value)) {
          const idx = o.expr.value - 1;
          if (idx < 0 || idx >= projectItems.length) {
            throw new SQLError(`ORDER BY position ${o.expr.value} is out of range`, o.pos, 'BIND');
          }
          exprId = this.rebindOutputRef(projectItems[idx], outputs[idx], scope);
        } else {
          exprId = this.bindOrderExpr(o.expr, projectItems, outputs, scope, o.pos);
        }
        const nullsFirst = o.nulls ? o.nulls === 'FIRST' : !o.desc;
        return { expr: exprId, desc: o.desc, nullsFirst };
      });
      plan = { node: 'sort', input: plan, keys };
    }

    // 8. LIMIT / OFFSET
    const limit = stmt.limit ? this.evalStaticInt(stmt.limit, 'LIMIT') : -1;
    const offset = stmt.offset ? this.evalStaticInt(stmt.offset, 'OFFSET') : 0;
    if (limit >= 0 || offset > 0) {
      plan = { node: 'limit', input: plan, limit: limit < 0 ? Number.MAX_SAFE_INTEGER : limit, offset };
    }

    this.scopes.pop();
    this.aggContexts.pop();
    return { plan, outputs };
  }

  private attachAggregates(plan: LogicalPlan, ctx: AggContext): LogicalPlan {
    // 找到 aggregate 节点并填入后收集到的聚合
    const walk = (p: LogicalPlan): LogicalPlan => {
      if (p.node === 'aggregate') {
        return { ...p, aggregates: ctx.aggregates };
      }
      if ('input' in p && p.input) return { ...p, input: walk(p.input) };
      return p;
    };
    return walk(plan);
  }

  private groupLabel(e: Expr): string {
    return this.defaultLabel(e);
  }

  private makeDummyScan(): LogicalPlan {
    return { node: 'dummy' };
  }

  // ---------------------------------------------------------
  // 表引用
  // ---------------------------------------------------------

  private bindTableRef(ref: TableRef, scope: Scope): LogicalPlan {
    switch (ref.kind) {
      case 'table': {
        const store = this.db.getTable(ref.name);
        const alias = ref.alias ?? store.def.name;
        const columns: OutputColumn[] = store.def.columns.map((c) => ({
          id: `${alias.toLowerCase()}.${c.name.toLowerCase()}`,
          label: c.name,
          sourceAlias: alias,
          originName: c.name,
          type: c.type,
        }));
        // 隐藏 rowid 也暴露为 __rowid__
        if (!store.def.primaryKey) {
          columns.push({
            id: `${alias.toLowerCase()}.__rowid__`,
            label: '__rowid__',
            sourceAlias: alias,
            originName: '__rowid__',
            type: 'INTEGER',
          });
        }
        scope.addColumns(columns, alias);
        return { node: 'scan', table: store.def.name, alias, columns };
      }
      case 'subquery': {
        const inner = this.bindSelect(ref.subquery);
        const columns: OutputColumn[] = inner.outputs.map((c) => ({
          id: `${ref.alias.toLowerCase()}.${c.label.toLowerCase()}`,
          label: c.label,
          sourceAlias: ref.alias,
          originName: c.label,
          type: c.type,
        }));
        scope.addColumns(columns, ref.alias);
        return { node: 'subquerySource', alias: ref.alias, plan: inner.plan, columns };
      }
      case 'join': {
        const left = this.bindTableRef(ref.left, scope);
        const right = this.bindTableRef(ref.right, scope);
        let condition: number | null = null;
        if (ref.on) condition = this.bindExpr(ref.on);
        return { node: 'join', joinType: ref.joinType, left, right, condition };
      }
    }
  }

  // ---------------------------------------------------------
  // SELECT 项 / 星标
  // ---------------------------------------------------------
  private bindSelectExpr(e: Expr): { id: number; isStar: boolean; starTable: string | null } {
    if (e.kind === 'star') {
      return { id: -1, isStar: true, starTable: e.table };
    }
    return { id: this.bindExpr(e), isStar: false, starTable: null };
  }

  private expandStar(tableQualifier: string | null, scope: Scope): ScopeColumn[] {
    if (!tableQualifier) return scope.columns.filter((c) => c.origin !== '__rowid__');
    const s = tableQualifier.toLowerCase();
    if (!scope.aliases.has(s)) throw new SQLError(`unknown table alias "${tableQualifier}"`, undefined, 'BIND');
    return scope.columns.filter((c) => c.source === s && c.origin !== '__rowid__');
  }

  private makeColumnRef(sc: ScopeColumn, pos: Pos): number {
    return this.compileColumnRef(sc.id, sc.label, pos);
  }

  // ---------------------------------------------------------
  // ORDER BY：可引用输出别名，也可引用底层列
  // ---------------------------------------------------------
  private bindOrderExpr(
    e: Expr,
    projectItems: { expr: number; label: string; type: OutputColumn['type'] }[],
    outputs: OutputColumn[],
    scope: Scope,
    pos: Pos,
  ): number {
    // 纯列名时先匹配输出别名（SQLite 行为）
    if (e.kind === 'column' && !e.table) {
      const lower = e.name.toLowerCase();
      const aliasIdx = projectItems.findIndex((p) => p.label.toLowerCase() === lower);
      if (aliasIdx >= 0) {
        return this.rebindOutputRef(projectItems[aliasIdx], outputs[aliasIdx], scope);
      }
    }
    try {
      return this.bindExpr(e);
    } catch (err) {
      throw err;
    }
  }

  private rebindOutputRef(
    projectItem: { expr: number; label: string; type: OutputColumn['type'] },
    output: OutputColumn,
    _scope: Scope,
  ): number {
    const label = output.label;
    return this.pool.add({
      eval: (row) => row[label] ?? null,
      debug: `ref(${label})`,
      columnRefs: new Set([label]),
      constant: false,
    });
  }

  private evalStaticInt(e: Expr, what: string): number {
    if (e.kind === 'literal' && typeof e.value === 'number') {
      const n = Math.trunc(e.value);
      if (n < 0) throw new SQLError(`${what} must not be negative`, e.pos, 'BIND');
      return n;
    }
    // 允许 cast 等简单常量表达式
    const id = this.bindExpr(e);
    const bound = this.pool.get(id);
    if (!bound.constant) throw new SQLError(`${what} must be a constant expression`, e.pos, 'BIND');
    const v = bound.eval({}, { outers: [], agg: null, sub: null });
    if (typeof v !== 'number' || Number.isNaN(v)) throw new SQLError(`${what} must be an integer`, e.pos, 'BIND');
    return Math.max(0, Math.trunc(v));
  }

  // ---------------------------------------------------------
  // 表达式绑定（核心）
  // ---------------------------------------------------------
  private currentScope(): Scope {
    return this.scopes[this.scopes.length - 1];
  }

  private currentAgg(): AggContext | null {
    return this.aggContexts[this.aggContexts.length - 1] ?? null;
  }

  private bindExpr(e: Expr): number {
    const id = this.bindExprInner(e);
    this.pool.get(id).ast = e;
    return id;
  }

  private bindExprInner(e: Expr): number {
    switch (e.kind) {
      case 'literal':
        return this.pool.add({
          eval: () => e.value,
          debug: e.value === null ? 'NULL' : (typeof e.value === 'string' ? `'${e.value}'` : String(e.value)),
          columnRefs: new Set(),
          constant: true,
        });

      case 'column':
        return this.bindColumn(e.table, e.name, e.pos);

      case 'star':
        throw new SQLError('"*" used outside SELECT list', e.pos, 'BIND');

      case 'unary': {
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => {
            const x = this.pool.get(v).eval(row, frame);
            if (x === null) return null;
            const n = typeof x === 'boolean' ? (x ? 1 : 0) : x;
            return e.op === '-' ? -(n as number) : (n as number);
          },
          debug: `(${e.op}${this.pool.get(v).debug})`,
          columnRefs: this.pool.get(v).columnRefs,
          constant: this.pool.get(v).constant,
        });
      }

      case 'binary': {
        const l = this.bindExpr(e.left);
        const r = this.bindExpr(e.right);
        const isCompare = ['=', '<>', '<', '<=', '>', '>='].includes(e.op);
        return this.pool.add({
          eval: (row, frame) => {
            const lv = this.pool.get(l).eval(row, frame);
            const rv = this.pool.get(r).eval(row, frame);
            if (isCompare) return compare(e.op as never, lv, rv);
            return arithmetic(e.op as '+' | '-' | '*' | '/' | '%', lv, rv, e.pos);
          },
          debug: `(${this.pool.get(l).debug} ${e.op} ${this.pool.get(r).debug})`,
          columnRefs: new Set([...this.pool.get(l).columnRefs, ...this.pool.get(r).columnRefs]),
          constant: this.pool.get(l).constant && this.pool.get(r).constant,
        });
      }

      case 'logical': {
        const l = this.bindExpr(e.left);
        const r = this.bindExpr(e.right);
        return this.pool.add({
          eval: (row, frame) => {
            const lv = truthy(this.pool.get(l).eval(row, frame));
            // AND/OR 短路（但仍返回三值）
            if (e.op === 'AND') {
              if (lv === false) return false;
              const rv = truthy(this.pool.get(r).eval(row, frame));
              return and3(lv, rv);
            }
            if (lv === true) return true;
            const rv = truthy(this.pool.get(r).eval(row, frame));
            return or3(lv, rv);
          },
          debug: `(${this.pool.get(l).debug} ${e.op} ${this.pool.get(r).debug})`,
          columnRefs: new Set([...this.pool.get(l).columnRefs, ...this.pool.get(r).columnRefs]),
          constant: this.pool.get(l).constant && this.pool.get(r).constant,
        });
      }

      case 'not': {
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => {
            const t = truthy(this.pool.get(v).eval(row, frame));
            return t === null ? null : !t;
          },
          debug: `(NOT ${this.pool.get(v).debug})`,
          columnRefs: this.pool.get(v).columnRefs,
          constant: this.pool.get(v).constant,
        });
      }

      case 'between': {
        const x = this.bindExpr(e.expr);
        const lo = this.bindExpr(e.low);
        const hi = this.bindExpr(e.high);
        return this.pool.add({
          eval: (row, frame) => {
            const xv = this.pool.get(x).eval(row, frame);
            const lv = this.pool.get(lo).eval(row, frame);
            const hv = this.pool.get(hi).eval(row, frame);
            const c1 = compare('>=', xv, lv);
            const c2 = compare('<=', xv, hv);
            let result: boolean | null = and3(c1, c2);
            if (e.negated) result = result === null ? null : !result;
            return result;
          },
          debug: `(${this.pool.get(x).debug} ${e.negated ? 'NOT ' : ''}BETWEEN ...)`,
          columnRefs: new Set([...this.pool.get(x).columnRefs, ...this.pool.get(lo).columnRefs, ...this.pool.get(hi).columnRefs]),
          constant: [x, lo, hi].every((i) => this.pool.get(i).constant),
        });
      }

      case 'inList': {
        const x = this.bindExpr(e.expr);
        const list = e.list.map((le) => this.bindExpr(le));
        return this.pool.add({
          eval: (row, frame) => {
            const xv = this.pool.get(x).eval(row, frame);
            if (xv === null) return null;
            let sawNull = false;
            for (const item of list) {
              const iv = this.pool.get(item).eval(row, frame);
              const eq = sqlEquals(xv, iv);
              if (eq === true) return !e.negated;
              if (eq === null) sawNull = true;
            }
            const result = sawNull ? null : false;
            return e.negated ? (result === null ? null : !result) : result;
          },
          debug: `(${this.pool.get(x).debug} ${e.negated ? 'NOT ' : ''}IN (...))`,
          columnRefs: new Set(list.flatMap((i) => [...this.pool.get(i).columnRefs])),
          constant: false,
        });
      }

      case 'inSubquery':
        return this.bindInSubquery(e);

      case 'exists':
        return this.bindExists(e);

      case 'scalarSubquery':
        return this.bindScalarSubquery(e);

      case 'like': {
        const x = this.bindExpr(e.pattern);
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => {
            const sv = this.pool.get(v).eval(row, frame);
            const pv = this.pool.get(x).eval(row, frame);
            const m = like(sv, pv);
            return e.negated && m !== null ? !m : m;
          },
          debug: `(${this.pool.get(v).debug} ${e.negated ? 'NOT ' : ''}LIKE ${this.pool.get(x).debug})`,
          columnRefs: new Set([...this.pool.get(v).columnRefs, ...this.pool.get(x).columnRefs]),
          constant: this.pool.get(v).constant && this.pool.get(x).constant,
        });
      }

      case 'isNull': {
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => this.pool.get(v).eval(row, frame) === null ? !e.negated : e.negated,
          debug: `(${this.pool.get(v).debug} IS ${e.negated ? 'NOT ' : ''}NULL)`,
          columnRefs: this.pool.get(v).columnRefs,
          constant: this.pool.get(v).constant,
        });
      }

      case 'isBoolean': {
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => {
            const val = this.pool.get(v).eval(row, frame);
            // IS TRUE: val===true(数字非0视为true，但 null/0/false 不算)
            let result: boolean;
            if (val === null) result = false;
            else if (typeof val === 'boolean') result = val === e.want;
            else if (typeof val === 'number') result = (val !== 0) === e.want;
            else result = false;
            return e.negated ? !result : result;
          },
          debug: `(${this.pool.get(v).debug} IS ${e.negated ? 'NOT ' : ''}${e.want ? 'TRUE' : 'FALSE'})`,
          columnRefs: this.pool.get(v).columnRefs,
          constant: this.pool.get(v).constant,
        });
      }

      case 'case': {
        const operand = e.operand ? this.bindExpr(e.operand) : null;
        const whens = e.whens.map((w) => ({ when: this.bindExpr(w.when), then: this.bindExpr(w.then) }));
        const elseExpr = e.elseExpr ? this.bindExpr(e.elseExpr) : null;
        return this.pool.add({
          eval: (row, frame) => {
            for (const w of whens) {
              let cond: DBValue;
              if (operand !== null) {
                cond = compare('=', this.pool.get(operand).eval(row, frame), this.pool.get(w.when).eval(row, frame));
              } else {
                cond = truthy(this.pool.get(w.when).eval(row, frame));
              }
              if (cond === true) return this.pool.get(w.then).eval(row, frame);
            }
            return elseExpr !== null ? this.pool.get(elseExpr).eval(row, frame) : null;
          },
          debug: 'CASE',
          columnRefs: new Set([
            ...(operand !== null ? [...this.pool.get(operand).columnRefs] : []),
            ...whens.flatMap((w) => [...this.pool.get(w.when).columnRefs, ...this.pool.get(w.then).columnRefs]),
            ...(elseExpr !== null ? [...this.pool.get(elseExpr).columnRefs] : []),
          ]),
          constant: false,
        });
      }

      case 'cast': {
        const v = this.bindExpr(e.expr);
        return this.pool.add({
          eval: (row, frame) => doCast(this.pool.get(v).eval(row, frame), e.type, e.pos),
          debug: `CAST(${this.pool.get(v).debug} AS ${e.type})`,
          columnRefs: this.pool.get(v).columnRefs,
          constant: this.pool.get(v).constant,
        });
      }

      case 'func':
        return this.bindAggregate(e);
    }
  }

  // ---------------------------------------------------------
  // 列解析（含外层相关引用）
  // ---------------------------------------------------------
  private bindColumn(table: string | null, name: string, pos: Pos): number {
    let found: ScopeColumn | null = null;
    let ambiguous = false;

    for (let depth = this.scopes.length - 1; depth >= 0; depth--) {
      const scope = this.scopes[depth];
      let matches: ScopeColumn[];
      if (table) {
        matches = scope.resolveQualified(table, name);
      } else {
        matches = scope.resolveUnqualified(name);
      }
      if (matches.length === 1) {
        found = matches[0];
        break;
      }
      if (matches.length > 1) {
        ambiguous = true;
        found = matches[0];
        break;
      }
    }

    if (!found) {
      throw new SQLError(
        table ? `no such column: ${table}.${name}` : `no such column: ${name}`,
        pos, 'BIND',
      );
    }
    if (ambiguous) {
      throw new SQLError(`ambiguous column name: ${table ? `${table}.` : ''}${name}`, pos, 'BIND');
    }

    const depth = this.scopes.length - 1 - this.scopeIndexOf(found);
    return this.compileColumnRef(found.id, found.label, pos, depth);
  }

  private scopeIndexOf(col: ScopeColumn): number {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].columns.includes(col)) return i;
    }
    return this.scopes.length - 1;
  }

  private compileColumnRef(id: string, label: string, pos: Pos, outerDepth = 0): number {
    void pos;
    if (outerDepth === 0) {
      return this.pool.add({
        eval: (row, frame) => (row[id] ?? null),
        debug: `col(${id})`,
        columnRefs: new Set([id]),
        constant: false,
      });
    }
    // 相关引用：从 frame.outers 取，深度 1 => outers[outers.length-1]
    const idxFromTop = outerDepth - 1;
    return this.pool.add({
      eval: (_row, frame) => {
        const outerRow = frame.outers[frame.outers.length - 1 - idxFromTop];
        return outerRow ? (outerRow[id] ?? null) : null;
      },
      debug: `outer${outerDepth}.col(${id})`,
      columnRefs: new Set([`outer${outerDepth}:${id}`]),
      constant: false,
    });
  }

  // ---------------------------------------------------------
  // 聚合
  // ---------------------------------------------------------
  private bindAggregate(e: Extract<Expr, { kind: 'func' }>): number {
    const ctx = this.currentAgg();
    const inAggArg = this.insideAggArg;
    if (ctx && ctx.allowAgg !== false && !inAggArg) {
      // 收集
      let arg: number | null = null;
      if (!e.star) {
        this.insideAggArg = true;
        try {
          if (e.args.length !== 1) throw new SQLError(`aggregate ${e.name} expects 1 argument`, e.pos, 'BIND');
          arg = this.bindExpr(e.args[0]);
        } finally {
          this.insideAggArg = false;
        }
      } else if (e.name !== 'COUNT') {
        throw new SQLError(`aggregate ${e.name}(*) is not supported`, e.pos, 'BIND');
      }

      // 去重：同一 kind/distinct/arg 复用
      const kind = e.name as AggregateSpec['kind'];
      let spec = ctx.aggregates.find(
        (a) => a.kind === kind && a.distinct === e.distinct && a.arg === arg,
      );
      if (!spec) {
        const type: AggregateSpec['type'] =
          kind === 'COUNT' ? 'INTEGER' :
          kind === 'AVG' ? 'REAL' : 'ANY';
        spec = {
          kind,
          distinct: e.distinct,
          arg,
          label: this.aggLabel(e),
          type,
        };
        ctx.aggregates.push(spec);
      }
      const index = ctx.aggregates.indexOf(spec);
      return this.pool.add({
        eval: (_row, frame) => {
          if (!frame.agg) throw new SQLError('aggregate used outside aggregate context', e.pos, 'RUNTIME');
          return frame.agg.get(index);
        },
        debug: `??AGG(${index})`,
        columnRefs: new Set(),
        constant: false,
      });
    }

    // 非聚合上下文（如 WHERE 已禁止；或子查询内单独处理）
    throw new SQLError(`misuse of aggregate function ${e.name}()`, e.pos, 'BIND');
  }

  private insideAggArg = false;

  private aggLabel(e: Extract<Expr, { kind: 'func' }>): string {
    if (e.star) return 'COUNT(*)';
    const arg = this.defaultLabel(e.args[0]);
    return `${e.name}(${e.distinct ? 'DISTINCT ' : ''}${arg})`;
  }

  // ---------------------------------------------------------
  // 子查询
  // ---------------------------------------------------------
  private bindScalarSubquery(e: Extract<Expr, { kind: 'scalarSubquery' }>): number {
    const id = this.subqueries.length;
    const saved = this.bindSubqueryPlan(e.subquery);
    const { correlated, depths } = this.analyzeCorrelation(saved.plan, id);
    this.subqueries.push({ kind: 'scalar', plan: saved.plan, outputs: saved.outputs, correlatedDepths: depths });
    void correlated;
    return this.pool.add({
      eval: (row, frame) => {
        if (!frame.sub) throw new SQLError('subquery evaluator missing', e.pos, 'INTERNAL');
        return frame.sub.scalar(id, row, frame);
      },
      debug: `(scalar-subquery#${id})`,
      columnRefs: new Set(),
      constant: false,
    });
  }

  private bindInSubquery(e: Extract<Expr, { kind: 'inSubquery' }>): number {
    const id = this.subqueries.length;
    const left = this.bindExpr(e.expr);
    const saved = this.bindSubqueryPlan(e.subquery);
    const { depths } = this.analyzeCorrelation(saved.plan, id);
    this.subqueries.push({ kind: 'in', plan: saved.plan, outputs: saved.outputs, correlatedDepths: depths });
    const neg = e.negated;
    return this.pool.add({
      eval: (row, frame) => {
        if (!frame.sub) throw new SQLError('subquery evaluator missing', e.pos, 'INTERNAL');
        const v = this.pool.get(left).eval(row, frame);
        const result = frame.sub.inSub(id, v, row, frame);
        return neg ? (result === null ? null : !result) : result;
      },
      debug: `(IN-subquery#${id})`,
      columnRefs: new Set(this.pool.get(left).columnRefs),
      constant: false,
    });
  }

  private bindExists(e: Extract<Expr, { kind: 'exists' }>): number {
    const id = this.subqueries.length;
    const saved = this.bindSubqueryPlan(e.subquery);
    const { depths } = this.analyzeCorrelation(saved.plan, id);
    this.subqueries.push({ kind: 'exists', plan: saved.plan, outputs: saved.outputs, correlatedDepths: depths });
    const neg = e.negated;
    return this.pool.add({
      eval: (row, frame) => {
        if (!frame.sub) throw new SQLError('subquery evaluator missing', e.pos, 'INTERNAL');
        const result = frame.sub.exists(id, row, frame);
        return neg ? !result : result;
      },
      debug: `(${neg ? 'NOT ' : ''}EXISTS#${id})`,
      columnRefs: new Set(),
      constant: false,
    });
  }

  private bindSubqueryPlan(stmt: SelectStmt): { plan: LogicalPlan; outputs: OutputColumn[] } {
    // bindSelect 自行管理 scope 与 aggContext；外层 scope 保留在栈底供相关引用解析
    return this.bindSelect(stmt);
  }

  private analyzeCorrelation(plan: LogicalPlan, _subId: number): { correlated: boolean; depths: Set<number> } {
    const depths = new Set<number>();
    const walk = (p: LogicalPlan) => {
      const check = (id: number) => {
        const b = this.pool.get(id);
        for (const ref of b.columnRefs) {
          const m = /^outer(\d+):/.exec(ref);
          if (m) depths.add(parseInt(m[1], 10));
        }
      };
      switch (p.node) {
        case 'filter': check(p.predicate); walk(p.input); break;
        case 'project':
          for (const it of p.items) check(it.expr);
          walk(p.input);
          break;
        case 'join':
          if (p.condition !== null) check(p.condition);
          walk(p.left); walk(p.right);
          break;
        case 'aggregate':
          for (const g of p.groups) check(g);
          for (const a of p.aggregates) if (a.arg !== null) check(a.arg);
          walk(p.input);
          break;
        case 'sort':
          for (const k of p.keys) check(k.expr);
          walk(p.input);
          break;
        case 'limit': case 'distinct': walk(p.input); break;
        case 'subquerySource': walk(p.plan); break;
        case 'scan': break;
      }
    };
    walk(plan);
    return { correlated: depths.size > 0, depths };
  }

  // ---------------------------------------------------------
  // 标签与类型
  // ---------------------------------------------------------
  private uniqueLabel(label: string, existing: OutputColumn[]): string {
    if (!existing.some((c) => c.label === label)) return label;
    let i = 2;
    while (existing.some((c) => c.label === `${label}_${i}`)) i++;
    return `${label}_${i}`;
  }

  defaultLabel(e: Expr): string {
    switch (e.kind) {
      case 'column': return e.name;
      case 'literal': return e.value === null ? 'NULL' : String(e.value);
      case 'func': return this.aggLabel(e);
      case 'cast': return `CAST(${this.defaultLabel(e.expr)} AS ${e.type})`;
      case 'unary': return `${e.op}${this.defaultLabel(e.expr)}`;
      case 'binary': return `${this.defaultLabel(e.left)} ${e.op} ${this.defaultLabel(e.right)}`;
      case 'logical': return `${this.defaultLabel(e.left)} ${e.op} ${this.defaultLabel(e.right)}`;
      case 'isNull': return `${this.defaultLabel(e.expr)} IS NULL`;
      case 'isBoolean': return `${this.defaultLabel(e.expr)} IS ${e.want ? 'TRUE' : 'FALSE'}`;
      case 'like': return `${this.defaultLabel(e.expr)} LIKE ${this.defaultLabel(e.pattern)}`;
      case 'between': return `${this.defaultLabel(e.expr)} BETWEEN ...`;
      case 'inList': return `${this.defaultLabel(e.expr)} IN (...)`;
      case 'inSubquery': return `${this.defaultLabel(e.expr)} IN (SELECT ...)`;
      case 'exists': return 'EXISTS(...)';
      case 'scalarSubquery': return '(subquery)';
      case 'case': return 'CASE';
      case 'not': return `NOT ${this.defaultLabel(e.expr)}`;
      case 'star': return '*';
    }
  }

  private inferOutputType(_e: Expr, id: number, ctx: AggContext): OutputColumn['type'] {
    // 聚合结果类型已知
    const debug = this.pool.get(id).debug;
    const m = /^\?\?AGG\((\d+)\)$/.exec(debug);
    if (m) {
      const agg = ctx.aggregates[parseInt(m[1], 10)];
      if (agg) return agg.type === 'ANY' ? 'ANY' : agg.type;
    }
    return 'ANY';
  }
}

interface AggContext {
  aggregates: AggregateSpec[];
  hasGroupBy: boolean;
  groupExprIds: number[];
  /** 为 false 时（WHERE）遇到聚合报错 */
  allowAgg?: boolean;
}
