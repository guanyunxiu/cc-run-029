import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Session } from '../src/engine/session';
import { SqlError } from '../src/sql/types';

async function newSession() {
  const storage = new MemoryStorage();
  await storage.init();
  return new Session(storage);
}

async function rows(db: Session, sql: string) {
  return (await db.execute(sql))[0].rows;
}
async function one(db: Session, sql: string) {
  return (await rows(db, sql))[0]?.[0] ?? null;
}

describe('NULL 三值逻辑', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER);
      INSERT INTO t (a,b) VALUES (1,10),(NULL,20),(3,NULL),(NULL,NULL);`);
  });

  it('NULL 比较结果不是 true', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a = NULL`)).toBe(0);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a <> NULL`)).toBe(0);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a > 0`)).toBe(2);
  });

  it('IS NULL / IS NOT NULL', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IS NULL`)).toBe(2);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IS NOT NULL`)).toBe(2);
  });

  it('AND/OR/NOT 三值真值表', async () => {
    // NULL AND false = false; NULL AND true = NULL; NULL OR true = true; NULL OR false = NULL
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IS NULL AND 1=0`)).toBe(0);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IS NULL OR 1=1`)).toBe(4);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE NOT (a > 0)`)).toBe(0); // NOT UNKNOWN = UNKNOWN
  });

  it('NULL 传播：算术', async () => {
    const r = await rows(db, `SELECT a + b, a * 2 FROM t ORDER BY id`);
    expect(r).toEqual([[11, 2], [null, null], [null, 6], [null, null]]);
  });

  it('NOT NULL 约束拒绝 NULL', async () => {
    await db.execute(`CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    await expect(db.execute(`INSERT INTO u (name) VALUES (NULL)`)).rejects.toBeInstanceOf(SqlError);
  });

  it('BETWEEN 含 NULL', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a BETWEEN 0 AND 5`)).toBe(2);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a NOT BETWEEN 0 AND 5`)).toBe(0);
  });

  it('IN 列表含 NULL 的三值逻辑', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IN (1, NULL)`)).toBe(1);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a NOT IN (1, NULL)`)).toBe(0);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE a IN (3)`)).toBe(1);
  });
});

describe('表达式', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, s TEXT);
      INSERT INTO t (n,s) VALUES (5,'hello'),(2,'world');`);
  });

  it('算术与取模、除零', async () => {
    const r = await rows(db, `SELECT n+1, n-1, n*2, n/2, n%3, n/0 FROM t ORDER BY id`);
    expect(r).toEqual([[6, 4, 10, 2.5, 2, null], [3, 1, 4, 1, 2, null]]);
  });

  it('一元负号与括号优先级', async () => {
    expect(await one(db, `SELECT -n + 2 FROM t WHERE n=5`)).toBe(-3);
    expect(await one(db, `SELECT -(n + 2) FROM t WHERE n=5`)).toBe(-7);
    expect(await one(db, `SELECT 2 + 3 * 4`)).toBe(14);
    expect(await one(db, `SELECT (2 + 3) * 4`)).toBe(20);
  });

  it('比较运算返回布尔', async () => {
    const r = await rows(db, `SELECT n > 3, n = 2, n <> 5 FROM t ORDER BY id`);
    expect(r).toEqual([[true, false, false], [false, true, true]]);
  });

  it('LIKE 通配符', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE s LIKE 'h%'`)).toBe(1);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE s LIKE '_o%'`)).toBe(1);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE s LIKE 'H%'`)).toBe(1); // 默认不敏感
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE s NOT LIKE '%l%'`)).toBe(0);
  });

  it('标量函数', async () => {
    const r = await rows(db, `SELECT UPPER(s), LOWER('AB'), TRIM(' x '), LENGTH(s), ABS(-n)`).catch(() => null);
    void r;
    expect(await one(db, `SELECT UPPER(s) FROM t WHERE n=5`)).toBe('HELLO');
    expect(await one(db, `SELECT LENGTH(s) FROM t WHERE n=5`)).toBe(5);
    expect(await one(db, `SELECT ABS(-7)`)).toBe(7);
    expect(await one(db, `SELECT COALESCE(NULL, NULL, 1, 2)`)).toBe(1);
    const r2 = await rows(db, `SELECT NULLIF(1,1), NULLIF(1,2)`);
    expect(r2).toEqual([[null, 1]]);
  });
});

describe('CASE / CAST', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
  });

  it('搜索 CASE', async () => {
    const r = await db.execute(`
      SELECT CASE WHEN 1=1 THEN 'a' WHEN 2=2 THEN 'b' ELSE 'c' END AS r,
             CASE WHEN 1=2 THEN 'x' ELSE 'y' END AS r2,
             CASE WHEN 1=2 THEN 'x' END AS r3
    `);
    expect(r[0].rows).toEqual([['a', 'y', null]]);
  });

  it('简单 CASE（按值匹配）', async () => {
    const r = await db.execute(`SELECT CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END`);
    expect(r[0].rows).toEqual([['two']]);
  });

  it('CAST 类型转换', async () => {
    const r = await db.execute(`SELECT CAST('42' AS INTEGER) + 8, CAST(3.9 AS INTEGER),
      CAST(1 AS TEXT), CAST('3.5' AS REAL), CAST(0 AS BOOLEAN), CAST('true' AS BOOLEAN)`);
    expect(r[0].rows).toEqual([[50, 3, '1', 3.5, false, true]]);
  });

  it('CAST 非法值报错', async () => {
    await expect(db.execute(`SELECT CAST('abc' AS INTEGER)`)).rejects.toBeInstanceOf(SqlError);
  });

  it('CASE 与聚合结合', async () => {
    await db.execute(`CREATE TABLE t (g TEXT, v INTEGER);
      INSERT INTO t VALUES ('a',1),('a',2),('b',3);`);
    const r = await db.execute(
      `SELECT SUM(CASE WHEN g='a' THEN v ELSE 0 END) FROM t`,
    );
    expect(r[0].rows).toEqual([[3]]);
  });
});

describe('类型系统', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
  });

  it('INTEGER/REAL/TEXT/BOOLEAN 列亲和', async () => {
    await db.execute(`CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BOOLEAN);
      INSERT INTO t VALUES ('42', '1.5', 123, '1');`);
    const r = await rows(db, `SELECT i, r, s, b FROM t`);
    expect(r).toEqual([[42, 1.5, '123', true]]);
    expect(typeof r[0][0]).toBe('number');
    expect(typeof r[0][1]).toBe('number');
    expect(typeof r[0][2]).toBe('string');
    expect(typeof r[0][3]).toBe('boolean');
  });

  it('TEXT 与 INTEGER 跨类型比较', async () => {
    await db.execute(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('10'),('2');`);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE v = 10`)).toBe(1);
    expect(await one(db, `SELECT COUNT(*) FROM t WHERE v < 5`)).toBe(1);
  });
});
