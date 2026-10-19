/**
 * Setup sheets: every F1 car gets the F1 sheet and every GT3 the GT3 sheet; each parameter's range
 * holds its baseline on a whole step, round-trips through the setup state, and never asks for more than the cars
 * take. Then the new setup channels move the cars: engine braking, brake power, brake ducts, toe, steering ratio
 * and diff preload.
 * Run: npx tsx scripts/verify-setup-sheet.ts
 */
import { DEFAULT_CHASSIS_SETUP, type ChassisSetup, type GarageTuner } from "../src/lib/sim/car-setup";
import { SETUP_CLASS, setupSheet, type SetupState } from "../src/lib/sim/setup-sheet";
import { TYRE_SETUP_LIMITS } from "../src/components/hud/PauseMenu";
import type { SimulatorCar } from "../src/lib/sim/simulator-car";
import type { TyreSetup, VehicleModelId } from "../src/types/f1";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { createAmgGt3Sim } from "../src/lib/sim/gt3/AmgGt3Sim";
import { F1Physics2026 } from "../src/lib/f1-physics-2026";
import { getRwandaTrackData } from "../src/lib/track-data";
import { createFlatTestTrack } from "./lib/flat-track";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}

const flat = createFlatTestTrack();
const track = getRwandaTrackData();
const makers: Record<VehicleModelId, (t: typeof track) => SimulatorCar> = {
  vf26: (t) => new F1Physics2026(t),
  "f12026-car": (t) => new F12026CarSim(t),
  "amg-gt3": (t) => createAmgGt3Sim(t),
};
const vehicles = Object.keys(makers) as VehicleModelId[];
const DT = 1 / 60;

// ---- The sheets ----
console.log("Sheets");
check("both F1 cars use the F1 sheet, the GT3 the GT3 sheet", SETUP_CLASS.vf26 === "f1" && SETUP_CLASS["f12026-car"] === "f1" && SETUP_CLASS["amg-gt3"] === "gt3");
const tuner: GarageTuner = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2 };
const defaultTyre = (v: VehicleModelId): TyreSetup => makers[v](flat).getTyreSetup();
const sheets = Object.fromEntries(vehicles.map((v) => [v, setupSheet(v, TYRE_SETUP_LIMITS[v], defaultTyre(v))]));
const groupIds = (v: VehicleModelId) => sheets[v].map((g) => g.id).join(",");
check("the F1 cars share one sheet layout", groupIds("vf26") === groupIds("f12026-car"), groupIds("vf26"));
check("F1 sheet: its pages in order", groupIds("vf26") === "aero,transmission,geometry,suspension,brakes,tyres,electronics");
check("GT3 sheet: its pages in order", groupIds("amg-gt3") === "tyres,electronics,mechanical,dampers,aero");
const paramIds = (v: VehicleModelId) => sheets[v].flatMap((g) => g.params.map((q) => q.id));
check("the F1 cars share the same parameters", paramIds("vf26").join() === paramIds("f12026-car").join());
for (const id of ["steerRatioDelta", "bumpStopRateFrontPct", "diffPreloadNm", "fastBumpFrontPct", "brakeDuctFront", "toeFrontDeg"])
  check(`GT3 sheet has ${id}`, paramIds("amg-gt3").includes(id));
for (const id of ["frontWingClicks", "diffExit", "diffEntry", "engineBrakingPct", "toeRearDeg", "brakePowerPct", "brakeMigrationPct"])
  check(`F1 sheet has ${id}`, paramIds("vf26").includes(id));

for (const v of vehicles) {
  const tyre = defaultTyre(v);
  const st: SetupState = { chassis: { ...DEFAULT_CHASSIS_SETUP }, tyre, tuner };
  let bad: string[] = [];
  for (const q of sheets[v].flatMap((g) => g.params)) {
    const onStep = (x: number) => Math.abs(x / q.step - Math.round(x / q.step)) < 1e-6;
    if (!(q.min <= q.base && q.base <= q.max)) bad.push(`${q.id}: base ${q.base} outside ${q.min}..${q.max}`);
    else if (q.writes !== "tyre" && !(onStep(q.base - q.min) && onStep(q.max - q.base))) bad.push(`${q.id}: base off the step grid`);
    if (q.writes === "chassis" && Math.abs(q.get(st) - q.base) > 1e-6) bad.push(`${q.id}: default reads ${q.get(st)}, not ${q.base}`);
    for (const x of [q.min, q.max]) {
      const back = q.get(q.set(st, x));
      if (Math.abs(back - x) > 1e-6) bad.push(`${q.id}: set ${x} reads back ${back} (range larger than the car takes)`);
    }
    if (!q.format(q.base) || q.fx.more.length > 48 || q.fx.less.length > 48) bad.push(`${q.id}: readout or effect text`);
  }
  check(`${v}: every parameter's range, baseline and round trip`, bad.length === 0, bad.slice(0, 4).join("; "));
  bad = [];
  // Setting a parameter touches only its own channel
  for (const q of sheets[v].flatMap((g) => g.params)) {
    const next = q.set(st, q.max === q.base ? q.min : q.max);
    const chassisChanged = (Object.keys(st.chassis) as (keyof ChassisSetup)[]).filter((k) => next.chassis[k] !== st.chassis[k]);
    if (q.writes === "chassis" && (chassisChanged.length !== 1 || chassisChanged[0] !== q.id)) bad.push(q.id);
    if (q.writes !== "chassis" && chassisChanged.length) bad.push(q.id);
  }
  check(`${v}: each parameter writes only itself`, bad.length === 0, bad.join(","));
}

// ---- The cars ----
const withSetup = (v: VehicleModelId, patch: Partial<ChassisSetup>, t = flat) => {
  const car = makers[v](t);
  car.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP, ...patch });
  return car;
};

console.log("Engine braking");
for (const v of vehicles) {
  const coast = (pct: number) => {
    const car = withSetup(v, { engineBrakingPct: pct });
    car.resetToStartGrid(true);
    for (let i = 0; i < 60; i++) car.step(DT, { throttle: 1 });
    const v0 = car.telemetry.speedKmh;
    for (let i = 0; i < 120; i++) car.step(DT, { throttle: 0, brake: 0 });
    return v0 - car.telemetry.speedKmh;
  };
  const full = coast(0);
  const half = coast(-50);
  check(`${v}: less engine braking loses less speed on a lift`, half < full - 0.3, `${full.toFixed(1)} vs ${half.toFixed(1)} km/h in 2 s`);
}

console.log("Brake power");
for (const v of ["f12026-car", "amg-gt3"] as const) {
  const inner = (c: SimulatorCar) => c as unknown as { config: { brakes: { maxTorqueNm: number } } };
  const base = inner(withSetup(v, {})).config.brakes.maxTorqueNm;
  const low = inner(withSetup(v, { brakePowerPct: -20 })).config.brakes.maxTorqueNm;
  check(`${v}: 80 % brake power is 80 % of the torque`, Math.abs(low / base - 0.8) < 1e-6);
}
{
  // VF26: a light pedal at moderate speed is torque-limited, so lower brake pressure stops less
  const stop = (pct: number) => {
    const car = withSetup("vf26", { brakePowerPct: pct });
    car.resetToStartGrid(true);
    for (let i = 0; i < 60; i++) car.step(DT, { throttle: 1 });
    const v0 = car.telemetry.speedKmh;
    for (let i = 0; i < 30; i++) car.step(DT, { brake: 0.35 });
    return v0 - car.telemetry.speedKmh;
  };
  const full = stop(0);
  const low = stop(-20);
  check("vf26: lower brake pressure loses less speed on the same pedal", low < full - 0.2, `${full.toFixed(1)} vs ${low.toFixed(1)} km/h`);
}

console.log("Brake ducts");
for (const v of vehicles) {
  const discTemp = (steps: number) => {
    const car = withSetup(v, { brakeDuctFront: steps, brakeDuctRear: steps }, track);
    car.resetToStartGrid(true);
    car.aiAutopilot = true;
    for (let t = 0; t < 40; t += DT) car.step(DT, {});
    const b = car.telemetry.brakeTempsC;
    return (b[0] + b[1] + b[2] + b[3]) / 4;
  };
  const closed = discTemp(-3);
  const open = discTemp(3);
  check(`${v}: open ducts run the brakes cooler`, open < closed - 5, `${closed.toFixed(0)} vs ${open.toFixed(0)} °C after 40 s`);
}

console.log("Toe, steering ratio and preload");
for (const v of ["f12026-car", "amg-gt3"] as const) {
  const wheels = (c: SimulatorCar) => (c as unknown as { vehicle: { wheels: { isFront: boolean; isLeft: boolean; steerRad: number }[] } }).vehicle.wheels;
  const car = withSetup(v, { toeFrontDeg: 0.3 });
  car.resetToStartGrid(false);
  car.step(DT, {});
  const fl = wheels(car).find((w) => w.isFront && w.isLeft)!;
  const fr = wheels(car).find((w) => w.isFront && !w.isLeft)!;
  // steerRad + = left: toe-in points the left wheel right and the right wheel left
  check(`${v}: front toe-in points the fronts inward`, fl.steerRad < -0.004 && fr.steerRad > 0.004, `${fl.steerRad.toFixed(4)} / ${fr.steerRad.toFixed(4)} rad`);
  const lock = (d: number) => withSetup(v, { steerRatioDelta: d }).maxSteerAngleRad ?? NaN;
  check(`${v}: a slower steering ratio gives less lock`, lock(2) < lock(0) && lock(-2) > lock(0), `${lock(-2).toFixed(3)} / ${lock(0).toFixed(3)} / ${lock(2).toFixed(3)} rad`);
  const pre = (d: number) => (withSetup(v, { diffPreloadNm: d }) as unknown as { config: { differential: { settings: { preload: number } } } }).config.differential.settings.preload;
  check(`${v}: diff preload follows the setup`, Math.abs(pre(50) - pre(0) - 50) < 1e-6);
}
{
  const car = withSetup("vf26", { toeRearDeg: 0.2 });
  const spec = (car as unknown as { axles: { spec: { staticToeDeg: number } }[] }).axles[1].spec.staticToeDeg;
  const base = (withSetup("vf26", {}) as unknown as { axles: { spec: { staticToeDeg: number } }[] }).axles[1].spec.staticToeDeg;
  check("vf26: rear toe adds to the car's static toe", Math.abs(spec - base - 0.2) < 1e-9, `${base} → ${spec}°`);
}

console.log(`\nAll ${passed} setup sheet checks passed.`);
