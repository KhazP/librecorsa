import * as THREE from "three";
import { SegmentOccluder } from "./segment-occluder";
import { carJumped, type ChaseCameraInput, DynamicChaseCamera } from "./chase-camera";
import { CAMERA_MODES, FALLBACK_COCKPIT_FOV_DEG } from "./camera-modes";
import { clampFov } from "@/lib/settings/player-settings";
import type { CameraMode, CarTelemetry, TrackSamplePoint } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";
import type { SimulatorCar } from "@/lib/sim/simulator-car";
import type { Lc26CameraAnchor } from "@/lib/lc26-car-model";

const TWO_PI = Math.PI * 2;
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// Cockpit micro-shake
// ---------------------------------------------------------------------------------------------------------------

const SHAKE_HPF_HZ = 2;
const SHAKE_HPF_RC = 1 / (TWO_PI * SHAKE_HPF_HZ);
/** Leaky integral of the high-passed suspension velocity, so the displacement estimate cannot drift */
const SHAKE_LEAK_S = 0.5;
/** Body rotation per mm of axle differential, with a little gain for visibility (rad per mm) */
const WHEELBASE_MM = 3400;
const TRACK_MM = 1460;
const PITCH_GAIN = 1.5;
const ROLL_GAIN = 1.5;
const HEAVE_GAIN_M_PER_MM = 0.5e-3;

const SHAKE_FREQ_HZ = 9;
const SHAKE_ZETA = 0.35;

const PITCH_LIMIT_RAD = 0.6 * DEG2RAD;
const ROLL_LIMIT_RAD = 0.6 * DEG2RAD;
const HEAVE_LIMIT_M = 0.004;

/** Kerb-strike velocity kicks at 120 km/h (scaled by speed) */
const KERB_ROLL_KICK_RAD_S = 0.25;
const KERB_PITCH_KICK_RAD_S = 0.1;
const KERB_HEAVE_KICK_M_S = 0.05;
/** Random angular acceleration (rad/s^2) while a kerb is under a wheel, scaled by speed */
const KERB_NOISE_RAD_S2 = 4;

export interface MicroShakeOutput {
  /** Chassis pitch, rad. Positive = nose down (rotation about +X) */
  pitchRad: number;
  /** Chassis roll, rad. Positive = left side up (rotation about +Z) */
  rollRad: number;
  /** Chassis heave, m. Positive = up */
  heaveM: number;
}

/**
 * Small, fast chassis motion from the suspension: the four travel signals are differentiated, high-passed at
 * 2 Hz, leaky-integrated into an axle-differential estimate, and fed to a 9 Hz / zeta 0.35 spring-damper per axis.
 * Kerb strikes add velocity kicks on the rising edge of onKerbLeft/onKerbRight, plus noise while on a kerb.
 * Output is clamped to 0.6 deg pitch/roll and 4 mm heave. The same object is returned on every call.
 */
export class CockpitMicroShake {
  private readonly out: MicroShakeOutput = { pitchRad: 0, rollRad: 0, heaveM: 0 };
  private readonly prevTravel = new Float64Array(4);
  private readonly prevVel = new Float64Array(4);
  private readonly hpfVel = new Float64Array(4);
  private readonly disp = new Float64Array(4);
  private pitch = 0;
  private pitchV = 0;
  private roll = 0;
  private rollV = 0;
  private heave = 0;
  private heaveV = 0;
  private prevKerbL = false;
  private prevKerbR = false;
  private seed = 0x2545f491;
  private initialised = false;

  update(dt: number, t: CarTelemetry): MicroShakeOutput {
    const travel = t.suspensionTravelMm;
    const h = dt > 0 ? Math.min(dt, 0.05) : 0;

    if (!this.initialised) {
      for (let i = 0; i < 4; i++) {
        this.prevTravel[i] = travel[i];
        this.prevVel[i] = 0;
        this.hpfVel[i] = 0;
        this.disp[i] = 0;
      }
      this.prevKerbL = t.onKerbLeft;
      this.prevKerbR = t.onKerbRight;
      this.initialised = true;
      return this.write();
    }
    if (h <= 0) return this.write();

    // Velocity -> one-pole high-pass (2 Hz) -> leaky integral = high-passed axle travel (mm)
    const aHp = SHAKE_HPF_RC / (SHAKE_HPF_RC + h);
    const leak = Math.exp(-h / SHAKE_LEAK_S);
    for (let i = 0; i < 4; i++) {
      const vel = (travel[i] - this.prevTravel[i]) / h;
      const hp = aHp * (this.hpfVel[i] + vel - this.prevVel[i]);
      this.hpfVel[i] = hp;
      this.prevVel[i] = vel;
      this.prevTravel[i] = travel[i];
      this.disp[i] = this.disp[i] * leak + hp * h;
    }

    // Combine corners into pitch / roll / heave targets. Index order is FL, FR, RL, RR.
    const front = (this.disp[0] + this.disp[1]) * 0.5;
    const rear = (this.disp[2] + this.disp[3]) * 0.5;
    const left = (this.disp[0] + this.disp[2]) * 0.5;
    const right = (this.disp[1] + this.disp[3]) * 0.5;
    const mean = (this.disp[0] + this.disp[1] + this.disp[2] + this.disp[3]) * 0.25;
    const pitchTarget = clampAbs(((front - rear) / WHEELBASE_MM) * PITCH_GAIN, PITCH_LIMIT_RAD * 2);
    const rollTarget = clampAbs(((right - left) / TRACK_MM) * ROLL_GAIN, ROLL_LIMIT_RAD * 2);
    const heaveTarget = clampAbs(-mean * HEAVE_GAIN_M_PER_MM, HEAVE_LIMIT_M * 2);

    // Kerb strikes
    const speed = clamp01(t.speedKmh / 120);
    if (t.onKerbLeft && !this.prevKerbL) {
      this.rollV -= KERB_ROLL_KICK_RAD_S * speed;
      this.pitchV += KERB_PITCH_KICK_RAD_S * speed;
      this.heaveV += KERB_HEAVE_KICK_M_S * speed;
    }
    if (t.onKerbRight && !this.prevKerbR) {
      this.rollV += KERB_ROLL_KICK_RAD_S * speed;
      this.pitchV += KERB_PITCH_KICK_RAD_S * speed;
      this.heaveV += KERB_HEAVE_KICK_M_S * speed;
    }
    this.prevKerbL = t.onKerbLeft;
    this.prevKerbR = t.onKerbRight;
    if (t.onKerbLeft || t.onKerbRight) {
      const n = this.noise() * KERB_NOISE_RAD_S2 * speed * h;
      this.rollV += t.onKerbLeft ? -n : n;
      this.pitchV += this.noise() * KERB_NOISE_RAD_S2 * 0.5 * speed * h;
    }

    // Spring-damper per axis, semi-implicit Euler in two substeps
    const omega = TWO_PI * SHAKE_FREQ_HZ;
    const omega2 = omega * omega;
    const damp = 2 * SHAKE_ZETA * omega;
    const hs = h * 0.5;
    for (let s = 0; s < 2; s++) {
      this.pitchV += (omega2 * (pitchTarget - this.pitch) - damp * this.pitchV) * hs;
      this.pitch += this.pitchV * hs;
      this.rollV += (omega2 * (rollTarget - this.roll) - damp * this.rollV) * hs;
      this.roll += this.rollV * hs;
      this.heaveV += (omega2 * (heaveTarget - this.heave) - damp * this.heaveV) * hs;
      this.heave += this.heaveV * hs;
    }

    // Clamp; zero the velocity at the limit so the spring does not wind up
    if (Math.abs(this.pitch) > PITCH_LIMIT_RAD) {
      this.pitch = Math.sign(this.pitch) * PITCH_LIMIT_RAD;
      this.pitchV = 0;
    }
    if (Math.abs(this.roll) > ROLL_LIMIT_RAD) {
      this.roll = Math.sign(this.roll) * ROLL_LIMIT_RAD;
      this.rollV = 0;
    }
    if (Math.abs(this.heave) > HEAVE_LIMIT_M) {
      this.heave = Math.sign(this.heave) * HEAVE_LIMIT_M;
      this.heaveV = 0;
    }
    return this.write();
  }

  reset(): void {
    this.out.pitchRad = 0;
    this.out.rollRad = 0;
    this.out.heaveM = 0;
    this.prevTravel.fill(0);
    this.prevVel.fill(0);
    this.hpfVel.fill(0);
    this.disp.fill(0);
    this.pitch = 0;
    this.pitchV = 0;
    this.roll = 0;
    this.rollV = 0;
    this.heave = 0;
    this.heaveV = 0;
    this.initialised = false;
  }

  private write(): MicroShakeOutput {
    this.out.pitchRad = this.pitch;
    this.out.rollRad = this.roll;
    this.out.heaveM = this.heave;
    return this.out;
  }

  /** Deterministic LCG in [-1, 1): no allocation, same sequence every run */
  private noise(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampAbs(x: number, limit: number): number {
  return x > limit ? limit : x < -limit ? -limit : x;
}

// ---------------------------------------------------------------------------------------------------------------
// Trackside broadcast director
// ---------------------------------------------------------------------------------------------------------------

const STATION_SPACING_M = 280;
const STATION_MIN = 14;
const STATION_MAX = 20;
/** Share of the car's travel through a station's sector that the dolly follows (the car passes a slower camera) */
const DOLLY_RATIO = 0.55;
/** Control points per dolly spline (enough to follow a corner over the longer travel) */
const DOLLY_POINTS = 6;
/** Lateral distance of the camera from the centreline, on the outside of the corner */
const OFFSET_M = 32;
/** Camera heights above the track, cycled per station (3.5..8 m range) */
const HEIGHTS_M = [4.5, 5.5, 6.5] as const;
/** Window used to refine a station onto the strongest curvature, and to decide which side is outside */
const APEX_SEARCH_M = 60;
const SIDE_WINDOW_M = 80;
const SIDE_CURVE_THRESHOLD_RAD = 0.05;
/** Switch to a new station only when it is this much closer (m) than the current one */
const SWITCH_HYSTERESIS_M = 40;

const FRAME_HALF_HEIGHT_M = 7.5;
const FOV_MIN_DEG = 18;
const FOV_MAX_DEG = 24;
const FOV_SMOOTH_S = 0.5;
const KERB_TIGHTEN_DEG = 3;
const KERB_IN_S = 0.12;
const KERB_OUT_S = 0.35;

const LOOK_SMOOTH_S = 0.15;
const LOOK_LEAD_S = 0.15;
const LOOK_HEIGHT_M = 0.6;
/** A hit closer than this to the car's end of the sight line counts as clear (the car's own surroundings) */
const OCCLUSION_MARGIN_M = 6;
/** Fallback placements for a blocked station: [side multiplier, offset from centreline (m), extra height (m)] */
const OCCLUSION_ALTERNATIVES: readonly (readonly [number, number, number])[] = [
  [-1, OFFSET_M, 0],
  [1, 20, 0],
  [-1, 20, 0],
  [1, 20, 8],
  [-1, 20, 8],
  [1, 14, 14],
  [-1, 14, 14],
];

export interface BroadcastCameraOutput {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  fovDeg: number;
  cameraIndex: number;
  /** True for the one frame in which the station changed; the caller should snap instead of smoothing */
  cut: boolean;
}

/**
 * Automatic trackside TV cameras. Stations sit on the outside of the lap's corners about 32 m from the
 * centreline and 4.5 to 6.5 m high. Each owns a four-point CatmullRom dolly spanning 70 m, parallel to the track,
 * that the camera glides along as the car passes. The active station is the nearest by track distance, with
 * hysteresis. Look-at is critically damped and leads the car by its velocity; FOV holds the car at a roughly
 * constant screen size (clamped to 18..24 deg) and tightens 3 deg on kerbs. The output object is preallocated and
 * returned on every call.
 */
export class TracksideBroadcastDirector {
  private readonly lengthM: number;
  private readonly sampleCount: number;
  private readonly ds: number;
  private readonly samples: BuiltTrackData["samples"];
  private readonly stationCount: number;
  private readonly centreS: Float64Array;
  private readonly curves: THREE.CatmullRomCurve3[];
  private readonly stationSide: number[] = [];
  /** Half the track distance between stations: the car's travel through one station's sector (m) */
  private readonly sectorHalfM: number;
  /** Half the dolly's own length along the track (m) */
  private readonly dollyHalfM: number;

  private readonly out: BroadcastCameraOutput = {
    position: new THREE.Vector3(),
    lookAt: new THREE.Vector3(),
    fovDeg: FOV_MAX_DEG,
    cameraIndex: 0,
    cut: false,
  };
  private readonly lookVel = new THREE.Vector3();
  private readonly lead = new THREE.Vector3();
  /** Station on air; -1 until the next update primes the director (after construction, reset() or a jump) */
  private current = -1;
  /** occlusionSteps moved the dolly of the station on air: the next update cuts to it instead of gliding */
  private recut = false;
  /** Where the car was at the last update, to notice frames this director missed (another camera was on) */
  private readonly lastCarPos = new THREE.Vector3();
  private fovBase = FOV_MAX_DEG;
  private kerbAmt = 0;

  constructor(track: BuiltTrackData) {
    this.samples = track.samples;
    this.sampleCount = track.samples.length;
    this.lengthM = track.totalLengthM;
    this.ds = this.lengthM / this.sampleCount;

    const n = Math.min(STATION_MAX, Math.max(STATION_MIN, Math.round(this.lengthM / STATION_SPACING_M)));
    this.stationCount = n;
    this.sectorHalfM = this.lengthM / n / 2;
    this.dollyHalfM = this.sectorHalfM * DOLLY_RATIO;
    this.centreS = new Float64Array(n);
    this.curves = [];

    for (let k = 0; k < n; k++) {
      const nominal = ((k + 0.5) * this.lengthM) / n;

      // Refine onto the strongest curvature nearby so the station covers a corner where there is one
      let centre = nominal;
      let bestCurv = -1;
      for (let o = -APEX_SEARCH_M; o <= APEX_SEARCH_M; o += this.ds) {
        const c = Math.abs(this.sampleAt(nominal + o).curvature);
        if (c > bestCurv) {
          bestCurv = c;
          centre = this.wrapS(nominal + o);
        }
      }
      this.centreS[k] = centre;

      // Outside of the dominant bend: right-hand bends (curvature > 0) are watched from the left
      let turnRad = 0;
      for (let o = -SIDE_WINDOW_M; o <= SIDE_WINDOW_M; o += this.ds) {
        turnRad += this.sampleAt(centre + o).curvature * this.ds;
      }
      let side: number;
      if (turnRad > SIDE_CURVE_THRESHOLD_RAD) side = -1;
      else if (turnRad < -SIDE_CURVE_THRESHOLD_RAD) side = 1;
      else side = k % 2 === 0 ? -1 : 1;

      this.stationSide.push(side);
      this.curves.push(this.buildDolly(centre, side, OFFSET_M, HEIGHTS_M[k % HEIGHTS_M.length]));
    }
  }

  /** Track distance of a dolly control point */
  private dollyS(centre: number, j: number): number {
    return centre - this.dollyHalfM + (j * 2 * this.dollyHalfM) / (DOLLY_POINTS - 1);
  }

  /** A station's dolly: points equally spaced along the track, so the curve parameter maps linearly onto track distance */
  private buildDolly(centre: number, side: number, offsetM: number, heightM: number): THREE.CatmullRomCurve3 {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j < DOLLY_POINTS; j++) {
      const s = this.dollyS(centre, j);
      const sample = this.sampleAt(s);
      const p = sample.position.clone().addScaledVector(sample.binormal, side * offsetM);
      p.y += heightM;
      pts.push(p);
    }
    return new THREE.CatmullRomCurve3(pts, false, "centripetal");
  }

  /**
   * Moves stations whose view of the track is blocked (grandstands, buildings, trees, terrain): each dolly is
   * checked with rays from its points to the car's height on the centreline below them, and replaced by the
   * first clear alternative (the other side, closer in, higher up). Run once, when the circuit has loaded, in steps
   * (each yields the stations moved so far) that a caller spreads over idle time: the scan is indexed a few thousand
   * triangles at a time (segment-occluder.ts), then one sight line per step. Three's Raycaster tested every triangle
   * of the scan per ray, ~100 ms on Firefox, which stalled the first 15 s of driving on the Sketchfab circuits.
   */
  *occlusionSteps(trackRoot: THREE.Object3D): Generator<number, void, void> {
    const occluders: THREE.Object3D[] = [];
    trackRoot.traverseVisible((obj) => {
      if ((obj as THREE.Mesh).isMesh) occluders.push(obj);
    });
    // Indexed once, in slices (a scan is up to 1.4 M triangles); each sight line then tests only what it crosses
    const occluder = new SegmentOccluder();
    const build = occluder.build(occluders);
    while (!build.next().done) yield 0;
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let moved = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the nested generator needs the director
    const self = this;
    /** Whether every sight line of a dolly is clear; yields after each raycast */
    function* clear(curve: THREE.CatmullRomCurve3, centre: number): Generator<number, boolean, void> {
      for (let j = 0; j < DOLLY_POINTS; j++) {
        const from = curve.points[j];
        // Sight line to where the car is when the camera is at this point (it is ahead of the camera on the
        // approach and behind it on the way out)
        const sample = self.sampleAt(centre + (self.dollyS(centre, j) - centre) / DOLLY_RATIO);
        target.copy(sample.position);
        target.y += LOOK_HEIGHT_M;
        dir.subVectors(target, from);
        const dist = dir.length();
        const blocked = occluder.blocked(from, dir.divideScalar(dist), dist - OCCLUSION_MARGIN_M);
        yield moved;
        if (blocked) return false;
      }
      return true;
    }
    for (let k = 0; k < this.stationCount; k++) {
      const centre = this.centreS[k];
      if (!(yield* clear(this.curves[k], centre))) {
        const side = this.stationSide[k];
        const height = HEIGHTS_M[k % HEIGHTS_M.length];
        for (const [sideMul, offset, extraH] of OCCLUSION_ALTERNATIVES) {
          const curve = this.buildDolly(centre, side * sideMul, offset, height + extraH);
          if (yield* clear(curve, centre)) {
            this.curves[k] = curve;
            if (k === this.current) this.recut = true;
            moved++;
            break;
          }
        }
      }
    }
    yield moved;
  }

  update(dt: number, carPos: THREE.Vector3, carS: number, carVel: THREE.Vector3, onKerb: boolean): BroadcastCameraOutput {
    const out = this.out;
    const h = dt > 0 ? Math.min(dt, 0.1) : 0;

    // Updated only while the TV camera is on: a car that has moved further than one frame allows since the last
    // update (another camera was on, a teleport) starts the director over rather than gliding from a stale station
    if (this.current >= 0 && carJumped(this.lastCarPos, carPos, carVel, dt)) this.current = -1;
    this.lastCarPos.copy(carPos);

    // Station choice: nearest by track distance, with hysteresis
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < this.stationCount; k++) {
      const score = Math.abs(this.wrapDelta(carS - this.centreS[k]));
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    let cut = false;
    if (this.current < 0) {
      this.current = best;
      cut = true;
    } else if (best !== this.current) {
      const curScore = Math.abs(this.wrapDelta(carS - this.centreS[this.current]));
      if (curScore > bestScore + SWITCH_HYSTERESIS_M) {
        this.current = best;
        cut = true;
      }
    }
    if (this.recut) {
      cut = true;
      this.recut = false;
    }
    const k = this.current;

    // Dolly: glide along the station's spline as the car passes its section
    const d = this.wrapDelta(carS - this.centreS[k]);
    const u = clamp01((d + this.sectorHalfM) / (2 * this.sectorHalfM));
    this.curves[k].getPoint(u, out.position);

    // Look-at: critically damped, leading the car by its velocity
    this.lead.copy(carVel).multiplyScalar(LOOK_LEAD_S).add(carPos);
    this.lead.y += LOOK_HEIGHT_M;
    if (cut) {
      out.lookAt.copy(this.lead);
      this.lookVel.set(0, 0, 0);
    } else {
      smoothDamp3(out.lookAt, this.lead, this.lookVel, LOOK_SMOOTH_S, h);
    }

    // Telephoto FOV: keep the car at roughly constant screen size, clamped; tighten on kerbs
    const dist = out.position.distanceTo(carPos);
    const fovTarget = clampRange(
      2 * Math.atan(FRAME_HALF_HEIGHT_M / Math.max(dist, 1)) * RAD2DEG,
      FOV_MIN_DEG + KERB_TIGHTEN_DEG,
      FOV_MAX_DEG
    );
    const kerbTarget = onKerb ? 1 : 0;
    if (cut) {
      this.fovBase = fovTarget;
      this.kerbAmt = kerbTarget;
    } else {
      this.fovBase += (fovTarget - this.fovBase) * (1 - Math.exp(-h / FOV_SMOOTH_S));
      const tau = kerbTarget > this.kerbAmt ? KERB_IN_S : KERB_OUT_S;
      this.kerbAmt += (kerbTarget - this.kerbAmt) * (1 - Math.exp(-h / tau));
    }
    // The base framing leaves KERB_TIGHTEN_DEG of headroom, so the kerb zoom stays inside the 18-24 deg range
    out.fovDeg = clampRange(this.fovBase - KERB_TIGHTEN_DEG * this.kerbAmt, FOV_MIN_DEG, FOV_MAX_DEG);

    out.cameraIndex = k;
    out.cut = cut;
    return out;
  }

  reset(): void {
    this.current = -1;
    this.recut = false;
    this.fovBase = FOV_MAX_DEG;
    this.kerbAmt = 0;
    this.lookVel.set(0, 0, 0);
    this.out.cut = false;
  }

  private wrapS(s: number): number {
    const L = this.lengthM;
    return ((s % L) + L) % L;
  }

  /** Signed track distance from `a` to the station, wrapped to (-L/2, L/2] */
  private wrapDelta(x: number): number {
    const L = this.lengthM;
    let w = ((x % L) + L) % L;
    if (w > L * 0.5) w -= L;
    return w;
  }

  private sampleAt(s: number): TrackSamplePoint {
    const idx = Math.round(this.wrapS(s) / this.ds) % this.sampleCount;
    return this.samples[idx];
  }
}

function clampRange(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Unity-style critically damped smoothing of a vector toward `target`, in place, no allocation */
function smoothDamp3(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, h: number): void {
  const omega = 2 / smoothTime;
  const x = omega * h;
  const expo = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  // Per-axis, unrolled to keep it allocation-free
  let change = cur.x - target.x;
  let temp = (vel.x + omega * change) * h;
  vel.x = (vel.x - omega * temp) * expo;
  cur.x = target.x + (change + temp) * expo;

  change = cur.y - target.y;
  temp = (vel.y + omega * change) * h;
  vel.y = (vel.y - omega * temp) * expo;
  cur.y = target.y + (change + temp) * expo;

  change = cur.z - target.z;
  temp = (vel.z + omega * change) * h;
  vel.z = (vel.z - omega * temp) * expo;
  cur.z = target.z + (change + temp) * expo;
}

// ---------------------------------------------------------------------------------------------------------------
// The view camera: each view's placement, the menus' orbit and the driver's neck
// ---------------------------------------------------------------------------------------------------------------

// Rotates a camera (which looks down -Z) to look along the car's +Z forward axis
const CAM_FORWARD_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const CAM_X_AXIS = new THREE.Vector3(1, 0, 0);

/** What the view camera reads from the player's car */
export type CameraRigCar = Pick<
  SimulatorCar,
  | "telemetry"
  | "worldPosition"
  | "worldQuaternion"
  | "wheelbaseM"
  | "cgHeightM"
  | "rideHeightOffsetM"
  | "pitchRad"
  | "rollRad"
  | "yawRateRadS"
  | "vxMs"
  | "vyMs"
  | "sMeters"
  | "lateralOffsetM"
>;

/** One frame of the view camera */
export interface CameraRigFrame {
  dt: number;
  nowMs: number;
  /** The view to place (the menus pass "chase", which their orbit then replaces) */
  mode: CameraMode;
  car: CameraRigCar;
  /** Where the car is drawn this frame (its pose carried forward by the physics' unstepped remainder) */
  carPos: THREE.Vector3;
  carVelocity: THREE.Vector3;
  /** The car model's anchor for this view, on its sprung chassis; null places the view from the car's pose instead */
  anchor: Lc26CameraAnchor | null;
  chassis: THREE.Object3D;
  /** Degrees the player's FOV setting moves the onboard views off the car's own */
  onboardFovShift: number;
  headMovement: "natural" | "static";
  /** The car is being driven (not paused, in a menu or in a replay) */
  driving: boolean;
  /** In a VR headset, which is the driver's head */
  inVr: boolean;
  /** In the menus: the attract orbit (closer on the car-select step), framed for a viewport of width × height */
  menu: { close: boolean; width: number; height: number } | null;
}

/**
 * Places the view camera every frame: on the car model's onboard anchor when it has one for the view, else from the
 * car's pose (the chase camera, the procedural onboard views, the helicopter, the trackside TV cameras); then the
 * menus' orbit, and the driver's neck in the views at the driver's head. The fallback onboard poses are tuned to the
 * procedural LC26 and apply to any car without anchors.
 */
export class CameraRig {
  private readonly cockpitShake = new CockpitMicroShake();
  private readonly shakeQuat = new THREE.Quaternion();
  private readonly shakeEuler = new THREE.Euler();
  private readonly anchorPitch = new THREE.Quaternion();
  private readonly chaseCamera = new DynamicChaseCamera();
  private readonly chaseInput: ChaseCameraInput = {
    carPos: new THREE.Vector3(),
    carQuaternion: new THREE.Quaternion(),
    carVelocity: new THREE.Vector3(),
    longitudinalG: 0,
    lateralG: 0,
    verticalG: 1,
    wheelbaseM: 0,
    cgHeightM: 0,
    rideHeightOffsetM: 0,
    kerbShakeM: 0,
    manualOverrideActive: false,
  };
  /** Automatic trackside broadcast cameras on dolly splines (telephoto, zooming in over kerbs) */
  private readonly tvDirector: TracksideBroadcastDirector;
  private readonly smoothedHeliPos = new THREE.Vector3();
  private readonly smoothedHeliLook = new THREE.Vector3();
  /** Where the helicopter last saw the car, and whether it starts over on its next frame (first use, reset()) */
  private readonly heliLastCarPos = new THREE.Vector3();
  private heliSnap = true;
  private menuOrbitRad = 0.6;
  private menuViewOffset = false;
  // Neck FX: velocity-aligned slide look, steering look, 25 m track-spline apex lookahead, and horizon roll stabilization
  private neckYaw = 0;
  private neckPitch = 0;
  private neckRoll = 0;
  private neckDriftState = 1;
  private readonly neckQuat = new THREE.Quaternion();
  private readonly neckPitchQuat = new THREE.Quaternion();
  private readonly neckRollQuat = new THREE.Quaternion();
  private readonly neckLookDelta = new THREE.Vector3();
  /** The head's sense of "up": follows the car's up with a 0.4 s lag, so quick body pitch and roll are held off */
  private readonly headUp = new THREE.Vector3(0, 1, 0);
  private readonly headCross = new THREE.Vector3();
  // Per-frame scratch
  private readonly carRight = new THREE.Vector3();
  private readonly carUp = new THREE.Vector3();
  private readonly carForward = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly track: BuiltTrackData
  ) {
    this.tvDirector = new TracksideBroadcastDirector(track);
  }

  /** Moves broadcast cameras that would film the inside of a grandstand (see TracksideBroadcastDirector) */
  occlusionSteps(trackRoot: THREE.Object3D): Generator<number, void, void> {
    return this.tvDirector.occlusionSteps(trackRoot);
  }

  /** Starts the smoothed cameras over: the run started over, or the replay moved the drawn car */
  reset(): void {
    this.cockpitShake.reset();
    this.chaseCamera.reset();
    this.tvDirector.reset();
    this.heliSnap = true;
  }

  update(f: CameraRigFrame): void {
    const camera = this.camera;
    const physics = f.car;
    const dtSeconds = f.dt;
    const nowMs = f.nowMs;
    const mode = f.mode;
    const view = CAMERA_MODES[mode];
    const renderCarPos = f.carPos;
    const shake = this.cockpitShake.update(dtSeconds, physics.telemetry);

    // Right-handed car basis: +X is carLeft, -X is carRight, +Y is carUp, +Z is carForward
    const carRight = this.carRight.set(-1, 0, 0).applyQuaternion(physics.worldQuaternion);
    const carUp = this.carUp.set(0, 1, 0).applyQuaternion(physics.worldQuaternion);
    const carForward = this.carForward.set(0, 0, 1).applyQuaternion(physics.worldQuaternion);

    const speedNorm = THREE.MathUtils.clamp(physics.telemetry.speedKmh / 350, 0, 1);
    const kerbShake = physics.telemetry.onKerbLeft || physics.telemetry.onKerbRight ? Math.sin(nowMs * 0.095) * 0.018 : 0;
    const highSpeedBuffet = speedNorm > 0.72 ? Math.sin(nowMs * 0.07) * 0.007 * (speedNorm - 0.72) : 0;
    const target = this.target;

    const anchor = f.anchor;
    if (anchor) {
      // Onboard camera anchors from the car model: bolted to the sprung chassis at the
      // model's position, pitch and field of view
      f.chassis.updateWorldMatrix(true, false);
      camera.position.copy(anchor.pos).applyMatrix4(f.chassis.matrixWorld);
      f.chassis.getWorldQuaternion(camera.quaternion);
      camera.quaternion.multiply(CAM_FORWARD_FLIP).multiply(this.anchorPitch.setFromAxisAngle(CAM_X_AXIS, anchor.pitchRad));
      const headLocked = view.driverHead && f.headMovement === "static";
      if (!headLocked) {
        // Micro-shake: pitch about the lens' X axis, roll about its view axis, heave along the car's up
        this.shakeEuler.set(shake.pitchRad, 0, shake.rollRad);
        camera.quaternion.multiply(this.shakeQuat.setFromEuler(this.shakeEuler));
        camera.position.addScaledVector(carUp, shake.heaveM);
      }
      camera.up.copy(carUp);
      // The player's FOV shifts the driver's-eye cameras together, keeping the model's framing between them
      const targetOnboardFov = view.playerFov ? clampFov(anchor.fovDeg + f.onboardFovShift) : anchor.fovDeg;
      if (camera.fov !== targetOnboardFov) {
        camera.fov = targetOnboardFov;
        camera.updateProjectionMatrix();
      }
    } else if (mode === "chase") {
      const chaseInput = this.chaseInput;
      chaseInput.carPos = renderCarPos;
      chaseInput.carQuaternion = physics.worldQuaternion;
      chaseInput.carVelocity = f.carVelocity;
      chaseInput.longitudinalG = physics.telemetry.longitudinalG;
      chaseInput.lateralG = physics.telemetry.lateralG;
      chaseInput.verticalG = physics.telemetry.verticalG;
      chaseInput.wheelbaseM = physics.wheelbaseM;
      chaseInput.cgHeightM = physics.cgHeightM;
      chaseInput.rideHeightOffsetM = physics.rideHeightOffsetM;
      chaseInput.kerbShakeM = kerbShake;
      chaseInput.manualOverrideActive = physics.telemetry.manualOverrideActive;
      const chase = this.chaseCamera.update(dtSeconds, chaseInput);
      camera.position.copy(chase.position);
      camera.up.copy(chase.up);
      camera.lookAt(chase.lookAt);
      camera.fov = chase.fovDeg;
      camera.updateProjectionMatrix();
    } else if (mode === "tv_pod") {
      // Broadcast Roll-Hoop T-Cam mounted at front lens of T-Cam pod looking down over painted helmet #16, butterfly wheel + gloved hand, Halo arch, mirrors, wheel brows & nose cone
      camera.position
        .copy(renderCarPos)
        .addScaledVector(carForward, -0.06)
        .addScaledVector(carRight, -0.02 - physics.rollRad * 0.3)
        .addScaledVector(carUp, 0.905 + physics.rideHeightOffsetM + kerbShake * 0.4);
      camera.up
        .copy(carUp)
        .addScaledVector(carRight, -physics.rollRad * 0.25)
        .normalize();
      camera.lookAt(
        target
          .copy(renderCarPos)
          .addScaledVector(carForward, 3.6)
          .addScaledVector(carRight, -physics.yawRateRadS * 0.12)
          .addScaledVector(carUp, 0.22 - physics.pitchRad * 2.2 + highSpeedBuffet)
      );
      camera.fov = 60 + speedNorm * 5 + f.onboardFovShift;
      camera.updateProjectionMatrix();
    } else if (mode === "cockpit_shoulder") {
      // Reference Image 2: Left Over-the-Shoulder Cockpit Bolster Camera showing helmet on right, yellow gloved hand on butterfly steering wheel, Halo arch & left mirror/wheel brow
      camera.position
        .copy(renderCarPos)
        .addScaledVector(carForward, 0.06)
        .addScaledVector(carRight, -0.24 - physics.rollRad * 0.22)
        .addScaledVector(carUp, 0.715 + physics.rideHeightOffsetM + kerbShake * 0.35);
      camera.up
        .copy(carUp)
        .addScaledVector(carRight, -physics.rollRad * 0.22)
        .normalize();
      camera.lookAt(
        target
          .copy(renderCarPos)
          .addScaledVector(carForward, 5.5)
          .addScaledVector(carRight, 0.13 - physics.yawRateRadS * 0.25)
          .addScaledVector(carUp, 0.4 - physics.pitchRad * 2.8 + highSpeedBuffet)
      );
      camera.fov = 58 + speedNorm * 5 + f.onboardFovShift;
      camera.updateProjectionMatrix();
    } else if (mode === "cockpit" || mode === "dash") {
      // The dash view has no pose of its own before a model's anchors arrive: it waits at the driver's eye
      // Reference Image 3: Driver Eye-Point Camera inside cockpit framing full Butterfly Steering Wheel OLED, Labeled Buttons, Rotary Dials, 3D Gloved Hands, Wing Mirrors & Wheel Brows under Halo
      camera.position
        .copy(renderCarPos)
        .addScaledVector(carForward, 0.21 - physics.pitchRad * 0.2)
        .addScaledVector(carRight, -physics.rollRad * 0.22)
        .addScaledVector(carUp, 0.675 + physics.rideHeightOffsetM + kerbShake * 0.32);
      camera.up
        .copy(carUp)
        .addScaledVector(carRight, -physics.rollRad * 0.2)
        .normalize();
      camera.lookAt(
        target
          .copy(renderCarPos)
          .addScaledVector(carForward, 8.0)
          .addScaledVector(carUp, 0.5 - physics.pitchRad * 3.5 + highSpeedBuffet)
          .addScaledVector(carRight, -physics.yawRateRadS * 0.3)
      );
      camera.fov = FALLBACK_COCKPIT_FOV_DEG + speedNorm * 4 + f.onboardFovShift;
      camera.updateProjectionMatrix();
    } else if (mode === "nose") {
      // Reference Image 4: Forward Nose-Cone Camera showing narrow Nose Tip, delicate Y-Pitot Probe, curved vertical Front Wing Endplates at bottom corners & 3D Dashed Braking Line
      camera.position
        .copy(renderCarPos)
        .addScaledVector(carForward, 1.66)
        .addScaledVector(carUp, 0.455 + physics.rideHeightOffsetM + kerbShake * 0.32);
      camera.up.copy(carUp);
      camera.lookAt(
        target
          .copy(renderCarPos)
          .addScaledVector(carForward, 18.0)
          .addScaledVector(carUp, 0.25 - physics.pitchRad * 5.0)
      );
      camera.fov = 64 + speedNorm * 4;
      camera.updateProjectionMatrix();
    } else if (mode === "helicopter") {
      const heliTarget = target.copy(renderCarPos).addScaledVector(carForward, -28);
      heliTarget.x += 14;
      heliTarget.y += 24;
      heliTarget.z += 14;
      // Updated only while this view is on, like the chase and TV cameras: a car further than one frame allows from where
      // it last saw it (another view was on, a replay scrub) puts the helicopter straight over it rather than flying across
      if (this.heliSnap || carJumped(this.heliLastCarPos, renderCarPos, f.carVelocity, dtSeconds)) {
        this.heliSnap = false;
        this.smoothedHeliPos.copy(heliTarget);
        this.smoothedHeliLook.copy(renderCarPos);
      } else {
        this.smoothedHeliPos.lerp(heliTarget, Math.min(1, dtSeconds * 6));
      }
      this.smoothedHeliLook.lerp(
        this.lookTarget.copy(renderCarPos).addScaledVector(carForward, 14),
        Math.min(1, dtSeconds * 12)
      );
      this.heliLastCarPos.copy(renderCarPos);
      camera.position.copy(this.smoothedHeliPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(this.smoothedHeliLook);
      camera.fov = 52;
      camera.updateProjectionMatrix();
    } else if (mode === "tv_side") {
      // Trackside broadcast: telephoto spline cameras that pan with the car and zoom in over kerbs
      const tv = this.tvDirector.update(
        dtSeconds,
        renderCarPos,
        physics.sMeters,
        f.carVelocity,
        physics.telemetry.onKerbLeft || physics.telemetry.onKerbRight
      );
      camera.position.copy(tv.position);
      camera.up.set(0, 1, 0);
      camera.lookAt(tv.lookAt);
      camera.fov = tv.fovDeg;
      camera.updateProjectionMatrix();
    }

    if (f.menu) {
      // Attract camera: a slow telephoto orbit of the car on the grid (closer on the car-select step)
      const close = f.menu.close;
      this.menuOrbitRad += dtSeconds * (close ? 0.2 : 0.08);
      const radius = close ? 6.2 : 9.5;
      const p = renderCarPos;
      camera.position.set(
        p.x + Math.sin(this.menuOrbitRad) * radius,
        p.y + (close ? 1.35 : 2.2),
        p.z + Math.cos(this.menuOrbitRad) * radius
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(p.x, p.y + 0.55, p.z);
      camera.fov = close ? 36 : 32;
      // Push the car right of centre so the menu panel on the left does not cover it
      const w = f.menu.width;
      const h = f.menu.height;
      if (w >= 1024) camera.setViewOffset(w, h, -w * (close ? 0.2 : 0.16), 0, w, h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      this.menuViewOffset = true;
    } else if (this.menuViewOffset) {
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
      this.menuViewOffset = false;
    }

    // Driver's head (not in VR, where the headset is the head). A neck holds the eyes steady against the
    // chassis' suspension pitch and roll and turns them a little toward where the car is going; the road's own
    // camber and gradient stay in view. "Locked" leaves the camera bolted to the chassis.
    const neckOn = f.headMovement === "natural" && f.driving && !f.inVr && view.driverHead;
    let neckYawTarget = 0;
    let neckPitchTarget = 0;
    let neckRollTarget = 0;
    if (neckOn) {
      const speedMs = Math.hypot(physics.vxMs, physics.vyMs);
      // Look toward the direction of travel in a slide (+vyMs is toward carLeft: positive yaw about carUp)
      const sliding = speedMs > 3 ? physics.vyMs / Math.max(3, speedMs) : 0;
      const slidingMult = Math.min(Math.abs(sliding) * 0.8, 1);
      if (slidingMult > 0.2) {
        this.neckDriftState = Math.max(0, this.neckDriftState - 0.5 * dtSeconds);
      } else {
        this.neckDriftState = Math.min(1, this.neckDriftState + 0.25 * dtSeconds);
      }
      const velYaw = THREE.MathUtils.clamp(Math.max(slidingMult - 0.2, 0) * Math.sign(sliding) * 0.35, -0.14, 0.14);

      // Look toward the corner 25 m ahead: a few degrees, faded out off the road and at walking pace
      const aheadSample = this.track.getSampleAtDistance((physics.sMeters + 25) % Math.max(1, this.track.totalLengthM));
      const neckLookDelta = this.neckLookDelta.copy(aheadSample.position).sub(physics.worldPosition);
      const chordLen = neckLookDelta.length();
      let apexYaw = 0;
      if (chordLen > 1) {
        const latDot = neckLookDelta.dot(carRight) / chordLen;
        const fwdDot = neckLookDelta.dot(carForward) / chordLen;
        const trackWeight =
          THREE.MathUtils.clamp((15 - Math.abs(physics.lateralOffsetM)) / 7, 0, 1) *
          THREE.MathUtils.clamp(fwdDot, 0, 1) *
          this.neckDriftState *
          THREE.MathUtils.clamp((speedMs - 4) / 12, 0, 1);
        apexYaw = THREE.MathUtils.clamp(-latDot * 0.22, -0.1, 0.1) * trackWeight;
      }

      neckYawTarget = THREE.MathUtils.clamp(velYaw + apexYaw, -0.17, 0.17);
      // Hold the head against the body's quick pitch and roll. The LC26 reports its suspension pitch (about the
      // car's +X, carLeft) and roll (about carForward) apart from its pose; the rigid-body cars carry theirs in
      // the pose, which the lagging head-up takes out.
      const headUp = this.headUp.lerp(carUp, Math.min(1, dtSeconds * 2.5)).normalize();
      const headCross = this.headCross.crossVectors(carUp, headUp);
      const bodyPitch = Math.atan2(headCross.dot(carRight), carUp.dot(headUp));
      const bodyRoll = Math.atan2(headCross.dot(carForward), carUp.dot(headUp));
      neckPitchTarget = THREE.MathUtils.clamp((physics.pitchRad + bodyPitch) * 0.6, -0.06, 0.06);
      neckRollTarget = THREE.MathUtils.clamp((-physics.rollRad + bodyRoll) * 0.6, -0.08, 0.08);
    } else {
      this.neckDriftState = 1;
      this.headUp.copy(carUp);
    }
    // The yaw eases in like a turn of the head; the stabilisation follows the chassis closely
    this.neckYaw += (neckYawTarget - this.neckYaw) * Math.min(1, dtSeconds * 3);
    this.neckPitch += (neckPitchTarget - this.neckPitch) * Math.min(1, dtSeconds * 14);
    this.neckRoll += (neckRollTarget - this.neckRoll) * Math.min(1, dtSeconds * 14);
    const { neckYaw, neckPitch, neckRoll } = this;
    if ((Math.abs(neckYaw) > 1e-4 || Math.abs(neckPitch) > 1e-4 || Math.abs(neckRoll) > 1e-4) && view.driverHead) {
      if (Math.abs(neckYaw) > 1e-4) {
        camera.quaternion.premultiply(this.neckQuat.setFromAxisAngle(carUp, neckYaw));
      }
      if (Math.abs(neckPitch) > 1e-4) {
        camera.quaternion.premultiply(this.neckPitchQuat.setFromAxisAngle(carRight, neckPitch));
      }
      if (Math.abs(neckRoll) > 1e-4) {
        camera.quaternion.premultiply(this.neckRollQuat.setFromAxisAngle(carForward, neckRoll));
      }
    }
  }
}
