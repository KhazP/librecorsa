/**
 * The flap button and what the HUD says about it (issues #118 and #121):
 *
 * 1. The race-control notice in the car's era's words: a 2026 car never hears "DRS (not) enabled" (its flaps open on
 *    every straight for every car); it is told of each straight ahead, and in a race of its Overtake verdict.
 * 2. A press made before a zone (or in it, off the throttle) is kept for that zone and opens the flaps as it starts, and
 *    lapses on the brake in the zone, on leaving it, on a second press, or after `FLAP_PRESS_MAX_WAIT_S`. It is never
 *    kept where the flaps can't open on that pass: too wet, or a DRS zone not earned at its detection point.
 * 3. The same on the game's car on a circuit, stepped directly and through the simulation worker's runtime.
 * 4. The corrected zones (`drs-zone-fixes.ts`): the Red Bull Ring's Turn 1 to Turn 3 zone reaches the braking for
 *    Turn 3, and no zone has a corner in it.
 *
 *   npx tsx scripts/verify-straight-mode.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { aeroNotice, aeroReadout, latestAeroEvent } from '../src/components/hud/aero-label';
import { setLc26OnRigidBody } from '../src/lib/cars/lc26-engine';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { correctedDrsZones, DRS_ZONE_FIXES } from '../src/lib/drs-zone-fixes';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createLc26Sim } from '../src/lib/sim/f12026-car/Lc26Sim';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics, type VehicleEvent, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import type { OvertakingRules } from '../src/lib/sim/overtaking-rules';
import { createSimHost, loopbackTransport } from '../src/lib/sim/runtime/sim-host';
import {
  FLAP_PRESS_MAX_WAIT_S,
  FLAP_PRESS_REACH_M,
  inLapWindow,
  type LapWindow,
  lapWindowFor,
  LOW_GRIP_ZONE_DELAY_M,
  mergeLapWindows,
  STRAIGHT_NOTICE_M,
  straightModeStretches,
  straightModeWindows,
} from '../src/lib/sim/straight-mode-zones';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { type BuiltTrackData, getActiveTrackData, type RawTrackJson, RWANDA_DRS_ZONES, setActiveTrack } from '../src/lib/track-data';
import type { CarTelemetry, F12026Channels } from '../src/types/f1';
import { hasFile, noteSkip } from './lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(74)} ${detail}`);
  if (!ok) failures.push(name);
};
const m = (frac: number, lap: number) => Math.round(frac * lap);

// ---------------------------------------------------------------------------
console.log('== The notice and the dash, in each era\'s words (aero-label.ts)');
{
  const ch = (c: Partial<F12026Channels>) => ({ hasDrs: true, drsAvailable: false, drsQueued: false, drsDetection: null, straightModeAhead: null, overtakeDetection: null, ...c }) as F12026Channels;
  const tel = (rules: OvertakingRules, c: Partial<F12026Channels>, open = false) =>
    ({ overtakingRules: rules, activeAeroMode: open ? 'X_MODE' : 'Z_MODE', f12026: ch(c) }) as Pick<CarTelemetry, 'overtakingRules' | 'activeAeroMode' | 'f12026'>;
  const drsYes = aeroNotice('drs-rear', { kind: 'detection', zone: 'ZONE_1', eligible: true });
  const drsNo = aeroNotice('drs-rear', { kind: 'detection', zone: 'ZONE_1', eligible: false });
  check('2011-2025 DRS keeps its words: "DRS enabled" / "DRS not enabled"', drsYes?.text === 'DRS enabled' && drsNo?.text === 'DRS not enabled' && drsYes.badge === 'ZONE_1');
  check('2026: a detection point is no flap notice', aeroNotice('straight-mode-2026', { kind: 'detection', zone: 'ZONE_1', eligible: false }) === null);
  const ahead = aeroNotice('straight-mode-2026', { kind: 'straight' });
  check('2026: a straight ahead is Straight Mode, as the dash names it', ahead?.text === 'Straight Mode' && ahead.badge === 'X-MODE', `${ahead?.badge} · ${ahead?.text}`);
  const earned = aeroNotice('straight-mode-2026', { kind: 'overtake', earned: true });
  const notEarned = aeroNotice('straight-mode-2026', { kind: 'overtake', earned: false });
  check('2026: the 1 s verdict is Overtake Mode\'s', earned?.badge === 'OVERTAKE' && earned.text === 'Enabled' && notEarned?.badge === 'OVERTAKE' && notEarned.text === 'Locked', `${earned?.text} / ${notEarned?.text}`);
  const words2026 = [ahead, earned, notEarned, aeroNotice('straight-mode-2026', { kind: 'queued' })].map((n) => `${n?.badge} ${n?.text}`).join(' | ');
  check('2026: no notice says DRS', !/DRS/.test(words2026), words2026);
  check('A kept press: its own notice in each era', aeroNotice('drs-rear', { kind: 'queued' })?.badge === 'DRS' && aeroNotice('straight-mode-2026', { kind: 'queued' })?.badge === 'X-MODE');
  check('No DRS (before 2011): no notice at all', aeroNotice('none', { kind: 'detection', zone: 'Z', eligible: true }) === null && aeroNotice(undefined, { kind: 'queued' }) === null);
  const det = { zone: 'ZONE_0', eligible: false, atMs: 5000 };
  check('2026 reads its own events, never the DRS detection', latestAeroEvent(tel('straight-mode-2026', { drsDetection: det })) === null);
  check(
    '2026: the newest of a straight ahead and an Overtake verdict',
    latestAeroEvent(tel('straight-mode-2026', { straightModeAhead: { atMs: 900 }, overtakeDetection: { earned: true, atMs: 800 } }))?.kind === 'straight' &&
      latestAeroEvent(tel('straight-mode-2026', { straightModeAhead: { atMs: 700 }, overtakeDetection: { earned: true, atMs: 800 } }))?.kind === 'overtake'
  );
  check('2011-2025 reads the detection point', latestAeroEvent(tel('drs-rear', { drsDetection: det, straightModeAhead: { atMs: 9000 } }))?.kind === 'detection');
  check(
    'The dash: X QUEUED / DRS QUEUED while a press is kept, X-MODE once open',
    aeroReadout(tel('straight-mode-2026', { drsQueued: true })).label === 'X QUEUED' &&
      aeroReadout(tel('drs-rear', { drsQueued: true })).label === 'DRS QUEUED' &&
      aeroReadout(tel('straight-mode-2026', { drsQueued: true }, true)).label === 'X-MODE' &&
      aeroReadout(tel('straight-mode-2026', { drsAvailable: true })).label === 'X ARMED'
  );
  check(
    'The engineering panel knows the era (X-mode and Overtake, or DRS)',
    aeroReadout(tel('straight-mode-2026', {})).straightMode && !aeroReadout(tel('drs-rear', {})).straightMode && !aeroReadout(tel('none', {})).straightMode
  );
}

// ---------------------------------------------------------------------------
console.log('\n== Stretches of the lap (straight-mode-zones.ts)');
{
  const merged = mergeLapWindows([{ start: 0.1, end: 0.2 }, { start: 0.15, end: 0.3 }, { start: 0.9, end: 1 }, { start: 0, end: 0.05 }, { start: 0.5, end: 0.6 }]);
  const text = merged.map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join(', ');
  check('Overlapping ones join, and two meeting at the line are one over it', text === '0.10-0.30, 0.50-0.60, 0.90-0.05', text);
  const ws: LapWindow[] = [{ start: 0.1, end: 0.2 }, { start: 0.9, end: 0.05 }];
  check('A press on a stretch is for it, over the line too', lapWindowFor(0.15, ws, 1000, 250)?.window === ws[0] && lapWindowFor(0.01, ws, 1000, 250)?.window === ws[1]);
  const before = lapWindowFor(0.88, ws, 1000, 250);
  check('A press within reach of one is for it', before?.window === ws[1] && Math.abs(before.aheadM - 20) < 1e-6 && lapWindowFor(0.06, ws, 1000, 250)?.window === ws[0]);
  check('A press out of reach is for none', lapWindowFor(0.5, ws, 1000, 250) === null && lapWindowFor(0.84, ws, 1000, 50) === null);
}

// ---------------------------------------------------------------------------
console.log('\n== A kept press (f12026-car model, flat ground, a 5 km "lap")');
const LAP = 5000;
const DT = 1 / 120;
// The car drives up +z from 200 m; the zone runs from 600 m to 1200 m, its detection point at 450 m
const ZONE = { id: 'Z', detection: 0.09, start: 0.12, end: 0.24 };
const sOf = (car: VehiclePhysics) => car.trackProgress * LAP;
type Phase = (s: number) => Partial<VehicleInputs>;
function flatRun(opts: {
  gated?: boolean;
  eligible?: boolean;
  startMs?: number;
  wetness?: number;
  script: Phase;
  untilS?: number;
  maxT?: number;
  /** Race control shuts the flaps from this lap distance on (a yellow flag) */
  barredFromS?: number;
  /** Race control's grip call (2026): null none, false Normal Grip, true Low Grip */
  lowGrip?: boolean | null;
}) {
  const events: VehicleEvent[] = [];
  const car = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    airDensity: 1.06,
    drsZones: [ZONE],
    locateProgress: (_x, z) => 0.04 + z / LAP,
    lapLengthM: LAP,
    drsEligibleAtDetection: () => opts.eligible ?? true,
    flapsBarred: () => opts.barredFromS !== undefined && Number.isFinite(car.trackProgress) && sOf(car) >= opts.barredFromS,
    onEvent: (e) => events.push(e),
  });
  car.drsGatedByDetection = opts.gated ?? false;
  car.drsFlaps = opts.gated ? 'rear' : 'front-rear';
  car.reset(0, 0, 0, opts.startMs ?? 40);
  car.wetness = opts.wetness ?? 0;
  car.flapsLowGrip = opts.lowGrip ?? null;
  // Front and rear downforce and drag over speed squared (N s²/m²), with the flaps' blend
  const log: { s: number; open: boolean; queued: boolean; t: number; blend: number; front: number; rear: number; drag: number }[] = [];
  let t = 0;
  const untilS = opts.untilS ?? 1400;
  const maxT = opts.maxT ?? 40;
  while (t < maxT) {
    const s = Number.isFinite(car.trackProgress) ? sOf(car) : 200;
    if (s >= untilS) break;
    // The script holds the button down for one step: one press
    car.step(DT, { throttle: 1, brake: 0, steer: 0, ...opts.script(s) });
    t += DT;
    const v2 = Math.max(1, car.velocity.lengthSq());
    const tel = car.telemetry;
    const front = (tel.downforceN * tel.AERO_BALANCE) / 100;
    log.push({ s: sOf(car), open: car.drsOpen, queued: car.telemetry.drsQueued, t, blend: car.drsBlend, front: front / v2, rear: (tel.downforceN - front) / v2, drag: tel.dragN / v2 });
  }
  const openAt = log.find((r) => r.open)?.s ?? null;
  return { car, log, events, openAt };
}
/** The button down for one step at lap distance `at` (m) */
const pressAt = (at: number) => {
  let done = false;
  return (s: number) => {
    if (!done && s >= at) {
      done = true;
      return true;
    }
    return false;
  };
};
{
  const zoneStart = ZONE.start * LAP;
  // 1. The reported case: a press as the notice shows, 150 m before the zone
  const p1 = pressAt(zoneStart - STRAIGHT_NOTICE_M);
  const a = flatRun({ script: (s) => ({ drs: p1(s) }) });
  const queuedBefore = a.log.some((r) => r.s < zoneStart && r.queued) && a.log.every((r) => r.s >= zoneStart - 1 || !r.open);
  check('A press 150 m before the zone is kept, the flaps stay shut until it', queuedBefore);
  check('It opens them as the zone starts', a.openAt !== null && a.openAt >= zoneStart - 1 && a.openAt < zoneStart + 6, `open at ${a.openAt?.toFixed(1)} m, zone from ${zoneStart} m`);
  check('And is spent once it has', !a.log.some((r) => r.open && r.queued) && !a.car.telemetry.drsQueued);

  // 2. Out of reach: as before, nothing
  const p2 = pressAt(zoneStart - FLAP_PRESS_REACH_M - 60);
  const b = flatRun({ script: (s) => ({ drs: p2(s) }) });
  check(`A press over ${FLAP_PRESS_REACH_M} m before the zone does nothing`, b.openAt === null && !b.log.some((r) => r.queued));

  // 3. A second press takes it back
  const p3a = pressAt(zoneStart - 140);
  const p3b = pressAt(zoneStart - 90);
  const c = flatRun({ script: (s) => ({ drs: p3a(s) || p3b(s) }) });
  check('A second press before the zone takes the first back', c.openAt === null && c.log.some((r) => r.queued) && !c.log.some((r) => r.s > zoneStart - 85 && r.queued));

  // 4. The brake in the zone ends it; the brake before the zone (the corner before it) does not
  const p4 = pressAt(zoneStart - 140);
  const d = flatRun({ script: (s) => ({ drs: p4(s), ...(s > zoneStart - 20 && s < zoneStart + 40 ? { throttle: 0, brake: 0.6 } : {}) }) });
  check('Braking into the zone lets the kept press go', d.openAt === null && !d.log.some((r) => r.s > zoneStart + 45 && r.queued));
  const p5 = pressAt(zoneStart - 140);
  const e = flatRun({ script: (s) => ({ drs: p5(s), ...(s > zoneStart - 100 && s < zoneStart - 30 ? { throttle: 0, brake: 0.4 } : {}) }) });
  check('Braking for the corner before the zone keeps it', e.openAt !== null && e.openAt < zoneStart + 6, `open at ${e.openAt?.toFixed(1)} m`);

  // 5. Off the throttle as the zone starts: opens once back on it, in the zone
  const p6 = pressAt(zoneStart - 100);
  const f = flatRun({ script: (s) => ({ drs: p6(s), ...(s < zoneStart + 60 ? { throttle: 0.3 } : {}) }) });
  check('Off the throttle at the zone start: opens when back on it', f.openAt !== null && f.openAt >= zoneStart + 58 && f.openAt < zoneStart + 70, `open at ${f.openAt?.toFixed(1)} m`);
  const p7 = pressAt(zoneStart + 100);
  const g = flatRun({ script: (s) => ({ drs: p7(s), ...(s < zoneStart + 200 ? { throttle: 0.3 } : {}) }) });
  check('A press in the zone off the throttle waits for the throttle too', g.openAt !== null && g.openAt >= zoneStart + 198 && g.openAt < zoneStart + 210, `open at ${g.openAt?.toFixed(1)} m`);

  // 6. Never on the throttle in the zone: lapses at its end
  const p8 = pressAt(zoneStart - 100);
  const h = flatRun({ script: (s) => ({ drs: p8(s), throttle: 0.3 }), startMs: 60 });
  const zoneEnd = ZONE.end * LAP;
  check('Never back on the throttle: lapses once past the zone', h.openAt === null && h.log.some((r) => r.queued) && !h.log.some((r) => r.s > zoneEnd + 2 && r.queued));

  // 7. A car that never gets there (stopped 100 m short): lapses after the longest wait
  const near = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    airDensity: 1.06,
    drsZones: [ZONE],
    locateProgress: (_x, z) => 0.04 + z / LAP,
    lapLengthM: LAP,
  });
  near.drsGatedByDetection = false;
  near.reset(0, 300, 0, 0);
  near.step(DT, { throttle: 0, brake: 1, steer: 0 });
  near.step(DT, { throttle: 0, brake: 1, steer: 0, drs: true });
  const keptAt = near.telemetry.drsQueued;
  let tt = 0;
  for (; tt < FLAP_PRESS_MAX_WAIT_S - 0.5; tt += DT) near.step(DT, { throttle: 0, brake: 1, steer: 0 });
  const stillKept = near.telemetry.drsQueued;
  for (; tt < FLAP_PRESS_MAX_WAIT_S + 0.5; tt += DT) near.step(DT, { throttle: 0, brake: 1, steer: 0 });
  check(`A car stopped 100 m short: kept, then let go after ${FLAP_PRESS_MAX_WAIT_S} s`, keptAt && stillKept && !near.telemetry.drsQueued && !near.drsOpen);

  // 8. DRS (2011-2025): a kept press opens only a zone earned at its detection point
  const p11 = pressAt(zoneStart - 100);
  const k = flatRun({ gated: true, eligible: true, script: (s) => ({ drs: p11(s) }) });
  const p12 = pressAt(zoneStart - 100);
  const l = flatRun({ gated: true, eligible: false, script: (s) => ({ drs: p12(s) }) });
  check('DRS: kept for an earned zone, opens as it starts', k.openAt !== null && k.openAt < zoneStart + 6, `open at ${k.openAt?.toFixed(1)} m`);
  check('DRS: a zone not earned never opens', l.openAt === null);
  // Its detection point already passed without earning it: nothing to keep, so the HUD never says queued
  const lQueued = l.log.filter((r) => r.queued);
  check('DRS: a press after the detection point, for a zone not earned, is not kept', lQueued.length === 0, lQueued.length ? `queued from ${lQueued[0].s.toFixed(0)} m to ${lQueued[lQueued.length - 1].s.toFixed(0)} m` : 'never queued');
  // Before the detection point it is not known yet: kept to it, and let go there when the zone is not earned
  const detectionM = ZONE.detection * LAP;
  const p13 = pressAt(detectionM - 30);
  const kn = flatRun({ gated: true, eligible: false, script: (s) => ({ drs: p13(s) }) });
  const p14 = pressAt(detectionM - 30);
  const ke = flatRun({ gated: true, eligible: true, script: (s) => ({ drs: p14(s) }) });
  check(
    'DRS: a press before the detection point is kept to it, then let go when the zone is not earned',
    kn.openAt === null && kn.log.some((r) => r.queued) && !kn.log.some((r) => r.s > detectionM + 2 && r.queued),
    `queued to ${kn.log.findLast((r) => r.queued)?.s.toFixed(0)} m, detection at ${detectionM} m`,
  );
  check('DRS: and opens the zone as it starts when it is earned', ke.openAt !== null && ke.openAt < zoneStart + 6, `open at ${ke.openAt?.toFixed(1)} m`);
  // A yellow flag under the open-wheel rules: an open flap closes as the car enters the zone, and stays shut
  const yellow = flatRun({ script: (s) => ({ drs: s >= 650 && s < 652 }), barredFromS: 800 });
  const openBefore = yellow.log.some((r) => r.open && r.s < 800);
  const openAfter = yellow.log.some((r) => r.open && r.s > 802);
  check('A yellow zone shuts an open flap, and it stays shut', openBefore && !openAfter, `open before ${openBefore}, after ${openAfter}`);

  // Too wet for the flaps: a press is not kept either (2026 and DRS alike)
  const p15 = pressAt(zoneStart - 100);
  const wet = flatRun({ wetness: 1, script: (s) => ({ drs: p15(s) }) });
  check('Too wet for the flaps: a press is not kept, and they stay shut', wet.openAt === null && !wet.log.some((r) => r.queued), `queued ${wet.log.filter((r) => r.queued).length} steps`);

  // Race control's grip call (2026): Normal Grip opens both flaps on a wet road; Low Grip the front ones alone, from
  // `LOW_GRIP_ZONE_DELAY_M` into the stretch
  const p16 = pressAt(zoneStart - 100);
  const normalWet = flatRun({ wetness: 1, lowGrip: false, script: (s) => ({ drs: p16(s) }) });
  check('Normal Grip declared: both flaps open, however wet the road under the car', normalWet.openAt !== null && normalWet.openAt < zoneStart + 6, `open at ${normalWet.openAt?.toFixed(1)} m`);
  const p17 = pressAt(zoneStart - 100);
  const low = flatRun({ wetness: 1, lowGrip: true, script: (s) => ({ drs: p17(s) }) });
  check('Low Grip: kept, and opened from 50 m into the stretch', low.openAt !== null && low.openAt >= zoneStart + LOW_GRIP_ZONE_DELAY_M - 1 && low.openAt < zoneStart + LOW_GRIP_ZONE_DELAY_M + 6, `open at ${low.openAt?.toFixed(1)} m`);
  // The flaps' aero at the same speed band: shut, both open, the front alone
  const shut = flatRun({ script: () => ({}), untilS: 1150 });
  const p18 = pressAt(zoneStart - 100);
  const p19 = pressAt(zoneStart - 100);
  const both = flatRun({ lowGrip: false, script: (s) => ({ drs: p18(s) }), untilS: 1150 });
  const front = flatRun({ lowGrip: true, script: (s) => ({ drs: p19(s) }), untilS: 1150 });
  const f2 = (x: number) => x.toFixed(3);
  const last = (r: ReturnType<typeof flatRun>) => r.log[r.log.length - 1];
  const [sh, bo, fr] = [last(shut), last(both), last(front)];
  check('The front flaps alone: less front downforce, the rear\'s as shut, less drag than shut but more than both',
    fr.blend === 1 && bo.blend === 1 && fr.front < sh.front * 0.97 && Math.abs(fr.rear / sh.rear - 1) < 0.03 && fr.drag < sh.drag && fr.drag > bo.drag && bo.rear < sh.rear * 0.97,
    `front ${f2(sh.front)}/${f2(bo.front)}/${f2(fr.front)}, rear ${f2(sh.rear)}/${f2(bo.rear)}/${f2(fr.rear)}, drag ${f2(sh.drag)}/${f2(bo.drag)}/${f2(fr.drag)} (shut/both/front)`);

  // 9. The notice: 2026 only, `STRAIGHT_NOTICE_M` before the zone
  const ungated = flatRun({ script: () => ({}) });
  const gated = flatRun({ gated: true, script: () => ({}) });
  const n2026 = ungated.events.filter((x) => x.type === 'STRAIGHT_MODE_AHEAD').length;
  check('2026: told of the zone once; DRS: never (it has its detection point)', n2026 === 1 && !gated.events.some((x) => x.type === 'STRAIGHT_MODE_AHEAD'));
  check('Both still report the detection point', ungated.events.some((x) => x.type === 'DRS_DETECTION') && gated.events.some((x) => x.type === 'DRS_DETECTION'));
}

// ---------------------------------------------------------------------------
// The game's car on a circuit: the autopilot drives, with its own flap button taken off, so the only press is the
// one made when the notice shows
const proto = F12026CarSim.prototype as unknown as { autopilot: (h: number) => { drs: boolean } };
const ownAutopilot = proto.autopilot;
proto.autopilot = function (this: F12026CarSim, h: number) {
  return { ...ownAutopilot.call(this, h), drs: false };
};

interface LapReport {
  stretches: number;
  told: number;
  opened: number;
  late: string[];
  drsWords: boolean;
  overtakeNotices: number;
  /** Where the notices came and the flaps opened (m), for the checks' details */
  notes: string;
}
/** A lap of `track` pressing the button whenever the HUD says a straight is coming; where the flaps opened */
function lapPressingAtNotice(drive: (inputs: { toggleXMode?: boolean }) => SimulatorCar, track: BuiltTrackData, frames: number): LapReport {
  const L = track.totalLengthM;
  const stretches = straightModeStretches(track, RWANDA_DRS_ZONES);
  const told = new Set<number>();
  const opened = new Set<number>();
  const late: string[] = [];
  let lastNotice = -1;
  let press = false;
  let wasOpen = false;
  let lap = 0;
  let prevS = Number.NaN;
  let drsWords = false;
  let overtakeNotices = 0;
  let lastOvertake = -1;
  const notes: string[] = [];
  for (let f = 0; f < frames && lap < 2; f++) {
    const car = drive(press ? { toggleXMode: true } : {});
    press = false;
    const t = car.telemetry;
    const s = car.sMeters;
    if (Number.isFinite(prevS) && prevS > 0.8 * L && s < 0.2 * L) lap++;
    prevS = s;
    const c = t.f12026;
    if (!c) continue;
    const ev = latestAeroEvent(t);
    if (ev) drsWords ||= /DRS/.test(`${aeroNotice(t.overtakingRules, ev)?.badge} ${aeroNotice(t.overtakingRules, ev)?.text}`);
    if (c.overtakeDetection && c.overtakeDetection.atMs !== lastOvertake) {
      lastOvertake = c.overtakeDetection.atMs;
      overtakeNotices++;
    }
    if (lap !== 1) continue;
    if (c.straightModeAhead && c.straightModeAhead.atMs !== lastNotice) {
      lastNotice = c.straightModeAhead.atMs;
      const p = s / L;
      const target = stretches.findIndex((w) => {
        const ahead = ((((w.start - p) % 1) + 1) % 1) * L;
        return ahead > 100 && ahead < STRAIGHT_NOTICE_M + 30;
      });
      if (target >= 0) told.add(target);
      notes.push(`notice@${Math.round(s)}`);
      press = true;
    }
    const open = t.activeAeroMode === 'X_MODE';
    if (open && !wasOpen) notes.push(`open@${Math.round(s)}`);
    if (open && !wasOpen) {
      const idx = stretches.findIndex((w) => inLapWindow(s / L, w.start, w.end));
      if (idx >= 0) {
        opened.add(idx);
        const into = ((((s / L - stretches[idx].start) % 1) + 1) % 1) * L;
        if (into > 15) late.push(`${m(stretches[idx].start, L)} m +${into.toFixed(0)} m`);
      }
    }
    wasOpen = open;
  }
  return { stretches: stretches.length, told: told.size, opened: opened.size, late, drsWords, overtakeNotices, notes: notes.join(' ') };
}

function circuitChecks(name: string, track: BuiltTrackData) {
  const L = track.totalLengthM;
  const text = straightModeStretches(track, RWANDA_DRS_ZONES).map((w) => `${m(w.start, L)}-${m(w.end, L)}`).join(', ');
  // Stepped directly
  const sim = createLc26Sim(track, null);
  sim.setOvertakingRules('straight-mode-2026');
  sim.aiAutopilot = true;
  const direct = lapPressingAtNotice((inputs) => {
    sim.step(1 / 60, inputs);
    return sim;
  }, track, 60 * 400);
  check(`${name}: told of every straight on the lap`, direct.told === direct.stretches, `${direct.told}/${direct.stretches}: ${text}`);
  check(`${name}: a press at the notice opens the flaps as each starts`, direct.opened === direct.stretches && direct.late.length === 0, direct.late.join('; ') || direct.notes);
  check(`${name}: practice, no DRS words and no Overtake verdict`, !direct.drsWords && direct.overtakeNotices === 0);

  // In a race, more than 1 s behind at every detection point: the flaps still open, and the verdict is Overtake's
  const race = createLc26Sim(track, null);
  race.setOvertakingRules('straight-mode-2026');
  race.raceControl = { racing: true, earnedAtDetection: () => false };
  race.aiAutopilot = true;
  const raced = lapPressingAtNotice((inputs) => {
    race.step(1 / 60, inputs);
    return race;
  }, track, 60 * 400);
  check(`${name}: racing without the 1 s, the flaps open all the same`, raced.opened === raced.stretches && !raced.drsWords, raced.notes);
  check(`${name}: racing, Overtake judged at its detection point every lap`, raced.overtakeNotices >= 1, `${raced.overtakeNotices} verdicts`);

  // Through the simulation worker's runtime, the way the page drives it
  setLc26OnRigidBody(true);
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const car = host.adopt(vehicleModelSpec('lc26').createSim(track, null), 'lc26');
  car.setOvertakingRules?.('straight-mode-2026');
  car.resetToStartGrid(false);
  host.endFrame(true);
  car.aiAutopilot = true;
  // What the HUD reads: the page's stand-in for the worker's car
  const pageNotices = new Set<number>();
  let pageQueued = false;
  let pageOpen = false;
  const worker = lapPressingAtNotice((inputs) => {
    car.step(1 / 60, inputs);
    loop.advance(1 / 60);
    host.endFrame(true);
    const pc = car.telemetry.f12026;
    if (pc?.straightModeAhead) pageNotices.add(pc.straightModeAhead.atMs);
    pageQueued ||= pc?.drsQueued === true;
    pageOpen ||= car.telemetry.activeAeroMode === 'X_MODE';
    return loop.runtime.simulatedCar ?? car;
  }, track, 60 * 400);
  check(`${name}: the same through the worker's runtime`, host.remote && worker.opened === worker.stretches && worker.late.length === 0, worker.late.join('; ') || worker.notes);
  check(
    `${name}: the page's car shows the notices, the kept press and the open flaps`,
    pageNotices.size >= worker.stretches && pageQueued && pageOpen,
    `${pageNotices.size} notices, queued ${pageQueued}, open ${pageOpen}`
  );
  setLc26OnRigidBody(false);
}

console.log('\n== The game\'s car on the bundled circuit (RISE Motordrome, short)');
circuitChecks('RISE short', getActiveTrackData());

// ---------------------------------------------------------------------------
console.log('\n== Zone corrections (drs-zone-fixes.ts)');
{
  const zones = [{ id: 'ZONE_2', detection: 0.0708, start: 0.1079, end: 0.1996 }];
  const fixed = correctedDrsZones('spielberg', DRS_ZONE_FIXES.spielberg.lengthM, zones);
  check('A correction moves only its edges, the id and detection point kept', Math.abs(fixed[0].start - 410 / DRS_ZONE_FIXES.spielberg.lengthM) < 1e-4 && fixed[0].detection === 0.0708 && fixed[0].end > 0.25 && zones[0].start === 0.1079 && zones[0].end === 0.1996);
  const warn = console.warn;
  console.warn = () => {};
  const other = correctedDrsZones('spielberg', 4400, zones);
  console.warn = warn;
  check('A circuit rebuilt to another length keeps its data\'s zones', other[0].end === 0.1996);
}

/** The circuit as the game loads it */
function loadCircuit(id: string): BuiltTrackData {
  const raw = JSON.parse(fs.readFileSync(path.join('public', 'tracks', id, 'track_data.json'), 'utf8')) as RawTrackJson;
  setActiveTrack(id, raw);
  return getActiveTrackData();
}
const stretchText = (track: BuiltTrackData) =>
  straightModeStretches(track, RWANDA_DRS_ZONES).map((w) => `${m(w.start, track.totalLengthM)}-${m(w.end, track.totalLengthM)}`).join(', ');
/** One stretch runs from `fromM` to `toM` (m, over the line when `toM` < `fromM`) without a break */
const covers = (track: BuiltTrackData, fromM: number, toM: number) => {
  const L = track.totalLengthM;
  const span = (((toM - fromM) % L) + L) % L;
  return straightModeStretches(track, RWANDA_DRS_ZONES).some((w) => {
    for (let d = 0; d <= span; d += 5) if (!inLapWindow(((fromM + d) % L) / L, w.start, w.end)) return false;
    return inLapWindow(toM / L, w.start, w.end);
  });
};

for (const [id, fix] of Object.entries(DRS_ZONE_FIXES)) {
  const file = `public/tracks/${id}/track_data.json`;
  if (!hasFile(file)) {
    noteSkip(`${id}'s zone correction`, file);
    continue;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as RawTrackJson;
  const ids = new Set((raw.drsZones as { id: string }[]).map((z) => z.id));
  check(`${id}: the correction is for this build of the circuit`, Math.abs(raw.metadata.lengthMeters - fix.lengthM) <= 1 && Object.keys(fix.zones).every((z) => ids.has(z)), `${raw.metadata.lengthMeters} m, ${Object.keys(fix.zones).join(', ')}`);
}

if (hasFile('public/tracks/spielberg/track_data.json')) {
  const track = loadCircuit('spielberg');
  const text = stretchText(track);
  // The 2026 FIA zones: the start/finish straight, Turn 1 to Turn 3, Turn 3 to Turn 4, Turn 8 to Turn 9 (as reported)
  check('Red Bull Ring: Turn 1 to Turn 3 open from 410 m to the braking for Remus (1095 m)', covers(track, 410, 1100), text);
  check('Red Bull Ring: the other three 2026 zones', covers(track, 4020, 260) && covers(track, 1380, 1900) && covers(track, 3210, 3550), text);
  check('Red Bull Ring: four stretches, no more', straightModeStretches(track, RWANDA_DRS_ZONES).length === 4, text);
  // The older LC26 engine and its AI field (ai-mpc.ts) read the zones from the track's samples
  check('Red Bull Ring: the older engine and its AI get the corrected zone too', track.getSampleAtDistance(1100).drsZone && !track.getSampleAtDistance(1250).drsZone);
  circuitChecks('Red Bull Ring', track);
} else noteSkip('Red Bull Ring', 'public/tracks/spielberg/track_data.json');

if (hasFile('public/tracks/norisring/track_data.json')) {
  const track = loadCircuit('norisring');
  const z = RWANDA_DRS_ZONES[0];
  check('Norisring: the main straight starts out of the last corner (1830 m), not before its apex (1746 m)', m(z.start, track.totalLengthM) >= 1820 && !covers(track, 1746, 1746), stretchText(track));
} else noteSkip('Norisring', 'public/tracks/norisring/track_data.json');

if (hasFile('public/tracks/vir_grand_west/track_data.json')) {
  const track = loadCircuit('vir_grand_west');
  check('VIR Grand West: the back straight is one stretch over its 26 m kink, as on the full course', covers(track, 2890, 3670), stretchText(track));
} else noteSkip('VIR Grand West', 'public/tracks/vir_grand_west/track_data.json');

// No zone with a corner in it: no bend tighter than 120 m before its last 150 m (the braking for the next corner).
// Flat-out kinks stay in: Istanbul's Turn 11 (147 m on the centreline) in its back-straight zone, as the real one
const ZONE_CORNER_RADIUS_M = 120;
{
  const index = hasFile('public/tracks/index.json') ? (JSON.parse(fs.readFileSync('public/tracks/index.json', 'utf8')) as { id: string }[]) : [];
  const bad: string[] = [];
  let seen = 0;
  for (const { id } of index) {
    if (!hasFile(`public/tracks/${id}/track_data.json`)) continue;
    const track = loadCircuit(id);
    seen++;
    const L = track.totalLengthM;
    for (const z of RWANDA_DRS_ZONES) {
      const len = ((((z.end - z.start) % 1) + 1) % 1) * L;
      for (let d = 0; d < len - 150; d += 2) {
        const k = Math.abs(track.getSampleAtDistance((z.start * L + d) % L).curvature);
        if (k > 1 / ZONE_CORNER_RADIUS_M) {
          bad.push(`${id} ${z.id} at ${Math.round((z.start * L + d) % L)} m (R ${Math.round(1 / k)} m)`);
          break;
        }
      }
    }
    // The straights the 2026 car adds keep to straights and short gentle kinks
    for (const w of straightModeWindows(track)) {
      for (let s = w.start * L; s <= (w.end < w.start ? w.end + 1 : w.end) * L; s += 2) {
        const k = Math.abs(track.getSampleAtDistance(s % L).curvature);
        if (k > 1 / 500) {
          bad.push(`${id} straight ${m(w.start, L)}-${m(w.end, L)} at ${Math.round(s % L)} m (R ${Math.round(1 / k)} m)`);
          break;
        }
      }
    }
  }
  if (seen === 0) noteSkip('Every circuit\'s zones', 'public/tracks/*/track_data.json');
  else check(`Every circuit (${seen}): no zone or straight with a corner in it`, bad.length === 0, bad.join('; '));
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll straight-mode checks passed.');
process.exit(failures.length ? 1 : 0);
