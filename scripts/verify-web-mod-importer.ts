/**
 * Unit verification suite for Assetto Corsa Web Mod Importer modules (Phase 1).
 * Run: npx tsx scripts/verify-web-mod-importer.ts
 */

import * as THREE from 'three';
import {
  packedDataKey,
  decryptDataAcd,
  parseIni,
  parseLut,
  parseInlineLut,
  AcModData,
} from '../src/lib/mods/ac-data-decrypt';
import { mapAcPhysics } from '../src/lib/mods/ac-physics-mapper';
import { peakDriveSlipRatio } from '../src/lib/mods/ac-tyre-shape';
import { parseKn5, buildKn5Scene, createTexture, type Kn5Model } from '../src/lib/mods/kn5-loader';
import { planKn5Appearance } from '../src/lib/mods/kn5-appearance';
import { isCspProtectedKn5Blob, ProtectedKn5Error, readCspKn5Footer } from '../src/lib/mods/kn5-protection';
import { rebuildCspKn5 } from '../src/lib/mods/kn5-csp-rebuild';
import { albedoDds, bakeAlbedo, rgbaTexture, texturePixels, type Rgba } from '../src/lib/mods/ac-albedo';
import { parseCspAppearance } from '../src/lib/mods/csp-appearance';
import {
  createCustomSimProfile,
  createDynamicVehicleModel,
  createCustomCarDefinition,
  selectedCustomCarActionForRegistryChange,
  getCustomCarSkinRecord,
  registerCustomCarMod,
  sanitizeCarPhysics,
  unregisterCustomCarMod,
} from '../src/lib/mods/dynamic-vehicle';
import { wingAngleOfAttack } from '../src/lib/sim/f12026-car/wing-angle';
import { ImportedController } from '../src/lib/sim/f12026-car/imported-controller';
import { aeroReadout } from '../src/components/hud/aero-label';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { Lut } from '../src/lib/sim/lut';
import {
  unpack7z,
  unpackZip,
  analyzeCarPackage,
  importAssettoCorsaMod,
  customCarIdForSlug,
  isEssentialModFile,
  readDroppedFiles,
  type ModFolderFile,
} from '../src/lib/mods/mod-extractor';
import {
  getAllCustomCars,
  getCustomCar,
  saveCustomCar,
  deleteCustomCar,
  type CustomCarRecord,
} from '../src/lib/mods/mod-store';
import { getRegisteredCars, carById, carSkinBaseUrl, portedSkinFor, type CarDefinition } from '../src/lib/cars/car-registry';
import { setCarSkin } from '../src/lib/cars/car-skins';
import { vehicleModelSpec, vehicleModelsFor } from '../src/lib/cars/vehicle-models';
import { CAR_WHEEL_LOCKS_DEG, carWheelLockDeg, wheelRimAngleDeg, wheelSteerValue } from '../src/lib/input/device-input';
import { softLockForce } from '../src/lib/input/wheel-ffb';
import { unregisterCarRevRange } from '../src/lib/sim/rev-range';
import { challengeCompound, challengeConditionsLabel } from '../src/lib/net/weekly-challenge';
import { createPortedCarRig, loadTemplate } from '../src/lib/ported-car-model';
import { staticFloorOf } from '../src/lib/render/body-floor';
import { OnboardViews } from '../src/lib/render/onboard-views';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { turboBoostAsked, turboSteadyBoost } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { LC26_SIM_PROFILE } from '../src/lib/sim/f12026-car/Lc26Sim';
import { getActiveTrackData, RWANDA_DRS_ZONES } from '../src/lib/track-data';
import { createFlatTestTrack } from './lib/flat-track';
import { loadGlbGeometry } from './lib/glb-geometry';
import { measureUpshift } from './lib/upshift-test';
import { createCspKn5Fixture, wrapCspKn5 } from './lib/csp-kn5-fixture';
import * as fflate from 'fflate';
import * as fs from 'fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. ac-data-decrypt tests
// ---------------------------------------------------------------------------
console.log('\n--- Testing ac-data-decrypt ---');

const keyLiana = packedDataKey('suzuki_liana');
assert(Array.isArray(keyLiana) && keyLiana.length > 0, 'packedDataKey generates key array');

// Create a synthetic encrypted data.acd buffer
function createEncryptedAcd(files: Record<string, string>, folderName: string): Uint8Array {
  const key = packedDataKey(folderName);
  const chunks: Uint8Array[] = [];

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const header = new Uint8Array(4 + nameBytes.length + 4);
    const view = new DataView(header.buffer);
    view.setInt32(0, nameBytes.length, true);
    header.set(nameBytes, 4);
    view.setInt32(4 + nameBytes.length, text.length, true);
    chunks.push(header);

    const body = new Uint8Array(text.length * 4);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const k = key[i % key.length];
      const encryptedByte = (charCode + k) & 0xff;
      body[i * 4] = encryptedByte;
    }
    chunks.push(body);
  }

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const mockFiles = {
  'car.ini': `
[INFO]
SCREEN_NAME=Test Mod Car

[BASIC]
TOTALMASS=1150
INERTIA=1.7,1.2,4.1

[CONTROLS]
STEER_LOCK=450
STEER_RATIO=15
`,
  'engine.ini': `
[ENGINE_DATA]
MINIMUM=850
LIMITER=7200
LIMITER_HZ=40
INERTIA=0.18

[COAST_REF]
RPM=7000
TORQUE=75
`,
  'power.lut': `
0|0
1000|120
2500|200
4000|250
6000|220
7200|180
`,
  'suspensions.ini': `
[BASIC]
WHEELBASE=2.55
CG_LOCATION=0.55

[FRONT]
TRACK=1.48
SPRING_RATE=45000
ROD_LENGTH=0.08
PACKER_RANGE=0.12
BUMPSTOP_UP=0.07
BUMPSTOP_DN=0.07
BASEY=-0.14
HUB_MASS=40
TYPE=STRUT

[REAR]
TRACK=1.48
SPRING_RATE=35000
ROD_LENGTH=0.06
PACKER_RANGE=0.12
BUMPSTOP_UP=0.06
BUMPSTOP_DN=0.06
BASEY=-0.14
HUB_MASS=38
TYPE=DWB

[ARB]
FRONT=25000
REAR=15000
`,
  'tyres.ini': `
[HEADER]
VERSION=10

[FRONT]
NAME=Street 205/55
WIDTH=0.205
RADIUS=0.315
RIM_RADIUS=0.203
RATE=210000
PRESSURE_IDEAL=32
FZ0=3500
FRICTION_LIMIT_ANGLE=9.5
`,
};

const encryptedAcd = createEncryptedAcd(mockFiles, 'test_car');
const decryptedMap = decryptDataAcd(encryptedAcd, 'test_car');

assert(decryptedMap.has('car.ini'), 'decryptedMap has car.ini');
assert(decryptedMap.has('engine.ini'), 'decryptedMap has engine.ini');
assert(decryptedMap.has('power.lut'), 'decryptedMap has power.lut');

const modData = new AcModData(decryptedMap);
assert(modData.present, 'AcModData is present');
assert(modData.text('car.ini', 'INFO', 'SCREEN_NAME') === 'Test Mod Car', 'AcModData parses screen name');
assert(modData.num('car.ini', 'BASIC', 'TOTALMASS') === 1150, 'AcModData parses numeric field');
assert(modData.vec('car.ini', 'BASIC', 'INERTIA').length === 3, 'AcModData parses vector field');

const lut = modData.lut('power.lut');
assert(lut.length === 6 && lut[0][0] === 0 && lut[3][1] === 250, 'AcModData parses LUT table');

const inlineLut = parseInlineLut('(0=10|100=20|200=30)');
assert(inlineLut.length === 3 && inlineLut[1][1] === 20, 'parseInlineLut parses correctly');

// ---------------------------------------------------------------------------
// 2. ac-physics-mapper tests
// ---------------------------------------------------------------------------
console.log('\n--- Testing ac-physics-mapper ---');

const physicsConfig = mapAcPhysics(modData);

assert(physicsConfig.screenName === 'Test Mod Car', 'screenName mapped');
assert(physicsConfig.chassis.totalMassKg === 1150, 'totalMassKg mapped');
assert(physicsConfig.chassis.wheelbase === 2.55, 'wheelbase mapped');
assert(physicsConfig.chassis.frontWeightFraction === 0.55, 'frontWeightFraction mapped');
assert(physicsConfig.engine.idleRpm === 850, 'idleRpm mapped');
assert(physicsConfig.gearbox.gears.redline_rpm === 7200, 'redline_rpm mapped');
assert(physicsConfig.suspensions.front.type === 'SuspensionType_Strut', 'front suspension is Strut');
assert(physicsConfig.suspensions.rear.type === 'SuspensionType_DoubleWishbone', 'rear suspension is DoubleWishbone');
assert(physicsConfig.tyreCompounds.PhysicsTyreCompound_Road_Street !== undefined, 'tyreCompounds mapped');
assert(physicsConfig.tyreCompounds.PhysicsTyreCompound_Road_Street?.front.radius === 0.315, 'tyre radius mapped');

console.log('\n--- Testing AC turbo boost from zero reference RPM ---');
const turboFixture = (referenceRpm: number) => mapAcPhysics(new AcModData({
  ...mockFiles,
  'engine.ini': `${mockFiles['engine.ini']}\n[TURBO_0]\nMAX_BOOST=0.35\nREFERENCE_RPM=${referenceRpm}\nGAMMA=5\n`,
  'power.lut': mockFiles['power.lut'].replace('0|0', '0|30'),
}));
const zeroRefEngine = turboFixture(0).engine;
const zeroRefTurbo = zeroRefEngine.turbo!;
assert(zeroRefEngine.powerCurve[0][1] === 0 && zeroRefEngine.powerCurve.every(([, kw]) => Number.isFinite(kw)),
  'a zero-reference turbo and a 0 RPM torque sample yield a finite power curve');
assert(turboSteadyBoost(zeroRefTurbo, 0) === 0 && turboSteadyBoost(zeroRefTurbo, 850) === 0.35 &&
  turboBoostAsked(zeroRefTurbo, 850, 0) === 0,
  'the turbo reaches full boost from idle under throttle but asks for none with the plate closed');

const legacyTurbo = turboFixture(0);
legacyTurbo.engine.turbo!.referenceRpm = legacyTurbo.engine.turbo!.spoolRefRpm = 0;
legacyTurbo.engine.powerCurve = [[0, NaN], ...legacyTurbo.engine.powerCurve.slice(1)];
assert(sanitizeCarPhysics('custom_zero_rpm_turbo', legacyTurbo) &&
  JSON.stringify(legacyTurbo.engine) === JSON.stringify(zeroRefEngine) &&
  !sanitizeCarPhysics('custom_zero_rpm_turbo', legacyTurbo),
  'restoring a saved import fixes its invalid zero-RPM sample without touching the rest of its curve');
const positiveRef = turboFixture(3000);
const positiveRefEngine = JSON.stringify(positiveRef.engine);
sanitizeCarPhysics('custom_positive_rpm_turbo', positiveRef);
assert(positiveRef.engine.turbo?.referenceRpm === 3000 && JSON.stringify(positiveRef.engine) === positiveRefEngine &&
  turboSteadyBoost(positiveRef.engine.turbo, 1500) === 0.35 / 32,
  'an ordinary positive reference retains its authored boost law');

const turboTrack = createFlatTestTrack(2000, 40, 80);
for (const [path, config] of [['fresh import', turboFixture(0)], ['saved import', legacyTurbo]] as const) {
  const sim = createDynamicVehicleModel('custom_zero_rpm_turbo', config).createSim(turboTrack, null);
  sim.teleportToDistance(100);
  let finite = true;
  for (let i = 0; i < 120; i++) {
    sim.step(1 / 60, { throttle: 1 });
    const { rpm, speedKmh, icePowerKw } = sim.telemetry;
    if (![rpm, speedKmh, icePowerKw].every(Number.isFinite)) {
      finite = false;
      break;
    }
  }
  assert(finite && sim.telemetry.speedKmh > 10, `the ${path} launches with finite RPM and power`);
}

const gearboxFixture = (fields: string) => mapAcPhysics(new AcModData({
  ...mockFiles,
  'drivetrain.ini': `
[GEARS]
COUNT=4
GEAR_1=3.4
GEAR_2=2.2
GEAR_3=1.5
GEAR_4=1.1
FINAL=3.9
[GEARBOX]
CHANGE_UP_TIME=30
CHANGE_DN_TIME=70
${fields}
`,
}));
const managedShift = gearboxFixture('SUPPORTS_SHIFTER=0\nAUTO_CUTOFF_TIME=10');
const manualShift = gearboxFixture('SUPPORTS_SHIFTER=1\nAUTO_CUTOFF_TIME=10');
assert(managedShift.gearbox.upshiftCutS === 0.01,
  'an explicit sequential gearbox maps its authored ignition cut from milliseconds to seconds');
assert(managedShift.gearbox.shiftTimeS === 0.03 && managedShift.gearbox.downshiftTimeS === 0.07 &&
  managedShift.gearbox.shiftTorqueFraction === 0 && managedShift.gearbox.upshiftNeutralS === undefined &&
  managedShift.gearbox.upshiftCutLift === undefined,
  'the managed cut is separate from the normal shift times and does not add a neutral phase or a pedal lift');
const longerCut = gearboxFixture('SUPPORTS_SHIFTER=0\nAUTO_CUTOFF_TIME=50').gearbox;
assert(longerCut.upshiftCutS === 0.05 && longerCut.shiftTimeS === 0.05,
  'a longer authored cut remains the minimum time between shifts');
assert(!Object.hasOwn(manualShift.gearbox, 'upshiftCutS') && manualShift.gearbox.shiftTimeS === 0.03,
  'an H-pattern gearbox keeps the legacy behaviour even when it declares an automatic cut');
for (const [fields, label] of [
  ['AUTO_CUTOFF_TIME=10', 'missing shifter flag'],
  ['SUPPORTS_SHIFTER=invalid\nAUTO_CUTOFF_TIME=10', 'invalid shifter flag'],
  ['SUPPORTS_SHIFTER=2\nAUTO_CUTOFF_TIME=10', 'unknown shifter flag'],
  ['SUPPORTS_SHIFTER=0', 'missing cut'],
  ['SUPPORTS_SHIFTER=0\nAUTO_CUTOFF_TIME=0', 'disabled cut'],
  ['SUPPORTS_SHIFTER=0\nAUTO_CUTOFF_TIME=-10', 'negative cut'],
  ['SUPPORTS_SHIFTER=0\nAUTO_CUTOFF_TIME=Infinity', 'non-finite cut'],
]) {
  const gearbox = gearboxFixture(fields).gearbox;
  assert(!Object.hasOwn(gearbox, 'upshiftCutS') && gearbox.shiftTimeS === 0.03,
    `gearbox with ${label} does not opt into managed shifting`);
}
const upshiftProbe = (config: typeof managedShift) => {
  const profile = createCustomSimProfile('custom_shift_fixture', config, 'road');
  return measureUpshift((track) => new F12026CarSim(track, null, profile), 80);
};
const managedProbe = upshiftProbe(managedShift);
const manualProbe = upshiftProbe(manualShift);
assert(managedProbe.from === 2 && managedProbe.to === 3 && managedProbe.slipBefore === manualProbe.slipBefore &&
  manualProbe.from === managedProbe.from && manualProbe.to === managedProbe.to,
  'the two imported gearbox probes start with the same slip and both shift from second to third');
assert(managedProbe.slipPeak < manualProbe.slipPeak - 0.02,
  `the managed shift reduces the rear-slip spike (${managedProbe.slipPeak.toFixed(3)} vs ${manualProbe.slipPeak.toFixed(3)})`);

console.log('\n--- Testing imported DRS, active aero and hybrid power ---');
const importedAeroFiles = {
  'aero.ini': `
[WING_9]
NAME=Rear flap
ANGLE=15
POSITION=0,0.5,-1.5
LUT_AOA_CL=(0=0.2|25=1.2)
LUT_AOA_CD=(0=0.05|25=0.4)
[DYNAMIC_CONTROLLER_2]
WING=9
INPUT=GAS
COMBINATOR=MULT
LUT=(0=1|1=1.5)
UP_LIMIT=24
[DYNAMIC_CONTROLLER_0]
WING=9
INPUT=SPEED_KMH
COMBINATOR=ADD
LUT=(0=0|100=5)
FILTER=0.8
[DYNAMIC_CONTROLLER_1]
WING=99
INPUT=BRAKE
COMBINATOR=ADD
LUT=(0=0|1=99)
`,
  'drs.ini': '[WING_9]\nEFFECT=0\n[DRS_ZONES]\nIGNORE_ZONES=1\n[DEACTIVATION]\nLIMIT_G=1.5',
};
const systemsConfig = (files: Record<string, string>) => mapAcPhysics(new AcModData({ ...mockFiles, ...files }));
const activeAero = systemsConfig(importedAeroFiles);
const aeroWing = activeAero.aero.wings[0];
assert(aeroWing.activeControllers?.map((c) => c.input).join() === 'SPEED_KMH,GAS' &&
  aeroWing.importedDrs !== undefined && 'effect' in aeroWing.importedDrs && aeroWing.importedDrs.effect === 0,
  'sparse wing numbers bind correctly and active controls follow their authored numeric order');
const fixed = VehiclePhysics.FIXED_DT;
const command = { throttle: 1, brake: 0, steer: 0 };
const chain = new ImportedController(aeroWing.activeControllers ?? []);
const initialAngle = chain.step(15, { ...command, throttle: 0 }, 0, 1, 0, 0.003);
const filteredAngle = chain.step(15, { ...command, throttle: 0 }, 100, 1, 0, 0.003);
chain.reset();
const limitedAngle = chain.step(15, command, 100, 1, 0, 0.003);
assert(initialAngle === 15 && filteredAngle === 16 && limitedAngle === 24,
  'the authored retention filters a speed step, then ADD/MULT and the angle limit apply in order');
const runVehicle = (v: VehiclePhysics, ticks: number, input: Parameters<VehiclePhysics['step']>[1]) => {
  for (let i = 0; i < ticks; i++) v.step(fixed, input);
};
const createProbe = (config: typeof activeAero, speedMs: number, extra?: Partial<ConstructorParameters<typeof VehiclePhysics>[0]>) => {
  const v = new VehiclePhysics({ config, ground: new FlatGroundQuery(0), airDensity: 1.225, ...extra });
  v.reset(0, 0, 0, speedMs);
  v.autoShift = false;
  return v;
};
const staticAero = structuredClone(activeAero);
delete staticAero.aero.wings[0].activeControllers;
const passive = createProbe(staticAero, 40);
const controlled = createProbe(activeAero, 40, { locateProgress: () => 0.25 });
runVehicle(passive, 30, command);
runVehicle(controlled, 30, command);
const passiveDrag = passive.telemetry.dragN;
assert(controlled.telemetry.dragN > passiveDrag * 1.2,
  `speed and throttle controllers change aerodynamic forces (${controlled.telemetry.dragN.toFixed(1)} vs ${passiveDrag.toFixed(1)} N)`);
const closed = controlled.telemetry.downforceN;
controlled.step(fixed, { ...command, drs: true });
assert(controlled.drsOpen && controlled.drsBlend > 0 && controlled.drsBlend < 1,
  'authored unrestricted DRS responds to the existing toggle and travels instead of snapping');
runVehicle(controlled, Math.ceil(activeAero.aero.drsTransitionS / fixed), command);
assert(controlled.telemetry.downforceN < closed * 0.6 && controlled.telemetry.dragN < passiveDrag,
  'opening the authored flap reduces both downforce and drag');
controlled.step(fixed, { ...command, brake: 0.4 });
assert(!controlled.drsOpen, 'imported DRS closes on the brake');
controlled.step(fixed, { ...command, drs: true });
controlled.telemetry.latG = 1.6;
controlled.step(fixed, command);
assert(!controlled.drsOpen, 'imported DRS closes beyond its authored lateral-G limit');

const zonedAero = systemsConfig({ ...importedAeroFiles, 'drs.ini': '[WING_9]\nMODE=ANGLE\nANGLE=0' });
let progress = 0.58;
const zoned = createProbe(zonedAero, 40, {
  locateProgress: () => progress,
  drsZones: [{ id: 'DRS 1', detection: 0.6, start: 0.62, end: 0.7 }],
  lapLengthM: 10000,
});
zoned.step(fixed, { ...command, drs: true });
assert(!zoned.drsOpen, 'a zoned imported DRS cannot open outside its zone');
for (progress of [0.605, 0.623]) zoned.step(fixed, command);
zoned.step(fixed, { ...command, drs: true });
const zonedFlap = zonedAero.aero.wings[0].importedDrs;
assert(zoned.drsOpen && zonedFlap !== undefined && 'angleDeg' in zonedFlap, 'ANGLE mode can open after detection and entry into the zone');
progress = 0.71;
zoned.step(fixed, command);
assert(!zoned.drsOpen, 'zoned imported DRS closes when the zone ends');
const invalidDrs = systemsConfig({ ...importedAeroFiles, 'drs.ini': '[WING_7]\nEFFECT=0' });
assert(!invalidDrs.aero.importedDrs, 'a DRS entry referencing a nonexistent wing does not expose a button');

const kineticFiles = {
  'ers.ini': `
[KINETIC]
TORQUE_CURVE=deploy.lut
COAST_CURVE=regen.lut
MAX_KJ_PER_LAP=20
MAX_KJ=40
CHARGE_K=0.001
HAS_BUTTON_OVERRIDE=1
DEFAULT_CONTROLLER=7
`,
  'deploy.lut': '0|90\n4000|90\n10000|60',
  'regen.lut': '0|0\n500|35\n10000|35',
  'ctrl_ers_7.ini': '[CONTROLLER_0]\nINPUT=GAS\nCOMBINATOR=ADD\nLUT=(0=0|1=0.25)',
};
const hybrid = systemsConfig(kineticFiles);
assert(hybrid.ers.importedDrive?.maps.BAL?.length === 1 && !hybrid.ers.importedDrive.electric &&
  hybrid.ers.ERS_MAX_CHARGE === 40_000 && hybrid.ers.deployPerLapJ === 20_000,
  'the authored default ERS map, electrical capacity and per-lap budget are separate');
const hybridProbe = createProbe(hybrid, 22);
hybridProbe.setPerformanceMode('BAL');
hybridProbe.step(fixed, command);
const mappedPower = hybridProbe.telemetry.MGUK_POWER;
hybridProbe.step(fixed, { ...command, importedBoost: true });
assert(mappedPower > 0 && hybridProbe.telemetry.MGUK_POWER > mappedPower * 2,
  `the ERS override adds deployment (${mappedPower.toFixed(0)} to ${hybridProbe.telemetry.MGUK_POWER.toFixed(0)} W)`);
runVehicle(hybridProbe, 220, { ...command, importedBoost: true });
assert(hybridProbe.telemetry.lapDeployJ <= 20_000 && hybridProbe.ersEnergyJ >= 20_000,
  'a sustained override cannot burn more than the authored lap allowance');
const beforeRegen = hybridProbe.ersEnergyJ;
runVehicle(hybridProbe, 3, { throttle: 0, brake: 0.6, steer: 0 });
assert(hybridProbe.ersEnergyJ > beforeRegen && hybridProbe.telemetry.MGUK_POWER < 0,
  `an imported kinetic drive replenishes the battery under braking (${beforeRegen.toFixed(0)} to ${hybridProbe.ersEnergyJ.toFixed(0)} J)`);
const malformed = systemsConfig({ ...kineticFiles, 'deploy.lut': '1000|0' });
assert(!malformed.ers.importedDrive && malformed.ers.ERS_MAX_DEPLOY === 0,
  'a missing or ineffective torque LUT does not create an electrical drivetrain');

const heatIni = `${kineticFiles['ers.ini']}\n[HEAT]\nCHARGE_K=0.002\nTORQUE_PERC=26`;
const turboEngine = `${mockFiles['engine.ini']}\n[TURBO_0]\nMAX_BOOST=1\nREFERENCE_RPM=2500\nGAMMA=1`;
const heatFiles = { ...kineticFiles, 'ers.ini': heatIni, 'engine.ini': turboEngine };
const heatHybrid = systemsConfig(heatFiles);
const noHeatHybrid = systemsConfig({ ...heatFiles, 'ers.ini': kineticFiles['ers.ini'] });
assert(heatHybrid.ers.importedDrive?.heat?.chargeK === 0.002 && heatHybrid.ers.importedDrive.heat.torqueFraction === 0.26,
  'a turbo hybrid maps [HEAT] alongside [KINETIC]');
assert(!systemsConfig({ ...kineticFiles, 'ers.ini': heatIni }).ers.importedDrive?.heat &&
  !systemsConfig({ ...heatFiles, 'deploy.lut': '1000|0' }).ers.importedDrive &&
  !systemsConfig({ ...heatFiles, 'ers.ini': heatIni.replace('0.002', '0') }).ers.importedDrive?.heat &&
  !systemsConfig({ ...heatFiles, 'ers.ini': heatIni.replace('TORQUE_PERC=26', 'TORQUE_PERC=150') }).ers.importedDrive?.heat &&
  !noHeatHybrid.ers.importedDrive?.heat, 'non-turbo, incomplete, disabled and invalid heat data do not enable an MGU-H');

const heatProbe = (config = heatHybrid, mode: 'BAL' | 'PSH' = 'BAL', charge = 0, lapJ = config.ers.deployPerLapJ) => {
  const car = createProbe(config, 22);
  car.setPerformanceMode(mode);
  car.ersEnergyJ = charge;
  car.lapDeployJ = lapJ;
  return car;
};
const thermalBattery = heatProbe();
const kineticOnly = heatProbe(noHeatHybrid);
runVehicle(thermalBattery, 32, command);
runVehicle(kineticOnly, 32, command);
assert(thermalBattery.ersEnergyJ > 0 && kineticOnly.ersEnergyJ === 0 &&
  thermalBattery.telemetry.MGUH_POWER > 0 && thermalBattery.telemetry.ERS_CHARGING &&
  thermalBattery.telemetry.MGUK_POWER === 0 && thermalBattery.lapHarvestJ === 0 &&
  thermalBattery.driveshaftPowerW === kineticOnly.driveshaftPowerW,
  'BAL recovers exhaust energy with no MGU-K torque or change to the kinetic lap counters');
const fullHybrid = heatProbe(heatHybrid, 'BAL', heatHybrid.ers.ERS_MAX_CHARGE - 1);
runVehicle(fullHybrid, 32, command);
assert(fullHybrid.ersEnergyJ === heatHybrid.ers.ERS_MAX_CHARGE && fullHybrid.telemetry.MGUH_POWER === 0,
  'battery-mode recovery stops at the usable capacity');
thermalBattery.step(fixed, { ...command, ignitionCut: 0 });
assert(thermalBattery.telemetry.MGUH_POWER === 0, 'a complete ignition cut stops heat recovery even with residual turbo boost');
thermalBattery.step(fixed, { ...command, throttle: 0, brake: 0.6 });
assert(thermalBattery.telemetry.MGUK_POWER < 0 && thermalBattery.telemetry.MGUH_POWER === 0 && thermalBattery.lapHarvestJ > 0,
  'lifting and braking still produces only kinetic regeneration');

const thermalMotor = heatProbe(heatHybrid, 'PSH');
const overriddenHeat = heatProbe();
runVehicle(thermalMotor, 32, command);
runVehicle(overriddenHeat, 32, { ...command, importedBoost: true });
const motorHeatW = thermalMotor.telemetry.MGUH_POWER;
assert(motorHeatW > 0 && Math.abs(thermalMotor.telemetry.MGUK_POWER - motorHeatW) < 1e-6 &&
  thermalMotor.ersEnergyJ === 0 && thermalMotor.lapDeployJ === heatHybrid.ers.deployPerLapJ &&
  overriddenHeat.telemetry.MGUK_POWER > 0 && overriddenHeat.ersEnergyJ === 0,
  'PSH and the authored boost override send heat directly to the MGU-K without battery charge or lap budget');
const strongHeat = heatProbe(systemsConfig({ ...heatFiles, 'ers.ini': heatIni.replace('0.002', '0.02') }), 'PSH');
runVehicle(strongHeat, 32, command);
assert(strongHeat.telemetry.MGUH_POWER > motorHeatW &&
  strongHeat.telemetry.MGUH_POWER <= heatHybrid.ers.ERS_MAX_DEPLOY * 0.26,
  'thermal power follows the authored boost gain and stays within the torque-share ceiling');
const combinedMotor = heatProbe(heatHybrid, 'BAL', heatHybrid.ers.ERS_MAX_CHARGE, 0);
runVehicle(combinedMotor, 32, { ...command, importedBoost: true });
assert(combinedMotor.telemetry.MGUK_POWER > combinedMotor.telemetry.MGUH_POWER &&
  combinedMotor.telemetry.MGUH_POWER > 0 && combinedMotor.lapDeployJ > 0 &&
  combinedMotor.telemetry.MGUK_POWER <= heatHybrid.ers.ERS_MAX_DEPLOY,
  'battery power and direct heat share one MGU-K power envelope');
const detachedMotor = heatProbe(heatHybrid, 'PSH');
runVehicle(detachedMotor, 32, { ...command, clutch: 1 });
assert(detachedMotor.telemetry.MGUK_POWER === 0 && detachedMotor.telemetry.MGUH_POWER === 0,
  'direct heat cannot turn the wheels while the clutch is open');

const electric = systemsConfig({
  ...heatFiles,
  'power.lut': '0|10\n10|0\n500|0\n10000|0',
  'drivetrain.ini': '[GEARS]\nCOUNT=1\nGEAR_1=3.7\nFINAL=2.5\nGEAR_R=-3.7',
});
const evProfile = createCustomSimProfile('custom_test_ev', electric, 'road');
const ev = new F12026CarSim(createFlatTestTrack(), null, evProfile);
ev.autoGearbox = false;
ev.autoClutch = false;
assert(evProfile.hasErs && ev.telemetry.f12026?.hasErsOverride === false && ev.telemetry.rpm === 0 && ev.telemetry.fuelKg === 0 &&
  !electric.ers.importedDrive?.heat && !electric.engine.turbo,
  `an ERS-driven EV has a battery but no idle, fuel, manual boost button or MGU-H (${ev.telemetry.rpm} rpm, ${ev.telemetry.fuelKg} kg)`);
for (let i = 0; i < 300; i++) ev.step(fixed, { throttle: 0.6, clutchBound: true });
assert(ev.telemetry.speedKmh > 1 && ev.ersEnergyJ < electric.ers.ERS_MAX_CHARGE &&
  ev.vehicle.iceMechanicalPowerW === 0 && !ev.telemetry.engineStalled,
  `the motor launches from rest without combustion or manual clutch (${ev.telemetry.speedKmh} km/h, ${ev.telemetry.mgukPowerKw} kW, ${ev.vehicle.iceMechanicalPowerW} W ICE)`);
ev.vehicle.ersEnergyJ = 0;
ev.step(fixed, { throttle: 1 });
assert(ev.telemetry.mgukPowerKw === 0 && ev.ersEnergyJ === 0, 'an empty battery cannot drive the wheels');
const importedProfile = createCustomSimProfile('custom_test_drs', activeAero, 'f1');
const importedSim = new F12026CarSim(createFlatTestTrack(), null, importedProfile);
importedSim.teleportToDistance(2000, 40);
importedSim.step(fixed, { throttle: 1, toggleXMode: true });
assert(importedSim.overtakingRules === 'drs-rear' && aeroReadout(importedSim.telemetry).label === 'DRS OPEN',
  'the existing driving input opens imported DRS and the HUD says DRS rather than X-mode');
const officialSim = new F12026CarSim(createFlatTestTrack(), null);
assert(officialSim.overtakingRules === 'straight-mode-2026' && aeroReadout(officialSim.telemetry).straightMode,
  'the official F1 keeps Straight Mode and its own rules');

const heaveConfig = mapAcPhysics(new AcModData({
  ...mockFiles,
  'suspensions.ini': `${mockFiles['suspensions.ini']}
[HEAVE_FRONT]
SPRING_RATE=120000
PROGRESSIVE_SPRING_RATE=30000
DAMP_BUMP=4090
DAMP_FAST_BUMP=1700
DAMP_REBOUND=5560
DAMP_FAST_REBOUND=2660
DAMP_FAST_BUMPTHRESHOLD=0.088
DAMP_FAST_REBOUNDTHRESHOLD=0.14
[HEAVE_REAR]
SPRING_RATE=100000
PROGRESSIVE_SPRING_RATE=20000
DAMP_BUMP=5560
DAMP_FAST_BUMP=1580
DAMP_REBOUND=6420
DAMP_FAST_REBOUND=2540
DAMP_FAST_BUMPTHRESHOLD=0.048
DAMP_FAST_REBOUNDTHRESHOLD=0.12
`,
}));
const frontHeave = heaveConfig.suspensions.dampers_controller.front;
const rearHeave = heaveConfig.suspensions.dampers_controller.rear;
assert(frontHeave.heave.slow_bump === 4090 && frontHeave.heave.fast_bump === 1700 &&
  frontHeave.heave.slow_rebound === 5560 && frontHeave.heave.fast_rebound === 2660 &&
  frontHeave.heaveFastThresholdMs === 0.088 && frontHeave.heaveFastReboundThresholdMs === 0.14,
  'front third-element damper and its own knees retain their AC data');
assert(rearHeave.heave.slow_bump === 5560 && rearHeave.heave.fast_bump === 1580 &&
  rearHeave.heave.slow_rebound === 6420 && rearHeave.heave.fast_rebound === 2540 &&
  rearHeave.heaveFastThresholdMs === 0.048 && rearHeave.heaveFastReboundThresholdMs === 0.12,
  'rear third-element damper and its own knees use the rear axle data');
assert(heaveConfig.suspensions.front.heave.progressiveRate === 30000 &&
  heaveConfig.suspensions.rear.heave.progressiveRate === 20000,
  'third-element progressive spring rates retain their axle-specific data');
assert(Object.values(physicsConfig.suspensions.dampers_controller.front.heave).every((value) => value === 0) &&
  physicsConfig.suspensions.dampers_controller.front.heaveFastThresholdMs === undefined,
  'cars without a third element keep their undamped fallback');
const partialHeaveConfig = mapAcPhysics(new AcModData({
  ...mockFiles,
  'suspensions.ini': `${mockFiles['suspensions.ini']}
[HEAVE_FRONT]
SPRING_RATE=100000
DAMP_BUMP=0
[HEAVE_REAR]
DAMP_BUMP=1234
`,
}));
const partialFrontHeave = partialHeaveConfig.suspensions.dampers_controller.front;
assert(Object.values(partialFrontHeave.heave).every((value) => value === 0) &&
  partialFrontHeave.heaveFastThresholdMs === undefined && partialFrontHeave.heaveFastReboundThresholdMs === undefined &&
  Object.values(partialHeaveConfig.suspensions.dampers_controller.rear.heave).every((value) => value === 0),
  'incomplete or inactive third elements do not invent damper data or knees');

const tyreConfig = mapAcPhysics(new AcModData({
  ...mockFiles,
  'tyres.ini': `[HEADER]
VERSION=10
[FRONT]
FRICTION_LIMIT_ANGLE=7.2
CX_MULT=1.06
XMU=0.27
RATE=300568
PRESSURE_STATIC=17
PRESSURE_IDEAL=29
PRESSURE_SPRING_GAIN=10102
[REAR]
FRICTION_LIMIT_ANGLE=6.5
CX_MULT=1.06
XMU=0.24
RATE=369995
PRESSURE_STATIC=17
PRESSURE_IDEAL=30
PRESSURE_SPRING_GAIN=12809
`,
}));
const tyreCompound = tyreConfig.tyreCompounds.PhysicsTyreCompound_Road_Street!;
const frontTyre = tyreCompound.modelData;
const rearTyre = tyreCompound.rearOverride!.modelData!;
const frontSpring = new Lut(tyreCompound.pressureData.pressureSpringCurve);
const rearSpring = new Lut(tyreCompound.rearOverride!.pressureData?.pressureSpringCurve ?? tyreCompound.pressureData.pressureSpringCurve);
assert(frontSpring.evaluate(17) === 300568 && frontSpring.evaluate(29) === 421792,
  'front tyre stiffness follows RATE and PRESSURE_SPRING_GAIN from PRESSURE_STATIC');
assert(rearSpring.evaluate(17) === 369995 && rearSpring.evaluate(30) === 536512,
  'rear tyre stiffness uses the rear axle data, not the front curve');
const fallbackSpring = new Lut(physicsConfig.tyreCompounds.PhysicsTyreCompound_Road_Street!.pressureData.pressureSpringCurve);
assert(fallbackSpring.evaluate(32) === 210000,
  'tyres without pressure-spring data retain the existing fallback');
const missingRearSpringConfig = mapAcPhysics(new AcModData({
  ...mockFiles,
  'tyres.ini': `[FRONT]
RATE=300000
PRESSURE_STATIC=20
PRESSURE_SPRING_GAIN=10000
[REAR]
RATE=350000
`,
}));
const missingRearSpringTyre = missingRearSpringConfig.tyreCompounds.PhysicsTyreCompound_Road_Street!;
const rearFallbackSpring = new Lut(missingRearSpringTyre.rearOverride!.pressureData!.pressureSpringCurve!);
assert(rearFallbackSpring.evaluate(30) === 400000,
  'an incomplete rear pressure-spring definition falls back to the front curve');
const zeroGainConfig = mapAcPhysics(new AcModData({
  ...mockFiles,
  'tyres.ini': '[FRONT]\nRATE=200000\nPRESSURE_STATIC=20\nPRESSURE_SPRING_GAIN=0',
}));
const zeroGainSpring = new Lut(zeroGainConfig.tyreCompounds.PhysicsTyreCompound_Road_Street!.pressureData.pressureSpringCurve);
assert(zeroGainSpring.evaluate(15) === 200000 && zeroGainSpring.evaluate(35) === 200000,
  'a zero pressure gain keeps the tyre stiffness constant');
assert(frontTyre.curveFullness === 0.27 && rearTyre.curveFullness === 0.24,
  'front and rear XMU map to brush-curve fullness');
assert(frontTyre.slip_ratio_limit === peakDriveSlipRatio(7.2, 1.06) &&
  rearTyre.slip_ratio_limit === peakDriveSlipRatio(6.5, 1.06) &&
  frontTyre.slip_ratio_limit !== frontTyre.curveFullness,
  'peak drive slip is derived from angle and longitudinal stiffness, not XMU');
delete frontTyre.curveFullness;
delete rearTyre.curveFullness;
frontTyre.slip_ratio_limit = 0.27;
rearTyre.slip_ratio_limit = 0.24;
assert(sanitizeCarPhysics('custom_tyre_fixture', tyreConfig) &&
  frontTyre.curveFullness === 0.27 && rearTyre.curveFullness === 0.24 &&
  frontTyre.slip_ratio_limit === peakDriveSlipRatio(7.2, 1.06) &&
  rearTyre.slip_ratio_limit === peakDriveSlipRatio(6.5, 1.06),
  'saved tyre records migrate XMU and peak slip separately');
assert(!sanitizeCarPhysics('custom_tyre_fixture', tyreConfig), 'tyre migration is idempotent');

const aeroMod = new AcModData({
  ...mockFiles,
  'aero.ini': `[WING_0]
NAME=Rear diffuser
CHORD=1
SPAN=1
POSITION=0,0,-1
ANGLE=2.5
LUT_AOA_CL=diff.lut
`,
  'diff.lut': '-5|0\n0|0.3\n2.5|0.5\n10|0.8',
});
const aeroConfig = mapAcPhysics(aeroMod);
const diffuser = aeroConfig.aero.wings[0];
const coefficient = new Lut(diffuser.lutAOA_CL);
assert(diffuser.aoaReference === 'setup', 'imported diffuser keeps its setup-angle reference');
assert(Math.abs(wingAngleOfAttack(diffuser, 1.2, 1.2) - 2.5) < 1e-9 &&
  Math.abs(coefficient.evaluate(wingAngleOfAttack(diffuser, 1.2, 1.2)) - 0.5) < 1e-9,
  'imported diffuser evaluates its authored angle at static rake');
assert(Math.abs(wingAngleOfAttack(diffuser, 2.2, 1.2) - 3.5) < 1e-9,
  'imported diffuser follows pitch changes relative to static rake');
assert(wingAngleOfAttack({ name: 'VENTURI_FLOOR', angleDeg: 2.5 }, 1.2, 0.8) === 1.2,
  'built-in floor retains its original absolute-rake reference');
assert(Math.abs(wingAngleOfAttack({ name: 'REAR_WING', angleDeg: 5 }, 1.2, 0.8) - 5.4) < 1e-9,
  'ordinary wing angle remains unchanged');
assert(Object.is(wingAngleOfAttack({ name: 'REAR_WING', angleDeg: 0.5 }, -1, -0.3), 0.5 + (-1 - -0.3)),
  'ordinary wing preserves the original angleDeg + (rake - staticRake) IEEE-754 grouping');
assert(Object.is(wingAngleOfAttack({ name: 'VENTURI_FLOOR', angleDeg: 0.5, aoaReference: 'setup' }, -1, -0.3),
  0.5 + (-1 - -0.3)),
  'setup-referenced imported floor preserves the original IEEE-754 grouping');
assert(Object.is(wingAngleOfAttack({ name: 'VENTURI_FLOOR', angleDeg: 0.5 }, -1, -0.3), -1),
  'built-in floor without setup reference returns the exact rake');
delete diffuser.aoaReference;
assert(sanitizeCarPhysics('custom_test', aeroConfig) && diffuser.aoaReference === 'setup',
  'previously imported diffusers migrate to the setup-angle reference');
assert(!sanitizeCarPhysics('custom_test', aeroConfig),
  'diffuser reference migration is idempotent');
const aeroAtSpeed = (useSetupAngle: boolean) => {
  const config = structuredClone(aeroConfig);
  if (!useSetupAngle) delete config.aero.wings[0].aoaReference;
  const vehicle = new VehiclePhysics({ config, ground: new FlatGroundQuery(0), airDensity: 1.2 });
  vehicle.reset(0, 0, 0, 40);
  vehicle.step(1 / 120, { throttle: 0, brake: 0, steer: 0 });
  return vehicle.telemetry.downforceN;
};
assert(aeroAtSpeed(true) > aeroAtSpeed(false) + 80,
  'the vehicle dynamics actually apply the imported diffuser angle at speed');

// ---------------------------------------------------------------------------
// 3. kn5-loader tests
// ---------------------------------------------------------------------------
console.log('\n--- Testing kn5-loader ---');

// Build a mock minimal KN5 binary buffer
function createMockKn5(): Uint8Array {
  const parts: Uint8Array[] = [];

  function writeI32(val: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, val, true);
    return b;
  }
  function writeU8(val: number): Uint8Array {
    return new Uint8Array([val & 0xff]);
  }
  function writeF32s(arr: number[]): Uint8Array {
    const b = new Uint8Array(arr.length * 4);
    const view = new DataView(b.buffer);
    arr.forEach((v, i) => view.setFloat32(i * 4, v, true));
    return b;
  }
  function writeStr(str: string): Uint8Array {
    const strBytes = new TextEncoder().encode(str);
    const b = new Uint8Array(4 + strBytes.length);
    new DataView(b.buffer).setInt32(0, strBytes.length, true);
    b.set(strBytes, 4);
    return b;
  }

  // Header: magic "sc6969"
  parts.push(new TextEncoder().encode('sc6969'));
  // Version: 5
  parts.push(writeI32(5));

  // Textures count: 0
  parts.push(writeI32(0));

  // Materials count: 2 (body and tyre)
  parts.push(writeI32(2));
  // Material 0: Body
  parts.push(writeStr('CarBody'));
  parts.push(writeStr('ksPerPixel'));
  parts.push(writeU8(0)); // blend
  parts.push(writeU8(0)); // alpha tested
  parts.push(writeI32(0)); // skip
  parts.push(writeI32(1)); // props count
  parts.push(writeStr('ksSpecularEXP'));
  parts.push(writeF32s([25]));
  parts.push(writeF32s(new Array(9).fill(0)));
  parts.push(writeI32(0)); // maps count

  // Material 1: Tyre
  parts.push(writeStr('TyreMat'));
  parts.push(writeStr('ksTyres'));
  parts.push(writeU8(0));
  parts.push(writeU8(0));
  parts.push(writeI32(0));
  parts.push(writeI32(0)); // props
  parts.push(writeI32(0)); // maps

  // Root node: CAR (kind 1, 1 child: BODY_MESH)
  // Let's write CAR dummy
  parts.push(writeI32(1)); // kind = 1 (dummy)
  parts.push(writeStr('Root'));
  parts.push(writeI32(6)); // 6 children: BODY, STEER_HR, WHEEL_LF, WHEEL_RF, WHEEL_LR, WHEEL_RR
  parts.push(writeU8(1)); // active
  // Identity matrix 16 floats
  parts.push(
    writeF32s([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ])
  );

  // Child 1: Body Mesh (kind 2)
  parts.push(writeI32(2));
  parts.push(writeStr('BODY_SHELL'));
  parts.push(writeI32(0)); // children
  parts.push(writeU8(1)); // active
  parts.push(writeU8(1)); // castShadow
  parts.push(writeU8(1)); // visible
  parts.push(writeU8(0)); // transparent
  parts.push(writeI32(3)); // 3 vertices
  // Vertex 0: pos (0, 0.5, 0), nrm (0, 1, 0), uv (0, 0), tan (1, 0, 0)
  parts.push(writeF32s([0, 0.5, 0, 0, 1, 0, 0, 0, 1, 0, 0]));
  // Vertex 1: pos (1, 0.5, 0), nrm (0, 1, 0), uv (1, 0), tan (1, 0, 0)
  parts.push(writeF32s([1, 0.5, 0, 0, 1, 0, 1, 0, 1, 0, 0]));
  // Vertex 2: pos (0, 0.5, 1), nrm (0, 1, 0), uv (0, 1), tan (1, 0, 0)
  parts.push(writeF32s([0, 0.5, 1, 0, 1, 0, 0, 1, 1, 0, 0]));
  // 3 indices: 0, 1, 2 (uint16)
  parts.push(writeI32(3));
  const idxBuf = new Uint8Array(6);
  const idxView = new DataView(idxBuf.buffer);
  idxView.setUint16(0, 0, true);
  idxView.setUint16(2, 1, true);
  idxView.setUint16(4, 2, true);
  parts.push(idxBuf);
  parts.push(writeI32(0)); // mat index = 0
  parts.push(writeI32(0)); // skip lod
  parts.push(new Uint8Array(8)); // skip 8
  parts.push(new Uint8Array(16)); // skip 16
  parts.push(writeU8(1)); // renderable

  // Child 2: STEER_HR dummy (kind 1)
  parts.push(writeI32(1));
  parts.push(writeStr('STEER_HR'));
  parts.push(writeI32(0)); // children
  parts.push(writeU8(1)); // active
  parts.push(
    writeF32s([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0.35, 0.65, 0.3, 1,
    ])
  );

  // Children 3-6: WHEEL_LF, WHEEL_RF, WHEEL_LR, WHEEL_RR (dummies with 1 tyre mesh each)
  const corners = [
    { name: 'LF', x: 0.75, y: 0.3, z: 1.3 },
    { name: 'RF', x: -0.75, y: 0.3, z: 1.3 },
    { name: 'LR', x: 0.75, y: 0.3, z: -1.3 },
    { name: 'RR', x: -0.75, y: 0.3, z: -1.3 },
  ];

  for (const c of corners) {
    parts.push(writeI32(1)); // dummy WHEEL_xx
    parts.push(writeStr(`WHEEL_${c.name}`));
    parts.push(writeI32(1)); // 1 child
    parts.push(writeU8(1));
    parts.push(
      writeF32s([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        c.x, c.y, c.z, 1,
      ])
    );

    // Tyre Mesh under WHEEL_xx
    parts.push(writeI32(2));
    parts.push(writeStr(`TYRE_${c.name}`));
    parts.push(writeI32(0));
    parts.push(writeU8(1));
    parts.push(writeU8(1));
    parts.push(writeU8(1));
    parts.push(writeU8(0));
    parts.push(writeI32(3));
    // 3 vertices centered around (0, 0, 0) in local wheel space
    parts.push(writeF32s([c.x, c.y, c.z, 0, 1, 0, 0, 0, 1, 0, 0]));
    parts.push(writeF32s([c.x + 0.1, c.y, c.z, 0, 1, 0, 1, 0, 1, 0, 0]));
    parts.push(writeF32s([c.x, c.y - 0.3, c.z, 0, 1, 0, 0, 1, 1, 0, 0]));
    parts.push(writeI32(3));
    parts.push(idxBuf);
    parts.push(writeI32(1)); // tyre material index
    parts.push(writeI32(0));
    parts.push(new Uint8Array(8));
    parts.push(new Uint8Array(16));
    parts.push(writeU8(1));
  }

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const res = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    res.set(p, off);
    off += p.length;
  }
  return res;
}

const mockKn5Bytes = createMockKn5();
const parsedKn5 = parseKn5(mockKn5Bytes);

assert(parsedKn5.materials.length === 2, 'parseKn5 extracts materials');
assert(parsedKn5.nodes.length >= 7, 'parseKn5 extracts nodes hierarchy');

const carScene = buildKn5Scene(parsedKn5);

assert(carScene.name === 'CAR', 'Scene root is CAR');
assert(carScene.getObjectByName('BODY') !== undefined, 'Scene has BODY group');
assert(carScene.getObjectByName('STEER') !== undefined, 'Scene has STEER group');
assert(carScene.getObjectByName('WHEEL_LF') !== undefined, 'Scene has WHEEL_LF');
assert(carScene.getObjectByName('WHEEL_RF') !== undefined, 'Scene has WHEEL_RF');
assert(carScene.getObjectByName('WHEEL_LR') !== undefined, 'Scene has WHEEL_LR');
assert(carScene.getObjectByName('WHEEL_RR') !== undefined, 'Scene has WHEEL_RR');

const extras = carScene.userData as Record<string, unknown>;
assert(extras.wheelCentres !== undefined, 'Scene has wheelCentres extras');
assert(extras.wheelbaseM !== undefined, 'Scene has wheelbaseM extras');
assert(extras.cameras !== undefined, 'Scene has cameras extras');

const noTyresModel = {
  ...parsedKn5,
  nodes: parsedKn5.nodes.map((node) => node.name.startsWith('TYRE_') ? { ...node, active: false } : node),
};
const noTyres = buildKn5Scene(noTyresModel);
assert(noTyres.userData.tyreRadius.LF === 0.32 && noTyres.userData.tyreHalfWidth.RF === 0.12,
  'an empty visual wheel slot has finite tyre dimensions instead of displacing the rig to infinity');

const centerlineScene = buildKn5Scene({
  ...noTyresModel,
  nodes: noTyresModel.nodes.map((node) => {
    const front = node.name.endsWith('_RR');
    if (!front && !node.name.endsWith('_LR')) return node;
    const worldMatrix = new THREE.Matrix4().makeTranslation(0, 0.3, front ? 0.7 : -0.7);
    if (!node.mesh) return { ...node, worldMatrix };
    const positions = new Float32Array([-0.07, -0.3, 0, 0.07, 0.3, 0.28, 0, 0, -0.28]);
    return {
      ...node, active: true, name: front ? '_wheel_lf_mesh' : 'Mesh', worldMatrix,
      mesh: { ...node.mesh, positions, materialIndex: 0 },
    };
  }),
});
const frontVisualWheel = centerlineScene.getObjectByName('WHEEL_LF')!;
const rearVisualWheel = centerlineScene.getObjectByName('WHEEL_LR')!;
assert(frontVisualWheel.children.length === 1 && rearVisualWheel.children.length === 1 &&
  centerlineScene.getObjectByName('WHEEL_RR')?.children.length === 0 &&
  frontVisualWheel.position.z === 0.7 && rearVisualWheel.position.z === -0.7,
  'two centerline wheels exported as rear corners spin about their own pivots on the correct axle channels');
assert(Math.abs(new THREE.Box3().setFromObject(frontVisualWheel).min.y) < 1e-6 &&
  Math.abs(centerlineScene.userData.tyreRadius.LF - 0.3) < 1e-6,
  'the untagged front wheel sits on the road at its measured radius');

const sharedPlastic: Kn5Model = {
  ...parsedKn5,
  materials: [{ ...parsedKn5.materials[0], name: 'Plastic', blend: 1 }],
  nodes: [
    parsedKn5.nodes[0],
    { ...parsedKn5.nodes[1], name: 'RIM_RF_Mesh' },
    { ...parsedKn5.nodes[1], name: 'BODY_PANEL' },
  ],
};
const mechanicalAppearance = planKn5Appearance(sharedPlastic);
const lookAt = (appearance: ReturnType<typeof planKn5Appearance>, node: number) =>
  appearance.surfaces[appearance.meshSurfaces.get(node)!]?.looks[0];
assert(lookAt(mechanicalAppearance, 1)?.alphaMode === 'opaque' &&
  lookAt(mechanicalAppearance, 2)?.alphaMode === 'blend',
  'a shared material separates solid wheel parts from a blended body surface');
const cspBlend = planKn5Appearance(sharedPlastic, {
  appearanceConfig: ['[SHADER_REPLACEMENT_0]\nMATERIALS=Plastic\nBLEND_MODE=ALPHA_BLEND'],
});
assert(lookAt(cspBlend, 1)?.alphaMode === 'blend', 'an explicit CSP blend overrides the solid-part heuristic');
const cutoutAppearance = planKn5Appearance({
  ...sharedPlastic,
  materials: [{ ...sharedPlastic.materials[0], alphaTested: true }],
});
assert(lookAt(cutoutAppearance, 1)?.alphaMode === 'test', 'alpha-tested wheel parts keep their cutouts');

console.log('\n--- Testing DDS and AC albedo ---');

function ddsFixture({
  width = 1, height = 1, bits = 0, masks = [], pixelFlags = 4, pitch, fourCC = 0, dxgi, payload,
}: {
  width?: number; height?: number; bits?: number; masks?: readonly number[];
  pixelFlags?: number; pitch?: number; fourCC?: number; dxgi?: number; payload: ArrayLike<number>;
}) {
  const offset = dxgi === undefined ? 128 : 148;
  const bytes = new Uint8Array(offset + payload.length);
  const view = new DataView(bytes.buffer);
  const uint = (at: number, value: number) => view.setUint32(at, value, true);
  uint(0, 0x20534444);
  uint(4, 124);
  uint(8, pitch === undefined ? 0x1007 : 0x100f);
  uint(12, height);
  uint(16, width);
  uint(20, pitch ?? 0);
  uint(76, 32);
  uint(80, pixelFlags);
  uint(84, dxgi === undefined ? fourCC : 0x30315844);
  uint(88, bits);
  masks.forEach((mask, i) => uint(92 + i * 4, mask));
  uint(108, 0x1000);
  if (dxgi !== undefined) {
    uint(128, dxgi);
    uint(132, 3);
    uint(140, 1);
  }
  bytes.set(payload, offset);
  return bytes;
}

function pixel(texture: THREE.Texture | null | undefined, x = 0, y = 0): string | undefined {
  const pixels = texturePixels(texture ?? null);
  const at = pixels ? (y * pixels.width + x) * 4 : 0;
  return pixels?.data.subarray(at, at + 4).join(',');
}

function ddsPixel(data: Uint8Array | ArrayBuffer, x?: number, y?: number): string | undefined {
  return pixel(createTexture('fixture.dds', data instanceof Uint8Array ? data : new Uint8Array(data)), x, y);
}

const luminance = ddsFixture({ bits: 8, masks: [0xff], pixelFlags: 0x20000, payload: [73] });
const luminanceAlpha = ddsFixture({ bits: 16, masks: [0xff, 0, 0, 0xff00], pixelFlags: 0x20001, payload: [200, 0] });
assert(ddsPixel(luminance) === '73,73,73,255', '8-bit luminance expands to opaque RGB');
assert(ddsPixel(luminanceAlpha) === '200,200,200,0', '16-bit luminance keeps zero alpha and RGB');
const paddedLuminanceAlpha = ddsFixture({
  height: 2, bits: 16, masks: [0xff, 0, 0, 0xff00], pixelFlags: 0x20001, pitch: 4,
  payload: [200, 0, 111, 222, 81, 113],
});
assert(ddsPixel(paddedLuminanceAlpha, 0, 1) === '81,81,81,113', '16-bit luminance honours row pitch and partial coverage');
assert(ddsPixel(ddsFixture({ bits: 16, masks: [0xf800, 0x07e0, 0x001f], pixelFlags: 0x40, payload: [0x1f, 0xfc] })) === '255,130,255,255',
  'RGB565 masks are decoded as colour, not luminance-alpha');
const paddedBgr = ddsFixture({
  height: 2, bits: 24, masks: [0xff0000, 0xff00, 0xff], pixelFlags: 0x40, pitch: 4,
  payload: [11, 22, 33, 240, 44, 55, 66],
});
assert(ddsPixel(paddedBgr, 0, 1) === '66,55,44,255', '24-bit DDS respects row pitch and channel masks');
assert(ddsPixel(ddsFixture({ bits: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000], pixelFlags: 0x41, payload: [3, 2, 1, 9] })) === '1,2,3,9',
  '32-bit BGRA imports without losing coverage');
assert(ddsPixel(ddsFixture({ dxgi: 88, payload: [3, 2, 1, 0] })) === '1,2,3,255', 'DX10 BGRX ignores the padding byte');
assert(ddsPixel(paddedBgr.subarray(0, paddedBgr.length - 1)) === undefined, 'truncated DDS is rejected before decode');
assert(ddsPixel(ddsFixture({ dxgi: 100, payload: [0, 0, 0, 0] })) === undefined, 'unsupported DDS is not a successful grey override');

const bc3 = ddsFixture({
  width: 4, height: 4, fourCC: 0x35545844,
  payload: [0, 0, 7, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0],
});
assert(ddsPixel(bc3, 0) === '255,255,255,255' && ddsPixel(bc3, 1) === '255,255,255,0',
  'BC3 with zero endpoints preserves both the mask and its explicit opaque index');

// Mode 6, identical even RGBA endpoints, p-bits and indices all zero.
function bc7Solid(color: Rgba): Uint8Array {
  const block = new Uint8Array(16);
  block[0] = 1 << 6;
  let offset = 7;
  for (const chan of color) {
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      for (let bit = 1; bit <= 7; bit++, offset++) block[offset >> 3] |= ((chan >> bit) & 1) << (offset % 8);
    }
  }
  return block;
}

const bc7Blocks = [
  ...bc7Solid([200, 50, 10, 128]), ...bc7Solid([40, 60, 80, 200]),
  ...bc7Solid([60, 240, 90, 64]), ...bc7Solid([20, 30, 240, 254]),
];
const bc7 = ddsFixture({ width: 5, height: 5, dxgi: 98, payload: bc7Blocks });
assert(ddsPixel(bc7) === '200,50,10,128' && ddsPixel(bc7, 4, 0) === '40,60,80,200' && ddsPixel(bc7, 4, 4) === '20,30,240,254',
  'BC7 decodes RGBA across block rows and clips edges');
assert([97, 99].every((dxgi) => ddsPixel(ddsFixture({ width: 5, height: 5, dxgi, payload: bc7Blocks })) === '200,50,10,128'),
  'BC7 typeless and sRGB variants have the same channel data');
assert(ddsPixel(bc7.subarray(0, bc7.length - 1)) === undefined, 'a missing BC7 block does not become black paint');

const testRgba = (bytes: number[], width = 1, height = 1) => rgbaTexture('fixture', new Uint8Array(bytes), width, height);
const diffuse = testRgba([200, 100, 50, 0, 240, 230, 220, 255], 2);
const detail = testRgba([255, 64, 0, 128, 64, 255, 255, 0], 2);
const baked = bakeAlbedo({ diffuse, detail, detailUv: 2, preserveAlpha: false });
assert(pixel(baked, 0) === '200,25,0,255' && pixel(baked, 1) === '50,100,50,255' && pixel(baked, 3) === '240,230,220,255',
  'opaque multimap repeats detail UVs but protects the printed diffuse colour');
const stripe = bakeAlbedo({ diffuse: testRgba([255, 255, 255, 0]), detail, detailUv: 2, preserveAlpha: true });
assert(pixel(stripe, 0) === '255,64,0,128' && pixel(stripe, 1) === '64,255,255,0',
  'neutral diffuse placeholder leaves RGB and coverage to the detail stripe');
assert(pixel(bakeAlbedo({ diffuse: null, detail, detailUv: 0, preserveAlpha: true })) === '255,64,0,128',
  'explicit zero UV scale samples a constant detail colour');
assert(ddsPixel(albedoDds(stripe!)!, 1) === pixel(stripe, 1), 'rig DDS bridge preserves colour behind zero alpha');

const ao = new Uint8Array(512 * 512 * 4).fill(200);
ao.set([200, 100, 60, 0, 200, 100, 60, 128, 200, 100, 60, 255]);
const coat = testRgba([51, 153, 230, 90, 51, 153, 230, 90], 2);
const flatLayers = { diffuse: rgbaTexture('ao', ao, 512, 512), detail: coat, detailUv: 350 };
const flatPaint = bakeAlbedo({ ...flatLayers, preserveAlpha: false });
const flatPaintSize = texturePixels(flatPaint);
assert(flatPaintSize?.width === 512 && flatPaintSize?.height === 512, 'uniform tiled paint keeps the original AO atlas size');
assert(pixel(flatPaint) === '40,60,54,255' && pixel(flatPaint, 1) === '120,80,57,255' && pixel(flatPaint, 2) === '200,100,60,255',
  'large flat-coat bake keeps unmasked, partly masked and fully masked diffuse pixels');
const flatCutout = bakeAlbedo({ ...flatLayers, preserveAlpha: true });
assert(pixel(flatCutout) === '40,60,54,0' && pixel(flatCutout, 1) === '120,80,57,128' && pixel(flatCutout, 2) === '200,100,60,255',
  'a flat coat does not replace the coverage of a real diffuse cutout');
const averaged = bakeAlbedo({ diffuse: null, detail, detailUv: 5000, preserveAlpha: true });
assert(texturePixels(averaged)?.width === 1 && texturePixels(averaged)?.height === 1 && pixel(averaged) === '160,160,128,64',
  'high-frequency detail still averages its colour and coverage without aliasing or inflating the map');

// ---------------------------------------------------------------------------
// 4. dynamic-vehicle tests
// ---------------------------------------------------------------------------
console.log('\n--- Testing dynamic-vehicle ---');

const removeActiveCustomCarAction = selectedCustomCarActionForRegistryChange('custom_active', {
  type: 'unregistered',
  id: 'custom_active',
});
assert(removeActiveCustomCarAction?.type === 'fallback' && removeActiveCustomCarAction.carId === 'lc26',
  'removing the selected mod falls back to the 2026 F1 car');
assert(selectedCustomCarActionForRegistryChange('custom_active', {
  type: 'unregistered',
  id: 'custom_other',
}) === null, 'removing another mod leaves the current custom-car session untouched');
assert(selectedCustomCarActionForRegistryChange('custom_active', {
  type: 'registered',
  id: 'custom_other',
}) === null, 'registering another mod does not restart the current custom-car session');
const reloadActiveCustomCarAction = selectedCustomCarActionForRegistryChange('custom_active', {
  type: 'registered',
  id: 'custom_active',
});
assert(reloadActiveCustomCarAction?.type === 'reload' && reloadActiveCustomCarAction.carId === 'custom_active',
  'reimporting the selected mod reloads its updated model and physics');

const simProfile = createCustomSimProfile('custom_test_car', physicsConfig);
assert(simProfile.id === 'custom_test_car', 'createCustomSimProfile creates profile');

const vehicleModel = createDynamicVehicleModel('custom_test_car', physicsConfig, 'road');
assert((vehicleModel.id as string) === 'custom_test_car', 'createDynamicVehicleModel sets vehicle ID');
assert(vehicleModel.classId === 'road', 'createDynamicVehicleModel sets class');
assert(vehicleModel.limiterRpm === 7200, 'createDynamicVehicleModel sets limiterRpm');

// These fixtures use only Node's in-memory registries; no browser or stored mods are opened.
console.log('\n--- Testing imported steering lock and wheel input ---');
const wheelFixture = mapAcPhysics(new AcModData({
  ...mockFiles,
  'car.ini': '[BASIC]\nTOTALMASS=1400\n[CONTROLS]\nSTEER_LOCK=360\nSTEER_RATIO=13.5',
}));
const fixtureChassis = wheelFixture.chassis as typeof wheelFixture.chassis & { steerLockDeg?: number; steerRatio?: number };
const nearWheel = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;
assert(fixtureChassis.steerLockDeg === 360 && fixtureChassis.steerRatio === 13.5 &&
  nearWheel(fixtureChassis.maxRoadWheelDeg, 360 / 13.5),
  'mapper keeps the synthetic 360° per-side lock, 13.5:1 ratio and full road-wheel angle');

const officialLocks: Record<string, number> = {
  lc26: 360,
  'f12026-car': 360,
  'amg-gt3': 640,
  liana: 1080,
  'mtr-496r': 480,
  'lc-lmdh': 450,
  'nissan-r33-jgtc': 500,
  'nissan-r32-jtcc': 720,
  'bmw-m1-procar': 720,
  'vw-scirocco-gtx': 900,
  'chaparral-2d': 720,
  'chaparral-2d-67': 720,
  'porsche-934-rsr': 1080,
};
const officialLocksUnchanged = () => Object.entries(officialLocks).every(([id, expected]) =>
  CAR_WHEEL_LOCKS_DEG[id] === expected && carWheelLockDeg(id) === expected);
assert(officialLocksUnchanged(), 'official cars start with their existing wheel locks');

const absentLock = Symbol('absent');
const wheelLockCases: { label: string; lock: unknown; mass: number; expected: number; classId?: 'road' | 'f1' }[] = [
  { label: '360° per side', lock: 360, mass: 1400, expected: 720 },
  { label: '450° per side', lock: 450, mass: 1400, expected: 900 },
  { label: 'absent lock', lock: absentLock, mass: 1400, expected: 450 },
  { label: 'undefined lock', lock: undefined, mass: 1400, expected: 450 },
  { label: 'null lock', lock: null, mass: 1400, expected: 450 },
  { label: 'zero', lock: 0, mass: 1400, expected: 360 },
  { label: 'negative', lock: -1, mass: 1400, expected: 360 },
  { label: 'NaN lock', lock: NaN, mass: 1400, expected: 360 },
  { label: 'positive infinity', lock: Infinity, mass: 1400, expected: 360 },
  { label: 'negative infinity', lock: -Infinity, mass: 1400, expected: 360 },
  { label: 'numeric string', lock: '360', mass: 1400, expected: 360 },
  { label: 'boolean', lock: true, mass: 1400, expected: 360 },
  { label: 'doubling overflow', lock: Number.MAX_VALUE, mass: 1400, expected: 360 },
  { label: 'large finite double', lock: Number.MAX_VALUE / 2, mass: 1400, expected: Number.MAX_VALUE },
  { label: '949 kg, 450° on road class', lock: 450, mass: 949, expected: 360, classId: 'road' },
  { label: '949 kg, missing lock', lock: absentLock, mass: 949, expected: 360 },
  { label: '949 kg, invalid lock', lock: Infinity, mass: 949, expected: 360 },
  { label: '950 kg, 360° on F1 class', lock: 360, mass: 950, expected: 720, classId: 'f1' },
  { label: 'NaN mass, 360°', lock: 360, mass: NaN, expected: 720 },
  { label: 'NaN mass, missing lock', lock: absentLock, mass: NaN, expected: 450 },
  { label: 'NaN mass, invalid lock', lock: -1, mass: NaN, expected: 360 },
];
const wheelTestIds: string[] = [];
try {
  for (const [index, test] of wheelLockCases.entries()) {
    const id = `custom_wheel_lock_fixture_${index}`;
    wheelTestIds.push(id);
    const config = structuredClone(wheelFixture);
    config.chassis.totalMassKg = test.mass;
    const chassis = config.chassis as typeof config.chassis & { steerLockDeg?: unknown };
    if (test.lock === absentLock) delete chassis.steerLockDeg;
    else chassis.steerLockDeg = test.lock;
    const originalChassis = structuredClone(config.chassis);

    createDynamicVehicleModel(id, config, test.classId);
    const first = CAR_WHEEL_LOCKS_DEG[id];
    createDynamicVehicleModel(id, config, test.classId);
    const second = CAR_WHEEL_LOCKS_DEG[id];
    assert(Number.isFinite(first) && first === test.expected && second === test.expected,
      `${test.label}: register ${test.expected}° lock-to-lock twice (got ${String(first)}, ${String(second)})`);
    assert(Object.hasOwn(chassis, 'steerLockDeg') === Object.hasOwn(originalChassis, 'steerLockDeg') &&
      Object.is(chassis.steerLockDeg, (originalChassis as typeof chassis).steerLockDeg) &&
      Object.is(chassis.totalMassKg, originalChassis.totalMassKg) &&
      chassis.maxRoadWheelDeg === originalChassis.maxRoadWheelDeg &&
      (chassis as typeof chassis & { steerRatio?: number }).steerRatio ===
        (originalChassis as typeof chassis & { steerRatio?: number }).steerRatio,
      `${test.label}: repeated registration leaves the source steering data and mass unchanged`);
  }

  const id = 'custom_wheel_input_fixture';
  wheelTestIds.push(id);
  const model = createDynamicVehicleModel(id, wheelFixture, 'road');
  const binding = { center: 0, invert: false };
  const realLock = carWheelLockDeg(id);
  const sim = model.createSim(createFlatTestTrack(), null);
  sim.assistPreset = 'pro';
  sim.teleportToDistance(1500, 0);

  for (const sign of [-1, 1]) {
    for (const [base, normalized, roadDeg] of [
      [900, 0.25, 90 / 13.5],
      [540, 1 / 3, (360 / 13.5) / 3],
      [360, 0.5, (360 / 13.5) / 2],
    ]) {
      const raw = sign * 90 / (base / 2);
      const command = wheelSteerValue(raw, binding, base, 0, realLock);
      sim.step(1 / 60, { analogSteer: command, steerRim: true });
      assert(nearWheel(wheelRimAngleDeg(raw, binding, base), sign * 90) &&
        nearWheel(command, sign * normalized) &&
        nearWheel(sim.telemetry.steering, sign * normalized) &&
        nearWheel(sim.telemetry.steering * sim.maxSteerAngleRad * 180 / Math.PI, sign * roadDeg),
        `${base}° base, rim ${sign * 90}°: real input reaches the rack at ${sign * roadDeg}° road-wheel command`);
    }

    for (const [rim, expectedCommand, expectedForce] of [
      [359, 359 / 360, 0],
      [360, 1, 0],
      [366, 1, -0.5],
      [372, 1, -1],
      [450, 1, -1],
    ]) {
      const raw = sign * rim / 450;
      const physicalRim = wheelRimAngleDeg(raw, binding, 900);
      assert(nearWheel(wheelSteerValue(raw, binding, 900, 0, realLock), sign * expectedCommand) &&
        nearWheel(softLockForce(physicalRim, realLock), sign * expectedForce),
        `900° base: ${sign * rim}° rim respects the ±360° virtual stop and soft-lock ramp`);
    }
    for (const base of [540, 360]) {
      const physicalRim = wheelRimAngleDeg(sign, binding, base);
      assert(nearWheel(wheelSteerValue(sign, binding, base, 0, realLock), sign) &&
        softLockForce(physicalRim, realLock) === 0,
        `${base}° base: ${sign < 0 ? 'left' : 'right'} physical stop reaches full rack before the 720° virtual stop`);
    }

    const quickerLock = carWheelLockDeg(id, { [id]: 480 });
    const quickerRaw = sign * 90 / 450;
    assert(quickerLock === 480 &&
      nearWheel(wheelSteerValue(quickerRaw, binding, 900, 0, quickerLock), sign * 0.375) &&
      softLockForce(sign * 240, quickerLock) === 0 &&
      nearWheel(softLockForce(sign * 246, quickerLock), -sign * 0.5),
      `valid per-car 480° preference changes ${sign * 90}° input and the soft-lock stop`);
    for (const invalid of [100, 720, 800, NaN, Infinity, '480', true]) {
      const playerLocks = { [id]: invalid } as unknown as Record<string, number>;
      const lock = carWheelLockDeg(id, playerLocks);
      assert(lock === 720 &&
        nearWheel(wheelSteerValue(quickerRaw, binding, 900, 0, lock), sign * 0.25) &&
        softLockForce(sign * 240, lock) === 0 &&
        nearWheel(softLockForce(sign * 366, lock), -sign * 0.5),
        `invalid per-car preference ${String(invalid)} keeps the 720° input and soft lock (${sign < 0 ? 'left' : 'right'})`);
    }
  }
  assert(officialLocksUnchanged(), 'registering imported fixtures does not change any official wheel lock');
} finally {
  for (const id of wheelTestIds) {
    delete (CAR_WHEEL_LOCKS_DEG as Record<string, number>)[id];
    unregisterCarRevRange(id);
  }
}

const mockCarRecord = {
  id: 'custom_test_car',
  title: 'Test Mod Car',
  subTitle: 'Street 2.0 Turbo',
  author: 'Antigravity Modder',
  year: 2024,
  classId: 'road' as const,
  physicsConfig,
  glbBlob: new Blob(['mock'], { type: 'model/gltf-binary' }),
  importedAt: Date.now(),
};

const carDef = createCustomCarDefinition(mockCarRecord, 'blob:http://localhost/test.glb');
assert((carDef.id as string) === 'custom_test_car', 'createCustomCarDefinition sets car id');
assert(carDef.badge === 'MOD', 'createCustomCarDefinition sets badge to MOD');
assert(carDef.modelUrl === 'blob:http://localhost/test.glb', 'createCustomCarDefinition sets modelUrl');

function materialAt(root: THREE.Object3D | null, mesh: string): THREE.MeshStandardMaterial | undefined {
  const object = root?.getObjectByName(mesh) as THREE.Mesh | undefined;
  return object?.isMesh && !Array.isArray(object.material) ? object.material as THREE.MeshStandardMaterial : undefined;
}

function portedRig(car: CarDefinition, record: CustomCarRecord) {
  return createPortedCarRig({
    url: car.modelUrl!,
    chassis: record.physicsConfig.chassis,
    floor: staticFloorOf(record.physicsConfig),
    steerLockDeg: 180,
    customMod: true,
  });
}

function wearing(car: CarDefinition, index: number) {
  const skin = car.skins![index];
  return { baseUrl: carSkinBaseUrl(car.id, skin.id), files: skin.files };
}

async function appearanceMatches(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  do {
    if (check()) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  } while (performance.now() < deadline);
  return check();
}

async function runCameraTests() {
  console.log('\n--- Testing Assetto Corsa onboard cameras ---');

  const eye = [0.32, 1.02, -0.25];
  const dash = [0.31, 0.91, 0.16];
  const bumper = [0.02, 0.48, 2.15];
  const tcam = [-0.17, 1.32, -0.42];
  const forward = new THREE.Vector3(0.21, -0.3, 0.93).normalize();
  const up = new THREE.Vector3(0.15, 1, 0.22);
  const carIni = `${mockFiles['car.ini']}
[GRAPHICS]
DRIVEREYES=${eye}
ON_BOARD_PITCH_ANGLE=-2.5
BUMPER_CAMERA_POS=${bumper}
BUMPER_CAMERA_PITCH=1.5`;
  const camerasIni = `[CAMERA_0]
POSITION=${tcam}
FORWARD=${forward.toArray()}
UP=${up.toArray()}
FOV=62
[CAMERA_5]
POSITION=0,1.4,0.8
FORWARD=0,-0.2,-1
FOV=41`;
  const dashIni = `[DASH_CAM]\nPOS=${dash}`;
  const config = mapAcPhysics(new AcModData({
    ...mockFiles, 'car.ini': carIni, 'dash_cam.ini': dashIni, 'cameras.ini': camerasIni,
  }));
  const equalsPos = (position: number[] | undefined, expected: number[]) =>
    position?.length === 3 && position.every((value, index) => value === expected[index]);
  assert(equalsPos(config.cameras?.cockpit?.pos, eye) && config.cameras?.cockpit?.pitchDeg === -2.5,
    'cockpit uses the authored driver eye and pitch, not CAMERA_0');
  assert(equalsPos(config.cameras?.dash?.pos, dash), 'dash uses the position in dash_cam.ini');
  assert(equalsPos(config.cameras?.bumper?.pos, bumper) && config.cameras?.bumper?.pitchDeg === 1.5,
    'nose uses the authored bumper position and pitch');
  assert(equalsPos(config.cameras?.tcam?.pos, tcam) && config.cameras?.tcam?.fov === 62,
    'T-cam uses the elevated forward-looking position, not rear-looking CAMERA_5');

  const missingEye = mapAcPhysics(new AcModData({
    ...mockFiles, 'car.ini': carIni.replace(`DRIVEREYES=${eye}`, 'DRIVEREYES=0,,not-a-coordinate,1'),
    'dash_cam.ini': dashIni, 'cameras.ini': camerasIni,
  }));
  assert(!missingEye.cameras?.cockpit && equalsPos(missingEye.cameras?.dash?.pos, dash),
    'malformed eye coordinates use the cockpit fallback without affecting the authored dash');
  const backwards = mapAcPhysics(new AcModData({
    ...mockFiles, 'car.ini': carIni, 'cameras.ini': camerasIni.replace(`FORWARD=${forward.toArray()}`, 'FORWARD=0,0,-1'),
  }));
  assert(!backwards.cameras?.tcam, 'a rearward camera is not selected for the forward-facing T-cam');

  const record: CustomCarRecord = {
    ...mockCarRecord,
    id: 'custom_camera_fixture',
    physicsConfig: config,
    kn5Blob: new Blob([new Uint8Array(mockKn5Bytes)]),
  };
  const car = registerCustomCarMod(record, parsedKn5);
  const rig = portedRig(car, record);
  try {
    await loadTemplate(car.modelUrl!);
    const anchors = rig.getCameraAnchors();
    assert(anchors !== null, 'camera fixture has a loaded ported rig');
    if (!anchors) return;
    // The mesh vertex starts at (0, .5, 0) in KN5. Subtract it to check that the eye
    // and dash get the exact same ground and chassis translations as the model.
    const body = rig.root.getObjectByName('BODY_BODY_SHELL') as THREE.Mesh | undefined;
    const meshPosition = body?.geometry.getAttribute('position');
    assert(Boolean(body && meshPosition), 'camera fixture has a reference body vertex');
    if (!body || !meshPosition) return;
    const rawOrigin = new THREE.Vector3(0, 0.5, 0);
    const actualVertex = rig.chassisGroup.worldToLocal(body.localToWorld(new THREE.Vector3().fromBufferAttribute(meshPosition, 0)));
    const translation = actualVertex.sub(rawOrigin);
    const matchesAnchor = (pos: THREE.Vector3 | undefined, expected: number[]) =>
      pos !== undefined && pos.distanceTo(new THREE.Vector3().fromArray(expected).add(translation)) < 1e-6;
    assert(matchesAnchor(anchors.cockpit.pos, eye) && matchesAnchor(anchors.bumper.pos, bumper),
      'ported eye and bumper positions follow the same coordinate transform as the body mesh');
    const views = new OnboardViews();
    assert(matchesAnchor(views.resolve(anchors, 'dash', car.id, undefined)?.pos, dash),
      'the actual imported dash view uses the author’s anchor instead of a generic eye offset');
    const unmarked = { ...anchors, dash: { ...anchors.dash, authoredDash: false } };
    const prototypeDash = views.resolve(unmarked, 'dash', 'lc26', undefined);
    assert(Boolean(prototypeDash && prototypeDash.pos.distanceTo(anchors.cockpit.pos.clone().add(new THREE.Vector3(0, -0.03, 0.18))) < 1e-9),
      'a model without an authored dash override still uses the official Prototype dash offset');
    assert(matchesAnchor(anchors.tcam.pos, tcam) &&
      Boolean(anchors.tcam.rotation &&
        new THREE.Vector3(0, 0, -1).applyQuaternion(anchors.tcam.rotation).distanceTo(forward) < 1e-9 &&
        new THREE.Vector3(0, 1, 0).applyQuaternion(anchors.tcam.rotation)
          .distanceTo(up.clone().addScaledVector(forward, -up.dot(forward)).normalize()) < 1e-9),
    'ported T-cam retains the authored facing and roll as well as its position');
  } finally {
    rig.dispose();
    unregisterCustomCarMod(record.id);
  }
}

async function runLiveryTests() {
  console.log('\n--- Testing CSP appearance and live livery changes ---');

  const carConfig = `
    [SHADER_REPLACEMENT_...]
    MATERIALS=CarBody
    RESOURCE_0=txDetail
    RESOURCE_FILE_0=coating.dds
    [SHADER_REPLACEMENT_...]
    MATERIALS=RaceNumber
    BLEND_MODE=ALPHA_TEST
    PROP_1=ksAlphaRef, 0.25
    [SHADER_REPLACEMENT_...]
    ACTIVE=0
    MATERIALS=CarBody
    RESOURCE_0=txDetail
    RESOURCE_COLOR_0=#000000
    [INCLUDE: side_effect.ini]
    [SCRIPT_TEST]
    SCRIPT=must_not_run.lua
  `;
  const skinConfig = `
    [SHADER_REPLACEMENT_...]
    MATERIALS=CARBODY
    MESHES=?mirror?
    RESOURCE_0=TXDETAIL
    RESOURCE_COLOR_0=#0000ff
  `;
  assert(parseCspAppearance([carConfig]).length === 2, 'repeated CSP sections keep both literal rules, not includes or disabled sections');

  const makeDds = (channels: number[], width?: number) => albedoDds(testRgba(channels, width))!;
  const originalNumber = [42, 50, 60, 64, 32, 20, 30, 0];
  const nextNumber = [160, 100, 32, 255, 200, 20, 20, 0];
  const model: Kn5Model = {
    ...parsedKn5,
    textures: new Map(Object.entries({
      'body_ao.dds': luminanceAlpha,
      'unused_detail.dds': new Uint8Array(makeDds([19, 5, 12, 255])),
      'coating.dds': new Uint8Array(makeDds([255, 255, 255, 255])),
      'number.dds': new Uint8Array(makeDds(originalNumber, 2)),
    }).map(([name, data]) => [name, { name, data, type: 1 }])),
    materials: [
      { ...parsedKn5.materials[0], shader: 'ksPerPixelMultiMap', props: { detailUVMultiplier: 40 }, maps: { txDiffuse: 'body_ao.dds', txDetail: 'unused_detail.dds' } },
      parsedKn5.materials[1],
      { name: 'RaceNumber', shader: 'ksPerPixel', alphaTested: false, blend: 0, maps: { txDiffuse: 'number.dds' }, props: {} },
    ],
    nodes: [
      ...parsedKn5.nodes,
      { ...parsedKn5.nodes[1], name: 'MIRROR' },
      { ...parsedKn5.nodes[1], name: 'NUMBER', mesh: { ...parsedKn5.nodes[1].mesh!, materialIndex: 2 } },
    ],
  };
  const record: CustomCarRecord = {
    ...mockCarRecord,
    id: 'custom_livery_fixture',
    glbBlob: undefined,
    kn5Blob: new Blob([new Uint8Array(mockKn5Bytes)]),
    appearanceConfig: [carConfig],
    skins: [
      { name: 'Red', swatch: ['#777777', '#222222'], swatchSource: 'authored', textures: { 'Layers\\COATING.DDS': new Blob([makeDds([255, 0, 0, 255])]) } },
      { name: 'Green', textures: { 'coating.dds': new Blob([makeDds([0, 255, 0, 255])]), 'NUMBER.DDS': new Blob([makeDds(nextNumber, 2)]) }, appearanceConfig: skinConfig },
      { name: 'Embedded', textures: {} },
      { name: 'Corrupt override', textures: { 'Coating.dds': new Blob([bc7.subarray(0, 150)]) } },
    ],
  };
  const body = 'BODY_BODY_SHELL', mirror = 'BODY_MIRROR', number = 'BODY_NUMBER';
  const car = registerCustomCarMod(record, model);
  const rig = portedRig(car, record);
  const show = (name: string, x = 0) => pixel(materialAt(rig.root, name)?.map, x);
  try {
    const template = await loadTemplate(car.modelUrl!);
    assert(portedSkinFor(car.id, car.skins![0])?.baseUrl === carSkinBaseUrl(car.id, car.skins![0].id),
      'the current livery API resolves even the first imported skin');
    assert(portedSkinFor(car.id, car.skins![1])?.files === car.skins![1].files,
      'the current livery API passes compiled imported skin files to the rig');
    assert(!vehicleModelsFor('any').includes(car.physics),
      'local imported physics are not advertised as available to online peers');
    assert(challengeCompound(car.physics) === 'soft' && challengeConditionsLabel(car.physics).includes('Slicks'),
      'challenge screens handle an imported vehicle without a built-in tyre entry');
    assert(pixel(materialAt(template, body)?.map) === '200,0,0,255', 'initial skin resolves case-insensitive loose txDetail over the embedded file');
    assert(materialAt(template, number)?.alphaTest === 0.25, 'the second repeated shader replacement sets decal coverage');
    assert(car.skins?.[0].swatch[0] === '#777777', 'authored swatches are not repainted or substituted');
    rig.setSkin?.(wearing(car, 1));
    assert(await appearanceMatches(() => show(body) === '0,200,0,255' && show(mirror) === '0,0,200,255'),
      'live livery uses the same bake, with skin config overriding car config only on the targeted mesh');
    assert(await appearanceMatches(() => show(number, 1) === '200,20,20,0'),
      'live livery updates an alpha-tested non-paint material without discarding coverage');
    rig.setSkin?.(wearing(car, 2));
    assert(await appearanceMatches(() => show(body) === '200,200,200,255' && show(mirror) === '200,200,200,255' && show(number) === '42,50,60,64'),
      'a skin without overrides uses embedded paint and restores the unchanged number map');
    rig.setSkin?.(wearing(car, 1));
    assert(await appearanceMatches(() => show(body) === '0,200,0,255'), 'a cached livery can be selected again');
    rig.setSkin?.(wearing(car, 3));
    assert(await appearanceMatches(() => show(body) === '200,200,200,255'), 'a corrupt override falls back on the live rig');
    rig.setSkin?.(wearing(car, 0));
    assert(show(body) === '200,0,0,255' && show(number) === '42,50,60,64', 'changing back restores the original map and decal');

    const revised = registerCustomCarMod({
      ...record,
      skins: record.skins!.map((skin, i) => i === 1 ? { ...skin, textures: { ...skin.textures, 'coating.dds': new Blob([makeDds([255, 255, 0, 255])]) } } : skin),
    }, model);
    const revisedRig = portedRig(revised, record);
    try {
      revisedRig.setSkin?.(wearing(revised, 1));
      assert(await appearanceMatches(() => pixel(materialAt(revisedRig.root, body)?.map) === '200,200,0,255'),
        'live rig reads the replacement revision instead of loading a cached livery');
      const revisedFile = revised.skins![1].files?.[0];
      assert(Boolean(revisedFile && revisedFile !== car.skins![1].files?.[0]), 're-imported maps have fresh rig cache keys');
    } finally {
      revisedRig.dispose();
    }
    setCarSkin(car.id, car.skins![1].id);
  } finally {
    rig.dispose();
    unregisterCustomCarMod(record.id);
  }
  assert(!getCustomCarSkinRecord(record.id), 'unregister removes baked livery records');

  // The drive session can start before IndexedDB registers the car. It knows the model URL,
  // but cannot pass its saved skin until the definition exists.
  const startupRig = portedRig(car, record);
  const startupPaint = (name: string) => pixel(materialAt(startupRig.root, name)?.map);
  try {
    const restored = registerCustomCarMod(record, model);
    const savedPaint = () => startupPaint(body) === '0,200,0,255' && startupPaint(mirror) === '0,0,200,255';
    assert(await appearanceMatches(savedPaint), 'a rig started before registration already wears the saved livery on reload');
    startupRig.setSkin?.(wearing(restored, 0));
    assert(await appearanceMatches(() => startupPaint(body) === '200,0,0,255' && startupPaint(mirror) === '200,0,0,255'),
      'the first livery is still available when the template starts in the saved livery');
    startupRig.setSkin?.(wearing(restored, 1));
    assert(savedPaint(), 'reselecting the saved livery restores the rebuilt template maps');
  } finally {
    startupRig.dispose();
    unregisterCustomCarMod(record.id);
  }
}

// ---------------------------------------------------------------------------
// 5. mod-extractor & archive tests
// ---------------------------------------------------------------------------
console.log('\n--- Testing mod-extractor ---');

const hyphenatedSlugId = customCarIdForSlug('test-road');
const underscoredSlugId = customCarIdForSlug('test_road');
assert(hyphenatedSlugId !== underscoredSlugId,
  'different slugs that sanitize to the same base receive different custom-car IDs');
assert(customCarIdForSlug('rss_formula_rss_4') === 'custom_rss_formula_rss_4',
  'simple existing slugs keep their historical custom-car IDs');
assert(customCarIdForSlug('test-road', [{ id: 'custom_test_road', slug: 'test-road' }]) === 'custom_test_road',
  'reimporting a legacy installed slug preserves its existing ID');
assert(customCarIdForSlug('test_road', [{ id: 'custom_test_road', slug: 'test-road' }]) !== 'custom_test_road',
  'a new colliding slug cannot replace a legacy installed mod');

async function runCustomCarIdCollisionTests() {
  console.log('\n--- Testing colliding custom-car IDs ---');
  const slugs = ['verify-test-road', 'verify_test_road'];
  const importedIds: string[] = [];
  const archiveFor = (slug: string) => fflate.zipSync({
    [`${slug}/data/car.ini`]: fflate.strToU8('[BASIC]\nTOTALMASS=980\n'),
    [`${slug}/model.kn5`]: mockKn5Bytes,
  });

  try {
    const first = await importAssettoCorsaMod(archiveFor(slugs[0]));
    importedIds.push(first.id);
    const firstRecord = await getCustomCar(first.id);
    const second = await importAssettoCorsaMod(archiveFor(slugs[1]));
    importedIds.push(second.id);
    const preservedFirstRecord = await getCustomCar(first.id);
    const secondRecord = await getCustomCar(second.id);

    assert(first.id !== second.id && preservedFirstRecord === firstRecord &&
      firstRecord?.slug === slugs[0] && secondRecord?.slug === slugs[1] &&
      getRegisteredCars().some((car) => car.id === first.id) &&
      getRegisteredCars().some((car) => car.id === second.id),
    'two real imports with colliding sanitized slugs remain separately stored and registered');
  } finally {
    for (const id of importedIds) {
      unregisterCustomCarMod(id);
      await deleteCustomCar(id);
    }
  }
}

async function runProtectedKn5Tests() {
  console.log('\n--- Testing protected KN5 handling ---');
  const marker = new TextEncoder().encode('__AC_SHADERS_PATCH_KN5ENC_v1__');
  const footer = new Uint8Array(4 + marker.length + 8);
  const view = new DataView(footer.buffer);
  view.setUint32(0, marker.length, true);
  footer.set(marker, 4);
  view.setUint32(4 + marker.length, mockKn5Bytes.length, true);
  view.setUint32(8 + marker.length, 1, true);
  const padded = new Uint8Array(3 + mockKn5Bytes.length + footer.length + 2);
  padded.set(mockKn5Bytes, 3);
  padded.set(footer, 3 + mockKn5Bytes.length);
  const protectedBytes = padded.subarray(3, -2);
  let parseError: unknown;
  try {
    parseKn5(protectedBytes, 'model.kn5');
  } catch (err) {
    parseError = err;
  }
  assert(parseError instanceof ProtectedKn5Error && parseError.message.includes('model.kn5'),
    'the shared KN5 parser reports the actual protected file, including for a nonzero byte offset');
  const unrelatedTail = new Uint8Array(protectedBytes);
  unrelatedTail[mockKn5Bytes.length] = 0; // Same marker text, without a valid footer.
  assert(parseKn5(unrelatedTail).nodes.length === parsedKn5.nodes.length,
    'non-CSP trailing data does not block an otherwise valid KN5');
  assert(!await isCspProtectedKn5Blob(new Blob([marker])),
    'a short Blob containing only the marker text does not match');

  const folder = 'Protected_Kn5_Fixture';
  const id = `custom_${folder.toLowerCase()}`;
  const carIni = '[BASIC]\nTOTALMASS=980\n';
  const acd = createEncryptedAcd({ 'car.ini': carIni }, folder);
  const fixture = createCspKn5Fixture(folder, acd);
  const v1 = wrapCspKn5(fixture.preview, fixture.records);
  const archive = (model: Uint8Array, packedData = acd) => fflate.zipSync({
    [`${folder}/data.acd`]: packedData,
    [`${folder}/model.kn5`]: model,
  });
  const paddedReal = Buffer.concat([Buffer.of(45, 46, 47), v1, Buffer.of(48)]);
  const v1View = paddedReal.subarray(3, -1);
  const footerV1 = readCspKn5Footer(v1View)!;
  const decoded = await rebuildCspKn5(v1View, footerV1, 'model.kn5', folder, acd);
  const model = parseKn5(await decoded.arrayBuffer());
  const expected = parseKn5(fixture.plain);
  const closeArray = (a: Float32Array, b: Float32Array) =>
    a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < 1e-7);
  assert(paddedReal.equals(Buffer.concat([Buffer.of(45, 46, 47), v1, Buffer.of(48)])) && !await isCspProtectedKn5Blob(decoded),
    'the decoder accepts sliced input, does not mutate its source, and strips the envelope');
  assert(model.version === 6 && model.textures.size === 3 && [...expected.textures].every(([name, texture]) =>
    Buffer.from(model.textures.get(name)!.data).equals(Buffer.from(texture.data))),
    'both embedded textures are restored byte-for-byte and the plain slot is preserved');
  for (const [i, name] of [[1, 'static'], [2, 'skinned']] as const) {
    const got = model.nodes[i].mesh!;
    const want = expected.nodes[i].mesh!;
    assert(closeArray(got.positions, want.positions) && closeArray(got.normals, want.normals) && closeArray(got.uvs, want.uvs) &&
      got.indices.join() === want.indices.join(),
      `the ${name} mesh restores XYZ, normals and UVs with the repeating mask, without changing indices`);
  }
  const noChecksumFixture = createCspKn5Fixture(folder);
  const noChecksum = wrapCspKn5(noChecksumFixture.preview, noChecksumFixture.records);
  assert((await rebuildCspKn5(noChecksum, readCspKn5Footer(noChecksum)!, 'model.kn5', folder)).size === decoded.size &&
    (await rebuildCspKn5(noChecksum, readCspKn5Footer(noChecksum)!, 'model.kn5', folder, acd)).size === decoded.size,
    'folder-only salt works both without data.acd and as fallback when the checksum does not apply');

  const stages: string[] = [];
  const tryProtectedImport = async (bytes: Uint8Array, message: string, packedData?: Uint8Array) => {
    stages.length = 0;
    try {
      await importAssettoCorsaMod(archive(bytes, packedData), ({ stage }) => stages.push(stage));
      return false;
    } catch (err) {
      return err instanceof ProtectedKn5Error && err.message.includes(message) &&
        !stages.includes('saving') && !stages.includes('done');
    }
  };
  try {
    const v2 = wrapCspKn5(fixture.preview, fixture.records, 2);
    assert(await tryProtectedImport(v2, 'versión 2') && !await getCustomCar(id) && !getRegisteredCars().some((car) => String(car.id) === id),
      'an unsupported CSP version stops before saving or registering the mod');
    assert(await tryProtectedImport(protectedBytes, 'vacíos o dañados'), 'an empty sidecar never imports its preview');
    const truncated = Buffer.from(v1);
    truncated.writeUInt32LE(0xffffffff, footerV1.sidecarOffset);
    assert(await tryProtectedImport(truncated, 'truncados o dañados'), 'an overlong sidecar entry is rejected before allocation');
    const wrongAcd = createEncryptedAcd({ 'car.ini': `${carIni}\n; different data` }, folder);
    assert(await tryProtectedImport(v1, 'data.acd original', wrongAcd), 'CSP checksum mismatch guides the user to the original package');

    const valid = await importAssettoCorsaMod(archive(mockKn5Bytes));
    assert(Boolean(await loadTemplate(valid.modelUrl!)), 'a plain KN5 still imports and can be selected');
    const progress: string[] = [];
    const recovered = await importAssettoCorsaMod(archive(v1), ({ message }) => progress.push(message));
    const saved = await getCustomCar(id);
    assert(recovered.id === valid.id && Boolean(saved?.kn5Blob) &&
      !await isCspProtectedKn5Blob(saved?.kn5Blob) && progress.some((message) => message.includes('CSP')) &&
      Buffer.from(await saved!.kn5Blob!.arrayBuffer()).equals(Buffer.from(await decoded.arrayBuffer())),
      'the ZIP import replaces the same car with the complete rebuilt model and reports recovery progress');
    const corruptedTexture = new Map(fixture.records);
    corruptedTexture.set('tex.badge.dds.d', Buffer.of(0, 0, 0, 0));
    assert(await tryProtectedImport(wrapCspKn5(fixture.preview, corruptedTexture), 'todas las texturas') &&
      await getCustomCar(id) === saved && carById(recovered.id) === recovered,
      'a failed reimport cannot replace the working record or the open model');
    const incompleteMesh = new Map(fixture.records);
    incompleteMesh.delete('ver.BODY.x');
    assert(await tryProtectedImport(wrapCspKn5(fixture.preview, incompleteMesh), 'Faltan datos'),
      'the importer refuses a partially present vertex mask rather than keeping the scrambled mesh');

    unregisterCustomCarMod(id);
    assert(Boolean(await loadTemplate(recovered.modelUrl!)), 'a saved rebuilt model loads through the normal path without decrypting again');

    const file = (name: string, bytes: BlobPart) => ({ path: `${folder}/${name}`, file: new File([bytes], name) });
    const dropped = await importAssettoCorsaMod([file('model.kn5', noChecksum), file('data/car.ini', carIni)]);
    assert(dropped.id === recovered.id && !await isCspProtectedKn5Blob((await getCustomCar(id))?.kn5Blob),
      'folder import uses the same recovery path and keeps the folder case for CSP');
  } finally {
    await deleteCustomCar(id);
    unregisterCustomCarMod(id);
  }

  // Legacy record, using the Node memory store only. The runtime must not even
  // try to load the whole Blob or resurrect this car via a previously saved URL.
  class FooterOnlyBlob extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('The full protected model was read'); }
  }
  const legacyId = 'custom_protected_kn5_legacy';
  const legacyBlob = new FooterOnlyBlob([protectedBytes]);
  const legacy = { ...mockCarRecord, id: legacyId, kn5Blob: legacyBlob, glbBlob: undefined };
  try {
    await saveCustomCar(legacy);
    assert(await isCspProtectedKn5Blob(legacyBlob) && await loadTemplate(`custom:${legacyId}`) === null &&
      await getCustomCar(legacyId) === legacy && !getRegisteredCars().some((car) => String(car.id) === legacyId),
      'a previously saved protected model remains stored but is not loaded or registered');
  } finally {
    await deleteCustomCar(legacyId);
    unregisterCustomCarMod(legacyId);
  }
}

async function runArchiveTests() {
  // Synthetic libarchive 7z: three multi-chunk textures, of which two are identical
  // and the third differs only in its last chunk. The remaining entries are car.ini and an audio bank.
  const solid7z = Buffer.from([
    'N3q8ryccAAM2JDAisAQAAAAAAAAjAAAAAAAAAKObXcAALZCEKanrZy6jf/fe4qAFA5LSLpHR1q6HaRb3HqSDD7mugbN9XnbgCQGPnhlWSurWhJXDIp',
    'HGBQIUEFlfuh455sr+4KD2iqFeHsnQV+g60jCZLH/zDKYgc0NdOm49CT0U36oNckk5ZDAOcN+smOMEGGTUlust/y7rmh26zrEnGFxZhulmUli+6Xa',
    'sWeTlWwUI+cfarfz7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEw7/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZ',
    'cQlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+cfarfz7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz',
    '5LZkKQEw7/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZcQlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTl',
    'StB0MRirw1fD/3GHpe0hjUqjWIa5x4JI80DZGodYLdAlbA2PYNKDaVmkTB9H//6tBWHNP1gwoObLXE0b1FdzbabhyP55IbWoM49ihH1aUWKSdElc',
    'xG2ykuegyM4HBO6f3qVCy4g/XACP0E6vJiiUcR89jyThcJ6nI1/sKMuF0ZWYin4qkfIndfcZwAaYTZj92K/VkA/EJVP49ZE2MQWlsO5vwXBNRwz',
    'RkRGqrWAdus6xJxhcWYbpZlJYvul2rFnk5VsFCPnH2q38+1IrdM0eWyBC+d1TPfgpZAk7gMsqbN+1O/DEvS5fqg8+S2ZCkBMO/xCT+HF4WfgL',
    'zf+VKEYPqfx83vuaMC5WwI+F84OBwGXEJVP49ZE2MQWlsO5vwXBNRwzRkRGqrWAdus6xJxhcWYbpZlJYvul2rFnk3kHWuzIz1sjuWv/BaMvMz0',
    'BOmNH7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEw7/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZcQlU/j1kTYx',
    'BaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+cfarfz7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEw7',
    '/EJP4cXhZ+AvN/5UoRg+p/Hze+5owLlbAj4Xzg4HAZcQlU/j1kTYxBaWw7m/BcE1HDNGREaqtYB26zrEnGFxZhulmUli+6XasWeTlWwUI+cfarf',
    'z7Uit0zR5bIEL53VM9+ClkCTuAyyps37U78MS9Ll+qDz5LZkKQEPDGLMQHJi/8BxrAnUL/jqC1nf//sCUwAAAAgTMHrg/VWPsG+cZm2o4cYVMb/',
    'XInUrVt6RinNDRoG4JCpMOiIWYwNKstb4T+EmtzVhtja9FGgMopWLSSQuvVQG7ojd/EXZ0gM9hgibsfE19KElJROoioAzc5PJjz5IJWFwSAAL',
    'GP1ZvbvFyaQm16SwcJmgB3pKKgm3/3X6QXIfX/yJlf7vk4MVb2hwvoEUNyOlyUc0yKIx5AvyVBYNrD5Z/f//zUgAAXBoQHAQmAqQAHCwEAASM',
    'DAQEFXQAAgAAMgWUKATLcKhkAAA==',
  ].join(''), 'base64');
  class SliceOnlyArchive extends Blob {
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('The whole archive was buffered'); }
  }
  const packed = await unpack7z(new SliceOnlyArchive([solid7z]));
  const first = packed.get('fixture/skins/a/helmet.dds');
  const second = packed.get('fixture/skins/b/helmet.dds');
  const variant = packed.get('fixture/skins/c/helmet.dds');
  assert(packed.size === 4 && await packed.get('fixture/data/car.ini')?.text() === '[BASIC]\nTOTALMASS=980\n',
    '7z reads from Blob slices, keeps physics and skips the unused audio bank');
  assert(
    first !== undefined && first === second && variant !== undefined && first !== variant && first.size === variant.size &&
      await first.slice(0, 4).text() === 'TEST' && await first.slice(-13).text() === 'first-texture' &&
      await variant.slice(-13).text() === 'other-texture',
    '7z shares byte-identical textures and preserves same-size variants and all their chunks');
  const folderModel = new File([mockKn5Bytes as BlobPart], 'model.kn5');
  const folderFiles = readDroppedFiles([{ file: folderModel, path: 'fixture/model.kn5' }]);
  assert(folderFiles.get('fixture/model.kn5') === folderModel, 'folder imports keep disk-backed File objects without copying them');

  // Test ZIP unpacking
  const mockZipData = fflate.zipSync({
    'content/cars/toyota_ae86/data/car.ini': fflate.strToU8('[BASIC]\nTOTALMASS=980\n'),
    'content/cars/toyota_ae86/toyota_ae86.kn5': mockKn5Bytes,
    'content/cars/toyota_ae86/ui/ui_car.json': fflate.strToU8(JSON.stringify({
      name: 'Toyota AE86 Trueno',
      brand: 'Toyota',
      author: 'InitialD Modding',
      year: 1986,
      tags: ['classic', 'rwd'],
    })),
  });

  const unzippedFiles = await unpackZip(mockZipData);
  assert(unzippedFiles.size === 3, 'unpackZip extracts 3 files');
  assert(unzippedFiles.has('content/cars/toyota_ae86/data/car.ini'), 'unzippedFiles contains car.ini');

  const pkg = await analyzeCarPackage(unzippedFiles);
  assert(pkg.slug === 'toyota_ae86', 'analyzeCarPackage detects car slug');
  assert(pkg.title === 'Toyota AE86 Trueno', 'analyzeCarPackage parses title from ui_car.json');
  assert(pkg.classId === 'classic', 'analyzeCarPackage infers classic class from 1986 year');
  assert(pkg.primaryKn5Name === 'toyota_ae86.kn5', 'analyzeCarPackage identifies primary kn5');

  const path = 'content/cars/toyota_ae86/';
  unzippedFiles.set(`${path}lods.ini`, fflate.strToU8('[LOD_0]\nFILE="main.kn5"\n'));
  unzippedFiles.set(`${path}MAIN.KN5`, mockKn5Bytes);
  unzippedFiles.set(`${path}skins/factory/ui_skin.json`, fflate.strToU8('{"skinname":"Factory","color":"#f8f8f8"}'));
  unzippedFiles.set(`${path}skins/factory/ext_config.ini`, fflate.strToU8('[Material_CarPaint_Solid]\nMaterials=Paint'));
  const configured = await analyzeCarPackage(unzippedFiles);
  assert(configured.primaryKn5Name === 'main.kn5', 'LOD_0 declaration wins over a model named after the car slug');
  const factorySkin = configured.skins?.[0];
  assert(factorySkin?.name === 'Factory' && factorySkin.swatchSource === 'authored' &&
    factorySkin.appearanceConfig?.includes('Materials=Paint') === true,
    'skin metadata and CSP survive even without a texture override');

  // Test real RAR mod import if present
  const rarPath = process.env.LC_MOD_RSS ?? join(homedir(), 'Documents', 'RSS_Formula_RSS_4-Assetto_Corsa-v2.rar');
  if (fs.existsSync(rarPath)) {
    console.log('\n--- Testing Real Mod Import (RSS Formula 4) ---');
    const rarBuf = fs.readFileSync(rarPath);
    const realCarDef = await importAssettoCorsaMod(rarBuf);
    assert((realCarDef.id as string) === 'custom_rss_formula_rss_4', 'Real mod ID is custom_rss_formula_rss_4');
    assert(realCarDef.title === 'Formula RSS 4', 'Real mod title is Formula RSS 4');
    assert(realCarDef.classId === 'f1', 'Real mod class is f1');
    assert(realCarDef.badge === 'MOD', 'Real mod badge is MOD');
    assert(realCarDef.year === 2017, 'Real mod year is 2017');

    const fromRegistry = carById(realCarDef.id);
    assert(fromRegistry.title === 'Formula RSS 4', 'carById returns imported car definition');

    const registered = getRegisteredCars();
    assert(registered.some((c) => c.id === realCarDef.id), 'getRegisteredCars contains imported car');

    const storedCars = await getAllCustomCars();
    assert(storedCars.some((c) => c.id === realCarDef.id), 'mod-store holds custom car record');
    const template = await loadTemplate(realCarDef.modelUrl!);
    let hasPaint = false;
    template?.getObjectByName('BODY')?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material) && (mesh.material as THREE.MeshStandardMaterial).map) hasPaint = true;
    });
    assert(hasPaint, 'RSS Formula 4 builds a textured rig after import');
    const mechanicalNames = ['HUB_1', 'RSS4_Disc', 'plastic_detail_z', 'RSS4_Radiator', 'RSS4_Cables', 'RSS4_Grip'];
    assert(mechanicalNames.every((name) => {
      const material = materialNamed(template, name);
      return material && !material.transparent && material.depthWrite && material.alphaTest === 0;
    }), 'RSS solid wheel, brake and mechanical parts do not use their finish masks as transparency');
    assert(materialNamed(template, '2017_Glass')?.transparent === true &&
      materialNamed(template, 'RSS4_LOGO_WHEEL')?.transparent === true &&
      Boolean(materialNamed(template, 'RSS4_FOIL')?.alphaTest),
      'RSS glass, logos and alpha-tested foil keep their intended coverage modes');

    // Clean up test car
    await deleteCustomCar(realCarDef.id);
    unregisterCustomCarMod(realCarDef.id);
    assert(!getRegisteredCars().some((c) => c.id === realCarDef.id), 'unregisterCustomCarMod removes car cleanly');
  }
}

function materialNamed(root: THREE.Object3D | null, name: string): THREE.MeshStandardMaterial | undefined {
  let found: THREE.MeshStandardMaterial | undefined;
  root?.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.name === name) {
      found = mesh.material as THREE.MeshStandardMaterial;
    }
  });
  return found;
}

function atlasSample(map: THREE.Texture | null | undefined, u = 0.125, v = 0.125): number[] {
  const pixels = texturePixels(map ?? null);
  if (!pixels) return [];
  const offset = 4 * (Math.floor(v * pixels.height) * pixels.width + Math.floor(u * pixels.width));
  return Array.from(pixels.data.subarray(offset, offset + 4));
}

function modFolder(root: string): ModFolderFile[] {
  function collect(directory: string, prefix: string): ModFolderFile[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const diskPath = join(directory, entry.name);
      const modPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return collect(diskPath, modPath);
      if (!entry.isFile() || !isEssentialModFile(modPath)) return [];
      const file = new File([fs.readFileSync(diskPath)], entry.name);
      return [{ path: modPath, file }];
    });
  }
  return collect(root, basename(root));
}

// Optional local fixtures. The supplied archives and KN5 assets are never written or distributed.
const REAL_LIVERY_TIMEOUT_MS = 30_000;

async function runLocalAppearanceTests() {
  const porsche = process.env.LC_MOD_PORSCHE;
  const mclaren = process.env.LC_MOD_MCLAREN;

  if (porsche) {
    console.log('\n--- Testing Real Paint (Porsche 992 GT3 RS) ---');
    const imported = await importAssettoCorsaMod(fs.readFileSync(porsche));
    const record = (await getAllCustomCars()).find(({ id }) => id === imported.id)!;
    const rig = portedRig(imported, record);
    try {
      const tyre = record.physicsConfig.tyreCompounds.PhysicsTyreCompound_Road_Street!;
      assert(tyre.modelData.curveFullness === 0.27 && tyre.rearOverride?.modelData?.curveFullness === 0.27 &&
        tyre.modelData.slip_ratio_limit === peakDriveSlipRatio(7.2, 1.06) &&
        tyre.rearOverride.modelData.slip_ratio_limit === peakDriveSlipRatio(6.5, 1.06),
        'Porsche front and rear tyres retain XMU and the separately derived peak slip');
      const template = await loadTemplate(imported.modelUrl!);
      const paint = materialNamed(template, 'CarPaint');
      const originalPaint = atlasSample(paint?.map, 0.23, 0.37);
      assert(originalPaint[2] > originalPaint[0] && originalPaint[3] === 255, 'Porsche first blue livery is painted, not grey AO or transparent');
      const paintFile = template?.userData.skinMaps?.CarPaint;
      const wheelFile = template?.userData.skinMaps?.Wheel_Paint_Red;
      const stripeFile = template?.userData.skinMaps?.BODY_DECAL;
      const red = record.skins!.findIndex(({ name }) => /guards red/i.test(name));
      const embedded = record.skins!.findIndex(({ name, textures }) => /white/i.test(name) && !textures['metal_detail.dds']);
      assert(red > 0 && embedded > 0 && imported.skins![red].files?.includes(paintFile!) === true,
        'Porsche has a separate factory white skin and a compiled red skin');
      assert(Boolean(wheelFile && stripeFile), 'Porsche rim and stripe slots can also switch liveries');
      const cutout = materialNamed(template, 'CarPaint_2');
      assert(Boolean(cutout?.alphaTest) && atlasSample(cutout?.map)[3] === 255, 'Porsche alpha-tested stripe uses detail coverage over the empty diffuse slot');
      const mesh = materialAt(template, 'BODY_body_12_009');
      assert(Boolean(mesh && template?.userData.skinMaps?.[mesh.name]), 'Porsche mesh-only CSP overrides have a separate livery binding');

      if (red > 0 && embedded > 0) {
        const currentPaint = () => atlasSample(materialNamed(rig.root, 'CarPaint')?.map, 0.23, 0.37);
        const rim = (root: THREE.Object3D | null) => atlasSample(materialNamed(root, 'Wheel_Paint_Red')?.map, 0.1875, 0.375);
        const [baseRim] = rim(template);
        const guardsRed = () => {
          const [r, g, b, a] = currentPaint();
          return r > g + 20 && r > b + 20 && a === 255;
        };
        const guardsRim = () => {
          const [r, g, b, a] = rim(rig.root);
          return r > 0 && r < baseRim - 20 && r === g && g === b && a === 255;
        };
        const factoryWhite = () => {
          const [r, g, b, a] = currentPaint();
          return r > 40 && Math.abs(r - g) < 12 && Math.abs(r - b) < 12 && a === 255;
        };
        const factoryTrim = () => {
          const [r, g, b, a] = rim(rig.root);
          const [stripeR, stripeG, stripeB, stripeA] = atlasSample(materialNamed(rig.root, 'BODY_DECAL')?.map, 0.23, 0.37);
          return r > g + 20 && r > b + 20 && a === 255 &&
            stripeR > stripeG + 20 && stripeR > stripeB + 20 && stripeA === 255;
        };

        rig.setSkin?.(wearing(imported, red));
        await appearanceMatches(() => guardsRed() && guardsRim(), REAL_LIVERY_TIMEOUT_MS);
        assert(guardsRed(), 'the ported rig switches Porsche paint from blue to red');
        assert(guardsRim(), 'Guards Red swaps the silver rims for its darker grey rims');

        rig.setSkin?.(wearing(imported, embedded));
        await appearanceMatches(() => factoryWhite() && factoryTrim(), REAL_LIVERY_TIMEOUT_MS);
        assert(factoryWhite(), 'Porsche white without a DDS resets to the embedded base instead of retaining red');
        assert(factoryTrim(), 'factory white restores the embedded red rims and stripe with full coverage');
      }
    } finally {
      rig.dispose();
      await deleteCustomCar(imported.id);
      unregisterCustomCarMod(imported.id);
    }
  }

  if (mclaren) {
    console.log('\n--- Testing Real Paint (McLaren MCL39 2025) ---');
    const fromFolder = fs.statSync(mclaren).isDirectory();
    const imported = await importAssettoCorsaMod(fromFolder ? modFolder(mclaren) : await fs.openAsBlob(mclaren));
    try {
      const record = (await getAllCustomCars()).find(({ id }) => id === imported.id)!;
      if (!fromFolder) assert(record.skins?.length === 9, 'the original McLaren 7z keeps all nine liveries');
      assert(record.physicsConfig.gearbox.upshiftCutS === 0.01 && record.physicsConfig.gearbox.shiftTimeS === 0.01,
        'the McLaren import stores its authored 10 ms managed upshift cut');
      const { aero, ers } = record.physicsConfig;
      assert(!!aero.importedDrs && aero.wings.filter((wing) => wing.importedDrs).length === 1 &&
        aero.wings.reduce((n, wing) => n + (wing.activeControllers?.length ?? 0), 0) >= 11,
        'the packed McLaren data retains its DRS flap and active aero controllers');
      assert(!!ers.importedDrive?.maps.BAL?.length && ers.importedDrive?.buttonOverride === true &&
        !ers.importedDrive.electric && ers.deployPerLapJ === 4_000_000,
        'the packed McLaren data retains its authored hybrid map and 4 MJ deployment allowance');
      assert(ers.importedDrive?.heat?.chargeK === 0.002 && ers.importedDrive.heat.torqueFraction === 0.26,
        'the packed McLaren data retains its authored MGU-H coefficients');
      const importedTyre = record.physicsConfig.tyreCompounds[record.physicsConfig.compoundSlots.soft]!;
      const importedFrontSpring = new Lut(importedTyre.pressureData.pressureSpringCurve);
      const importedRearSpring = new Lut(importedTyre.rearOverride?.pressureData?.pressureSpringCurve ?? importedTyre.pressureData.pressureSpringCurve);
      assert(importedFrontSpring.evaluate(17) === 300568 && importedRearSpring.evaluate(17) === 369995,
        'McLaren front and rear tyre springs retain their distinct reference rates');
      const frontHeave = record.physicsConfig.suspensions.dampers_controller.front;
      const rearHeave = record.physicsConfig.suspensions.dampers_controller.rear;
      assert(frontHeave.heave.slow_bump === 4090 && frontHeave.heave.fast_rebound === 2660 &&
        frontHeave.heaveFastThresholdMs === 0.088 && frontHeave.heaveFastReboundThresholdMs === 0.14 &&
        rearHeave.heave.slow_bump === 5560 && rearHeave.heave.fast_rebound === 2540 &&
        rearHeave.heaveFastThresholdMs === 0.048 && rearHeave.heaveFastReboundThresholdMs === 0.12 &&
        record.physicsConfig.suspensions.front.heave.progressiveRate === 30000 &&
        record.physicsConfig.suspensions.rear.heave.progressiveRate === 20000,
        'McLaren third-element dampers, knees and progressive springs match the two real axles');
      const rearDiffusers = record.physicsConfig.aero.wings.filter(
        (wing) => wing.name === 'VENTURI_FLOOR' && Math.abs(wing.positionZ + 1.3) < 0.01,
      );
      assert(rearDiffusers.length === 2 && rearDiffusers.every((wing) => {
        const cl = new Lut(wing.lutAOA_CL);
        return wing.aoaReference === 'setup' && Math.abs(wing.angleDeg - 2.5) < 1e-6 &&
          cl.evaluate(wingAngleOfAttack(wing, 0.8, 0.8)) > cl.evaluate(0) + 0.1;
      }), 'McLaren rear diffusers use their authored 2.5° angle instead of ignoring it');
      const drivingConfig = structuredClone(record.physicsConfig);
      const profile = createCustomSimProfile('custom_mclaren_driving_fixture', drivingConfig, 'f1');
      const sim = new F12026CarSim(createFlatTestTrack(30_000, 3000), null, profile);
      sim.assistPreset = 'pro';
      sim.teleportToDistance(1500, 250 / 3.6);
      let steering = 0;
      let maxSlipDeg = 0;
      const sampleSlip = () => {
        maxSlipDeg = Math.max(maxSlipDeg, Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) * 180 / Math.PI);
      };
      for (let i = 0; i < 3 * 120; i++) {
        steering = Math.min(0.1, steering + 0.15 / 120);
        sim.step(1 / 120, {
          throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (250 / 3.6 - sim.vxMs), 0, 1),
          analogSteer: steering,
        });
        sampleSlip();
      }
      const cornerSpeed = sim.telemetry.speedKmh;
      for (let i = 0; i < 2 * 120; i++) {
        sim.step(1 / 120, { brake: Math.min(0.3, (i / 120 / 0.08) * 0.3), analogSteer: 0.1 });
        sampleSlip();
      }
      assert(cornerSpeed > 230 && maxSlipDeg < 10,
        'McLaren stays controlled in a 250 km/h flat-ground corner and moderate braking scenario');
      // The wheel's rim bypasses the rate limiter used for digital/stick inputs: a catch should reach the rack in
      // the same frame. This checks the simulator path, not the G29 hardware, FFB, or any player-set device filter.
      const wheelCatch = new F12026CarSim(createFlatTestTrack(30_000, 3000), null, profile);
      wheelCatch.assistPreset = 'pro';
      wheelCatch.teleportToDistance(1500, 200 / 3.6);
      const steerInto = wheelCatch.step(1 / 60, { analogSteer: 0.18, steerRim: true }).steering;
      const steerAgainst = wheelCatch.step(1 / 60, { analogSteer: -0.18, steerRim: true }).steering;
      assert(Math.abs(steerInto - 0.18) < 1e-6 && Math.abs(steerAgainst + 0.18) < 1e-6 &&
        wheelCatch.tcLevel === 0 && wheelCatch.absLevel === 0,
        'a physical-wheel countersteer reaches the McLaren rack in the same frame without TC or ABS');
      // The light-braking stability test alone says nothing about ultimate cornering grip. Use the same
      // slow steer ramp on the imported car and the native LC26, but do not require their limits to match.
      const corneringProbe = (testProfile: typeof profile) => {
        const car = new F12026CarSim(createFlatTestTrack(30_000, 3000), null, testProfile);
        car.assistPreset = 'pro';
        car.teleportToDistance(1500, 250 / 3.6);
        const history: number[] = [];
        let bestMeanG = 0;
        let peakSlipDeg = 0;
        for (let i = 0; i < 8 * 120; i++) {
          const t = i / 120;
          const steer = t < 1 ? 0 : Math.min(0.45, (t - 1) * 0.0643);
          car.step(1 / 120, {
            throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (250 / 3.6 - car.vxMs), 0, 1),
            analogSteer: steer,
          });
          peakSlipDeg = Math.max(peakSlipDeg, Math.abs(Math.atan2(car.vyMs, Math.max(1, Math.abs(car.vxMs)))) * 180 / Math.PI);
          history.push(Math.abs(car.telemetry.lateralG));
          if (history.length > 120) history.shift();
          if (history.length === 120) bestMeanG = Math.max(bestMeanG, history.reduce((a, b) => a + b, 0) / 120);
          if (peakSlipDeg > 25 || car.telemetry.speedKmh < 190) break;
        }
        return { bestMeanG, peakSlipDeg };
      };
      const mclarenCorner = corneringProbe(profile);
      const lc26Corner = corneringProbe(LC26_SIM_PROFILE);
      console.log(`  250 km/h one-second lateral peak: McLaren ${mclarenCorner.bestMeanG.toFixed(2)} g; LC26 ${lc26Corner.bestMeanG.toFixed(2)} g`);
      assert(mclarenCorner.bestMeanG > 3 && mclarenCorner.peakSlipDeg < 10 && Number.isFinite(lc26Corner.bestMeanG),
        'McLaren develops sustained high-speed lateral load without a spin on a flat steer ramp');

      // A deterministic AI-driven probe, not a replay of the user's steering. It begins at the left edge of
      // RISE's Plateau Kink at 250 km/h and rides the real mesh kerb while pro mode leaves TC and ABS off.
      const riseMesh = 'public/tracks/rwanda_official/rwanda_official.glb';
      if (fs.existsSync(riseMesh)) {
        const rise = getActiveTrackData();
        const riseRoot = loadGlbGeometry(riseMesh);
        const zone = RWANDA_DRS_ZONES[0];
        if (zone) {
          const zoneMid = (zone.start + ((zone.end - zone.start + 1) % 1) / 2) % 1;
          const drsPass = (open: boolean) => {
            const testCar = new F12026CarSim(rise, riseRoot, profile);
            testCar.assistPreset = 'pro';
            testCar.autoGearbox = false;
            testCar.teleportToDistance(zoneMid * rise.totalLengthM, 250 / 3.6);
            testCar.step(fixed, { throttle: 1, toggleXMode: open });
            for (let i = 0; i < 180; i++) testCar.step(fixed, { throttle: 1 });
            return {
              open: testCar.vehicle.drsOpen,
              dragAtSpeed: testCar.vehicle.telemetry.dragN / testCar.vehicle.speedMs ** 2,
              energyUsed: testCar.vehicle.lapDeployJ,
              heatKw: testCar.telemetry.mguhPowerKw ?? 0,
            };
          };
          const closedFlap = drsPass(false);
          const openFlap = drsPass(true);
          assert(!closedFlap.open && openFlap.open && openFlap.dragAtSpeed < closedFlap.dragAtSpeed * 0.95,
            'the reimported McLaren opens DRS and measurably cuts drag in a RISE practice zone');
          assert(closedFlap.energyUsed > 1_000 && openFlap.energyUsed > 1_000,
            'the reimported McLaren deploys kinetic energy on the authored map in RISE');
          assert(closedFlap.heatKw > 0 && openFlap.heatKw > 0,
            `the reimported McLaren recovers exhaust energy in RISE (${closedFlap.heatKw.toFixed(1)} kW with DRS closed)`);
        }
        // Autopilot normally uses the semi-pro aid dials independently of the driver's preset.
        const noAidsProfile = {
          ...profile,
          assistDials: { ...profile.assistDials, semi_pro: { tcLevel: 0, tc2Level: 0, absLevel: 0 } },
        };
        const car = new F12026CarSim(rise, riseRoot, noAidsProfile);
        car.assistPreset = 'pro';
        car.aiSelfRecovery = false;
        car.teleportToDistance(390, 250 / 3.6, -rise.getSampleAtDistance(390).width / 2);
        car.aiAutopilot = true;
        car.aiPaceScale = 1;
        car.aiLineBiasM = -2;
        let kerbFrames = 0;
        let fastestKerbKmh = 0;
        let peakBodySlip = 0;
        for (let i = 0; i < 3 * 60 && car.sMeters < 550; i++) {
          const tel = car.step(1 / 60, {});
          if (tel.wheelSurfaces.includes('kerb')) {
            kerbFrames++;
            fastestKerbKmh = Math.max(fastestKerbKmh, tel.speedKmh);
          }
          peakBodySlip = Math.max(peakBodySlip, Math.abs(Math.atan2(car.vyMs, Math.max(1, Math.abs(car.vxMs)))) * 180 / Math.PI);
        }
        console.log(`  RISE kerb probe: ${kerbFrames} frames on kerb, fastest ${fastestKerbKmh.toFixed(0)} km/h, peak body slip ${peakBodySlip.toFixed(1)}°`);
        assert(car.onTrackColliders && car.tcLevel === 0 && car.absLevel === 0 &&
          noAidsProfile.assistDials.semi_pro.tcLevel === 0 && noAidsProfile.assistDials.semi_pro.absLevel === 0 &&
          kerbFrames >= 5 && fastestKerbKmh > 200 && car.sMeters >= 550 && peakBodySlip < 10,
          'McLaren completes a high-speed RISE kerb probe on real colliders with TC and ABS off');
      } else {
        console.log('  SKIP: RISE kerb probe (track mesh unavailable)');
      }

      const template = await loadTemplate(imported.modelUrl!);
      const paint = materialNamed(template, 'MCLAREN_PAINT');
      const [r, g, b, a] = atlasSample(paint?.map);
      assert(r > 150 && g > 40 && b < 40 && a === 255 && paint?.alphaTest === 0, 'McLaren papaya comes through its original BC3 paint mask');
      const [dark] = atlasSample(paint?.map, 0.625);
      assert(dark < r / 2, 'McLaren palette keeps separate atlas regions instead of using one guessed colour');
      const carbon = materialNamed(template, 'MCLAREN_CARBON1');
      assert(carbon?.normalMap?.repeat.x === 500 && Boolean(carbon.map),
        'McLaren carbon keeps authored AO and a tiled normal detail');
      const decal = materialNamed(template, 'MCLAREN_NUMBER_81_DECAL');
      const originalDriver = fromFolder
        ? fs.readFileSync(join(mclaren, 'skins', '2025_Mclaren_Norris', 'mclaren_driver.dds'))
        : new Uint8Array(await record.skins![0].textures['mclaren_driver.dds'].arrayBuffer());
      const external = createTexture('mclaren_driver.dds', originalDriver);
      const decalPixels = texturePixels(decal?.map ?? null)?.data;
      const externalPixels = texturePixels(external)?.data;
      assert(Boolean(decal?.alphaTest && decalPixels && externalPixels && decalPixels.length === externalPixels.length &&
        decalPixels.every((value, index) => value === externalPixels[index])),
        'McLaren number decal uses the supplied Norris skin with coverage intact');
    } finally {
      await deleteCustomCar(imported.id);
      unregisterCustomCarMod(imported.id);
    }
  }
}

async function runLocalDucatiTest() {
  const ducati = process.env.LC_MOD_DUCATI;
  if (!ducati) return;

  console.log('\n--- Testing local Ducati 7z on RISE ---');
  const imported = await importAssettoCorsaMod(await fs.openAsBlob(ducati));
  try {
    const template = await loadTemplate(imported.modelUrl!);
    assert(!!template && template.userData.wheelbaseM > 1.4 && template.userData.wheelbaseM < 1.5 &&
      (template.getObjectByName('WHEEL_LF')?.children.length ?? 0) > 0 &&
      (template.getObjectByName('WHEEL_LR')?.children.length ?? 0) > 0 &&
      Object.values(template.userData.tyreRadius).every(Number.isFinite),
      'the actual Ducati model has two correctly located visible wheels with finite radii');

    const track = getActiveTrackData();
    const trackRoot = loadGlbGeometry('public/tracks/rwanda_official/rwanda_official.glb');
    const sim = vehicleModelSpec(imported.physics).createSim(track, trackRoot);
    const start = track.totalLengthM - 100;
    sim.teleportToDistance(start);
    let finite = true;
    for (let i = 0; i < 3 * 60; i++) {
      sim.step(1 / 60, { throttle: 1 });
      const { rpm, speedKmh, icePowerKw } = sim.telemetry;
      if (![rpm, speedKmh, icePowerKw, ...sim.worldPosition.toArray()].every(Number.isFinite)) {
        finite = false;
        break;
      }
    }
    const { speedKmh, gear } = sim.telemetry;
    assert(finite && speedKmh > 85 && gear > 1 && sim.sMeters > start + 30 &&
      sim.telemetry.wheelSurfaces.includes('asphalt'),
      `the Ducati launches and shifts on the real track (${speedKmh.toFixed(0)} km/h, gear ${gear})`);
    if (!finite) return;

    let lateralG = 0;
    for (let i = 0; i < 30; i++) {
      sim.step(1 / 60, { analogSteer: 0.035 });
      lateralG = Math.max(lateralG, sim.telemetry.lateralG);
    }
    for (let i = 0; i < 60; i++) sim.step(1 / 60, { brake: 0.7 });
    assert(lateralG > 0.15 && sim.telemetry.speedKmh < speedKmh - 20 && Number.isFinite(sim.telemetry.rpm),
      'the Ducati responds to steering and braking after launch');
  } finally {
    unregisterCustomCarMod(imported.id);
    await deleteCustomCar(imported.id);
  }
}

runCameraTests().then(runLiveryTests).then(runCustomCarIdCollisionTests).then(runProtectedKn5Tests).then(runArchiveTests).then(runLocalAppearanceTests).then(runLocalDucatiTest).then(() => {
  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\nVerification complete: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}).catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
