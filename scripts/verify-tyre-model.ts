/**
 * The brush tyre family (`src/lib/sim/f12026-car/brush-tyre.ts`, `TyresModelData.curve: 'brush'`) against the numbers
 * its data implies: the shape of the force curve, how gently it lets go past the peak, where the peak sits with load,
 * grip and pressure, combined slip, the tyre's lag and the grip lost to sliding speed. Then the same on a car.
 *
 *   npx tsx scripts/verify-tyre-model.ts
 */
import {
  brushCurve,
  brushForces,
  brushPeakSlipTan,
  brushRelaxationLength,
  brushSlipStiffness,
  brushSpeedGrip,
  createBrushTyre,
  type BrushForces,
} from '../src/lib/sim/f12026-car/brush-tyre';
import { compoundData, type TyresModelData } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { MTR_496R_CONFIG } from '../src/lib/sim/proto/Mtr496rConfig';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 3) => v.toFixed(d);
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const DEG = Math.PI / 180;

// The 496R's soft slick: peak slip angle 6.216°, +6.21 % of it per Fz0 (3 kN) of load, sliding level 0.86 reached at
// 4 per unit of slip, combined exponent 2.23, longitudinal stiffness × 1.24, 0.2 % of grip per m/s of sliding
const model: TyresModelData = compoundData(MTR_496R_CONFIG, MTR_496R_CONFIG.compoundSlots.soft).modelData;
const FZ0 = 3000;
const tanPeak0 = Math.tan(6.216 * DEG);
const tyre = createBrushTyre(model, tanPeak0, FZ0);

console.log('== The curve');
{
  check('Reaches its peak at the peak slip, and 87.5 % of it at half', near(brushCurve(tyre, tanPeak0, tanPeak0), 1, 1e-12) && near(brushCurve(tyre, 0.5 * tanPeak0, tanPeak0), 0.875, 1e-12),
    `${fmt(brushCurve(tyre, 0.5 * tanPeak0, tanPeak0))} at half the peak slip`);
  const slope = brushCurve(tyre, 1e-6, tanPeak0) / 1e-6;
  check('Slip stiffness is 3 × the peak over the peak slip', near(slope * tanPeak0, 3, 1e-4) && near(brushSlipStiffness(tyre, tanPeak0) * tanPeak0, 3, 1e-12), `${fmt(slope * tanPeak0)}`);
  // level + (1 − level) / (1 + speed × slip past the peak): 0.86 + 0.14 / (1 + 4 × 0.0545) and … / (1 + 4 × 0.1089)
  const at15 = brushCurve(tyre, 1.5 * tanPeak0, tanPeak0);
  const at2 = brushCurve(tyre, 2 * tanPeak0, tanPeak0);
  check('Lets go gently: 97.5 % at 1.5 × the peak slip, 95.7 % at 2 ×', near(at15, 0.9749, 5e-4) && near(at2, 0.9575, 5e-4), `${fmt(at15, 4)} / ${fmt(at2, 4)}`);
  check('... and heads for its sliding level far past the peak', near(brushCurve(tyre, 50, tanPeak0), 0.86, 0.002), fmt(brushCurve(tyre, 50, tanPeak0)));
  const held = createBrushTyre({ ...model, use_slip_falloff: false }, tanPeak0, FZ0);
  check('A tyre without a falloff holds its peak', brushCurve(held, 3 * tanPeak0, tanPeak0) === 1, '');
  const full = createBrushTyre({ ...model, curveFullness: 0.28 }, tanPeak0, FZ0);
  // The cubic's 0.875 plus 0.28 × 3 × 0.5 × 0.25
  check('A fuller rising branch: 0.98 at half the peak slip for a fullness of 0.28', near(brushCurve(full, 0.5 * tanPeak0, tanPeak0), 0.98, 1e-12), fmt(brushCurve(full, 0.5 * tanPeak0, tanPeak0)));
}

console.log('\n== Where the peak sits');
{
  const peakDeg = (fz: number, grip = 1, pressure = 1) => Math.atan(brushPeakSlipTan(tyre, fz, grip, pressure)) / DEG;
  check('6.216° at Fz0, 6.21 % more at twice the load', near(peakDeg(FZ0), 6.216, 1e-9) && near(peakDeg(2 * FZ0), 6.216 * 1.0621, 1e-6), `${fmt(peakDeg(FZ0))}° / ${fmt(peakDeg(2 * FZ0))}°`);
  check('Linear in load beyond', near(brushPeakSlipTan(tyre, 3 * FZ0, 1, 1) - brushPeakSlipTan(tyre, 2 * FZ0, 1, 1), brushPeakSlipTan(tyre, 2 * FZ0, 1, 1) - tanPeak0, 1e-12), `${fmt(peakDeg(3 * FZ0))}° at 3 × Fz0`);
  // Three quarters of a grip loss: 0.8 of the grip → 0.85 of the peak slip
  check('A tyre with 80 % of its grip peaks at 85 % of the slip', near(brushPeakSlipTan(tyre, FZ0, 0.8, 1) / tanPeak0, 0.85, 1e-12), fmt(brushPeakSlipTan(tyre, FZ0, 0.8, 1) / tanPeak0));
  // Pressure gain −0.06: 10 % under the optimum → ÷ (1 + 0.006)
  check('10 % under its pressure it peaks 0.6 % earlier', near(brushPeakSlipTan(tyre, FZ0, 1, 0.9) / tanPeak0, 1 / 1.006, 1e-12), fmt(brushPeakSlipTan(tyre, FZ0, 1, 0.9) / tanPeak0, 4));
}

console.log('\n== Combined slip');
{
  const out: BrushForces = { fx: 0, fy: 0, slipNorm: 0 };
  brushForces(tyre, 0, tanPeak0, tanPeak0, out);
  check('Pure cornering at the peak slip angle: the full lateral force', near(out.fy, 1, 1e-12) && out.fx === 0 && near(out.slipNorm, 1, 1e-12), '');
  // Driving, the theoretical slip is κ / (1 + κ); the longitudinal peak is the lateral one over 1.24
  const sigma = tanPeak0 / 1.24;
  const kDrive = sigma / (1 - sigma);
  const kBrake = -sigma / (1 + sigma);
  brushForces(tyre, kDrive, 0, tanPeak0, out);
  const drive = out.fx;
  brushForces(tyre, kBrake, 0, tanPeak0, out);
  check('Drive force peaks at 9.6 % slip, braking at 8.1 %', near(drive, 1, 1e-9) && near(out.fx, -1, 1e-9) && near(kDrive, 0.0963, 5e-4) && near(kBrake, -0.0807, 5e-4),
    `κ ${fmt(kDrive, 4)} / ${fmt(kBrake, 4)}`);
  // Equal slips on both axes, each at 70 % of the lateral peak: the exponent 2.23 leaves a little more of each force
  // than a circle would (the combined slip is 0.7 × 2^(1/2.23) = 0.955 of the peak instead of 0.990)
  const kEq = (0.7 * tanPeak0) / (1 - 0.7 * tanPeak0);
  brushForces(tyre, kEq, 0.7 * tanPeak0 * (1 + kEq), tanPeak0, out);
  check('Braking and turning at once: combined slip 0.955 of the peak', near(out.slipNorm, 0.7 * Math.pow(2, 1 / 2.23), 1e-9), `slip ${fmt(out.slipNorm)}, forces ${fmt(out.fx)} / ${fmt(out.fy)}`);
  const circle = createBrushTyre({ ...model, combinedExponent: 2 }, tanPeak0, FZ0);
  const ref: BrushForces = { fx: 0, fy: 0, slipNorm: 0 };
  brushForces(circle, kEq, 0.7 * tanPeak0 * (1 + kEq), tanPeak0, ref);
  check('... which is less slip than the friction circle counts', out.slipNorm < ref.slipNorm && near(ref.slipNorm, 0.7 * Math.SQRT2, 1e-9), `${fmt(out.slipNorm)} vs ${fmt(ref.slipNorm)}`);
}

console.log('\n== Lag and sliding speed');
{
  const L = model.relaxationLengthY;
  check('Twice the relaxation length at small slip and 2 kN', near(brushRelaxationLength(tyre, 2000, 0), 2 * L, 1e-12), `${fmt(brushRelaxationLength(tyre, 2000, 0))} m`);
  check('2.6 × at 4 kN', near(brushRelaxationLength(tyre, 4000, 0), 2.6 * L, 1e-12), `${fmt(brushRelaxationLength(tyre, 4000, 0))} m`);
  check('The relaxation length itself once the tyre is at its peak', near(brushRelaxationLength(tyre, 4000, 1), L, 1e-12) && near(brushRelaxationLength(tyre, 4000, 3), L, 1e-12), '');
  check('2 % of its grip lost at 10 m/s of sliding', near(brushSpeedGrip(tyre, 10), 1 / 1.02, 1e-12), fmt(brushSpeedGrip(tyre, 10), 4));
}

console.log('\n== On the car (496R, flat road, 150 km/h)');
{
  const DT = 1 / 500;
  const car = new VehiclePhysics({ ground: new FlatGroundQuery(0), config: MTR_496R_CONFIG, airDensity: 1.2 });
  car.reset(0, 0, 0, 150 / 3.6);
  let pedal = 0.3;
  // A gentle corner, 5 % of lock, held: the outer front tyre in steady state
  let fy = 0;
  let expected = 0;
  let n = 0;
  const camberGain = compoundData(MTR_496R_CONFIG, MTR_496R_CONFIG.compoundSlots.soft).camberData.camberGain;
  for (let i = 0; i < 6 / DT; i++) {
    pedal = Math.min(1, Math.max(0, pedal + (car.telemetry.speedKmh < 150 ? 0.004 : -0.004)));
    car.step(DT, { throttle: pedal, brake: 0, steer: -0.05 * Math.min(1, i * DT) });
    if (i < 4 / DT) continue;
    const w = car.wheels[1];
    // Its slip angle with the camber's share (sin γ × the camber gain) taken off, read on the cubic
    const slip = Math.abs(Math.tan(w.slipAngleRad - Math.sin(w.camberLeftRad) * camberGain)) / (1 + w.slipRatio);
    const s = Math.min(1, slip / Math.tan(w.peakSlipAngleRad));
    fy += Math.abs(w.fy);
    expected += w.muY * w.fz * (1 - (1 - s) ** 3);
    n++;
  }
  check('A front tyre in a steady corner makes the cubic\'s force at its slip, within 3 %', near(fy / expected, 1, 0.03), `${fmt(fy / n, 0)} N vs ${fmt(expected / n, 0)} N`);
  const w = car.wheels[1];
  check('Its cornering stiffness is 3 × μ·Fz over the peak slip', near(w.corneringStiffness, (3 * w.muY * w.fz) / Math.tan(w.peakSlipAngleRad), 1e-6 * w.corneringStiffness),
    `${fmt(w.corneringStiffness / 1000, 1)} kN per unit of tan α at ${fmt(w.fz, 0)} N`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll tyre model checks passed.');
if (failures.length) process.exitCode = 1;
