/**
 * The LC-LMDH in the simulator: the f12026-car adapter (`F12026CarSim`) driving `LC_LMDH_CONFIG`.
 * A hybrid with no DRS. The real car races without ABS (Art. 11.5.1); here it has the simulator's ABS on the TC + ABS
 * and Full presets as every other car does, so its fronts don't lock under a driver used to ABS. Off is off.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { LC_LMDH_CONFIG, LC_LMDH_ELECTRONICS as E, LC_LMDH_LONG_CONFIG } from './LcLmdhConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/**
 * Its own engine, gearbox and hybrid sounds (`scripts/audio/build_custom_soundbank.py`). The bank's top anchor sits at
 * the limiter, the end of the regulated power curve
 */
export const LC_LMDH_SOUND: CarSoundSource = {
  id: 'lc-lmdh',
  assetDir: '/cars/lc-lmdh/audio/',
  limiterRpm: LC_LMDH_CONFIG.gearbox.gears.redline_rpm,
};

const C = LC_LMDH_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The car's planning model for its lap-time line, braking zones, braking urgency and HUD target speed, at ρ 1.07
 * (Rwanda's air, as the other closed-wheel cars' plans are): downforce 2.2 v² (CL·A ≈ 4.1 m² over the speeds a lap
 * uses), drag 0.588 v² (CD·A 1.10 m²), 55.5 % of the downforce on the rear axle. It corners on μ 1.365 and brakes on
 * μ 1.3, under what `scripts/ai/measure-ggv.ts` measures (1.59 g at 54 km/h and 3.43 g at 306 in corners, 1.69 and
 * 3.42 g on the brakes), so it never brakes later than the car can stop.
 */
export const LC_LMDH_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 2.2,
  // ½ρ·CD·A at ρ 1.07: the endurance trim's ≈ 1.10 m² on the 5.5° wing
  dragCoef: 0.588,
  rearDownforceShare: 0.555,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.365,
  muLong: 1.3,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')),
  // The regulated power at the driveshafts: 507 kW
  maxDrivePowerW: 507_000,
  // Above the top speed the gearing and the drag give, so those set it, not this cap
  vMaxMs: 97,
};

export const LC_LMDH_SIM_PROFILE: CarSimProfile = {
  id: 'lc-lmdh',
  config: LC_LMDH_CONFIG,
  hasErs: true,
  hasDrs: false,
  turbo: true,
  // Cold pressures at the garage's 25 °C (no blankets): 131–172 kPa [bop]
  coldPsiRange: [19, 25],
  frontCamberRange: [-3.2, -0.8],
  rearCamberRange: [-2.6, -0.6],
  setupPressureRefC: 25,
  // Three traction dials
  tcSlipAngleDial: true,
  // −0.12° (toe-out) front, +0.12° rear [bop]
  staticToeDeg: { front: -0.12, rear: 0.12 },
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The rear wing goes 1–9° (set 5.5). Each package trims the front with it so the balance stays where it was, ≈ 47 %
  // front at 150 and 250 km/h: high downforce adds the dive planes (+3°) with 1.5° more wing, as much downforce as
  // 3.5° of wing alone gave without moving the balance 3.8 % rearward (the push in fast corners); low drag takes them
  // off (−5°) with the wing at its 1° minimum, where the front alone had kept 49.5 % on the nose
  aeroPackagesDeg: { low_downforce: [-5, -4.5], balanced: [0, 0], high_downforce: [3, 1.5] },
  // Its grip on the flat per g of weight and downforce, 1.46–1.51 from 80 to 180 km/h: the steering assist's yaw guard
  // reads this, and the 1.4 it had trimmed a stick's lock short of the grip in slow corners
  padLateralMu: 1.5,
  // 263.5° of rim lock each way on a 13.175 : 1 rack [bop]
  steerRatio: 13.175,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that: 1.45 g at low speed and 3.2 g at 306 km/h, inside
  // the measured 1.52 and 3.32 g
  braking: { lowG: 1.55, aeroG: 1.9, refMs: 85 },
  understeerRadPerMs2: 0.003,
  speedProfile: LC_LMDH_PROFILE_CAR,
  // The closed-wheel line
  racingLine: 'gt3',
  // ≈ 0.033 kg/s at 8000 rpm flat out [est]: 540 kW at the crank at 38 % efficiency. The flow follows the pedal and the
  // revs, not the torque: the fuel the hybrid's deployment saves on the real car is not counted
  fuelLPerS1000Rpm: 0.0055,
  // Levels index the electronics tables from the most intrusive (12). The class's dry baseline is 10 / 7 / 10 (slip,
  // cut, slip angle); ABS on TC + ABS and Full
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 7, absLevel: 0, tcSlipAngleLevel: 0 },
    semi_pro: { tcLevel: 10, tc2Level: 7, absLevel: 6, tcSlipAngleLevel: 10 },
    assisted: { tcLevel: 12, tc2Level: 9, absLevel: 9, tcSlipAngleLevel: 12 },
  },
  keyboardSteer: { lowSpeedRate: 1.25, highSpeedRate: 0.85, returnRate: 1 },
  // The spec hybrid's motor is on the gearbox's clutch shaft (Art. 5.3.2) [spec]
  motorOnGearbox: true,
};

/** The long-circuit trim (long gear set, 1° rear wing), for the checks: not selectable in the game */
export const LC_LMDH_LONG_SIM_PROFILE: CarSimProfile = { ...LC_LMDH_SIM_PROFILE, config: LC_LMDH_LONG_CONFIG };

export function createLcLmdhSim(track: BuiltTrackData, root?: THREE.Object3D | null, profile: CarSimProfile = LC_LMDH_SIM_PROFILE): F12026CarSim {
  return new F12026CarSim(track, root, profile);
}
