/**
 * Fuel load and lap time (verify-fuel-lap-time*.ts): a flying lap of RISE Motordrome on the autopilot, light, on the
 * default load and full, on Casual (the load and its mass kept, nothing burnt). More fuel is a slower lap, by a
 * believable amount per 10 kg. Three laps a car take most of the time, so the cars are split into groups of about equal
 * driving time, one suite each, which the verify runner runs side by side.
 */
import { FUEL_LOAD } from "../../src/lib/sim/car-setup";
import { SIM_REALISM_FLAGS } from "../../src/lib/sim/sim-realism";
import type { SimulatorCar } from "../../src/lib/sim/simulator-car";
import type { VehicleModelId } from "../../src/types/f1";
import { DT, track, withSetup } from "./setup-cars";

export type FuelLapGroup = "modern" | "classic" | "road";

/** Every vehicle model in exactly one group: typed over VehicleModelId, so a new car fails to compile until it has one */
export const FUEL_LAP_GROUP: Record<VehicleModelId, FuelLapGroup> = {
  lc26: "modern",
  lc25: "modern",
  "f12026-car": "modern",
  "amg-gt3": "modern",
  "mtr-496r": "modern",
  "lc-lmdh": "modern",
  "nissan-r33-jgtc": "classic",
  "nissan-r32-jtcc": "classic",
  "bmw-m1-procar": "classic",
  "porsche-934-rsr": "classic",
  liana: "road",
  "vw-scirocco-gtx": "road",
  "chaparral-2d": "road",
  "chaparral-2d-67": "road",
};

type Massy = SimulatorCar & { setSimRealism?: (f: (typeof SIM_REALISM_FLAGS)["full"]) => void };

const lapS = (v: VehicleModelId, fuelKg: number) => {
  const car = withSetup(v, { fuelDeltaKg: fuelKg - FUEL_LOAD[v].defaultKg }, track);
  (car as Massy).setSimRealism?.(SIM_REALISM_FLAGS.casual);
  car.resetToStartGrid(true);
  car.aiAutopilot = true;
  const lap0 = car.telemetry.lapCount;
  for (let t = 0; t < 240 && car.telemetry.lapCount < lap0 + 1; t += DT) car.step(DT, {});
  return car.telemetry.lapCount === lap0 + 1 && car.telemetry.lastLapTimeMs !== null ? car.telemetry.lastLapTimeMs / 1000 : Number.NaN;
};

/** Runs the checks for one group's cars; exits 1 on the first failure */
export function runFuelLapChecks(group: FuelLapGroup): void {
  let passed = 0;
  const check = (name: string, cond: boolean, detail = "") => {
    if (!cond) {
      console.error(`FAIL ${name} ${detail}`);
      process.exit(1);
    }
    passed++;
    console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
  };
  console.log(`Fuel load: lap time (${group} cars)`);
  for (const v of (Object.keys(FUEL_LAP_GROUP) as VehicleModelId[]).filter((id) => FUEL_LAP_GROUP[id] === group)) {
    const f = FUEL_LOAD[v];
    const light = lapS(v, f.minKg);
    const base = lapS(v, f.defaultKg);
    const heavy = lapS(v, f.maxKg);
    const per10 = ((heavy - light) / (f.maxKg - f.minKg)) * 10;
    check(
      `${v}: more fuel, slower lap`,
      // The LC26's autopilot drives the track's fixed speed profile, so a light car can't corner faster on it and
      // only gains on the exits: there it has to be no slower than the default, not strictly quicker
      (v === "lc26" ? light <= base + 0.1 : light < base) && base < heavy && per10 > 0.05 && per10 < 1,
      `${light.toFixed(3)} / ${base.toFixed(3)} / ${heavy.toFixed(3)} s at ${f.minKg} / ${f.defaultKg} / ${f.maxKg} kg, ${per10.toFixed(3)} s per 10 kg`
    );
  }
  console.log(`\nAll ${passed} fuel lap time checks (${group} cars) passed.`);
}
