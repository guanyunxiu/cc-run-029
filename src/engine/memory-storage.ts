// 内存存储实现（测试与无 IndexedDB 环境使用）
// 事务模型：单写多读（写锁互斥）+ 快照隔离 + 提交时读集校验（写冲突回滚）
import { IndexDef, Row, SqlError, SqlValue, TableDef } from '../sql/types';
import {
  ApplyResult,
  Catalog,
  ID_PROP,
  IndexRange,
  PK_NAME,
  ScanMark,
  ScanOptions,
  Storage,
  StoredRow,
  TxnContext,
  pkColumnName,
} from './storage';
import { applyAffinity, sqlCompare } from './value';

interface TableState {
  def: TableDef;
  rows: Map<number, StoredRow>; // 已提交数据
  nextId: number;
}

interface PendingChanges {
  inserts: Map<number, StoredRow>; // 新行（id 在提交时确定，begin 时预分配）
  updates: Map<number, StoredRow>; // 覆盖后的整行
  deletes: Set<number>;
}

export class MemoryStorage implements Storage {
  private catalogData: Catalog = { tables: {} };
  private state = new Map<string, TableState>();
  private nextTxnId = 1;
  private writeLocked = false;
  private activeTxns = new Set<TxnContext>();

  constructor() {}

  async init(): Promise<void> {
    /* 内存实现无需初始化 */
  }

  async getCatalog(): Promise<Catalog> {
    return this.catalogData;
  }

  // ---------- DDL ----------
  private assertNoActiveWrite(): void {
    // DDL 允许在无显式事务时执行；引擎层已保证
  }

  async createTable(def: TableDef): Promise<void> {
    this.assertNoActiveWrite();
    if (this.catalogData.tables[def.name]) {
      throw new SqlError(`表 ${def.name} 已存在`);
    }
    this.catalogData = {
      tables: { ...this.catalogData.tables, [def.name]: structuredClone(def) },
    };
    this.state.set(def.name, { def: structuredClone(def), rows: new Map(), nextId: 1 });
  }

  async dropTable(name: string): Promise<void> {
    if (!this.catalogData.tables[name]) throw new SqlError(`表 ${name} 不存在`);
    const tables = { ...this.catalogData.tables };
    delete tables[name];
    this.catalogData = { tables };
    this.state.delete(name);
  }

  async createIndex(idx: IndexDef): Promise<void> {
    const t = this.catalogData.tables[idx.table];
    if (!t) throw new SqlError(`表 ${idx.table} 不存在`);
    if (!t.columns.some((c) => c.name === idx.column)) throw new SqlError(`列 ${idx.column} 不存在`);
    if (t.indexes.some((i) => i.name === idx.name)) throw new SqlError(`索引 ${idx.name} 已存在`);
    // 唯一性校验：存量数据不能有重复
    if (idx.unique) {
      const seen = new Set<string>();
      const st = this.state.get(idx.table)!;
      for (const r of st.rows.values()) {
        const v = r[idx.column];
        if (v === null || v === undefined) continue;
        const key = JSON.stringify(v);
        if (seen.has(key)) throw new SqlError(`创建唯一索引失败：列 ${idx.column} 存在重复值 ${key}`);
        seen.add(key);
      }
    }
    const newDef: TableDef = { ...t, indexes: [...t.indexes, { ...idx }] };
    this.catalogData = {
      tables: { ...this.catalogData.tables, [idx.table]: structuredClone(newDef) },
    };
    this.state.get(idx.table)!.def = structuredClone(newDef);
  }

  async dropIndex(table: string, indexName: string): Promise<void> {
    const t = this.catalogData.tables[table];
    if (!t || !t.indexes.some((i) => i.name === indexName)) {
      throw new SqlError(`索引 ${indexName} 不存在`);
    }
    const newDef: TableDef = { ...t, indexes: t.indexes.filter((i) => i.name !== indexName) };
    this.catalogData = {
      tables: { ...this.catalogData.tables, [table]: structuredClone(newDef) },
    };
    this.state.get(table)!.def = structuredClone(newDef);
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
    (txn as TxnContext & { pending?: Map<string, PendingChanges> }).pending = new Map();
    this.activeTxns.add(txn);
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
    try {
      if (!txn.readOnly) await this.validateReadSet(txn);
      const pending = this.pending(txn);
      for (const [tableName, p] of pending) {
        const st = this.state.get(tableName);
        if (!st) continue;
        for (const row of p.inserts.values()) {
          st.rows.set(row.__id, { ...row });
          if (row.__id >= st.nextId) st.nextId = row.__id + 1;
        }
        for (const [id, row] of p.updates) {
          st.rows.set(id, { ...row });
          if (row.__id >= st.nextId) st.nextId = row.__id + 1;
        }
        for (const id of p.deletes) st.rows.delete(id);
      }
    } finally {
      this.cleanupTxn(txn);
    }
  }

  async rollback(txn: TxnContext): Promise<void> {
    this.cleanupTxn(txn);
  }

  private cleanupTxn(txn: TxnContext): void {
    this.activeTxns.delete(txn);
    if (!txn.readOnly) this.writeLocked = false;
  }

  /** 提交前校验读集：读过的行版本未被其他事务改动（本事务自身的变更除外） */
  private async validateReadSet(txn: TxnContext): Promise<void> {
    for (const [tableName, reads] of txn.readSet) {
      const st = this.state.get(tableName);
      if (!st) continue;
      const p = this.pending(txn).get(tableName);
      for (const [id, ver] of reads) {
        // 本事务自身更新/删除/插入的行不参与外部冲突校验
        if (p?.updates.has(id) || p?.deletes.has(id) || p?.inserts.has(id)) continue;
        const cur = st.rows.get(id);
        const curVer = cur ? cur.__ver : 0; // 行被其他事务删除 => 0
        if (curVer !== ver) {
          throw new SqlError('写冲突：读取过的数据已被其他事务修改，事务回滚');
        }
      }
      const mark = txn.scanMarks.get(tableName);
      if (mark && !(p && (p.inserts.size > 0 || p.deletes.size > 0 || p.updates.size > 0))) {
        const currentMark = this.currentMark(st);
        if (currentMark.rowCount !== mark.rowCount || currentMark.maxId !== mark.maxId) {
          throw new SqlError('写冲突：查询范围数据已被其他事务修改，事务回滚');
        }
      }
    }
  }

  private currentMark(st: TableState): ScanMark {
    let rowCount = 0;
    let maxId = 0;
    for (const id of st.rows.keys()) {
      rowCount++;
      if (id > maxId) maxId = id;
    }
    return { rowCount, maxId };
  }

  // ---------- 读取 ----------
  /** 得到某表在事务视角下的全部行（已提交 + 本事务变更覆盖） */
  private visibleRows(txn: TxnContext, tableName: string): StoredRow[] {
    const st = this.state.get(tableName);
    if (!st) throw new SqlError(`表 ${tableName} 不存在`);
    const p = this.pending(txn).get(tableName);
    const result: StoredRow[] = [];
    for (const row of st.rows.values()) {
      if (p?.deletes.has(row.__id)) continue;
      result.push(p?.updates.get(row.__id) ?? row);
    }
    if (p) for (const row of p.inserts.values()) result.push(row);
    return result;
  }

  private trackRead(txn: TxnContext, table: string, row: StoredRow): void {
    let reads = txn.readSet.get(table);
    if (!reads) {
      reads = new Map();
      txn.readSet.set(table, reads);
    }
    if (!reads.has(row.__id)) reads.set(row.__id, row.__ver);
  }

  private trackScan(txn: TxnContext, table: string): void {
    if (txn.readOnly || !txn.scanMarks.has(table)) {
      const st = this.state.get(table)!;
      txn.scanMarks.set(table, this.currentMark(st));
    }
  }

  async getById(txn: TxnContext, table: string, id: number): Promise<StoredRow | null> {
    const st = this.state.get(table);
    if (!st) throw new SqlError(`表 ${table} 不存在`);
    const p = this.pending(txn).get(table);
    let row: StoredRow | undefined;
    if (p?.deletes.has(id)) return null;
    row = p?.inserts.get(id) ?? p?.updates.get(id) ?? st.rows.get(id);
    if (!row) return null;
    this.trackRead(txn, table, row);
    return { ...row };
  }

  async getByIndex(
    txn: TxnContext,
    table: string,
    indexName: string,
    value: SqlValue,
  ): Promise<StoredRow | null> {
    const rows = await this.scan(txn, table, {
      indexName,
      range: value === null ? null : eqRange(value),
    });
    if (value === null) {
      const hit = rows.find((r) => r[this.indexColumn(table, indexName)] === null);
      return hit ? { ...hit } : null;
    }
    return rows.length > 0 ? { ...rows[0] } : null;
  }

  private indexColumn(table: string, indexName: string): string {
    const def = this.catalogData.tables[table];
    const idx = def.indexes.find((i) => i.name === indexName);
    if (!idx) throw new SqlError(`索引 ${indexName} 不存在`);
    return idx.column;
  }

  async scan(txn: TxnContext, table: string, opts: ScanOptions = {}): Promise<StoredRow[]> {
    const st = this.state.get(table);
    if (!st) throw new SqlError(`表 ${table} 不存在`);
    this.trackScan(txn, table);

    let rows = this.visibleRows(txn, table);
    const direction = opts.direction ?? 'asc';

    if (opts.indexName) {
      const idx = st.def.indexes.find((i) => i.name === opts.indexName);
      if (!idx) throw new SqlError(`索引 ${opts.indexName} 不存在`);
      const col = idx.column;
      rows.sort((a, b) => {
        const c = compareIndexKey(a[col], b[col]);
        return direction === 'desc' ? -c : c;
      });
      if (opts.range) {
        rows = rows.filter((r) => matchRange(r[col], opts.range!));
      }
    } else {
      rows.sort((a, b) => (direction === 'desc' ? b.__id - a.__id : a.__id - b.__id));
    }
    for (const r of rows) this.trackRead(txn, table, r);
    return rows.map((r) => ({ ...r }));
  }

  // ---------- 写入 ----------
  async applyMutations(
    txn: TxnContext,
    tableName: string,
    mutations: { insert?: Row[]; update?: { id: number; row: Row }[]; delete?: number[] },
  ): Promise<ApplyResult> {
    if (txn.readOnly) throw new SqlError('不能在只读事务中写入');
    const st = this.state.get(tableName);
    if (!st) throw new SqlError(`表 ${tableName} 不存在`);
    const def = st.def;
    const p = this.pendingFor(txn, tableName);
    const result: ApplyResult = { inserted: [], updated: [], deleted: [] };

    const pkCol = pkColumnName(def);

    // 构造当前可见行索引，便于唯一性检查
    const visible = new Map<number, StoredRow>();
    for (const row of this.visibleRows(txn, tableName)) visible.set(row.__id, row);

    const checkUnique = (candidate: Row, ignoreId: number): void => {
      // 只有主键/唯一索引才做唯一性校验；普通索引仅用于加速
      for (const idx of def.indexes) {
        if (!idx.unique) continue;
        const v = candidate[idx.column];
        if (v === null || v === undefined) {
          // NULL 不参与唯一约束（标准 SQL 语义）
          continue;
        }
        for (const other of visible.values()) {
          if (other.__id === ignoreId) continue;
          const ov = other[idx.column];
          if (ov !== null && ov !== undefined && sqlCompare(ov, v) === 0) {
            const kind = idx.column === pkCol || def.columns.find((c) => c.name === idx.column)?.primaryKey
              ? '主键'
              : '唯一索引';
            throw new SqlError(`${kind}冲突：列 ${idx.column} 的值 ${formatVal(v)} 已存在`);
          }
        }
      }
    };

    // INSERT
    if (mutations.insert) {
      for (const rawIn of mutations.insert) {
        // INTEGER 主键缺省时先补自增值，再做规范化（NOT NULL 等检查）
        const raw = { ...rawIn };
        if (pkCol) {
          const pkType = def.columns.find((c) => c.name === pkCol)!.type;
          if ((raw[pkCol] === null || raw[pkCol] === undefined) && pkType === 'INTEGER') {
            raw[pkCol] = st.nextId;
          }
        }
        const row = this.normalizeRow(def, raw);
        let id: number;
        if (pkCol) {
          const pkVal = row[pkCol];
          if (pkVal === null || pkVal === undefined) {
            throw new SqlError(`主键列 ${pkCol} 不能为 NULL`);
          } else {
            // 物理行 id 与主键值解耦：INTEGER 主键直接复用其值，其他类型由存储分配
            id = typeof pkVal === 'number' && Number.isInteger(pkVal) ? pkVal : st.nextId;
          }
        } else {
          id = st.nextId;
        }
        if (visible.has(id) || p.inserts.has(id)) {
          throw new SqlError(`主键冲突：id=${id} 已存在`);
        }
        const stored: StoredRow = { ...row, __id: id, __ver: 1 };
        checkUnique(stored, -1);
        p.inserts.set(id, stored);
        visible.set(id, stored);
        st.nextId = Math.max(st.nextId, id + 1);
        result.inserted.push(stored);
      }
    }

    // UPDATE
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

    // DELETE
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

  /** 按表定义规范化一行：补默认值、类型亲和、NOT NULL 检查、拒绝未知列 */
  private normalizeRow(def: TableDef, raw: Row, allowMissing = false): Row {
    const out: Row = {};
    for (const col of def.columns) {
      let v: SqlValue;
      if (!(col.name in raw)) {
        if (allowMissing) continue; // 更新时未涉及的列在后面保留
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
    // 更新时保留未提供的列
    if (allowMissing) {
      for (const col of def.columns) {
        if (!(col.name in out)) out[col.name] = (raw[col.name] ?? null) as SqlValue;
      }
    }
    for (const key of Object.keys(raw)) {
      if (key === ID_PROP || key === '__ver' || key === PK_NAME) continue;
      if (!def.columns.some((c) => c.name === key)) {
        throw new SqlError(`表 ${def.name} 不存在列 ${key}`);
      }
    }
    return out;
  }
}

function formatVal(v: SqlValue): string {
  return typeof v === 'string' ? `'${v}'` : String(v);
}

export function eqRange(v: SqlValue): IndexRange {
  return { hasLower: true, lower: v, lowerInclusive: true, hasUpper: true, upper: v, upperInclusive: true };
}

/** 索引键比较：NULL 最小，然后数值、文本（与 IndexedDB 键序兼容） */
export function compareIndexKey(a: SqlValue, b: SqlValue): number {
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : -1;
  }
  if (b === null || b === undefined) return 1;
  const c = sqlCompare(a, b);
  return c ?? 0;
}

export function matchRange(v: SqlValue, r: IndexRange): boolean {
  if (v === null || v === undefined) return false;
  if (r.hasLower) {
    const c = compareIndexKey(v, r.lower);
    if (c < 0 || (c === 0 && !r.lowerInclusive)) return false;
  }
  if (r.hasUpper) {
    const c = compareIndexKey(v, r.upper);
    if (c > 0 || (c === 0 && !r.upperInclusive)) return false;
  }
  return true;
}
