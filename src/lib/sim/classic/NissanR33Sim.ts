/**
 * The Nissan Skyline GT-R BCNR33 JGTC in the simulator: the f12026-car adapter (`F12026CarSim`) driving
 * `NISSAN_R33_CONFIG`. No ERS, DRS or push mode. The real car has ABS, off by default, and no traction control: pro
 * leaves both off; semi-pro switches the ABS on at its default 12 % (the AI brakes on the semi-pro aids); assisted
 * tightens the ABS to its tightest position and adds a TC the car does not have.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { NISSAN_R33_CONFIG, NISSAN_R33_ELECTRONICS as E } from './NissanR33Config';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const NISSAN_R33_SOUND: CarSoundSource = {
  id: 'nissan-r33-jgtc',
  assetDir: '/cars/nissan-r33-jgtc/audio/',
  limiterRpm: NISSAN_R33_CONFIG.gearbox.gears.redline_rpm,
};

const C = NISSAN_R33_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The brake torque that reaches the road while the car slows: the wheels' spin (ANGULAR_INERTIA 2.21 / 2.16 kg·m²) and
 * the engine's through third gear (INERTIA 0.215) slow with it, ≈ 110 kg of rotating mass on 1275, so ≈ 92 % of the
 * 3500 Nm decelerates the car [spec, derived]
 */
const rotatingKg =
  (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / tyreRadius('rear') ** 2 +
  C.engine.inertia * ((C.gearbox.ratios[2] * C.gearbox.finalDrive) / tyreRadius('rear')) ** 2;
const BRAKE_SHARE = C.chassis.totalMassKg / (C.chassis.totalMassKg + rotatingKg);

/**
 * The R33's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm tyres. It holds 1.37 g at 54 km/h and 2.33 g at 270 (μ ≈ 1.32 of weight +
 * downforce easing to 1.16 as the slicks' steep load sensitivity bites: μ ∝ n^−0.2 for n the load over the weight) and
 * brakes at 1.27–1.74 g, never at the tyres' limit: the 3500 Nm of brake torque sets the stop (1.43 g once the spinning
 * wheels and the engine through third take their share, plus the drag), and at 54 km/h, in first, the engine's inertia
 * through the 15:1 gearing (≈ 375 kg at the road) and its overrun hold it to 1.27 g. The plan corners on μ 1.3 n^−0.2 and
 * brakes on 1.25 or the brakes' force, so it never brakes later than the car can stop. Its aero at ρ 1.07, Rwanda's air,
 * as the GT3's and the 496R's plans are: downforce ≈ 1.95 v² (CL·A 3.65–3.70 m² from 100 to 250 km/h), drag 0.54 v²
 * (CD·A 1.0 m²), 56 % of the downforce on the rear axle; power at the wheels from the car's data.
 */
export const NISSAN_R33_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.95,
  dragCoef: 0.54,
  rearDownforceShare: 0.56,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.3,
  muLong: 1.25,
  muLoadExp: 0.2,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')) *
    BRAKE_SHARE,
  // Peak crank power (the curve is kW, with the boost made) through the driveline: ≈ 321 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Above the ≈ 81 m/s that sixth reaches at the limiter (the drag holds it to ≈ 75 at sea level), so power and drag set
  // the straight-line speed, not this cap
  vMaxMs: 83,
};

export const NISSAN_R33_SIM_PROFILE: CarSimProfile = {
  id: 'nissan-r33-jgtc',
  config: NISSAN_R33_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: true,
  // [spec setup.ini]: pressures 10–30 psi, as AC states them at 20 °C (the tyres leave 70–85 °C blankets); front camber
  // −5…0°, rear −4…0°
  coldPsiRange: [10, 30],
  setupPressureRefC: 20,
  frontCamberRange: [-5, 0],
  rearCamberRange: [-4, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The splitter goes 0–6° (set 2), the rear wing 0–10° (set 4), 1° a click [spec setup.ini WING_0, WING_1]: low drops
  // both to 0°, high takes the splitter to its CL peak at 4° and the wing to 8°. The wing has no drag at any angle in the
  // data, so low downforce gains nothing on a straight
  aeroPackagesDeg: { low_downforce: [-2, -4], balanced: [0, 0], high_downforce: [2, 4] },
  // μ per g of weight + downforce the ggv measures: 1.32 at 54 km/h, 1.26 at 198, 1.16 at 270
  padLateralMu: 1.25,
  // 250° of rim lock each way on a 15:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 15,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. This car corners harder than it brakes at speed (the
  // brake torque, not the tyres, sets its stop; the downforce keeps adding grip), so the envelope is held under both:
  // 0.85 × it is ≈ 88–92 % of the measured 1.62 / 1.68 / 1.74 g on the brakes at 198 / 234 / 270 km/h (a little more in
  // Rwanda's thinner air, where the drag helps less), and 1.1 × 0.85 × it 1.36 g at 54 km/h (1.37 measured), falling to
  // ≈ 75 % of the measured cornering by 270 km/h
  braking: { lowG: 1.43, aeroG: 0.45, refMs: 75 },
  // As the GT3's [est]; scripts/verify-nissan-r33-jgtc.ts checks the autopilot's laps
  understeerRadPerMs2: 0.0035,
  speedProfile: NISSAN_R33_PROFILE_CAR,
  // The GT3's line: closed-wheel grip and downforce
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.00574 l/s per 1000 rpm flat out, ≈ 0.038 l/s (0.028 kg/s) at 6700 rpm
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.00574,
  // Levels index the electronics tables from the most intrusive (12): ABS 6 is the data's 12 %, 9 its tightest 9 %;
  // TC 10 is the dormant 10 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 10, tc2Level: 9, absLevel: 9 },
  },
};

export function createNissanR33Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, NISSAN_R33_SIM_PROFILE);
}
