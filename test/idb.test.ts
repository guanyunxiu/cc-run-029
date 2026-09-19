// IndexedDB 存储后端持久化与事务提交测试（Node + fake-indexeddb）
import 'fake-indexeddb/auto';
import { describe, it, expect } from './harness';
import { Database } from '../src/engine/database';
import { IndexedDbStorage } from '../src/engine/idb-storage';
import { Engine } from '../src/engine/engine';
import { column } from './helpers';

describe('IndexedDB 持久化', () => {
  it('126. 提交后重新加载，数据与表结构保留', async () => {
    const storage1 = new IndexedDbStorage('test-persist');
    const db1 = new Database(storage1);
    await db1.init();
    const e1 = new Engine(db1);
    await e1.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await e1.execute("INSERT INTO t VALUES (1,'Alice'),(2,'Bob')");

    // 用新的 Database + 同一底层 IndexedDB 重新加载
    const db2 = new Database(new IndexedDbStorage('test-persist'));
    await db2.init();
    const e2 = new Engine(db2);
    expect(await column(e2, 'SELECT name FROM t ORDER BY id')).toEqual(['Alice', 'Bob']);
  });

  it('127. 事务回滚后底层存储无残留', async () => {
    const db = new Database(new IndexedDbStorage('test-rollback'));
    await db.init();
    const e = new Engine(db);
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('BEGIN');
    await e.execute('INSERT INTO t VALUES (1),(2)');
    await e.execute('ROLLBACK');
    // 重新加载确认持久层干净
    const db2 = new Database(new IndexedDbStorage('test-rollback'));
    await db2.init();
    const e2 = new Engine(db2);
    expect(await column(e2, 'SELECT COUNT(*) FROM t')).toEqual([0]);
  });

  it('128. DROP TABLE 重新加载后表与行均消失', async () => {
    const db = new Database(new IndexedDbStorage('test-drop'));
    await db.init();
    const e = new Engine(db);
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    await e.execute('INSERT INTO t VALUES (1)');
    await e.execute('DROP TABLE t');
    const db2 = new Database(new IndexedDbStorage('test-drop'));
    await db2.init();
    const e2 = new Engine(db2);
    let threw = false;
    try { await e2.execute('SELECT * FROM t'); } catch { threw = true; }
    expect(threw).toBeTruthy();
  });

  it('129. AUTOINCREMENT 序列在重载后正确恢复', async () => {
    const db = new Database(new IndexedDbStorage('test-seq'));
    await db.init();
    const e = new Engine(db);
    await e.execute('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)');
    await e.execute('INSERT INTO t VALUES (50, 1)');
    const db2 = new Database(new IndexedDbStorage('test-seq'));
    await db2.init();
    const e2 = new Engine(db2);
    await e2.execute("INSERT INTO t (v) VALUES (2)");
    expect(await column(e2, 'SELECT id FROM t')).toEqual([50, 51]);
  });
});
