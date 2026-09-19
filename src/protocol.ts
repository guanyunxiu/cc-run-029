// 主线程 <-> Worker 消息协议
import { QueryResult, TableDef, Row } from './sql/types';
import { DatabaseExport } from './engine/import-export';

export type WorkerRequest =
  | { id: number; type: 'init'; backend: 'idb' | 'memory' }
  | { id: number; type: 'exec'; sql: string; explain: boolean }
  | { id: number; type: 'listTables' }
  | { id: number; type: 'getTableRows'; table: string }
  | { id: number; type: 'exportJson' }
  | { id: number; type: 'exportSql' }
  | { id: number; type: 'exportCsv'; table: string }
  | { id: number; type: 'importJson'; data: DatabaseExport }
  | { id: number; type: 'importCsv'; table: string; text: string; create: boolean }
  | { id: number; type: 'importSql'; script: string };

export interface TableData {
  definition: TableDef;
  rows: Row[];
}

export type WorkerResponse =
  | { id: number; ok: true; results?: QueryResult[]; data?: unknown }
  | { id: number; ok: false; error: { message: string; line: number; column: number } };
