/**
 * Kerbs a car should not be driven over: each kerb's rise over the ground it stands on (`TrackColliderQuery.queryBase`),
 * scanned across the road every few metres, and where the tall ones lie against a car's usable road (`lateralRangeAt`).
 *
 *   npx tsx scripts/ai/kerb-scan.ts --track oschersleben [--car lc26] [--min 0.05] [--step 2]
 *
 * Prints each stretch with a kerb taller than `--min` (m): where along the lap, which side, how tall, how far across the
 * road it reaches, and whether the car's usable road (the line generator's bounds) takes its centre over it.
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { trackColliders } from '../../src/lib/sim/track-colliders';
import { createGroundHit } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import type { VehicleModelId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'oschersleben');
const carId = opt('car', 'lc26') as VehicleModelId;
const minRise = Number(opt('min', '0.05'));
const step = Number(opt('step', '2'));

setActiveTrack(trackId, JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);
const found = trackColliders(root as never).ground;
if (!found?.queryBase) throw new Error('the colliders have no ground with queryBase');
const ground = found as typeof found & { queryBase: NonNullable<typeof found.queryBase> };
const car = vehicleModelSpec(carId).createSim(track, root as never) as unknown as { lateralRangeAt?: (s: number) => [number, number] };
const hit = createGroundHit();
const base = createGroundHit();
const L = track.totalLengthM;

interface Row { s: number; side: number; rise: number; from: number; to: number; rangeEdge: number }
const rows: Row[] = [];
for (let s = 0; s < L; s += step) {
  const smp = track.getSampleAtDistance(s);
  const b = smp.binormal;
  const half = smp.width / 2;
  const range = car.lateralRangeAt?.(s) ?? [-half, half];
  for (const side of [-1, 1]) {
    let best = 0, from = Infinity, to = -Infinity;
    for (let lat = 0; lat <= half + 1.6 + 1e-6; lat += 0.1) {
      const x = smp.position.x + b.x * side * lat, z = smp.position.z + b.z * side * lat, y = smp.position.y + b.y * side * lat + 1.5;
      if (!ground.query(x, z, y, hit) || hit.surface !== 'kerb') continue;
      if (!ground.queryBase(x, z, y, base)) continue;
      const rise = hit.height - base.height;
      if (rise > minRise) {
        best = Math.max(best, rise);
        from = Math.min(from, lat);
        to = Math.max(to, lat);
      }
    }
    if (best > 0) rows.push({ s, side, rise: best, from, to, rangeEdge: side < 0 ? -range[0] : range[1] });
  }
}
// Stretches: consecutive rows on one side, each side on its own (a station with a kerb on both sides has a row for
// each, so the rows in lap order alternate sides there), printed in lap order
interface Stretch { s0: number; s1: number; side: number; rise: number; from: number; to: number; over: boolean }
const stretches: Stretch[] = [];
for (const side of [-1, 1]) {
  const sideRows = rows.filter((r) => r.side === side);
  let i = 0;
  while (i < sideRows.length) {
    const r0 = sideRows[i];
    let j = i;
    let rise = r0.rise, from = r0.from, to = r0.to, over = false;
    while (j + 1 < sideRows.length && sideRows[j + 1].s - sideRows[j].s <= step + 1e-6) j++;
    for (let k = i; k <= j; k++) {
      rise = Math.max(rise, sideRows[k].rise);
      from = Math.min(from, sideRows[k].from);
      to = Math.max(to, sideRows[k].to);
      // The car's centre may reach the kerb's inner edge less half its track: its tyres on it
      if (sideRows[k].rangeEdge + 0.8 > sideRows[k].from) over = true;
    }
    stretches.push({ s0: r0.s, s1: sideRows[j].s, side, rise, from, to, over });
    i = j + 1;
  }
}
stretches.sort((a, b) => a.s0 - b.s0 || a.side - b.side);
console.log(`${trackId} · ${carId} · kerbs taller than ${(minRise * 100).toFixed(0)} cm (lateral m from the centreline; range = the car's usable centre reach)`);
for (const { s0, s1, side, rise, from, to, over } of stretches) {
  console.log(
    `  ${s0.toFixed(0).padStart(5)}-${s1.toFixed(0).padEnd(5)} ${side < 0 ? 'left ' : 'right'} rise ${(rise * 100).toFixed(1).padStart(4)} cm  across ${from.toFixed(1)}-${to.toFixed(1)} m  ${over ? 'IN the usable road' : 'clear'}`
  );
}
