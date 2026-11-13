/**
 * The LC-LMDH in the simulator: the f12026-car adapter (`F12026CarSim`) driving `LC_LMDH_CONFIG`.
 * A hybrid with no DRS and no ABS. The car's own traction control stays on in every preset (the regulations allow one):
 * pro runs it at a light setting with no ABS, as the car is; semi-pro and assisted tighten it and add the simulator's
 * ABS (as the F1 cars' and the other prototype's presets do, which have none either), so the AI, which brakes on the
 * semi-pro aids, doesn't lock its fronts.
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
 * (Rwanda's air, as the other closed-wheel cars' plans are): downforce 2.05 v² (CL·A ≈ 3.85 m² over the speeds a lap
 * uses), drag 0.53 v² (CD·A 0.99 m²), 54 % of the downforce on the rear axle. It corners and brakes on μ 1.3, under
 * what `scripts/ai/measure-ggv.ts` measures (1.52 g at 54 km/h and 3.32 g at 306 in corners, 1.69 and 3.41 g on the
 * brakes), so it never brakes later than the car can stop.
 */
export const LC_LMDH_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 2.05,
  dragCoef: 0.53,
  rearDownforceShare: 0.54,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.3,
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
  // [est]
  coldPsiRange: [18, 34],
  frontCamberRange: [-4, 0],
  rearCamberRange: [-3, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The rear wing goes 1–9° (set 5.5); the splitter is fixed
  aeroPackagesDeg: { low_downforce: [0, -4.5], balanced: [0, 0], high_downforce: [0, 3.5] },
  padLateralMu: 1.4,
  // 225° of rim lock each way on a 12.5 : 1 rack [est]
  steerRatio: 12.5,
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
  // Levels index the electronics tables from the most intrusive (12): 4 is 9 % of wheelspin, 6 the default 8 %
  assistDials: {
    pro: { tcLevel: 4, tc2Level: 4, absLevel: 0 },
    semi_pro: { tcLevel: 6, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
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
