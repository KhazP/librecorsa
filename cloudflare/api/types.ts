/**
 * The parts of the Workers runtime the API uses, declared here so the repository needs no workers-types dependency
 * and `tsc` checks these files with the rest of the project.
 */

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { changes?: number; last_row_id?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface R2ObjectBody {
  text(): Promise<string>;
}

export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

/** The server end of a WebSocket accepted by a Durable Object */
export interface ServerSocket {
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  readyState: number;
}

export interface DurableObjectState {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: ServerSocket, tags?: string[]): void;
  getWebSockets(tag?: string): ServerSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}

/** Bindings and settings of the librecorsa.org Worker (wrangler.jsonc); every online feature is optional */
export interface Env {
  ASSETS: { fetch(request: Request | URL | string): Promise<Response> };
  LARGE_ASSETS: unknown;
  /** Room server: pairs the players of a room code */
  ROOMS?: DurableObjectNamespace;
  /** Scheduled races: the room that runs one race slot */
  RACES?: DurableObjectNamespace;
  /** Lap boards */
  BOARD_DB?: D1Database;
  GHOSTS?: R2Bucket;
  /** Limits how often one address may open a room connection */
  ROOM_LIMIT?: RateLimit;
  /** "on" / "off" switches (wrangler.jsonc `vars`); anything but "on" is off */
  ONLINE_ROOMS?: string;
  ONLINE_RACES?: string;
  ONLINE_BOARD?: string;
  /** Seconds between scheduled races (default 1200) */
  RACE_SLOT_S?: string;
  /** Cloudflare TURN key (secrets); without them rooms connect directly only */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  /** Extra origins allowed to call the API, comma separated (local development: .dev.vars) */
  DEV_ORIGINS?: string;
  /** The anonymous usage counter (usage.ts): its switch, and how often one address may report */
  ONLINE_USAGE?: string;
  USAGE_LIMIT?: RateLimit;
  /** Key of the private admin numbers (admin.ts), a secret; without it the route does not answer */
  ADMIN_KEY?: string;
}

/** `new WebSocketPair()` and friends exist only in the Workers runtime */
export interface WorkersGlobals {
  WebSocketPair: new () => { 0: WebSocket; 1: ServerSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}

export const workers = globalThis as unknown as WorkersGlobals;
