/**
 * How far a car runs out over the road's edge and its kerbs, corner by corner: its drive plan and its own driver on the
 * stored line, beside the online boards' fastest laps in that car (scripts/ai/fetch-ghosts.ts).
 *
 *   npx tsx scripts/ai/kerb-use.ts --track chang [--car amg-gt3] [--grip 0.97] [--ghosts 3]
 *
 * Per corner (the plan's slowest points), at the apex (the inside, ±40 m) and the exit (the outside, 20-150 m on): the
 * kerb past the edge on that side (how far it runs, its tallest rise, the surface 0.5 m out), the room the car's own
 * driver and its plan may take (the centre's furthest point past the edge: `ownRangeAt`, `lateralRangeAt`), and how far
 * past the edge the line, the plan, the own driver and each player's centre went (m, + past the edge). The slowest speed
 * of each over the corner closes the row.
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { aiLineOffsetM } from '../../src/lib/sim/speed-profile';
import { aiTrackFor } from '../../src/lib/sim/ai/ai-track';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { trackColliders } from '../../src/lib/sim/track-colliders';
import { createGroundHit } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import type { VehicleModelId } from '../../src/types/f1';
import { loadGlbGeometry } from '../lib/glb-geometry';
import { physicsLap, physicsLapLine } from './lib/physics-lap';
import { cornerMinima, loadGhostLines } from './lib/ghosts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const trackId = opt('track', 'chang');
const car = opt('car', 'amg-gt3') as VehicleModelId;
const grip = Number(opt('grip', '0.97'));
const nGhosts = Number(opt('ghosts', '3'));

setActiveTrack(trackId, JSON.parse(readFileSync(`public/tracks/${trackId}/track_data.json`, 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const t = aiTrackFor(track);
const N = t.n;
const root = loadGlbGeometry(`public${track.meshUrl}`);
const ground = trackColliders(root as never).ground;
if (!ground) throw new Error('the circuit has no road collider');
const hit = createGroundHit();
const base = createGroundHit();
const sim = vehicleModelSpec(car).createSim(track, root as never) as unknown as {
  lateralRangeAt: (s: number) => [number, number];
  ownRangeAt: (s: number) => [number, number];
};
const line = physicsLapLine(car, track);
const offsets = new Float64Array(N);
for (let i = 0; i < N; i++) offsets[i] = aiLineOffsetM(track.getSampleAtDistance(i * t.ds), line);
const plan = physicsLap(track, root, car, offsets, grip, undefined, { line });
const own = physicsLap(track, root, car, offsets, grip, undefined, { plan: false, line });
const ghosts = loadGhostLines(track, trackId, { vehicles: [car], n: N, ds: t.ds }).slice(0, nGhosts);
const f = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? ' ' : ''}${x.toFixed(d)}` : '    -');
console.log(
  `${trackId} · ${car} (${line} line) · plan ${f(plan.lapS)} s at grip ${grip} · own driver ${f(own.lapS)} s · players ${ghosts.map((g) => g.lapS.toFixed(2)).join(', ') || '-'}`
);
console.log('   s  where side | kerb past the edge (m), rise, 0.5 m out | room: own  plan | past the edge: line  plan  own | players | slowest km/h plan/own/players');

/** The kerb past the edge on a side at `s`: from the edge out (m), its tallest rise (m) and the surface 0.5 m out */
function kerbOut(s: number, side: number): { to: number; rise: number; surface: string } {
  const smp = track.getSampleAtDistance(s);
  const b = smp.binormal;
  const half = smp.width / 2;
  let to = NaN, rise = 0, surface = '';
  for (let d = 0; d <= 3 + 1e-6; d += 0.1) {
    const lat = half + d;
    const x = smp.position.x + b.x * side * lat, z = smp.position.z + b.z * side * lat, y = smp.position.y + b.y * side * lat + 1.5;
    if (!ground!.query(x, z, y, hit)) break;
    if (Math.abs(d - 0.5) < 0.05) surface = hit.surface;
    if (hit.surface !== 'kerb') {
      if (d > 0.2) break;
      continue;
    }
    to = d;
    if (ground!.queryBase && ground!.queryBase(x, z, y, base)) rise = Math.max(rise, hit.height - base.height);
  }
  return { to, rise, surface };
}

for (const c of cornerMinima(plan.v, t.ds)) {
  let k = 0;
  for (let j = -6; j <= 6; j++) k += t.kappa[(c + j + N) % N];
  const inside = Math.sign(k) || 1;
  const row = (where: string, side: number, i0: number, i1: number) => {
    const past = (n: ArrayLike<number>): [number, number] => {
      let best = -Infinity, at = c;
      for (let i = i0; i <= i1; i++) {
        const ii = (i + N) % N;
        const v = n[ii] * side - t.width[ii] / 2;
        if (Number.isFinite(v) && v > best) [best, at] = [v, ii];
      }
      return [best, at];
    };
    const [pPlan, at] = past(plan.n);
    const s = at * t.ds;
    const kerb = kerbOut(s, side);
    const [lo, hi] = sim.lateralRangeAt(s);
    const [ownLo, ownHi] = sim.ownRangeAt(s);
    let vPlan = Infinity, vOwn = Infinity, vPl = Infinity;
    for (let i = c - 10; i <= c + 10; i++) {
      const ii = (i + N) % N;
      vPlan = Math.min(vPlan, plan.v[ii]);
      vOwn = Math.min(vOwn, own.v[ii]);
      for (const g of ghosts) if (Number.isFinite(g.v[ii])) vPl = Math.min(vPl, g.v[ii]);
    }
    console.log(
      `${(c * t.ds).toFixed(0).padStart(5)} ${where} ${side < 0 ? 'L' : 'R'}    | ${Number.isFinite(kerb.to) ? kerb.to.toFixed(1).padStart(4) : '   -'} ${(kerb.rise * 100).toFixed(0).padStart(3)} cm ${kerb.surface.padEnd(7)} |` +
        ` ${f((side < 0 ? -ownLo : ownHi) - t.width[at] / 2)} ${f((side < 0 ? -lo : hi) - t.width[at] / 2)} | ${f(past(offsets)[0])} ${f(pPlan)} ${f(past(own.n)[0])} |` +
        ` ${ghosts.map((g) => f(past(g.n)[0])).join(' ') || '-'} | ${(vPlan * 3.6).toFixed(0)}/${(vOwn * 3.6).toFixed(0)}/${Number.isFinite(vPl) ? (vPl * 3.6).toFixed(0) : '-'}`
    );
  };
  row('apex', inside, c - 8, c + 8);
  row('exit', -inside, c + 4, c + 30);
}
process.exit(0);
