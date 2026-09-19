// SQL 引擎会话：解析 → 计划 → 执行；管理用户事务与自动提交
import { SqlError, SqlValue, TableDef, QueryResult, Row } from '../sql/types';
import { Parser } from '../sql/parser';
import * as AST from '../sql/ast';
import { Statement } from '../sql/ast';
import { Storage, TxnContext, pkColumnName } from './storage';
import { Planner } from './planner';
import { Binder, ExecContext, evalExpr } from './executor';
import { castValue, isTrue } from './value';

export interface ExecuteOptions {
  explain?: boolean;
}

const parser = new Parser();

export class Session {
  private planner: Planner;
  private userTxn: TxnContext | null = null;

  constructor(public storage: Storage) {
    this.planner = new Planner(storage);
  }

  async execute(sql: string, opts: ExecuteOptions = {}): Promise<QueryResult[]> {
    const stmts = parser.parse(sql);
    const results: QueryResult[] = [];
    for (const stmt of stmts) {
      results.push(await this.executeStmt(stmt, opts.explain ?? false));
    }
    return results;
  }

  async explain(sql: string): Promise<QueryResult[]> {
    return this.execute(sql, { explain: true });
  }

  // ---------- 目录与导入导出辅助 ----------
  async listTables(): Promise<TableDef[]> {
    const catalog = await this.storage.getCatalog();
    return Object.values(catalog.tables);
  }

  async getTableDef(name: string): Promise<TableDef | undefined> {
    return (await this.storage.getCatalog()).tables[name];
  }

  /** 读取表全部数据行（仅数据列，按 __id 升序） */
  async getTableRows(name: string): Promise<Row[]> {
    const def = await this.requireTable(name);
    const txn = await this.storage.begin(true);
    try {
      const stored = await this.storage.scan(txn, name, {});
      await this.storage.commit(txn);
      return stored.map((r) => {
        const row: Row = {};
        for (const c of def.columns) row[c.name] = r[c.name] ?? null;
        return row;
      });
    } catch (e) {
      await this.storage.rollback(txn).catch(() => {});
      throw e;
    }
  }

  /** 批量插入原始行（单个自动提交事务） */
  async bulkInsert(table: string, rows: Row[]): Promise<number> {
    if (rows.length === 0) return 0;
    const res = await this.withWriteTxn(async (txn) => {
      return this.storage.applyMutations(txn, table, { insert: rows });
    });
    return res.inserted.length;
  }

  /** 直接创建带数据的表（用于 JSON 导入；def.indexes 已包含全部索引） */
  async importTable(def: TableDef, rows: Row[]): Promise<void> {
    const catalog = await this.storage.getCatalog();
    if (catalog.tables[def.name]) throw new SqlError(`表 ${def.name} 已存在`);
    await this.storage.createTable(def);
    if (rows.length > 0) await this.bulkInsert(def.name, rows);
  }

  private async executeStmt(stmt: Statement, explain: boolean): Promise<QueryResult> {
    switch (stmt.kind) {
      case 'txn':
        return this.txn(stmt.action);
      case 'createTable':
        return this.ddl(() => this.createTable(stmt), explain);
      case 'dropTable':
        return this.ddl(() => this.dropTable(stmt), explain);
      case 'createIndex':
        return this.ddl(() => this.createIndex(stmt), explain);
      case 'dropIndex':
        return this.ddl(() => this.dropIndex(stmt), explain);
      case 'insert':
      case 'update':
      case 'delete':
        return this.dml(stmt, explain);
      case 'select':
        return this.query(stmt, explain);
      case 'explain': {
        // EXPLAIN 包裹：内层语句以 explain 模式执行（只给计划不真正执行 SELECT）
        if (stmt.inner.kind === 'select') {
          return this.query(stmt.inner, true);
        }
        // DML 的 EXPLAIN：先构建计划再执行（简化：返回影响行数 + 空计划提示）
        return this.executeStmt(stmt.inner, false);
      }
    }
  }

  // ---------- 事务 ----------
  private async txn(action: 'BEGIN' | 'COMMIT' | 'ROLLBACK'): Promise<QueryResult> {
    if (action === 'BEGIN') {
      if (this.userTxn) throw new SqlError('已有事务进行中，请先 COMMIT 或 ROLLBACK');
      this.userTxn = await this.storage.begin(false);
      return messageResult('事务已开始（BEGIN）');
    }
    if (!this.userTxn) throw new SqlError(`没有正在进行的事务，无法 ${action}`);
    const txn = this.userTxn;
    this.userTxn = null;
    if (action === 'COMMIT') {
      await this.storage.commit(txn);
      return messageResult('事务已提交（COMMIT）');
    }
    await this.storage.rollback(txn);
    return messageResult('事务已回滚（ROLLBACK）');
  }

  private async withWriteTxn<T>(fn: (txn: TxnContext) => Promise<T>): Promise<T> {
    const ownTxn = !this.userTxn;
    const txn = this.userTxn ?? (await this.storage.begin(false));
    try {
      const result = await fn(txn);
      if (ownTxn) await this.storage.commit(txn);
      return result;
    } catch (e) {
      if (ownTxn) await this.storage.rollback(txn).catch(() => {});
      throw e;
    }
  }

  private async ddl(fn: () => Promise<{ message: string }>, explain: boolean): Promise<QueryResult> {
    void explain;
    if (this.userTxn) throw new SqlError('显式事务中不允许执行 DDL（CREATE/DROP），请先提交事务');
    const { message } = await fn();
    return messageResult(message);
  }

  // ---------- DDL ----------
  private async createTable(stmt: AST.CreateTableStmt): Promise<{ message: string }> {
    const catalog = await this.storage.getCatalog();
    if (catalog.tables[stmt.name]) {
      if (stmt.ifNotExists) return { message: `表 ${stmt.name} 已存在，跳过创建` };
      throw new SqlError(`表 ${stmt.name} 已存在`);
    }
    const pkCount = stmt.columns.filter((c) => c.primaryKey).length;
    if (pkCount > 1) throw new SqlError('本引擎只支持单列主键');
    const def: TableDef = {
      name: stmt.name,
      columns: stmt.columns.map((c) => ({
        name: c.name,
        type: c.type,
        primaryKey: c.primaryKey,
        nullable: c.nullable,
        default: c.default,
      })),
      indexes: [],
    };
    const pk = stmt.columns.find((c) => c.primaryKey);
    await this.storage.createTable(def);
    if (pk) {
      await this.storage.createIndex({
        name: `idx_${stmt.name}_pk_${pk.name}`,
        table: stmt.name,
        column: pk.name,
        unique: true,
      });
    }
    for (const c of stmt.columns) {
      if (c.unique && !c.primaryKey) {
        await this.storage.createIndex({
          name: `idx_${stmt.name}_uq_${c.name}`,
          table: stmt.name,
          column: c.name,
          unique: true,
        });
      }
    }
    return { message: `表 ${stmt.name} 创建成功` };
  }

  private async dropTable(stmt: AST.DropTableStmt): Promise<{ message: string }> {
    const catalog = await this.storage.getCatalog();
    if (!catalog.tables[stmt.name]) {
      if (stmt.ifExists) return { message: `表 ${stmt.name} 不存在，跳过删除` };
      throw new SqlError(`表 ${stmt.name} 不存在`);
    }
    await this.storage.dropTable(stmt.name);
    return { message: `表 ${stmt.name} 已删除` };
  }

  private async createIndex(stmt: AST.CreateIndexStmt): Promise<{ message: string }> {
    const catalog = await this.storage.getCatalog();
    const t = catalog.tables[stmt.table];
    if (!t) throw new SqlError(`表 ${stmt.table} 不存在`);
    if (t.indexes.some((i) => i.name === stmt.name)) {
      if (stmt.ifNotExists) return { message: `索引 ${stmt.name} 已存在，跳过` };
      throw new SqlError(`索引 ${stmt.name} 已存在`);
    }
    await this.storage.createIndex({
      name: stmt.name,
      table: stmt.table,
      column: stmt.column,
      unique: stmt.unique,
    });
    return { message: `${stmt.unique ? '唯一' : ''}索引 ${stmt.name} 创建成功` };
  }

  private async dropIndex(stmt: AST.DropIndexStmt): Promise<{ message: string }> {
    const catalog = await this.storage.getCatalog();
    for (const [tableName, t] of Object.entries(catalog.tables)) {
      if (t.indexes.some((i) => i.name === stmt.name)) {
        await this.storage.dropIndex(tableName, stmt.name);
        return { message: `索引 ${stmt.name} 已删除` };
      }
    }
    if (stmt.ifExists) return { message: `索引 ${stmt.name} 不存在，跳过` };
    throw new SqlError(`索引 ${stmt.name} 不存在`);
  }

  // ---------- DML ----------
  private async dml(
    stmt: AST.InsertStmt | AST.UpdateStmt | AST.DeleteStmt,
    explain: boolean,
  ): Promise<QueryResult> {
    void explain;
    return this.withWriteTxn(async (txn) => {
      switch (stmt.kind) {
        case 'insert':
          return this.insert(txn, stmt);
        case 'update':
          return this.update(txn, stmt);
        case 'delete':
          return this.remove(txn, stmt);
      }
    });
  }

  private async insert(txn: TxnContext, stmt: AST.InsertStmt): Promise<QueryResult> {
    const def = await this.requireTable(stmt.table);
    const rows: Row[] = stmt.values.map((rawRow) => {
      const row: Row = {};
      if (stmt.columns) {
        if (stmt.columns.length !== rawRow.length) {
          throw new SqlError(
            `INSERT 列数(${stmt.columns.length})与值数(${rawRow.length})不匹配`,
          );
        }
        stmt.columns.forEach((c, i) => (row[c] = rawRow[i]));
      } else {
        if (rawRow.length !== def.columns.length) {
          throw new SqlError(
            `INSERT 值数(${rawRow.length})与表 ${stmt.table} 列数(${def.columns.length})不匹配`,
          );
        }
        def.columns.forEach((c, i) => (row[c.name] = rawRow[i]));
      }
      return row;
    });
    const res = await this.storage.applyMutations(txn, stmt.table, { insert: rows });
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: res.inserted.length,
      message: `插入 ${res.inserted.length} 行`,
    };
  }

  private async update(txn: TxnContext, stmt: AST.UpdateStmt): Promise<QueryResult> {
    const def = await this.requireTable(stmt.table);
    const binder = new Binder();
    const source = binder.sourceForTable(def);
    const scope = { sources: [source] };
    // 先扫描（读已写数据，支持同事务内更新）
    const stored = await txnSafeScan(this.storage, txn, stmt.table);
    const candidates: { id: number; row: Row }[] = [];
    const boundSets = stmt.sets.map((s) => ({
      column: s.column,
      expr: binder.bindExpr(s.expr, scope),
    }));
    const boundWhere = stmt.where ? binder.bindExpr(stmt.where, scope) : undefined;
    const ctx: ExecContext = { txn, storage: this.storage };
    for (const r of stored) {
      const row: Row = {};
      for (const c of def.columns) row[c.name] = r[c.name] ?? null;
      const env = { row: { [source.alias]: row } };
      if (boundWhere && !isTrue(await evalExpr(boundWhere, env, ctx))) continue;
      const next: Row = {};
      for (const s of boundSets) {
        if (!def.columns.some((c) => c.name === s.column)) {
          throw new SqlError(`列 ${s.column} 不存在`);
        }
        const colDef = def.columns.find((c) => c.name === s.column)!;
        const v = await evalExpr(s.expr, env, ctx);
        next[s.column] = v === null ? null : castValue(v, colDef.type);
      }
      candidates.push({ id: r.__id, row: next });
    }
    const res = await this.storage.applyMutations(txn, stmt.table, { update: candidates });
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: res.updated.length,
      message: `更新 ${res.updated.length} 行`,
    };
  }

  private async remove(txn: TxnContext, stmt: AST.DeleteStmt): Promise<QueryResult> {
    const def = await this.requireTable(stmt.table);
    const stored = await txnSafeScan(this.storage, txn, stmt.table);
    let ids: number[];
    if (!stmt.where) {
      ids = stored.map((r) => r.__id);
    } else {
      const binder = new Binder();
      const source = binder.sourceForTable(def);
      const scope = { sources: [source] };
      const bound = binder.bindExpr(stmt.where, scope);
      const ctx: ExecContext = { txn, storage: this.storage };
      ids = [];
      for (const r of stored) {
        const row: Row = {};
        for (const c of def.columns) row[c.name] = r[c.name] ?? null;
        if (isTrue(await evalExpr(bound, { row: { [source.alias]: row } }, ctx))) ids.push(r.__id);
      }
    }
    const res = await this.storage.applyMutations(txn, stmt.table, { delete: ids });
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: res.deleted.length,
      message: `删除 ${res.deleted.length} 行`,
    };
  }

  private async requireTable(name: string): Promise<TableDef> {
    const catalog = await this.storage.getCatalog();
    const def = catalog.tables[name];
    if (!def) throw new SqlError(`表 ${name} 不存在`);
    return def;
  }

  // ---------- SELECT ----------
  private async query(stmt: AST.SelectStmt, explain: boolean): Promise<QueryResult> {
    const ownTxn = !this.userTxn;
    const txn = this.userTxn ?? (await this.storage.begin(true));
    try {
      const plan = await this.planner.planSelect(stmt);
      const planJSON = plan.root.toJSON();
      if (explain) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          plan: planJSON,
          message: '执行计划（未实际执行）',
        };
      }
      const ctx: ExecContext = { txn, storage: this.storage };
      const outRows: SqlValue[][] = [];
      const cols = plan.outputColumns.map((c) => c.name);
      while (true) {
        const row = await plan.root.next(ctx);
        if (!row) break;
        outRows.push(cols.map((c) => (row[c] === undefined ? null : (row[c] as SqlValue))));
      }
      const withCounts = plan.root.toJSON();
      if (ownTxn) await this.storage.commit(txn);
      return {
        columns: plan.outputColumns,
        rows: outRows,
        rowCount: outRows.length,
        plan: withCounts,
      };
    } catch (e) {
      if (ownTxn) await this.storage.rollback(txn).catch(() => {});
      throw e;
    }
  }
}

async function txnSafeScan(storage: Storage, txn: TxnContext, table: string) {
  return storage.scan(txn, table, {});
}

function messageResult(message: string): QueryResult {
  return { columns: [], rows: [], rowCount: 0, affectedRows: 0, message };
}

export { pkColumnName };
