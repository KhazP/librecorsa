/**
 * An Assetto Corsa car's physics as a mod physics patch (src/lib/mods/mod-physics.ts): the values of a base vehicle
 * model's profile that the car's data states, converted as mod-physics-import.ts and verify-mod-parity.ts convert them,
 * written as `{ "format": 1, "profile": {…} }`. The base is chosen from the car's class, tags, year, drivetrain, mass and
 * power (`chooseBaseModel`), or named.
 *
 *   npx tsx scripts/cars/ac-physics-patch.ts <car or data folder> [--base <model>] [--out physics.json] [--drive]
 *
 * Every value is a path in the base's profile and the file and key it came from (`MappedValue`). A value the base has
 * no place for (a turbo's lag on a base without a turbo, a rear tyre value on a base with one tyre for both axles) is
 * listed as unmapped with the reason, and so is one `modSimProfile` refuses; the rest is the patch. What the data does
 * not state (the tyres' heat capacities, the AI's and the HUD's plans, the garage's ranges where setup.ini gives none) is
 * the base's. `--drive` runs the result on a flat pad (`driveCheck`): straight-line acceleration, top speed, braking,
 * and an autopilot lap of RISE when its files are here.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { MOD_PHYSICS_FORMAT, modSimProfile } from '../../src/lib/mods/mod-physics';
import { turboSteadyBoost, type TurboData } from '../../src/lib/sim/f12026-car/F12026CarConfig';
import type { CarSimProfile } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { modBodyHeightM, modCornerStops } from '../../src/lib/sim/mod-suspension';
import type { VehicleModelId } from '../../src/types/f1';
import { lutAt, ModData, type Lut } from '../lib/mod-data';
import { readUiCar, type UiCar } from './ac-car-info';

const G = 9.81;
const RHO = 1.225;

/** One value of the patch: where it goes in the base's profile, what it is, and the data it came from */
export interface MappedValue {
  path: string;
  value: unknown;
  from: string;
}

/** A value of the data the patch doesn't carry, and why */
export interface Unmapped {
  from: string;
  why: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths in a profile: `config.aero.wings[1].area`
// ---------------------------------------------------------------------------------------------------------------------

type Step = string | number;

function steps(path: string): Step[] {
  const out: Step[] = [];
  for (const part of path.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new Error(`bad path ${path}`);
    out.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value at `path`, undefined when a step is missing */
export function valueAt(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const s of steps(path)) {
    if (typeof s === 'number') cur = Array.isArray(cur) ? cur[s] : undefined;
    else cur = isObject(cur) && Object.hasOwn(cur, s) ? cur[s] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Sets `path` in a patch, making the objects and lists on the way (a list's earlier items `{}`: the base's own) */
function setAt(patch: Record<string, unknown>, path: string, value: unknown): void {
  const s = steps(path);
  let cur: Record<string, unknown> | unknown[] = patch;
  for (let i = 0; i < s.length - 1; i++) {
    const key = s[i];
    const next = s[i + 1];
    const container = cur as Record<string | number, unknown>;
    if (container[key] === undefined) container[key] = typeof next === 'number' ? [] : {};
    const child = container[key];
    if (Array.isArray(child) && typeof next === 'number') for (let k = 0; k < next; k++) child[k] ??= {};
    cur = child as Record<string, unknown> | unknown[];
  }
  (cur as Record<string | number, unknown>)[s[s.length - 1]] = value;
}

/** Top-level profile values a patch may set though the base leaves them out (mod-physics.ts OPTIONAL_PROFILE_KEYS) */
const OPTIONAL = new Set(['steerRatio', 'fuelLPerS1000Rpm', 'fuelFlowKgS', 'understeerRadPerMs2', 'setupPressureRefC', 'aiMaxKerbRiseM']);

const finite = (v: unknown): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.length > 0 && v.every(finite) : isObject(v) ? Object.values(v).every(finite) : v !== undefined;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Collects the patch's values against the base: a value the base has no place for is unmapped, with the reason */
class Mapper {
  readonly values: MappedValue[] = [];
  readonly unmapped: Unmapped[] = [];
  constructor(readonly base: CarSimProfile) {}

  has(path: string): boolean {
    return valueAt(this.base, path) !== undefined;
  }

  set(path: string, value: unknown, from: string): boolean {
    if (!finite(value)) {
      this.unmapped.push({ from, why: 'not in the data (or not a number)' });
      return false;
    }
    if (!this.has(path) && !(OPTIONAL.has(path) && !path.includes('.'))) {
      this.unmapped.push({ from, why: `the base model has no ${path}` });
      return false;
    }
    this.put({ path, value: round(value), from });
    return true;
  }

  /** One value per path: a later one replaces it */
  private put(v: MappedValue): void {
    const i = this.values.findIndex((x) => x.path === v.path);
    if (i >= 0) this.values[i] = v;
    else this.values.push(v);
  }

  /** Sets it where the base has it; says nothing otherwise (a value of the base's own make-up, set to match the data) */
  quiet(path: string, value: unknown, from: string): void {
    if (this.has(path) && finite(value)) this.put({ path, value: round(value), from });
  }

  skip(from: string, why: string): void {
    this.unmapped.push({ from, why });
  }
}

/** Numbers to 6 significant figures, as the configs write them */
function round(v: unknown): unknown {
  if (typeof v === 'number') return Number(v.toPrecision(6));
  if (Array.isArray(v)) return v.map(round);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
}

/** A table with its x rising strictly (repeats dropped), as a profile's curves must be */
const rising = (lut: Lut): [number, number][] => {
  const out: [number, number][] = [];
  for (const [x, y] of lut) if (!out.length || x > out[out.length - 1][0]) out.push([x, y]);
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// The car, in a few numbers: what the base model is chosen by
// ---------------------------------------------------------------------------------------------------------------------

export type Traction = 'RWD' | 'FWD' | 'AWD' | 'AWD2';

export interface AcCarFacts {
  name: string;
  className: string;
  tags: string[];
  year?: number;
  traction: Traction;
  massKg: number;
  /** Peak crank power (kW), the full boost included */
  peakKw: number;
  turbo: boolean;
  /** Downforce coefficient × area at the static setup (m², + = downforce) */
  clA: number;
}

/** The car's turbos (engine.ini [TURBO_n]) as the game's turbo law: boost = max · (rpm / reference)^gamma, capped */
function acTurbos(mod: ModData): { turbo: TurboData; section: string }[] {
  return mod
    .sections('engine.ini')
    .filter((s) => /^TURBO_\d+$/.test(s))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((s) => {
      const t = (k: string) => mod.num('engine.ini', s, k);
      const wastegate = t('WASTEGATE');
      const maxBoost = Math.min(t('MAX_BOOST'), Number.isFinite(wastegate) && wastegate > 0 ? wastegate : Infinity);
      const lag = (k: string) => 1 / ((1 - t(k)) * 444);
      return {
        section: s,
        turbo: {
          maxBoost,
          referenceRpm: t('REFERENCE_RPM'),
          gamma: t('GAMMA'),
          spoolUpS: lag('LAG_UP'),
          spoolRefRpm: t('REFERENCE_RPM'),
          spoolDownS: lag('LAG_DN'),
          displayMaxBoostBar: t('DISPLAY_MAX_BOOST') || maxBoost,
        },
      };
    })
    .filter((x) => x.turbo.maxBoost > 0 && Number.isFinite(x.turbo.referenceRpm));
}

/** Full-throttle boost of all the car's turbos together at `rpm` (AC adds them) */
const acBoost = (turbos: { turbo: TurboData }[], rpm: number): number => turbos.reduce((b, t) => b + turboSteadyBoost(t.turbo, rpm), 0);

/** The car's default tyre compound: its tyres.ini section suffix ('' for FRONT / REAR, `_n` for FRONT_n) */
function defaultCompound(mod: ModData): string {
  const i = mod.num('tyres.ini', 'COMPOUND_DEFAULT', 'INDEX');
  return Number.isFinite(i) && i > 0 && mod.sections('tyres.ini').includes(`FRONT_${i}`) ? `_${i}` : '';
}

/** An aero element of aero.ini at the car's static ride: its CL·A and CD·A at its set angle and its height off the road */
interface AeroElement {
  section: string;
  name: string;
  area: number;
  /** [x, y above the CG, z ahead of it] */
  position: number[];
  angle: number;
  cl: Lut;
  cd: Lut;
  ghCl: Lut;
  ghCd: Lut;
  yawClGain: number;
  /** At the static setup */
  clA: number;
  cdA: number;
}

/**
 * Static ride: the CG's height and the body's height at each axle, on the first compound's tyres (mod-physics-import's
 * and the parity suite's rule, so a car's own data gives its config's heights back)
 */
function staticRide(mod: ModData) {
  const sus = (s: string, k: string) => mod.num('suspensions.ini', s, k);
  const c = '';
  const mass = mod.num('car.ini', 'BASIC', 'TOTALMASS');
  const front = sus('BASIC', 'CG_LOCATION');
  const sprungKg = mass - 2 * sus('FRONT', 'HUB_MASS') - 2 * sus('REAR', 'HUB_MASS');
  const axle = (name: 'FRONT' | 'REAR') => {
    const share = name === 'FRONT' ? front : 1 - front;
    const heave = `HEAVE_${name}`;
    const staticLoadN = (sprungKg * G * share) / 2;
    const stops = modCornerStops({
      staticLoadN,
      springRate: sus(name, 'SPRING_RATE'),
      rodLength: sus(name, 'ROD_LENGTH'),
      packerRange: sus(name, 'PACKER_RANGE'),
      bumpStopUp: sus(name, 'BUMPSTOP_UP'),
      bumpStopDn: sus(name, 'BUMPSTOP_DN'),
      heave: Number.isFinite(sus(heave, 'SPRING_RATE'))
        ? { springRate: sus(heave, 'SPRING_RATE'), rodLength: sus(heave, 'ROD_LENGTH'), packerRange: sus(heave, 'PACKER_RANGE'), bumpStopUp: sus(heave, 'BUMPSTOP_UP') }
        : undefined,
    });
    const t = (k: string) => mod.num('tyres.ini', `${name}${c}`, k);
    const rate = t('RATE') + (t('PRESSURE_SPRING_GAIN') || 0) * ((t('PRESSURE_IDEAL') || t('PRESSURE_STATIC')) - t('PRESSURE_STATIC'));
    const cornerN = staticLoadN + sus(name, 'HUB_MASS') * G;
    return { stops, staticLoadN, bodyHeight: modBodyHeightM(t('RADIUS'), cornerN / rate, sus(name, 'BASEY'), stops.staticOffsetM) };
  };
  const f = axle('FRONT');
  const r = axle('REAR');
  const wheelbase = sus('BASIC', 'WHEELBASE');
  return {
    front: f,
    rear: r,
    cgHeight: f.bodyHeight + (r.bodyHeight - f.bodyHeight) * (1 - front),
    /** CG to the front and rear axles (m) */
    a: wheelbase * (1 - front),
    b: wheelbase * front,
    wheelbase,
  };
}

function aeroElements(mod: ModData): AeroElement[] {
  const ride = staticRide(mod);
  return mod
    .sections('aero.ini')
    .filter((s) => /^WING_\d+$/.test(s))
    .map((s) => {
      const n = (k: string) => mod.num('aero.ini', s, k);
      const position = mod.vec('aero.ini', s, 'POSITION');
      const scale = (lut: Lut, k: number): Lut => lut.map(([x, y]) => [x, y * (Number.isFinite(k) ? k : 1)]);
      const cl = scale(mod.lutOf('aero.ini', s, 'LUT_AOA_CL'), n('CL_GAIN'));
      const cd = scale(mod.lutOf('aero.ini', s, 'LUT_AOA_CD'), n('CD_GAIN'));
      const ghCl = mod.lutOf('aero.ini', s, 'LUT_GH_CL');
      const ghCd = mod.lutOf('aero.ini', s, 'LUT_GH_CD');
      const area = n('CHORD') * n('SPAN');
      const angle = n('ANGLE') || 0;
      // The element's height off the road at static ride: the body's height under it, plus its own above the CG
      const z = position[2] ?? 0;
      const share = Math.min(1, Math.max(0, (z + ride.b) / ride.wheelbase));
      const h = ride.rear.bodyHeight + (ride.front.bodyHeight - ride.rear.bodyHeight) * share + (position[1] ?? 0);
      const gh = (lut: Lut) => (lut.length ? lutAt(lut, h) : 1);
      return {
        section: s,
        name: mod.text('aero.ini', s, 'NAME') ?? s,
        area,
        position,
        angle,
        cl,
        cd,
        ghCl,
        ghCd,
        yawClGain: n('YAW_CL_GAIN') || 0,
        clA: cl.length ? area * lutAt(cl, angle) * gh(ghCl) : 0,
        cdA: cd.length ? area * lutAt(cd, angle) * gh(ghCd) : 0,
      };
    })
    .filter((e) => Number.isFinite(e.area) && e.area > 0);
}

export function acCarFacts(mod: ModData, ui: UiCar): AcCarFacts {
  const turbos = acTurbos(mod);
  const torque = rising(mod.lut('power.lut'));
  const limiter = mod.num('engine.ini', 'ENGINE_DATA', 'LIMITER') || Infinity;
  let peakKw = 0;
  for (const [rpm, nm] of torque) if (rpm > 0 && rpm <= limiter) peakKw = Math.max(peakKw, (nm * (1 + acBoost(turbos, rpm)) * rpm * Math.PI) / 30 / 1000 / 0.9);
  const traction = (mod.text('drivetrain.ini', 'TRACTION', 'TYPE') ?? 'RWD').toUpperCase();
  return {
    name: ui.name ?? '',
    className: ui.class ?? '',
    tags: ui.tags.map((t) => t.toLowerCase()),
    year: ui.year,
    traction: (['RWD', 'FWD', 'AWD', 'AWD2'].includes(traction) ? traction : 'RWD') as Traction,
    massKg: mod.num('car.ini', 'BASIC', 'TOTALMASS'),
    peakKw,
    turbo: turbos.length > 0,
    clA: aeroElements(mod).reduce((s, e) => s + e.clA, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The base model
// ---------------------------------------------------------------------------------------------------------------------

/** The vehicle models a car can be based on: every one with a profile the patch can change */
export const BASE_MODELS = (Object.keys(VEHICLE_MODELS) as VehicleModelId[]).filter((id) => VEHICLE_MODELS[id].simProfile);

const OPEN_WHEEL = /\bformula\b|\bf[1-4]\b|open.?wheel|single.?seater|\bindy|monoposto|\bfsae\b|\bf3000\b|\bfa1\b/;
const PROTOTYPE = /\blmp\d?\b|\blmdh\b|\blmh\b|hypercar|prototype|group ?c\b|\bgtp\b|can.?am|\bdpi\b|sports.?racer|\bp[1-4]\b/;
const MODERN_GT = /\bgt3\b|\bgt-3\b|\bgtd\b|\bgte\b|\bgtlm\b|\bgt2\b|\bgt4\b|lmgt3|\bgt300\b|\bgt500\b|super ?gt|\bdtm\b|\bgt1\b|\bjgtc\b/;
const CLASSIC = /vintage|classic|historic|retro|group ?[245b]\b|\bdrm\b|\bimsa\b|touring|\bjtcc\b|\bbtcc\b|\bdtm\b/;
const ROAD = /\bstreet\b|\broad\b|\bstock\b|\bhatch|\bsaloon\b|\bsedan\b|\bcoupe\b|\bdaily\b/;

/** Power to weight (W/kg) */
const ptw = (id: VehicleModelId): number => {
  const c = VEHICLE_MODELS[id].simProfile!.config;
  return (Math.max(...c.engine.powerCurve.map(([, kw]) => kw)) * 1000) / c.chassis.totalMassKg;
};

/**
 * The base model for a car, and why: open-wheelers on the 2026 F1 car; prototypes on the LMDh or the 496R, whichever's
 * power to weight is nearer; a modern GT (GT3, GTE, GT1…) on the AMG GT3, a 1990s one (JGTC, GT500 before 2000) on the
 * R33 JGTC; a four-wheel-drive car on the R32 (the one base with a centre coupling); a front-driven one on the Liana or
 * the Scirocco, by power (the bases that can drive their front wheels); classic racers on the 934 (turbo) or the M1
 * (atmospheric); road cars on the Liana or the Scirocco, by power; any other race car on the GT3, or the 496R when it
 * makes real downforce for its weight
 */
export function chooseBaseModel(f: AcCarFacts): { base: VehicleModelId; why: string } {
  const words = [f.className, ...f.tags, f.name].join(' ').toLowerCase();
  const nearer = (a: VehicleModelId, b: VehicleModelId) => {
    const own = (f.peakKw * 1000) / f.massKg;
    return Math.abs(ptw(a) - own) <= Math.abs(ptw(b) - own) ? a : b;
  };
  const awd = f.traction === 'AWD' || f.traction === 'AWD2';
  const classic = CLASSIC.test(words) || (f.year !== undefined && f.year < 2000);
  if (OPEN_WHEEL.test(words)) return { base: 'f12026-car', why: 'an open-wheeler (its class, tags or name)' };
  if (PROTOTYPE.test(words)) {
    const base = nearer('lc-lmdh', 'mtr-496r');
    return { base, why: `a prototype (its class, tags or name), nearer the ${base === 'lc-lmdh' ? 'LMDh' : '496R'} in power to weight` };
  }
  if (awd) return { base: 'nissan-r32-jtcc', why: `four-wheel drive (${f.traction}): the R32 is the one base with a centre coupling` };
  // The front-driven bases are the two with the switch for it: any other drives its rear wheels
  if (f.traction === 'FWD') {
    const base: VehicleModelId = f.peakKw < 95 ? 'liana' : 'vw-scirocco-gtx';
    return { base, why: `front-wheel drive, ${Math.round(f.peakKw)} kW: the front-driven bases are the Liana and the Scirocco` };
  }
  if (MODERN_GT.test(words)) {
    if ((f.year !== undefined && f.year < 2000) || /\bjgtc\b|vintage|classic|historic/.test(words)) return { base: 'nissan-r33-jgtc', why: 'a 1990s GT racer (JGTC, GT500, GT1 before 2000)' };
    return { base: 'amg-gt3', why: 'a modern GT racer (GT3, GTE, GT2, GT4, GT500, DTM)' };
  }
  const race = /\brace\b|\bracing\b|\brace ?car\b|\bcup\b|\bmotorsport\b/.test(words) || f.clA > 0.4;
  if (classic && (race || !ROAD.test(words))) {
    if (f.turbo) return { base: 'porsche-934-rsr', why: 'a classic racer with a turbo' };
    return { base: 'bmw-m1-procar', why: 'an atmospheric classic racer' };
  }
  if (!race || ROAD.test(words)) {
    const base: VehicleModelId = f.peakKw < 95 ? 'liana' : 'vw-scirocco-gtx';
    return { base, why: `a road car of ${Math.round(f.peakKw)} kW` };
  }
  if (f.clA / Math.max(1, f.massKg) > 0.0015) return { base: 'mtr-496r', why: 'a modern race car with real downforce for its weight' };
  return { base: 'amg-gt3', why: 'a modern race car' };
}

// ---------------------------------------------------------------------------------------------------------------------
// The values
// ---------------------------------------------------------------------------------------------------------------------

const HARDPOINT_KEYS = ['WBCAR_TOP_FRONT', 'WBCAR_TOP_REAR', 'WBCAR_BOTTOM_FRONT', 'WBCAR_BOTTOM_REAR', 'WBTYRE_TOP', 'WBTYRE_BOTTOM', 'WBCAR_STEER', 'WBTYRE_STEER'];
const RIGID_STOP_RATE = 500_000;
const NO_DAMPER = { slow_bump: 0, fast_bump: 0, slow_rebound: 0, fast_rebound: 0 };
const FLAT: Lut = [
  [0, 1],
  [1, 1],
];

/** AC's YAW_CL_GAIN as the configs' table: CL × (1 + gain · |yaw| in radians) */
const yawTable = (gain: number): Lut => [0, 2, 5, 10, 20, 30].map((deg) => [deg, Math.max(0, 1 + (gain * deg * Math.PI) / 180)]);

/** Every value of the base's profile the car's data states, converted, against the base (`Mapper`) */
export function acPhysicsValues(mod: ModData, base: CarSimProfile): Mapper {
  const m = new Mapper(base);
  const car = (s: string, k: string) => mod.num('car.ini', s, k);
  const sus = (s: string, k: string) => mod.num('suspensions.ini', s, k);
  const eng = (s: string, k: string) => mod.num('engine.ini', s, k);
  const drv = (s: string, k: string) => mod.num('drivetrain.ini', s, k);
  const brk = (s: string, k: string) => mod.num('brakes.ini', s, k);
  const bc = base.config;
  const ride = staticRide(mod);
  const compound = defaultCompound(mod);

  // ---- chassis
  const mass = car('BASIC', 'TOTALMASS');
  const [bw, bh, bl] = mod.vec('car.ini', 'BASIC', 'INERTIA');
  const box = (a: number, b: number) => (mass / 12) * (a * a + b * b);
  m.set('config.chassis.totalMassKg', mass, 'car.ini [BASIC] TOTALMASS');
  m.set('config.chassis.inertia.pitch', box(bh, bl), 'car.ini [BASIC] INERTIA (height, length)');
  m.set('config.chassis.inertia.roll', box(bw, bh), 'car.ini [BASIC] INERTIA (width, height)');
  m.set('config.chassis.inertia.yaw', box(bw, bl), 'car.ini [BASIC] INERTIA (width, length)');
  m.set('config.chassis.wheelbase', sus('BASIC', 'WHEELBASE'), 'suspensions.ini [BASIC] WHEELBASE');
  m.set('config.chassis.frontWeightFraction', sus('BASIC', 'CG_LOCATION'), 'suspensions.ini [BASIC] CG_LOCATION');
  m.set('config.chassis.trackWidthFront', sus('FRONT', 'TRACK'), 'suspensions.ini [FRONT] TRACK');
  m.set('config.chassis.trackWidthRear', sus('REAR', 'TRACK'), 'suspensions.ini [REAR] TRACK');
  m.set('config.chassis.unsprungMassFront', sus('FRONT', 'HUB_MASS'), 'suspensions.ini [FRONT] HUB_MASS');
  m.set('config.chassis.unsprungMassRear', sus('REAR', 'HUB_MASS'), 'suspensions.ini [REAR] HUB_MASS');
  m.set('config.chassis.cgHeight', ride.cgHeight, 'suspensions.ini BASEY, ROD_LENGTH, SPRING_RATE + tyres.ini RADIUS, RATE (static ride)');
  const tank = mod.vec('car.ini', 'FUELTANK', 'POSITION');
  if (tank.length === 3 && tank.every(Number.isFinite)) {
    m.set('config.chassis.fuelTank.y', tank[1], 'car.ini [FUELTANK] POSITION y');
    m.set('config.chassis.fuelTank.z', tank[2], 'car.ini [FUELTANK] POSITION z');
  }
  m.set('config.chassis.wheelInertiaFront', mod.num('tyres.ini', `FRONT${compound}`, 'ANGULAR_INERTIA'), 'tyres.ini [FRONT] ANGULAR_INERTIA');
  m.set('config.chassis.wheelInertiaRear', mod.num('tyres.ini', `REAR${compound}`, 'ANGULAR_INERTIA'), 'tyres.ini [REAR] ANGULAR_INERTIA');
  const steerRatio = car('CONTROLS', 'STEER_RATIO');
  m.set('config.chassis.maxRoadWheelDeg', car('CONTROLS', 'STEER_LOCK') / steerRatio, 'car.ini [CONTROLS] STEER_LOCK / STEER_RATIO');
  m.set('steerRatio', steerRatio, 'car.ini [CONTROLS] STEER_RATIO');
  m.quiet('config.chassis.powerSteering.steeringRatio', steerRatio, 'car.ini [CONTROLS] STEER_RATIO');
  m.set('fuelLPerS1000Rpm', car('FUEL', 'CONSUMPTION'), 'car.ini [FUEL] CONSUMPTION');

  // ---- engine: power.lut is torque after the driveline, the turbos' boost on top of it
  const eff = bc.gearbox.efficiency;
  const turbos = acTurbos(mod);
  const limiter = eng('ENGINE_DATA', 'LIMITER');
  const baseTurbo = bc.engine.turbo;
  const torque = rising(mod.lut('power.lut').filter(([rpm]) => rpm >= 0));
  if (torque.length >= 2) {
    m.set(
      'config.engine.powerCurve',
      torque.map(([rpm, nm]) => [rpm, ((nm * (1 + acBoost(turbos, rpm))) / eff) * ((rpm * Math.PI) / 30) / 1000]),
      `power.lut (torque ÷ the base's driveline efficiency ${eff}${turbos.length ? ', × the full boost' : ''})`,
    );
  } else m.skip('power.lut', 'missing or empty');
  const idle = eng('ENGINE_DATA', 'MINIMUM');
  const coastRpm = eng('COAST_REF', 'RPM');
  const coastNm = eng('COAST_REF', 'TORQUE');
  if (coastRpm > idle && coastNm >= 0) {
    const end = Math.max(coastRpm, limiter || coastRpm) * 1.05;
    m.set('config.engine.coastCurve', [[0, 0], [idle, 0], [coastRpm, coastNm], ...(end > coastRpm ? [[end, (coastNm * (end - idle)) / (coastRpm - idle)]] : [])], 'engine.ini [COAST_REF] RPM, TORQUE (a line from nothing at idle)');
  } else m.skip('engine.ini [COAST_REF]', 'no overrun torque reference above idle');
  const throttleLutName = mod.text('engine.ini', 'THROTTLE_RESPONSE', 'LUT') ?? (mod.has('throttle.lut') ? 'throttle.lut' : undefined);
  const throttle = rising(mod.lut(throttleLutName));
  if (throttle.length >= 2 && throttle[throttle.length - 1][0] >= 99) m.set('config.engine.throttleResponseCurve', throttle.map(([x, y]) => [x / 100, y / 100]), `${throttleLutName} (pedal → throttle, %)`);
  m.set('config.engine.idleRpm', idle, 'engine.ini [ENGINE_DATA] MINIMUM');
  m.set('config.engine.inertia', eng('ENGINE_DATA', 'INERTIA') + (drv('GEARBOX', 'INERTIA') || 0), 'engine.ini [ENGINE_DATA] INERTIA + drivetrain.ini [GEARBOX] INERTIA');
  m.set('config.engine.limiterCutS', 1 / eng('ENGINE_DATA', 'LIMITER_HZ'), 'engine.ini [ENGINE_DATA] LIMITER_HZ (one cycle)');
  if (Number.isFinite(eng('ENGINE_DATA', 'ALTITUDE_SENSITIVITY'))) m.set('config.engine.airDensitySensitivity', eng('ENGINE_DATA', 'ALTITUDE_SENSITIVITY'), 'engine.ini [ENGINE_DATA] ALTITUDE_SENSITIVITY');
  if (turbos.length && baseTurbo) {
    const t = turbos[0].turbo;
    const from = `engine.ini [${turbos[0].section}]`;
    m.set('config.engine.turbo.maxBoost', t.maxBoost, `${from} MAX_BOOST, WASTEGATE`);
    m.set('config.engine.turbo.referenceRpm', t.referenceRpm, `${from} REFERENCE_RPM`);
    m.set('config.engine.turbo.gamma', t.gamma, `${from} GAMMA`);
    m.set('config.engine.turbo.spoolUpS', t.spoolUpS, `${from} LAG_UP (1 / ((1 − lag) · 444))`);
    m.set('config.engine.turbo.spoolRefRpm', t.spoolRefRpm, `${from} REFERENCE_RPM`);
    m.set('config.engine.turbo.spoolDownS', t.spoolDownS, `${from} LAG_DN`);
    m.set('config.engine.turbo.displayMaxBoostBar', t.displayMaxBoostBar, `${from} DISPLAY_MAX_BOOST`);
    m.quiet('config.engine.turbo.throttleInBoostLaw', true, `${from} (AC's throttle works inside the boost law)`);
    for (const extra of turbos.slice(1)) m.skip(`engine.ini [${extra.section}]`, 'a second turbo: its full boost is in the power curve, its lag is the first turbo\'s');
  } else if (turbos.length) {
    for (const t of turbos) m.skip(`engine.ini [${t.section}] LAG_UP, LAG_DN`, 'the base model has no turbo: the full boost is in the power curve, without its lag');
  } else if (baseTurbo) {
    m.set('config.engine.turbo.maxBoost', 0, 'engine.ini (no [TURBO_n]: no boost)');
  }
  m.set('turbo', turbos.length > 0 && !!baseTurbo, 'engine.ini [TURBO_n] (the HUD\'s boost gauge)');
  if (mod.sections('engine.ini').some((s) => /^TURBO_\d+$/.test(s)) && mod.has('ctrl_turbo0.ini')) m.skip('ctrl_turbo0.ini', 'a boost controller: not modelled (the turbo runs its own boost law)');

  // ---- gearbox and clutch
  const count = drv('GEARS', 'COUNT');
  const ratios = Array.from({ length: Number.isFinite(count) ? count : 0 }, (_, i) => drv('GEARS', `GEAR_${i + 1}`));
  m.set('config.gearbox.ratios', ratios, 'drivetrain.ini [GEARS] GEAR_1…GEAR_n');
  m.set('config.gearbox.reverse', Math.abs(drv('GEARS', 'GEAR_R')), 'drivetrain.ini [GEARS] GEAR_R');
  m.set('config.gearbox.finalDrive', drv('GEARS', 'FINAL'), 'drivetrain.ini [GEARS] FINAL');
  const up = drv('GEARBOX', 'CHANGE_UP_TIME');
  const cut = drv('GEARBOX', 'AUTO_CUTOFF_TIME');
  const dn = drv('GEARBOX', 'CHANGE_DN_TIME');
  m.set('config.gearbox.shiftTimeS', Math.max(up || 0, cut || 0) / 1000, 'drivetrain.ini [GEARBOX] CHANGE_UP_TIME, AUTO_CUTOFF_TIME (the longer)');
  if (m.has('config.gearbox.downshiftTimeS')) m.set('config.gearbox.downshiftTimeS', dn / 1000, 'drivetrain.ini [GEARBOX] CHANGE_DN_TIME');
  if (m.has('config.gearbox.upshiftNeutralS')) m.set('config.gearbox.upshiftNeutralS', up / 1000, 'drivetrain.ini [GEARBOX] CHANGE_UP_TIME');
  if (m.has('config.gearbox.upshiftCutS')) m.set('config.gearbox.upshiftCutS', cut / 1000, 'drivetrain.ini [GEARBOX] AUTO_CUTOFF_TIME');
  if (m.has('config.gearbox.downshift')) {
    m.set('config.gearbox.downshift.neutralS', dn / 1000, 'drivetrain.ini [GEARBOX] CHANGE_DN_TIME');
    m.set('config.gearbox.downshift.clutchReleaseS', drv('DOWNSHIFT_PROFILE', 'POINT_1') / 1000, 'drivetrain.ini [DOWNSHIFT_PROFILE] POINT_1');
    m.set('config.gearbox.downshift.clutchHomeS', drv('DOWNSHIFT_PROFILE', 'POINT_2') / 1000, 'drivetrain.ini [DOWNSHIFT_PROFILE] POINT_2');
    m.set('config.gearbox.downshift.blip.level', drv('AUTOBLIP', 'LEVEL'), 'drivetrain.ini [AUTOBLIP] LEVEL');
    m.set('config.gearbox.downshift.blip.riseS', drv('AUTOBLIP', 'POINT_0') / 1000, 'drivetrain.ini [AUTOBLIP] POINT_0');
    if (m.has('config.gearbox.downshift.overRevRpm')) {
      const overrev = drv('DOWNSHIFT_PROTECTION', 'OVERREV');
      const damage = eng('DAMAGE', 'RPM_THRESHOLD');
      if (Number.isFinite(overrev)) m.set('config.gearbox.downshift.overRevRpm', overrev, 'drivetrain.ini [DOWNSHIFT_PROTECTION] OVERREV');
      else if (damage > limiter) m.set('config.gearbox.downshift.overRevRpm', damage - limiter, 'engine.ini [DAMAGE] RPM_THRESHOLD − LIMITER (no down-shift protection)');
    }
  }
  m.set('config.gearbox.gears.redline_rpm', limiter, 'engine.ini [ENGINE_DATA] LIMITER');
  const autoUp = drv('AUTO_SHIFTER', 'UP');
  const autoDn = drv('AUTO_SHIFTER', 'DOWN');
  const scale = limiter / bc.gearbox.gears.redline_rpm;
  if (autoUp > 0) m.set('config.gearbox.gears.upshift_rpm', Math.min(autoUp, limiter - 50), 'drivetrain.ini [AUTO_SHIFTER] UP');
  else m.quiet('config.gearbox.gears.upshift_rpm', bc.gearbox.gears.upshift_rpm * scale, "the base's, on this limiter");
  if (autoDn > 0) m.set('config.gearbox.gears.downshift_rpm', autoDn, 'drivetrain.ini [AUTO_SHIFTER] DOWN');
  else m.quiet('config.gearbox.gears.downshift_rpm', bc.gearbox.gears.downshift_rpm * scale, "the base's, on this limiter");
  if (bc.gearbox.gears.brake_downshift_rpm) m.quiet('config.gearbox.gears.brake_downshift_rpm', bc.gearbox.gears.brake_downshift_rpm * scale, "the base's, on this limiter");
  if (bc.gearSets?.length) m.quiet('config.gearSets', [{ ratios, reverse: Math.abs(drv('GEARS', 'GEAR_R')), finalDrive: drv('GEARS', 'FINAL') }], 'drivetrain.ini [GEARS] (the one gear set)');
  m.set('config.clutch.maxTorqueNm', drv('CLUTCH', 'MAX_TORQUE'), 'drivetrain.ini [CLUTCH] MAX_TORQUE');
  const bite = drv('AUTOCLUTCH', 'MIN_RPM');
  const lock = drv('AUTOCLUTCH', 'MAX_RPM');
  if (bite > 0 && lock > bite) {
    m.set('config.clutch.biteRpm', bite, 'drivetrain.ini [AUTOCLUTCH] MIN_RPM');
    m.set('config.clutch.lockRpm', lock, 'drivetrain.ini [AUTOCLUTCH] MAX_RPM');
  }

  // ---- the driven wheels and the differentials
  const traction = (mod.text('drivetrain.ini', 'TRACTION', 'TYPE') ?? 'RWD').toUpperCase();
  if (traction === 'FWD' || traction === 'RWD') {
    if (m.has('config.drivenAxle')) m.set('config.drivenAxle', traction === 'FWD' ? 'front' : 'rear', 'drivetrain.ini [TRACTION] TYPE');
    else if (traction === 'FWD') m.skip('drivetrain.ini [TRACTION] TYPE=FWD', 'the base model drives its rear wheels and has no switch for it');
    if (bc.awd) {
      m.set('config.awd.centre.maxTorqueNm', 0, 'drivetrain.ini [TRACTION] TYPE (two-wheel drive: the centre coupling idle)');
      m.set('config.awd.centre.rampNmPerRadS', 0, 'drivetrain.ini [TRACTION] TYPE');
    }
    m.set('config.differential.settings.power', drv('DIFFERENTIAL', 'POWER'), 'drivetrain.ini [DIFFERENTIAL] POWER');
    m.set('config.differential.settings.coast', drv('DIFFERENTIAL', 'COAST'), 'drivetrain.ini [DIFFERENTIAL] COAST');
    m.set('config.differential.settings.preload', drv('DIFFERENTIAL', 'PRELOAD'), 'drivetrain.ini [DIFFERENTIAL] PRELOAD');
  } else if (traction === 'AWD2' && bc.awd) {
    const a = (k: string) => drv('AWD2', k);
    m.set('config.differential.settings.power', a('REAR_DIFF_POWER'), 'drivetrain.ini [AWD2] REAR_DIFF_POWER');
    m.set('config.differential.settings.coast', a('REAR_DIFF_COAST'), 'drivetrain.ini [AWD2] REAR_DIFF_COAST');
    m.set('config.differential.settings.preload', a('REAR_DIFF_PRELOAD'), 'drivetrain.ini [AWD2] REAR_DIFF_PRELOAD');
    m.set('config.awd.centre.rampNmPerRadS', a('CENTRE_RAMP_TORQUE'), 'drivetrain.ini [AWD2] CENTRE_RAMP_TORQUE');
    m.set('config.awd.centre.maxTorqueNm', a('CENTRE_MAX_TORQUE'), 'drivetrain.ini [AWD2] CENTRE_MAX_TORQUE');
    m.set('config.awd.secondaryDiff.power', a('FRONT_DIFF_POWER'), 'drivetrain.ini [AWD2] FRONT_DIFF_POWER');
    m.set('config.awd.secondaryDiff.coast', a('FRONT_DIFF_COAST'), 'drivetrain.ini [AWD2] FRONT_DIFF_COAST');
    m.set('config.awd.secondaryDiff.preload', a('FRONT_DIFF_PRELOAD'), 'drivetrain.ini [AWD2] FRONT_DIFF_PRELOAD');
  } else {
    m.skip(`drivetrain.ini [TRACTION] TYPE=${traction}`, bc.awd ? "AWD (a centre differential) isn't modelled: the R32's centre coupling stays as it is" : 'four-wheel drive needs a base with a centre coupling (nissan-r32-jtcc): it drives as the base does');
    m.set('config.differential.settings.power', drv('DIFFERENTIAL', 'POWER'), 'drivetrain.ini [DIFFERENTIAL] POWER');
    m.set('config.differential.settings.coast', drv('DIFFERENTIAL', 'COAST'), 'drivetrain.ini [DIFFERENTIAL] COAST');
    m.set('config.differential.settings.preload', drv('DIFFERENTIAL', 'PRELOAD'), 'drivetrain.ini [DIFFERENTIAL] PRELOAD');
  }

  // ---- brakes
  m.set('config.brakes.maxTorqueNm', brk('DATA', 'MAX_TORQUE'), 'brakes.ini [DATA] MAX_TORQUE');
  m.set('config.brakes.front_bias', brk('DATA', 'FRONT_SHARE'), 'brakes.ini [DATA] FRONT_SHARE');
  if (brk('DATA', 'HANDBRAKE_TORQUE') > 0) m.set('config.brakes.handbrakeTorqueNm', brk('DATA', 'HANDBRAKE_TORQUE'), 'brakes.ini [DATA] HANDBRAKE_TORQUE');
  if (brk('DATA', 'ADJUST_STEP') > 0) m.set('config.brakes.ebbStep', brk('DATA', 'ADJUST_STEP') / 100, 'brakes.ini [DATA] ADJUST_STEP');
  if (m.has('config.brakes.padMuCurve')) {
    const pads = rising(mod.lutOf('brakes.ini', 'TEMPS_FRONT', 'PERF_CURVE'));
    m.set('config.brakes.padMuCurve', pads.length >= 2 ? pads : [[0, 1], [1000, 1]], pads.length >= 2 ? 'brakes.ini [TEMPS_FRONT] PERF_CURVE' : 'brakes.ini (no [TEMPS_*]: constant brakes)');
  }
  if (bc.brakes.brakeByWire !== false && !m.has('config.brakes.brakeByWire')) m.skip('brakes.ini (hydraulic brakes)', "the base's rear brakes are by wire, blending with its engine braking");
  else m.quiet('config.brakes.brakeByWire', false, 'brakes.ini (hydraulic brakes)');

  // ---- suspension
  for (const AX of ['FRONT', 'REAR'] as const) {
    const ax = AX === 'FRONT' ? 'front' : 'rear';
    const s = (k: string) => sus(AX, k);
    const p = `config.suspensions.${ax}`;
    const d = `config.suspensions.dampers_controller.${ax}`;
    const st = ride[ax].stops;
    m.set(`${p}.staticCamber`, s('STATIC_CAMBER'), `suspensions.ini [${AX}] STATIC_CAMBER`);
    m.set(`${p}.springs.wheel_rate`, s('SPRING_RATE'), `suspensions.ini [${AX}] SPRING_RATE`);
    if (valueAt(base, `${p}.springs.helper_rate`)) {
      m.set(`${p}.springs.helper_rate`, 0, `suspensions.ini [${AX}] (no helper spring)`);
      m.set(`${p}.springs.helper_range`, 0, `suspensions.ini [${AX}] (no helper spring)`);
    }
    if (s('PROGRESSIVE_SPRING_RATE')) m.skip(`suspensions.ini [${AX}] PROGRESSIVE_SPRING_RATE`, "this model's corner springs are linear");
    m.set(`${p}.arb`, sus('ARB', AX), `suspensions.ini [ARB] ${AX}`);
    // The packers and bump stop, from static ride: the nearer is the first stop, the farther the second
    const strut = mod.text('suspensions.ini', AX, 'TYPE') === 'STRUT';
    const packerRate = s('BUMP_STOP_RATE');
    const stopRate = strut ? RIGID_STOP_RATE : packerRate;
    const together = Math.abs(st.packerGapM - st.bumpStopGapM) < 1e-4;
    const packerFirst = st.packerGapM <= st.bumpStopGapM;
    m.set(`${p}.bumpStop.range`, Math.max(0, Math.min(st.packerGapM, st.bumpStopGapM)), `suspensions.ini [${AX}] PACKER_RANGE, BUMPSTOP_UP (from static ride)`);
    m.set(`${p}.bumpStop.rate`, together ? packerRate + stopRate : packerFirst ? packerRate : stopRate, `suspensions.ini [${AX}] BUMP_STOP_RATE`);
    m.quiet(`${p}.bumpStop.progression`, 0, `suspensions.ini [${AX}] (linear stops)`);
    m.quiet(`${p}.bumpStop.packerGap`, 0, `suspensions.ini [${AX}] (the packers are the first stop)`);
    if (!together) {
      if (m.has(`${p}.bumpStop.hardStop`)) {
        m.set(`${p}.bumpStop.hardStop.range`, Math.max(st.packerGapM, st.bumpStopGapM), `suspensions.ini [${AX}] PACKER_RANGE, BUMPSTOP_UP (the farther)`);
        m.set(`${p}.bumpStop.hardStop.rate`, packerFirst ? stopRate : packerRate, `suspensions.ini [${AX}] BUMP_STOP_RATE (the farther stop)`);
      } else m.skip(`suspensions.ini [${AX}] BUMPSTOP_UP / PACKER_RANGE (the farther stop)`, 'the base model has one stop: the nearer is used');
    }
    m.set(`${p}.droopTravel`, Math.max(0.001, st.droopM), `suspensions.ini [${AX}] BUMPSTOP_DN (from static ride)`);
    const heave = `HEAVE_${AX}`;
    const h = (k: string) => sus(heave, k);
    if (Number.isFinite(h('SPRING_RATE'))) {
      m.set(`${p}.heave.rate`, h('SPRING_RATE'), `suspensions.ini [${heave}] SPRING_RATE`);
      m.set(`${p}.heave.gap`, 0, `suspensions.ini [${heave}] (in contact at static ride)`);
      m.set(`${p}.heave.packerGap`, Math.max(0, Math.min(st.heavePackerGapM, st.heaveBumpStopGapM)), `suspensions.ini [${heave}] PACKER_RANGE, BUMPSTOP_UP`);
      m.set(`${p}.heave.packerRate`, st.heavePackerGapM <= st.heaveBumpStopGapM ? h('BUMP_STOP_RATE') : RIGID_STOP_RATE, `suspensions.ini [${heave}] BUMP_STOP_RATE`);
      if (h('PROGRESSIVE_SPRING_RATE')) m.set(`${p}.heave.progressiveRate`, h('PROGRESSIVE_SPRING_RATE'), `suspensions.ini [${heave}] PROGRESSIVE_SPRING_RATE`);
      m.set(`${d}.heave`, { slow_bump: h('DAMP_BUMP'), fast_bump: h('DAMP_FAST_BUMP'), slow_rebound: h('DAMP_REBOUND'), fast_rebound: h('DAMP_FAST_REBOUND') }, `suspensions.ini [${heave}] DAMP_*`);
      if (m.has(`${d}.heaveFastThresholdMs`)) m.set(`${d}.heaveFastThresholdMs`, h('DAMP_FAST_BUMPTHRESHOLD'), `suspensions.ini [${heave}] DAMP_FAST_BUMPTHRESHOLD`);
      if (m.has(`${d}.heaveFastReboundThresholdMs`)) m.set(`${d}.heaveFastReboundThresholdMs`, h('DAMP_FAST_REBOUNDTHRESHOLD'), `suspensions.ini [${heave}] DAMP_FAST_REBOUNDTHRESHOLD`);
    } else {
      if (valueAt(base, `${p}.heave.rate`)) {
        m.set(`${p}.heave.rate`, 0, `suspensions.ini (no [${heave}]: no third spring)`);
        m.set(`${p}.heave.packerRate`, 0, `suspensions.ini (no [${heave}])`);
      }
      if (!same(valueAt(base, `${d}.heave`), NO_DAMPER)) m.quiet(`${d}.heave`, NO_DAMPER, `suspensions.ini (no [${heave}]: no heave damper)`);
    }
    for (const mode of ['roll', 'pitch']) if (!same(valueAt(base, `${d}.${mode}`), NO_DAMPER)) m.quiet(`${d}.${mode}`, NO_DAMPER, `suspensions.ini (no ${mode} damper)`);
    m.set(`${d}.base`, { slow_bump: s('DAMP_BUMP'), fast_bump: s('DAMP_FAST_BUMP'), slow_rebound: s('DAMP_REBOUND'), fast_rebound: s('DAMP_FAST_REBOUND') }, `suspensions.ini [${AX}] DAMP_BUMP, DAMP_FAST_BUMP, DAMP_REBOUND, DAMP_FAST_REBOUND`);
    m.set(`${d}.fastThresholdMs`, s('DAMP_FAST_BUMPTHRESHOLD'), `suspensions.ini [${AX}] DAMP_FAST_BUMPTHRESHOLD`);
    if (m.has(`${d}.fastReboundThresholdMs`)) m.set(`${d}.fastReboundThresholdMs`, s('DAMP_FAST_REBOUNDTHRESHOLD'), `suspensions.ini [${AX}] DAMP_FAST_REBOUNDTHRESHOLD`);
    // The geometry, where the base is the same kind of suspension: a strut's top mount stands in for the upper ball
    // joint, with a 1 m virtual upper arm square to the strut (as the Liana's, Scirocco's and 934's configs build it)
    const type = (mod.text('suspensions.ini', AX, 'TYPE') ?? 'DWB').toUpperCase();
    const baseType = valueAt(base, `${p}.type`);
    const vec = (k: string) => mod.vec('suspensions.ini', AX, k);
    if (type === 'DWB' && baseType === 'SuspensionType_DoubleWishbone') {
      m.set(`${p}.hardpoints`, HARDPOINT_KEYS.map(vec), `suspensions.ini [${AX}] ${HARDPOINT_KEYS.join(', ')}`);
    } else if (type === 'STRUT' && baseType === 'SuspensionType_Strut') {
      const top = vec('STRUT_CAR');
      const foot = Number.isFinite(vec('WBTYRE_BOTTOM')[0]) ? vec('WBTYRE_BOTTOM') : vec('STRUT_TYRE');
      const axis = [top[0] - vec('STRUT_TYRE')[0], top[1] - vec('STRUT_TYRE')[1]];
      const len = Math.hypot(axis[0], axis[1]);
      const arm = [axis[1] / len, -axis[0] / len];
      const inboard = (dz: number) => [top[0] + arm[0], top[1] + arm[1], top[2] + dz];
      m.set(`${p}.hardpoints`, [inboard(0.15), inboard(-0.15), vec('WBCAR_BOTTOM_FRONT'), vec('WBCAR_BOTTOM_REAR'), top, foot, vec('WBCAR_STEER'), vec('WBTYRE_STEER')], `suspensions.ini [${AX}] STRUT_CAR, STRUT_TYRE, WBCAR_BOTTOM_*, WBTYRE_BOTTOM, WBCAR_STEER, WBTYRE_STEER (a 1 m virtual upper arm)`);
    } else {
      m.skip(`suspensions.ini [${AX}] TYPE=${type} hardpoints`, `the base's ${ax} suspension is a ${String(baseType).replace('SuspensionType_', '')}: its geometry stays the base's`);
    }
    if (type === 'STRUT' || type === 'DWB') m.quiet(`${p}.rockerProgressivityPerM`, 0, `suspensions.ini [${AX}] (rates at the wheel: no rocker)`);
  }
  // Ride-height pickups: the floor's height at each axle, the plank under the body's colliders
  const pickupF = car('RIDE', 'PICKUP_FRONT_HEIGHT');
  const pickupR = car('RIDE', 'PICKUP_REAR_HEIGHT');
  if (Number.isFinite(pickupF) && Number.isFinite(pickupR)) {
    m.set('config.aero.front_target_height', ride.front.bodyHeight + pickupF, 'car.ini [RIDE] PICKUP_FRONT_HEIGHT (+ the static ride)');
    m.set('config.aero.rear_target_height', ride.rear.bodyHeight + pickupR, 'car.ini [RIDE] PICKUP_REAR_HEIGHT (+ the static ride)');
    m.set('config.aero.floorOffsetY', 0.5 * (pickupF + pickupR), 'car.ini [RIDE] PICKUP_FRONT_HEIGHT, PICKUP_REAR_HEIGHT');
    if (bc.aero.rhMap) {
      m.set('config.aero.rhMap.frontPickupY', pickupF, 'car.ini [RIDE] PICKUP_FRONT_HEIGHT');
      m.set('config.aero.rhMap.rearPickupY', pickupR, 'car.ini [RIDE] PICKUP_REAR_HEIGHT');
    }
  }
  const colliders = mod.sections('colliders.ini').filter((c) => /^COLLIDER_\d+$/.test(c));
  if (colliders.length && m.has('config.aero.plank')) {
    const boxes = colliders.map((c) => ({ c: mod.vec('colliders.ini', c, 'CENTRE'), s: mod.vec('colliders.ini', c, 'SIZE') }));
    m.set('config.aero.plank', {
      y: Math.min(...boxes.map((b) => b.c[1] - b.s[1] / 2)),
      frontZ: Math.max(...boxes.map((b) => b.c[2] + b.s[2] / 2)),
      rearZ: Math.min(...boxes.map((b) => b.c[2] - b.s[2] / 2)),
    }, 'colliders.ini [COLLIDER_n] CENTRE, SIZE (the undersides)');
  }

  // ---- tyres
  mapTyres(mod, m, base, compound);

  // ---- aero
  mapAero(mod, m, base, ride);

  // ---- electronics and the garage's ranges
  const el = (s: string, k: string) => mod.num('electronics.ini', s, k);
  const abs = mod.sections('electronics.ini').includes('ABS_V2') ? 'ABS_V2' : 'ABS';
  if (base.electronics) {
    if (el(abs, 'SLIP_RATIO_LIMIT') > 0) m.set('electronics.absDefault', el(abs, 'SLIP_RATIO_LIMIT'), `electronics.ini [${abs}] SLIP_RATIO_LIMIT`);
    if (el(abs, 'RATE_HZ') > 0) m.set('electronics.absRateHz', el(abs, 'RATE_HZ'), `electronics.ini [${abs}] RATE_HZ`);
    if (el('TRACTION_CONTROL', 'SLIP_RATIO_LIMIT') > 0) m.set('electronics.tcDefault', el('TRACTION_CONTROL', 'SLIP_RATIO_LIMIT'), 'electronics.ini [TRACTION_CONTROL] SLIP_RATIO_LIMIT');
    if (el('TRACTION_CONTROL', 'RATE_HZ') > 0) m.set('electronics.tcRateHz', el('TRACTION_CONTROL', 'RATE_HZ'), 'electronics.ini [TRACTION_CONTROL] RATE_HZ');
    if (Number.isFinite(el('TRACTION_CONTROL', 'MIN_SPEED_KMH'))) {
      m.set('electronics.tcMinSpeedKmh', el('TRACTION_CONTROL', 'MIN_SPEED_KMH'), 'electronics.ini [TRACTION_CONTROL] MIN_SPEED_KMH');
      m.set('tcMinSpeedMs', el('TRACTION_CONTROL', 'MIN_SPEED_KMH') / 3.6, 'electronics.ini [TRACTION_CONTROL] MIN_SPEED_KMH');
    }
  }
  const setupRange = (sec: string): [number, number] | null => {
    const lo = mod.num('setup.ini', sec, 'MIN');
    const hi = mod.num('setup.ini', sec, 'MAX');
    return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? [lo, hi] : null;
  };
  const psi = setupRange('PRESSURE_LF');
  if (psi) m.set('coldPsiRange', psi, 'setup.ini [PRESSURE_LF] MIN, MAX');
  else {
    const set = mod.num('tyres.ini', `FRONT${compound}`, 'PRESSURE_STATIC');
    if (set > 0) m.set('coldPsiRange', [Math.min(base.coldPsiRange[0], set - 4), Math.max(base.coldPsiRange[1], set + 4)], "tyres.ini PRESSURE_STATIC (the base's range, widened to it)");
  }
  for (const [sec, key, ax] of [['CAMBER_LF', 'frontCamberRange', 'FRONT'], ['CAMBER_LR', 'rearCamberRange', 'REAR']] as const) {
    const r = setupRange(sec);
    const own = sus(ax, 'STATIC_CAMBER');
    if (r && own >= r[0] - 1e-9 && own <= r[1] + 1e-9) m.set(key, r, `setup.ini [${sec}] MIN, MAX`);
    else if (Number.isFinite(own)) {
      const [lo, hi] = base[key];
      if (own < lo || own > hi) m.set(key, [Math.min(lo, own), Math.max(hi, own)], `suspensions.ini [${ax}] STATIC_CAMBER (the base's range, widened to it)`);
    }
  }
  if (base.hasErs && !mod.has('ers.ini')) {
    // `hasErs` only hides the HUD's energy: the motor's deploy, its harvests and the modes' own harvests go too, or a
    // car with no hybrid would drive with the base's
    const from = 'no ers.ini: no hybrid';
    m.set('hasErs', false, from);
    for (const k of ['ERS_MAX_DEPLOY', 'maxHarvestW', 'topGearLiftHarvestW'] as const) if (bc.ers[k] > 0) m.set(`config.ers.${k}`, 0, from);
    if (bc.ers.liftHarvestEveryGear) m.set('config.ers.liftHarvestEveryGear.maxAxleTorqueNm', 0, from);
    for (const [name, mode] of Object.entries(bc.performanceModes)) {
      if (mode.topGearClipHarvestW > 0) m.set(`config.performanceModes.${name}.topGearClipHarvestW`, 0, from);
      if (mode.partThrottleHarvestW > 0) m.set(`config.performanceModes.${name}.partThrottleHarvestW`, 0, from);
    }
  }
  if (base.hasDrs && !/\bDRS\b/i.test(JSON.stringify(mod.sections('aero.ini')))) m.set('hasDrs', false, 'aero.ini (no DRS)');
  mapPlanning(mod, m, base, ride);
  return m;
}

/** The base's dry compounds (by slot, each once) and its wet ones: the dry take the data's tyres, the wet its sizes */
function baseCompounds(base: CarSimProfile): { dry: { slot: string; key: string }[]; wet: string[] } {
  const slots = base.config.compoundSlots;
  const dry: { slot: string; key: string }[] = [];
  for (const slot of ['soft', 'medium', 'hard'] as const) if (!dry.some((d) => d.key === slots[slot])) dry.push({ slot, key: slots[slot] });
  const wet = [slots.intermediate, slots.wet].filter((k, i, a) => a.indexOf(k) === i && !dry.some((d) => d.key === k));
  return { dry, wet };
}

/** The data's compounds by index, with their names */
function acCompounds(mod: ModData): { suffix: string; name: string }[] {
  return mod
    .sections('tyres.ini')
    .filter((s) => /^FRONT(_\d+)?$/.test(s))
    .map((s) => ({ suffix: s.slice(5), name: `${mod.text('tyres.ini', s, 'NAME') ?? ''} ${mod.text('tyres.ini', s, 'SHORT_NAME') ?? ''}`.toLowerCase() }));
}

/** Which of the data's compounds goes in a base slot: one named for it, else the data's default */
function compoundFor(slot: string, compounds: { suffix: string; name: string }[], fallback: string): string {
  const word = { soft: /\bsoft\b|\(s\)|^s\b|\bs$/, medium: /\bmedium\b|\bmed\b|\(m\)|\bm$/, hard: /\bhard\b|\(h\)|\bh$/ }[slot];
  const hit = word && compounds.find((c) => word.test(c.name.trim()));
  return hit ? hit.suffix : fallback;
}

function mapTyres(mod: ModData, m: Mapper, base: CarSimProfile, fallback: string): void {
  const { dry, wet } = baseCompounds(base);
  const compounds = acCompounds(mod);
  const version = mod.num('tyres.ini', 'HEADER', 'VERSION');
  for (const { slot, key } of dry) {
    const suffix = compoundFor(slot, compounds, fallback);
    const F = `FRONT${suffix}`;
    const R = `REAR${suffix}`;
    const c = `config.tyreCompounds.${key}`;
    const tf = (k: string) => mod.num('tyres.ini', F, k);
    const tr = (k: string) => mod.num('tyres.ini', R, k);
    const label = (k: string) => `tyres.ini [${F}/${R}] ${k}`;
    // A value with a front and a rear: the rear's where the base keeps its own, else the front's for both
    const axle = (path: string, front: unknown, rear: unknown, from: string) => {
      if (!m.set(`${c}.${path}`, front, from)) return;
      if (m.has(`${c}.rearOverride.${path}`)) m.set(`${c}.rearOverride.${path}`, rear, `${from} (rear)`);
      else if (finite(rear) && !same(round(front), round(rear))) m.skip(`${from} (rear: ${JSON.stringify(round(rear))})`, "the base model's tyre has one value for both axles: the front's is used");
    };
    for (const [ax, t] of [['front', tf], ['rear', tr]] as const) {
      const g = `${c}.${ax}`;
      m.set(`${g}.width`, t('WIDTH'), `tyres.ini [${ax === 'front' ? F : R}] WIDTH`);
      m.set(`${g}.radius`, t('RADIUS'), `tyres.ini [${ax === 'front' ? F : R}] RADIUS`);
      m.set(`${g}.rimRadius`, t('RIM_RADIUS'), `tyres.ini [${ax === 'front' ? F : R}] RIM_RADIUS`);
      m.quiet(`${g}.verticalRateScale`, 1, 'tyres.ini RATE (the pressure curve is the axle\'s own)');
      if (Number.isFinite(t('RADIUS_ANGULAR_K'))) m.set(`${g}.radiusGrowthPerRadS`, t('RADIUS_ANGULAR_K') / 1000, `tyres.ini [${ax === 'front' ? F : R}] RADIUS_ANGULAR_K (mm per rad/s)`);
    }
    m.quiet(`${c}.modelData.curve`, 'brush', 'tyres.ini (the brush tyre AC uses)');
    axle('modelData.friction_limit_angle', tf('FRICTION_LIMIT_ANGLE'), tr('FRICTION_LIMIT_ANGLE'), label('FRICTION_LIMIT_ANGLE'));
    // Peak grip against load
    // The loads a law is tabled at, with half, once and twice the reference load among them (the power law's fit)
    const loadsFor = (fz0: number) => [...new Set([500, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000, fz0 / 2, fz0, 2 * fz0])].filter(Number.isFinite).sort((a, b) => a - b);
    const loadCurve = (t: (k: string) => number, sec: string, axis: 'Y' | 'X'): Lut => {
      const loads = loadsFor(version >= 10 ? t('FZ0') : ride0Load(mod, sec.startsWith('FRONT') ? 'FRONT' : 'REAR'));
      const table = mod.lutOf('tyres.ini', sec, `D${axis}_CURVE`);
      if (table.length >= 2) return rising(table);
      if (version >= 10) return loads.map((fz) => [fz, t(`D${axis}_REF`) * Math.pow(fz / t('FZ0'), t(`LS_EXP${axis}`) - 1)]);
      // An older version: a line, μ = D0 + D1 per 2000 N
      return loads.map((fz) => [fz, Math.max(0.5, t(`D${axis}0`) + (t(`D${axis}1`) * fz) / 2000)]);
    };
    // The power law through a table: μ at the reference load, and its exponent from μ at half and double the load
    const powerLaw = (lut: Lut, fz0: number) => {
      const mu0 = lutAt(lut, fz0);
      const exp = 1 + Math.log(lutAt(lut, 2 * fz0) / lutAt(lut, fz0 / 2)) / Math.log(4);
      return { mu0, exp };
    };
    const fz0F = version >= 10 ? tf('FZ0') : ride0Load(mod, 'FRONT');
    const fz0R = version >= 10 ? tr('FZ0') : ride0Load(mod, 'REAR');
    for (const axis of ['Y', 'X'] as const) {
      const lf = loadCurve(tf, F, axis);
      const lr = loadCurve(tr, R, axis);
      const fromCurve = mod.lutOf('tyres.ini', F, `D${axis}_CURVE`).length ? `D${axis}_CURVE` : version >= 10 ? `D${axis}_REF, LS_EXP${axis}, FZ0` : `D${axis}0, D${axis}1`;
      // The table where the base reads one; μ at FZ0 and the load exponent either way (the power law through the
      // table: exactly the data's own where it gives a power law)
      if (m.has(`${c}.modelData.d${axis.toLowerCase()}Curve`)) axle(`modelData.d${axis.toLowerCase()}Curve`, lf, lr, label(fromCurve));
      const pf = powerLaw(lf, fz0F);
      const pr = powerLaw(lr, fz0R);
      axle(`modelData.D${axis.toLowerCase()}0`, pf.mu0, pr.mu0, label(`${fromCurve} at FZ0`));
      axle(`modelData.lsExp${axis}`, pf.exp, pr.exp, label(`${fromCurve} (a power law through it)`));
    }
    axle('modelData.Fz0', fz0F, fz0R, label(version >= 10 ? 'FZ0' : 'the static corner load (no FZ0 in this data version)'));
    if (version >= 10) {
      axle('modelData.peakSlipLoadGain', tf('FLEX_GAIN'), tr('FLEX_GAIN'), label('FLEX_GAIN'));
      axle('modelData.peakSlipPressureGain', tf('PRESSURE_FLEX_GAIN'), tr('PRESSURE_FLEX_GAIN'), label('PRESSURE_FLEX_GAIN'));
      axle('modelData.combinedExponent', tf('COMBINED_FACTOR') || 2, tr('COMBINED_FACTOR') || 2, label('COMBINED_FACTOR'));
      axle('modelData.longStiffnessMult', tf('CX_MULT') || 1, tr('CX_MULT') || 1, label('CX_MULT'));
      m.quiet(`${c}.modelData.use_slip_falloff`, true, label('FALLOFF_LEVEL'));
      axle('modelData.falloff_level', tf('FALLOFF_LEVEL'), tr('FALLOFF_LEVEL'), label('FALLOFF_LEVEL'));
      axle('modelData.falloff_slope', tf('FALLOFF_SPEED'), tr('FALLOFF_SPEED'), label('FALLOFF_SPEED'));
      const peak = (t: (k: string) => number) => {
        const sigma = Math.tan((t('FRICTION_LIMIT_ANGLE') * Math.PI) / 180) / (t('CX_MULT') || 1);
        return sigma / (1 - sigma);
      };
      axle('modelData.slip_ratio_limit', peak(tf), peak(tr), label('FRICTION_LIMIT_ANGLE, CX_MULT (the drive force\'s peak slip)'));
      axle('modelData.brakeDxMod', tf('BRAKE_DX_MOD') || 0, tr('BRAKE_DX_MOD') || 0, label('BRAKE_DX_MOD'));
    } else {
      axle('modelData.curveFullness', tf('XMU'), tr('XMU'), label('XMU'));
      m.quiet(`${c}.modelData.use_slip_falloff`, false, 'tyres.ini (no falloff in this data version)');
      m.skip(label('FLEX'), 'the peak angle\'s growth with load in this data version: not carried');
    }
    axle('modelData.speedSensitivity', tf('SPEED_SENSITIVITY'), tr('SPEED_SENSITIVITY'), label('SPEED_SENSITIVITY'));
    axle('modelData.relaxationLengthX', tf('RELAXATION_LENGTH'), tr('RELAXATION_LENGTH'), label('RELAXATION_LENGTH'));
    axle('modelData.relaxationLengthY', tf('RELAXATION_LENGTH'), tr('RELAXATION_LENGTH'), label('RELAXATION_LENGTH'));
    axle('modelData.rollingResistance', tf('ROLLING_RESISTANCE_0') / 1000, tr('ROLLING_RESISTANCE_0') / 1000, label('ROLLING_RESISTANCE_0 (N per kN)'));
    if (Number.isFinite(tf('ROLLING_RESISTANCE_1'))) axle('modelData.rollingResistanceSpeedSq', tf('ROLLING_RESISTANCE_1') / 1000, tr('ROLLING_RESISTANCE_1') / 1000, label('ROLLING_RESISTANCE_1'));
    if (Number.isFinite(tf('ROLLING_RESISTANCE_SLIP'))) axle('modelData.rollingResistanceSlipGain', tf('ROLLING_RESISTANCE_SLIP') / 1000, tr('ROLLING_RESISTANCE_SLIP') / 1000, label('ROLLING_RESISTANCE_SLIP'));
    axle('modelData.verticalDamping', tf('DAMP'), tr('DAMP'), label('DAMP'));
    // Pressure: the radial rate at the static pressure, growing per psi
    const springCurve = (t: (k: string) => number): Lut => {
      const st = t('PRESSURE_STATIC');
      const ideal = t('PRESSURE_IDEAL');
      const xs = ideal > st + 0.5 ? [st - 10, st, ideal, ideal + 10] : [st - 10, st, st + 10];
      return xs.map((psi) => [psi, t('RATE') + (t('PRESSURE_SPRING_GAIN') || 0) * (psi - st)]);
    };
    axle('pressureData.optimalPsi', tf('PRESSURE_IDEAL'), tr('PRESSURE_IDEAL'), label('PRESSURE_IDEAL'));
    if (m.has(`${c}.pressureData.setPsi`)) axle('pressureData.setPsi', tf('PRESSURE_STATIC'), tr('PRESSURE_STATIC'), label('PRESSURE_STATIC'));
    axle('pressureData.pressureSpringCurve', springCurve(tf), springCurve(tr), label('RATE, PRESSURE_STATIC, PRESSURE_SPRING_GAIN'));
    if (Number.isFinite(tf('PRESSURE_RR_GAIN'))) axle('pressureData.pressureRollingGain', tf('PRESSURE_RR_GAIN'), tr('PRESSURE_RR_GAIN'), label('PRESSURE_RR_GAIN'));
    axle('pressureData.pressureGripLossPerPsi', tf('PRESSURE_D_GAIN'), tr('PRESSURE_D_GAIN'), label('PRESSURE_D_GAIN'));
    axle('camberData.camberGain', tf('CAMBER_GAIN'), tr('CAMBER_GAIN'), label('CAMBER_GAIN'));
    axle('camberData.dcamber0', tf('DCAMBER_0'), tr('DCAMBER_0'), label('DCAMBER_0'));
    axle('camberData.dcamber1', tf('DCAMBER_1'), tr('DCAMBER_1'), label('DCAMBER_1'));
    const camberLut = rising(mod.lutOf('tyres.ini', F, 'DCAMBER_LUT'));
    if (camberLut.length >= 2) m.set(`${c}.camberData.dcamberLut`, camberLut, label('DCAMBER_LUT'));
    const thermal = `THERMAL_${F}`;
    const perf = rising(mod.lutOf('tyres.ini', thermal, 'PERFORMANCE_CURVE'));
    if (perf.length >= 2) {
      m.set(`${c}.thermalData.thermalPerformanceCurve`, perf, `tyres.ini [${thermal}] PERFORMANCE_CURVE`);
      const top = Math.max(...perf.map(([, y]) => y));
      const window = perf.filter(([, y]) => y >= 0.99 * top).map(([x]) => x);
      m.set(`${c}.thermalData.optimalTempC`, [window[0], window[window.length - 1] > window[0] ? window[window.length - 1] : window[0] + 10], `tyres.ini [${thermal}] PERFORMANCE_CURVE (its peak)`);
    }
    const tread = (k: string) => mod.num('tyres.ini', thermal, k);
    if (Number.isFinite(tread('GRAIN_GAIN'))) {
      m.set(`${c}.thermalData.tread.grainGain`, tread('GRAIN_GAIN'), `tyres.ini [${thermal}] GRAIN_GAIN`);
      m.set(`${c}.thermalData.tread.grainGamma`, tread('GRAIN_GAMMA'), `tyres.ini [${thermal}] GRAIN_GAMMA`);
      m.set(`${c}.thermalData.tread.blisterGain`, tread('BLISTER_GAIN'), `tyres.ini [${thermal}] BLISTER_GAIN`);
      m.set(`${c}.thermalData.tread.blisterGamma`, tread('BLISTER_GAMMA'), `tyres.ini [${thermal}] BLISTER_GAMMA`);
    }
    const wear = rising(mod.lutOf('tyres.ini', F, 'WEAR_CURVE'));
    if (wear.length >= 2) m.set(`${c}.wear.curve`, wear, label('WEAR_CURVE'));
    if (m.has(`${c}.wear.loadScaled`)) m.set(`${c}.wear.loadScaled`, mod.num('tyres.ini', 'VIRTUALKM', 'USE_LOAD') === 1, 'tyres.ini [VIRTUALKM] USE_LOAD');
  }
  // The wet compounds keep their own grip, on the car's tyre sizes
  for (const key of wet) {
    for (const [ax, sec] of [['front', `FRONT${fallback}`], ['rear', `REAR${fallback}`]] as const) {
      for (const [k, path] of [['WIDTH', 'width'], ['RADIUS', 'radius'], ['RIM_RADIUS', 'rimRadius']] as const) {
        m.quiet(`config.tyreCompounds.${key}.${ax}.${path}`, mod.num('tyres.ini', sec, k), `tyres.ini [${sec}] ${k} (the base's wet tyre, at the car's size)`);
      }
    }
  }
  for (const c of compounds) if (!dry.some(({ slot }) => compoundFor(slot, compounds, fallback) === c.suffix)) m.skip(`tyres.ini [FRONT${c.suffix}/REAR${c.suffix}] (${c.name.trim()})`, 'a compound no slot of the base takes');
}

/** An axle's static corner load (N): an older tyre data version's reference load */
function ride0Load(mod: ModData, axle: 'FRONT' | 'REAR'): number {
  const sus = (s: string, k: string) => mod.num('suspensions.ini', s, k);
  const share = axle === 'FRONT' ? sus('BASIC', 'CG_LOCATION') : 1 - sus('BASIC', 'CG_LOCATION');
  return (mod.num('car.ini', 'BASIC', 'TOTALMASS') * G * share) / 2;
}

/**
 * Aero: the data's elements named as wings go in the base's wings ahead of and behind the CG, with their tables; the
 * rest (the body, splitters, diffusers, a wing the base has no place for) is folded into the body's constant lift and
 * drag at the static ride (the ride-height map's coefficients on a base with one). A wing of the base left over is
 * switched off (no area)
 */
function mapAero(mod: ModData, m: Mapper, base: CarSimProfile, ride: ReturnType<typeof staticRide>): void {
  const elements = aeroElements(mod);
  if (!elements.length) {
    m.skip('aero.ini', 'no aero elements');
    return;
  }
  const wings = base.config.aero.wings;
  const slot = (name: string) => wings.findIndex((w) => w.name === name);
  const used = new Set<number>();
  const folded: AeroElement[] = [];
  const pickup = { front: mod.num('car.ini', 'RIDE', 'PICKUP_FRONT_HEIGHT'), rear: mod.num('car.ini', 'RIDE', 'PICKUP_REAR_HEIGHT') };
  for (const e of elements) {
    const z = e.position[2] ?? 0;
    const want = /wing|spoiler|flap/i.test(e.name) && !/diff|floor|under|body/i.test(e.name) ? (z >= 0 ? 'FRONT_WING' : 'REAR_WING') : null;
    const i = want ? slot(want) : -1;
    if (i < 0 || used.has(i) || !e.cl.length) {
      folded.push(e);
      continue;
    }
    used.add(i);
    const w = `config.aero.wings[${i}]`;
    const from = `aero.ini [${e.section}] (${e.name})`;
    const heightRef = wings[i].heightRef;
    const ref = heightRef === 'front' ? pickup.front : heightRef === 'rear' ? pickup.rear : 0.5 * (pickup.front + pickup.rear);
    // Ground-height tables against the pickup the element's axle reads: moved by the element's height below it
    const drop = Number.isFinite(ref) ? ref - (e.position[1] ?? 0) : 0;
    const shift = (lut: Lut): Lut => (lut.length >= 2 ? rising(lut.map(([x, y]) => [x + drop, y])) : FLAT);
    m.set(`${w}.area`, e.area, `${from} CHORD × SPAN`);
    m.set(`${w}.positionZ`, z, `${from} POSITION z`);
    m.set(`${w}.angleDeg`, e.angle, `${from} ANGLE`);
    m.set(`${w}.lutAOA_CL`, rising(e.cl), `${from} LUT_AOA_CL × CL_GAIN`);
    m.set(`${w}.lutAOA_CD`, e.cd.length >= 2 ? rising(e.cd) : FLAT.map(([x]) => [x, 0]), `${from} LUT_AOA_CD × CD_GAIN`);
    m.set(`${w}.lutGH_CL_mult`, shift(e.ghCl), `${from} LUT_GH_CL (at the element's own height)`);
    m.set(`${w}.lutGH_CD_mult`, shift(e.ghCd), `${from} LUT_GH_CD`);
    if (m.has(`${w}.lutYaw_CL_mult`)) m.set(`${w}.lutYaw_CL_mult`, yawTable(e.yawClGain), `${from} YAW_CL_GAIN`);
    if (m.has(`${w}.dragY`)) m.set(`${w}.dragY`, e.position[1] ?? 0, `${from} POSITION y`);
  }
  wings.forEach((w, i) => {
    if (!used.has(i)) m.quiet(`config.aero.wings[${i}].area`, 0, `aero.ini (no element for the base's ${w.name})`);
  });
  // The folded elements, as constants at the static ride, split to the axles by their position
  let front = 0;
  let rear = 0;
  let cdA = 0;
  let cdAy = 0;
  for (const e of folded) {
    const share = Math.min(1, Math.max(0, ((e.position[2] ?? 0) + ride.b) / ride.wheelbase));
    front += e.clA * share;
    rear += e.clA * (1 - share);
    cdA += e.cdA;
    cdAy += e.cdA * (e.position[1] ?? 0);
  }
  const names = folded.map((e) => `[${e.section}] ${e.name}`).join(', ');
  if (!folded.length) return;
  const from = `aero.ini ${names} (at the static ride, its tables read once)`;
  const map = base.config.aero.rhMap;
  if (map) {
    const total = front + rear;
    m.set('config.aero.rhMap.clA', total, `${from}: CL·A`);
    m.set('config.aero.rhMap.cdA', cdA, `${from}: CD·A`);
    const grid = (v: number) => map.rearRh.map(() => map.frontRh.map(() => v));
    m.set('config.aero.rhMap.cl', grid(1), `${from} (no ride-height map)`);
    m.set('config.aero.rhMap.cd', grid(1), `${from} (no ride-height map)`);
    m.set('config.aero.rhMap.balance', grid(total > 1e-6 ? front / total : 0.5), `${from}: the front's share`);
    for (const k of ['rollCl', 'rollCd', 'yawCl', 'yawCd'] as const) m.quiet(`config.aero.rhMap.${k}`, [[-30, 1], [30, 1]], `${from} (no roll or yaw tables)`);
    for (const k of ['rollBalance', 'yawBalance'] as const) m.quiet(`config.aero.rhMap.${k}`, [[-30, 0], [30, 0]], `${from} (no roll or yaw tables)`);
    m.quiet('config.aero.rhMap.activeAero', { dClAFront: 0, dClARear: 0, dCdA: 0 }, 'aero.ini (no active aero)');
  } else {
    m.set('config.aero.front_lift', front, `${from}: CL·A ahead`);
    m.set('config.aero.rear_lift', rear, `${from}: CL·A behind`);
    m.set('config.aero.drag', cdA, `${from}: CD·A`);
    if (m.has('config.aero.dragCentreY') && cdA > 0) m.set('config.aero.dragCentreY', cdAy / cdA, `${from}: POSITION y, by drag`);
  }
  for (const e of folded) if (e.ghCl.length >= 2 || e.cl.length >= 3) m.skip(`aero.ini [${e.section}] ${e.name}: its angle and ground-height tables`, 'read once at the static ride: the element no longer changes with pitch or ride height');
  for (const s of mod.sections('aero.ini').filter((x) => /^FIN_\d+$/.test(x))) m.skip(`aero.ini [${s}]`, 'a fin (side force in yaw): not modelled');
}

/**
 * The AI's and the HUD's plan of the car (`speedProfile`), where the base has one: its mass, drag, downforce, brakes and
 * power from the data, its grip the base's scaled by the data's tyres against the base's at the static load
 */
function mapPlanning(mod: ModData, m: Mapper, base: CarSimProfile, ride: ReturnType<typeof staticRide>): void {
  const sp = base.speedProfile;
  if (!sp) return;
  const elements = aeroElements(mod);
  const clA = elements.reduce((s, e) => s + e.clA, 0);
  const cdA = elements.reduce((s, e) => s + e.cdA, 0);
  const frontCl = elements.reduce((s, e) => s + e.clA * Math.min(1, Math.max(0, ((e.position[2] ?? 0) + ride.b) / ride.wheelbase)), 0);
  const mass = mod.num('car.ini', 'BASIC', 'TOTALMASS');
  const c = defaultCompound(mod);
  const radius = mod.num('tyres.ini', `REAR${c}`, 'RADIUS');
  const turbos = acTurbos(mod);
  const eff = base.config.gearbox.efficiency;
  let peakW = 0;
  for (const [rpm, nm] of rising(mod.lut('power.lut'))) if (rpm > 0) peakW = Math.max(peakW, nm * (1 + acBoost(turbos, rpm)) * ((rpm * Math.PI) / 30));
  // Top speed: the limiter in top gear, or where the power meets the drag
  const ratios = Array.from({ length: mod.num('drivetrain.ini', 'GEARS', 'COUNT') || 0 }, (_, i) => mod.num('drivetrain.ini', 'GEARS', `GEAR_${i + 1}`));
  const top = ratios.length ? ((mod.num('engine.ini', 'ENGINE_DATA', 'LIMITER') * Math.PI) / 30 / (ratios[ratios.length - 1] * mod.num('drivetrain.ini', 'GEARS', 'FINAL'))) * radius : NaN;
  const vDrag = Math.cbrt(peakW / Math.max(0.1, 0.5 * RHO * cdA));
  const from = 'car.ini, aero.ini, brakes.ini, power.lut (the AI\'s and HUD\'s plan of the car)';
  m.set('speedProfile.massKg', mass, `${from}: TOTALMASS`);
  m.set('speedProfile.downforceCoef', Math.max(0, 0.5 * RHO * clA), `${from}: Σ CL·A`);
  m.set('speedProfile.dragCoef', 0.5 * RHO * cdA, `${from}: Σ CD·A`);
  m.set('speedProfile.rearDownforceShare', clA > 1e-6 ? Math.min(1, Math.max(0, 1 - frontCl / clA)) : 0.5, `${from}: the elements' positions`);
  m.set('speedProfile.rearWeightFraction', 1 - mod.num('suspensions.ini', 'BASIC', 'CG_LOCATION'), `${from}: CG_LOCATION`);
  m.set('speedProfile.maxBrakeForceN', (2 * mod.num('brakes.ini', 'DATA', 'MAX_TORQUE')) / radius, `${from}: MAX_TORQUE ÷ RADIUS`);
  m.set('speedProfile.maxDrivePowerW', peakW, `${from}: power.lut's peak`);
  m.set('speedProfile.vMaxMs', Number.isFinite(top) ? Math.min(top, vDrag) : vDrag, `${from}: the limiter in top gear, or power against drag`);
  // Grip: the base's planning μ, scaled by the data's peak μ against the base's at each one's static front load
  const bc = base.config;
  const baseTyre = bc.tyreCompounds[bc.compoundSlots.soft]!.modelData;
  const baseLoad = (bc.chassis.totalMassKg * G * bc.chassis.frontWeightFraction) / 2;
  const baseMu = (axis: 'y' | 'x') => {
    const curve = axis === 'y' ? baseTyre.dyCurve : baseTyre.dxCurve;
    if (curve?.length) return lutAt(curve, baseLoad);
    const [d0, exp] = axis === 'y' ? [baseTyre.Dy0, baseTyre.lsExpY] : [baseTyre.Dx0, baseTyre.lsExpX];
    return d0 * Math.pow(baseLoad / baseTyre.Fz0, exp - 1);
  };
  const load = ride0Load(mod, 'FRONT');
  const version = mod.num('tyres.ini', 'HEADER', 'VERSION');
  const t = (k: string) => mod.num('tyres.ini', `FRONT${c}`, k);
  const acMu = (axis: 'Y' | 'X') => {
    const curve = mod.lutOf('tyres.ini', `FRONT${c}`, `D${axis}_CURVE`);
    if (curve.length) return lutAt(curve, load);
    if (version >= 10) return t(`D${axis}_REF`) * Math.pow(load / t('FZ0'), t(`LS_EXP${axis}`) - 1);
    return t(`D${axis}0`) + (t(`D${axis}1`) * load) / 2000;
  };
  m.set('speedProfile.muLat', sp.muLat * (acMu('Y') / baseMu('y')), `${from}: tyres.ini peak μ against the base's`);
  m.set('speedProfile.muLong', sp.muLong * (acMu('X') / baseMu('x')), `${from}: tyres.ini peak μ against the base's`);
  m.set('padLateralMu', base.padLateralMu * (acMu('Y') / baseMu('y')), "tyres.ini peak μ against the base's (the steering assist's grip)");
  // The braking envelope: lowG + aeroG × (v / refMs)², the downforce's share at the reference speed
  const lowG = base.braking.lowG * (acMu('X') / baseMu('x'));
  m.set('braking.lowG', lowG, "tyres.ini peak μ against the base's (the braking envelope)");
  m.set('braking.aeroG', Math.max(0, (0.5 * RHO * clA * base.braking.refMs ** 2) / (mass * G)) * lowG, `${from}: Σ CL·A at the envelope's reference speed`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------------------------------------------------

export interface AcPhysicsPatch {
  base: VehicleModelId;
  why: string;
  /** `{ format, profile }`: what cars/<id>/physics.json holds */
  file: { format: number; profile: Record<string, unknown> };
  mapped: MappedValue[];
  unmapped: Unmapped[];
  /** The profile the game builds from it */
  profile: CarSimProfile;
}

function buildPatch(values: MappedValue[], base: CarSimProfile): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const v of values) setAt(patch, v.path, v.value);
  // A patched list replaces the base's: the wings the patch leaves alone are kept as the base's own
  const wings = valueAt(patch, 'config.aero.wings');
  if (Array.isArray(wings)) while (wings.length < base.config.aero.wings.length) wings.push({});
  return patch;
}

/**
 * The car's physics patch on `base` (chosen by `chooseBaseModel` when absent), checked as the game checks a physics
 * file: a value it refuses is moved to the unmapped list with its reason, and the rest is checked again
 */
export function acPhysicsPatch(dir: string, opts: { base?: VehicleModelId; ui?: UiCar } = {}): AcPhysicsPatch {
  const mod = new ModData(dir);
  if (!mod.present) throw new Error(`${dir}: no car data (car.ini in it, in its data/ folder or in its data.acd)`);
  const ui = opts.ui ?? readUiCar(dir);
  const choice = opts.base ? { base: opts.base, why: 'named' } : chooseBaseModel(acCarFacts(mod, ui));
  const baseProfile = VEHICLE_MODELS[choice.base]?.simProfile;
  if (!baseProfile) throw new Error(`${choice.base} takes no physics file; the bases are ${BASE_MODELS.join(', ')}`);
  const mapper = acPhysicsValues(mod, baseProfile);
  let values = mapper.values;
  const unmapped = [...mapper.unmapped];
  for (let round = 0; round < 20; round++) {
    const file = { format: MOD_PHYSICS_FORMAT, profile: buildPatch(values, baseProfile) };
    const result = modSimProfile(baseProfile, file, `mod:check/${basename(resolve(dir))}`);
    if (result.ok) return { ...choice, file, mapped: values, unmapped, profile: result.profile };
    const refused = new Set<MappedValue>();
    for (const err of result.errors) {
      const at = /^profile\.(\S+?):/.exec(err)?.[1] ?? '';
      // The value the problem is at, or within; a problem with a whole object (its values disagree), its values named
      let hit = values.filter((v) => at === v.path || at.startsWith(`${v.path}.`) || at.startsWith(`${v.path}[`));
      if (!hit.length) hit = values.filter((v) => v.path.startsWith(`${at}.`) && err.includes(v.path.slice(v.path.lastIndexOf('.') + 1)));
      if (!hit.length) hit = values.filter((v) => v.path.startsWith(`${at}.`) || v.path.startsWith(`${at}[`));
      if (!hit.length) throw new Error(`the physics patch is refused, and no value of it is to blame: ${err}`);
      for (const v of hit) {
        refused.add(v);
        unmapped.push({ from: v.from, why: `refused by the game's check: ${err.replace(/^profile\./, '')}` });
      }
    }
    values = values.filter((v) => !refused.has(v));
  }
  throw new Error('the physics patch is still refused after taking out every value the check named');
}

// ---------------------------------------------------------------------------------------------------------------------
// Driving it
// ---------------------------------------------------------------------------------------------------------------------

export interface DriveCheck {
  ok: boolean;
  problems: string[];
  /**
   * 0–100 km/h (s), top speed (km/h) in 60 s flat out, and on it the most body slip (deg), the fastest yaw (rad/s) and
   * how far it ran off its line (m: the wheel held straight, as no driver would)
   */
  t100: number;
  topKmh: number;
  straightSlipDeg: number;
  straightYawRadS: number;
  straightDriftM: number;
  /** From `brakeFromKmh` to a stop with ABS: the distance (m), mean deceleration (g) and the most body slip (deg) */
  brakeFromKmh: number;
  brakeM: number;
  brakeG: number;
  brakeSlipDeg: number;
  /** An autopilot lap of RISE, when its files are here */
  lap?: { done: boolean; lapS: number; maxSlipDeg: number; beyondM: number; topKmh: number };
}

/**
 * The profile driven headless: flat out from rest on a flat pad for 60 s with the wheel held straight, the driver easing
 * off the throttle while the driven wheels spin past 15 % (no spin: under 6 deg of body slip and 0.3 rad/s of yaw, a
 * twitch at a shift but no more; a top speed of 80–450 km/h and 0–100 km/h in 1.5–30 s), braked to a stop with ABS
 * from 200 km/h or 90 % of its top speed (0.4–4 g, under 10 deg of slip), then, with `lap`, an autopilot lap of RISE
 */
export async function driveCheck(profile: CarSimProfile, opts: { lap?: boolean } = {}): Promise<DriveCheck> {
  const { F12026CarSim } = await import('../../src/lib/sim/f12026-car/F12026CarSim');
  const { createFlatTestTrack } = await import('../lib/flat-track');
  const DT = 1 / 120;
  const pad = createFlatTestTrack(30_000, 3000);
  const slipDeg = (sim: { vyMs: number; vxMs: number }) => (Math.abs(Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)))) * 180) / Math.PI;

  // Flat out, the driver easing off while the driven wheels spin past 15 % (no aid of the car's: its physics alone)
  const run = new F12026CarSim(pad, null, profile);
  run.assistPreset = 'pro';
  run.teleportToDistance(1000, 0);
  let pedal = 1;
  let t100 = NaN;
  let top = 0;
  let straightSlip = 0;
  let straightYaw = 0;
  let drift = 0;
  for (let t = 0; t < 60; t += DT) {
    const spin = Math.max(...run.telemetry.wheelSlipRatios);
    pedal = Math.min(1, Math.max(0.25, pedal + (spin > 0.15 ? -6 : 3) * DT));
    run.step(DT, { throttle: pedal });
    const v = run.telemetry.speedKmh;
    top = Math.max(top, v);
    if (Number.isNaN(t100) && v >= 100) t100 = t;
    if (v > 20) {
      straightSlip = Math.max(straightSlip, slipDeg(run));
      straightYaw = Math.max(straightYaw, Math.abs(run.yawRateRadS));
    }
    drift = Math.max(drift, Math.abs(run.lateralOffsetM));
  }
  const from = Math.min(200, Math.round(0.9 * top));
  const stop = new F12026CarSim(pad, null, profile);
  stop.assistPreset = 'semi_pro';
  stop.teleportToDistance(1000, from / 3.6);
  const s0 = stop.sMeters;
  let tStop = 0;
  let brakeSlip = 0;
  for (; tStop < 20 && stop.telemetry.speedKmh > 1; tStop += DT) {
    stop.step(DT, { brake: 1 });
    if (stop.telemetry.speedKmh > 10) brakeSlip = Math.max(brakeSlip, slipDeg(stop));
  }
  const brakeM = stop.sMeters - s0;
  const brakeG = (from / 3.6) ** 2 / (2 * Math.max(0.1, brakeM)) / G;
  const problems: string[] = [];
  if (straightSlip > 6) problems.push(`it slides ${straightSlip.toFixed(1)} deg sideways flat out on a straight`);
  if (straightYaw > 0.3) problems.push(`it yaws at ${straightYaw.toFixed(2)} rad/s flat out on a straight`);
  if (!(top >= 80 && top <= 450)) problems.push(`a top speed of ${top.toFixed(0)} km/h`);
  if (!(t100 >= 1.5 && t100 <= 30)) problems.push(Number.isNaN(t100) ? 'it never reaches 100 km/h' : `0–100 km/h in ${t100.toFixed(1)} s`);
  if (!(brakeG >= 0.4 && brakeG <= 4)) problems.push(`it brakes from ${from} km/h at ${brakeG.toFixed(2)} g`);
  if (brakeSlip > 10) problems.push(`it slides ${brakeSlip.toFixed(1)} deg sideways under braking`);

  const out: DriveCheck = { ok: false, problems, t100, topKmh: top, straightSlipDeg: straightSlip, straightYawRadS: straightYaw, straightDriftM: drift, brakeFromKmh: from, brakeM, brakeG, brakeSlipDeg: brakeSlip };
  const rise = join(__dirname, '..', '..', 'public', 'tracks', 'rwanda_official', 'rwanda_official.glb');
  if (opts.lap && existsSync(rise)) {
    const { getActiveTrackData } = await import('../../src/lib/track-data');
    const { loadGlbGeometry } = await import('../lib/glb-geometry');
    const track = getActiveTrackData();
    const sim = new F12026CarSim(track, loadGlbGeometry(rise), profile);
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    sim.aiPaceScale = 1;
    const lap0 = sim.telemetry.lapCount;
    let maxSlip = 0;
    let beyond = -Infinity;
    for (let t = 0; t < 300 && sim.telemetry.lapCount < lap0 + 2; t += 1 / 60) {
      sim.step(1 / 60, {});
      if (sim.telemetry.speedKmh > 20) maxSlip = Math.max(maxSlip, slipDeg(sim));
      beyond = Math.max(beyond, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
    }
    const done = sim.telemetry.lapCount >= lap0 + 2;
    out.lap = { done, lapS: (sim.telemetry.lastLapTimeMs ?? 0) / 1000, maxSlipDeg: maxSlip, beyondM: Math.max(0, beyond), topKmh: sim.telemetry.allTimeTopSpeedKmh };
    if (!done) problems.push('the autopilot did not finish a lap of RISE');
    else if (maxSlip > 25) problems.push(`it slid ${maxSlip.toFixed(0)} deg sideways on its autopilot lap of RISE`);
  }
  out.ok = problems.length === 0;
  return out;
}

/** The mapping as a table, for the terminal */
export function mappingTable(p: AcPhysicsPatch): string {
  const short = (v: unknown) => {
    const s = JSON.stringify(v);
    return s.length > 48 ? `${s.slice(0, 45)}…` : s;
  };
  const rows = p.mapped.map((v) => `  ${v.path.padEnd(64)} ${short(v.value).padEnd(50)} ← ${v.from}`);
  const left = p.unmapped.map((u) => `  ${u.from}: ${u.why}`);
  return [`Mapped (${p.mapped.length}):`, ...rows, '', `Not mapped (${p.unmapped.length}):`, ...left].join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: 'string' }, out: { type: 'string' }, drive: { type: 'boolean' }, lap: { type: 'boolean' } } });
  const dir = positionals[0];
  if (!dir) {
    console.error('usage: npx tsx scripts/cars/ac-physics-patch.ts <car or data folder> [--base <model>] [--out physics.json] [--drive] [--lap]');
    process.exit(1);
  }
  const p = acPhysicsPatch(dir, { base: values.base as VehicleModelId | undefined });
  console.log(`Base: ${p.base} (${p.why})\n`);
  console.log(mappingTable(p));
  if (values.out) {
    writeFileSync(values.out, `${JSON.stringify(p.file, null, 2)}\n`);
    console.log(`\nwrote ${values.out}`);
  }
  if (values.drive || values.lap) {
    const d = await driveCheck(p.profile, { lap: values.lap });
    console.log(`\nDrive: 0–100 ${d.t100.toFixed(2)} s, top ${d.topKmh.toFixed(0)} km/h, slip ${d.straightSlipDeg.toFixed(1)} deg, yaw ${d.straightYawRadS.toFixed(3)} rad/s; ${d.brakeFromKmh}→0 in ${d.brakeM.toFixed(1)} m (${d.brakeG.toFixed(2)} g)` + (d.lap ? `; RISE lap ${d.lap.lapS.toFixed(2)} s, top ${d.lap.topKmh.toFixed(0)} km/h, slip ${d.lap.maxSlipDeg.toFixed(1)} deg` : ''));
    console.log(d.ok ? 'Drives sanely.' : `Problems: ${d.problems.join('; ')}`);
  }
}

// Run as a command (its source, or its bundle in the launcher's converter), not imported: `require.main` is CommonJS's
// alone, and the converter's bundles are ES modules
if (/[\\/]ac-physics-patch\.(ts|mjs)$/.test(process.argv[1] ?? "")) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
