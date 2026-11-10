/**
 * Starts a car's physics config from a mod's data (Assetto Corsa compatible: an unpacked data folder, or a car folder
 * holding `data/` or a packed `data.acd`): prints the values a `CarPhysicsConfig` takes from that data, each converted
 * to this sim's units and tagged with the file and key it came from, as TypeScript to paste into a new `*Config.ts`.
 *
 *   npx tsx scripts/cars/mod-physics-import.ts <car or data folder> > /tmp/NewCarConfig.draft.ts
 *
 * What it prints is the part of a config the data states. What a config also needs and the data does not have (this
 * sim's tyre heat capacities, the kinematic camber gain and roll-centre heights the solver reports, rain tyres, the
 * autopilot's profile) is left to the author, marked TODO. Once the config exists, add the car to
 * `scripts/verify-mod-parity.ts`, which checks every value against the same files and lists the keys left uncarried.
 *
 * The conversions (all in one place, here and in `src/lib/sim/mod-suspension.ts`):
 *  - power.lut is torque after the driveline: crank power = torque ÷ efficiency × rpm
 *  - INERTIA is the box the body's moments of inertia are taken from
 *  - springs, bars and dampers are rates at the wheel; packers and bump stops are measured from the design position
 *    and become gaps from static ride (`modCornerStops`); the CG height follows from BASEY (`modBodyHeightM`)
 *  - rolling resistance is newtons per kN of load; the radius growth is millimetres per rad/s
 *  - a tyre data version of 10 gives the brush family its shape directly; an older one has a linear load law
 *    (DY0 + DY1 per 2000 N), a fuller rise (XMU) and no falloff
 */
import { modBodyHeightM, modCornerStops } from '../../src/lib/sim/mod-suspension';
import { ModData, type Lut } from '../lib/mod-data';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npx tsx scripts/cars/mod-physics-import.ts <car or data folder>');
  process.exit(1);
}
const mod = new ModData(dir);
if (!mod.present) {
  console.error(`no car data in ${dir} (looked for car.ini in it, in its data/ folder and in its data.acd)`);
  process.exit(1);
}

const G = 9.81;
const DRIVELINE_EFFICIENCY = 0.92;
const out: string[] = [];
const p = (line = '') => out.push(line);
const n = (v: number, digits = 6) => (Number.isFinite(v) ? String(Number(v.toPrecision(digits))) : 'NaN /* TODO: not in the data */');
const lut = (points: Lut, indent = '  ') => `[\n${points.map(([x, y]) => `${indent}  [${n(x)}, ${n(y)}],`).join('\n')}\n${indent}]`;
const car = (sec: string, key: string) => mod.num('car.ini', sec, key);
const sus = (sec: string, key: string) => mod.num('suspensions.ini', sec, key);
const drv = (sec: string, key: string) => mod.num('drivetrain.ini', sec, key);
const eng = (sec: string, key: string) => mod.num('engine.ini', sec, key);
const tyr = (sec: string, key: string) => mod.num('tyres.ini', sec, key);

// ---- chassis and static ride
const mass = car('BASIC', 'TOTALMASS');
const [boxW, boxH, boxL] = mod.vec('car.ini', 'BASIC', 'INERTIA');
const wheelbase = sus('BASIC', 'WHEELBASE');
const frontShare = sus('BASIC', 'CG_LOCATION');
const hubF = sus('FRONT', 'HUB_MASS');
const hubR = sus('REAR', 'HUB_MASS');
const sprungKg = mass - 2 * hubF - 2 * hubR;
const tank = mod.vec('car.ini', 'FUELTANK', 'POSITION');

function axle(name: 'FRONT' | 'REAR') {
  const share = name === 'FRONT' ? frontShare : 1 - frontShare;
  const heave = `HEAVE_${name}`;
  const hasHeave = Number.isFinite(sus(heave, 'SPRING_RATE'));
  const staticLoadN = (sprungKg * G * share) / 2;
  const stops = modCornerStops({
    staticLoadN,
    springRate: sus(name, 'SPRING_RATE'),
    rodLength: sus(name, 'ROD_LENGTH'),
    packerRange: sus(name, 'PACKER_RANGE'),
    bumpStopUp: sus(name, 'BUMPSTOP_UP'),
    bumpStopDn: sus(name, 'BUMPSTOP_DN'),
    heave: hasHeave
      ? { springRate: sus(heave, 'SPRING_RATE'), rodLength: sus(heave, 'ROD_LENGTH'), packerRange: sus(heave, 'PACKER_RANGE'), bumpStopUp: sus(heave, 'BUMPSTOP_UP') }
      : undefined,
  });
  // The tyre's loaded radius at its ideal pressure, under the corner's whole weight
  const rate = tyr(name, 'RATE') + (tyr(name, 'PRESSURE_SPRING_GAIN') || 0) * ((tyr(name, 'PRESSURE_IDEAL') || tyr(name, 'PRESSURE_STATIC')) - tyr(name, 'PRESSURE_STATIC'));
  const cornerN = staticLoadN + (name === 'FRONT' ? hubF : hubR) * G;
  const bodyHeight = modBodyHeightM(tyr(name, 'RADIUS'), cornerN / rate, sus(name, 'BASEY'), stops.staticOffsetM);
  return { name, heave, hasHeave, stops, bodyHeight, strut: mod.text('suspensions.ini', name, 'TYPE') === 'STRUT' };
}
const front = axle('FRONT');
const rear = axle('REAR');
const cgHeight = front.bodyHeight + (rear.bodyHeight - front.bodyHeight) * (1 - frontShare);

p(`// Drafted by scripts/cars/mod-physics-import.ts from ${mod.text('car.ini', 'INFO', 'SCREEN_NAME') ?? 'a car'}'s data.`);
p('// [spec] = taken from the data (file and key named); TODO = what the data does not state.');
p();
p('// ---- chassis');
p(`const MASS = ${n(mass)}; // [spec car.ini TOTALMASS] with driver, no fuel`);
p(`const WHEELBASE = ${n(wheelbase)}; // [spec suspensions.ini WHEELBASE]`);
p(`const FRONT_WEIGHT = ${n(frontShare)}; // [spec CG_LOCATION] share of the sprung weight on the front axle`);
p(`/** Equivalent box ${n(boxW)} × ${n(boxH)} × ${n(boxL)} m [spec car.ini INERTIA] */`);
p('const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);');
p('const chassis = {');
p('  totalMassKg: MASS,');
p('  frontWeightFraction: FRONT_WEIGHT,');
p('  wheelbase: WHEELBASE,');
p(`  trackWidthFront: ${n(sus('FRONT', 'TRACK'))}, // [spec TRACK]`);
p(`  trackWidthRear: ${n(sus('REAR', 'TRACK'))},`);
p(`  // Body ${n(front.bodyHeight * 1000, 4)} mm up at the front axle, ${n(rear.bodyHeight * 1000, 4)} mm at the rear [derived: BASEY, RADIUS, RATE, static offsets]`);
p(`  cgHeight: ${n(cgHeight, 4)},`);
p(`  inertia: { pitch: box(${n(boxH)}, ${n(boxL)}), roll: box(${n(boxW)}, ${n(boxH)}), yaw: box(${n(boxW)}, ${n(boxL)}) },`);
p(`  unsprungMassFront: ${n(hubF)}, // [spec HUB_MASS]`);
p(`  unsprungMassRear: ${n(hubR)},`);
if (tank.length === 3 && tank.every(Number.isFinite)) p(`  fuelTank: { y: ${n(tank[1])}, z: ${n(tank[2])} }, // [spec car.ini FUELTANK POSITION]`);
p(`  wheelInertiaFront: ${n(tyr('FRONT', 'ANGULAR_INERTIA'))}, // [spec tyres.ini ANGULAR_INERTIA]`);
p(`  wheelInertiaRear: ${n(tyr('REAR', 'ANGULAR_INERTIA'))},`);
p(`  maxRoadWheelDeg: ${n(car('CONTROLS', 'STEER_LOCK'))} / ${n(car('CONTROLS', 'STEER_RATIO'))}, // [spec STEER_LOCK, STEER_RATIO]`);
p('  // TODO ffbMechanicalTrailM: the kingpin trail the solver reports');
p('};');
p(`// Ride-height pickups [spec car.ini RIDE]: ${n((front.bodyHeight + car('RIDE', 'PICKUP_FRONT_HEIGHT')) * 1000, 4)} mm front, ${n((rear.bodyHeight + car('RIDE', 'PICKUP_REAR_HEIGHT')) * 1000, 4)} mm rear off the ground at rest`);

// ---- engine and driveline
p();
p('// ---- engine and driveline');
p(`const DRIVELINE_EFFICIENCY = ${DRIVELINE_EFFICIENCY}; // this sim's; the data's torque is after the driveline`);
p(`/** Torque after the driveline (rpm → Nm) [spec power.lut] */`);
p(`const WHEEL_TORQUE: [number, number][] = ${lut(mod.lut('power.lut'), '')};`);
p('const POWER_CURVE = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000] as const);');
p('const engine = {');
p('  powerCurve: POWER_CURVE,');
p(`  // Linear overrun torque [spec engine.ini COAST_REF]`);
p(`  coastCurve: [[0, 0], [${n(eng('COAST_REF', 'RPM'))}, ${n(eng('COAST_REF', 'TORQUE'))}]],`);
if (mod.has('throttle.lut')) p(`  throttleResponseCurve: ${lut(mod.lut('throttle.lut').map(([x, y]) => [x / 100, y / 100]))}, // [spec throttle.lut]`);
p(`  idleRpm: ${n(eng('ENGINE_DATA', 'MINIMUM'))}, // [spec MINIMUM]`);
p(`  inertia: ${n(eng('ENGINE_DATA', 'INERTIA') + (drv('GEARBOX', 'INERTIA') || 0))}, // engine + gearbox [spec INERTIA]`);
p(`  limiterCutS: ${n(0.5 / eng('ENGINE_DATA', 'LIMITER_HZ'))}, // half a cycle of the limiter [spec LIMITER_HZ]`);
p('};');
const gears = Array.from({ length: drv('GEARS', 'COUNT') }, (_, i) => drv('GEARS', `GEAR_${i + 1}`));
const cutS = Math.max(drv('GEARBOX', 'CHANGE_UP_TIME') || 0, drv('GEARBOX', 'AUTO_CUTOFF_TIME') || 0) / 1000;
p('const gearbox = {');
p(`  ratios: [${gears.map((g) => n(g)).join(', ')}], // [spec drivetrain.ini GEARS]`);
p(`  reverse: ${n(Math.abs(drv('GEARS', 'GEAR_R')))},`);
p(`  finalDrive: ${n(drv('GEARS', 'FINAL'))},`);
p(`  shiftTimeS: ${n(cutS)}, // the longer of the change and the ignition cut [spec CHANGE_UP_TIME, AUTO_CUTOFF_TIME]`);
p(`  downshiftTimeS: ${n(drv('GEARBOX', 'CHANGE_DN_TIME') / 1000)}, // [spec CHANGE_DN_TIME]`);
p('  shiftTorqueFraction: 0, // TODO: torque kept through a shift');
p('  efficiency: DRIVELINE_EFFICIENCY,');
p(`  gears: { redline_rpm: ${n(eng('ENGINE_DATA', 'LIMITER'))}, upshift_rpm: ${n(drv('AUTO_SHIFTER', 'UP'))}, downshift_rpm: ${n(drv('AUTO_SHIFTER', 'DOWN'))}, brake_downshift_rpm: NaN /* TODO */ },`);
p('};');
p(`const clutch = { maxTorqueNm: ${n(drv('CLUTCH', 'MAX_TORQUE'))}, biteRpm: ${n(drv('AUTOCLUTCH', 'MIN_RPM'))}, lockRpm: ${n(drv('AUTOCLUTCH', 'MAX_RPM'))} }; // [spec CLUTCH, AUTOCLUTCH]`);
p(`// ${mod.text('drivetrain.ini', 'TRACTION', 'TYPE') ?? 'RWD'}: set drivenAxle: 'front' for a front-driven car`);
p('const differential = {');
p("  type: 'LSD_Ramp',");
p(`  settings: { power: ${n(drv('DIFFERENTIAL', 'POWER'))}, coast: ${n(drv('DIFFERENTIAL', 'COAST'))}, preload: ${n(drv('DIFFERENTIAL', 'PRELOAD'))}, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 }, // [spec DIFFERENTIAL]`);
p('};');
const handbrake = mod.num('brakes.ini', 'DATA', 'HANDBRAKE_TORQUE');
p(
  `const brakes = { maxTorqueNm: ${n(mod.num('brakes.ini', 'DATA', 'MAX_TORQUE'))}, front_bias: ${n(mod.num('brakes.ini', 'DATA', 'FRONT_SHARE'))}, ` +
    `${handbrake > 0 ? `handbrakeTorqueNm: ${n(handbrake)}, ` : ''}ebbStep: ${n((mod.num('brakes.ini', 'DATA', 'ADJUST_STEP') || 0.5) / 100)}, brakeByWire: false }; // [spec brakes.ini] TODO discMaterial`
);

// ---- suspension
p();
p('// ---- suspension (rates at the wheel; stops as gaps from static ride)');
const KEYS = ['WBCAR_TOP_FRONT', 'WBCAR_TOP_REAR', 'WBCAR_BOTTOM_FRONT', 'WBCAR_BOTTOM_REAR', 'WBTYRE_TOP', 'WBTYRE_BOTTOM', 'WBCAR_STEER', 'WBTYRE_STEER'];
for (const a of [front, rear]) {
  const s = (key: string) => sus(a.name, key);
  const st = a.stops;
  const packerFirst = st.packerGapM <= st.bumpStopGapM;
  const together = Math.abs(st.packerGapM - st.bumpStopGapM) < 1e-4;
  // A strut's own bump stop is rigid; the packers, and a wishbone corner's stop, work at BUMP_STOP_RATE
  const stopRate = a.strut ? 500_000 : s('BUMP_STOP_RATE');
  const first = together ? s('BUMP_STOP_RATE') + stopRate : packerFirst ? s('BUMP_STOP_RATE') : stopRate;
  const second = packerFirst ? stopRate : s('BUMP_STOP_RATE');
  p(`const ${a.name.toLowerCase()}Suspension = {`);
  p(`  type: '${a.strut ? 'SuspensionType_Strut' : 'SuspensionType_DoubleWishbone'}', // [spec TYPE]`);
  p(`  staticCamber: ${n(s('STATIC_CAMBER'))}, // [spec STATIC_CAMBER]`);
  p(`  springs: { wheel_rate: ${n(s('SPRING_RATE'))}, helper_rate: 0, helper_range: 0 }, // [spec SPRING_RATE]${s('PROGRESSIVE_SPRING_RATE') ? ' TODO: the data has a progressive rate this model does not' : ''}`);
  p(`  arb: ${n(sus('ARB', a.name))}, // [spec ARB]`);
  p(`  // Static ride sits ${n(st.staticOffsetM * 1000, 3)} mm into the travel from the design position [derived ROD_LENGTH, SPRING_RATE]`);
  p(
    `  bumpStop: { range: ${n(Math.min(st.packerGapM, st.bumpStopGapM), 4)}, rate: ${n(first)}, progression: 0` +
      (together ? '' : `, hardStop: { range: ${n(Math.max(st.packerGapM, st.bumpStopGapM), 4)}, rate: ${n(second)} }`) +
      ' }, // [spec PACKER_RANGE, BUMPSTOP_UP, BUMP_STOP_RATE]'
  );
  p(`  droopTravel: ${n(st.droopM, 4)}, // [spec BUMPSTOP_DN]`);
  if (a.hasHeave) {
    const h = (key: string) => sus(a.heave, key);
    const packerNearer = st.heavePackerGapM <= st.heaveBumpStopGapM;
    p(
      `  heave: { rate: ${n(h('SPRING_RATE'))}, gap: 0, packerGap: ${n(Math.min(st.heavePackerGapM, st.heaveBumpStopGapM), 4)}, packerRate: ${n(packerNearer ? h('BUMP_STOP_RATE') : 500_000)}, ` +
        `progressiveRate: ${n(h('PROGRESSIVE_SPRING_RATE') || 0)} }, // [spec ${a.heave}]`
    );
  } else {
    p('  heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },');
  }
  p('  // [x inboard, y up, z forward] from the wheel centre [spec]');
  p('  hardpoints: [');
  for (const key of KEYS) {
    const strutKey = a.strut && key === 'WBTYRE_TOP' ? 'STRUT_CAR' : a.strut && key === 'WBTYRE_BOTTOM' ? 'STRUT_TYRE' : key;
    const v = mod.vec('suspensions.ini', a.name, strutKey);
    p(v.length === 3 && v.every(Number.isFinite) ? `    [${v.map((x) => n(x)).join(', ')}], // ${strutKey}` : `    [NaN, NaN, NaN], // TODO ${key}: a strut has no upper arm; use a long virtual one square to the strut`);
  }
  p('  ],');
  p('  // TODO camberGainKinematic, rollCentreHeight: what the kinematic solver gives on these points');
  p('};');
  p(
    `const ${a.name.toLowerCase()}Dampers = { base: { slow_bump: ${n(s('DAMP_BUMP'))}, fast_bump: ${n(s('DAMP_FAST_BUMP'))}, slow_rebound: ${n(s('DAMP_REBOUND'))}, fast_rebound: ${n(s('DAMP_FAST_REBOUND'))} }, ` +
      `fastThresholdMs: ${n(s('DAMP_FAST_BUMPTHRESHOLD'))}, fastReboundThresholdMs: ${n(s('DAMP_FAST_REBOUNDTHRESHOLD'))}` +
      (a.hasHeave
        ? `, heave: { slow_bump: ${n(sus(a.heave, 'DAMP_BUMP'))}, fast_bump: ${n(sus(a.heave, 'DAMP_FAST_BUMP'))}, slow_rebound: ${n(sus(a.heave, 'DAMP_REBOUND'))}, fast_rebound: ${n(sus(a.heave, 'DAMP_FAST_REBOUND'))} }, ` +
          `heaveFastThresholdMs: ${n(sus(a.heave, 'DAMP_FAST_BUMPTHRESHOLD'))}, heaveFastReboundThresholdMs: ${n(sus(a.heave, 'DAMP_FAST_REBOUNDTHRESHOLD'))}`
        : '') +
      ' }; // [spec DAMP_*]'
  );
}

// ---- tyres
p();
p('// ---- tyres (one block per compound and axle; the rear goes in `rearOverride` where it differs)');
const version = mod.num('tyres.ini', 'HEADER', 'VERSION');
const loadScaled = mod.num('tyres.ini', 'VIRTUALKM', 'USE_LOAD') === 1;
for (const name of mod.sections('tyres.ini').filter((s) => /^(FRONT|REAR)(_\d+)?$/.test(s))) {
  const t = (key: string) => tyr(name, key);
  const thermal = `THERMAL_${name}`;
  p(`// ${name}: ${mod.text('tyres.ini', name, 'NAME') ?? ''} (${mod.text('tyres.ini', name, 'SHORT_NAME') ?? ''})`);
  p(`const tyre_${name} = {`);
  p(
    `  geometry: { width: ${n(t('WIDTH'))}, radius: ${n(t('RADIUS'))}, rimRadius: ${n(t('RIM_RADIUS'))}, verticalRateScale: 1` +
      (Number.isFinite(t('RADIUS_ANGULAR_K')) ? `, radiusGrowthPerRadS: ${n(t('RADIUS_ANGULAR_K') / 1000)}` : '') +
      ' }, // [spec WIDTH, RADIUS, RIM_RADIUS, RADIUS_ANGULAR_K]'
  );
  p('  modelData: {');
  p("    curve: 'brush',");
  p(`    friction_limit_angle: ${n(t('FRICTION_LIMIT_ANGLE'))}, // [spec FRICTION_LIMIT_ANGLE]`);
  if (version >= 10) {
    p(`    Fz0: ${n(t('FZ0'))}, lsExpY: ${n(t('LS_EXPY'))}, lsExpX: ${n(t('LS_EXPX'))}, // [spec FZ0, LS_EXPY, LS_EXPX]`);
    const dy = mod.lutOf('tyres.ini', name, 'DY_CURVE');
    const dx = mod.lutOf('tyres.ini', name, 'DX_CURVE');
    if (dy.length) p(`    dyCurve: ${lut(dy, '    ')}, // [spec DY_CURVE] peak μ against load (N)`);
    if (dx.length) p(`    dxCurve: ${lut(dx, '    ')}, // [spec DX_CURVE]`);
    if (!dy.length) p(`    Dy0: ${n(t('DY_REF'))}, Dx0: ${n(t('DX_REF'))}, // [spec DY_REF, DX_REF]`);
    p(`    peakSlipLoadGain: ${n(t('FLEX_GAIN'))}, peakSlipPressureGain: ${n(t('PRESSURE_FLEX_GAIN'))}, // [spec FLEX_GAIN, PRESSURE_FLEX_GAIN]`);
    p(`    combinedExponent: ${n(t('COMBINED_FACTOR') || 2)}, longStiffnessMult: ${n(t('CX_MULT') || 1)}, // [spec COMBINED_FACTOR, CX_MULT]`);
    p(`    use_slip_falloff: true, falloff_level: ${n(t('FALLOFF_LEVEL'))}, falloff_slope: ${n(t('FALLOFF_SPEED'))}, // [spec FALLOFF_LEVEL, FALLOFF_SPEED]`);
    // The drive force peaks at a theoretical slip of tan(peak angle) / CX_MULT: as a slip ratio, σ / (1 − σ)
    const sigma = Math.tan((t('FRICTION_LIMIT_ANGLE') * Math.PI) / 180) / (t('CX_MULT') || 1);
    p(`    slip_ratio_limit: ${n(sigma / (1 - sigma), 3)}, // [derived] slip ratio at the peak of the drive force`);
    p(`    brakeDxMod: ${n(t('BRAKE_DX_MOD') || 0)}, // [spec BRAKE_DX_MOD]`);
  } else {
    p(`    // An older tyre data version: μ = DY0 + DY1 per 2000 N of load [spec DY0 ${n(t('DY0'))} / DY1 ${n(t('DY1'))}, DX0 ${n(t('DX0'))} / DX1 ${n(t('DX1'))}]`);
    p(`    dyCurve: ${lut([0, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000].map((fz) => [fz, Math.max(0.5, t('DY0') + (t('DY1') * fz) / 2000)]), '    ')},`);
    p(`    dxCurve: ${lut([0, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000].map((fz) => [fz, Math.max(0.5, t('DX0') + (t('DX1') * fz) / 2000)]), '    ')},`);
    p(`    curveFullness: ${n(t('XMU'))}, // [spec XMU]`);
    p('    peakSlipLoadRefN: 2000, // TODO peakSlipLoadGain: the peak angle\'s growth per 2 kN, from FLEX');
    p('    longStiffnessMult: 1, use_slip_falloff: false, falloff_level: 1, falloff_slope: 0, // no falloff in this data version');
    p('    // TODO Dy0, Dx0, lsExpY, lsExpX, Fz0 at the static corner load; slip_ratio_limit');
  }
  p(`    speedSensitivity: ${n(t('SPEED_SENSITIVITY'))}, // [spec SPEED_SENSITIVITY]`);
  p(`    relaxationLengthX: ${n(t('RELAXATION_LENGTH'))}, relaxationLengthY: ${n(t('RELAXATION_LENGTH'))}, // [spec RELAXATION_LENGTH]`);
  p(
    `    rollingResistance: ${n(t('ROLLING_RESISTANCE_0') / 1000)}, rollingResistanceSpeedSq: ${n(t('ROLLING_RESISTANCE_1') / 1000)}, rollingResistanceSlipGain: ${n(t('ROLLING_RESISTANCE_SLIP') / 1000)}, // [spec ROLLING_RESISTANCE_0 / _1 / _SLIP]`
  );
  p(`    verticalDamping: ${n(t('DAMP'))}, // [spec DAMP]`);
  p('    // TODO pneumaticTrail; pKy2 is unused by a brush tyre');
  p('  },');
  p('  pressureData: {');
  p(`    optimalPsi: ${n(t('PRESSURE_IDEAL'))}, // [spec PRESSURE_IDEAL]`);
  const pStatic = t('PRESSURE_STATIC');
  p(`    // RATE ${n(t('RATE'))} N/m at the ${n(pStatic)} psi static pressure + ${n(t('PRESSURE_SPRING_GAIN'))} N/m per psi [spec]`);
  p(`    pressureSpringCurve: ${lut([pStatic - 10, pStatic, t('PRESSURE_IDEAL'), t('PRESSURE_IDEAL') + 10].map((psi) => [psi, Math.round(t('RATE') + t('PRESSURE_SPRING_GAIN') * (psi - pStatic))]), '    ')},`);
  p(`    pressureRollingGain: ${n(t('PRESSURE_RR_GAIN'))}, pressureGripLossPerPsi: ${n(t('PRESSURE_D_GAIN'))}, // [spec PRESSURE_RR_GAIN, PRESSURE_D_GAIN]`);
  p('    // TODO coldRefC: blankets or garage temperature');
  p('  },');
  p(`  camberData: { camberGain: ${n(t('CAMBER_GAIN'))}, dcamber0: ${n(t('DCAMBER_0'))}, dcamber1: ${n(t('DCAMBER_1'))} }, // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]`);
  const perf = mod.lutOf('tyres.ini', thermal, 'PERFORMANCE_CURVE');
  if (perf.length) p(`  thermalPerformanceCurve: ${lut(perf)}, // [spec ${thermal} PERFORMANCE_CURVE] grip against temperature (°C)`);
  const tread = (key: string) => mod.num('tyres.ini', thermal, key);
  if (Number.isFinite(tread('GRAIN_GAIN'))) p(`  tread: { grainGain: ${n(tread('GRAIN_GAIN'))}, grainGamma: ${n(tread('GRAIN_GAMMA'))}, blisterGain: ${n(tread('BLISTER_GAIN'))}, blisterGamma: ${n(tread('BLISTER_GAMMA'))} }, // [spec ${thermal}]`);
  const wear = mod.lutOf('tyres.ini', name, 'WEAR_CURVE');
  if (wear.length) p(`  wear: { curve: ${lut(wear)}${loadScaled ? ', loadScaled: true' : ''} }, // [spec WEAR_CURVE${loadScaled ? ', VIRTUALKM USE_LOAD' : ''}] grip (% of new) against km slid`);
  p('  // TODO thermalData heat capacities and cooling (this sim\'s own model), optimalTempC (the curve\'s 100 % span)');
  p('};');
}

// ---- aero
p();
p('// ---- aero (each element: area, position behind / ahead of the CG, angle, tables with their gains folded in)');
for (const sec of mod.sections('aero.ini').filter((s) => /^WING_\d+$/.test(s))) {
  const a = (key: string) => mod.num('aero.ini', sec, key);
  const pos = mod.vec('aero.ini', sec, 'POSITION');
  const scale = (points: Lut, k: number): Lut => points.map(([x, y]) => [x, y * k]);
  const cl = scale(mod.lutOf('aero.ini', sec, 'LUT_AOA_CL'), a('CL_GAIN'));
  const cd = scale(mod.lutOf('aero.ini', sec, 'LUT_AOA_CD'), a('CD_GAIN'));
  p(`// ${sec}: ${mod.text('aero.ini', sec, 'NAME') ?? ''}, ${n(pos[1])} m above the CG`);
  p(`const aero_${sec} = {`);
  p(`  area: ${n(a('CHORD') * a('SPAN'))}, positionZ: ${n(pos[2])}, angleDeg: ${n(a('ANGLE'))}, // [spec CHORD × SPAN, POSITION, ANGLE]`);
  p(`  lutAOA_CL: ${lut(cl)}, // [spec LUT_AOA_CL × CL_GAIN ${n(a('CL_GAIN'))}]`);
  p(`  lutAOA_CD: ${lut(cd)}, // [spec LUT_AOA_CD × CD_GAIN ${n(a('CD_GAIN'))}]`);
  const ghCl = mod.lutOf('aero.ini', sec, 'LUT_GH_CL');
  const ghCd = mod.lutOf('aero.ini', sec, 'LUT_GH_CD');
  if (ghCl.length) p(`  lutGH_CL_mult: ${lut(ghCl)}, // [spec LUT_GH_CL] against the element's own height: move it by the element's height below its pickup`);
  if (ghCd.length) p(`  lutGH_CD_mult: ${lut(ghCd)}, // [spec LUT_GH_CD]`);
  p(`  // YAW_CL_GAIN ${n(a('YAW_CL_GAIN'))}: CL × (1 + gain × |yaw| in radians), as a table`);
  p('};');
}

// ---- electronics
if (mod.has('electronics.ini')) {
  const e = (sec: string, key: string) => mod.num('electronics.ini', sec, key);
  p();
  p('// ---- electronics [spec electronics.ini]');
  if (e('ABS', 'PRESENT') === 1) p(`// ABS: ${n(e('ABS', 'SLIP_RATIO_LIMIT'))} slip, ${n(e('ABS', 'RATE_HZ'))} Hz`);
  if (e('TRACTION_CONTROL', 'PRESENT') === 1) p(`// TC: ${n(e('TRACTION_CONTROL', 'SLIP_RATIO_LIMIT'))} slip, ${n(e('TRACTION_CONTROL', 'RATE_HZ'))} Hz, off under ${n(e('TRACTION_CONTROL', 'MIN_SPEED_KMH'))} km/h`);
}

console.log(out.join('\n'));
