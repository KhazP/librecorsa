/**
 * Physics surfaces named by what the circuit draws, where its converted physics got them wrong (per circuit, in code,
 * like the venue models: no hosted file changes).
 *
 * - Norisring: its physics road is the lap's own band, 9-17 m wide, but the street is drawn as asphalt out to the
 *   barriers (20 m and more across), and the bands past the edge called it run-off and grass. A car using the street
 *   was off the track (and on grass grip) on drawn asphalt. Every drawn road and kerb between the barriers is the
 *   track, except past a kerb's outer edge (the car parks, escape roads and the island behind the hairpins' kerbs);
 *   paving past the barriers stays as it is. At turns 2-6 the areas marked on the reviewed corner images
 *   (marked-areas.ts) apply on top: street marked as track that the street rule misses (past the lap's
 *   barrier distances, which run short at the Schöller S, or paving it doesn't read as road) is the track, and the
 *   back straight's promenades, the curb strips behind the Schöller S's inside wall and road faces jutting past the
 *   start-finish straight's edge are off it, except where an area marked as track overlaps them.
 * - Red Bull Ring: its physics counts the yellow kerbs and kerb cubes inside Castrol Edge (turn 1) and Remus (turn 2)
 *   as kerb and road, out to the grass: a car with all four wheels past the red and white kerb, on the yellow kerb and
 *   the cubes, stayed on the track (players' board laps went 8.4-8.9 m inside the line there). The yellow kerb and the
 *   cubes are sausages, past the track limits (the surface table's `sausage`, not part of the track); the South
 *   course's Castrol Edge too. At the two corners, as marked on their reviewed images: the anti-cut rumble outside
 *   Castrol Edge's exit and the astroturf behind Remus's outside exit kerb are sausages too (both were kerb);
 *   the racing asphalt out to the white line, and the red and white kerb, are the track where the physics called them
 *   run-off and grass; and the road collider's asphalt past the white line on the pit exit before Castrol Edge, and
 *   on the gore island past its apex, is run-off.
 *
 * - Goodwood (the hill climb): its road collider reaches 1-2.5 m past the asphalt over the verges, the ground under
 *   the hay bales, the flint wall and the side-road mouths, and at Turn 2 and Molecomb it is shifted off the road.
 *   The areas marked on its reviewed corner images (marked-areas.ts) make the track the asphalt, out to its edge.
 * - Red Bull Ring, inner skill course: the course through the driving centre is laid out in cones, a lane 3.6-9.4 m
 *   wide, but its physics road is a 10.5 m band round the lap, past the cones on every corner and over grass islands
 *   on some. The track is the lane between the cones, out to their outer edges (cone-lanes.ts); the old band past
 *   them, the open pads, the other lanes and the grass islands are off it.
 *
 * Each rule takes the circuit's physics faces lying under the drawn meshes of its materials, where it applies, and
 * moves them to a `Track_Surface_<Kind>` node at their own heights: the ground the car drives on is unchanged, only
 * what it is called. Faces across the drawn edge are split (quartered down to `PIECE_M`) so the cut follows it. Over
 * the road collider, which has no surface node to move, a rule lays a copy of its faces instead.
 */
import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { SPIELBERG_INNER_CONE_LANE } from "./cone-lanes";
import { GOODWOOD_MARKED_AREAS, NORISRING_MARKED_AREAS, type MarkedArea } from "./marked-areas";
import { isTrackSurfaceKind, type SurfaceTable, type TrackSurfaceKind } from "./track-surfaces";

export interface DrawnSurfaceRule {
  /**
   * Drawn materials (by name), the circuit's own racing-surface materials (`metadata.mesh.roadMaterials`), or null:
   * wherever the rule applies, whatever is drawn there
   */
  materials: readonly string[] | "roadMaterials" | null;
  /** What the physics under them is */
  surface: TrackSurfaceKind;
  /** The physics surfaces the rule renames (all when absent) */
  from?: readonly TrackSurfaceKind[];
  /**
   * Where it applies: lap stretches [from, to] (m) on a side (-1 left, +1 right); lap bands [from, to, side, near,
   * far], a stretch's side from `near` to `far` m off the centre line; areas, world outlines (x, z pairs) less any
   * `except` outline over them; or anywhere between the lap's barriers (each side's barrier distance at that point of
   * the lap, `wallLeftM` / `wallRightM`)
   */
  within:
    | { stretches: readonly (readonly [number, number, -1 | 1])[] }
    | { bands: readonly (readonly [number, number, -1 | 1, number, number])[] }
    | { areas: readonly (readonly number[])[]; except?: readonly (readonly number[])[] }
    | "barriers";
  /**
   * Also lays the rule's surface over the road collider (`Track_Collider_Road`) where it applies, as a copy of its
   * faces there: the road collider stays the ground the car drives on, the copy says what it is
   */
  overRoadCollider?: boolean;
  /**
   * Drawn materials that lie on the rule's ground in places (a sand or grass patch drawn over the street mesh, a
   * millimetre apart): where one of them is within `COVER_M` of a point, the ground there is not the rule's
   */
  covers?: readonly string[];
  /**
   * With `within: "barriers"`: where the lap has a kerb on a side, the rule stops at the kerb's outer edge there instead
   * of the barrier (past a corner's kerb is off the track, however much asphalt is drawn)
   */
  kerbsLimit?: boolean;
  /**
   * Never on the lap's road: inside its track-data width where the circuit's road (`roadMaterials`) is drawn (where
   * that width lies over drawn grass, as where it is shifted off the road, the rule applies)
   */
  offTheRoad?: boolean;
  /** How fine a face across the drawn edge is cut (m; default `PIECE_M`) */
  pieceM?: number;
  note: string;
}

const OFF_ROAD: readonly TrackSurfaceKind[] = ["runoff", "gravel", "grass"];
const ON_TRACK: readonly TrackSurfaceKind[] = ["road", "kerb", "pitlane"];
/** Norisring's drawn grass and sand (grassa, SandVariation, grassouttemp, 3dgrasb) */
const NORISRING_COVERS = ["grassa", "sanda", "grassout", "dteichgrass"];
/**
 * A circuit's marked corner images (marked-areas.ts) as two rules, cut to 0.5 m (about the pen's line): the areas
 * marked as track are road where the physics left them off it, and the areas marked off it are run-off where they are
 * track (the road collider too), except where an area marked as track overlaps them (the finer image's marks win) and
 * inside the lap's road (its track-data width: a mark that reaches into it is a coarse image's pen, the road is the
 * track)
 */
function markedAreaRules(areas: readonly MarkedArea[], track: string, off: string): DrawnSurfaceRule[] {
  const legal = areas.filter((a) => a.legal).map((a) => a.outline);
  return [
    { materials: null, surface: "road", from: OFF_ROAD, within: { areas: legal }, pieceM: 0.5, note: track },
    {
      materials: null,
      surface: "runoff",
      from: ON_TRACK,
      overRoadCollider: true,
      within: { areas: areas.filter((a) => !a.legal).map((a) => a.outline), except: legal },
      offTheRoad: true,
      pieceM: 0.5,
      note: off,
    },
  ];
}
/** How far past its lane a circuit laid out in cones (`coneLaneRules`) is off the track (m) */
const CONE_LANE_MARGIN_M = 15;
/**
 * A circuit laid out in cones (cone-lanes.ts) as two rules, cut to 0.5 m: the lane between the cones is road where the
 * physics left it off it, and every other piece of track ground within `CONE_LANE_MARGIN_M` of it is run-off (the road
 * collider too), the lap's track-data width included
 */
function coneLaneRules(legal: readonly (readonly number[])[], track: string, off: string): DrawnSurfaceRule[] {
  if (!legal.length) return [];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const o of legal) {
    for (let i = 0; i < o.length; i += 2) {
      x0 = Math.min(x0, o[i]);
      x1 = Math.max(x1, o[i]);
      z0 = Math.min(z0, o[i + 1]);
      z1 = Math.max(z1, o[i + 1]);
    }
  }
  const m = CONE_LANE_MARGIN_M;
  const around = [x0 - m, z0 - m, x1 + m, z0 - m, x1 + m, z1 + m, x0 - m, z1 + m];
  return [
    { materials: null, surface: "road", from: OFF_ROAD, within: { areas: legal }, pieceM: 0.5, note: track },
    { materials: null, surface: "runoff", from: ON_TRACK, overRoadCollider: true, within: { areas: [around], except: legal }, pieceM: 0.5, note: off },
  ];
}
/**
 * The Red Bull Ring's sausage kerbs: curb_yellow, curb_cubes (two), curb_cubes_red and the anti-cut rumble (rmblsafe).
 * Its names here are the same in the venue pair and the full GLB.
 */
const RED_BULL_RING_SAUSAGES = ["Material #12016", "Material #13667", "Material #19120", "Material #19526", "rmbl_anticut"];
/** Its racing asphalt (Castrol Edge's, Remus's) and white line (two names) */
const RED_BULL_RING_ROAD = ["Material #11573", "Material #11583", "Material #3147", "line_01"];
/** Its red and white kerbs (curb_redWhite2, curb_redWhite1) */
const RED_BULL_RING_KERBS = ["Material #18918", "Material #19534"];
/** Its astroturf: carpet_B_2, redbull_carpet_01_d, curb_greenFlat_3 (and with a drain) */
const RED_BULL_RING_TURF = ["Material #12386", "Material #18425", "Material #19423", "Material #19509"];

// Castrol Edge (turn 1), the same s in the full lap and the South course: the yellow kerb and cubes inside it, the
// anti-cut rumble outside its exit; the asphalt round its outside out to the white line (10 m out at the apex); the
// road collider past the white line (7.25-7.5 m out) on the pit exit beside the run to it, from where the armco
// between them ends, and on the gore island past the apex, up to where the pit exit lane merges
type Stretch = readonly [number, number, -1 | 1];
type Band = readonly [number, number, -1 | 1, number, number];
const CASTROL_EDGE_SAUSAGES: Stretch[] = [[295, 360, 1], [340, 420, -1]];
const CASTROL_EDGE_ROAD: Band[] = [[316, 342, -1, 5, 10.1]];
const CASTROL_EDGE_PIT_EXIT: Band[] = [[222, 298, 1, 7.6, 16], [348, 368, 1, 7.75, 16]];
const pitExit = (bands: Band[]): DrawnSurfaceRule => ({
  materials: null,
  surface: "runoff",
  from: ["road"],
  overRoadCollider: true,
  within: { bands },
  note: "the road collider past the white line on the pit exit before Castrol Edge and the gore island past its apex",
});

export const DRAWN_SURFACE_RULES: Readonly<Record<string, readonly DrawnSurfaceRule[]>> = {
  norisring: [
    // The gravel traps and grass drawn over the street mesh in places stay as they are; cut to 0.5 m, as where the
    // street meets a gravel trap inside the barriers its edge is the track limit
    { materials: "roadMaterials", surface: "road", from: OFF_ROAD, within: "barriers", kerbsLimit: true, covers: NORISRING_COVERS, pieceM: 0.5, note: "the drawn street between the barriers" },
    // curbrubber and the drain strip by the kerbs
    { materials: ["CurbRubber", "rmblb"], surface: "kerb", from: OFF_ROAD, within: "barriers", kerbsLimit: true, covers: NORISRING_COVERS, pieceM: 0.5, note: "the drawn kerbs between the barriers" },
    // The corner images of turns 2-6 as marked: street the rules above leave off the track (past the lap's barrier
    // distances, which run 1-2 m short at the Schöller S, paving the street rule doesn't read as road), and what is off
    // it although drawn as street or kerb (the back straight's promenades, the curb strips behind the Schöller S's
    // inside wall, road faces jutting past the start-finish straight's edge; the coarser turn 4 image's marks reach up
    // to 1.5 m onto that straight's road)
    ...markedAreaRules(NORISRING_MARKED_AREAS, "the areas marked as track on the corner images", "the areas marked off the track on the corner images"),
  ],
  // The hill climb's marked images, all of the course: the track is the asphalt, out to its edge. Its road collider
  // reached 1-2.5 m past the asphalt over the verges, the ground under the hay bales, the flint wall and the
  // shoulders; it ran over side-road and driveway mouths blocked by bales; and at Turn 2 and Molecomb it is shifted
  // off the road, leaving asphalt on the outside off the track (Molecomb's entry up to the bales; at Turn 2's
  // Y-junction the main road through)
  goodwood: markedAreaRules(GOODWOOD_MARKED_AREAS, "the asphalt marked as track on the corner images", "the verges, shoulders and side-road mouths marked off the track on the corner images"),
  spielberg: [
    {
      materials: RED_BULL_RING_SAUSAGES,
      surface: "sausage",
      from: ON_TRACK,
      within: { stretches: [...CASTROL_EDGE_SAUSAGES, [1240, 1300, 1]] },
      note: "the yellow kerbs and cubes inside Castrol Edge (turn 1) and Remus (turn 2), the anti-cut rumble outside Castrol Edge's exit",
    },
    // Behind Remus's outside exit kerb the physics kerb ran on under the astroturf, standing up to 15 cm over the run-off
    // beneath: as a sausage (raised, off the track) it keeps the kerb's heights, capped as they were
    { materials: RED_BULL_RING_TURF, surface: "sausage", from: ["kerb"], within: { stretches: [[1278, 1350, -1]] }, note: "the astroturf behind Remus's outside exit kerb" },
    {
      materials: RED_BULL_RING_ROAD,
      surface: "road",
      from: OFF_ROAD,
      // Remus: inside on the way in, outside, inside on the way out (the white line 7.75-9 m out)
      within: { bands: [...CASTROL_EDGE_ROAD, [1238, 1260, 1, 5, 8.25], [1255, 1284, -1, 5, 10], [1282, 1300, 1, 5, 8]] },
      note: "the racing asphalt out to the white line at Castrol Edge and Remus",
    },
    { materials: RED_BULL_RING_KERBS, surface: "kerb", from: OFF_ROAD, within: { bands: [[1255, 1284, -1, 5, 10]] }, note: "Remus's outside kerb" },
    pitExit(CASTROL_EDGE_PIT_EXIT),
  ],
  // The South course runs the same lap to past Castrol Edge (and leaves before Remus)
  spielberg_south: [
    {
      materials: RED_BULL_RING_SAUSAGES,
      surface: "sausage",
      from: ON_TRACK,
      within: { stretches: CASTROL_EDGE_SAUSAGES },
      note: "the yellow kerbs and cubes inside Castrol Edge (turn 1), the anti-cut rumble outside its exit",
    },
    { materials: RED_BULL_RING_ROAD, surface: "road", from: OFF_ROAD, within: { bands: CASTROL_EDGE_ROAD }, note: "the racing asphalt out to the white line at Castrol Edge" },
    pitExit(CASTROL_EDGE_PIT_EXIT),
  ],
  spielberg_inner: coneLaneRules(
    SPIELBERG_INNER_CONE_LANE,
    "the lane between the cones",
    "past the cones: the old band round the lap, the open pads, the other lanes and the grass islands",
  ),
};

/** The physics nodes a rule may rename, by the surface each holds */
const SURFACE_NODES: Readonly<Record<string, TrackSurfaceKind>> = {
  Track_Surface_Road: "road",
  Track_Surface_Apron: "road",
  Track_Surface_Kerb: "kerb",
  Track_Surface_Runoff: "runoff",
  Track_Surface_Gravel: "gravel",
  Track_Surface_Grass: "grass",
};
/** A physics face this close (m) above or below the drawn ground lies under it */
const UNDER_DRAWN_M = 1;
/** A cover this close (m) above or below a point covers the rule's ground there */
const COVER_M = 0.3;
/** Faces across the drawn edge are quartered until their longest side is under this (m) */
const PIECE_M = 0.25;
const CELL_M = 4;

/** A mesh's drawn material name: the material itself in the game, the name the Node loader keeps in scripts */
function materialName(mesh: THREE.Mesh): string {
  const m = mesh.material;
  const name = Array.isArray(m) ? "" : (m?.name ?? "");
  return name || ((mesh.userData.materialName as string | undefined) ?? "");
}

const isPhysics = (o: THREE.Object3D, root: THREE.Object3D): boolean => {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
    if (/^Track_(Collider|Surface)_/.test(p.name) || p.userData?.collider || p.userData?.hidden) return true;
  }
  return false;
};

/** A mesh of the road collider (`Track_Collider_Road`, itself or an ancestor) */
function isRoadCollider(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (p.name === "Track_Collider_Road" || p.userData?.collider === "road") return true;
  return false;
}

/**
 * The surface of the physics node a mesh belongs to (itself or the nearest named ancestor, or a node an earlier rule
 * made: a later rule may rename its pieces again), or null
 */
function nodeSurface(o: THREE.Object3D, root: THREE.Object3D): TrackSurfaceKind | null {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) {
    if (SURFACE_NODES[p.name]) return SURFACE_NODES[p.name];
    if (p.userData?.rule !== undefined && isTrackSurfaceKind(p.userData.surface)) return p.userData.surface;
  }
  return null;
}

/**
 * A strip of triangles (x, z of three corners each, 6 numbers a triangle) on an XZ grid: `contains(x, z)`, and
 * `touches(x0, z0, x1, z1)` when some triangle's box overlaps the box
 */
function stripRegion(strip: readonly number[]) {
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;
  for (let t = 0; t < strip.length / 6; t++) {
    const o = t * 6;
    const x0 = Math.floor(Math.min(strip[o], strip[o + 2], strip[o + 4]) / CELL_M), x1 = Math.floor(Math.max(strip[o], strip[o + 2], strip[o + 4]) / CELL_M);
    const z0 = Math.floor(Math.min(strip[o + 1], strip[o + 3], strip[o + 5]) / CELL_M), z1 = Math.floor(Math.max(strip[o + 1], strip[o + 3], strip[o + 5]) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) (grid.get(key(cx, cz)) ?? grid.set(key(cx, cz), []).get(key(cx, cz))!).push(t);
  }
  const contains = (x: number, z: number): boolean => {
    for (const t of grid.get(key(Math.floor(x / CELL_M), Math.floor(z / CELL_M))) ?? []) {
      const o = t * 6;
      const v0x = strip[o + 2] - strip[o], v0z = strip[o + 3] - strip[o + 1], v1x = strip[o + 4] - strip[o], v1z = strip[o + 5] - strip[o + 1];
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const px = x - strip[o], pz = z - strip[o + 1];
      const u = (px * v1z - v1x * pz) / den, v = (v0x * pz - px * v0z) / den;
      if (u >= 0 && v >= 0 && u + v <= 1) return true;
    }
    return false;
  };
  const touches = (x0: number, z0: number, x1: number, z1: number): boolean => {
    for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
      for (let cz = Math.floor(z0 / CELL_M); cz <= Math.floor(z1 / CELL_M); cz++) {
        for (const t of grid.get(key(cx, cz)) ?? []) {
          const o = t * 6;
          if (Math.max(strip[o], strip[o + 2], strip[o + 4]) < x0 || Math.min(strip[o], strip[o + 2], strip[o + 4]) > x1) continue;
          if (Math.max(strip[o + 1], strip[o + 3], strip[o + 5]) < z0 || Math.min(strip[o + 1], strip[o + 3], strip[o + 5]) > z1) continue;
          return true;
        }
      }
    }
    return false;
  };
  return { contains, touches };
}

/** The lap's road, each sample's track-data width, as a strip of triangles */
function lapRoadStrip(track: BuiltTrackData): number[] {
  const S = track.samples;
  const ends = S.map((q) => {
    const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
    const bx = q.binormal.x / bl, bz = q.binormal.z / bl, hw = q.width / 2;
    return [q.position.x - bx * hw, q.position.z - bz * hw, q.position.x + bx * hw, q.position.z + bz * hw];
  });
  const strip: number[] = [];
  for (let i = 0; i < S.length; i++) {
    const a = ends[i], b = ends[(i + 1) % S.length];
    strip.push(a[0], a[1], a[2], a[3], b[2], b[3], a[0], a[1], b[2], b[3], b[0], b[1]);
  }
  return strip;
}

/** The cell (m) of the grid an area's outline is filled on */
const AREA_CELL_M = 0.2;
interface AreaMask {
  x0: number;
  z0: number;
  w: number;
  h: number;
  bits: Uint8Array;
  /** Filled cells summed over [0, c) x [0, r), (w + 1) x (h + 1): a box's count in four reads */
  sums: Int32Array;
}
/** An outline (x, z pairs) filled on a grid of `AREA_CELL_M` cells, row by row (even-odd) */
function areaMask(outline: readonly number[]): AreaMask {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    x0 = Math.min(x0, outline[i]);
    x1 = Math.max(x1, outline[i]);
    z0 = Math.min(z0, outline[i + 1]);
    z1 = Math.max(z1, outline[i + 1]);
  }
  const w = Math.ceil((x1 - x0) / AREA_CELL_M) + 1, h = Math.ceil((z1 - z0) / AREA_CELL_M) + 1;
  const bits = new Uint8Array(w * h);
  const n = outline.length / 2;
  const xs: number[] = [];
  for (let r = 0; r < h; r++) {
    const z = z0 + (r + 0.5) * AREA_CELL_M;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const zi = outline[i * 2 + 1], zj = outline[j * 2 + 1];
      if (zi > z !== zj > z) xs.push(outline[i * 2] + ((z - zi) / (zj - zi)) * (outline[j * 2] - outline[i * 2]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / AREA_CELL_M - 0.5));
      for (let c = Math.max(0, Math.ceil((xs[k] - x0) / AREA_CELL_M - 0.5)); c <= c1; c++) bits[r * w + c] = 1;
    }
  }
  const sums = new Int32Array((w + 1) * (h + 1));
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) sums[(r + 1) * (w + 1) + c + 1] = bits[r * w + c] + sums[r * (w + 1) + c + 1] + sums[(r + 1) * (w + 1) + c] - sums[r * (w + 1) + c];
  }
  return { x0, z0, w, h, bits, sums };
}
const inMask = (m: AreaMask, x: number, z: number): boolean => {
  const c = Math.floor((x - m.x0) / AREA_CELL_M), r = Math.floor((z - m.z0) / AREA_CELL_M);
  return c >= 0 && r >= 0 && c < m.w && r < m.h && m.bits[r * m.w + c] === 1;
};
/** Some filled cell of the mask lies in the box x0..x1, z0..z1 */
const maskTouches = (m: AreaMask, x0: number, z0: number, x1: number, z1: number): boolean => {
  const c0 = Math.max(0, Math.floor((x0 - m.x0) / AREA_CELL_M)), c1 = Math.min(m.w - 1, Math.floor((x1 - m.x0) / AREA_CELL_M));
  const r0 = Math.max(0, Math.floor((z0 - m.z0) / AREA_CELL_M)), r1 = Math.min(m.h - 1, Math.floor((z1 - m.z0) / AREA_CELL_M));
  if (c0 > c1 || r0 > r1) return false;
  const W = m.w + 1;
  return m.sums[(r1 + 1) * W + c1 + 1] - m.sums[r0 * W + c1 + 1] - m.sums[(r1 + 1) * W + c0] + m.sums[r0 * W + c0] > 0;
};
const maskBox = (m: AreaMask): THREE.Box3 =>
  new THREE.Box3(new THREE.Vector3(m.x0, -1e4, m.z0), new THREE.Vector3(m.x0 + m.w * AREA_CELL_M, 1e4, m.z0 + m.h * AREA_CELL_M));

type V3 = THREE.Vector3;
/** Each triangle of a mesh in world space (its vertices moved once each) */
function forEachTri(mesh: THREE.Mesh, fn: (p: V3, q: V3, r: V3) => void): void {
  const g = mesh.geometry as THREE.BufferGeometry;
  const pos = g.getAttribute("position");
  if (!pos) return;
  const idx = g.getIndex();
  const n = idx ? idx.count : pos.count;
  const W = new Float64Array(pos.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    W[i * 3] = a.x;
    W[i * 3 + 1] = a.y;
    W[i * 3 + 2] = a.z;
  }
  for (let k = 0; k + 2 < n; k += 3) {
    const i0 = (idx ? idx.getX(k) : k) * 3, i1 = (idx ? idx.getX(k + 1) : k + 1) * 3, i2 = (idx ? idx.getX(k + 2) : k + 2) * 3;
    fn(a.set(W[i0], W[i0 + 1], W[i0 + 2]), b.set(W[i1], W[i1 + 1], W[i1 + 2]), c.set(W[i2], W[i2 + 1], W[i2 + 2]));
  }
}

/** The XZ box overlaps one of these (their heights aside) */
const overlapsXZ = (boxes: readonly THREE.Box3[], x0: number, z0: number, x1: number, z1: number): boolean =>
  boxes.some((b) => x1 >= b.min.x && x0 <= b.max.x && z1 >= b.min.z && z0 <= b.max.z);

/**
 * The upward faces of the drawn meshes with these materials, where `keep` takes their middle (and, given `boxes`, only
 * meshes and faces over one of them are read), on an XZ grid; `covers(x, y, z, dy)` = one of them lies over (x, z)
 * within `dy` of height y
 */
function drawnGround(root: THREE.Object3D, mats: ReadonlySet<string>, keep: (x: number, z: number) => boolean, boxes: readonly THREE.Box3[] | null = null) {
  const tris: number[] = [];
  const wb = new THREE.Box3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !mats.has(materialName(o)) || isPhysics(o, root)) return;
    if (boxes) {
      const g = o.geometry as THREE.BufferGeometry;
      if (!g.boundingBox) g.computeBoundingBox();
      wb.copy(g.boundingBox!).applyMatrix4(o.matrixWorld);
      if (!overlapsXZ(boxes, wb.min.x, wb.min.z, wb.max.x, wb.max.z)) return;
    }
    forEachTri(o, (p, q, r) => {
      if (boxes && !overlapsXZ(boxes, Math.min(p.x, q.x, r.x), Math.min(p.z, q.z, r.z), Math.max(p.x, q.x, r.x), Math.max(p.z, q.z, r.z))) return;
      const ny = (q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z);
      const len = Math.hypot((q.y - p.y) * (r.z - p.z) - (q.z - p.z) * (r.y - p.y), ny, (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      if (len < 1e-9 || Math.abs(ny) / len < 0.5) return;
      if (!keep((p.x + q.x + r.x) / 3, (p.z + q.z + r.z) / 3)) return;
      tris.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    });
  });
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;
  for (let t = 0; t < tris.length / 9; t++) {
    const o = t * 9;
    const x0 = Math.floor(Math.min(tris[o], tris[o + 3], tris[o + 6]) / CELL_M), x1 = Math.floor(Math.max(tris[o], tris[o + 3], tris[o + 6]) / CELL_M);
    const z0 = Math.floor(Math.min(tris[o + 2], tris[o + 5], tris[o + 8]) / CELL_M), z1 = Math.floor(Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) / CELL_M);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) (grid.get(key(cx, cz)) ?? grid.set(key(cx, cz), []).get(key(cx, cz))!).push(t);
  }
  const covers = (x: number, y: number, z: number, dy: number): boolean => {
    const list = grid.get(key(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (!list) return false;
    for (const t of list) {
      const o = t * 9;
      const v0x = tris[o + 3] - tris[o], v0z = tris[o + 5] - tris[o + 2], v1x = tris[o + 6] - tris[o], v1z = tris[o + 8] - tris[o + 2];
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const px = x - tris[o], pz = z - tris[o + 2];
      const u = (px * v1z - v1x * pz) / den, v = (v0x * pz - px * v0z) / den;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const h = tris[o + 1] + u * (tris[o + 4] - tris[o + 1]) + v * (tris[o + 7] - tris[o + 1]);
      if (Math.abs(h - y) <= dy) return true;
    }
    return false;
  };
  /** Some face's box overlaps the box x0..x1, z0..z1 at heights within y0..y1 (a cheap test before the exact ones) */
  const touches = (x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): boolean => {
    for (let cx = Math.floor(x0 / CELL_M); cx <= Math.floor(x1 / CELL_M); cx++) {
      for (let cz = Math.floor(z0 / CELL_M); cz <= Math.floor(z1 / CELL_M); cz++) {
        for (const t of grid.get(key(cx, cz)) ?? []) {
          const o = t * 9;
          if (Math.max(tris[o], tris[o + 3], tris[o + 6]) < x0 || Math.min(tris[o], tris[o + 3], tris[o + 6]) > x1) continue;
          if (Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) < z0 || Math.min(tris[o + 2], tris[o + 5], tris[o + 8]) > z1) continue;
          if (Math.max(tris[o + 1], tris[o + 4], tris[o + 7]) < y0 || Math.min(tris[o + 1], tris[o + 4], tris[o + 7]) > y1) continue;
          return true;
        }
      }
    }
    return false;
  };
  return { tris, covers, touches };
}

/** How far (m) past each end of a kerb its outer edge is carried over to the barrier */
const KERB_BRIDGE_M = 20;

/**
 * One side's limit per lap sample (0 = none, the barrier): the kerb's outer edge where there is a kerb, and from each
 * end of a kerb a line over `KERB_BRIDGE_M` to the barrier there, so where the barrier opens out beside a corner (an
 * escape road, a car park) the limit runs from the kerb to the barrier instead of out to the opening
 */
function kerbLimits(edge: Float64Array, wall: (i: number) => number, track: BuiltTrackData): Float64Array {
  const n = edge.length;
  const D = Math.max(1, Math.round((KERB_BRIDGE_M / track.totalLengthM) * n));
  const out = Float64Array.from(edge);
  for (let i = 0; i < n; i++) {
    if (!(edge[i] > 0)) continue;
    for (const dir of [-1, 1]) {
      if (edge[(i + dir + n) % n] > 0) continue;
      const far = wall((((i + dir * D) % n) + n) % n);
      for (let k = 1; k <= D; k++) {
        const j = (((i + dir * k) % n) + n) % n;
        if (edge[j] > 0) break;
        const v = edge[i] + (far - edge[i]) * (k / D);
        out[j] = out[j] > 0 ? Math.min(out[j], v) : v;
      }
    }
  }
  return out;
}

/**
 * The outer edge of the lap's physics kerb (`Track_Surface_Kerb`) on each side, per lap sample (m from the centre line;
 * 0 where the side has none): each kerb face marks every sample its lap span covers with its outermost corner
 */
export function kerbOuterEdges(root: THREE.Object3D, track: BuiltTrackData): { left: Float64Array; right: Float64Array } {
  const S = track.samples;
  const n = S.length;
  const L = track.totalLengthM;
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  // The nearest sample of a point from a coarse grid of the samples, as the projection's hint
  const CELL = 25;
  const sgrid = new Map<number, number[]>();
  const skey = (cx: number, cz: number) => cx * 73856093 + cz * 19349663;
  S.forEach((q, i) => {
    const k = skey(Math.floor(q.position.x / CELL), Math.floor(q.position.z / CELL));
    (sgrid.get(k) ?? sgrid.set(k, []).get(k)!).push(i);
  });
  const hintAt = (x: number, z: number): number | undefined => {
    let best = Infinity, bi = -1;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of sgrid.get(skey(cx + dx, cz + dz)) ?? []) {
        const d = (S[i].position.x - x) ** 2 + (S[i].position.z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
    }
    return bi >= 0 ? S[bi].s : undefined;
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name !== "Track_Surface_Kerb") return;
    const g = o.geometry as THREE.BufferGeometry;
    const posAttr = g.getAttribute("position");
    if (!posAttr) return;
    const idx = g.getIndex();
    // Each vertex placed on the lap once (s, lateral offset)
    const v = new THREE.Vector3();
    const P = Array.from({ length: posAttr.count }, (_, i) => {
      v.fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
      const p = track.projectWorldToTrack(v.x, v.z, hintAt(v.x, v.z));
      return { s: p.s, lateralOffset: p.lateralOffset };
    });
    for (let k = 0; k + 2 < (idx ? idx.count : posAttr.count); k += 3) {
      const pr = [0, 1, 2].map((j) => P[idx ? idx.getX(k + j) : k + j]);
      const side = pr[0].lateralOffset + pr[1].lateralOffset + pr[2].lateralOffset >= 0 ? 1 : -1;
      const out = Math.max(...pr.map((p) => Math.abs(p.lateralOffset)));
      // The face's span along the lap (the shorter way round), every sample in it
      let s0 = pr[0].s, s1 = pr[0].s;
      for (const p of pr.slice(1)) {
        const d = ((((p.s - pr[0].s) % L) + L * 1.5) % L) - L / 2;
        s0 = Math.min(s0, pr[0].s + d);
        s1 = Math.max(s1, pr[0].s + d);
      }
      if (s1 - s0 > 50) continue;
      const edge = side > 0 ? right : left;
      for (let i = Math.floor((s0 / L) * n); i <= Math.ceil((s1 / L) * n); i++) {
        const j = ((i % n) + n) % n;
        edge[j] = Math.max(edge[j], out);
      }
    }
  });
  return { left, right };
}

/**
 * Applies a circuit's rules to its fitted physics surfaces (TrackColliderQuery.fromTrackRoot's `prepare`). Returns the
 * area renamed (m², per surface); nothing changes on a circuit without rules.
 */
export function applyDrawnSurfaceRules(
  root: THREE.Object3D,
  track: BuiltTrackData,
  roadMaterials: readonly string[] = [],
  rules = DRAWN_SURFACE_RULES[track.id ?? ""],
  table?: SurfaceTable
): Record<string, number> {
  const done: Record<string, number> = {};
  if (!rules?.length) return done;
  root.updateMatrixWorld(true);
  // (the physics kerbs' outer edges, read once, when the first rule that stops at them runs)
  let kerbEdges: ReturnType<typeof kerbOuterEdges> | null = null;
  let roadBand: ReturnType<typeof stripRegion> | null = null;
  for (const rule of rules) {
    const from = rule.from ? new Set(rule.from) : null;
    const within = rule.within;
    const barriers = within === "barriers";
    const stretches = !barriers && "stretches" in within ? within.stretches : null;
    const bands = !barriers && "bands" in within ? within.bands : null;
    const areas = !barriers && "areas" in within ? within.areas.map(areaMask) : null;
    const except = !barriers && "areas" in within ? (within.except ?? []).map(areaMask) : [];
    const lapLen = (s0: number, s1: number) => (((s1 - s0) % track.totalLengthM) + track.totalLengthM) % track.totalLengthM;

    // Where the rule applies: within its stretches (judged once per drawn face, by its middle), or within its bands,
    // its areas or between the barriers (judged per point, from a strip of the lap or the areas' grids)
    const stretchBoxes = areas
      ? areas.map(maskBox)
      : (stretches ?? bands ?? []).map(([s0, s1]) => {
          const bx = new THREE.Box3();
          for (let d = 0; d <= lapLen(s0, s1); d += 5) bx.expandByPoint(track.getSampleAtDistance(s0 + d).position);
          return bx.expandByScalar(40);
        });
    const inStretch = (x: number, z: number): boolean => {
      if (barriers) return true;
      const k = stretchBoxes.findIndex((bx) => x >= bx.min.x && x <= bx.max.x && z >= bx.min.z && z <= bx.max.z);
      if (k < 0 || !stretches) return k >= 0;
      // (the stretch's middle as the projection's hint: a search along the lap from there, not round all of it)
      const [s0, s1] = stretches[k];
      const p = track.projectWorldToTrack(x, z, s0 + lapLen(s0, s1) / 2);
      const side = p.lateralOffset >= 0 ? 1 : -1;
      return stretches.some(([s0, s1, sd]) => sd === side && (s0 <= s1 ? p.s >= s0 && p.s <= s1 : p.s >= s0 || p.s <= s1));
    };
    // Between the barriers: the strip from each sample's left barrier to its right one; a band: its side's strip from
    // `near` to `far` along its stretch, a metre at a time. As triangles on an XZ grid
    const strip: number[] = [];
    for (const [s0, s1, side, near, far] of bands ?? []) {
      let prev: number[] | null = null;
      const len = lapLen(s0, s1);
      for (let k = 0; k <= Math.ceil(len); k++) {
        const q = track.getSampleAtDistance(s0 + Math.min(k, len));
        const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
        const bx = (side * q.binormal.x) / bl, bz = (side * q.binormal.z) / bl;
        const e = [q.position.x + bx * near, q.position.z + bz * near, q.position.x + bx * far, q.position.z + bz * far];
        if (prev) strip.push(prev[0], prev[1], prev[2], prev[3], e[2], e[3], prev[0], prev[1], e[2], e[3], e[0], e[1]);
        prev = e;
      }
    }
    if (barriers) {
      const S = track.samples;
      const wallL = (i: number) => S[i].wallLeftM ?? S[i].width / 2;
      const wallR = (i: number) => S[i].wallRightM ?? S[i].width / 2;
      const kerb = rule.kerbsLimit ? (kerbEdges ??= kerbOuterEdges(root, track)) : null;
      const limL = kerb ? kerbLimits(kerb.left, wallL, track) : null;
      const limR = kerb ? kerbLimits(kerb.right, wallR, track) : null;
      const ends = S.map((q, i) => {
        const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
        const bx = q.binormal.x / bl, bz = q.binormal.z / bl;
        let wl = wallL(i), wr = wallR(i);
        if (limL && limL[i] > 0) wl = Math.min(wl, limL[i]);
        if (limR && limR[i] > 0) wr = Math.min(wr, limR[i]);
        return [q.position.x - bx * wl, q.position.z - bz * wl, q.position.x + bx * wr, q.position.z + bz * wr];
      });
      for (let i = 0; i < S.length; i++) {
        const a = ends[i], b = ends[(i + 1) % S.length];
        strip.push(a[0], a[1], a[2], a[3], b[2], b[3], a[0], a[1], b[2], b[3], b[0], b[1]);
      }
    }
    // The rule's region, judged per point: the strip, or its areas less the areas excepted (and, with `offTheRoad`, less
    // the circuit's road drawn within the lap's road)
    const road = rule.offTheRoad ? (roadBand ??= stripRegion(lapRoadStrip(track))) : null;
    const roadDrawn = road && areas ? drawnGround(root, new Set(roadMaterials), () => true, stretchBoxes) : null;
    const onRoad = (x: number, y: number, z: number): boolean => !!road && road.contains(x, z) && (roadDrawn?.covers(x, y, z, UNDER_DRAWN_M) ?? true);
    const strips = strip.length ? stripRegion(strip) : null;
    const region = strips
      ? { contains: (x: number, _y: number, z: number) => strips.contains(x, z), touches: strips.touches }
      : areas
        ? {
            contains: (x: number, y: number, z: number) =>
              areas.some((m) => inMask(m, x, z)) && !except.some((m) => inMask(m, x, z)) && !onRoad(x, y, z),
            touches: (x0: number, z0: number, x1: number, z1: number) => areas.some((m) => maskTouches(m, x0, z0, x1, z1)),
          }
        : null;

    // The drawn ground of the rule's materials (upward faces) within where it applies, and its covers near it
    const drawn = rule.materials === null ? null : drawnGround(root, new Set(rule.materials === "roadMaterials" ? roadMaterials : rule.materials), inStretch, barriers ? null : stretchBoxes);
    if (drawn ? !drawn.tris.length : !region) continue;
    const covers = rule.covers?.length ? drawnGround(root, new Set(rule.covers), () => true) : null;
    const underDrawn = (x: number, y: number, z: number): boolean =>
      (drawn ? drawn.covers(x, y, z, UNDER_DRAWN_M) : true) && !(covers?.covers(x, y, z, COVER_M) ?? false);
    /**
     * The face's box overlaps some drawn face's box (and the region's, where the rule has one): it may hold drawn ground
     * no vote point lands on
     */
    const touchesFace = (f: number[][]): boolean => {
      const x0 = Math.min(f[0][0], f[1][0], f[2][0]), x1 = Math.max(f[0][0], f[1][0], f[2][0]);
      const z0 = Math.min(f[0][2], f[1][2], f[2][2]), z1 = Math.max(f[0][2], f[1][2], f[2][2]);
      if (region && !region.touches(x0, z0, x1, z1)) return false;
      return !drawn || drawn.touches(x0, z0, x1, z1, Math.min(f[0][1], f[1][1], f[2][1]) - UNDER_DRAWN_M, Math.max(f[0][1], f[1][1], f[2][1]) + UNDER_DRAWN_M);
    };

    // Split each physics face by where the rule applies: its middle, corners and side middles (a tenth of the way in)
    // vote; a face they don't agree on is quartered until its pieces are under PIECE_M, then its middle decides
    type Corner = number[]; // x, y, z, u, v
    const mid = (p: Corner, q: Corner): Corner => p.map((v, k) => (v + q[k]) / 2);
    const longest = (f: Corner[]) => Math.max(...[0, 1, 2].map((k) => Math.hypot(f[(k + 1) % 3][0] - f[k][0], f[(k + 1) % 3][2] - f[k][2])));
    const areaXZ = (f: Corner[]) => Math.abs((f[1][0] - f[0][0]) * (f[2][2] - f[0][2]) - (f[2][0] - f[0][0]) * (f[1][2] - f[0][2])) / 2;
    // The footprint (drawn ground, or the strip or areas at any height)
    const box = new THREE.Box3();
    if (drawn) for (let i = 0; i < drawn.tris.length; i += 3) box.expandByPoint(new THREE.Vector3(drawn.tris[i], drawn.tris[i + 1], drawn.tris[i + 2]));
    else if (areas) for (const bx of stretchBoxes) box.union(bx);
    else for (let i = 0; i < strip.length; i += 2) box.expandByPoint(new THREE.Vector3(strip[i], 0, strip[i + 1])).expandByPoint(new THREE.Vector3(strip[i], 1e4, strip[i + 1])).expandByPoint(new THREE.Vector3(strip[i], -1e4, strip[i + 1]));
    box.expandByScalar(UNDER_DRAWN_M);

    /** The renamed pieces, by the surface they were */
    const moved = new Map<TrackSurfaceKind, number[]>();
    const inside = (x: number, y: number, z: number) => (!region || region.contains(x, y, z)) && underDrawn(x, y, z);
    /** 1: all seven vote points inside, 0: none, -1: they differ (a last piece: its middle alone, 1 or 0) */
    const vote = (g: Corner[], last: boolean): 1 | 0 | -1 => {
      const mx = (g[0][0] + g[1][0] + g[2][0]) / 3, my = (g[0][1] + g[1][1] + g[2][1]) / 3, mz = (g[0][2] + g[1][2] + g[2][2]) / 3;
      const middle = inside(mx, my, mz);
      if (last) return middle ? 1 : 0;
      for (let k = 0; k < 3; k++) {
        const a = g[k], b = g[(k + 1) % 3];
        if (inside(a[0] + 0.1 * (mx - a[0]), a[1] + 0.1 * (my - a[1]), a[2] + 0.1 * (mz - a[2])) !== middle) return -1;
        const sx = (a[0] + b[0]) / 2, sy = (a[1] + b[1]) / 2, sz = (a[2] + b[2]) / 2;
        if (inside(sx + 0.1 * (mx - sx), sy + 0.1 * (my - sy), sz + 0.1 * (mz - sz)) !== middle) return -1;
      }
      return middle ? 1 : 0;
    };
    // The physics surfaces the rule renames, and the road collider it lays its surface over (copies: `copy`)
    const targets: { mesh: THREE.Mesh; fromKind: TrackSurfaceKind; copy: boolean }[] = [];
    const roadCopy = rule.overRoadCollider === true && rule.surface !== "road" && (!from || from.has("road"));
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const kind = nodeSurface(o, root);
      if (kind && kind !== rule.surface && (!from || from.has(kind))) targets.push({ mesh: o, fromKind: kind, copy: false });
      else if (!kind && roadCopy && isRoadCollider(o, root)) targets.push({ mesh: o, fromKind: "road", copy: true });
    });
    for (const { mesh, fromKind, copy } of targets) {
      const out = moved.get(fromKind) ?? moved.set(fromKind, []).get(fromKind)!;
      const geom = mesh.geometry as THREE.BufferGeometry;
      const pos = geom.getAttribute("position");
      if (!pos) continue;
      const idx = geom.getIndex();
      const uv = geom.getAttribute("uv");
      const nTri = Math.floor((idx ? idx.count : pos.count) / 3);
      // The drawn footprint's box in the mesh's own space: faces clear of it are kept without reading them further
      const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const lbox = box.clone().applyMatrix4(toLocal);
      const v = new THREE.Vector3();
      const W = new Float64Array(pos.count * 3);
      const done3 = new Uint8Array(pos.count);
      const world = (i: number) => {
        if (!done3[i]) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          W[i * 3] = v.x;
          W[i * 3 + 1] = v.y;
          W[i * 3 + 2] = v.z;
          done3[i] = 1;
        }
        return i * 3;
      };
      const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
      /** The face's box (in the mesh's space) is clear of the footprint's (a face wider than it may have no corner in it) */
      const clear = (i0: number, i1: number, i2: number) =>
        Math.max(pos.getX(i0), pos.getX(i1), pos.getX(i2)) < lbox.min.x ||
        Math.min(pos.getX(i0), pos.getX(i1), pos.getX(i2)) > lbox.max.x ||
        Math.max(pos.getZ(i0), pos.getZ(i1), pos.getZ(i2)) < lbox.min.z ||
        Math.min(pos.getZ(i0), pos.getZ(i1), pos.getZ(i2)) > lbox.max.z;
      // Faces near the drawn ground (their box overlapping a drawn face's box); the rest stay as they are
      const near = new Uint8Array(nTri);
      let any = false;
      for (let t = 0; t < nTri; t++) {
        if (clear(vi(t, 0), vi(t, 1), vi(t, 2))) continue;
        const a = world(vi(t, 0)), b = world(vi(t, 1)), c = world(vi(t, 2));
        if (touchesFace([[W[a], W[a + 1], W[a + 2]], [W[b], W[b + 1], W[b + 2]], [W[c], W[c + 1], W[c + 2]]])) {
          near[t] = 1;
          any = true;
        }
      }
      if (!any) continue;
      const corner = (i: number): Corner => {
        const o = world(i);
        return [W[o], W[o + 1], W[o + 2], uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0];
      };
      // The pieces kept of the faces near it (the faces clear of it are kept as they are, by number)
      const kept: Corner[][] = [];
      const keptFaces: number[] = [];
      let changed = false;
      for (let t = 0; t < nTri; t++) {
        if (!near[t]) {
          keptFaces.push(t);
          continue;
        }
        let todo: Corner[][] = [[corner(vi(t, 0)), corner(vi(t, 1)), corner(vi(t, 2))]];
        for (let depth = 0; depth <= 12 && todo.length; depth++) {
          const next: Corner[][] = [];
          for (const g of todo) {
            const last = depth === 12 || longest(g) < (rule.pieceM ?? PIECE_M);
            const vt = vote(g, last);
            // (a face its votes miss may still hold a narrow drawn strip: split it while it touches one)
            if (vt === 0 && (last || !touchesFace(g))) kept.push(g);
            else if (vt === 1) {
              for (const c of g) out.push(c[0], c[1], c[2]);
              done[rule.surface] = (done[rule.surface] ?? 0) + areaXZ(g);
              changed = true;
            } else {
              const ab = mid(g[0], g[1]), bc = mid(g[1], g[2]), ca = mid(g[2], g[0]);
              next.push([g[0], ab, ca], [ab, g[1], bc], [ca, bc, g[2]], [ab, bc, ca]);
            }
          }
          todo = next;
        }
      }
      // (the road collider keeps every face: the pieces were copied)
      if (!changed || copy) continue;
      // Rebuilt unindexed in the mesh's own space, keeping its texture coordinates (the kerb ripple reads them)
      const nf = keptFaces.length;
      const keptPos = new Float32Array((nf + kept.length) * 9);
      const uvs = uv ? new Float32Array((nf + kept.length) * 6) : null;
      keptFaces.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const j = vi(t, k);
          keptPos[i * 9 + k * 3] = pos.getX(j);
          keptPos[i * 9 + k * 3 + 1] = pos.getY(j);
          keptPos[i * 9 + k * 3 + 2] = pos.getZ(j);
          if (uvs && uv) {
            uvs[i * 6 + k * 2] = uv.getX(j);
            uvs[i * 6 + k * 2 + 1] = uv.getY(j);
          }
        }
      });
      kept.forEach((f, i) => f.forEach((p, k) => {
        v.set(p[0], p[1], p[2]).applyMatrix4(toLocal);
        keptPos[(nf + i) * 9 + k * 3] = v.x;
        keptPos[(nf + i) * 9 + k * 3 + 1] = v.y;
        keptPos[(nf + i) * 9 + k * 3 + 2] = v.z;
        if (uvs) {
          uvs[(nf + i) * 6 + k * 2] = p[3];
          uvs[(nf + i) * 6 + k * 2 + 1] = p[4];
        }
      }));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(keptPos, 3));
      if (uvs) g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      mesh.geometry = g;
    }
    for (const [fromKind, pieces] of moved) {
      if (!pieces.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pieces), 3));
      const node = new THREE.Mesh(g);
      const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
      node.name = `Track_Surface_${cap(rule.surface)}_Drawn_From_${cap(fromKind)}`;
      node.userData = { surface: rule.surface, hidden: true, rule: rule.note };
      // A raised kerb renamed keeps the most it may stand over the ground under it (the circuit's kerb `maxRiseM`)
      const rise = table?.[fromKind]?.maxRiseM;
      if (rise !== undefined && Number.isFinite(rise)) node.userData.maxRiseM = rise;
      root.add(node);
      root.updateMatrixWorld(true);
    }
  }
  return done;
}
