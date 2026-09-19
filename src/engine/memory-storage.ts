// ============================================================
// 内存存储后端（测试用，零依赖、同步可用）
// ============================================================

import type { DatabaseSnapshot, StorageBackend, WriteIntent } from './storage-interface';

export class MemoryStorage implements StorageBackend {
  private snap: DatabaseSnapshot = { tables: {}, rows: {}, version: 0 };
  private version = 0;

  async load(): Promise<DatabaseSnapshot> {
    // 深拷贝，避免外部直接改动
    const out = structuredCloneSafe(this.snap);
    out.version = this.version;
    return out;
  }

  async commit(intents: WriteIntent[], baseVersion: number): Promise<number> {
    if (baseVersion !== this.version) {
      throw Object.assign(new Error('write conflict: database changed by another transaction'), {
        conflict: true,
      });
    }
    for (const intent of intents) {
      switch (intent.type) {
        case 'putRow': {
          const list = (this.snap.rows[intent.table] ??= []);
          const idx = list.findIndex((r) => r.pk === intent.pk);
          const row = { pk: intent.pk, data: structuredCloneSafe(intent.data) };
          if (idx >= 0) list[idx] = row;
          else list.push(row);
          break;
        }
        case 'deleteRow': {
          const list = this.snap.rows[intent.table];
          if (list) {
            const idx = list.findIndex((r) => r.pk === intent.pk);
            if (idx >= 0) list.splice(idx, 1);
          }
          break;
        }
        case 'putTable':
          this.snap.tables[intent.table.name] = structuredCloneSafe(intent.table);
          this.snap.rows[intent.table.name] ??= [];
          break;
        case 'deleteTable':
          delete this.snap.tables[intent.name];
          delete this.snap.rows[intent.name];
          break;
      }
    }
    this.version++;
    return this.version;
  }

  async reset(): Promise<void> {
    this.snap = { tables: {}, rows: {}, version: 0 };
    this.version = 0;
  }
}

function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}
