// ============================================================
// 前端主逻辑：Worker 通信、编辑器、结果/计划渲染、结构树、导入导出
// ============================================================

import type { WorkerRequest, WorkerResponse, SchemaInfo } from '../shared/protocol';
import type { QueryResult } from '../engine/engine';
import type { DBValue, Row } from '../sql/types';

const worker = new Worker(new URL('../worker/sql.worker.ts', import.meta.url), { type: 'module' });

let nextId = 1;
const pending = new Map<number, {
  resolve: (r: WorkerResponse) => void;
  reject: (e: Error) => void;
}>();

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const msg = ev.data;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'error') {
    p.reject(Object.assign(new Error(msg.message), {
      line: msg.line, column: msg.column, kind: msg.kind,
    }));
  } else {
    p.resolve(msg);
  }
};

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
function call(req: DistributiveOmit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...req, id } as WorkerRequest);
  });
}

// ------------------------------------------------------------
// DOM
// ------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

const editor = $<HTMLTextAreaElement>('#editor');
const btnRun = $('#btn-run');
const btnExplain = $('#btn-explain');
const btnFormat = $('#btn-format');
const btnExportJson = $('#btn-export-json');
const btnExportCsv = $('#btn-export-csv');
const btnImportJson = $('#btn-import-json');
const btnImportCsv = $('#btn-import-csv');
const btnReset = $('#btn-reset');
const btnRefresh = $('#btn-refresh');
const messagesEl = $('#messages');
const msgSummary = $('#msg-summary');
const resultWrap = $('#result-table-wrap');
const resultMeta = $('#result-meta');
const planView = $('#plan-view');
const schemaTree = $('#schema-tree');
const fileInput = $<HTMLInputElement>('#file-input');
const txnBadge = $('#txn-badge');
const examplesEl = $('#examples');

let currentResults: QueryResult[] = [];

// ------------------------------------------------------------
// 执行
// ------------------------------------------------------------
async function runSQL(explainOnly = false): Promise<void> {
  let sql = editor.value.trim();
  if (!sql) {
    addMessage('请输入 SQL 语句。', 'info');
    return;
  }
  if (explainOnly && !/^\s*EXPLAIN/i.test(sql)) {
    // 只对第一条 SELECT 包裹 EXPLAIN
    sql = `EXPLAIN ${sql}`;
  }
  const started = performance.now();
  addMessage(`▶ ${sql.replace(/\s+/g, ' ').slice(0, 200)}`, 'info');
  try {
    const resp = await call({ type: 'exec', sql });
    if (resp.type !== 'result') return;
    currentResults = resp.results;
    const elapsed = (performance.now() - started).toFixed(1);
    renderResults(resp.results, elapsed);
    renderPlans(resp.results);
    renderMessages(resp.results);
    watchTxn(sql, resp.results);
    await refreshSchema();
  } catch (e) {
    renderError(e as ErrorInfo);
    // 事务可能仍在进行（BEGIN 后某条失败）；刷新结构/徽标
    void refreshSchema();
  }
}

interface ErrorInfo extends Error {
  line?: number;
  column?: number;
  kind?: string;
}

function renderError(err: ErrorInfo): void {
  const loc = err.line ? ` [${err.line}:${err.column}]` : '';
  const kind = err.kind ? `${err.kind} ERROR` : 'ERROR';
  addMessage(`${kind}${loc}: ${err.message}`, 'error');
  msgSummary.textContent = '执行失败';
  resultWrap.innerHTML = '<div class="hint">查询执行出错，请查看消息面板。</div>';
}

function renderMessages(results: QueryResult[]): void {
  let total = 0;
  for (const r of results) {
    addMessage(`✓ ${r.message}`, 'ok');
    total += r.rowsAffected;
  }
  msgSummary.textContent = `${results.length} 条语句执行成功`;
}

let txnActive = false;
function watchTxn(sql: string, _results: QueryResult[]): void {
  // 按成功执行的语句跟踪事务状态
  const stmts = sql.split(';').map((s) => s.trim().toUpperCase());
  for (const s of stmts) {
    if (s.startsWith('BEGIN')) txnActive = true;
    else if (s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) txnActive = false;
  }
  txnBadge.classList.toggle('hidden', !txnActive);
}

// ------------------------------------------------------------
// 结果表格
// ------------------------------------------------------------
function renderResults(results: QueryResult[], elapsed: string): void {
  // 找最后一个有列的结果；否则显示影响行数信息
  const selects = results.filter((r) => r.columns.length > 0);
  const target = selects[selects.length - 1];
  if (!target) {
    const writes = results.filter((r) => r.rowsAffected > 0);
    resultWrap.innerHTML = writes.length
      ? `<div class="hint">语句执行成功，共影响 ${writes.reduce((a, r) => a + r.rowsAffected, 0)} 行。</div>`
      : '<div class="hint">语句执行成功（无结果集）。</div>';
    resultMeta.textContent = `耗时 ${elapsed} ms`;
    return;
  }
  resultMeta.textContent =
    `${target.rows.length} 行 · ${target.columns.length} 列 · 耗时 ${elapsed} ms`;

  const head = target.columns.map((c) =>
    `<th>${escapeHtml(c.name)}${c.type && c.type !== 'ANY' ? `<span class="type">${escapeHtml(c.type)}</span>` : ''}</th>`).join('');
  const body = target.rows.map((row) => {
    const tds = target.columns.map((c) => {
      const v = row[c.name];
      return `<td${cellClass(v)}>${formatCell(v)}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');
  resultWrap.innerHTML =
    `<table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function cellClass(v: DBValue): string {
  if (v === null) return ' class="null"';
  if (typeof v === 'number') return ' class="num"';
  if (typeof v === 'boolean') return ' class="bool"';
  return '';
}

function formatCell(v: DBValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return escapeHtml(String(v));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// 执行计划
// ------------------------------------------------------------
function renderPlans(results: QueryResult[]): void {
  const explain = results.filter((r) => r.plan);
  if (explain.length === 0) {
    // 普通查询不覆盖已有计划视图，只在没有时提示
    if (!planView.dataset.sticky) {
      planView.textContent = '执行 EXPLAIN 或点击「计划」查看。';
    }
    return;
  }
  const parts: string[] = [];
  for (const r of explain) {
    const p = r.plan!;
    parts.push(
      `── 逻辑计划 ──\n${p.logical}\n\n` +
      `── 物理计划 ──\n${p.physical}\n\n` +
      `── 统计 ──\n` +
      `扫描行数: ${p.stats.rowsScanned}  输出行数: ${p.stats.rowsOutput}\n` +
      `索引查找: ${p.stats.indexLookups}  Hash 表: ${p.stats.hashJoinsBuilt}\n` +
      `常量折叠: ${p.optimizer.foldedConstants}  谓词下推: ${p.optimizer.pushedPredicates}`,
    );
  }
  planView.textContent = parts.join('\n\n');
  planView.dataset.sticky = '1';
}

// ------------------------------------------------------------
// 消息
// ------------------------------------------------------------
function addMessage(text: string, level: 'ok' | 'info' | 'error'): void {
  const div = document.createElement('div');
  div.className = `msg ${level}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ------------------------------------------------------------
// 结构树
// ------------------------------------------------------------
async function refreshSchema(): Promise<void> {
  const resp = await call({ type: 'schema' });
  if (resp.type !== 'schema') return;
  renderSchema(resp.schema);
}

function renderSchema(schema: SchemaInfo): void {
  if (schema.tables.length === 0) {
    schemaTree.innerHTML = '<div class="hint">尚无表，先执行 CREATE TABLE。</div>';
    return;
  }
  schemaTree.innerHTML = schema.tables.map((t) => {
    const cols = t.columns.map((c) => {
      const badges = [
        c.primaryKey ? '<span class="badge pk">PK</span>' : '',
        !c.nullable && !c.primaryKey ? '<span class="badge nn">NN</span>' : '',
      ].join('');
      return `<div class="col-row" data-table="${escapeAttr(t.name)}" data-col="${escapeAttr(c.name)}">
        <span class="col-name">${escapeHtml(c.name)}</span>
        <span>${escapeHtml(c.type)}</span>${badges}</div>`;
    }).join('');
    const idxs = t.indexes
      .filter((i) => !i.name.startsWith('__auto_'))
      .map((i) => `<div class="index-row">↳ ${i.unique ? 'UNIQUE ' : ''}INDEX ${escapeHtml(i.name)}(${escapeHtml(i.column)})</div>`)
      .join('');
    return `<div class="table-node">
      <div class="table-head" data-table="${escapeAttr(t.name)}">
        <span>▦ ${escapeHtml(t.name)}</span><span class="count">${t.rowCount} 行</span>
      </div>
      <div class="columns">${cols}</div>
      ${idxs ? `<div class="index-list">${idxs}</div>` : ''}
    </div>`;
  }).join('');

  // 点击表名 -> SELECT *；点击列名 -> 插入到编辑器
  schemaTree.querySelectorAll('.table-head').forEach((el) => {
    el.addEventListener('click', () => {
      editor.value = `SELECT * FROM ${el.getAttribute('data-table')};`;
      void runSQL();
    });
  });
  schemaTree.querySelectorAll('.col-row').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const t = el.getAttribute('data-table');
      const c = el.getAttribute('data-col');
      editor.value = `SELECT ${c} FROM ${t};`;
    });
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ------------------------------------------------------------
// 导入导出
// ------------------------------------------------------------
function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

btnExportJson.addEventListener('click', async () => {
  const resp = await call({ type: 'export-json' });
  if (resp.type === 'export-json') {
    download(`mini-sql-${Date.now()}.json`, resp.text, 'application/json');
    addMessage('数据库已导出为 JSON。', 'ok');
  }
});

btnExportCsv.addEventListener('click', () => {
  const target = currentResults.filter((r) => r.columns.length > 0).pop();
  if (!target || target.rows.length === 0) {
    addMessage('没有可导出的查询结果。', 'info');
    return;
  }
  const text = resultToCSV(target);
  download(`result-${Date.now()}.csv`, text, 'text/csv');
  addMessage(`已导出 ${target.rows.length} 行到 CSV。`, 'ok');
});

function resultToCSV(r: QueryResult): string {
  const cols = r.columns.map((c) => c.name);
  const esc = (v: DBValue): string => {
    if (v === null) return '';
    const s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(esc).join(',')];
  for (const row of r.rows as Row[]) {
    lines.push(cols.map((c) => esc(row[c] ?? null)).join(','));
  }
  return lines.join('\n');
}

let pendingImport: { kind: 'json' } | { kind: 'csv'; table: string } | null = null;
btnImportJson.addEventListener('click', () => { pendingImport = { kind: 'json' }; fileInput.click(); });
btnImportCsv.addEventListener('click', () => {
  const table = prompt('导入到哪张表？（输入表名）');
  if (!table) return;
  pendingImport = { kind: 'csv', table };
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file || !pendingImport) return;
  const text = await file.text();
  try {
    if (pendingImport.kind === 'json') {
      const resp = await call({ type: 'import-json', text });
      if (resp.type === 'import-result') {
        addMessage(`导入完成：${resp.tables} 张表，${resp.rows} 行。`, 'ok');
      }
    } else {
      const table = pendingImport.table;
      const resp = await call({ type: 'import-csv', table, text });
      if (resp.type === 'import-result') {
        addMessage(`CSV 导入完成：${resp.rows} 行 → 表 ${table}。`, 'ok');
      }
    }
  } catch (e) {
    renderError(e as ErrorInfo);
  }
  pendingImport = null;
  await refreshSchema();
});

btnReset.addEventListener('click', async () => {
  if (!confirm('确定清空整个数据库？此操作不可撤销。')) return;
  await call({ type: 'reset' });
  txnActive = false;
  txnBadge.classList.add('hidden');
  addMessage('数据库已清空。', 'info');
  await refreshSchema();
});

// ------------------------------------------------------------
// 格式化（简单 SQL 美化）
// ------------------------------------------------------------
btnFormat.addEventListener('click', () => {
  editor.value = formatSQL(editor.value);
});

function formatSQL(sql: string): string {
  const keywords = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
    'INNER JOIN', 'LEFT JOIN', 'JOIN', 'ON', 'AND', 'OR', 'VALUES', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK'];
  let out = sql.replace(/\s+/g, ' ').trim();
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw.replace(' ', '\\s+')}\\b`, 'gi');
    out = out.replace(re, (m) => `\n${kw === 'AND' || kw === 'OR' ? '  ' : ''}${m.toUpperCase()}`);
  }
  // SELECT 列表逗号换行
  out = out.replace(/,\s+(?![^(]*\))/g, ',\n  ');
  return out.trim();
}

// ------------------------------------------------------------
// 示例
// ------------------------------------------------------------
const EXAMPLES: { label: string; sql: string }[] = [
  {
    label: '示例库（电商）',
    sql: `CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, vip BOOLEAN);
CREATE TABLE orders (id INTEGER PRIMARY KEY, cid INTEGER, amount REAL, created TEXT);
INSERT INTO customers VALUES
 (1,'Alice','Beijing',true),(2,'Bob','Shanghai',false),(3,'Carol','Beijing',true),(4,'Dave','Shenzhen',false);
INSERT INTO orders VALUES
 (101,1,299.0,'2024-01-03'),(102,1,59.5,'2024-02-11'),(103,2,1200.0,'2024-02-18'),
 (104,3,88.0,'2024-03-01'),(105,1,NULL,'2024-03-09');
CREATE INDEX idx_orders_cid ON orders(cid);`,
  },
  { label: 'JOIN 查询', sql: `SELECT c.name, COUNT(o.id) AS order_count, SUM(o.amount) AS total
FROM customers c
LEFT JOIN orders o ON o.cid = c.id
GROUP BY c.id ORDER BY order_count DESC;` },
  {
    label: '聚合 + HAVING',
    sql: `SELECT city, COUNT(*) cnt, AVG(amount) avg_amt
FROM customers c JOIN orders o ON o.cid = c.id
GROUP BY city HAVING COUNT(*) >= 1 ORDER BY avg_amt DESC;`,
  },
  { label: 'IN 子查询', sql: `SELECT name FROM customers
WHERE id IN (SELECT cid FROM orders WHERE amount > 100);` },
  { label: '事务回滚', sql: `BEGIN;
UPDATE customers SET vip = true WHERE city = 'Beijing';
ROLLBACK;` },
];

for (const ex of EXAMPLES) {
  const b = document.createElement('button');
  b.textContent = ex.label;
  b.addEventListener('click', () => { editor.value = ex.sql; });
  examplesEl.appendChild(b);
}

// ------------------------------------------------------------
// 快捷键
// ------------------------------------------------------------
editor.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
    ev.preventDefault();
    void runSQL();
  }
  // Tab 插入两个空格
  if (ev.key === 'Tab') {
    ev.preventDefault();
    const s = editor.selectionStart;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(editor.selectionEnd);
    editor.selectionStart = editor.selectionEnd = s + 2;
  }
});
btnRun.addEventListener('click', () => void runSQL());
btnExplain.addEventListener('click', () => void runSQL(true));
btnRefresh.addEventListener('click', () => void refreshSchema());

// 初始化
void refreshSchema();
