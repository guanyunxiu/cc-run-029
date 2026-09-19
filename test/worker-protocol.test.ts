// 通过模拟 self 直接驱动 worker 消息处理，验证协议端到端
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../src/protocol';
import type { WorkerRequestWithoutId } from '../src/worker-client';

let nextId: number;
const replies = new Map<number, WorkerResponse>();
let workerSelf: {
  onmessage: ((ev: { data: WorkerRequest }) => void | Promise<void>) | null;
  postMessage: (m: WorkerResponse) => void;
};

async function loadWorker(): Promise<void> {
  nextId = 1;
  replies.clear();
  workerSelf = {
    onmessage: null,
    postMessage: (m) => replies.set(m.id, m),
  };
  (globalThis as unknown as { self: unknown }).self = workerSelf;
  vi.resetModules();
  await import('../src/worker');
}

async function send(req: WorkerRequestWithoutId): Promise<WorkerResponse> {
  const id = nextId++;
  const full = { ...req, id } as WorkerRequest;
  await workerSelf.onmessage!({ data: full });
  for (let i = 0; i < 400; i++) {
    const r = replies.get(id);
    if (r) return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('worker 超时未响应');
}

describe('Worker 协议端到端', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('init -> DDL/DML -> 查询 -> 列表/数据 -> 导出 往返', async () => {
    await loadWorker();
    expect((await send({ type: 'init', backend: 'memory' })).ok).toBe(true);

    const ddl = await send({
      type: 'exec',
      sql: `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'),('b');`,
      explain: false,
    });
    expect(ddl.ok).toBe(true);

    const q = await send({ type: 'exec', sql: `SELECT COUNT(*) AS c FROM t`, explain: false });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.results![0].rows).toEqual([[2]]);

    const tables = await send({ type: 'listTables' });
    expect(tables.ok).toBe(true);
    if (tables.ok) expect((tables.data as { name: string }[]).map((t) => t.name)).toEqual(['t']);

    const rows = await send({ type: 'getTableRows', table: 't' });
    expect(rows.ok).toBe(true);

    const csv = await send({ type: 'exportCsv', table: 't' });
    expect(csv.ok).toBe(true);
    if (csv.ok) expect(String(csv.data)).toContain('a');

    const json = await send({ type: 'exportJson' });
    expect(json.ok).toBe(true);

    const sql = await send({ type: 'exportSql' });
    expect(sql.ok).toBe(true);
    expect(String((sql as { ok: true; data: unknown }).data)).toContain('CREATE TABLE');
  });

  it('JSON 导入', async () => {
    await loadWorker();
    await send({ type: 'init', backend: 'memory' });
    const r = await send({
      type: 'importJson',
      data: {
        format: 'browser-sql-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        tables: [
          {
            definition: {
              name: 'imp',
              columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
              indexes: [{ name: 'idx_imp_pk_id', table: 'imp', column: 'id', unique: true }],
            },
            rows: [{ id: 1 }, { id: 2 }],
          },
        ],
      },
    });
    expect(r.ok).toBe(true);
    const q = await send({ type: 'exec', sql: `SELECT COUNT(*) FROM imp`, explain: false });
    if (q.ok) expect(q.results![0].rows).toEqual([[2]]);
  });

  it('CSV 导入新表', async () => {
    await loadWorker();
    await send({ type: 'init', backend: 'memory' });
    const r = await send({
      type: 'importCsv',
      table: 'people',
      text: 'id,name\r\n1,Alice\r\n2,Bob\r\n',
      create: true,
    });
    expect(r.ok).toBe(true);
    const q = await send({ type: 'exec', sql: `SELECT name FROM people ORDER BY id`, explain: false });
    if (q.ok) expect(q.results![0].rows).toEqual([['Alice'], ['Bob']]);
  });

  it('语法错误返回行列号', async () => {
    await loadWorker();
    await send({ type: 'init', backend: 'memory' });
    const r = await send({ type: 'exec', sql: `SELECT * FRUM t`, explain: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBeGreaterThan(0);
      expect(r.error.message).toMatch(/第\s*1\s*行/);
    }
  });

  it('EXPLAIN 返回计划且不返回数据行', async () => {
    await loadWorker();
    await send({ type: 'init', backend: 'memory' });
    await send({ type: 'exec', sql: `CREATE TABLE t (id INTEGER PRIMARY KEY);`, explain: false });
    const r = await send({ type: 'exec', sql: `SELECT * FROM t WHERE id=1`, explain: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results![0].plan?.op).toBeDefined();
      expect(r.results![0].rowCount).toBe(0);
    }
  });
});
