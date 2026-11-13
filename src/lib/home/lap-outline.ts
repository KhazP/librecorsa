/**
 * A circuit's outline and the racing line's pace round it, small enough to sit in a page. Built from the same
 * `track_data.json` the scene uses: the outline keeps only the points its shape needs, the pace is a fixed number of
 * speeds spread evenly over the lap. scripts/build-home-outlines.ts writes them to circuit-outlines.json for the
 * home page.
 */
export interface LapOutline {
  /** The outline's box; its longer side is 1000 */
  w: number;
  h: number;
  /** An SVG path from the start line, in lap order: closed for a circuit, open for a hill climb's run */
  d: string;
  /** The racing line's speed (km/h) at evenly spaced points round the lap; empty when the circuit has none */
  kmh: number[];
  lengthM: number;
  /** The start line: where it is, and the track's heading there (degrees) */
  start: [x: number, y: number, deg: number];
}

/** The part of a circuit's track data this reads */
export interface RawLap {
  /** `pointToPoint`: a hill climb, whose outline is its run from the start line to the finish */
  metadata: { lengthMeters: number; pointToPoint?: { finishS: number } };
  samples: { p: number[]; v?: number }[];
}

const PACE_POINTS = 180;
/** How far the drawn outline may stray from the centreline, in the box's own units (0.1 % of its longer side) */
const TOLERANCE = 1;

type Pt = [number, number];

/** Ramer-Douglas-Peucker: the indices of the points a polyline needs to keep its shape within `tol` */
function simplify(pts: Pt[], tol: number): number[] {
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const spans: [number, number][] = [[0, n - 1]];
  while (spans.length) {
    const [a, b] = spans.pop()!;
    const [ax, ay] = pts[a];
    const dx = pts[b][0] - ax;
    const dy = pts[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax;
      const py = pts[i][1] - ay;
      // A lap ends where it starts: with no chord to measure from, take the distance from that point
      const dist = len > 1e-6 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      if (dist > worst) {
        worst = dist;
        at = i;
      }
    }
    if (at > 0 && worst > tol) {
      keep[at] = 1;
      spans.push([a, at], [at, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

export function lapOutlineOf(raw: RawLap): LapOutline {
  // A point-to-point course (a hill climb): its run, not the loop its track data closes beyond the finish
  const finishS = raw.metadata.pointToPoint?.finishS;
  const all = raw.samples;
  const s = finishS === undefined ? all : all.slice(0, Math.min(all.length, Math.ceil((finishS / raw.metadata.lengthMeters) * all.length) + 1));
  const n = s.length;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const q of s) {
    minX = Math.min(minX, q.p[0]);
    maxX = Math.max(maxX, q.p[0]);
    minZ = Math.min(minZ, q.p[2]);
    maxZ = Math.max(maxZ, q.p[2]);
  }
  const k = 1000 / (Math.max(maxX - minX, maxZ - minZ) || 1);
  const pts = s.map((q): Pt => [(q.p[0] - minX) * k, (q.p[2] - minZ) * k]);
  const d = `${simplify(pts, TOLERANCE)
    .map((i, j) => `${j ? "L" : "M"}${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`)
    .join("")}${finishS === undefined ? "Z" : ""}`;
  const paced = s.some((q) => typeof q.v === "number" && q.v > 0);
  const kmh = paced ? Array.from({ length: PACE_POINTS }, (_, i) => Math.round(s[Math.floor((i / PACE_POINTS) * n)].v ?? 0)) : [];
  const ahead = pts[Math.min(3, n - 1)];
  return {
    w: Math.round((maxX - minX) * k),
    h: Math.round((maxZ - minZ) * k),
    d,
    kmh,
    lengthM: finishS ?? raw.metadata.lengthMeters,
    start: [
      Math.round(pts[0][0] * 10) / 10,
      Math.round(pts[0][1] * 10) / 10,
      Math.round((Math.atan2(ahead[1] - pts[0][1], ahead[0] - pts[0][0]) * 180) / Math.PI),
    ],
  };
}

/** The racing line's speed (km/h) at a fraction of the lap */
export function paceAt(o: LapOutline, frac: number): number {
  const m = o.kmh.length;
  if (!m) return 0;
  const at = (((frac % 1) + 1) % 1) * m;
  const i = Math.floor(at);
  const a = o.kmh[i % m];
  return a + (o.kmh[(i + 1) % m] - a) * (at - i);
}

export const topSpeed = (o: LapOutline): number => o.kmh.reduce((best, v) => Math.max(best, v), 0);
