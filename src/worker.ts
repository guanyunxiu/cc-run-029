// Web Worker 入口：所有 SQL 执行都在这里，避免阻塞主线程
import { Session } from './engine/session';
import { Storage } from './engine/storage';
import { MemoryStorage } from './engine/memory-storage';
import { IdbStorage } from './engine/idb-storage';
import { SqlError, TableDef } from './sql/types';
import {
  buildExport,
  exportCsv,
  exportToSqlScript,
  parseCsv,
  type DatabaseExport,
} from './engine/import-export';
import type { WorkerRequest, WorkerResponse } from './protocol';

let session: Session | null = null;
let backend: 'idb' | 'memory' = 'idb';

async function getSession(wanted?: 'idb' | 'memory'): Promise<Session> {
  if (wanted) backend = wanted;
  if (session) return session;
  const storage: Storage = backend === 'idb' ? new IdbStorage() : new MemoryStorage();
  await storage.init();
  session = new Session(storage);
  return session;
}

async function collectTables(db: Session) {
  const defs = await db.listTables();
  const tables: { definition: TableDef; rows: import('./sql/types').Row[] }[] = [];
  for (const d of defs) tables.push({ definition: d, rows: await db.getTableRows(d.name) });
  return tables;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  const reply = (r: WorkerResponse): void => {
    (self as unknown as Worker).postMessage(r);
  };
  try {
    switch (req.type) {
      case 'init': {
        await getSession(req.backend);
        reply({ id: req.id, ok: true });
        break;
      }
      case 'exec': {
        const db = await getSession();
        const results = await db.execute(req.sql, { explain: req.explain });
        reply({ id: req.id, ok: true, results });
        break;
      }
      case 'listTables': {
        const db = await getSession();
        reply({ id: req.id, ok: true, data: await db.listTables() });
        break;
      }
      case 'getTableRows': {
        const db = await getSession();
        reply({ id: req.id, ok: true, data: await db.getTableRows(req.table) });
        break;
      }
      case 'exportJson': {
        const db = await getSession();
        const exp: DatabaseExport = buildExport(await collectTables(db));
        reply({ id: req.id, ok: true, data: exp });
        break;
      }
      case 'exportSql': {
        const db = await getSession();
        reply({ id: req.id, ok: true, data: exportToSqlScript(await collectTables(db)) });
        break;
      }
      case 'exportCsv': {
        const db = await getSession();
        const def = await db.getTableDef(req.table);
        if (!def) throw new SqlError(`表 ${req.table} 不存在`);
        const rows = await db.getTableRows(req.table);
        reply({ id: req.id, ok: true, data: exportCsv(def, rows) });
        break;
      }
      case 'importJson': {
        const db = await getSession();
        let count = 0;
        for (const t of req.data.tables) {
          await db.importTable(structuredClone(t.definition), structuredClone(t.rows));
          count += t.rows.length;
        }
        reply({ id: req.id, ok: true, data: { tables: req.data.tables.length, rows: count } });
        break;
      }
      case 'importSql': {
        const db = await getSession();
        const results = await db.execute(req.script);
        reply({ id: req.id, ok: true, data: { statements: results.length } });
        break;
      }
      case 'importCsv': {
        const db = await getSession();
        const parsed = parseCsv(req.text);
        if (parsed.columns.length === 0) throw new SqlError('CSV 内容为空');
        let def: TableDef | undefined;
        if (req.create) {
          const pkName = parsed.columns[0]?.toLowerCase() === 'id' ? parsed.columns[0] : undefined;
          const cols = parsed.columns.map((name) => ({
            name,
            type: (name === pkName ? 'INTEGER' : 'TEXT') as 'INTEGER' | 'TEXT',
            primaryKey: name === pkName,
            nullable: name !== pkName,
          }));
          def = {
            name: req.table,
            columns: cols,
            indexes: pkName
              ? [{ name: `idx_${req.table}_pk_${pkName}`, table: req.table, column: pkName, unique: true }]
              : [],
          };
          await db.importTable(def, []);
        } else {
          def = await db.getTableDef(req.table);
          if (!def) throw new SqlError(`表 ${req.table} 不存在`);
        }
        const rows = parsed.rows.map((r) => {
          const row: import('./sql/types').Row = {};
          def!.columns.forEach((c, i) => {
            const raw = r[i] ?? '';
            row[c.name] = raw === '' ? null : coerceCsv(raw, c.type);
          });
          return row;
        });
        const n = await db.bulkInsert(req.table, rows);
        reply({ id: req.id, ok: true, data: { rows: n } });
        break;
      }
    }
  } catch (e) {
    const err = e as SqlError;
    reply({
      id: req.id,
      ok: false,
      error: {
        message: err.message || String(err),
        line: (err as SqlError).line ?? 0,
        column: (err as SqlError).column ?? 0,
      },
    });
  }
};

function coerceCsv(raw: string, type: string): string | number | boolean {
  switch (type) {
    case 'INTEGER': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : raw;
    }
    case 'REAL': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'BOOLEAN': {
      const s = raw.toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return raw;
    }
    default:
      return raw;
  }
}
