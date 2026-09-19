import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { chromium } from 'playwright';

// 在缺少系统库的环境中，使用随仓库脚本下载到 /tmp/deps 的依赖（若存在）
const localDeps = ['/tmp/deps/root/usr/lib/aarch64-linux-gnu', '/tmp/deps/root/lib/aarch64-linux-gnu'];
const existingDeps = localDeps.filter((d) => existsSync(d));
if (existingDeps.length) {
  process.env.LD_LIBRARY_PATH = [...existingDeps, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
// 默认使用完整 chromium（若安装了 headless shell 则由 Playwright 自行选择）
const chromiumPath = join(homedir(), '.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome');
const launchOpts = existsSync(chromiumPath)
  ? { executablePath: chromiumPath, args: ['--no-sandbox'] }
  : { args: ['--no-sandbox'] };

const root = join(process.cwd(), 'dist');
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };

const server = createServer(async (req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': mime[extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch(launchOpts);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() === 404) { errors.push('404: ' + r.url()); console.log('GOT404', r.url()); } });
page.on('requestfailed', (r) => console.log('REQFAIL', r.url(), r.failure()?.errorText));

await page.goto('http://localhost:4173/');
await page.waitForLoadState('networkidle');

// 输入建表+数据+查询
await page.fill('#editor', `
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
INSERT INTO users VALUES (1,'Alice',30),(2,'Bob',25),(3,'Carol',40);
SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC;
`);
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelectorAll('#result-table-wrap tbody tr').length === 2, { timeout: 8000 });

const headers = await page.$$eval('#result-table-wrap th', els => els.map(e => e.textContent.trim()));
const rows = await page.$$eval('#result-table-wrap tbody tr', trs =>
  trs.map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent)));
console.log('headers:', headers);
console.log('rows:', rows);

// 验证表结构树
await page.waitForSelector('.table-node .table-head');
const tableNames = await page.$$eval('.table-head', els => els.map(e => e.textContent.trim()));
console.log('schema tables:', tableNames);

// 验证执行计划
await page.fill('#editor', `EXPLAIN SELECT * FROM users WHERE id = 1`);
await page.click('#btn-run');
await page.click('.tab[data-tab="plan"]');
await page.waitForFunction(() => document.querySelector('#plan-view').textContent.includes('IndexScan'), { timeout: 5000 });
const plan = await page.textContent('#plan-view');
console.log('plan has IndexScan:', plan.includes('IndexScan'));

// 验证错误行列号
await page.fill('#editor', `SELECT bad FROM users`);
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelector('#messages .msg.error') !== null, { timeout: 5000 });
const errText = await page.textContent('#messages .msg.error');
console.log('error msg:', errText);

// IndexedDB 持久化：刷新后数据仍在
await page.reload({ waitUntil: 'networkidle' });
await page.fill('#editor', `SELECT COUNT(*) AS n FROM users`);
await page.click('#btn-run');
await page.waitForFunction(() => document.querySelectorAll('#result-table-wrap tbody tr').length === 1, { timeout: 8000 });
const afterReload = await page.textContent('#result-table-wrap td');
console.log('count after reload:', afterReload);

let ok = true;
if (headers.join(',') !== 'name,INTEGERAGE,INTEGER') { /* age 列类型标签 */ }
if (rows.length !== 2 || rows[0][0] !== 'Carol') { console.error('RESULT MISMATCH'); ok = false; }
if (!tableNames.some(t => t.includes('users'))) { console.error('SCHEMA MISSING'); ok = false; }
if (!plan.includes('IndexScan')) { console.error('PLAN MISSING INDEX'); ok = false; }
if (!/BIND ERROR \[1:8\]/.test(errText)) { console.error('ERROR POSITION WRONG:', errText); ok = false; }
if (afterReload.trim() !== '3') { console.error('PERSISTENCE FAIL'); ok = false; }
if (errors.length) { console.error('PAGE ERRORS:', errors); ok = false; }

await browser.close();
server.close();
console.log(ok ? 'E2E OK' : 'E2E FAILED');
process.exit(ok ? 0 : 1);
