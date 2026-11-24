/**
 * LC25 Prototype in the simulator: drives `LC25_CAR_CONFIG` (2025 FIA Formula 1 regulations: 800 kg, 1.6L V6 turbo +
 * MGU-H + 120 kW MGU-K, ground-effect aero, rear-wing-only DRS) through `F12026CarSim`.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { OPEN_WHEEL_KEYBOARD_STEER } from '@/lib/input/keyboard-steer';
import type { CarSoundSource } from '../CarAudio';
import { HOSTED_CONTENT } from '../../hosted-content';
import { NOMINAL_AIR_DENSITY, type SpeedProfileCarModel } from '../speed-profile';
import { type CarSimProfile, F12026CarSim, F12026_ELECTRONICS, F1_ASSIST_DIALS } from '../f12026-car/F12026CarSim';
import { LC25_CAR_CONFIG, LC25_FUEL_FLOW_CURVE_KGS, LC25_STEERING, LC25_TYRE_SETUP_RANGES } from './Lc25Config';

/**
 * kyojinvan's 2025 F1 V6 sound (an Assetto Corsa bank, `scripts/audio/car_configs.json` "lc25-v6") where the hosted
 * files are listed, on librecorsa.org; a plain copy of the repository plays the synthesised 2025 1.6L V6 turbo-hybrid +
 * MGU-H bank (`scripts/audio/synth_f1_2025_bank.py`) that ships with it
 */
export const LC25_SOUND: CarSoundSource = {
  id: 'lc25',
  assetDir: HOSTED_CONTENT ? '/cars/lc25-v6/audio/' : '/cars/lc25/audio/',
  limiterRpm: LC25_CAR_CONFIG.gearbox.gears.redline_rpm,
};

const C = LC25_CAR_CONFIG;

/**
 * Planning model for the LC25 Prototype's braking line, braking urgency and HUD target speed.
 * Calibrated for 2025 ground-effect downforce (~6.45 m² CL·A, ~1.35 m² CD·A closed, 53.5% rear DF share) and ~695 kW
 * wheel power (608 kW ICE + 120 kW MGU-K through 95.5% drivetrain).
 */
export function lc25ProfileCar(airDensity = NOMINAL_AIR_DENSITY): SpeedProfileCarModel {
  const { maxTorqueNm, front_bias } = C.brakes;
  const soft = C.tyreCompounds[C.compoundSlots.soft]!;
  return {
    massKg: C.chassis.totalMassKg + 35,
    downforceCoef: 0.5 * airDensity * 6.45,
    dragCoef: 0.5 * airDensity * 1.35,
    rearDownforceShare: 0.535,
    rearWeightFraction: 1 - C.chassis.frontWeightFraction,
    muLat: 1.72,
    muLong: 1.52,
    maxBrakeForceN:
      0.92 * 2 * maxTorqueNm * (front_bias / soft.front.radius + (1 - front_bias) / soft.rear.radius),
    maxDrivePowerW: 695_000,
    vMaxMs: 99,
  };
}

export const LC25_SIM_PROFILE: CarSimProfile = {
  id: 'lc25',
  config: LC25_CAR_CONFIG,
  hasErs: true,
  hasDrs: true,
  turbo: true,
  defaultOvertakingRules: 'drs-rear',
  coldPsiRange: LC25_TYRE_SETUP_RANGES.coldPsiRange,
  setupPressureRefC: 20,
  frontCamberRange: LC25_TYRE_SETUP_RANGES.frontCamberRange,
  rearCamberRange: LC25_TYRE_SETUP_RANGES.rearCamberRange,
  tcMinSpeedMs: 2,
  electronics: F12026_ELECTRONICS,
  assistDials: F1_ASSIST_DIALS,
  // Three aero trims: Monza/low-drag (~353 km/h DRS), balanced (Spielberg ~324 km/h), Monaco high-downforce (~289 km/h)
  aeroPackagesDeg: { low_downforce: [-3.8, -6.5], balanced: [0, 0], high_downforce: [3.2, 4.8] },
  padLateralMu: 1.78,
  steerRatio: LC25_STEERING.ratio,
  braking: { lowG: 1.75, aeroG: 3.1, refMs: 72 },
  understeerRadPerMs2: 0.001,
  fuelFlowCurveKgS: LC25_FUEL_FLOW_CURVE_KGS,
  speedProfile: lc25ProfileCar(),
  keyboardSteer: OPEN_WHEEL_KEYBOARD_STEER,
  aiMaxKerbRiseM: 0.05,
};

export function createLc25Sim(
  track: BuiltTrackData,
  root?: THREE.Object3D | null,
  profile: CarSimProfile = LC25_SIM_PROFILE
): F12026CarSim {
  return new F12026CarSim(track, root, profile);
}
