import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Session } from '../src/engine/session';

async function newSession() {
  const storage = new MemoryStorage();
  await storage.init();
  return new Session(storage);
}

async function rows(db: Session, sql: string) {
  const rs = await db.execute(sql);
  return rs[0].rows;
}

describe('冒烟：增删改查基本链路', () => {
  let db: Session;
  beforeEach(async () => {
    db = await newSession();
    await db.execute(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        age INTEGER,
        active BOOLEAN DEFAULT TRUE
      );
    `);
  });

  it('建表 + 插入 + 查询', async () => {
    await db.execute(`INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25), ('Carol', NULL)`);
    const r = await rows(db, `SELECT id, name, age FROM users ORDER BY id`);
    expect(r).toEqual([
      [1, 'Alice', 30],
      [2, 'Bob', 25],
      [3, 'Carol', null],
    ]);
  });

  it('默认值', async () => {
    await db.execute(`INSERT INTO users (name) VALUES ('Dave')`);
    const r = await rows(db, `SELECT active FROM users WHERE name = 'Dave'`);
    expect(r).toEqual([[true]]);
  });

  it('UPDATE', async () => {
    await db.execute(`INSERT INTO users (name, age) VALUES ('Alice', 30)`);
    await db.execute(`UPDATE users SET age = 31 WHERE name = 'Alice'`);
    const r = await rows(db, `SELECT age FROM users`);
    expect(r).toEqual([[31]]);
  });

  it('DELETE', async () => {
    await db.execute(`INSERT INTO users (name) VALUES ('A'), ('B')`);
    await db.execute(`DELETE FROM users WHERE name = 'A'`);
    const r = await rows(db, `SELECT name FROM users ORDER BY name`);
    expect(r).toEqual([['B']]);
  });

  it('WHERE 比较 + AND/OR', async () => {
    await db.execute(`INSERT INTO users (name, age) VALUES ('A', 10), ('B', 20), ('C', 30)`);
    const r = await rows(db, `SELECT name FROM users WHERE age >= 20 AND name <> 'C' ORDER BY name`);
    expect(r).toEqual([['B']]);
  });

  it('LIMIT/OFFSET', async () => {
    await db.execute(`INSERT INTO users (name) VALUES ('A'),('B'),('C'),('D')`);
    const r = await rows(db, `SELECT name FROM users ORDER BY id LIMIT 2 OFFSET 1`);
    expect(r).toEqual([['B'], ['C']]);
  });
});
