/**
 * Verifies #148 setup sharing codec, strict sanitization, cross-car adaptation, and summary formatting:
 *   npx tsx scripts/verify-setup-sharing.ts
 */
import assert from "node:assert/strict";
import { ARB_DETACHED_PCT, CHASSIS_LIMITS, DEFAULT_CHASSIS_SETUP } from "../src/lib/sim/car-setup";
import {
  buildSharedSetup,
  decodeSetupShareCode,
  encodeSetupShareCode,
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
      frontWingClicks: -3,
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
    tuner: { brakeBiasPct: 54.5, tcLevel: 3, diffExit: 60 },
  });

  assert.equal(Object.keys(built.chassis ?? {}).length, 4, "only 4 non-default chassis fields serialized");
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
    tuner: { absLevel: 4, brakeBiasPct: 56.2 },
  });
  const decoded = decodeSetupShareCode(rawJson);
  assert.ok(decoded);
  assert.equal(decoded.vehicle, "amg-gt3");
  assert.equal(decoded.name, "Monza Q");
  assert.equal(decoded.tyre?.coldPressurePsi.fl, 26);
  assert.equal(decoded.tyre?.coldPressurePsi.rr, 25.5);
});

check("parseSharedSetup clamps extreme out-of-range numbers and rejects malformed payloads", () => {
  const extreme = parseSharedSetup({
    v: 1,
    vehicle: "lc26",
    chassis: { frontWingClicks: 9999, rearWingClicks: -9999, springFrontPct: 500 },
    tyre: { coldPressurePsi: { fl: 200, fr: -10, rl: 25, rr: 25 }, camberDeg: { front: -99, rear: 40 } },
    compound: "soft",
    aero: "balanced",
    tuner: { brakeBiasPct: 999, tcLevel: -5 },
  });
  assert.ok(extreme);
  assert.equal(extreme.chassis?.frontWingClicks, CHASSIS_LIMITS.frontWingClicks.max);
  assert.equal(extreme.chassis?.rearWingClicks, CHASSIS_LIMITS.rearWingClicks.min);
  assert.equal(extreme.chassis?.springFrontPct, CHASSIS_LIMITS.springFrontPct.max);
  assert.equal(extreme.tyre?.coldPressurePsi.fl, 50);
  assert.equal(extreme.tyre?.coldPressurePsi.fr, 10);
  assert.equal(extreme.tyre?.camberDeg.front, -8);
  assert.equal(extreme.tyre?.camberDeg.rear, 2);
  assert.equal(extreme.tuner?.brakeBiasPct, 75);
  assert.equal(extreme.tuner?.tcLevel, 0);

  // Rejects bad version, unknown vehicle, NaN, invalid compound, huge payload
  assert.equal(parseSharedSetup({ v: 2, vehicle: "lc26" }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "unknown" }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "lc26", chassis: { frontWingClicks: Number.NaN } }), null);
  assert.equal(parseSharedSetup({ v: 1, vehicle: "lc26", compound: "ultrasoft" }), null);
  assert.equal(decodeSetupShareCode("LC1-!!!invalid!!!"), null);
  assert.equal(decodeSetupShareCode("not a code"), null);
});

check("resolveSetupForCar clamps tyre pressures/camber to target car limits and flags cross-car setups", () => {
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

console.log(`\n${passed} setup-sharing checks passed.`);
