/**
 * A racing line from a lap you drove: turns a lap file saved from the game (`ghost-<track>-<car>-<time>.json`, the
 * lap summary's "Save ghost") into the seed line scripts/optimize-racing-line.ts takes with `--seed`.
 *
 *   npx tsx scripts/line-from-lap.ts --track rwanda_official --lap ~/Downloads/ghost-rwanda_official-f12026-car-1.38.412.json
 *   npx tsx scripts/optimize-racing-line.ts --track rwanda_official --seed line-seed-rwanda_official.json --lock 0:99999
 *
 * `--lock 0:99999` keeps the whole lap as driven (smoothed by the optimiser's spline, checked by a physics lap, then
 * written to the circuit's track_data.json); lock only some stretches (`--lock 650:900,2100:2400`, metres along the
 * lap) to keep your line through those corners and let the optimiser find the rest.
 *
 * The seed is one lateral offset from the centreline per track sample (m, + = right), at the optimiser's 1200 samples.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { aiLineOffsetM } from '../src/lib/sim/speed-profile';
import { LAP_SAMPLE_FIELDS, LAP_SAMPLE_STRIDE, type LapRecording } from '../src/lib/sim/lap-types';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ROOT = path.join(__dirname, '..');
const lapPath = arg('--lap');
if (!lapPath) throw new Error('--lap <file saved from the game> is required');
const rec = JSON.parse(fs.readFileSync(lapPath.replace(/^~/, process.env.HOME ?? '~'), 'utf8')) as LapRecording;
const trackId = arg('--track') ?? rec.trackId;
const outPath = arg('--out') ?? `line-seed-${trackId}.json`;
if (rec.trackId !== trackId) console.warn(`The lap was driven on ${rec.trackId}, not ${trackId}: its positions are used as they are.`);

const index: { id: string; dataUrl: string }[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'tracks', 'index.json'), 'utf8'));
const dataUrl = index.find((e) => e.id === trackId)?.dataUrl ?? `/tracks/${trackId}/track_data.json`;
setActiveTrack(trackId, JSON.parse(fs.readFileSync(path.join(ROOT, 'public', dataUrl.replace(/^\//, '')), 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const n = track.samples.length;
const L = track.totalLengthM;

// Where the car was across the road at each recorded sample
const X = LAP_SAMPLE_FIELDS.indexOf('x');
const Z = LAP_SAMPLE_FIELDS.indexOf('z');
const S = LAP_SAMPLE_FIELDS.indexOf('s');
const points: { s: number; off: number }[] = [];
for (let k = 0; k + LAP_SAMPLE_STRIDE <= rec.data.length; k += LAP_SAMPLE_STRIDE) {
  const loc = track.locateWorldPoint(rec.data[k + X], rec.data[k + Z], rec.data[k + S]);
  points.push({ s: ((loc.s % L) + L) % L, off: loc.lateralH });
}
if (points.length < 50) throw new Error(`Only ${points.length} samples in the lap file`);
points.sort((a, b) => a.s - b.s);

// Onto the track's samples: straight-line between the two recorded points either side, round the lap
const offsets = new Array<number>(n);
let j = 0;
let widest = 0;
let outside = 0;
for (let i = 0; i < n; i++) {
  const s = (i / n) * L;
  while (j < points.length && points[j].s < s) j++;
  const b = points[j % points.length];
  const a = points[(j - 1 + points.length) % points.length];
  const span = (b.s - a.s + L) % L || 1e-9;
  const off = a.off + ((b.off - a.off) * ((s - a.s + L) % L)) / span;
  offsets[i] = Math.round(off * 1000) / 1000;
  widest = Math.max(widest, Math.abs(off));
  if (Math.abs(off) > track.samples[i].width / 2) outside++;
}

// How far it is from the line the circuit has now
let moved = 0;
let movedAt = 0;
for (let i = 0; i < n; i++) {
  const d = Math.abs(offsets[i] - aiLineOffsetM(track.samples[i], 'f1'));
  if (d > moved) {
    moved = d;
    movedAt = (i / n) * L;
  }
}

fs.writeFileSync(outPath, JSON.stringify(offsets));
console.log(`${trackId}: ${points.length} recorded points over ${L.toFixed(0)} m -> ${n} offsets in ${outPath}`);
console.log(`Widest ${widest.toFixed(2)} m from the centreline; ${outside} of ${n} samples beyond the road's edge (the optimiser pulls those back in).`);
console.log(`Furthest from the circuit's current line: ${moved.toFixed(2)} m at ${movedAt.toFixed(0)} m into the lap.`);
console.log(`Next: npx tsx scripts/optimize-racing-line.ts --track ${trackId} --seed ${outPath} --lock 0:99999`);
