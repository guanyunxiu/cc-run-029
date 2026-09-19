// UI 主逻辑（原生 DOM）
import SqlWorker from '../worker?worker';
import { WorkerClient } from '../worker-client';
import type { QueryResult, SqlValue, TableDef } from '../sql/types';
import type { PlanNodeJSON } from '../sql/types';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel)!;

const editor = $('#sql-editor') as HTMLTextAreaElement;
const btnRun = $('#btn-run') as HTMLButtonElement;
const btnExplain = $('#btn-explain') as HTMLButtonElement;
const btnRefresh = $('#btn-refresh') as HTMLButtonElement;
const btnSample = $('#btn-sample') as HTMLButtonElement;
const messages = $('#messages') as HTMLDivElement;
const resultTable = $('#result-table') as HTMLTableElement;
const resultMeta = $('#result-meta') as HTMLDivElement;
const planView = $('#plan-view') as HTMLPreElement;
const tableList = $('#table-list') as HTMLUListElement;
const backendSelect = $('#backend-select') as HTMLSelectElement;
const fileInput = $('#file-input') as HTMLInputElement;

let client: WorkerClient;
let tables: TableDef[] = [];
let activeTable: string | null = null;
let lastResults: QueryResult[] = [];
let importMode: 'json' | 'sql' | 'csv-new' | 'csv-table' | null = null;

const SAMPLE_SQL = `-- 示例：部门与员工（可重复执行）
DROP TABLE IF EXISTS emp;
DROP TABLE IF EXISTS dept;
CREATE TABLE dept (
  id INTEGER PRIMARY KEY,
  dname TEXT NOT NULL
);
CREATE TABLE emp (
  id INTEGER PRIMARY KEY,
  ename TEXT NOT NULL,
  dept_id INTEGER,
  salary REAL,
  active BOOLEAN DEFAULT TRUE
);
CREATE INDEX idx_emp_dept ON emp(dept_id);
INSERT INTO dept (id, dname) VALUES (1, '研发部'), (2, '销售部'), (3, '市场部');
INSERT INTO emp (ename, dept_id, salary) VALUES
  ('Alice', 1, 12000), ('Bob', 1, 9500), ('Carol', 2, 8000),
  ('Dave', NULL, 15000), ('Eve', 2, 7000);

-- 各部门平均工资（只看有部门的员工）
SELECT d.dname AS 部门, COUNT(*) AS 人数, ROUND(AVG(e.salary), 2) AS 平均工资
FROM emp e JOIN dept d ON e.dept_id = d.id
GROUP BY d.dname
HAVING AVG(e.salary) > 7500
ORDER BY 平均工资 DESC;
`;

async function init(): Promise<void> {
  client = new WorkerClient(SqlWorker);
  try {
    await client.init('idb');
    msg('数据库已就绪（IndexedDB 持久化）', 'ok');
    await refreshTables();
  } catch (e) {
    msg(`初始化失败: ${(e as Error).message}`, 'err');
  }
  wireEvents();
}

function wireEvents(): void {
  btnRun.addEventListener('click', () => run(false));
  btnExplain.addEventListener('click', () => run(true));
  btnRefresh.addEventListener('click', refreshTables);
  btnSample.addEventListener('click', async () => {
    editor.value = SAMPLE_SQL;
    await run(false);
    await refreshTables();
  });
  editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void run(false);
    }
  });

  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  backendSelect.addEventListener('change', async () => {
    msg('切换存储后端需要刷新页面', 'info');
  });

  document.querySelectorAll<HTMLElement>('[data-export]').forEach((b) => {
    b.addEventListener('click', () => doExport(b.dataset.export!));
  });
  document.querySelectorAll<HTMLElement>('[data-import]').forEach((b) => {
    b.addEventListener('click', () => {
      importMode = b.dataset.import as typeof importMode;
      fileInput.value = '';
      fileInput.click();
    });
  });
  fileInput.addEventListener('change', doImportFile);
}

// ---------- 执行 ----------
async function run(explain: boolean): Promise<void> {
  const sql = editor.value.trim();
  if (!sql) return;
  clearMessages();
  try {
    const t0 = performance.now();
    const results = await client.exec(sql, explain);
    const ms = (performance.now() - t0).toFixed(1);
    lastResults = results;
    renderResults(results, explain);
    for (const r of results) {
      if (r.message) msg(r.message, 'ok');
    }
    const totalRows = results.reduce((n, r) => n + r.rowCount, 0);
    const affected = results.reduce((n, r) => n + (r.affectedRows ?? 0), 0);
    if (affected > 0) msg(`${results.length} 条语句执行完成，影响 ${affected} 行（${ms} ms）`, 'ok');
    else if (totalRows > 0) msg(`返回 ${totalRows} 行（${ms} ms）`, 'ok');
    else msg(`${results.length} 条语句执行完成（${ms} ms）`, 'info');
    await refreshTables();
  } catch (e) {
    renderError(e as Error & { line?: number; column?: number });
  }
}

// ---------- 渲染 ----------
function renderResults(results: QueryResult[], explain: boolean): void {
  resultTable.innerHTML = '';
  // 取最后一个有列的结果；DML 只有消息
  const withCols = results.filter((r) => r.columns.length > 0);
  const chosen = withCols[withCols.length - 1];
  resultMeta.textContent = '';
  if (!chosen) {
    resultTable.innerHTML = '';
    return;
  }
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  chosen.columns.forEach((c) => {
    const th = document.createElement('th');
    th.textContent = c.name;
    th.title = `类型: ${c.type}`;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  resultTable.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of chosen.rows) {
    const tr = document.createElement('tr');
    row.forEach((v, i) => {
      const td = document.createElement('td');
      formatCell(td, v, chosen.columns[i].type);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  resultTable.appendChild(tbody);
  resultMeta.textContent = `${chosen.columns.length} 列 × ${chosen.rowCount} 行${explain ? '（EXPLAIN：未执行）' : ''}`;

  if (chosen.plan) renderPlan(chosen.plan);
}

function formatCell(td: HTMLTableCellElement, v: SqlValue, _type: string): void {
  if (v === null || v === undefined) {
    td.textContent = 'NULL';
    td.classList.add('null');
    return;
  }
  if (typeof v === 'boolean') {
    td.textContent = v ? 'true' : 'false';
    td.classList.add('bool');
    return;
  }
  if (typeof v === 'number') {
    td.textContent = String(v);
    td.classList.add('num');
    return;
  }
  td.textContent = String(v);
}

function renderPlan(plan: PlanNodeJSON): void {
  planView.innerHTML = '';
  planView.appendChild(renderPlanNode(plan, 0, true));
}

function renderPlanNode(node: PlanNodeJSON, depth: number, isLast: boolean): HTMLElement {
  const wrap = document.createElement('div');
  const prefix = depth === 0 ? '' : '  '.repeat(depth - 1) + (isLast ? '└─ ' : '├─ ');
  const head = document.createElement('span');
  const op = document.createElement('span');
  op.className = 'plan-op';
  op.textContent = node.op;
  const detail = document.createElement('span');
  detail.className = 'plan-detail';
  detail.textContent = `  ${node.detail}`;
  const rows = document.createElement('span');
  rows.className = 'plan-rows';
  rows.textContent = `  [实际行数: ${node.actualRows ?? 0}]`;
  head.append(document.createTextNode(prefix), op, detail, rows);
  if (node.indexUsed) {
    const idx = document.createElement('div');
    idx.className = 'plan-idx';
    idx.textContent = `${'  '.repeat(depth + 1)}↳ 使用索引：${node.indexUsed}`;
    head.appendChild(idx);
  }
  wrap.appendChild(head);
  node.children.forEach((c, i) => {
    wrap.appendChild(renderPlanNode(c, depth + 1, i === node.children.length - 1));
  });
  return wrap;
}

function renderError(e: Error & { line?: number; column?: number }): void {
  const div = document.createElement('div');
  div.className = 'msg err';
  if (e.line && e.line > 0) {
    div.innerHTML = `<span class="loc">第 ${e.line} 行第 ${e.column} 列：</span> ${escapeHtml(stripLoc(e.message))}`;
  } else {
    div.textContent = `错误: ${e.message}`;
  }
  messages.appendChild(div);
}

function stripLoc(msg: string): string {
  return msg.replace(/^第 \d+ 行第 \d+ 列: /, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function msg(text: string, level: 'ok' | 'err' | 'info'): void {
  const div = document.createElement('div');
  div.className = `msg ${level}`;
  div.textContent = text;
  messages.appendChild(div);
}
function clearMessages(): void {
  messages.innerHTML = '';
}

// ---------- 表结构侧栏 ----------
async function refreshTables(): Promise<void> {
  try {
    tables = await client.listTables();
  } catch {
    return;
  }
  tableList.innerHTML = '';
  if (tables.length === 0) {
    const li = document.createElement('li');
    li.style.color = 'var(--muted)';
    li.textContent = '（暂无表）';
    tableList.appendChild(li);
    return;
  }
  for (const t of tables) {
    const li = document.createElement('li');
    if (t.name === activeTable) li.classList.add('active');
    const pkName = t.columns.find((c) => c.primaryKey)?.name;
    li.innerHTML = `<div class="tname">${escapeHtml(t.name)}</div>`;
    const cols = document.createElement('div');
    cols.className = 'cols';
    for (const c of t.columns) {
      const d = document.createElement('div');
      d.className = 'col-item';
      const flag = c.primaryKey ? ' <span class="pk">🔑PK</span>' : c.nullable === false ? ' NOT NULL' : '';
      d.innerHTML = `${c.primaryKey ? '<span class="pk">●</span> ' : '○ '}${escapeHtml(c.name)}: ${c.type}${flag}`;
      cols.appendChild(d);
    }
    const normalIdx = t.indexes.filter((i) => i.name !== `idx_${t.name}_pk_${pkName}`);
    for (const idx of normalIdx) {
      const d = document.createElement('div');
      d.className = 'idx';
      d.textContent = `  ⤷ ${idx.unique ? '唯一索引' : '索引'} ${idx.column}`;
      cols.appendChild(d);
    }
    li.appendChild(cols);
    li.addEventListener('click', async () => {
      activeTable = t.name;
      await showTableData(t.name);
      document.querySelectorAll('.table-list li').forEach((x) => x.classList.remove('active'));
      li.classList.add('active');
    });
    tableList.appendChild(li);
  }
}

async function showTableData(name: string): Promise<void> {
  try {
    const def = tables.find((t) => t.name === name)!;
    const rows = await client.getTableRows(name);
    const pseudo: QueryResult = {
      columns: def.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: rows.map((r) => def.columns.map((c) => (r[c.name] ?? null) as SqlValue)),
      rowCount: rows.length,
    };
    lastResults = [pseudo];
    renderResults([pseudo], false);
    planView.textContent = `浏览表 ${name}（非 SQL 查询，无执行计划）`;
  } catch (e) {
    msg((e as Error).message, 'err');
  }
}

// ---------- 导入导出 ----------
async function doExport(kind: string): Promise<void> {
  try {
    if (kind === 'json') {
      const data = await client.exportJson();
      downloadFile(`db-export-${stamp()}.json`, JSON.stringify(data, null, 2), 'application/json');
    } else if (kind === 'sql') {
      const script = await client.exportSql();
      downloadFile(`db-export-${stamp()}.sql`, script, 'text/plain');
    } else if (kind === 'csv') {
      if (!activeTable) return msg('请先在左侧选择一张表', 'err');
      const csv = await client.exportCsv(activeTable);
      downloadFile(`${activeTable}-${stamp()}.csv`, '﻿' + csv, 'text/csv');
    }
  } catch (e) {
    msg((e as Error).message, 'err');
  }
}

async function doImportFile(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file || !importMode) return;
  const text = await file.text();
  const baseName = file.name.replace(/\.[^.]+$/, '');
  try {
    if (importMode === 'json') {
      const data = JSON.parse(text);
      const r = await client.importJson(data);
      msg(`导入 JSON：${r.tables} 张表，${r.rows} 行`, 'ok');
    } else if (importMode === 'sql') {
      const r = await client.importSql(text);
      msg(`执行 SQL 脚本：${r.statements} 条语句`, 'ok');
    } else if (importMode === 'csv-new') {
      const table = promptSafe('新表名称', baseName);
      if (!table) return;
      const r = await client.importCsv(table, text, true);
      msg(`从 CSV 创建表 ${table} 并导入 ${r.rows} 行`, 'ok');
    } else if (importMode === 'csv-table') {
      if (!activeTable) return msg('请先在左侧选择目标表', 'err');
      const r = await client.importCsv(activeTable, text, false);
      msg(`CSV 导入表 ${activeTable}：${r.rows} 行`, 'ok');
    }
    await refreshTables();
  } catch (e) {
    msg(`导入失败: ${(e as Error).message}`, 'err');
  } finally {
    importMode = null;
  }
}

function promptSafe(label: string, dflt: string): string | null {
  return window.prompt(label, dflt);
}

function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  msg(`已导出 ${name}`, 'ok');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

void init();
