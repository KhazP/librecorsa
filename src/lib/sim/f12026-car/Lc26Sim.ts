/**
 * The LC26 on the rigid-body engine: the f12026-car adapter (`F12026CarSim`) driving the tuned car of `Lc26Tune.ts`.
 * The 2026 rules (override, straight-line mode, energy store) are the adapter's. `LC26_DATA_SIM_PROFILE` is the same
 * adapter on the untouched car data `F1Physics2026` runs, for comparing the two engines on one car.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { createLc26ProfileCarModel, NOMINAL_AIR_DENSITY, type SpeedProfileCarModel } from '../speed-profile';
import { LC26_CHASSIS, LC26_TYRE_SETUP_RANGES } from '../lc26-data';
import { type CarSimProfile, F12026CarSim, F12026_ELECTRONICS, F1_ASSIST_DIALS } from './F12026CarSim';
import { LC26_CAR_CONFIG } from './Lc26Config';
import { LC26_TUNED_CONFIG } from './Lc26Tune';

/**
 * The tuned car as its braking line and target speed plan it: the LC26's planning model with this car's brakes and
 * the grip it measures. It stops in 86 m from 300 km/h where the data's car takes 77, so on the circuit's own plan
 * (made for that car) the braking points came late: μ 1.4 on the brakes plans 2 to 5 % longer than the car stops,
 * and 1.63 in corners 3 to 6 % under what it holds.
 */
export function lc26TunedProfileCar(airDensity = NOMINAL_AIR_DENSITY): SpeedProfileCarModel {
  const { maxTorqueNm, front_bias } = LC26_TUNED_CONFIG.brakes;
  const soft = LC26_TUNED_CONFIG.tyreCompounds.PhysicsTyreCompound_F1_Soft;
  return {
    ...createLc26ProfileCarModel('balanced', airDensity),
    muLat: 1.63,
    muLong: 1.4,
    maxBrakeForceN: 0.92 * 2 * maxTorqueNm * (front_bias / soft.front.radius + (1 - front_bias) / soft.rear.radius),
  };
}

export const LC26_SIM_PROFILE: CarSimProfile = {
  id: 'lc26',
  config: LC26_TUNED_CONFIG,
  hasErs: true,
  hasDrs: true,
  turbo: true,
  coldPsiRange: LC26_TYRE_SETUP_RANGES.coldPsiRange,
  // The car's setup sheet gives cold pressures at 20 °C, as its other engine reads them
  setupPressureRefC: 20,
  frontCamberRange: LC26_TYRE_SETUP_RANGES.frontCamberRange,
  rearCamberRange: LC26_TYRE_SETUP_RANGES.rearCamberRange,
  tcMinSpeedMs: 2,
  // The f12026-car's driver-aid tables
  electronics: F12026_ELECTRONICS,
  assistDials: F1_ASSIST_DIALS,
  // Wing offsets of the three aero packages, front and rear (deg) [lc26-aero AERO_PACKAGES]
  aeroPackagesDeg: { low_downforce: [-1.5, -3], balanced: [0, 0], high_downforce: [2, 3] },
  // As the f12026-car until the flat-ground probes are run on this car
  padLateralMu: 1.75,
  // The ratio the config's lock is given on (270° of rim lock on 14:1)
  steerRatio: LC26_CHASSIS.steering.ratio,
  braking: { lowG: 1.6, aeroG: 2.8, refMs: 70 },
  speedProfile: lc26TunedProfileCar(),
};

/** The same car on the data as it stands, untuned: what `F1Physics2026` drives */
// (no planning model of its own: the circuit's plan is this car's)
export const LC26_DATA_SIM_PROFILE: CarSimProfile = { ...LC26_SIM_PROFILE, config: LC26_CAR_CONFIG, speedProfile: undefined };

export function createLc26Sim(track: BuiltTrackData, root?: THREE.Object3D | null, profile: CarSimProfile = LC26_SIM_PROFILE): F12026CarSim {
  return new F12026CarSim(track, root, profile);
}
