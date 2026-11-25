import * as THREE from "three";
import { Pass } from "postprocessing";
import { anyCarById, type CarId } from "@/lib/cars/car-registry";
import type { GraphicsQuality } from "@/lib/settings/player-settings";
import { DETAIL_LAYER } from "@/lib/render/layers";

/*
 * Rain water on the glass in front of the driver.
 *
 * Closed cars: droplets live on the car's own windscreen. A few thousand drops are simulated on the CPU in the
 * windscreen's plane (metres across and up the glass): rain lands and beads, drops grow as more lands on them, a drop
 * heavy enough for the forces on it (gravity along the glass, the air over it at speed, braking and cornering) breaks
 * loose and runs, leaving a trail of smaller beads and swallowing the drops in its path, and the wiper blade pushes
 * what it crosses to the end of its sweep. Each frame the drops are drawn as height bumps into a small water map, and
 * the car's windscreen meshes are drawn again with a material that reads it: inside a drop the scene behind the glass
 * is refracted through it (a half-size copy of the frame), darker towards the rim, and the blade and arm are drawn on
 * the glass where they are. The glass is depth-tested against the frame, so the wheel, dash and pillars stay in front.
 *
 * Open cars: the same drops on the driver's visor, in screen space, soft and out of focus, blown off by the air.
 *
 * The water meshes are drawn in the scene's own render (view camera only: the mirrors and the reflection probe leave
 * them out), as transparent objects that write the glass's depth where there is water, so the clouds and haze later
 * passes add by depth leave the drops alone. What they refract is a half-size copy of the previous frame, taken by a
 * composer pass right after the scene render: a frame late, inside an inverted image the size of a drop, is not seen,
 * and drawing in the scene pass costs no second resolve of the multisampled buffer.
 */

/** Drops simulated at once, per graphics tier (phones use Low's) */
export const WINDSCREEN_DROP_BUDGET: Readonly<Record<GraphicsQuality, number>> = {
  low: 400,
  medium: 1600,
  high: 2800,
};
/** Water map size (texels) per tier: about a texel per millimetre of glass on High */
const WATER_MAP_SIZE: Readonly<Record<GraphicsQuality, readonly [number, number]>> = {
  low: [512, 256],
  medium: [1024, 512],
  high: [1536, 768],
};
/**
 * Low (and every phone): the drops step 30 times a second and the water map is redrawn only when they did, the frame
 * copy seen through them is a quarter of the screen's width, and the fine beads' wetness is kept in coarser cells
 */
const LOW_STEP_EVERY = 2;
const SCENE_COPY_SCALE: Readonly<Record<GraphicsQuality, number>> = { low: 0.25, medium: 0.5, high: 0.5 };
const WET_CELL_LOW_M = 0.02;
const VISOR_DROP_BUDGET = 140;
const VISOR_MAP_SIZE: readonly [number, number] = [384, 216];
/** The visor's drops are simulated on a 10 cm tall patch of the view (so a 3 mm drop is a few % of the screen) */
const VISOR_HEIGHT = 0.1;
const VISOR_R_MAX = 0.006;

/** Largest drop radius the map encodes (m); merged drops are capped here and the rest runs off */
const R_MAX = 0.0055;
/** The largest drop as drawn: the water map's heights are shares of it */
const R_MAX_DRAWN = R_MAX * 1.5;
/**
 * Drops are drawn this much larger than they are simulated: at a cockpit's field of view a windscreen spans about a
 * pixel and a half per millimetre, where true-to-size beads would be specks of two or three pixels
 */
const DRAW_SCALE = 1.5;
/** Trail beads smaller than this (m) are not simulated, and simulated drops this small dry off within seconds */
const R_TRAIL_MIN = 0.0006;
/** Smallest drop kept (m); residue below it has dried */
const R_MIN = 0.00012;
/**
 * Pinning: a drop of radius r (mm) holds on to the glass against an acceleration up to PIN / r² (m/s²): on a raked
 * windscreen gravity alone moves drops of about 3 mm
 */
const PIN = 40;
/** The air's push on a drop at speed v (m/s), per mm of radius: AIR × v² / r (1.5 mm drops start up the glass at ~100 km/h) */
const AIR = 0.045;
/** Drop speed (m/s) per m/s² of acceleration past the pinning, per mm of radius */
const MOBILITY = 0.04;
const MAX_DROP_SPEED = 1.4;

export type WaterMode = "off" | "windscreen" | "visor";

// ---------------------------------------------------------------------------
// Wipers
// ---------------------------------------------------------------------------

/**
 * A car's wipers in the windscreen's own frame: pivots as shares of its width (from the car's right) and height
 * (from the bottom edge), blade reach as a share of its height, and the sweep. Angles are in the glass plane, 0° along
 * the glass towards the car's left and 90° straight up it; the blade parks at `parkDeg` and turns by `sweepDeg`
 * (negative: clockwise as the driver sees it).
 */
export interface WiperSpec {
  pivots: readonly (readonly [number, number])[];
  /** Blade from this share of the windscreen height out from the pivot to `outer` */
  inner: number;
  outer: number;
  parkDeg: number;
  sweepDeg: number;
}

/** One blade from the bottom middle, parked towards the passenger, sweeping across the driver's view */
const SINGLE_WIPER: WiperSpec = { pivots: [[0.5, -0.03]], inner: 0.18, outer: 0.98, parkDeg: 8, sweepDeg: 150 };
/** Two blades side by side, parked low, sweeping up together (most road cars) */
const TWIN_WIPERS: WiperSpec = { pivots: [[0.25, -0.02], [0.7, -0.02]], inner: 0.12, outer: 0.92, parkDeg: 4, sweepDeg: 100 };

const WIPER_OVERRIDES: Partial<Record<CarId, WiperSpec>> = {
  // The Mk2 Scirocco's one long blade
  "vw-scirocco-gtx": { pivots: [[0.42, -0.04]], inner: 0.15, outer: 1.02, parkDeg: 6, sweepDeg: 140 },
  "porsche-934-rsr": TWIN_WIPERS,
};

/** The car's wipers (null: none, as an open car has none) */
export function wiperSpecFor(carId: CarId): WiperSpec | null {
  const def = anyCarById(carId);
  if (!def || def.classId === "f1") return null;
  return WIPER_OVERRIDES[carId] ?? (def.classId === "road" ? TWIN_WIPERS : SINGLE_WIPER);
}

/** The same wipers seen in a mirror: for a car whose driver sits on the other side */
export function mirrorWiper(spec: WiperSpec): WiperSpec {
  return {
    ...spec,
    pivots: spec.pivots.map(([x, y]) => [1 - x, y] as const),
    parkDeg: 180 - spec.parkDeg,
    sweepDeg: -spec.sweepDeg,
  };
}

/** Blade angle (degrees, windscreen frame) at a wiper phase 0..1 (0 parked, 0.5 the far end), eased at both ends */
export function wiperBladeDeg(spec: WiperSpec, phase: number): number {
  const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * THREE.MathUtils.clamp(tri, 0, 1));
  return spec.parkDeg + spec.sweepDeg * eased;
}

// ---------------------------------------------------------------------------
// The windscreen glass of a car model
// ---------------------------------------------------------------------------

/** The windscreen found in a car model: its meshes and a plane frame fitted to it, in the chassis' space */
export interface WindscreenGlass {
  meshes: THREE.Mesh[];
  /** Which faces to draw so each point of the glass is drawn once from inside (glass with inner and outer skins) */
  side: THREE.Side;
  origin: THREE.Vector3;
  /** Across the glass towards the car's left, up the glass, and out of it (forward and up) */
  axisU: THREE.Vector3;
  axisV: THREE.Vector3;
  axisN: THREE.Vector3;
  /** The glass's extent along U and V from `origin` (m) */
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

const GLASS_NAME = /glass|window|windscreen|windshield|glaaass|glss/i;
const NOT_WINDSCREEN = /light|lamp|lens|led|screen|display|mirror|sticker|black_glass|indicator|steer|wheel|dash|gauge/i;
/** Normal of a typical raked windscreen (forward and up), chassis space */
const RAKE = new THREE.Vector3(0, 0.7, 0.714).normalize();

function namesOf(o: THREE.Object3D, stop: THREE.Object3D): string {
  let s = "";
  for (let p: THREE.Object3D | null = o; p && p !== stop; p = p.parent) s += ` ${p.name}`;
  return s;
}

/**
 * Finds a car model's windscreen: the glass meshes under `chassis` whose faces sit ahead of and around the driver's
 * eye (chassis space, +X left, +Y up, +Z forward) and face forward and up, and fits a plane frame to those faces.
 * Lamps, mirrors and screens are left out by name; side and rear windows by the way they face. Null when the model
 * has no such glass (open cars, or a model still loading).
 */
export function findWindscreenGlass(chassis: THREE.Object3D, eye: THREE.Vector3): WindscreenGlass | null {
  chassis.updateWorldMatrix(true, true);
  const toChassis = new THREE.Matrix4().copy(chassis.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const toEye = new THREE.Vector3();
  const normalSum = new THREE.Vector3();
  const centroidSum = new THREE.Vector3();
  let areaSum = 0;
  let frontArea = 0;
  const meshes: THREE.Mesh[] = [];
  /** Windscreen triangles' corners (chassis space), kept to measure the extent once the frame is known */
  const corners: number[] = [];

  chassis.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || Array.isArray(mesh.material)) return;
    const mat = mesh.material as THREE.Material;
    if (!GLASS_NAME.test(mat.name) || NOT_WINDSCREEN.test(mat.name) || NOT_WINDSCREEN.test(namesOf(mesh, chassis))) return;
    if (!mat.transparent && (mat as THREE.MeshStandardMaterial).opacity >= 1) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    m.multiplyMatrices(toChassis, mesh.matrixWorld);
    const mirrored = m.determinant() < 0;
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    let used = false;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(m);
      b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1).applyMatrix4(m);
      c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2).applyMatrix4(m);
      centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      const dz = centre.z - eye.z;
      const dy = centre.y - eye.y;
      if (dz < 0.2 || dz > 1.6 || dy < -0.45 || dy > 0.6 || Math.abs(centre.x) > 1.0) continue;
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const area2 = n.length();
      if (area2 < 1e-10) continue;
      n.divideScalar(area2);
      const facing = n.dot(RAKE);
      if (Math.abs(facing) < 0.55) continue;
      const area = area2 * 0.5;
      // Front-facing as the eye sees it (three flips the winding of a mirrored mesh)
      const towardEye = n.dot(toEye.subVectors(eye, centre)) > 0;
      if (towardEye !== mirrored) frontArea += area;
      // The plane's normal points out of the car whichever way the model wound its faces
      normalSum.addScaledVector(n, (facing >= 0 ? 1 : -1) * area);
      centroidSum.addScaledVector(centre, area);
      areaSum += area;
      corners.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      used = true;
    }
    if (used) meshes.push(mesh);
  });
  // Less than about 0.15 m² of glass ahead of the driver is not a windscreen (a lamp lens slipped through)
  if (areaSum < 0.15 || meshes.length === 0) return null;
  const axisN = normalSum.normalize();
  const origin = centroidSum.divideScalar(areaSum);
  const axisU = new THREE.Vector3(1, 0, 0).addScaledVector(axisN, -axisN.x).normalize();
  const axisV = new THREE.Vector3().crossVectors(axisN, axisU).normalize();
  if (axisV.y < 0) axisV.negate();
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < corners.length; i += 3) {
    a.set(corners[i] - origin.x, corners[i + 1] - origin.y, corners[i + 2] - origin.z);
    // Glass well off the plane (a lamp lens facing the same way) does not stretch the windscreen's frame
    if (Math.abs(a.dot(axisN)) > 0.15) continue;
    const u = a.dot(axisU);
    const v = a.dot(axisV);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  return {
    meshes,
    side: frontArea > 0.3 * areaSum ? THREE.FrontSide : THREE.BackSide,
    origin,
    axisU,
    axisV,
    axisN,
    uMin,
    uMax,
    vMin,
    vMax,
  };
}

// ---------------------------------------------------------------------------
// The drops
// ---------------------------------------------------------------------------

/** Per-step forces on the glass, in its own frame (m/s² along x and y) */
export interface DropForces {
  /** Gravity and the car's own acceleration felt along the glass */
  ax: number;
  ay: number;
  /** Air speed over the glass (m/s): pushes up the glass and out to the sides (windscreen) or out from the middle (visor) */
  airMs: number;
}

/**
 * Drops on a rectangle of glass `width` × `height` (m), x across and y up it. Struct of arrays, swap-removed, with a
 * uniform grid rebuilt every step for the merges (an impact on a drop, a running drop through others, beads piling up
 * along a wiper blade).
 */
export class DropletField {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly r: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Per-drop pinning strength (stick-slip: re-drawn as a drop runs, so drops stop and go) */
  private readonly pin: Float32Array;
  /** Distance run since the drop last left a bead behind (m) */
  private readonly run: Float32Array;
  count = 0;
  private cellSize = 0.008;
  private cols = 1;
  private rows = 1;
  private cellStart = new Int32Array(2);
  private cellCursor = new Int32Array(1);
  private cellItems: Int32Array;
  private readonly cellOf: Int32Array;
  private readonly dead: Uint8Array;
  private seed = 1234567;

  constructor(
    readonly capacity: number,
    public width: number,
    public height: number,
    /** "visor": out of focus, blown out from the middle, no beads left behind */
    readonly kind: "windscreen" | "visor" = "windscreen"
  ) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.r = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.pin = new Float32Array(capacity);
    this.run = new Float32Array(capacity);
    this.cellItems = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.dead = new Uint8Array(capacity);
    this.resize(width, height);
  }

  /** A deterministic random number in [0, 1) (the field reproduces a run from the same inputs) */
  rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(0.05, width);
    this.height = Math.max(0.05, height);
    // Cells as wide as the largest merge reach (two drops' radii), so a 3 × 3 block finds every neighbour
    this.cellSize = this.kind === "visor" ? 0.05 : 0.012;
    this.cols = Math.max(1, Math.ceil(this.width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(this.height / this.cellSize));
    this.cellStart = new Int32Array(this.cols * this.rows + 1);
    this.cellCursor = new Int32Array(this.cols * this.rows);
  }

  clear(): void {
    this.count = 0;
  }

  /** Adds a drop (merging it into a drop it lands on); false when the field is full and nothing was near */
  add(x: number, y: number, r: number): boolean {
    const hit = this.findOverlap(x, y, r, -1);
    if (hit >= 0) {
      this.absorb(hit, x, y, r);
      return true;
    }
    // Full: the impact is lost among the fine beads (the wetness grid's)
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.r[i] = r;
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.pin[i] = 0.6 + 0.8 * this.rand();
    this.run[i] = 0;
    this.dead[i] = 0;
    this.cellOf[i] = -1;
    return true;
  }

  /** Merges a drop of radius `r` at (x, y) into drop `i` (volumes add; the centre moves towards the heavier) */
  private absorb(i: number, x: number, y: number, r: number): void {
    const vi = this.r[i] ** 3;
    const vj = r ** 3;
    const v = vi + vj;
    this.x[i] = (this.x[i] * vi + x * vj) / v;
    this.y[i] = (this.y[i] * vi + y * vj) / v;
    this.r[i] = Math.min(R_MAX, Math.cbrt(v));
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
    return cy * this.cols + cx;
  }

  /** Counting sort of the drops into the grid (positions as they are now) */
  private rebuildGrid(): void {
    const start = this.cellStart;
    const cellOf = this.cellOf;
    const xs = this.x;
    const ys = this.y;
    const inv = 1 / this.cellSize;
    const cols = this.cols;
    const colMax = cols - 1;
    const rowMax = this.rows - 1;
    start.fill(0);
    for (let i = 0; i < this.count; i++) {
      let cx = Math.floor(xs[i] * inv);
      let cy = Math.floor(ys[i] * inv);
      cx = cx < 0 ? 0 : cx > colMax ? colMax : cx;
      cy = cy < 0 ? 0 : cy > rowMax ? rowMax : cy;
      const c = cy * cols + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < start.length - 1; c++) start[c + 1] += start[c];
    const fill = this.cellItems;
    const cursor = this.cellCursor;
    cursor.set(start.subarray(0, start.length - 1));
    for (let i = 0; i < this.count; i++) fill[cursor[this.cellOf[i]]++] = i;
  }

  /** A live drop overlapping a circle (x, y, r), other than `self`, or -1 (grid as last rebuilt) */
  private findOverlap(x: number, y: number, r: number, self: number): number {
    const cols = this.cols;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const start = this.cellStart;
    const items = this.cellItems;
    const xs = this.x;
    const ys = this.y;
    const rs = this.r;
    const dead = this.dead;
    const count = this.count;
    const gy1 = Math.min(this.rows - 1, cy + 1);
    const gx1 = Math.min(cols - 1, cx + 1);
    for (let gy = Math.max(0, cy - 1); gy <= gy1; gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= gx1; gx++) {
        const c = gy * cols + gx;
        const k1 = start[c + 1];
        for (let k = start[c]; k < k1; k++) {
          const j = items[k];
          if (j === self || j >= count || dead[j]) continue;
          const dx = xs[j] - x;
          const dy = ys[j] - y;
          const rr = (rs[j] + r) * 0.85;
          if (dx * dx + dy * dy < rr * rr) return j;
        }
      }
    }
    return -1;
  }

  /**
   * One step: `newDrops` rain drops land, the forces move the drops heavy enough to break loose, running drops shed
   * beads and swallow what they cross, the wiper (if any) pushes what its blade swept since the last step, and the
   * finest residue dries.
   */
  step(dt: number, newDrops: number, sizeScale: number, f: DropForces, wiper: WiperSweep | null): void {
    if (dt <= 0) return;
    this.rebuildGrid();
    const W = this.width;
    const H = this.height;
    const visor = this.kind === "visor";
    // Landing rain: mostly fine drops with a few larger ones
    let n = Math.floor(newDrops);
    if (this.rand() < newDrops - n) n++;
    for (let k = 0; k < n; k++) {
      const s = this.rand();
      const r = (visor ? 0.0015 + 0.0035 * s * s : 0.0014 + 0.002 * s * s * s) * sizeScale;
      this.add(this.rand() * W, this.rand() * H, r);
    }

    const end = this.count;
    const xs = this.x;
    const ys = this.y;
    const rs = this.r;
    const pins = this.pin;
    const dead = this.dead;
    const air2 = AIR * f.airMs * f.airMs;
    const windy = f.airMs > 0.5;
    for (let i = 0; i < end; i++) {
      if (dead[i]) continue;
      const r = rs[i];
      const rMm = r * 1000;
      let ax = f.ax;
      let ay = f.ay;
      if (windy) {
        const push = air2 / (rMm > 0.2 ? rMm : 0.2);
        if (visor) {
          // Out from the middle of the view, and up
          const dx = xs[i] - W * 0.5;
          const dy = ys[i] - H * 0.45;
          const d = Math.sqrt(dx * dx + dy * dy) + 0.02;
          ax += push * (dx / d) * 0.8;
          ay += push * ((dy / d) * 0.8 + 0.35);
        } else {
          // Up the glass, spreading out towards the pillars the higher it gets
          const side = (xs[i] / W - 0.5) * 2;
          const up = ys[i] / H;
          ax += push * side * (0.15 + 0.55 * up);
          ay += push;
        }
      }
      const a2 = ax * ax + ay * ay;
      const hold = (PIN * pins[i]) / (rMm * rMm);
      if (a2 > hold * hold) {
        const a = Math.sqrt(a2);
        let speed = Math.min(MAX_DROP_SPEED, MOBILITY * (a - hold) * rMm);
        if (visor) speed = Math.min(MAX_DROP_SPEED * 2, speed * 3);
        const ux = ax / a;
        const uy = ay / a;
        // A little wander across the direction of travel, as a drop finds its way down dry glass
        const wander = (this.rand() - 0.5) * 0.35;
        const vx = (ux - uy * wander) * speed;
        const vy = (uy + ux * wander) * speed;
        this.vx[i] = vx;
        this.vy[i] = vy;
        const px = this.x[i];
        const py = this.y[i];
        this.x[i] = px + vx * dt;
        this.y[i] = py + vy * dt;
        const moved = speed * dt;
        this.run[i] += moved;
        // A bead left behind every few radii run: the trail; it costs the running drop its volume. Beads too small to
        // see are left to the fine-bead layer
        const rb = r * (0.3 + 0.18 * this.rand());
        if (!visor && this.run[i] > 2.6 * r && rb > R_TRAIL_MIN && this.count < this.capacity) {
          this.run[i] = 0;
          const j = this.count++;
          this.x[j] = px;
          this.y[j] = py;
          this.r[j] = rb;
          this.vx[j] = 0;
          this.vy[j] = 0;
          this.pin[j] = 0.8 + 0.8 * this.rand();
          this.run[j] = 0;
          this.dead[j] = 0;
          this.cellOf[j] = -1;
          this.r[i] = Math.cbrt(Math.max(0, r ** 3 - rb ** 3));
        }
        // Stick-slip: the glass holds harder or softer as the drop meets clean or wet patches
        if (this.rand() < moved * 60) this.pin[i] = 0.6 + 0.8 * this.rand();
        // Swallow what it runs into
        const hit = this.findOverlap(this.x[i], this.y[i], this.r[i], i);
        if (hit >= 0 && hit < end && !this.dead[hit] && hit !== i) {
          this.absorb(i, this.x[hit], this.y[hit], this.r[hit]);
          this.dead[hit] = 1;
        }
      } else if (this.vx[i] !== 0 || this.vy[i] !== 0) {
        this.vx[i] = 0;
        this.vy[i] = 0;
      }
    }

    if (wiper) this.applyWiper(wiper);

    // Dry the finest residue, drop what left the glass, and compact
    const dry = (visor ? 0.0004 : 0.00006) * dt;
    let w = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      let r = this.r[i];
      if (r < R_TRAIL_MIN || visor) r -= dry;
      const x = this.x[i];
      const y = this.y[i];
      if (r < R_MIN || x < -r || x > W + r || y < -r || y > H + r) continue;
      if (w !== i) {
        this.x[w] = x;
        this.y[w] = y;
        this.vx[w] = this.vx[i];
        this.vy[w] = this.vy[i];
        this.pin[w] = this.pin[i];
        this.run[w] = this.run[i];
      }
      this.r[w] = r;
      this.dead[w] = 0;
      w++;
    }
    this.count = w;
  }

  /**
   * The blades swept from `fromDeg` to `toDeg` about each pivot since the last step: every drop in the swept band is
   * carried to just ahead of the blade, and the drops riding the blade merge where they bunch up, so a line of beads
   * builds along it and is left at the end of the stroke. A few fine traces stay behind the rubber.
   */
  private applyWiper(wp: WiperSweep): void {
    const d0 = THREE.MathUtils.degToRad(wp.fromDeg);
    const d1 = THREE.MathUtils.degToRad(wp.toDeg);
    if (Math.abs(d1 - d0) < 1e-5) return;
    const lo = Math.min(d0, d1);
    const hi = Math.max(d0, d1);
    const dir = Math.sign(d1 - d0);
    // A bin per 5 mm of blade: drops riding the same stretch of rubber merge into one bead
    const binM = 0.005;
    for (const [px, py] of wp.pivots) {
      const bins = new Map<number, number>();
      // Traces left this stroke are appended past `end` and stay where they were left
      const end = this.count;
      for (let i = 0; i < end; i++) {
        if (this.dead[i]) continue;
        const dx = this.x[i] - px;
        const dy = this.y[i] - py;
        const rho = Math.sqrt(dx * dx + dy * dy);
        if (rho < wp.inner - 0.01 || rho > wp.outer + this.r[i]) continue;
        let ang = Math.atan2(dy, dx);
        if (ang < -Math.PI / 2) ang += Math.PI * 2;
        if (ang < lo - 0.002 || ang > hi + 0.002) continue;
        if (this.rand() < 0.03 && this.r[i] > 0.0006 && this.count < this.capacity) {
          // A fine trace left by the rubber where the drop was; the drop rides on
          const rt = Math.min(0.00035, this.r[i] * 0.3);
          const j = this.count++;
          this.x[j] = this.x[i];
          this.y[j] = this.y[i];
          this.r[j] = rt;
          this.vx[j] = 0;
          this.vy[j] = 0;
          this.pin[j] = 1.4;
          this.run[j] = 0;
          this.dead[j] = 0;
          this.r[i] = Math.cbrt(this.r[i] ** 3 - rt ** 3);
        }
        const lead = d1 + dir * (0.01 + this.r[i] / Math.max(0.05, rho));
        const rr = Math.min(rho, wp.outer);
        this.x[i] = px + Math.cos(lead) * rr;
        this.y[i] = py + Math.sin(lead) * rr;
        this.vx[i] = 0;
        this.vy[i] = 0;
        const bin = Math.floor(rho / binM);
        const into = bins.get(bin);
        if (into === undefined) bins.set(bin, i);
        else {
          this.absorb(into, this.x[i], this.y[i], this.r[i]);
          this.dead[i] = 1;
        }
      }
    }
  }
}

/** The blades' sweep over the last step, in the field's own coordinates (m) */
export interface WiperSweep {
  pivots: readonly (readonly [number, number])[];
  inner: number;
  outer: number;
  fromDeg: number;
  toDeg: number;
}

/** Wetness cells of the fine-bead layer (m): about one bead of the finer grid each */
const WET_CELL_M = 0.012;

/**
 * How wet each patch of the glass is (0..1, 12 mm cells), for the fine beads too small and too many to simulate one
 * by one: rain wets it, the air at speed dries it, and the wiper blade wipes it dry and re-seeds its bead pattern (a
 * generation count per cell, so the beads that form again after a stroke are not the ones it wiped). Uploaded each
 * frame as a small RG8 texture (wetness, generation).
 */
export class WetnessGrid {
  cols = 1;
  rows = 1;
  wet = new Float32Array(1);
  /** The wettest cell after the last step */
  maxWet = 0;
  private gen = new Uint8Array(1);
  private data = new Uint8Array(2);
  /** Per pivot: each cell's distance from it and angle about it, worked out once per size */
  private polar: { rho: Float32Array; ang: Float32Array; pivot: readonly [number, number] }[] = [];
  texture: THREE.DataTexture;

  constructor(
    public width: number,
    public height: number,
    private cellM = WET_CELL_M
  ) {
    this.texture = this.makeTexture();
    this.resize(width, height);
  }

  /** A coarser or finer grid (takes effect at once; the glass dries) */
  setCellSize(cellM: number): void {
    if (cellM === this.cellM) return;
    this.cellM = cellM;
    this.cols = 0;
    this.resize(this.width, this.height);
  }

  private makeTexture(): THREE.DataTexture {
    const t = new THREE.DataTexture(this.data, this.cols, this.rows, THREE.RGFormat, THREE.UnsignedByteType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const cols = Math.max(1, Math.ceil(width / this.cellM));
    const rows = Math.max(1, Math.ceil(height / this.cellM));
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.wet = new Float32Array(cols * rows);
      this.gen = new Uint8Array(cols * rows);
      this.data = new Uint8Array(cols * rows * 2);
      this.texture.dispose();
      this.texture = this.makeTexture();
    }
    this.polar = [];
  }

  clear(): void {
    this.wet.fill(0);
    this.maxWet = 0;
  }

  private polarFor(pivot: readonly [number, number]) {
    let p = this.polar.find((q) => q.pivot[0] === pivot[0] && q.pivot[1] === pivot[1]);
    if (p) return p;
    const n = this.cols * this.rows;
    const rho = new Float32Array(n);
    const ang = new Float32Array(n);
    const cw = this.width / this.cols;
    const ch = this.height / this.rows;
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const dx = (i + 0.5) * cw - pivot[0];
        const dy = (j + 0.5) * ch - pivot[1];
        let a = Math.atan2(dy, dx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        rho[j * this.cols + i] = Math.hypot(dx, dy);
        ang[j * this.cols + i] = a;
      }
    }
    p = { rho, ang, pivot };
    this.polar.push(p);
    return p;
  }

  /** Rain adds `gain` per second, the air takes `airLoss` of it per second, the blades wipe what they swept */
  step(dt: number, gain: number, airLoss: number, wiper: WiperSweep | null): void {
    const wet = this.wet;
    const add = gain * dt;
    const keep = Math.exp(-(airLoss + 0.01) * dt);
    for (let k = 0; k < wet.length; k++) {
      const v = wet[k] * keep + add;
      wet[k] = v < 1 ? v : 1;
    }
    if (wiper) {
      const d0 = THREE.MathUtils.degToRad(wiper.fromDeg);
      const d1 = THREE.MathUtils.degToRad(wiper.toDeg);
      for (const pivot of wiper.pivots) {
        const { rho, ang } = this.polarFor(pivot);
        const margin = this.cellM * 0.7;
        for (let k = 0; k < wet.length; k++) {
          const r = rho[k];
          if (r < wiper.inner - margin || r > wiper.outer + margin) continue;
          const pad = margin / Math.max(0.05, r);
          const a = ang[k];
          if (a < Math.min(d0, d1) - pad || a > Math.max(d0, d1) + pad) continue;
          if (wet[k] > 0.02) this.gen[k] = (this.gen[k] + 1) & 255;
          wet[k] = 0;
        }
      }
    }
  }

  /** Packs the grid into its texture (and finds the wettest cell) */
  upload(): void {
    const d = this.data;
    const wet = this.wet;
    const gen = this.gen;
    let most = 0;
    for (let k = 0; k < wet.length; k++) {
      const v = wet[k];
      if (v > most) most = v;
      d[k * 2] = (v * 255 + 0.5) | 0;
      d[k * 2 + 1] = gen[k];
    }
    this.maxWet = most;
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

// ---------------------------------------------------------------------------
// GPU side
// ---------------------------------------------------------------------------

/*
 * The water map: per texel the height of the water there (R, a share of the largest drop) and its slope across and up
 * the glass (G, B; -1.2..1.2 mapped to 0..1). Drops and beads are drawn with a depth test that keeps the highest water
 * per texel, so overlapping drops keep the slope of the one on top and the glass reads one texel for its shading.
 */
const SLOPE_RANGE = 2.4;

const DROP_VERT = /* glsl */ `
attribute vec4 aDrop;   // x, y (m), radius (m), unused
attribute vec2 aStretch; // run direction × elongation (0: a resting bead)
uniform vec2 uExtent;   // field width, height (m)
uniform float uRMax;
varying vec2 vLocal;
varying float vHeight;
varying float vTail;
varying vec2 vDir;
void main() {
  vec2 dir = length(aStretch) > 1e-4 ? normalize(aStretch) : vec2(0.0, 1.0);
  float k = length(aStretch);
  // Right of the run direction: keeps the quad's winding (a mirrored quad is culled as a back face)
  vec2 side = vec2(dir.y, -dir.x);
  // The quad covers the bead and, for a running drop, a tail behind it
  vec2 q = position.xy; // -1..1
  float along = q.y > 0.0 ? q.y : q.y * (1.0 + 1.6 * k);
  vec2 p = aDrop.xy + (side * q.x + dir * along) * aDrop.z * 1.05;
  vLocal = vec2(q.x, along) * 1.05;
  vTail = 1.0 + 1.6 * k;
  vHeight = aDrop.z / uRMax;
  vDir = dir;
  gl_Position = vec4(p / uExtent * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Writes one drop: height, slope, and the depth that keeps the highest water */
const WATER_OUT = /* glsl */ `
uniform float uReversed;
void writeWater(float h, vec2 slope) {
  gl_FragDepth = uReversed > 0.5 ? h : 1.0 - h;
  gl_FragColor = vec4(h, clamp(slope / ${SLOPE_RANGE.toFixed(1)} + 0.5, 0.0, 1.0), 1.0);
}
`;

const DROP_FRAG = /* glsl */ `
${WATER_OUT}
uniform float uSoft;
varying vec2 vLocal;
varying float vHeight;
varying float vTail;
varying vec2 vDir;
void main() {
  // A round cap in front, drawn out into a tapering tail behind a running drop
  bool tail = vLocal.y < 0.0;
  float sa = tail ? vTail : 1.0;
  float sb = tail ? 1.0 / (1.0 + 0.6 * (-vLocal.y / vTail)) : 1.0;
  float a = vLocal.y / sa;
  float b = vLocal.x / sb;
  float d2 = a * a + b * b;
  if (d2 >= 1.0) discard;
  // A drop sitting on glass is a shallow cap (contact angle about 50°: its peak about 0.6 of its radius); out of
  // focus (the visor), a softer bump. Slopes are per metre of glass, along the run and across it
  float hard = 1.0 - d2;
  float g = mix(1.0, 2.0 * hard, uSoft);
  float h = vHeight * 0.6 * mix(hard, hard * hard, uSoft);
  vec2 local = -1.2 * g * vec2(b / sb, a / sa);
  vec2 side = vec2(vDir.y, -vDir.x);
  writeWater(h, side * local.x + vDir * local.y);
}
`;

/**
 * The fine beads (drawn at the drops' scale): three jittered grids of cells (10.5, 14 and 22 mm), each with one bead
 * of its own size and place that has formed once the cell's wetness passes the bead's own threshold
 */
const MICRO_FRAG = /* glsl */ `
${WATER_OUT}
uniform sampler2D uWet;
uniform vec2 uExtent;
uniform float uRMax;
varying vec2 vUv;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Height (x) and slope (yz) of the cell's bead at p, or zero
vec3 bead(vec2 p, float cellM, float salt, float share) {
  vec2 cell = floor(p / cellM);
  vec2 wg = texture2D(uWet, (cell + 0.5) * cellM / uExtent).rg;
  float gen = floor(wg.g * 255.0 + 0.5);
  vec2 seed = cell + vec2(gen * 17.13 + salt, gen * 31.71 - salt);
  if (hash12(seed) > wg.r * share) return vec3(0.0);
  float r = cellM * (0.13 + 0.22 * hash12(seed + 7.7)) * (0.75 + 0.25 * wg.r);
  vec2 jitter = vec2(hash12(seed + 3.1), hash12(seed + 11.3)) - 0.5;
  vec2 c = (cell + 0.5 + jitter * (1.0 - 2.0 * r / cellM)) * cellM;
  vec2 d = (p - c) / r;
  float d2 = dot(d, d);
  if (d2 >= 1.0) return vec3(0.0);
  return vec3(r / uRMax * 0.6 * (1.0 - d2), -1.2 * d);
}
void main() {
  vec2 p = vUv * uExtent;
  // Three grids of different pitch, none filling every cell even when soaked, so no regular pattern shows
  vec3 a = bead(p, 0.014, 0.0, 0.7);
  vec3 b = bead(p, 0.022, 51.7, 0.45);
  vec3 c = bead(p + 0.0047, 0.0105, 23.3, 0.4);
  vec3 w = a.x >= b.x ? a : b;
  w = w.x >= c.x ? w : c;
  if (w.x <= 0.0) discard;
  writeWater(w.x, w.yz);
}
`;

const COPY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const COPY_FRAG = /* glsl */ `
uniform sampler2D tInput;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tInput, vUv).rgb, 1.0);
}
`;

/** Shared by the glass and the visor: refraction through a drop from the water map's height and slope */
const WATER_SHADE = /* glsl */ `
uniform sampler2D uWater;
uniform sampler2D uScene;
uniform vec2 uViewport;
uniform float uRefract;
uniform vec3 uSky;
// Height (x), slope across (y) and up (z) the glass at uv
vec3 waterAt(vec2 uv) {
  vec4 t = texture2D(uWater, uv);
  return vec3(t.r, (t.gb - 0.5) * ${SLOPE_RANGE.toFixed(1)});
}
// The scene through a drop: an inverted, shrunken view (rays through the rim bend most), darker at the rim where the
// light inside reflects back, and the sky's light gathered at its lower edge
vec4 shadeDrop(vec3 w, vec2 dirU, vec2 dirV, float edge0, float edge1, float lookDown) {
  vec3 nT = normalize(vec3(-w.y, -w.z, 1.0));
  vec2 screenUv = gl_FragCoord.xy / uViewport;
  // A small bead bends the view less far than a big drop (whose peak is higher): no speckle of far-off pixels
  vec2 off = (dirU * -nT.x + dirV * -nT.y) * uRefract * clamp(w.x * 4.0, 0.35, 1.0);
  // The frame copy holds the cabin too: low on the glass, looking far down the view would find the dash, not the road
  off.y = off.y < 0.0 ? off.y * lookDown : off.y;
  vec3 seen = texture2D(uScene, clamp(screenUv + off, vec2(0.001), vec2(0.999))).rgb;
  // The light from higher up the view (the sky by day, the lamps at night), which a drop gathers low inside it
  vec3 above = texture2D(uScene, clamp(screenUv + dirV * uRefract * 1.4, vec2(0.001), vec2(0.999))).rgb;
  float slope = clamp(length(nT.xy), 0.0, 1.0);
  // Through the steep rim the light reflects inside the drop instead of passing: a darker ring
  vec3 col = seen * (0.96 - 0.58 * smoothstep(0.42, 0.74, slope));
  // That gathered light low in the drop, and a glint off its upper side
  vec3 L = normalize(vec3(0.25, 0.6, 0.76));
  col += max(above, uSky) * (0.3 * pow(clamp(-nT.y * 1.2, 0.0, 1.0), 2.0) + 1.1 * pow(clamp(dot(nT, L), 0.0, 1.0), 22.0));
  float cover = smoothstep(edge0, edge1, w.x);
  return vec4(col, cover);
}
`;

const GLASS_VERT = /* glsl */ `
uniform mat4 uMeshToChassis;
uniform vec3 uOrigin;
uniform vec3 uAxisU;
uniform vec3 uAxisV;
uniform vec3 uAxisN;
uniform vec4 uRect; // uMin, vMin, 1/width, 1/height
varying vec2 vMap;
varying float vPlane;
varying float vFacing;
void main() {
  vec3 pc = (uMeshToChassis * vec4(position, 1.0)).xyz;
  vec3 nc = normalize(mat3(uMeshToChassis) * normal);
  vec3 d = pc - uOrigin;
  vMap = vec2((dot(d, uAxisU) - uRect.x) * uRect.z, (dot(d, uAxisV) - uRect.y) * uRect.w);
  vPlane = dot(d, uAxisN);
  vFacing = abs(dot(nc, uAxisN));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GLASS_FRAG = /* glsl */ `
${WATER_SHADE}
uniform vec2 uDirU;
uniform vec2 uDirV;
uniform vec2 uExtent;
uniform vec4 uBladeA; // pivot x, y (m), angle (rad), on
uniform vec4 uBladeB;
uniform vec4 uBladeShape; // inner, outer reach (m), blade half width, arm half width (m)
uniform vec3 uBladeColor;
varying vec2 vMap;
varying float vPlane;
varying float vFacing;

float bladeCover(vec4 blade, vec2 p, float aa) {
  if (blade.w < 0.5) return 0.0;
  vec2 dir = vec2(cos(blade.z), sin(blade.z));
  vec2 rel = p - blade.xy;
  float t = dot(rel, dir);
  float s = dir.x * rel.y - dir.y * rel.x;
  // The rubber along the outer reach, and the arm from the pivot, a little behind the blade
  float rubber = (1.0 - smoothstep(uBladeShape.z - aa, uBladeShape.z + aa, abs(s)))
    * step(uBladeShape.x, t) * step(t, uBladeShape.y);
  float armT = clamp(t / max(0.01, 0.6 * uBladeShape.y), 0.0, 1.0);
  float arm = (1.0 - smoothstep(uBladeShape.w - aa, uBladeShape.w + aa, abs(s + uBladeShape.w * 1.6 * armT)))
    * step(0.0, t) * step(t, 0.6 * uBladeShape.y);
  return max(rubber, arm);
}

void main() {
  if (vFacing < 0.5 || abs(vPlane) > 0.16) discard;
  if (vMap.x < 0.0 || vMap.y < 0.0 || vMap.x > 1.0 || vMap.y > 1.0) discard;
  vec2 p = vMap * uExtent;
  float aa = max(fwidth(p.x), fwidth(p.y)) * 0.75;
  float blade = max(bladeCover(uBladeA, p, aa), bladeCover(uBladeB, p, aa));
  vec3 w = waterAt(vMap);
  if (w.x < 0.004 && blade < 0.01) discard;
  vec4 drop = shadeDrop(w, uDirU, uDirV, 0.004, 0.03, mix(0.25, 1.0, smoothstep(0.3, 0.6, vMap.y)));
  vec3 col = mix(drop.rgb, uBladeColor, blade);
  float a = max(drop.a, blade);
  if (a < 0.12) discard;
  gl_FragColor = vec4(col, a);
}
`;

const VISOR_VERT = /* glsl */ `
uniform float uNearZ;
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, uNearZ, 1.0);
}
`;

const VISOR_FRAG = /* glsl */ `
${WATER_SHADE}
varying vec2 vUv;
void main() {
  vec3 w = waterAt(vUv);
  if (w.x < 0.01) discard;
  vec4 drop = shadeDrop(w, vec2(1.0, 0.0), vec2(0.0, 1.0), 0.02, 0.35, 0.5);
  // Out of focus this close to the eye: a soft, slightly milky lens rather than a crisp bead
  vec3 col = mix(drop.rgb, drop.rgb * 0.9 + uSky * 0.06, 0.5);
  float a = drop.a * 0.85;
  if (a < 0.02) discard;
  gl_FragColor = vec4(col, a);
}
`;

/** Fullscreen triangle in clip space */
function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  return g;
}

export interface WindscreenWaterFrame {
  dt: number;
  /** Rain falling (0..1) and spray thrown up by the cars ahead (0..1) */
  rain: number;
  spray: number;
  mode: WaterMode;
  carId: CarId;
  /** The sprung body of the car whose glass it is, and its driver's eye in that body's space */
  chassis: THREE.Object3D;
  eye: THREE.Vector3 | null;
  camera: THREE.Camera;
  /** Wiper phase 0..1 (0 parked) and whether they run */
  wiperPhase: number;
  /** Sky brightness 0..1 */
  light: number;
}

interface GlassProxy {
  source: THREE.Mesh;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

/**
 * The composer pass for water on the glass (see the header). Disabled (skipped by the composer) whenever there is
 * nothing to draw: dry glass, a chase view, VR.
 */
export class WindscreenWaterPass extends Pass {
  private quality: GraphicsQuality = "high";
  /** The water meshes, in the main scene */
  private readonly group = new THREE.Group();
  private readonly dropScene = new THREE.Scene();
  private readonly dropCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly copyScene = new THREE.Scene();
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly dropMaterial: THREE.ShaderMaterial;
  private dropGeometry: THREE.InstancedBufferGeometry;
  private dropAttr: THREE.InstancedBufferAttribute;
  private stretchAttr: THREE.InstancedBufferAttribute;
  private waterTarget: THREE.WebGLRenderTarget;
  private visorTarget: THREE.WebGLRenderTarget;
  private sceneTarget: THREE.WebGLRenderTarget;
  private readonly visorMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly visorDropMaterial: THREE.ShaderMaterial;
  private field: DropletField;
  private readonly visorField = new DropletField(VISOR_DROP_BUDGET, VISOR_HEIGHT * 1.78, VISOR_HEIGHT, "visor");
  private readonly wetGrid = new WetnessGrid(1.4, 0.7);
  private readonly microMaterial: THREE.ShaderMaterial;
  private readonly microMesh: THREE.Mesh;
  private glass: WindscreenGlass | null = null;
  private glassFor: THREE.Object3D | null = null;
  private glassCar: CarId | null = null;
  private glassScanMs = -Infinity;
  private proxies: GlassProxy[] = [];
  private modeNow: WaterMode = "off";
  private wiper: WiperSpec | null = null;
  private wiperDeg = 0;
  private readonly prevChassisPos = new THREE.Vector3();
  private readonly chassisVel = new THREE.Vector3();
  private readonly chassisAcc = new THREE.Vector3();
  private hasPrevPose = false;
  private viewport = new THREE.Vector2(1, 1);
  private readonly bladeColor = new THREE.Color(0.012, 0.012, 0.013);
  private readonly sky = new THREE.Color();
  private activeSince = -1;
  private pendingDt = 0;
  private frameNo = 0;
  /** Whether the drops stepped this frame (the water map is redrawn only then) */
  private mapDirty = true;
  /** The blade where it is drawn this frame (the drops' sweep follows it at their own step rate) */
  private wiperDegNow = 0;
  private chassis: THREE.Object3D | null = null;
  /** Whether the renderer's depth runs reversed (the water maps' highest-water test writes depth to match) */
  private reversedDepth: THREE.IUniform<number>;

  constructor(private readonly host: THREE.Scene) {
    super("WindscreenWaterPass");
    this.needsSwap = false;
    this.enabled = false;
    this.group.name = "windscreen-water";
    this.group.matrixAutoUpdate = false;
    host.add(this.group);
    this.dropScene.matrixWorldAutoUpdate = false;
    this.copyScene.matrixWorldAutoUpdate = false;
    this.field = new DropletField(WINDSCREEN_DROP_BUDGET.high, 1.4, 0.7);

    const quad = new THREE.PlaneGeometry(2, 2);
    this.dropGeometry = new THREE.InstancedBufferGeometry();
    this.dropGeometry.index = quad.index;
    this.dropGeometry.setAttribute("position", quad.getAttribute("position"));
    this.dropAttr = new THREE.InstancedBufferAttribute(new Float32Array(WINDSCREEN_DROP_BUDGET.high * 4), 4);
    this.stretchAttr = new THREE.InstancedBufferAttribute(new Float32Array(WINDSCREEN_DROP_BUDGET.high * 2), 2);
    this.dropAttr.setUsage(THREE.DynamicDrawUsage);
    this.stretchAttr.setUsage(THREE.DynamicDrawUsage);
    this.dropGeometry.setAttribute("aDrop", this.dropAttr);
    this.dropGeometry.setAttribute("aStretch", this.stretchAttr);
    this.dropGeometry.instanceCount = 0;
    // The highest water wins each texel (WATER_OUT's depth): no blending
    const topWater = {
      blending: THREE.NoBlending,
      depthTest: true,
      depthWrite: true,
      depthFunc: THREE.LessEqualDepth,
    } as const;
    const reversed = { value: 1 };
    this.reversedDepth = reversed;
    this.dropMaterial = new THREE.ShaderMaterial({
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      uniforms: { uExtent: { value: new THREE.Vector2(1, 1) }, uRMax: { value: R_MAX_DRAWN }, uSoft: { value: 0 }, uReversed: reversed },
      ...topWater,
    });
    this.visorDropMaterial = new THREE.ShaderMaterial({
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      uniforms: {
        uExtent: { value: new THREE.Vector2(VISOR_HEIGHT * 1.78, VISOR_HEIGHT) },
        uRMax: { value: VISOR_R_MAX },
        uSoft: { value: 1 },
        uReversed: reversed,
      },
      ...topWater,
    });
    const drops = new THREE.Mesh(this.dropGeometry, this.dropMaterial);
    drops.frustumCulled = false;
    this.dropScene.add(drops);

    const tri = fullscreenTriangle();
    this.microMaterial = new THREE.ShaderMaterial({
      vertexShader: COPY_VERT,
      fragmentShader: MICRO_FRAG,
      uniforms: {
        uWet: { value: this.wetGrid.texture },
        uExtent: { value: new THREE.Vector2(1.4, 0.7) },
        uRMax: { value: R_MAX_DRAWN },
        uReversed: reversed,
      },
      ...topWater,
    });
    this.microMesh = new THREE.Mesh(tri, this.microMaterial);
    this.microMesh.frustumCulled = false;
    this.microMesh.visible = false;
    this.dropScene.add(this.microMesh);
    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: COPY_VERT,
      fragmentShader: COPY_FRAG,
      uniforms: { tInput: { value: null } },
      depthTest: false,
      depthWrite: false,
    });
    const copy = new THREE.Mesh(tri, this.copyMaterial);
    copy.frustumCulled = false;
    this.copyScene.add(copy);

    // The water maps: RGBA8 (height, slope) with a depth buffer for the highest-water test; the scene copy keeps the
    // frame's linear HDR
    const rt = (w: number, h: number, hdr: boolean) =>
      new THREE.WebGLRenderTarget(w, h, {
        type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
        depthBuffer: !hdr,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    const [mw, mh] = WATER_MAP_SIZE.high;
    this.waterTarget = rt(mw, mh, false);
    this.visorTarget = rt(VISOR_MAP_SIZE[0], VISOR_MAP_SIZE[1], false);
    this.sceneTarget = rt(2, 2, true);

    this.visorMesh = new THREE.Mesh(
      tri,
      new THREE.ShaderMaterial({
        vertexShader: VISOR_VERT,
        fragmentShader: VISOR_FRAG,
        uniforms: this.waterUniforms(this.visorTarget, 0.05, { uNearZ: { value: 1 } }),
        transparent: true,
        // Depth writes need the test on: always passes, and the drops then keep the clouds and haze off them
        depthTest: true,
        depthFunc: THREE.AlwaysDepth,
        depthWrite: true,
      })
    );
    this.visorMesh.frustumCulled = false;
    // View camera only, drawn after everything else in the scene (it is in front of everything)
    this.visorMesh.layers.set(DETAIL_LAYER);
    this.visorMesh.renderOrder = 10000;
    this.visorMesh.visible = false;
    this.group.add(this.visorMesh);
  }

  /** The uniforms both water materials share */
  private waterUniforms(
    target: THREE.WebGLRenderTarget,
    refract: number,
    extra: Record<string, THREE.IUniform> = {}
  ): Record<string, THREE.IUniform> {
    return {
      uWater: { value: target.texture },
      uScene: { value: this.sceneTarget?.texture ?? null },
      uViewport: { value: this.viewport },
      uRefract: { value: refract },
      uSky: { value: this.sky },
      ...extra,
    };
  }

  setQuality(quality: GraphicsQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    const [mw, mh] = WATER_MAP_SIZE[quality];
    this.waterTarget.setSize(mw, mh);
    this.field = new DropletField(WINDSCREEN_DROP_BUDGET[quality], this.field.width, this.field.height);
    this.wetGrid.setCellSize(quality === "low" ? WET_CELL_LOW_M : WET_CELL_M);
    for (const p of this.proxies) this.syncGlassUniforms(p.mesh.material);
    this.activeSince = -1;
    this.setSize(this.viewport.x, this.viewport.y);
  }

  override setSize(width: number, height: number): void {
    this.viewport.set(width, height);
    const k = SCENE_COPY_SCALE[this.quality];
    this.sceneTarget.setSize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)));
  }

  /** Whether drops are on the glass now (for tests and the HUD) */
  get dropCount(): number {
    return this.modeNow === "visor" ? this.visorField.count : this.modeNow === "windscreen" ? this.field.count : 0;
  }

  private dropProxies(): void {
    for (const p of this.proxies) {
      this.group.remove(p.mesh);
      p.mesh.material.dispose();
    }
    this.proxies = [];
  }

  private syncGlassUniforms(mat: THREE.ShaderMaterial): void {
    const g = this.glass;
    if (!g) return;
    const w = g.uMax - g.uMin;
    const h = g.vMax - g.vMin;
    const u = mat.uniforms;
    u.uOrigin.value.copy(g.origin);
    u.uAxisU.value.copy(g.axisU);
    u.uAxisV.value.copy(g.axisV);
    u.uAxisN.value.copy(g.axisN);
    u.uRect.value.set(g.uMin, g.vMin, 1 / w, 1 / h);
    u.uExtent.value.set(w, h);
  }

  private buildProxies(): void {
    this.dropProxies();
    const g = this.glass;
    if (!g) return;
    for (const source of g.meshes) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: GLASS_VERT,
        fragmentShader: GLASS_FRAG,
        uniforms: {
          ...this.waterUniforms(this.waterTarget, 0.16),
          uMeshToChassis: { value: new THREE.Matrix4() },
          uOrigin: { value: new THREE.Vector3() },
          uAxisU: { value: new THREE.Vector3() },
          uAxisV: { value: new THREE.Vector3() },
          uAxisN: { value: new THREE.Vector3() },
          uRect: { value: new THREE.Vector4() },
          uExtent: { value: new THREE.Vector2() },
          uDirU: { value: new THREE.Vector2(1, 0) },
          uDirV: { value: new THREE.Vector2(0, 1) },
          uBladeA: { value: new THREE.Vector4() },
          uBladeB: { value: new THREE.Vector4() },
          uBladeShape: { value: new THREE.Vector4() },
          uBladeColor: { value: this.bladeColor },
        },
        transparent: true,
        depthTest: true,
        depthWrite: true,
        side: g.side,
        // Just in front of the glass it lies on
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      this.syncGlassUniforms(mat);
      const mesh = new THREE.Mesh(source.geometry, mat);
      mesh.name = "windscreen-water-glass";
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      // It takes the glass's pose as it is drawn (the scene has just brought the car's matrices up to this frame)
      mesh.frustumCulled = false;
      mesh.onBeforeRender = () => mesh.matrixWorld.copy(source.matrixWorld);
      mesh.layers.set(DETAIL_LAYER);
      this.group.add(mesh);
      this.proxies.push({ source, mesh });
    }
  }

  /** Finds (or re-finds after a car change or a late model load) the windscreen of the car being driven */
  private ensureGlass(f: WindscreenWaterFrame, nowMs: number): boolean {
    if (this.glassFor === f.chassis && this.glassCar === f.carId && this.glass) return true;
    if (this.glassFor === f.chassis && this.glassCar === f.carId && nowMs - this.glassScanMs < 1000) return false;
    this.glassFor = f.chassis;
    this.glassCar = f.carId;
    this.glassScanMs = nowMs;
    this.glass = f.eye ? findWindscreenGlass(f.chassis, f.eye) : null;
    this.wiper = wiperSpecFor(f.carId);
    // Specs park the blade towards the car's left; a driver sitting on the left has it park towards the passenger
    if (this.wiper && f.eye && f.eye.x > 0.05) this.wiper = mirrorWiper(this.wiper);
    this.buildProxies();
    if (this.glass) {
      const w = this.glass.uMax - this.glass.uMin;
      const h = this.glass.vMax - this.glass.vMin;
      this.field.resize(w, h);
      this.field.clear();
      this.wetGrid.resize(w, h);
      this.wetGrid.clear();
      (this.microMaterial.uniforms.uExtent.value as THREE.Vector2).set(w, h);
      this.activeSince = -1;
    }
    return this.glass !== null;
  }

  /** Per drawn frame, before the composer renders */
  update(f: WindscreenWaterFrame): void {
    const nowMs = performance.now();
    const dt = Math.min(0.1, Math.max(0, f.dt));
    this.trackChassis(f.chassis, dt);
    const wet = f.rain > 0.01 || f.spray > 0.02;
    let mode = f.mode;
    if (mode === "windscreen" && !this.ensureGlass(f, nowMs)) mode = "off";
    const field = mode === "visor" ? this.visorField : this.field;
    if (mode !== this.modeNow) {
      this.modeNow = mode;
      this.activeSince = -1;
    }
    const water = field.count > 0 || (mode === "windscreen" && this.wetGrid.maxWet > 0.01);
    if (mode === "off" || (!wet && !water)) {
      this.enabled = false;
      this.visorMesh.visible = false;
      for (const p of this.proxies) p.mesh.visible = false;
      return;
    }
    // A floor for the drops' gathered light where the view above them is dark (the cabin roof)
    this.sky.setRGB(0.55, 0.6, 0.68).multiplyScalar(0.05 + 0.3 * THREE.MathUtils.clamp(f.light, 0, 1));
    // Coming into the view in the rain: the glass is already as wet as it would be by now
    const prime = this.activeSince < 0 && wet;
    this.activeSince = nowMs;
    // Low steps every other frame with both frames' time (the blade still moves every frame)
    this.pendingDt += dt;
    this.frameNo++;
    const due = prime || this.quality !== "low" || this.frameNo % LOW_STEP_EVERY === 0;
    if (mode === "windscreen" && this.wiper) this.wiperDegNow = wiperBladeDeg(this.wiper, f.wiperPhase);
    this.mapDirty = due;
    if (due) {
      const steps = prime ? 24 : 1;
      const stepDt = prime ? 0.1 : Math.min(0.1, this.pendingDt);
      this.pendingDt = 0;
      for (let s = 0; s < steps; s++) {
        if (mode === "visor") this.stepVisor(stepDt, f);
        else this.stepWindscreen(stepDt, f, s === steps - 1);
      }
      this.uploadDrops(field, mode === "visor" ? VISOR_R_MAX : R_MAX_DRAWN, mode === "visor" ? 1 : DRAW_SCALE);
      if (mode === "windscreen") {
        this.wetGrid.upload();
        this.microMaterial.uniforms.uWet.value = this.wetGrid.texture;
      }
    }
    this.microMesh.visible = mode === "windscreen";
    if (mode === "visor") {
      this.visorMesh.visible = true;
      for (const p of this.proxies) p.mesh.visible = false;
    } else {
      this.visorMesh.visible = false;
      for (const p of this.proxies) p.mesh.visible = p.source.visible !== false;
    }
    this.chassis = f.chassis;
    if (mode === "windscreen" && this.glass) this.syncProxies(f.camera, f.chassis);
    if (this.mapDirty) this.renderMap();
    this.enabled = true;
  }

  /** Draws the drops (and fine beads) into the water map, before the frame's scene render reads it */
  private renderMap(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    const prevTarget = renderer.getRenderTarget();
    const clear = renderer.getClearColor(_color);
    const clearAlpha = renderer.getClearAlpha();
    // Dry glass is no height and a level slope
    this.reversedDepth.value = renderer.state.buffers.depth.getReversed() ? 1 : 0;
    renderer.setClearColor(_dryGlass, 0);
    renderer.setRenderTarget(this.modeNow === "visor" ? this.visorTarget : this.waterTarget);
    renderer.clear(true, true, false);
    if (this.dropGeometry.instanceCount > 0 || this.microMesh.visible) renderer.render(this.dropScene, this.dropCamera);
    renderer.setClearColor(clear, clearAlpha);
    renderer.setRenderTarget(prevTarget);
    this.visorMesh.material.uniforms.uNearZ.value = this.reversedDepth.value > 0.5 ? 1 : -1;
  }

  /** The chassis' velocity and acceleration in its own frame, from its pose over the last frames (smoothed) */
  private trackChassis(chassis: THREE.Object3D, dt: number): void {
    const pos = _v1.setFromMatrixPosition(chassis.matrixWorld);
    if (!this.hasPrevPose || dt <= 0) {
      this.prevChassisPos.copy(pos);
      this.hasPrevPose = true;
      return;
    }
    const vWorld = _v2.subVectors(pos, this.prevChassisPos).divideScalar(dt);
    this.prevChassisPos.copy(pos);
    // A teleport (reset, replay seek) is not a speed
    if (vWorld.lengthSq() > 120 * 120) return;
    _q.setFromRotationMatrix(chassis.matrixWorld).invert();
    const vLocal = vWorld.applyQuaternion(_q);
    const k = 1 - Math.exp(-dt * 6);
    const aLocal = _v3.subVectors(vLocal, this.chassisVel).divideScalar(dt).clampLength(0, 40);
    this.chassisAcc.lerp(aLocal, k);
    this.chassisVel.lerp(vLocal, 1 - Math.exp(-dt * 12));
  }

  private stepWindscreen(dt: number, f: WindscreenWaterFrame, last: boolean): void {
    const g = this.glass!;
    const field = this.field;
    const area = field.width * field.height;
    const fwd = Math.max(0, this.chassisVel.z);
    // Felt along the glass: gravity (world down in the chassis' frame) and the car's acceleration, reversed
    _q.setFromRotationMatrix(f.chassis.matrixWorld).invert();
    const felt = _v1.set(0, -9.81, 0).applyQuaternion(_q).sub(this.chassisAcc);
    const forces: DropForces = { ax: felt.dot(g.axisU), ay: felt.dot(g.axisV), airMs: fwd };
    // The glass sweeps through the rain as the car drives: more lands at speed. The simulated drops are the larger
    // ones; the fine beads between them are the wetness grid's
    const rate = area * (f.rain * 60 * (1 + fwd / 14) + f.spray * 120);
    let sweep: WiperSweep | null = null;
    if (this.wiper && last) {
      const deg = wiperBladeDeg(this.wiper, f.wiperPhase);
      if (Math.abs(deg - this.wiperDeg) > 1e-3) {
        const h = field.height;
        sweep = {
          pivots: this.wiper.pivots.map(([px, py]) => [px * field.width, py * h] as const),
          inner: this.wiper.inner * h,
          outer: this.wiper.outer * h,
          fromDeg: this.wiperDeg,
          toDeg: deg,
        };
      }
      this.wiperDeg = deg;
    }
    // Drops from the spray are finer than rain
    const sizeScale = f.spray > f.rain ? 0.7 : 1;
    field.step(dt, rate * dt, sizeScale, forces, sweep);
    // Fine beads: full in a couple of seconds of heavy rain standing still; the air thins them past ~150 km/h
    const airLoss = (fwd / 40) ** 2;
    this.wetGrid.step(dt, f.rain * 0.45 * (1 + fwd / 14) + f.spray * 0.9, airLoss, sweep);
  }

  private stepVisor(dt: number, f: WindscreenWaterFrame): void {
    const field = this.visorField;
    const aspect = this.viewport.x / Math.max(1, this.viewport.y);
    if (Math.abs(field.width - aspect * VISOR_HEIGHT) > 0.001) {
      field.resize(aspect * VISOR_HEIGHT, VISOR_HEIGHT);
    }
    const fwd = Math.max(0, this.chassisVel.z);
    // A helmet visor faces forward: rain reaches it mostly as the car drives into it, and at speed the air sends the
    // drops across it in about half a second (the visor sits in the cockpit's slower air: a third of the car's speed)
    const rate = f.rain * (2 + fwd * 0.8) + f.spray * 20;
    field.step(dt, rate * dt, 1, { ax: 0, ay: -0.6, airMs: fwd * 0.33 }, null);
  }

  private uploadDrops(field: DropletField, rMax: number, scale: number): void {
    const n = Math.min(field.count, this.dropAttr.count);
    const d = this.dropAttr.array as Float32Array;
    const s = this.stretchAttr.array as Float32Array;
    for (let i = 0; i < n; i++) {
      d[i * 4] = field.x[i];
      d[i * 4 + 1] = field.y[i];
      d[i * 4 + 2] = Math.min(field.r[i] * scale, rMax);
      d[i * 4 + 3] = 0;
      const vx = field.vx[i];
      const vy = field.vy[i];
      const sp = Math.sqrt(vx * vx + vy * vy);
      const k = Math.min(1.6, sp * 4);
      s[i * 2] = sp > 1e-4 ? (vx / sp) * k : 0;
      s[i * 2 + 1] = sp > 1e-4 ? (vy / sp) * k : 0;
    }
    this.dropAttr.clearUpdateRanges();
    this.dropAttr.addUpdateRange(0, n * 4);
    this.dropAttr.needsUpdate = true;
    this.stretchAttr.clearUpdateRanges();
    this.stretchAttr.addUpdateRange(0, n * 2);
    this.stretchAttr.needsUpdate = true;
    this.dropGeometry.instanceCount = n;
    const mat = field === this.visorField ? this.visorDropMaterial : this.dropMaterial;
    (mat.uniforms.uExtent.value as THREE.Vector2).set(field.width, field.height);
    (this.dropScene.children[0] as THREE.Mesh).material = mat;
  }

  /**
   * The proxies' poses and the view-dependent uniforms. Runs in render(), after the scene pass has brought the world
   * matrices up to this frame: in update() they are last frame's, a car's length behind at racing speed
   */
  private syncProxies(camera: THREE.Camera, chassis: THREE.Object3D): void {
    const g = this.glass!;
    const chassisInv = _m1.copy(chassis.matrixWorld).invert();
    // Screen directions of the glass's own axes (for the refraction's offset)
    const toView = _m2.multiplyMatrices(camera.matrixWorldInverse, chassis.matrixWorld);
    const du = _v1.copy(g.axisU).transformDirection(toView);
    const dv = _v2.copy(g.axisV).transformDirection(toView);
    const duLen = Math.hypot(du.x, du.y) || 1;
    const dvLen = Math.hypot(dv.x, dv.y) || 1;
    const field = this.field;
    const blades = this.wiper?.pivots ?? [];
    const rad = THREE.MathUtils.degToRad(this.wiperDegNow);
    for (const p of this.proxies) {
      const mesh = p.mesh;
      mesh.matrixWorld.copy(p.source.matrixWorld);
      const u = mesh.material.uniforms;
      (u.uMeshToChassis.value as THREE.Matrix4).multiplyMatrices(chassisInv, p.source.matrixWorld);
      (u.uDirU.value as THREE.Vector2).set(du.x / duLen, du.y / duLen);
      (u.uDirV.value as THREE.Vector2).set(dv.x / dvLen, dv.y / dvLen);
      u.uScene.value = this.sceneTarget.texture;
      const spec = this.wiper;
      const setBlade = (v: THREE.Vector4, i: number) => {
        if (!spec || i >= blades.length) return v.set(0, 0, 0, 0);
        return v.set(blades[i][0] * field.width, blades[i][1] * field.height, rad, 1);
      };
      setBlade(u.uBladeA.value as THREE.Vector4, 0);
      setBlade(u.uBladeB.value as THREE.Vector4, 1);
      if (spec) (u.uBladeShape.value as THREE.Vector4).set(spec.inner * field.height, spec.outer * field.height, 0.009, 0.006);
    }
  }

  /** Runs right after the scene render: a smaller copy of the frame, for next frame's drops to see through */
  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget | null): void {
    if (!inputBuffer || this.modeNow === "off") return;
    this.copyMaterial.uniforms.tInput.value = inputBuffer.texture;
    renderer.setRenderTarget(this.sceneTarget);
    renderer.render(this.copyScene, this.dropCamera);
  }

  override dispose(): void {
    this.dropProxies();
    this.waterTarget.dispose();
    this.visorTarget.dispose();
    this.sceneTarget.dispose();
    this.dropGeometry.dispose();
    this.dropMaterial.dispose();
    this.visorDropMaterial.dispose();
    this.copyMaterial.dispose();
    this.microMaterial.dispose();
    this.wetGrid.dispose();
    this.visorMesh.material.dispose();
    this.visorMesh.geometry.dispose();
    this.host.remove(this.group);
    super.dispose();
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _color = new THREE.Color();
const _dryGlass = new THREE.Color(0, 0.5, 0.5);
