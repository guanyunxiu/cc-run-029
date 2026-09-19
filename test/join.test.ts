// JOIN / DISTINCT / ORDER NULLS
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';

async function seedJoin() {
  const e = await newEngine();
  await e.execute('CREATE TABLE dept (id INTEGER PRIMARY KEY, dname TEXT)');
  await e.execute('CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT, dept_id INTEGER)');
  await e.execute(`INSERT INTO dept VALUES (10,'Engineering'),(20,'Sales'),(30,'Empty')`);
  await e.execute(`INSERT INTO emp VALUES
    (1,'Alice',10),(2,'Bob',10),(3,'Carol',20),(4,'Dave',NULL)`);
  return e;
}

describe('JOIN', () => {
  it('34. INNER JOIN 只返回匹配行', async () => {
    const e = await seedJoin();
    const r = await rows(e,
      `SELECT e.name, d.dname FROM emp e INNER JOIN dept d ON e.dept_id = d.id ORDER BY e.id`);
    expect(r).toEqual([
      { name: 'Alice', dname: 'Engineering' },
      { name: 'Bob', dname: 'Engineering' },
      { name: 'Carol', dname: 'Sales' },
    ]);
  });

  it('35. LEFT JOIN 保留左表无匹配行（右列补 NULL）', async () => {
    const e = await seedJoin();
    const r = await rows(e,
      `SELECT e.name, d.dname FROM emp e LEFT JOIN dept d ON e.dept_id = d.id ORDER BY e.id`);
    expect(r).toHaveLength(4);
    expect(r[3]).toEqual({ name: 'Dave', dname: null });
  });

  it('36. LEFT JOIN 无匹配时右表 COUNT 聚合正确', async () => {
    const e = await seedJoin();
    const r = await rows(e,
      `SELECT d.dname, COUNT(e.id) AS n FROM dept d
       LEFT JOIN emp e ON e.dept_id = d.id GROUP BY d.id ORDER BY d.id`);
    expect(r).toEqual([
      { dname: 'Engineering', n: 2 },
      { dname: 'Sales', n: 1 },
      { dname: 'Empty', n: 0 },
    ]);
  });

  it('37. 隐式逗号连接（笛卡尔积 + WHERE）', async () => {
    const e = await seedJoin();
    const n = await column(e,
      `SELECT COUNT(*) FROM emp e, dept d WHERE e.dept_id = d.id`);
    expect(n).toEqual([3]);
  });

  it('38. 无 ON 的 JOIN 是笛卡尔积', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE a (x INTEGER)');
    await e.execute('CREATE TABLE b (y INTEGER)');
    await e.execute('INSERT INTO a VALUES (1),(2)');
    await e.execute('INSERT INTO b VALUES (10),(20),(30)');
    expect(await column(e, 'SELECT COUNT(*) FROM a JOIN b')).toEqual([6]);
  });

  it('39. JOIN ON 非等值条件（嵌套循环）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE a (x INTEGER)');
    await e.execute('CREATE TABLE b (y INTEGER)');
    await e.execute('INSERT INTO a VALUES (1),(2),(3)');
    await e.execute('INSERT INTO b VALUES (2),(3)');
    const r = await rows(e, 'SELECT x, y FROM a JOIN b ON a.x < b.y ORDER BY x, y');
    expect(r).toEqual([
      { x: 1, y: 2 }, { x: 1, y: 3 },
      { x: 2, y: 3 },
    ]);
  });

  it('40. 多表 JOIN（三个表）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE a (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER, w INTEGER)');
    await e.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, b_id INTEGER, z INTEGER)');
    await e.execute('INSERT INTO a VALUES (1,100)');
    await e.execute('INSERT INTO b VALUES (1,1,200)');
    await e.execute('INSERT INTO c VALUES (1,1,300)');
    const r = await rows(e,
      `SELECT a.v, b.w, c.z FROM a
       JOIN b ON b.a_id = a.id
       JOIN c ON c.b_id = b.id`);
    expect(r).toEqual([{ v: 100, w: 200, z: 300 }]);
  });

  it('41. FROM 子查询', async () => {
    const e = await seedJoin();
    const r = await rows(e,
      `SELECT s.name FROM (SELECT name, dept_id FROM emp WHERE dept_id = 10) s ORDER BY s.name`);
    expect(r).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
  });

  it('42. DISTINCT 去重', async () => {
    const e = await seedJoin();
    expect(await column(e, 'SELECT DISTINCT dept_id FROM emp ORDER BY dept_id'))
      .toEqual([null, 10, 20]);
  });

  it('43. DISTINCT 多列', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (a INTEGER, b INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,1),(1,1),(1,2),(2,1)');
    const r = await rows(e, 'SELECT DISTINCT a, b FROM t ORDER BY a, b');
    expect(r).toHaveLength(3);
  });

  it('44. 歧义列名报错', async () => {
    const e = await seedJoin();
    await expectSqlError(e,
      'SELECT id FROM emp JOIN dept ON emp.dept_id = dept.id', /ambiguous/);
  });
});
