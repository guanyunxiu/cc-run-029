// 测试入口：导入所有用例并执行
import './basic.test';
import './join.test';
import './aggregate.test';
import './subquery.test';
import './null.test';
import './types.test';
import './features.test';
import './idb.test';
import { runAll } from './harness';

export async function run(): Promise<number> {
  return runAll();
}
