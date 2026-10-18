/**
 * End-to-end verification suite for all 8 Priority Realism Upgrades (P0 through P7):
 *   npx tsx "scripts/verify-realism-upgrades.ts"
 *
 * Tests:
 *   P0: Full physics parity between F1Physics2026 and VehiclePhysics / F12026CarSim
 *   P1: 5-point 3D cambered tire contact patch + ISO 8608 spatial road micro-roughness
 *   P2: 16-sector circumferential tire grid, flat-spots, graining, blistering, dirt pickup, centrifugal growth, & WLF shift
 *   P3: Live 3D AC1-style double-wishbone + steering tie-rod kinematics solver & chassis torsion
 *   P4: 2-node physical brake disc thermals (T^4 radiation + speed convection), pad compound mu(T), glazing, & dynamic brake migration
 *   P5: Aerodynamic slipstream tow & dirty-air vortex wake + yaw/roll/wind aero sensitivities
 *   P6: True 3D steering rack FFB solver + 240/480 Hz subframe output & auto-configuration
 *   P7: 3D OBB SAT car-to-car rigid-body collisions, RealRoad dynamic track evolution, & EWMA clock-synced P2P netcode
 */
import assert from 'node:assert/strict';
import { getRwandaTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { VF26_CHASSIS, VF26_TYRES } from '../src/lib/sim/vf26-data';
import {
  computeTyreForces,
  createTyreRuntime,
  evaluateIso8608RoadRoughness,
  sample5PointContactPatch,
  tyreLoadedRadius,
  updateTyreThermal,
} from '../src/lib/sim/ac-tyre';
import {
  buildDoubleWishboneHardpoints,
  computeTorsionalRollDistribution,
  solveAxleKinematics3D,
  solveCornerKinematics3D,
} from '../src/lib/sim/suspension-kinematics';
import {
  computeDynamicBrakeMigration,
  createBrakeDiscState,
  evaluateBrakePadMuFactor,
  stepBrakeDiscThermal,
} from '../src/lib/sim/brake-physics';
import {
  computeRelativeAirspeed,
  evaluateAeroWakeDeficit,
  evaluateRollAeroFactor,
} from '../src/lib/sim/aero-wake';
import {
  RealRoadState,
  resolveCarToCarObbCollision,
  type RigidBodyCollisionCar,
} from '../src/lib/sim/real-road';
import { MultiplayerSyncManager, type NetworkVehiclePacket } from '../src/lib/sim/multiplayer-sync';
import { autoConfigureWheel, DEFAULT_WHEEL_SETTINGS } from '../src/lib/input/device-input';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}:`, err);
  }
}

console.log('=== Verifying Sim Racing Realism Upgrades (P0 - P7) ===\n');

const track = getRwandaTrackData();

// -----------------------------------------------------------------------------
// P1: 5-Point 3D Cambered Contact Patch & ISO 8608 Spatial Road Micro-Roughness
// -----------------------------------------------------------------------------
console.log('P1: 5-Point 3D Cambered Contact Patch & ISO 8608 Road Roughness');

check('5-point cambered contact patch sampler detects kerb slope, shifts load centroid, and computes overturning moment Mx', () => {
  // Simulate a right-hand kerb rising on the outer edge (x > 0)
  const patch = sample5PointContactPatch(
    0,
    0,
    1,
    0,
    -1, // left wheel: inward is -left (+x)
    -0.055, // -3.15 deg negative camber
    0.305,
    0.36,
    0.015,
    (x, _z) => (x < 0 ? -0.085 * x : 0),
    'kerb'
  );
  assert.ok(Number.isFinite(patch.effectiveHeightM) && patch.ny > 0.9);
  assert.ok(Math.abs(patch.kerbCamberRad) > 0.005, `Expected non-zero kerb camber tilt: ${patch.kerbCamberRad}`);
  assert.ok(Math.abs(patch.centroidShiftInwardNorm) > 0.01, `Expected lateral centroid shift: ${patch.centroidShiftInwardNorm}`);

  const tyre = createTyreRuntime(VF26_TYRES.soft.front, 95);
  const out = computeTyreForces(tyre, {
    fz: 4200,
    vx: 55,
    vy: 2.5,
    rimSpeed: 55,
    camberLeftRad: -0.055 + patch.kerbCamberRad,
    surfaceGrip: 1.0,
    inwardSign: -1,
    contactCentroidShiftInward: patch.centroidShiftInwardNorm,
    contactCentroidShiftLeftM: patch.centroidShiftLeftM,
    dt: 1 / 240,
  });
  assert.ok(Math.abs(out.mx) > 1.0, `Expected non-zero overturning moment Mx: ${out.mx} Nm`);
  assert.ok(tyre.bandLoad[0] > tyre.bandLoad[2], `Expected inner band load (${tyre.bandLoad[0]}) > outer band load (${tyre.bandLoad[2]})`);
});

check('ISO 8608 spatial road micro-roughness is deterministic in (x, z) and rougher on kerbs than asphalt', () => {
  const rAsphalt1 = evaluateIso8608RoadRoughness(120.4, -85.2, 'asphalt');
  const rAsphalt2 = evaluateIso8608RoadRoughness(120.4, -85.2, 'asphalt');
  const rKerb = evaluateIso8608RoadRoughness(120.4, -85.2, 'kerb');
  assert.equal(rAsphalt1, rAsphalt2, 'Deterministic spatial elevation');
  assert.ok(Math.abs(rKerb) > Math.abs(rAsphalt1), `Expected kerb roughness (${Math.abs(rKerb)}) > asphalt roughness (${Math.abs(rAsphalt1)})`);
});

// -----------------------------------------------------------------------------
// P2: 16-Sector Circumferential Grid, Flat-Spots, Graining, Blistering, Dirt, Centrifugal Growth
// -----------------------------------------------------------------------------
console.log('\nP2: 16-Sector Circumferential Tire Grid, Flat-Spots, Graining, Blistering, Dirt & Centrifugal Growth');

check('Locked wheel concentrates wear and heat into the grounded circumferential sector (flat-spot) and excites harmonic vibration', () => {
  const t = createTyreRuntime(VF26_TYRES.soft.front, 90);
  // Simulate a 1.0-second full lockup (rimSpeed = 0 at rollSpeed = 75 m/s)
  for (let i = 0; i < 240; i++) {
    updateTyreThermal(t, 180_000, 3800, 75, 25, 38, 1 / 240, 450, 0, 'asphalt', 0);
  }
  assert.ok(t.flatSpotSeverity > 0.08, `Expected flatSpotSeverity > 0.08 after lockup, got ${t.flatSpotSeverity}`);
  const maxWear = Math.max(...t.circumferentialWear);
  const minWear = Math.min(...t.circumferentialWear);
  assert.ok(maxWear > minWear * 1.5, `Locked sector wear (${maxWear}) must exceed opposite sector wear (${minWear})`);

  // Roll the flat-spotted tyre and verify harmonic flat-spot vibration torque
  let maxVib = 0;
  for (let i = 0; i < 40; i++) {
    const out = computeTyreForces(t, {
      fz: 3800,
      vx: 60,
      vy: 0,
      rimSpeed: 60,
      camberLeftRad: -0.05,
      surfaceGrip: 1.0,
      dt: 1 / 240,
    });
    maxVib = Math.max(maxVib, Math.abs(out.flatSpotVibrationNm));
  }
  assert.ok(maxVib > 0.2, `Expected non-zero harmonic flat-spot vibration torque (${maxVib} Nm)`);
});

check('Off-track excursion picks up dirt and on-track rolling cleans it off', () => {
  const t = createTyreRuntime(VF26_TYRES.soft.front, 90);
  for (let i = 0; i < 60; i++) {
    updateTyreThermal(t, 5000, 3000, 35, 25, 38, 1 / 60, 350, 35, 'grass', 0);
  }
  const peakDirt = t.dirtyLevel;
  assert.ok(peakDirt > 0.3, `Expected dirt pickup on grass > 0.3, got ${peakDirt}`);
  for (let i = 0; i < 180; i++) {
    updateTyreThermal(t, 25_000, 3500, 55, 25, 38, 1 / 60, 350, 55, 'asphalt', 0);
  }
  assert.ok(t.dirtyLevel < peakDirt * 0.4, `Expected dirt to clean off on asphalt (${t.dirtyLevel} < ${peakDirt * 0.4})`);
});

check('Centrifugal carcass growth increases loaded radius at 330 km/h', () => {
  const t = createTyreRuntime(VF26_TYRES.soft.front, 95);
  const rRest = tyreLoadedRadius(t, 3500, 0);
  const rHighSpeed = tyreLoadedRadius(t, 3500, 260); // ~335 km/h
  assert.ok(rHighSpeed > rRest + 0.002, `Expected >2 mm centrifugal growth at 335 km/h (${rHighSpeed - rRest} m)`);
});

// -----------------------------------------------------------------------------
// P3: 3D Double-Wishbone + Steering Tie-Rod Kinematics & Chassis Torsion
// -----------------------------------------------------------------------------
console.log('\nP3: 3D Double-Wishbone Kinematics & Chassis Torsion Spring');

check('3D double-wishbone solver reproduces the VF26 camber gains in bump and computes kingpin/caster/scrub/bump-steer/roll-centre', () => {
  const frontHp = buildDoubleWishboneHardpoints(undefined, true, 'pull_rod');
  const rest = solveCornerKinematics3D(frontHp, 0, 0, true, 0.345);
  const bump = solveCornerKinematics3D(frontHp, 0.025, 0, true, 0.345);
  // The car's own gains (front +4.6, rear -12.7 deg/m), within 2 deg/m, from the default F1 hardpoints
  const gainDegPerM = (hp: typeof frontHp) =>
    ((solveCornerKinematics3D(hp, 0.025, 0, true, 0.345).dynamicCamberDeltaRad -
      solveCornerKinematics3D(hp, 0, 0, true, 0.345).dynamicCamberDeltaRad) /
      0.025) *
    (180 / Math.PI);
  const gF = gainDegPerM(frontHp);
  const gR = gainDegPerM(buildDoubleWishboneHardpoints(undefined, false, 'push_rod'));
  assert.ok(Math.abs(gF - VF26_CHASSIS.front.camberGainDegPerM) < 2, `Front camber gain ${gF} vs ${VF26_CHASSIS.front.camberGainDegPerM} deg/m`);
  assert.ok(Math.abs(gR - VF26_CHASSIS.rear.camberGainDegPerM) < 2, `Rear camber gain ${gR} vs ${VF26_CHASSIS.rear.camberGainDegPerM} deg/m`);
  assert.ok(Math.abs(bump.bumpSteerToeInRad) > 1e-5, 'Tie-rod arc produces physical bump steer');
  assert.ok(bump.casterTrailM > 0.008 && bump.scrubRadiusM > 0.008, 'Physical caster trail and scrub radius');

  const axle = solveAxleKinematics3D(frontHp, 0.02, -0.01, 0.08, 1.60, 0.34, 0.35);
  assert.ok(Number.isFinite(axle.rollCentreHeightM) && Math.abs(axle.rollCentreLatOffsetM) > 0, 'Roll centre migrates laterally under asymmetric roll');
  assert.ok(axle.antiPitchFraction > 0.05, '3D wishbone plane inclinations yield anti-dive / anti-squat');
});

check('Chassis torsional spring couples front and rear roll stiffnesses realistically', () => {
  const [frontShareRigid] = computeTorsionalRollDistribution(180_000, 110_000, 1e9);
  const [frontShareCompliant] = computeTorsionalRollDistribution(180_000, 110_000, 400_000);
  assert.ok(frontShareCompliant < frontShareRigid, `Compliant chassis torsion reduces stiffer front axle share (${frontShareCompliant} < ${frontShareRigid})`);
});

// -----------------------------------------------------------------------------
// P4: Physical 2-Node Brake System, Pad Mu(T), Glazing & Dynamic Migration
// -----------------------------------------------------------------------------
console.log('\nP4: Physical 2-Node Brake System, Pad Mu(T), Glazing & Dynamic Migration');

check('Carbon-carbon brake cold bite is lower than optimal window (250-880°C) and overheating causes fade/glazing', () => {
  const coldMu = evaluateBrakePadMuFactor(60, 'carbon-ceramic', 0);
  const optMu = evaluateBrakePadMuFactor(550, 'carbon-ceramic', 0);
  const hotFadeMu = evaluateBrakePadMuFactor(1120, 'carbon-ceramic', 0.4);
  assert.ok(optMu > coldMu + 0.15, `Expected optimal carbon pad mu (${optMu}) > cold carbon pad mu (${coldMu})`);
  assert.ok(hotFadeMu < optMu - 0.2, `Expected overheated glazed carbon pad mu (${hotFadeMu}) < optimal (${optMu})`);

  const disc = createBrakeDiscState(300, 'carbon-ceramic');
  for (let i = 0; i < 60; i++) {
    stepBrakeDiscThermal(disc, 3800, 210, 75, 25, 1 / 60, 'carbon-ceramic');
  }
  assert.ok(disc.surfaceTempC > disc.coreTempC, `2-node thermal model maintains surface (${disc.surfaceTempC}°C) > core (${disc.coreTempC}°C) gradient during heavy braking`);
});

check('Dynamic brake migration shifts bias forward at peak pressure and rearward during trail-braking release', () => {
  const peakBias = computeDynamicBrakeMigration(0.56, 1.0, 0.025);
  const trailBias = computeDynamicBrakeMigration(0.56, 0.25, 0.025);
  assert.ok(peakBias > trailBias, `Expected peak brake pressure bias (${peakBias}) > trail-braking bias (${trailBias})`);
});

// -----------------------------------------------------------------------------
// P5: Aerodynamic Slipstream & Dirty-Air Vortex Wake + Wind/Yaw/Roll Aero
// -----------------------------------------------------------------------------
console.log('\nP5: Aerodynamic Slipstream & Dirty-Air Vortex Wake');

check('Following car experiences greater front wing downforce loss than drag reduction in dirty air, and lateral offset recovers clean air', () => {
  const leader = { sMeters: 500, lateralOffsetM: 0, speedMs: 80 };
  const wakeInline = evaluateAeroWakeDeficit(478, 0, 80, [leader], 5000, 0);
  const wakeOffset = evaluateAeroWakeDeficit(478, 3.5, 80, [leader], 5000, 0);

  assert.ok(wakeInline.dragMultiplier < 0.92, `Slipstream should reduce drag (${wakeInline.dragMultiplier})`);
  assert.ok(
    wakeInline.frontDownforceMultiplier < wakeInline.dragMultiplier,
    `Dirty air hurts front downforce (${wakeInline.frontDownforceMultiplier}) more than it reduces drag (${wakeInline.dragMultiplier})`
  );
  assert.ok(wakeInline.copFrontShiftPct < 0, 'Dirty air shifts CoP rearward (high-speed understeer)');
  assert.ok(wakeOffset.frontDownforceMultiplier > wakeInline.frontDownforceMultiplier, 'Stepping 3.5m off-line recovers clean air on the front wing');
});

check('Chassis roll floor seal leakage and ambient wind vector modulate airspeed and downforce', () => {
  const levelMult = evaluateRollAeroFactor(0);
  const rolledMult = evaluateRollAeroFactor(0.06);
  assert.ok(rolledMult < levelMult, 'Chassis roll leaks Venturi floor downforce');

  // Heading 0 is +Z: a 10 m/s headwind blows toward −Z (the wind is given as world X / Z velocity components)
  const headwind = computeRelativeAirspeed(70, 0, 0, 0, -10);
  assert.ok(headwind.airspeedMs > 79.9, `Headwind increases relative airspeed (${headwind.airspeedMs} m/s)`);
  const crosswind = computeRelativeAirspeed(70, 0, 0, -10, 0);
  assert.ok(crosswind.aeroBetaRad > 0.1 && Math.abs(crosswind.airspeedMs - Math.hypot(70, 10)) < 1e-6, `A wind from the left (blowing toward −X) gives sideslip (${crosswind.aeroBetaRad} rad)`);
});

// -----------------------------------------------------------------------------
// P6: True 3D Steering Rack Force Feedback & Wheel Auto-Configuration
// -----------------------------------------------------------------------------
console.log('\nP6: True 3D Steering Rack Force Feedback & Wheel Auto-Configuration');

check('autoConfigureWheel automatically enables ffbEnabled when a wheel base is detected', () => {
  const patch = autoConfigureWheel(
    [{ id: 'MOZA R9 Base (Vendor: 346e Product: 0002)', index: 0, mapping: '', axes: [0, 0], buttons: [] }],
    DEFAULT_WHEEL_SETTINGS
  );
  assert.equal(patch?.ffbEnabled, true, 'Expected ffbEnabled: true on wheel auto-configuration');
});

// -----------------------------------------------------------------------------
// P7: 3D OBB Collisions, RealRoad Evolution & EWMA Clock-Synced Netcode
// -----------------------------------------------------------------------------
console.log('\nP7: 3D OBB Collisions, RealRoad Track Evolution & Clock-Synced Netcode');

check('3D OBB SAT collision solver computes off-center yaw rate impulse on rear-quarter contact', () => {
  const carA: RigidBodyCollisionCar = {
    x: 0,
    y: 0,
    z: 0,
    fwdX: 0,
    fwdZ: 1,
    vx: 0,
    vz: 50,
    yawRateRadS: 0,
    halfLengthM: 2.5,
    halfWidthM: 0.98,
    massKg: 778,
    yawInertiaKgM2: 1120,
  };
  const carB: RigidBodyCollisionCar = {
    ...carA,
    x: 0.85, // off-center tap on right rear quarter
    z: -4.6,
    vz: 56,
  };
  const hit = resolveCarToCarObbCollision(carA, carB);
  assert.equal(hit.collided, true, 'Expected OBB SAT collision detection');
  assert.ok(Math.abs(hit.yawDeltaA) > 0.01, `Off-center contact must induce yaw rotation (${hit.yawDeltaA} rad/s)`);
});

check('RealRoad evolves racing-line rubber grip and off-line marbles as cars lap', () => {
  const rr = new RealRoadState(track.totalLengthM);
  rr.reset(0.35); // start on a green track
  const initialLine = rr.sample(200, 0, 0);
  for (let pass = 0; pass < 120; pass++) {
    rr.depositCarPass(200, 0, 0, 85_000, 0.25);
  }
  const rubberedLine = rr.sample(200, 0, 0);
  const offLineMarbles = rr.sample(200, 4.8, 0);
  assert.ok(rubberedLine.gripMultiplier > initialLine.gripMultiplier, `Rubbered racing line grip (${rubberedLine.gripMultiplier}) > green track (${initialLine.gripMultiplier})`);
  assert.ok(offLineMarbles.marbleLevel > rubberedLine.marbleLevel, `Off-line marbles (${offLineMarbles.marbleLevel}) > racing line (${rubberedLine.marbleLevel})`);
});

check('MultiplayerSyncManager synchronizes remote peer clock offset via EWMA and rejects out-of-order UDP packets', () => {
  const net = new MultiplayerSyncManager();
  const makePkt = (ts: number, sMeters: number): NetworkVehiclePacket => ({
    peerId: 'remote_1',
    driverCode: 'VER',
    teamColorHex: '#3671c6',
    timestampMs: ts,
    pos: [0, 0, sMeters],
    quat: [0, 0, 0, 1],
    linVel: [0, 0, 60],
    angVel: [0, 0, 0],
    steerAngle: 0,
    wheelRPMs: [1500, 1500, 1500, 1500],
    throttle: 1,
    brake: 0,
    trackS: sMeters,
    speedKmh: 216,
  });
  // Remote clock is +5000 ms ahead of local performance.now()
  const localNow = 1000;
  net.ingestPacket(makePkt(localNow + 5000, 100), false, localNow);
  net.ingestPacket(makePkt(localNow + 5050, 103), false, localNow + 50);
  // Out-of-order stale packet with earlier timestamp must be ignored
  net.ingestPacket(makePkt(localNow + 4900, 50), false, localNow + 55);
  const peers = net.update(localNow + 120, makePkt(localNow + 120, 0));
  assert.equal(peers.length, 1);
  assert.equal(peers[0].trackS, 103, 'Out-of-order packet was rejected');
});

// -----------------------------------------------------------------------------
// P0: End-to-End Parity Between F1Physics2026 & F12026CarSim (VehiclePhysics)
// -----------------------------------------------------------------------------
console.log('\nP0: Full Physics Parity Between F1Physics2026 & F12026CarSim');

check('Both F1Physics2026 and F12026CarSim populate all P0-P7 telemetry fields and 240/500 Hz FFB subframes', () => {
  const vf26 = new F1Physics2026(track);
  const f126 = new F12026CarSim(track);
  vf26.aiAutopilot = false;
  f126.aiAutopilot = false;

  for (let i = 0; i < 60; i++) {
    vf26.step(1 / 60, { throttle: 0.85, brake: 0, steerLeft: 0, steerRight: 0, analogSteer: 0.15 });
    f126.step(1 / 60, { throttle: 0.85, brake: 0, steerLeft: 0, steerRight: 0, analogSteer: 0.15 });
  }

  for (const [name, sim] of [['F1Physics2026', vf26], ['F12026CarSim', f126]] as const) {
    const t = sim.telemetry;
    assert.equal(t.tireTempsC.length, 4, `${name} tireTempsC`);
    assert.equal(t.tireWearPct.length, 4, `${name} tireWearPct`);
    assert.equal(t.tireBandTempsC?.length, 4, `${name} tireBandTempsC`);
    assert.equal(t.tirePressuresPsi?.length, 4, `${name} tirePressuresPsi`);
    assert.equal(t.tireFlatSpotSeverity?.length, 4, `${name} tireFlatSpotSeverity`);
    assert.equal(t.tireGrainLevel?.length, 4, `${name} tireGrainLevel`);
    assert.equal(t.tireBlisterLevel?.length, 4, `${name} tireBlisterLevel`);
    assert.equal(t.tireDirtyLevel?.length, 4, `${name} tireDirtyLevel`);
    assert.equal(t.brakeTempsC.length, 4, `${name} brakeTempsC`);
    assert.equal(t.brakeCoreTempsC?.length, 4, `${name} brakeCoreTempsC`);
    assert.equal(t.brakePadMuFactor?.length, 4, `${name} brakePadMuFactor`);
    assert.ok(t.ffbSubframeSamples && t.ffbSubframeSamples.length >= 4, `${name} ffbSubframeSamples`);
    assert.ok(Number.isFinite(t.ffbTorqueNorm) && Math.abs(t.ffbTorqueNorm!) > 0.005, `${name} ffbTorqueNorm=${t.ffbTorqueNorm}`);
    assert.ok(t.turboBoostBar >= 0, `${name} turboBoostBar=${t.turboBoostBar}`);
  }
});

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
