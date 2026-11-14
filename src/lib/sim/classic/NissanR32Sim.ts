/**
 * The Nissan Skyline GT-R R32 JTCC in the simulator: the f12026-car adapter (`F12026CarSim`) driving `NISSAN_R32_CONFIG`.
 * No ERS, DRS, push mode or wing adjustment. The real car has neither traction control nor ABS: pro and semi-pro leave
 * the TC off; semi-pro adds a light ABS (as the 496R's and the F1 cars' semi-pro do) for the AI, which brakes on the
 * semi-pro aids: on a dry road its 2800 Nm of brakes can't lock the slicks, in the wet they can; assisted adds the mod's
 * 10 % TC and tightens both.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import type * as THREE from 'three';
import { type CarSimProfile, F12026CarSim } from '../f12026-car/F12026CarSim';
import { NISSAN_R32_CONFIG, NISSAN_R32_ELECTRONICS as E } from './NissanR32Config';
import type { CarSoundSource } from '../CarAudio';
import type { SpeedProfileCarModel } from '../speed-profile';

/** Its own engine, gearbox and tyre sounds, ported from the Assetto Corsa car's sound bank */
export const NISSAN_R32_SOUND: CarSoundSource = {
  id: 'nissan-r32-jtcc',
  assetDir: '/cars/nissan-r32-jtcc/audio/',
  limiterRpm: NISSAN_R32_CONFIG.gearbox.gears.redline_rpm,
};

const C = NISSAN_R32_CONFIG;
const RADIUS = C.tyreCompounds[C.compoundSlots.soft].front.radius;

/**
 * The R32's planning model for its lap-time line, braking zones, braking urgency and HUD target speed: what
 * `scripts/ai/measure-ggv.ts` measures on warm tyres. It holds 1.14–1.18 g from 54 to 306 km/h, flat: the fronts limit
 * it (57.5 % of the weight, the heavy front bar) and its 0.59 m² of CL·A puts 81 % of its load on the rears, so the
 * downforce buys it nothing; the plan's μ falls as 1 / the load over the weight (`muLoadExp` 1) to hold that, cornering on
 * μ 1.12. It brakes at ≈ 1.25 g plus drag: the 2800 Nm of brake torque, not the tyres, sets the stop; the plan brakes on
 * μ 1.18 (11.6 m/s² before drag), so it never brakes later than the car can stop (a 200→0 km/h stop takes 125 m). It
 * puts down 0.79 g at 54 km/h: the rears with the weight that transfers onto them, and the fronts through the centre
 * coupling, so the traction limit, which reads one driven axle at its static share, takes 0.65 of the weight. Its aero at
 * ρ 1.07, Rwanda's air, as the GT3's and the 496R's plans are: downforce 0.32 v² (CL·A 0.59 m²), drag 0.47 v² (CD·A
 * 0.88 m²), 81 % of the downforce on the rear axle; brake force and power at the wheels from the car's data.
 */
export const NISSAN_R32_PROFILE_CAR: SpeedProfileCarModel = {
  massKg: C.chassis.totalMassKg,
  downforceCoef: 0.316,
  dragCoef: 0.471,
  rearDownforceShare: 0.81,
  rearWeightFraction: 0.65,
  muLat: 1.12,
  muLong: 1.18,
  muLoadExp: 1,
  maxBrakeForceN: (2 * C.brakes.maxTorqueNm) / RADIUS,
  // Peak crank power (the curve is kW, with the boost) through the driveline: ≈ 351 kW at the wheels
  maxDrivePowerW: Math.max(...C.engine.powerCurve.map(([, kw]) => kw)) * 1000 * C.gearbox.efficiency,
  // Above the ≈ 83 m/s drag-limited top speed, so power and drag set the straight-line speed, not this cap
  vMaxMs: 90,
};

export const NISSAN_R32_SIM_PROFILE: CarSimProfile = {
  id: 'nissan-r32-jtcc',
  config: NISSAN_R32_CONFIG,
  hasErs: false,
  hasDrs: false,
  // Twin turbos: the telemetry's boost pressure
  turbo: true,
  // [spec setup.ini]: pressures 10–30 psi, camber −4…0° at both ends
  coldPsiRange: [10, 30],
  frontCamberRange: [-4, 0],
  rearCamberRange: [-4, 0],
  tcMinSpeedMs: E.tcMinSpeedKmh / 3.6,
  electronics: E,
  // The wing and lip are fixed (setup.ini has no wing entry)
  aeroPackagesDeg: { low_downforce: [0, 0], balanced: [0, 0], high_downforce: [0, 0] },
  // What it holds at low speed, where the downforce is nothing (measure-ggv: 1.14–1.18 g)
  padLateralMu: 1.15,
  // 360° of rim lock on a 12.4:1 rack [spec car.ini STEER_LOCK, STEER_RATIO]
  steerRatio: 12.4,
  // The autopilot brakes on 85 % of this and corners on 1.1 × that. The car corners at 1.14–1.18 g whatever the speed
  // and brakes at 1.25 g plus drag (measure-ggv), so the envelope is held under the corners: 1.1 × 0.85 × it is 1.12 g
  // at low speed and 1.15 g at 306 km/h, and its braking (1.02–1.05 g) sits under the brakes' 1.25–1.6 g
  braking: { lowG: 1.2, aeroG: 0.03, refMs: 80 },
  // 5.3° of front against 2.4° of rear slip at the peak of a 100 km/h steer ramp (1.40 g, scripts/verify-nissan-r32-jtcc.ts)
  understeerRadPerMs2: 0.0037,
  speedProfile: NISSAN_R32_PROFILE_CAR,
  // The GT3's line: closed-wheel grip, nearer a GT3's than an F1 car's
  racingLine: 'gt3',
  // Fuel flow with the engine's speed: 0.004 l/s per 1000 rpm flat out, ≈ 0.03 l/s (0.022 kg/s) at 7500 rpm
  // [spec car.ini FUEL CONSUMPTION]
  fuelLPerS1000Rpm: 0.004,
  // Levels index the electronics tables from the most intrusive (12); 6 is the data's TC 10 % and ABS 12.5 %
  assistDials: {
    pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
    semi_pro: { tcLevel: 0, tc2Level: 6, absLevel: 6 },
    assisted: { tcLevel: 9, tc2Level: 9, absLevel: 9 },
  },
};

export function createNissanR32Sim(track: BuiltTrackData, root?: THREE.Object3D | null): F12026CarSim {
  return new F12026CarSim(track, root, NISSAN_R32_SIM_PROFILE);
}
