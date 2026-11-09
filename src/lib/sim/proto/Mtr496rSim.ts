/**
 * The MTRacing 496R in the simulator: the f12026-car adapter (`F12026CarSim`) driving `MTR_496R_CONFIG`.
 * No ERS, DRS or push mode. The real car has traction control and no ABS: pro switches the TC off too; semi-pro keeps
 * the mod's TC and adds a light ABS (as the F1 cars' semi-pro does, which have none either), so the AI, which brakes on
 * the semi-pro aids, doesn't lock its fronts on 5900 Nm brakes; assisted tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { MTR_496R_CONFIG, MTR_496R_ELECTRONICS as E } from './Mtr496rConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const MTR_496R_SOUND: CarSoundSource = {
  id: 'mtr-496r',
  assetDir: '/cars/mtr-496r/audio/',
  limiterRpm: MTR_496R_CONFIG.gearbox.gears.redline_rpm,
};

const C = MTR_496R_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The 496R's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm tyres. It holds 1.55 g at 54 km/h and 2.91 g at 306 (μ ≈ 1.49 easing to
 * 1.27 of weight + downforce as the tyres' load sensitivity bites) and brakes at 1.68–3.67 g (μ ≈ 1.6, ≈ 1.4 at the top
 * once drag is taken out). The plan corners on μ 1.3 and brakes on 1.4, so it never brakes later than the car can stop.
 * Its aero at ρ 1.07, Rwanda's air, as the GT3's plan is (the car leans on downforce more than the GT3, so sea-level
 * numbers put it into Rwanda's fast corners too quick): downforce ≈ 1.79 v² (CL·A 3.3–3.4 m², the diffuser working
 * from rest at its 64 / 85 mm ride height), drag 0.615 v² (CD·A 1.15 m²), 58 % of the downforce on the rear axle;
 * brake force and power at the wheels from the car's data.
 */
export const MTR_496R_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 1.79,
  dragCoef: 0.615,
  rearDownforceShare: 0.58,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.3,
  muLong: 1.4,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')),
  // Peak crank power (the curve is kW) through the driveline: ≈ 410 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Above the drag-limited top speed, so power and drag set the straight-line speed, not this cap
  vMaxMs: 95,
};

export const MTR_496R_SIM_PROFILE: CarSimProfile = {
  id: 'mtr-496r',
  config: MTR_496R_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // [spec setup.ini]: pressures 15–45 psi, front camber −4…0°, rear −3.5…0°
  coldPsiRange: [15, 45],
  frontCamberRange: [-4, 0],
  rearCamberRange: [-3.5, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The rear wing goes 1–15° (set 8) [spec setup.ini WING_2]; the splitter is fixed
  aeroPackagesDeg: { low_downforce: [0, -5], balanced: [0, 0], high_downforce: [0, 5] },
  padLateralMu: 1.35,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. This car brakes harder than it corners (its tyres'
  // 10 % BRAKE_DX_MOD, and its drag), so the envelope is sized for the corners: 1.1 × 0.85 × it is the measured 1.55 g
  // at 54 km/h, 1.9 g at 162 (2.0 measured) and 2.9 g at 306 (the brakes' own 1.7 / 2.4 / 3.7 g plan as ≈ 70–85 % of that)
  braking: { lowG: 1.6, aeroG: 1.5, refMs: 85 },
  // As the GT3's [est]; scripts/verify-mtr-496r.ts checks the autopilot's laps
  understeerRadPerMs2: 0.0035,
  speedProfile: MTR_496R_PROFILE_CAR,
  // The GT3's line: closed-wheel grip and downforce, nearer a GT3's than an F1 car's
  racingLine: 'gt3',
  // AC CONSUMPTION 0.005659: ≈ 0.048 l/s at 8500 rpm, full throttle, at 0.74 kg/l [derived]
  fuelFlowKgS: 0.036,
  // Levels index the electronics tables from the most intrusive (12); 6 is the mod's TC 9 %, and ABS 6 holds 12 % slip
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 6, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
};

export function createMtr496rSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, MTR_496R_SIM_PROFILE);
}
