/**
 * A car's own pace round a circuit: the speed its model is expected to carry at each point of its racing line (a drive
 * plan at the AI field's plan grip: its cornering, braking, traction and top speed), built once per circuit, model and
 * line. What a car's slowness is judged by (the AI field's hazards, the online flags and fair-play rule) and what its
 * VSC pace is a share of. The circuit's own speed profile is the LC26's: a road car's top speed is 50 m/s where that is
 * 85, its hairpin 10 m/s where that is 18.
 *
 * Deterministic (every client of a race builds the same), no three.js, no DOM.
 */
import { VEHICLE_CLASS_OF } from '@/lib/cars/vehicle-class';
import { hazardPaceProfile } from '@/lib/sim/ai-racecraft';
import { aiTrackFor, sampleGrid } from '@/lib/sim/ai/ai-track';
import { driveLineOf, makeDrivePlan } from '@/lib/sim/ai/drive-plan';
import { carLimitsFor, GGV_TABLES } from '@/lib/sim/ai/ggv';
import { aiLineOffsetM } from '@/lib/sim/speed-profile';
import { racingLineFor, type BuiltTrackData } from '@/lib/track-data';
import type { RacingLineId, VehicleModelId } from '@/types/f1';

/** The AI field's plan grip at pace 1 (`PLAN_GRIP`, ai-opponents.ts) */
const OWN_PACE_GRIP = 0.97;

export interface OwnPace {
  /** Expected speed every `ds` m of the lap (m/s) */
  expected: Float64Array;
  /** The same with its braking zones eased (`hazardPaceProfile`): what slowness is judged by */
  hazard: Float64Array;
  ds: number;
}

const paces = new WeakMap<BuiltTrackData, Map<string, OwnPace>>();

/** A car model's own pace round its line on `track` (~10 ms to build, then kept); null on a point-to-point road */
export function ownPaceFor(track: BuiltTrackData, vehicle: VehicleModelId | undefined, line: RacingLineId): OwnPace | null {
  if (track.pointToPoint) return null;
  let byModel = paces.get(track);
  if (!byModel) paces.set(track, (byModel = new Map()));
  const key = `${vehicle ?? ''}|${line}`;
  let pace = byModel.get(key);
  if (!pace) {
    const limits = carLimitsFor(vehicle, OWN_PACE_GRIP);
    const t = aiTrackFor(track);
    const offsets = new Float64Array(t.n);
    for (let i = 0; i < t.n; i++) offsets[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);
    const expected = makeDrivePlan(t, driveLineOf(t, offsets), limits).vExpected;
    pace = { expected, hazard: hazardPaceProfile(expected, t.ds, (v) => limits.braking(v)), ds: t.ds };
    byModel.set(key, pace);
  }
  return pace;
}

/** `pace`'s speed at lap distance `s` (m/s); `hazard`: the eased one */
export const ownSpeedAt = (pace: OwnPace, s: number, hazard = false): number => sampleGrid(hazard ? pace.hazard : pace.expected, s, pace.ds);

/**
 * The line each model's profile asks for (`CarSimProfile.racingLine`, in each car's sim file): the road cars and most
 * classics the road cars' line. scripts/verify/verify-road-line.ts holds it to the profiles
 */
export const PROFILE_RACING_LINE: Readonly<Record<VehicleModelId, RacingLineId>> = {
  lc26: 'f1',
  lc25: 'f1',
  'f12026-car': 'f1',
  'amg-gt3': 'gt3',
  liana: 'road',
  'mtr-496r': 'gt3',
  'lc-lmdh': 'gt3',
  'nissan-r33-jgtc': 'gt3',
  'nissan-r32-jtcc': 'road',
  'bmw-m1-procar': 'road',
  'vw-scirocco-gtx': 'road',
  'chaparral-2d': 'road',
  'chaparral-2d-67': 'road',
  'porsche-934-rsr': 'road',
  'f1-2007': 'f1',
};

/**
 * The racing line a model drives on the active circuit (`racingLineFor`, as its car does): its profile's, a road car's
 * the GT3's where its plan check on the road line didn't pass
 */
export const racingLineOfVehicle = (vehicle: VehicleModelId): RacingLineId =>
  racingLineFor(PROFILE_RACING_LINE[vehicle] ?? (VEHICLE_CLASS_OF[vehicle] === 'f1' ? 'f1' : 'gt3'), vehicle);

/**
 * The eased own speed (m/s) at lap distance `s` of a car of model `vehicle` (an online car: the model its packets
 * name); undefined for a model this client doesn't know (none named, another version's, a mod's): the fixed rules hold
 */
export function vehicleOwnSpeedMs(track: BuiltTrackData, vehicle: string | undefined, s: number): number | undefined {
  if (!vehicle || !Object.hasOwn(GGV_TABLES, vehicle) || !Object.hasOwn(VEHICLE_CLASS_OF, vehicle)) return undefined;
  const id = vehicle as VehicleModelId;
  const pace = ownPaceFor(track, id, racingLineOfVehicle(id));
  return pace ? ownSpeedAt(pace, s, true) : undefined;
}
