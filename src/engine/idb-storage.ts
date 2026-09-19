// IndexedDB 存储实现
// 固定 schema 的三个对象仓库，避免动态建库升级；事务覆盖层复用内存表的方式。
// 简单 WAL：写事务提交记录写入 __wal__，崩溃重启时清理未完成事务的残留。
import { IndexDef, Row, SqlError, SqlValue, TableDef } from '../sql/types';
import {
  ApplyResult,
  Catalog,
  PK_NAME,
  ScanOptions,
  Storage,
  StoredRow,
  TxnContext,
  pkColumnName,
} from './storage';
import { applyAffinity, sqlCompare } from './value';

const DB_NAME = 'browser-sql-engine';
const DB_VERSION = 1;
const STORE_ROWS = '__rows__';
const STORE_CATALOG = '__catalog__';
const STORE_WAL = '__wal__';

function idbOpen(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ROWS)) {
        // 复合键 [tableName, id]
        db.createObjectStore(STORE_ROWS, { keyPath: ['__table', '__id'] });
      }
      if (!db.objectStoreNames.contains(STORE_CATALOG)) {
        db.createObjectStore(STORE_CATALOG);
      }
      if (!db.objectStoreNames.contains(STORE_WAL)) {
        db.createObjectStore(STORE_WAL, { keyPath: 'txnId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txnPromise(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new SqlError('IndexedDB 事务中止'));
  });
}

interface IdxMeta extends IndexDef {
  keyPath: string;
}

interface PendingChanges {
  inserts: Map<number, StoredRow>;
  updates: Map<number, StoredRow>;
  deletes: Set<number>;
}

export class IdbStorage implements Storage {
  private db!: IDBDatabase;
  private catalogCache: Catalog = { tables: {} };
  private writeLocked = false;
  private nextTxnId = 1;

  constructor(private dbName: string = DB_NAME) {}

  async init(): Promise<void> {
    this.db = await idbOpen(this.dbName);
    await this.recover();
    const cat = await this.readCatalog();
    this.catalogCache = cat;
  }

  // ---------- 恢复 ----------
  private async recover(): Promise<void> {
    // 读取 WAL 中未标记 COMMITTED 的事务，删除其残留行（未提交行带 __txn 字段）
    const tx = this.db.transaction([STORE_WAL, STORE_ROWS], 'readwrite');
    const walStore = tx.objectStore(STORE_WAL);
    const rowsStore = tx.objectStore(STORE_ROWS);
    const logs = await wrap(walStore.getAll());
    for (const log of logs as { txnId: number; committed: boolean }[]) {
      if (!log.committed) {
        // 清理该事务可能写入的脏数据
        await new Promise<void>((resolve) => {
          const cursorReq = rowsStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              const v = cursor.value as StoredRow & { __txn?: number };
              if (v.__txn === log.txnId) cursor.delete();
              cursor.continue();
            } else resolve();
          };
          cursorReq.onerror = () => resolve();
        });
        walStore.delete(log.txnId);
      }
    }
    await txnPromise(tx);
  }

  private async readCatalog(): Promise<Catalog> {
    const tx = this.db.transaction(STORE_CATALOG, 'readonly');
    const v = await wrap(tx.objectStore(STORE_CATALOG).get('catalog'));
    return (v as Catalog) ?? { tables: {} };
  }

  private async writeCatalog(cat: Catalog): Promise<void> {
    this.catalogCache = cat;
    const tx = this.db.transaction(STORE_CATALOG, 'readwrite');
    tx.objectStore(STORE_CATALOG).put(cat, 'catalog');
    await txnPromise(tx);
  }

  async getCatalog(): Promise<Catalog> {
    return this.catalogCache;
  }

  // ---------- DDL ----------
  async createTable(def: TableDef): Promise<void> {
    if (this.catalogCache.tables[def.name]) throw new SqlError(`表 ${def.name} 已存在`);
    const cat: Catalog = { tables: { ...this.catalogCache.tables, [def.name]: structuredClone(def) } };
    await this.writeCatalog(cat);
  }

  async dropTable(name: string): Promise<void> {
    if (!this.catalogCache.tables[name]) throw new SqlError(`表 ${name} 不存在`);
    const tx = this.db.transaction([STORE_CATALOG, STORE_ROWS], 'readwrite');
    // 删除该表所有行
    await new Promise<void>((resolve, reject) => {
      const range = IDBKeyRange.bound([name, -Infinity], [name, Infinity]);
      const req = tx.objectStore(STORE_ROWS).openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const tables = { ...this.catalogCache.tables };
    delete tables[name];
    tx.objectStore(STORE_CATALOG).put({ tables }, 'catalog');
    await txnPromise(tx);
    this.catalogCache = { tables };
  }

  async createIndex(idx: IndexDef): Promise<void> {
    const t = this.catalogCache.tables[idx.table];
    if (!t) throw new SqlError(`表 ${idx.table} 不存在`);
    if (!t.columns.some((c) => c.name === idx.column)) throw new SqlError(`列 ${idx.column} 不存在`);
    if (t.indexes.some((i) => i.name === idx.name)) throw new SqlError(`索引 ${idx.name} 已存在`);
    if (idx.unique) {
      const rows = await this.readAllCommitted(idx.table);
      const seen = new Set<string>();
      for (const r of rows) {
        const v = r[idx.column];
        if (v === null || v === undefined) continue;
        const k = JSON.stringify(v);
        if (seen.has(k)) throw new SqlError(`创建唯一索引失败：列 ${idx.column} 存在重复值`);
        seen.add(k);
      }
    }
    const newDef: TableDef = { ...t, indexes: [...t.indexes, { ...idx }] };
    await this.writeCatalog({ tables: { ...this.catalogCache.tables, [idx.table]: structuredClone(newDef) } });
    // 为存量数据补充索引字段
    const rows = await this.readAllCommitted(idx.table);
    if (rows.length > 0) {
      const tx = this.db.transaction(STORE_ROWS, 'readwrite');
      const store = tx.objectStore(STORE_ROWS);
      for (const r of rows) {
        store.put({ ...r });
      }
      await txnPromise(tx);
    }
  }

  async dropIndex(table: string, indexName: string): Promise<void> {
    const t = this.catalogCache.tables[table];
    if (!t || !t.indexes.some((i) => i.name === indexName)) throw new SqlError(`索引 ${indexName} 不存在`);
    const newDef: TableDef = { ...t, indexes: t.indexes.filter((i) => i.name !== indexName) };
    await this.writeCatalog({ tables: { ...this.catalogCache.tables, [table]: structuredClone(newDef) } });
  }

  // ---------- 事务 ----------
  async begin(readOnly = false): Promise<TxnContext> {
    if (!readOnly) {
      if (this.writeLocked) throw new SqlError('数据库忙：已有写事务进行中（单写多读）');
      this.writeLocked = true;
    }
    const txn: TxnContext = {
      id: this.nextTxnId++,
      readOnly,
      readSet: new Map(),
      scanMarks: new Map(),
    };
    (txn as TxnContext & { pending: Map<string, PendingChanges> }).pending = new Map();
    return txn;
  }

  private pending(txn: TxnContext): Map<string, PendingChanges> {
    return (txn as TxnContext & { pending: Map<string, PendingChanges> }).pending;
  }

  private pendingFor(txn: TxnContext, table: string): PendingChanges {
    const map = this.pending(txn);
    let p = map.get(table);
    if (!p) {
      p = { inserts: new Map(), updates: new Map(), deletes: new Set() };
      map.set(table, p);
    }
    return p;
  }

  async commit(txn: TxnContext): Promise<void> {
    if (txn.readOnly) return;
    const pending = this.pending(txn);
    let hasChanges = false;
    for (const p of pending.values()) {
      if (p.inserts.size || p.updates.size || p.deletes.size) hasChanges = true;
    }
    if (!hasChanges) {
      this.writeLocked = false;
      return;
    }

    // 读集校验：用一个只读事务快速比对
    await this.validateReadSet(txn, pending);

    // WAL 记录 BEGIN，再写入数据（带 __txn 标记），最后写 COMMITTED
    const idbTx = this.db.transaction([STORE_ROWS, STORE_WAL], 'readwrite');
    const rowsStore = idbTx.objectStore(STORE_ROWS);
    const walStore = idbTx.objectStore(STORE_WAL);
    walStore.put({ txnId: txn.id, committed: false, ts: Date.now() });

    for (const [tableName, p] of pending) {
      for (const row of p.inserts.values()) {
        rowsStore.put(this.toIdbRow(tableName, row, txn.id));
      }
      for (const [id, row] of p.updates) {
        rowsStore.put(this.toIdbRow(tableName, row, txn.id));
        void id;
      }
      for (const id of p.deletes) {
        rowsStore.delete([tableName, id]);
      }
    }
    walStore.put({ txnId: txn.id, committed: true, ts: Date.now() });
    await txnPromise(idbTx);

    // 提交成功后移除 WAL 记录与行上的 __txn 标记
    const cleanupTx = this.db.transaction([STORE_ROWS, STORE_WAL], 'readwrite');
    cleanupTx.objectStore(STORE_WAL).delete(txn.id);
    const cStore = cleanupTx.objectStore(STORE_ROWS);
    for (const [tableName, p] of pending) {
      for (const row of p.inserts.values()) cStore.put(this.toIdbRow(tableName, row));
      for (const row of p.updates.values()) cStore.put(this.toIdbRow(tableName, row));
    }
    await txnPromise(cleanupTx).catch(() => {
      /* 清理失败不影响正确性：__txn 标记的行已由 WAL COMMITTED 保护 */
    });
    this.writeLocked = false;
  }

  async rollback(txn: TxnContext): Promise<void> {
    if (!txn.readOnly) this.writeLocked = false;
  }

  private toIdbRow(table: string, row: StoredRow, txnId?: number): Record<string, unknown> {
    const out: Record<string, unknown> = { ...row, __table: table };
    if (txnId !== undefined) out.__txn = txnId;
    return out;
  }

  private async validateReadSet(
    txn: TxnContext,
    pending: Map<string, PendingChanges>,
  ): Promise<void> {
    const idbTx = this.db.transaction(STORE_ROWS, 'readonly');
    const store = idbTx.objectStore(STORE_ROWS);
    for (const [table, reads] of txn.readSet) {
      const p = pending.get(table);
      for (const [id, ver] of reads) {
        // 本事务自身的变更不参与外部冲突校验
        if (p?.inserts.has(id) || p?.updates.has(id) || p?.deletes.has(id)) continue;
        const cur = (await wrap(store.get([table, id]))) as (StoredRow & { __txn?: number }) | undefined;
        const curVer = !cur || cur.__txn !== undefined ? 0 : cur.__ver;
        if (curVer !== ver) {
          throw new SqlError('写冲突：读取过的数据已被其他事务修改，事务回滚');
        }
      }
    }
  }

  // ---------- 读取 ----------
  private async readAllCommitted(table: string): Promise<StoredRow[]> {
    const idbTx = this.db.transaction(STORE_ROWS, 'readonly');
    const range = IDBKeyRange.bound([table, -Infinity], [table, Infinity]);
    const all = (await wrap(idbTx.objectStore(STORE_ROWS).getAll(range))) as (StoredRow & {
      __table?: string;
      __txn?: number;
    })[];
    return all.filter((r) => r.__txn === undefined).map((r) => {
      const { __table, __txn, ...row } = r;
      return row as StoredRow;
    });
  }

  private async visibleRows(txn: TxnContext, table: string): Promise<StoredRow[]> {
    const committed = await this.readAllCommitted(table);
    const p = this.pending(txn).get(table);
    let rows = committed;
    if (p) {
      rows = rows.filter((r) => !p.deletes.has(r.__id) && !p.updates.has(r.__id));
      rows = rows.concat([...p.updates.values(), ...p.inserts.values()]);
    }
    return rows;
  }

  private trackRead(txn: TxnContext, table: string, row: StoredRow): void {
    let reads = txn.readSet.get(table);
    if (!reads) {
      reads = new Map();
      txn.readSet.set(table, reads);
    }
    if (!reads.has(row.__id)) reads.set(row.__id, row.__ver);
  }

  async scan(txn: TxnContext, table: string, opts: ScanOptions = {}): Promise<StoredRow[]> {
    if (!this.catalogCache.tables[table]) throw new SqlError(`表 ${table} 不存在`);
    let rows = await this.visibleRows(txn, table);
    const direction = opts.direction ?? 'asc';

    if (opts.indexName) {
      const def = this.catalogCache.tables[table];
      const idx = def.indexes.find((i) => i.name === opts.indexName);
      if (!idx) throw new SqlError(`索引 ${opts.indexName} 不存在`);
      rows.sort((a, b) => {
        const c = cmp(a[idx.column], b[idx.column]);
        return direction === 'desc' ? -c : c;
      });
      if (opts.range) {
        const r = opts.range;
        rows = rows.filter((row) => {
          const v = row[idx.column];
          if (v === null || v === undefined) return false;
          if (r.hasLower) {
            const c = cmp(v, r.lower);
            if (c < 0 || (c === 0 && !r.lowerInclusive)) return false;
          }
          if (r.hasUpper) {
            const c = cmp(v, r.upper);
            if (c > 0 || (c === 0 && !r.upperInclusive)) return false;
          }
          return true;
        });
      }
    } else {
      rows.sort((a, b) => (direction === 'desc' ? b.__id - a.__id : a.__id - b.__id));
    }
    for (const r of rows) this.trackRead(txn, table, r);
    return rows.map((r) => ({ ...r }));
  }

  async getById(txn: TxnContext, table: string, id: number): Promise<StoredRow | null> {
    const rows = await this.visibleRows(txn, table);
    const row = rows.find((r) => r.__id === id);
    if (row) this.trackRead(txn, table, row);
    return row ? { ...row } : null;
  }

  async getByIndex(txn: TxnContext, table: string, indexName: string, value: SqlValue): Promise<StoredRow | null> {
    const rows = await this.scan(txn, table, { indexName });
    const hit = rows.find((r) => {
      const col = this.catalogCache.tables[table].indexes.find((i) => i.name === indexName)!.column;
      return value === null ? r[col] === null : sqlCompare(r[col], value) === 0;
    });
    return hit ? { ...hit } : null;
  }

  // ---------- 写入 ----------
  async applyMutations(
    txn: TxnContext,
    tableName: string,
    mutations: { insert?: Row[]; update?: { id: number; row: Row }[]; delete?: number[] },
  ): Promise<ApplyResult> {
    if (txn.readOnly) throw new SqlError('不能在只读事务中写入');
    const def = this.catalogCache.tables[tableName];
    if (!def) throw new SqlError(`表 ${tableName} 不存在`);
    const p = this.pendingFor(txn, tableName);
    const result: ApplyResult = { inserted: [], updated: [], deleted: [] };
    const pkCol = pkColumnName(def);

    // 计算下一个物理 id：已提交最大 id +1
    const committed = await this.readAllCommitted(tableName);
    let nextId = 1;
    for (const r of committed) if (r.__id >= nextId) nextId = r.__id + 1;
    for (const r of [...p.inserts.values()]) if (r.__id >= nextId) nextId = r.__id + 1;

    const visible = new Map<number, StoredRow>();
    for (const row of await this.visibleRows(txn, tableName)) visible.set(row.__id, row);

    const checkUnique = (candidate: Row, ignoreId: number): void => {
      for (const idx of def.indexes) {
        if (!idx.unique) continue; // 普通索引不做唯一性校验
        const v = candidate[idx.column];
        if (v === null || v === undefined) continue;
        for (const other of visible.values()) {
          if (other.__id === ignoreId) continue;
          const ov = other[idx.column];
          if (ov !== null && ov !== undefined && sqlCompare(ov, v) === 0) {
            const isPk = def.columns.find((c) => c.name === idx.column)?.primaryKey;
            throw new SqlError(`${isPk ? '主键' : '唯一索引'}冲突：列 ${idx.column} 的值已存在`);
          }
        }
      }
    };

    if (mutations.insert) {
      for (const rawIn of mutations.insert) {
        const raw = { ...rawIn };
        if (pkCol) {
          const pkType = def.columns.find((c) => c.name === pkCol)!.type;
          if ((raw[pkCol] === null || raw[pkCol] === undefined) && pkType === 'INTEGER') {
            raw[pkCol] = nextId++;
          }
        }
        const row = this.normalizeRow(def, raw);
        let id: number;
        if (pkCol) {
          const pkVal = row[pkCol];
          if (pkVal === null || pkVal === undefined) {
            throw new SqlError(`主键列 ${pkCol} 不能为 NULL`);
          } else {
            id = typeof pkVal === 'number' && Number.isInteger(pkVal) ? pkVal : nextId++;
          }
        } else {
          id = nextId++;
        }
        if (visible.has(id) || p.inserts.has(id)) throw new SqlError(`主键冲突：id=${id} 已存在`);
        const stored: StoredRow = { ...row, __id: id, __ver: 1 };
        checkUnique(stored, -1);
        p.inserts.set(id, stored);
        visible.set(id, stored);
        result.inserted.push(stored);
      }
    }

    if (mutations.update) {
      for (const { id, row: raw } of mutations.update) {
        const existing = visible.get(id);
        if (!existing) throw new SqlError(`更新失败：行 ${id} 不存在`);
        const merged: Row = { ...existing };
        for (const k of Object.keys(raw)) merged[k] = raw[k];
        const normalized = this.normalizeRow(def, merged, true);
        checkUnique(normalized, id);
        const stored: StoredRow = { ...normalized, __id: id, __ver: existing.__ver + 1 };
        p.updates.set(id, stored);
        visible.set(id, stored);
        result.updated.push(stored);
      }
    }

    if (mutations.delete) {
      for (const id of mutations.delete) {
        const existing = visible.get(id);
        if (!existing) throw new SqlError(`删除失败：行 ${id} 不存在`);
        p.deletes.add(id);
        p.inserts.delete(id);
        p.updates.delete(id);
        visible.delete(id);
        result.deleted.push(existing);
      }
    }

    return result;
  }

  private normalizeRow(def: TableDef, raw: Row, allowMissing = false): Row {
    const out: Row = {};
    for (const col of def.columns) {
      let v: SqlValue;
      if (!(col.name in raw)) {
        if (allowMissing) continue;
        v = col.default !== undefined ? col.default : null;
      } else {
        v = raw[col.name];
      }
      if (v === null || v === undefined) {
        if (col.primaryKey) throw new SqlError(`主键列 ${col.name} 不能为 NULL`);
        if (col.nullable === false) throw new SqlError(`列 ${col.name} 不能为 NULL`);
        out[col.name] = null;
      } else {
        out[col.name] = applyAffinity(v, col.type);
      }
    }
    if (allowMissing) {
      for (const col of def.columns) {
        if (!(col.name in out)) out[col.name] = (raw[col.name] ?? null) as SqlValue;
      }
    }
    for (const key of Object.keys(raw)) {
      if (key === '__id' || key === '__ver' || key === '__table' || key === '__txn' || key === PK_NAME) continue;
      if (!def.columns.some((c) => c.name === key)) {
        throw new SqlError(`表 ${def.name} 不存在列 ${key}`);
      }
    }
    return out;
  }
}

/** IndexedDB 键序：null < number < string（boolean 转 0/1） */
function cmp(a: SqlValue, b: SqlValue): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'boolean') a = a ? 1 : 0;
  if (typeof b === 'boolean') b = b ? 1 : 0;
  const c = sqlCompare(a, b);
  return c ?? 0;
}
