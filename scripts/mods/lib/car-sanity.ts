/**
 * A converted car's physics driven headless before it is packaged: what a player would notice at once if a conversion
 * went wrong. On the flat test pad (scripts/lib/flat-track.ts) the car launches from rest and runs flat out to its top
 * speed with the wheel held straight, then brakes to a stop from there; and on a circuit, when one is given, it
 * laps on the game's autopilot. It runs the game's own car simulation (F12026CarSim) on the profile a mod car gets
 * (mods/mod-physics.ts `modSimProfile`), so what drives here is what drives in the game.
 */
import * as THREE from "three";
import type { BuiltTrackData } from "../../../src/lib/track-data";
import type { DriverAssistPreset } from "../../../src/types/f1";
import { F12026CarSim, type CarSimProfile } from "../../../src/lib/sim/f12026-car/F12026CarSim";
import { createFlatTestTrack } from "../../lib/flat-track";

const DT = 1 / 120;
/** Body slip past which the car has spun (rad, 20°) */
const SPIN_SLIP_RAD = 0.35;
const KMH = 3.6;

export interface SanityLimits {
  /** The slowest top speed that is plausible for the car (km/h) */
  minTopSpeedKmh: number;
  /** The fastest */
  maxTopSpeedKmh: number;
  /** The longest stop from 100 km/h (m) */
  maxStop100M: number;
}

export interface SanityResult {
  ok: boolean;
  problems: string[];
  topSpeedKmh: number;
  /** Seconds from rest to 100 km/h, or null when it never got there */
  zeroTo100S: number | null;
  /** Metres to stop from 100 km/h, and from the top speed */
  stop100M: number | null;
  stopFromTopM: number | null;
  /** The largest body slip on the straight (deg) */
  maxSlipDeg: number;
  /** The widest the car strayed from its lane on the straight (m) */
  maxDriftM: number;
  lap?: { timeS: number | null; offTrackS: number; maxSlipDeg: number; spun: boolean };
}

const slipOf = (c: F12026CarSim) => Math.abs(Math.atan2(c.vyMs, Math.max(1, Math.abs(c.vxMs))));

/**
 * The wheel held straight: a car that pulls or weaves with nobody steering shows it here (a driver's corrections, at
 * gains that suit one car, set others weaving at speed)
 */
const STRAIGHT = 0;

/** Launch, top speed and braking on the flat pad, then a lap of `circuit` when given */
export function driveSanity(
  profile: CarSimProfile,
  limits: SanityLimits,
  circuit?: { track: BuiltTrackData; root: THREE.Object3D | null },
  assists: DriverAssistPreset = "semi_pro"
): SanityResult {
  const problems: string[] = [];
  const pad = createFlatTestTrack(40_000);
  const car = new F12026CarSim(pad, null, profile);
  // As most players drive it: traction control and ABS on (semi-pro), so the check is the car's, not a flat-out launch's
  car.assistPreset = assists;
  car.autoGearbox = true;
  car.autoClutch = true;
  car.teleportToDistance(200, 0, 0);

  // Flat out from rest until the speed stops rising (or 4 minutes)
  let t = 0;
  let zeroTo100S: number | null = null;
  let maxSlip = 0;
  let maxDrift = 0;
  let spun = false;
  let plateauV = 0;
  let plateauT = 0;
  while (t < 240) {
    car.step(DT, { throttle: 1, brake: 0, analogSteer: STRAIGHT });
    t += DT;
    const v = car.vxMs * KMH;
    if (zeroTo100S === null && v >= 100) zeroTo100S = t;
    maxSlip = Math.max(maxSlip, slipOf(car));
    maxDrift = Math.max(maxDrift, Math.abs(car.lateralOffsetM));
    if (slipOf(car) > SPIN_SLIP_RAD) {
      spun = true;
      break;
    }
    if (v > plateauV + 0.5) {
      plateauV = v;
      plateauT = t;
    } else if (t - plateauT > 8) break;
  }
  const topSpeedKmh = car.vxMs * KMH;
  if (spun) problems.push(`it spun under power on a straight, at ${topSpeedKmh.toFixed(0)} km/h`);
  if (!spun && maxDrift > 25) problems.push(`it pulled ${maxDrift.toFixed(1)} m off its line under power on a straight`);
  if (!spun && topSpeedKmh < limits.minTopSpeedKmh) problems.push(`top speed ${topSpeedKmh.toFixed(0)} km/h, under the ${limits.minTopSpeedKmh} km/h it should reach`);
  if (!spun && topSpeedKmh > limits.maxTopSpeedKmh) problems.push(`top speed ${topSpeedKmh.toFixed(0)} km/h, over the ${limits.maxTopSpeedKmh} km/h it could reach`);

  // Full braking from the top speed, measuring the stop from 100 km/h on the way down
  const brake = (): { fromTop: number | null; from100: number | null } => {
    const s0 = car.sMeters;
    let s100: number | null = null;
    for (let tb = 0; tb < 60; tb += DT) {
      if (s100 === null && car.vxMs * KMH <= 100) s100 = car.sMeters;
      car.step(DT, { throttle: 0, brake: 1, analogSteer: STRAIGHT });
      maxSlip = Math.max(maxSlip, slipOf(car));
      if (slipOf(car) > SPIN_SLIP_RAD) {
        problems.push("it spun under braking on a straight");
        return { fromTop: null, from100: null };
      }
      if (car.vxMs < 0.3) return { fromTop: car.sMeters - s0, from100: s100 === null ? null : car.sMeters - s100 };
    }
    problems.push("it didn't stop within a minute of full braking");
    return { fromTop: null, from100: null };
  };
  const stops = spun ? { fromTop: null, from100: null } : brake();
  if (stops.from100 !== null && stops.from100 > limits.maxStop100M) problems.push(`it took ${stops.from100.toFixed(0)} m to stop from 100 km/h (at most ${limits.maxStop100M} m)`);

  const result: SanityResult = {
    ok: false,
    problems,
    topSpeedKmh,
    zeroTo100S,
    stop100M: stops.from100,
    stopFromTopM: stops.fromTop,
    maxSlipDeg: (maxSlip * 180) / Math.PI,
    maxDriftM: maxDrift,
  };

  if (circuit) {
    // An out lap from the grid, then a flying lap, on the game's autopilot
    const lapCar = new F12026CarSim(circuit.track, circuit.root, profile);
    lapCar.assistPreset = assists;
    lapCar.aiAutopilot = true;
    lapCar.resetToStartGrid(false);
    let lapSlip = 0;
    let offTrack = 0;
    let lapSpun = false;
    let laps = 0;
    let timeS: number | null = null;
    for (let tl = 0; tl < 900 && laps < 2; tl += DT) {
      lapCar.step(DT, {});
      const tel = lapCar.telemetry;
      if (tel.offTrack) offTrack += DT;
      lapSlip = Math.max(lapSlip, slipOf(lapCar));
      if (slipOf(lapCar) > SPIN_SLIP_RAD && lapCar.vxMs > 5) lapSpun = true;
      if (tel.lapCount > laps) {
        laps = tel.lapCount;
        if (laps === 2) timeS = tel.lastLapTimeMs === null ? null : tel.lastLapTimeMs / 1000;
      }
    }
    result.lap = { timeS, offTrackS: offTrack, maxSlipDeg: (lapSlip * 180) / Math.PI, spun: lapSpun };
    if (timeS === null) problems.push("it didn't finish a lap on the autopilot within 15 minutes");
    if (lapSpun) problems.push("it spun on the autopilot's lap");
  }
  result.ok = problems.length === 0;
  return result;
}
