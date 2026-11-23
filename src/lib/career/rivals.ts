/**
 * A career's AI drivers: made-up people (no real driver's name or code), each with a pace, a temper and a consistency
 * of their own that stay with them for the whole career. A season's grid is drawn from them: the ones who finished
 * well in the last season move up with the player ("promoted alongside"), the rest come in from the pool.
 *
 * The race's AI field is built from exactly these drivers (their codes are the codes the race shows), so a result maps
 * back to its driver by code. A rival's code never equals the player's: each has a second one for that.
 */
import type { AiDriverDef } from "@/lib/sim/ai-opponents";

export interface CareerRival {
  id: string;
  first: string;
  last: string;
  /** Three letters, shown on the timing tower */
  code: string;
  /** Used instead of `code` when the player's own code is the same */
  altCode: string;
  number: number;
  color: string;
  /** 0..1: how quick they are against the rest of the field */
  rating: number;
  /** -1 waits for a clear gap ... +1 late lunges (ai-opponents.ts) */
  aggression: number;
  /** Lap-to-lap repeatability (-0.1 ... +0.1) */
  consistency: number;
}

/** Codes of real drivers (recent Formula 1): never used, so no rival reads as a real person */
const REAL_CODES = new Set([
  "VER", "HAM", "LEC", "NOR", "PIA", "RUS", "SAI", "ALO", "GAS", "OCO", "ALB", "STR", "HUL", "TSU", "BOT", "ZHO",
  "MAG", "LAW", "BEA", "ANT", "BOR", "HAD", "COL", "DOO", "PER", "RIC", "SAR", "LAT", "VET", "RAI", "KUB", "GIO",
  "MSC", "MAZ", "KVY", "GRO", "BUT", "MAS", "ROS", "WEB", "BAR", "KOB", "DIR", "VAN", "ERI", "NAS", "HAR", "GUT",
]);

/** First names and surnames to draw from: made up in their pairing, from many countries */
const FIRST = [
  "Elias", "Tomas", "Nils", "Ruben", "Ivo", "Jonah", "Kenji", "Dario", "Felix", "Hugo", "Arjun", "Sami", "Oskar",
  "Marco", "Leon", "Caio", "Diego", "Yuto", "Rafael", "Jan", "Emil", "Lena", "Ines", "Maya", "Sofia", "Chloe", "Aiko",
  "Freya", "Zara", "Nadia", "Amara", "Priya", "Kai", "Mateus", "Anders", "Pavel", "Luca", "Theo", "Bruno", "Omar",
  "Tariq", "Jules", "Mika", "Rhea", "Ilse", "Selin", "Noor", "Hana", "Wren", "Iker", "Ezra", "Soren", "Otto", "Remy",
];
const LAST = [
  "Brandt", "Kurek", "Ekberg", "Salgado", "Petrak", "Whitlock", "Arakawa", "Lucchesi", "Morrow", "Lavigne", "Mehta",
  "Halonen", "Lindqvist", "Ferrante", "Hartwig", "Moreira", "Fuentes", "Kaneda", "Duarte", "Novotny", "Strand", "Vogt",
  "Carvalho", "Okafor", "Brenner", "Marchetti", "Tanabe", "Lund", "Haddadi", "Petrova", "Mensah", "Iyer", "Takeda",
  "Quintero", "Rask", "Dvorak", "Pellegrini", "Aubert", "Castellano", "Saleh", "Benali", "Fontaine", "Koskela",
  "Desai", "Engel", "Yilmaz", "Rahimi", "Sato", "Ashby", "Etxeberria", "Calloway", "Thorsen", "Kessler", "Delacroix",
];
const COLORS = [
  "#e8442e", "#2f80ed", "#27ae60", "#f2c94c", "#9b51e0", "#eb5757", "#2d9cdb", "#6fcf97", "#f2994a", "#bb6bd9",
  "#56ccf2", "#219653", "#f2c94c", "#828282", "#ff7eb6", "#00b8a9", "#c0392b", "#16a085", "#d35400", "#8e44ad",
];

/** Small seeded generator (mulberry32) */
export function careerRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const codeOf = (last: string, taken: Set<string>): { code: string; alt: string } => {
  const up = last.toUpperCase().replace(/[^A-Z]/g, "");
  const cands = [up.slice(0, 3), up[0] + up.slice(2, 4), up[0] + up[1] + up[up.length - 1], up[0] + up.slice(-2)];
  const free = cands.filter((c) => c.length === 3 && !REAL_CODES.has(c) && !taken.has(c));
  const code = free[0] ?? `${up[0]}${up[1] ?? "X"}${taken.size % 10}`;
  taken.add(code);
  const alt = free.find((c) => c !== code) ?? `${code.slice(0, 2)}${(taken.size + 3) % 10}`;
  return { code, alt };
};

/** A career's pool of drivers (48), made the same way from the same seed */
export function makeRivals(seed: number): CareerRival[] {
  const rng = careerRng(seed ^ 0x5bd1e995);
  const firsts = [...FIRST];
  const lasts = [...LAST];
  const taken = new Set<string>();
  const numbers = new Set<number>();
  const out: CareerRival[] = [];
  for (let i = 0; i < 48 && lasts.length; i++) {
    const first = firsts.splice(Math.floor(rng() * firsts.length), 1)[0] ?? FIRST[i % FIRST.length];
    const last = lasts.splice(Math.floor(rng() * lasts.length), 1)[0];
    const { code, alt } = codeOf(last, taken);
    let number = 2 + Math.floor(rng() * 97);
    while (numbers.has(number)) number = number >= 99 ? 2 : number + 1;
    numbers.add(number);
    out.push({
      id: `r${i}`,
      first,
      last,
      code,
      altCode: alt,
      number,
      color: COLORS[Math.floor(rng() * COLORS.length)],
      rating: rng(),
      aggression: Math.round((rng() * 1.3 - 0.5) * 100) / 100,
      consistency: Math.round((rng() * 0.16 - 0.08) * 100) / 100,
    });
  }
  return out;
}

/** The code a rival races under against this player */
export const rivalCode = (r: CareerRival, playerCode: string): string => (r.code === playerCode.toUpperCase() ? r.altCode : r.code);

/** A rival as the AI field's driver: pace from the rating, in the band the field's own drivers run in */
export function rivalAsDriver(r: CareerRival, playerCode: string): AiDriverDef {
  return {
    code: rivalCode(r, playerCode),
    teamColorHex: r.color,
    pace: Math.round((0.934 + 0.042 * r.rating) * 1000) / 1000,
    aggression: r.aggression,
    consistencyBias: r.consistency,
  };
}

/**
 * A season's grid (`size` AI drivers): those carried over first (the ones promoted alongside the player), then drivers
 * the career has not raced with yet, then any, in an order the seed sets
 */
export function drawGrid(pool: readonly CareerRival[], size: number, carried: readonly string[], used: ReadonlySet<string>, seed: number): string[] {
  const rng = careerRng(seed);
  const out = carried.filter((id) => pool.some((r) => r.id === id)).slice(0, size);
  const fresh = pool.filter((r) => !out.includes(r.id) && !used.has(r.id));
  const again = pool.filter((r) => !out.includes(r.id) && used.has(r.id));
  for (const list of [fresh, again]) {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const r of shuffled) {
      if (out.length >= size) break;
      out.push(r.id);
    }
  }
  return out;
}
