// DDL / INSERT / 基础查询
import { describe, it, expect } from './harness';
import { newEngine, query, column, rows, expectSqlError } from './helpers';

describe('DDL & 建表', () => {
  it('1. CREATE TABLE 后可查询空结果', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const r = await query(e, 'SELECT * FROM t');
    expect(r.rows).toHaveLength(0);
  });

  it('2. CREATE TABLE IF NOT EXISTS 重复建表不报错', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const r = await query(e, 'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
    expect(r.rowsAffected).toBe(0);
  });

  it('3. 重复建表报错', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await expectSqlError(e, 'CREATE TABLE t (id INTEGER PRIMARY KEY)', /already exists/);
  });

  it('4. DROP TABLE 后再查询报表不存在', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('DROP TABLE t');
    await expectSqlError(e, 'SELECT * FROM t', /no such table/);
  });

  it('5. DROP TABLE IF EXISTS 不存在时跳过', async () => {
    const e = await newEngine();
    const r = await query(e, 'DROP TABLE IF EXISTS ghost');
    expect(r.rowsAffected).toBe(0);
  });

  it('6. NOT NULL 约束拒绝 NULL', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await expectSqlError(e, "INSERT INTO t (id) VALUES (1)", /NOT NULL/);
  });

  it('7. 主键冲突报错', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await e.execute("INSERT INTO t VALUES (1, 'a')");
    await expectSqlError(e, "INSERT INTO t VALUES (1, 'b')", /UNIQUE/);
  });

  it('8. AUTOINCREMENT 自动生成主键', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
    await e.execute("INSERT INTO t (name) VALUES ('a'), ('b')");
    expect(await column(e, 'SELECT id FROM t ORDER BY id')).toEqual([1, 2]);
  });

  it('9. AUTOINCREMENT 在指定大 id 后继续递增', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
    await e.execute("INSERT INTO t VALUES (100, 'x')");
    await e.execute("INSERT INTO t (name) VALUES ('y')");
    expect(await column(e, 'SELECT id FROM t ORDER BY id')).toEqual([100, 101]);
  });

  it('10. 无主键表使用隐藏 rowid 也能插入与删除', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (name TEXT)');
    await e.execute("INSERT INTO t VALUES ('a'), ('b')");
    await e.execute("DELETE FROM t WHERE name = 'a'");
    expect(await column(e, 'SELECT name FROM t')).toEqual(['b']);
  });
});

describe('INSERT / UPDATE / DELETE', () => {
  it('11. INSERT 多行 VALUES', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    const r = await query(e, 'INSERT INTO t VALUES (1,10),(2,20),(3,30)');
    expect(r.rowsAffected).toBe(3);
  });

  it('12. INSERT 指定部分列，其余为 NULL', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)');
    await e.execute('INSERT INTO t (id, a) VALUES (1, 5)');
    expect(await rows(e, 'SELECT a, b FROM t')).toEqual([{ a: 5, b: null }]);
  });

  it('13. INSERT 列数不匹配报错', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)');
    await expectSqlError(e, 'INSERT INTO t VALUES (1,2)', /expected 3/);
  });

  it('14. UPDATE 修改满足条件的行', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,10),(2,20),(3,30)');
    const r = await query(e, 'UPDATE t SET v = v + 100 WHERE v >= 20');
    expect(r.rowsAffected).toBe(2);
    expect(await column(e, 'SELECT v FROM t ORDER BY id')).toEqual([10, 120, 130]);
  });

  it('15. UPDATE 无 WHERE 更新全部行', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,1),(2,2)');
    const r = await query(e, 'UPDATE t SET v = 0');
    expect(r.rowsAffected).toBe(2);
    expect(await column(e, 'SELECT v FROM t')).toEqual([0, 0]);
  });

  it('16. UPDATE 多列赋值互不影响（都基于旧值）', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)');
    await e.execute('INSERT INTO t VALUES (1, 10, 20)');
    await e.execute('UPDATE t SET a = b, b = a WHERE id = 1');
    expect(await rows(e, 'SELECT a, b FROM t')).toEqual([{ a: 20, b: 10 }]);
  });

  it('17. DELETE 满足条件的行', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (1,10),(2,20),(3,30)');
    const r = await query(e, 'DELETE FROM t WHERE v < 30');
    expect(r.rowsAffected).toBe(2);
    expect(await column(e, 'SELECT v FROM t')).toEqual([30]);
  });

  it('18. DELETE 无 WHERE 清空表', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1),(2),(3)');
    await e.execute('DELETE FROM t');
    expect(await column(e, 'SELECT COUNT(*) FROM t')).toEqual([0]);
  });

  it('19. INSERT ... SELECT 复制数据', async () => {
    const e = await newEngine();
    await e.execute('CREATE TABLE a (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('CREATE TABLE b (id INTEGER PRIMARY KEY, v INTEGER)');
    await e.execute('INSERT INTO a VALUES (1,10),(2,20)');
    const r = await query(e, 'INSERT INTO b SELECT id, v * 2 FROM a WHERE v > 10');
    expect(r.rowsAffected).toBe(1);
    expect(await rows(e, 'SELECT id, v FROM b')).toEqual([{ id: 2, v: 40 }]);
  });
});

describe('SELECT 基础 / WHERE / 别名', () => {
  async function seed() {
    const e = await newEngine();
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, score REAL)');
    await e.execute(`INSERT INTO t VALUES
      (1,'Alice',30,90.5),(2,'Bob',25,80.0),(3,'Carol',35,70.5),(4,'Dave',25,null)`);
    return e;
  }

  it('20. WHERE 比较 + AND', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t WHERE age >= 30 AND score > 80')).toEqual(['Alice']);
  });

  it('21. WHERE OR + NOT', async () => {
    const e = await seed();
    const names = await column(e, "SELECT name FROM t WHERE NOT (age = 25) OR name = 'Bob' ORDER BY id");
    expect(names).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('22. BETWEEN 包含边界', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t WHERE age BETWEEN 25 AND 30 ORDER BY id'))
      .toEqual(['Alice', 'Bob', 'Dave']);
  });

  it('23. NOT BETWEEN', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t WHERE age NOT BETWEEN 25 AND 35 ORDER BY id'))
      .toEqual([]);
  });

  it('24. IN 列表', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t WHERE id IN (1,3) ORDER BY id')).toEqual(['Alice', 'Carol']);
  });

  it('25. NOT IN 列表', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t WHERE id NOT IN (1,2,3) ORDER BY id')).toEqual(['Dave']);
  });

  it('26. LIKE % 与 _', async () => {
    const e = await seed();
    expect(await column(e, "SELECT name FROM t WHERE name LIKE 'A%'")).toEqual(['Alice']);
    expect(await column(e, "SELECT name FROM t WHERE name LIKE '_ob'")).toEqual(['Bob']);
  });

  it('27. ORDER BY ASC/DESC', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT age FROM t ORDER BY age DESC, id ASC')).toEqual([35, 30, 25, 25]);
  });

  it('28. LIMIT 与 OFFSET', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t ORDER BY id LIMIT 2 OFFSET 1')).toEqual(['Bob', 'Carol']);
  });

  it('29. LIMIT a,b 形式（offset,count）', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT name FROM t ORDER BY id LIMIT 2,1')).toEqual(['Carol']);
  });

  it('30. 列别名与表别名', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT x.name AS nm FROM t x WHERE x.id = 1', 'nm')).toEqual(['Alice']);
  });

  it('31. 算术表达式与优先级', async () => {
    const e = await seed();
    expect(await column(e, 'SELECT 2 + 3 * 4 AS v', 'v')).toEqual([14]);
    expect(await column(e, 'SELECT (2 + 3) * 4 AS v', 'v')).toEqual([20]);
  });

  it('32. 取模与整数除法语义', async () => {
    const e = await newEngine();
    expect(await column(e, 'SELECT 17 % 5 AS v', 'v')).toEqual([2]);
    expect(await column(e, 'SELECT 7 / 2 AS v', 'v')).toEqual([3.5]);
  });

  it('33. 除零报错带位置', async () => {
    const e = await newEngine();
    const err = await expectSqlError(e, 'SELECT 1 / 0', /division by zero/);
    expect(err.column).toBe(10);
  });
});
