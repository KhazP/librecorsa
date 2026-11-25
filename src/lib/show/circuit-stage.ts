/**
 * The pre-race show's circuit, drawn in 3D on a 2D canvas from the centreline alone (so every layout gets it, and it
 * costs a phone nothing): a turning view from high above, the lap drawing itself, its sectors colouring in, the road
 * rising into a wall with the corners numbered on it. Pure: the overlay's canvas asks for the frame at a time, the
 * verify suite checks the projection.
 */

export interface StagePoint {
  /** Metres from the circuit's middle (x east, y up, z south as the world has them) */
  x: number;
  y: number;
  z: number;
  /** Distance along the lap (m) and its share of the lap */
  s: number;
  u: number;
  sector: 1 | 2 | 3;
}

export interface StageTurn {
  number: number;
  /** Index into `points` of its apex */
  at: number;
}

export interface CircuitStageModel {
  points: StagePoint[];
  turns: StageTurn[];
  /** Half the circuit's largest horizontal extent (m) */
  radius: number;
  /** The rise of the road, highest less lowest (m) */
  elevationM: number;
  closed: boolean;
}

interface SampleLike {
  s: number;
  position: { x: number; y: number; z: number };
  sector: 1 | 2 | 3;
}

/** How many points the drawing keeps along the lap */
const STAGE_POINTS = 360;
/** The road's heights are drawn this much taller than they are, so a hill reads from up there */
export const ELEVATION_SCALE = 2.5;
/** The extruded wall height as a share of the circuit's horizontal radius */
export const STAGE_WALL_RATIO = 0.145;
/** Track ribbon half-width as a share of the circuit's horizontal radius (for the 3D deck) */
export const STAGE_ROAD_HALF_RATIO = 0.022;
/** Slow orbital camera rotation speed (rad/s) */
export const STAGE_YAW_SPEED = 0.06;

export interface StageSector {
  sector: 1 | 2 | 3;
  /** Index of the sector's first point */
  start: number;
  /** Index of the sector's middle point (for its S1/S2/S3 badge) */
  mid: number;
}

/** The drawing's points from the circuit's samples (evenly spaced), its corners by distance along the lap */
export function circuitStageModel(
  samples: readonly SampleLike[],
  totalLengthM: number,
  turns: readonly { number: number; sApprox: number }[],
  closed = true
): CircuitStageModel | null {
  if (samples.length < 8 || !(totalLengthM > 0)) return null;
  const step = Math.max(1, Math.floor(samples.length / STAGE_POINTS));
  const picked: SampleLike[] = [];
  for (let i = 0; i < samples.length; i += step) picked.push(samples[i]);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of picked) {
    minX = Math.min(minX, p.position.x);
    maxX = Math.max(maxX, p.position.x);
    minZ = Math.min(minZ, p.position.z);
    maxZ = Math.max(maxZ, p.position.z);
    minY = Math.min(minY, p.position.y);
    maxY = Math.max(maxY, p.position.y);
  }
  if (![minX, maxX, minZ, maxZ, minY, maxY].every(Number.isFinite)) return null;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const cy = (minY + maxY) / 2;
  const points = picked.map((p) => ({
    x: p.position.x - cx,
    y: (p.position.y - cy) * ELEVATION_SCALE,
    z: p.position.z - cz,
    s: p.s,
    u: Math.min(1, Math.max(0, p.s / totalLengthM)),
    sector: p.sector,
  }));
  const nearest = (s: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].s - s);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const stageTurns = turns
    .filter((t) => Number.isFinite(t.sApprox) && t.number > 0)
    .map((t) => ({ number: t.number, at: nearest(((t.sApprox % totalLengthM) + totalLengthM) % totalLengthM) }));
  return {
    points,
    turns: stageTurns,
    radius: Math.max(50, Math.hypot(maxX - minX, maxZ - minZ) / 2),
    elevationM: maxY - minY,
    closed,
  };
}

export interface StageView {
  /** Turn of the view about the vertical (rad) */
  yaw: number;
  /** How far the view looks down (rad, π/2 = straight down) */
  pitch: number;
  /** The canvas (CSS px) and where the circuit's middle sits on it */
  width: number;
  height: number;
  centreX: number;
  centreY: number;
  /** Share of the smaller side the circuit's extent fills */
  fill: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Distance from the eye (for drawing far things first) */
  depth: number;
}

/**
 * Projects a point of the drawing (`lift`: metres added on top, before the height scale is applied to the road)
 * through a camera turning about the circuit's middle and looking down at `pitch`
 */
export function projectStage(model: CircuitStageModel, view: StageView, x: number, y: number, z: number, out: Projected): Projected {
  const cosY = Math.cos(view.yaw);
  const sinY = Math.sin(view.yaw);
  // Turned about the vertical
  const rx = x * cosY - z * sinY;
  const rz = x * sinY + z * cosY;
  // Tilted: the camera looks down by the pitch towards +z (its up is +z tipped towards +y), from `distance` away
  const cosP = Math.cos(view.pitch);
  const sinP = Math.sin(view.pitch);
  const vy = y * cosP + rz * sinP;
  const vz = -y * sinP + rz * cosP;
  const distance = model.radius * 3.2;
  const depth = distance + vz;
  const focal = (Math.min(view.width, view.height) * view.fill * distance) / (2 * model.radius);
  out.x = view.centreX + (focal * rx) / Math.max(1, depth);
  out.y = view.centreY - (focal * vy) / Math.max(1, depth);
  out.depth = depth;
  return out;
}

/** The view's turn at a time into the show: a slow, steady turn, starting square to the start/finish straight */
export function stageYaw(model: CircuitStageModel, timeS: number): number {
  const a = model.points[0];
  const b = model.points[Math.min(model.points.length - 1, 3)];
  const heading = Math.atan2(b.x - a.x, b.z - a.z);
  return -heading + Math.PI / 2 + timeS * STAGE_YAW_SPEED;
}

/** Directional brightness (0..1) of a vertical wall segment from `a` to `b` under a top-left-front key light */
export function wallShade(a: StagePoint, b: StagePoint, yaw: number): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return 0.5;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  // Segment tangent rotated into camera yaw space, then horizontal normal
  const rx = (dx * cosY - dz * sinY) / len;
  const rz = (dx * sinY + dz * cosY) / len;
  const nx = -rz;
  const nz = rx;
  // Key light coming from front-left (-0.48, -0.88 in rotated XZ)
  const dot = Math.abs(nx * -0.48 + nz * -0.88);
  return 0.15 + 0.85 * Math.min(1, Math.max(0, dot));
}

/** Finds each sector's start and middle index along the circuit's points */
export function stageSectors(model: CircuitStageModel): StageSector[] {
  const pts = model.points;
  const out: StageSector[] = [];
  for (const sector of [1, 2, 3] as const) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].sector !== sector) continue;
      if (first === -1) first = i;
      last = i;
    }
    if (first !== -1) out.push({ sector, start: first, mid: Math.floor((first + last) / 2) });
  }
  return out;
}

/** Ease for the drawing's phases */
export const easeOut = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return 1 - (1 - t) * (1 - t) * (1 - t);
};

/** Smooth S-curve for rising walls and transitions */
export const easeInOut = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
