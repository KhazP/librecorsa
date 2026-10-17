import * as THREE from "three";
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
   * first clear alternative (the other side, closer in, higher up). Run once, when the circuit has loaded.
   */
  resolveOcclusion(trackRoot: THREE.Object3D): number {
    const occluders: THREE.Object3D[] = [];
    trackRoot.traverseVisible((obj) => {
      if ((obj as THREE.Mesh).isMesh) occluders.push(obj);
    });
    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const hits: THREE.Intersection[] = [];
    const clear = (curve: THREE.CatmullRomCurve3, centre: number): boolean => {
      for (let j = 0; j < DOLLY_POINTS; j++) {
        const from = curve.points[j];
        // Sight line to where the car is when the camera is at this point (it is ahead of the camera on the
        // approach and behind it on the way out)
        const sample = this.sampleAt(centre + (this.dollyS(centre, j) - centre) / DOLLY_RATIO);
        target.copy(sample.position);
        target.y += LOOK_HEIGHT_M;
        dir.subVectors(target, from);
        const dist = dir.length();
        ray.set(from, dir.divideScalar(dist));
        ray.far = dist - OCCLUSION_MARGIN_M;
        hits.length = 0;
        if (ray.intersectObjects(occluders, false, hits).length > 0) return false;
      }
      return true;
    };
    let moved = 0;
    for (let k = 0; k < this.stationCount; k++) {
      const centre = this.centreS[k];
      if (clear(this.curves[k], centre)) continue;
      const side = this.stationSide[k];
      const height = HEIGHTS_M[k % HEIGHTS_M.length];
      for (const [sideMul, offset, extraH] of OCCLUSION_ALTERNATIVES) {
        const curve = this.buildDolly(centre, side * sideMul, offset, height + extraH);
        if (clear(curve, centre)) {
          this.curves[k] = curve;
          moved++;
          break;
        }
      }
    }
    return moved;
  }

  /** Number of automatic stations built for this lap */
  get stations(): number {
    return this.stationCount;
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
