// 主线程 Worker 客户端：Promise 化的请求/响应
import type { WorkerRequest, WorkerResponse, TableData } from './protocol';
import type { QueryResult, TableDef, Row } from './sql/types';
import type { DatabaseExport } from './engine/import-export';

/** Worker 构造器（由 Vite 的 ?worker 导入提供） */
export type SqlWorkerConstructor = new () => Worker;

export class WorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(WorkerCtor: SqlWorkerConstructor) {
    this.worker = new WorkerCtor();
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg);
      else {
        const err = new Error(msg.error.message) as Error & { line?: number; column?: number };
        err.line = msg.error.line;
        err.column = msg.error.column;
        p.reject(err);
      }
    };
    this.worker.onerror = (ev) => {
      for (const [, p] of this.pending) p.reject(new Error(ev.message || 'Worker 内部错误'));
      this.pending.clear();
    };
  }

  private call<T = unknown>(req: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...req, id });
    });
  }

  init(backend: 'idb' | 'memory'): Promise<void> {
    return this.call({ type: 'init', backend });
  }
  exec(sql: string, explain = false): Promise<QueryResult[]> {
    return this.call<{ results: QueryResult[] }>({ type: 'exec', sql, explain }).then((r) => r.results);
  }
  listTables(): Promise<TableDef[]> {
    return this.call({ type: 'listTables' });
  }
  getTableRows(table: string): Promise<Row[]> {
    return this.call({ type: 'getTableRows', table });
  }
  exportJson(): Promise<DatabaseExport> {
    return this.call({ type: 'exportJson' });
  }
  exportSql(): Promise<string> {
    return this.call<{ data: string }>({ type: 'exportSql' }).then((r) => r.data);
  }
  exportCsv(table: string): Promise<string> {
    return this.call<{ data: string }>({ type: 'exportCsv', table }).then((r) => r.data);
  }
  importJson(data: DatabaseExport): Promise<{ tables: number; rows: number }> {
    return this.call<{ data: { tables: number; rows: number } }>({ type: 'importJson', data }).then((r) => r.data);
  }
  importSql(script: string): Promise<{ statements: number }> {
    return this.call<{ data: { statements: number } }>({ type: 'importSql', script }).then((r) => r.data);
  }
  importCsv(table: string, text: string, create: boolean): Promise<{ rows: number }> {
    return this.call<{ data: { rows: number } }>({ type: 'importCsv', table, text, create }).then((r) => r.data);
  }
}

// 分布式 Omit：避免对联合类型直接 Omit 后丢失判别字段
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** 不含消息 id 的请求类型（供测试与调用方使用） */
export type WorkerRequestWithoutId = DistributiveOmit<WorkerRequest, 'id'>;

export type { TableData };
