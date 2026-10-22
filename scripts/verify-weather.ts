/**
 * Headless checks for weather, time of day, wet tyres and the realism levels.
 *
 *   npx tsx scripts/verify-weather.ts
 *
 *  1. Wet tyre model (`wet-tyres.ts`): slick / intermediate / full-wet grip vs water depth and speed
 *  2. Weather state (`weather.ts`): golden-hour default unchanged, rain wets / drying dries, cars dry the line,
 *     dynamic weather is deterministic, host sync round-trips
 *  3. f12026-car (`VehiclePhysics`): peak lateral g and braking dry vs wet per compound, rain tyres overheat in the dry
 *  4. VF26 tyre (`ac-tyre.ts`): peak lateral force per compound dry vs wet, rain tyres overheat in the dry
 *  5. Realism levels: casual has no wear / fuel use, full is the default
 *  6. AI: weather pace and tyre call
 */
import * as THREE from 'three';
import { getRwandaTrackData } from '../src/lib/track-data';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { VehiclePhysics, type VehicleInputs } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { computeTyreForces, createTyreRuntime, updateTyreThermal } from '../src/lib/sim/ac-tyre';
import { VF26_TYRES } from '../src/lib/sim/vf26-data';
import {
  dynamicBristleRelaxationScale,
  evaluateFlashTempAndWlfGrip,
  isRearFlapAllowedInWet,
  recommendedCompound,
  remainingTreadDepthMm,
  SLICK_TRAITS,
  WET_TYRE_TRAITS,
  wetGripFactor,
  wetGrooveGripEffect,
  wetnessFromWater,
  wetPneumaticTrailScale,
} from '../src/lib/sim/wet-tyres';
import {
  DEFAULT_SESSION_CONDITIONS,
  defaultWeatherNodesForPreset,
  dynamicWeatherAt,
  GOLDEN_HOUR_CLOCK_H,
  interpolateWeatherNodes,
  sanitizeWeatherSync,
  sunPosition,
  topographicalPuddleFactor,
  WeatherState,
} from '../src/lib/sim/weather';
import { evaluateAeroWakeDeficit } from '../src/lib/sim/aero-wake';
import { stepWindscreenWipers } from '../src/lib/render/rain-fx';
import { TrackEvolutionState } from '../src/lib/sim/track-evolution';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { DEFAULT_PLAYER_SETTINGS } from '../src/lib/settings/player-settings';
import type { TireCompound } from '../src/types/f1';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const COMPOUNDS: TireCompound[] = ['medium', 'intermediate', 'wet'];
const grip = (c: TireCompound, mm: number, kmh: number) => WET_TYRE_TRAITS[c].dryGrip * wetGripFactor(WET_TYRE_TRAITS[c], mm, kmh / 3.6);

// ---------------------------------------------------------------------------
// 1. Wet tyre model
// ---------------------------------------------------------------------------
console.log('\n== Wet tyre model (grip relative to a dry slick)');
for (const mm of [0, 0.1, 0.3, 0.6, 1.2, 2.4]) {
  console.log(`      ${fmt(mm, 1)} mm   ` + COMPOUNDS.map((c) => `${c.padEnd(12)} ${fmt(grip(c, mm, 120))} @120 ${fmt(grip(c, mm, 250))} @250`).join('   '));
}
check('Dry: slick > intermediate > wet', grip('medium', 0, 200) > grip('intermediate', 0, 200) && grip('intermediate', 0, 200) > grip('wet', 0, 200), COMPOUNDS.map((c) => fmt(grip(c, 0, 200))).join(' / '));
check('Damp (0.05 mm): slicks still the quickest', grip('medium', 0.05, 200) > grip('intermediate', 0.05, 200), `${fmt(grip('medium', 0.05, 200))} vs ${fmt(grip('intermediate', 0.05, 200))}`);
check('Wet (0.5 mm): intermediate the quickest', grip('intermediate', 0.5, 200) > grip('wet', 0.5, 200) && grip('intermediate', 0.5, 200) > grip('medium', 0.5, 200) + 0.2, COMPOUNDS.map((c) => fmt(grip(c, 0.5, 200))).join(' / '));
check('Standing water (2.4 mm): full wet the quickest', grip('wet', 2.4, 200) > grip('intermediate', 2.4, 200) + 0.2, COMPOUNDS.map((c) => fmt(grip(c, 2.4, 200))).join(' / '));
check('Slicks aquaplane at speed in standing water', grip('medium', 2.4, 250) < 0.2, fmt(grip('medium', 2.4, 250)));
check('Aquaplaning grows with speed (inters, 1.5 mm)', grip('intermediate', 1.5, 280) < grip('intermediate', 1.5, 100) - 0.2, `${fmt(grip('intermediate', 1.5, 100))} @100 → ${fmt(grip('intermediate', 1.5, 280))} @280`);
check('Recommended tyre follows the water', recommendedCompound(0) === 'medium' && recommendedCompound(0.5) === 'intermediate' && recommendedCompound(2) === 'wet', `${recommendedCompound(0)} / ${recommendedCompound(0.5)} / ${recommendedCompound(2)}`);

// ---------------------------------------------------------------------------
// 2. Weather state
// ---------------------------------------------------------------------------
console.log('\n== Weather & time of day');
{
  const sun = sunPosition(GOLDEN_HOUR_CLOCK_H);
  const w = new WeatherState(5300);
  check('Default is clear golden hour', DEFAULT_SESSION_CONDITIONS.weather === 'clear' && DEFAULT_SESSION_CONDITIONS.timeOfDay === 'golden_hour', `${DEFAULT_SESSION_CONDITIONS.weather}, ${DEFAULT_SESSION_CONDITIONS.timeOfDay}`);
  check('Golden hour keeps the 14° / 127° sun', Math.abs(sun.elevationDeg - 14) < 1e-6 && Math.abs(sun.azimuthDeg - 127) < 1e-6, `${fmt(sun.elevationDeg, 3)}° / ${fmt(sun.azimuthDeg, 3)}°`);
  for (let i = 0; i < 600; i++) w.step(1);
  check('Default stays 27 °C air / 41 °C track, dry', Math.abs(w.ambientC - 27) < 1e-6 && Math.abs(w.trackTempC - 41) < 1e-6 && w.waterMm === 0, `${fmt(w.ambientC, 3)} / ${fmt(w.trackTempC, 3)} °C, ${w.waterMm} mm`);
  check('Noon sun is high', sunPosition(12.2).elevationDeg > 70, `${fmt(sunPosition(12.2).elevationDeg, 1)}°`);

  const rain = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  check('Heavy rain: standing water, cool track', rain.waterMm > 1.5 && rain.trackTempC < rain.ambientC + 2, `${fmt(rain.waterMm)} mm, ${fmt(rain.ambientC, 1)} / ${fmt(rain.trackTempC, 1)} °C`);

  const dry = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon' });
  const lineCar = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'drying', timeOfDay: 'afternoon' });
  const w0 = dry.waterMm;
  // 6 cars at 60 m/s on the line for 8 min
  for (let t = 0; t < 480; t += 0.05) {
    dry.step(0.05);
    lineCar.step(0.05);
    for (let c = 0; c < 6; c++) lineCar.depositCarPass((t * 60 + c * 400) % 5300, 0, 60, 0.05);
  }
  const onLine = lineCar.waterAt(1000, 0, 0);
  const offLine = lineCar.waterAt(1000, 6, 0);
  check('Drying: the track dries', dry.waterMm < w0 * 0.75, `${fmt(w0)} → ${fmt(dry.waterMm)} mm in 8 min`);
  check('Drying: the cars dry the racing line first', onLine < offLine * 0.6, `line ${fmt(onLine)} mm vs ${fmt(offLine)} mm off it`);

  const a = dynamicWeatherAt(7, 1234);
  const b = dynamicWeatherAt(7, 1234);
  let rained = false;
  for (let s = 0; s < 3600 * 2; s += 30) if (dynamicWeatherAt(7, s).rain > 0.2) rained = true;
  check('Dynamic weather is deterministic and rains at times', a.cloud === b.cloud && a.rain === b.rain && rained, `cloud ${fmt(a.cloud)} rain ${fmt(a.rain)}`);

  const host = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'light_rain', timeScale: 5 });
  for (let i = 0; i < 100; i++) host.step(1);
  const guest = new WeatherState(5300);
  const snap = sanitizeWeatherSync(JSON.parse(JSON.stringify(host.snapshot())));
  if (snap) guest.applySync(snap);
  check('Host weather sync round-trips', !!snap && guest.conditions.weather === 'light_rain' && Math.abs(guest.waterMm - host.waterMm) < 1e-9 && Math.abs(guest.clockH - host.clockH) < 1e-9, `${guest.conditions.weather}, ${fmt(guest.waterMm, 3)} mm, ${fmt(guest.clockH, 3)} h`);
  check('Garbage sync is refused', sanitizeWeatherSync({ clockH: 'x' }) === null, 'null');
}

// ---------------------------------------------------------------------------
// 3. f12026-car / GT3 (VehiclePhysics)
// ---------------------------------------------------------------------------
console.log('\n== VehiclePhysics: peak lateral g at 150 km/h and braking 200→80 km/h');
const DT = 1 / 120;
const flat = new FlatGroundQuery();
function peakLateralG(config: typeof F12026_CAR_CONFIG | typeof AMG_GT3_CONFIG, compound: TireCompound, waterMm: number, kmh: number): number {
  const car = new VehiclePhysics({ ground: flat, config, airDensity: 1.06, compound: config.compoundSlots[compound] });
  car.waterMm = waterMm;
  car.wetness = wetnessFromWater(waterMm);
  car.reset(0, 0, 0, kmh / 3.6);
  let pedal = 0.3;
  let maxLat = 0;
  for (let t = 0; t < 8; t += DT) {
    pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < kmh ? 0.02 : -0.02), 0, 1);
    car.step(DT, { throttle: pedal, brake: 0, steer: -Math.min(1, t / 8) * 0.9 });
    maxLat = Math.max(maxLat, Math.abs(car.telemetry.latG));
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
    if (Math.abs(Math.atan2(car.velocity.dot(right), car.velocity.dot(fwd))) > 0.35) break;
  }
  return maxLat;
}
function brakingDistance(config: typeof F12026_CAR_CONFIG, compound: TireCompound, waterMm: number): number {
  const car = new VehiclePhysics({ ground: flat, config, airDensity: 1.06, compound: config.compoundSlots[compound] });
  car.waterMm = waterMm;
  car.wetness = wetnessFromWater(waterMm);
  car.reset(0, 0, 0, 200 / 3.6);
  let pedal = 1;
  const z0 = car.position.z;
  for (let t = 0; t < 15 && car.telemetry.speedKmh > 80; t += DT) {
    const sr = Math.min(...car.wheels.map((w) => w.slipRatio));
    pedal = THREE.MathUtils.clamp(pedal + (sr < -0.12 ? -0.1 : 0.05), 0.05, 1);
    const inp: VehicleInputs = { throttle: 0, brake: pedal, steer: 0 };
    car.step(DT, inp);
  }
  return car.position.z - z0;
}
for (const [label, cfg] of [['f12026-car', F12026_CAR_CONFIG], ['AMG GT3', AMG_GT3_CONFIG]] as const) {
  const g = (c: TireCompound, mm: number) => peakLateralG(cfg, c, mm, 150);
  const dry = { s: g('medium', 0), i: g('intermediate', 0), w: g('wet', 0) };
  const wet = { s: g('medium', 0.6), i: g('intermediate', 0.6), w: g('wet', 0.6) };
  const flood = { s: g('medium', 2.4), i: g('intermediate', 2.4), w: g('wet', 2.4) };
  console.log(`      ${label}: dry ${fmt(dry.s)} / ${fmt(dry.i)} / ${fmt(dry.w)} g · 0.6 mm ${fmt(wet.s)} / ${fmt(wet.i)} / ${fmt(wet.w)} g · 2.4 mm ${fmt(flood.s)} / ${fmt(flood.i)} / ${fmt(flood.w)} g (slick / inter / wet)`);
  check(`${label}: rain tyres slower in the dry`, dry.s > dry.i && dry.i > dry.w, `${fmt(dry.s)} > ${fmt(dry.i)} > ${fmt(dry.w)} g`);
  check(`${label}: wet road costs slicks most of their grip`, wet.s < 0.75 * dry.s && wet.i > wet.s, `${fmt(wet.s)} vs dry ${fmt(dry.s)}, inter ${fmt(wet.i)} g`);
  check(`${label}: standing water needs full wets`, flood.w > flood.i && flood.w > flood.s * 1.5, `${fmt(flood.w)} vs ${fmt(flood.i)} / ${fmt(flood.s)} g`);
}
{
  const dDry = brakingDistance(F12026_CAR_CONFIG, 'medium', 0);
  const dWetSlick = brakingDistance(F12026_CAR_CONFIG, 'medium', 1.2);
  const dWetWet = brakingDistance(F12026_CAR_CONFIG, 'wet', 1.2);
  check('f12026-car braking: wet road on slicks is far longer', dWetSlick > dDry * 1.6, `dry ${fmt(dDry, 1)} m, 1.2 mm slicks ${fmt(dWetSlick, 1)} m`);
  check('f12026-car braking: full wets stop shorter than slicks in rain', dWetWet < dWetSlick, `wets ${fmt(dWetWet, 1)} m vs slicks ${fmt(dWetSlick, 1)} m`);
}
// Rain tyres in the dry run hot for their window: 90 s of steady 1.7 g cornering at 150 km/h
{
  const soak = (compound: TireCompound, waterMm: number) => {
    const car = new VehiclePhysics({ ground: flat, config: F12026_CAR_CONFIG, airDensity: 1.06, compound: F12026_CAR_CONFIG.compoundSlots[compound] });
    car.waterMm = waterMm;
    car.wetness = wetnessFromWater(waterMm);
    car.reset(0, 0, 0, 150 / 3.6);
    let pedal = 0.3;
    for (let t = 0; t < 90; t += DT) {
      pedal = THREE.MathUtils.clamp(pedal + (car.telemetry.speedKmh < 150 ? 0.02 : -0.02), 0, 1);
      car.step(DT, { throttle: pedal, brake: 0, steer: -0.12 });
    }
    const td = F12026_CAR_CONFIG.tyreCompounds[F12026_CAR_CONFIG.compoundSlots[compound]]!.thermalData;
    const surf = Math.max(...car.wheels.map((w) => w.surfaceTempC));
    return { surf, over: surf - (td.optimalTempC[0] + td.optimalTempC[1]) / 2, window: td.optimalTempC };
  };
  const slick = soak('medium', 0);
  const inter = soak('intermediate', 0);
  const interWet = soak('intermediate', 0.6);
  check('f12026-car: inters run hot for their window in the dry', inter.over > slick.over + 15, `inter ${fmt(inter.surf, 0)} °C (window ${inter.window.join('–')}), slick ${fmt(slick.surf, 0)} °C (${slick.window.join('–')})`);
  check('f12026-car: a wet road cools the tyres', interWet.surf < inter.surf - 8, `inter wet ${fmt(interWet.surf, 0)} vs dry ${fmt(inter.surf, 0)} °C`);
}

// ---------------------------------------------------------------------------
// 4. VF26 tyre (ac-tyre)
// ---------------------------------------------------------------------------
console.log('\n== VF26 tyre (ac-tyre): peak lateral force at 4 kN, 55 m/s');
{
  const peakFy = (c: TireCompound, waterMm: number) => {
    let best = 0;
    for (let deg = 1; deg <= 14; deg += 0.5) {
      const t = createTyreRuntime(VF26_TYRES[c].front, c === 'medium' ? 95 : 95 + WET_TYRE_TRAITS[c].tempShiftC);
      t.waterMm = waterMm;
      t.wetness = wetnessFromWater(waterMm);
      let fy = 0;
      const vx = 55;
      const vy = -vx * Math.tan((deg * Math.PI) / 180);
      for (let i = 0; i < 200; i++) fy = computeTyreForces(t, { fz: 4000, vx, vy, rimSpeed: vx, camberLeftRad: 0, surfaceGrip: 1, dt: 1 / 2000 }).fy;
      best = Math.max(best, Math.abs(fy));
    }
    return best;
  };
  const d = { s: peakFy('medium', 0), i: peakFy('intermediate', 0), w: peakFy('wet', 0) };
  const r = { s: peakFy('medium', 1), i: peakFy('intermediate', 1), w: peakFy('wet', 1) };
  console.log(`      dry ${fmt(d.s, 0)} / ${fmt(d.i, 0)} / ${fmt(d.w, 0)} N · 1 mm ${fmt(r.s, 0)} / ${fmt(r.i, 0)} / ${fmt(r.w, 0)} N (slick / inter / wet)`);
  check('VF26: rain tyres slower in the dry', d.s > d.i && d.i > d.w, `${fmt(d.s, 0)} > ${fmt(d.i, 0)} > ${fmt(d.w, 0)} N`);
  check('VF26: rain tyres beat slicks on 1 mm of water', r.i > 2 * r.s && r.w > 2 * r.s, `${fmt(r.i, 0)} / ${fmt(r.w, 0)} vs ${fmt(r.s, 0)} N`);

  // Thermal: 5 min of sliding at 6 kW on a dry road (to equilibrium)
  const heat = (c: TireCompound, wetness: number) => {
    const t = createTyreRuntime(VF26_TYRES[c].front, 80);
    t.wetness = wetness;
    for (let i = 0; i < 300 * 200; i++) updateTyreThermal(t, 6000, 4000, 55, 27, 41, 1 / 200);
    return t.surfaceTempC;
  };
  const sDry = heat('medium', 0);
  const wDry = heat('wet', 0);
  const wWet = heat('wet', 1);
  check('VF26: full wets run hotter than slicks on a dry road', wDry > sDry + 10, `wet ${fmt(wDry, 0)} vs slick ${fmt(sDry, 0)} °C`);
  check('VF26: water on the road cools the tread', wWet < wDry - 15, `wet road ${fmt(wWet, 0)} vs dry ${fmt(wDry, 0)} °C`);
}

// ---------------------------------------------------------------------------
// 5. Realism
// ---------------------------------------------------------------------------
console.log('\n== Simulation realism');
{
  check('Default realism is Full', DEFAULT_PLAYER_SETTINGS.realism === 'full', DEFAULT_PLAYER_SETTINGS.realism);
  const t = createTyreRuntime(VF26_TYRES.soft.front, 95);
  t.wearScale = SIM_REALISM_FLAGS.casual.tyreWearScale;
  for (let i = 0; i < 2000; i++) updateTyreThermal(t, 30000, 4000, 55, 27, 41, 1 / 200);
  const full = createTyreRuntime(VF26_TYRES.soft.front, 95);
  for (let i = 0; i < 2000; i++) updateTyreThermal(full, 30000, 4000, 55, 27, 41, 1 / 200);
  check('Casual: no tyre wear', t.wear === 0 && full.wear > 0, `casual ${t.wear}, full ${fmt(full.wear * 100, 3)} %`);

  const track = getRwandaTrackData();
  const fuel = (level: 'casual' | 'full') => {
    const sim = new F1Physics2026(track);
    sim.setSimRealism(SIM_REALISM_FLAGS[level]);
    sim.aiAutopilot = true;
    sim.resetToStartGrid(true);
    const f0 = sim.telemetry.fuelKg;
    for (let i = 0; i < 300; i++) sim.step(1 / 60, {});
    return f0 - sim.telemetry.fuelKg;
  };
  const burnt = { casual: fuel('casual'), full: fuel('full') };
  check('Casual: no fuel use', burnt.casual === 0 && burnt.full > 0, `casual ${fmt(burnt.casual, 3)} kg, full ${fmt(burnt.full, 3)} kg in 5 s`);
}

// ---------------------------------------------------------------------------
// 6. AI
// ---------------------------------------------------------------------------
console.log('\n== AI in the wet');
{
  const track = getRwandaTrackData();
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain' });
  const ai = new F1Physics2026(track).createAiPeerCar();
  ai.aiAutopilot = true;
  ai.tireCompound = 'soft';
  env.update(1 / 60, [ai]);
  const fitted = ai.tireCompound as TireCompound;
  check('AI fits full wets in heavy rain', fitted === 'wet', fitted);
  // The VF26 plans its corner speeds and braking points on its wet grip
  const planGrip = ai.aiPlanGrip();
  ai.tireCompound = 'soft';
  const slickPlanGrip = ai.aiPlanGrip();
  const dryAi = new F1Physics2026(track).createAiPeerCar();
  check('VF26 AI plans on its wet grip, less on slicks', planGrip < 0.9 && slickPlanGrip < planGrip && dryAi.aiPlanGrip() === 1, `wets ${fmt(planGrip, 2)}, slicks ${fmt(slickPlanGrip, 2)}, dry ${fmt(dryAi.aiPlanGrip(), 2)}`);
  // A car without its own wet plan gets a pace factor instead
  const plain = (tireCompound: TireCompound) => ({ sMeters: 100, lateralOffsetM: 0, tireCompound }) as unknown as SimulatorCar;
  const pace = env.weatherPaceScale(plain('wet'));
  const slickPace = env.weatherPaceScale(plain('soft'));
  const dryEnv = new TrackEnvironment(track);
  check('AI pace drops in the wet, more on slicks', pace < 0.95 && slickPace < pace && dryEnv.weatherPaceScale(plain('soft')) === 1, `wets ${fmt(pace, 3)}, slicks ${fmt(slickPace, 3)}, dry 1`);
  const player = new F1Physics2026(track);
  player.tireCompound = 'soft';
  env.update(1 / 60, [player]);
  check("The player's tyres are left alone", player.tireCompound === 'soft', player.tireCompound);
}

// ---------------------------------------------------------------------------
// 7. RealRoad wet groove inversion, worn tread aquaplaning, 5-node weather & wet rim cooling
// ---------------------------------------------------------------------------
console.log('\n== RealRoad wet surface evolution, tread depth & 5-node weather');
{
  // Worn rain tyre loses tread depth and aquaplanes earlier
  const freshInter = wetGripFactor(WET_TYRE_TRAITS.intermediate, 1.4, 65, 1, 0);
  const wornInter = wetGripFactor(WET_TYRE_TRAITS.intermediate, 1.4, 65, 1, 0.8);
  const remMm = remainingTreadDepthMm(WET_TYRE_TRAITS.intermediate, 0.8);
  check(
    'Worn intermediate tread clears less water and aquaplanes earlier',
    wornInter < freshInter - 0.15 && remMm < (WET_TYRE_TRAITS.intermediate.treadDepthMm ?? 2.5) * 0.4,
    `fresh ${fmt(freshInter, 2)} vs 80% worn ${fmt(wornInter, 2)} (${fmt(remMm, 2)} mm tread left)`
  );

  // Wet groove inversion: above 0.18 wetness, the rubbered-in racing line has less grip than the unrubbered off-line tarmac
  const evo = new TrackEvolutionState(5300);
  evo.reset('saturated');
  const dryOnLine = evo.sample(1000, 0, 0, 0).gripMultiplier;
  const dryOffLine = evo.sample(1000, 5, 0, 0).gripMultiplier;
  const wetOnLine = evo.sample(1000, 0, 0, 0.85);
  const wetOffLine = evo.sample(1000, 5, 0, 0.85);
  check(
    'Dry rubbered line has more grip than off-line; wet rubbered line inverts and loses grip',
    dryOnLine > dryOffLine && wetOnLine.gripMultiplier < wetOffLine.gripMultiplier && wetGrooveGripEffect(0.95, 0.85, 1) < 0,
    `dry line ${fmt(dryOnLine, 3)} > off ${fmt(dryOffLine, 3)} · wet line ${fmt(wetOnLine.gripMultiplier, 3)} < off ${fmt(wetOffLine.gripMultiplier, 3)}`
  );

  // 4-channel surface state export/import round-trip
  const snap = evo.exportSurfaceState();
  const evo2 = new TrackEvolutionState(5300);
  evo2.reset('green');
  evo2.importSurfaceState(snap);
  check(
    '4-channel surface state snapshot round-trips',
    Math.abs(evo2.sample(500, 0, 0).rubberLevel - evo.sample(500, 0, 0).rubberLevel) < 1e-6,
    `rubber ${fmt(evo2.sample(500, 0, 0).rubberLevel, 3)}`
  );

  // 5-node weather schedule interpolation & 3x3 spatial rain cell grid
  const nodes = defaultWeatherNodesForPreset('heavy_rain', 'afternoon', 42);
  const midNode = interpolateWeatherNodes(nodes, 0.5, 42);
  const wx = new WeatherState(5300, { ...DEFAULT_SESSION_CONDITIONS, weather: 'heavy_rain', weatherNodes: nodes });
  wx.step(120);
  const centerRain = wx.rainAtWorldPos(0, 0);
  const edgeRain = wx.rainAtWorldPos(450, -450);
  check(
    '5-node weather schedule & 3x3 spatial rain grid evaluate cleanly',
    nodes.length === 5 && midNode.rain > 0.5 && centerRain > 0.5 && edgeRain > 0.3,
    `mid rain ${fmt(midNode.rain, 2)}, grid center ${fmt(centerRain, 2)}, edge ${fmt(edgeRain, 2)}`
  );

  // Wet rim & internal gas cooling drops hot tyre pressure in the wet
  const dryTyre = createTyreRuntime(VF26_TYRES.intermediate.front, 85);
  const wetTyre = createTyreRuntime(VF26_TYRES.intermediate.front, 85);
  wetTyre.wetness = 0.9;
  for (let i = 0; i < 60 * 200; i++) {
    updateTyreThermal(dryTyre, 4000, 3800, 60, 22, 26, 1 / 200, 320);
    updateTyreThermal(wetTyre, 4000, 3800, 60, 22, 26, 1 / 200, 320);
  }
  check(
    'Wet spray cools wheel rim and internal gas, lowering hot inflation pressure',
    wetTyre.gasTempC < dryTyre.gasTempC - 5 && wetTyre.pressurePsi < dryTyre.pressurePsi - 0.3,
    `wet ${fmt(wetTyre.pressurePsi, 2)} psi (${fmt(wetTyre.gasTempC, 1)} °C) vs dry ${fmt(dryTyre.pressurePsi, 2)} psi (${fmt(dryTyre.gasTempC, 1)} °C)`
  );

  // Wet rear-flap (DRS / X-mode) lockout above wetness 0.25
  check(
    'Rear flap (DRS / X-mode) locked out when wetness >= 0.25',
    isRearFlapAllowedInWet(0.1) && !isRearFlapAllowedInWet(0.35),
    `wetness 0.10 → ${isRearFlapAllowedInWet(0.1)}, wetness 0.35 → ${isRearFlapAllowedInWet(0.35)}`
  );

  // 8. Topographical puddle pooling, WLF viscoelastic contact patch, pneumatic trail collapse & spray wake
  console.log('\n== Topographical puddles, WLF viscoelasticity, hydroplaning FFB & rooster-tail spray');
  const highSideBank = topographicalPuddleFactor(400, -5, 6, 0, 7.5);
  const lowSideGutter = topographicalPuddleFactor(400, 6.5, 6, 0, 7.5);
  const steepSlope = topographicalPuddleFactor(800, 0, 0, 12, 7.5);
  const flatBasin = topographicalPuddleFactor(800, 0, 0, 0, 7.5);
  check(
    'Topographical drainage: banked high side & steep slopes drain; low inside gutter & flat basins pool water',
    lowSideGutter > highSideBank + 0.25 && flatBasin > steepSlope + 0.15,
    `gutter ${fmt(lowSideGutter, 2)}x > high bank ${fmt(highSideBank, 2)}x · flat basin ${fmt(flatBasin, 2)}x > steep slope ${fmt(steepSlope, 2)}x`
  );

  // Per-wheel puddle hydrodynamic drag yaw pull on VehiclePhysics
  const puddleCar = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: F12026_CAR_CONFIG,
    compound: F12026_CAR_CONFIG.compoundSlots.soft,
  });
  puddleCar.reset(0, 0, 0);
  puddleCar.velocity.set(0, 0, 65);
  for (const w of puddleCar.wheels) w.omega = 65 / 0.36;
  // Right wheels (RF=1, RR=3) hit a 3.0 mm standing puddle while left wheels (LF=0, LR=2) are on 0.05 mm damp tarmac
  puddleCar.waterMm = 0.5;
  puddleCar.wheelWaterMm = [0.05, 3.0, 0.05, 3.0];
  puddleCar.wetness = 0.5;
  for (let i = 0; i < 60; i++) puddleCar.step(1 / 120, { throttle: 0, brake: 0, steer: 0, clutch: 1 });
  check(
    'Per-wheel standing puddle pulls car yaw toward the flooded side',
    puddleCar.angularVelocity.y < -0.01,
    `yawRate ${fmt(puddleCar.angularVelocity.y * (180 / Math.PI), 2)} °/s (pulled right toward 3.0 mm puddle)`
  );

  // Flash temperature quenching & WLF viscoelastic compliance on cold wet tarmac
  const dryFlash = evaluateFlashTempAndWlfGrip(SLICK_TRAITS, 38, 6, 4200, 0);
  const wetSlickWlf = evaluateFlashTempAndWlfGrip(SLICK_TRAITS, 38, 6, 4200, 0.9);
  const wetFullWlf = evaluateFlashTempAndWlfGrip(WET_TYRE_TRAITS.wet, 38, 6, 4200, 0.9);
  const bristleHighLoad = dynamicBristleRelaxationScale(6500, 3500, 0.2);
  const bristleLowLoadWet = dynamicBristleRelaxationScale(2000, 3500, 0.9);
  check(
    'Water quenches asperity flash heating and silica wet compound retains higher WLF viscoelastic grip at 38 °C',
    wetSlickWlf.flashDeltaC < dryFlash.flashDeltaC * 0.5 &&
      wetFullWlf.viscoelasticMult > wetSlickWlf.viscoelasticMult &&
      bristleHighLoad > bristleLowLoadWet,
    `flash dry ${fmt(dryFlash.flashDeltaC, 1)} °C vs wet ${fmt(wetSlickWlf.flashDeltaC, 1)} °C · WLF wet ${fmt(wetFullWlf.viscoelasticMult, 3)} > slick ${fmt(wetSlickWlf.viscoelasticMult, 3)}`
  );

  // Hydroplaning pneumatic trail collapse (FFB lightening)
  const trailLowSpeed = wetPneumaticTrailScale(WET_TYRE_TRAITS.intermediate, 1.6, 20, 0);
  const trailHydroplane = wetPneumaticTrailScale(WET_TYRE_TRAITS.intermediate, 1.6, 82, 0);
  check(
    'Pneumatic trail collapses at hydroplaning speed to lighten steering FFB',
    trailHydroplane < trailLowSpeed * 0.65,
    `trail @20 m/s ${fmt(trailLowSpeed, 2)} → @82 m/s ${fmt(trailHydroplane, 2)}`
  );

  // Airborne rooster-tail spray wake & visor droplet accumulation
  const emitters = [
    { sMeters: 500, lateralOffsetM: 0, speedMs: 65 },
    { sMeters: 518, lateralOffsetM: 0.2, speedMs: 65 },
  ];
  const wakeDry = evaluateAeroWakeDeficit(500, 0, 65, emitters, 5300, 0, 0, 0);
  const wakeWet = evaluateAeroWakeDeficit(500, 0, 65, emitters, 5300, 0, 0, 0.9);
  const visor = { dropletDensity: 0, wiperPhase: 0, wiperMode: 'off' as const };
  for (let i = 0; i < 30; i++) stepWindscreenWipers(visor, 0.05, 0.4, wakeWet.sprayIntensity ?? 0, 60, true);
  check(
    'Rooster-tail spray wake builds behind leading cars in the wet and wets the visor/windscreen',
    (wakeDry.sprayIntensity ?? 0) === 0 && (wakeWet.sprayIntensity ?? 0) > 0.35 && visor.dropletDensity > 0.05,
    `spray dry ${fmt(wakeDry.sprayIntensity ?? 0, 2)}, wet ${fmt(wakeWet.sprayIntensity ?? 0, 2)}, visor droplets ${fmt(visor.dropletDensity, 2)} (wiper: ${visor.wiperMode})`
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll weather checks passed.');
if (failures.length) process.exit(1);
