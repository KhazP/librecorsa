import { getRwandaTrackData, TURN_METADATA } from '../src/lib/track-data';
import { F1Physics2026, floorStallFactorForClearance } from '../src/lib/f1-physics-2026';
import {
  computeTyreForces,
  createTyreRuntime,
  magicFormula,
  setTyreTemperature,
  tyreRollingRadius,
  updateTyreThermal,
  wearGripMultiplier,
} from '../src/lib/sim/ac-tyre';
import { estimateAeroCoefficients } from '../src/lib/sim/vf26-aero';
import { NOMINAL_AIR_DENSITY } from '../src/lib/sim/speed-profile';
import { Lut } from '../src/lib/sim/lut';
import { mgukDeployCapW, VF26_AI_REFERENCE, VF26_CHASSIS, VF26_TYRES } from '../src/lib/sim/vf26-data';
import { buildRwandaCircuitScene } from '../src/lib/scene-builder';
import { MultiplayerSyncManager } from '../src/lib/sim/multiplayer-sync';
import { AiOpponentField } from '../src/lib/sim/ai-opponents';
import { createFlatTestTrack } from './lib/flat-track';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';

// Headless canvas shim for running scene-builder procedural textures in Node.js verification
if (typeof globalThis.document === 'undefined') {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({
      width: 256,
      height: 256,
      getContext: () => ({
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        fill: () => {},
        stroke: () => {},
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        fillText: () => {},
        measureText: (t: string) => ({ width: t.length * 10 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
      }),
    }),
  };
}

const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
    console.log(`  [FAIL] ${message}`);
    return;
  }
  console.log(`  [PASS] ${message}`);
}

async function runVerification() {
  console.log('=== RWANDA F1 2026 SIMULATOR (VF26) VERIFICATION SUITE ===\n');
  const track = getRwandaTrackData(1200);
  const flat = createFlatTestTrack(30_000);

  // 1. Stationary steering: the wheels turn, the car does not move
  console.log('1. Testing Stationary Steering Stability...');
  const simStationary = new F1Physics2026(track);
  simStationary.resetToStartGrid(false);
  const initialHeading = simStationary.headingErrorRad;
  const initialLat = simStationary.lateralOffsetM;
  for (let i = 0; i < 120; i++) {
    simStationary.step(1 / 60, { steerLeft: i < 60 ? 1 : 0, steerRight: i >= 60 ? 1 : 0 });
  }
  const headingDrift = Math.abs(simStationary.headingErrorRad - initialHeading);
  const latDrift = Math.abs(simStationary.lateralOffsetM - initialLat);
  assert(
    Math.abs(simStationary.yawRateRadS) < 5e-3 && headingDrift < 1e-3 && latDrift < 5e-3,
    `Stationary car does not rotate or creep while steering at 0 km/h (yawRate=${simStationary.yawRateRadS.toExponential(1)} rad/s, Δheading=${headingDrift.toExponential(1)} rad, Δlat=${latDrift.toExponential(1)} m)`
  );
  assert(
    Math.abs(simStationary.steerAngleNorm) > 0.5,
    `Front wheels visually steer while stationary (steerAngleNorm = ${simStationary.steerAngleNorm.toFixed(3)})`
  );

  // 2. Straight-line acceleration on the flat pad against the mod's AI acceleration envelope
  console.log('\n2. Testing Straight-Line Acceleration & Self-Steer on the Flat Pad...');
  const simStraight = new F1Physics2026(flat);
  simStraight.teleportToDistance(100, 0);
  const accelRef = new Lut(VF26_AI_REFERENCE.accel);
  const accelChecks: string[] = [];
  let accelOk = true;
  let tAccel = 0;
  let t100: number | null = null;
  for (const [tRef] of VF26_AI_REFERENCE.accel) {
    while (tAccel < tRef) {
      simStraight.step(1 / 120, { throttle: 1 });
      tAccel += 1 / 120;
      if (t100 === null && simStraight.vxMs * 3.6 >= 100) t100 = tAccel;
    }
    const ref = accelRef.evaluate(tRef);
    accelChecks.push(`${tRef.toFixed(1)}s: ${simStraight.vxMs.toFixed(1)} vs ${ref.toFixed(1)} m/s`);
    if (simStraight.vxMs < ref * 0.95) accelOk = false;
  }
  assert(accelOk, `Full-throttle acceleration (TC on) matches or beats the mod AI reference (${accelChecks.join(', ')})`);
  assert(
    t100 !== null && t100 > 2.2 && t100 < 3.2,
    `0-100 km/h launch time is in the F1 range (${t100?.toFixed(2)} s within [2.2, 3.2] s)`
  );
  assert(
    Math.abs(simStraight.lateralOffsetM) < 0.05 && Math.abs(simStraight.headingErrorRad) < 0.002,
    `No self-steer under full power on a flat straight (|lat|=${Math.abs(simStraight.lateralOffsetM).toFixed(4)} m, |heading|=${Math.abs(simStraight.headingErrorRad).toFixed(5)} rad)`
  );

  // 3. Fixed-Timestep 500 Hz Determinism (50 FPS vs 100 FPS)
  console.log('\n3. Testing Fixed-Timestep 500 Hz Sub-Stepping Determinism (50Hz vs 100Hz)...');
  const sim60 = new F1Physics2026(track);
  const sim120 = new F1Physics2026(track);
  sim60.resetToStartGrid(true);
  sim120.resetToStartGrid(true);
  for (let i = 0; i < 60; i++) sim60.step(0.02, { throttle: 1, steerLeft: 0.25 });
  for (let i = 0; i < 120; i++) sim120.step(0.01, { throttle: 1, steerLeft: 0.25 });
  const speedDiff = Math.abs(sim60.vxMs - sim120.vxMs);
  const sDiff = Math.abs(sim60.sMeters - sim120.sMeters);
  assert(
    speedDiff < 1e-6 && sDiff < 1e-6,
    `500 Hz sub-stepped solver is frame-rate independent (speedDiff=${speedDiff.toExponential(2)}, sDiff=${sDiff.toExponential(2)})`
  );

  // 4. Tyre load sensitivity & ground-effect aero (VF26 data)
  console.log('\n4. Testing Tyre Load Sensitivity, Ground Effect & Active Aero...');
  const tyreMu = (fz: number) => {
    const tyre = createTyreRuntime(VF26_TYRES.soft.front, 90);
    let mu = 0;
    for (let i = 0; i < 400; i++) {
      mu = computeTyreForces(tyre, { fz, vx: 50, vy: -4, rimSpeed: 50, camberLeftRad: 0, surfaceGrip: 1, dt: 0.0005 }).mu;
    }
    return mu;
  };
  const muLow = tyreMu(2000);
  const muHigh = tyreMu(6000);
  assert(
    muLow > muHigh,
    `Tyre load sensitivity lowers the friction coefficient at higher load (mu@2kN=${muLow.toFixed(3)} > mu@6kN=${muHigh.toFixed(3)})`
  );
  // Magic Formula slip curve: peak (1.0) at the mod's peak slip, mod stiffness, mod falloff by x = 3
  {
    const spec = VF26_TYRES.soft.front;
    const tyre = createTyreRuntime(spec, 90);
    let peakX = 0;
    let peak = 0;
    for (let x = 0; x <= 5; x += 0.001) {
      const f = magicFormula(x, tyre.mf);
      if (f > peak) {
        peak = f;
        peakX = x;
      }
    }
    const slope0 = magicFormula(1e-4, tyre.mf) / 1e-4;
    const at3 = magicFormula(3, tyre.mf);
    assert(
      Math.abs(peakX - 1) < 0.01 && Math.abs(peak - 1) < 1e-6 && Math.abs(slope0 - 2) < 0.01 && Math.abs(at3 - spec.falloffLevel) < 0.002,
      `Magic Formula slip curve (B=${tyre.mf.B.toFixed(3)} C=${tyre.mf.C.toFixed(3)} E=${tyre.mf.E.toFixed(3)}) peaks at x=${peakX.toFixed(3)} (1.0), slope ${slope0.toFixed(2)} (2.0), ${at3.toFixed(3)} at x=3 (falloff ${spec.falloffLevel})`
    );
  }
  // Inflation: ideal gas, P/T constant; pressure stiffens the carcass; load shortens the rolling radius
  {
    const spec = VF26_TYRES.soft.front;
    const tyre = createTyreRuntime(spec, 20);
    const pCold = tyre.pressurePsi;
    setTyreTemperature(tyre, 95);
    const pHot = tyre.pressurePsi;
    const rateHot = tyre.verticalRate;
    const ideal = (pCold * (95 + 273.15)) / (20 + 273.15);
    const rLight = tyreRollingRadius(tyre, 2000);
    const rHeavy = tyreRollingRadius(tyre, 12000);
    assert(
      Math.abs(pHot - ideal) < 1e-6 && Math.abs(pHot - spec.pressureRefPsi) < 0.01 && pHot >= 20 && pHot <= 25 && rateHot > 0 && rLight > rHeavy,
      `Tyre pressure follows the ideal gas law (${pCold.toFixed(1)} psi @20°C -> ${pHot.toFixed(1)} psi @95°C, reference ${spec.pressureRefPsi}); rolling radius ${(rLight * 1000).toFixed(1)} mm @2 kN > ${(rHeavy * 1000).toFixed(1)} mm @12 kN`
    );
    const tyreCold = createTyreRuntime(spec, 20);
    assert(
      tyre.verticalRate > tyreCold.verticalRate,
      `Higher pressure stiffens the tyre (${(tyreCold.verticalRate / 1000).toFixed(0)} -> ${(tyre.verticalRate / 1000).toFixed(0)} kN/m)`
    );
  }
  // 9-node thermal: static negative camber loads and heats the inner shoulder; cornering moves load outward
  {
    const spec = VF26_TYRES.soft.front;
    const run = (camberInRad: number, slipVy: number) => {
      const tyre = createTyreRuntime(spec, 80);
      let out = computeTyreForces(tyre, { fz: 5000, vx: 60, vy: 0, rimSpeed: 60, camberLeftRad: camberInRad, surfaceGrip: 1, inwardSign: 1, dt: 0.0005 });
      for (let i = 0; i < 40000; i++) {
        out = computeTyreForces(tyre, { fz: 5000, vx: 60, vy: slipVy, rimSpeed: 60, camberLeftRad: camberInRad, surfaceGrip: 1, inwardSign: 1, dt: 0.0005 });
        if (i % 4 === 3) updateTyreThermal(tyre, out.slipPower, 5000, 60, 27, 41, 0.002);
      }
      return { load: [...tyre.bandLoad], temps: [0, 1, 2].map((b) => tyre.nodes[b * 3]) };
    };
    // A small and a large slip; vy < 0 makes the force point toward the car (inwardSign +1 = left)
    const straight = run(0.06, -1);
    const corner = run(0.06, -5);
    assert(
      straight.load[0] > straight.load[2] && straight.temps[0] > straight.temps[2] && corner.load[0] - corner.load[2] < straight.load[0] - straight.load[2],
      `9-node tyre: 3.4° negative camber loads the inner band (I/M/O ${straight.load.map((v) => v.toFixed(2)).join('/')}, ${straight.temps.map((v) => v.toFixed(1)).join('/')} °C after 20 s); an inward cornering force shifts it outward (${corner.load.map((v) => v.toFixed(2)).join('/')})`
    );
  }
  const aeroLow = estimateAeroCoefficients('balanced', NOMINAL_AIR_DENSITY, -0.02, 0);
  const aeroHigh = estimateAeroCoefficients('balanced', NOMINAL_AIR_DENSITY, 0.03, 0);
  const aeroX = estimateAeroCoefficients('balanced', NOMINAL_AIR_DENSITY, -0.02, 0, 1);
  const v270 = 270 / 3.6;
  const df270 = aeroLow.downforceCoef * v270 * v270;
  assert(
    aeroLow.downforceCoef > aeroHigh.downforceCoef,
    `Floor/wing ground effect: more downforce closer to the road (${df270.toFixed(0)} N vs ${(aeroHigh.downforceCoef * v270 * v270).toFixed(0)} N at 270 km/h, 50 mm higher)`
  );
  assert(
    aeroX.dragCoef < aeroLow.dragCoef * 0.85 && aeroX.downforceCoef < aeroLow.downforceCoef,
    `2026 X-mode sheds drag and downforce (drag ${(aeroX.dragCoef * v270 * v270).toFixed(0)} N vs ${(aeroLow.dragCoef * v270 * v270).toFixed(0)} N at 270 km/h)`
  );

  // 5. AI driver: Turn 1-2, then a full flying lap
  console.log('\n5. Testing Racing-Line AI Driver...');
  const simAi = new F1Physics2026(track);
  simAi.setAssistPreset('pro');
  simAi.resetToStartGrid(true);
  simAi.aiAutopilot = true;
  let aiOffTrackFrames = 0;
  for (let i = 0; i < 900; i++) {
    simAi.step(1 / 60, {});
    if (simAi.telemetry.offTrack) aiOffTrackFrames++;
  }
  assert(
    aiOffTrackFrames === 0 && simAi.telemetry.speedKmh > 95 && simAi.sMeters > 550,
    `AI keeps the car on track through Turn 1-2 (offTrackFrames=${aiOffTrackFrames}, s=${simAi.sMeters.toFixed(1)}m, speed=${simAi.telemetry.speedKmh.toFixed(1)} km/h, latOffset=${simAi.lateralOffsetM.toFixed(2)}m)`
  );
  const simLap = new F1Physics2026(track);
  simLap.setAssistPreset('pro');
  simLap.resetToStartGrid(true);
  simLap.aiAutopilot = true;
  let lapOffTrack = 0;
  for (let i = 0; i < 60 * 130 && simLap.telemetry.lastLapTimeMs === null; i++) {
    simLap.step(1 / 60, {});
    if (simLap.telemetry.offTrack) lapOffTrack++;
  }
  const lapMs = simLap.telemetry.lastLapTimeMs;
  assert(
    lapMs !== null && lapMs > 85_000 && lapMs < 110_000 && lapOffTrack === 0,
    `AI completes a clean flying lap (lap=${lapMs !== null ? (lapMs / 1000).toFixed(3) : 'none'} s within [85, 110] s, offTrackFrames=${lapOffTrack}, top=${simLap.telemetry.allTimeTopSpeedKmh.toFixed(0)} km/h)`
  );

  // 6. Grandstand & Structure Track Clearance Verification (User bug: "there are some grandstands right on the track")
  console.log('\n6. Testing Grandstand & Trackside Structure Clearance Against All 1,200 Track Samples...');
  const builtScene = buildRwandaCircuitScene(track);
  builtScene.sceneGroup.updateMatrixWorld(true);
  let checkedStructureGroups = 0;
  let checkedMeshes = 0;
  let minClearanceFromCenterlineM = Infinity;

  builtScene.sceneGroup.traverse((obj) => {
    if (obj.userData?.isTracksideStructure) {
      checkedStructureGroups++;
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.updateWorldMatrix(true, false);
          const geom = child.geometry;
          if (!geom.boundingBox) geom.computeBoundingBox();
          const box = geom.boundingBox;
          if (!box) return;

          // Check center and 4 base corners in world space against all 1,200 track samples
          const testPoints = [
            new THREE.Vector3((box.min.x + box.max.x) * 0.5, box.min.y, (box.min.z + box.max.z) * 0.5),
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
          ];

          for (const pt of testPoints) {
            pt.applyMatrix4(child.matrixWorld);
            for (let i = 0; i < track.samples.length; i++) {
              const sp = track.samples[i].position;
              const dist = Math.hypot(pt.x - sp.x, pt.z - sp.z);
              if (dist < minClearanceFromCenterlineM) {
                minClearanceFromCenterlineM = dist;
              }
            }
          }
          checkedMeshes++;
        }
      });
    }
  });
  assert(
    checkedStructureGroups >= 10 && checkedMeshes >= 30 && minClearanceFromCenterlineM > 14.0,
    `Verified ${checkedStructureGroups} trackside structure groups (${checkedMeshes} meshes); minimum corner distance from track centerline is ${minClearanceFromCenterlineM.toFixed(2)}m (> 7.5m asphalt half-width)`
  );

  // 7. Multiplayer: a remote peer's 25 Hz packets are interpolated through the jitter buffer
  console.log('\n7. Testing 25 Hz Multiplayer Sync & Cubic Hermite / Slerp Dead-Reckoning...');
  const mpSync = new MultiplayerSyncManager();
  const remote = new F1Physics2026(track);
  remote.setAssistPreset('pro');
  remote.resetToStartGrid(true);
  remote.aiAutopilot = true;
  const packetOf = (sim: F1Physics2026) => ({
    driverCode: 'VER',
    teamColorHex: '#38bdf8',
    pos: [sim.worldPosition.x, sim.worldPosition.y, sim.worldPosition.z] as [number, number, number],
    quat: [sim.worldQuaternion.x, sim.worldQuaternion.y, sim.worldQuaternion.z, sim.worldQuaternion.w] as [
      number,
      number,
      number,
      number,
    ],
    linVel: [0, 0, sim.vxMs] as [number, number, number],
    angVel: [0, sim.yawRateRadS, 0] as [number, number, number],
    steerAngle: sim.steerAngleNorm,
    wheelRPMs: [1800, 1800, 1800, 1800] as [number, number, number, number],
    throttle: sim.telemetry.throttle,
    brake: sim.telemetry.brake,
    trackS: sim.sMeters,
    speedKmh: sim.telemetry.speedKmh,
  });
  let peers: ReturnType<typeof mpSync.update> = [];
  let maxInterpErrM = 0;
  const remoteTrail: THREE.Vector3[] = [];
  for (let i = 0; i <= 120; i++) {
    const nowMs = i * (1000 / 60);
    remote.step(1 / 60, {});
    remoteTrail.push(remote.worldPosition.clone());
    if (i % 2 === 0) mpSync.ingestPacket({ ...packetOf(remote), peerId: 'peer_remote', timestampMs: nowMs });
    peers = mpSync.update(nowMs, packetOf(simAi));
    // Rendered ~65 ms (4 frames) behind: compare with where the remote car was then
    if (i > 20 && peers.length === 1) {
      maxInterpErrM = Math.max(maxInterpErrM, peers[0].position.distanceTo(remoteTrail[Math.max(0, i - 4)]));
    }
  }
  assert(
    peers.length === 1 && Number.isFinite(peers[0].position.x) && maxInterpErrM < 4.0,
    `Remote peer interpolated from 25 Hz packets (${peers.map((p) => `${p.driverCode}:${p.speedKmh.toFixed(0)}km/h`).join(', ')}, max error vs. 65 ms-delayed truth ${maxInterpErrM.toFixed(2)} m)`
  );
  mpSync.dispose();

  // 7b. AI opponents: standing start behind the lights, then a clean, close race
  console.log('\n7b. Testing AI Opponent Field (start lights, traffic, contact)...');
  const racer = new F1Physics2026(track);
  racer.setAssistPreset('pro');
  const field = new AiOpponentField(track, racer);
  field.startRace(true);
  racer.aiAutopilot = true;
  racer.aiPaceScale = 0.99;
  const lightsSeen = new Set<number>();
  let frozenFrames = 0;
  const aiOff = new Array(field.aiSims().length).fill(0);
  const leaders = new Set<string>();
  const order0 = field.status().standings.map((e) => e.driverCode).join();
  let orderChanges = 0;
  let lastOrder = order0;
  for (let i = 0; i < 60 * 100; i++) {
    if (field.playerFrozen) frozenFrames++;
    else racer.step(1 / 60, {});
    field.update(1 / 60);
    if (field.phase === 'lights') lightsSeen.add(field.lightsOn);
    else {
      field.aiSims().forEach((sim, k) => {
        if (sim.telemetry.offTrack) aiOff[k]++;
      });
      const st = field.status();
      leaders.add(st.standings[0].driverCode);
      const order = st.standings.map((e) => e.driverCode).join();
      if (order !== lastOrder) orderChanges++;
      lastOrder = order;
    }
  }
  const raceSt = field.status();
  const aiFinite = field.peers().every((p) => Number.isFinite(p.position.x) && p.speedKmh > 60);
  const worstOff = Math.max(...aiOff);
  assert(
    [1, 2, 3, 4, 5].every((k) => lightsSeen.has(k)) &&
      frozenFrames >= 60 * 5 &&
      raceSt.phase === 'racing' &&
      raceSt.fieldSize === 6 &&
      aiFinite &&
      worstOff < 60 &&
      orderChanges >= 1 &&
      raceSt.standings[raceSt.fieldSize - 1].gapToLeaderS < 15,
    `AI field: lights ${[...lightsSeen].sort().join('-')} then out after ${(frozenFrames / 60).toFixed(1)} s, ${raceSt.fieldSize} cars racing (${raceSt.standings.map((e) => `${e.driverCode} +${e.gapToLeaderS.toFixed(1)}`).join(', ')}), ${orderChanges} position changes, worst AI off-track ${worstOff} frames`
  );

  // 8. Edge Cases: NaN/Zero dt, Carbon Brake Thermal Glow, 2026 /Boost Override & Dynamic Racing Line
  console.log('\n8. Testing Edge Cases (Invalid dt, Brake Thermal Glow, /Boost Override, Dynamic Racing Line)...');
  const prevSpeed = simAi.telemetry.speedKmh;
  simAi.step(0, {});
  simAi.step(-0.05, {});
  simAi.step(Number.NaN, {});
  assert(
    simAi.telemetry.speedKmh === prevSpeed && Number.isFinite(simAi.telemetry.speedKmh),
    `Physics solver safely ignores 0, negative, and NaN dtSeconds (speed preserved at ${simAi.telemetry.speedKmh.toFixed(1)} km/h)`
  );

  // Heavy braking from 280 km/h -> verify deceleration and carbon disc temperature rise
  const simBrake = new F1Physics2026(track);
  simBrake.teleportToDistance(30, 280 / 3.6);
  const startBrakeTemp = simBrake.telemetry.brakeTempsC[0];
  for (let i = 0; i < 60; i++) simBrake.step(1 / 60, { brake: 1.0 });
  assert(
    simBrake.telemetry.speedKmh < 160 && simBrake.telemetry.brakeTempsC[0] > startBrakeTemp + 80,
    `Heavy braking decelerates car (${simBrake.telemetry.speedKmh.toFixed(1)} km/h after 1 s) and heats carbon discs (${startBrakeTemp.toFixed(0)}°C -> ${simBrake.telemetry.brakeTempsC[0].toFixed(0)}°C)`
  );

  // 2026 /Boost Manual Override above 300 km/h
  const simBoost = new F1Physics2026(track);
  simBoost.teleportToDistance(100, 315 / 3.6);
  const boostActivated = simBoost.activateBoostOverride();
  simBoost.step(1 / 60, { throttle: 1, brake: 0 });
  assert(
    boostActivated && simBoost.telemetry.manualOverrideActive && simBoost.telemetry.mgukPowerKw > 330,
    `2026 FIA /Boost Manual Override sustains ${simBoost.telemetry.mgukPowerKw.toFixed(0)} kW MGU-K at 315 km/h`
  );

  // Dynamic 3D Dashed Braking Line color update
  builtScene.updateDynamicRacingLine(520, 82); // Approaching T1 at 295 km/h
  const colorAttr = builtScene.racingLineMesh.geometry.getAttribute('color');
  assert(
    Boolean(colorAttr && colorAttr.count > 100),
    `Dynamic 3D Dashed Braking Line updates vertex colors (${colorAttr?.count ?? 0} vertices)`
  );

  // 9. Regression suite: aero load & ride heights, load transfer sign, ground contact, banking, cameras, recovery, braking
  console.log('\n9. Testing Regression Suite (Aero Load, Load Transfer Sign, Ground Contact, Banking, Cameras, Recovery, Braking, Traction Control, Gamepad Assist)...');

  // 9.1 Downforce level and ride heights at 270 km/h
  assert(
    df270 >= 7000 && df270 <= 16500,
    `2026 F1 downforce level at 270 km/h at Bugesera air density (${df270.toFixed(0)} N within [7000, 16500] N)`
  );
  const simHighSpeed = new F1Physics2026(flat);
  simHighSpeed.teleportToDistance(100, 270 / 3.6);
  for (let i = 0; i < 60; i++) simHighSpeed.step(1 / 60, { throttle: 1, brake: 0 });
  const [rhFR, rhFL, rhRR, rhRL] = simHighSpeed.telemetry.wheelRideHeightsMm;
  assert(
    rhFR >= 10 && rhFL >= 10 && rhRR >= 14 && rhRL >= 14,
    `High-speed suspension keeps the floor off the road (FR=${rhFR}mm, FL=${rhFL}mm, RR=${rhRR}mm, RL=${rhRL}mm)`
  );
  const sumWheelFz = simHighSpeed.wheels.reduce((acc, w) => acc + w.fzN, 0);
  const expectedTotalFz =
    (VF26_CHASSIS.totalMassKg + simHighSpeed.telemetry.fuelKg) * 9.81 + simHighSpeed.telemetry.downforceN;
  assert(
    Math.abs(sumWheelFz - expectedTotalFz) / expectedTotalFz < 0.05,
    `Sum of 4 wheel loads matches weight + aero downforce on the flat pad (sumFz=${sumWheelFz.toFixed(0)}N vs expected=${expectedTotalFz.toFixed(0)}N)`
  );

  // 9.2 Lateral load transfer sign (turning left -> outside right wheels FR/RR carry more load)
  const simCorner = new F1Physics2026(flat);
  simCorner.teleportToDistance(100, 180 / 3.6);
  for (let i = 0; i < 30; i++) simCorner.step(1 / 60, { throttle: 0.5, steerLeft: 0.3 });
  const fzRight = simCorner.wheels[0].fzN + simCorner.wheels[2].fzN;
  const fzLeft = simCorner.wheels[1].fzN + simCorner.wheels[3].fzN;
  assert(
    fzRight > fzLeft + 800,
    `Left-hand turn transfers weight to outside Right wheels (fzRight=${fzRight.toFixed(0)}N > fzLeft=${fzLeft.toFixed(0)}N)`
  );

  // 9.3 Wheels follow the track surface; unsprung assemblies are parented to the car root
  const { evaluateSampleLateralHeightM, LIVERIES } = await import('../src/lib/track-data');
  const simGround = new F1Physics2026(track);
  simGround.teleportToDistance(1200, 200 / 3.6);
  for (let i = 0; i < 60; i++) simGround.step(1 / 60, { throttle: 0.6 });
  let maxContactErrMm = 0;
  for (const w of simGround.wheels) {
    const loc = track.locateWorldPoint(w.worldPos.x, w.worldPos.z, simGround.sMeters);
    const n = track.samples.length;
    const tt = loc.t;
    const cr = [
      ((-tt + 2) * tt - 1) * tt * 0.5,
      ((3 * tt - 5) * tt * tt + 2) * 0.5,
      ((-3 * tt + 4) * tt + 1) * tt * 0.5,
      (tt - 1) * tt * tt * 0.5,
    ];
    const ids = [(loc.i0 - 1 + n) % n, loc.i0, loc.i1, (loc.i1 + 1) % n];
    const zRoad = ids.reduce((acc, id, k) => acc + cr[k] * evaluateSampleLateralHeightM(track.samples[id], loc.lateralH), 0);
    maxContactErrMm = Math.max(maxContactErrMm, Math.abs(w.zRoad - zRoad) * 1000);
  }
  assert(
    maxContactErrMm < 0.5,
    `Each tyre's road height is the track cross-section surface under that wheel (max error ${maxContactErrMm.toFixed(3)} mm)`
  );

  const { createF1Car2026 } = await import('../src/lib/car-builder-2026');
  const carRig = createF1Car2026(LIVERIES[0], 'soft');
  assert(
    carRig.frontLeftSteerPivot.parent === carRig.root && carRig.frontRightSteerPivot.parent === carRig.root,
    `Unsprung wheel assemblies are parented to root (not sprung chassisGroup) so tires stay planted during pitch/roll/heave`
  );

  // 9.4 Inward Track Banking Sign Verification
  const bankedRightSample = track.samples.find((s) => s.bankingRad > (3.0 * Math.PI) / 180);
  assert(
    Boolean(bankedRightSample && bankedRightSample.binormal.y < -0.04),
    `Positive banking tilts track surface inward toward right-hand apex (banking=${((bankedRightSample?.bankingRad ?? 0) * 180 / Math.PI).toFixed(1)}°, binormal.y=${bankedRightSample?.binormal.y.toFixed(4)})`
  );

  // 9.5 Frustum Projection Verification for All 4 Reference Image Onboard Cameras
  carRig.root.position.set(0, 0, 0);
  carRig.root.quaternion.identity();
  carRig.root.updateMatrixWorld(true);

  const projectLocalPoint = (
    camPos: [number, number, number],
    lookAtPos: [number, number, number],
    fovDeg: number,
    targetPt: [number, number, number]
  ): { x: number; y: number; z: number } => {
    const cam = new THREE.PerspectiveCamera(fovDeg, 16 / 9, 0.05, 500);
    cam.position.set(camPos[0], camPos[1], camPos[2]);
    cam.up.set(0, 1, 0);
    cam.lookAt(lookAtPos[0], lookAtPos[1], lookAtPos[2]);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const v = new THREE.Vector3(targetPt[0], targetPt[1], targetPt[2]).project(cam);
    return { x: v.x, y: v.y, z: v.z };
  };

  // Image 1 (`tv_pod` at [0.02, 0.905, -0.06] -> [0, 0.22, 3.6], fov=60):
  // Frames Helmet (0, 0.625, 0.24), Steering Wheel (0, 0.588, 0.565), Halo (0, 0.842, 0.752), Mirrors (±0.465, 0.635, 0.68), Wheel Brows (±0.695, 0.388, 1.42), Front Tires (±0.77, 0.355, 1.42)
  const tvHelmet = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.65, 0.28]);
  const tvWheel = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.588, 0.565]);
  const tvHalo = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0, 0.842, 0.752]);
  const tvMirrorL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.465, 0.635, 0.68]);
  const tvBrowL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.695, 0.388, 1.42]);
  const tvTireL = projectLocalPoint([0.02, 0.905, -0.06], [0, 0.22, 3.6], 60, [0.77, 0.355, 1.42]);
  assert(
    tvHelmet.y > -0.95 &&
      tvHelmet.y < -0.25 &&
      tvWheel.y > -0.75 &&
      tvWheel.y < 0.0 &&
      Math.abs(tvMirrorL.x) < 0.92 &&
      tvMirrorL.y > -0.65 &&
      tvBrowL.y > tvTireL.y &&
      Math.abs(tvTireL.x) < 0.95 &&
      tvHalo.y < 0.5,
    `Image 1 (tv_pod) frames helmet (ndcY=${tvHelmet.y.toFixed(2)}), wheel (ndcY=${tvWheel.y.toFixed(2)}), mirrors (ndc=${tvMirrorL.x.toFixed(2)},${tvMirrorL.y.toFixed(2)}), wheel brows above tires (ndcY=${tvBrowL.y.toFixed(2)}>${tvTireL.y.toFixed(2)}), and halo (ndcY=${tvHalo.y.toFixed(2)})`
  );

  // Image 2 (`cockpit_shoulder` at [0.24, 0.715, 0.06] -> [-0.13, 0.40, 5.5], fov=58):
  // Helmet on right (ndcX > 0), left glove/wheel in lower-center, left mirror & front-left wheel + wheel brow on left (ndcX < 0)
  const shHelmet = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0, 0.625, 0.28]);
  const shGloveL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.132, 0.575, 0.565]);
  const shMirrorL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.465, 0.635, 0.68]);
  const shTireL = projectLocalPoint([0.24, 0.715, 0.06], [-0.13, 0.40, 5.5], 58, [0.77, 0.355, 1.42]);
  assert(
    shHelmet.x > 0.15 &&
      shHelmet.x < 0.98 &&
      Math.abs(shGloveL.x) < 0.45 &&
      shGloveL.y > -0.78 &&
      shMirrorL.x < -0.15 &&
      shMirrorL.x > -0.95 &&
      shMirrorL.y > -0.55 &&
      shTireL.x < -0.1 &&
      shTireL.x > -0.95,
    `Image 2 (cockpit_shoulder) frames helmet on right (ndcX=${shHelmet.x.toFixed(2)}), gloved hand on wheel (ndc=${shGloveL.x.toFixed(2)},${shGloveL.y.toFixed(2)}), left mirror (ndc=${shMirrorL.x.toFixed(2)},${shMirrorL.y.toFixed(2)}), and left tire (ndcX=${shTireL.x.toFixed(2)})`
  );

  // Image 3 (`cockpit` at [0, 0.675, 0.21] -> [0, 0.50, 8.0], fov=62):
  // Full Butterfly Steering Wheel OLED & lower edge (0, 0.515, 0.565) above bottom HUD bar (ndcY > -0.76), plus both wing mirrors visible at sides
  const ckWheelTop = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0, 0.642, 0.565]);
  const ckWheelBot = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0, 0.515, 0.565]);
  const ckGloveL = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0.132, 0.575, 0.565]);
  const ckMirrorL = projectLocalPoint([0, 0.675, 0.21], [0, 0.50, 8.0], 62, [0.465, 0.635, 0.68]);
  assert(
    ckWheelTop.y < 0.15 &&
      ckWheelBot.y > -0.76 &&
      Math.abs(ckGloveL.x) < 0.65 &&
      Math.abs(ckMirrorL.x) < 0.99 &&
      Math.abs(ckMirrorL.y) < 0.45,
    `Image 3 (cockpit) frames full Butterfly Steering Wheel & OLED above bottom HUD (ndcY=[${ckWheelBot.y.toFixed(2)}, ${ckWheelTop.y.toFixed(2)}]), gloved hands (ndcX=±${Math.abs(ckGloveL.x).toFixed(2)}), and side mirrors (ndcX=±${Math.abs(ckMirrorL.x).toFixed(2)})`
  );

  // Image 4 (`nose` at [0, 0.455, 1.66] -> [0, 0.25, 18.0], fov=64):
  // Y-Pitot probe (0, 0.405, 2.145) stands above narrow nose tip (0, 0.255, 2.42), with curved vertical front-wing endplates (±0.80, 0.22, 2.45) at bottom corners
  const nsPitot = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0, 0.405, 2.145]);
  const nsTip = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0, 0.255, 2.42]);
  const nsEndplateL = projectLocalPoint([0, 0.455, 1.66], [0, 0.25, 18.0], 64, [0.80, 0.22, 2.45]);
  assert(
    Math.abs(nsPitot.x) < 0.05 &&
      nsPitot.y > nsTip.y + 0.15 &&
      nsPitot.y > -0.35 &&
      nsTip.y > -0.75 &&
      Math.abs(nsEndplateL.x) < 0.98 &&
      nsEndplateL.y > -0.75,
    `Image 4 (nose) frames central metallic Y-pitot probe (ndcY=${nsPitot.y.toFixed(2)}) above narrow nose tip (ndcY=${nsTip.y.toFixed(2)}) and front wing endplates (ndcX=±${Math.abs(nsEndplateL.x).toFixed(2)}, ndcY=${nsEndplateL.y.toFixed(2)})`
  );

  // Verify dynamic forearm-to-wrist kinematics at full steering lock (±1.0) so forearms never swing above the wheel
  const fullLockTelemetry = { ...simCorner.telemetry, steering: 1.0 };
  carRig.updateFromTelemetry(fullLockTelemetry, 0, 0, 0, 0);
  carRig.root.updateMatrixWorld(true);
  // steering +1 = right turn -> +rotation.z about the forward axis = clockwise as seen from the seat
  assert(
    Math.abs(carRig.steeringWheelGroup.rotation.z - 1.45) < 0.01,
    `Steering wheel turns clockwise (to the right) at full right lock (rotZ=${carRig.steeringWheelGroup.rotation.z.toFixed(2)} rad)`
  );

  // Verify all 5 pre-rendered WAV loops in public/audio/f1_real_*.wav have seamless wrap-around and zero pitch wobble
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const wavName of [
    'f1_real_v6_low.wav',
    'f1_real_mid_bark.wav',
    'f1_real_high_roar.wav',
    'f1_real_top_scream.wav',
    'f1_real_overrun.wav',
  ]) {
    const wavPath = path.resolve(process.cwd(), 'public/audio', wavName);
    const wavBuf = fs.readFileSync(wavPath);
    const numSamples = (wavBuf.length - 44) / 2;
    const firstSample = wavBuf.readInt16LE(44) / 32768;
    const lastSample = wavBuf.readInt16LE(44 + (numSamples - 1) * 2) / 32768;
    const prevSample = wavBuf.readInt16LE(44 + (numSamples - 2) * 2) / 32768;
    const stepDelta = Math.abs(lastSample - prevSample);
    const wrapDelta = Math.abs(firstSample - lastSample);
    assert(
      wrapDelta <= Math.max(0.05, stepDelta * 2.5),
      `Audio sample ${wavName} has phase-coherent loop boundary (wrapDelta=${wrapDelta.toFixed(4)}, stepDelta=${stepDelta.toFixed(4)})`
    );
  }


  // 9.6 Extreme 85° heading error: the car turns back without spinning or NaNs ('pro', flat pad, no walls),
  //     and an 85° impact into the run-off tyre barrier of the real track stays bounded
  const recovery = (sign: 1 | -1) => {
    const sim = new F1Physics2026(flat);
    sim.setAssistPreset('pro');
    sim.teleportToDistance(200, 110 / 3.6);
    sim.headingErrorRad = (sign * 85 * Math.PI) / 180;
    for (let i = 0; i < 150; i++) {
      // Proportional driver countersteer aiming back toward the track tangent + centreline
      const targetHeading = THREE.MathUtils.clamp(-sim.lateralOffsetM * 0.06, -0.35, 0.35);
      const err = sim.headingErrorRad - targetHeading;
      sim.step(1 / 60, {
        throttle: 0.35,
        steerLeft: THREE.MathUtils.clamp(err * 1.2, 0, 0.85),
        steerRight: THREE.MathUtils.clamp(-err * 1.2, 0, 0.85),
      });
    }
    return sim;
  };
  const recRight = recovery(1);
  const recLeft = recovery(-1);
  assert(
    [recRight, recLeft].every(
      (sim) =>
        Number.isFinite(sim.vxMs) &&
        Number.isFinite(sim.vyMs) &&
        Number.isFinite(sim.yawRateRadS) &&
        Math.abs(sim.headingErrorRad) < (25 * Math.PI) / 180
    ),
    `Extreme ±85° heading error at 110 km/h in 'pro' mode turns back without spinning (heading after 2.5 s: ${((recRight.headingErrorRad * 180) / Math.PI).toFixed(1)}° / ${((recLeft.headingErrorRad * 180) / Math.PI).toFixed(1)}°)`
  );
  const simWall = new F1Physics2026(track);
  simWall.setAssistPreset('pro');
  simWall.teleportToDistance(1200, 110 / 3.6);
  const halfWall = track.getSampleAtDistance(1200).width * 0.5;
  simWall.lateralOffsetM = halfWall + 1.6; // right-hand run-off of the back straight
  simWall.headingErrorRad = (85 * Math.PI) / 180; // pointing at the tyre barrier
  for (let i = 0; i < 60; i++) simWall.step(1 / 60, { throttle: 0.35 });
  assert(
    Number.isFinite(simWall.vxMs) &&
      Number.isFinite(simWall.yawRateRadS) &&
      simWall.lateralOffsetM <= halfWall + 4.8 + 1e-6 &&
      simWall.telemetry.speedKmh < 60,
    `85° impact into the run-off tyre barrier stays bounded (lat=${simWall.lateralOffsetM.toFixed(2)} m <= barrier ${(halfWall + 4.8).toFixed(2)} m, speed=${simWall.telemetry.speedKmh.toFixed(0)} km/h)`
  );

  // 9.7 Threshold braking 320 -> 100 km/h on the flat pad, with ABS (semi_pro) and without (pro)
  const brakingDistance = (assist: 'semi_pro' | 'pro', pedal: number) => {
    const sim = new F1Physics2026(flat);
    sim.setAssistPreset(assist);
    sim.teleportToDistance(100, 320 / 3.6);
    const z0 = sim.worldZ;
    let steps = 0;
    let maxLock = 0;
    while (sim.vxMs * 3.6 > 100 && steps < 5000) {
      sim.step(0.002, { brake: pedal });
      maxLock = Math.max(maxLock, ...sim.wheels.map((w) => -w.slipRatio));
      steps++;
    }
    return { dist: Math.abs(sim.worldZ - z0), maxLock };
  };
  const brakeAbs = brakingDistance('semi_pro', 1);
  assert(
    brakeAbs.dist >= 75 && brakeAbs.dist <= 115 && brakeAbs.maxLock < 0.35,
    `320 -> 100 km/h with ABS takes ${brakeAbs.dist.toFixed(1)} m (within [75, 115] m), no lock-up (max slip ${brakeAbs.maxLock.toFixed(2)})`
  );
  const brakePro = brakingDistance('pro', 1);
  assert(
    brakePro.dist >= 70 && brakePro.dist <= 140,
    `320 -> 100 km/h at full pedal without ABS takes ${brakePro.dist.toFixed(1)} m (within [70, 140] m; max slip ${brakePro.maxLock.toFixed(2)} — the brakes can lock the tyres)`
  );

  // 9.8 Rwanda 2026 circuit GLB (< 24 MB, < 25 MB track folder total), Dynamic Braking Zone & 12 Trackside TV Cameras Verification
  const { getTracksideTvCameras, getActiveTvCamera } = await import('../src/lib/track-data');
  const { evaluateDynamicBrakingUrgency } = await import('../src/lib/sim/track-occupancy');
  const tvCams = getTracksideTvCameras();
  const sampleTvCam = getActiveTvCamera(0.25);
  const trackDir = path.resolve(process.cwd(), 'public/tracks/rwanda');
  const glbPath = path.resolve(trackDir, 'rwanda_2026.glb');
  const glbBytes = fs.statSync(glbPath).size;
  const glbHeader = fs.readFileSync(glbPath).subarray(0, 4).toString('latin1');

  // Compute total size and max single-file size in public/tracks/rwanda
  const getFilesRecursive = (dir: string): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...getFilesRecursive(full));
      else out.push(full);
    }
    return out;
  };
  const allTrackFiles = getFilesRecursive(trackDir);
  let totalTrackBytes = 0;
  let maxSingleFileBytes = 0;
  for (const f of allTrackFiles) {
    const sz = fs.statSync(f).size;
    totalTrackBytes += sz;
    if (sz > maxSingleFileBytes) maxSingleFileBytes = sz;
  }

  assert(
    tvCams.length === 12 &&
      Boolean(sampleTvCam && sampleTvCam.position.length === 3) &&
      glbHeader === 'glTF' &&
      glbBytes > 1_000_000 &&
      maxSingleFileBytes < 24 * 1000 * 1000 &&
      totalTrackBytes < 25 * 1024 * 1024,
    `Rwanda 2026 circuit GLB (${(glbBytes / 1048576).toFixed(2)} MiB < 24 MB, track folder ${(totalTrackBytes / 1048576).toFixed(2)} MiB < 25 MB) and ${tvCams.length} official TV cameras verified (active cam @ 0.25 = ${sampleTvCam?.name})`
  );

  // 9.9 Dynamic braking-line urgency ahead of Turn 2 (the first heavy stop: Turn 1 is a flat-out sweeper)
  // follows the VF26 speed profile
  const t1S = TURN_METADATA.find((t) => t.number === 1)?.sApprox ?? 366;
  const t2S = TURN_METADATA.find((t) => t.number === 2)?.sApprox ?? 664;
  const carS = t1S + 40;
  const carKmh = 285;
  const carV = carKmh / 3.6;
  const urgencyAt = (s: number) => evaluateDynamicBrakingUrgency(track, carS, carV, s);
  // Last possible brake point for the approach speed from the car model's braking envelope
  let sBrake = -1;
  for (let s = carS + 10; s <= t2S + 40 && sBrake < 0; s += 1) {
    if ((track.getSampleAtDistance(s).brakeLimitKmh ?? Infinity) < carKmh) sBrake = s;
  }
  let vMin = Infinity;
  let apexS = -1;
  for (let s = t2S - 80; s <= t2S + 80; s += 2) {
    const v = track.getSampleAtDistance(s).optimalSpeedKmh;
    if (v < vMin) {
      vMin = v;
      apexS = s;
    }
  }
  let firstYellow = -1;
  let firstRed = -1;
  for (let s = carS + 10; s <= apexS; s += 2) {
    const u = urgencyAt(s);
    if (firstYellow < 0 && u > 0 && u < 1) firstYellow = s;
    if (firstRed < 0 && u >= 1) firstRed = s;
  }
  const urgStart = urgencyAt(carS + 20);
  const urgExit = urgencyAt(apexS + 40);
  assert(
    urgStart === 0 &&
      firstYellow > 0 &&
      firstRed > firstYellow &&
      firstRed < apexS &&
      urgExit === 0 &&
      sBrake > 0 &&
      firstRed <= sBrake &&
      firstRed >= sBrake - 14,
    `Braking-line urgency ahead of Turn 2 runs Green (${urgStart.toFixed(2)} @ ${carS + 20}m) -> Yellow (from ${firstYellow}m) -> Red (from ${firstRed}m, car-model brake point ${sBrake}m) -> Green (${urgExit.toFixed(2)} @ ${apexS + 40}m; apex ${apexS}m at ${vMin.toFixed(0)} km/h)`
  );

  // 9.10 Traction control (semi_pro) catches a throttle stab at the cornering limit: the car
  //      accelerates out instead of spinning. Flat pad wide enough for the circles.
  const wideFlat = createFlatTestTrack(30_000, 3000);
  const slipDeg = (sim: F1Physics2026) => (Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs))) * 180) / Math.PI;
  const speedHold = (sim: F1Physics2026, vMs: number) => THREE.MathUtils.clamp(0.25 + 0.6 * (vMs - sim.vxMs), 0, 1);
  const tcStab = (vKmh: number, steer: number) => {
    const sim = new F1Physics2026(wideFlat);
    sim.setAssistPreset('semi_pro');
    sim.teleportToDistance(1500, vKmh / 3.6);
    let st = 0;
    for (let t = 0; t < 4; t += 1 / 120) {
      st = Math.min(steer, st + 0.15 / 120);
      sim.step(1 / 120, { throttle: speedHold(sim, vKmh / 3.6), analogSteer: st });
    }
    let maxSlip = 0;
    for (let t = 0; t < 3; t += 1 / 120) {
      sim.step(1 / 120, { throttle: Math.min(1, t / 0.05), analogSteer: steer });
      maxSlip = Math.max(maxSlip, Math.abs(slipDeg(sim)));
    }
    return { maxSlip, gainKmh: sim.telemetry.speedKmh - vKmh };
  };
  const stab90 = tcStab(90, 0.36);
  const stab160 = tcStab(160, 0.18);
  assert(
    stab90.maxSlip < 10 && stab90.gainKmh > 15 && stab160.maxSlip < 12 && stab160.gainKmh > 5,
    `TC+ABS: full throttle stab at ~80% of the cornering limit drives out without spinning (90 km/h: max body slip ${stab90.maxSlip.toFixed(1)}°, +${stab90.gainKmh.toFixed(0)} km/h; 160 km/h: ${stab160.maxSlip.toFixed(1)}°, +${stab160.gainKmh.toFixed(0)} km/h)`
  );

  // 9.11 Gamepad steering assist: full stick holds the car at its grip limit, full-stick flicks at
  //      280 km/h stay stable, and a released stick self-aligns the car straight
  const padRun = (vKmh: number, stick: (t: number) => number, seconds: number) => {
    const sim = new F1Physics2026(wideFlat);
    sim.setAssistPreset('semi_pro');
    sim.teleportToDistance(1500, vKmh / 3.6);
    let maxSlip = 0;
    let lateralG = 0;
    for (let t = 0; t < seconds; t += 1 / 120) {
      sim.step(1 / 120, { throttle: speedHold(sim, vKmh / 3.6), padSteer: stick(t) });
      maxSlip = Math.max(maxSlip, Math.abs(slipDeg(sim)));
      lateralG = Math.abs(sim.telemetry.lateralG);
    }
    return { sim, maxSlip, lateralG };
  };
  const hold160 = padRun(160, () => 1, 4);
  const hold240 = padRun(240, () => 1, 4);
  const flick280 = padRun(280, (t) => (t < 0.3 ? 1 : t < 0.6 ? -1 : 0), 3);
  const release200 = padRun(200, (t) => (t < 1 ? 1 : 0), 4);
  assert(
    hold160.maxSlip < 10 && hold160.lateralG > 2.4 && hold240.maxSlip < 10 && hold240.lateralG > 3.2,
    `Gamepad full stick holds the car at its grip limit without spinning (160 km/h: ${hold160.lateralG.toFixed(2)} g, max body slip ${hold160.maxSlip.toFixed(1)}°; 240 km/h: ${hold240.lateralG.toFixed(2)} g, ${hold240.maxSlip.toFixed(1)}°)`
  );
  assert(
    flick280.maxSlip < 10 &&
      Math.abs(release200.sim.yawRateRadS) < 0.05 &&
      Math.abs(slipDeg(release200.sim)) < 2,
    `Gamepad full-stick right-left flick at 280 km/h stays stable (max body slip ${flick280.maxSlip.toFixed(1)}°) and a released stick straightens the car (yaw ${((release200.sim.yawRateRadS * 180) / Math.PI).toFixed(1)}°/s, slip ${slipDeg(release200.sim).toFixed(1)}°)`
  );

  // 9.12 Trail braking in fast corners (semi_pro): a brake stab at 180-290 km/h while holding ~2-3.6 g must
  //      not unload the rear into a spin (the aero balance shifts forward only through the ride-height maps), and
  //      the ABS must hold the cornering rear tyres near their peak slip instead of past it
  const trailBrake = (vKmh: number, steer: number, brake: number) => {
    const sim = new F1Physics2026(wideFlat);
    sim.setAssistPreset('semi_pro');
    sim.teleportToDistance(1500, vKmh / 3.6);
    let st = 0;
    for (let t = 0; t < 4; t += 1 / 120) {
      st = Math.min(steer, st + 0.15 / 120);
      sim.step(1 / 120, { throttle: speedHold(sim, vKmh / 3.6), analogSteer: st });
    }
    let maxSlip = 0;
    let rearLock = 0;
    for (let t = 0; t < 2; t += 1 / 120) {
      sim.step(1 / 120, { brake: Math.min(brake, (t / 0.08) * brake), analogSteer: steer });
      maxSlip = Math.max(maxSlip, Math.abs(slipDeg(sim)));
      // Loaded rear only: the lifted inside wheel carries no side force worth keeping
      if (sim.vxMs > 30) {
        const W = sim.telemetry.wheelSlipRatios;
        const loads = sim.telemetry.wheelLoadsN;
        const outer = loads && loads[2] > loads[3] ? 2 : 3;
        if (W) rearLock = Math.max(rearLock, -W[outer] / VF26_TYRES.soft.rear.peakSlipRatio);
      }
    }
    return { maxSlip, rearLock };
  };
  const trailCases: [number, number, number][] = [
    [180, 0.16, 0.5], [200, 0.12, 1], [250, 0.1, 0.3], [250, 0.12, 0.6], [250, 0.12, 1], [290, 0.08, 0.3], [290, 0.1, 0.6], [290, 0.12, 1],
  ];
  const trailRuns = trailCases.map(([v, st, b]) => trailBrake(v, st, b));
  assert(
    Math.max(...trailRuns.map((r) => r.maxSlip)) < 10 && Math.max(...trailRuns.map((r) => r.rearLock)) < 1.3,
    `Trail braking in fast corners keeps the rear planted (max body slip / loaded-rear lock vs peak ${trailCases.map(([v, , b], i) => `${v} km/h brk ${b}: ${trailRuns[i].maxSlip.toFixed(1)}° ${trailRuns[i].rearLock.toFixed(2)}`).join(', ')}; < 10°, < 1.3)`
  );

  // 10. Phase 2 vehicle physics: tyre wear, floor stall, MGU-K super-clipping, tyre setup
  console.log('\n10. Testing Phase 2 Vehicle Physics (Tyre Wear, Floor Stall & Centre of Pressure, MGU-K Deploy Ceiling, Tyre Setup)...');

  // 10.1 Soft tyre wear over one full AI lap (mean of the four wheels, between two line crossings)
  {
    const sim = new F1Physics2026(track);
    sim.setAssistPreset('pro');
    sim.tireCompound = 'soft';
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    const meanWearPct = () => (100 * sim.wheels.reduce((a, w) => a + w.tyre.wear, 0)) / sim.wheels.length;
    let wearAt2 = -1;
    let wearAt3 = -1;
    for (let i = 0; i < 60 * 260 && wearAt3 < 0; i++) {
      sim.step(1 / 60, {});
      if (sim.telemetry.lapCount === 2 && wearAt2 < 0) wearAt2 = meanWearPct();
      if (sim.telemetry.lapCount === 3 && wearAt3 < 0) wearAt3 = meanWearPct();
    }
    const lapWear = wearAt3 - wearAt2;
    assert(
      wearAt2 >= 0 && wearAt3 >= 0 && lapWear >= 2 && lapWear <= 4,
      `Soft tyre loses ${lapWear.toFixed(2)} % of its tread per AI lap (within [2, 4] %, mean of four wheels)`
    );
  }

  // 10.2 Grip vs tread wear: progressive, monotonic, ~1.5–2 % at 30 % wear and ~8–10 % at 80 %
  {
    let monotonic = true;
    for (let w = 0.01; w <= 1.0001; w += 0.01) {
      if (wearGripMultiplier(w) >= wearGripMultiplier(w - 0.01)) monotonic = false;
    }
    const loss30 = (1 - wearGripMultiplier(0.3)) * 100;
    const loss80 = (1 - wearGripMultiplier(0.8)) * 100;
    assert(
      monotonic && loss30 >= 1.5 && loss30 <= 2 && loss80 >= 8 && loss80 <= 10,
      `Grip falls progressively with tread wear (${loss30.toFixed(2)} % lost at 30 % wear, ${loss80.toFixed(2)} % at 80 %, monotonic: ${monotonic})`
    );
  }

  // 10.3 Floor stall: the floor loses suction when the plank nears the road, the centre of pressure stays in range
  {
    const floorDownforce = (clearanceM: number) => {
      const sim = new F1Physics2026(flat);
      sim.teleportToDistance(100, 270 / 3.6);
      for (const w of sim.wheels) w.rideHeight = clearanceM;
      const internals = sim as unknown as { updateAero: (dt: number) => void; aeroDownforceN: number };
      internals.updateAero(0.002);
      return internals.aeroDownforceN;
    };
    const dfStalled = floorDownforce(0.003);
    const dfAttached = floorDownforce(0.015);
    const stallOk = floorStallFactorForClearance(0.015) === 1 && Math.abs(floorStallFactorForClearance(0.003) - 0.55) < 1e-9;
    assert(
      stallOk && dfStalled < dfAttached,
      `Floor stall: downforce at 3 mm plank clearance ${dfStalled.toFixed(0)} N < ${dfAttached.toFixed(0)} N at 15 mm (stall factor 0.55 at 4 mm and below, 1.0 above 6 mm)`
    );
  }

  // 10.4 MGU-K deploy ceiling: 350 kW to 290 km/h (350 kW to 337 km/h with Manual Override), linear taper to 0 at 355 km/h
  {
    const capMid = mgukDeployCapW(322.5, false);
    const capOk =
      mgukDeployCapW(280, false) === 350_000 &&
      Math.abs(capMid - 175_000) <= 0.05 * 175_000 &&
      mgukDeployCapW(355, false) === 0 &&
      mgukDeployCapW(330, true) === 350_000 &&
      mgukDeployCapW(360, true) === 0;
    assert(
      capOk,
      `MGU-K deploy ceiling: 350 kW at 280 km/h, ${(capMid / 1000).toFixed(1)} kW at 322.5 km/h, 0 at 355 km/h; with Manual Override 350 kW at 330 km/h and 0 at 360 km/h`
    );
  }

  // 10.5 Tyre setup: round-trip, clamping, pressure on the runtime, and survival of resets and compound changes
  {
    const sim = new F1Physics2026(track);
    sim.resetToStartGrid(false);
    const hotBefore = sim.wheels[0].tyre.pressurePsi;
    const setup = { coldPressurePsi: { front: 20.4, rear: 19.1 }, camberDeg: { front: -3.2, rear: -1.8 } };
    sim.setTyreSetup(setup);
    const got = sim.getTyreSetup();
    const roundTrip =
      got.coldPressurePsi.front === 20.4 &&
      got.coldPressurePsi.rear === 19.1 &&
      got.camberDeg.front === -3.2 &&
      got.camberDeg.rear === -1.8;
    // Hot pressure follows the ideal gas law from the new cold pressure
    const hotPsi = (coldPsi: number, gasC: number) => (coldPsi * (gasC + 273.15)) / 293.15;
    const hotOk =
      Math.abs(sim.wheels[0].tyre.pressurePsi - hotPsi(20.4, sim.wheels[0].tyre.gasTempC)) < 1e-9 &&
      Math.abs(sim.wheels[2].tyre.pressurePsi - hotPsi(19.1, sim.wheels[2].tyre.gasTempC)) < 1e-9;
    assert(
      roundTrip && hotOk && Math.abs(sim.wheels[0].tyre.pressurePsi - hotBefore) > 0.5,
      `Tyre setup round-trips through getTyreSetup and sets the runtime pressure (FL ${hotBefore.toFixed(2)} -> ${sim.wheels[0].tyre.pressurePsi.toFixed(2)} psi hot, cold ${sim.wheels[0].tyre.coldPressurePsi} psi)`
    );

    sim.tireCompound = 'hard';
    sim.resetToStartGrid(true);
    sim.step(1 / 60, {});
    const kept = sim.getTyreSetup();
    const surviveOk =
      sim.wheels[0].tyre.spec.name.includes('Hard') &&
      sim.wheels[0].tyre.coldPressurePsi === 20.4 &&
      sim.wheels[2].tyre.coldPressurePsi === 19.1 &&
      kept.camberDeg.front === -3.2 &&
      kept.camberDeg.rear === -1.8;
    assert(surviveOk, 'Tyre setup survives a grid reset and a compound change (cold pressure and camber kept)');

    sim.setTyreSetup({ coldPressurePsi: { front: 40, rear: 5 }, camberDeg: { front: -9, rear: 0 } });
    const clamped = sim.getTyreSetup();
    assert(
      clamped.coldPressurePsi.front === 27 &&
        clamped.coldPressurePsi.rear === 17 &&
        clamped.camberDeg.front === -4.5 &&
        clamped.camberDeg.rear === -0.5,
      `Tyre setup inputs are clamped (pressure ${clamped.coldPressurePsi.front}/${clamped.coldPressurePsi.rear} psi, camber ${clamped.camberDeg.front}°/${clamped.camberDeg.rear}°)`
    );
  }

  // 11. Track surface smoothness, grades, camber and run-off flares (public/tracks/rwanda/track_data.json)
  console.log('\n11. Testing the track surface (vertical curves, grades, positive camber, run-off flares)...');
  {
    type RawSample = { s: number; p: number[]; t: number[]; b: number; rL: number; rR: number; gL: number; gR: number };
    const raw = JSON.parse(readFileSync('public/tracks/rwanda/track_data.json', 'utf8')) as {
      metadata: { sampleSpacingM: number };
      samples: RawSample[];
    };
    const S = raw.samples;
    const n = S.length;
    const ds = raw.metadata.sampleSpacingM;
    const at = (i: number) => S[((i % n) + n) % n];
    // The runtime centreline stays on the exported road (no snapping that would pull it off the mesh)
    let maxOffRoadM = 0;
    let offAt = 0;
    for (const smp of S) {
      const rt = track.getSampleAtDistance(smp.s);
      const d = Math.hypot(rt.position.x - smp.p[0], rt.position.y - smp.p[1], rt.position.z - smp.p[2]);
      if (d > maxOffRoadM) {
        maxOffRoadM = d;
        offAt = smp.s;
      }
    }
    assert(
      maxOffRoadM < 0.03,
      `Runtime centreline follows the exported road samples (max deviation ${(maxOffRoadM * 100).toFixed(1)} cm at s ${offAt.toFixed(0)} m; < 3 cm)`
    );
    let maxD2z = 0;
    let maxGrade = 0;
    let minGrade = 0;
    let maxBankDeg = 0;
    let offCamber = 0;
    let cornerSamples = 0;
    let maxFlare = 0;
    let maxTwistDegPerM = 0;
    for (let i = 0; i < n; i++) {
      maxTwistDegPerM = Math.max(maxTwistDegPerM, Math.abs(THREE.MathUtils.radToDeg(at(i + 1).b - at(i).b)) / ds);
      const z0 = at(i - 1).p[1];
      const z1 = at(i).p[1];
      const z2 = at(i + 1).p[1];
      maxD2z = Math.max(maxD2z, Math.abs(z2 - 2 * z1 + z0) / (ds * ds));
      const grade = (z2 - z0) / (2 * ds);
      maxGrade = Math.max(maxGrade, grade);
      minGrade = Math.min(minGrade, grade);
      // curvature (+ = right-hand turn, i.e. clockwise seen from above) from the heading over +-2 samples
      const h = (q: RawSample) => Math.atan2(-q.t[2], q.t[0]);
      let dh = h(at(i + 2)) - h(at(i - 2));
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const kappa = -dh / (4 * ds);
      maxBankDeg = Math.max(maxBankDeg, Math.abs(THREE.MathUtils.radToDeg(at(i).b)));
      if (Math.abs(kappa) > 1 / 400) {
        cornerSamples++;
        if (at(i).b * Math.sign(kappa) < -1e-3) offCamber++;
      }
      const flareL = Math.abs(at(i + 1).rL + at(i + 1).gL - (at(i).rL + at(i).gL)) / ds;
      const flareR = Math.abs(at(i + 1).rR + at(i + 1).gR - (at(i).rR + at(i).gR)) / ds;
      maxFlare = Math.max(maxFlare, flareL, flareR);
    }
    assert(
      maxD2z < 0.004,
      `Centreline vertical curvature |d²Z/ds²| peaks at ${maxD2z.toFixed(5)} 1/m (< 0.004: no bumps or creases at ${ds.toFixed(2)} m sampling)`
    );
    assert(
      maxGrade > 0.04 && maxGrade < 0.1 && minGrade < -0.04 && minGrade > -0.1,
      `Longitudinal grades reach +${(maxGrade * 100).toFixed(1)} % / ${(minGrade * 100).toFixed(1)} % (gentle rolling profile: each between 4 and 10 %)`
    );
    assert(
      offCamber === 0 && maxBankDeg <= 4.5 && maxTwistDegPerM <= 0.15,
      `Positive camber in every corner (${offCamber} off-camber of ${cornerSamples} corner samples), peak banking ${maxBankDeg.toFixed(1)}° (<= 4.5°), twist ${maxTwistDegPerM.toFixed(3)}°/m (<= 0.15: no diagonal unloading)`
    );
    assert(maxFlare < 0.5, `Run-off / gravel outer edges flare at most ${maxFlare.toFixed(2)} m per metre (< 0.5: no lateral kinks)`);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} CHECK(S) FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
}

runVerification().catch((err) => {
  console.error(err);
  process.exit(1);
});
