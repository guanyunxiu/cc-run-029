// 测试辅助：每次返回全新的内存引擎
import { Database } from '../src/engine/database';
import { MemoryStorage } from '../src/engine/memory-storage';
import { Engine, type QueryResult } from '../src/engine/engine';
import { SQLError } from '../src/sql/types';
import type { DBValue } from '../src/sql/types';

export async function newEngine(): Promise<Engine> {
  const db = new Database(new MemoryStorage());
  await db.init();
  return new Engine(db);
}

/** 执行 SQL，返回第一条结果 */
export async function query(engine: Engine, sql: string): Promise<QueryResult> {
  const results = await engine.execute(sql);
  return results[0];
}

/** 取单列结果为数组 */
export async function column(engine: Engine, sql: string, col?: string): Promise<DBValue[]> {
  const r = await query(engine, sql);
  const name = col ?? r.columns[0]?.name;
  if (!name) throw new Error('no columns in result');
  return r.rows.map((row) => row[name] ?? null);
}

/** 取结果为对象数组 */
export async function rows(engine: Engine, sql: string): Promise<Record<string, DBValue>[]> {
  const r = await query(engine, sql);
  return r.rows as Record<string, DBValue>[];
}

/** 执行并期望抛 SQLError */
export async function expectSqlError(engine: Engine, sql: string, match?: RegExp | string): Promise<SQLError> {
  try {
    await engine.execute(sql);
  } catch (e) {
    const err = e as SQLError;
    if (match instanceof RegExp) {
      if (!match.test(err.message)) {
        throw new Error(`error message "${err.message}" does not match ${match}`);
      }
    } else if (typeof match === 'string') {
      if (!err.message.includes(match)) {
        throw new Error(`error message "${err.message}" does not include "${match}"`);
      }
    }
    return err;
  }
  throw new Error(`expected SQL to throw but it did not: ${sql}`);
}
