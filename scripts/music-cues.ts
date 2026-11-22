/**
 * Measures the soundtrack's files for the catalogue's trims (music-catalog.ts): each file's loudness against the
 * -16 LUFS target (gainDb), where its music starts after any head silence (startS) and where it ends before a silent
 * tail (endS). A race track whose first 20 s sit 2 LU or more under the whole also gets a candidate start at the first
 * loud section, cut as a 10 s clip into --clips <dir> to listen to before it goes in the catalogue.
 * Needs ffmpeg on the PATH and the MP3s in public/music (they are hosted, not committed).
 * Run: npx tsx scripts/music-cues.ts [--clips <dir>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MUSIC_TRACKS } from '../src/lib/audio/music-catalog';

const TARGET_LUFS = -16;
/** Quieter than this is silence at the head or the tail of a file */
const SILENCE_DB = -50;
const DIR = join(__dirname, '../public/music');
const clipsAt = process.argv.indexOf('--clips');
const clipsDir = clipsAt > 0 ? process.argv[clipsAt + 1] : null;

interface Frame {
  t: number;
  m: number;
  s: number;
}

function ffmpeg(args: string[]): string {
  const r = spawnSync('ffmpeg', ['-nostats', '-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr.slice(-400)}`);
  return r.stderr;
}

function loudness(file: string): { i: number; lra: number; frames: Frame[] } {
  const out = ffmpeg(['-loglevel', 'verbose', '-i', file, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']);
  const frames: Frame[] = [];
  for (const m of out.matchAll(/t: ([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+) S:\s*(-?[\d.]+)/g)) {
    frames.push({ t: Number(m[1]), m: Number(m[2]), s: Number(m[3]) });
  }
  const summary = out.slice(out.lastIndexOf('Summary:'));
  const i = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const lra = Number(/LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1]);
  return { i, lra, frames };
}

function duration(file: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout.trim());
}

/** Silent stretches as [start, end] (end = the file's length for a silence that runs to the end) */
function silences(file: string, len: number): [number, number][] {
  const out = ffmpeg(['-i', file, '-af', `silencedetect=n=${SILENCE_DB}dB:d=0.05`, '-f', 'null', '-']);
  const spans: [number, number][] = [];
  let open: number | null = null;
  for (const m of out.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === 'start') open = Math.max(0, Number(m[2]));
    else if (open !== null) {
      spans.push([open, Number(m[2])]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, len]);
  return spans;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** The first loud section's start: 30 s that average within 2 LU of the whole, entered from the quietest moment of the 4 s before */
function loudSection(frames: Frame[], i: number): number | null {
  for (let k = 50; k < frames.length - 300; k++) {
    if (frames[k].s < i - 3) continue;
    if (mean(frames.slice(k, k + 300).map((f) => f.s)) < i - 2) continue;
    let best = k;
    for (let j = Math.max(0, k - 40); j <= k; j++) if (frames[j].m < frames[best].m) best = j;
    return Math.round(frames[best].t * 10) / 10;
  }
  return null;
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

if (!existsSync(DIR)) {
  console.error('public/music is not in this checkout');
  process.exit(1);
}
if (clipsDir) mkdirSync(clipsDir, { recursive: true });

console.log('id                         pool     I       LRA   gainDb  startS  endS    len     first20s  candidate');
for (const track of MUSIC_TRACKS) {
  const file = join(DIR, `${track.id}.mp3`);
  const len = duration(file);
  const { i, lra, frames } = loudness(file);
  const spans = silences(file, len);
  const head = spans.find(([a]) => a <= 0.05);
  const tail = spans.find(([, b]) => b >= len - 0.05);
  const startS = head ? round(Math.max(0, head[1] - 0.05), 2) : 0;
  const endS = tail ? round(tail[0], 2) : round(len, 2);
  const gainDb = round(TARGET_LUFS - i);
  // The opening's loudness: the mean short-term level over the first 20 s of music
  const first = mean(frames.filter((f) => f.t >= startS + 3 && f.t <= startS + 20).map((f) => f.s));
  const quietOpen = track.pool === 'race' && first < i - 2;
  const candidate = quietOpen ? loudSection(frames, i) : null;
  console.log(
    `${track.id.padEnd(26)} ${track.pool.padEnd(8)} ${i.toFixed(1).padStart(6)} ${lra.toFixed(1).padStart(5)} ${gainDb.toFixed(1).padStart(6)}  ` +
      `${startS.toFixed(2).padStart(6)} ${endS.toFixed(1).padStart(6)} ${len.toFixed(1).padStart(6)}  ${first.toFixed(1).padStart(7)}   ${candidate ?? ''}`
  );
  if (clipsDir && candidate !== null) {
    ffmpeg(['-y', '-ss', String(Math.max(0, candidate - 2)), '-t', '12', '-i', file, '-af', 'afade=t=out:st=11:d=1', join(clipsDir, `${track.id}-from-${candidate}s.mp3`)]);
  }
}
