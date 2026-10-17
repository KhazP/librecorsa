/**
 * The Mercedes-AMG GT3 in the simulator: the f12026-car adapter (`F12026CarSim`) driving `AMG_GT3_CONFIG`.
 * No ERS, DRS or push mode. ABS and traction control use multi-stage GT3 slip limits (see `AMG_GT3_ELECTRONICS`):
 * default switch positions in the TC + ABS preset, the most intrusive TC and a tighter ABS in assisted, off in pro.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { AMG_GT3_CONFIG, AMG_GT3_ELECTRONICS as E } from './AmgGt3Config';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Sound bank configuration for the GT3 */
export const AMG_GT3_SOUND: CarSoundSource = {
  id: 'amg-gt3',
  assetDir: '/gt3/audio/',
  limiterRpm: AMG_GT3_CONFIG.gearbox.gears.redline_rpm,
};

const C = AMG_GT3_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The GT3's planning model for its braking line, braking urgency and HUD target speed. Measured on this car's
 * vehicle model at ρ 1.06 on the flat (scripts/verify-gt3.ts checks it): it brakes at μ 1.19–1.22 on ABS and peaks
 * at ≈1.45 laterally, so the plan uses a few % less, as the VF26's does; downforce ≈1.45 v² (1.72 at 100 km/h, 1.14
 * at 250 km/h as the car runs lower), drag 0.577 v². Brake force and power at the wheels from the mod's data.
 */
export const AMG_GT3_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.45,
  dragCoef: 0.577,
  rearDownforceShare: 0.55,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.4,
  muLong: 1.15,
  maxBrakeForceN:
    0.92 *
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')),
  // the mod's torque curve is at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([rpm, nm]) => (rpm * nm * Math.PI) / 30)),
  vMaxMs: 83,
};

export const AMG_GT3_SIM_PROFILE: CarSimProfile = {
  id: 'amg-gt3',
  config: AMG_GT3_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // The mod's setup ranges (cold psi, camber)
  coldPsiRange: [15, 30],
  frontCamberRange: [-4.0, 0],
  rearCamberRange: [-3.0, 0.5],
  tcTarget: { pro: 0, semi_pro: E.tcDefault, assisted: E.tcLevels[0] },
  absTarget: { pro: 0, semi_pro: E.absDefault, assisted: E.absLevels[1] },
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  // The mod's splitter goes 0–2° (default 2), its rear wing 0–8° (default 5)
  aeroPackagesDeg: { low_downforce: [-2, -3], balanced: [0, 0], high_downforce: [0, 3] },
  padLateralMu: 1.5,
  // ≈1.3 g at 100 km/h to ≈1.7 g past 250 km/h: below the car's grip, so the autopilot corners at about the same
  // share of it as the f12026-car's does (a high-CG GT3 steps out on a trail-braked entry at the limit)
  braking: { lowG: 1.2, aeroG: 0.5, refMs: 70 },
  speedProfile: AMG_GT3_PROFILE_CAR,
};

export function createAmgGt3Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, AMG_GT3_SIM_PROFILE);
}
