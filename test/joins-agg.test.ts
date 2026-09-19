import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Session } from '../src/engine/session';

async function newSession() {
  const storage = new MemoryStorage();
  await storage.init();
  return new Session(storage);
}

async function rows(db: Session, sql: string) {
  return (await db.execute(sql))[0].rows;
}

async function one(db: Session, sql: string) {
  const r = await rows(db, sql);
  return r[0]?.[0] ?? null;
}

describe('JOIN', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE dept (id INTEGER PRIMARY KEY, dname TEXT);
      CREATE TABLE emp (
        id INTEGER PRIMARY KEY,
        ename TEXT,
        dept_id INTEGER,
        salary REAL
      );
      INSERT INTO dept (dname) VALUES ('Engineering'), ('Sales'), ('Empty');
      INSERT INTO emp (ename, dept_id, salary) VALUES
        ('Alice', 1, 100.5), ('Bob', 1, 200), ('Carol', 2, NULL), ('Dave', NULL, 999);
    `);
  });

  it('INNER JOIN', async () => {
    const r = await rows(db, `
      SELECT e.ename, d.dname FROM emp e
      INNER JOIN dept d ON e.dept_id = d.id
      ORDER BY e.ename
    `);
    expect(r).toEqual([
      ['Alice', 'Engineering'],
      ['Bob', 'Engineering'],
      ['Carol', 'Sales'],
    ]);
  });

  it('INNER JOIN 用 JOIN 关键字', async () => {
    const r = await rows(db, `SELECT COUNT(*) FROM emp JOIN dept ON emp.dept_id = dept.id`);
    expect(r).toEqual([[3]]);
  });

  it('LEFT JOIN 保留左表无匹配行并补 NULL', async () => {
    const r = await rows(db, `
      SELECT e.ename, d.dname FROM emp e
      LEFT JOIN dept d ON e.dept_id = d.id
      ORDER BY e.ename
    `);
    expect(r).toEqual([
      ['Alice', 'Engineering'],
      ['Bob', 'Engineering'],
      ['Carol', 'Sales'],
      ['Dave', null],
    ]);
  });

  it('LEFT JOIN 右表过滤条件放在 ON 与 WHERE 的语义差异', async () => {
    // ON 上的条件：不满足仍保留左行
    const on = await rows(db, `
      SELECT e.ename, d.dname FROM emp e
      LEFT JOIN dept d ON e.dept_id = d.id AND d.dname = 'Sales'
      ORDER BY e.ename
    `);
    expect(on).toEqual([
      ['Alice', null],
      ['Bob', null],
      ['Carol', 'Sales'],
      ['Dave', null],
    ]);
  });

  it('JOIN + WHERE 组合', async () => {
    const r = await rows(db, `
      SELECT e.ename FROM emp e JOIN dept d ON e.dept_id = d.id
      WHERE d.dname = 'Engineering' AND e.salary > 150
      ORDER BY e.ename
    `);
    expect(r).toEqual([['Bob']]);
  });

  it('笛卡尔积（逗号连接）', async () => {
    const r = await rows(db, `SELECT COUNT(*) FROM emp, dept`);
    expect(r).toEqual([[12]]);
  });

  it('表别名与列别名', async () => {
    const res = await db.execute(`SELECT e.ename AS name, e.salary s FROM emp e WHERE e.ename='Bob'`);
    expect(res[0].columns.map((c) => c.name)).toEqual(['name', 's']);
    expect(res[0].rows).toEqual([['Bob', 200]]);
  });
});

describe('聚合', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE t (g TEXT, v INTEGER);
      INSERT INTO t (g, v) VALUES ('a', 1), ('a', 2), ('a', 3), ('b', 10), ('b', NULL), ('c', NULL);
    `);
  });

  it('COUNT(*)', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t`)).toBe(6);
  });

  it('COUNT(col) 忽略 NULL', async () => {
    expect(await one(db, `SELECT COUNT(v) FROM t`)).toBe(4);
  });

  it('SUM/AVG/MIN/MAX', async () => {
    const r = await rows(db, `SELECT SUM(v), AVG(v), MIN(v), MAX(v) FROM t`);
    expect(r[0][0]).toBe(16);
    expect(r[0][1]).toBe(4);
    expect(r[0][2]).toBe(1);
    expect(r[0][3]).toBe(10);
  });

  it('GROUP BY', async () => {
    const r = await rows(db, `SELECT g, SUM(v) FROM t GROUP BY g ORDER BY g`);
    expect(r).toEqual([['a', 6], ['b', 10], ['c', null]]);
  });

  it('HAVING 过滤分组', async () => {
    const r = await rows(db, `SELECT g, COUNT(*) c FROM t GROUP BY g HAVING COUNT(*) >= 2 ORDER BY g`);
    expect(r).toEqual([['a', 3], ['b', 2]]);
  });

  it('COUNT(DISTINCT)', async () => {
    expect(await one(db, `SELECT COUNT(DISTINCT v) FROM t`)).toBe(4);
  });

  it('SUM(DISTINCT)', async () => {
    expect(
      await one(db, `SELECT SUM(DISTINCT v) FROM t WHERE v IS NOT NULL`),
    ).toBe(16);
  });

  it('空表聚合', async () => {
    await db.execute(`CREATE TABLE empty (v INTEGER)`);
    const r = await rows(db, `SELECT COUNT(*), SUM(v), AVG(v), MIN(v), MAX(v) FROM empty`);
    expect(r).toEqual([[0, null, null, null, null]]);
  });

  it('聚合表达式参与运算', async () => {
    expect(await one(db, `SELECT SUM(v) + 1 FROM t`)).toBe(17);
  });
});

describe('DISTINCT / ORDER BY', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE t (a TEXT, b INTEGER);
      INSERT INTO t (a,b) VALUES ('x',1),('y',2),('x',1),('x',3),(NULL,5);
    `);
  });

  it('DISTINCT 单列', async () => {
    const r = await rows(db, `SELECT DISTINCT a FROM t ORDER BY a`);
    expect(r).toEqual([[null], ['x'], ['y']]);
  });

  it('DISTINCT 多列', async () => {
    const r = await rows(db, `SELECT DISTINCT a, b FROM t ORDER BY b`);
    expect(r).toEqual([['x', 1], ['y', 2], ['x', 3], [null, 5]]);
  });

  it('ORDER BY 多键 + DESC', async () => {
    const r = await rows(db, `SELECT a, b FROM t ORDER BY a DESC, b ASC`);
    // y, x(1), x(1), x(3), NULL（DESC 时 NULL 排最后）
    expect(r.map((x) => x[1])).toEqual([2, 1, 1, 3, 5]);
  });

  it('ORDER BY 输出别名', async () => {
    const r = await rows(db, `SELECT a AS aa FROM t WHERE a IS NOT NULL ORDER BY aa DESC`);
    expect(r.map((x) => x[0])).toEqual(['y', 'x', 'x', 'x']);
  });

  it('ORDER BY 输出位置表达式', async () => {
    const r = await rows(db, `SELECT a, b*2 AS dbl FROM t ORDER BY dbl LIMIT 2`);
    expect(r).toEqual([['x', 2], ['x', 2]]);
  });
});
