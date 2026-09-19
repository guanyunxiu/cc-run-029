// 内建标量函数
import { SqlValue } from '../sql/types';
import { sqlCompare } from './value';

function nullEq(a: SqlValue, b: SqlValue): boolean {
  if (a === null || b === null) return false;
  return sqlCompare(a, b) === 0;
}

export const SCALAR_FUNCTIONS = new Set(['ABS', 'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'COALESCE', 'NULLIF', 'ROUND']);

export function evalScalarFunction(name: string, args: SqlValue[]): SqlValue {
  switch (name) {
    case 'ABS': {
      const v = args[0];
      if (v === null) return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Math.abs(n);
    }
    case 'UPPER':
      return args[0] === null ? null : String(args[0]).toUpperCase();
    case 'LOWER':
      return args[0] === null ? null : String(args[0]).toLowerCase();
    case 'TRIM':
      return args[0] === null ? null : String(args[0]).trim();
    case 'LENGTH':
      return args[0] === null ? null : String(args[0]).length;
    case 'ROUND': {
      const v = args[0];
      if (v === null) return null;
      const digits = args[1] === null || args[1] === undefined ? 0 : Number(args[1]);
      const f = Math.pow(10, digits);
      return Math.round(Number(v) * f) / f;
    }
    case 'COALESCE': {
      for (const a of args) if (a !== null && a !== undefined) return a;
      return null;
    }
    case 'NULLIF':
      return nullEq(args[0], args[1]) ? null : args[0];
    default:
      throw new Error(`未知函数: ${name}`);
  }
}
