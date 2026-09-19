// 子查询：IN / EXISTS / 标量 / 相关
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, tier INTEGER)');
  await e.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, cid INTEGER, total INTEGER)');
  await e.execute(`INSERT INTO customers VALUES (1,'Alice',1),(2,'Bob',2),(3,'Carol',1),(4,'Dave',3)`);
  await e.execute(`INSERT INTO orders VALUES
    (10,1,100),(11,1,200),(12,2,50),(13,3,NULL)`);
  return e;
}

describe('子查询', () => {
  it('57. 非相关 IN 子查询', async () => {
    const e = await seed();
    const r = await column(e,
      `SELECT name FROM customers WHERE id IN (SELECT cid FROM orders WHERE total > 75)
       ORDER BY id`);
    expect(r).toEqual(['Alice']);
  });

  it('58. 相关 EXISTS', async () => {
    const e = await seed();
    const r = await column(e,
      `SELECT name FROM customers c
       WHERE EXISTS (SELECT 1 FROM orders o WHERE o.cid = c.id AND o.total > 75)
       ORDER BY c.id`);
    expect(r).toEqual(['Alice']);
  });

  it('59. NOT EXISTS', async () => {
    const e = await seed();
    const r = await column(e,
      `SELECT name FROM customers c
       WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.cid = c.id)
       ORDER BY c.id`);
    expect(r).toEqual(['Dave']);
  });

  it('60. 标量子查询（SELECT 列表）', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT name, (SELECT COUNT(*) FROM orders o WHERE o.cid = c.id) n
       FROM customers c ORDER BY c.id`);
    expect(r.map((x) => x.n)).toEqual([2, 1, 1, 0]);
  });

  it('61. WHERE 中的标量子查询比较', async () => {
    const e = await seed();
    const r = await column(e,
      `SELECT name FROM customers
       WHERE tier = (SELECT MAX(tier) FROM customers) ORDER BY id`);
    expect(r).toEqual(['Dave']);
  });

  it('62. 标量子查询返回多列（>1 输出）正常', async () => {
    const e = await seed();
    // IN 子查询只取首列
    const r = await column(e,
      `SELECT name FROM customers WHERE id IN (SELECT cid, total FROM orders WHERE total = 50)`);
    expect(r).toEqual(['Bob']);
  });

  it('63. 标量子查询返回多行报错', async () => {
    const e = await seed();
    await expectSqlError(e,
      'SELECT name, (SELECT id FROM customers) FROM customers',
      /more than 1 row/);
  });

  it('64. 标量子查询无结果返回 NULL', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT (SELECT MAX(total) FROM orders WHERE total > 1000) AS m`);
    expect(r[0].m).toBeNull();
  });

  it('65. NOT IN 包含 NULL 时结果为 UNKNOWN（空结果）', async () => {
    // 3 NOT IN (1,2,NULL) => UNKNOWN => 不返回任何行
    const e = await newEngine();
    await e.execute('CREATE TABLE nums (n INTEGER)');
    await e.execute('INSERT INTO nums VALUES (1),(2),(NULL)');
    const out = await column(e, `SELECT n FROM nums WHERE n NOT IN (1, 2, NULL)`);
    expect(out).toEqual([]);
  });

  it('66. 相关子查询在 SELECT 中引用外层两层', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT)');
    await e.execute('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER, name TEXT)');
    await e.execute('CREATE TABLE gc (id INTEGER PRIMARY KEY, cid INTEGER, v INTEGER)');
    await e.execute("INSERT INTO p VALUES (1,'P')");
    await e.execute("INSERT INTO c VALUES (1,1,'C')");
    await e.execute('INSERT INTO gc VALUES (1,1,10),(2,1,20)');
    const r = await rows(e,
      `SELECT p.name pn, c.name cn, (SELECT SUM(v) FROM gc WHERE gc.cid = c.id) s
       FROM p JOIN c ON c.pid = p.id`);
    expect(r).toEqual([{ pn: 'P', cn: 'C', s: 30 }]);
  });
});
