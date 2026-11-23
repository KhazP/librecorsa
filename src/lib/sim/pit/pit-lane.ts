/**
 * A circuit's pit lane, read from its track data's `pitLane` and placed against the lap.
 *
 * The stored lane is the Assetto Corsa pit spline (`pit_lane.ai`) the porter keeps, or the circuit's own: it starts and
 * ends on the racing surface (AC's spline carries 65-680 m of road before the lane leaves it, and as much after it
 * rejoins), so where the lane is really a lane is worked out here: the longest stretch of it more than
 * `OFF_ROAD_M` past the road edge (`leaveM`..`rejoinM` along the lane). Track data written by
 * `scripts/tracks/export_pit_lanes.py` (v2) carries the full-resolution lane, those two points and the real pit boxes
 * (AC_PIT_n); older track data has the porter's ~80-point copy, and the boxes are laid out along the lane.
 *
 * A car is in the pit lane only off the racing surface (a car on the road is on the track, however close the lane runs),
 * within the corridor of the lane between its leave and rejoin points. There its lap position is the lane's own
 * (`trackSAt`): monotonic along the lane, so a lane that skips a corner neither jumps the lap clock nor reads as a cut.
 *
 * No pit lane: hill climbs, a layout whose lane is a stub or runs back on itself (Dunsfold's teardrop, Spielberg's inner
 * loop), and `pitLane.none` in the data.
 *
 * Pure, no three.js: the simulation worker builds the same model from the same track data.
 */
import type { BuiltTrackData } from "@/lib/track-data";

/** The `pitLane` object in track_data.json: the porter's fields, and the export script's (v2) */
export interface PitLaneData {
  entryS?: number;
  exitS?: number;
  widthM?: number;
  centerline?: number[][];
  /** Export script version (2): the fields below are set */
  v?: number;
  /** Along the centreline (m): where the lane leaves the road and where it rejoins it */
  leaveM?: number;
  rejoinM?: number;
  /** Speed-limit zone along the centreline (m) */
  limitStartM?: number;
  limitEndM?: number;
  /** Pit boxes in garage order: x, y, z, heading (rad, atan2(dx, dz) of the car's nose) */
  boxes?: number[][];
  /** Pit lane speed limit (km/h) */
  limitKmh?: number;
  /** The layout has no pit lane */
  none?: boolean;
}

export interface PitBox {
  index: number;
  x: number;
  y: number;
  z: number;
  /** Heading of a car parked in it: atan2(dx, dz) of its nose */
  yawRad: number;
  /** Along the lane (m) */
  laneM: number;
  /** Signed offset from the lane's centreline (m, + right of the lane's direction) */
  offsetM: number;
}

export interface PitLaneSpot {
  /** Along the lane (m) */
  laneM: number;
  /** Signed offset from the centreline (m, + right of the lane's direction) */
  offsetM: number;
  /** Lap position (m, wrapped to the lap) */
  trackS: number;
  /** Inside the speed-limit zone */
  inLimitZone: boolean;
}

export interface PitLanePoint {
  x: number;
  y: number;
  z: number;
  /** Unit direction of the lane (x/z) */
  tx: number;
  tz: number;
}

/** The lane counts from this far past the road edge (m) */
const OFF_ROAD_M = 2;
/** Shorter than this off the road is no pit lane (m): Dunsfold's 50 m teardrop (VIR Patriot's lane is 131 m) */
const MIN_LANE_M = 100;
/** Spacing the lane is resampled to before it is measured (m) */
const STEP_M = 2;
/** A car off the road counts as in the lane this far either side of the leave and rejoin points (m) */
const END_SLACK_M = 25;
/** The speed-limit zone starts this far into the lane and ends this far before its end (m), without data of its own */
const LIMIT_INSET_M = 15;
/** Default pit lane speed limit (km/h) */
export const PIT_LIMIT_KMH_DEFAULT = 60;
/** Boxes laid out along the lane when the data has none: spacing and offset to the garage side (m) */
const BOX_SPACING_M = 9;
const BOX_OFFSET_M = 3.2;
/** Clear lane kept between the zone ends and the first and last boxes (m) */
const BOX_MARGIN_M = 30;

export class PitLaneModel {
  /** x, y, z per point, resampled to `STEP_M` (read-only outside: the verify script and the box visual) */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Distance along the lane at each point (m) */
  readonly cum: Float64Array;
  /** Lap position at each point, unwrapped from the leave point (m) */
  private readonly lapS: Float64Array;
  private readonly n: number;
  readonly lengthM: number;
  readonly leaveM: number;
  readonly rejoinM: number;
  readonly limitStartM: number;
  readonly limitEndM: number;
  readonly limitKmh: number;
  readonly boxes: readonly PitBox[];
  /** Half-width of the corridor a car is in the lane within (m) */
  readonly corridorM: number;
  /** Lap positions (wrapped) where the lane leaves the road and where it rejoins it */
  readonly leaveTrackS: number;
  readonly rejoinTrackS: number;
  /** +1 when the lane lies right of the track (its garages further right), -1 left */
  readonly side: 1 | -1;
  /** Real pit boxes from the data (else laid out here) */
  readonly realBoxes: boolean;
  private readonly trackLen: number;

  private constructor(args: {
    px: Float64Array;
    py: Float64Array;
    pz: Float64Array;
    cum: Float64Array;
    lapS: Float64Array;
    leaveM: number;
    rejoinM: number;
    limitStartM: number;
    limitEndM: number;
    limitKmh: number;
    boxes: PitBox[];
    side: 1 | -1;
    realBoxes: boolean;
    trackLen: number;
  }) {
    this.px = args.px;
    this.py = args.py;
    this.pz = args.pz;
    this.cum = args.cum;
    this.lapS = args.lapS;
    this.n = args.px.length;
    this.lengthM = args.cum[args.cum.length - 1];
    this.leaveM = args.leaveM;
    this.rejoinM = args.rejoinM;
    this.limitStartM = args.limitStartM;
    this.limitEndM = args.limitEndM;
    this.limitKmh = args.limitKmh;
    this.boxes = args.boxes;
    this.side = args.side;
    this.realBoxes = args.realBoxes;
    this.trackLen = args.trackLen;
    const maxBox = args.boxes.reduce((m, b) => Math.max(m, Math.abs(b.offsetM)), 0);
    this.corridorM = Math.max(5, maxBox + 2.5);
    this.leaveTrackS = this.trackSAt(args.leaveM);
    this.rejoinTrackS = this.trackSAt(args.rejoinM);
  }

  /**
   * The model of a circuit's lane, or null where there is none. `track` is the built lap (its samples and projection);
   * `pitboxes` the circuit's box count (metadata) for a lane laid out here
   */
  static build(data: PitLaneData | null | undefined, track: BuiltTrackData, pitboxes?: number): PitLaneModel | null {
    if (!data || data.none || track.pointToPoint) return null;
    const raw = (data.centerline ?? []).filter((p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite));
    if (raw.length < 6) return null;
    const L = track.totalLengthM;
    // Resample to STEP_M so the off-road test and the projections are even along the lane
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    xs.push(raw[0][0]);
    ys.push(raw[0][1]);
    zs.push(raw[0][2]);
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1];
      const b = raw[i];
      const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (d < 1e-6) continue;
      const k = Math.max(1, Math.ceil(d / STEP_M));
      for (let j = 1; j <= k; j++) {
        const t = j / k;
        xs.push(a[0] + (b[0] - a[0]) * t);
        ys.push(a[1] + (b[1] - a[1]) * t);
        zs.push(a[2] + (b[2] - a[2]) * t);
      }
    }
    const n = xs.length;
    if (n < 6) return null;
    const px = Float64Array.from(xs);
    const py = Float64Array.from(ys);
    const pz = Float64Array.from(zs);
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], pz[i] - pz[i - 1]);
    // Each point against the lap: its position and how far past the road edge it is
    const projS = new Float64Array(n);
    const past = new Float64Array(n);
    const lat = new Float64Array(n);
    let hintS: number | undefined = data.entryS;
    for (let i = 0; i < n; i++) {
      const p = track.projectWorldToTrack(px[i], pz[i], hintS);
      projS[i] = p.s;
      lat[i] = p.lateralOffset;
      past[i] = Math.abs(p.lateralOffset) - p.sample.width / 2;
      hintS = p.s;
    }
    let leaveM: number;
    let rejoinM: number;
    if (data.v === 2 && Number.isFinite(data.leaveM) && Number.isFinite(data.rejoinM)) {
      leaveM = Math.max(0, data.leaveM!);
      rejoinM = Math.min(cum[n - 1], data.rejoinM!);
    } else {
      // The longest run of points past the edge
      let bestA = -1;
      let bestB = -1;
      let a = -1;
      for (let i = 0; i <= n; i++) {
        const off = i < n && past[i] > OFF_ROAD_M;
        if (off && a < 0) a = i;
        if (!off && a >= 0) {
          if (bestA < 0 || cum[i - 1] - cum[a] > cum[bestB] - cum[bestA]) {
            bestA = a;
            bestB = i - 1;
          }
          a = -1;
        }
      }
      if (bestA < 0) return null;
      leaveM = cum[bestA];
      rejoinM = cum[bestB];
    }
    if (rejoinM - leaveM < MIN_LANE_M) return null;
    // The lane has to go the way the lap does: from where it leaves the road it rejoins further round, by less than half
    // a lap (Spielberg's inner loop rejoins behind where it left)
    const iLeave = indexAt(cum, leaveM);
    const iRejoin = indexAt(cum, rejoinM);
    const ahead = wrapPos(projS[iRejoin] - projS[iLeave], L);
    if (ahead <= 0 || ahead > L * 0.5) return null;
    // Lap position along the lane: the projections, unwrapped from the leave point and never going back. Before the
    // leave point and after the rejoin point the lane is on the road and the projection is the car's own
    const lapS = new Float64Array(n);
    let prev = projS[iLeave];
    for (let i = iLeave; i < n; i++) {
      let s = projS[i];
      while (s < prev - L * 0.5) s += L;
      while (s > prev + L * 0.5) s -= L;
      if (s < prev) s = prev;
      lapS[i] = s;
      prev = s;
    }
    prev = projS[iLeave];
    for (let i = iLeave - 1; i >= 0; i--) {
      let s = projS[i];
      while (s < prev - L * 0.5) s += L;
      while (s > prev + L * 0.5) s -= L;
      if (s > prev) s = prev;
      lapS[i] = s;
      prev = s;
    }
    // Across the off-road stretch the lap position runs evenly from leave to rejoin (it is the lane that is driven, not
    // the road beside it: a lane that bends away from the road would otherwise stall or rush the lap clock)
    const sLeave = lapS[iLeave];
    const sRejoin = lapS[iRejoin];
    for (let i = iLeave; i <= iRejoin; i++) {
      const t = (cum[i] - cum[iLeave]) / Math.max(1e-6, cum[iRejoin] - cum[iLeave]);
      lapS[i] = sLeave + (sRejoin - sLeave) * t;
    }
    // The side the lane lies (and its garages): where most of its off-road points are
    let sideSum = 0;
    for (let i = iLeave; i <= iRejoin; i++) sideSum += Math.sign(lat[i]);
    const side: 1 | -1 = sideSum >= 0 ? 1 : -1;
    const limitStartM =
      data.v === 2 && Number.isFinite(data.limitStartM) ? Math.max(leaveM, data.limitStartM!) : leaveM + LIMIT_INSET_M;
    const limitEndM =
      data.v === 2 && Number.isFinite(data.limitEndM) ? Math.min(rejoinM, data.limitEndM!) : rejoinM - LIMIT_INSET_M;
    const limitKmh =
      Number.isFinite(data.limitKmh) && data.limitKmh! >= 30 && data.limitKmh! <= 120 ? data.limitKmh! : PIT_LIMIT_KMH_DEFAULT;
    const shape = { px, py, pz, cum, n };
    let boxes: PitBox[] = [];
    const realBoxes = Array.isArray(data.boxes) && data.boxes.length > 0;
    if (realBoxes) {
      for (const b of data.boxes!) {
        if (!Array.isArray(b) || b.length < 4 || !b.every(Number.isFinite)) continue;
        const pr = projectPolyline(shape, b[0], b[2], 0, n - 1);
        if (pr.laneM < limitStartM || pr.laneM > limitEndM) continue;
        boxes.push({ index: 0, x: b[0], y: b[1], z: b[2], yawRad: b[3], laneM: pr.laneM, offsetM: pr.offsetM });
      }
      boxes.sort((a, b) => a.laneM - b.laneM);
    }
    if (boxes.length < 4) {
      boxes = layOutBoxes(shape, limitStartM, limitEndM, side, pitboxes);
    }
    boxes.forEach((b, i) => (b.index = i));
    return new PitLaneModel({
      px,
      py,
      pz,
      cum,
      lapS,
      leaveM,
      rejoinM,
      limitStartM,
      limitEndM,
      limitKmh,
      boxes,
      side,
      realBoxes: realBoxes && boxes.length >= 4,
      trackLen: L,
    });
  }

  /** Lap position (wrapped) at `laneM` along the lane */
  trackSAt(laneM: number): number {
    const i = indexAt(this.cum, laneM);
    const j = Math.min(this.n - 1, i + 1);
    const span = this.cum[j] - this.cum[i];
    const t = span > 1e-6 ? (laneM - this.cum[i]) / span : 0;
    const s = this.lapS[i] + (this.lapS[j] - this.lapS[i]) * Math.max(0, Math.min(1, t));
    return wrapPos(s, this.trackLen);
  }

  /** The lane's centreline and direction at `laneM` */
  pointAt(laneM: number, out: PitLanePoint = { x: 0, y: 0, z: 0, tx: 0, tz: 1 }): PitLanePoint {
    const m = Math.max(0, Math.min(this.lengthM, laneM));
    const i = Math.min(this.n - 2, indexAt(this.cum, m));
    const j = i + 1;
    const span = this.cum[j] - this.cum[i];
    const t = span > 1e-6 ? (m - this.cum[i]) / span : 0;
    out.x = this.px[i] + (this.px[j] - this.px[i]) * t;
    out.y = this.py[i] + (this.py[j] - this.py[i]) * t;
    out.z = this.pz[i] + (this.pz[j] - this.pz[i]) * t;
    const dx = this.px[j] - this.px[i];
    const dz = this.pz[j] - this.pz[i];
    const d = Math.hypot(dx, dz) || 1;
    out.tx = dx / d;
    out.tz = dz / d;
    return out;
  }

  /**
   * Where a car is in the lane, or null when it is not: on the road (`offRoadM` = how far past the road edge it is,
   * negative on the road), outside the lane's corridor, or before the leave / past the rejoin point
   */
  locate(x: number, z: number, offRoadM: number): PitLaneSpot | null {
    if (offRoadM < 0.5) return null;
    const lo = indexAt(this.cum, Math.max(0, this.leaveM - END_SLACK_M - 60));
    const hi = indexAt(this.cum, Math.min(this.lengthM, this.rejoinM + END_SLACK_M + 60)) + 1;
    const pr = projectPolyline(this, x, z, lo, Math.min(this.n - 1, hi));
    if (Math.abs(pr.offsetM) > this.corridorM || pr.distM > this.corridorM) return null;
    if (pr.laneM < this.leaveM - END_SLACK_M || pr.laneM > this.rejoinM + END_SLACK_M) return null;
    return {
      laneM: pr.laneM,
      offsetM: pr.offsetM,
      trackS: this.trackSAt(pr.laneM),
      inLimitZone: pr.laneM >= this.limitStartM && pr.laneM <= this.limitEndM,
    };
  }

  /** Whether the lap position `s` is in the stretch of the lap the lane runs beside (with a margin, m) */
  besideLap(s: number, marginM = 60): boolean {
    const span = wrapPos(this.rejoinTrackS - this.leaveTrackS, this.trackLen);
    return wrapPos(s - this.leaveTrackS + marginM, this.trackLen) <= span + 2 * marginM;
  }

  /** Whether lap position `s` is where a car turns into the lane (from 60 m before the leave point to 150 m after it) */
  nearEntry(s: number): boolean {
    const d = wrapPos(s - this.leaveTrackS + 60, this.trackLen);
    return d <= 210;
  }

  /** Lap position (m, wrapped) where a car still on the road turns into the lane: the leave point less `beforeM` */
  entryTrackS(beforeM = 0): number {
    return wrapPos(this.leaveTrackS - beforeM, this.trackLen);
  }
}

/** A car joins the lane only in its first this many metres past the leave point (m) */
const ENTRY_REGION_M = 90;

/**
 * One car's state against the lane: it is in the pit lane from when it turns into it at the entry until it is back on the
 * road. A car running wide onto the grass beside the lane further down is not in it (it never came in at the entry)
 */
export class PitLaneTracker {
  spot: PitLaneSpot | null = null;
  constructor(readonly lane: PitLaneModel) {}

  /**
   * `offRoadM`: how far past the road edge the car is (m, negative on the road); `lapS`: its lap position on the road's
   * projection. A car joins only where the lane leaves the road: Monaco's lane runs beside the lap twice more (behind the
   * barriers at the Swimming Pool), and a car off the road there is not in it
   */
  update(x: number, z: number, offRoadM: number, lapS: number): PitLaneSpot | null {
    const at = this.lane.locate(x, z, offRoadM);
    if (!this.spot) {
      if (at && at.laneM <= this.lane.leaveM + ENTRY_REGION_M && this.lane.nearEntry(lapS)) this.spot = at;
      return this.spot;
    }
    this.spot = at;
    return at;
  }

  /** Put the car in the lane at `laneM` (an AI car driven down it) */
  place(laneM: number, offsetM: number): PitLaneSpot {
    const spot: PitLaneSpot = {
      laneM,
      offsetM,
      trackS: this.lane.trackSAt(laneM),
      inLimitZone: laneM >= this.lane.limitStartM && laneM <= this.lane.limitEndM,
    };
    this.spot = spot;
    return spot;
  }

  reset(): void {
    this.spot = null;
  }
}

interface LaneShape {
  readonly px: Float64Array;
  readonly pz: Float64Array;
  readonly cum: Float64Array;
}

/** Nearest point of the lane's polyline between points `lo` and `hi` */
function projectPolyline(
  shape: LaneShape,
  x: number,
  z: number,
  lo: number,
  hi: number
): { laneM: number; offsetM: number; distM: number; index: number } {
  let best = Infinity;
  let bestM = 0;
  let bestOff = 0;
  let bestI = lo;
  for (let i = Math.max(0, lo); i < Math.min(hi, shape.px.length - 1); i++) {
    const ax = shape.px[i];
    const az = shape.pz[i];
    const bx = shape.px[i + 1];
    const bz = shape.pz[i + 1];
    const abx = bx - ax;
    const abz = bz - az;
    const l2 = abx * abx + abz * abz;
    if (l2 < 1e-9) continue;
    const u = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / l2));
    const cx = ax + abx * u;
    const cz = az + abz * u;
    const dx = x - cx;
    const dz = z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      const l = Math.sqrt(l2);
      bestM = shape.cum[i] + u * l;
      // Signed offset right of the lane's direction: the game's right (binormal) of a tangent (tx, tz) is (-tz, tx)
      bestOff = (dx * -abz + dz * abx) / l;
      bestI = i;
    }
  }
  return { laneM: bestM, offsetM: bestOff, distM: Math.sqrt(best), index: bestI };
}

/** Boxes along the limit zone, offset to the garage side, when the data has none */
function layOutBoxes(
  shape: LaneShape & { py: Float64Array; n: number },
  limitStartM: number,
  limitEndM: number,
  side: 1 | -1,
  pitboxes?: number
): PitBox[] {
  const a = limitStartM + BOX_MARGIN_M;
  const b = limitEndM - BOX_MARGIN_M;
  const span = Math.max(0, b - a);
  const want = Math.max(10, Math.min(40, Math.round(pitboxes ?? 20)));
  const count = Math.max(1, Math.min(want, Math.floor(span / BOX_SPACING_M) + 1));
  const step = count > 1 ? span / (count - 1) : 0;
  const mid = count > 1 ? a : (a + b) / 2;
  const out: PitBox[] = [];
  for (let k = 0; k < count; k++) {
    const m = mid + step * k;
    const i = Math.min(shape.n - 2, indexAt(shape.cum, m));
    const j = i + 1;
    const segL = shape.cum[j] - shape.cum[i] || 1;
    const t = (m - shape.cum[i]) / segL;
    const tx = (shape.px[j] - shape.px[i]) / segL;
    const tz = (shape.pz[j] - shape.pz[i]) / segL;
    // Right of the lane = (-tz, tx); the garages lie away from the track
    const rx = -tz;
    const rz = tx;
    const off = BOX_OFFSET_M * side;
    out.push({
      index: k,
      x: shape.px[i] + (shape.px[j] - shape.px[i]) * t + rx * off,
      y: shape.py[i] + (shape.py[j] - shape.py[i]) * t,
      z: shape.pz[i] + (shape.pz[j] - shape.pz[i]) * t + rz * off,
      yawRad: Math.atan2(tx, tz),
      laneM: m,
      offsetM: off,
    });
  }
  return out;
}

/** Index of the last point at or before `m` along the lane */
function indexAt(cum: Float64Array, m: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  if (m <= cum[0]) return 0;
  if (m >= cum[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= m) lo = mid;
    else hi = mid;
  }
  return lo;
}

function wrapPos(s: number, L: number): number {
  return L > 0 ? ((s % L) + L) % L : s;
}
