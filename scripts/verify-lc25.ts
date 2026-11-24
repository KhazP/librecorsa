/**
 * End-to-end verification suite for the 2025 Formula 1 LC25 Prototype:
 *  1. FIA 2025 regulatory invariants (800 kg, 44.6-46.1% split, 120 kW / 200 Nm MGU-K, MGU-H, 70 °C blankets, no plank wear)
 *  2. 2025 ERS + MGU-H physics (100 km/h launch lockout, MGU-H anti-lag, direct H->K bypass past 4 MJ, H->ES past 2 MJ)
 *  3. Rest stability, rear-only DRS drag/speed gain, braking 300->80 km/h, high-speed lateral g, compound ladder
 *  4. AI flying laps on RISE Motordrome (repo) + 2025 OpenF1 Spielberg / Monaco telemetry checks (when track files exist locally)
 *  5. 3D model (`public/cars/lc25/model/lc25.glb`) rig, DRS hinge, tyre, steering wheel and size invariants
 *
 * Run: npx tsx scripts/verify-lc25.ts
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { carById, carOvertakingRules, carTakesLivery } from '../src/lib/cars/car-registry';
import { VEHICLE_MODELS } from '../src/lib/cars/vehicle-models';
import { LC25_CAR_CONFIG, LC25_FUEL_FLOW_CURVE_KGS } from '../src/lib/sim/f12025-car/Lc25Config';
import { createLc25Sim } from '../src/lib/sim/f12025-car/Lc25Sim';
import { Lut } from '../src/lib/sim/lut';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { getActiveTrackData, setActiveTrack, type BuiltTrackData, type RawTrackJson } from '../src/lib/track-data';
import { aiLineOffsetM } from '../src/lib/sim/speed-profile';
import { createFlatTestTrack } from './lib/flat-track';
import { physicsLap } from './ai/lib/physics-lap';
import { aiTrackFor } from '../src/lib/sim/ai/ai-track';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(62)} ${detail}`);
}

const DT = 1 / 240;
const flat = new FlatGroundQuery(0);

console.log('1. FIA 2025 Regulations, Registry & Config Invariants');
{
  const cfg = LC25_CAR_CONFIG;
  const def = carById('lc25');
  const model = VEHICLE_MODELS.lc25;
  check('Registry entry is LC25 Prototype (2025, F1, own physics)', def.id === 'lc25' && def.year === 2025 && def.classId === 'f1' && def.quality === 'own', def.title);
  check('LC25 uses LibreCorsa procedural F1 liveries', carTakesLivery('lc25'));
  check('Overtaking rules for 2025 are rear-flap DRS', carOvertakingRules(def) === 'drs-rear', String(carOvertakingRules(def)));
  check('Model credit attributes shunqi CC BY 4.0', def.credit.author === 'shunqi' && def.credit.license === 'CC BY 4.0', `${def.credit.title} by ${def.credit.author}`);
  check('Dry mass is 800 kg (FIA 2025 Art. 4.1)', cfg.chassis.totalMassKg === 800, `${cfg.chassis.totalMassKg} kg`);
  check('Weight split inside 44.6%–46.1% front band (Art. 4.2)', cfg.chassis.frontWeightFraction >= 0.446 && cfg.chassis.frontWeightFraction <= 0.461, `${(cfg.chassis.frontWeightFraction * 100).toFixed(1)}%`);
  check('Wheelbase <= 3.600 m (Art. 3.4.2)', cfg.chassis.wheelbase > 3.5 && cfg.chassis.wheelbase <= 3.6, `${cfg.chassis.wheelbase.toFixed(4)} m`);
  check('ERS runs under f1-2025 rules (120 kW, 4 MJ / 2 MJ, MGU-H)', cfg.ers.regulations === 'f1-2025' && cfg.ers.ERS_MAX_DEPLOY === 120_000 && cfg.ers.deployPerLapJ === 4_000_000 && cfg.ers.harvestPerLapJ === 2_000_000 && !!cfg.ers.mguH);
  check('Standing-start MGU-K lockout at 100 km/h (Art. 5.3.2)', cfg.ers.standingStartLockoutKmh === 100);
  check('No plank-wear mechanic configured (plankPhysics absent)', cfg.aero.plankPhysics === undefined && cfg.aero.plank !== undefined);
  check('Slick tyre blanket temperature cap is 70 °C', cfg.tyreCompounds.PhysicsTyreCompound_F1_Soft!.pressureData.coldRefC === 70);
  check('Rear-only DRS: front wing has no flap, rear flap < 0.4 s', cfg.aero.wings.filter((w) => w.name === 'FRONT_WING').every((w) => !w.drs) && cfg.aero.wings.some((w) => w.name === 'REAR_WING' && !!w.drs) && cfg.aero.drsTransitionS < 0.4, `${cfg.aero.drsTransitionS} s`);
  const fuelLut = new Lut(LC25_FUEL_FLOW_CURVE_KGS);
  const q8000 = fuelLut.evaluate(8000) * 3600;
  const q10500 = fuelLut.evaluate(10500) * 3600;
  const q13000 = fuelLut.evaluate(13000) * 3600;
  check('Fuel flow follows Art. 5.2.3 (77.5 kg/h @ 8k, 100 @ >=10.5k)', Math.abs(q8000 - 77.5) < 0.2 && Math.abs(q10500 - 100) < 0.1 && Math.abs(q13000 - 100) < 0.1, `8k=${q8000.toFixed(1)}, 10.5k=${q10500.toFixed(1)}, 13k=${q13000.toFixed(1)} kg/h`);
  check('Sim defaults to rear-flap DRS out of the box', model.createSim(createFlatTestTrack(), null).overtakingRules === 'drs-rear');
}

console.log('\n2. 2025 ERS + MGU-H Physics Behaviour');
{
  // Standing-start 100 km/h lockout (with Semi-pro TC so rear tyres launch straight to 200+ km/h)
  const sim = createLc25Sim(createFlatTestTrack(4000, 100));
  sim.assistPreset = 'semi_pro';
  sim.autoGearbox = true;
  sim.resetToStartGrid(false);
  sim.vehicle.setPerformanceMode('PSH');
  let maxDeployBelow95 = 0;
  let maxDeployAbove120 = 0;
  let peakLaunchKmh = 0;
  for (let t = 0; t < 6.0; t += 1 / 120) {
    sim.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0 });
    const kmh = sim.telemetry.speedKmh;
    const kw = sim.telemetry.mgukPowerKw;
    peakLaunchKmh = Math.max(peakLaunchKmh, kmh);
    if (kmh < 95) maxDeployBelow95 = Math.max(maxDeployBelow95, kw);
    if (kmh > 120) maxDeployAbove120 = Math.max(maxDeployAbove120, kw);
  }
  check('Standing-start lockout: 0 kW MGU-K below 95 km/h', maxDeployBelow95 < 0.5, `max=${maxDeployBelow95.toFixed(2)} kW, vmax=${peakLaunchKmh.toFixed(0)} km/h`);
  check('MGU-K deploys cleanly once above 100 km/h', maxDeployAbove120 > 100, `peak=${maxDeployAbove120.toFixed(1)} kW`);

  // MGU-H anti-lag comparison: PSH (MGU-H active) vs CHR (MGU-H motoring off)
  const testLag = (mode: 'PSH' | 'CHR') => {
    const v = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
    v.reset(0, 0, 0, 50); // 180 km/h
    v.setPerformanceMode(mode);
    // Cruise at full throttle for 0.8 s to build full boost, then lift for 0.5 s, then snap to full throttle
    for (let t = 0; t < 0.8; t += DT) v.step(DT, { throttle: 1, brake: 0, steer: 0 });
    for (let t = 0; t < 0.5; t += DT) v.step(DT, { throttle: 0, brake: 0, steer: 0 });
    const boostAfterLift = v.turboBoostBar - 1;
    for (let t = 0; t < 0.16; t += DT) v.step(DT, { throttle: 1, brake: 0, steer: 0 });
    const boostAt160ms = v.turboBoostBar - 1;
    return { boostAfterLift, boostAt160ms };
  };
  const pshLag = testLag('PSH');
  const chrLag = testLag('CHR');
  check(
    'MGU-H anti-lag holds higher off-throttle boost than passive CHR',
    pshLag.boostAfterLift > chrLag.boostAfterLift + 0.5,
    `PSH=${pshLag.boostAfterLift.toFixed(2)} bar vs CHR=${chrLag.boostAfterLift.toFixed(2)} bar`
  );
  check(
    'MGU-H anti-lag recovers >2.1 bar within 160 ms of throttle snap',
    pshLag.boostAt160ms > 2.1 && pshLag.boostAt160ms > chrLag.boostAt160ms + 0.7,
    `PSH=${pshLag.boostAt160ms.toFixed(2)} bar vs CHR=${chrLag.boostAt160ms.toFixed(2)} bar`
  );

  // Direct MGU-H -> MGU-K bypass past the 4 MJ ES cap
  const bypass = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
  bypass.reset(0, 0, 0, 60);
  bypass.setPerformanceMode('PSH');
  let tailKwSum = 0;
  let tailN = 0;
  for (let i = 0; i < 90 / DT; i++) {
    bypass.step(DT, { throttle: 1, brake: 0, steer: 0 });
    if (i * DT > 80) {
      tailKwSum += bypass.telemetry.MGUK_POWER / 1000;
      tailN++;
    }
  }
  const tailKw = tailKwSum / Math.max(1, tailN);
  check(
    'ES -> MGU-K lap deploy stays <= 4.0 MJ while direct H -> K keeps deploying',
    bypass.lapDeployJ <= 4_010_000 && bypass.lapDirectDeployJ > 1_000_000 && tailKw > 60,
    `ES=${(bypass.lapDeployJ / 1e6).toFixed(2)} MJ, directH=${(bypass.lapDirectDeployJ / 1e6).toFixed(2)} MJ, tail=${tailKw.toFixed(1)} kW`
  );

  // Unlimited MGU-H -> ES harvest bypassing 2 MJ MGU-K cap
  const harvest = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
  harvest.reset(0, 0, 0, 70);
  harvest.ersEnergyJ = 200_000; // start nearly empty (5%)
  harvest.setPerformanceMode('CHR');
  for (let i = 0; i < 45 / DT; i++) {
    const phase = (i * DT) % 9;
    const brake = phase > 6.5 && harvest.speedMs > 28 ? 0.85 : 0;
    const throttle = brake > 0 ? 0 : 1;
    harvest.step(DT, { throttle, brake, steer: 0 });
  }
  check(
    'MGU-K -> ES capped <= 2.0 MJ while MGU-H charges ES past 2.0 MJ',
    harvest.lapHarvestJ <= 2_010_000 && harvest.lapMguHHarvestJ > 1_000_000 && harvest.ersEnergyJ > 2_500_000,
    `K->ES=${(harvest.lapHarvestJ / 1e6).toFixed(2)} MJ, H=${(harvest.lapMguHHarvestJ / 1e6).toFixed(2)} MJ, ES=${(harvest.ersEnergyJ / 1e6).toFixed(2)} MJ`
  );
}

console.log('\n3. Rest Stability, Rear-Only DRS, Braking & Cornering Envelope');
{
  // Rest stability
  const rest = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
  rest.reset(0, 0, 0, 0);
  for (let t = 0; t < 5.0; t += DT) rest.step(DT, { throttle: 0, brake: 0.5, steer: 0 });
  check('Rest stability: speed < 0.05 m/s after 5 s', rest.speedMs < 0.05, `${rest.speedMs.toFixed(4)} m/s`);
  check(
    'Rest ride heights match 34 / 58 mm within ±3 mm',
    Math.abs(rest.telemetry.aeroHeightFront * 1000 - 34) < 3 && Math.abs(rest.telemetry.aeroHeightRear * 1000 - 58) < 3,
    `F=${(rest.telemetry.aeroHeightFront * 1000).toFixed(1)} mm, R=${(rest.telemetry.aeroHeightRear * 1000).toFixed(1)} mm`
  );

  // Rear-only DRS speed delta on a 900 m straight from 150 km/h (Austria T1 -> T3 style)
  const straightRun = (openDrs: boolean) => {
    const v = new VehiclePhysics({
      ground: flat,
      config: LC25_CAR_CONFIG,
      drsZones: [{ id: 'Z0', detection: 0.01, start: 0.02, end: 0.99 }],
      locateProgress: () => 0.5,
      lapLengthM: 5000,
    });
    v.drsFitted = true;
    v.drsFlaps = 'rear';
    v.drsGatedByDetection = false;
    v.reset(0, 0, 0, 150 / 3.6);
    v.setPerformanceMode('PSH');
    const z0 = v.position.z;
    for (let t = 0; t < 15 && v.position.z - z0 < 900; t += DT) {
      v.step(DT, { throttle: 1, brake: 0, steer: 0, drs: openDrs && !v.drsOpen && t > 0.1 });
    }
    return { kmh: v.telemetry.speedKmh, cdA: v.telemetry.dragN / Math.max(1, 0.5 * 1.225 * v.speedMs * v.speedMs) };
  };
  const closed = straightRun(false);
  const open = straightRun(true);
  const drsGain = open.kmh - closed.kmh;
  check(
    'Rear-only DRS lowers CD·A by 0.20–0.30 m² and adds +10..+24 km/h over 900 m',
    closed.cdA - open.cdA >= 0.20 && closed.cdA - open.cdA <= 0.32 && drsGain >= 10 && drsGain <= 24,
    `closed=${closed.kmh.toFixed(1)} km/h (CD·A=${closed.cdA.toFixed(3)}), open=${open.kmh.toFixed(1)} km/h (CD·A=${open.cdA.toFixed(3)}), +${drsGain.toFixed(1)} km/h`
  );

  // Braking 300 -> 80 km/h with threshold ABS on warm carbon discs
  const brkSim = createLc25Sim(createFlatTestTrack(4000, 100));
  brkSim.assistPreset = 'semi_pro';
  brkSim.autoGearbox = true;
  brkSim.teleportToDistance(500, 300 / 3.6, 0);
  for (const w of brkSim.vehicle.wheels) w.brakeDisc.surfaceTempC = 600;
  let peakDecelG = 0;
  const sStart = brkSim.sMeters;
  for (let t = 0; t < 6; t += 1 / 120) {
    brkSim.step(1 / 120, { throttle: 0, brake: 1, analogSteer: 0 });
    peakDecelG = Math.max(peakDecelG, -brkSim.vehicle.telemetry.lonG);
    if (brkSim.telemetry.speedKmh <= 80) break;
  }
  const stopDistM = brkSim.sMeters - sStart;
  check(
    'Braking 300 -> 80 km/h hits 5.3–7.0 g peak within 65–95 m',
    peakDecelG >= 5.3 && peakDecelG <= 7.0 && stopDistM >= 65 && stopDistM <= 95,
    `peak=${peakDecelG.toFixed(2)} g, dist=${stopDistM.toFixed(1)} m`
  );

  // Cornering g & compound ladder at 200 km/h
  const peakLatG = (compound: 'PhysicsTyreCompound_F1_Soft' | 'PhysicsTyreCompound_F1_Medium' | 'PhysicsTyreCompound_F1_Hard', kmh: number) => {
    const v = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG, compound });
    const target = kmh / 3.6;
    v.reset(0, 0, 0, target);
    const prev = v.velocity.clone();
    const win: number[] = [];
    let best = 0;
    for (let t = 0; t < 11; t += 1 / 120) {
      const err = target - v.speedMs;
      const steer = Math.min(1, t / 9);
      v.step(1 / 120, { throttle: THREE.MathUtils.clamp(0.4 + err * 0.4, 0, 1), brake: THREE.MathUtils.clamp(-err * 0.2, 0, 1), steer });
      const a = v.velocity.clone().sub(prev).divideScalar(1 / 120);
      const left = new THREE.Vector3(1, 0, 0).applyQuaternion(v.quaternion);
      prev.copy(v.velocity);
      win.push(Math.abs(a.dot(left)) / 9.81);
      if (win.length > 30) win.shift();
      if (win.length === 30 && Math.abs(v.speedMs - target) < 0.06 * target) {
        best = Math.max(best, win.reduce((s, x) => s + x, 0) / 30);
      }
    }
    return best;
  };
  const gSoft240 = peakLatG('PhysicsTyreCompound_F1_Soft', 240);
  const gMed240 = peakLatG('PhysicsTyreCompound_F1_Medium', 240);
  const gHard240 = peakLatG('PhysicsTyreCompound_F1_Hard', 240);
  check(
    'High-speed cornering at 240 km/h reaches 4.3–5.4 g on Softs',
    gSoft240 >= 4.3 && gSoft240 <= 5.4,
    `Soft=${gSoft240.toFixed(2)} g, Med=${gMed240.toFixed(2)} g, Hard=${gHard240.toFixed(2)} g`
  );
  check('Compound hierarchy: Soft > Medium > Hard', gSoft240 > gMed240 && gMed240 > gHard240);
}

console.log('\n4. AI Flying Laps & 2025 OpenF1 Circuit Benchmarks');
{
  const runCircuit = (label: string, track: BuiltTrackData, minS: number, maxS: number) => {
    const ai = aiTrackFor(track);
    const offsets = new Float64Array(ai.n);
    for (let i = 0; i < ai.n; i++) offsets[i] = aiLineOffsetM(track.getSampleAtDistance(i * ai.ds), 'f1');
    const lap = physicsLap(track, null, 'lc25', offsets, 0.96, 260);
    let maxV = 0;
    for (let i = 0; i < lap.v.length; i++) if (Number.isFinite(lap.v[i])) maxV = Math.max(maxV, lap.v[i] * 3.6);
    check(
      `${label}: clean AI flying lap (${minS}–${maxS} s, 0 wall hits)`,
      Number.isFinite(lap.lapS) && lap.lapS >= minS && lap.lapS <= maxS && lap.wallHits === 0,
      `lap=${lap.lapS.toFixed(3)} s, vmax=${maxV.toFixed(1)} km/h, wallHits=${lap.wallHits}, offTrack=${lap.offTrackFrames}`
    );
  };

  // Always available in repo: RISE Motordrome
  runCircuit('RISE Motordrome (repo)', getActiveTrackData(), 82, 115);

  // Locally available hosted tracks (Spielberg & Monaco 2025 OpenF1 benchmarks)
  const loadHostedTrack = (id: string): BuiltTrackData | null => {
    const candidates = [
      path.join('public', 'tracks', id, 'track_data.json'),
      path.join('/Users/alpyalay/Documents/GitHub/librecorsa/public/tracks', id, 'track_data.json'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as RawTrackJson;
        setActiveTrack(id, raw);
        return getActiveTrackData(1200);
      }
    }
    return null;
  };
  const spielberg = loadHostedTrack('spielberg');
  if (spielberg) {
    // Norris 2025 Austria Q pole: 63.971 s (with AI at 0.96 grip scale and race fuel, ~62–68 s expected)
    runCircuit('Spielberg Austria (2025 pole 63.971 s)', spielberg, 61.0, 68.5);
  } else {
    console.log('  SKIP  Spielberg benchmark (hosted track_data.json not present locally)');
  }
  const monaco = loadHostedTrack('monaco');
  if (monaco) {
    // Norris 2025 Monaco Q pole: 69.954 s (with AI at 0.96 grip scale, ~68–76 s expected)
    runCircuit('Monaco GP (2025 pole 69.954 s)', monaco, 68.0, 77.0);
  } else {
    console.log('  SKIP  Monaco benchmark (hosted track_data.json not present locally)');
  }
}

console.log('\n5. 3D Model Rig & Compression Invariants (public/cars/lc25/model/lc25.glb)');
{
  const glbPath = path.join('public', 'cars', 'lc25', 'model', 'lc25.glb');
  check('lc25.glb exists and is <= 2.5 MB', existsSync(glbPath) && statSync(glbPath).size <= 2.5 * 1024 * 1024, `${(statSync(glbPath).size / (1024 * 1024)).toFixed(2)} MB`);
  const buf = readFileSync(glbPath);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
    nodes: { name?: string; mesh?: number; extras?: Record<string, unknown> }[];
    meshes: { primitives: unknown[] }[];
    materials: { name?: string; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
    images?: unknown[];
  };
  const nodeNames = new Set(json.nodes.map((n) => n.name));
  const matNames = new Set(json.materials.map((m) => m.name));
  const exteriorTextured = json.materials.filter((m) => m.name?.startsWith('EXT_') && !!m.pbrMetallicRoughness?.baseColorTexture);
  const root = json.nodes.find((n) => n.name === 'LC26');
  const wc = (root?.extras?.wheelCentres ?? {}) as Record<string, number[]>;
  const glbWheelbase = wc.WHEEL_LF && wc.WHEEL_LR ? wc.WHEEL_LF[2] - wc.WHEEL_LR[2] : NaN;
  const drsNode = json.nodes.find((n) => n.name === 'WING_REAR_DRS');
  const tyreNodesOk = ['WHEEL_LF_TYRE', 'WHEEL_RF_TYRE', 'WHEEL_LR_TYRE', 'WHEEL_RR_TYRE'].every((name) => {
    const n = json.nodes.find((x) => x.name === name);
    return n?.mesh !== undefined && json.meshes[n.mesh].primitives.length === 1;
  });
  check('Required F1 rig nodes present (LC26, BODY, STEER_BASE, WING_REAR_DRS)', ['LC26', 'BODY', 'STEER_BASE', 'WING_REAR_DRS', 'WHEEL_LF', 'WHEEL_RF', 'WHEEL_LR', 'WHEEL_RR'].every((n) => nodeNames.has(n)));
  check('All 4 tyres are single-primitive meshes for tyre-wrap shader', tyreNodesOk);
  check('Rear DRS flap carries aeroClosed & aeroOpen poses', Array.isArray(drsNode?.extras?.aeroClosed) && Array.isArray(drsNode?.extras?.aeroOpen));
  check('No front active-aero flaps on 2025 body', !json.nodes.some((n) => n.name?.includes('WING_FRONT') && n.extras?.aeroOpen));
  check(
    'Livery paint zones & carbon present, zero exterior sponsor textures',
    ['EXT_PAINT_PRIMARY', 'EXT_PAINT_SECONDARY', 'EXT_PAINT_ACCENT', 'EXT_carbon', 'EXT_RIM', 'EXT_TYRE'].every((m) => matNames.has(m)) && exteriorTextured.length === 0,
    `extTextured=${exteriorTextured.length}, totalImages=${json.images?.length ?? 0}`
  );
  check('GLB wheelbase matches LC25_CAR_CONFIG within 1 mm', Math.abs(glbWheelbase - LC25_CAR_CONFIG.chassis.wheelbase) < 0.001, `glb=${glbWheelbase.toFixed(4)} m vs cfg=${LC25_CAR_CONFIG.chassis.wheelbase.toFixed(4)} m`);
}

console.log(`\nLC25 verification: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
