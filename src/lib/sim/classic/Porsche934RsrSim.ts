/**
 * The Porsche 934 Turbo RSR in the simulator: the f12026-car adapter (`F12026CarSim`) driving `PORSCHE_934_RSR_CONFIG`.
 * No ERS, DRS or push mode. The real car has neither traction control nor ABS: pro and semi-pro leave the TC off;
 * semi-pro adds a light ABS (as the Nissans' and the M1's semi-pro do) for the AI, which brakes on the semi-pro aids;
 * assisted adds a TC the car does not have and tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { PORSCHE_934_RSR_CONFIG, PORSCHE_934_RSR_ELECTRONICS as E } from './Porsche934RsrConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, turbo, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const PORSCHE_934_RSR_SOUND: CarSoundSource = {
  id: 'porsche-934-rsr',
  assetDir: '/cars/porsche-934-rsr/audio/',
  limiterRpm: PORSCHE_934_RSR_CONFIG.gearbox.gears.redline_rpm,
};

const C = PORSCHE_934_RSR_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The brake torque that reaches the road while the car slows: the wheels' spin (ANGULAR_INERTIA 1.6 / 2.4 kg·m²) and
 * the engine's through second gear (INERTIA 0.128) slow with it, ≈ 112 kg of rotating mass on 1165, so ≈ 91 % of the
 * 2700 Nm decelerates the car [spec, derived]
 */
const rotatingKg =
  (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / tyreRadius('rear') ** 2 +
  C.engine.inertia * ((C.gearbox.ratios[1] * C.gearbox.finalDrive) / tyreRadius('rear')) ** 2;
const BRAKE_SHARE = C.chassis.totalMassKg / (C.chassis.totalMassKg + rotatingKg);

/**
 * The 934's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm slicks. It holds 0.99–1.01 g from 54 to 306 km/h, flat: the little
 * downforce it has (CL·A 0.16 m²) buys it next to nothing. The plan corners on μ 0.92 (0.92 g) and brakes on μ 1.0 or
 * the brakes' force, ≈ 91 % of the measured 1.10 g at 54 km/h (1.32 at 306), so it never brakes later than the car can
 * stop. Its aero at ρ 1.07, Rwanda's air, as the other cars' plans are: downforce 0.086 v², two thirds of it on the
 * rear axle (the wing well behind it, the spoiler half a metre ahead of the front), drag 0.365 v² (CD·A 0.683 m²);
 * brake force and power at the wheels from the car's data.
 */
export const PORSCHE_934_RSR_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 0.086,
  dragCoef: 0.365,
  rearDownforceShare: 0.65,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 0.92,
  muLong: 1.0,
  muLoadExp: 0,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')) *
    BRAKE_SHARE,
  // Peak crank power (the curve is kW, with the boost) through the driveline: ≈ 364 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Fourth reaches ≈ 88 m/s at the 8400 rpm limiter; power and drag stop it a little short of that
  vMaxMs: 85,
};

export const PORSCHE_934_RSR_SIM_PROFILE: CarSimProfile = {
  id: 'porsche-934-rsr',
  config: PORSCHE_934_RSR_CONFIG,
  hasErs: false,
  hasDrs: false,
  // The turbo: the telemetry's boost pressure
  turbo: true,
  // [spec setup.ini]: pressures 15–45 psi; front camber −4…0°, rear −2…+0.2°
  coldPsiRange: [15, 45],
  frontCamberRange: [-4, 0],
  rearCamberRange: [-2, 0.2],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The spoiler and wing are fixed (setup.ini has no wing entry)
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [0, 0] },
  // What it holds at low speed, where the downforce is nothing (measure-ggv: 0.99 g at 54 km/h)
  padLateralMu: 1.0,
  // 540° of rim lock each way on a 16.9:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 16.9,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. The car corners at 0.99–1.01 g whatever the speed
  // and brakes at 1.10–1.32 g (measure-ggv), so the envelope is held under the corners: 1.1 × 0.85 × it is 0.98 g
  braking: { lowG: 1.05, aeroG: 0, refMs: 80 },
  // As the M1's [est]
  understeerRadPerMs2: 0.007,
  speedProfile: PORSCHE_934_RSR_PROFILE_CAR,
  // The GT3's line: closed-wheel grip, nearer a GT3's than an F1 car's
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.0042 l/s per 1000 rpm flat out, ≈ 0.03 l/s at 7200 rpm [spec car.ini FUEL
  // CONSUMPTION]
  fuelLPerS1000Rpm: 0.0042,
  // Levels index the electronics tables from the most intrusive (12): ABS 6 is the data's 20 %; TC 6 its 20 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
};

export function createPorsche934RsrSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, PORSCHE_934_RSR_SIM_PROFILE);
}
