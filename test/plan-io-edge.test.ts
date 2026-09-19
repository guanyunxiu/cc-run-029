import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Session } from '../src/engine/session';
import { exportCsv, parseCsv, buildExport, exportToSqlScript } from '../src/engine/import-export';

async function newSession() {
  const storage = new MemoryStorage();
  await storage.init();
  return new Session(storage);
}
async function one(db: Session, sql: string) {
  return (await db.execute(sql))[0].rows[0]?.[0] ?? null;
}

describe('执行计划', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
      CREATE INDEX idx_t_age ON t(age);
      INSERT INTO t (name,age) VALUES ('a',10),('b',20),('c',30);
    `);
  });

  it('等值主键查询走索引', async () => {
    const r = await db.execute(`EXPLAIN SELECT * FROM t WHERE id = 1`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('INDEX_SCAN');
    expect(plan).toContain('idx_t_pk_id');
  });

  it('普通索引等值查询标注索引', async () => {
    const r = await db.execute(`EXPLAIN SELECT * FROM t WHERE age = 20`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('INDEX_SCAN');
    expect(plan).toContain('idx_t_age');
  });

  it('无索引条件全表扫描', async () => {
    const r = await db.execute(`EXPLAIN SELECT * FROM t WHERE name = 'a'`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('TABLE_SCAN');
    expect(plan).not.toContain('INDEX_SCAN');
  });

  it('计划包含过滤/投影/限制算子', async () => {
    const r = await db.execute(`EXPLAIN SELECT name FROM t WHERE age > 5 ORDER BY age LIMIT 2`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('FILTER');
    expect(plan).toContain('PROJECT');
    expect(plan).toContain('SORT');
    expect(plan).toContain('LIMIT_OFFSET');
  });

  it('JOIN 计划标注连接算子', async () => {
    await db.execute(`CREATE TABLE u (id INTEGER PRIMARY KEY, tid INTEGER)`);
    const r = await db.execute(`EXPLAIN SELECT * FROM t JOIN u ON t.id = u.tid`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('INNER_JOIN');
  });

  it('聚合计划', async () => {
    const r = await db.execute(`EXPLAIN SELECT age, COUNT(*) FROM t GROUP BY age HAVING COUNT(*) > 0`);
    const plan = JSON.stringify(r[0].plan);
    expect(plan).toContain('HASH_AGGREGATE');
  });

  it('执行后计划含实际行数', async () => {
    const r = await db.execute(`SELECT * FROM t WHERE age > 15`);
    expect(r[0].rowCount).toBe(2);
    const m = JSON.stringify(r[0].plan).match(/"actualRows":(\d+)/);
    expect(m).not.toBeNull();
  });
});

describe('导入导出', () => {
  it('CSV 往返', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL);
      INSERT INTO t (name,score) VALUES ('Alice, Jr.', 99.5), ('Bob "B"', 80);`);
    const def = await db.getTableDef('t')!;
    const rows = await db.getTableRows('t');
    const csv = exportCsv(def!, rows);
    expect(csv).toContain('"Alice, Jr."');
    expect(csv).toContain('"Bob ""B"""');
    const parsed = parseCsv(csv);
    expect(parsed.columns).toEqual(['id', 'name', 'score']);
    expect(parsed.rows[1][1]).toBe('Bob "B"');
  });

  it('JSON 导出结构', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x');`);
    const tables = [];
    for (const d of await db.listTables()) {
      tables.push({ definition: d, rows: await db.getTableRows(d.name) });
    }
    const exp = buildExport(tables);
    expect(exp.format).toBe('browser-sql-export');
    expect(exp.tables[0].definition.name).toBe('t');
    expect(exp.tables[0].rows[0].v).toBe('x');
    expect(JSON.parse(JSON.stringify(exp)).tables[0].rows).toHaveLength(1);
  });

  it('SQL 脚本可重新导入', async () => {
    const db1 = await newSession();
    await db1.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE);
      INSERT INTO t (v) VALUES ('a'),('b');`);
    const tables = [];
    for (const d of await db1.listTables()) {
      tables.push({ definition: d, rows: await db1.getTableRows(d.name) });
    }
    const script = exportToSqlScript(tables);
    expect(script).toContain('CREATE TABLE');
    expect(script).toContain('CREATE UNIQUE INDEX');
    const db2 = await newSession();
    await db2.execute(script);
    expect(await one(db2, `SELECT COUNT(*) FROM t`)).toBe(2);
  });
});

describe('边界情况', () => {
  it('空表查询', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    const r = await db.execute(`SELECT * FROM t`);
    expect(r[0].rows).toEqual([]);
    expect(r[0].rowCount).toBe(0);
  });

  it('LIMIT 超过行数', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2);`);
    const r = await db.execute(`SELECT * FROM t LIMIT 100 OFFSET 5`);
    expect(r[0].rows).toEqual([]);
  });

  it('OFFSET 0 / LIMIT 0', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2);`);
    expect((await db.execute(`SELECT * FROM t LIMIT 0`))[0].rows).toEqual([]);
    expect((await db.execute(`SELECT * FROM t LIMIT 1 OFFSET 0`))[0].rows).toHaveLength(1);
  });

  it('大整数与浮点', async () => {
    const db = await newSession();
    const third = 1 / 3;
    await db.execute(
      `CREATE TABLE t (a INTEGER, b REAL); INSERT INTO t VALUES (10000000000, ${String(third)});`,
    );
    const r = (await db.execute(`SELECT a, b FROM t`))[0].rows;
    expect(r[0][0]).toBe(10000000000);
    expect(Math.abs((r[0][1] as number) - third)).toBeLessThan(1e-16);
  });

  it('字符串转义单引号', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('it''s ok')`);
    expect(await one(db, `SELECT s FROM t`)).toBe("it's ok");
  });

  it('多行 VALUES 插入', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER); INSERT INTO t (v) VALUES (1),(2),(3);`);
    expect(await one(db, `SELECT COUNT(*) FROM t`)).toBe(3);
  });

  it('UPDATE 自增表达式', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, c INTEGER); INSERT INTO t (c) VALUES (10);`);
    await db.execute(`UPDATE t SET c = c + 1 WHERE id = 1`);
    expect(await one(db, `SELECT c FROM t`)).toBe(11);
  });

  it('DELETE 全表后可重新插入', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2); DELETE FROM t;`);
    await db.execute(`INSERT INTO t VALUES (3);`);
    expect(await one(db, `SELECT COUNT(*) FROM t`)).toBe(1);
  });

  it('IF NOT EXISTS / IF EXISTS', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)`);
    await db.execute(`DROP TABLE IF EXISTS ghost`);
    expect(true).toBe(true);
  });

  it('全部分页边界 OFFSET = 行数', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1),(2),(3);`);
    expect((await db.execute(`SELECT * FROM t ORDER BY id LIMIT 2 OFFSET 2`))[0].rows).toEqual([[3]]);
    expect((await db.execute(`SELECT * FROM t ORDER BY id LIMIT 2 OFFSET 3`))[0].rows).toEqual([]);
  });
});

describe('普通索引语义', () => {
  it('普通单列索引允许重复值，只有 UNIQUE/主键才冲突', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, dept_id INTEGER);
      CREATE INDEX ix_dept ON t(dept_id);`);
    await db.execute(`INSERT INTO t (dept_id) VALUES (1),(1),(2),(NULL),(NULL);`);
    expect(await one(db, `SELECT COUNT(*) FROM t`)).toBe(5);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE dept_id = 1`)).toBe(2);
    // 走普通索引的计划仍然正确
    const plan = JSON.stringify((await db.execute(`EXPLAIN SELECT * FROM t WHERE dept_id = 1`))[0].plan);
    expect(plan).toContain('ix_dept');
  });
});
