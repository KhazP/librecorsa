/**
 * Reuse of `VehiclePhysics.reset`'s settle between identical cars.
 *
 * Every placement settles the car for 3600 sub-steps (1.8 s simulated) before it is handed over, and that settle is
 * most of the cost of making a car: an AI field of five cars settled the same car on the same grid slot five times.
 * The settle is a pure function of the car's whole state before it and of the ground it stands on, so a car that starts
 * one in exactly the state another car started an earlier one in (every number in its body, wheels, tyres, drivetrain
 * and config, bit for bit) gets that settle's result copied instead of running it again. Nothing is approximated: the
 * copy is the state the settle would have produced.
 *
 * The state is read by walking the car's object graph, not from a list of fields, so a field added later is covered
 * without anyone remembering this file. Anything the walk cannot read for certain turns the reuse off for that settle:
 * an object it does not know (a Set, a Map keyed by objects), a ground or barrier query whose answers depend on its own
 * earlier queries, a settle that fired an event (a barrier hit) or changed the shape of the state.
 */

/**
 * Settles kept (each about 60 KB): the grid slots of a field or two, the player's car and the AI's. One that was never
 * copied goes first (a driven car's reset is never met again), then the oldest
 */
const MAX_ENTRIES = 32;

/** A car's state flattened in walk order: its numbers, its other leaves, and a hash of its shape */
interface StateWalk {
  nums: Float64Array;
  /**
   * The identity of each object entered, in walk order: a settle that put another object in a field (a wheel's
   * surface switching from the asphalt's entry in a shared table to the kerb's) is not kept, or giving it to a car
   * would write one shared object's values into another
   */
  ids: Uint32Array;
  /** Booleans, strings, null and undefined, plus a token for each object met again and each opaque object */
  others: unknown[];
  shape: number;
  hashA: number;
  hashB: number;
}

interface Entry {
  before: StateWalk;
  after: StateWalk;
  /** Times it was copied to a car */
  uses: number;
}

const memo = new Map<string, Entry>();
let enabled = true;
const stats = { hits: 0, misses: 0, stored: 0, refused: 0 };

/** Turns the reuse off (every settle runs) or back on; off clears it */
export function setSettleMemoEnabled(on: boolean): void {
  enabled = on;
  if (!on) memo.clear();
}

/** Counts since the page started, for tests and timing */
export function settleMemoStats(): Readonly<typeof stats> & { entries: number } {
  return { ...stats, entries: memo.size };
}

export function clearSettleMemo(): void {
  memo.clear();
}

const TOKEN = '\u0000';
/** A number for each object's identity (opaque queries, and every object a walk enters) */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;
const identity = (o: object): number => {
  let id = identities.get(o);
  if (id === undefined) identities.set(o, (id = nextIdentity++));
  return id;
};

class Unsupported extends Error {}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Two 32-bit running hashes (FNV-1a and a multiply-xorshift), and one of the shape alone */
class Hasher {
  a = 0x811c9dc5;
  b = 0x9e3779b9;
  shape = 0x811c9dc5;
  word(x: number): void {
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ (x >>> 16), 0x85ebca6b) ^ Math.imul(x & 0xffff, 0xc2b2ae35);
  }
  shapeWord(x: number): void {
    this.shape = Math.imul(this.shape ^ x, 0x01000193);
  }
  shapeString(s: string): void {
    for (let i = 0; i < s.length; i++) this.shapeWord(s.charCodeAt(i));
    this.shapeWord(0x2c);
  }
  number(v: number): void {
    f64[0] = v;
    this.word(u32[0]);
    this.word(u32[1]);
  }
  string(s: string): void {
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
    this.word(s.length);
  }
}

/**
 * Walks `root` depth first in own-key order. In read mode it collects the leaves into `nums` / `others`; in write mode
 * it puts `nums` / `others` (a walk of a graph of the same shape) back into the graph. Functions are skipped; objects in
 * `opaque` are not entered, they stand as their identity.
 */
class Walker {
  private readonly seen = new Map<object, number>();
  private n = 0;
  private o = 0;
  readonly nums: number[] = [];
  readonly others: unknown[] = [];
  readonly ids: number[] = [];
  readonly hash = new Hasher();

  constructor(
    private readonly opaque: ReadonlySet<object>,
    private readonly source: StateWalk | null
  ) {}

  /** Numbers that lead the walk (the settle's own inputs): read like the graph's, stepped over in write mode */
  leading(values: readonly number[]): void {
    for (const v of values) {
      this.hash.shapeWord(1);
      if (this.source) this.n++;
      else {
        this.nums.push(v);
        this.hash.number(v);
      }
    }
  }

  /** Visits `parent[key]` */
  visit(parent: Record<string | number, unknown>, key: string | number): void {
    const v = parent[key];
    const t = typeof v;
    if (t === 'function' || t === 'symbol') return;
    if (t === 'number') {
      this.hash.shapeWord(1);
      if (this.source) this.put(parent, key, this.source.nums[this.n++]);
      else {
        this.nums.push(v as number);
        this.hash.number(v as number);
      }
      return;
    }
    if (t === 'bigint') throw new Unsupported();
    if (v === null || t !== 'object') {
      this.hash.shapeWord(2);
      if (this.source) this.put(parent, key, this.source.others[this.o++]);
      else this.leaf(v);
      return;
    }
    this.object(v as object);
  }

  /** Writes only what differs: most of the state (the config) is the same, and a frozen object would throw */
  private put(parent: Record<string | number, unknown>, key: string | number, v: unknown): void {
    if (!Object.is(parent[key], v)) parent[key] = v;
  }

  private leaf(v: unknown): void {
    this.others.push(v);
    if (typeof v === 'string') this.hash.string(v);
    else this.hash.word(v === undefined ? 3 : v === null ? 4 : v ? 5 : 6);
  }

  /**
   * A token in `others` for an object met before or an opaque one. Write mode only steps over it: the graph written to
   * was read first and matched the source's shape, tokens included
   */
  private token(tok: string): void {
    this.hash.shapeWord(3);
    if (this.source) this.o++;
    else this.leaf(tok);
  }

  object(v: object): void {
    if (this.opaque.has(v)) return this.token(`${TOKEN}o${identity(v)}`);
    const at = this.seen.get(v);
    if (at !== undefined) return this.token(`${TOKEN}r${at}`);
    this.seen.set(v, this.seen.size);
    if (!this.source) this.ids.push(identity(v));
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView || v instanceof BigInt64Array || v instanceof BigUint64Array) throw new Unsupported();
      const a = v as unknown as { length: number; [i: number]: number };
      this.hash.shapeString(Object.prototype.toString.call(v));
      this.hash.shapeWord(a.length);
      if (this.source)
        for (let i = 0; i < a.length; i++) {
          const x = this.source.nums[this.n++];
          if (!Object.is(a[i], x)) a[i] = x;
        }
      else
        for (let i = 0; i < a.length; i++) {
          this.nums.push(a[i]);
          this.hash.number(a[i]);
        }
      return;
    }
    if (Array.isArray(v)) {
      this.hash.shapeWord(0x5b);
      this.hash.shapeWord(v.length);
      for (let i = 0; i < v.length; i++) this.visit(v as unknown as Record<number, unknown>, i);
      return;
    }
    if (v instanceof Map) {
      this.hash.shapeWord(0x4d);
      this.hash.shapeWord(v.size);
      for (const [k, x] of v) {
        if (typeof k === 'object' && k !== null) throw new Unsupported();
        this.hash.shapeString(String(k));
        if (x !== null && typeof x === 'object') this.object(x);
        else if (typeof x !== 'function') {
          // A primitive value in a Map is a leaf that cannot be written back in place
          throw new Unsupported();
        }
      }
      return;
    }
    const proto = Object.getPrototypeOf(v);
    if (v instanceof Set || v instanceof WeakMap || v instanceof WeakSet || v instanceof Promise || v instanceof Date || v instanceof ArrayBuffer) {
      throw new Unsupported();
    }
    this.hash.shapeString(proto?.constructor?.name ?? '');
    const rec = v as Record<string, unknown>;
    for (const k in rec) {
      if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
      this.hash.shapeString(k);
      this.visit(rec, k);
    }
  }

  result(): StateWalk {
    return {
      nums: Float64Array.from(this.nums),
      ids: Uint32Array.from(this.ids),
      others: this.others,
      shape: this.hash.shape >>> 0,
      hashA: this.hash.a >>> 0,
      hashB: this.hash.b >>> 0,
    };
  }
}

const keyOf = (w: StateWalk) => `${w.shape}:${w.hashA}:${w.hashB}:${w.nums.length}:${w.others.length}`;

function sameWalk(a: StateWalk, b: StateWalk): boolean {
  if (a.shape !== b.shape || a.nums.length !== b.nums.length || a.others.length !== b.others.length) return false;
  const ua = new Uint32Array(a.nums.buffer, a.nums.byteOffset, a.nums.length * 2);
  const ub = new Uint32Array(b.nums.buffer, b.nums.byteOffset, b.nums.length * 2);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  for (let i = 0; i < a.others.length; i++) if (!Object.is(a.others[i], b.others[i])) return false;
  return true;
}

const NO_IDS = new Uint32Array(0);
const sameIds = (a: Uint32Array, b: Uint32Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The tokens (objects met again, opaque ones) sit at the same places with the same values in both walks */
function sameTokens(a: StateWalk, b: StateWalk): boolean {
  for (let i = 0; i < a.others.length; i++) {
    const x = a.others[i];
    const y = b.others[i];
    const tx = typeof x === 'string' && x.startsWith(TOKEN);
    const ty = typeof y === 'string' && y.startsWith(TOKEN);
    if ((tx || ty) && x !== y) return false;
  }
  return true;
}

function read(root: object, opaque: ReadonlySet<object>, inputs: readonly number[]): StateWalk | null {
  try {
    const w = new Walker(opaque, null);
    w.leading(inputs);
    w.object(root);
    return w.result();
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

/**
 * A settle about to run on `car` (the settle's own inputs in `inputs`; `opaque`: the shared, stateless queries it reads,
 * taken by identity). Returns a token to finish it with: `apply` when a settle from this very state is known (the car
 * now holds its result), otherwise `store` once the settle has run.
 */
export function beginSettle(
  car: object,
  opaque: ReadonlySet<object>,
  inputs: readonly number[]
): { applied: boolean; store(eventsFired: boolean): void } {
  const none = { applied: false, store: () => {} };
  if (!enabled) return none;
  const before = read(car, opaque, inputs);
  if (!before) {
    stats.refused++;
    return none;
  }
  const key = keyOf(before);
  const hit = memo.get(key);
  if (hit && sameWalk(hit.before, before)) {
    // The car's graph was just read as the same shape as the stored settle's, so this walk lines up value for value
    const w = new Walker(opaque, hit.after);
    w.leading(inputs);
    w.object(car);
    memo.delete(key);
    memo.set(key, hit);
    hit.uses++;
    stats.hits++;
    return { applied: true, store: () => {} };
  }
  stats.misses++;
  return {
    applied: false,
    store(eventsFired: boolean) {
      if (eventsFired) {
        stats.refused++;
        return;
      }
      const after = read(car, opaque, inputs);
      if (
        !after ||
        after.shape !== before.shape ||
        after.nums.length !== before.nums.length ||
        after.others.length !== before.others.length ||
        !sameTokens(before, after) ||
        !sameIds(before.ids, after.ids)
      ) {
        stats.refused++;
        return;
      }
      // Identities are this car's, of no use to another
      memo.set(key, { before: { ...before, ids: NO_IDS }, after: { ...after, ids: NO_IDS }, uses: 0 });
      stats.stored++;
      while (memo.size > MAX_ENTRIES) {
        let drop: string | undefined;
        for (const [k, e] of memo) {
          if (k !== key && e.uses === 0) {
            drop = k;
            break;
          }
        }
        memo.delete(drop ?? (memo.keys().next().value as string));
      }
    },
  };
}
