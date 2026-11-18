/**
 * The Chaparral 2D in the simulator, 1966 and 1967: the f12026-car adapter (`F12026CarSim`) driving
 * `CHAPARRAL_2D_CONFIG` / `CHAPARRAL_2D_67_CONFIG`. No ERS, DRS or push mode. The real car has neither traction control
 * nor ABS: pro and semi-pro leave the TC off; semi-pro adds a light ABS (as the M1's does) for the AI, which brakes on the
 * semi-pro aids; assisted adds a TC the car does not have and tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import type { CarPhysicsConfig } from '../f12026-car/F12026CarConfig';
import { CHAPARRAL_2D_67_CONFIG, CHAPARRAL_2D_CONFIG, CHAPARRAL_2D_ELECTRONICS as E, CHAPARRAL_AERO_KIT_DEG } from './Chaparral2dConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Their own engine, gearbox and tyre sounds, ported from the Assetto Corsa cars' sound banks */
export const CHAPARRAL_2D_SOUND: CarSoundSource = {
  id: 'chaparral-2d',
  assetDir: '/cars/chaparral-2d/audio/',
  limiterRpm: CHAPARRAL_2D_CONFIG.gearbox.gears.redline_rpm,
};
export const CHAPARRAL_2D_67_SOUND: CarSoundSource = {
  id: 'chaparral-2d-67',
  assetDir: '/cars/chaparral-2d-67/audio/',
  limiterRpm: CHAPARRAL_2D_67_CONFIG.gearbox.gears.redline_rpm,
};

/**
 * The brake force that reaches the road while the car slows: the wheels' spin and the engine's through second gear slow
 * with it, so a share of the brake torque decelerates the car [spec, derived]
 */
function brakeShare(C: CarPhysicsConfig): number {
  const rear = C.tyreCompounds[C.compoundSlots.soft]!.rear.radius;
  const rotatingKg =
    (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / rear ** 2 +
    C.engine.inertia * ((C.gearbox.ratios[1] * C.gearbox.finalDrive) / rear) ** 2;
  return C.chassis.totalMassKg / (C.chassis.totalMassKg + rotatingKg);
}

function maxBrakeForceN(C: CarPhysicsConfig): number {
  const t = C.tyreCompounds[C.compoundSlots.soft]!;
  return 2 * C.brakes.maxTorqueNm * (C.brakes.front_bias / t.front.radius + (1 - C.brakes.front_bias) / t.rear.radius) * brakeShare(C);
}

/** Peak crank power (the curve is kW) through the driveline */
const maxDrivePowerW = (C: CarPhysicsConfig) => Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency;

/**
 * The 1966 car's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm tyres. It holds 0.90 g at 54 km/h, 0.94 at 126 and 0.79 at 306: the body
 * lifts (the spoiler's lip pushes down a little) and the slicks lose grip to sliding speed, so the grip falls off as
 * it goes faster. The plan corners on μ 0.82 of the weight less the lift (0.82 g slow, 0.76 at 306 km/h) and brakes on
 * μ 1.07 or the brakes' force, ≈ 92 % of the measured 1.17 g, under the car everywhere. Aero at ρ 1.07, Rwanda's air:
 * lift 0.084 v² (CL·A −0.157 m²), drag 0.318 v² (CD·A 0.594 m²); brake force and power at the wheels from the car's data.
 */
export const CHAPARRAL_2D_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: CHAPARRAL_2D_CONFIG.chassis.totalMassKg,
  downforceCoef: -0.084,
  dragCoef: 0.318,
  rearDownforceShare: 0.5,
  rearWeightFraction: 1 - CHAPARRAL_2D_CONFIG.chassis.frontWeightFraction,
  muLat: 0.82,
  muLong: 1.07,
  muLoadExp: 0,
  maxBrakeForceN: maxBrakeForceN(CHAPARRAL_2D_CONFIG),
  maxDrivePowerW: maxDrivePowerW(CHAPARRAL_2D_CONFIG),
  // Second reaches ≈ 83 m/s at the 6800 rpm limiter, a little short of where power and drag would take it
  vMaxMs: 82.5,
};

/**
 * The 1967 car's (Daytona kit): 0.94 g at 54 km/h, 0.99 at 126, 0.87 at 306; the plan on μ 0.86 across and 1.07 on
 * the brakes. Lift 0.065 v² (CL·A −0.121 m²), drag 0.318 v²; heavier, on the 427's power
 */
export const CHAPARRAL_2D_67_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: CHAPARRAL_2D_67_CONFIG.chassis.totalMassKg,
  downforceCoef: -0.065,
  dragCoef: 0.318,
  rearDownforceShare: 0.5,
  rearWeightFraction: 1 - CHAPARRAL_2D_67_CONFIG.chassis.frontWeightFraction,
  muLat: 0.86,
  muLong: 1.07,
  muLoadExp: 0,
  maxBrakeForceN: maxBrakeForceN(CHAPARRAL_2D_67_CONFIG),
  maxDrivePowerW: maxDrivePowerW(CHAPARRAL_2D_67_CONFIG),
  // Third reaches ≈ 90 m/s at the limiter; power and drag stop it at ≈ 88.6 (319 km/h)
  vMaxMs: 88.5,
};

/** What the two cars share in the simulator */
const COMMON = {
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // [spec setup.ini]: pressures 12–35 psi; front camber −2…+1° (taken to the data's static −1.4°), rear −1.5…+1°
  coldPsiRange: [12, 35] as [number, number],
  frontCamberRange: [-2, -1.4] as [number, number],
  rearCamberRange: [-1.5, 1] as [number, number],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // 360° of rim lock each way on a 14.1:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 14.1,
  // The GT3's line: closed-wheel grip, nearer a GT3's than an F1 car's
  racingLine: 'gt3' as const,
  // Levels index the electronics tables from the most intrusive (12): ABS 6 is the data's 13 %; TC 6 its 12 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
};

export const CHAPARRAL_2D_SIM_PROFILE: CarSimProfile = {
  ...COMMON,
  id: 'chaparral-2d',
  config: CHAPARRAL_2D_CONFIG,
  // The setup's aero is two switches, 0 or 50 [spec setup.ini WING_3, WING_4]: the high-downforce package raises the
  // spoiler and fits the gurney extension (both REAR_WING elements); the front has nothing to move
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [0, CHAPARRAL_AERO_KIT_DEG] },
  // What it holds at low speed (measure-ggv: 0.90 g at 54 km/h)
  padLateralMu: 0.9,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. The car corners at 0.90–0.94 g slow and 0.79 at
  // 306 km/h, braking at 1.17–1.33 g (measure-ggv), so the envelope is held under the corners: 1.1 × 0.85 × it is 0.87 g
  // slow and 0.79 at 306, the lift taking grip away as the speed rises
  braking: { lowG: 0.93, aeroG: -0.08, refMs: 80 },
  // As the M1's [est]
  understeerRadPerMs2: 0.007,
  speedProfile: CHAPARRAL_2D_PROFILE_CAR,
  // Fuel flow with the engine's speed: 0.00555 l/s per 1000 rpm flat out [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.005553,
};

export const CHAPARRAL_2D_67_SIM_PROFILE: CarSimProfile = {
  ...COMMON,
  id: 'chaparral-2d-67',
  config: CHAPARRAL_2D_67_CONFIG,
  // The high-downforce package is the Sebring kit: canards (FRONT_WING) and the big spoiler (REAR_WING) at 50
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [CHAPARRAL_AERO_KIT_DEG, CHAPARRAL_AERO_KIT_DEG] },
  // measure-ggv: 0.94 g at 54 km/h
  padLateralMu: 0.94,
  // 1.1 × 0.85 × it is 0.92 g slow and 0.87 at 306 km/h, under the 0.94–0.99 / 0.87 g it corners at
  braking: { lowG: 0.98, aeroG: -0.05, refMs: 80 },
  understeerRadPerMs2: 0.007,
  speedProfile: CHAPARRAL_2D_67_PROFILE_CAR,
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.00619,
};

export function createChaparral2dSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, CHAPARRAL_2D_SIM_PROFILE);
}

export function createChaparral2d67Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, CHAPARRAL_2D_67_SIM_PROFILE);
}
