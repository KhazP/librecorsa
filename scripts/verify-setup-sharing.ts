/**
 * Verifies #148 setup sharing codec, strict sanitization, cross-car adaptation, and summary formatting:
 *   npx tsx scripts/verify-setup-sharing.ts
 */
import assert from "node:assert/strict";
import { VEHICLE_MODEL_IDS } from "../src/types/f1";
import { ARB_DETACHED_PCT, CHASSIS_LIMITS, DEFAULT_CHASSIS_SETUP } from "../src/lib/sim/car-setup";
import { clampChassisToCarSheet } from "../src/lib/sim/setup-sheet";
import {
  buildSharedSetup,
  decodeSetupShareCode,
  encodeSetupShareCode,
  garageTunerFrom,
  parseSharedSetup,
  resolveSetupForCar,
  SHARE_CODE_PREFIX,
  summarizeSharedSetup,
} from "../src/lib/sim/setup-share";
import { clampTyreSetup, TYRE_SETUP_LIMITS } from "../src/lib/sim/tyre-setup";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

check("buildSharedSetup stores only non-default chassis fields and round-trips through LC1 share codes", () => {
  const built = buildSharedSetup({
    vehicle: "lc-lmdh",
    name: "Le Mans Low Drag",
    chassis: {
      ...DEFAULT_CHASSIS_SETUP,
      rideHeightFrontMm: -4,
      rearWingClicks: -5,
      arbRearPct: ARB_DETACHED_PCT,
      gearRatioSet: 1,
    },
    tyre: {
      coldPressurePsi: { fl: 25.5, fr: 25.5, rl: 24.5, rr: 24.5 },
      camberDeg: { front: -1.4, rear: -1.1 },
    },
    compound: "medium",
    aero: "low_downforce",
    tuner: { brakeBiasPct: 54.6, tcLevel: 3, tcSlipAngleLevel: 12, brakeMigrationPct: 2.3 },
  });

  assert.equal(Object.keys(built.chassis ?? {}).length, 4, "only 4 non-default chassis fields serialized");
  assert.equal(built.tuner?.tcSlipAngleLevel, 12, "preserves full GT3/LMDh slip angle dial range up to 12");
  assert.equal(built.tuner?.brakeMigrationPct, 2.3, "preserves 0.1 % brake migration step");
  const code = encodeSetupShareCode(built);
  assert.ok(code.startsWith(SHARE_CODE_PREFIX), `starts with ${SHARE_CODE_PREFIX}`);
  assert.ok(code.length < 600, `compact share code (${code.length} chars)`);

  // Decodes even with whitespace/newlines wrapped from chat apps
  const wrapped = `${code.slice(0, 40)}\n  ${code.slice(40)}`;
  const decoded = decodeSetupShareCode(wrapped);
  assert.deepEqual(decoded, built);
});

check("decodeSetupShareCode also accepts raw JSON and GaragePreset exports", () => {
  const rawJson = JSON.stringify({
    id: "abc",
    name: "Monza Q",
    savedAt: 1700000000000,
    vehicle: "amg-gt3",
    chassis: { frontWingClicks: 2, rearWingClicks: -2 },
    tyre: { coldPressurePsi: { front: 26, rear: 25.5 }, camberDeg: { front: -3.2, rear: -2.4 } },
    compound: "soft",
    aero: "low_downforce",
    tuner: { absLevel: 4, brakeBiasPct: 68.5 },
  });
  const decoded = decodeSetupShareCode(rawJson);
  assert.ok(decoded);
  assert.equal(decoded.vehicle, "amg-gt3");
  assert.equal(decoded.name, "Monza Q");
  assert.equal(decoded.chassis?.frontWingClicks, undefined, "strips chassis params absent from GT3 sheet");
  assert.equal(decoded.chassis?.rearWingClicks, -2);
  assert.equal(decoded.tuner?.brakeBiasPct, 68.5, "preserves valid amg-gt3 brake bias");
  assert.equal(decoded.tyre?.coldPressurePsi.fl, 26);
  assert.equal(decoded.tyre?.coldPressurePsi.rr, 25.5);

  const mtr = parseSharedSetup({ v: 1, vehicle: "mtr-496r", tuner: { brakeBiasPct: 78 } });
  assert.equal(mtr?.tuner?.brakeBiasPct, 78, "preserves mtr-496r 78% brake bias");
  const r33 = parseSharedSetup({ v: 1, vehicle: "nissan-r33-jgtc", tuner: { brakeBiasPct: 80 } });
  assert.equal(r33?.tuner?.brakeBiasPct, 80, "preserves classic 80% brake bias");
});

check("parseSharedSetup clamps extreme out-of-range numbers to the car's setup sheet and rejects malformed payloads", () => {
  const extreme = parseSharedSetup({
    v: 1,
    vehicle: "lc26",
    chassis: { frontWingClicks: 9999, rearWingClicks: -9999, springFrontPct: 500, rideHeightFrontMm: -15 },
    tyre: { coldPressurePsi: { fl: 200, fr: -10, rl: 25, rr: 25 }, camberDeg: { front: -99, rear: 40 } },
    compound: "soft",
    aero: "balanced",
    tuner: { brakeBiasPct: 999, tcLevel: -5, tcSlipAngleLevel: 12 },
  });
  assert.ok(extreme);
  assert.equal(extreme.chassis?.frontWingClicks, CHASSIS_LIMITS.frontWingClicks.max);
  assert.equal(extreme.chassis?.rearWingClicks, CHASSIS_LIMITS.rearWingClicks.min);
  assert.equal(extreme.chassis?.springFrontPct, CHASSIS_LIMITS.springFrontPct.max);
  assert.equal(extreme.chassis?.rideHeightFrontMm, -8, "lc26 front ride height clamped to F1 sheet floor (-8 mm)");
  assert.equal(extreme.tyre?.coldPressurePsi.fl, 50);
  assert.equal(extreme.tyre?.coldPressurePsi.fr, 10);
  assert.equal(extreme.tyre?.camberDeg.front, -8);
  assert.equal(extreme.tyre?.camberDeg.rear, 2);
  assert.equal(extreme.tuner?.brakeBiasPct, 70, "lc26 brake bias clamped to F1 sheet max (70%)");
  assert.equal(extreme.tuner?.tcLevel, 0);
  assert.equal(extreme.tuner?.tcSlipAngleLevel, undefined, "lc26 strips GT3-only tcSlipAngleLevel");

  // Forged GT3 setup with F1 wing clicks is strictly clamped to GT3 sheet limits (±5 rear, no front wing)
  const forgedGt3 = parseSharedSetup({
    v: 1,
    vehicle: "amg-gt3",
    chassis: { frontWingClicks: 25, rearWingClicks: 25, arbFrontPct: ARB_DETACHED_PCT },
  });
  assert.ok(forgedGt3);
  assert.equal(forgedGt3.chassis?.frontWingClicks, undefined, "GT3 has no front wing slider");
  assert.equal(forgedGt3.chassis?.rearWingClicks, 5, "GT3 rear wing clamped to +5 clicks");

  // Rejects bad version, unknown vehicle, NaN, invalid compound, huge payload
  assert.equal(parseSharedSetup({ v: 2, vehicle: "lc26" }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "unknown" }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "lc26", chassis: { frontWingClicks: Number.NaN } }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "lc26", compound: "ultrasoft" }), null);
  assert.equal(decodeSetupShareCode("LC1-!!!invalid!!!"), null);
  assert.equal(decodeSetupShareCode("not a code"), null);
});

check("DEFAULT_CHASSIS_SETUP is an exact fixed point of clampChassisToCarSheet for all vehicles and garageTunerFrom preserves full car bounds", () => {
  for (const v of VEHICLE_MODEL_IDS) {
    assert.deepEqual(clampChassisToCarSheet(v, DEFAULT_CHASSIS_SETUP), DEFAULT_CHASSIS_SETUP, `${v} baseline fixed point`);
  }
  const t = garageTunerFrom({ brakeBiasPct: 78, tcSlipAngleLevel: 12, brakeMigrationPct: 2.3, motorDeployKw: null });
  assert.equal(t.brakeBiasPct, 78);
  assert.equal(t.tcSlipAngleLevel, 12);
  assert.equal(t.brakeMigrationPct, 2.3);
  assert.equal(t.motorDeployKw, undefined);
});

check("resolveSetupForCar clamps tyre pressures/camber/chassis to target car sheet and flags cross-car setups", () => {
  const f1Setup = buildSharedSetup({
    vehicle: "lc26",
    chassis: { frontWingClicks: 20, rearWingClicks: 20 },
    tyre: {
      coldPressurePsi: { fl: 22, fr: 22, rl: 20, rr: 20 },
      camberDeg: { front: -3.5, rear: -2.0 },
    },
    aero: "high_downforce",
  });
  const defaultGt3Tyre = {
    coldPressurePsi: { fl: 26, fr: 26, rl: 26, rr: 26 },
    camberDeg: { front: -3.2, rear: -2.4 },
  };
  const resolvedGt3 = resolveSetupForCar(
    f1Setup,
    "amg-gt3",
    defaultGt3Tyre,
    (t) => clampTyreSetup("amg-gt3", t),
    "soft",
    "balanced",
    { brakeBiasPct: 68 },
  );
  assert.equal(resolvedGt3.differentCar, true);
  assert.equal(resolvedGt3.chassis.frontWingClicks, 0, "F1 front wing clicks dropped when resolved onto GT3");
  assert.equal(resolvedGt3.chassis.rearWingClicks, 5, "F1 +20 rear wing clicks clamped to GT3 +5 max");

  const gt3Setup = buildSharedSetup({
    vehicle: "amg-gt3",
    tyre: {
      coldPressurePsi: { fl: 28, fr: 28, rl: 28, rr: 28 },
      camberDeg: { front: -4.2, rear: -3.2 },
    },
    aero: "high_downforce",
  });
  const defaultF1Tyre = {
    coldPressurePsi: { fl: 22, fr: 22, rl: 20, rr: 20 },
    camberDeg: { front: -3.0, rear: -1.8 },
  };
  const resolved = resolveSetupForCar(
    gt3Setup,
    "lc26",
    defaultF1Tyre,
    (t) => clampTyreSetup("lc26", t),
    "soft",
    "balanced",
    { brakeBiasPct: 56 },
  );
  assert.equal(resolved.differentCar, true);
  assert.equal(resolved.aero, "high_downforce");
  // Clamped cleanly inside lc26 tyre limits (never blindly takes GT3 28 psi)
  assert.equal(resolved.tyre.coldPressurePsi.fl, TYRE_SETUP_LIMITS.lc26.pressurePsi.max);
  assert.ok(summarizeSharedSetup(gt3Setup).includes("High downforce"));
});

check("Hardening: preserves receiver fuel/tyres, keeps GT3 MFD diff dials, snaps slider steps, strips bidi chars", () => {
  // 1. GT3 MFD diff dials survive round-trip & sheet clamp
  const gt3 = buildSharedSetup({
    vehicle: "amg-gt3",
    name: "Fast\u202Egt3",
    chassis: { rearWingClicks: 2.37, gearRatioSet: 0.5, fuelDeltaKg: -25 },
    tuner: { diffEntry: 9, diffMid: 5, diffExit: 2, brakeBiasPct: 68 },
  });
  assert.equal(gt3.name, "Fast gt3", "bidi override character stripped");
  assert.equal(gt3.chassis?.rearWingClicks, 2, "between-step rear wing snapped to integer click");
  assert.equal(gt3.chassis?.gearRatioSet, 1, "between-step gearRatioSet snapped to integer");
  assert.equal(gt3.tuner?.diffEntry, 9, "GT3 MFD diffEntry preserved");
  assert.equal(gt3.tuner?.diffMid, 5, "GT3 MFD diffMid preserved");
  assert.equal(gt3.tuner?.diffExit, 2, "GT3 MFD diffExit preserved");

  // 2. Resolving onto receiver preserves receiver's fuel load and current tyres (when setup omits tyres)
  const myTyres = { coldPressurePsi: { fl: 25.5, fr: 25.5, rl: 25.0, rr: 25.0 }, camberDeg: { front: -3.4, rear: -2.6 } };
  const resolved = resolveSetupForCar(
    gt3,
    "amg-gt3",
    myTyres,
    (t) => clampTyreSetup("amg-gt3", t),
    "medium",
    "balanced",
    { brakeBiasPct: 66 },
    12,
  );
  assert.equal(resolved.chassis.fuelDeltaKg, 12, "receiver fuel load preserved instead of overwritten to -25 kg");
  assert.deepEqual(resolved.tyre, myTyres, "receiver current tyres kept when shared setup omits tyres");
});

console.log(`\n${passed} setup-sharing checks passed.`);
