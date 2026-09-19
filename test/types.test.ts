// 类型系统 / CAST / 隐式转换
import { describe, it, expect } from './harness';
import { newEngine, column, rows, expectSqlError } from './helpers';

describe('类型与转换', () => {
  it('79. CAST INTEGER/TEXT/REAL 互转', async () => {
    const e = await newEngine();
    const r = await rows(e,
      `SELECT CAST(3.9 AS INTEGER) i, CAST(42 AS REAL) r, CAST(42 AS TEXT) t, CAST('7' AS INTEGER) s`);
    expect(r).toEqual([{ i: 3, r: 42, t: '42', s: 7 }]);
  });

  it('80. CAST 布尔与数字/文本', async () => {
    const e = await newEngine();
    const r = await rows(e,
      `SELECT CAST(1 AS BOOLEAN) b1, CAST(0 AS BOOLEAN) b0,
              CAST(true AS INTEGER) bi, CAST(false AS TEXT) bt`);
    expect(r).toEqual([{ b1: true, b0: false, bi: 1, bt: 'false' }]);
  });

  it('81. 无法转换的文本报错', async () => {
    const e = await newEngine();
    await expectSqlError(e, "SELECT CAST('abc' AS INTEGER)", /cannot cast/);
  });

  it('82. 插入时按列类型隐式转换（文本数字 -> INTEGER）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute("INSERT INTO t VALUES (1, '42')");
    expect(await column(e, 'SELECT v FROM t')).toEqual([42]);
  });

  it('83. 插入布尔列接受 true/false/0/1 文本', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, f BOOLEAN)');
    await e.execute("INSERT INTO t VALUES (1, true),(2,'false'),(3,1),(4,0)");
    expect(await column(e, 'SELECT f FROM t ORDER BY id')).toEqual([true, false, true, false]);
  });

  it('84. 类型别名（VARCHAR/INT/FLOAT/BOOL）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (a VARCHAR(10), b INT, c FLOAT, d BOOL)');
    await e.execute("INSERT INTO t VALUES ('x', 1, 1.5, true)");
    const r = (await rows(e, 'SELECT * FROM t'))[0];
    expect(r).toEqual({ a: 'x', b: 1, c: 1.5, d: true });
  });

  it('85. CASE 简单形式（带 operand）', async () => {
    const e = await newEngine();
    const r = await rows(e,
      `SELECT CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END z`);
    expect(r[0].z).toBe('b');
  });

  it('86. CASE 搜索形式', async () => {
    const e = await newEngine();
    const r = await rows(e,
      `SELECT CASE WHEN 1 > 2 THEN 'a' WHEN 3 > 2 THEN 'b' END z`);
    expect(r[0].z).toBe('b');
  });

  it('87. CASE 中 NULL 条件不匹配', async () => {
    const e = await newEngine();
    const r = await rows(e, `SELECT CASE WHEN NULL THEN 'a' ELSE 'b' END z`);
    expect(r[0].z).toBe('b');
  });

  it('88. 文本转数字用于算术', async () => {
    const e = await newEngine();
    expect(await column(e, "SELECT '10' + '5' AS z", 'z')).toEqual([15]);
  });

  it('89. 布尔参与算术', async () => {
    const e = await newEngine();
    expect(await column(e, 'SELECT true + true AS z', 'z')).toEqual([2]);
  });

  it('90. 混合类型排序：数字在文本前（计算列产生混合类型）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (k INTEGER PRIMARY KEY, kind INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,1),(2,2),(3,3),(4,4)');
    const r = await column(e,
      `SELECT CASE kind WHEN 1 THEN 'b' WHEN 2 THEN 10 WHEN 3 THEN 'a' ELSE 2 END AS z
       FROM t ORDER BY z`);
    expect(r).toEqual([2, 10, 'a', 'b']);
  });
});
