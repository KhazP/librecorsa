/**
 * Where another layout's road leaves a lap (two layouts over one model): the stretches of the lap, as a car on that
 * road is placed along it (`projectWorldToTrack`, following on from the last point), where any of that road lies past
 * the lap's own edge and kerbs. Stored as the lap's `metadata.otherLayoutRoads` (course-limits.ts reads it).
 */
import { beyondLayoutEdge } from '../../src/lib/sim/course-limits';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';

/** Marks closer than this (m) are one stretch; each stretch is padded by as much either side and rounded out to 5 m */
const JOIN_M = 30;

export function otherLayoutRoads(id: string, raw: RawTrackJson, other: RawTrackJson): [number, number][] {
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  const L = track.totalLengthM;
  const marks: number[] = [];
  let hint: number | undefined;
  const os = other.samples as { p: number[]; t: number[]; w: number }[];
  for (let i = 0; i <= os.length; i++) {
    // Every 2.5 m of the other road, across its whole width
    const a = os[i % os.length];
    const b = os[(i + 1) % os.length];
    for (const u of [0, 0.5]) {
      const cx = a.p[0] + (b.p[0] - a.p[0]) * u;
      const cz = a.p[2] + (b.p[2] - a.p[2]) * u;
      const tl = Math.hypot(a.t[0], a.t[2]) || 1;
      const rx = -a.t[2] / tl;
      const rz = a.t[0] / tl;
      const p = track.projectWorldToTrack(cx, cz, hint);
      hint = p.s;
      const sample = track.getSampleAtDistance(p.s);
      for (const f of [-1, -0.5, 0, 0.5, 1]) {
        if (beyondLayoutEdge(sample, cx + rx * f * (a.w / 2), cz + rz * f * (a.w / 2))) {
          marks.push(p.s);
          break;
        }
      }
    }
  }
  marks.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (const s of marks) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= JOIN_M) last[1] = s;
    else out.push([s, s]);
  }
  // Over the line: the last stretch runs into the first
  if (out.length > 1 && out[0][0] + L - out[out.length - 1][1] <= JOIN_M) out[0][0] = out.pop()![0];
  return out.map(([a, b]) => [
    (((Math.floor((a - JOIN_M) / 5) * 5) % L) + L) % L,
    (((Math.ceil((b + JOIN_M) / 5) * 5) % L) + L) % L,
  ]);
}
