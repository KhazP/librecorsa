import * as THREE from "three";
import { SegmentOccluder } from "./segment-occluder";
import type { CarTelemetry, TrackSamplePoint } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";

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
  private initialised = false;
  private current = -1;
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
    if (!this.initialised || this.current < 0) {
      this.current = best;
      cut = true;
    } else if (best !== this.current) {
      const curScore = Math.abs(this.wrapDelta(carS - this.centreS[this.current]));
      if (curScore > bestScore + SWITCH_HYSTERESIS_M) {
        this.current = best;
        cut = true;
      }
    }
    const k = this.current;

    // Dolly: glide along the station's spline as the car passes its section
    const d = this.wrapDelta(carS - this.centreS[k]);
    const u = clamp01((d + this.sectorHalfM) / (2 * this.sectorHalfM));
    this.curves[k].getPoint(u, out.position);

    // Look-at: critically damped, leading the car by its velocity
    this.lead.copy(carVel).multiplyScalar(LOOK_LEAD_S).add(carPos);
    this.lead.y += LOOK_HEIGHT_M;
    if (cut || !this.initialised) {
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
    if (cut || !this.initialised) {
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
    this.initialised = true;
    return out;
  }

  reset(): void {
    this.initialised = false;
    this.current = -1;
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

function smootherstep(x: number): number {
  const r = clamp01(x);
  return r * r * r * (r * (r * 6 - 15) + 10);
}

// ---------------------------------------------------------------------------------------------------------------
// Dynamic chase camera
// ---------------------------------------------------------------------------------------------------------------

const CHASE_BASE_DISTANCE_M = 3.0;
const CHASE_BASE_HEIGHT_M = 1.24;
const CHASE_PITCH_DEG = -4.0;
const CHASE_PITCH_RAD = CHASE_PITCH_DEG * DEG2RAD;
const CHASE_BASE_FOV_DEG = 60;
const CHASE_SPEED_FOV_ADD_DEG = 8;
const CHASE_BOOST_FOV_ADD_DEG = 3.5;
const CHASE_BOOST_EXTRA_DIST_M = 0.24;
/** High-pass cutoff (Hz) on verticalG so steady-state aerodynamic downforce at speed never sinks the camera */
const CHASE_VERT_G_HPF_HZ = 1.2;
const CHASE_VERT_G_HPF_RC = 1 / (TWO_PI * CHASE_VERT_G_HPF_HZ);
const CHASE_VERT_FX_LIMIT_M = 0.18;
/** Maximum horizontal yaw lag of the chase boom behind the car's nose (rad) */
export const CHASE_MAX_LAG_RAD = 0.35;
/** Maximum banking roll angle for camera height compensation (rad, ~pi/4) */
const CHASE_ROLL_LIMIT_RAD = 0.785;
/** Maximum per-frame position delta before clamping as a teleport/discontinuity (m) */
const CHASE_MAX_DELTA_M = 5;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export interface ChaseCameraInput {
  /** Car world position on the ground reference plane (m) */
  carPos: THREE.Vector3;
  /** Car orientation in world space (used when carForward / carUp / carRight are omitted) */
  carQuaternion?: THREE.Quaternion;
  /** Optional car forward unit vector (+Z in car frame) */
  carForward?: THREE.Vector3;
  /** Optional car up unit vector (+Y in car frame) */
  carUp?: THREE.Vector3;
  /** Optional car right unit vector (-X in car frame) */
  carRight?: THREE.Vector3;
  /** Optional 3D world velocity of the car (m/s) */
  carVelocity?: THREE.Vector3;
  /** Longitudinal acceleration in G (+ = forward acceleration, - = braking) */
  longitudinalG: number;
  /** Lateral acceleration in G (+ = right turn, - = left turn) */
  lateralG: number;
  /** Vertical load in G (1.0 at rest on flat ground) */
  verticalG: number;
  /** Car wheelbase (m); defaults to 3.5 */
  wheelbaseM?: number;
  /** Static CG height above ground (m); defaults to 0.30 */
  cgHeightM?: number;
  /** Dynamic ride height / heave offset (m); defaults to 0 */
  rideHeightOffsetM?: number;
  /** High-frequency kerb shake vertical offset (m); defaults to 0 */
  kerbShakeM?: number;
  /** Whether manual-override / push boost is active */
  manualOverrideActive?: boolean;
  /** Optional look-around yaw (-2 = look back, +1 = look left, -1 = look right, 0 = forward) */
  lookYaw?: number;
  /** Optional look-around pitch (-1..1, scaled by pi/4) */
  lookPitch?: number;
}

export interface ChaseCameraOutput {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  lookAt: THREE.Vector3;
  up: THREE.Vector3;
  fovDeg: number;
  /** Instantaneous longitudinal boom distance (m) */
  fxDistanceM: number;
  /** Banking roll height compensation along carUp (m) */
  rollAddM: number;
  /** Vertical G heave offset along carUp (m) */
  vertFxM: number;
}

/**
 * Velocity-trailing dynamic chase camera rig with dual-rate 3D G-force smoothing, wheelbase-scaled boom geometry,
 * longitudinal G surge, lateral G cornering sway, vertical G heave + pitch compensation, quintic smootherstep
 * banking height compensation, and subtle horizon roll tilt. Allocation-free: returns the same output instance on
 * every call.
 */
export class DynamicChaseCamera {
  private readonly out: ChaseCameraOutput = {
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, 1),
    lookAt: new THREE.Vector3(0, 0, 15),
    up: new THREE.Vector3(0, 1, 0),
    fovDeg: CHASE_BASE_FOV_DEG,
    fxDistanceM: CHASE_BASE_DISTANCE_M + 1.75,
    rollAddM: 0,
    vertFxM: 0,
  };

  private readonly carVelocity = new THREE.Vector3();
  private readonly carVelocityRaw = new THREE.Vector3();
  private readonly carAccel = new THREE.Vector3();
  private readonly carAccelFx = new THREE.Vector3();
  private readonly carAccelFy = new THREE.Vector3();
  private readonly gForce = new THREE.Vector3();
  private readonly camDirLowSpeed = new THREE.Vector3(0, 0, 1);
  private readonly lastCarPos = new THREE.Vector3();

  // Scratch vectors to keep update() allocation-free
  private readonly carForward = new THREE.Vector3(0, 0, 1);
  private readonly carUp = new THREE.Vector3(0, 1, 0);
  private readonly carRight = new THREE.Vector3(-1, 0, 0);
  private readonly carDirFlat = new THREE.Vector3(0, 0, 1);
  private readonly carRightFlat = new THREE.Vector3(-1, 0, 0);
  private readonly cameraDir = new THREE.Vector3(0, 0, 1);
  private readonly cameraUp = new THREE.Vector3(0, 1, 0);
  private readonly cameraRight = new THREE.Vector3(-1, 0, 0);
  private readonly delta = new THREE.Vector3();
  private readonly lowSpeedTarget = new THREE.Vector3();
  private readonly velHoriz = new THREE.Vector3();
  private readonly scratchCross = new THREE.Vector3();

  private camPitch = 0;
  private carSpeedSmooth = 0;
  private lookDirection = 0;
  private lookPitch = 0;
  private rollAdd = 0;
  private boostExtraDist = 0;
  private fovDeg = CHASE_BASE_FOV_DEG;
  private prevRawVertG = 0;
  private hpfVertG = 0;
  private initialised = false;

  update(dt: number, input: ChaseCameraInput): ChaseCameraOutput {
    const out = this.out;
    const h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;

    if (input.carForward && input.carUp && input.carRight) {
      this.carForward.copy(input.carForward);
      this.carUp.copy(input.carUp);
      this.carRight.copy(input.carRight);
    } else if (input.carQuaternion) {
      this.carRight.set(-1, 0, 0).applyQuaternion(input.carQuaternion);
      this.carUp.set(0, 1, 0).applyQuaternion(input.carQuaternion);
      this.carForward.set(0, 0, 1).applyQuaternion(input.carQuaternion);
    } else {
      this.carForward.set(0, 0, 1);
      this.carUp.set(0, 1, 0);
      this.carRight.set(-1, 0, 0);
    }
    if (this.carForward.lengthSq() > 1e-8) this.carForward.normalize();
    else this.carForward.set(0, 0, 1);
    if (this.carUp.lengthSq() > 1e-8) this.carUp.normalize();
    else this.carUp.set(0, 1, 0);
    if (this.carRight.lengthSq() > 1e-8) this.carRight.normalize();
    else this.carRight.crossVectors(this.carForward, this.carUp).normalize();

    this.carDirFlat.set(this.carForward.x, 0, this.carForward.z);
    if (this.carDirFlat.lengthSq() > 1e-8) this.carDirFlat.normalize();
    else this.carDirFlat.set(0, 0, 1);

    this.carRightFlat.set(this.carRight.x, 0, this.carRight.z);
    if (this.carRightFlat.lengthSq() > 1e-8) this.carRightFlat.normalize();
    else this.carRightFlat.set(-this.carDirFlat.z, 0, this.carDirFlat.x);

    const wheelbaseM =
      input.wheelbaseM !== undefined && Number.isFinite(input.wheelbaseM) && input.wheelbaseM > 0
        ? input.wheelbaseM
        : 3.5;
    const halfWheelbaseM = wheelbaseM * 0.5;
    const cgHeightM =
      input.cgHeightM !== undefined && Number.isFinite(input.cgHeightM) ? input.cgHeightM : 0.3;
    const rideHeightOffsetM =
      input.rideHeightOffsetM !== undefined && Number.isFinite(input.rideHeightOffsetM) ? input.rideHeightOffsetM : 0;
    const kerbShakeM =
      input.kerbShakeM !== undefined && Number.isFinite(input.kerbShakeM) ? input.kerbShakeM : 0;
    const distance = CHASE_BASE_DISTANCE_M + halfWheelbaseM;

    const lonG = Number.isFinite(input.longitudinalG) ? input.longitudinalG : 0;
    const latG = Number.isFinite(input.lateralG) ? input.lateralG : 0;
    const rawVertG = (Number.isFinite(input.verticalG) ? input.verticalG : 1) - 1;

    if (!this.initialised) {
      this.lastCarPos.copy(input.carPos);
      if (input.carVelocity && Number.isFinite(input.carVelocity.x)) {
        this.carVelocityRaw.copy(input.carVelocity);
      } else {
        this.carVelocityRaw.set(0, 0, 0);
      }
      this.carVelocity.copy(this.carVelocityRaw);
      this.carSpeedSmooth = this.carVelocityRaw.length();
      this.camPitch = Math.asin(clampRange(this.carForward.y, -1, 1));
      this.camDirLowSpeed.copy(this.carDirFlat);
      this.lookDirection = input.lookYaw ?? 0;
      this.lookPitch = (input.lookPitch ?? 0) * (Math.PI * 0.25);
      this.boostExtraDist = input.manualOverrideActive ? CHASE_BOOST_EXTRA_DIST_M : 0;
      this.fovDeg = CHASE_BASE_FOV_DEG;
      this.prevRawVertG = rawVertG;
      this.hpfVertG = 0;
      this.initialised = true;
    }

    if (h > 0) {
      // High-pass verticalG: telemetry.verticalG includes steady-state aerodynamic downforce (up to ~3.5 G at 320 km/h),
      // which would otherwise sink the camera into the road and pitch it upward at speed. Only transient crests/dips pass.
      const aHp = CHASE_VERT_G_HPF_RC / (CHASE_VERT_G_HPF_RC + h);
      this.hpfVertG = aHp * (this.hpfVertG + rawVertG - this.prevRawVertG);
      this.prevRawVertG = rawVertG;
      this.gForce.set(latG, this.hpfVertG, lonG);

      // Dual-rate G-force smoothing: low-pass sustained load (dt * 2) and fast road vibration (dt * 30)
      this.carAccel.lerp(this.gForce, Math.min(1, h * 2));
      this.carAccelFx.lerp(this.gForce, Math.min(1, h * 30));
      this.carAccelFy.lerp(this.gForce, Math.min(1, h * 2));

      // 3D world velocity with > 5 m teleport clamping
      this.delta.subVectors(input.carPos, this.lastCarPos);
      const deltaLen = this.delta.length();
      this.lastCarPos.copy(input.carPos);
      const hasExplicitVel = Boolean(input.carVelocity && Number.isFinite(input.carVelocity.x));

      if (deltaLen > CHASE_MAX_DELTA_M) {
        // Discontinuity / teleport: clamp delta so velocity never spikes
        if (hasExplicitVel) {
          this.carVelocityRaw.copy(input.carVelocity!);
          const vLen = this.carVelocityRaw.length();
          if (vLen > CHASE_MAX_DELTA_M / h) {
            this.carVelocityRaw.multiplyScalar(CHASE_MAX_DELTA_M / h / vLen);
          }
        } else {
          this.delta.multiplyScalar((CHASE_MAX_DELTA_M * h) / deltaLen);
          this.carVelocityRaw.copy(this.delta).divideScalar(h);
        }
        this.camDirLowSpeed.copy(this.carDirFlat);
      } else if (hasExplicitVel && (input.carVelocity!.lengthSq() > 1e-6 || deltaLen <= 1e-6)) {
        // Prefer exact 3D physics velocity over finite-differencing frame-extrapolated positions
        this.carVelocityRaw.copy(input.carVelocity!);
      } else if (deltaLen > 1e-6) {
        this.carVelocityRaw.copy(this.delta).divideScalar(h);
      } else {
        this.carVelocityRaw.set(0, 0, 0);
      }

      this.carVelocity.lerp(this.carVelocityRaw, Math.min(1, h * 8));
      const carSpeed = this.carVelocityRaw.length();
      this.carSpeedSmooth += (carSpeed - this.carSpeedSmooth) * Math.min(1, h * 32);
    }

    // Low-speed heading blend and velocity climb/dive pitch tracking
    const speedGate = clamp01(this.carSpeedSmooth - 1);
    const carPitch = Math.asin(clampRange(this.carForward.y, -1, 1));
    const velLen = this.carVelocity.length();
    const velDirY = velLen > 1e-5 ? this.carVelocity.y / velLen : this.carForward.y;
    const velPitchTarget = Math.asin(clampRange(velDirY, -1, 1));
    const pitchTarget = carPitch + (velPitchTarget - carPitch) * speedGate;
    if (h > 0) {
      this.camPitch += (pitchTarget - this.camPitch) * Math.min(1, h * 2);
    } else {
      this.camPitch = pitchTarget;
    }

    const rawSpeed = Math.max(1, this.carVelocityRaw.length());
    this.lowSpeedTarget.copy(this.carDirFlat).multiplyScalar(rawSpeed);
    this.velHoriz.set(this.carVelocity.x, 0, this.carVelocity.z);
    if (this.velHoriz.lengthSq() < 1e-6) {
      this.velHoriz.copy(this.carDirFlat).multiplyScalar(rawSpeed);
    }
    this.lowSpeedTarget.lerp(this.velHoriz, speedGate);
    if (h > 0) {
      this.camDirLowSpeed.lerp(this.lowSpeedTarget, Math.min(1, h));
    } else {
      this.camDirLowSpeed.copy(this.lowSpeedTarget);
    }
    this.camDirLowSpeed.y = 0;
    if (this.camDirLowSpeed.lengthSq() > 1e-8) {
      this.camDirLowSpeed.normalize();
    } else {
      this.camDirLowSpeed.copy(this.carDirFlat);
    }

    // Bound horizontal yaw lag relative to carForward so full spins or respawns never invert the boom
    const lagRad = Math.atan2(
      this.scratchCross.crossVectors(this.carDirFlat, this.camDirLowSpeed).y,
      this.camDirLowSpeed.dot(this.carDirFlat)
    );
    if (!(Math.abs(lagRad) <= CHASE_MAX_LAG_RAD)) {
      this.camDirLowSpeed
        .copy(this.carDirFlat)
        .applyAxisAngle(WORLD_UP, Number.isFinite(lagRad) ? Math.sign(lagRad) * CHASE_MAX_LAG_RAD : 0)
        .normalize();
    }

    this.cameraDir.copy(this.camDirLowSpeed);
    const upDotRightFlat = this.carUp.dot(this.carRightFlat);
    this.cameraUp.copy(this.carUp).addScaledVector(this.carRightFlat, -upDotRightFlat);
    if (this.cameraUp.lengthSq() < 1e-8) this.cameraUp.set(0, 1, 0);

    this.cameraRight.crossVectors(this.cameraDir, this.cameraUp);
    if (this.cameraRight.lengthSq() > 1e-8) this.cameraRight.normalize();
    else this.cameraRight.copy(this.carRightFlat);

    this.cameraDir.applyAxisAngle(this.cameraRight, this.camPitch).normalize();
    this.cameraRight.crossVectors(this.cameraDir, this.cameraUp);
    if (this.cameraRight.lengthSq() > 1e-8) this.cameraRight.normalize();
    else this.cameraRight.copy(this.carRightFlat);

    // Look-around yaw / pitch
    const lookYawTarget = input.lookYaw !== undefined && Number.isFinite(input.lookYaw) ? input.lookYaw : 0;
    const lookPitchTarget =
      (input.lookPitch !== undefined && Number.isFinite(input.lookPitch) ? input.lookPitch : 0) * (Math.PI * 0.25);
    const lookLerp = h > 0 ? Math.min(1, h * 10) : 1;
    this.lookDirection += (lookYawTarget - this.lookDirection) * lookLerp;
    this.lookPitch += (lookPitchTarget - this.lookPitch) * lookLerp;
    if (Math.abs(this.lookDirection) > 1e-5) {
      this.cameraDir.applyAxisAngle(WORLD_UP, this.lookDirection * (Math.PI * 0.5));
    }
    if (Math.abs(this.lookPitch) > 1e-5) {
      this.cameraDir.applyAxisAngle(this.cameraRight, this.lookPitch);
    }
    this.cameraDir.normalize();
    this.cameraRight.crossVectors(this.cameraDir, this.cameraUp);
    if (this.cameraRight.lengthSq() > 1e-8) this.cameraRight.normalize();
    else this.cameraRight.copy(this.carRightFlat);

    // Longitudinal G surge, pitch-angle height compensation, vertical G heave, and banking roll compensation
    const boostTarget = input.manualOverrideActive ? CHASE_BOOST_EXTRA_DIST_M : 0;
    this.boostExtraDist += (boostTarget - this.boostExtraDist) * (h > 0 ? Math.min(1, h * 8) : 1);
    const fxDistance =
      distance + (Math.sin(Math.atan(1.5 * this.carAccel.z - 0.258)) + 0.25) * 0.35 + this.boostExtraDist;
    const height = CHASE_BASE_HEIGHT_M + fxDistance * Math.tan(-CHASE_PITCH_RAD);

    const vertFx = clampAbs(
      Math.sin(Math.atan(-this.carAccelFy.y)) * 0.32 +
        Math.sin(Math.atan(-this.carAccelFx.y)) * 0.08 * (this.carSpeedSmooth / 30),
      CHASE_VERT_FX_LIMIT_M
    );

    const rollAngle = -Math.atan2(
      this.scratchCross.crossVectors(this.carRight, this.carRightFlat).dot(this.carForward),
      this.carRight.dot(this.carRightFlat)
    );
    const rollClamped = clampRange(Math.abs(rollAngle), 0, CHASE_ROLL_LIMIT_RAD);
    const rollRange = rollClamped / CHASE_ROLL_LIMIT_RAD;
    const rollSmooth = smootherstep(rollRange);
    const rollTarget = height * 0.65 * Math.tan(rollSmooth * CHASE_ROLL_LIMIT_RAD);
    if (h > 0) {
      this.rollAdd += (rollTarget - this.rollAdd) * Math.min(1, h);
    } else {
      this.rollAdd = rollTarget;
    }

    const carAngle = Math.atan2(this.carForward.z, this.carForward.x);
    const velocityAngle = Math.atan2(this.cameraDir.z, this.cameraDir.x);
    const velocityPitch = Math.asin(clampRange(-this.cameraDir.y, -1, 1));
    const diffAngle = velocityAngle - carAngle;
    const cosVelPitch = Math.cos(velocityPitch);
    // Swing camera toward the outside of the turn (-carRight for right turn where lateralG > 0)
    const lateralSwayM = -Math.sin(Math.atan(this.carAccel.x)) * (wheelbaseM / 8);

    out.position
      .copy(input.carPos)
      .addScaledVector(this.carRightFlat, Math.sin(diffAngle) * cosVelPitch * -fxDistance)
      .addScaledVector(this.carDirFlat, Math.cos(diffAngle) * cosVelPitch * -fxDistance)
      .addScaledVector(WORLD_UP, Math.sin(velocityPitch) * fxDistance)
      .addScaledVector(this.cameraUp, height + cgHeightM + rideHeightOffsetM * 0.5)
      .addScaledVector(this.carUp, this.rollAdd + vertFx + kerbShakeM)
      .addScaledVector(this.carRight, lateralSwayM);

    const heavePitchRad = -Math.atan(vertFx / Math.max(0.5, fxDistance + halfWheelbaseM));
    this.cameraDir.applyAxisAngle(this.cameraRight, heavePitchRad + CHASE_PITCH_RAD).normalize();
    out.direction.copy(this.cameraDir);
    out.lookAt.copy(out.position).addScaledVector(this.cameraDir, 15);

    // Horizon roll tilt (~1 deg under sustained lateral G, plus partial banking blend on heavily banked turns)
    const horizonRollRad = -DEG2RAD * Math.sin(Math.atan(2 * this.carAccel.x));
    out.up.copy(WORLD_UP).applyAxisAngle(this.carDirFlat, horizonRollRad);
    if (rollSmooth > 1e-4) {
      out.up.lerp(this.carUp, rollSmooth * 0.35);
    }
    out.up.normalize();

    const speedNorm = clamp01((this.carSpeedSmooth * 3.6) / 350);
    const boostFovKick = input.manualOverrideActive ? CHASE_BOOST_FOV_ADD_DEG : 0;
    const fovTarget = CHASE_BASE_FOV_DEG + speedNorm * CHASE_SPEED_FOV_ADD_DEG + boostFovKick;
    if (h > 0) {
      this.fovDeg += (fovTarget - this.fovDeg) * Math.min(1, h * 10);
    } else {
      this.fovDeg = fovTarget;
    }
    out.fovDeg = this.fovDeg;
    out.fxDistanceM = fxDistance;
    out.rollAddM = this.rollAdd;
    out.vertFxM = vertFx;
    return out;
  }

  reset(): void {
    this.carVelocity.set(0, 0, 0);
    this.carVelocityRaw.set(0, 0, 0);
    this.carAccel.set(0, 0, 0);
    this.carAccelFx.set(0, 0, 0);
    this.carAccelFy.set(0, 0, 0);
    this.gForce.set(0, 0, 0);
    this.camDirLowSpeed.set(0, 0, 1);
    this.lastCarPos.set(0, 0, 0);
    this.camPitch = 0;
    this.carSpeedSmooth = 0;
    this.lookDirection = 0;
    this.lookPitch = 0;
    this.rollAdd = 0;
    this.boostExtraDist = 0;
    this.fovDeg = CHASE_BASE_FOV_DEG;
    this.prevRawVertG = 0;
    this.hpfVertG = 0;
    this.initialised = false;
  }
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
