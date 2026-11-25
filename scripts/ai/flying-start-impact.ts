/**
 * What the boards' flying start hands each car: its first timed lap from the boards' start (`boardFlyingStartSpeedMs`,
 * what a solo flying lap starts on) against the same lap from the fair start (`fairFlyingStartSpeedMs`: the same spot,
 * pointed the same way, at no more than the car's own pace there) and from a normal start: the same spot at the speed
 * the car itself carries there on its way round (read off the fair run's lap), so that lap is a normal flying lap with
 * the tyres, fuel and energy of a first one. The game's autopilot drives (full pace, on its own driver or the circuit's
 * checked plan, as a qualifying reference lap does) on the full physics with the circuit's colliders, as the player's
 * car runs; it is deterministic, so one run per start.
 *
 *   npx tsx scripts/ai/flying-start-impact.ts [--tracks sachsenring,chang] [--cars liana,lc26] [--json out.json] [--control]
 *
 * Per car and layout (s): `gainS` = fair lap − board lap, what the boards' start is worth against the fair one (what a
 * car's board laps would lose if its solo laps started fair); `boardGainS` = normal lap − board lap, against a normal
 * one; `fairErrS` = fair lap − normal lap, how far the fair start is from a normal lap (+ slower). A layout whose boards'
 * start is known to be wrong (verify-flying-start.ts) or a lap with a wall hit or a cut is flagged, not dropped (the
 * normal lap's cut is not known: putting the car back voids the lap under way, and the line that starts the timed lap
 * doesn't clear that). `--control` also puts the car back at the fair start's own speed, which must time the fair lap
 * to the step. Hill climbs have no flying lap.
 */
import fs from 'node:fs';
import type * as THREE from 'three';
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { ownPaceFor, ownSpeedAt } from '../../src/lib/sim/own-pace';
import { type BuiltTrackData, getActiveTrackData, type RawTrackJson, setActiveTrack } from '../../src/lib/track-data';
import type { VehicleModelId } from '../../src/types/f1';
import { loadGlbGeometry, trackModelFiles } from '../lib/glb-geometry';
import { hasFile, noteSkip } from '../lib/hosted-files';
import { type FlyingStartLap, flyingStartLap } from './lib/flying-start-lap';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const index = JSON.parse(fs.readFileSync('public/tracks/index.json', 'utf8')) as { id: string }[];
const TRACKS = opt('tracks')?.split(',') ?? index.map((t) => t.id);
const CARS = (opt('cars')?.split(',') ?? Object.keys(VEHICLE_MODELS)) as VehicleModelId[];
const JSON_OUT = opt('json');
/** Also put the car back at the fair start's own speed: that lap must be the fair one's (the method's check) */
const CONTROL = argv.includes('--control');

type Run = FlyingStartLap;
export interface ImpactRow {
  track: string;
  car: VehicleModelId;
  board: Run;
  fair: Run;
  normal: Run | null;
  /** fair lap − board lap (s) */
  gainS: number | null;
  /** normal lap − board lap (s) */
  boardGainS: number | null;
  /** fair lap − normal lap (s) */
  fairErrS: number | null;
  /** `--control`: the lap put back at the fair start's own speed, less the fair lap (s; 0 expected) */
  controlS?: number | null;
  /** The car's own pace at the start's spot (`ownPaceFor`, km/h): the fair start's cap */
  ownPlanKmh: number | null;
  flags: string[];
}

function load(id: string): { track: BuiltTrackData; root: THREE.Object3D } | null {
  const data = `public/tracks/${id}/track_data.json`;
  if (!hasFile(data)) {
    noteSkip(id, data);
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(data, 'utf8')) as RawTrackJson & { metadata: { mesh: { url: string } } };
  const files = trackModelFiles({ id, meshUrl: raw.metadata.mesh.url });
  if (!hasFile(files.path) || (files.shared && !hasFile(files.shared))) {
    noteSkip(id, files.path);
    return null;
  }
  setActiveTrack(id, raw);
  return { track: getActiveTrackData(1200), root: loadGlbGeometry(files.path, files.shared) };
}

const KNOWN_BAD_BOARD_START = new Set(['le_mans_82', 'chang', 'speedvegas', 'spielberg_inner', 'vir_patriot', 'vir_patriot_reverse', 'watkins_glen_short', 'riverside', 'riverside_short', 'riverside_nascar']);

const rows: ImpactRow[] = [];
for (const id of TRACKS) {
  const c = load(id);
  if (!c) continue;
  if (c.track.pointToPoint) {
    console.log(`${id}: point-to-point, no flying lap`);
    continue;
  }
  for (const model of CARS) {
    const t0 = performance.now();
    const board = flyingStartLap(c.track, c.root, model, { fairStart: false });
    const fair = flyingStartLap(c.track, c.root, model, { fairStart: true });
    const normal = fair.spotKmh !== null ? flyingStartLap(c.track, c.root, model, { fairStart: true, speedKmh: fair.spotKmh }) : null;
    const control = CONTROL ? flyingStartLap(c.track, c.root, model, { fairStart: true, speedKmh: fair.startKmh }) : null;
    const diff = (a: Run | null, b: Run | null) => (a?.lapMs != null && b?.lapMs != null ? (a.lapMs - b.lapMs) / 1000 : null);
    const flags: string[] = [];
    for (const [name, r] of [['board', board], ['fair', fair], ['normal', normal]] as const) {
      if (!r) flags.push(`${name}: not run`);
      else if (r.lapMs === null) flags.push(`${name}: no lap`);
      else {
        if (!r.valid && name !== 'normal') flags.push(`${name} invalid`);
        if (r.walls) flags.push(`${name} ${r.walls} wall`);
      }
    }
    if (KNOWN_BAD_BOARD_START.has(id)) flags.push('board start known wrong');
    const sim = VEHICLE_MODELS[model].createSim(c.track, null);
    const pace = ownPaceFor(c.track, model, sim.racingLineId ?? 'f1');
    const ownPlanKmh = pace ? ownSpeedAt(pace, board.startS + c.track.totalLengthM) * 3.6 : null;
    const row: ImpactRow = { track: id, car: model, board, fair, normal, ownPlanKmh, gainS: diff(fair, board), boardGainS: diff(normal, board), fairErrS: diff(fair, normal), flags };
    if (control) row.controlS = diff(control, fair);
    rows.push(row);
    const f = (x: number | null | undefined) => (x == null ? '    n/a' : x.toFixed(3).padStart(7));
    console.log(
      `${id.padEnd(22)} ${model.padEnd(16)} start ${board.startKmh.toFixed(0).padStart(3)} / fair ${fair.startKmh.toFixed(0).padStart(3)} / plan ${ownPlanKmh?.toFixed(0).padStart(3) ?? '  ?'} / carried ${fair.spotKmh?.toFixed(0).padStart(3) ?? '  ?'} km/h  ` +
        `lap ${f(board.lapMs && board.lapMs / 1000)} ${f(fair.lapMs && fair.lapMs / 1000)} ${f(normal?.lapMs && normal.lapMs / 1000)}  gain ${f(row.gainS)}  vs normal ${f(row.boardGainS)}  fair err ${f(row.fairErrS)}${control ? `  control ${f(row.controlS)}` : ''}` +
        `  ${((performance.now() - t0) / 1000).toFixed(0)} s${flags.length ? `  [${flags.join('; ')}]` : ''}`
    );
  }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1));
