// ============================================================
// 极简测试框架（零依赖）：describe/it/expect，输出汇总
// ============================================================

type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
}

interface Suite {
  name: string;
  cases: TestCase[];
}

const suites: Suite[] = [];
let current: Suite | null = null;

export function describe(name: string, fn: () => void): void {
  current = { name, cases: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name: string, fn: TestFn): void {
  if (!current) throw new Error('it() outside describe()');
  current.cases.push({ name, fn });
}

interface Failure {
  suite: string;
  name: string;
  error: Error;
}

export async function runAll(): Promise<number> {
  let passed = 0;
  const failures: Failure[] = [];
  const started = Date.now();

  for (const suite of suites) {
    console.log(`\n${suite.name}`);
    for (const tc of suite.cases) {
      try {
        await tc.fn();
        passed++;
        console.log(`  ✓ ${tc.name}`);
      } catch (e) {
        failures.push({ suite: suite.name, name: tc.name, error: e as Error });
        console.log(`  ✗ ${tc.name}`);
        console.log(`      ${(e as Error).message.split('\n').join('\n      ')}`);
      }
    }
  }

  const total = passed + failures.length;
  const elapsed = Date.now() - started;
  console.log(`\n========================================`);
  console.log(`${passed}/${total} passed, ${failures.length} failed (${elapsed}ms)`);
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) {
      console.log(`  - [${f.suite}] ${f.name}`);
      console.log(`      ${f.error.message}`);
    }
  }
  return failures.length === 0 ? 0 : 1;
}

// ------------------------------------------------------------
// 断言
// ------------------------------------------------------------
export function expect<T>(actual: T): Assertion<T> {
  return new Assertion(actual);
}

class Assertion<T> {
  constructor(private actual: T) {}

  toBe(expected: T): void {
    if (!Object.is(this.actual, expected)) {
      throw new Error(`expected ${fmt(this.actual)} to be ${fmt(expected)}`);
    }
  }

  toEqual(expected: unknown): void {
    if (!deepEqual(this.actual, expected)) {
      throw new Error(`expected ${fmt(this.actual)} to deeply equal ${fmt(expected)}`);
    }
  }

  toBeCloseTo(expected: number, epsilon = 1e-9): void {
    const a = this.actual as unknown as number;
    if (typeof a !== 'number' || Math.abs(a - expected) > epsilon) {
      throw new Error(`expected ${fmt(this.actual)} to be close to ${expected}`);
    }
  }

  toBeNull(): void {
    if (this.actual !== null) throw new Error(`expected ${fmt(this.actual)} to be null`);
  }

  toBeTruthy(): void {
    if (!this.actual) throw new Error(`expected ${fmt(this.actual)} to be truthy`);
  }

  toBeFalsy(): void {
    if (this.actual) throw new Error(`expected ${fmt(this.actual)} to be falsy`);
  }

  toContain(item: unknown): void {
    if (typeof this.actual === 'string' && typeof item === 'string') {
      if (!this.actual.includes(item)) {
        throw new Error(`expected string ${fmt(this.actual)} to contain ${fmt(item)}`);
      }
      return;
    }
    const arr = this.actual as unknown as unknown[];
    if (!Array.isArray(arr) || !arr.some((x) => deepEqual(x, item))) {
      throw new Error(`expected ${fmt(this.actual)} to contain ${fmt(item)}`);
    }
  }

  toHaveLength(n: number): void {
    const arr = this.actual as unknown as { length: number };
    if (arr?.length !== n) {
      throw new Error(`expected length ${arr?.length} to be ${n}`);
    }
  }

  toThrow(expectedMessage?: string | RegExp): void {
    const fn = this.actual as unknown as () => unknown;
    let threw: Error | null = null;
    try { fn(); } catch (e) { threw = e as Error; }
    if (!threw) throw new Error('expected function to throw, but it did not');
    if (expectedMessage !== undefined) {
      const msg = threw.message;
      const ok = expectedMessage instanceof RegExp ? expectedMessage.test(msg) : msg.includes(expectedMessage);
      if (!ok) throw new Error(`expected error message "${msg}" to match ${expectedMessage}`);
    }
  }

  async rejects(expectedMessage?: string | RegExp): Promise<void> {
    const p = this.actual as unknown as Promise<unknown>;
    let threw: Error | null = null;
    try { await p; } catch (e) { threw = e as Error; }
    if (!threw) throw new Error('expected promise to reject, but it resolved');
    if (expectedMessage !== undefined) {
      const msg = threw.message;
      const ok = expectedMessage instanceof RegExp ? expectedMessage.test(msg) : msg.includes(expectedMessage);
      if (!ok) throw new Error(`expected error message "${msg}" to match ${expectedMessage}`);
    }
  }
}

export async function expectReject<T>(p: Promise<T>, message?: string | RegExp): Promise<void> {
  let threw: Error | null = null;
  try { await p; } catch (e) { threw = e as Error; }
  if (!threw) throw new Error('expected promise to reject, but it resolved');
  if (message !== undefined) {
    const ok = message instanceof RegExp ? message.test(threw.message) : threw.message.includes(message);
    if (!ok) throw new Error(`expected error message "${threw.message}" to match ${message}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>).sort();
  const bk = Object.keys(b as Record<string, unknown>).sort();
  if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return '[fn]';
  try { return JSON.stringify(v); } catch { return String(v); }
}
