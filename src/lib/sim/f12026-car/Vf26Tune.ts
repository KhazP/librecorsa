/**
 * The VF26 as the rigid-body engine runs it: the car of `vf26-data.ts` with the values below in place of the data's.
 * `Vf26Config.ts` builds the data's car (the one `F1Physics2026` drives, kept for the side-by-side of the two
 * engines); this is the car a driver gets with the rigid-body engine.
 *
 * Why these: the data's chassis is sprung at the corners (200 / 185 kN/m) with light third springs, wheels of 13 and
 * 15 kg and dampers a tenth of critical in bump. A 2026 car carries its downforce on the third springs and their
 * packers and rolls on soft corner springs and the bars, on wheels of some 30 kg. What that changes on the road:
 *
 *  - the floor stays in its working height to 300 km/h (CL·A 4.7 there, was 4.2; 5.2 at 250, was 4.7)
 *  - the body rolls 0.28°/g (was 0.18) and a single wheel meets a kerb on half the spring
 *  - the wheels hop at 20 Hz (was 33), where the dampers can hold them
 *  - grip falls away with load above 4 kN, so the bars, the springs and the wing level move the balance
 *
 * The combustion engine is cut to the 2026 fuel-energy limit (400 kW at the wheels; the data's makes 500), the MGU-K,
 * the drag and the gears stay the data's: flat out with full deployment the car pulls 1.42 / 1.14 / 0.84 / 0.55 g at
 * 160 / 200 / 240 / 280 km/h against 1.50 / 1.25 / 0.86 / 0.53 g of 2026 qualifying laps, and its gears turn 34.3 rpm
 * per km/h in eighth against the 34.4 of those laps. An up-shift is managed (no kick to the rear wheels) and the
 * engine's torque follows the pedal over 80 ms.
 *
 *  - [rules]   the 2026 technical regulations
 *  - [ref]     in the range of reference data for 2026 cars
 *  - [tuned]   set here, by the measurement named
 */
import type { LutPoints } from '../lut';
import { Lut } from '../lut';
import { VF26_CHASSIS, VF26_ERS, type Vf26AxleSuspension, type Vf26TyreSpec } from '../vf26-data';
import { buildVf26Config, type Vf26Overrides } from './Vf26Config';

// ---------------------------------------------------------------------------
// Springs, third elements, bars
// ---------------------------------------------------------------------------

/** Wheel and upright, brake, half the links (kg) [ref: an 18 in wheel with its tyre is 17 to 20 kg of it] */
const UNSPRUNG_KG = { front: 30, rear: 34 };

/** Corner springs at the wheel (N/m): soft, for roll and the single wheel [ref] */
const WHEEL_RATE = { front: 110_000, rear: 75_000 };
/**
 * Third springs (N/m): with the corners they hold each axle at 420 / 380 kN/m, near the data's 460 / 420, so the car
 * sits where it did at rest and at 200 km/h [tuned: ride heights against speed]
 */
const HEAVE_RATE = { front: 200_000, rear: 230_000 };
/**
 * The third springs' packers: 3 and 4 mm away at rest, so from about 150 km/h the axles ride on them and only the
 * tyres give. The floor then sinks 12 mm between 150 and 300 km/h, not 19, and stays on the flat of its curve
 * [tuned: CL·A at 250 and 300 km/h; a lap of Rwanda never under 15 mm at the front axle, was 10]
 */
const PACKER = { gap: { front: 0.003, rear: 0.004 }, rate: 800_000 };
/**
 * Bars (N/m between the wheels): the front axle carries 59 % of the load transfer (the data's car: 55 %). More at the front costs grip
 * in slow corners; more at the rear lifts the inside rear on the throttle, and the car turns round on less pedal
 * [tuned: lateral g at 86 and 144 km/h against the slide on 40 % throttle in a 1.6 g corner at 100 km/h, held to
 * the data's car's 8.5°]
 */
const BAR = { front: 58_000, rear: 25_000 };
/** The rear rides 2 mm higher at rest, which centres the floor's height band on 150 to 300 km/h [tuned] */
const RIDE_HEIGHT = { front: VF26_CHASSIS.front.staticRideHeight, rear: VF26_CHASSIS.rear.staticRideHeight + 0.002 };

/**
 * Corner dampers from damping ratios: against a wheel's rate in roll (its spring and the bar), `zeta` of critical in
 * slow bump, 1.45 times that in slow rebound, and 55 % of each past the knee, where a kerb's speed would otherwise
 * lift the car [tuned: 0.4 in bump, 0.58 in rebound; wheel hop at a third of critical with the tyre's own damping]
 */
function cornerDamper(axle: 'front' | 'rear', zeta: number): Vf26AxleSuspension['damper'] {
  const sprungKg = VF26_CHASSIS.totalMassKg - 2 * (UNSPRUNG_KG.front + UNSPRUNG_KG.rear);
  const cornerKg = (sprungKg * (axle === 'front' ? VF26_CHASSIS.frontWeightFraction : 1 - VF26_CHASSIS.frontWeightFraction)) / 2;
  const critical = 2 * Math.sqrt((WHEEL_RATE[axle] + 2 * BAR[axle]) * cornerKg);
  const round = (c: number) => Math.round(c / 100) * 100;
  const bump = round(zeta * critical);
  const rebound = round(1.45 * zeta * critical);
  return { bumpSlow: bump, bumpFast: round(0.55 * bump), reboundSlow: rebound, reboundFast: round(0.55 * rebound), bumpThreshold: 0.05, reboundThreshold: 0.05 };
}

const axle = (a: 'front' | 'rear'): Partial<Vf26AxleSuspension> => ({
  springRate: WHEEL_RATE[a],
  heaveRate: HEAVE_RATE[a],
  heavePackerTravel: PACKER.gap[a],
  heavePackerRate: PACKER.rate,
  arbRate: BAR[a],
  unsprungMassKg: UNSPRUNG_KG[a],
  damper: cornerDamper(a, 0.4),
  staticRideHeight: RIDE_HEIGHT[a],
});

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

/**
 * Grip against load, on the data's curve: as it is up to 4 kN (a corner's load at rest is 1.8 to 2.2 kN), then
 * falling away faster, to 94 % at 8 kN and 83 % at 12 kN. The data's curve keeps 89 % of its 4 kN grip at 12 kN, so
 * downforce was grip at no cost and load moved across an axle changed nothing [ref, tuned: 4.18 g at 248 km/h, was
 * 4.41 on less downforce]
 */
const LOAD_SHAPE: LutPoints = [
  [0, 1],
  [4000, 1],
  [6000, 0.975],
  [8000, 0.94],
  [10_000, 0.89],
  [12_000, 0.83],
  [16_000, 0.72],
];
/** Drive and brake grip over the data's: it stood 6 % over the cornering grip, a slick's is about level [ref] */
const LONGITUDINAL_SCALE = 0.95;

const loadShape = new Lut(LOAD_SHAPE);
function gripCurve(curve: LutPoints | undefined, ref: number, exponent: number, fz0: number, scale: number): LutPoints {
  const data = curve ? new Lut(curve) : null;
  const loads = [...new Set([...(curve ?? []).map(([fz]) => fz), 1000, 2000, 3000, 4000, 6000, 8000, 10_000, 12_000, 16_000])].sort((a, b) => a - b);
  return loads.map((fz) => {
    const mu = data ? data.evaluate(fz) : ref * Math.pow(fz / fz0, exponent - 1);
    return [fz, Number((mu * loadShape.evaluate(fz) * scale).toFixed(4))];
  });
}

/** The data's grip against temperature from 95 °C up; below, a slick off its blankets keeps more than the data's 90 % at 60 °C [ref] */
const COLD_SIDE: LutPoints = [
  [0, 0.85],
  [20, 0.885],
  [40, 0.915],
  [60, 0.948],
  [80, 0.985],
];

function tyre(spec: Vf26TyreSpec, a: 'front' | 'rear'): Vf26TyreSpec {
  const front = a === 'front';
  return {
    ...spec,
    // 2026 tyres: 25 mm narrower at the front and 30 mm at the rear, on 705 and 710 mm [rules]
    width: front ? 0.28 : 0.375,
    radius: front ? 0.3525 : 0.355,
    // The carcass at running pressure, 290 and 315 kN/m, and its own damping [ref]
    rate: Math.round(spec.rate * 0.87),
    damp: front ? 600 : 650,
    angularInertia: front ? 1.35 : 1.55,
    dyCurve: gripCurve(spec.dyCurve, spec.dyRef, spec.lsExpY, spec.fz0, 1),
    dxCurve: gripCurve(spec.dxCurve, spec.dxRef, spec.lsExpX, spec.fz0, LONGITUDINAL_SCALE),
    // No extra grip on the brakes: the pedal locks the wheel the load and the balance say it does [ref]
    brakeDxMod: 0,
    // The wide rear builds its force at a smaller angle than the front, which keeps the tail behind the nose [ref]
    frictionLimitAngleDeg: front ? spec.frictionLimitAngleDeg : 5.9,
    relaxationLength: front ? 0.1 : 0.12,
    // Past the peak the tyre keeps 86 % and gets there within twice the peak slip [ref]
    falloffLevel: 0.86,
    falloffSpeed: 4,
    thermalCurve: [...COLD_SIDE, ...spec.thermalCurve.filter(([c]) => c >= 95)],
  };
}

// ---------------------------------------------------------------------------
// The car
// ---------------------------------------------------------------------------

export const VF26_TUNE: Vf26Overrides = {
  front: axle('front'),
  rear: axle('rear'),
  tyre,
  // The combustion engine at the 2026 fuel-energy limit: 421 kW at the crank, 400 at the wheels. The data's curve peaks
  // at 527 kW, a 2025 engine's, and with the MGU-K the car out-pulled 2026 laps by 16 % at 240 km/h and 30 % at 280
  // [rules, ref; tuned: full-throttle g at 160 to 280 km/h against those laps]
  icePowerScale: 0.8,
  // Crank, flywheel and the MGU-K geared to it [ref]
  engineInertia: 0.08,
  // Overrun: 60 Nm at 15 000 rpm, a V6's pumping and friction; the data's 30 Nm left the car coasting on a lift [ref]
  coastScale: 2,
  // 5.3 g at 300 km/h, where the brakes and not the tyres set the limit [tuned]
  brakeTorqueNm: 6200,
  // Less lock under power than the data's 0.2: with the softer rear the inside wheel keeps its share [tuned: as the bars]
  diffPowerLock: 0.15,
  // An up-shift is the control unit's: the drive is off for 20 ms and the engine meets the next gear at the wheels'
  // speed. The data's closed clutch handed the engine's excess to the rear wheels at every change: 6 % slip became
  // 36 % on a shift at full throttle, 1 % became 20 % on a light pedal [ref: such cars cut for 40 to 50 ms and get
  // part of it back from the engine; tuned: the slip across a shift, and the jolt of one on a light pedal]
  upshiftCutS: 0.02,
  // The engine's torque follows the pedal in 80 ms and lets go in 50 (the data: 30 and 20), so the rear tyres load up
  // over a tenth of a second and not at once [ref]
  torqueResponseS: { rise: 0.08, fall: 0.05 },
  // A lift recovers energy in every gear, not in eighth alone, where it was a step in the car's deceleration between
  // seventh and eighth (0.19 g at 200 km/h in the lift-and-coast map). It is whole with the pedal shut and gone by the
  // 5 % where the deployment starts, in every gear alike (eighth harvested up to 15 %); the rear axle is never held
  // back by more than the data's 900 Nm, which is 0.33 g under 125 km/h [ref: recovery on a lift in every gear, easing
  // off with the pedal; data: the axle's ceiling; tuned: lift-off deceleration at 60 to 280 km/h in each gear]
  ers: { liftThrottle: 0.05, liftHarvestEveryGear: { maxAxleTorqueNm: VF26_ERS.coastHarvestMaxAxleTorqueNm } },
  // The fuel cell is behind the driver: 0.15 m behind the centre of gravity of the car without fuel and 0.2 m above
  // it [ref]. With the fuel at that centre the weight split never moved with the load; from here a full 110 kg tank
  // takes 0.6 point off the front axle's share (45.65 % empty, 45.42 % with 40 kg, 45.07 % full) and the car gets it
  // back as the fuel burns [measured at rest on flat ground]
  fuelTank: { y: 0.2, z: -0.15 },
};

export const VF26_TUNED_CONFIG = buildVf26Config(VF26_TUNE);
