/**
 * The BMW M1 Procar in the simulator: the f12026-car adapter (`F12026CarSim`) driving `BMW_M1_PROCAR_CONFIG`. No ERS,
 * DRS or push mode. The real car has neither traction control nor ABS: pro and semi-pro leave the TC off; semi-pro adds
 * a light ABS (as the Nissans' and the F1 cars' semi-pro do) for the AI, which brakes on the semi-pro aids; assisted
 * adds a TC the car does not have and tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { BMW_M1_PROCAR_CONFIG, BMW_M1_PROCAR_ELECTRONICS as E } from './BmwM1ProcarConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const BMW_M1_PROCAR_SOUND: CarSoundSource = {
  id: 'bmw-m1-procar',
  assetDir: '/cars/bmw-m1-procar/audio/',
  limiterRpm: BMW_M1_PROCAR_CONFIG.gearbox.gears.redline_rpm,
};

const C = BMW_M1_PROCAR_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The brake torque that reaches the road while the car slows: the wheels' spin (ANGULAR_INERTIA 1.71 / 2.28 kg·m²) and
 * the engine's through third gear (INERTIA 0.195) slow with it, ≈ 163 kg of rotating mass on 1095, so ≈ 87 % of the
 * 2700 Nm decelerates the car [spec, derived]
 */
const rotatingKg =
  (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / tyreRadius('rear') ** 2 +
  C.engine.inertia * ((C.gearbox.ratios[2] * C.gearbox.finalDrive) / tyreRadius('rear')) ** 2;
const BRAKE_SHARE = C.chassis.totalMassKg / (C.chassis.totalMassKg + rotatingKg);

/**
 * The M1's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm tyres. It holds 1.08 g at 54 km/h, rising to 1.24 at 306: the fronts
 * limit it (the front bar five times the rear's), and the spoiler's and the wing's downforce, near even between the
 * axles, adds a little more grip than its share of the load as the front gains it; the plan corners on μ 1.0 of weight
 * + downforce (1.0 g slow, 1.12 at 306 km/h), under the car everywhere. It brakes at 1.34 g at 54 km/h (in first, the
 * engine's inertia through the 12:1 gearing slowing with it) to 1.77 g at 306 with the AI's ABS: the fronts' grip on a
 * 66 % front bias sets the stop, a little short of the 2700 Nm of torque; the plan brakes on μ 1.3 or the brakes'
 * force, ≈ 92 % of the measured stop, so it never brakes later than the car can stop. Its aero at ρ 1.07, Rwanda's air,
 * as the GT3's and the 496R's plans are: downforce 0.185 v² (CL·A 0.345 m², verify-bmw-m1-procar.ts), drag 0.273 v²
 * (CD·A 0.51 m²), 51.5 % of the downforce on the rear axle; brake force and power at the wheels from the car's data.
 */
export const BMW_M1_PROCAR_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 0.185,
  dragCoef: 0.273,
  rearDownforceShare: 0.515,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.0,
  muLong: 1.3,
  muLoadExp: 0,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')) *
    BRAKE_SHARE,
  // Peak crank power (the curve is kW) through the driveline: ≈ 304 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // The ≈ 81.5 m/s fifth reaches at the 9200 rpm limiter: power and drag would take it to ≈ 105 m/s, so the gearing
  // sets the top speed
  vMaxMs: 81.5,
};

export const BMW_M1_PROCAR_SIM_PROFILE: CarSimProfile = {
  id: 'bmw-m1-procar',
  config: BMW_M1_PROCAR_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // [spec setup.ini]: pressures 24–44 psi; front camber −3.5…−2° (taken to the data's static −1.6°), rear −2.7…0°
  coldPsiRange: [24, 44],
  frontCamberRange: [-3.5, -1.6],
  rearCamberRange: [-2.7, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The front spoiler is fixed; the rear wing goes 1–6° (set 3), 1° a click [spec setup.ini WING_1 STEP 0, WING_2]
  aeroPackagesDeg: { low_downforce: [0, -2], balanced: [0, 0], high_downforce: [0, 3] },
  // What it holds at low speed, where the downforce is nothing (measure-ggv: 1.08 g at 54 km/h)
  padLateralMu: 1.08,
  // 360° of rim lock each way on a 16:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 16,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. The car corners at 1.08–1.24 g and brakes at
  // 1.35–1.79 g (measure-ggv), so the envelope is held under the corners: 1.1 × 0.85 × it is 1.00 g at 54 km/h and
  // 1.16 g at 306, and its braking (0.91–1.05 g) sits well under the brakes'
  braking: { lowG: 1.07, aeroG: 0.15, refMs: 80 },
  // 9.8° of front against 4.5° of rear slip at the peak of a 100 km/h steer ramp (1.32 g, scripts/verify-bmw-m1-procar.ts)
  understeerRadPerMs2: 0.007,
  speedProfile: BMW_M1_PROCAR_PROFILE_CAR,
  // The GT3's line: closed-wheel grip, nearer a GT3's than an F1 car's
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.005 l/s per 1000 rpm flat out, ≈ 0.045 l/s (0.033 kg/s) at 9000 rpm
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.005,
  // Levels index the electronics tables from the most intrusive (12): ABS 6 is the data's 12 %; TC 6 its 10 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
};

export function createBmwM1ProcarSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, BMW_M1_PROCAR_SIM_PROFILE);
}
