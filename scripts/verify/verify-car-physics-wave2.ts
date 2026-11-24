/**
 * Wave 2 car-physics & setup polish verification:
 *  1. LC-LMDH low-downforce aero balance, yaw neutrality, straight-line advantage, and transient snap-oversteer resistance
 *  2. Aero package tooltips and i18n keys/notes wiring in Segmented & EngineersGarage
 *  3. Heavy-rain wet tyre grip reduction, wet braking distance increase, and F12026CarSim wet braking guide scaling
 *  4. AMG GT3 dry turn-in softening (rack ratio, front tyre stiffness/lag, keyboard steer profile, step-steer poise)
 *
 *   npx tsx scripts/verify/verify-car-physics-wave2.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { OPEN_WHEEL_KEYBOARD_STEER } from '../../src/lib/input/keyboard-steer';
import { DEFAULT_CHASSIS_SETUP, FACTORY_PRESETS, STEER_RATIO_BASE } from '../../src/lib/sim/car-setup';
import { compoundData, F12026_CAR_CONFIG } from '../../src/lib/sim/f12026-car/F12026CarConfig';
import { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { FlatGroundQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../../src/lib/sim/f12026-car/VehiclePhysics';
import { AMG_GT3_CONFIG } from '../../src/lib/sim/gt3/AmgGt3Config';
import { AMG_GT3_SIM_PROFILE, createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { LC_LMDH_CONFIG, LC_LMDH_LONG_CONFIG } from '../../src/lib/sim/proto/LcLmdhConfig';
import { createLcLmdhSim, LC_LMDH_SIM_PROFILE } from '../../src/lib/sim/proto/LcLmdhSim';
import { WET_TYRE_TRAITS, wetGripFactor, wetnessFromWater } from '../../src/lib/sim/wet-tyres';
import { getActiveTrackData } from '../../src/lib/track-data';
import { createFlatTestTrack } from '../lib/flat-track';
import { midCorner, steadyRamp, steerFor, stepSteer } from '../lib/handling-tests';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const DT = 1 / 120;
const flat = new FlatGroundQuery(0);
const pad = createFlatTestTrack(40_000, 3000);

// ---------------------------------------------------------------------------
// 1. LC-LMDH low-downforce stability
// ---------------------------------------------------------------------------
console.log('\n== 1. LC-LMDH low-downforce stability');
{
  const aeroSample = (preset: 'balanced' | 'low_downforce', kmh: number) => {
    const cfg = structuredClone(LC_LMDH_CONFIG);
    const [f, r] = LC_LMDH_SIM_PROFILE.aeroPackagesDeg[preset];
    for (const w of cfg.aero.wings) w.angleDeg += w.name === 'FRONT_WING' ? f : w.name === 'REAR_WING' ? r : 0;
    const car = new VehiclePhysics({ ground: flat, config: cfg, airDensity: 1.225 });
    car.reset(0, 0, 0, kmh / 3.6);
    for (let t = 0; t < 4; t += DT) {
      car.step(DT, { throttle: car.telemetry.speedKmh < kmh ? 0.6 : 0.25, brake: 0, steer: 0 });
    }
    const q = 0.5 * 1.225 * car.speedMs ** 2;
    const bal0 = car.telemetry.AERO_BALANCE;
    const cdA = car.telemetry.dragN / q;
    const clA = car.telemetry.downforceN / q;
    // Probe 8° yaw CoP shift
    const speed = car.velocity.length();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
    const rad = (8 * Math.PI) / 180;
    car.velocity.copy(fwd.multiplyScalar(Math.cos(rad) * speed).add(side.multiplyScalar(Math.sin(rad) * speed)));
    car.step(DT, { throttle: 0.35, brake: 0, steer: 0 });
    return { bal0, balYaw8: car.telemetry.AERO_BALANCE, cdA, clA };
  };

  const bal250 = aeroSample('balanced', 250);
  const low250 = aeroSample('low_downforce', 250);
  const bal150 = aeroSample('balanced', 150);
  const low150 = aeroSample('low_downforce', 150);

  check(
    'Low-downforce shifts aero balance slightly rearward vs balanced',
    low150.bal0 < bal150.bal0 - 0.3 &&
      low250.bal0 < bal250.bal0 - 0.3 &&
      Math.abs(low150.bal0 - bal150.bal0) < 1 &&
      Math.abs(low250.bal0 - bal250.bal0) < 1,
    `150 km/h ${fmt(low150.bal0)}% vs ${fmt(bal150.bal0)}%, 250 km/h ${fmt(low250.bal0)}% vs ${fmt(bal250.bal0)}%`
  );
  check(
    'Low-downforce keeps CoP neutral in an 8° yaw slide (no forward snap)',
    Math.abs(low250.balYaw8 - low250.bal0) < 0.25,
    `0° ${fmt(low250.bal0)}% → 8° ${fmt(low250.balYaw8)}% (Δ ${fmt(low250.balYaw8 - low250.bal0)}%)`
  );
  check(
    'Low-downforce meaningfully cuts drag while preserving downforce',
    low250.cdA < bal250.cdA - 0.08 && low250.clA < bal250.clA - 0.5,
    `CD·A ${fmt(low250.cdA, 3)} vs ${fmt(bal250.cdA, 3)} m², CL·A ${fmt(low250.clA)} vs ${fmt(bal250.clA)} m²`
  );
  check(
    'LC_LMDH_LONG_CONFIG front wing matches low_downforce aero trim',
    LC_LMDH_LONG_CONFIG.aero.wings.find((w) => w.name === 'FRONT_WING')?.angleDeg ===
      LC_LMDH_SIM_PROFILE.aeroPackagesDeg.low_downforce[0],
    `${LC_LMDH_LONG_CONFIG.aero.wings.find((w) => w.name === 'FRONT_WING')?.angleDeg}°`
  );

  const soft = compoundData(LC_LMDH_CONFIG, LC_LMDH_CONFIG.compoundSlots.soft);
  const rearFla = soft.rearOverride?.modelData?.friction_limit_angle ?? 0;
  const frontFla = soft.modelData.friction_limit_angle ?? 0;
  const rearFalloff = soft.rearOverride?.modelData?.falloff_level ?? 0;
  check(
    'LC-LMDH rear slick has wider peak slip and gentler falloff than front',
    rearFla > frontFla && rearFalloff > soft.modelData.falloff_level,
    `rear ${rearFla}° / ${rearFalloff} vs front ${frontFla}° / ${soft.modelData.falloff_level}`
  );

  const makeLmdh = (preset: 'low_downforce' | 'factory_ld') => () => {
    const sim = createLcLmdhSim(pad);
    if (preset === 'low_downforce') {
      sim.aeroPreset = 'low_downforce';
    } else {
      const f = FACTORY_PRESETS['lc-lmdh']![0];
      sim.aeroPreset = f.aero;
      sim.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, ...f.chassis });
      if (f.camberDeg) sim.setTyreSetup({ ...sim.getTyreSetup(), camberDeg: f.camberDeg });
    }
    return sim;
  };

  for (const label of ['low_downforce', 'factory_ld'] as const) {
    const r200 = steadyRamp(makeLmdh(label), 200 / 3.6, 10, 0.5);
    const pwr200 = midCorner(makeLmdh(label), 200 / 3.6, steerFor(r200, 0.75), { throttle: 1, brake: 0 });
    const lift200 = midCorner(makeLmdh(label), 200 / 3.6, steerFor(r200, 0.85), { throttle: 0, brake: 0 });
    const brk200 = midCorner(makeLmdh(label), 200 / 3.6, steerFor(r200, 0.7), { throttle: 0, brake: 0.5 });
    check(
      `LC-LMDH ${label} @ 200 km/h power-on exit stays controllable (no snap spin)`,
      !pwr200.spun && pwr200.peakSlipDeg < 15,
      `peak slip ${fmt(pwr200.peakSlipDeg, 1)}°, spun=${pwr200.spun}`
    );
    check(
      `LC-LMDH ${label} @ 200 km/h lift-off & brake-in-turn stay planted`,
      !lift200.spun && !brk200.spun && lift200.peakSlipDeg < 6 && brk200.peakSlipDeg < 6,
      `lift ${fmt(lift200.peakSlipDeg, 1)}°, brake ${fmt(brk200.peakSlipDeg, 1)}°`
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Aero package tooltips & i18n
// ---------------------------------------------------------------------------
console.log('\n== 2. Aero package tooltips & i18n');
{
  const enMenu = JSON.parse(readFileSync(resolve(process.cwd(), 'src/i18n/messages/en/menu.json'), 'utf8')) as {
    garage: Record<string, string>;
  };
  const notesMenu = JSON.parse(readFileSync(resolve(process.cwd(), 'src/i18n/notes/menu.json'), 'utf8')) as Record<string, string>;
  const keys = ['lowDownforceHint', 'balancedHint', 'highDownforceHint'] as const;
  check(
    'English menu catalog and translator notes define all three aero hints',
    keys.every((k) => typeof enMenu.garage[k] === 'string' && enMenu.garage[k].length > 20 && typeof notesMenu[`garage.${k}`] === 'string'),
    keys.map((k) => `${k} (${enMenu.garage[k]?.length ?? 0} chars)`).join(', ')
  );
  const segSrc = readFileSync(resolve(process.cwd(), 'src/components/ui/Segmented.tsx'), 'utf8');
  const garageSrc = readFileSync(resolve(process.cwd(), 'src/components/menu/EngineersGarage.tsx'), 'utf8');
  check(
    'Segmented passes option title tooltips and EngineersGarage wires aero package tooltips + active hint',
    segSrc.includes('title?: string') &&
      segSrc.includes('title={o.title}') &&
      garageSrc.includes('hint={tx(AERO_PRESET_HINT[p.aeroPreset])}') &&
      garageSrc.includes('title: tx("lowDownforceHint")') &&
      garageSrc.includes('title: tx("balancedHint")') &&
      garageSrc.includes('title: tx("highDownforceHint")'),
    'Segmented + EngineersGarage'
  );
}

// ---------------------------------------------------------------------------
// 3. Heavy-rain wet tyre grip & braking
// ---------------------------------------------------------------------------
console.log('\n== 3. Heavy-rain wet tyre grip & braking');
{
  const gWet120 = WET_TYRE_TRAITS.wet.dryGrip * wetGripFactor(WET_TYRE_TRAITS.wet, 2.4, 120 / 3.6);
  const gWet220 = WET_TYRE_TRAITS.wet.dryGrip * wetGripFactor(WET_TYRE_TRAITS.wet, 2.4, 220 / 3.6);
  const gInter05 = WET_TYRE_TRAITS.intermediate.dryGrip * wetGripFactor(WET_TYRE_TRAITS.intermediate, 0.5, 160 / 3.6);
  check(
    'Heavy rain (2.4 mm) full-wet grip drops to realistic 45–62% @120 and 40–55% @220',
    gWet120 >= 0.45 && gWet120 <= 0.62 && gWet220 >= 0.4 && gWet220 <= 0.55 && gWet220 < gWet120,
    `${fmt(gWet120)} @120, ${fmt(gWet220)} @220 (inter @0.5 mm: ${fmt(gInter05)})`
  );

  const stopDist = (cfg: typeof F12026_CAR_CONFIG | typeof AMG_GT3_CONFIG | typeof LC_LMDH_CONFIG, comp: 'medium' | 'wet', mm: number) => {
    const car = new VehiclePhysics({ ground: flat, config: cfg as never, airDensity: 1.06, compound: cfg.compoundSlots[comp] });
    car.waterMm = mm;
    car.wetness = wetnessFromWater(mm);
    car.reset(0, 0, 0, 200 / 3.6);
    let pedal = 1;
    const z0 = car.position.z;
    for (let t = 0; t < 20 && car.telemetry.speedKmh > 80; t += DT) {
      const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
      pedal = THREE.MathUtils.clamp(pedal + (sr < -0.12 ? -0.1 : 0.05), 0.05, 1);
      car.step(DT, { throttle: 0, brake: pedal, steer: 0 });
    }
    return car.position.z - z0;
  };
  for (const [label, cfg] of [['F1', F12026_CAR_CONFIG], ['AMG GT3', AMG_GT3_CONFIG], ['LC-LMDH', LC_LMDH_CONFIG]] as const) {
    const dDry = stopDist(cfg, 'medium', 0);
    const dHeavy = stopDist(cfg, 'wet', 2.4);
    const mult = dHeavy / dDry;
    check(
      `${label}: heavy rain (2.4 mm wets) braking 200→80 km/h is ≥1.5× dry`,
      mult >= 1.5 && mult <= 2.3,
      `dry ${fmt(dDry, 1)} m → heavy rain ${fmt(dHeavy, 1)} m (×${fmt(mult)})`
    );
  }

  // F12026CarSim wet braking guide must scale down on full wets in heavy rain (not divide by dryGrip)
  const track = getActiveTrackData();
  const sim = createAmgGt3Sim(track);
  sim.tireCompound = 'medium';
  sim.setWeatherSample({ waterMm: 0, lineWaterMm: 0, wetness: 0, ambientC: 25, rain: 0 });
  const dryBucket = (sim as unknown as { brakingGuideGripBucket: number }).brakingGuideGripBucket;
  sim.tireCompound = 'wet';
  sim.setWeatherSample({ waterMm: 2.4, lineWaterMm: 2.4, wetness: wetnessFromWater(2.4), ambientC: 18, rain: 0.85 });
  const wetBucket = (sim as unknown as { brakingGuideGripBucket: number }).brakingGuideGripBucket;
  check(
    'F12026CarSim braking guide reduces planned grip in heavy rain on full wets',
    dryBucket === 20 && wetBucket <= 13,
    `bucket ${dryBucket}/20 dry → ${wetBucket}/20 heavy rain`
  );
}

// ---------------------------------------------------------------------------
// 4. AMG GT3 dry turn-in tuning
// ---------------------------------------------------------------------------
console.log('\n== 4. AMG GT3 dry turn-in');
{
  const gt3Soft = compoundData(AMG_GT3_CONFIG, AMG_GT3_CONFIG.compoundSlots.soft);
  const fFla = gt3Soft.modelData.friction_limit_angle ?? 0;
  const rFla = gt3Soft.rearOverride?.modelData?.friction_limit_angle ?? 0;
  const fRelY = gt3Soft.modelData.relaxationLengthY;
  const rRelY = gt3Soft.rearOverride?.modelData?.relaxationLengthY ?? fRelY;
  check(
    'GT3 rack is slower (14.2:1) and keyboard steer calmer than open-wheelers',
    AMG_GT3_SIM_PROFILE.steerRatio === 14.2 &&
      STEER_RATIO_BASE['amg-gt3'] === 14.2 &&
      AMG_GT3_CONFIG.chassis.powerSteering?.steeringRatio === 14.2 &&
      (AMG_GT3_SIM_PROFILE.keyboardSteer?.lowSpeedRate ?? 9) < OPEN_WHEEL_KEYBOARD_STEER.lowSpeedRate &&
      (AMG_GT3_SIM_PROFILE.keyboardSteer?.highSpeedRate ?? 9) <= OPEN_WHEEL_KEYBOARD_STEER.highSpeedRate,
    `ratio ${AMG_GT3_SIM_PROFILE.steerRatio}:1, kb ${AMG_GT3_SIM_PROFILE.keyboardSteer?.lowSpeedRate}/${AMG_GT3_SIM_PROFILE.keyboardSteer?.highSpeedRate}`
  );
  check(
    'GT3 front tyre has softer initial cornering stiffness and longer carcass lag than rear',
    fFla > rFla + 0.4 && fRelY > rRelY + 0.03,
    `peak slip ${fFla}° vs ${rFla}°, relaxY ${fmt(fRelY, 3)} vs ${fmt(rRelY, 3)} m`
  );

  const gt3Ramp = steadyRamp(() => createAmgGt3Sim(pad), 110 / 3.6);
  const f1Ramp = steadyRamp(() => new F12026CarSim(pad), 150 / 3.6);
  const gt3Step = stepSteer(() => createAmgGt3Sim(pad), 110 / 3.6, steerFor(gt3Ramp, 0.5));
  const f1Step = stepSteer(() => new F12026CarSim(pad), 150 / 3.6, steerFor(f1Ramp, 0.5));
  check(
    'GT3 dry turn-in is calmer and more progressive than open-wheeler F1',
    gt3Step.responseTimeS > f1Step.responseTimeS + 0.03 &&
      gt3Ramp.understeerDegPerG >= 1.3 &&
      gt3Ramp.understeerDegPerG <= 1.85 &&
      gt3Ramp.maxG >= 1.65 &&
      gt3Ramp.maxG <= 1.9,
    `GT3 resp ${fmt(gt3Step.responseTimeS, 3)} s (F1 ${fmt(f1Step.responseTimeS, 3)} s), US ${fmt(gt3Ramp.understeerDegPerG)}°/g, peak ${fmt(gt3Ramp.maxG)} g`
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll Wave 2 car-physics checks passed.');
if (failures.length) process.exit(1);
