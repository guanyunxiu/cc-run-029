// ============================================================
// Database：目录管理 + 事务（单写多读、undo log、乐观版本冲突检测）
// ============================================================

import type {
  ColumnDef, DBValue, DataType, Row, TableDef, IndexDef,
} from '../sql/types';
import { castValue, SQLError } from '../sql/types';
import type { StorageBackend, WriteIntent, StoredRow } from './storage-interface';
import { TableStore } from './table-store';

export type IsolationLevel = 'SNAPSHOT';

interface UndoEntry {
  undo: () => void;
}

export class Transaction {
  intents: WriteIntent[] = [];
  undos: UndoEntry[] = [];
  /** 事务内语句失败后，仅允许 ROLLBACK */
  failed = false;

  push(intent: WriteIntent, undo: () => void): void {
    this.intents.push(intent);
    this.undos.push({ undo });
  }

  rollback(): void {
    // 逆序撤销
    for (let i = this.undos.length - 1; i >= 0; i--) {
      this.undos[i].undo();
    }
    this.undos = [];
    this.intents = [];
    this.failed = false;
  }
}

export interface PrimaryKeyParts {
  pkValue: DBValue;      // 原始值（用于生成物理 pk 字符串）
  pkString: string;
}

export class Database {
  tables = new Map<string, TableStore>();
  version = 0;
  private storage: StorageBackend;
  private writer: Transaction | null = null;

  constructor(storage: StorageBackend) {
    this.storage = storage;
  }

  async init(): Promise<void> {
    const snap = await this.storage.load();
    this.tables.clear();
    for (const name of Object.keys(snap.tables)) {
      const store = new TableStore(snap.tables[name]);
      store.loadRows(snap.rows[name] ?? []);
      store.def.seq = snap.tables[name].seq ?? this.computeInitialSeq(store);
      this.tables.set(name.toLowerCase(), store);
    }
    this.version = snap.version;
  }

  private computeInitialSeq(store: TableStore): number {
    if (!store.def.primaryKey || !store.def.autoincrement) return 1;
    let max = 0;
    const col = store.def.primaryKey;
    for (const r of store.all()) {
      const v = r.data[col];
      if (typeof v === 'number' && v > max) max = v;
    }
    return max + 1;
  }

  getTable(name: string): TableStore {
    const t = this.tables.get(name.toLowerCase());
    if (!t) throw new SQLError(`no such table: ${name}`, undefined, 'BIND');
    return t;
  }

  findTable(name: string): TableStore | undefined {
    return this.tables.get(name.toLowerCase());
  }

  // ---------------------------------------------------------
  // 锁与事务（排队由 Engine 的互斥队列负责）
  // ---------------------------------------------------------
  get activeWriter(): Transaction | null {
    return this.writer;
  }

  acquireWriter(txn: Transaction): void {
    if (this.writer) {
      throw new SQLError('cannot BEGIN: another write transaction is active', undefined, 'CONFLICT');
    }
    this.writer = txn;
  }

  async commit(txn: Transaction): Promise<void> {
    if (this.writer !== txn) throw new SQLError('COMMIT failed: no active transaction', undefined, 'CONFLICT');
    try {
      this.version = await this.storage.commit(txn.intents, this.version);
    } catch (e) {
      // 乐观版本冲突 => 回滚内存状态
      txn.rollback();
      this.writer = null;
      if ((e as { conflict?: boolean }).conflict) {
        throw new SQLError(
          'write conflict: the database was modified by another transaction; transaction rolled back',
          undefined, 'CONFLICT',
        );
      }
      throw e;
    }
    txn.intents = [];
    txn.undos = [];
    this.writer = null;
  }

  releaseWriter(txn: Transaction): void {
    if (this.writer !== txn) throw new SQLError('ROLLBACK failed: no active transaction', undefined, 'CONFLICT');
    txn.rollback();
    this.writer = null;
  }

  // ---------------------------------------------------------
  // DDL
  // ---------------------------------------------------------
  createTable(def: TableDef, ifNotExists: boolean, txn: Transaction): boolean {
    const key = def.name.toLowerCase();
    if (this.tables.has(key)) {
      if (ifNotExists) return false;
      throw new SQLError(`table "${def.name}" already exists`, undefined, 'BIND');
    }
    const store = new TableStore(def);
    this.tables.set(key, store);
    txn.push({ type: 'putTable', table: clone(def) }, () => {
      this.tables.delete(key);
    });
    return true;
  }

  dropTable(name: string, ifExists: boolean, txn: Transaction): boolean {
    const key = name.toLowerCase();
    const store = this.tables.get(key);
    if (!store) {
      if (ifExists) return false;
      throw new SQLError(`no such table: ${name}`, undefined, 'BIND');
    }
    // 保存撤销快照
    const rows = store.all().map((r) => ({ pk: r.pk, data: clone(r.data) }));
    this.tables.delete(key);
    txn.push({ type: 'deleteTable', name: store.def.name }, () => {
      const restored = new TableStore(clone(store.def));
      restored.loadRows(rows);
      this.tables.set(key, restored);
    });
    return true;
  }

  createIndex(idx: IndexDef, ifNotExists: boolean, txn: Transaction): boolean {
    const store = this.getTable(idx.table);
    if (store.def.indexes.some((i) => i.name.toLowerCase() === idx.name.toLowerCase())) {
      if (ifNotExists) return false;
      throw new SQLError(`index "${idx.name}" already exists`, undefined, 'BIND');
    }
    const col = store.def.columns.find((c) => c.name.toLowerCase() === idx.column.toLowerCase());
    if (!col) throw new SQLError(`no such column: ${idx.column}`, undefined, 'BIND');

    // 检查唯一约束并建立索引
    const oldDef = clone(store.def);
    store.def.indexes.push(idx);
    store.rebuildIndexes();
    if (idx.unique) {
      const seen = new Map<string, StoredRow>();
      for (const r of store.all()) {
        const v = r.data[col.name];
        if (v === null) continue;
        const key = `${typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : 's'}:${String(v)}`;
        if (seen.has(key)) {
          store.def.indexes.pop();
          store.def = oldDef;
          store.rebuildIndexes();
          throw new SQLError(
            `UNIQUE constraint failed: index "${idx.name}" has duplicate value ${formatValue(v)}`,
            undefined, 'CONFLICT',
          );
        }
        seen.set(key, r);
      }
    }
    txn.push({ type: 'putTable', table: clone(store.def) }, () => {
      store.def = oldDef;
      store.rebuildIndexes();
    });
    return true;
  }

  dropIndex(name: string, ifExists: boolean, txn: Transaction): boolean {
    for (const store of this.tables.values()) {
      const idx = store.def.indexes.findIndex((i) => i.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0) {
        const oldDef = clone(store.def);
        const removed = store.def.indexes.splice(idx, 1)[0];
        store.rebuildIndexes();
        txn.push({ type: 'putTable', table: clone(store.def) }, () => {
          store.def = oldDef;
          store.rebuildIndexes();
        });
        void removed;
        return true;
      }
    }
    if (ifExists) return false;
    throw new SQLError(`no such index: ${name}`, undefined, 'BIND');
  }

  // ---------------------------------------------------------
  // DML（由执行器调用，直接改内存并记录 undo + intent）
  // ---------------------------------------------------------
  physicalPk(store: TableStore, data: Row, providedPk: DBValue | undefined): string {
    const def = store.def;
    if (def.primaryKey) {
      const v = providedPk !== undefined ? providedPk : data[def.primaryKey];
      if (v === null || v === undefined) {
        if (def.autoincrement) {
          const next = def.seq++;
          data[def.primaryKey] = next;
          return `k:${String(next)}`;
        }
        throw new SQLError(`NOT NULL constraint failed: ${def.name}.${def.primaryKey}`, undefined, 'CONFLICT');
      }
      // 显式给出 AUTOINCREMENT 主键时，推进序列避免后续冲突
      if (def.autoincrement && typeof v === 'number' && v >= def.seq) {
        def.seq = Math.trunc(v) + 1;
      }
      return `k:${pkString(v)}`;
    }
    // 隐藏 rowid
    const next = def.seq++;
    data.__rowid__ = next;
    return `r:${next}`;
  }

  insertRow(store: TableStore, data: Row, txn: Transaction, castColumns: boolean): void {
    // 先做类型转换（缺失列补 null），再让 AUTOINCREMENT 生成主键，最后做 NOT NULL 校验
    const def0 = store.def;
    const wantsAuto = def0.primaryKey !== null &&
      (data[def0.primaryKey] === undefined || data[def0.primaryKey] === null) &&
      def0.autoincrement;

    this.coerceAndValidate(store, data, castColumns, wantsAuto ? def0.primaryKey : null);
    let pkValue: DBValue | undefined;
    if (store.def.primaryKey) pkValue = data[store.def.primaryKey] ?? null;
    const seqBefore = store.def.seq;
    const pk = this.physicalPk(store, data, pkValue ?? undefined);
    const seqChanged = store.def.seq !== seqBefore;

    if (store.get(pk)) {
      throw new SQLError(
        `UNIQUE constraint failed: ${store.def.name}.${store.def.primaryKey ?? 'rowid'} = ${formatValue(pkValue ?? pk)}`,
        undefined, 'CONFLICT',
      );
    }
    // 二级唯一索引检查
    for (const idx of store.def.indexes) {
      if (!idx.unique) continue;
      const conflict = store.findUniqueConflict(idx.column, data[idx.column] ?? null, null);
      if (conflict) {
        throw new SQLError(
          `UNIQUE constraint failed: ${store.def.name}.${idx.column} = ${formatValue(data[idx.column] ?? null)}`,
          undefined, 'CONFLICT',
        );
      }
    }
    store.insert(pk, data);
    txn.push({ type: 'putRow', table: store.def.name, pk, data: clone(data) }, () => {
      store.delete(pk);
    });
    // AUTOINCREMENT / 隐式 rowid 序列推进需要持久化到 catalog
    if (seqChanged) {
      const defSnapshot = clone(store.def); // 已含新 seq
      txn.push({ type: 'putTable', table: defSnapshot }, () => { store.def.seq = seqBefore; });
    }
  }

  deleteRow(store: TableStore, pk: string, txn: Transaction): void {
    const existing = store.get(pk);
    if (!existing) return;
    const snapshot = clone(existing.data);
    store.delete(pk);
    txn.push({ type: 'deleteRow', table: store.def.name, pk }, () => {
      store.insert(pk, snapshot);
    });
  }

  updateRow(store: TableStore, pk: string, newData: Row, txn: Transaction): void {
    const existing = store.get(pk);
    if (!existing) return;
    const snapshot = clone(existing.data);
    this.coerceAndValidate(store, newData, true);
    // 主键变更：检查新主键冲突
    if (store.def.primaryKey) {
      const newPk = `k:${pkString(newData[store.def.primaryKey] ?? null)}`;
      if (newPk !== pk && store.get(newPk)) {
        throw new SQLError(
          `UNIQUE constraint failed: ${store.def.name}.${store.def.primaryKey}`,
          undefined, 'CONFLICT',
        );
      }
    }
    // 二级唯一索引检查
    for (const idx of store.def.indexes) {
      if (!idx.unique) continue;
      const conflict = store.findUniqueConflict(idx.column, newData[idx.column] ?? null, pk);
      if (conflict) {
        throw new SQLError(
          `UNIQUE constraint failed: ${store.def.name}.${idx.column} = ${formatValue(newData[idx.column] ?? null)}`,
          undefined, 'CONFLICT',
        );
      }
    }
    if (store.def.primaryKey) {
      const newPk = `k:${pkString(newData[store.def.primaryKey] ?? null)}`;
      if (newPk !== pk) {
        store.delete(pk);
        store.insert(newPk, newData);
        txn.push({ type: 'deleteRow', table: store.def.name, pk }, () => {});
        txn.push({ type: 'putRow', table: store.def.name, pk: newPk, data: clone(newData) }, () => {});
        // undo 整组（逆序执行时）
        txn.undos[txn.undos.length - 1].undo = () => { store.delete(newPk); };
        txn.undos[txn.undos.length - 2].undo = () => { store.insert(pk, snapshot); };
      } else {
        store.replace(pk, newData);
        txn.push({ type: 'putRow', table: store.def.name, pk, data: clone(newData) }, () => {
          store.replace(pk, snapshot);
        });
      }
    } else {
      // 保留隐藏 rowid
      newData.__rowid__ = snapshot.__rowid__;
      const next = pk;
      store.replace(next, newData);
      txn.push({ type: 'putRow', table: store.def.name, pk, data: clone(newData) }, () => {
        store.replace(pk, snapshot);
      });
    }
  }

  /** 类型转换 + NOT NULL 校验；删除多余字段，补齐缺失列为 null */
  private coerceAndValidate(
    store: TableStore,
    data: Row,
    cast: boolean,
    skipNullCheckColumn: string | null = null,
  ): void {
    const def = store.def;
    const out: Row = {};
    for (const col of def.columns) {
      let v = data[col.name];
      if (v === undefined) v = null;
      if (cast) {
        try {
          v = castValue(v, col.type);
        } catch (e) {
          if (e instanceof SQLError) {
            throw new SQLError(`${e.message} (column ${def.name}.${col.name})`, undefined, 'TYPE');
          }
          throw e;
        }
      } else if (v !== null) {
        this.assertType(v, col.type, def.name, col.name);
      }
      if (v === null && !col.nullable && col.name !== skipNullCheckColumn) {
        throw new SQLError(`NOT NULL constraint failed: ${def.name}.${col.name}`, undefined, 'CONFLICT');
      }
      out[col.name] = v;
    }
    // 清空 data 后回填（去掉未知列）
    for (const k of Object.keys(data)) delete data[k];
    Object.assign(data, out);
  }

  private assertType(v: DBValue, type: DataType, table: string, col: string): void {
    if (v === null) return;
    const t = typeof v;
    const ok =
      (type === 'INTEGER' && t === 'number' && Number.isInteger(v)) ||
      (type === 'REAL' && t === 'number') ||
      (type === 'TEXT' && t === 'string') ||
      (type === 'BOOLEAN' && t === 'boolean');
    if (!ok) {
      throw new SQLError(
        `type mismatch: column ${table}.${col} expects ${type} but got ${t === 'number' ? (Number.isInteger(v) ? 'INTEGER' : 'REAL') : t.toUpperCase()}`,
        undefined, 'TYPE',
      );
    }
  }

  // ---------------------------------------------------------
  // 工具
  // ---------------------------------------------------------
  snapshotTables(): { name: string; def: TableDef; rows: { pk: string; data: Row }[] }[] {
    return [...this.tables.values()].map((s) => ({
      name: s.def.name,
      def: clone(s.def),
      rows: s.all().map((r) => ({ pk: r.pk, data: clone(r.data) })),
    }));
  }

  async resetStorage(): Promise<void> {
    await this.storage.reset();
    this.tables.clear();
    this.version = 0;
  }
}

// ------------------------------------------------------------
// 建表定义构造
// ------------------------------------------------------------
export function buildTableDef(
  name: string,
  raw: {
    name: string;
    type: DataType;
    primaryKey: boolean;
    autoincrement: boolean;
    notNull: boolean;
    unique: boolean;
  }[],
  tablePrimaryKey: string[] | null,
): TableDef {
  const columns: ColumnDef[] = raw.map((c, i) => ({
    name: c.name,
    type: c.type,
    nullable: !c.notNull && !c.primaryKey && !(tablePrimaryKey?.includes(c.name) ?? false),
    primaryKey: c.primaryKey || (tablePrimaryKey?.includes(c.name) ?? false),
    ordinal: i,
  }));
  let primaryKey: string | null = null;
  let autoincrement = false;
  const pkCol = columns.find((c) => c.primaryKey);
  if (pkCol) {
    primaryKey = pkCol.name;
    autoincrement = raw.find((c) => c.name === pkCol.name)?.autoincrement ?? false;
    pkCol.nullable = false;
  }
  return {
    name,
    columns,
    indexes: raw
      .filter((c) => c.unique && !c.primaryKey)
      .map((c) => ({ name: `__auto_${name}_${c.name}`, table: name, column: c.name, unique: true })),
    primaryKey,
    autoincrement,
    seq: 1,
  };
}

// ------------------------------------------------------------
// 辅助
// ------------------------------------------------------------
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function pkString(v: DBValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'b1' : 'b0';
  if (typeof v === 'number') return Number.isInteger(v) ? `i${v}` : `r${v}`;
  return `s${v}`;
}

function formatValue(v: DBValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return `'${v}'`;
  return String(v);
}
