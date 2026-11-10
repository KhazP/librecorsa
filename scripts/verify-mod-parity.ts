/**
 * Each car's config against the mod data it was taken from: every value a config tags as taken from its source equals
 * what the source's files say, read in the source's own units and converted here.
 *
 *   npx tsx scripts/verify-mod-parity.ts
 *
 * The data folders are local reference material (`REALISM_REF`, see `scripts/lib/mod-data.ts`), not part of the
 * repository: a car whose folder is absent is skipped with a note, so the suite passes in a clone and in CI.
 *
 * Where a config departs from its source on purpose (a value fitted to telemetry, a model this sim has and the source
 * doesn't), the key is left out of that car's list here and the reason is in the config.
 */
import { compoundData, F12026_CAR_CONFIG, type CarPhysicsConfig, type TyreGeometry, type TyresCompoundData } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { modBodyHeightM, modCornerStops, type ModCornerStops } from '../src/lib/sim/mod-suspension';
import { MTR_496R_CONFIG, MTR_496R_ELECTRONICS } from '../src/lib/sim/proto/Mtr496rConfig';
import { SUZUKI_LIANA_CONFIG, SUZUKI_LIANA_ELECTRONICS } from '../src/lib/sim/road/SuzukiLianaConfig';
import { lutAt, lutGap, modDir, ModData, type Lut } from './lib/mod-data';

const failures: string[] = [];
let checks = 0;
const fmt = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : String(v));
/** `ours` equals `theirs` within `tol` (relative, or absolute for values near zero) */
function eq(name: string, ours: number, theirs: number, tol = 1e-6): void {
  checks++;
  const ok = Number.isFinite(ours) && Number.isFinite(theirs) && Math.abs(ours - theirs) <= tol * Math.max(1, Math.abs(theirs));
  if (!ok) {
    failures.push(name);
    console.log(`FAIL  ${name.padEnd(62)} ours ${fmt(ours)}, source ${fmt(theirs)}`);
  }
}
/** Two tables agree within `tol` over the range both cover */
function sameCurve(name: string, ours: Lut, theirs: Lut, tol: number): void {
  checks++;
  const gap = lutGap(ours, theirs);
  if (!(gap <= tol)) {
    failures.push(name);
    console.log(`FAIL  ${name.padEnd(62)} tables differ by ${fmt(gap)} (${ours.length} vs ${theirs.length} points)`);
  }
}
const scale = (lut: Lut, k: number): Lut => lut.map(([x, y]) => [x, y * k]);
const upTo = (lut: Lut, xMax: number): Lut => lut.filter(([x]) => x <= xMax);
const G = 9.81;

function section(title: string, id: string, run: (mod: ModData) => void, wholeSource = true): void {
  const mod = new ModData(modDir(id));
  if (!mod.present) {
    console.log(`SKIP  ${title}: its source data isn't on this machine (${id})`);
    return;
  }
  const before = failures.length;
  const from = checks;
  run(mod);
  console.log(`${failures.length === before ? 'PASS' : 'FAIL'}  ${title}: ${checks - from} values against the source`);
  if (wholeSource && process.argv.includes('--unread')) listUnread(mod);
}

const PHYSICS_FILES = ['car.ini', 'suspensions.ini', 'tyres.ini', 'drivetrain.ini', 'engine.ini', 'brakes.ini', 'aero.ini', 'electronics.ini'];

/** Sections and keys with no physics in them (names, graphics, pit stops, damage, debug) */
const NOT_PHYSICS_SECTION = /^(HEADER|INFO|GRAPHICS|GRAPHICS_OFFSETS|DISCS_GRAPHICS|PIT_STOP|RULES|DAMAGE|COMPOUND_DEFAULT|_EXTENSION|EXPLOSION)$/;
const NOT_PHYSICS_KEY = /^(NAME|SHORT_NAME|TYPE_HINT|GRAPHICS_.*|DEBUG.*|COCKPIT_ADJUSTABLE|SUPPORTS_SHIFTER|PRESENT|ACTIVE|WEAR_CURVE|PERFORMANCE_CURVE)$/;

/**
 * Source keys no check reads, and why the config does not carry them, matched on `file [SECTION] KEY` (a compound's
 * `_1`, `_2` sections count as one). Anything the source has that is neither checked nor listed here prints as
 * unexplained: a key to carry, or to add here with its reason.
 */
const NOT_CARRIED: [RegExp, string][] = [
  [/^tyres\.ini \[THERMAL_(FRONT|REAR)\] /, "tyre heat flow: this sim's own thermal model, not yet fitted to these"],
  [/^tyres\.ini \[(FRONT|REAR)\] (DY0|DY1|DX0|DX1|DY_REF|DX_REF)$/, 'replaced by the load curves the data also gives'],
  [/^tyres\.ini \[(FRONT|REAR)\] (FLEX|XMU)$/, 'not read by this tyre data version, or carried in a derived form (the Liana: peak angle against load)'],
  [/^tyres\.ini \[(FRONT|REAR)\] DCAMBER_LUT(_SMOOTH)?$/, "names a table that isn't in the data; the camber terms stand in"],
  [/^tyres\.ini \[(FRONT|REAR)\] PRESSURE_FLEX_GAIN$/, 'not carried for this tyre data version (the Liana)'],
  [/^tyres\.ini \[(FRONT|REAR)\] (ANGULAR_INERTIA|ROLLING_RESISTANCE_[01]|ROLLING_RESISTANCE_SLIP|PRESSURE_RR_GAIN|RADIUS_ANGULAR_K|BRAKE_DX_MOD)$/, "taken from another data set or this sim's own (f12026 tyres, the other compounds' wheels)"],
  [/^tyres\.ini \[(FRONT|REAR)\] (CAMBER_SPRING_MULT|ROLLING_RADIUS_MULT|RADIUS_ANGULAR_K_2|DX_CAMBER_REF|DX_CAMBER_MULT|DROPOFF_FACTOR_.)$/, "an extension's tyre terms: not modelled"],
  [/^tyres\.ini \[(VIRTUALKM|ADDITIONAL1|THERMAL_MODEL)\] /, 'wear by load and blanket settings: not carried'],
  [/^car\.ini \[CONTROLS\] (FFMULT|STEER_ASSIST)$/, "force feedback scaling: this sim's own"],
  [/^car\.ini \[CONTROLS\] LINEAR_STEER_ROD_RATIO$/, 'rack travel: steering is by road-wheel angle (STEER_LOCK / STEER_RATIO) on the solved geometry'],
  [/^car\.ini \[FUEL\] /, "fuel load and use: the sim's own (car-setup)"],
  [/^suspensions\.ini \[(FRONT|REAR)\] (TYPE|RIM_OFFSET)$/, 'the config states the suspension type itself; rim offset is graphics'],
  [/^suspensions\.ini \[(FRONT|REAR)\] TOE_OUT$/, 'static toe is a setup value here (the data gives a rod length, not an angle): not converted'],
  [/^suspensions\.ini \[(FRONT|REAR)\] WBTYRE_BOTTOM$/, "a strut's lower ball joint is STRUT_TYRE"],
  [/^suspensions\.ini \[HEAVE_(FRONT|REAR)\] BUMPSTOP_DN$/, 'no droop stop on a heave element'],
  [/^suspensions\.ini \[HEAVE_(FRONT|REAR)\] BUMP_STOP_RATE$/, "the element's packers lie past its own bump stop, which is rigid"],
  [/^drivetrain\.ini \[GEARS\] GEAR_7$/, 'past the gear count: unused'],
  [/^drivetrain\.ini \[GEARBOX\] (CHANGE_UP_TIME|AUTO_CUTOFF_TIME)$/, 'one up-shift time: the longer of the change and the ignition cut'],
  [/^drivetrain\.ini \[GEARBOX\] (VALID_SHIFT_RPM_WINDOW|CONTROLS_WINDOW_GAIN)$/, 'H-pattern shift rules: not modelled'],
  [/^drivetrain\.ini \[(AUTOCLUTCH|DOWNSHIFT_PROFILE|AUTOBLIP|DOWNSHIFT_PROTECTION|AUTO_SHIFTER|TRACTION)\] /, "clutch, blip and auto-shift timing: this sim's own gearbox logic"],
  [/^engine\.ini \[ENGINE_DATA\] (ALTITUDE_SENSITIVITY|AMBIENT_EFFECT)$/, "air density acts on the engine through this sim's own weather"],
  [/^engine\.ini \[(COAST_REF|COAST_DATA|COAST_CURVE)\] /, 'the overrun torque is the reference line (COAST_REF) alone'],
  [/^brakes\.ini \[TEMPS_(FRONT|REAR)\] /, "brake heat: this sim's own disc model by material"],
  [/^brakes\.ini \[DATA\] (HANDBRAKE_TORQUE|ADJUST_STEP)$/, 'no handbrake or bias adjuster on this car'],
  [/^aero\.ini \[WING_\d+\] ZONE_/, 'slipstream and damage zones: not modelled per element'],
  [/^aero\.ini \[(WING_0|FIN_0|WING_1)\] /, 'the body (and the Liana\'s boot) as constant drag and lift; the 496R\'s fin has no tables'],
  [/^electronics\.ini \[(ABS|TRACTION_CONTROL)\] CURVE$/, 'the switch positions are listed in the config'],
  [/^electronics\.ini \[EDL\] /, 'electronic diff lock by the brakes: not modelled'],
];

/** With `--unread`: the source's physics keys this suite never read, grouped by why they are not carried */
function listUnread(mod: ModData): void {
  const byReason = new Map<string, Set<string>>();
  const note = (id: string) => {
    const reason = NOT_CARRIED.find(([re]) => re.test(id))?.[1] ?? 'UNEXPLAINED';
    let set = byReason.get(reason);
    if (!set) byReason.set(reason, (set = new Set()));
    set.add(id);
  };
  // A compound's numbered sections (FRONT_2, THERMAL_REAR_1) are one kind
  const kind = (name: string) => name.replace(/^((?:THERMAL_)?(?:FRONT|REAR))_\d+$/, '$1');
  for (const file of PHYSICS_FILES) {
    if (!mod.has(file)) continue;
    const { keys, sections } = mod.unread(file);
    for (const [name, left] of Object.entries(keys)) {
      if (NOT_PHYSICS_SECTION.test(name)) continue;
      for (const key of left) if (!NOT_PHYSICS_KEY.test(key)) note(`${file} [${kind(name)}] ${key}`);
    }
    // A section never opened: one line for it, unless it is another compound's (a tyre the car here doesn't fit)
    for (const name of sections) {
      if (NOT_PHYSICS_SECTION.test(name) || /^(THERMAL_)?(FRONT|REAR)(_\d+)?$/.test(name)) continue;
      note(`${file} [${name}] *`);
    }
  }
  for (const [reason, ids] of [...byReason].sort(([a], [b]) => (a === 'UNEXPLAINED' ? 1 : b === 'UNEXPLAINED' ? -1 : a.localeCompare(b)))) {
    console.log(`        ${reason}:`);
    console.log(`          ${[...ids].map((id) => id.replace(/\.ini/, '')).join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Parts shared by the cars
// ---------------------------------------------------------------------------

/** A compound's data for one axle: the front's, with the rear's overrides on top */
function axleTyre(compound: TyresCompoundData, axle: 'front' | 'rear') {
  const rear = axle === 'rear' ? compound.rearOverride : undefined;
  return {
    geometry: compound[axle] as TyreGeometry,
    model: { ...compound.modelData, ...rear?.modelData },
    camber: { ...compound.camberData, ...rear?.camberData },
    pressure: { ...compound.pressureData, ...rear?.pressureData },
    thermal: compound.thermalData,
    wear: compound.wear,
  };
}
type AxleTyre = ReturnType<typeof axleTyre>;

/** tyres.ini keys → what the config holds for them */
const TYRE_KEYS: Record<string, (t: AxleTyre) => number | undefined> = {
  WIDTH: (t) => t.geometry.width,
  RADIUS: (t) => t.geometry.radius,
  RIM_RADIUS: (t) => t.geometry.rimRadius,
  DAMP: (t) => t.model.verticalDamping,
  FRICTION_LIMIT_ANGLE: (t) => t.model.friction_limit_angle,
  FLEX_GAIN: (t) => t.model.peakSlipLoadGain,
  PRESSURE_FLEX_GAIN: (t) => t.model.peakSlipPressureGain,
  COMBINED_FACTOR: (t) => t.model.combinedExponent,
  CX_MULT: (t) => t.model.longStiffnessMult,
  SPEED_SENSITIVITY: (t) => t.model.speedSensitivity,
  XMU: (t) => t.model.curveFullness,
  FALLOFF_LEVEL: (t) => t.model.falloff_level,
  FALLOFF_SPEED: (t) => t.model.falloff_slope,
  RELAXATION_LENGTH: (t) => t.model.relaxationLengthY,
  // Newtons per kN of load, and per kN per (m/s)²
  ROLLING_RESISTANCE_0: (t) => t.model.rollingResistance * 1000,
  ROLLING_RESISTANCE_1: (t) => (t.model.rollingResistanceSpeedSq ?? 0) * 1000,
  CAMBER_GAIN: (t) => t.camber.camberGain,
  DCAMBER_0: (t) => t.camber.dcamber0,
  DCAMBER_1: (t) => t.camber.dcamber1,
  PRESSURE_IDEAL: (t) => t.pressure.optimalPsi,
  PRESSURE_D_GAIN: (t) => t.pressure.pressureGripLossPerPsi,
  FZ0: (t) => t.model.Fz0,
  LS_EXPY: (t) => t.model.lsExpY,
  LS_EXPX: (t) => t.model.lsExpX,
  BRAKE_DX_MOD: (t) => t.model.brakeDxMod,
  // Millimetres of radius per rad/s of spin
  RADIUS_ANGULAR_K: (t) => (t.geometry.radiusGrowthPerRadS ?? NaN) * 1000,
  // Thousandths of the free-rolling drag per unit of slip over the peak slip
  ROLLING_RESISTANCE_SLIP: (t) => (t.model.rollingResistanceSlipGain ?? NaN) * 1000,
  PRESSURE_RR_GAIN: (t) => t.pressure.pressureRollingGain,
};

interface TyreCheck {
  /** tyres.ini section (`FRONT`, `REAR_2`, …) and its thermal section */
  sectionName: string;
  thermalName: string;
  keys: string[];
  /** Tables to compare: load curves up to this load (N), the radial rate, wear, temperature, the tread's gains */
  loadCurvesToN?: number;
  rate?: boolean;
  wear?: boolean;
  thermalCurve?: boolean;
  tread?: boolean;
}

function checkTyre(label: string, mod: ModData, tyre: AxleTyre, c: TyreCheck): void {
  const num = (key: string) => mod.num('tyres.ini', c.sectionName, key);
  for (const key of c.keys) eq(`${label} ${key}`, TYRE_KEYS[key](tyre) ?? NaN, num(key));
  if (c.loadCurvesToN) {
    sameCurve(`${label} DY_CURVE`, upTo(tyre.model.dyCurve ?? [], c.loadCurvesToN), mod.lutOf('tyres.ini', c.sectionName, 'DY_CURVE'), 1e-3);
    sameCurve(`${label} DX_CURVE`, upTo(tyre.model.dxCurve ?? [], c.loadCurvesToN), mod.lutOf('tyres.ini', c.sectionName, 'DX_CURVE'), 1e-3);
  }
  if (c.rate) {
    // RATE at the static pressure, growing by PRESSURE_SPRING_GAIN per psi
    const scaleRate = tyre.geometry.verticalRateScale ?? 1;
    for (const psi of [num('PRESSURE_STATIC'), num('PRESSURE_IDEAL')])
      eq(`${label} RATE at ${psi} psi`, lutAt(tyre.pressure.pressureSpringCurve, psi) * scaleRate, num('RATE') + num('PRESSURE_SPRING_GAIN') * (psi - num('PRESSURE_STATIC')), 1e-3);
  }
  if (c.wear) sameCurve(`${label} WEAR_CURVE`, tyre.wear?.curve ?? [], mod.lutOf('tyres.ini', c.sectionName, 'WEAR_CURVE'), 0.05);
  if (c.thermalCurve) sameCurve(`${label} PERFORMANCE_CURVE`, tyre.thermal.thermalPerformanceCurve, mod.lutOf('tyres.ini', c.thermalName, 'PERFORMANCE_CURVE'), 1e-3);
  if (c.tread) {
    const t = (key: string) => mod.num('tyres.ini', c.thermalName, key);
    eq(`${label} GRAIN_GAIN`, tyre.thermal.tread?.grainGain ?? NaN, t('GRAIN_GAIN'));
    eq(`${label} GRAIN_GAMMA`, tyre.thermal.tread?.grainGamma ?? NaN, t('GRAIN_GAMMA'));
    eq(`${label} BLISTER_GAIN`, tyre.thermal.tread?.blisterGain ?? NaN, t('BLISTER_GAIN'));
    eq(`${label} BLISTER_GAMMA`, tyre.thermal.tread?.blisterGamma ?? NaN, t('BLISTER_GAMMA'));
  }
}

/** Mass, inertia box, steering, wheelbase, tracks, hub masses, weight split */
function checkChassis(label: string, mod: ModData, config: CarPhysicsConfig): void {
  const ch = config.chassis;
  const mass = mod.num('car.ini', 'BASIC', 'TOTALMASS');
  eq(`${label} TOTALMASS`, ch.totalMassKg, mass);
  const [w, h, l] = mod.vec('car.ini', 'BASIC', 'INERTIA');
  const box = (a: number, b: number) => (mass / 12) * (a * a + b * b);
  eq(`${label} INERTIA pitch`, ch.inertia.pitch, box(h, l));
  eq(`${label} INERTIA roll`, ch.inertia.roll, box(w, h));
  eq(`${label} INERTIA yaw`, ch.inertia.yaw, box(w, l));
  eq(`${label} STEER_LOCK / STEER_RATIO`, ch.maxRoadWheelDeg, mod.num('car.ini', 'CONTROLS', 'STEER_LOCK') / mod.num('car.ini', 'CONTROLS', 'STEER_RATIO'));
  const s = (sec: string, key: string) => mod.num('suspensions.ini', sec, key);
  eq(`${label} WHEELBASE`, ch.wheelbase, s('BASIC', 'WHEELBASE'));
  eq(`${label} CG_LOCATION`, ch.frontWeightFraction, s('BASIC', 'CG_LOCATION'));
  eq(`${label} TRACK front`, ch.trackWidthFront, s('FRONT', 'TRACK'));
  eq(`${label} TRACK rear`, ch.trackWidthRear, s('REAR', 'TRACK'));
  eq(`${label} HUB_MASS front`, ch.unsprungMassFront, s('FRONT', 'HUB_MASS'));
  eq(`${label} HUB_MASS rear`, ch.unsprungMassRear, s('REAR', 'HUB_MASS'));
  const tank = mod.vec('car.ini', 'FUELTANK', 'POSITION');
  eq(`${label} FUELTANK POSITION y`, ch.fuelTank?.y ?? NaN, tank[1]);
  eq(`${label} FUELTANK POSITION z`, ch.fuelTank?.z ?? NaN, tank[2]);
  eq(`${label} ANGULAR_INERTIA front`, ch.wheelInertiaFront, mod.num('tyres.ini', 'FRONT', 'ANGULAR_INERTIA'));
  eq(`${label} ANGULAR_INERTIA rear`, ch.wheelInertiaRear, mod.num('tyres.ini', 'REAR', 'ANGULAR_INERTIA'));
}

/** Rate of a stop the source data gives no rate for: a strut's or a heave element's own bump stop (N/m) */
const RIGID_STOP_RATE = 500_000;

const HARDPOINT_KEYS = ['WBCAR_TOP_FRONT', 'WBCAR_TOP_REAR', 'WBCAR_BOTTOM_FRONT', 'WBCAR_BOTTOM_REAR', 'WBTYRE_TOP', 'WBTYRE_BOTTOM', 'WBCAR_STEER', 'WBTYRE_STEER'];

/** The stops of an axle from static ride, as the source's design-position data gives them */
function sourceStops(mod: ModData, axle: 'FRONT' | 'REAR'): ModCornerStops {
  const s = (sec: string, key: string) => mod.num('suspensions.ini', sec, key);
  const sprungKg = mod.num('car.ini', 'BASIC', 'TOTALMASS') - 2 * s('FRONT', 'HUB_MASS') - 2 * s('REAR', 'HUB_MASS');
  const front = s('BASIC', 'CG_LOCATION');
  const heave = `HEAVE_${axle}`;
  const hasHeave = Number.isFinite(s(heave, 'SPRING_RATE'));
  return modCornerStops({
    staticLoadN: (sprungKg * G * (axle === 'FRONT' ? front : 1 - front)) / 2,
    springRate: s(axle, 'SPRING_RATE'),
    rodLength: s(axle, 'ROD_LENGTH'),
    packerRange: s(axle, 'PACKER_RANGE'),
    bumpStopUp: s(axle, 'BUMPSTOP_UP'),
    bumpStopDn: s(axle, 'BUMPSTOP_DN'),
    heave: hasHeave ? { springRate: s(heave, 'SPRING_RATE'), rodLength: s(heave, 'ROD_LENGTH'), packerRange: s(heave, 'PACKER_RANGE'), bumpStopUp: s(heave, 'BUMPSTOP_UP') } : undefined,
  });
}

/** Springs, bars, dampers, hardpoints, stops (from static ride) and the CG height they put the body at */
function checkSuspension(label: string, mod: ModData, config: CarPhysicsConfig, opts: { hardpoints: { front: number[]; rear: number[] }; strutFront?: boolean }): void {
  const s = (sec: string, key: string) => mod.num('suspensions.ini', sec, key);
  const stops = { FRONT: sourceStops(mod, 'FRONT'), REAR: sourceStops(mod, 'REAR') };
  for (const axle of ['FRONT', 'REAR'] as const) {
    const lower = axle === 'FRONT' ? 'front' : 'rear';
    const sus = config.suspensions[lower];
    const damp = config.suspensions.dampers_controller[lower];
    const name = `${label} ${lower}`;
    eq(`${name} STATIC_CAMBER`, sus.staticCamber, s(axle, 'STATIC_CAMBER'));
    eq(`${name} SPRING_RATE`, sus.springs.wheel_rate, s(axle, 'SPRING_RATE'));
    eq(`${label} ARB ${lower}`, sus.arb, s('ARB', axle));
    eq(`${name} DAMP_BUMP`, damp.base.slow_bump, s(axle, 'DAMP_BUMP'));
    eq(`${name} DAMP_FAST_BUMP`, damp.base.fast_bump, s(axle, 'DAMP_FAST_BUMP'));
    eq(`${name} DAMP_REBOUND`, damp.base.slow_rebound, s(axle, 'DAMP_REBOUND'));
    eq(`${name} DAMP_FAST_REBOUND`, damp.base.fast_rebound, s(axle, 'DAMP_FAST_REBOUND'));
    eq(`${name} DAMP_FAST_BUMPTHRESHOLD`, damp.fastThresholdMs ?? NaN, s(axle, 'DAMP_FAST_BUMPTHRESHOLD'));
    eq(`${name} DAMP_FAST_REBOUNDTHRESHOLD`, damp.fastReboundThresholdMs ?? NaN, s(axle, 'DAMP_FAST_REBOUNDTHRESHOLD'));

    // Packers and bump stop from static ride: the nearer is the config's first stop, the farther its second
    const st = stops[axle];
    const near = Math.min(st.packerGapM, st.bumpStopGapM);
    const far = Math.max(st.packerGapM, st.bumpStopGapM);
    eq(`${name} first stop from static ride`, sus.bumpStop.range, near, 1e-4);
    if (sus.bumpStop.hardStop) eq(`${name} second stop from static ride`, sus.bumpStop.hardStop.range, far, 1e-4);
    eq(`${name} droop from static ride`, sus.droopTravel, st.droopM, 1e-4);
    // The packers work at BUMP_STOP_RATE, and so does a wishbone corner's bump stop (a strut's is rigid); where the two
    // meet at the same travel their rates add
    const packerRate = s(axle, 'BUMP_STOP_RATE');
    const stopRate = opts.strutFront && axle === 'FRONT' ? RIGID_STOP_RATE : packerRate;
    const together = Math.abs(st.packerGapM - st.bumpStopGapM) < 1e-4;
    const packerFirst = st.packerGapM <= st.bumpStopGapM;
    eq(`${name} BUMP_STOP_RATE at the first stop`, sus.bumpStop.rate, together ? packerRate + stopRate : packerFirst ? packerRate : stopRate);
    if (sus.bumpStop.hardStop) eq(`${name} BUMP_STOP_RATE at the second stop`, sus.bumpStop.hardStop.rate, packerFirst ? stopRate : packerRate);
    // This model's corner springs are linear
    eq(`${name} PROGRESSIVE_SPRING_RATE`, 0, s(axle, 'PROGRESSIVE_SPRING_RATE'));

    const heave = `HEAVE_${axle}`;
    if (Number.isFinite(s(heave, 'SPRING_RATE'))) {
      eq(`${name} heave SPRING_RATE`, sus.heave.rate, s(heave, 'SPRING_RATE'));
      eq(`${name} heave PROGRESSIVE_SPRING_RATE`, sus.heave.progressiveRate ?? 0, s(heave, 'PROGRESSIVE_SPRING_RATE'));
      eq(`${name} heave first stop from static ride`, sus.heave.packerGap, Math.min(st.heavePackerGapM, st.heaveBumpStopGapM), 1e-4);
      // A heave element's packers work at its BUMP_STOP_RATE; its own bump stop is rigid
      eq(`${name} heave BUMP_STOP_RATE at the first stop`, sus.heave.packerRate, st.heavePackerGapM <= st.heaveBumpStopGapM ? s(heave, 'BUMP_STOP_RATE') : RIGID_STOP_RATE);
      eq(`${name} heave DAMP_BUMP`, damp.heave.slow_bump, s(heave, 'DAMP_BUMP'));
      eq(`${name} heave DAMP_FAST_BUMP`, damp.heave.fast_bump, s(heave, 'DAMP_FAST_BUMP'));
      eq(`${name} heave DAMP_REBOUND`, damp.heave.slow_rebound, s(heave, 'DAMP_REBOUND'));
      eq(`${name} heave DAMP_FAST_REBOUND`, damp.heave.fast_rebound, s(heave, 'DAMP_FAST_REBOUND'));
      eq(`${name} heave DAMP_FAST_BUMPTHRESHOLD`, damp.heaveFastThresholdMs ?? NaN, s(heave, 'DAMP_FAST_BUMPTHRESHOLD'));
      eq(`${name} heave DAMP_FAST_REBOUNDTHRESHOLD`, damp.heaveFastReboundThresholdMs ?? NaN, s(heave, 'DAMP_FAST_REBOUNDTHRESHOLD'));
    }

    for (const i of opts.hardpoints[lower]) {
      const key = opts.strutFront && axle === 'FRONT' && i === 4 ? 'STRUT_CAR' : opts.strutFront && axle === 'FRONT' && i === 5 ? 'STRUT_TYRE' : HARDPOINT_KEYS[i];
      const theirs = mod.vec('suspensions.ini', axle, key);
      const ours = sus.hardpoints?.[i] ?? [NaN, NaN, NaN];
      for (let k = 0; k < 3; k++) eq(`${name} ${key}[${k}]`, ours[k], theirs[k]);
    }
  }

  // CG height: at each axle the tyre's loaded radius (at its ideal pressure) less the wheel centre's height in the body
  // frame, BASEY + the static offset; the CG is the weight split along between
  const bodyHeight = (axle: 'FRONT' | 'REAR') => {
    const t = (key: string) => mod.num('tyres.ini', axle, key);
    const rate = t('RATE') + t('PRESSURE_SPRING_GAIN') * (t('PRESSURE_IDEAL') - t('PRESSURE_STATIC'));
    const sprungKg = mod.num('car.ini', 'BASIC', 'TOTALMASS') - 2 * s('FRONT', 'HUB_MASS') - 2 * s('REAR', 'HUB_MASS');
    const share = axle === 'FRONT' ? s('BASIC', 'CG_LOCATION') : 1 - s('BASIC', 'CG_LOCATION');
    const cornerN = (sprungKg * G * share) / 2 + s(axle, 'HUB_MASS') * G;
    return modBodyHeightM(t('RADIUS'), cornerN / rate, s(axle, 'BASEY'), stops[axle].staticOffsetM);
  };
  const front = bodyHeight('FRONT');
  const rear = bodyHeight('REAR');
  eq(`${label} CG height`, config.chassis.cgHeight, front + (rear - front) * (1 - s('BASIC', 'CG_LOCATION')), 1e-4);
  eq(`${label} PICKUP_FRONT_HEIGHT`, config.aero.front_target_height, front + mod.num('car.ini', 'RIDE', 'PICKUP_FRONT_HEIGHT'), 1e-4);
  eq(`${label} PICKUP_REAR_HEIGHT`, config.aero.rear_target_height, rear + mod.num('car.ini', 'RIDE', 'PICKUP_REAR_HEIGHT'), 1e-4);
}

/** Engine, gearbox, clutch, differential, brakes */
function checkDriveline(label: string, mod: ModData, config: CarPhysicsConfig): void {
  const e = (sec: string, key: string) => mod.num('engine.ini', sec, key);
  const d = (sec: string, key: string) => mod.num('drivetrain.ini', sec, key);
  // power.lut is torque at the wheels' side of the driveline: the config's crank power × its efficiency, as torque
  const power = mod.lut('power.lut');
  let worst = 0;
  for (const [rpm, nm] of power) {
    if (rpm <= 0 || rpm > e('ENGINE_DATA', 'LIMITER')) continue;
    const ours = ((lutAt(config.engine.powerCurve, rpm) * 1000 * 30) / (Math.PI * rpm)) * config.gearbox.efficiency;
    worst = Math.max(worst, Math.abs(ours - nm) / Math.max(1, nm));
  }
  eq(`${label} power.lut (worst point, relative)`, worst, 0, 2e-3);
  eq(`${label} engine MINIMUM`, config.engine.idleRpm, e('ENGINE_DATA', 'MINIMUM'));
  eq(`${label} engine LIMITER`, config.gearbox.gears.redline_rpm, e('ENGINE_DATA', 'LIMITER'));
  eq(`${label} engine + gearbox INERTIA`, config.engine.inertia, e('ENGINE_DATA', 'INERTIA') + d('GEARBOX', 'INERTIA'));
  eq(`${label} LIMITER_HZ`, config.engine.limiterCutS ?? NaN, 0.5 / e('ENGINE_DATA', 'LIMITER_HZ'));
  eq(`${label} COAST_REF`, lutAt(config.engine.coastCurve, e('COAST_REF', 'RPM')), e('COAST_REF', 'TORQUE'));
  const count = d('GEARS', 'COUNT');
  eq(`${label} gear COUNT`, config.gearbox.ratios.length, count);
  for (let g = 1; g <= count; g++) eq(`${label} GEAR_${g}`, config.gearbox.ratios[g - 1], d('GEARS', `GEAR_${g}`));
  eq(`${label} GEAR_R`, config.gearbox.reverse, Math.abs(d('GEARS', 'GEAR_R')));
  eq(`${label} FINAL`, config.gearbox.finalDrive, d('GEARS', 'FINAL'));
  const diff = config.differential.settings;
  eq(`${label} diff POWER`, diff.power, d('DIFFERENTIAL', 'POWER'));
  eq(`${label} diff COAST`, diff.coast, d('DIFFERENTIAL', 'COAST'));
  eq(`${label} diff PRELOAD`, diff.preload, d('DIFFERENTIAL', 'PRELOAD'));
  eq(`${label} clutch MAX_TORQUE`, config.clutch.maxTorqueNm, d('CLUTCH', 'MAX_TORQUE'));
  eq(`${label} autoclutch MIN_RPM`, config.clutch.biteRpm, d('AUTOCLUTCH', 'MIN_RPM'));
  eq(`${label} autoclutch MAX_RPM`, config.clutch.lockRpm, d('AUTOCLUTCH', 'MAX_RPM'));
  eq(`${label} brake MAX_TORQUE`, config.brakes.maxTorqueNm, mod.num('brakes.ini', 'DATA', 'MAX_TORQUE'));
  eq(`${label} brake FRONT_SHARE`, config.brakes.front_bias, mod.num('brakes.ini', 'DATA', 'FRONT_SHARE'));
}

// ---------------------------------------------------------------------------
// The cars
// ---------------------------------------------------------------------------

const V10_SHAPE = ['FRICTION_LIMIT_ANGLE', 'FLEX_GAIN', 'PRESSURE_FLEX_GAIN', 'COMBINED_FACTOR', 'CX_MULT', 'SPEED_SENSITIVITY', 'FALLOFF_LEVEL', 'FALLOFF_SPEED'];
const ALL = [0, 1, 2, 3, 4, 5, 6, 7];

section('MTR 496R', 'mt_mtr_496r', (mod) => {
  const config = MTR_496R_CONFIG;
  checkChassis('496R', mod, config);
  checkSuspension('496R', mod, config, { hardpoints: { front: ALL, rear: ALL } });
  checkDriveline('496R', mod, config);
  eq('496R AUTO_SHIFTER UP', config.gearbox.gears.upshift_rpm, mod.num('drivetrain.ini', 'AUTO_SHIFTER', 'UP'));
  eq('496R AUTO_SHIFTER DOWN', config.gearbox.gears.downshift_rpm, mod.num('drivetrain.ini', 'AUTO_SHIFTER', 'DOWN'));
  eq('496R AUTO_CUTOFF_TIME', config.gearbox.shiftTimeS, mod.num('drivetrain.ini', 'GEARBOX', 'AUTO_CUTOFF_TIME') / 1000);
  eq('496R CHANGE_DN_TIME', config.gearbox.downshiftTimeS, mod.num('drivetrain.ini', 'GEARBOX', 'CHANGE_DN_TIME') / 1000);
  eq('496R brake ADJUST_STEP', config.brakes.ebbStep, mod.num('brakes.ini', 'DATA', 'ADJUST_STEP') / 100);
  eq('496R TC SLIP_RATIO_LIMIT', MTR_496R_ELECTRONICS.tcDefault, mod.num('electronics.ini', 'TRACTION_CONTROL', 'SLIP_RATIO_LIMIT'));
  eq('496R TC RATE_HZ', MTR_496R_ELECTRONICS.tcRateHz, mod.num('electronics.ini', 'TRACTION_CONTROL', 'RATE_HZ'));
  eq('496R TC MIN_SPEED_KMH', MTR_496R_ELECTRONICS.tcMinSpeedKmh, mod.num('electronics.ini', 'TRACTION_CONTROL', 'MIN_SPEED_KMH'));

  // Slick Soft / Medium / Hard are the first three compounds
  const keys = [...V10_SHAPE, 'WIDTH', 'RADIUS', 'RIM_RADIUS', 'RADIUS_ANGULAR_K', 'DAMP', 'RELAXATION_LENGTH', 'ROLLING_RESISTANCE_0', 'ROLLING_RESISTANCE_1', 'ROLLING_RESISTANCE_SLIP', 'PRESSURE_RR_GAIN', 'CAMBER_GAIN', 'DCAMBER_0', 'DCAMBER_1', 'PRESSURE_IDEAL', 'PRESSURE_D_GAIN', 'FZ0', 'LS_EXPY', 'LS_EXPX', 'BRAKE_DX_MOD'];
  (['soft', 'medium', 'hard'] as const).forEach((slot, i) => {
    const compound = compoundData(config, config.compoundSlots[slot]);
    const suffix = i ? `_${i}` : '';
    for (const axle of ['front', 'rear'] as const) {
      const AX = axle.toUpperCase();
      checkTyre(`496R ${slot} ${axle}`, mod, axleTyre(compound, axle), {
        sectionName: `${AX}${suffix}`,
        thermalName: `THERMAL_${AX}${suffix}`,
        keys,
        loadCurvesToN: 20_000,
        rate: true,
        wear: true,
        thermalCurve: true,
        tread: true,
      });
    }
  });

  // Aero: each element's area (chord × span), position, angle and its tables with their gains folded in. The diffuser's
  // angle tables are moved along by the body's static rake, so only their values are compared.
  const wings: [string, string][] = [['FRONT_WING', 'WING_1'], ['REAR_WING', 'WING_2'], ['VENTURI_FLOOR', 'WING_3']];
  for (const [name, sec] of wings) {
    const wing = config.aero.wings.find((w) => w.name === name);
    const a = (key: string) => mod.num('aero.ini', sec, key);
    if (!wing) {
      eq(`496R ${sec} present`, NaN, 1);
      continue;
    }
    eq(`496R ${sec} CHORD × SPAN`, wing.area, a('CHORD') * a('SPAN'));
    eq(`496R ${sec} POSITION z`, wing.positionZ, mod.vec('aero.ini', sec, 'POSITION')[2]);
    eq(`496R ${sec} ANGLE`, wing.angleDeg, a('ANGLE'));
    const cl = scale(mod.lutOf('aero.ini', sec, 'LUT_AOA_CL'), a('CL_GAIN'));
    const cd = scale(mod.lutOf('aero.ini', sec, 'LUT_AOA_CD'), a('CD_GAIN'));
    if (name === 'VENTURI_FLOOR') {
      wing.lutAOA_CL.forEach(([, y], i) => eq(`496R ${sec} LUT_AOA_CL[${i}]`, y, cl[i]?.[1] ?? NaN, 1e-4));
      wing.lutAOA_CD.forEach(([, y], i) => eq(`496R ${sec} LUT_AOA_CD[${i}]`, y, cd[i]?.[1] ?? NaN, 1e-4));
    } else {
      sameCurve(`496R ${sec} LUT_AOA_CL × CL_GAIN`, wing.lutAOA_CL, cl, 1e-3);
      sameCurve(`496R ${sec} LUT_AOA_CD × CD_GAIN`, wing.lutAOA_CD, cd, 1e-3);
    }
    // 10° of yaw: CL × (1 + YAW_CL_GAIN × the angle in radians)
    eq(`496R ${sec} YAW_CL_GAIN`, lutAt(wing.lutYaw_CL_mult ?? [], 10), 1 + (a('YAW_CL_GAIN') * 10 * Math.PI) / 180, 1e-3);
    // Ground-height tables, read at the element's own height: the config's are moved by the element's height below
    // the ride-height pickup its axle reads (the splitter 4 mm under the front one)
    const drop = name === 'FRONT_WING' ? mod.num('car.ini', 'RIDE', 'PICKUP_FRONT_HEIGHT') - mod.vec('aero.ini', sec, 'POSITION')[1] : 0;
    const shift = (lut: Lut): Lut => lut.map(([x, y]) => [x + drop, y]);
    const ghCl = mod.lutOf('aero.ini', sec, 'LUT_GH_CL');
    const ghCd = mod.lutOf('aero.ini', sec, 'LUT_GH_CD');
    if (ghCl.length) sameCurve(`496R ${sec} LUT_GH_CL`, wing.lutGH_CL_mult, shift(ghCl), 1e-3);
    if (ghCd.length) sameCurve(`496R ${sec} LUT_GH_CD`, wing.lutGH_CD_mult, shift(ghCd), 1e-3);
  }
});

section('Suzuki Liana', 'suzuki_liana', (mod) => {
  const config = SUZUKI_LIANA_CONFIG;
  checkChassis('Liana', mod, config);
  // The front is a strut: its top mount and lower ball joint, the lower arm and the tie rod are the source's; the
  // virtual upper arm is this model's
  checkSuspension('Liana', mod, config, { hardpoints: { front: [2, 3, 4, 5, 6, 7], rear: ALL }, strutFront: true });
  checkDriveline('Liana', mod, config);
  eq('Liana CHANGE_UP_TIME', config.gearbox.shiftTimeS, mod.num('drivetrain.ini', 'GEARBOX', 'CHANGE_UP_TIME') / 1000);
  eq('Liana CHANGE_DN_TIME', config.gearbox.downshiftTimeS, mod.num('drivetrain.ini', 'GEARBOX', 'CHANGE_DN_TIME') / 1000);
  eq('Liana HANDBRAKE_TORQUE', config.brakes.handbrakeTorqueNm, mod.num('brakes.ini', 'DATA', 'HANDBRAKE_TORQUE'));
  const el = (sec: string, key: string) => mod.num('electronics.ini', sec, key);
  eq('Liana ABS SLIP_RATIO_LIMIT', SUZUKI_LIANA_ELECTRONICS.absDefault, el('ABS', 'SLIP_RATIO_LIMIT'));
  eq('Liana ABS RATE_HZ', SUZUKI_LIANA_ELECTRONICS.absRateHz, el('ABS', 'RATE_HZ'));
  eq('Liana TC SLIP_RATIO_LIMIT', SUZUKI_LIANA_ELECTRONICS.tcDefault, el('TRACTION_CONTROL', 'SLIP_RATIO_LIMIT'));
  eq('Liana TC RATE_HZ', SUZUKI_LIANA_ELECTRONICS.tcRateHz, el('TRACTION_CONTROL', 'RATE_HZ'));
  eq('Liana TC MIN_SPEED_KMH', SUZUKI_LIANA_ELECTRONICS.tcMinSpeedKmh, el('TRACTION_CONTROL', 'MIN_SPEED_KMH'));

  // The street tyre is the first compound: an older tyre data version, with a linear load law and no falloff
  const compound = compoundData(config, config.compoundSlots.soft);
  const keys = ['WIDTH', 'RADIUS', 'RIM_RADIUS', 'DAMP', 'FRICTION_LIMIT_ANGLE', 'XMU', 'SPEED_SENSITIVITY', 'RELAXATION_LENGTH', 'ROLLING_RESISTANCE_0', 'ROLLING_RESISTANCE_1', 'ROLLING_RESISTANCE_SLIP', 'PRESSURE_RR_GAIN', 'CAMBER_GAIN', 'DCAMBER_0', 'DCAMBER_1', 'PRESSURE_IDEAL', 'PRESSURE_D_GAIN'];
  for (const axle of ['front', 'rear'] as const) {
    const AX = axle.toUpperCase();
    const tyre = axleTyre(compound, axle);
    checkTyre(`Liana ${axle}`, mod, tyre, { sectionName: AX, thermalName: `THERMAL_${AX}`, keys, rate: true, wear: true, thermalCurve: true, tread: true });
    // μ = DY0 + DY1 per 2000 N of load
    const t = (key: string) => mod.num('tyres.ini', AX, key);
    for (const fz of [2000, 4000, 6000]) {
      eq(`Liana ${axle} DY0 + DY1 at ${fz} N`, lutAt(tyre.model.dyCurve ?? [], fz), t('DY0') + (t('DY1') * fz) / 2000, 1e-4);
      eq(`Liana ${axle} DX0 + DX1 at ${fz} N`, lutAt(tyre.model.dxCurve ?? [], fz), t('DX0') + (t('DX1') * fz) / 2000, 1e-4);
    }
    eq(`Liana ${axle} no falloff`, tyre.model.use_slip_falloff ? 1 : 0, 0);
  }
});

// The GT3's base is a data set this machine doesn't hold; what it took from its second reference is checked here
section('AMG GT3 (second reference)', 'gt3_ref', (mod) => {
  const config = AMG_GT3_CONFIG;
  const tank = mod.vec('car.ini', 'FUELTANK', 'POSITION');
  eq('GT3 FUELTANK POSITION y', config.chassis.fuelTank.y, tank[1]);
  eq('GT3 FUELTANK POSITION z', config.chassis.fuelTank.z, tank[2]);
  const s = (sec: string, key: string) => mod.num('suspensions.ini', sec, key);
  eq('GT3 ARB front', config.suspensions.front.arb, s('ARB', 'FRONT'));
  eq('GT3 ARB rear', config.suspensions.rear.arb, s('ARB', 'REAR'));
  eq('GT3 front SPRING_RATE', config.suspensions.front.springs.wheel_rate, s('FRONT', 'SPRING_RATE'));
  eq('GT3 rear SPRING_RATE', config.suspensions.rear.springs.wheel_rate, s('REAR', 'SPRING_RATE'));
  const diff = config.differential.settings;
  eq('GT3 diff POWER', diff.power, mod.num('drivetrain.ini', 'DIFFERENTIAL', 'POWER'));
  eq('GT3 diff COAST', diff.coast, mod.num('drivetrain.ini', 'DIFFERENTIAL', 'COAST'));
  eq('GT3 diff PRELOAD', diff.preload, mod.num('drivetrain.ini', 'DIFFERENTIAL', 'PRELOAD'));
  const compound = compoundData(config, config.compoundSlots.soft);
  const keys = ['FLEX_GAIN', 'PRESSURE_FLEX_GAIN', 'COMBINED_FACTOR', 'CX_MULT', 'SPEED_SENSITIVITY', 'FALLOFF_LEVEL', 'FALLOFF_SPEED', 'PRESSURE_D_GAIN', 'BRAKE_DX_MOD', 'DCAMBER_0', 'DCAMBER_1', 'DAMP'];
  for (const axle of ['front', 'rear'] as const) {
    const AX = axle.toUpperCase();
    checkTyre(`GT3 ${axle}`, mod, axleTyre(compound, axle), { sectionName: AX, thermalName: `THERMAL_${AX}`, keys, tread: true });
  }
}, false);

// The f12026 car's tyres: C3 / C2 / C1 (the third to fifth compounds) as soft / medium / hard. Its grip above 4 kN is
// this sim's own (the data's falls further than a tyre does at a Formula 1 car's loads), so the load curves are
// compared up to there.
section('f12026 tyres', 'f1_2026_tyres', (mod) => {
  const config = F12026_CAR_CONFIG;
  const keys = [...V10_SHAPE, 'WIDTH', 'RADIUS', 'RIM_RADIUS', 'DAMP', 'RELAXATION_LENGTH', 'CAMBER_GAIN', 'DCAMBER_0', 'DCAMBER_1', 'PRESSURE_IDEAL', 'PRESSURE_D_GAIN', 'FZ0', 'LS_EXPY', 'LS_EXPX'];
  (['soft', 'medium', 'hard'] as const).forEach((slot, i) => {
    const compound = compoundData(config, config.compoundSlots[slot]);
    for (const axle of ['front', 'rear'] as const) {
      const AX = axle.toUpperCase();
      checkTyre(`f12026 ${slot} ${axle}`, mod, axleTyre(compound, axle), {
        sectionName: `${AX}_${i + 2}`,
        thermalName: `THERMAL_${AX}_${i + 2}`,
        keys,
        loadCurvesToN: 4000,
        rate: true,
        tread: true,
      });
    }
  });
});

console.log(failures.length ? `\n${failures.length} of ${checks} value(s) differ from their source.` : `\nAll ${checks} checked values match their source.`);
if (failures.length) process.exitCode = 1;
