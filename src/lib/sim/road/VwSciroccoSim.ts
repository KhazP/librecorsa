/**
 * The Volkswagen Scirocco GTX 16V in the simulator: the f12026-car adapter (`F12026CarSim`) driving
 * `VW_SCIROCCO_CONFIG`. No ERS, DRS, push mode or wing adjustment. The real car has neither traction control nor ABS:
 * pro and semi-pro leave the TC off; semi-pro adds a light ABS for the AI, which brakes on the semi-pro aids; assisted
 * adds the mod's 12 % TC and tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { VW_SCIROCCO_CONFIG, VW_SCIROCCO_ELECTRONICS as E } from './VwSciroccoConfig';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const VW_SCIROCCO_SOUND: CarSoundSource = {
  id: 'vw-scirocco-gtx',
  assetDir: '/cars/vw-scirocco-gtx/audio/',
  limiterRpm: VW_SCIROCCO_CONFIG.gearbox.gears.redline_rpm,
};

const C = VW_SCIROCCO_CONFIG;
const RADIUS = C.tyreCompounds.PhysicsTyreCompound_Road_Street.front.radius;
const AIR = 0.5 * C.aero.airDensity;

/**
 * The Scirocco's planning model for its lap-time line, braking zones, braking urgency and HUD target speed. The speed
 * profile's traction limit reads the driven axle, which is the front here: `rearWeightFraction` and
 * `rearDownforceShare` carry the front axle's shares (55 % of the downforce: the splitter ahead of the axle, and 55 % of
 * the body's, 0.17 m behind the CG). Its aero at sea-level air: CL·A 0.19 m², CD·A 0.33 m²; brake force and power at the wheels from the
 * car's data. Grip as `scripts/ai/measure-ggv.ts` measures it: 0.91–0.94 g held in a corner at any speed (the
 * downforce is too small to show), 1.13 g on the brakes at 54 km/h rising to 1.2 g at 160 with the drag. It brakes on
 * μ 1.02, so a 100→0 km/h stop is planned 4 % longer than the car takes (scripts/verify-vw-scirocco-gtx.ts).
 */
export const VW_SCIROCCO_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: AIR * 0.19,
  dragCoef: AIR * 0.33,
  rearDownforceShare: 0.55,
  rearWeightFraction: C.chassis.frontWeightFraction,
  muLat: 0.92,
  muLong: 1.02,
  maxBrakeForceN: (2 * C.brakes.maxTorqueNm) / RADIUS,
  // Peak crank power (the curve is kW) through the driveline: ≈ 104 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Its 209 km/h in fifth at the limiter, a little over
  vMaxMs: 59,
};

export const VW_SCIROCCO_SIM_PROFILE: CarSimProfile = {
  id: 'vw-scirocco-gtx',
  config: VW_SCIROCCO_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // [spec setup.ini]: pressures 15–48 psi, front camber −3…0°, rear −2…0°
  coldPsiRange: [15, 48],
  frontCamberRange: [-3, 0],
  rearCamberRange: [-2, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // No wings to trim
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [0, 0] },
  // What it holds at low speed (measure-ggv: 0.91–0.94 g)
  padLateralMu: 0.92,
  // 450° of rim lock on a 14:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 14,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that: 0.89 g in a corner, under the 0.91–0.94 g it holds,
  // and 0.81 g on the brakes, under the 1.13 g it stops at
  braking: { lowG: 0.95, aeroG: 0, refMs: 50 },
  // 9.2° of front against 2.3° of rear slip at the peak of a 110 km/h steer ramp (1.07 g,
  // scripts/verify-vw-scirocco-gtx.ts): a nose-heavy front-driver
  understeerRadPerMs2: 0.0115,
  speedProfile: VW_SCIROCCO_PROFILE_CAR,
  // The slower line: lower grip than an F1 car moves the apexes and braking points
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.003 l/s per 1000 rpm flat out, ≈ 0.02 l/s (0.015 kg/s) at 6500 rpm
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.003,
  // Levels index the electronics tables from the most intrusive (12); 6 is the data's ABS and TC 12 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
  // A road car with 32° of lock to wind on, as the Liana's
  keyboardSteer: { lowSpeedRate: 1.3, highSpeedRate: 1, returnRate: 1.1 },
};

export function createVwSciroccoSim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, VW_SCIROCCO_SIM_PROFILE);
}
