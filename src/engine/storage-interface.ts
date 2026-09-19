// ============================================================
// 存储层抽象
// 内存存储用于测试；IndexedDB 存储用于浏览器持久化。
// 表内行以 { __pk: string, data: Row } 形式保存。
// ============================================================

import type { Row, TableDef } from '../sql/types';

export interface StoredRow {
  /** 行的物理主键值（字符串化）：主键列值或自动 rowid */
  pk: string;
  data: Row;
}

export interface DatabaseSnapshot {
  tables: Record<string, TableDef>;
  rows: Record<string, StoredRow[]>;
  /** 当前存储版本号（由后端持久化） */
  version: number;
}

/** 写操作意图（事务提交时一次性落盘） */
export type WriteIntent =
  | { type: 'putRow'; table: string; pk: string; data: Row }
  | { type: 'deleteRow'; table: string; pk: string }
  | { type: 'putTable'; table: TableDef }
  | { type: 'deleteTable'; name: string };

export interface StorageBackend {
  load(): Promise<DatabaseSnapshot>;
  /** 原子提交一批写入；返回最新版本号 */
  commit(intents: WriteIntent[], baseVersion: number): Promise<number>;
  /** 清空整个数据库 */
  reset(): Promise<void>;
}
