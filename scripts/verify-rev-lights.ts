/**
 * verify-rev-lights.ts: the HUD's shift lights and the car's own wheel LEDs light the same LEDs in the same colour
 * bands at the same rpm (src/lib/sim/rev-range.ts), and every car can light all of them before its rev limiter.
 * The 2026 car's lights ran from 10,800 to 14,600 rpm against its 12,500 rpm limiter, so neither the HUD nor the wheel
 * got past yellow while the shift beep still sounded (GitHub discussion #127).
 */
import assert from "node:assert/strict";
import { revLedBand, revLeds, revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from "../src/lib/sim/rev-range";
import { LC26_DRIVETRAIN, LC26_ENGINE } from "../src/lib/sim/lc26-data";
import { VEHICLE_MODELS } from "../src/lib/cars/vehicle-models";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}

const COUNT = 15;
const CARS = [undefined, "lc26", "f12026-car", "amg-gt3", "liana", "mtr-496r", "lc-lmdh", "nissan-r33-jgtc", "nissan-r32-jtcc", "bmw-m1-procar", "vw-scirocco-gtx", "chaparral-2d", "chaparral-2d-67", "porsche-934-rsr"];
const bandsAt = (rpm: number, range: readonly [number, number]) => {
  const { lit, atShift } = revLeds(rpm, range, COUNT);
  return atShift ? "flash" : Array.from({ length: lit }, (_, i) => revLedBand(i, COUNT)).join(" ");
};

check("15 lights keep the HUD's bands: 5 green, 5 yellow, 3 red, 2 shift", () => {
  const bands = Array.from({ length: COUNT }, (_, i) => revLedBand(i, COUNT));
  const old = Array.from({ length: COUNT }, (_, i) => (i < 5 ? "green" : i < 10 ? "yellow" : i < 13 ? "red" : "shift"));
  assert.deepEqual(bands, old);
});

check("lit count and shift point match the HUD's own formula for every car", () => {
  for (const car of CARS) {
    const [start, full] = revRangeFor(car);
    for (let rpm = start - 1500; rpm <= full + 1500; rpm += 25) {
      const { lit, atShift } = revLeds(rpm, [start, full], COUNT);
      const hudLit = Math.round(((rpm - start) / (full - start)) * COUNT);
      assert.equal(lit, Math.max(0, Math.min(COUNT, hudLit)), `${car ?? "formula"} at ${rpm} rpm`);
      assert.equal(atShift, rpm >= full, `${car ?? "formula"} shift at ${rpm} rpm`);
    }
  }
});

check("every car lights all its rev lights before its rev limiter", () => {
  for (const [id, model] of Object.entries(VEHICLE_MODELS)) {
    const [start, full] = revRangeFor(id);
    assert.ok(start < full, `${id}: range ${start}-${full}`);
    assert.ok(full <= model.limiterRpm, `${id}: all lit at ${full} rpm, limiter ${model.limiterRpm}`);
  }
});

check("the 2026 car flashes at the shift beep and shows blue at its auto upshift", () => {
  // The car reports itself as the f12026-car in telemetry; the wheel and HUD read the same default range
  for (const id of [undefined, "lc26", "f12026-car"]) {
    const range = revRangeFor(id);
    assert.equal(range[1], LC26_ENGINE.limiterRpm - SHIFT_BEEP_BELOW_LIMITER_RPM, `${id ?? "default"} shift point`);
    const atUpshift = revLeds(LC26_DRIVETRAIN.autoUpshiftRpm, range, COUNT);
    assert.ok(atUpshift.lit >= 14 && !atUpshift.atShift, `${id ?? "default"} at the auto upshift: ${bandsAt(LC26_DRIVETRAIN.autoUpshiftRpm, range)}`);
    assert.equal(revLedBand(atUpshift.lit - 1, COUNT), "shift");
    assert.ok(revLeds(LC26_ENGINE.limiterRpm - SHIFT_BEEP_BELOW_LIMITER_RPM, range, COUNT).atShift, "flash at the beep");
  }
});

check("a non-finite rpm lights nothing", () => {
  assert.deepEqual(revLeds(Number.NaN, revRangeFor(undefined), COUNT), { lit: 0, atShift: false });
});

const f1 = revRangeFor(undefined);
console.log(`\n  2026 car, ${f1[0]}-${f1[1]} rpm:`);
for (const rpm of [11_000, 11_500, 12_000, LC26_DRIVETRAIN.autoUpshiftRpm, f1[1]]) console.log(`    ${rpm}: ${bandsAt(rpm, f1)}`);

if (failed) {
  console.log(`\n${failed} rev light check(s) failed.`);
  process.exit(1);
}
console.log("\nAll rev light checks passed.");
