import * as THREE from "three";
import { type BuiltTrackData, inDeadZone } from "@/lib/track-data";

/**
 * The title screen's attract shot: when the player has left the menu alone for a while the camera leaves the car on
 * the grid for the air, like a broadcast's opening titles. It cuts between slow shots, each framed from the circuit's
 * own centreline so every layout gets them (an odd shape, a hill climb):
 *   - drone: flies along the road from behind and to one side, high up, the first one starting over the player's car;
 *   - orbit: circles a corner (the tightest bends, spread around the lap) from high on its outside.
 * The heights are set from the highest road near the shot, and the cameras pull in when the fog thickens (rain), so
 * the ground never goes grey. Pure: the time since the aerial started picks the shot and its pose.
 */

/** How long the title screen has to be left alone before the aerial tour starts (ms) */
export const AERIAL_IDLE_MS = 30_000;
/** How long each shot holds before the cut to the next (s) */
export const AERIAL_SHOT_S = 15;
/** The drone's speed along the road (m/s) */
const DRONE_SPEED_MS = 24;
/** The drone's place behind and beside the road point it films, and its height above the road (m) */
const DRONE_BACK_M = 150;
const DRONE_SIDE_M = 70;
const DRONE_HEIGHT_M = 120;
/** How far ahead of its road point the drone looks (m) */
const DRONE_LOOK_AHEAD_M = 45;
/** The half-length of the chords that set the drone's heading, and how many and how far apart they are (m) */
const DRONE_HEADING_HALF_M = 150;
const HEADING_TAPS = 4;
const HEADING_TAP_M = 60;
/**
 * The drone turns after the road like an operator would: easing towards its heading, never faster than this (rad/s),
 * so a hairpin swings it round slowly (it ends up beside the road for a while, rather than whipping round behind it).
 * Planned per shot at YAW_STEP_S steps, from a few seconds before the shot so it opens already settled.
 */
const DRONE_YAW_RATE = 0.1;
const DRONE_YAW_GAIN = 1.2;
const YAW_STEP_S = 0.25;
const YAW_PREROLL_S = 6;
/** The orbit's radius and height above the corner (m), and its turn rate (rad/s) */
const ORBIT_RADIUS_M = 240;
const ORBIT_HEIGHT_M = 160;
const ORBIT_RATE = 0.05;
/** Vertical field of view (deg); a portrait screen gets a wider one */
const FOV_DEG = 40;
const FOV_PORTRAIT_DEG = 55;
/** Corners closer than this along the road than a tighter one are not filmed on their own (m) */
const CORNER_SPACING_M = 450;
const MAX_CORNERS = 4;
/** Where the title menu's panel ends on a wide screen, in the frame's -1 .. 1 across */
const MENU_EDGE_NDC = -0.3;
/** The fog density the shot distances are set for: clear golden-hour air */
const CLEAR_FOG_DENSITY = 0.00035;

export interface AerialPose {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  fovDeg: number;
}

type Shot =
  | { kind: "drone"; startU: number; side: 1 | -1; floorY: number; yaw: Float32Array }
  | { kind: "orbit"; focus: THREE.Vector3; startRad: number; dir: 1 | -1; floorY: number };

const smoothstep = (x: number) => {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export class MenuAerial {
  /** The road as a run from its start: u = 0 .. roadLen, s = (s0 + u) mod L */
  private readonly s0: number;
  private readonly roadLen: number;
  private readonly closed: boolean;
  private readonly lengthM: number;
  private readonly ds: number;
  /** Middle of the road's bounds, at the road's mean height */
  readonly centre = new THREE.Vector3();
  /** Corner apexes worth an orbit, as u along the road */
  private readonly corners: number[];
  private readonly shots = new Map<number, Shot>();
  /** The drone's first road point: the player's car, when the aerial started */
  private firstU = 0;
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  /** A stand-in for the view camera on a wide screen, to judge the shots' framing by */
  private readonly probe = new THREE.PerspectiveCamera(FOV_DEG, 16 / 9, 1, 6000);
  private readonly probePose: AerialPose = { position: new THREE.Vector3(), lookAt: new THREE.Vector3(), fovDeg: FOV_DEG };

  constructor(private readonly track: BuiltTrackData) {
    const L = Math.max(1, track.totalLengthM);
    this.lengthM = L;
    this.ds = L / Math.max(1, track.samples.length);
    const p2p = track.pointToPoint;
    this.closed = !p2p;
    this.s0 = p2p ? p2p.startS : 0;
    this.roadLen = p2p ? Math.max(1, L - p2p.startS + p2p.endS) : L;

    // Bounds of the driven road (a hill climb's closing line has no road under it)
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let sumY = 0;
    let n = 0;
    for (const s of track.samples) {
      if (p2p && inDeadZone(p2p, s.s)) continue;
      minX = Math.min(minX, s.position.x);
      maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z);
      maxZ = Math.max(maxZ, s.position.z);
      sumY += s.position.y;
      n++;
    }
    if (n === 0) {
      minX = maxX = minZ = maxZ = 0;
      n = 1;
    }
    this.centre.set((minX + maxX) / 2, sumY / n, (minZ + maxZ) / 2);
    this.corners = this.findCorners();
    // The rig's wide-screen framing: the shot pushed right of the menu (camera-rig.ts)
    this.probe.setViewOffset(1600, 900, -0.16 * 1600, 0, 1600, 900);
  }

  /** s along the loop of a point u along the road */
  private sOf(u: number): number {
    const L = this.lengthM;
    const uu = this.closed ? ((u % this.roadLen) + this.roadLen) % this.roadLen : THREE.MathUtils.clamp(u, 0, this.roadLen);
    return (((this.s0 + uu) % L) + L) % L;
  }

  /** u along the road of a point s along the loop */
  private uOf(s: number): number {
    const L = this.lengthM;
    const u = (((s - this.s0) % L) + L) % L;
    return this.closed ? u : Math.min(u, this.roadLen);
  }

  /** The centreline at u, between its samples */
  private pointAt(u: number, out: THREE.Vector3): THREE.Vector3 {
    const samples = this.track.samples;
    const N = samples.length;
    if (N === 0) return out.set(0, 0, 0);
    const f = this.sOf(u) / this.ds;
    const i0 = Math.floor(f) % N;
    const i1 = (i0 + 1) % N;
    return out.lerpVectors(samples[i0].position, samples[i1].position, f - Math.floor(f));
  }

  /** The sample nearest u */
  private sampleAt(u: number) {
    const N = this.track.samples.length;
    return this.track.samples[Math.round(this.sOf(u) / this.ds) % N];
  }

  /** The highest road between two points along it */
  private maxRoadY(u0: number, u1: number): number {
    let y = -Infinity;
    for (let u = u0; u <= u1; u += this.ds) y = Math.max(y, this.pointAt(u, this.a).y);
    return y;
  }

  /** The highest driven road within r (m) of a point, horizontally */
  private maxRoadYNear(p: THREE.Vector3, r: number): number {
    const p2p = this.track.pointToPoint;
    let y = p.y;
    for (const s of this.track.samples) {
      if (p2p && inDeadZone(p2p, s.s)) continue;
      const dx = s.position.x - p.x;
      const dz = s.position.z - p.z;
      if (dx * dx + dz * dz < r * r) y = Math.max(y, s.position.y);
    }
    return y;
  }

  /** The tightest bends, spread out along the road (evenly spaced points on a road with none) */
  private findCorners(): number[] {
    const samples = this.track.samples;
    const N = samples.length;
    const scored: { u: number; k: number }[] = [];
    const margin = this.closed ? 0 : 150;
    const half = Math.max(1, Math.round(30 / this.ds));
    for (let i = 0; i < N; i++) {
      const u = this.uOf(samples[i].s);
      if (!this.closed && (u < margin || u > this.roadLen - margin || inDeadZone(this.track.pointToPoint!, samples[i].s))) continue;
      let k = 0;
      for (let j = -half; j <= half; j++) k += samples[(i + j + N) % N].curvature;
      scored.push({ u, k: Math.abs(k) / (2 * half + 1) });
    }
    scored.sort((x, y) => y.k - x.k);
    const picked: number[] = [];
    const gap = (x: number, y: number) => {
      const d = Math.abs(x - y);
      return this.closed ? Math.min(d, this.roadLen - d) : d;
    };
    for (const c of scored) {
      if (c.k < 1 / 400 || picked.length >= MAX_CORNERS) break;
      if (picked.every((u) => gap(u, c.u) >= CORNER_SPACING_M)) picked.push(c.u);
    }
    if (picked.length < 2) {
      const span = this.roadLen - 2 * margin;
      for (const f of [0.3, 0.7]) if (picked.every((u) => gap(u, margin + f * span) >= CORNER_SPACING_M / 2)) picked.push(margin + f * span);
    }
    return picked.sort((x, y) => x - y);
  }

  /** Starts the tour over, its first drone shot leaving from the player's car (s along the loop) */
  restart(carS: number): void {
    this.shots.clear();
    this.firstU = this.uOf(carS);
  }

  /** The shot at index i, planned on first use */
  private shot(i: number): Shot {
    let shot = this.shots.get(i);
    if (shot) return shot;
    const k = Math.floor(i / 2);
    if (i % 2 === 0) {
      // Drone: the first from the car, then around the lap by the golden ratio, so no two runs repeat
      const run = DRONE_SPEED_MS * AERIAL_SHOT_S;
      let startU = this.firstU + 60 + k * this.roadLen * 0.382;
      if (!this.closed) {
        const room = Math.max(0, this.roadLen - run - 2 * DRONE_HEADING_HALF_M);
        startU = DRONE_HEADING_HALF_M + (k === 0 ? Math.min(room, Math.max(0, this.firstU - DRONE_HEADING_HALF_M)) : (((startU / this.roadLen) % 1) * room));
      }
      // Out over the lower side of the road where its edges fall away (a hill climb's valley); else on the side that
      // keeps more of the road clear of the menu
      let lean = 0;
      for (let u = startU; u <= startU + run; u += 40) {
        const prof = this.sampleAt(u).yProf;
        if (prof && prof.length >= 9) lean += prof[8] - prof[0];
      }
      const reach = DRONE_BACK_M + DRONE_HEADING_HALF_M + HEADING_TAPS * HEADING_TAP_M;
      const floorY = this.maxRoadY(startU - reach, startU + run + reach);
      const yaw = this.planYaw(startU);
      const left: Shot = { kind: "drone", startU, side: -1, floorY, yaw };
      const right: Shot = { kind: "drone", startU, side: 1, floorY, yaw };
      shot = Math.abs(lean) > 30 ? (lean > 0 ? left : right) : this.clearOfMenu(right) > this.clearOfMenu(left) ? right : left;
    } else {
      const u = this.corners.length ? this.corners[k % this.corners.length] : this.roadLen / 2;
      const focus = this.pointAt(u, new THREE.Vector3());
      // Centred on the corner's outside as seen from the middle of the circuit, so the rest of it lies beyond
      // (or a little round from there, whichever keeps more of the road clear of the menu)
      const outside = Math.atan2(focus.x - this.centre.x, focus.z - this.centre.z);
      const dir: 1 | -1 = k % 2 === 0 ? 1 : -1;
      const floorY = this.maxRoadYNear(focus, ORBIT_RADIUS_M + 80);
      let best = -Infinity;
      let pick: Shot = { kind: "orbit", focus, startRad: outside, dir, floorY };
      for (const turn of [0, -0.7, 0.7]) {
        const candidate: Shot = { kind: "orbit", focus, startRad: outside + turn - dir * ORBIT_RATE * AERIAL_SHOT_S * 0.5, dir, floorY };
        const score = this.clearOfMenu(candidate) - Math.abs(turn) * 0.05;
        if (score > best) {
          best = score;
          pick = candidate;
        }
      }
      shot = pick;
    }
    this.shots.set(i, shot);
    return shot;
  }

  /** The road's heading at u (rad, atan2 of x over z), smoothed over a few hundred metres: a sum of chords */
  private roadHeading(u: number): number {
    let hx = 0;
    let hz = 0;
    for (let k = -HEADING_TAPS; k <= HEADING_TAPS; k++) {
      const w = HEADING_TAPS + 1 - Math.abs(k);
      const c = u + k * HEADING_TAP_M;
      const ahead = this.pointAt(c + DRONE_HEADING_HALF_M, this.a);
      const behind = this.pointAt(c - DRONE_HEADING_HALF_M, this.b);
      hx += (ahead.x - behind.x) * w;
      hz += (ahead.z - behind.z) * w;
    }
    return Math.atan2(hx, hz);
  }

  /** A drone shot's heading through the shot (unwrapped, at YAW_STEP_S steps), easing after the road's */
  private planYaw(startU: number): Float32Array {
    const yaw = new Float32Array(Math.ceil(AERIAL_SHOT_S / YAW_STEP_S) + 2);
    const ease = 1 - Math.exp(-DRONE_YAW_GAIN * YAW_STEP_S);
    const maxStep = DRONE_YAW_RATE * YAW_STEP_S;
    let a = this.roadHeading(startU - DRONE_SPEED_MS * YAW_PREROLL_S);
    const follow = (t: number) => {
      let d = this.roadHeading(startU + DRONE_SPEED_MS * t) - a;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a += THREE.MathUtils.clamp(d * ease, -maxStep, maxStep);
    };
    for (let t = -YAW_PREROLL_S; t < 0; t += YAW_STEP_S) follow(t);
    for (let i = 0; i < yaw.length; i++) {
      yaw[i] = a;
      follow(i * YAW_STEP_S);
    }
    return yaw;
  }

  /**
   * The camera `timeS` into the tour. `still` holds the first shot's opening frame (reduced motion). `fogDensity`
   * (the scene's FogExp2) pulls the cameras in when the air thickens.
   */
  pose(timeS: number, aspect: number, fogDensity: number, still: boolean, out: AerialPose): AerialPose {
    const t = still ? 0 : Math.max(0, timeS);
    const index = Math.floor(t / AERIAL_SHOT_S);
    // Shorter distances in thick air (rain), down to a little under half
    const near = THREE.MathUtils.clamp((CLEAR_FOG_DENSITY * 2.6) / Math.max(1e-6, fogDensity), 0.45, 1);
    out.fovDeg = aspect < 1 ? FOV_PORTRAIT_DEG : FOV_DEG;
    return this.poseOf(this.shot(index), t - index * AERIAL_SHOT_S, near, out);
  }

  /**
   * How much of the road a shot keeps clear of the menu on the left of a wide screen: the share of the road in frame
   * that lies right of the panel, through the shot (the framing the rig gives a wide screen: the view offset)
   */
  private clearOfMenu(shot: Shot): number {
    const probe = this.probe;
    const pose = this.probePose;
    const p2p = this.track.pointToPoint;
    const samples = this.track.samples;
    const v = this.a;
    let inFrame = 0;
    let clear = 0;
    for (const tau of [1, AERIAL_SHOT_S / 2, AERIAL_SHOT_S - 1]) {
      this.poseOf(shot, tau, 1, pose);
      probe.position.copy(pose.position);
      probe.lookAt(pose.lookAt);
      probe.updateMatrixWorld();
      for (let i = 0; i < samples.length; i += 3) {
        if (p2p && inDeadZone(p2p, samples[i].s)) continue;
        v.copy(samples[i].position).project(probe);
        if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1) continue;
        inFrame++;
        if (v.x > MENU_EDGE_NDC) clear++;
      }
    }
    return inFrame ? clear / inFrame : 0;
  }

  private poseOf(shot: Shot, tau: number, near: number, out: AerialPose): AerialPose {
    if (shot.kind === "drone") {
      const u = shot.startU + DRONE_SPEED_MS * tau;
      const target = this.pointAt(u, this.target);
      const f = Math.min(tau / YAW_STEP_S, shot.yaw.length - 1.001);
      const i = Math.floor(f);
      const yaw = THREE.MathUtils.lerp(shot.yaw[i], shot.yaw[i + 1], f - i);
      const hx = Math.sin(yaw);
      const hz = Math.cos(yaw);
      // Rises a little through the shot, as a drone climbing away
      const height = (DRONE_HEIGHT_M + 14 * smoothstep(tau / AERIAL_SHOT_S)) * near;
      const y = Math.max(target.y + height, shot.floorY + height * 0.6);
      out.position.set(
        target.x - hx * DRONE_BACK_M * near - hz * DRONE_SIDE_M * near * shot.side,
        y,
        target.z - hz * DRONE_BACK_M * near + hx * DRONE_SIDE_M * near * shot.side
      );
      out.lookAt.set(target.x + hx * DRONE_LOOK_AHEAD_M, target.y, target.z + hz * DRONE_LOOK_AHEAD_M);
    } else {
      const rad = shot.startRad + shot.dir * ORBIT_RATE * tau;
      const r = ORBIT_RADIUS_M * near;
      const f = shot.focus;
      out.position.set(f.x + Math.sin(rad) * r, Math.max(f.y, shot.floorY) + ORBIT_HEIGHT_M * near, f.z + Math.cos(rad) * r);
      out.lookAt.copy(f);
    }
    return out;
  }
}
