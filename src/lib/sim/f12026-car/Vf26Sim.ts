/**
 * The VF26 on the rigid-body engine: the f12026-car adapter (`F12026CarSim`) driving `VF26_CAR_CONFIG`, the same car
 * data `F1Physics2026` runs. The 2026 rules (override, straight-line mode, energy store) are the adapter's.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { VF26_TYRE_SETUP_RANGES } from '../vf26-data';
import { type CarSimProfile, F12026CarSim, F12026_ELECTRONICS } from './F12026CarSim';
import { VF26_CAR_CONFIG } from './Vf26Config';

export const VF26_SIM_PROFILE: CarSimProfile = {
  id: 'vf26',
  config: VF26_CAR_CONFIG,
  hasErs: true,
  hasDrs: true,
  turbo: true,
  coldPsiRange: VF26_TYRE_SETUP_RANGES.coldPsiRange,
  // The car's setup sheet gives cold pressures at 20 °C, as its other engine reads them
  setupPressureRefC: 20,
  frontCamberRange: VF26_TYRE_SETUP_RANGES.frontCamberRange,
  rearCamberRange: VF26_TYRE_SETUP_RANGES.rearCamberRange,
  tcMinSpeedMs: 2,
  // The f12026-car's driver-aid tables
  electronics: F12026_ELECTRONICS,
  // Wing offsets of the three aero packages, front and rear (deg) [vf26-aero AERO_PACKAGES]
  aeroPackagesDeg: { low_downforce: [-1.5, -3], balanced: [0, 0], high_downforce: [2, 3] },
  // As the f12026-car until the flat-ground probes are run on this car
  padLateralMu: 1.75,
  braking: { lowG: 1.6, aeroG: 2.8, refMs: 70 },
};

export function createVf26Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, VF26_SIM_PROFILE);
}
