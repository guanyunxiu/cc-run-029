import { describe, it, expect } from 'vitest';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Session } from '../src/engine/session';
import { SqlError } from '../src/sql/types';

async function newSession() {
  const storage = new MemoryStorage();
  await storage.init();
  return new Session(storage);
}

describe('并发：单写多读', () => {
  it('第二个写事务 BEGIN 被拒绝', async () => {
    const s = new MemoryStorage();
    await s.init();
    await s.createTable({
      name: 't',
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
      indexes: [{ name: 'idx_t_pk_id', table: 't', column: 'id', unique: true }],
    });
    const w1 = await s.begin(false);
    await expect(s.begin(false)).rejects.toBeInstanceOf(SqlError);
    await s.rollback(w1);
    // 锁释放后可以再次开始写事务
    const w2 = await s.begin(false);
    await s.commit(w2);
  });

  it('多个只读事务可以并发', async () => {
    const s = new MemoryStorage();
    await s.init();
    const r1 = await s.begin(true);
    const r2 = await s.begin(true);
    const r3 = await s.begin(true);
    await Promise.all([s.commit(r1), s.commit(r2), s.commit(r3)]);
  });

  it('只读事务中写入被拒绝', async () => {
    const s = new MemoryStorage();
    await s.init();
    await s.createTable({
      name: 't',
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true, nullable: false }],
      indexes: [{ name: 'idx_t_pk_id', table: 't', column: 'id', unique: true }],
    });
    const r = await s.begin(true);
    await expect(
      s.applyMutations(r, 't', { insert: [{ id: 1 }] }),
    ).rejects.toBeInstanceOf(SqlError);
    await s.rollback(r);
  });

  it('显式事务中禁止 DDL', async () => {
    const db = await newSession();
    await db.execute(`BEGIN`);
    await expect(db.execute(`CREATE TABLE x (id INTEGER PRIMARY KEY)`)).rejects.toThrow(/事务/);
    await db.execute(`ROLLBACK`);
  });

  it('写事务内的变更对后续语句立即可见', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`BEGIN`);
    await db.execute(`INSERT INTO t (v) VALUES (10)`);
    // 同一事务内能读到未提交数据
    const r = await db.execute(`SELECT v FROM t`);
    expect(r[0].rows).toEqual([[10]]);
    // 基于读到的数据做更新
    await db.execute(`UPDATE t SET v = v + 5`);
    await db.execute(`COMMIT`);
    const r2 = await db.execute(`SELECT v FROM t`);
    expect(r2[0].rows).toEqual([[15]]);
  });

  it('约束失败自动回滚，不影响已提交数据', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.execute(`INSERT INTO t VALUES (1, 100)`);
    await expect(db.execute(`INSERT INTO t VALUES (1, 200)`)).rejects.toThrow();
    const r = await db.execute(`SELECT v FROM t`);
    expect(r[0].rows).toEqual([[100]]);
    // 自动回滚后写锁已释放，可继续写入
    await db.execute(`INSERT INTO t VALUES (2, 200)`);
    const r2 = await db.execute(`SELECT COUNT(*) FROM t`);
    expect(r2[0].rows).toEqual([[2]]);
  });

  it('ROLLBACK 后写锁释放（并发模拟）', async () => {
    const db = await newSession();
    await db.execute(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await db.execute(`BEGIN`);
    await db.execute(`ROLLBACK`);
    await db.execute(`BEGIN`);
    await db.execute(`INSERT INTO t VALUES (1)`);
    await db.execute(`COMMIT`);
    const r = await db.execute(`SELECT COUNT(*) FROM t`);
    expect(r[0].rows).toEqual([[1]]);
  });

  it('读集版本校验单元行为（直接构造存储内部状态）', async () => {
    const s = new MemoryStorage();
    await s.init();
    await s.createTable({
      name: 't',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
        { name: 'v', type: 'INTEGER', nullable: true },
      ],
      indexes: [{ name: 'idx_t_pk_id', table: 't', column: 'id', unique: true }],
    });
    // 准备数据
    const setup = await s.begin(false);
    await s.applyMutations(setup, 't', { insert: [{ id: 1, v: 100 }] });
    await s.commit(setup);

    // T1 读
    const t1 = await s.begin(false);
    await s.scan(t1, 't', {});

    // 模拟 T1 写锁被"挂起"，让 T2 提交修改（单写多读实现下的防御性校验路径）
    (s as unknown as { writeLocked: boolean }).writeLocked = false;
    const t2 = await s.begin(false);
    await s.applyMutations(t2, 't', { update: [{ id: 1, row: { v: 200 } }] });
    await s.commit(t2);
    (s as unknown as { writeLocked: boolean }).writeLocked = true;

    // T1 提交时读集校验失败 => 冲突回滚
    await expect(s.commit(t1)).rejects.toBeInstanceOf(SqlError);
    await s.rollback(t1).catch(() => {});
  });
});
