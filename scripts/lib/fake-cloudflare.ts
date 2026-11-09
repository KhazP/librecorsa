/**
 * Stand-ins for the Cloudflare bindings the online API uses, for the headless checks: D1 on Node's built-in SQLite
 * (the same SQL runs), R2 as a map.
 */
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result, R2Bucket } from '../../cloudflare/api/types';

type Bind = null | number | bigint | string;

export function fakeD1(schemaSql: string): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  const rows = (sql: string, binds: unknown[]) => db.prepare(sql).all(...(binds as Bind[])) as Record<string, unknown>[];
  const statement = (sql: string, binds: unknown[]): D1PreparedStatement & { exec(): D1Result } => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async <T>() => (rows(sql, binds)[0] as T | undefined) ?? null,
    all: async <T>() => ({ results: rows(sql, binds) as T[], success: true, meta: {} }),
    run: async () => {
      const done = db.prepare(sql).run(...(binds as Bind[]));
      return { results: [], success: true, meta: { changes: Number(done.changes) } };
    },
    exec: () => ({ results: rows(sql, binds), success: true, meta: {} }),
  });
  return {
    prepare: (sql: string) => statement(sql, []),
    // As D1: all or nothing
    batch: async (statements: D1PreparedStatement[]) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as ReturnType<typeof statement>).exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

export function fakeR2(): R2Bucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async (key: string) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key: string, value: string) => void objects.set(key, value),
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}
