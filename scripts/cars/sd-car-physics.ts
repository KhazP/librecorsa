/**
 * A Speed Dreams car's physics as a mod physics patch (src/lib/mods/mod-physics.ts) on the closest of the game's
 * vehicle models. Its parameters (scripts/lib/sd-params.ts: the car's XML over its category's, in SI) are read as
 * Speed Dreams' simulation (simuv5) uses them, and each is converted to what the profile's value means here:
 *
 *  - Car: `mass` (with the driver, no fuel), `front-rear weight repartition`, the axles' `xpos` and the wheels' `ypos`
 *    (wheelbase, tracks); the CG stands `GC height` over the body's reference plane, which is `ride height` over the road
 *    at each axle; the inertias are simuv5's box, m·k²·(a² + b²)/12 over the body's sizes, k the `mass repartition
 *    coefficient`, unless the file states them.
 *  - Engine: `data points` (crank torque, N·m, against rpm) as crank power; `revs limiter`, `tickover`, `inertia`;
 *    closed-throttle braking bL·ω + bC·maxTorque (`brake linear coefficient`, `brake coefficient`); fuel flow from
 *    `fuel cons factor` (litres = 0.75e-7·power·factor a second).
 *  - Gearbox and driveline: the gears' ratios, the driven differential's `ratio` as the final drive, the gears' and the
 *    differential's efficiencies multiplied, `shift time`; the differential's type and `max slip bias` as a ramp LSD.
 *  - Brakes: each wheel's full-pedal torque, disc radius × piston area × pad μ × `max pressure` × its axle's share.
 *  - Tyres: radius rim / 2 + width × ratio; Speed Dreams' grip, μ × the load factor (1 at `operating load`, `load
 *    factor max` with no load, falling to `load factor min`), as the peak μ against load; the magic formula's peak slip
 *    (`stiffness`, `dynamic friction`, `elasticity factor`) as the peak slip angle, and its sliding level
 *    (`dynamic friction` exactly) as the falloff.
 *  - Suspension: wheel rates k·b² and damping c·b² for a spring and dampers on a `bellcrank` b, the dampers' knees
 *    (`bump` / `rebound limit velocity`) over b; the anti-roll bars' `spring`; camber; the free travel to the packers and
 *    to full droop (`suspension course`) from the ride height.
 *  - Aero: Speed Dreams' forces at ρ = 1.29 and its body lift's ground effect at the static ride heights, as the
 *    profile's coefficients at its own air density (aero-fit.ts matches the base's aero to them by driving it).
 *
 * Numbers in "lbs/in" stay as Speed Dreams converts them (a pound as a mass: ×17.86 to N/m), since that is the spring
 * its cars were set up on. Anything the base has no place for, or that Speed Dreams' simulation doesn't use, is listed.
 */
import type { CarSimProfile } from "../../src/lib/sim/f12026-car/F12026CarSim";
import type { VehicleModelId } from "../../src/types/f1";
import type { ModCarClass } from "../../src/lib/mods/mod-manifest";
import { VEHICLE_MODELS } from "../../src/lib/cars/vehicle-models";
import type { SdParams } from "../lib/sd-params";

const G = 9.81;
const RAD_S_TO_RPM = 30 / Math.PI;
/** Speed Dreams' air (aero.cpp's fixed density) */
export const SD_RHO = 1.29;

const COMPOUND_NAMES = ["soft", "medium", "hard", "wet", "extrem wet"] as const;
const CORNER_SECTIONS = {
  FR: ["Front Right Wheel", "Front Right Suspension", "Front Right Brake"],
  FL: ["Front Left Wheel", "Front Left Suspension", "Front Left Brake"],
  RR: ["Rear Right Wheel", "Rear Right Suspension", "Rear Right Brake"],
  RL: ["Rear Left Wheel", "Rear Left Suspension", "Rear Left Brake"],
} as const;

export interface SdTyre {
  rimRadius: number;
  width: number;
  radius: number;
  /** Wheel spin inertia, with half the axle's (axle.cpp) */
  inertia: number;
  rideHeight: number;
  camberDeg: number;
  toeDeg: number;
  stiffness: number;
  /** `dynamic friction`: the sliding force over the peak */
  dynamicFriction: number;
  elasticity: number;
  operatingLoadN: number;
  lfMin: number;
  lfMax: number;
  /** μ by compound name, or the wheel's own `mu` under "" */
  mu: Record<string, number>;
  unsprungKg?: number;
}

export interface SdAxleSuspension {
  spring: number;
  bellcrank: number;
  course: number;
  packers: number;
  slowBump: number;
  slowRebound: number;
  fastBump: number;
  fastRebound: number;
  bumpKnee: number;
  reboundKnee: number;
  arb: number;
}

export interface SdWing {
  area: number;
  angleRad: number;
  xpos: number;
  zpos: number;
  type: string;
  params: Record<string, number>;
}

/** What the car's parameters say, in SI, as Speed Dreams' simulation reads them */
export interface SdCar {
  name: string;
  category: string;
  massKg: number;
  frontWeight: number;
  gcHeight: number;
  xFront: number;
  xRear: number;
  track: { front: number; rear: number };
  body: { length: number; width: number; height: number };
  inertia: { roll: number; pitch: number; yaw: number };
  engine: {
    torque: [number, number][];
    limiterRpm: number;
    maxRpm: number;
    idleRpm: number;
    inertia: number;
    brakeLinear: number;
    brakeCoeff: number;
    fuelFactor: number;
    turbo: boolean;
    capacityL?: number;
    cylinders?: number;
    shape?: string;
    position?: string;
    revLimitFeature: boolean;
  };
  gears: { ratios: number[]; reverse: number; efficiency: number; shiftTimeS: number };
  drive: "RWD" | "FWD" | "4WD";
  diff: { type: string; ratio: number; efficiency: number; lockTorque: number; maxSlipBias: number; coastSlipBias: number };
  steerLockDeg: number;
  brakes: { frontWheelNm: number; rearWheelNm: number };
  tyres: { front: SdTyre; rear: SdTyre };
  compounds: boolean;
  compoundSet: number;
  suspension: { front: SdAxleSuspension; rear: SdAxleSuspension };
  aero: { cx: number; area: number; cliftFront: number; cliftRear: number; wings: { front?: SdWing; rear?: SdWing } };
}

const num = (p: SdParams, s: string, k: string, d: number) => p.numOr(s, k, d);
const mean = (a: number, b: number) => (a + b) / 2;

function readTyre(p: SdParams, right: string, left: string, axle: string): SdTyre {
  const both = (k: string, d: number) => mean(num(p, right, k, d), num(p, left, k, d));
  const rim = both("rim diameter", 0.33) / 2;
  const width = both("tire width", 0.145);
  const height = both("tire height", 0) || width * both("tire height-width ratio", 0.75);
  const mu: Record<string, number> = { "": both("mu", 1) };
  for (const c of COMPOUND_NAMES) {
    const m = p.num(`${right}/Compounds/${c}`, "mu");
    if (m !== undefined) mu[c] = mean(m, p.numOr(`${left}/Compounds/${c}`, "mu", m));
  }
  const lfMin = Math.min(0.9, both("load factor min", 0.8));
  const lfMax = Math.max(1.1, both("load factor max", 1.6));
  return {
    rimRadius: rim,
    width,
    radius: rim + height,
    inertia: both("inertia", 1.5) + num(p, `${axle} Axle`, "inertia", 0) / 2,
    rideHeight: both("ride height", 0.2),
    camberDeg: (both("camber", 0) * 180) / Math.PI,
    toeDeg: (both("toe", 0) * 180) / Math.PI,
    stiffness: both("stiffness", 30),
    // Kept as read past 0.99 (sdCarProblems refuses it): at 100 % Speed Dreams' curve never peaks
    dynamicFriction: Math.max(0.1, both("dynamic friction", 0.8)),
    elasticity: both("elasticity factor", 0.7),
    // A raw number in N, whatever unit the file gives it (wheel.cpp); its default, 1.2 × the static corner load, below
    operatingLoadN: both("operating load", 0),
    lfMin,
    lfMax,
    mu,
    unsprungKg: p.has(right, "mass") ? both("mass", 20) : undefined,
  };
}

function readSuspension(p: SdParams, right: string, left: string, arb: string): SdAxleSuspension {
  const both = (k: string, d: number) => mean(num(p, right, k, d), num(p, left, k, d));
  return {
    spring: both("spring", 175_000),
    bellcrank: both("bellcrank", 1),
    course: both("suspension course", 0.5),
    packers: both("packers", 0),
    slowBump: both("slow bump", 0),
    slowRebound: both("slow rebound", 0),
    fastBump: both("fast bump", 0),
    fastRebound: both("fast rebound", 0),
    bumpKnee: both("bump limit velocity", 0.5),
    reboundKnee: both("rebound limit velocity", 0.5),
    arb: num(p, arb, "spring", 175_000),
  };
}

function readWing(p: SdParams, sec: string): SdWing | undefined {
  const area = p.num(sec, "area");
  if (!area) return undefined;
  const params: Record<string, number> = {};
  for (const k of p.keys(sec)) {
    const v = p.num(sec, k);
    if (v !== undefined) params[k] = v;
  }
  return { area, angleRad: num(p, sec, "angle", 0), xpos: num(p, sec, "xpos", 0), zpos: num(p, sec, "zpos", 0), type: (p.str(sec, "wing type") ?? "FLAT").toUpperCase(), params };
}

/** The car's parameters as simuv5 reads them (car.cpp, engine.cpp, transmission.cpp, wheel.cpp, susp.cpp, aero.cpp) */
export function readSdCar(p: SdParams): SdCar {
  const mass = num(p, "Car", "mass", 1500);
  const frontWeight = num(p, "Car", "front-rear weight repartition", 0.5);
  const L = num(p, "Car", "body length", 4.7);
  const W = num(p, "Car", "body width", 1.9);
  const H = num(p, "Car", "body height", 1.2);
  const k = num(p, "Car", "mass repartition coefficient", 1);
  const box = (a: number, b: number) => (mass * k * k * (a * a + b * b)) / 12;

  // Engine: the curve's points by rising rpm (a category's extra points come after the car's)
  const torque: [number, number][] = [];
  for (const s of p.sections("Engine/data points")) {
    const w = p.num(`Engine/data points/${s}`, "rpm");
    const tq = p.num(`Engine/data points/${s}`, "Tq");
    if (w !== undefined && tq !== undefined) torque.push([w * RAD_S_TO_RPM, tq]);
  }
  torque.sort((a, b) => a[0] - b[0]);
  const curve = torque.filter((pt, i) => i === 0 || pt[0] > torque[i - 1][0] + 1e-6);
  const maxRpm = Math.min(num(p, "Engine", "revs maxi", 1000) * RAD_S_TO_RPM, curve.length ? curve[curve.length - 1][0] : Infinity);
  const limiterRpm = Math.min(num(p, "Engine", "revs limiter", 800) * RAD_S_TO_RPM, maxRpm);

  // Gearbox: forward gears 1..n, as transmission.cpp counts them
  const ratios: number[] = [];
  const effs: number[] = [];
  for (let g = 1; g <= 8; g++) {
    const r = p.num(`Gearbox/gears/${g}`, "ratio");
    if (r === undefined || r === 0) break;
    ratios.push(r);
    effs.push(Math.min(1, Math.max(0, p.numOr(`Gearbox/gears/${g}`, "efficiency", 1))));
  }
  const drive = (p.str("Drivetrain", "type") ?? "RWD").toUpperCase() as SdCar["drive"];
  const diffSec = drive === "FWD" ? "Front Differential" : drive === "4WD" ? "Central Differential" : "Rear Differential";
  const dtype = (p.str(diffSec, "type") ?? "NONE").toUpperCase();
  const msb = num(p, diffSec, "max slip bias", 0.75);
  const diff = {
    type: dtype,
    ratio: num(p, diffSec, "ratio", 1),
    efficiency: num(p, diffSec, "efficiency", 1),
    lockTorque: num(p, diffSec, "locking input torque", 300),
    maxSlipBias: msb,
    coastSlipBias: dtype === "1.5 WAY LSD" || dtype === "ELECTRONIC LSD" ? num(p, diffSec, "coast max slip bias", msb) : msb,
  };
  const meanEff = effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : 1;
  const sideEff = drive === "4WD" ? mean(num(p, "Front Differential", "efficiency", 1), num(p, "Rear Differential", "efficiency", 1)) : 1;

  // Brakes: each wheel's torque at full pedal (brake.cpp)
  const pMax = num(p, "Brake System", "max pressure", 3e7);
  const rep = num(p, "Brake System", "front-rear brake repartition", 0.5);
  const wheelNm = (sec: string, share: number) => (num(p, sec, "disk diameter", 0.38) / 2) * num(p, sec, "piston area", 0.005) * num(p, sec, "mu", 0.3) * pMax * share;

  const front = readTyre(p, CORNER_SECTIONS.FR[0], CORNER_SECTIONS.FL[0], "Front");
  const rear = readTyre(p, CORNER_SECTIONS.RR[0], CORNER_SECTIONS.RL[0], "Rear");
  // `operating load` defaults to 1.2 × the static corner load (wheel.cpp)
  if (!front.operatingLoadN) front.operatingLoadN = 1.2 * mass * G * frontWeight * 0.5;
  if (!rear.operatingLoadN) rear.operatingLoadN = 1.2 * mass * G * (1 - frontWeight) * 0.5;

  // Body lift: `front Clift` and `rear Clift`, or the newer `Clift` (2 × their sum) and its front share
  let cliftFront = num(p, "Aerodynamics", "front Clift", 0);
  let cliftRear = num(p, "Aerodynamics", "rear Clift", 0);
  if (p.has("Aerodynamics", "Clift")) {
    const total = num(p, "Aerodynamics", "Clift", 0) / 2;
    const bias = num(p, "Aerodynamics", "Clift bias", 0.5);
    cliftFront = total * bias;
    cliftRear = total * (1 - bias);
  }
  const feature = (k: string) => (p.str("Features", k) ?? "no").toLowerCase() === "yes";
  const fuelAt = (s: string) => p.str("Engine", s);
  const capacity = Number.parseFloat(fuelAt("capacity") ?? "") || p.num("Engine", "capacity");

  return {
    name: p.name,
    category: p.str("Car", "category") ?? "",
    massKg: mass,
    frontWeight,
    gcHeight: num(p, "Car", "GC height", 0.5),
    xFront: num(p, "Front Axle", "xpos", 0),
    xRear: num(p, "Rear Axle", "xpos", 0),
    track: {
      front: num(p, CORNER_SECTIONS.FL[0], "ypos", 0.8) - num(p, CORNER_SECTIONS.FR[0], "ypos", -0.8),
      rear: num(p, CORNER_SECTIONS.RL[0], "ypos", 0.8) - num(p, CORNER_SECTIONS.RR[0], "ypos", -0.8),
    },
    body: { length: L, width: W, height: H },
    inertia: {
      roll: p.num("Car", "roll rotational inertia") ?? box(W, H),
      pitch: p.num("Car", "pitch rotational inertia") ?? box(L, H),
      yaw: p.num("Car", "yaw rotational inertia") ?? box(W, L),
    },
    engine: {
      torque: curve,
      limiterRpm,
      maxRpm,
      idleRpm: num(p, "Engine", "tickover", 150) * RAD_S_TO_RPM,
      inertia: num(p, "Engine", "inertia", 0.2423),
      brakeLinear: num(p, "Engine", "brake linear coefficient", 0.03),
      brakeCoeff: num(p, "Engine", "brake coefficient", 0.03),
      fuelFactor: num(p, "Engine", "fuel cons factor", 0.0622),
      turbo: (p.str("Engine", "turbo") ?? "false").toLowerCase() === "true",
      capacityL: Number.isFinite(capacity) && capacity ? capacity : undefined,
      cylinders: p.num("Engine", "cylinders"),
      shape: p.str("Engine", "shape"),
      position: p.str("Engine", "position"),
      revLimitFeature: feature("realistic rev limiter"),
    },
    gears: {
      ratios,
      reverse: Math.abs(num(p, "Gearbox/gears/r", "ratio", -3)),
      efficiency: meanEff * diff.efficiency * sideEff,
      shiftTimeS: num(p, "Gearbox", "shift time", 0.2),
    },
    drive,
    diff,
    steerLockDeg: (num(p, "Steer", "steer lock", 0.43) * 180) / Math.PI,
    brakes: { frontWheelNm: wheelNm(CORNER_SECTIONS.FR[2], rep), rearWheelNm: wheelNm(CORNER_SECTIONS.RR[2], 1 - rep) },
    tyres: { front, rear },
    compounds: feature("tire compounds"),
    compoundSet: Math.round(num(p, "Tires Set", "compound set", 5)),
    suspension: {
      front: readSuspension(p, CORNER_SECTIONS.FR[1], CORNER_SECTIONS.FL[1], "Front Anti-Roll Bar"),
      rear: readSuspension(p, CORNER_SECTIONS.RR[1], CORNER_SECTIONS.RL[1], "Rear Anti-Roll Bar"),
    },
    aero: {
      cx: num(p, "Aerodynamics", "Cx", 0.4),
      area: num(p, "Aerodynamics", "front area", 2.5),
      cliftFront,
      cliftRear,
      wings: { front: readWing(p, "Front Wing"), rear: readWing(p, "Rear Wing") },
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed Dreams' tyre and aero, evaluated
// ---------------------------------------------------------------------------------------------------------------------

/** μ at load `fz` (N): mu × the load factor (wheel.cpp), before temperature and camber */
export function sdTyreMu(t: SdTyre, mu: number, fz: number): number {
  const k = Math.log((1 - t.lfMin) / (t.lfMax - t.lfMin));
  return mu * (t.lfMin + (t.lfMax - t.lfMin) * Math.exp((k * fz) / t.operatingLoadN));
}

/**
 * The magic formula's force over its peak at slip s, and the slip of the peak (s = |(slip ratio, sin slip angle)|):
 * Infinity when the curve doesn't peak below a slip of 2 (no stiffness, or a dynamic friction near 100 %)
 */
export function sdTyreCurve(t: SdTyre): { at: (s: number) => number; peakSlip: number } {
  const C = 2 - (2 * Math.asin(Math.min(1, t.dynamicFriction))) / Math.PI;
  const B = t.stiffness / C;
  const E = t.elasticity;
  const at = (s: number) => Math.sin(C * Math.atan(B * s * (1 - E) + E * Math.atan(B * s)));
  // The peak: the argument of the sine reaches π / 2
  const arg = (s: number) => B * s * (1 - E) + E * Math.atan(B * s);
  let lo = 0;
  let hi = 2;
  const target = Math.tan(Math.PI / (2 * C));
  if (!(arg(hi) >= target)) return { at, peakSlip: Number.POSITIVE_INFINITY };
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    if (arg(m) < target) lo = m;
    else hi = m;
  }
  return { at, peakSlip: (lo + hi) / 2 };
}

/** The slip past which a converted tyre's peak isn't one the game's tyre model can take */
export const MAX_PEAK_SLIP = 1;

/**
 * What in the car's parameters the conversion can't take: a value that isn't finite, or one outside the range Speed
 * Dreams' own simulation needs (a mass, wheelbase, spring or bellcrank of 0, brakes with no pressure, an engine with no
 * torque between tickover and the limiter, a tyre whose curve never peaks). Each as "<what> is <value> (<rule>)"
 */
export function sdCarProblems(car: SdCar): string[] {
  const out: string[] = [];
  const need = (what: string, v: number, ok: (x: number) => boolean, rule: string) => {
    if (!Number.isFinite(v) || !ok(v)) out.push(`${what} is ${Number.isFinite(v) ? Number(v.toPrecision(4)) : String(v)} (${rule})`);
  };
  const positive = (what: string, v: number) => need(what, v, (x) => x > 0, "it must be more than 0");
  const nonNegative = (what: string, v: number) => need(what, v, (x) => x >= 0, "it must be 0 or more");
  const finite = (what: string, v: number) => need(what, v, () => true, "it must be a finite number");
  const share = (what: string, v: number) => need(what, v, (x) => x > 0 && x <= 1, "it must be more than 0 and at most 1");

  positive("Car/mass", car.massKg);
  need("Car/front-rear weight repartition", car.frontWeight, (x) => x > 0 && x < 1, "it must be between 0 and 1");
  finite("Car/GC height", car.gcHeight);
  positive("the wheelbase (Front Axle/xpos − Rear Axle/xpos)", car.xFront - car.xRear);
  positive("the front track (Front Left − Front Right Wheel/ypos)", car.track.front);
  positive("the rear track (Rear Left − Rear Right Wheel/ypos)", car.track.rear);
  for (const k of ["roll", "pitch", "yaw"] as const) positive(`the ${k} inertia (Car/${k} rotational inertia, or the body's size and mass)`, car.inertia[k]);
  positive("Steer/steer lock", car.steerLockDeg);

  const e = car.engine;
  for (const [rpm, nm] of e.torque) {
    finite("Engine/data points/rpm", rpm);
    finite("Engine/data points/Tq", nm);
  }
  positive("Engine/tickover", e.idleRpm);
  need("Engine/revs limiter", e.limiterRpm, (x) => x > e.idleRpm, `it must be above the tickover, ${Math.round(e.idleRpm)} rpm`);
  const pulling = e.torque.filter(([rpm, nm]) => rpm >= e.idleRpm && rpm <= e.limiterRpm && nm > 0);
  if (e.torque.length >= 2 && !pulling.length) out.push(`Engine/data points has no torque between the tickover and the limiter (${Math.round(e.idleRpm)}–${Math.round(e.limiterRpm)} rpm)`);
  positive("Engine/inertia", e.inertia);
  nonNegative("Engine/brake linear coefficient", e.brakeLinear);
  nonNegative("Engine/brake coefficient", e.brakeCoeff);
  nonNegative("Engine/fuel cons factor", e.fuelFactor);

  car.gears.ratios.forEach((r, i) => positive(`Gearbox/gears/${i + 1}/ratio`, r));
  positive("Gearbox/gears/r/ratio", car.gears.reverse);
  share("the driveline's efficiency (Gearbox/gears/*/efficiency × the differentials')", car.gears.efficiency);
  nonNegative("Gearbox/shift time", car.gears.shiftTimeS);
  positive("the driven differential's ratio", car.diff.ratio);

  nonNegative("a front wheel's brake torque (Brake System/max pressure, the disc, piston area and mu)", car.brakes.frontWheelNm);
  nonNegative("a rear wheel's brake torque (Brake System/max pressure, the disc, piston area and mu)", car.brakes.rearWheelNm);
  positive("the brakes' torque, front and rear (Brake System/max pressure × the discs)", car.brakes.frontWheelNm + car.brakes.rearWheelNm);

  for (const [A, t] of [["Front", car.tyres.front], ["Rear", car.tyres.rear]] as const) {
    positive(`${A} wheels/rim diameter`, t.rimRadius);
    positive(`${A} wheels/tire width`, t.width);
    positive(`${A} wheels' tyre radius`, t.radius);
    positive(`${A} wheels/inertia`, t.inertia);
    finite(`${A} wheels/ride height`, t.rideHeight);
    finite(`${A} wheels/camber`, t.camberDeg);
    finite(`${A} wheels/toe`, t.toeDeg);
    positive(`${A} wheels/stiffness`, t.stiffness);
    need(`${A} wheels/dynamic friction`, t.dynamicFriction, (x) => x < 0.99, "under 99 %: at 100 % Speed Dreams' tyre never loses grip past its peak, which the game's tyres can't do");
    need(`${A} wheels/elasticity factor`, t.elasticity, (x) => x >= 0 && x < 1, "it must be 0 or more and under 1");
    positive(`${A} wheels/operating load`, t.operatingLoadN);
    for (const [compound, mu] of Object.entries(t.mu)) positive(`${A} wheels${compound ? `/Compounds/${compound}` : ""}/mu`, mu);
    if (out.length === 0) {
      const peak = sdTyreCurve(t).peakSlip;
      need(`${A} wheels' peak slip (stiffness, dynamic friction, elasticity factor)`, peak, (x) => x < MAX_PEAK_SLIP, `the curve must peak under a slip of ${MAX_PEAK_SLIP}`);
    }
  }

  for (const [A, s] of [["Front", car.suspension.front], ["Rear", car.suspension.rear]] as const) {
    positive(`${A} suspensions/spring`, s.spring);
    positive(`${A} suspensions/bellcrank`, s.bellcrank);
    positive(`${A} suspensions/suspension course`, s.course);
    nonNegative(`${A} suspensions/packers`, s.packers);
    for (const [k, v] of [["slow bump", s.slowBump], ["slow rebound", s.slowRebound], ["fast bump", s.fastBump], ["fast rebound", s.fastRebound]] as const) nonNegative(`${A} suspensions/${k}`, v);
    positive(`${A} suspensions/bump limit velocity`, s.bumpKnee);
    positive(`${A} suspensions/rebound limit velocity`, s.reboundKnee);
    nonNegative(`${A} Anti-Roll Bar/spring`, s.arb);
  }

  nonNegative("Aerodynamics/Cx", car.aero.cx);
  positive("Aerodynamics/front area", car.aero.area);
  finite("Aerodynamics/front Clift", car.aero.cliftFront);
  finite("Aerodynamics/rear Clift", car.aero.cliftRear);
  for (const [A, w] of [["Front", car.aero.wings.front], ["Rear", car.aero.wings.rear]] as const) {
    if (!w) continue;
    positive(`${A} Wing/area`, w.area);
    finite(`${A} Wing/angle`, w.angleRad);
    finite(`${A} Wing/xpos`, w.xpos);
    if (w.type === "THIN") {
      positive(`${A} Wing/aspect ratio`, w.params["aspect ratio"] ?? 5);
      positive(`${A} Wing/stall width`, w.params["stall width"] ?? 0.035);
    } else if (w.type === "PROFILE") {
      positive(`${A} Wing/aoa at max + aoa offset`, (w.params["aoa at max"] ?? 0.3) + (w.params["aoa offset"] ?? 0));
    }
  }
  return out;
}

/** Downforce coefficient (N per (m/s)², + down) and drag (N per (m/s)²) of a wing at its static angle (aero.cpp) */
export function sdWingForces(w: SdWing): { lift: number; drag: number } {
  const aoa = w.angleRad;
  const rA = SD_RHO * w.area;
  if (w.type === "THIN") {
    const ar = w.params["aspect ratio"] ?? 5;
    const zero = w.params["aoa at zero"] ?? 0;
    const stall = w.params["angle of stall"] ?? 0.26;
    const width = w.params["stall width"] ?? 0.035;
    const pre = ((2 * Math.PI * ar) / (ar + 2)) * (aoa - zero);
    const post = 1.05 * Math.sin(2 * aoa) + 0.05;
    const blend = Math.min(1, Math.max(0, (aoa - stall) / Math.max(1e-6, width) + 0.5));
    const cl = pre * (1 - blend) + post * blend;
    const cd = (blend < 1 ? 0.6 * aoa * aoa + 0.006 : 1 - 0.9 * Math.cos(2 * aoa)) + (cl * cl) / (0.9 * Math.PI * ar);
    return { lift: 0.5 * rA * cl, drag: 0.5 * rA * cd };
  }
  if (w.type === "PROFILE") {
    const deg = (aoa * 180) / Math.PI;
    const atMax = ((w.params["aoa at max"] ?? 0.3) * 180) / Math.PI;
    const offset = ((w.params["aoa offset"] ?? 0) * 180) / Math.PI;
    const clMax = w.params["clift max"] ?? 1.5;
    const clZero = w.params["clift at zero"] ?? 0;
    const f = 90 / (atMax + offset);
    const s2 = (x: number) => Math.sin((x * Math.PI) / 180) ** 2;
    const d = 1.8 * (s2(f * offset) * clMax - clZero);
    const cl = s2(f * (Math.min(deg, atMax) + offset)) * (clMax + d) - d;
    const zero = w.params["aoa at zero"] ?? 0;
    return { lift: rA * cl, drag: rA * Math.max(Math.abs(Math.sin(aoa - zero)), 0.02) };
  }
  // FLAT
  const s = aoa < Math.PI / 6 ? Math.sin(aoa) : aoa < Math.PI / 2 ? 0.25 * (1 - ((aoa - Math.PI / 3) / (Math.PI / 6)) ** 3) : 0;
  return { lift: rA * s, drag: rA * Math.max(Math.abs(Math.sin(aoa)), 0.02) };
}

/**
 * The car's aero at rest height, as Speed Dreams applies it: downforce on each axle and drag, in N per (m/s)². The body
 * lift (with its ground effect at the static ride heights) acts at the wings' xpos, as car.cpp applies it
 */
export function sdAeroTargets(car: SdCar): { front: number; rear: number; drag: number } {
  const t = car.tyres;
  const sumRh = 2 * t.front.rideHeight + 2 * t.rear.rideHeight;
  const hm = 2 * Math.exp(-3 * (1.5 * sumRh) ** 4);
  const xCg = car.xFront * car.frontWeight + car.xRear * (1 - car.frontWeight);
  const xF = car.xFront - xCg;
  const xR = car.xRear - xCg;
  const wb = xF - xR;
  if (!(wb > 0)) throw new Error(`${car.name}: a wheelbase of ${wb} m (Front Axle/xpos − Rear Axle/xpos must be more than 0)`);
  // A force at x (from the CG) shared onto the axles
  const split = (f: number, x: number) => ({ front: (f * (x - xR)) / wb, rear: (f * (xF - x)) / wb });
  const fw = car.aero.wings.front;
  const rw = car.aero.wings.rear;
  const out = { front: 0, rear: 0, drag: 0.5 * SD_RHO * car.aero.cx * car.aero.area };
  const add = (f: number, x: number) => {
    const s = split(f, x);
    out.front += s.front;
    out.rear += s.rear;
  };
  add(car.aero.cliftFront * hm, fw ? fw.xpos : 0);
  add(car.aero.cliftRear * hm, rw ? rw.xpos : 0);
  for (const w of [fw, rw]) {
    if (!w) continue;
    const f = sdWingForces(w);
    add(f.lift, w.xpos);
    out.drag += f.drag;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The base model
// ---------------------------------------------------------------------------------------------------------------------

/** Speed Dreams' categories: the game's class, and the bases close to their cars */
const CATEGORY_CLASS: Record<string, { classId: ModCarClass; bases: VehicleModelId[]; year?: number }> = {
  MP1: { classId: "f1", bases: ["f12026-car"], year: 2012 },
  "22MP1": { classId: "f1", bases: ["f12026-car"], year: 2022 },
  "23MP1": { classId: "f1", bases: ["f12026-car"], year: 2023 },
  "86MP1": { classId: "f1", bases: ["f12026-car"], year: 1986 },
  "92MP1": { classId: "f1", bases: ["f12026-car"], year: 1992 },
  MP3: { classId: "f1", bases: ["f12026-car"], year: 2005 },
  MP5: { classId: "f1", bases: ["f12026-car", "chaparral-2d"], year: 2005 },
  MP10: { classId: "classic", bases: ["chaparral-2d"], year: 2010 },
  MPA1: { classId: "f1", bases: ["f12026-car"], year: 2005 },
  MPA11: { classId: "f1", bases: ["f12026-car"], year: 2011 },
  MPA12: { classId: "f1", bases: ["f12026-car"], year: 2012 },
  MPE: { classId: "f1", bases: ["f12026-car"], year: 2020 },
  "36GP": { classId: "classic", bases: ["chaparral-2d", "chaparral-2d-67"], year: 1936 },
  "67GP": { classId: "classic", bases: ["chaparral-2d", "chaparral-2d-67"], year: 1967 },
  "Fun-Racer": { classId: "classic", bases: ["chaparral-2d"], year: 2010 },
  "LS-GT1": { classId: "gt3", bases: ["amg-gt3"], year: 2010 },
  "LS-GT1v41": { classId: "gt3", bases: ["amg-gt3"], year: 2010 },
  "LS-GT2": { classId: "gt3", bases: ["amg-gt3"], year: 2010 },
  "SD-GTP": { classId: "proto", bases: ["mtr-496r", "lc-lmdh"], year: 1990 },
  "LS-P1": { classId: "proto", bases: ["lc-lmdh", "mtr-496r"], year: 2010 },
  "LS-P2": { classId: "proto", bases: ["mtr-496r", "lc-lmdh"], year: 2010 },
  SRW: { classId: "gt3", bases: ["amg-gt3", "nissan-r33-jgtc"], year: 2010 },
  TRB1: { classId: "gt3", bases: ["amg-gt3"], year: 2005 },
  SuperCup: { classId: "gt3", bases: ["amg-gt3"], year: 2005 },
  SuperTour2: { classId: "classic", bases: ["nissan-r32-jtcc", "bmw-m1-procar"], year: 1995 },
  Supercars: { classId: "road", bases: ["vw-scirocco-gtx", "liana"], year: 2000 },
  RS: { classId: "road", bases: ["vw-scirocco-gtx", "liana"], year: 2005 },
  Preview: { classId: "road", bases: ["vw-scirocco-gtx", "liana"], year: 2010 },
  References: { classId: "road", bases: ["vw-scirocco-gtx", "liana"], year: 2010 },
  "Raid-T1": { classId: "road", bases: ["vw-scirocco-gtx", "liana"], year: 2010 },
  TA50: { classId: "classic", bases: ["porsche-934-rsr", "bmw-m1-procar"], year: 1970 },
  Stock: { classId: "classic", bases: ["porsche-934-rsr", "bmw-m1-procar"], year: 1971 },
  Nascar: { classId: "classic", bases: ["porsche-934-rsr", "bmw-m1-procar"], year: 2005 },
};

/** Every base a mod car can take a physics file on */
export const PHYSICS_BASES = (Object.keys(VEHICLE_MODELS) as VehicleModelId[]).filter((v) => VEHICLE_MODELS[v].simProfile);

const peakPowerKw = (torque: [number, number][]) => Math.max(0, ...torque.map(([rpm, nm]) => (nm * rpm * Math.PI) / 30 / 1000));
const basePeakKw = (b: CarSimProfile) => Math.max(...(b.config.engine.powerCurve as [number, number][]).map(([, kw]) => kw));

/**
 * The closest base for the car: among its category's bases (all of them, for an unknown category), the one nearest in
 * mass, power to weight and weight split, that can drive the same wheels (a front-driven car needs a base that names
 * its driven axle, four-wheel drive one with a centre coupling)
 */
export function chooseBase(car: SdCar, want?: VehicleModelId): { base: VehicleModelId; classId: ModCarClass; year: number; reason: string } {
  const cat = CATEGORY_CLASS[car.category];
  const candidates = want ? [want] : (cat?.bases ?? PHYSICS_BASES);
  const kw = peakPowerKw(car.engine.torque);
  const score = (id: VehicleModelId) => {
    const b = VEHICLE_MODELS[id].simProfile!;
    const c = b.config;
    let s = Math.abs(Math.log(car.massKg / c.chassis.totalMassKg)) + Math.abs(Math.log(kw / car.massKg / (basePeakKw(b) / c.chassis.totalMassKg)));
    s += 2 * Math.abs(car.frontWeight - c.chassis.frontWeightFraction);
    if (car.drive === "FWD" && c.drivenAxle === undefined) s += 10;
    if (car.drive === "4WD" && !c.awd) s += 3;
    return s;
  };
  const ranked = [...candidates].sort((a, b) => score(a) - score(b));
  const base = ranked[0];
  const classId = cat?.classId ?? VEHICLE_MODELS[base].classId;
  const why = want
    ? `chosen with --base`
    : cat
      ? `its category ${car.category} is ${classId} (${cat.bases.join(" or ")}); nearest in mass, power and weight split`
      : `category ${car.category || "(none)"} unknown: nearest of every base in mass, power and weight split`;
  return { base, classId, year: cat?.year ?? 2010, reason: why };
}

// ---------------------------------------------------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------------------------------------------------

export interface MappingRow {
  /** The XML's section/key (or what it is derived from) */
  from: string;
  /** The profile path */
  to: string;
  value: string;
}

export interface SdPhysics {
  car: SdCar;
  base: VehicleModelId;
  classId: ModCarClass;
  year: number;
  reason: string;
  /** `profile` of the physics file */
  patch: Record<string, unknown>;
  rows: MappingRow[];
  /** What the patch leaves at the base's value, and why */
  leftOut: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at a dotted path of an object (list items by index), or undefined */
function at(obj: unknown, path: string): unknown {
  let o: unknown = obj;
  for (const k of path.split(".")) {
    if (Array.isArray(o)) o = o[Number(k)];
    else if (isRecord(o)) o = o[k];
    else return undefined;
  }
  return o;
}

const fmt = (v: unknown): string => {
  if (typeof v === "number") return String(Number(v.toPrecision(5)));
  if (Array.isArray(v) && v.length > 6) return `[${v.length} points]`;
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Number(x.toPrecision(5)) : x));
};

/** Top-level profile values a patch may set though the base leaves them out (mods/mod-physics.ts) */
const OPTIONAL_PROFILE_KEYS = new Set(["understeerRadPerMs2", "fuelFlowKgS", "fuelLPerS1000Rpm", "steerRatio", "setupPressureRefC", "aiMaxKerbRiseM"]);

/** Builds a patch over a base profile, setting only what the base has */
class PatchBuilder {
  readonly patch: Record<string, unknown> = {};
  readonly rows: MappingRow[] = [];
  readonly leftOut: string[] = [];
  constructor(readonly base: CarSimProfile) {}

  has(path: string): boolean {
    return at(this.base, path) !== undefined;
  }

  /**
   * Sets `path` (dotted, from the profile's top) when the base has it, or it is one of the profile's optional values a
   * patch may add (mods/mod-physics.ts: `fuelLPerS1000Rpm`, `steerRatio`…); otherwise notes it
   */
  set(path: string, value: unknown, from: string, why = "the base has no such value"): boolean {
    if (!this.has(path) && !OPTIONAL_PROFILE_KEYS.has(path)) {
      this.leftOut.push(`${from} → ${path}: ${why}`);
      return false;
    }
    const keys = path.split(".");
    let o: Record<string, unknown> = this.patch;
    let b: unknown = this.base;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      b = isRecord(b) ? b[k] : undefined;
      if (!isRecord(o[k])) o[k] = {};
      o = o[k] as Record<string, unknown>;
    }
    o[keys[keys.length - 1]] = value;
    this.rows.push({ from, to: path, value: fmt(value) });
    return true;
  }
}

/** Points of a function on [a, b], rising */
const sample = (a: number, b: number, n: number, f: (x: number) => number): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const x = a + ((b - a) * i) / (n - 1);
    return [Number(x.toPrecision(6)), Number(f(x).toPrecision(6))] as [number, number];
  });

/**
 * The car's physics as a patch on its base. The aero is set to the base's shape, scaled by `aeroScale` (aero-fit.ts
 * finds the scales that give Speed Dreams' forces): front and rear elements, and the body's drag
 */
export function sdCarPhysics(params: SdParams, opts: { base?: VehicleModelId } = {}): SdPhysics {
  const car = readSdCar(params);
  const problems = sdCarProblems(car);
  if (problems.length) throw new Error(`${car.name || params.file}: its parameters can't be converted: ${problems.join("; ")}`);
  const choice = chooseBase(car, opts.base);
  const base = VEHICLE_MODELS[choice.base].simProfile!;
  const P = new PatchBuilder(base);
  const c = base.config;
  const C = "config";

  // ---- Chassis
  const wb = car.xFront - car.xRear;
  const rhF = car.tyres.front.rideHeight;
  const rhR = car.tyres.rear.rideHeight;
  const cgHeight = car.gcHeight + car.frontWeight * rhF + (1 - car.frontWeight) * rhR;
  P.set(`${C}.chassis.totalMassKg`, car.massKg, "Car/mass");
  P.set(`${C}.chassis.frontWeightFraction`, car.frontWeight, "Car/front-rear weight repartition");
  P.set(`${C}.chassis.wheelbase`, wb, "Front Axle/xpos − Rear Axle/xpos");
  P.set(`${C}.chassis.trackWidthFront`, car.track.front, "Front Left − Front Right Wheel/ypos");
  P.set(`${C}.chassis.trackWidthRear`, car.track.rear, "Rear Left − Rear Right Wheel/ypos");
  P.set(`${C}.chassis.cgHeight`, cgHeight, "Car/GC height + ride heights (weighted by the front share)");
  P.set(`${C}.chassis.inertia`, car.inertia, "Car/mass, mass repartition coefficient, body length/width/height (simuv5's box)");
  if (car.tyres.front.unsprungKg !== undefined) P.set(`${C}.chassis.unsprungMassFront`, Math.max(car.tyres.front.unsprungKg, 5), "Front wheels/mass");
  else P.leftOut.push("unsprung masses: the XML has no wheel mass (Speed Dreams' default is 20 kg); the base's kept");
  if (car.tyres.rear.unsprungKg !== undefined) P.set(`${C}.chassis.unsprungMassRear`, Math.max(car.tyres.rear.unsprungKg, 5), "Rear wheels/mass");
  P.set(`${C}.chassis.wheelInertiaFront`, car.tyres.front.inertia, "Front wheels/inertia + Front Axle/inertia ÷ 2");
  P.set(`${C}.chassis.wheelInertiaRear`, car.tyres.rear.inertia, "Rear wheels/inertia + Rear Axle/inertia ÷ 2");
  P.set(`${C}.chassis.maxRoadWheelDeg`, car.steerLockDeg, "Steer/steer lock");
  // The camber ranges of the garage take the car's own camber
  const widen = (r: [number, number], v: number): [number, number] => [Math.min(r[0], Math.floor(v * 10) / 10), Math.max(r[1], Math.ceil(v * 10) / 10)];
  P.set("frontCamberRange", widen(base.frontCamberRange, car.tyres.front.camberDeg), "Front wheels/camber (the garage's range, to hold it)");
  P.set("rearCamberRange", widen(base.rearCamberRange, car.tyres.rear.camberDeg), "Rear wheels/camber (the garage's range, to hold it)");

  // ---- Engine
  const e = car.engine;
  if (e.torque.length < 2) throw new Error(`${car.name}: its engine has no torque curve (Engine/data points)`);
  const power = e.torque.map(([rpm, nm]) => [Number(rpm.toPrecision(6)), Number(((nm * rpm * Math.PI) / 30 / 1000).toPrecision(6))] as [number, number]);
  P.set(`${C}.engine.powerCurve`, power, "Engine/data points (rpm, Tq): crank power = Tq × ω");
  P.set(`${C}.engine.idleRpm`, e.idleRpm, "Engine/tickover");
  P.set(`${C}.engine.inertia`, e.inertia, "Engine/inertia");
  const maxTq = Math.max(...e.torque.filter(([rpm]) => rpm >= e.idleRpm && rpm <= e.limiterRpm).map(([, nm]) => nm));
  P.set(
    `${C}.engine.coastCurve`,
    sample(0, Math.max(e.limiterRpm, e.idleRpm + 100), 6, (rpm) => (rpm < e.idleRpm ? 0 : e.brakeLinear * (rpm / RAD_S_TO_RPM) + e.brakeCoeff * maxTq)),
    "Engine/brake linear coefficient × ω + brake coefficient × max torque"
  );
  if (e.revLimitFeature) P.set(`${C}.engine.limiterCutS`, 0.1, "Features/realistic rev limiter (a 0.1 s cut)");
  if (c.engine.turbo) {
    // The curve is the engine's steady torque, boost and all: the base's turbo must not delay it
    P.set(`${C}.engine.turbo.spoolUpS`, 0.01, "Engine/data points (the full torque at once: simuv5 has no turbo lag)");
    P.set(`${C}.engine.turbo.spoolDownS`, 0.01, "Engine/data points (the full torque at once: simuv5 has no turbo lag)");
  }
  P.set("turbo", e.turbo, "Engine/turbo (the telemetry's boost; the torque curve already holds it)");
  // Fuel: simuv5 burns 0.75e-7 × power × factor litres a second; here, flow per 1000 rpm at its peak power
  const peak = power.reduce((a, b) => (b[1] > a[1] ? b : a));
  const lps = 0.75e-7 * peak[1] * 1000 * e.fuelFactor;
  if (lps > 0) P.set("fuelLPerS1000Rpm", lps / (peak[0] / 1000), "Engine/fuel cons factor (at peak power)");

  // ---- Gearbox and driveline
  const g = car.gears;
  if (!g.ratios.length) throw new Error(`${car.name}: its gearbox has no forward gears (Gearbox/gears/1…)`);
  P.set(`${C}.gearbox.ratios`, g.ratios, "Gearbox/gears/1…n/ratio");
  P.set(`${C}.gearbox.reverse`, g.reverse, "Gearbox/gears/r/ratio");
  const diffSec = car.drive === "FWD" ? "Front" : car.drive === "4WD" ? "Central" : "Rear";
  P.set(`${C}.gearbox.finalDrive`, car.diff.ratio, `${diffSec} Differential/ratio`);
  P.set(`${C}.gearbox.efficiency`, g.efficiency, "Gearbox/gears/*/efficiency × the differential's efficiency");
  P.set(`${C}.gearbox.shiftTimeS`, g.shiftTimeS, "Gearbox/shift time");
  if (P.has(`${C}.gearbox.downshiftTimeS`)) P.set(`${C}.gearbox.downshiftTimeS`, g.shiftTimeS, "Gearbox/shift time");
  // simuv5's gear change opens the clutch and holds the throttle at 10 % for the shift time
  P.set(`${C}.gearbox.shiftTorqueFraction`, 0, "Gearbox/shift time (no drive through a change)");
  if (base.config.gearSets) {
    P.set(`${C}.gearSets`, [{ ratios: g.ratios, reverse: g.reverse, finalDrive: car.diff.ratio }], "Gearbox/gears (the garage's one gear set)");
  }
  // Shift points: up where the next gear pulls as hard at the same road speed, never past the limiter
  const tq = (rpm: number) => {
    const pts = e.torque;
    if (rpm <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (rpm <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (rpm - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
    return 0;
  };
  const ups: number[] = [];
  for (let i = 0; i + 1 < g.ratios.length; i++) {
    const step = g.ratios[i + 1] / g.ratios[i];
    let best = e.limiterRpm;
    for (let rpm = e.limiterRpm; rpm > e.idleRpm; rpm -= 25) {
      if (tq(rpm) * g.ratios[i] >= tq(rpm * step) * g.ratios[i + 1]) break;
      best = rpm;
    }
    ups.push(best);
  }
  const upshift = Math.min(e.limiterRpm - 150, ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : e.limiterRpm - 150);
  const meanStep = g.ratios.length > 1 ? Math.pow(g.ratios[g.ratios.length - 1] / g.ratios[0], 1 / (g.ratios.length - 1)) : 0.7;
  const scaleRpm = (v: number) => (v / c.gearbox.gears.redline_rpm) * e.limiterRpm;
  P.set(`${C}.gearbox.gears.redline_rpm`, e.limiterRpm, "Engine/revs limiter");
  P.set(`${C}.gearbox.gears.upshift_rpm`, upshift, "Engine/data points, Gearbox/gears (where the next gear pulls harder)");
  P.set(`${C}.gearbox.gears.downshift_rpm`, Math.max(e.idleRpm + 300, upshift * meanStep - 300), "the up-shift point × the mean gear step");
  if (c.gearbox.gears.brake_downshift_rpm !== undefined) {
    P.set(`${C}.gearbox.gears.brake_downshift_rpm`, Math.min(e.limiterRpm - 300, scaleRpm(c.gearbox.gears.brake_downshift_rpm)), "Engine/revs limiter (the base's share of it)");
  }
  // The clutch bites where the base's does, as a share of the limiter
  P.set(`${C}.clutch.biteRpm`, Math.max(e.idleRpm + 100, scaleRpm(c.clutch.biteRpm)), "Engine/revs limiter, tickover (the base's bite as a share)");
  P.set(`${C}.clutch.lockRpm`, Math.max(e.idleRpm + 600, scaleRpm(c.clutch.lockRpm)), "Engine/revs limiter, tickover (the base's lock as a share)");
  if (c.clutch.launchRpm !== undefined) P.set(`${C}.clutch.launchRpm`, scaleRpm(c.clutch.launchRpm), "Engine/revs limiter (the base's launch as a share)");
  // The clutch holds the engine's torque, with a margin
  if (c.clutch.maxTorqueNm < 1.2 * maxTq) P.set(`${C}.clutch.maxTorqueNm`, 1.5 * maxTq, "Engine/data points (1.5 × its maximum torque)");

  if (car.drive === "FWD") P.set(`${C}.drivenAxle`, "front", "Drivetrain/type FWD", "the base can't drive its front wheels");
  else if (c.drivenAxle !== undefined) P.set(`${C}.drivenAxle`, "rear", `Drivetrain/type ${car.drive}`);
  if (car.drive === "4WD") P.leftOut.push(`Drivetrain/type 4WD: ${c.awd ? "the base's centre coupling kept as it is" : "the base drives one axle; this car drives its rear wheels only"}`);
  // simuv5's limited slip: the lock (at full slip) is `max slip bias` × the input torque, open on the overrun
  const d = car.diff;
  const ramp = c.differential.settings;
  const cotRamp = (deg: number) => 1 / Math.tan((deg * Math.PI) / 180);
  const lockGain = (share: number, rampDeg: number) => share / (ramp.friction_faces * cotRamp(rampDeg));
  let lockPower = 0;
  let lockCoast = 0;
  let preload = 0;
  if (d.type === "SPOOL") {
    preload = 20_000;
  } else if (d.type === "LIMITED SLIP") {
    lockPower = d.maxSlipBias;
  } else if (d.type === "1.5 WAY LSD" || d.type === "ELECTRONIC LSD") {
    lockPower = d.maxSlipBias;
    lockCoast = d.coastSlipBias;
  } else if (d.type === "VISCOUS COUPLER") {
    lockPower = 0.3;
    lockCoast = 0.3;
    P.leftOut.push(`${diffSec} Differential/type VISCOUS COUPLER: as a 30 % ramp lock both ways (no viscous model here)`);
  } else if (d.type !== "FREE") {
    P.leftOut.push(`${diffSec} Differential/type ${d.type}: Speed Dreams drives nothing through it; an open differential here`);
  }
  P.set(`${C}.differential.settings.power`, Math.min(1, lockGain(lockPower, ramp.power_ramp_deg)), `${diffSec} Differential/type ${d.type}, max slip bias`);
  P.set(`${C}.differential.settings.coast`, Math.min(1, lockGain(lockCoast, ramp.coast_ramp_deg)), `${diffSec} Differential/type ${d.type}, coast max slip bias`);
  P.set(`${C}.differential.settings.preload`, preload, `${diffSec} Differential/type ${d.type}`);

  // ---- Brakes: per wheel at full pedal; the profile's torque is a front and a rear wheel's together
  const bf = car.brakes.frontWheelNm;
  const br = car.brakes.rearWheelNm;
  P.set(`${C}.brakes.maxTorqueNm`, bf + br, "Brake System/max pressure × (disk diameter / 2 × piston area × mu) of a front and a rear wheel");
  P.set(`${C}.brakes.front_bias`, Math.min(0.8, Math.max(0.3, bf / (bf + br))), "Brake System/front-rear brake repartition and the discs (front wheel's share)");

  // ---- Tyres
  const tF = car.tyres.front;
  const tR = car.tyres.rear;
  const curveF = sdTyreCurve(tF);
  const curveR = sdTyreCurve(tR);
  const slotMu = (t: SdTyre, slot: string): number => {
    if (!car.compounds) return t.mu[""];
    const name = slot === "soft" ? "soft" : slot === "medium" ? "medium" : slot === "hard" ? "hard" : slot === "intermediate" ? "wet" : "extrem wet";
    return t.mu[name] ?? t.mu[COMPOUND_NAMES[car.compoundSet - 1] ?? "medium"] ?? t.mu[""];
  };
  const defaultName = COMPOUND_NAMES[car.compoundSet - 1] ?? "extrem wet";
  const muCurve = (t: SdTyre, mu: number): [number, number][] => sample(0, 3 * t.operatingLoadN, 13, (fz) => sdTyreMu(t, mu, fz));
  const slots = Object.entries(c.compoundSlots) as [string, string][];
  const bySlot = new Map<string, string>();
  for (const [slot, compound] of slots) if (!bySlot.has(compound)) bySlot.set(compound, slot);
  const allSame = new Set(slots.map(([, comp]) => comp)).size === 1;
  for (const [compound, slot] of bySlot) {
    const path = `${C}.tyreCompounds.${compound}`;
    const pick = allSame ? (car.compounds ? defaultName : "") : slot;
    const muF = allSame ? (tF.mu[pick] ?? tF.mu[""]) : slotMu(tF, slot);
    const muR = allSame ? (tR.mu[pick] ?? tR.mu[""]) : slotMu(tR, slot);
    const src = car.compounds ? `Wheels/Compounds/${allSame ? pick : slot === "intermediate" ? "wet" : slot === "wet" ? "extrem wet" : slot}/mu` : "Wheels/mu";
    P.set(`${path}.front`, { width: tF.width, radius: tF.radius, rimRadius: tF.rimRadius }, "Front wheels/rim diameter, tire width, tire height-width ratio");
    P.set(`${path}.rear`, { width: tR.width, radius: tR.radius, rimRadius: tR.rimRadius }, "Rear wheels/rim diameter, tire width, tire height-width ratio");
    const md = `${path}.modelData`;
    const front = muCurve(tF, muF);
    if (P.has(`${md}.dyCurve`)) {
      P.set(`${md}.dyCurve`, front, `${src} × load factor (operating load, load factor min/max)`);
      if (P.has(`${md}.dxCurve`)) P.set(`${md}.dxCurve`, front, `${src} × load factor (the same both ways in Speed Dreams)`);
    } else {
      // No table on this base: its power law fitted through Speed Dreams' μ at Fz0 and at 2 Fz0
      const fz0 = at(base, `${md}.Fz0`) as number;
      const m1 = sdTyreMu(tF, muF, fz0);
      const m2 = sdTyreMu(tF, muF, 2 * fz0);
      const exp = 1 + Math.log(m2 / m1) / Math.log(2);
      P.set(`${md}.Dy0`, m1, `${src} × load factor at the base's Fz0`);
      P.set(`${md}.Dx0`, m1, `${src} × load factor at the base's Fz0`);
      P.set(`${md}.lsExpY`, exp, "Wheels/load factor min/max, operating load (the load law's slope)");
      P.set(`${md}.lsExpX`, exp, "Wheels/load factor min/max, operating load (the load law's slope)");
    }
    const alphaF = (Math.asin(Math.min(0.9, curveF.peakSlip)) * 180) / Math.PI;
    P.set(`${md}.friction_limit_angle`, alphaF, "Front wheels/stiffness, dynamic friction, elasticity factor (the magic formula's peak)");
    P.set(`${md}.slip_ratio_limit`, curveF.peakSlip, "Front wheels/stiffness, dynamic friction, elasticity factor (the same peak slip both ways)");
    if (P.has(`${md}.longStiffnessMult`)) P.set(`${md}.longStiffnessMult`, Math.tan((alphaF * Math.PI) / 180) / curveF.peakSlip, "the same peak slip both ways");
    if (P.has(`${md}.peakSlipLoadGain`)) P.set(`${md}.peakSlipLoadGain`, 0, "Speed Dreams' peak slip doesn't move with load");
    P.set(`${md}.use_slip_falloff`, true, "Front wheels/dynamic friction");
    P.set(`${md}.falloff_level`, tF.dynamicFriction, "Front wheels/dynamic friction (the sliding force over the peak)");
    // The decay to that level: through Speed Dreams' curve at twice the peak slip
    const tanPeak = Math.tan((alphaF * Math.PI) / 180);
    const f2 = curveF.at(2 * curveF.peakSlip);
    const level = tF.dynamicFriction;
    const slope = f2 > level + 1e-3 && f2 < 1 ? ((1 - level) / (f2 - level) - 1) / tanPeak : 50;
    P.set(`${md}.falloff_slope`, slope, "Front wheels/stiffness, dynamic friction, elasticity factor (the curve at twice the peak)");
    if (P.has(`${md}.curveFullness`)) {
      // The rising branch's slope at the origin: Speed Dreams' `stiffness` per unit of slip
      P.set(`${md}.curveFullness`, Math.max(0, Math.min(1, (tF.stiffness * tanPeak) / 3 - 1)), "Front wheels/stiffness (the slope at no slip)");
    }
    // The rear, where the base keeps its own
    const ro = `${path}.rearOverride.modelData`;
    const rearCurve = muCurve(tR, muR);
    if (P.has(`${ro}.dyCurve`)) P.set(`${ro}.dyCurve`, rearCurve, `${src} (rear) × load factor`);
    if (P.has(`${ro}.dxCurve`)) P.set(`${ro}.dxCurve`, rearCurve, `${src} (rear) × load factor`);
    if (P.has(`${ro}.friction_limit_angle`)) P.set(`${ro}.friction_limit_angle`, (Math.asin(Math.min(0.9, curveR.peakSlip)) * 180) / Math.PI, "Rear wheels/stiffness, dynamic friction, elasticity factor");
    if (P.has(`${ro}.falloff_level`)) P.set(`${ro}.falloff_level`, tR.dynamicFriction, "Rear wheels/dynamic friction");
    if (P.has(`${ro}.peakSlipLoadGain`)) P.set(`${ro}.peakSlipLoadGain`, 0, "Speed Dreams' peak slip doesn't move with load");
    if (P.has(`${ro}.slip_ratio_limit`)) P.set(`${ro}.slip_ratio_limit`, curveR.peakSlip, "Rear wheels/stiffness, dynamic friction, elasticity factor");
    if (P.has(`${ro}.longStiffnessMult`)) P.set(`${ro}.longStiffnessMult`, Math.tan(Math.asin(Math.min(0.9, curveR.peakSlip))) / curveR.peakSlip, "the same peak slip both ways");
  }
  const muDiff = Math.abs(sdTyreMu(tR, tR.mu[""], tR.operatingLoadN) / sdTyreMu(tF, tF.mu[""], tF.operatingLoadN) - 1);
  if (muDiff > 0.03 && !P.has(`${C}.tyreCompounds.${slots[0][1]}.rearOverride.modelData.dyCurve`)) {
    P.leftOut.push(`Rear wheels' own grip (${(muDiff * 100).toFixed(0)} % from the front's): the base shares one grip curve between its axles`);
  }

  // ---- Suspension: rates at the wheel
  for (const [axle, s, t] of [["front", car.suspension.front, tF], ["rear", car.suspension.rear, tR]] as const) {
    const A = axle === "front" ? "Front" : "Rear";
    const b2 = s.bellcrank * s.bellcrank;
    const sp = `${C}.suspensions.${axle}`;
    P.set(`${sp}.springs.wheel_rate`, s.spring * b2, `${A} suspensions/spring × bellcrank² (Speed Dreams' N/m)`);
    if (P.has(`${sp}.springs.helper_rate`)) P.set(`${sp}.springs.helper_rate`, 0, `${A} suspensions (no helper spring)`);
    P.set(`${sp}.arb`, s.arb * s.bellcrank, `${A} Anti-Roll Bar/spring × the suspension's bellcrank`);
    P.set(`${sp}.staticCamber`, t.camberDeg, `${A} wheels/camber`);
    P.set(`${sp}.bumpStop.range`, Math.max(0.005, t.rideHeight - s.packers), `${A} wheels/ride height − ${A} suspensions/packers`);
    const hard = at(base, `${sp}.bumpStop.hardStop`) as { range: number } | undefined;
    const baseRange = at(base, `${sp}.bumpStop.range`) as number;
    if (hard) P.set(`${sp}.bumpStop.hardStop.range`, Math.max(0.006, t.rideHeight - s.packers) + Math.max(0, hard.range - baseRange), `${A} wheels/ride height (the base's second stop as far beyond)`);
    P.set(`${sp}.droopTravel`, Math.max(0.01, s.course - t.rideHeight), `${A} suspensions/suspension course − ride height`);
    if (Math.abs(t.toeDeg) > 0.01) P.leftOut.push(`${A} wheels/toe ${t.toeDeg.toFixed(2)}°: Speed Dreams turns both wheels the same way (a steering offset), not a toe`);
    const dc = `${C}.suspensions.dampers_controller.${axle}`;
    P.set(`${dc}.base`, { slow_bump: s.slowBump * b2, slow_rebound: s.slowRebound * b2, fast_bump: s.fastBump * b2, fast_rebound: s.fastRebound * b2 }, `${A} suspensions/slow & fast bump & rebound × bellcrank²`);
    P.set(`${dc}.fastThresholdMs`, s.bumpKnee / s.bellcrank, `${A} suspensions/bump limit velocity ÷ bellcrank`);
    if (P.has(`${dc}.fastReboundThresholdMs`)) P.set(`${dc}.fastReboundThresholdMs`, s.reboundKnee / s.bellcrank, `${A} suspensions/rebound limit velocity ÷ bellcrank`);
    const zero = { slow_bump: 0, slow_rebound: 0, fast_bump: 0, fast_rebound: 0 };
    for (const mode of ["heave", "roll", "pitch"] as const) P.set(`${dc}.${mode}`, zero, `(Speed Dreams' dampers are the corners' only: no ${mode} damper)`);
  }
  if (params.has("Front Heave Spring", "spring") && (params.num("Front Heave Spring", "spring") ?? 0) > 0) P.leftOut.push("Front Heave Spring: the base's heave element kept");
  if (params.has("Rear Heave Spring", "spring") && (params.num("Rear Heave Spring", "spring") ?? 0) > 0) P.leftOut.push("Rear Heave Spring: the base's heave element kept");

  // ---- Ride heights and the floor: the reference plane is `GC height` under the CG
  P.set(`${C}.aero.front_target_height`, rhF, "Front wheels/ride height");
  P.set(`${C}.aero.rear_target_height`, rhR, "Rear wheels/ride height");
  const floorShift = -car.gcHeight - c.aero.floorOffsetY;
  P.set(`${C}.aero.floorOffsetY`, -car.gcHeight, "Car/GC height (the floor is the reference plane)");
  if (c.aero.plank) P.set(`${C}.aero.plank.y`, c.aero.plank.y + floorShift, "Car/GC height (the plank moves with the floor)");
  if (c.aero.rhMap) {
    P.set(`${C}.aero.rhMap.frontPickupY`, c.aero.rhMap.frontPickupY + floorShift, "Car/GC height (the pickups move with the floor)");
    P.set(`${C}.aero.rhMap.rearPickupY`, c.aero.rhMap.rearPickupY + floorShift, "Car/GC height (the pickups move with the floor)");
    // No straight-line mode on a Speed Dreams car
    P.set(`${C}.aero.rhMap.activeAero`, { dClAFront: 0, dClARear: 0, dCdA: 0 }, "(no active aero in Speed Dreams)");
  }

  // ---- Hybrid and DRS: Speed Dreams' cars have neither
  if (base.hasErs) {
    P.set("hasErs", false, "(no hybrid in Speed Dreams)");
    P.set(`${C}.ers.ERS_MAX_DEPLOY`, 0, "(no hybrid in Speed Dreams)");
    P.set(`${C}.ers.maxHarvestW`, 0, "(no hybrid in Speed Dreams)");
    P.set(`${C}.ers.ERS_MAX_CHARGE`, 1, "(no hybrid in Speed Dreams: an empty store)");
    P.set(`${C}.ers.topGearLiftHarvestW`, 0, "(no hybrid in Speed Dreams)");
  }
  if (base.hasDrs) P.set("hasDrs", false, "(no DRS in Speed Dreams)");

  // ---- The driver aids and the AI's grip, scaled with the tyres' grip at the static loads
  const muAt = (t: SdTyre, mu: number, share: number) => sdTyreMu(t, mu, (car.massKg * G * share) / 2);
  const sdMu = (muAt(tF, slotMu(tF, "medium"), car.frontWeight) + muAt(tR, slotMu(tR, "medium"), 1 - car.frontWeight)) / 2;
  const medium = c.tyreCompounds[c.compoundSlots.medium]!;
  const baseLoad = (c.chassis.totalMassKg * G) / 4;
  const baseMu = medium.modelData.dyCurve ? interp(medium.modelData.dyCurve as [number, number][], baseLoad) : medium.modelData.Dy0 * Math.pow(baseLoad / medium.modelData.Fz0, medium.modelData.lsExpY - 1);
  const gripRatio = sdMu / baseMu;
  P.set("padLateralMu", base.padLateralMu * gripRatio, `Wheels/mu at the static loads (${sdMu.toFixed(2)} against the base's ${baseMu.toFixed(2)})`);
  P.set("braking.lowG", base.braking.lowG * gripRatio, "Wheels/mu at the static loads (the braking guide's grip)");

  return { car, base: choice.base, classId: choice.classId, year: choice.year, reason: choice.reason, patch: P.patch, rows: P.rows, leftOut: P.leftOut };
}

function interp(pts: [number, number][], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (x - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
  return pts[pts.length - 1][1];
}

/** The keys Speed Dreams' simulation reads that this conversion does not carry */
export const SD_KEYS_NOT_CARRIED = [
  "Wheels/pressure, temperatures, hysteresis, wear, cooling factors: Speed Dreams' own heat and wear model; the base's tyre heat, wear and pressure model is kept",
  "Wheels/camber's grip term (1 + 0.05 sin(−18 × camber)): the base's camber model applies",
  "Brakes/inertia, Clutch/inertia, Drivetrain/inertia: unused or lost in simuv5",
  "Engine/turbo rpm, turbo factor, turbo lag, capacity, cylinders: unused by simuv5 (the sound's turbo only)",
  "Front & Rear Axle/roll center height: unused by simuv5 (its roll centre is the ground); the base's suspension geometry is kept",
  "Car/fuel tank, initial fuel: the base's fuel model and tank",
  "Features/enable abs, enable tcl, enable esp: the base's driver aids",
];
