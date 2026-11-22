/**
 * Measures the race compressor (bgm-controller.ts RACE_COMP) on the real Web Audio node: each race track renders in
 * Chromium through the same chain the player builds (the track's gainDb trim, then the compressor), and once straight
 * through, and ffmpeg measures both. Prints each track's loudness and loudness range, dry and compressed, and the trim
 * that puts the compressed loudness back on the dry one (RACE_COMP_TRIM_DB).
 * Needs ffmpeg on the PATH, Playwright's Chromium (npx playwright-core install chromium) and the MP3s in public/music.
 * Run: npx tsx scripts/music-comp.ts [track ids] [--threshold -30 --knee 12 --ratio 3 --attack 0.05 --release 0.5]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { RACE_COMP } from '../src/lib/audio/bgm-controller';
import { MUSIC_TRACKS } from '../src/lib/audio/music-catalog';

const RATE = 22050;
const DIR = join(__dirname, '../public/music');
const args = process.argv.slice(2);
const comp: Record<string, number> = { ...RACE_COMP };
const ids: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) comp[args[i].slice(2)] = Number(args[++i]);
  else ids.push(args[i]);
}
const tracks = MUSIC_TRACKS.filter((t) => (ids.length ? ids.includes(t.id) : t.pool === 'race'));

function measure(file: string): { i: number; lra: number } {
  const r = spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'));
  return { i: Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]), lra: Number(/LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1]) };
}

/** 16-bit stereo WAV around interleaved samples */
function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function main(): Promise<void> {
  if (!existsSync(DIR)) throw new Error('public/music is not in this checkout');
  const app = join(homedir(), 'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  const browser = await chromium.launch(existsSync(app) ? { executablePath: app } : {});
  const page = await browser.newPage();
  await page.route('http://music.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.endsWith('.mp3')) return route.fulfill({ body: '<!doctype html>', contentType: 'text/html' });
    return route.fulfill({ body: readFileSync(join(DIR, path)), contentType: 'audio/mpeg' });
  });
  await page.goto('http://music.test/');
  const out = mkdtempSync(join(tmpdir(), 'music-comp-'));
  const chunks: Buffer[] = [];
  await page.exposeFunction('sendChunk', (b64: string) => void chunks.push(Buffer.from(b64, 'base64')));
  console.log(`compressor ${JSON.stringify(comp)}`);
  console.log('id                         dry I   LRA   comp I  LRA   trim dB');
  const trims: number[] = [];
  for (const t of tracks) {
    const result: Record<string, { i: number; lra: number }> = {};
    for (const mode of ['dry', 'comp'] as const) {
      chunks.length = 0;
      await page.evaluate(
        async ({ url, rate, trimDb, mode, comp }) => {
          const data = await (await fetch(url)).arrayBuffer();
          const probe = new OfflineAudioContext(2, 1, rate);
          const buf = await probe.decodeAudioData(data);
          const ctx = new OfflineAudioContext(2, buf.length, rate);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          const trim = ctx.createGain();
          trim.gain.value = 10 ** (trimDb / 20);
          src.connect(trim);
          if (mode === 'comp') {
            const c = ctx.createDynamicsCompressor();
            c.threshold.value = comp.threshold;
            c.knee.value = comp.knee;
            c.ratio.value = comp.ratio;
            c.attack.value = comp.attack;
            c.release.value = comp.release;
            trim.connect(c);
            c.connect(ctx.destination);
          } else trim.connect(ctx.destination);
          src.start();
          const r = await ctx.startRendering();
          const l = r.getChannelData(0);
          const rr = r.getChannelData(1);
          const step = 1 << 20;
          for (let at = 0; at < r.length; at += step) {
            const n = Math.min(step, r.length - at);
            const pcm = new Int16Array(n * 2);
            for (let k = 0; k < n; k++) {
              pcm[2 * k] = Math.max(-32768, Math.min(32767, Math.round(l[at + k] * 32767)));
              pcm[2 * k + 1] = Math.max(-32768, Math.min(32767, Math.round(rr[at + k] * 32767)));
            }
            const bytes = new Uint8Array(pcm.buffer);
            let bin = '';
            for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
            await (window as unknown as { sendChunk: (b: string) => Promise<void> }).sendChunk(btoa(bin));
          }
        },
        { url: `http://music.test/${t.id}.mp3`, rate: RATE, trimDb: t.gainDb, mode, comp }
      );
      const file = join(out, `${t.id}-${mode}.wav`);
      writeFileSync(file, wav(Buffer.concat(chunks)));
      result[mode] = measure(file);
    }
    const trim = result.dry.i - result.comp.i;
    trims.push(trim);
    console.log(
      `${t.id.padEnd(26)} ${result.dry.i.toFixed(1).padStart(6)} ${result.dry.lra.toFixed(1).padStart(5)}   ${result.comp.i.toFixed(1).padStart(6)} ${result.comp.lra.toFixed(1).padStart(5)}   ${trim.toFixed(1).padStart(5)}`
    );
  }
  const sorted = [...trims].sort((a, b) => a - b);
  console.log(`median trim ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} dB`);
  await browser.close();
  rmSync(out, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
