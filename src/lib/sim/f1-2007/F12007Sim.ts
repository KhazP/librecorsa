/**
 * The F1 2007 cars in the simulator: the f12026-car adapter (`F12026CarSim`) driving `F12007_CONFIG`, one profile for
 * every team. No ERS, DRS or push mode. The 2007 cars had traction control and no ABS: pro switches the TC off, as every
 * car's pro does; semi-pro keeps the data's TC and adds a light ABS (as the other F1 cars' semi-pro does, which have none
 * either) for the AI, which brakes on the semi-pro aids; assisted tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { OPEN_WHEEL_KEYBOARD_STEER } from '@/lib/input/keyboard-steer';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { F12007_CONFIG, F12007_ELECTRONICS as E } from './F12007Config';
import type { CarSoundSource } from '../CarAudio';
import { f12007Sound } from './f12007-sounds';
import type { SpeedProfileCarModel } from '../speed-profile';

/**
 * Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound banks: the Ferrari's, the car's
 * first livery; each livery plays its team's (`f12007Sound`, `CarSkin.sound`)
 */
export const F12007_SOUND: CarSoundSource = f12007Sound('ferrari');

const C = F12007_CONFIG;
const tyreRadius = (axle: 'front' | 'rear') => C.tyreCompounds[C.compoundSlots.soft][axle].radius;

/**
 * The brake torque that reaches the road while the car slows: the wheels' spin (ANGULAR_INERTIA 0.93 / 1.25 kg·m²) and
 * the engine's through third gear (INERTIA 0.045) slow with it, ≈ 98 kg of rotating mass on 680, so ≈ 87 % of the
 * 4200 Nm decelerates the car [spec, derived]
 */
const rotatingKg =
  (2 * C.chassis.wheelInertiaFront + 2 * C.chassis.wheelInertiaRear) / tyreRadius('rear') ** 2 +
  C.engine.inertia * ((C.gearbox.ratios[2] * C.gearbox.finalDrive) / tyreRadius('rear')) ** 2;
const BRAKE_SHARE = C.chassis.totalMassKg / (C.chassis.totalMassKg + rotatingKg);

/**
 * The F1 2007's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm Softs with the garage's 35 kg of fuel (stand-in) and the wings on 45 / 60.
 * It holds 1.67 g at 54 km/h and 3.42 g at 306 (μ ≈ 1.56 of weight + downforce at 54 km/h easing to 1.11 at 306, the
 * tyres' load tables and the front's load transfer: the data's front bar is 6.5 times the rear's, so the fronts limit
 * it) and brakes at 1.95–4.26 g (μ ≈ 1.8 easing to 1.1 once drag is taken out). The plan's μ falls with the load over
 * the weight as n^−0.32 from 1.5, so it corners and brakes 4–8 % under the car at every speed. Its aero at ρ 1.07,
 * Rwanda's air, as the other cars' plans are: downforce ≈ 1.79 v² (CL·A 3.3–3.4 m², little change with speed),
 * drag 0.73 v² (CD·A 1.33–1.40 m², the rear floor's drag growing as it settles), 57–62 % of the downforce on the rear
 * axle (the share grows as the rake closes at speed); brake force and power at the wheels from the car's data.
 */
export const F12007_PROFILE_CAR: SpeedProfileCarModel = {
  // With the garage's default fuel [est, as the LC25's plan]
  massKg: C.chassis.totalMassKg + 35,
  downforceCoef: 1.79,
  dragCoef: 0.73,
  rearDownforceShare: 0.6,
  rearWeightFraction: 1 - C.chassis.frontWeightFraction,
  muLat: 1.5,
  muLong: 1.5,
  muLoadExp: 0.32,
  maxBrakeForceN:
    2 *
    C.brakes.maxTorqueNm *
    (C.brakes.front_bias / tyreRadius('front') + (1 - C.brakes.front_bias) / tyreRadius('rear')) *
    BRAKE_SHARE,
  // Peak crank power (the curve is kW) through the driveline: ≈ 537 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Seventh at the 19 000 rpm limiter with the tyres grown, ≈ 320 km/h; on the balanced wings power and drag stop it at
  // ≈ 299 km/h in sea-level air (313 on the low-downforce package), so this cap seldom binds
  vMaxMs: 89,
};

export const F12007_SIM_PROFILE: CarSimProfile = {
  id: 'f1-2007',
  config: F12007_CONFIG,
  hasErs: false,
  hasDrs: false,
  turbo: false,
  // No DRS or push-to-pass in 2007
  defaultOvertakingRules: 'none',
  // [spec setup.ini PRESSURE_*: 8–21 psi cold], stated at 20 °C for tyres that leave 90 °C blankets
  coldPsiRange: [8, 21],
  setupPressureRefC: 20,
  // [spec setup.ini CAMBER_*]: front −3.5…−2°, rear −3…−1.5°
  frontCamberRange: [-3.5, -2],
  rearCamberRange: [-3, -1.5],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The wings' setup positions run 0–100, the front in steps of 5 (set 45), the rear in steps of 10 (set 60) [spec
  // setup.ini WING_1, WING_2, aero.ini ANGLE]. Low downforce: front 0, rear 20 (CD·A −0.23 m², CL·A −0.33); high: both
  // 100 (CD·A +0.22, CL·A +0.38). Each keeps the front's 42 % of the downforce within half a point [derived]
  aeroPackagesDeg: { low_downforce: [-45, -40], balanced: [0, 0], high_downforce: [55, 40] },
  // What it holds at low speed, where the downforce is small (measure-ggv: 1.67 g at 54 km/h on 1.07 g of load)
  padLateralMu: 1.55,
  // 225° of rim lock each way on a 12:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 12,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. The car corners at 1.67–3.42 g and brakes at
  // 1.95–4.26 g (measure-ggv, at sea level), so the envelope is held under the corners: at sea level, where its aero
  // part is × 1.156 of the stored one, 1.1 × 0.85 × it is 1.65 g at 54 km/h, 2.1 g at 162, 2.97 g at 270 and 3.37 g at
  // 306
  braking: { lowG: 1.7, aeroG: 1.65, refMs: 85 },
  // As the other F1 cars' [est]. The flat-pad steer ramp measures this car's at 0.06–0.23 °/g (≈ 0.0001–0.0004 rad per
  // m/s²), under that; the borrowed value is what holds the F1 cars to their lines
  understeerRadPerMs2: 0.001,
  speedProfile: F12007_PROFILE_CAR,
  // The F1 line (no `racingLine`): a high-downforce single-seater, as the LC25 and LC26 drive it
  // Its own driver keeps to the asphalt: it has never been raced on the kerbs (`OWN_KERB_SHARE`)
  aiOwnKerbShare: 0,
  // An F1 car's ride height: the outer tyres stay off kerbs taller than the LC25's limit [est]
  aiMaxKerbRiseM: 0.05,
  // Fuel flow with the engine's speed: 0.0045 l/s per 1000 rpm flat out, ≈ 0.085 l/s at 19 000 rpm [spec car.ini FUEL
  // CONSUMPTION]
  fuelLPerS1000Rpm: 0.0045,
  // Levels index the electronics tables from the most intrusive (12): TC 6 is the data's 8 %, ABS 6 its 10 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 6, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
  keyboardSteer: OPEN_WHEEL_KEYBOARD_STEER,
};

export function createF12007Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, F12007_SIM_PROFILE);
}
