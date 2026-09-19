// IndexedDB 存储与内存存储一致性测试
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { IdbStorage } from '../src/engine/idb-storage';
import { Session } from '../src/engine/session';

let dbSeq = 0;
async function newSession() {
  dbSeq++;
  const storage = new IdbStorage(`test-db-${dbSeq}-${Date.now()}`);
  await storage.init();
  return new Session(storage);
}
async function rows(db: Session, sql: string) {
  return (await db.execute(sql))[0].rows;
}

describe('IndexedDB 存储', () => {

  it('建表/插入/查询往返持久化', async () => {
    let db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
      INSERT INTO t (name,age) VALUES ('Alice',30),('Bob',25);`);
    expect(await rows(db, `SELECT name FROM t WHERE age > 20 ORDER BY id`)).toEqual([['Alice'], ['Bob']]);
  });

  it('事务回滚不写入', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`BEGIN; INSERT INTO t (v) VALUES (1); ROLLBACK;`);
    expect(await rows(db, `SELECT COUNT(*) FROM t`)).toEqual([[0]]);
  });

  it('事务提交持久化', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`BEGIN; INSERT INTO t (v) VALUES (1); INSERT INTO t (v) VALUES (2); COMMIT;`);
    expect(await rows(db, `SELECT SUM(v) FROM t`)).toEqual([[3]]);
  });

  it('JOIN + 聚合在 IndexedDB 上运行', async () => {
    const db = await newSession();
    await db.execute(`
      CREATE TABLE d (id INTEGER PRIMARY KEY, dn TEXT);
      CREATE TABLE e (id INTEGER PRIMARY KEY, did INTEGER, sal INTEGER);
      INSERT INTO d VALUES (1,'A'),(2,'B');
      INSERT INTO e VALUES (1,1,100),(2,1,200),(3,2,300);
    `);
    const r = await rows(db, `
      SELECT d.dn, COUNT(*), AVG(e.sal) FROM d JOIN e ON d.id=e.did GROUP BY d.dn ORDER BY d.dn
    `);
    expect(r).toEqual([['A', 2, 150], ['B', 1, 300]]);
  });

  it('索引扫描计划可用', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, age INTEGER); CREATE INDEX ix ON t(age);
      INSERT INTO t (age) VALUES (10),(20);`);
    const r = await db.execute(`EXPLAIN SELECT * FROM t WHERE age=10`);
    expect(JSON.stringify(r[0].plan)).toContain('ix');
    expect(await rows(db, `SELECT age FROM t WHERE age=10`)).toEqual([[10]]);
  });

  it('UPDATE/DELETE 在 IndexedDB 上工作', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);
      INSERT INTO t (v) VALUES (1),(2),(3);`);
    await db.execute(`UPDATE t SET v = v * 10 WHERE v >= 2`);
    await db.execute(`DELETE FROM t WHERE v = 30`);
    expect(await rows(db, `SELECT v FROM t ORDER BY id`)).toEqual([[1], [20]]);
  });

  it('重新打开数据库后数据与目录仍在（模拟刷新）', async () => {
    const name = `persist-${Date.now()}`;
    const s1 = new IdbStorage(name);
    await s1.init();
    const db1 = new Session(s1);
    await db1.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
      CREATE INDEX ix_v ON t(v); INSERT INTO t (v) VALUES ('hello');`);
    // 重新打开
    const s2 = new IdbStorage(name);
    await s2.init();
    const db2 = new Session(s2);
    expect((await db2.listTables()).map((d) => d.name)).toEqual(['t']);
    expect(await rows(db2, `SELECT v FROM t`)).toEqual([['hello']]);
    expect(await rows(db2, `SELECT v FROM t WHERE v='hello'`)).toEqual([['hello']]);
  });



  it('主键冲突报错', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await db.execute(`INSERT INTO t VALUES (1)`);
    await expect(db.execute(`INSERT INTO t VALUES (1)`)).rejects.toThrow();
  });
});
