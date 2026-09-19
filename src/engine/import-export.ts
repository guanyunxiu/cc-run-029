// 数据导入导出：JSON（结构+数据）与 CSV
import { Row, SqlValue, TableDef } from '../sql/types';

export interface DatabaseExport {
  format: 'browser-sql-export';
  version: 1;
  exportedAt: string;
  tables: {
    definition: TableDef;
    rows: Row[];
  }[];
}

/** 导出整个数据库为 JSON 对象 */
export function buildExport(tables: { definition: TableDef; rows: Row[] }[]): DatabaseExport {
  return {
    format: 'browser-sql-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

/** 生成建表 + 插入的 SQL 脚本 */
export function exportToSqlScript(tables: { definition: TableDef; rows: Row[] }[]): string {
  const lines: string[] = [];
  for (const t of tables) {
    const d = t.definition;
    const colDefs = d.columns.map((c) => {
      const parts = [c.name, c.type];
      if (c.primaryKey) parts.push('PRIMARY KEY');
      if (c.nullable === false && !c.primaryKey) parts.push('NOT NULL');
      if (c.default !== undefined) parts.push(`DEFAULT ${sqlLiteral(c.default)}`);
      return parts.join(' ');
    });
    // UNIQUE 单列约束以 CREATE UNIQUE INDEX 形式导出
    lines.push(`CREATE TABLE ${ident(d.name)} (${colDefs.join(', ')});`);
    for (const idx of d.indexes) {
      if (idx.name.startsWith(`idx_${d.name}_pk_`)) continue;
      lines.push(
        `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${ident(idx.name)} ON ${ident(d.name)} (${ident(idx.column)});`,
      );
    }
    if (t.rows.length > 0) {
      const cols = d.columns.map((c) => ident(c.name)).join(', ');
      const batches: string[] = [];
      for (const row of t.rows) {
        const vals = d.columns.map((c) => sqlLiteral(row[c.name] ?? null)).join(', ');
        batches.push(`(${vals})`);
      }
      // 每行一条，避免单条过长
      for (const b of batches) {
        lines.push(`INSERT INTO ${ident(d.name)} (${cols}) VALUES ${b};`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function ident(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

export function sqlLiteral(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** 把一张表导出为 CSV 文本 */
export function exportCsv(def: TableDef, rows: Row[]): string {
  const header = def.columns.map((c) => csvEscape(c.name)).join(',');
  const lines = rows.map((r) =>
    def.columns
      .map((c) => {
        const v = r[c.name] ?? null;
        if (v === null) return '';
        return csvEscape(formatCsvValue(v));
      })
      .join(','),
  );
  return [header, ...lines].join('\r\n');
}

function formatCsvValue(v: SqlValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export interface CsvParseResult {
  columns: string[];
  rows: string[][];
}

/** 解析 CSV（支持引号、双引号转义、CRLF/LF） */
export function parseCsv(text: string): CsvParseResult {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
      i++;
    } else if (ch === '\n') {
      pushRow();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // 最后一行（无换行结尾）
  if (field.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return { columns: [], rows: [] };
  const [columns, ...dataRows] = rows;
  // 去掉完全空的尾部行
  const nonEmpty = dataRows.filter((r) => !(r.length === 1 && r[0] === ''));
  return { columns, rows: nonEmpty };
}
