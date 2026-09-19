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
  return (await rows(db, sql))[0]?.[0] ?? null;
}

describe('子查询', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE dept (id INTEGER PRIMARY KEY, dname TEXT);
      CREATE TABLE emp (id INTEGER PRIMARY KEY, ename TEXT, dept_id INTEGER, salary INTEGER);
      INSERT INTO dept VALUES (1,'Eng'),(2,'Sales');
      INSERT INTO emp VALUES (1,'Alice',1,100),(2,'Bob',1,200),(3,'Carol',2,300),(4,'Dave',NULL,400);
    `);
  });

  it('IN 子查询', async () => {
    const r = await rows(db, `
      SELECT ename FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE dname='Eng') ORDER BY ename
    `);
    expect(r).toEqual([['Alice'], ['Bob']]);
  });

  it('NOT IN 子查询', async () => {
    const r = await rows(db, `
      SELECT ename FROM emp WHERE dept_id NOT IN (SELECT id FROM dept) ORDER BY ename
    `);
    // Dave 的 dept_id 为 NULL => UNKNOWN，不返回（标准 SQL）
    expect(r).toEqual([]);
  });

  it('EXISTS 相关子查询', async () => {
    const r = await rows(db, `
      SELECT dname FROM dept d
      WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id AND e.salary > 150)
      ORDER BY dname
    `);
    expect(r).toEqual([['Eng'], ['Sales']]);
  });

  it('NOT EXISTS 相关子查询', async () => {
    const r = await rows(db, `
      SELECT dname FROM dept d
      WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id)
    `);
    expect(r).toEqual([]);
    // 无员工的部门：把 Eng/Sales 员工全删后再测
    await db.execute(`DELETE FROM emp WHERE dept_id IS NOT NULL`);
    const r2 = await rows(db, `
      SELECT dname FROM dept d WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id)
      ORDER BY dname
    `);
    expect(r2).toEqual([['Eng'], ['Sales']]);
  });

  it('标量子查询（SELECT 列表）', async () => {
    const r = await rows(db, `
      SELECT ename, (SELECT dname FROM dept WHERE dept.id = emp.dept_id) AS d
      FROM emp ORDER BY ename
    `);
    expect(r).toEqual([
      ['Alice', 'Eng'],
      ['Bob', 'Eng'],
      ['Carol', 'Sales'],
      ['Dave', null],
    ]);
  });

  it('WHERE 中的标量子查询比较', async () => {
    const r = await rows(db, `
      SELECT ename FROM emp
      WHERE salary > (SELECT AVG(salary) FROM emp WHERE dept_id = 1)
      ORDER BY ename
    `);
    expect(r).toEqual([['Bob'], ['Carol'], ['Dave']]); // AVG(100,200)=150
  });

  it('标量子查询返回多行报错', async () => {
    await expect(
      db.execute(`SELECT ename, (SELECT id FROM dept) FROM emp`),
    ).rejects.toThrow();
  });

  it('FROM 派生表', async () => {
    const r = await rows(db, `
      SELECT t.d, t.c FROM (SELECT dept_id d, COUNT(*) c FROM emp GROUP BY dept_id) t
      WHERE t.c >= 1 ORDER BY t.d
    `);
    expect(r).toEqual([[null, 1], [1, 2], [2, 1]]);
  });

  it('IN 子查询为空集合', async () => {
    expect(await one(db, `SELECT COUNT(*) FROM emp WHERE dept_id IN (SELECT id FROM dept WHERE 1=0)`)).toBe(0);
    expect(await one(db, `SELECT COUNT(*) FROM emp WHERE dept_id NOT IN (SELECT id FROM dept WHERE 1=0)`)).toBe(4); // 空集合 NOT IN 恒为真（含 NULL）
  });
});

describe('事务', () => {
  it('COMMIT 后数据可见', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`BEGIN`);
    await db.execute(`INSERT INTO t (v) VALUES (1)`);
    await db.execute(`INSERT INTO t (v) VALUES (2)`);
    await db.execute(`COMMIT`);
    const r = await db.execute(`SELECT COUNT(*) FROM t`);
    expect(r[0].rows).toEqual([[2]]);
  });

  it('ROLLBACK 撤销变更', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`INSERT INTO t (v) VALUES (1)`);
    await db.execute(`BEGIN`);
    await db.execute(`INSERT INTO t (v) VALUES (2)`);
    await db.execute(`UPDATE t SET v=100 WHERE id=1`);
    await db.execute(`ROLLBACK`);
    const r = await db.execute(`SELECT v FROM t ORDER BY id`);
    expect(r[0].rows).toEqual([[1]]);
  });

  it('没有事务时 COMMIT 报错', async () => {
    const db = await newSession();
    await expect(db.execute(`COMMIT`)).rejects.toThrow();
  });

  it('重复 BEGIN 报错', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await db.execute(`BEGIN`);
    await expect(db.execute(`BEGIN`)).rejects.toThrow();
    await db.execute(`ROLLBACK`);
  });

  it('回滚后写锁释放，可再次写入', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`BEGIN`);
    await db.execute(`INSERT INTO t (v) VALUES (1)`);
    await expect(db.execute(`INSERT INTO t (id) VALUES (1)`)).rejects.toThrow(); // 主键冲突触发自动回滚?
    // 显式 ROLLBACK 后应可继续
    await db.execute(`ROLLBACK`).catch(() => {});
    await db.execute(`INSERT INTO t (v) VALUES (9)`);
    expect((await db.execute(`SELECT COUNT(*) FROM t`))[0].rows).toEqual([[1]]);
  });
});

describe('约束与错误', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT UNIQUE, age INTEGER)`);
  });

  it('主键冲突报错', async () => {
    await db.execute(`INSERT INTO t (id) VALUES (5)`);
    await expect(db.execute(`INSERT INTO t (id) VALUES (5)`)).rejects.toThrow(/冲突|重复/i);
  });

  it('UNIQUE 冲突报错', async () => {
    await db.execute(`INSERT INTO t (id,email) VALUES (1,'a@x.com')`);
    await expect(db.execute(`INSERT INTO t (id,email) VALUES (2,'a@x.com')`)).rejects.toThrow();
  });

  it('列数不匹配报错', async () => {
    await expect(db.execute(`INSERT INTO t (id,email) VALUES (1)`)).rejects.toThrow();
  });

  it('不存在的表/列报错', async () => {
    await expect(db.execute(`SELECT * FROM nope`)).rejects.toThrow();
    await expect(db.execute(`SELECT ghost FROM t`)).rejects.toThrow(/列/);
  });

  it('不支持的 JOIN 报错（RIGHT/FULL）', async () => {
    await expect(db.execute(`SELECT * FROM t a RIGHT JOIN t b ON a.id=b.id`)).rejects.toThrow();
  });

  it('语法错误带行列号', async () => {
    try {
      await db.execute(`SELECT FROM\n  FRUM t`);
      throw new Error('should fail');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/第\s*1\s*行/);
    }
  });
});
