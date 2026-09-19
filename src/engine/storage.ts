// 存储抽象层：表结构目录、行存储、事务上下文、冲突检测
// IndexedDB 实现见 idb-storage.ts；内存实现见 memory-storage.ts
import { IndexDef, Row, SqlValue, TableDef } from '../sql/types';

export const PK_NAME = '__pk'; // 主键列值副本字段名
export const ID_PROP = '__id';
export const VER_PROP = '__ver';

export interface StoredRow {
  __id: number;
  __ver: number;
  [column: string]: SqlValue; // 数据列 + __id/__ver（number 属于 SqlValue）
}

export interface Catalog {
  tables: Record<string, TableDef>;
}

export type ScanDirection = 'asc' | 'desc';

export interface ScanOptions {
  indexName?: string; // undefined 表示主键顺序扫描
  range?: IndexRange | null;
  direction?: ScanDirection;
}

export interface IndexRange {
  // 边界均可为 null 值；用 hasLower/hasUpper 表示是否有界
  hasLower: boolean;
  lower: SqlValue;
  lowerInclusive: boolean;
  hasUpper: boolean;
  upper: SqlValue;
  upperInclusive: boolean;
}

export interface ApplyResult {
  inserted: StoredRow[];
  updated: StoredRow[];
  deleted: StoredRow[];
}

export interface TxnContext {
  id: number;
  readOnly: boolean;
  /** 读过的行版本：table -> (id -> ver) */
  readSet: Map<string, Map<number, number>>;
  /** 各表扫描水位（用于提交时校验幻读）：table -> 扫描时的最大行版本/行数快照 */
  scanMarks: Map<string, ScanMark>;
}

export interface ScanMark {
  rowCount: number;
  maxId: number;
}

export interface Storage {
  init(): Promise<void>;
  getCatalog(): Promise<Catalog>;

      createTable(def: TableDef): Promise<void>;
  dropTable(name: string): Promise<void>;
  createIndex(idx: IndexDef): Promise<void>;
  dropIndex(table: string, indexName: string): Promise<void>;

  /** 开始事务。readonly 事务不阻塞且不产生写锁。 */
  begin(readOnly?: boolean): Promise<TxnContext>;
  commit(txn: TxnContext): Promise<void>;
  rollback(txn: TxnContext): Promise<void>;

  scan(txn: TxnContext, table: string, opts?: ScanOptions): Promise<StoredRow[]>;
  getById(txn: TxnContext, table: string, id: number): Promise<StoredRow | null>;
  /** 直接用唯一索引取行（主键/唯一索引） */
  getByIndex(txn: TxnContext, table: string, indexName: string, value: SqlValue): Promise<StoredRow | null>;

  /**
   * 在事务内应用一批变更。约束冲突抛错，调用方应 rollback。
   * 变更在事务内立即对后续读取可见。
   */
  applyMutations(
    txn: TxnContext,
    table: string,
    mutations: {
      insert?: Row[];
      update?: { id: number; row: Row }[];
      delete?: number[];
    },
  ): Promise<ApplyResult>;
}

export function pkIndexName(table: TableDef): string | undefined {
  const pk = table.columns.find((c) => c.primaryKey);
  return pk ? `idx_${table.name}_pk_${pk.name}` : undefined;
}

export function pkColumnName(table: TableDef): string | undefined {
  return table.columns.find((c) => c.primaryKey)?.name;
}
