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
 * brake force and power at the wheels from the car's data. (Drag since the endurance trim: 0.567 v², CD·A ≈ 1.07.)
 */
export const AMG_GT3_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.17,
  // ½ρ·CD·A at ρ 1.06: the endurance trim's ≈ 1.07 m²
  dragCoef: 0.567,
  rearDownforceShare: 0.55,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.52,
  muLong: 1.42,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')),
  // The regulated power at the driveshafts: 354 kW
  maxDrivePowerW: 354_000,
  // Above the ≈88 m/s drag-limited top speed, so power and drag set the straight-line speed, not this cap
  vMaxMs: 90,
};

export const AMG_GT3_SIM_PROFILE: CarSimProfile = {
  id: 'amg-gt3',
  config: AMG_GT3_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // GT3 setup ranges: cold psi at the garage's 25 °C (no blankets), camber
  coldPsiRange: [18, 26],
  frontCamberRange: [-4.0, -1.5],
  rearCamberRange: [-3.2, -1.0],
  setupPressureRefC: 25,
  // 540° lock to lock on the 12.6 : 1 rack
  steerRatio: 12.6,
  // An endurance GT3's electronics: twelve ABS maps, three traction dials
  enduranceAbsMaps: true,
  tcSlipAngleDial: true,
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // Splitter goes 0–2° (default 2), rear wing 0–14° (default 6)
  aeroPackagesDeg: { low_downforce: [-2, -3], balanced: [0, 0], high_downforce: [0, 3] },
  // Its grip on the flat per g of weight and downforce, warm, from 54 to 171 km/h: 1.59–1.63 on the soft, 1.58–1.61 on
  // the medium and 1.54–1.57 on the hard. The steering assist's yaw guard reads this, one figure for all three, so it
  // is the soft's: the 1.5 it had trimmed a stick's lock short of the grip on every compound
  padLateralMu: 1.63,
  // The autopilot plans on 85 % of this: ≈1.5 g on the brakes at 100 km/h to ≈1.9 g past 250 km/h, and corners on
  // 1.1 × that (≈1.6 g slow, ≈2.1 g fast, the car's own grip): it laps the circuits' GT3 speed profiles to within
  // ≈1–5 % at the AI's 0.975 pace (scripts/race-headless.ts --car amg-gt3)
  braking: { lowG: 1.7, aeroG: 0.55, refMs: 70 },
  // The car's understeer, which the autopilot's yaw loop otherwise only caught up with by mid-corner at speed: the front
  // road-wheel angle past the kinematic one (and past the loop's 0.8 × body slip) per m/s², on a flat-pad steer ramp at
  // constant speed on the calibrated grip: 0.0014-0.0016 rad at 160-260 km/h (0.0006 at 100). The 0.0035 measured on the
  // older physics steered in twice the understeer the car has, and the feed-forward grows with v²: the yaw loop swung
  // and diverged at 200-270 km/h (VIR's and Watkins Glen's lines spun off on check-lines)
  understeerRadPerMs2: 0.0015,
  speedProfile: AMG_GT3_PROFILE_CAR,
  // its own lap-time line: lower grip and downforce than an F1 car move the apexes and braking points
  racingLine: 'gt3',
  // Flat-out fuel flow, ≈ 0.049 l/s
  fuelFlowKgS: 0.036,
  // Default switch positions in semi-pro, the most intrusive TC and a tighter ABS in assisted, TC and ABS off in pro
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 5, absLevel: 0, tcSlipAngleLevel: 0 },
    semi_pro: { tcLevel: 10, tc2Level: 6, absLevel: 9, tcSlipAngleLevel: 10 },
    assisted: { tcLevel: 12, tc2Level: 9, absLevel: 11, tcSlipAngleLevel: 12 },
  },
  // A heavy car on a slow rack: quicker keys in slow and medium corners (half the grip limit ≈210 ms after the key at
  // 70–120 km/h instead of ≈300, the yaw ≈130 ms sooner at 70) and at speed as the base, where the car is calm; a
  // touch quicker back to centre
  keyboardSteer: { lowSpeedRate: 1.6, highSpeedRate: 1.05, returnRate: 1.1 },
};

/** An AMG GT3; `bodyPlan`, the plan of another GT3 body it wears (`CarDefinition.bodyPlan`) */
export function createAmgGt3Sim(
  track: BuiltTrackData,
  root?: THREE.Object3D | null,
  bodyPlan?: readonly (readonly [number, number])[]
): F12026CarSim {
  return new F12026CarSim(track, root, bodyPlan ? { ...AMG_GT3_SIM_PROFILE, bodyPlan } : AMG_GT3_SIM_PROFILE);
}
