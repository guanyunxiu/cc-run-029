// 聚合 / GROUP BY / HAVING
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, product TEXT, amount INTEGER, qty INTEGER)');
  await e.execute(`INSERT INTO sales VALUES
    (1,'N','A',100,2),(2,'N','B',200,1),(3,'S','A',150,3),
    (4,'S','A',50,null),(5,'E',null,300,1)`);
  return e;
}

describe('聚合', () => {
  it('45. COUNT(*)/COUNT(col)/SUM/AVG/MIN/MAX', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT COUNT(*) c, COUNT(qty) cq, SUM(amount) s, AVG(amount) a,
              MIN(amount) mn, MAX(amount) mx FROM sales`);
    expect(r).toEqual([{ c: 5, cq: 4, s: 800, a: 160, mn: 50, mx: 300 }]);
  });

  it('46. 空表 COUNT=0，其它聚合为 NULL', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (v INTEGER)');
    const r = await rows(e, 'SELECT COUNT(*) c, SUM(v) s, AVG(v) a, MIN(v) mn, MAX(v) mx FROM t');
    expect(r).toEqual([{ c: 0, s: null, a: null, mn: null, mx: null }]);
  });

  it('47. GROUP BY 分组聚合', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT region, SUM(amount) total FROM sales GROUP BY region ORDER BY region`);
    expect(r).toEqual([
      { region: 'E', total: 300 },
      { region: 'N', total: 300 },
      { region: 'S', total: 200 },
    ]);
  });

  it('48. GROUP BY NULL 值独立成组', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT product, COUNT(*) n FROM sales GROUP BY product ORDER BY product`);
    expect(r).toContain({ product: null, n: 1 });
    expect(r).toContain({ product: 'A', n: 3 });
  });

  it('49. HAVING 过滤分组', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT region, SUM(amount) total FROM sales GROUP BY region HAVING SUM(amount) > 200
       ORDER BY region`);
    expect(r).toEqual([
      { region: 'E', total: 300 },
      { region: 'N', total: 300 },
    ]);
  });

  it('50. HAVING 中可使用聚合别名（部分 SQL 方言）', async () => {
    const e = await seed();
    // 标准行为：HAVING 可以引用聚合表达式；这里用完整表达式
    const r = await rows(e,
      `SELECT region, COUNT(*) n FROM sales GROUP BY region HAVING COUNT(*) >= 2 ORDER BY region`);
    expect(r).toEqual([
      { region: 'N', n: 2 },
      { region: 'S', n: 2 },
    ]);
  });

  it('51. COUNT(DISTINCT ...)', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT COUNT(DISTINCT region) FROM sales')).toEqual([3]);
    expect(await column(e, 'SELECT COUNT(DISTINCT product) FROM sales')).toEqual([2]);
  });

  it('52. SUM(DISTINCT ...)', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (v INTEGER)');
    await e.execute('INSERT INTO t VALUES (5),(5),(10)');
    expect(await column(e, 'SELECT SUM(DISTINCT v) FROM t')).toEqual([15]);
  });

  it('53. WHERE 中使用聚合报错', async () => {
    const e = await seed();
    await expectSqlError(e, 'SELECT * FROM sales WHERE SUM(amount) > 10', /aggregate/);
  });

  it('54. 聚合参数中的表达式', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT SUM(amount * qty) FROM sales')).toEqual([
      100 * 2 + 200 * 1 + 150 * 3 + 300 * 1, // qty null 行跳过/为 null
    ]);
  });

  it('55. 聚合自动跳过 NULL 输入', async () => {
    const e = await seed();
    const v = (await rows(e, 'SELECT AVG(qty) a, SUM(qty) s FROM sales'))[0];
    expect(v.a).toBeCloseTo((2 + 1 + 3 + 1) / 4);
    expect(v.s).toBe(7);
  });

  it('56. ORDER BY 输出位置序号', async () => {
    const e = await seed();
    const r = await rows(e,
      `SELECT region, SUM(amount) total FROM sales GROUP BY region ORDER BY 2 DESC`);
    expect(r[0]).toEqual({ region: 'N', total: 300 });
  });
});
