/**
 * The traffic bias of a car on a drive plan that tracks plans its own way (src/lib/sim/ai/plan-bias.ts): it moves
 * across with the lateral acceleration its tyres have to spare, arrives at its goal at rest without overshooting it, and
 * with an endless acceleration it is the plain rate limit the F1 cars and the GT3 keep.
 *
 *   npx tsx scripts/verify/verify-plan-bias.ts
 */
import { biasAccelMs2, FIELD_CORNER_K, ownCornerK, stepBias } from '../../src/lib/sim/ai/plan-bias';

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};
const DT = 1 / 120;

/** Runs the bias toward `goal` for `s` seconds: its path, peak lateral speed and acceleration */
function run(goal: number, rate: number, accel: number, s: number, b0 = 0, v0 = 0) {
  let b = b0, v = v0, peakV = 0, peakA = 0, overshoot = 0;
  const path: number[] = [];
  for (let t = 0; t < s; t += DT) {
    const r = stepBias(b, v, goal, rate, accel, DT);
    peakA = Math.max(peakA, Math.abs(r.vel - v) / DT);
    b = r.bias;
    v = r.vel;
    peakV = Math.max(peakV, Math.abs(v));
    overshoot = Math.max(overshoot, Math.sign(goal - b0) * (b - goal));
    path.push(b);
  }
  return { b, v, peakV, peakA, overshoot, path };
}

// The plain rate limit: an endless acceleration is the old step
{
  const r = stepBias(0, 0, 3, 2.2, Infinity, DT);
  check('an endless acceleration steps at the plain rate', Math.abs(r.bias - 2.2 * DT) < 1e-12);
  const near = stepBias(2.999, 0, 3, 2.2, Infinity, DT);
  check('...and lands on a goal within one step', near.bias === 3);
}

// A move of 3 m at 2.2 m/s with 2 m/s² to spare
{
  const r = run(3, 2.2, 2, 4);
  check(`arrives at the goal (${r.b.toFixed(4)} m) at rest (${r.v.toFixed(4)} m/s)`, Math.abs(r.b - 3) < 1e-6 && Math.abs(r.v) < 1e-9);
  check(`never past the goal (${r.overshoot.toFixed(4)} m)`, r.overshoot <= 1e-9);
  check(`never faster across than the rate (${r.peakV.toFixed(3)} m/s)`, r.peakV <= 2.2 + 1e-9);
  check(`never more lateral acceleration than allowed (${r.peakA.toFixed(3)} m/s²)`, r.peakA <= 2 + 1e-6);
  // Time-optimal for a 3 m move at 2 m/s² capped at 2.2 m/s: 1.1 s up, 0.26 s at the rate, 1.1 s down ≈ 2.46 s
  const t = r.path.findIndex((b) => Math.abs(b - 3) < 1e-6) * DT;
  check(`about as quick as the tyres allow (${t.toFixed(2)} s, 2.46 s ideal)`, t > 2.3 && t < 2.7);
  const plain = run(3, 2.2, Infinity, 4);
  check(`slower to start than the plain rate (${r.path[11].toFixed(3)} vs ${plain.path[11].toFixed(3)} m after 0.1 s)`, r.path[11] < 0.25 * plain.path[11]);
}

// A goal reversed mid-move: the bias brakes its lateral speed first, it does not flick back
{
  let b = 0, v = 0, peakA = 0;
  for (let t = 0; t < 1.2; t += DT) ({ bias: b, vel: v } = stepBias(b, v, 3, 2.2, 2, DT));
  const vAt = v;
  for (let t = 0; t < 5; t += DT) {
    const r = stepBias(b, v, -1, 2.2, 2, DT);
    peakA = Math.max(peakA, Math.abs(r.vel - v) / DT);
    b = r.bias;
    v = r.vel;
  }
  check(`a reversed goal is reached (${b.toFixed(4)} m) from ${vAt.toFixed(2)} m/s the other way`, Math.abs(b + 1) < 1e-6 && Math.abs(v) < 1e-9);
  check(`...within the acceleration (${peakA.toFixed(3)} m/s²)`, peakA <= 2 + 1e-6);
}

// Small moves and holding still
{
  const r = run(0.05, 2.2, 2, 1);
  check('a 5 cm move arrives', Math.abs(r.b - 0.05) < 1e-6 && Math.abs(r.v) < 1e-9);
  const h = run(1.5, 2.2, 2, 1, 1.5, 0);
  check('on its goal at rest it stays', h.path.every((b) => b === 1.5));
}

// The acceleration a move may use
{
  check('on a straight: the share of the limit', Math.abs(biasAccelMs2(8, 40, 0, 0.25, 0.5) - 2) < 1e-12);
  check('in a corner: what the limit leaves beside the path', Math.abs(biasAccelMs2(8, 40, 7 / 1600, 0.25, 0.5) - 1) < 1e-12);
  check('on the limit: the floor', biasAccelMs2(8, 40, 8 / 1600, 0.25, 0.5) === 0.5);
  check('past the limit: still the floor', biasAccelMs2(8, 40, 0.01, 0.25, 0.5) === 0.5);
  check('either way round the corner', biasAccelMs2(8, 40, -7 / 1600, 0.25, 0.5) === biasAccelMs2(8, 40, 7 / 1600, 0.25, 0.5));
}

// Corners by the car's own grip: RISE short's sweep, centreline 0.004 1/m, the Liana's line 0.0035 1/m at 41 m/s with
// 7.8 m/s² of grip (≈ 75 % of it)
{
  const k = ownCornerK(0.004, 0.0035, 41, 7.8, 0.5);
  check(`a sweep that takes most of a road car's grip is a corner to the field (${k.toFixed(4)} 1/m)`, k > FIELD_CORNER_K);
  check('...on the side it turns', ownCornerK(-0.004, -0.0035, 41, 7.8, 0.5) === -k);
  const f1 = ownCornerK(0.004, 0.0035, 41, 24, 0.5);
  check(`...and not at that speed on three times the grip (${f1.toFixed(4)} 1/m: the centreline's)`, f1 === 0.004);
  check('the centreline rules where it is the tighter', ownCornerK(0.02, 0.001, 20, 8, 0.5) === 0.02);
  check('a straight stays a straight', ownCornerK(0, 0, 50, 8, 0.5) === 0);
  check('a line curving on a straight centreline turns its own way', ownCornerK(0, -0.004, 40, 8, 0.5) < -FIELD_CORNER_K);
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
