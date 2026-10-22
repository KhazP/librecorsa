/**
 * Data-driven AI tuning, after the per-car `default.xml` + per-track override files of Speed Dreams' USR robot
 * (re-implemented from the idea, no code taken):
 *
 *   built-in defaults → class file (`public/ai/<class>.json`) → its `vehicles.<vehicleId>` block
 *     → track file (`public/ai/<class>.<track>.json`) → its `vehicles` block → per-section overrides
 *
 * A section override applies to a stretch of track given by distance (`fromM` / `toM`, like USR's `x bgn` / `x end`)
 * or by turn numbers (`turns`, with a braking lead-in), e.g. "be more careful through Degner at Suzuka".
 *
 * On top of the resolved parameters sits the player's AI skill level (0–100) and a per-driver personality; at the
 * default skill and the shipped defaults the field drives exactly as it did before this module existed.
 */
import type { BuiltTrackData } from '@/lib/track-data';

export type AiClassId = 'f1-2026' | 'gt3';

/** Everything a tuning file may set. Ranges are enforced on load (`sanitizeParams`). */
export interface AiTuningParams {
  /** Multiplier on each driver's pace (fraction of the car's limit speed); 1 = the driver as written */
  pace: number;
  /** Share of the car's braking deceleration held in reserve when planning braking points (0 = at the limit) */
  brakeMargin: number;
  /** Multiplier on cornering and braking-zone speeds (1 = the car's speed profile) */
  apexSpeedScale: number;
  /** Closest the car's centre comes to the inside / outside edge of a corner (m); 0 = the racing line as drawn */
  intMarginM: number;
  extMarginM: number;
  /** Multiplier on the path-tracking gains (higher = tighter, twitchier line following) */
  steerGain: number;
  /** 0 = dives for any gap, 1 = only passes with plenty of room and closing speed */
  overtakeCaution: number;
  /** 0 = never covers the inside, 1 = defends the inside of every braking zone when attacked */
  defend: number;
  /** Lift over crests where the car goes light (0 = flat out, 1 = careful) */
  bumpCaution: number;
  /** 0..1: lap-to-lap repeatability (1 = a robot); the skill level sets how big an inconsistency is */
  consistency: number;
}

/** What a section override may change: the parameters that make sense for a stretch of track */
export type AiSectionParams = Partial<
  Pick<AiTuningParams, 'brakeMargin' | 'apexSpeedScale' | 'intMarginM' | 'extMarginM' | 'steerGain' | 'overtakeCaution' | 'bumpCaution'>
>;

export interface AiSectionOverride {
  label?: string;
  /** Track distance range (m from the start line); `toM` < `fromM` wraps over the line */
  fromM?: number;
  toM?: number;
  /** Or: these turns (sample turn numbers), from `leadInM` before the first to the end of the last */
  turns?: number[];
  /** Braking lead-in ahead of a `turns` section (m, default 120) */
  leadInM?: number;
  params: AiSectionParams;
}

/** A `public/ai/*.json` file */
export interface AiTuningFile {
  description?: string;
  params?: Partial<AiTuningParams>;
  /** Overrides for one vehicle model of the class (`vf26`, `f12026-car`, `amg-gt3`) */
  vehicles?: Record<string, Partial<AiTuningParams>>;
  sections?: AiSectionOverride[];
}

/** The built-in defaults: the field as it drove before tuning files existed */
export const AI_TUNING_DEFAULTS: AiTuningParams = {
  pace: 1,
  brakeMargin: 0,
  apexSpeedScale: 1,
  intMarginM: 0,
  extMarginM: 0,
  steerGain: 1,
  overtakeCaution: 0.3,
  defend: 0.4,
  bumpCaution: 0,
  consistency: 0.85,
};

/** [min, max] per parameter */
export const AI_PARAM_RANGES: Record<keyof AiTuningParams, readonly [number, number]> = {
  pace: [0.8, 1.05],
  brakeMargin: [0, 0.4],
  apexSpeedScale: [0.85, 1.05],
  intMarginM: [0, 4],
  extMarginM: [0, 4],
  steerGain: [0.6, 1.5],
  overtakeCaution: [0, 1],
  defend: [0, 1],
  bumpCaution: [0, 1],
  consistency: [0, 1],
};

const PARAM_KEYS = Object.keys(AI_PARAM_RANGES) as (keyof AiTuningParams)[];
const SECTION_KEYS: readonly (keyof AiSectionParams)[] = [
  'brakeMargin',
  'apexSpeedScale',
  'intMarginM',
  'extMarginM',
  'steerGain',
  'overtakeCaution',
  'bumpCaution',
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keeps the known, finite parameters of a parsed file, clamped to their ranges */
export function sanitizeParams<K extends keyof AiTuningParams>(raw: unknown, keys: readonly K[] = PARAM_KEYS as K[]): Partial<Pick<AiTuningParams, K>> {
  const out: Partial<Pick<AiTuningParams, K>> = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (isNum(v)) out[k] = clamp(v, AI_PARAM_RANGES[k][0], AI_PARAM_RANGES[k][1]) as AiTuningParams[K];
  }
  return out;
}

function sanitizeSections(raw: unknown): AiSectionOverride[] {
  if (!Array.isArray(raw)) return [];
  const out: AiSectionOverride[] = [];
  for (const s of raw.slice(0, 64)) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const turns = Array.isArray(r.turns) ? r.turns.filter(isNum).map(Math.round) : undefined;
    const hasRange = isNum(r.fromM) && isNum(r.toM);
    if (!hasRange && !(turns && turns.length)) continue;
    out.push({
      label: typeof r.label === 'string' ? r.label.slice(0, 64) : undefined,
      fromM: hasRange ? (r.fromM as number) : undefined,
      toM: hasRange ? (r.toM as number) : undefined,
      turns: hasRange ? undefined : turns,
      leadInM: isNum(r.leadInM) ? clamp(r.leadInM, 0, 400) : undefined,
      params: sanitizeParams(r.params, SECTION_KEYS),
    });
  }
  return out;
}

export function sanitizeTuningFile(raw: unknown): AiTuningFile {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const vehicles: Record<string, Partial<AiTuningParams>> = {};
  if (r.vehicles && typeof r.vehicles === 'object') {
    for (const [id, v] of Object.entries(r.vehicles as Record<string, unknown>).slice(0, 16)) vehicles[id] = sanitizeParams(v);
  }
  return {
    description: typeof r.description === 'string' ? r.description : undefined,
    params: sanitizeParams(r.params),
    vehicles,
    sections: sanitizeSections(r.sections),
  };
}

export interface AiTuningKey {
  classId: AiClassId;
  vehicleId?: string;
  trackId?: string;
}

/** The files a resolution can draw on, keyed `<class>` and `<class>.<track>` */
export type AiTuningLibrary = Readonly<Record<string, AiTuningFile | undefined>>;

export interface ResolvedAiTuning {
  params: AiTuningParams;
  sections: AiSectionOverride[];
  /** The layers that contributed, in order (for logs and the headless report) */
  sources: string[];
}

/** defaults → class → class.vehicles[vehicle] → class.track → class.track.vehicles[vehicle]; sections from the track file */
export function resolveAiTuning(key: AiTuningKey, library: AiTuningLibrary): ResolvedAiTuning {
  const params: AiTuningParams = { ...AI_TUNING_DEFAULTS };
  const sources = ['defaults'];
  const layer = (name: string, p: Partial<AiTuningParams> | undefined) => {
    if (!p || !Object.keys(p).length) return;
    Object.assign(params, p);
    sources.push(name);
  };
  const cls = library[key.classId];
  layer(key.classId, cls?.params);
  if (key.vehicleId) layer(`${key.classId}:${key.vehicleId}`, cls?.vehicles?.[key.vehicleId]);
  const sections: AiSectionOverride[] = [...(cls?.sections ?? [])];
  if (key.trackId) {
    const trk = library[`${key.classId}.${key.trackId}`];
    layer(`${key.classId}.${key.trackId}`, trk?.params);
    if (key.vehicleId) layer(`${key.classId}.${key.trackId}:${key.vehicleId}`, trk?.vehicles?.[key.vehicleId]);
    if (trk?.sections?.length) {
      sections.push(...trk.sections);
      sources.push(`${key.classId}.${key.trackId}#sections(${trk.sections.length})`);
    }
  }
  return { params, sections, sources };
}

// -------------------------------------------------------------------------------------------------
// Skill level
// -------------------------------------------------------------------------------------------------

export const AI_SKILL_LEVELS = [
  { id: 'rookie', label: 'Rookie', value: 0 },
  { id: 'amateur', label: 'Amateur', value: 35 },
  { id: 'pro', label: 'Pro', value: 70 },
  { id: 'alien', label: 'Alien', value: 100 },
] as const;

/** Pro: the field as it drove before skill levels existed */
export const AI_SKILL_DEFAULT = 70;

export function aiSkillLabel(skill: number): string {
  let best: (typeof AI_SKILL_LEVELS)[number] = AI_SKILL_LEVELS[0];
  for (const l of AI_SKILL_LEVELS) if (Math.abs(l.value - skill) <= Math.abs(best.value - skill)) best = l;
  return best.label;
}

export interface AiSkillModifiers {
  /** × pace */
  paceMult: number;
  /** + brakeMargin */
  brakeMarginAdd: number;
  /** × apexSpeedScale */
  apexMult: number;
  /** Size of an inconsistency at consistency 0: σ of the per-lap pace error (fraction of pace) */
  lapPaceSigma: number;
  /** σ of the per-corner braking-point error (share of braking deceleration) at consistency 0 */
  cornerBrakeSigma: number;
  /** Chance per lap of a proper mistake (into one corner too hot) */
  mistakesPerLap: number;
  /** + overtakeCaution */
  cautionAdd: number;
  /** × defend */
  defendMult: number;
}

// Anchors at 0 / 35 / 70 / 100. Pro is the identity (apart from a small lap-to-lap spread).
const SKILL_ANCHORS: readonly [number, AiSkillModifiers][] = [
  [0, { paceMult: 0.94, brakeMarginAdd: 0.14, apexMult: 0.965, lapPaceSigma: 0.05, cornerBrakeSigma: 0.5, mistakesPerLap: 0.3, cautionAdd: 0.35, defendMult: 0.3 }],
  [35, { paceMult: 0.97, brakeMarginAdd: 0.06, apexMult: 0.985, lapPaceSigma: 0.03, cornerBrakeSigma: 0.3, mistakesPerLap: 0.1, cautionAdd: 0.15, defendMult: 0.7 }],
  [70, { paceMult: 1, brakeMarginAdd: 0, apexMult: 1, lapPaceSigma: 0.012, cornerBrakeSigma: 0.1, mistakesPerLap: 0, cautionAdd: 0, defendMult: 1 }],
  [100, { paceMult: 1.018, brakeMarginAdd: 0, apexMult: 1.01, lapPaceSigma: 0.006, cornerBrakeSigma: 0.05, mistakesPerLap: 0, cautionAdd: -0.15, defendMult: 1.25 }],
];

export function aiSkillModifiers(skill: number): AiSkillModifiers {
  const s = clamp(isNum(skill) ? skill : AI_SKILL_DEFAULT, 0, 100);
  let i = 0;
  while (i < SKILL_ANCHORS.length - 2 && s > SKILL_ANCHORS[i + 1][0]) i++;
  const [s0, a] = SKILL_ANCHORS[i];
  const [s1, b] = SKILL_ANCHORS[i + 1];
  const u = clamp((s - s0) / (s1 - s0), 0, 1);
  const out = {} as AiSkillModifiers;
  for (const k of Object.keys(a) as (keyof AiSkillModifiers)[]) out[k] = a[k] + (b[k] - a[k]) * u;
  return out;
}

// -------------------------------------------------------------------------------------------------
// Seeded randomness (mulberry32): the same seed gives the same race in the headless runner
// -------------------------------------------------------------------------------------------------

export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from a uniform source (Box–Muller) */
export function gaussian(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** A small stable hash of a string (driver code → seed offset) */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// -------------------------------------------------------------------------------------------------
// Track sections
// -------------------------------------------------------------------------------------------------

export interface TrackSection {
  fromM: number;
  toM: number;
  label: string;
}

const wrapS = (s: number, L: number) => ((s % L) + L) % L;

/** True when s lies in [from, to) going forward (wrapping over the line when to < from) */
export function inSection(s: number, fromM: number, toM: number, L: number): boolean {
  const x = wrapS(s, L);
  const a = wrapS(fromM, L);
  const b = wrapS(toM, L);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

/** Distance ranges of each turn number on the samples (a turn split by a short gap keeps its first start and last end) */
function turnRanges(track: BuiltTrackData): Map<number, { fromM: number; toM: number }> {
  const out = new Map<number, { fromM: number; toM: number }>();
  const n = track.samples.length;
  const L = track.totalLengthM;
  const ds = L / n;
  for (let i = 0; i < n; i++) {
    const t = track.samples[i].turnNumber;
    if (!t) continue;
    const s = i * ds;
    const r = out.get(t);
    if (!r) out.set(t, { fromM: s, toM: s + ds });
    else r.toM = s + ds;
  }
  return out;
}

/** Resolves `turns` overrides to distances */
export function resolveSectionRanges(track: BuiltTrackData, sections: readonly AiSectionOverride[]): (AiSectionOverride & { fromM: number; toM: number })[] {
  const ranges = turnRanges(track);
  const out: (AiSectionOverride & { fromM: number; toM: number })[] = [];
  for (const sec of sections) {
    if (isNum(sec.fromM) && isNum(sec.toM)) {
      out.push({ ...sec, fromM: sec.fromM, toM: sec.toM });
      continue;
    }
    const rs = (sec.turns ?? []).map((t) => ranges.get(t)).filter((r): r is { fromM: number; toM: number } => Boolean(r));
    if (!rs.length) continue;
    const fromM = Math.min(...rs.map((r) => r.fromM)) - (sec.leadInM ?? 120);
    const toM = Math.max(...rs.map((r) => r.toM));
    out.push({ ...sec, fromM: wrapS(fromM, track.totalLengthM), toM });
  }
  return out;
}

/**
 * The lap cut into corners for learning: each turn with the straight before it (where its braking happens).
 * Tracks without turn numbers fall back to 400 m pieces.
 */
export function cornerSections(track: BuiltTrackData): TrackSection[] {
  const L = track.totalLengthM;
  const ranges = [...turnRanges(track).entries()].sort((a, b) => a[1].fromM - b[1].fromM);
  if (ranges.length < 2) {
    const n = Math.max(1, Math.round(L / 400));
    return Array.from({ length: n }, (_, i) => ({ fromM: (i * L) / n, toM: ((i + 1) * L) / n, label: `S${i + 1}` }));
  }
  // Merge turns whose ends are close (a chicane is one corner to learn)
  const merged: { fromM: number; toM: number; label: string }[] = [];
  for (const [t, r] of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.fromM - last.toM < 40) {
      last.toM = r.toM;
      last.label += `-${t}`;
    } else merged.push({ fromM: r.fromM, toM: r.toM, label: `T${t}` });
  }
  return merged.map((m, i) => ({
    fromM: i === 0 ? merged[merged.length - 1].toM - L : merged[i - 1].toM,
    toM: m.toM,
    label: m.label,
  })).map((m) => ({ ...m, fromM: wrapS(m.fromM, L) }));
}

// -------------------------------------------------------------------------------------------------
// Per-position tuning along the lap
// -------------------------------------------------------------------------------------------------

/** Grid spacing of the per-position tuning (m) */
export const AI_TUNING_STEP_M = 5;

type SectionKey = keyof AiSectionParams;

/** The resolved parameters at every point of the lap (section overrides applied), on a 5 m grid */
export class AiTrackTuning {
  readonly n: number;
  readonly L: number;
  readonly values: Record<SectionKey, Float32Array>;
  readonly sections: (AiSectionOverride & { fromM: number; toM: number })[];

  constructor(
    track: BuiltTrackData,
    readonly resolved: ResolvedAiTuning
  ) {
    this.L = track.totalLengthM;
    this.n = Math.max(8, Math.ceil(this.L / AI_TUNING_STEP_M));
    this.sections = resolveSectionRanges(track, resolved.sections);
    const values = {} as Record<SectionKey, Float32Array>;
    for (const k of SECTION_KEYS) values[k] = new Float32Array(this.n).fill(resolved.params[k]);
    for (const sec of this.sections) {
      for (let i = 0; i < this.n; i++) {
        if (!inSection((i * this.L) / this.n, sec.fromM, sec.toM, this.L)) continue;
        for (const k of SECTION_KEYS) {
          const v = sec.params[k];
          if (v !== undefined) values[k][i] = v;
        }
      }
    }
    this.values = values;
  }

  get params(): AiTuningParams {
    return this.resolved.params;
  }

  at(key: SectionKey, s: number): number {
    const arr = this.values[key];
    return arr[Math.floor((wrapS(s, this.L) / this.L) * this.n) % this.n];
  }
}

// -------------------------------------------------------------------------------------------------
// Target-speed profile from a car's own limit profile
// -------------------------------------------------------------------------------------------------

const G = 9.81;

/**
 * The car's braking capability by speed, read off its own limit profile: the hardest deceleration the profile
 * plans at each speed (1 m/s bins, made non-decreasing in speed as downforce and drag grow with it).
 */
export function decelEnvelope(base: ArrayLike<number>, L: number): Float32Array {
  const n = base.length;
  const ds = L / n;
  const env = new Float32Array(130);
  for (let i = 0; i < n; i++) {
    const v0 = base[i];
    const v1 = base[(i + 1) % n];
    if (v1 >= v0) continue;
    const a = (v0 * v0 - v1 * v1) / (2 * ds);
    const b = Math.min(env.length - 1, Math.max(0, Math.floor(v1)));
    if (a > env[b]) env[b] = a;
  }
  let run = 8; // nothing brakes worse than ~0.8 g
  for (let b = 0; b < env.length; b++) {
    run = Math.max(run, env[b]);
    env[b] = run;
  }
  return env;
}

export interface TargetPointTuning {
  brakeMargin: number;
  apexScale: number;
  bumpCaution: number;
}

/**
 * Builds the target speed (m/s, same grid as `base`) from the car's limit profile: the corners and their braking
 * zones scaled by `apexScale`, a lift over crests by `bumpCaution`, then a backward braking pass at
 * (1 − brakeMargin) of the car's own deceleration so it brakes earlier. With every point at (0, 1, 0) it returns
 * the base profile unchanged.
 */
export function buildTargetSpeedProfile(
  base: ArrayLike<number>,
  track: BuiltTrackData,
  tuneAt: (s: number, i: number) => TargetPointTuning,
  env: Float32Array = decelEnvelope(base, track.totalLengthM)
): Float64Array {
  const n = base.length;
  const L = track.totalLengthM;
  const ds = L / n;
  const v = new Float64Array(n);
  const margin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    const t = tuneAt(s, i);
    const b = base[i];
    const smp = track.getSampleAtDistance(s);
    // Braking zones and corners take the apex scale; on the way out the car accelerates at whatever it can
    const braking = base[(i + 1) % n] <= b + 0.05 || Math.abs(smp.curvature) > 0.004;
    let x = braking ? b * t.apexScale : b;
    if (t.bumpCaution > 0 && smp.verticalCurvature < 0) {
      x *= 1 - 0.08 * t.bumpCaution * clamp((-smp.verticalCurvature * b * b) / G, 0, 1);
    }
    v[i] = Math.max(6, x);
    margin[i] = clamp(t.brakeMargin, 0, 0.9);
  }
  // Backward pass twice round, so the wrap over the line is consistent
  for (let pass = 0; pass < 2 * n; pass++) {
    const i = n - 1 - (pass % n);
    const j = (i + 1) % n;
    const vj = v[j];
    // (at margin 0 this only smooths the step where a scaled braking zone starts: the base already obeys `env`)
    const m = Math.max(0, margin[i]);
    const a = (1 - m) * env[Math.min(env.length - 1, Math.max(0, Math.floor(vj)))];
    const lim = Math.sqrt(vj * vj + 2 * a * ds);
    if (lim < v[i]) v[i] = lim;
  }
  return v;
}

/** Linear interpolation of a per-point array at track distance s */
export function sampleArray(values: ArrayLike<number>, s: number, L: number): number {
  const n = values.length;
  const x = (wrapS(s, L) / L) * n;
  const i0 = Math.floor(x) % n;
  const t = x - Math.floor(x);
  return values[i0] + (values[(i0 + 1) % n] - values[i0]) * t;
}
