// ============================================================
// 数据导入导出：整库 JSON、单表结果 CSV
// ============================================================

import { castValue, type DBValue, type Row, type TableDef } from '../sql/types';
import type { DataType } from '../sql/types';
import type { Database } from './database';
import { Transaction } from './database';
import { SQLError } from '../sql/types';
import type { Engine } from './engine';

export interface DatabaseExport {
  format: 'mini-sql-export';
  version: 1;
  exportedAt?: string;
  tables: {
    name: string;
    columns: TableDef['columns'];
    indexes: TableDef['indexes'];
    primaryKey: string | null;
    autoincrement: boolean;
    rows: Row[];
  }[];
}

/** 导出整个数据库为可移植 JSON（不依赖物理 pk） */
export function exportDatabaseJSON(db: Database): string {
  const data: DatabaseExport = {
    format: 'mini-sql-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: db.snapshotTables().map((t) => ({
      name: t.def.name,
      columns: t.def.columns,
      indexes: t.def.indexes,
      primaryKey: t.def.primaryKey,
      autoincrement: t.def.autoincrement,
      rows: t.rows.map((r) => {
        const out: Row = {};
        for (const c of t.def.columns) out[c.name] = r.data[c.name] ?? null;
        return out;
      }),
    })),
  };
  return JSON.stringify(data, null, 2);
}

/**
 * 导入数据库 JSON：要求当前库为空（或表名不冲突）。
 * 在一个事务中完成，失败整体回滚。
 */
export async function importDatabaseJSON(engine: Engine, text: string): Promise<{ tables: number; rows: number }> {
  let data: DatabaseExport;
  try {
    data = JSON.parse(text) as DatabaseExport;
  } catch {
    throw new SQLError('invalid JSON file', undefined, 'RUNTIME');
  }
  if (!data || data.format !== 'mini-sql-export' || !Array.isArray(data.tables)) {
    throw new SQLError('not a valid mini-sql-export file', undefined, 'RUNTIME');
  }

  const db = engine.db;
  const txn = new Transaction();
  db.acquireWriter(txn);
  let tableCount = 0;
  let rowCount = 0;
  try {
    for (const t of data.tables) {
      if (db.findTable(t.name)) {
        throw new SQLError(`cannot import: table "${t.name}" already exists`, undefined, 'CONFLICT');
      }
      const def: TableDef = {
        name: t.name,
        columns: t.columns.map((c, i) => ({ ...c, ordinal: i })),
        indexes: t.indexes ?? [],
        primaryKey: t.primaryKey ?? null,
        autoincrement: t.autoincrement ?? false,
        seq: 1,
      };
      db.createTable(def, false, txn);
      const store = db.getTable(t.name);
      for (const raw of t.rows) {
        const row: Row = {};
        for (const c of def.columns) row[c.name] = (raw[c.name] ?? null) as DBValue;
        db.insertRow(store, row, txn, true);
        rowCount++;
      }
      tableCount++;
    }
    await db.commit(txn);
  } catch (e) {
    if (db.activeWriter === txn) db.releaseWriter(txn);
    throw e;
  }
  return { tables: tableCount, rows: rowCount };
}

// ------------------------------------------------------------
// CSV：把查询结果序列化为 CSV，或把 CSV 解析为行
// ------------------------------------------------------------
export function rowsToCSV(rows: Row[], columns: string[]): string {
  const lines: string[] = [];
  lines.push(columns.map(csvEscape).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(valueToText(row[c]))).join(','));
  }
  return lines.join('\n');
}

function valueToText(v: DBValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 解析 CSV（首行为表头），返回列名与字符串行数组（空字段 => null） */
export function parseCSV(text: string): { columns: string[]; rows: Row[] } {
  const records = tokenizeCSV(text);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0].map((h, i) => h.trim() || `column${i + 1}`);
  const rows: Row[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.length === 1 && rec[0].trim() === '') continue; // 跳过空行
    const row: Row = {};
    for (let i = 0; i < columns.length; i++) {
      const raw = rec[i] ?? '';
      row[columns[i]] = raw === '' ? null : raw;
    }
    rows.push(row);
  }
  return { columns, rows };
}

function tokenizeCSV(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // 是否已经开始一个字段或一行

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; started = false; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    started = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') { /* CRLF：忽略，由 \n 结束行 */ }
    else field += c;
  }
  // 闭合未关闭的引号
  if (inQuotes) throw new SQLError('unterminated quoted field in CSV', undefined, 'RUNTIME');
  // 最后一行没有结尾换行
  if (started || field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** 把 CSV 数据导入已存在的表（按列名匹配），值按目标列类型转换 */
export async function importCSVIntoTable(
  engine: Engine,
  tableName: string,
  csvText: string,
): Promise<number> {
  const { columns, rows } = parseCSV(csvText);
  const db = engine.db;
  const store = db.getTable(tableName);
  const def = store.def;

  const targetCols = columns.map((c) => {
    const col = def.columns.find((x) => x.name.toLowerCase() === c.toLowerCase());
    if (!col) throw new SQLError(`CSV column "${c}" does not exist in table "${tableName}"`, undefined, 'BIND');
    return col.name;
  });

  const txn = new Transaction();
  db.acquireWriter(txn);
  let count = 0;
  try {
    for (const raw of rows) {
      const data: Row = {};
      for (const c of def.columns) data[c.name] = null;
      for (let i = 0; i < targetCols.length; i++) {
        const colDef = def.columns.find((c) => c.name === targetCols[i])!;
        const v = raw[columns[i]];
        data[targetCols[i]] = v === null ? null : castValue(String(v), colDef.type);
      }
      db.insertRow(store, data, txn, true);
      count++;
    }
    await db.commit(txn);
  } catch (e) {
    if (db.activeWriter === txn) db.releaseWriter(txn);
    throw e;
  }
  return count;
}
