/**
 * Kerb feel from the physics (`src/lib/sim/kerb-hits.ts`): each tyre's load hits drive the pad's rumble, the
 * DualSense and the wheel's kerb buzz, and the rigid-body rack kicks at the front tyres' scrub radius.
 *
 * 1. The hit tracker on made-up loads: a steady load and the asphalt's texture are not felt, ridges at 30 Hz are, at
 *    their rate, and the feel stops soon after them.
 * 2. Willow Springs' slotted Turn 6 kerb (0.45 m strips, a slot every metre), with a front tyre held on it at 100 km/h
 *    and then 2.5 m inside it on the asphalt: every car feels the kerb and not the asphalt, at the slots' rate, and the
 *    F1 2026 car's rack carries the slots. Needs the hosted circuit files.
 *
 *   npx tsx scripts/verify-kerb-feel.ts
 */
import { readFileSync } from 'node:fs';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { createKerbHitState, kerbHitLevel, stepKerbHit } from '../src/lib/sim/kerb-hits';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createGroundHit } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { loadGlbGeometry } from './lib/glb-geometry';
import { skipSuiteWithout } from './lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const finish = () => {
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll kerb feel checks passed.');
  process.exit(0);
};

// ---- 1. The tracker on made-up loads
console.log('== The hit tracker');
{
  const H = 0.0005;
  const STATIC_N = 2000;
  const run = (load: (t: number) => number, seconds: number, s = createKerbHitState()) => {
    for (let t = 0; t < seconds; t += H) stepKerbHit(s, load(t), true, STATIC_N, H);
    return s;
  };
  const steady = run(() => STATIC_N, 1);
  check('A steady load is not felt', kerbHitLevel(steady, STATIC_N) === 0 && steady.hitRateHz === 0, `level ${kerbHitLevel(steady, STATIC_N).toFixed(2)}`);
  // The asphalt's texture: ±150 N of mixed fast wobble
  const texture = run((t) => STATIC_N + 90 * Math.sin(2 * Math.PI * 37 * t) + 60 * Math.sin(2 * Math.PI * 83 * t + 1), 1);
  check('The asphalt texture is not felt', kerbHitLevel(texture, STATIC_N) === 0, `rate ${texture.hitRateHz.toFixed(1)} Hz`);
  // Ridges: a 1.2 kN hit 8 ms long, 30 times a second
  const ridges = run((t) => STATIC_N + ((t * 30) % 1 < 0.24 ? 1200 : 0), 1);
  check('Ridges at 30 Hz are felt', kerbHitLevel(ridges, STATIC_N) > 0.4, `level ${kerbHitLevel(ridges, STATIC_N).toFixed(2)}`);
  check('…at their rate', Math.abs(ridges.hitRateHz - 30) < 3, `${ridges.hitRateHz.toFixed(1)} Hz`);
  const after = run(() => STATIC_N, 0.3, ridges);
  check('…and not 0.3 s after them', kerbHitLevel(after, STATIC_N) === 0 && after.hitRateHz === 0);
}

// ---- 2. Willow Springs' slotted kerb
// The tracker's failures end the suite here: skipping section 2 for want of the hosted files would pass it
if (failures.length) finish();
skipSuiteWithout('public/tracks/willow_springs/track_data.json', 'public/tracks/willow_springs/willow_springs.glb');
console.log("\n== Willow Springs' Turn 6 kerb at 100 km/h");
setActiveTrack('willow_springs', JSON.parse(readFileSync('public/tracks/willow_springs/track_data.json', 'utf8')) as RawTrackJson);
const track = getActiveTrackData();
const root = loadGlbGeometry('public/tracks/willow_springs/willow_springs.glb');
const ground = trackColliders(root).ground!;
const hit = createGroundHit();
// The kerb is on the right of the lap from 2128 to 2228 m: its middle, every 0.5 m
const S0 = 2128;
const S1 = 2228;
const kerbMid = new Map<number, number>();
for (let s = S0 - 30; s <= S1; s += 0.5) {
  const t = track.getSampleAtDistance(s);
  const lats: number[] = [];
  for (let d = -0.4; d <= 1.6; d += 0.03) {
    const lat = t.width * 0.5 + d;
    if (ground.query(t.position.x + t.binormal.x * lat, t.position.z + t.binormal.z * lat, t.position.y + 2, hit) && hit.surface === 'kerb') lats.push(lat);
  }
  if (lats.length) kerbMid.set(Math.round(s * 2), (lats[0] + lats[lats.length - 1]) / 2);
}
const midAt = (s: number) => {
  for (let k = 0; k < 40; k++) {
    const v = kerbMid.get(Math.round(s * 2) + k) ?? kerbMid.get(Math.round(s * 2) - k);
    if (v !== undefined) return v;
  }
  return 7;
};
const median = (a: number[]) => {
  const x = [...a].sort((m, n) => m - n);
  return x.length ? x[Math.floor((x.length - 1) / 2)] : NaN;
};
const KMH = 100;
const SLOT_M = 1;
type Car = { step: (dt: number, i: object) => any; teleportToDistance: (s: number, v: number, lat: number) => void; lateralOffsetM: number; sMeters?: number; distanceM?: number };

/** A run along the kerb with the right front tyre `inset` m inside the kerb's middle: its feel, the right side's hit rate and the rack torque */
function drive(make: () => Car, inset: number) {
  const car = make();
  const halfTrack = 0.8;
  car.teleportToDistance(S0 - 25, KMH / 3.6, midAt(S0) - halfTrack - inset);
  const feel: number[] = [];
  const rate: number[] = [];
  const torque: number[] = [];
  let speedSum = 0;
  let frames = 0;
  const steps = Math.round(((S1 - S0 + 25) / (KMH / 3.6)) * 120);
  for (let step = 0; step < steps; step++) {
    const s = car.sMeters ?? car.distanceM ?? 0;
    const target = midAt(s + 1.8) - halfTrack - inset;
    const tel = car.step(1 / 120, { throttle: 0.3, brake: 0, analogSteer: Math.max(-0.3, Math.min(0.3, (target - car.lateralOffsetM) * 0.6)) });
    const now = car.sMeters ?? car.distanceM ?? 0;
    if (now < S0 || now > S1) continue;
    frames++;
    speedSum += tel.speedKmh;
    for (const v of tel.ffbSubframeSamples ?? []) torque.push(v);
    // On the kerb run, only the frames the right front is on it
    if (inset === 0 && tel.wheelSurfaces[1] !== 'kerb') continue;
    feel.push(tel.wheelKerbHit[1]);
    rate.push(tel.kerbHitHz[1]);
  }
  return { feel, rate, torque, speed: speedSum / Math.max(1, frames) / 3.6 };
}

/** The torque samples' (500 Hz) high-passed amplitude at `f` (Hz) */
function amplitudeAt(samples: number[], f: number): number {
  const hp = samples.map((x, i) => {
    let m = 0;
    let n = 0;
    for (let k = Math.max(0, i - 12); k < Math.min(samples.length, i + 12); k++) {
      m += samples[k];
      n++;
    }
    return x - m / n;
  });
  let re = 0;
  let im = 0;
  for (let i = 0; i < hp.length; i++) {
    re += hp[i] * Math.cos((2 * Math.PI * f * i) / 500);
    im += hp[i] * Math.sin((2 * Math.PI * f * i) / 500);
  }
  return Math.hypot(re, im) / hp.length;
}

const cars: { id: string; make: () => Car; minFeel: number }[] = [
  { id: 'F1 2026 car', make: () => new F12026CarSim(track, root) as unknown as Car, minFeel: 0.5 },
  { id: 'GT3', make: () => createAmgGt3Sim(track, root) as unknown as Car, minFeel: 0.5 },
  // The prototype's own tyre and suspension take the slots more softly (0.30 median)
  {
    id: '2026 Prototype',
    make: () => {
      const c = new F1Physics2026(track);
      c.attachTrackRoot(root);
      return c as unknown as Car;
    },
    minFeel: 0.15,
  },
];
for (const c of cars) {
  const kerb = drive(c.make, 0);
  const road = drive(c.make, 2.5);
  const slotHz = kerb.speed / SLOT_M;
  check(`${c.id}: the kerb is felt`, kerb.feel.length > 20 && median(kerb.feel) >= c.minFeel, `median ${median(kerb.feel).toFixed(2)} over ${kerb.feel.length} frames on it`);
  check(`${c.id}: the asphalt beside it is not`, median(road.feel) === 0, `median ${median(road.feel).toFixed(2)}`);
  const r = median(kerb.rate.filter((x) => x > 0));
  check(`${c.id}: hits come at the slots' rate`, Math.abs(r - slotHz) < 0.25 * slotHz, `${r.toFixed(1)} Hz, slots ${slotHz.toFixed(1)} Hz`);
  if (c.id === 'F1 2026 car') {
    const at = amplitudeAt(kerb.torque, slotHz);
    const around = [0.6, 0.75, 1.3, 1.5].map((m) => amplitudeAt(kerb.torque, slotHz * m)).reduce((a, b) => a + b) / 4;
    check(`${c.id}: the rack carries the slots`, at > 1.4 * around, `${(at / around).toFixed(1)}x the torque at nearby rates`);
  }
}
finish();
