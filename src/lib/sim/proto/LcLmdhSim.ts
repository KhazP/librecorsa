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
 * Its sound bank (on librecorsa.org only): the engine, in the cockpit and outside, and its shift and lift-off sounds are
 * Engine Lab by bimbalanch, given to LibreCorsa (CREDITS.md); the gearbox whine, hybrid motor, limiter and shift cut are
 * from its earlier bank (`scripts/audio/build_custom_soundbank.py`). The engine's 16 anchors run from 1800 to 9846 rpm
 * at the engine's own revs, past the 8300 rpm limiter, so the bank plays at the physics' rpm unscaled
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
 * (Rwanda's air, as the other closed-wheel cars' plans are): downforce 2.25 v² (CL·A ≈ 4.2 m² over the speeds a lap
 * uses), drag 0.588 v² (CD·A 1.10 m²), 55.5 % of the downforce on the rear axle. It corners on μ 1.42 and brakes on
 * μ 1.21, under what `scripts/ai/measure-ggv.ts` measures (1.66 g at 54 km/h and 3.66 g at 306 in corners, 1.73 and
 * 3.37 g on the brakes): with the drag the plan adds to its braking, 3.36 g at 306 km/h and 2.9 g at 270 against the
 * measured 3.37 and 3.12, so it never brakes later than the car can stop.
 */
export const LC_LMDH_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 2.25,
  // ½ρ·CD·A at ρ 1.07: the endurance trim's ≈ 1.10 m² on the 5.5° wing
  dragCoef: 0.588,
  rearDownforceShare: 0.555,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.42,
  muLong: 1.21,
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
  // The garage's camber ranges round the 963's statics [963]
  frontCamberRange: [-4, -1],
  rearCamberRange: [-3.4, -0.6],
  setupPressureRefC: 25,
  // Three traction dials
  tcSlipAngleDial: true,
  // −0.12° (toe-out) front, +0.12° rear [bop]
  staticToeDeg: { front: -0.12, rear: 0.12 },
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The rear wing goes 1–9° (set 5.5). Each package trims the front with it so the balance stays stable: high downforce
  // adds the dive planes (+3°) with 1.5° more wing; low drag trims the front further (−4.9°) with the wing at its 1°
  // minimum so the CoP shifts slightly rearward (~0.5 % behind balanced) to keep low-downforce corners planted without
  // snap oversteer
  aeroPackagesDeg: { low_downforce: [-4.9, -4.5], balanced: [0, 0], high_downforce: [3, 1.5] },
  // Its grip on the flat per g of weight and downforce, 1.56–1.64 from 90 to 162 km/h: the steering assist's yaw guard
  // reads this, and a figure under it trims a stick's lock short of the grip in slow corners
  padLateralMu: 1.6,
  // 263.5° of rim lock each way on a 13.175 : 1 rack [bop]
  steerRatio: 13.175,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that: 1.45 g at low speed and 3.2 g at 306 km/h, inside
  // the measured 1.52 and 3.32 g
  braking: { lowG: 1.55, aeroG: 1.9, refMs: 85 },
  understeerRadPerMs2: 0.003,
  speedProfile: LC_LMDH_PROFILE_CAR,
  // The closed-wheel line
  racingLine: 'gt3',
  // The fuel the engine's work takes [963]: 37 % brake thermal efficiency on a 43.5 MJ/kg renewable fuel, ≈ 0.033 kg/s
  // for the ≈ 535 kW at the crank flat out (≈ 495 kW while the motor deploys 40 kW), and 0.7 g/s idling: ≈ 2.5 L a lap
  // of Watkins Glen on the autopilot, where the class runs 30 to 33 laps on ≈ 90 L. The motor's deployment saves what
  // the engine gives way to it under the shaft limit, ≈ 7 % a lap there at 40 kW, as the class's power rules have it.
  // Engine maps 1 to 3 all make the shaft limit, so they burn alike; 4 and 5 trade power for fuel
  fuelFromEngineWork: { brakeThermalEfficiency: 0.37, lowerHeatingValueMJPerKg: 43.5, idleKgS: 0.0007 },
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
