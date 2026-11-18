/**
 * Setup sheets: every F1 car gets the F1 sheet and every GT3 the GT3 sheet; each parameter's range
 * holds its baseline on a whole step, round-trips through the setup state, and never asks for more than the cars
 * take. Then the new setup channels move the cars: engine braking, brake power, brake ducts, toe, steering ratio,
 * diff preload and the dampers. Last the fuel load: the default is the load each car always started on, old saves
 * without it still load, more fuel is more mass and a slower lap, the car lightens as it burns, and Casual keeps the
 * mass without the burn.
 * Run: npx tsx scripts/verify-setup-sheet.ts
 */
import {
  clampChassisSetup,
  DEFAULT_CHASSIS_SETUP,
  FACTORY_PRESETS,
  FUEL_LOAD,
  loadChassisSetup,
  loadGaragePresets,
  saveChassisSetup,
  startingFuelKg,
  type ChassisSetup,
  type GarageTuner,
} from "../src/lib/sim/car-setup";
import { SIM_REALISM_FLAGS } from "../src/lib/sim/sim-realism";
import { SETUP_CLASS, setupSheet, type SetupState } from "../src/lib/sim/setup-sheet";
import { TYRE_SETUP_LIMITS } from "../src/lib/sim/tyre-setup";
import type { SimulatorCar } from "../src/lib/sim/simulator-car";
import type { TyreSetup, VehicleModelId } from "../src/types/f1";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { createAmgGt3Sim } from "../src/lib/sim/gt3/AmgGt3Sim";
import { createSuzukiLianaSim } from "../src/lib/sim/road/SuzukiLianaSim";
import { createMtr496rSim } from "../src/lib/sim/proto/Mtr496rSim";
import { createLcLmdhSim } from "../src/lib/sim/proto/LcLmdhSim";
import { createNissanR33Sim } from "../src/lib/sim/classic/NissanR33Sim";
import { createNissanR32Sim } from "../src/lib/sim/classic/NissanR32Sim";
import { createBmwM1ProcarSim } from "../src/lib/sim/classic/BmwM1ProcarSim";
import { createChaparral2d67Sim, createChaparral2dSim } from "../src/lib/sim/classic/Chaparral2dSim";
import { createPorsche934RsrSim } from "../src/lib/sim/classic/Porsche934RsrSim";
import { createVwSciroccoSim } from "../src/lib/sim/road/VwSciroccoSim";
import { F1Physics2026 } from "../src/lib/f1-physics-2026";
import { getActiveTrackData } from "../src/lib/track-data";
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
const track = getActiveTrackData();
const makers: Record<VehicleModelId, (t: typeof track) => SimulatorCar> = {
  lc26: (t) => new F1Physics2026(t),
  "f12026-car": (t) => new F12026CarSim(t),
  "amg-gt3": (t) => createAmgGt3Sim(t),
  liana: (t) => createSuzukiLianaSim(t),
  "mtr-496r": (t) => createMtr496rSim(t),
  "lc-lmdh": (t) => createLcLmdhSim(t),
  "nissan-r33-jgtc": (t) => createNissanR33Sim(t),
  "nissan-r32-jtcc": (t) => createNissanR32Sim(t),
  "bmw-m1-procar": (t) => createBmwM1ProcarSim(t),
  "vw-scirocco-gtx": (t) => createVwSciroccoSim(t),
  "chaparral-2d": (t) => createChaparral2dSim(t),
  "chaparral-2d-67": (t) => createChaparral2d67Sim(t),
  "porsche-934-rsr": (t) => createPorsche934RsrSim(t),
};
const vehicles = Object.keys(makers) as VehicleModelId[];
const DT = 1 / 60;

// ---- The sheets ----
console.log("Sheets");
check("both F1 cars use the F1 sheet, the GT3 the GT3 sheet", SETUP_CLASS.lc26 === "f1" && SETUP_CLASS["f12026-car"] === "f1" && SETUP_CLASS["amg-gt3"] === "gt3");
const tuner: GarageTuner = { tcLevel: 5, tc2Level: 6, absLevel: 5, brakeBiasPct: 56, brakeMigrationPct: 2.5, diffEntry: 3, diffMid: 5, diffExit: 5, engineMap: 2 };
const defaultTyre = (v: VehicleModelId): TyreSetup => makers[v](flat).getTyreSetup();
const sheets = Object.fromEntries(vehicles.map((v) => [v, setupSheet(v, TYRE_SETUP_LIMITS[v], defaultTyre(v))]));
const groupIds = (v: VehicleModelId) => sheets[v].map((g) => g.id).join(",");
check("the F1 cars share one sheet layout", groupIds("lc26") === groupIds("f12026-car"), groupIds("lc26"));
check("F1 sheet: its pages in order", groupIds("lc26") === "aero,transmission,geometry,suspension,dampers,brakes,tyres,electronics,fuel");
check("GT3 sheet: its pages in order", groupIds("amg-gt3") === "tyres,electronics,mechanical,dampers,aero,fuel");
const paramIds = (v: VehicleModelId) => sheets[v].flatMap((g) => g.params.map((q) => q.id));
check("the F1 cars share the same parameters", paramIds("lc26").join() === paramIds("f12026-car").join());
for (const id of ["steerRatioDelta", "bumpStopRateFrontPct", "diffPreloadNm", "fastBumpFrontPct", "brakeDuctFront", "toeFrontDeg"])
  check(`GT3 sheet has ${id}`, paramIds("amg-gt3").includes(id));
for (const id of ["frontWingClicks", "diffExit", "diffEntry", "engineBrakingPct", "toeRearDeg", "brakePowerPct", "brakeMigrationPct"])
  check(`F1 sheet has ${id}`, paramIds("lc26").includes(id));
const DAMPER_IDS: (keyof ChassisSetup)[] = [
  "bumpFrontPct", "bumpRearPct", "fastBumpFrontPct", "fastBumpRearPct",
  "reboundFrontPct", "reboundRearPct", "fastReboundFrontPct", "fastReboundRearPct",
];
for (const v of vehicles) {
  const dampersPage = sheets[v].find((g) => g.id === "dampers");
  check(`${v}: a dampers page with bump and rebound, slow and fast, front and rear`, dampersPage?.params.map((q) => q.id).join() === DAMPER_IDS.join());
}

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
  // LC26: a light pedal at moderate speed is torque-limited, so lower brake pressure stops less
  const stop = (pct: number) => {
    const car = withSetup("lc26", { brakePowerPct: pct });
    car.resetToStartGrid(true);
    for (let i = 0; i < 60; i++) car.step(DT, { throttle: 1 });
    const v0 = car.telemetry.speedKmh;
    for (let i = 0; i < 30; i++) car.step(DT, { brake: 0.35 });
    return v0 - car.telemetry.speedKmh;
  };
  const full = stop(0);
  const low = stop(-20);
  check("lc26: lower brake pressure loses less speed on the same pedal", low < full - 0.2, `${full.toFixed(1)} vs ${low.toFixed(1)} km/h`);
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
  const car = withSetup("lc26", { toeRearDeg: 0.2 });
  const spec = (car as unknown as { axles: { spec: { staticToeDeg: number } }[] }).axles[1].spec.staticToeDeg;
  const base = (withSetup("lc26", {}) as unknown as { axles: { spec: { staticToeDeg: number } }[] }).axles[1].spec.staticToeDeg;
  check("lc26: rear toe adds to the car's static toe", Math.abs(spec - base - 0.2) < 1e-9, `${base} → ${spec}°`);
}

console.log("Dampers");
{
  // Each damper setting scales its own curve: +40 % on one channel is 1.4× that channel's baseline, the rest untouched
  type Curve = { slow_bump: number; fast_bump: number; slow_rebound: number; fast_rebound: number };
  type Lc26Damper = { bumpSlow: number; bumpFast: number; reboundSlow: number; reboundFast: number };
  const rigid = (c: SimulatorCar) => (c as unknown as { config: { suspensions: { dampers_controller: { front: { base: Curve }; rear: { base: Curve } } } } }).config.suspensions.dampers_controller;
  const lc26 = (c: SimulatorCar) => (c as unknown as { axles: { spec: { damper: Lc26Damper } }[] }).axles;
  const curves = (v: VehicleModelId, c: SimulatorCar): number[] => {
    if (v === "lc26") {
      const [f, r] = lc26(c).map((a) => a.spec.damper);
      return [f.bumpSlow, r.bumpSlow, f.bumpFast, r.bumpFast, f.reboundSlow, r.reboundSlow, f.reboundFast, r.reboundFast];
    }
    const { front: { base: f }, rear: { base: r } } = rigid(c);
    return [f.slow_bump, r.slow_bump, f.fast_bump, r.fast_bump, f.slow_rebound, r.slow_rebound, f.fast_rebound, r.fast_rebound];
  };
  for (const v of vehicles) {
    const base = curves(v, withSetup(v, {}));
    const bad: string[] = [];
    DAMPER_IDS.forEach((id, i) => {
      const got = curves(v, withSetup(v, { [id]: 40 }));
      got.forEach((x, j) => {
        const want = base[j] * (j === i ? 1.4 : 1);
        if (Math.abs(x - want) > 1e-6 * Math.max(1, want)) bad.push(`${id}→#${j}: ${x.toFixed(0)} not ${want.toFixed(0)}`);
      });
    });
    check(`${v}: each damper setting scales only its own curve`, bad.length === 0, bad.slice(0, 3).join("; "));
    // And it acts on the car: on a step steer at speed, stiffer dampers slow the body's roll in the first 0.1 s
    // (roll is the corner dampers' alone; the LC26's heave damper would mask them in pitch)
    const comp = (c: SimulatorCar): { comp: number; front: boolean; left: boolean }[] =>
      v === "lc26"
        ? (c as unknown as { wheels: { suspCompression: number; isFront: boolean; isLeft: boolean }[] }).wheels.map((w) => ({ comp: w.suspCompression, front: w.isFront, left: w.isLeft }))
        : (c as unknown as { vehicle: { wheels: { compression: number; isFront: boolean; isLeft: boolean }[] } }).vehicle.wheels.map((w) => ({ comp: w.compression, front: w.isFront, left: w.isLeft }));
    const frontRoll = (c: SimulatorCar) => {
      const fr = comp(c).filter((w) => w.front);
      return fr.find((w) => !w.left)!.comp - fr.find((w) => w.left)!.comp;
    };
    const rollShare = (pct: number) => {
      const car = withSetup(v, Object.fromEntries(DAMPER_IDS.map((id) => [id, pct])));
      car.resetToStartGrid(true);
      for (let i = 0; i < 60; i++) car.step(1 / 120, { throttle: 0.25 });
      const r0 = frontRoll(car);
      let early = 0;
      for (let i = 0; i < 120; i++) {
        car.step(1 / 240, { throttle: 0.25, steerLeft: 0.5 });
        if (i === 23) early = frontRoll(car) - r0;
      }
      return early / (frontRoll(car) - r0);
    };
    const soft = rollShare(-40);
    const stiff = rollShare(40);
    check(`${v}: stiffer dampers slow the body's roll on a step steer`, stiff < soft - 0.02, `${(soft * 100).toFixed(0)} % vs ${(stiff * 100).toFixed(0)} % of the roll after 0.1 s`);
  }
}

console.log("Fuel load");
{
  // What every car started on before the garage had a fuel setting; the GT3 and the LC-LMDH since on their endurance
  // trims' fixed sprint loads
  const LEGACY_FUEL_KG: Record<VehicleModelId, number> = {
    lc26: 40,
    "f12026-car": 35,
    "amg-gt3": 30,
    liana: 22,
    "mtr-496r": 22,
    "lc-lmdh": 28,
    "nissan-r33-jgtc": 30,
    "nissan-r32-jtcc": 22,
    "bmw-m1-procar": 22,
    "vw-scirocco-gtx": 22,
    "chaparral-2d": 22,
    "chaparral-2d-67": 22,
    "porsche-934-rsr": 22,
  };
  // A setup saved before the fuel setting: no fuel field at all
  const { fuelDeltaKg: _drop, ...modern } = DEFAULT_CHASSIS_SETUP;
  void _drop;
  const legacy = clampChassisSetup({ ...modern, springFrontPct: 6 });
  check("an old save without a fuel field loads on the default fuel", legacy.fuelDeltaKg === 0 && legacy.springFrontPct === 6);
  check("a junk fuel field falls back to the default", clampChassisSetup({ fuelDeltaKg: "lots" }).fuelDeltaKg === 0 && clampChassisSetup({ fuelDeltaKg: Number.NaN }).fuelDeltaKg === 0);

  // Saves from before 18 Nov 2026 (no tyreBlankets entry) were offset from the GT3's 50 kg and the LMDh's 38 kg
  // defaults of then: a load the driver chose keeps its kilograms (as far as the tank goes), the default stays the default
  {
    const store = new Map<string, string>();
    const g = globalThis as { window?: unknown };
    const had = g.window;
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
    const { tyreBlankets: _tb, ...before } = DEFAULT_CHASSIS_SETUP;
    void _tb;
    store.set("lc.garage.chassis.amg-gt3", JSON.stringify({ ...before, fuelDeltaKg: 10 }));
    store.set("lc.garage.chassis.lc-lmdh", JSON.stringify({ ...before, fuelDeltaKg: 0 }));
    store.set("lc.garage.chassis.mtr-496r", JSON.stringify({ ...before, fuelDeltaKg: 10 }));
    store.set("lc.garage.presets.lc-lmdh", JSON.stringify([{ name: "Long", chassis: { ...before, fuelDeltaKg: 60 } }]));
    const gt3 = loadChassisSetup("amg-gt3");
    const kg = (v: VehicleModelId, s: ChassisSetup) => startingFuelKg(v, s);
    check("a GT3 save from before 18 Nov keeps its 60 kg", kg("amg-gt3", gt3) === 60, `${kg("amg-gt3", gt3)} kg`);
    saveChassisSetup("amg-gt3", gt3);
    check("and keeps them once saved again", kg("amg-gt3", loadChassisSetup("amg-gt3")) === 60, `${kg("amg-gt3", loadChassisSetup("amg-gt3"))} kg`);
    check("an LMDh save on the default load starts on today's default", kg("lc-lmdh", loadChassisSetup("lc-lmdh")) === FUEL_LOAD["lc-lmdh"].defaultKg);
    const preset = loadGaragePresets("lc-lmdh")[0]?.chassis;
    check("an LMDh preset's 98 kg load fills today's tank", preset !== undefined && kg("lc-lmdh", preset) === FUEL_LOAD["lc-lmdh"].maxKg, `${preset && kg("lc-lmdh", preset)} kg`);
    check("a car whose default did not change keeps its offset", kg("mtr-496r", loadChassisSetup("mtr-496r")) === FUEL_LOAD["mtr-496r"].defaultKg + 10);
    g.window = had;
  }

  type Massy = SimulatorCar & { contactMassKg?: number; totalMassKg?: number; setSimRealism?: (f: (typeof SIM_REALISM_FLAGS)["full"]) => void };
  const massOf = (c: SimulatorCar) => (c as Massy).contactMassKg ?? (c as Massy).totalMassKg ?? Number.NaN;
  for (const v of vehicles) {
    const f = FUEL_LOAD[v];
    const fresh = makers[v](flat);
    check(`${v}: the default load is the ${LEGACY_FUEL_KG[v]} kg it always started on`, f.defaultKg === LEGACY_FUEL_KG[v] && Math.abs(fresh.telemetry.fuelKg - LEGACY_FUEL_KG[v]) < 1e-6, `${fresh.telemetry.fuelKg} kg`);
    const old = withSetup(v, legacy);
    old.resetToStartGrid(false);
    check(`${v}: an old save starts on the default load`, Math.abs(old.telemetry.fuelKg - f.defaultKg) < 1e-6);

    const light = withSetup(v, { fuelDeltaKg: f.minKg - f.defaultKg });
    const heavy = withSetup(v, { fuelDeltaKg: f.maxKg - f.defaultKg });
    const dm = massOf(heavy) - massOf(light);
    check(`${v}: the fuel load sets the starting fuel and the mass`, Math.abs(light.telemetry.fuelKg - f.minKg) < 1e-6 && Math.abs(heavy.telemetry.fuelKg - f.maxKg) < 1e-6 && Math.abs(dm - (f.maxKg - f.minKg)) < 1e-6, `${f.minKg}–${f.maxKg} kg, +${dm.toFixed(1)} kg`);
    check(`${v}: the load holds through a restart`, (heavy.resetToStartGrid(true), Math.abs(heavy.telemetry.fuelKg - f.maxKg) < 1e-6));
    const sameFuel = withSetup(v, { fuelDeltaKg: 10 });
    // Burning switched on (the game's sprints run a fixed load, `SimRealismFlags.fuelUse`)
    (sameFuel as Massy).setSimRealism?.({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
    // 4 s: a car whose fuel flow follows its rpm burns under the readout's 0.01 kg in the first 2 s of a launch
    for (let i = 0; i < 240; i++) sameFuel.step(DT, { throttle: 1 });
    const burnt = sameFuel.telemetry.fuelKg;
    sameFuel.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP, fuelDeltaKg: 10, springFrontPct: 6 });
    check(`${v}: changing another setting keeps the fuel burnt so far`, burnt < f.defaultKg + 10 && sameFuel.telemetry.fuelKg === burnt);

    // With burning on the car lightens; Full as shipped (sprints on a fixed load) and Casual keep the load and its mass
    // all run. 20 kg over the default, or a full tank where that's less (the Liana's 37 kg tank starts on 22)
    const extra = Math.min(20, f.maxKg - f.defaultKg);
    const burn = (level: "burning" | "full" | "casual") => {
      const car = withSetup(v, { fuelDeltaKg: extra });
      (car as Massy).setSimRealism?.(level === "burning" ? { ...SIM_REALISM_FLAGS.full, fuelUse: true } : SIM_REALISM_FLAGS[level]);
      car.resetToStartGrid(true);
      const m0 = massOf(car);
      for (let i = 0; i < 600; i++) car.step(DT, { throttle: 1 });
      return { fuel: car.telemetry.fuelKg, dm: massOf(car) - m0 };
    };
    const burning = burn("burning");
    const full = burn("full");
    const casual = burn("casual");
    const start = f.defaultKg + extra;
    check(`${v}: burning, the fuel goes and the car lightens`, burning.fuel < start - 0.05 && Math.abs(burning.dm + (start - burning.fuel)) < 0.006 /* the readout is to 0.01 kg */, `${(start - burning.fuel).toFixed(2)} kg in 10 s`);
    check(`${v}: Full and Casual keep the load and its mass (sprint ballast)`, full.fuel === start && full.dm === 0 && casual.fuel === start && casual.dm === 0);
  }

  // A flying lap of Kigali on the autopilot, light and full: the extra mass costs time
  console.log("Fuel load: lap time");
  const lapS = (v: VehicleModelId, fuelKg: number) => {
    const car = withSetup(v, { fuelDeltaKg: fuelKg - FUEL_LOAD[v].defaultKg }, track);
    (car as Massy).setSimRealism?.(SIM_REALISM_FLAGS.casual);
    car.resetToStartGrid(true);
    car.aiAutopilot = true;
    const lap0 = car.telemetry.lapCount;
    for (let t = 0; t < 240 && car.telemetry.lapCount < lap0 + 1; t += DT) car.step(DT, {});
    return car.telemetry.lapCount === lap0 + 1 && car.telemetry.lastLapTimeMs !== null ? car.telemetry.lastLapTimeMs / 1000 : Number.NaN;
  };
  for (const v of vehicles) {
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
  check("startingFuelKg keeps to each car's range", startingFuelKg("amg-gt3", { fuelDeltaKg: 80 }) === FUEL_LOAD["amg-gt3"].maxKg && startingFuelKg("lc26", { fuelDeltaKg: -50 }) === FUEL_LOAD.lc26.minKg);
}

// ---- Factory setups ----
console.log("Factory setups");
for (const v of vehicles) {
  for (const f of FACTORY_PRESETS[v] ?? []) {
    const d = defaultTyre(v);
    const st: SetupState = { chassis: { ...DEFAULT_CHASSIS_SETUP, ...f.chassis }, tyre: { ...d, camberDeg: f.camberDeg ?? d.camberDeg }, tuner };
    // Every value inside its slider's range, so the garage loads it unchanged
    const out = sheets[v].flatMap((g) => g.params).filter((q) => q.writes !== "tuner" && (q.get(st) < q.min - 1e-9 || q.get(st) > q.max + 1e-9));
    check(`${v} ${f.id}: every setting on its slider`, out.length === 0, out.map((q) => q.id).join(", "));
    const sim = makers[v](flat) as unknown as { applyChassisSetup(c: ChassisSetup): void; config: { suspensions: { rear: { arb: number } }; gearbox: { finalDrive?: number; ratios: number[] } } };
    const base = makers[v](flat) as unknown as typeof sim;
    sim.applyChassisSetup(clampChassisSetup(st.chassis));
    base.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP });
    const longer = sim.config.gearbox.ratios.at(-1)! * (sim.config.gearbox.finalDrive ?? 1) < base.config.gearbox.ratios.at(-1)! * (base.config.gearbox.finalDrive ?? 1);
    const detached = f.chassis.arbRearPct === -100 ? sim.config.suspensions.rear.arb === 0 : sim.config.suspensions.rear.arb > 0;
    check(`${v} ${f.id}: long top gear, rear bar as set`, longer && detached, `rear ARB ${sim.config.suspensions.rear.arb.toFixed(0)} N/m`);
  }
}

console.log(`\nAll ${passed} setup sheet checks passed.`);
