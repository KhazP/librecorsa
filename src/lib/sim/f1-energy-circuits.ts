/**
 * Each circuit's 2026 F1 energy rules, as the FIA's Race Director gives them to the teams before an event ("Power Unit
 * Information", one per Grand Prix; FIA 2026 F1 Regulations Section B7.2.1 b): the recharge allowed a lap in each
 * session (C5.2.10), the ERS-K speed curves (C5.2.8), the race's sectors on the 250 kW curve (C5.2.8 iii), the sectors
 * where a power-limited period may start with a larger cut (C5.12.4) or a cut be reset (C5.12.5), the rate of the
 * cuts (C5.12.6) and the Overtake Detection and Activation Lines (B7.2.3).
 *
 * - Circuits F1 races on: the FIA's figures for the 2026 event, its lap distances moved onto this circuit's lap by the
 *   braking points of the real 2026 laps (this lap's start and length differ from the FIA's centreline).
 * - Every other circuit: derived the way the FIA's figures fall across the 2026 calendar. The recharge by the share of
 *   the lap spent flat out and the braking a lap has to recover from (Monaco, Hungary and Singapore at one end, Monza
 *   and Las Vegas at the other); the 250 kW sectors on the runs that feed no overtaking straight ("350 kW in key
 *   acceleration zones, from corner exit to braking point, including overtaking zones": the FIA, 20 Apr 2026); the
 *   cut rate 50 kW/s where over 3.5 km of the lap is flat out (C5.12.6 a); the Overtake lines at the last DRS zone.
 */
import type { TrackSamplePoint } from '@/types/f1';
import type { LapWindow } from './straight-mode-zones';

/** The session a lap is driven in: its recharge allowance and which sectors apply */
export type EnergySession = 'race' | 'practice' | 'timeTrial';

/** The ERS-K speed curves of an event (C5.2.8): the base pair, or Monaco's and Singapore's lower "Rev 1" */
export type ErsCurveSet = 'base' | 'rev1';

/** A stretch of the lap (m from this circuit's line), wrapping past the line when `fromM` > `toM` */
export interface LapStretch {
  fromM: number;
  toM: number;
}

export interface F1EnergyCircuit {
  /** Where the figures come from */
  source: 'fia-2026' | 'derived';
  /** Recharge allowed a lap (J) by session; a race lap begun with Overtake activated may recharge `overtakeExtraJ` more */
  recharge: Record<EnergySession, number>;
  overtakeExtraJ: number;
  curves: ErsCurveSet;
  /** Race and sprint: where the 250 kW curve applies in a power-limited period (C5.2.8 iii) */
  alt1: LapStretch[];
  /** Where a power-limited period may start with a cut of up to `maxW` (C5.12.4); some in qualifying only */
  bigCut: (LapStretch & { maxW: number; timeTrialOnly: boolean })[];
  /** Where a cut may be reset (C5.12.5): the qualifying lap's launch out of the last corner */
  reset: (LapStretch & { timeTrialOnly: boolean })[];
  /** The cuts' rate (W/s, C5.12.6) */
  cutRateWps: number;
  /** Overtake: judged at the Detection Line, activated at the Activation Line (lap m; null without) */
  detectionM: number | null;
  activationM: number | null;
  /**
   * Where an Overtake is spent in a race (the AI's and the Automatic Overtake's): the DRS zones and straights, or on a
   * circuit with neither (Monaco) its two longest runs between braking zones
   */
  overtakeZones: LapStretch[];
}

/** Is lap distance s inside a stretch (wrapping) */
export function inStretch(s: number, w: LapStretch): boolean {
  return w.fromM <= w.toM ? s >= w.fromM && s <= w.toM : s >= w.fromM || s <= w.toM;
}

const MJ = 1e6;

// ---------------------------------------------------------------------------------------------------------------------
// The FIA's 2026 events

interface FiaEvent {
  /** This circuit's lap the anchors were measured on (m): another build of it moves its corners */
  lapM: number;
  /** FIA lap distance (from the Control Line, on its centreline) → this circuit's, at the braking points of the corners
   * the real 2026 qualifying laps brake for, in lap order */
  anchors: [fia: number, ours: number][];
  /** The FIA centreline (m) */
  fiaLapM: number;
  recharge: { race: number; qualifying: number; practice: number };
  curves: ErsCurveSet;
  alt1: [number, number][];
  bigCut: [number, number, number, boolean][];
  reset: [number, number, boolean][];
  cutRateWps: number;
  detectionM: number;
  activationM: number;
}

/**
 * The FIA Race Director's Power Unit Information (2026), lap distances in its metres [regulation]. The anchors: the
 * braking points of the 2026 pole laps (OpenF1 car data, distance by speed, scaled to the centreline) against this
 * circuit's braking zones (`brakingZones`)
 */
const FIA_EVENTS: Readonly<Record<string, FiaEvent>> = {
  // Monaco Grand Prix, 5-7 June 2026, Document 4 (3 June): no 250 kW sectors; the lower Rev 1 curves
  monaco: {
    lapM: 3309.26,
    fiaLapM: 3337,
    anchors: [[78, 66], [640, 601], [837, 833], [1016, 976], [1181, 1161], [1300, 1280], [1362, 1360], [1983, 1944], [2300, 2242], [2619, 2614], [2711, 2700], [2833, 2835], [2966, 2931]],
    recharge: { race: 8.5, qualifying: 9.0, practice: 9.0 },
    curves: 'rev1',
    alt1: [],
    bigCut: [[2980, 3200, 350_000, true]],
    reset: [[3070, 3400, true]],
    cutRateWps: 100_000,
    // "80 m after T16", "40 m after T18"
    detectionM: 2805,
    activationM: 2950,
  },
  // Austrian Grand Prix, 26-28 June 2026, Document 5 (25 June). The document's 4.236 km centreline is a slip: its
  // circuit map gives 4.326 km, and its sectors fit that
  spielberg: {
    lapM: 4314.25,
    fiaLapM: 4326,
    anchors: [[336, 194], [1264, 1125], [2088, 1938], [2607, 2445], [2968, 2754], [3749, 3541], [3916, 3746]],
    recharge: { race: 8.0, qualifying: 6.0, practice: 8.5 },
    curves: 'base',
    // T4-T7, T9-T10
    alt1: [[2170, 2960], [3720, 3920]],
    // T6-T7, T9-T10; [Exit T10] in qualifying only
    bigCut: [[2700, 3000, 350_000, false], [3750, 3900, 350_000, false], [3950, 4150, 350_000, true]],
    reset: [[4100, 4400, true]],
    cutRateWps: 100_000,
    // "50 m before T10", "110 m after T10"
    detectionM: 3936,
    activationM: 4088,
  },
};

/** An FIA lap distance on this circuit's lap: between the braking points it lies between, in proportion */
function fiaToLap(e: FiaEvent, lapM: number, fiaM: number): number {
  const a = e.anchors;
  const last = a[a.length - 1];
  // The anchors with the last one a lap back and the first a lap on, so every distance lies between two of them
  const ext: [number, number][] = [[last[0] - e.fiaLapM, last[1] - lapM], ...a, [a[0][0] + e.fiaLapM, a[0][1] + lapM]];
  const f = ((fiaM % e.fiaLapM) + e.fiaLapM) % e.fiaLapM;
  let s = (f * lapM) / e.fiaLapM;
  for (let k = 0; k + 1 < ext.length; k++) {
    const [f0, s0] = ext[k];
    const [f1, s1] = ext[k + 1];
    if (f >= f0 && f <= f1) {
      s = s0 + ((f - f0) * (s1 - s0)) / (f1 - f0);
      break;
    }
  }
  return ((s % lapM) + lapM) % lapM;
}

function fromFia(e: FiaEvent, lapM: number): Omit<F1EnergyCircuit, 'overtakeZones'> {
  const at = (m: number) => Math.round(fiaToLap(e, lapM, m));
  const r = e.recharge;
  return {
    source: 'fia-2026',
    recharge: { race: r.race * MJ, practice: r.practice * MJ, timeTrial: r.qualifying * MJ },
    overtakeExtraJ: 0.5 * MJ,
    curves: e.curves,
    alt1: e.alt1.map(([a, b]) => ({ fromM: at(a), toM: at(b) })),
    bigCut: e.bigCut.map(([a, b, maxW, timeTrialOnly]) => ({ fromM: at(a), toM: at(b), maxW, timeTrialOnly })),
    reset: e.reset.map(([a, b, timeTrialOnly]) => ({ fromM: at(a), toM: at(b), timeTrialOnly })),
    cutRateWps: e.cutRateWps,
    detectionM: at(e.detectionM),
    activationM: at(e.activationM),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Every other circuit

/**
 * The braking zones of a circuit from the speed profile baked into its samples: where the profile asks for over half
 * of a car's braking (1.6 g slow, rising with downforce to 5.1 g, as the braking guide's red) over 13.5 m, and falls
 * by at least 36 km/h in all. 1 per sample in a zone
 */
export function brakingZones(samples: ReadonlyArray<TrackSamplePoint>, lapM: number): Uint8Array {
  const n = samples.length;
  const ds = lapM / n;
  const v = Float64Array.from(samples, (p) => (p.brakeLimitKmh ?? p.optimalSpeedKmh) / 3.6);
  const k = Math.max(1, Math.round(13.5 / ds));
  const hard = (i: number): boolean => {
    const a = v[i];
    const b = v[(i + k) % n];
    return (a * a - b * b) / (2 * k * ds) > 0.52 * 9.81 * (1.6 + 3.5 * Math.min(1, (a / 83) ** 2));
  };
  const zone = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!hard(i) || hard((i - 1 + n) % n)) continue;
    let j = i;
    let vMin = v[i];
    while (hard(j % n) && j - i < n) vMin = Math.min(vMin, v[(++j + k - 1) % n]);
    if (v[i] - vMin >= 10) for (let m = i; m < j; m++) zone[m % n] = 1;
  }
  return zone;
}

/** How a circuit's lap is driven, from its baked speed profile: the share of it flat out and its braking time (s) */
export function lapCharacter(samples: ReadonlyArray<TrackSamplePoint>, lapM: number): { flatShare: number; flatM: number; brakingS: number } {
  const n = samples.length;
  const ds = lapM / n;
  const v = samples.map((p) => Math.max(1, (p.brakeLimitKmh ?? p.optimalSpeedKmh) / 3.6));
  const top = Math.max(...v);
  let flatM = 0;
  let brakingS = 0;
  for (let i = 0; i < n; i++) {
    const dv = v[(i + 1) % n] - v[i];
    if (dv > 0.002 || (Math.abs(dv) <= 0.002 && v[i] > 0.9 * top)) flatM += ds;
    if (dv < -0.05) brakingS += ds / v[i];
  }
  return { flatShare: flatM / lapM, flatM, brakingS };
}

/**
 * The recharge a lap (MJ) for a circuit of this character, by the 2026 events' figures [regulation; the classes are
 * this game's reading of them]. The flat-out share is the baked profile's, which runs some 10 % over the FIA's
 * power-limited distance (Monaco 54 % against 42 %, the Red Bull Ring 76 % against 68 %)
 */
function rechargeFor(flatShare: number, brakingS: number): FiaEvent['recharge'] {
  // Monaco, Hungary, Singapore: 8.5 race, 9.0 in qualifying and practice
  if (flatShare < 0.58) return { race: 8.5, qualifying: 9.0, practice: 9.0 };
  // Suzuka, Miami, Barcelona, Madrid, Austin: 8.5, qualifying 8.0 (their median), practice 9.0
  if (flatShare < 0.7) return { race: 8.5, qualifying: 8.0, practice: 9.0 };
  // Austria, Silverstone, Melbourne, Montreal, Spa: 8.0, qualifying 6.5, practice 8.5
  if (flatShare < 0.8) return { race: 8.0, qualifying: 6.5, practice: 8.5 };
  // Monza-class low-braking circuits: 7.0 race, 4.0-5.0 qualifying (C5.2.10 ii floor is 4 MJ), 7.5 practice
  if (brakingS < 16) return { race: 7.0, qualifying: 4.0, practice: 7.5 };
  if (brakingS < 20) return { race: 7.0, qualifying: 5.0, practice: 7.5 };
  // Las Vegas: long straights into heavy braking: 8.0, qualifying 6.0, practice 8.5
  return { race: 8.0, qualifying: 6.0, practice: 8.5 };
}

/**
 * The race's 250 kW sectors: the runs between braking zones that feed no overtaking straight (a straight-mode stretch
 * or a DRS zone), each from the braking zone it starts in to the one it ends at, runs next to each other joined. A
 * circuit with no overtaking straight at all has none (Monaco: the FIA gives it lower curves instead). No more than
 * `ALT1_MAX_SHARE` of the lap: past it the longest of those runs stay at 350 kW, as a circuit's main acceleration zones
 * do (the 2026 events: 12 to 40 % of the lap, Madrid's 66 % the one outlier)
 */
const ALT1_MAX_SHARE = 0.4;

function derivedAlt1(zone: Uint8Array, lapM: number, straights: readonly LapWindow[]): LapStretch[] {
  const n = zone.length;
  const ds = lapM / n;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    if (zone[i] && !zone[(i - 1 + n) % n]) starts.push(i);
    if (zone[i] && !zone[(i + 1) % n]) ends.push(i);
  }
  if (starts.length < 2) return [];
  // Each run: from the end of one braking zone to the start of the next
  const runs: { from: number; to: number; main: boolean }[] = [];
  for (const e of ends) {
    const next = starts.find((s) => s > e) ?? starts[0] + n;
    const fromM = (e + 1) * ds;
    const toM = next * ds;
    const main = straights.some((w) => {
      const a = w.start * lapM;
      const b = (w.end < w.start ? w.end + 1 : w.end) * lapM;
      const lo = fromM;
      const hi = toM;
      return Math.min(hi, b) > Math.max(lo, a) || Math.min(hi, b + lapM) > Math.max(lo, a + lapM) || Math.min(hi + lapM, b) > Math.max(lo + lapM, a);
    });
    runs.push({ from: fromM, to: toM, main });
  }
  runs.sort((a, b) => a.from - b.from);
  if (!runs.some((r) => r.main)) return [];
  // Join the runs that feed no straight with the braking zones between them, from the first's braking zone on
  const join = (): LapStretch[] => {
    const out: LapStretch[] = [];
    let open: { from: number; to: number } | null = null;
    for (const r of runs) {
      if (r.main) {
        if (open) out.push({ fromM: open.from, toM: open.to });
        open = null;
      } else if (open) {
        open.to = r.to;
      } else {
        open = { from: r.from, to: r.to };
      }
    }
    if (open) out.push({ fromM: open.from, toM: open.to });
    return out;
  };
  // The longest runs back on 350 kW until the sectors are no more than the share of the lap
  const len = (r: { from: number; to: number }) => r.to - r.from;
  const byLength = runs.filter((r) => !r.main).sort((a, b) => len(b) - len(a));
  let out = join();
  for (const r of byLength) {
    if (out.reduce((a, w) => a + (w.toM - w.fromM), 0) <= ALT1_MAX_SHARE * lapM) break;
    r.main = true;
    out = join();
  }
  return out.map((w) => ({ fromM: Math.round(w.fromM % lapM), toM: Math.round(w.toM % lapM) }));
}

/** The runs between braking zones (lap m, the run's start past its end when it wraps), longest first */
function runsBetweenBraking(zone: Uint8Array, lapM: number): LapStretch[] {
  const n = zone.length;
  const ds = lapM / n;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    if (zone[i] && !zone[(i - 1 + n) % n]) starts.push(i);
    if (zone[i] && !zone[(i + 1) % n]) ends.push(i);
  }
  const runs = ends.map((e) => {
    const next = starts.find((s) => s > e) ?? (starts[0] ?? e) + n;
    return { fromM: (e + 1) * ds, toM: next * ds };
  });
  runs.sort((a, b) => b.toM - b.fromM - (a.toM - a.fromM));
  return runs.map((r) => ({ fromM: Math.round(r.fromM % lapM), toM: Math.round(r.toM % lapM) }));
}

/** Where to spend an Overtake: the DRS zones and straights (lap fractions), or the two longest runs on a circuit with neither */
function overtakeZonesOf(zone: Uint8Array, lapM: number, overtaking: readonly LapWindow[]): LapStretch[] {
  if (overtaking.length > 0) return overtaking.map((w) => ({ fromM: Math.round(w.start * lapM), toM: Math.round(w.end * lapM) }));
  return runsBetweenBraking(zone, lapM).slice(0, 2);
}

const circuitCache = new WeakMap<ReadonlyArray<TrackSamplePoint>, Map<string, F1EnergyCircuit>>();

/**
 * A circuit's energy rules: the FIA's for an event it holds (when this is the build of the circuit they were
 * measured on), else derived from its profile, its straights and its DRS zones
 */
export function f1EnergyCircuit(
  trackId: string,
  samples: ReadonlyArray<TrackSamplePoint>,
  lapM: number,
  straights: readonly LapWindow[],
  drsZones: readonly { detection: number; start: number; end: number }[]
): F1EnergyCircuit {
  let perId = circuitCache.get(samples);
  if (!perId) circuitCache.set(samples, (perId = new Map()));
  const cached = perId.get(trackId);
  if (cached) return cached;
  const event = FIA_EVENTS[trackId];
  const zones = brakingZones(samples, lapM);
  const overtaking = [...straights, ...drsZones.map((z) => ({ start: z.start, end: z.end }))];
  let out: F1EnergyCircuit;
  if (event && Math.abs(event.lapM - lapM) <= 1) {
    out = { ...fromFia(event, lapM), overtakeZones: overtakeZonesOf(zones, lapM, overtaking) };
  } else {
    const ch = lapCharacter(samples, lapM);
    const r = rechargeFor(ch.flatShare, ch.brakingS);
    // The Overtake lines at the last DRS zone before the line: judged at its detection point, active from its start
    const last = [...drsZones].sort((a, b) => a.detection - b.detection).pop();
    out = {
      source: 'derived',
      recharge: { race: r.race * MJ, practice: r.practice * MJ, timeTrial: r.qualifying * MJ },
      overtakeExtraJ: 0.5 * MJ,
      curves: 'base',
      alt1: derivedAlt1(zones, lapM, overtaking),
      bigCut: [],
      reset: [],
      // The FIA's power-limited distance runs some 16 % under the baked flat-out distance
      cutRateWps: 0.84 * ch.flatM > 3500 ? 50_000 : 100_000,
      detectionM: last ? Math.round(last.detection * lapM) : null,
      activationM: last ? Math.round(last.start * lapM) : null,
      overtakeZones: overtakeZonesOf(zones, lapM, overtaking),
    };
  }
  perId.set(trackId, out);
  return out;
}
