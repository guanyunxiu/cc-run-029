// ============================================================
// Worker <-> 主线程消息协议
// ============================================================

import type { QueryResult } from '../engine/engine';

export type WorkerRequest =
  | { type: 'exec'; sql: string; id: number }
  | { type: 'export-json'; id: number }
  | { type: 'import-json'; text: string; id: number }
  | { type: 'import-csv'; table: string; text: string; id: number }
  | { type: 'schema'; id: number }
  | { type: 'reset'; id: number };

export interface SchemaInfo {
  tables: {
    name: string;
    columns: { name: string; type: string; nullable: boolean; primaryKey: boolean }[];
    indexes: { name: string; column: string; unique: boolean }[];
    primaryKey: string | null;
    rowCount: number;
  }[];
}

export type WorkerResponse =
  | {
      type: 'result';
      id: number;
      results: QueryResult[];
    }
  | { type: 'schema'; id: number; schema: SchemaInfo }
  | { type: 'export-json'; id: number; text: string }
  | { type: 'import-result'; id: number; tables: number; rows: number }
  | {
      type: 'error';
      id: number;
      message: string;
      line?: number;
      column?: number;
      kind?: string;
    };
