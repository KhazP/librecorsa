/**
 * Stand-ins for the Cloudflare bindings the online API uses, for the headless checks: D1 on Node's built-in SQLite
 * (the same SQL runs), R2 as a map.
 */
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result, DurableObjectState, R2Bucket, ServerSocket } from '../../cloudflare/api/types';

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

/** The server end of a socket a Durable Object accepted: records what was sent to it and whether it was closed */
export class FakeSocket implements ServerSocket {
  sent: Record<string, unknown>[] = [];
  closed: number | null = null;
  /** Set while the object handles this socket's close: the real runtime still lists it then */
  closing = false;
  readyState = 1;
  tags: string[] = [];
  private attachment: unknown = null;
  send(message: string): void {
    if (this.closed !== null) throw new Error('closed');
    this.sent.push(JSON.parse(message));
  }
  close(code?: number): void {
    this.closed ??= code ?? 1000;
    this.readyState = 3;
  }
  serializeAttachment(value: unknown): void {
    this.attachment = JSON.parse(JSON.stringify(value));
  }
  deserializeAttachment(): unknown {
    return this.attachment;
  }
  last(): Record<string, unknown> | undefined {
    return this.sent[this.sent.length - 1];
  }
}

/** A Durable Object's state: storage as a map, the alarm as a number, sockets as FakeSockets */
export function fakeState(): DurableObjectState & { sockets: FakeSocket[]; alarmMs: number | null; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const sockets: FakeSocket[] = [];
  const state = {
    sockets,
    store,
    alarmMs: null as number | null,
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void store.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => store.delete(key),
      setAlarm: async (ms: number) => void (state.alarmMs = ms),
      deleteAlarm: async () => void (state.alarmMs = null),
      deleteAll: async () => {
        store.clear();
        state.alarmMs = null;
      },
    },
    acceptWebSocket(ws: ServerSocket, tags: string[] = []) {
      (ws as FakeSocket).tags = tags;
      sockets.push(ws as FakeSocket);
    },
    // As the runtime: sockets still open, and one whose close is being handled right now (`closing`)
    getWebSockets: (tag?: string) => sockets.filter((x) => (x.closed === null || x.closing) && (tag === undefined || x.tags.includes(tag))),
    setWebSocketAutoResponse() {},
  };
  return state;
}
