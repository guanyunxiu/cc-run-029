// NULL 三值逻辑
import { describe, it, expect } from './harness';
import { newEngine, column, rows } from './helpers';

async function seed() {
  const e = await newEngine();
  await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b BOOLEAN, s TEXT)');
  await e.execute(`INSERT INTO t VALUES
    (1, 10, true, 'x'),(2, NULL, false, 'y'),(3, 20, NULL, NULL),(4, NULL, NULL, NULL)`);
  return e;
}

describe('NULL 三值逻辑', () => {
  it('67. NULL 比较结果为 UNKNOWN（被过滤）', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM t WHERE a = NULL ORDER BY id')).toEqual([]);
    expect(await column(e, 'SELECT id FROM t WHERE a <> 10 ORDER BY id')).toEqual([3]);
  });

  it('68. IS NULL / IS NOT NULL', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM t WHERE a IS NULL ORDER BY id')).toEqual([2, 4]);
    expect(await column(e, 'SELECT id FROM t WHERE a IS NOT NULL ORDER BY id')).toEqual([1, 3]);
  });

  it('69. NULL 参与算术结果为 NULL', async () => {
    const e = await seed();
    const r = await rows(e, 'SELECT id, a + 1 AS x FROM t ORDER BY id');
    expect(r.map((x) => x.x)).toEqual([11, null, 21, null]);
  });

  it('70. 三值逻辑 AND/OR 真值表', async () => {
    const e = await newEngine();
    expect(await column(e, `SELECT (TRUE AND NULL) AS x`, 'x')).toEqual([null]);
    expect(await column(e, `SELECT (FALSE AND NULL) AS x`, 'x')).toEqual([false]);
    expect(await column(e, `SELECT (TRUE OR NULL) AS x`, 'x')).toEqual([true]);
    expect(await column(e, `SELECT (FALSE OR NULL) AS x`, 'x')).toEqual([null]);
    expect(await column(e, `SELECT NOT NULL AS x`, 'x')).toEqual([null]);
  });

  it('71. NULL 在 IN 列表中', async () => {
    const e = await newEngine();
    // 1 IN (2, NULL) => UNKNOWN => 空
    expect(await column(e, 'SELECT 1 WHERE 1 IN (2, NULL)')).toEqual([]);
    // 1 IN (1, NULL) => true
    expect(await column(e, 'SELECT 1 AS x WHERE 1 IN (1, NULL)', 'x')).toEqual([1]);
  });

  it('72. COUNT 包含 NULL 行但不统计 NULL 值', async () => {
    const e = await seed();
    const r = await rows(e, 'SELECT COUNT(*) c, COUNT(a) ca, COUNT(s) cs FROM t');
    expect(r).toEqual([{ c: 4, ca: 2, cs: 2 }]);
  });

  it('73. GROUP BY 将 NULL 聚为一组', async () => {
    const e = await seed();
    const r = await rows(e, 'SELECT a, COUNT(*) n FROM t GROUP BY a ORDER BY a NULLS FIRST');
    expect(r[0]).toEqual({ a: null, n: 2 });
  });

  it('74. NULL 排序：ASC 默认 NULLS FIRST，DESC 默认 NULLS LAST', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT a FROM t ORDER BY a ASC')).toEqual([null, null, 10, 20]);
    expect(await column(e, 'SELECT a FROM t ORDER BY a DESC')).toEqual([20, 10, null, null]);
  });

  it('75. 显式 NULLS FIRST / LAST', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT a FROM t ORDER BY a ASC NULLS LAST')).toEqual([10, 20, null, null]);
    expect(await column(e, 'SELECT a FROM t ORDER BY a DESC NULLS FIRST')).toEqual([null, null, 20, 10]);
  });

  it('76. IS TRUE / IS FALSE 对 NULL 为 false', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT id FROM t WHERE b IS TRUE ORDER BY id')).toEqual([1]);
    expect(await column(e, 'SELECT id FROM t WHERE b IS NOT TRUE ORDER BY id')).toEqual([2, 3, 4]);
  });

  it('77. CASE ELSE 缺省返回 NULL', async () => {
    const e = await seed();
    const r = await rows(e, `SELECT id, CASE WHEN a > 15 THEN 'big' END AS z FROM t ORDER BY id`);
    expect(r.map((x) => x.z)).toEqual([null, null, 'big', null]);
  });

  it('78. LIKE NULL 模式返回 NULL', async () => {
    const e = await seed();
    expect(await column(e, "SELECT id FROM t WHERE s LIKE NULL")).toEqual([]);
  });
});
