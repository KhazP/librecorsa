/**
 * The steering torque is the moment of the front tyres' road loads about their kingpins, both cars:
 *   node scripts/run-verify.mjs rack-torque
 *  - pneumatic trail from the contact patch (a/3), so it grows with load
 *  - Fx at the scrub radius, Fy at the caster trail, Fz's KPI / caster weight-jacking, Mz and Mx onto the axis
 *  - a parked car's tyres twist against the road: the rim is heavy when turned in place and holds steady
 *  - hydraulic power steering takes part of the rack torque, the parked load most, so it stays inside full scale
 *  - the road texture is a position-based height the tyres roll over, so the rim only feels it through them
 *  - the F1 has steering compliance, stiffer than the GT3's
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VehiclePhysics, flatSpotThumpNm } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import {
  contactHalfLengthM,
  driverRackTorqueNm,
  kingpinMomentNm,
  spinFrictionArmM,
} from '../src/lib/sim/f12026-car/steering-torque';
import { roadTextureHeightM, ROAD_TEXTURE_RMS_M } from '../src/lib/sim/road-texture';

let passed = 0;
function check(name: string, fn: () => string | void) {
  const detail = fn();
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}
const DT = 1 / 120;
const D2R = Math.PI / 180;
const flat = new FlatGroundQuery(0);
const CARS = [
  ['F1', F12026_CAR_CONFIG],
  ['GT3', AMG_GT3_CONFIG],
] as const;
const make = (config: (typeof CARS)[number][1], speedMs = 0) => {
  const c = new VehiclePhysics({ ground: flat, config: config as never, airDensity: 1.06 });
  c.reset(0, 0, 0, speedMs);
  c.takeFfbAverage();
  c.takeFfbSubframeSamples();
  return c;
};
const sd = (a: number[]) => {
  const m = a.reduce((s, x) => s + x, 0) / a.length;
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
};
/** R² of the least-squares fit y ≈ β0 + Σ βk·xk (normal equations, Gauss-Jordan) */
function linearFitR2(y: number[], X: number[][]): number {
  const p = X[0].length + 1;
  const A = Array.from({ length: p }, () => new Array<number>(p + 1).fill(0));
  for (let i = 0; i < y.length; i++) {
    const row = [1, ...X[i]];
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < p; b++) A[a][b] += row[a] * row[b];
      A[a][p] += row[a] * y[i];
    }
  }
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      for (let k = col; k <= p; k++) A[r][k] -= f * A[col][k];
    }
  }
  const beta = A.map((row, i) => row[p] / row[i]);
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let ssr = 0;
  let sst = 0;
  for (let i = 0; i < y.length; i++) {
    const fit = [1, ...X[i]].reduce((s, v, k) => s + v * beta[k], 0);
    ssr += (y[i] - fit) ** 2;
    sst += (y[i] - my) ** 2;
  }
  return 1 - ssr / sst;
}

console.log('Contact patch');
check('the patch lengthens with load, and the pneumatic trail (a/3) with it', () => {
  const R = 0.3625;
  const rate = 317_000;
  const t = [1500, 3000, 6000, 9000].map((fz) => contactHalfLengthM(R, fz / rate) / 3);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], t.join(' '));
  assert.ok(t[0] > 0.015 && t[0] < 0.03 && t[3] > 0.04 && t[3] < 0.06, t.join(' '));
  return t.map((x) => `${(x * 1000).toFixed(0)} mm`).join(' / ');
});
check('the spin-friction lever is the mean distance over the patch', () => {
  assert.ok(Math.abs(spinFrictionArmM(1, 1) - 0.7652) < 1e-3);
});
check('in a corner the aligning moment carries the trail of the patch it has', () => {
  const c = make(F12026_CAR_CONFIG, 120 / 3.6);
  for (let t = 0; t < 2; t += DT) c.step(DT, { throttle: 0.3, brake: 0, steer: -0.05 * Math.min(1, t) });
  const w = c.wheels[1];
  const trail = -w.mz / w.fy / Math.max(1e-6, 1 - w.combinedSlip);
  assert.ok(Math.abs(trail - w.patchHalfLengthM / 3) < 2e-3, `${trail} vs ${w.patchHalfLengthM / 3}`);
  return `${(trail * 1000).toFixed(1)} mm at ${(w.fz / 1000).toFixed(1)} kN`;
});
check("a tyre's own trail share replaces the third of the patch", () => {
  const share = 0.24;
  const own = {
    ...F12026_CAR_CONFIG,
    tyreCompounds: Object.fromEntries(
      Object.entries(F12026_CAR_CONFIG.tyreCompounds).map(([k, t]) => [k, t && { ...t, modelData: { ...t.modelData, trailShare: share } }])
    ),
  };
  const c = make(own as never, 120 / 3.6);
  for (let t = 0; t < 2; t += DT) c.step(DT, { throttle: 0.3, brake: 0, steer: -0.05 * Math.min(1, t) });
  const w = c.wheels[1];
  const trail = -w.mz / w.fy / Math.max(1e-6, 1 - w.combinedSlip);
  assert.ok(Math.abs(trail - w.patchHalfLengthM * share) < 1e-3, `${trail} vs ${w.patchHalfLengthM * share}`);
  return `${(trail * 1000).toFixed(1)} mm, ${(trail / w.patchHalfLengthM).toFixed(3)} of the half-length`;
});
check('a flat spot thumps the rack once a revolution, as the worn sector meets the road', () => {
  const wear = new Float32Array(16).fill(0.01);
  wear[5] = 0.02;
  const n = 720;
  const shake = Array.from({ length: n }, (_, k) => flatSpotThumpNm(0.2, (k / n) * 2 * Math.PI, 80, 4000, wear));
  let peaks = 0;
  for (let k = 0; k < n; k++) if (shake[k] > shake[(k + n - 1) % n] && shake[k] >= shake[(k + 1) % n]) peaks++;
  const crest = shake.indexOf(Math.max(...shake));
  const crestSector = Math.floor((crest / n) * 16);
  assert.ok(peaks === 1 && crestSector === 5, `${peaks} peaks, crest in sector ${crestSector}`);
  assert.ok(flatSpotThumpNm(0.004, 1, 80, 4000, wear) === 0, 'no shake from a trace of a flat');
  return `${Math.max(...shake).toFixed(2)} Nm crest`;
});

console.log('Moments about the kingpin');
{
  const ex = new THREE.Vector3(1, 0, 0);
  const ey = new THREE.Vector3(0, 1, 0);
  const ez = new THREE.Vector3(0, 0, 1);
  const kin = { kpiRad: 10 * D2R, casterRad: 7 * D2R, casterTrailM: 0.012, scrubRadiusM: 0.04 };
  const M = (inboard: number, steer: number, fx: number, fy: number, fz: number, mz = 0) => {
    const fw = new THREE.Vector3(Math.sin(steer), 0, Math.cos(steer));
    const lw = new THREE.Vector3(Math.cos(steer), 0, -Math.sin(steer));
    return kingpinMomentNm(ex, ey, ez, ey, fw, lw, inboard, steer, 0.36, kin, fx, fy, fz, mz, 0);
  };
  check('a lateral force acts at the caster trail, turning the wheel back', () => {
    const m = M(-1, 0, 0, 1000, 0);
    assert.ok(m < 0 && Math.abs(-m / 1000 - 0.012) < 0.001, `${m}`);
  });
  check('braking acts at the scrub radius: even braking cancels across the rack, one wheel toes out', () => {
    assert.ok(Math.abs(M(-1, 0, -1000, 0, 0) + M(1, 0, -1000, 0, 0)) < 1e-9);
    assert.ok(M(-1, 0, -1000, 0, 0) > 30, 'left wheel braking turns it left');
  });
  check('the vertical load self-centres a steered pair (KPI / caster weight-jacking), none straight ahead', () => {
    assert.ok(Math.abs(M(-1, 0, 0, 0, 2000) + M(1, 0, 0, 0, 2000)) < 1e-9);
    const sums = [5, 10, 20].map((deg) => M(-1, deg * D2R, 0, 0, 2000) + M(1, deg * D2R, 0, 0, 2000));
    for (let i = 0; i < sums.length; i++) assert.ok(sums[i] < 0 && (i === 0 || sums[i] < sums[i - 1]), sums.join(' '));
    return `${sums.map((s) => s.toFixed(1)).join(' / ')} Nm at 5 / 10 / 20°`;
  });
  check('the aligning moment reaches the axis almost whole', () => {
    const m = M(-1, 0, 0, 0, 0, 100);
    assert.ok(m > 97 && m < 100, `${m}`);
  });
}

console.log('Parked and slow');
for (const [name, config] of CARS) {
  check(`${name}: turning the wheel in place builds a heavy, steady torque against it, the power steering keeping it in range`, () => {
    const c = make(config);
    for (let t = 0; t < 0.5; t += DT) {
      c.step(DT, { throttle: 0, brake: 1, steer: 0 });
      c.takeFfbSubframeSamples();
    }
    const before = c.takeFfbAverage();
    for (let k = 1; k <= 60; k++) c.step(DT, { throttle: 0, brake: 1, steer: (0.3 * k) / 60 });
    c.takeFfbAverage();
    c.takeFfbSubframeSamples();
    const held: number[] = [];
    for (let k = 0; k < 60; k++) {
      c.step(DT, { throttle: 0, brake: 1, steer: 0.3 });
      held.push(...c.takeFfbSubframeSamples());
    }
    const mean = held.reduce((s, x) => s + x, 0) / held.length;
    // Rim convention (+ = right): turned right, the tyres push it back left
    assert.ok(Math.abs(before) < 0.01, `before ${before}`);
    assert.ok(mean < -0.45 && mean > -0.75, `held ${mean}`);
    assert.ok(sd(held) < 0.01, `steady ${sd(held)}`);
    assert.ok(c.velocity.length() < 0.05, `the car stays put (${c.velocity.length()} m/s)`);
    return `${before.toFixed(3)} → ${mean.toFixed(2)}`;
  });
  check(`${name}: rolling lets the twist out, so the wheel lightens with speed`, () => {
    const at = (kmh: number) => {
      const c = make(config, kmh / 3.6);
      let pedal = 0.1;
      let sum = 0;
      let n = 0;
      for (let t = 0; t < 3; t += DT) {
        pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < kmh ? 0.01 : -0.01), 0, 1);
        c.step(DT, { throttle: pedal, brake: 0, steer: 0.3 * Math.min(1, t / 0.5) });
        const s = c.takeFfbSubframeSamples();
        if (t > 2) {
          sum += s.reduce((a, x) => a + x, 0);
          n += s.length;
        }
      }
      return sum / n;
    };
    const parked = (() => {
      const c = make(config);
      for (let k = 1; k <= 60; k++) c.step(DT, { throttle: 0, brake: 1, steer: (0.3 * k) / 60 });
      for (let k = 0; k < 30; k++) c.step(DT, { throttle: 0, brake: 1, steer: 0.3 });
      c.takeFfbSubframeSamples();
      c.step(DT, { throttle: 0, brake: 1, steer: 0.3 });
      return c.takeFfbAverage() * -1;
    })();
    const slow = at(5);
    assert.ok(slow < 0 && Math.abs(slow) < 0.6 * Math.abs(parked), `${slow} vs parked ${parked}`);
    return `parked ${parked.toFixed(2)}, 5 km/h ${slow.toFixed(2)}`;
  });
}

console.log('Power steering');
check("the rim gets the driver's share: T·(1 + boost ratio) holds the rack, none below the valve's deadband", () => {
  for (const [, config] of CARS) {
    const ps = config.chassis.powerSteering;
    assert.ok(ps, 'both cars have power steering');
    const below = 0.9 * ps.deadbandNm * ps.steeringRatio;
    assert.equal(driverRackTorqueNm(below, 0, ps), below);
    let last = 0;
    for (const rack of [200, 400, 600, 800, 1000]) {
      const driver = driverRackTorqueNm(rack, 0, ps);
      const t = driver / ps.steeringRatio;
      const u = THREE.MathUtils.clamp((t - ps.deadbandNm) / ps.rampNm, 0, 1);
      const ratio = ps.maxRatio * u * u * (3 - 2 * u);
      assert.ok(Math.abs(t * (1 + ratio) - rack / ps.steeringRatio) < 1e-3, `${rack}: ${t}`);
      assert.ok(driver > last && driver <= rack, `rises with the rack, never above it (${rack} → ${driver})`);
      assert.equal(driverRackTorqueNm(-rack, 0, ps), -driver);
      last = driver;
    }
  }
});
check("the GT3's speed-sensitive pump gives no assist at speed; the F1's engine-driven one the same at any speed", () => {
  const gt3 = AMG_GT3_CONFIG.chassis.powerSteering;
  const f1 = F12026_CAR_CONFIG.chassis.powerSteering;
  assert.equal(driverRackTorqueNm(700, 100 / 3.6, gt3), 700);
  assert.ok(driverRackTorqueNm(700, 0, gt3) < 0.6 * 700);
  assert.equal(driverRackTorqueNm(500, 0, f1), driverRackTorqueNm(500, 80, f1));
});

console.log('Road texture');
check('a deterministic height of position, ≈ 0.5 mm RMS, that the patch smooths', () => {
  assert.equal(roadTextureHeightM(120.4, -85.2, 0.08), roadTextureHeightM(120.4, -85.2, 0.08));
  assert.ok(ROAD_TEXTURE_RMS_M > 3e-4 && ROAD_TEXTURE_RMS_M < 8e-4, `${ROAD_TEXTURE_RMS_M}`);
  const along = (a: number) => {
    const h: number[] = [];
    for (let z = 0; z < 500; z += 0.02) h.push(roadTextureHeightM(2, z, a));
    return sd(h);
  };
  assert.ok(along(0.1) < along(0), 'a longer patch averages more of it out');
  return `${(ROAD_TEXTURE_RMS_M * 1000).toFixed(2)} mm`;
});
for (const [name, config] of CARS) {
  check(`${name}: parked, nothing buzzes; at speed the rim shakes with the front tyres' loads`, () => {
    const parked = make(config);
    const still: number[] = [];
    for (let t = 0; t < 1; t += DT) {
      parked.step(DT, { throttle: 0, brake: 1, steer: 0 });
      if (t > 0.5) still.push(...parked.takeFfbSubframeSamples());
      else parked.takeFfbSubframeSamples();
    }
    const c = make(config, 200 / 3.6);
    let pedal = 0.3;
    const rim: number[] = [];
    const loads: number[][] = [];
    const dLoad: number[] = [];
    for (let t = 0; t < 2; t += 1 / 500) {
      pedal = THREE.MathUtils.clamp(pedal + (c.telemetry.speedKmh < 200 ? 0.02 : -0.02), 0, 1);
      c.step(1 / 500, { throttle: pedal, brake: 0, steer: 0 });
      const s = c.takeFfbSubframeSamples();
      if (t > 0.5) {
        const [L, R] = c.wheels;
        rim.push(s[s.length - 1] as number);
        loads.push([L.fx, R.fx, L.fy, R.fy, L.fz, R.fz, L.mz + L.mzTwist, R.mz + R.mzTwist, L.mx, R.mx, L.gyroSteerNm, R.gyroSteerNm]);
        dLoad.push(L.fz - R.fz);
      }
    }
    // Everything the rim does is the front tyres' loads at their levers plus the wheels' gyroscopic torque: a linear fit
    // on them leaves nothing over
    const r2 = linearFitR2(rim, loads);
    assert.ok(sd(still) < 1e-4, `parked ${sd(still)}`);
    assert.ok(sd(rim) > 1e-3 && sd(dLoad) > 50, `rim ${sd(rim)}, load ${sd(dLoad)}`);
    assert.ok(r2 > 0.99, `R² ${r2}`);
    return `rim sd ${sd(rim).toFixed(4)}, front load difference sd ${sd(dLoad).toFixed(0)} N, R² on the tyre loads ${r2.toFixed(4)}`;
  });
}

console.log('Steering compliance');
check('the F1 gives way to lateral force too, far less than the bushed GT3', () => {
  const f1 = F12026_CAR_CONFIG.chassis.steerComplianceDegPerKN ?? 0;
  const gt3 = AMG_GT3_CONFIG.chassis.steerComplianceDegPerKN ?? 0;
  assert.ok(f1 > 0 && f1 < 0.5 * gt3, `${f1} vs ${gt3}`);
  const c = make(F12026_CAR_CONFIG, 200 / 3.6);
  for (let t = 0; t < 2; t += DT) c.step(DT, { throttle: 0.4, brake: 0, steer: -0.1 * Math.min(1, t) });
  const w = c.wheels[1];
  const perKn = (Math.abs(w.complianceRad) / D2R / Math.abs(w.fy)) * 1000;
  assert.ok(Math.abs(perKn - f1) < 0.01, `${perKn}`);
  return `${(Math.abs(w.complianceRad) / D2R).toFixed(2)}° at ${(Math.abs(w.fy) / 1000).toFixed(1)} kN`;
});

console.log(`\n${passed} checks passed`);
