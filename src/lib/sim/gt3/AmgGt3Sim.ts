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
 * The GT3's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what this
 * car's vehicle model does on warm tyres at ρ 1.06 on the flat (scripts/verify-gt3.ts checks it). Held corners
 * pull μ ≈1.62 up to 190 km/h, easing to 1.5 at 250 km/h as the load rises; a threshold stop from 250 to 80 km/h
 * takes ≈117–120 m on the fixed 71 % balance-bar bias (the tyres' hot pressure moves it by a few metres), μ ≈1.42–1.45
 * on the full brake force. The plan corners on μ 1.6 and brakes on 1.42 (≈121 m, never shorter than the car), so its
 * braking points are where a driver at the limit brakes, not before. Downforce ≈1.17 v², drag 0.46 v² (CdA 0.87 m²);
 * brake force and power at the wheels from the car's data.
 */
export const AMG_GT3_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.17,
  dragCoef: 0.46,
  rearDownforceShare: 0.55,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.6,
  muLong: 1.42,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')),
  // Peak crank power (the curve is kW) through the driveline: ≈359 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Above the ≈88 m/s drag-limited top speed, so power and drag set the straight-line speed, not this cap
  vMaxMs: 90,
};

export const AMG_GT3_SIM_PROFILE: CarSimProfile = {
  id: 'amg-gt3',
  config: AMG_GT3_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // GT3 setup ranges (cold psi, camber)
  coldPsiRange: [15, 30],
  frontCamberRange: [-4.0, 0],
  rearCamberRange: [-3.0, 0.5],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // Splitter goes 0–2° (default 2), rear wing 0–14° (default 6)
  aeroPackagesDeg: { low_downforce: [-2, -3], balanced: [0, 0], high_downforce: [0, 3] },
  padLateralMu: 1.5,
  // The autopilot plans on 85 % of this: ≈1.5 g on the brakes at 100 km/h to ≈1.9 g past 250 km/h, and corners on
  // 1.1 × that (≈1.6 g slow, ≈2.1 g fast, the car's own grip): it laps the circuits' GT3 speed profiles to within
  // ≈1–5 % at the AI's 0.975 pace (scripts/race-headless.ts --car amg-gt3)
  braking: { lowG: 1.7, aeroG: 0.55, refMs: 70 },
  // ≈0.2° more front road-wheel angle per m/s² than the kinematic angle: the car's understeer, which the autopilot's
  // yaw loop otherwise only caught up with by mid-corner at speed
  understeerRadPerMs2: 0.0035,
  speedProfile: AMG_GT3_PROFILE_CAR,
  // its own lap-time line: lower grip and downforce than an F1 car move the apexes and braking points
  racingLine: 'gt3',
};

export function createAmgGt3Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, AMG_GT3_SIM_PROFILE);
}
