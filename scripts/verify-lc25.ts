/**
 * End-to-end verification suite for the 2025 Formula 1 LC25 Prototype:
 *  1. FIA 2025 regulatory invariants (800 kg, 44.6-46.1% split, 120 kW / 200 Nm MGU-K, MGU-H, 70 °C blankets, no plank wear)
 *  2. 2025 ERS + MGU-H physics (100 km/h launch lockout, MGU-H anti-lag, direct H->K bypass past 4 MJ, H->ES past 2 MJ)
 *  3. Rest stability, gearbox shift plateau, 3-phase diff, rear-only DRS, aero packages, braking, ride heights, FFB headroom & cornering stability
 *  4. Multi-lap thermal/brake/pressure/wear balance & Nuzzi rain-tyre water-clearing + thermal windows
 *  5. AI flying laps on RISE Motordrome (repo) + 2025 OpenF1 Spielberg / Monaco telemetry checks (when track files exist locally)
 *  6. 3D model (`public/cars/lc25/model/lc25.glb`) rig, DRS hinge, tyre, steering wheel and size invariants
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
import { carLimitsFor } from '../src/lib/sim/ai/ggv';
import { makeDrivePlan } from '../src/lib/sim/ai/drive-plan';
import { stepSteer, steadyRamp } from './lib/handling-tests';

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
  const flap = cfg.aero.rhMap?.activeAero;
  check('Rear-only DRS: front wing has no flap, rear flap < 0.4 s', !!flap && flap.dClAFront === 0 && flap.dClARear < 0 && flap.dCdA < 0 && cfg.aero.wings.every((w) => !w.drs) && cfg.aero.drsTransitionS < 0.4, `${cfg.aero.drsTransitionS} s`);
  const fuelLut = new Lut(LC25_FUEL_FLOW_CURVE_KGS);
  const q8000 = fuelLut.evaluate(8000) * 3600;
  const q10500 = fuelLut.evaluate(10500) * 3600;
  const q13000 = fuelLut.evaluate(13000) * 3600;
  check('Fuel flow follows Art. 5.2.3 (77.5 kg/h @ 8k, 100 @ >=10.5k)', Math.abs(q8000 - 77.5) < 0.2 && Math.abs(q10500 - 100) < 0.1 && Math.abs(q13000 - 100) < 0.1, `8k=${q8000.toFixed(1)}, 10.5k=${q10500.toFixed(1)}, 13k=${q13000.toFixed(1)} kg/h`);
  check('3-phase active electronic differential & aero cooling configured', cfg.differential.threePhase === true && !!cfg.aero.cooling && cfg.brakes.discThicknessMm?.front === 32 && cfg.brakes.discThicknessMm?.rear === 28);
  const softC = cfg.tyreCompounds.PhysicsTyreCompound_F1_Soft!;
  const medC = cfg.tyreCompounds.PhysicsTyreCompound_F1_Medium!;
  const hardC = cfg.tyreCompounds.PhysicsTyreCompound_F1_Hard!;
  const interC = cfg.tyreCompounds.PhysicsTyreCompound_F1_Intermediate!;
  const wetC = cfg.tyreCompounds.PhysicsTyreCompound_F1_Wet!;
  const lastKm = (c: typeof softC) => c.wear!.curve[c.wear!.curve.length - 1][0];
  check(
    'Compound wear & flat-spot softness ladder: Soft < Med < Hard life',
    lastKm(softC) < lastKm(medC) && lastKm(medC) < lastKm(hardC) && (softC.flatSpotSoftness ?? 0) > (medC.flatSpotSoftness ?? 0) && (medC.flatSpotSoftness ?? 0) > (hardC.flatSpotSoftness ?? 0),
    `wearKm=${lastKm(softC)}/${lastKm(medC)}/${lastKm(hardC)}, flatSpot=${softC.flatSpotSoftness}/${medC.flatSpotSoftness}/${hardC.flatSpotSoftness}`
  );
  check(
    'Nuzzi rain-tyre water clearing configured (Wet 4.14 mm >> Inter 1.30 mm)',
    (interC.wetTraits?.clearMm ?? 0) >= 1.25 && (wetC.wetTraits?.clearMm ?? 0) >= 4.0 && (wetC.wetTraits?.treadDepthMm ?? 0) >= 6.0,
    `Inter=${interC.wetTraits?.clearMm}mm/${interC.wetTraits?.treadDepthMm}mm, Wet=${wetC.wetTraits?.clearMm}mm/${wetC.wetTraits?.treadDepthMm}mm`
  );
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
  // The 75 kW MGU-H covers about 70 kW of the 120: the store reaches its 4 MJ a lap within the 90 s, then the MGU-K
  // derates to what the MGU-H feeds it, as the 2014–2025 cars did at the end of the longest straights
  check(
    'ES -> MGU-K lap deploy reaches its 4.0 MJ, then direct H -> K alone deploys 55–75 kW',
    bypass.lapDeployJ >= 3_900_000 && bypass.lapDeployJ <= 4_010_000 && bypass.lapDirectDeployJ > 1_000_000 && tailKw > 55 && tailKw < 75,
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
    'Rest ride heights match 39 / 62 mm within ±3 mm',
    Math.abs(rest.telemetry.aeroHeightFront * 1000 - 39) < 3 && Math.abs(rest.telemetry.aeroHeightRear * 1000 - 62) < 3,
    `F=${(rest.telemetry.aeroHeightFront * 1000).toFixed(1)} mm, R=${(rest.telemetry.aeroHeightRear * 1000).toFixed(1)} mm`
  );

  // Standing-start stability with TC off (Pro preset): hooks cleanly without instant rear spinout
  const launchSim = createLc25Sim(createFlatTestTrack(4000, 100));
  launchSim.assistPreset = 'pro';
  launchSim.autoGearbox = true;
  launchSim.teleportToDistance(500, 0, 0);
  let launchT100 = 0;
  let launchT200 = 0;
  let launchMaxBeta = 0;
  let launchMaxSlip = 0;
  for (let i = 1; i <= 960; i++) {
    launchSim.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0 });
    const sec = i / 120;
    const kmh = launchSim.telemetry.speedKmh;
    if (!launchT100 && kmh >= 100) launchT100 = sec;
    if (!launchT200 && kmh >= 200) {
      launchT200 = sec;
      break;
    }
    if (sec < 3.5) {
      const beta = Math.abs((Math.atan2(launchSim.vyMs, Math.max(1, Math.abs(launchSim.vxMs))) * 180) / Math.PI);
      launchMaxBeta = Math.max(launchMaxBeta, beta);
      launchMaxSlip = Math.max(
        launchMaxSlip,
        Math.abs(launchSim.telemetry.wheelSlipRatios[2]),
        Math.abs(launchSim.telemetry.wheelSlipRatios[3])
      );
    }
  }
  check(
    'Standing start (TC off): 0–100 in 2.4–3.1 s, 0–200 in 4.6–5.6 s, < 3° beta',
    launchT100 >= 2.4 && launchT100 <= 3.1 && launchT200 >= 4.6 && launchT200 <= 5.6 && launchMaxBeta < 3.0 && launchMaxSlip < 0.35,
    `0-100=${launchT100.toFixed(2)} s, 0-200=${launchT200.toFixed(2)} s, maxSlip=${(launchMaxSlip * 100).toFixed(0)}%, maxBeta=${launchMaxBeta.toFixed(1)}°`
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
  let brkMinFrontRhMm = 999;
  const sStart = brkSim.sMeters;
  for (let t = 0; t < 6; t += 1 / 120) {
    brkSim.step(1 / 120, { throttle: 0, brake: 1, analogSteer: 0 });
    peakDecelG = Math.max(peakDecelG, -brkSim.vehicle.telemetry.lonG);
    brkMinFrontRhMm = Math.min(brkMinFrontRhMm, brkSim.vehicle.telemetry.aeroHeightFront * 1000);
    if (brkSim.telemetry.speedKmh <= 80) break;
  }
  const stopDistM = brkSim.sMeters - sStart;
  check(
    'Braking 300 -> 80 km/h hits 5.4–7.0 g within 65–90 m and holds >= 8 mm front RH',
    peakDecelG >= 5.4 && peakDecelG <= 7.0 && stopDistM >= 65 && stopDistM <= 90 && brkMinFrontRhMm >= 8.0,
    `peak=${peakDecelG.toFixed(2)} g, dist=${stopDistM.toFixed(1)} m, minFrontRH=${brkMinFrontRhMm.toFixed(1)} mm`
  );

  // Season-locked OpenF1 gear shifts land on the 10,500 rpm FIA fuel-flow plateau (G4->G5..G7->G8)
  const shiftSim = createLc25Sim(createFlatTestTrack(5000, 100));
  shiftSim.assistPreset = 'semi_pro';
  shiftSim.autoGearbox = true;
  shiftSim.teleportToDistance(500, 120 / 3.6, 0);
  shiftSim.vehicle.setPerformanceMode('PSH');
  let pGear = shiftSim.vehicle.gear;
  const landedRpms: number[] = [];
  for (let t = 0; t < 16; t += 1 / 120) {
    shiftSim.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0 });
    if (shiftSim.vehicle.gear > pGear) {
      const fromG = pGear;
      for (let k = 0; k < 3; k++) shiftSim.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0 });
      if (fromG >= 4 && fromG <= 7) landedRpms.push(Math.round(shiftSim.vehicle.rpm));
    }
    pGear = shiftSim.vehicle.gear;
  }
  check(
    'OpenF1 gearbox G4->G8 upshifts land on 10,500 rpm fuel-flow plateau (10.1–11.1k)',
    landedRpms.length >= 4 && landedRpms.every((r) => r >= 10_100 && r <= 11_100),
    `landed=${landedRpms.join('/')} rpm`
  );

  // 3-phase active electronic differential phase transitions + dynamic ride height at 320 km/h
  const rhVeh = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
  rhVeh.reset(0, 0, 0, 320 / 3.6);
  for (let t = 0; t < 1.2; t += DT) {
    const err = 320 / 3.6 - rhVeh.speedMs;
    rhVeh.step(DT, { throttle: THREE.MathUtils.clamp(0.5 + err * 0.5, 0, 1), brake: 0, steer: 0 });
  }
  const fRh320 = rhVeh.telemetry.aeroHeightFront * 1000;
  const rRh320 = rhVeh.telemetry.aeroHeightRear * 1000;
  const bal320 = rhVeh.telemetry.AERO_BALANCE;
  check(
    '320 km/h aero platform holds >= 10/24 mm RH and 44–48% front balance',
    fRh320 >= 10 && rRh320 >= 24 && bal320 >= 44 && bal320 <= 48,
    `RH=${fRh320.toFixed(1)}/${rRh320.toFixed(1)} mm, bal=${bal320.toFixed(1)}%`
  );
  rhVeh.reset(0, 0, 0, 180 / 3.6);
  rhVeh.step(DT, { throttle: 0, brake: 0.7, steer: 0.1 });
  const pEntry = rhVeh.diffActivePhase;
  rhVeh.step(DT, { throttle: 0.02, brake: 0, steer: 0.25 });
  const pMid = rhVeh.diffActivePhase;
  rhVeh.step(DT, { throttle: 0.85, brake: 0, steer: 0.15 });
  const pExit = rhVeh.diffActivePhase;
  check('3-phase active diff transitions ENTRY -> MID -> EXIT', pEntry === 'ENTRY' && pMid === 'MID' && pExit === 'EXIT', `${pEntry}->${pMid}->${pExit}`);

  // Monza low-downforce DRS top speed (>= 345 km/h over 1300 m) & Monaco high-downforce CL·A (>= 6.75)
  const runPkg = (pkg: 'low_downforce' | 'high_downforce', openDrs: boolean, distM: number) => {
    const s = createLc25Sim(createFlatTestTrack(5000, 100));
    s.aeroPreset = pkg;
    s.assistPreset = 'semi_pro';
    s.autoGearbox = true;
    s.vehicle.drsFitted = true;
    s.vehicle.drsFlaps = 'rear';
    s.vehicle.drsGatedByDetection = false;
    s.teleportToDistance(500, 100 / 3.6, 0);
    s.setLiveTuner({ ersMode: 'PSH' });
    const s0 = s.sMeters;
    for (let t = 0; t < 24 && s.sMeters - s0 < distM; t += 1 / 120) {
      s.step(1 / 120, { throttle: 1, brake: 0, analogSteer: 0, toggleXMode: openDrs && !s.vehicle.drsOpen && t > 0.1 });
    }
    const q = Math.max(1, 0.5 * 1.225 * s.vehicle.speedMs * s.vehicle.speedMs);
    return { kmh: s.telemetry.speedKmh, clA: s.vehicle.telemetry.downforceN / q, cdA: s.vehicle.telemetry.dragN / q };
  };
  const monzaDrs = runPkg('low_downforce', true, 1300);
  const monacoClosed = runPkg('high_downforce', false, 750);
  check(
    'Aero trims: Monza low-DF DRS >= 345 km/h & Monaco high-DF CL·A >= 6.75',
    monzaDrs.kmh >= 345 && monacoClosed.clA >= 6.75 && monacoClosed.cdA >= 1.5,
    `MonzaDRS=${monzaDrs.kmh.toFixed(1)} km/h, Monaco CL·A=${monacoClosed.clA.toFixed(2)} CD·A=${monacoClosed.cdA.toFixed(3)}`
  );

  // FFB rack torque headroom: parked weight in range & zero clipping up to 270 km/h
  const parked = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG, airDensity: 1.06 });
  parked.reset(0, 0, 0, 0);
  for (let t = 0; t < 0.5; t += 1 / 120) { parked.step(1 / 120, { throttle: 0, brake: 1, steer: 0 }); parked.takeFfbSubframeSamples(); }
  for (let k = 1; k <= 60; k++) parked.step(1 / 120, { throttle: 0, brake: 1, steer: (0.3 * k) / 60 });
  parked.takeFfbSubframeSamples();
  const held: number[] = [];
  for (let k = 0; k < 60; k++) { parked.step(1 / 120, { throttle: 0, brake: 1, steer: 0.3 }); held.push(...parked.takeFfbSubframeSamples()); }
  const parkedMean = held.reduce((a, b) => a + b, 0) / held.length;
  const ffbPeaks: number[] = [];
  for (const [kmh, maxSteer] of [[90, 0.65], [160, 0.36], [220, 0.24], [270, 0.16]] as const) {
    const fv = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG });
    const tgt = kmh / 3.6;
    fv.reset(0, 0, 0, tgt);
    let pk = 0;
    for (let t = 0; t < 6; t += 1 / 120) {
      const err = tgt - fv.speedMs;
      fv.step(1 / 120, { throttle: THREE.MathUtils.clamp(0.45 + err * 0.4, 0, 1), brake: THREE.MathUtils.clamp(-err * 0.2, 0, 1), steer: Math.min(maxSteer, (t / 5) * maxSteer) });
      if (t > 1) pk = Math.max(pk, Math.abs(fv.takeFfbAverage()));
    }
    ffbPeaks.push(pk);
  }
  check(
    'FFB headroom: parked in -0.45..-0.75, zero clipping (<0.96) 90–270 km/h',
    parkedMean < -0.45 && parkedMean > -0.75 && ffbPeaks[0] >= 0.3 && ffbPeaks.every((p) => p < 0.96),
    `parked=${parkedMean.toFixed(2)}, 90/160/220/270=${ffbPeaks.map((p) => p.toFixed(2)).join('/')}`
  );

  // High-speed transient stability (step steer at 220 & 270 km/h at 70% lateral limit)
  const pad = createFlatTestTrack(40_000, 3000);
  const hsResults = [220, 270].map((kmh) => {
    const r = steadyRamp(() => createLc25Sim(pad), kmh / 3.6, 8, 0.45);
    const pt = r.curve.find(([, g]) => g >= r.maxG * 0.7) ?? r.curve[r.curve.length - 1];
    const st = stepSteer(() => createLc25Sim(pad), kmh / 3.6, pt[0]);
    return { kmh, maxG: r.maxG, ovs: st.overshootPct, spun: st.spun };
  });
  check(
    'High-speed step-steer stability (220 & 270 km/h @ 70%): no spin, <30% overshoot',
    hsResults.every((x) => !x.spun && x.ovs < 30),
    hsResults.map((x) => `${x.kmh}:${x.maxG.toFixed(2)}g/${x.ovs.toFixed(0)}%`).join(', ')
  );

  // Cornering g & compound ladder at 240 km/h
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

console.log('\n4. Multi-Lap Thermal/Brake/Pressure Balance & Nuzzi Rain Tyres');
{
  // Multi-lap full-pace RISE Motordrome stint: tyre core window, rear brake disc band, hot pressures, wear, zero blistering
  const rise = getActiveTrackData(1200);
  const ai = aiTrackFor(rise);
  const offsets = new Float64Array(ai.n);
  for (let i = 0; i < ai.n; i++) offsets[i] = aiLineOffsetM(rise.getSampleAtDistance(i * ai.ds), 'f1');
  const plan = makeDrivePlan(ai, offsets, carLimitsFor('lc25', 0.96));
  const stint = createLc25Sim(rise);
  stint.assistPreset = 'pro';
  stint.tireCompound = 'soft';
  stint.resetToStartGrid(true);
  stint.aiAutopilot = true;
  stint.aiPaceScale = 1.0;
  stint.aiPlan = plan;
  let lap = 0, prevS = stint.sMeters, minRh = 999, wearLap3 = 0, wearPrev = 0, maxBlister = 0;
  let sumCoreF = 0, sumCoreR = 0, sumDiscF = 0, sumDiscR = 0, sumPsiF = 0, sumPsiR = 0, samples = 0;
  for (let t = 0; t < 420 && lap < 4; t += 1 / 120) {
    stint.step(1 / 120, { throttle: 0, brake: 0 });
    if (lap >= 1) minRh = Math.min(minRh, stint.vehicle.telemetry.aeroHeightFront * 1000);
    if (lap === 3) {
      const w = stint.vehicle.wheels;
      sumCoreF += (w[0].coreTempC + w[1].coreTempC) / 2;
      sumCoreR += (w[2].coreTempC + w[3].coreTempC) / 2;
      sumDiscF += (w[0].brakeDisc.surfaceTempC + w[1].brakeDisc.surfaceTempC) / 2;
      sumDiscR += (w[2].brakeDisc.surfaceTempC + w[3].brakeDisc.surfaceTempC) / 2;
      sumPsiF += (w[0].pressurePsi + w[1].pressurePsi) / 2;
      sumPsiR += (w[2].pressurePsi + w[3].pressurePsi) / 2;
      for (const wh of w) maxBlister = Math.max(maxBlister, wh.blisterLevel);
      samples++;
    }
    if (stint.sMeters < prevS - rise.totalLengthM / 2) {
      const meanWear = stint.vehicle.wheels.reduce((a, w) => a + w.wear, 0) / 4;
      if (lap === 3) wearLap3 = (meanWear - wearPrev) * 100;
      wearPrev = meanWear;
      lap++;
    }
    prevS = stint.sMeters;
  }
  const coreF = sumCoreF / Math.max(1, samples);
  const coreR = sumCoreR / Math.max(1, samples);
  const discF = sumDiscF / Math.max(1, samples);
  const discR = sumDiscR / Math.max(1, samples);
  const psiF = sumPsiF / Math.max(1, samples);
  const psiR = sumPsiR / Math.max(1, samples);
  check(
    '3-lap RISE stint: tyre core in 82–104 °C, 0 blistering, realistic Soft wear',
    coreF >= 82 && coreF <= 104 && coreR >= 82 && coreR <= 104 && maxBlister < 0.05 && wearLap3 >= 2.5 && wearLap3 <= 5.5 && minRh >= 6.0,
    `core=${coreF.toFixed(1)}/${coreR.toFixed(1)}°C, bls=${maxBlister.toFixed(2)}, wear=${wearLap3.toFixed(2)}%/lap, minRH=${minRh.toFixed(1)}mm`
  );
  check(
    '3-lap RISE stint: carbon discs 420–680 °C & hot pressures within ±1.5 psi of 23.5/21.0',
    discF >= 420 && discF <= 680 && discR >= 420 && discR <= 680 && Math.abs(psiF - 23.5) <= 1.5 && Math.abs(psiR - 21.0) <= 1.5,
    `disc=${discF.toFixed(0)}/${discR.toFixed(0)}°C, P=${psiF.toFixed(2)}/${psiR.toFixed(2)} psi`
  );

  // Nuzzi rain-tyre flat-pad water clearing hierarchy @ 220 km/h
  const wetPadG = (compound: 'PhysicsTyreCompound_F1_Soft' | 'PhysicsTyreCompound_F1_Intermediate' | 'PhysicsTyreCompound_F1_Wet', waterMm: number) => {
    const v = new VehiclePhysics({ ground: flat, config: LC25_CAR_CONFIG, compound });
    v.waterMm = waterMm;
    v.wheelWaterMm.fill(waterMm);
    v.wetness = waterMm > 0 ? 1 : 0;
    const tgt = 220 / 3.6;
    v.reset(0, 0, 0, tgt);
    const win: number[] = [];
    let best = 0;
    for (let t = 0; t < 7; t += 1 / 120) {
      const err = tgt - v.speedMs;
      v.step(1 / 120, { throttle: THREE.MathUtils.clamp(0.4 + err * 0.4, 0, 1), brake: THREE.MathUtils.clamp(-err * 0.2, 0, 1), steer: Math.min(0.6, t / 6) });
      win.push(Math.abs(v.telemetry.latG));
      if (win.length > 30) win.shift();
      if (win.length === 30 && Math.abs(v.speedMs - tgt) < 0.08 * tgt) best = Math.max(best, win.reduce((a, b) => a + b, 0) / 30);
    }
    return best;
  };
  const gDryS = wetPadG('PhysicsTyreCompound_F1_Soft', 0);
  const gDryI = wetPadG('PhysicsTyreCompound_F1_Intermediate', 0);
  const gDryW = wetPadG('PhysicsTyreCompound_F1_Wet', 0);
  const gWet6S = wetPadG('PhysicsTyreCompound_F1_Soft', 0.6);
  const gWet6I = wetPadG('PhysicsTyreCompound_F1_Intermediate', 0.6);
  const gWet6W = wetPadG('PhysicsTyreCompound_F1_Wet', 0.6);
  const gFldI = wetPadG('PhysicsTyreCompound_F1_Intermediate', 2.4);
  const gFldW = wetPadG('PhysicsTyreCompound_F1_Wet', 2.4);
  check(
    'Nuzzi rain water-clearing @ 220 km/h: Dry S>I>W, 0.6 mm I>W>>S, 2.4 mm W>>I',
    gDryS > gDryI && gDryI > gDryW && gWet6I > gWet6W && gWet6W > gWet6S + 1.5 && gFldW > gFldI + 1.5,
    `0mm=${gDryS.toFixed(2)}/${gDryI.toFixed(2)}/${gDryW.toFixed(2)}g, 0.6mm=${gWet6S.toFixed(2)}/${gWet6I.toFixed(2)}/${gWet6W.toFixed(2)}g, 2.4mm=${gFldI.toFixed(2)}/${gFldW.toFixed(2)}g`
  );

  // Nuzzi rain-tyre thermal split: Inter overheats on dry tarmac vs cools into 70–82 °C window on wet; Wet holds window in flood
  const rainStintTemp = (cmp: 'intermediate' | 'wet', waterMm: number) => {
    const s = createLc25Sim(rise);
    s.assistPreset = 'pro';
    s.tireCompound = cmp;
    s.setWeatherSample({ waterMm, wetness: waterMm > 0 ? 1 : 0, ambientC: 20 } as never);
    s.resetToStartGrid(true);
    s.aiAutopilot = true;
    s.aiPaceScale = 1.0;
    let lapCount = 0, ps = s.sMeters, sumSurf = 0, sumCore = 0, cnt = 0;
    for (let t = 0; t < 400 && lapCount < 3; t += 1 / 120) {
      s.step(1 / 120, { throttle: 0, brake: 0 });
      if (lapCount === 2) {
        sumSurf += s.vehicle.wheels.reduce((a, w) => a + w.surfaceTempC, 0) / 4;
        sumCore += s.vehicle.wheels.reduce((a, w) => a + w.coreTempC, 0) / 4;
        cnt++;
      }
      if (s.sMeters < ps - rise.totalLengthM / 2) lapCount++;
      ps = s.sMeters;
    }
    return { lapCount, surf: sumSurf / Math.max(1, cnt), core: sumCore / Math.max(1, cnt) };
  };
  const interDry = rainStintTemp('intermediate', 0);
  const interWet = rainStintTemp('intermediate', 0.7);
  const wetFlood = rainStintTemp('wet', 2.2);
  check(
    'Nuzzi rain thermals: Inter cooks dry (>95 °C surf) vs wet window, Wet holds 65–85 °C in 2.2 mm flood',
    interDry.surf > 95 && interDry.surf > interWet.surf + 20 && interWet.core >= 65 && interWet.core <= 85 && wetFlood.lapCount >= 3 && wetFlood.core >= 65 && wetFlood.core <= 85,
    `InterDry=${interDry.surf.toFixed(0)}°C surf, InterWet=${interWet.core.toFixed(0)}°C core, WetFlood=${wetFlood.core.toFixed(0)}°C core`
  );
}

console.log('\n5. AI Flying Laps & 2025 OpenF1 Circuit Benchmarks');
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
    // Norris 2025 Monaco Q pole: 69.954 s (with AI at 0.96 grip scale, 35 kg race fuel, balanced aero: LC26=79.25 s, LC25 ~76–78 s)
    runCircuit('Monaco GP (2025 pole 69.954 s)', monaco, 68.0, 78.5);
  } else {
    console.log('  SKIP  Monaco benchmark (hosted track_data.json not present locally)');
  }
}

console.log('\n6. 3D Model Rig & Compression Invariants (public/cars/lc25/model/lc25.glb)');
{
  const glbPath = path.join('public', 'cars', 'lc25', 'model', 'lc25.glb');
  check('lc25.glb exists and is <= 2.5 MB', existsSync(glbPath) && statSync(glbPath).size <= 2.5 * 1024 * 1024, `${(statSync(glbPath).size / (1024 * 1024)).toFixed(2)} MB`);
  const buf = readFileSync(glbPath);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8')) as {
    nodes: { name?: string; mesh?: number; rotation?: number[]; extras?: Record<string, unknown> }[];
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
  const lfRot = json.nodes.find((n) => n.name === 'WHEEL_LF')?.rotation ?? [0, 0, 0, 1];
  const rfRot = json.nodes.find((n) => n.name === 'WHEEL_RF')?.rotation ?? [0, 0, 0, 1];
  const thw = (root?.extras?.tyreHalfWidth ?? {}) as Record<string, number>;
  check(
    'Front wheels carry symmetric camber on WHEEL_* parent nodes and true 305 mm local tyre geometry (zero spin wobble)',
    Math.abs(lfRot[2] + rfRot[2]) < 1e-3 && Math.abs(lfRot[2]) > 0.01 && Math.abs((thw.LF ?? 0) - 0.1525) < 0.003 && Math.abs((thw.RF ?? 0) - 0.1525) < 0.003,
    `LF.rz=${lfRot[2].toFixed(4)}, RF.rz=${rfRot[2].toFixed(4)}, halfW=${thw.LF}/${thw.RF} m`
  );
}

console.log(`\nLC25 verification: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
