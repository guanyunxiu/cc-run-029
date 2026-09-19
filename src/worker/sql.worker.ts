// ============================================================
// Web Worker：在后台线程运行 SQL 引擎，避免阻塞界面
// ============================================================

/// <reference lib="webworker" />

import { Database } from '../engine/database';
import { IndexedDbStorage } from '../engine/idb-storage';
import { Engine } from '../engine/engine';
import {
  exportDatabaseJSON,
  importDatabaseJSON,
  importCSVIntoTable,
} from '../engine/import-export';
import type { SchemaInfo } from '../shared/protocol';
import type { WorkerRequest, WorkerResponse } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let engine: Engine | null = null;

async function getEngine(): Promise<Engine> {
  if (engine) return engine;
  const db = new Database(new IndexedDbStorage());
  await db.init();
  engine = new Engine(db);
  return engine;
}

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    const e = await getEngine();
    switch (msg.type) {
      case 'exec': {
        const results = await e.execute(msg.sql);
        post({ type: 'result', id: msg.id, results });
        break;
      }
      case 'schema': {
        post({ type: 'schema', id: msg.id, schema: buildSchema(e) });
        break;
      }
      case 'export-json': {
        post({ type: 'export-json', id: msg.id, text: exportDatabaseJSON(e.db) });
        break;
      }
      case 'import-json': {
        const info = await importDatabaseJSON(e, msg.text);
        post({ type: 'import-result', id: msg.id, tables: info.tables, rows: info.rows });
        break;
      }
      case 'import-csv': {
        const n = await importCSVIntoTable(e, msg.table, msg.text);
        post({ type: 'import-result', id: msg.id, tables: 1, rows: n });
        break;
      }
      case 'reset': {
        await e.db.resetStorage();
        post({ type: 'schema', id: msg.id, schema: buildSchema(e) });
        break;
      }
    }
  } catch (err) {
    const e = err as { message: string; line?: number; column?: number; kind?: string };
    post({
      type: 'error',
      id: msg.id,
      message: e.message ?? String(err),
      line: e.line,
      column: e.column,
      kind: e.kind,
    });
  }
};

function buildSchema(engine: Engine): SchemaInfo {
  return {
    tables: engine.db.snapshotTables().map((t) => ({
      name: t.def.name,
      columns: t.def.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        primaryKey: c.primaryKey,
      })),
      indexes: t.def.indexes.map((i) => ({ name: i.name, column: i.column, unique: i.unique })),
      primaryKey: t.def.primaryKey,
      rowCount: t.rows.length,
    })),
  };
}
