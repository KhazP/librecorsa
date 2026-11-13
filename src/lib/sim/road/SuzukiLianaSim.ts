/**
 * The Suzuki Liana 1.6 in the simulator: the f12026-car adapter (`F12026CarSim`) driving `SUZUKI_LIANA_CONFIG`.
 * No ERS, DRS, push mode or wings. The real car has ABS and no traction control: that is the semi-pro preset; the
 * assisted preset adds the mod's 12 % traction control, and pro switches both off.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { SUZUKI_LIANA_CONFIG, SUZUKI_LIANA_ELECTRONICS as E } from './SuzukiLianaConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const SUZUKI_LIANA_SOUND: CarSoundSource = {
  id: 'liana',
  assetDir: '/cars/liana/audio/',
  limiterRpm: SUZUKI_LIANA_CONFIG.gearbox.gears.redline_rpm,
};

const C = SUZUKI_LIANA_CONFIG;
const RADIUS = C.tyreCompounds.PhysicsTyreCompound_Road_Street.front.radius;
const AIR = 0.5 * C.aero.airDensity;

/**
 * The Liana's planning model for its lap-time line, braking zones, braking urgency and HUD target speed. The speed
 * profile's traction limit reads the driven axle, which is the front here: `rearWeightFraction` and
 * `rearDownforceShare` carry the front axle's shares. The body lifts a little (CL·A −0.134) and drags CdA 0.79 m²;
 * brake force and power at the wheels come from the car's data. Grip as `scripts/ai/measure-ggv.ts` measures it:
 * 0.82–0.84 g held in a corner, 0.8 g on the brakes at low speed with the ABS.
 */
export const SUZUKI_LIANA_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: AIR * (C.aero.front_lift + C.aero.rear_lift),
  dragCoef: AIR * C.aero.drag,
  rearDownforceShare: C.aero.front_lift / (C.aero.front_lift + C.aero.rear_lift),
  rearWeightFraction: C.chassis.frontWeightFraction,
  muLat: 0.82,
  // 0.77: the ABS stop from 100 km/h takes 49.6 m on the integrated tyre / drivetrain model (49.0 m before), and the
  // plan must not brake later than the car can stop
  muLong: 0.77,
  maxBrakeForceN: (2 * C.brakes.maxTorqueNm) / RADIUS,
  // Peak crank power (the curve is kW) through the driveline: ≈ 76 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Above the ≈ 51 m/s drag-limited top speed
  vMaxMs: 54,
};

export const SUZUKI_LIANA_SIM_PROFILE: CarSimProfile = {
  id: 'liana',
  config: SUZUKI_LIANA_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // [spec setup.ini]: pressures 15–40 psi, front camber −1.8…−0.2°, rear −0.5…+1.3°
  coldPsiRange: [15, 40],
  frontCamberRange: [-1.8, -0.2],
  rearCamberRange: [-0.5, 1.3],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // No wings to trim
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [0, 0] },
  padLateralMu: 0.84,
  // 540° of rim lock on a 15:1 rack [spec car.ini STEER_RATIO]
  steerRatio: 15,
  // 0.8 g on the brakes at town speeds to ≈ 0.95 g at the top end (drag), no downforce
  braking: { lowG: 0.8, aeroG: 0.15, refMs: 50 },
  // A nose-heavy front-driver: ≈ 8.5° more front than rear slip at 0.85 g on the steady ramp (scripts/verify-liana.ts),
  // so the autopilot steers that much in ahead of its yaw loop; with less it ran 1.7 m wide in Dunsfold's 7 m section
  understeerRadPerMs2: 0.015,
  speedProfile: SUZUKI_LIANA_PROFILE_CAR,
  // The slower line: lower grip than an F1 car moves the apexes and braking points
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.0015 l/s per 1000 rpm flat out, ≈ 0.0083 l/s (0.006 kg/s) at 5500 rpm
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.0015,
  // Levels index the electronics tables from the most intrusive (12); 9 is the mod's ABS 8 % / TC 12 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 9 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
  // A road car with 36° of lock to wind on: quicker keys around town speeds (half the grip limit ≈210 ms after the key
  // at 40–70 km/h instead of ≈275), its few fast corners as the base, and a touch quicker back from a big angle
  keyboardSteer: { lowSpeedRate: 1.3, highSpeedRate: 1, returnRate: 1.1 },
};

export function createSuzukiLianaSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, SUZUKI_LIANA_SIM_PROFILE);
}
