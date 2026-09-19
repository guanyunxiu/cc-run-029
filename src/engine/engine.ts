// ============================================================
// Engine：解析 -> 绑定 -> 优化 -> 物理执行
// 对外提供 execute(sql)，管理事务（单写队列）与子查询注册
// ============================================================

import { Parser } from '../sql/parser';
import type {
  Stmt, SelectStmt, InsertStmt, UpdateStmt, DeleteStmt,
} from '../sql/ast';
import { castValue, type DBValue, type Row, SQLError } from '../sql/types';
import type { TableDef } from '../sql/types';
import { Database, Transaction, buildTableDef } from './database';
import { Binder } from './binder';
import { optimize, type OptimizerStats } from './optimizer';
import { PhysicalBuilder } from './physical-builder';
import { SubqueryRuntime } from './subquery-runtime';
import type { Operator } from './executor';
import type { ExecStats } from './executor';
import type {
  LogicalPlan, OutputColumn, StatementPlan,
} from './logical-plan';
import type { EvalRow, ExecFrame } from './eval-expr';
import { truthy } from './eval-expr';

export interface ResultColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  type: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'txn' | 'explain';
  columns: ResultColumn[];
  rows: Row[];
  rowsAffected: number;
  message: string;
  plan?: ExplainOutput;
  /** 语句在输入 SQL 中的起始位置 */
  pos: { line: number; column: number };
}

export interface ExplainOutput {
  logical: string;
  physical: string;
  indexes: OptimizerStats['indexesUsed'];
  optimizer: OptimizerStats;
  stats: ExecStats;
}

interface PreparedSelect {
  plan: LogicalPlan;
  outputs: OutputColumn[];
  optimizer: OptimizerStats;
  binder: Binder;
}

export class Engine {
  db: Database;
  private txn: Transaction | null = null;
  /** 写操作串行队列（单写） */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(db: Database) {
    this.db = db;
  }

  get inTransaction(): boolean {
    return this.txn !== null;
  }

  // ---------------------------------------------------------
  // 顶层入口
  // ---------------------------------------------------------
  async execute(sql: string): Promise<QueryResult[]> {
    const stmts = new Parser(sql).parseStatements();
    if (stmts.length === 0) return [];
    const results: QueryResult[] = [];
    for (const stmt of stmts) {
      results.push(await this.executeOne(stmt));
    }
    return results;
  }

  private executeOne(stmt: Stmt): Promise<QueryResult> {
    const base = { pos: stmt.pos };
    switch (stmt.kind) {
      case 'explain': {
        return this.runExplain(stmt.inner, stmt.pos);
      }
      case 'select':
        return Promise.resolve(this.runSelect(stmt, base.pos));
      case 'txn':
        return this.enqueueWrite(() => this.runTxn(stmt.op, stmt.pos));
      case 'insert':
      case 'update':
      case 'delete':
      case 'createTable':
      case 'dropTable':
      case 'createIndex':
      case 'dropIndex':
        return this.enqueueWrite(() => this.runWrite(stmt, stmt.pos));
    }
  }

  private enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.writeChain.then(() => fn());
    // 队列即使失败也继续
    this.writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---------------------------------------------------------
  // SELECT
  // ---------------------------------------------------------
  private prepareSelect(stmt: SelectStmt): PreparedSelect {
    const binder = new Binder(this.db);
    const bound = binder.bindSelect(stmt);
    const optimized = optimize(bound.plan, this.db, binder.pool);
    return {
      plan: optimized.plan,
      outputs: bound.outputs,
      optimizer: optimized.stats,
      binder,
    };
  }

  private runSelect(stmt: SelectStmt, pos: { line: number; column: number }): QueryResult {
    if (this.txn?.failed) {
      throw new SQLError(
        'current transaction is aborted; commands ignored until end of transaction block (use ROLLBACK)',
        pos, 'CONFLICT',
      );
    }
    const prepared = this.prepareSelect(stmt);
    const { rows, stats } = this.executePlan(prepared);

    const columns: ResultColumn[] = prepared.outputs.map((o) => ({
      name: o.label,
      type: formatType(o.type),
    }));
    // 去掉内部 __pk 等隐藏字段
    const clean = rows.map((r) => {
      const out: Row = {};
      for (const c of columns) out[c.name] = r[c.name] ?? null;
      return out;
    });
    return {
      type: 'select',
      columns,
      rows: clean,
      rowsAffected: clean.length,
      message: `${clean.length} row${clean.length === 1 ? '' : 's'} in result set`,
      pos,
    };
  }

  private executePlan(
    prepared: PreparedSelect,
    planOverride?: LogicalPlan,
  ): { rows: EvalRow[]; stats: ExecStats } {
    const subqueries = new SubqueryRuntime();
    const stats: ExecStats = {
      rowsScanned: 0,
      rowsOutput: 0,
      indexLookups: 0,
      hashJoinsBuilt: 0,
      hashJoinRows: 0,
    };
    const ctx = {
      db: this.db,
      txn: this.requireTxn(),
      pool: prepared.binder.pool,
      stats,
      subqueries,
    };
    const builder = new PhysicalBuilder(this.db, prepared.binder, ctx);

    // 注册子查询（惰性构建）
    prepared.binder.subqueries.forEach((info) => {
      subqueries.register({
        kind: info.kind,
        outputs: info.outputs,
        correlatedDepths: info.correlatedDepths,
        build: (_frame) => builder.build(info.plan),
      });
    });

    const op = builder.build(planOverride ?? prepared.plan);
    const frame: ExecFrame = { outers: [], agg: null, sub: subqueries };
    const rows = op.all(frame);
    stats.rowsOutput = rows.length;
    return { rows, stats };
  }

  /**
   * DML 需要拿到行的物理 __pk__（该字段在最终 Project 投影时被丢弃）。
   * 下钻到产生源列的子计划：limit -> distinct -> project -> ...
   * 为 DML 生成的 SELECT 永远是 select-star，无 distinct/order/limit，
   * 故只需去掉最外层 project。
   */
  private executeDmlScan(prepared: PreparedSelect): EvalRow[] {
    let plan: LogicalPlan = prepared.plan;
    if (plan.node === 'project') plan = plan.input;
    const { rows } = this.executePlan(prepared, plan);
    return rows;
  }

  // ---------------------------------------------------------
  // 写语句
  // ---------------------------------------------------------
  private async runWrite(
    stmt: Exclude<Stmt, { kind: 'select' | 'txn' | 'explain' }>,
    pos: { line: number; column: number },
  ): Promise<QueryResult> {
    const ownTxn = !this.txn;
    const txn = this.requireOrBeginTxn();
    try {
      let result: QueryResult;
      switch (stmt.kind) {
        case 'insert': result = this.runInsert(stmt, txn, pos); break;
        case 'update': result = this.runUpdate(stmt, txn, pos); break;
        case 'delete': result = this.runDelete(stmt, txn, pos); break;
        case 'createTable': result = this.runCreateTable(stmt, txn, pos); break;
        case 'dropTable': result = this.runDropTable(stmt, txn, pos); break;
        case 'createIndex': result = this.runCreateIndex(stmt, txn, pos); break;
        case 'dropIndex': result = this.runDropIndex(stmt, txn, pos); break;
      }
      if (ownTxn) {
        await this.db.commit(txn);
        this.txn = null;
      }
      return result;
    } catch (e) {
      if (ownTxn) {
        if (this.db.activeWriter === txn) this.db.releaseWriter(txn);
        this.txn = null;
      } else {
        // 显式事务：标记失败，保留写锁，等待 ROLLBACK
        txn.failed = true;
      }
      throw e;
    }
  }

  private requireOrBeginTxn(): Transaction {
    if (this.txn) {
      if (this.txn.failed) {
        throw new SQLError(
          'current transaction is aborted; commands ignored until end of transaction block (use ROLLBACK)',
          undefined, 'CONFLICT',
        );
      }
      return this.txn;
    }
    const txn = new Transaction();
    this.db.acquireWriter(txn);
    this.txn = txn;
    return txn;
  }

  private requireTxn(): Transaction {
    // SELECT 不产生写 intent；显式事务上下文中复用同一事务对象
    return this.txn ?? new Transaction();
  }

  // ---------------------------------------------------------
  // INSERT
  // ---------------------------------------------------------
  private runInsert(stmt: InsertStmt, txn: Transaction, pos: { line: number; column: number }): QueryResult {
    const store = this.db.getTable(stmt.table);
    let count = 0;

    if (stmt.values) {
      const targetCols = this.resolveInsertColumns(stmt, store.def);
      for (const valueList of stmt.values) {
        if (valueList.length !== targetCols.length) {
          throw new SQLError(
            `INSERT has ${valueList.length} values but expected ${targetCols.length}`,
            pos, 'BIND',
          );
        }
        const data: Row = {};
        for (const col of store.def.columns) data[col.name] = null;
        for (let i = 0; i < targetCols.length; i++) {
          data[targetCols[i]] = this.evalScalarValue(valueList[i], pos);
        }
        this.db.insertRow(store, data, txn, true);
        count++;
      }
    } else if (stmt.select) {
      const prepared = this.prepareSelect(stmt.select);
      const { rows } = this.executePlan(prepared);
      const targetCols = this.resolveInsertColumns(stmt, store.def);
      if (prepared.outputs.length !== targetCols.length) {
        throw new SQLError(
          `INSERT SELECT has ${prepared.outputs.length} target columns but expected ${targetCols.length}`,
          pos, 'BIND',
        );
      }
      for (const r of rows) {
        const data: Row = {};
        for (const col of store.def.columns) data[col.name] = null;
        for (let i = 0; i < targetCols.length; i++) {
          data[targetCols[i]] = r[prepared.outputs[i].label] ?? null;
        }
        this.db.insertRow(store, data, txn, true);
        count++;
      }
    }
    return {
      type: 'insert', columns: [], rows: [], rowsAffected: count,
      message: `inserted ${count} row${count === 1 ? '' : 's'}`, pos,
    };
  }

  private resolveInsertColumns(stmt: InsertStmt, def: TableDef): string[] {
    if (stmt.columns) {
      for (const name of stmt.columns) {
        if (!def.columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
          throw new SQLError(`table ${def.name} has no column named ${name}`, undefined, 'BIND');
        }
      }
      return stmt.columns;
    }
    return def.columns.map((c) => c.name);
  }

  private evalScalarValue(expr: Stmt | unknown, pos: { line: number; column: number }): DBValue {
    // VALUES 中只允许常量表达式（可能含 CAST/算术）
    const e = expr as import('../sql/ast').Expr;
    const binder = new Binder(this.db);
    // 无 FROM 的单行绑定
    const id = binder.bindConstantExpr(e);
    const bound = binder.pool.get(id);
    return bound.eval({}, { outers: [], agg: null, sub: null });
  }

  // ---------------------------------------------------------
  // UPDATE / DELETE：先 SELECT 扫描出候选行 + pk
  // ---------------------------------------------------------
  private buildDmlScan(tableName: string, where: import('../sql/ast').Expr | null, pos: { line: number; column: number }) {
    const store = this.db.getTable(tableName);
    // 构造 SELECT * FROM t [WHERE w] 走完整绑定优化流程
    const selectAst: SelectStmt = {
      kind: 'select',
      distinct: false,
      items: [{ expr: { kind: 'star', table: null, pos }, alias: null, pos }],
      from: { kind: 'table', name: tableName, alias: null, pos },
      where,
      groupBy: [], having: null, orderBy: [], limit: null, offset: null, pos,
    };
    const prepared = this.prepareSelect(selectAst);
    const rows = this.executeDmlScan(prepared);
    return { store, rows, alias: store.def.name };
  }

  private runUpdate(stmt: UpdateStmt, txn: Transaction, pos: { line: number; column: number }): QueryResult {
    const { store, rows } = this.buildDmlScan(stmt.table, stmt.where, pos);
    const aliasLower = store.def.name.toLowerCase();
    let count = 0;

    // SET 表达式的作用域只依赖表结构，绑定一次即可，逐行换数据求值。
    // 所有 RHS 均基于“旧行”求值（SQL 标准：多列更新互不可见新值）。
    const preparedSets = stmt.sets.map((s) => {
      const col = store.def.columns.find((c) => c.name.toLowerCase() === s.column.toLowerCase());
      if (!col) throw new SQLError(`no such column: ${s.column}`, s.pos, 'BIND');
      const prepared = this.prepareRowExpr(stmt.table, s.value, pos);
      return { name: col.name, evaluate: prepared };
    });

    for (const srcRow of rows) {
      const pk = String(srcRow[`${aliasLower}.__pk__`]);
      const stored = store.get(pk);
      if (!stored) continue;
      const oldData: Row = { ...stored.data };
      delete oldData.__rowid__;
      const data: Row = { ...oldData };
      for (const sp of preparedSets) {
        data[sp.name] = sp.evaluate(stored.data);
      }
      this.db.updateRow(store, pk, data, txn);
      count++;
    }
    return {
      type: 'update', columns: [], rows: [], rowsAffected: count,
      message: `updated ${count} row${count === 1 ? '' : 's'}`, pos,
    };
  }

  /** 绑定一个相对单表行求值的表达式（UPDATE SET / INSERT…SELECT 中的子查询） */
  private prepareRowExpr(
    tableName: string,
    expr: import('../sql/ast').Expr,
    pos: { line: number; column: number },
  ): (data: Row) => DBValue {
    const binder = new Binder(this.db);
    const selectAst: SelectStmt = {
      kind: 'select',
      distinct: false,
      items: [{ expr, alias: 'v', pos }],
      from: { kind: 'table', name: tableName, alias: null, pos },
      where: null,
      groupBy: [], having: null, orderBy: [], limit: null, offset: null, pos,
    };
    const bound = binder.bindSelect(selectAst);
    const subqueries = new SubqueryRuntime();
    const stats: ExecStats = { rowsScanned: 0, rowsOutput: 0, indexLookups: 0, hashJoinsBuilt: 0, hashJoinRows: 0 };
    const ctx = { db: this.db, txn: this.requireTxn(), pool: binder.pool, stats, subqueries };
    const builder = new PhysicalBuilder(this.db, binder, ctx);
    binder.subqueries.forEach((info) => {
      subqueries.register({
        kind: info.kind, outputs: info.outputs, correlatedDepths: info.correlatedDepths,
        build: () => builder.build(info.plan),
      });
    });
    const frame: ExecFrame = { outers: [], agg: null, sub: subqueries };
    const store = this.db.getTable(tableName);
    const exprId = bound.plan.node === 'project' ? bound.plan.items[0]?.expr : null;
    if (exprId === null || exprId === undefined) {
      throw new SQLError('internal: cannot bind row expression', pos, 'INTERNAL');
    }
    const compiled = binder.pool.get(exprId);
    return (data: Row): DBValue => {
      const row: EvalRow = {};
      for (const c of store.def.columns) {
        row[`${store.def.name.toLowerCase()}.${c.name.toLowerCase()}`] = data[c.name] ?? null;
      }
      subqueries.clearCache();
      return compiled.eval(row, frame);
    };
  }

  private runDelete(stmt: DeleteStmt, txn: Transaction, pos: { line: number; column: number }): QueryResult {
    const { store, rows } = this.buildDmlScan(stmt.table, stmt.where, pos);
    const aliasLower = store.def.name.toLowerCase();
    let count = 0;
    // 先收集 pk 再删除（避免迭代过程中变化）
    const pks = rows.map((r) => String(r[`${aliasLower}.__pk__`]));
    for (const pk of pks) {
      this.db.deleteRow(store, pk, txn);
      count++;
    }
    return {
      type: 'delete', columns: [], rows: [], rowsAffected: count,
      message: `deleted ${count} row${count === 1 ? '' : 's'}`, pos,
    };
  }

  // ---------------------------------------------------------
  // DDL
  // ---------------------------------------------------------
  private runCreateTable(
    stmt: Extract<Stmt, { kind: 'createTable' }>,
    txn: Transaction,
    pos: { line: number; column: number },
  ): QueryResult {
    const def = buildTableDef(stmt.name, stmt.columns, stmt.tablePrimaryKey);
    // autoincrement 必须是 INTEGER 主键
    const autoCol = stmt.columns.find((c) => c.autoincrement);
    if (autoCol && !(autoCol.primaryKey && autoCol.type === 'INTEGER')) {
      throw new SQLError('AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY column', pos, 'BIND');
    }
    const created = this.db.createTable(def, stmt.ifNotExists, txn);
    return {
      type: 'ddl', columns: [], rows: [], rowsAffected: created ? 1 : 0,
      message: created ? `table "${stmt.name}" created` : `table "${stmt.name}" already exists, skipped`, pos,
    };
  }

  private runDropTable(
    stmt: Extract<Stmt, { kind: 'dropTable' }>,
    txn: Transaction,
    pos: { line: number; column: number },
  ): QueryResult {
    const dropped = this.db.dropTable(stmt.name, stmt.ifExists, txn);
    return {
      type: 'ddl', columns: [], rows: [], rowsAffected: dropped ? 1 : 0,
      message: dropped ? `table "${stmt.name}" dropped` : `table "${stmt.name}" does not exist, skipped`, pos,
    };
  }

  private runCreateIndex(
    stmt: Extract<Stmt, { kind: 'createIndex' }>,
    txn: Transaction,
    pos: { line: number; column: number },
  ): QueryResult {
    const created = this.db.createIndex(
      { name: stmt.name, table: stmt.table, column: stmt.column, unique: stmt.unique },
      stmt.ifNotExists, txn,
    );
    return {
      type: 'ddl', columns: [], rows: [], rowsAffected: created ? 1 : 0,
      message: created ? `index "${stmt.name}" created` : `index "${stmt.name}" already exists, skipped`, pos,
    };
  }

  private runDropIndex(
    stmt: Extract<Stmt, { kind: 'dropIndex' }>,
    txn: Transaction,
    pos: { line: number; column: number },
  ): QueryResult {
    const dropped = this.db.dropIndex(stmt.name, stmt.ifExists, txn);
    return {
      type: 'ddl', columns: [], rows: [], rowsAffected: dropped ? 1 : 0,
      message: dropped ? `index "${stmt.name}" dropped` : `index "${stmt.name}" does not exist, skipped`, pos,
    };
  }

  // ---------------------------------------------------------
  // 事务
  // ---------------------------------------------------------
  private async runTxn(op: 'BEGIN' | 'COMMIT' | 'ROLLBACK', pos: { line: number; column: number }): Promise<QueryResult> {
    if (op === 'BEGIN') {
      if (this.txn) throw new SQLError('there is already an active transaction', pos, 'CONFLICT');
      const txn = new Transaction();
      this.db.acquireWriter(txn);
      this.txn = txn;
      return { type: 'txn', columns: [], rows: [], rowsAffected: 0, message: 'transaction started', pos };
    }
    if (op === 'COMMIT') {
      const txn = this.txn;
      if (!txn) throw new SQLError('no transaction is active', pos, 'CONFLICT');
      if (txn.failed) {
        this.db.releaseWriter(txn);
        this.txn = null;
        throw new SQLError('transaction rolled back because of a prior error', pos, 'CONFLICT');
      }
      // commit 失败时内部已回滚并释放写锁
      await this.db.commit(txn);
      this.txn = null;
      return { type: 'txn', columns: [], rows: [], rowsAffected: 0, message: 'transaction committed', pos };
    }
    // ROLLBACK
    const txn = this.txn;
    if (!txn) throw new SQLError('no transaction is active', pos, 'CONFLICT');
    this.db.releaseWriter(txn);
    this.txn = null;
    return { type: 'txn', columns: [], rows: [], rowsAffected: 0, message: 'transaction rolled back', pos };
  }

  // ---------------------------------------------------------
  // EXPLAIN
  // ---------------------------------------------------------
  private async runExplain(inner: Stmt, pos: { line: number; column: number }): Promise<QueryResult> {
    if (inner.kind !== 'select') {
      throw new SQLError('EXPLAIN is only supported for SELECT statements', pos, 'BIND');
    }
    const prepared = this.prepareSelect(inner);
    const { stats } = this.executePlan(prepared);
    const logical = formatLogicalPlan(prepared.plan, prepared.binder, '');
    const physical = formatPhysicalPlan(prepared.plan, prepared.binder, '');
    return {
      type: 'explain',
      columns: [{ name: 'EXPLAIN', type: 'TEXT' }],
      rows: [],
      rowsAffected: 0,
      message: 'execution plan ready',
      plan: {
        logical,
        physical,
        indexes: prepared.optimizer.indexesUsed,
        optimizer: prepared.optimizer,
        stats,
      },
      pos,
    };
  }
}

// ------------------------------------------------------------
// 辅助
// ------------------------------------------------------------
function formatType(t: OutputColumn['type']): string {
  return t;
}

// 逻辑计划文本
export function formatLogicalPlan(plan: LogicalPlan, binder: Binder, indent: string): string {
  const pool = binder.pool;
  const expr = (id: number | null): string => (id === null ? '' : pool.get(id).debug);
  const lines: string[] = [];
  const pad = indent;
  switch (plan.node) {
    case 'scan': {
      const idx = plan.index
        ? `  [INDEX ${plan.index.kind} ${plan.index.indexName}: ${plan.index.detail}]`
        : '  [FULL SCAN]';
      lines.push(`${pad}Scan ${plan.table} AS ${plan.alias}${idx}`);
      break;
    }
    case 'dummy':
      lines.push(`${pad}SingleRow (no FROM)`);
      break;
    case 'filter':
      lines.push(`${pad}Filter: ${expr(plan.predicate)}`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'project':
      lines.push(`${pad}Project: ${plan.items.map((i) => `${expr(i.expr)} AS ${i.label}`).join(', ')}${plan.distinct ? ' DISTINCT' : ''}`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'join':
      lines.push(`${pad}${plan.joinType} JOIN (${plan.impl ?? 'NESTED_LOOP'})${plan.impl === 'HASH' ? ` keys=${plan.hashKeys?.map((k) => `${binder.pool.get(0) ? '' : ''}`).length ?? 0}` : ''}`);
      lines.push(formatLogicalPlan(plan.left, binder, indent + '  '));
      lines.push(formatLogicalPlan(plan.right, binder, indent + '  '));
      if (plan.condition !== null) lines.push(`${pad}  ON ${expr(plan.condition)}`);
      break;
    case 'aggregate':
      lines.push(`${pad}Aggregate: groups=[${plan.groupOutputs.map((g) => expr(g.expr)).join(', ')}] aggs=[${plan.aggregates.map((a) => a.label).join(', ')}]${plan.globalAgg ? ' (global)' : ''}`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'sort':
      lines.push(`${pad}Sort: ${plan.keys.map((k) => `${expr(k.expr)} ${k.desc ? 'DESC' : 'ASC'} NULLS ${k.nullsFirst ? 'FIRST' : 'LAST'}`).join(', ')}`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'limit':
      lines.push(`${pad}Limit ${plan.limit === Number.MAX_SAFE_INTEGER ? 'ALL' : plan.limit} OFFSET ${plan.offset}`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'distinct':
      lines.push(`${pad}Distinct`);
      lines.push(formatLogicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'subquerySource':
      lines.push(`${pad}SubquerySource AS ${plan.alias}`);
      lines.push(formatLogicalPlan(plan.plan, binder, indent + '  '));
      break;
  }
  return lines.join('\n');
}

export function formatPhysicalPlan(plan: LogicalPlan, binder: Binder, indent: string): string {
  const pool = binder.pool;
  const expr = (id: number | null): string => (id === null ? '' : pool.get(id).debug);
  const lines: string[] = [];
  const pad = indent;
  switch (plan.node) {
    case 'scan': {
      if (plan.index) {
        lines.push(`${pad}IndexScan(table=${plan.table}, index=${plan.index.indexName}, ${plan.index.access}, "${plan.index.detail}")`);
      } else {
        lines.push(`${pad}SeqScan(table=${plan.table})`);
      }
      break;
    }
    case 'dummy':
      lines.push(`${pad}ConstScan(1 row)`);
      break;
    case 'filter':
      lines.push(`${pad}Filter(${expr(plan.predicate)})`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'project':
      lines.push(`${pad}Project(${plan.items.map((i) => expr(i.expr)).join(', ')})`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'join':
      if (plan.impl === 'HASH') {
        lines.push(`${pad}HashJoin(${plan.joinType}, on=${(plan.hashKeys ?? []).map((k) => `${astText(k.leftAst)} = ${astText(k.rightAst)}`).join(' AND ')}${((plan.otherConditions ?? []).length) ? ' AND ' + (plan.otherConditions ?? []).map(expr).join(' AND ') : ''})`);
      } else {
        lines.push(`${pad}NestedLoopJoin(${plan.joinType}${plan.condition !== null ? `, ${expr(plan.condition)}` : ', CROSS'})`);
      }
      lines.push(formatPhysicalPlan(plan.left, binder, indent + '  '));
      lines.push(formatPhysicalPlan(plan.right, binder, indent + '  '));
      break;
    case 'aggregate':
      lines.push(`${pad}HashAggregate(groups=${plan.groups.length}, aggs=${plan.aggregates.length})`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'sort':
      lines.push(`${pad}Sort(${plan.keys.map((k) => `${expr(k.expr)} ${k.desc ? 'DESC' : 'ASC'}`).join(', ')})`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'limit':
      lines.push(`${pad}Limit(offset=${plan.offset}, count=${plan.limit === Number.MAX_SAFE_INTEGER ? 'ALL' : plan.limit})`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'distinct':
      lines.push(`${pad}HashDistinct`);
      lines.push(formatPhysicalPlan(plan.input, binder, indent + '  '));
      break;
    case 'subquerySource':
      lines.push(`${pad}SubqueryScan(alias=${plan.alias})`);
      lines.push(formatPhysicalPlan(plan.plan, binder, indent + '  '));
      break;
  }
  return lines.join('\n');
}

function astText(e: import('../sql/ast').Expr): string {
  switch (e.kind) {
    case 'column': return e.table ? `${e.table}.${e.name}` : e.name;
    case 'literal': return e.value === null ? 'NULL' : String(e.value);
    case 'binary': return `(${astText(e.left)} ${e.op} ${astText(e.right)})`;
    default: return e.kind;
  }
}
