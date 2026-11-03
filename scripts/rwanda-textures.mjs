// Draws the project's own textures for four materials on Rwanda's own geometry that still use a track pack's
// images: the Armco barriers, the debris fence, the pit wall and the start gantry's metal. rwanda_2026.glb is not
// changed; the runtime swaps the material's map at load (src/lib/render/scenery-textures.ts), so the original
// stays if a file fails to load.
//
//   node scripts/rwanda-textures.mjs [--track <rwanda_2026.glb>] [--out <dir>]
//
// Each texture keeps the size and coarse layout its geometry's UVs were made for, read from the original: the
// average colour of each row (the W-beam's bands, the pit wall's coping and stripe, the gantry atlas's strips), the
// fence's rail rows and alpha coverage, the pit wall's panel joints. Every pixel of detail is drawn here: grain,
// grime, bolts, the chain-link mesh.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './lib/rwanda-ground.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const TRACK = args.track ?? join(ROOT, 'public/tracks/rwanda/rwanda_2026.glb');
const OUT = args.out ?? join(ROOT, 'public/tracks/rwanda/scenery/textures');

await MeshoptDecoder.ready;
const track = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(TRACK);
const materialByName = Object.fromEntries(track.getRoot().listMaterials().map((m) => [m.getName(), m]));

/** The original's pixels (RGBA) and size */
async function original(materialName) {
  const tex = materialByName[materialName]?.getBaseColorTexture();
  if (!tex) throw new Error(`${materialName} has no texture in ${TRACK}`);
  const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height, name: tex.getName() };
}

/** Average colour of each row, smoothed over `blur` rows (the only thing kept from the original's colours) */
function rowMeans({ data, W, H }, blur = 2) {
  const raw = Array.from({ length: H }, (_, y) => {
    const s = [0, 0, 0];
    for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) s[k] += data[(y * W + x) * 4 + k];
    return s.map((v) => v / W);
  });
  return raw.map((_, y) => {
    const s = [0, 0, 0];
    let n = 0;
    for (let d = -blur; d <= blur; d++) {
      const r = raw[Math.min(H - 1, Math.max(0, y + d))];
      for (let k = 0; k < 3; k++) s[k] += r[k];
      n++;
    }
    return s.map((v) => v / n);
  });
}

/** Smooth value noise in 0..1 at (x, y) with a cell of `cell` pixels, tiling every `W` × `H` */
function noise(x, y, cell, W, H, salt) {
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  const fx = x / cell - cx;
  const fy = y / cell - cy;
  const nx = Math.max(1, Math.round(W / cell));
  const ny = Math.max(1, Math.round(H / cell));
  const v = (i, j) => hash(((i % nx) + nx) % nx, ((j % ny) + ny) % ny, salt);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = v(cx, cy) + (v(cx + 1, cy) - v(cx, cy)) * sx;
  const b = v(cx, cy + 1) + (v(cx + 1, cy + 1) - v(cx, cy + 1)) * sx;
  return a + (b - a) * sy;
}
const grain = (x, y, W, H, salt) => 0.5 * noise(x, y, 3, W, H, salt) + 0.3 * noise(x, y, 11, W, H, salt + 1) + 0.2 * noise(x, y, 41, W, H, salt + 2) - 0.5;

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

/** Armco: the W-beam's bands from the original's rows, galvanised grain, a few long streaks and rust specks */
function armco(src) {
  const { W, H } = src;
  const rows = rowMeans(src, 3);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const g = grain(x, y, W, H, 3) * 26;
      const streak = (noise(x, y * 0.08, 24, W, H, 7) - 0.5) * 14;
      const speck = hash(x, y, 13) > 0.997 ? -45 : 0;
      const rust = speck ? [18, 0, -14] : [0, 0, 0];
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) out[i + k] = clamp(rows[y][k] + g + streak + speck + rust[k]);
      out[i + 3] = 255;
    }
  return out;
}

/**
 * Debris fence: a chain-link diamond mesh (two families of wires at ±45°, twisted at the crossings) and two
 * horizontal rails at the original's rail rows; wire width set so the opaque share matches the original's.
 */
function fence(src) {
  const { data, W, H } = src;
  let opaque = 0;
  const railRows = [];
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) row += data[(y * W + x) * 4 + 3] > 128;
    opaque += row;
    if (row > 0.5 * W) railRows.push(y);
  }
  const coverage = opaque / (W * H);
  const railShare = railRows.length / H;
  const pitch = W / 8; // diamonds across the texture (it tiles)
  const wire = Math.max(1.5, ((coverage - railShare) / 2) * (pitch / Math.SQRT2));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const rail = railRows.includes(y);
      // Distance to the nearest wire of each family, measured across it
      const d1 = Math.abs(((((x + y) % pitch) + pitch) % pitch) - pitch / 2) / Math.SQRT2;
      const d2 = Math.abs(((((x - y) % pitch) + pitch) % pitch) - pitch / 2) / Math.SQRT2;
      const d = Math.min(d1, d2);
      const onWire = d < wire / 2;
      const shade = rail ? 0.85 + 0.15 * Math.sin((y - railRows[0]) * 0.4) : 0.75 + 0.5 * (wire / 2 - d) / wire;
      const base = [118, 122, 126].map((c) => c * shade + grain(x, y, W, H, 21) * 18);
      for (let k = 0; k < 3; k++) out[i + k] = clamp(base[k]);
      out[i + 3] = rail || onWire ? 255 : 0;
    }
  return { out, coverage, wire };
}

/** Pit wall: the coping and stripe bands from the original's rows, cast-concrete grain, panel joints and drip stains */
function pitWall(src) {
  const { W, H } = src;
  const rows = rowMeans(src, 2);
  const joints = [0, 0.25, 0.5, 0.75].map((t) => Math.round(t * W));
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const g = grain(x, y, W, H, 31) * 22;
      const pores = hash(x, y, 33) > 0.985 ? -18 : 0;
      const drip = (noise(x * 3, y * 0.15, 20, W, H, 35) - 0.5) * 16 * (y / H);
      const joint = joints.some((j) => Math.abs(((x - j + W / 2 + W) % W) - W / 2) < 1.2) && y > H * 0.2 && y < H * 0.75 ? -40 : 0;
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) out[i + k] = clamp(rows[y][k] + g + pores + drip + joint);
      out[i + 3] = 255;
    }
  return out;
}

/** Gantry metal: the atlas's strips from the original's rows, brushed-steel streaks along u, bolt heads on the panels */
function gantryMetal(src) {
  const { W, H } = src;
  const rows = rowMeans(src, 1);
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const brushed = (noise(x * 0.05, y, 2, W, H, 41) - 0.5) * 22 + grain(x, y, W, H, 43) * 10;
      // Bolt heads every 128 px along the upper (panel) part of the atlas
      const bx = ((x % 128) + 128) % 128;
      const bolt = y < H * 0.55 && Math.hypot(bx - 64, y - H * 0.18) < 7 ? -55 : 0;
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) out[i + k] = clamp(rows[y][k] + brushed + bolt);
      out[i + 3] = 255;
    }
  return out;
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const [material, file, draw, alpha] of [
  ['Barrier_Armco', 'armco.webp', armco, false],
  ['Fence_Debris', 'debris-fence.webp', fence, true],
  ['PitWall', 'pit-wall.webp', pitWall, false],
  ['KN5_Metal_D', 'gantry-metal.webp', gantryMetal, false],
]) {
  const src = await original(material);
  const drawn = draw(src);
  const pixels = drawn.out ?? drawn;
  const img = sharp(pixels, { raw: { width: src.W, height: src.H, channels: 4 } });
  const buf = alpha ? await img.webp({ quality: 90, alphaQuality: 100, exact: true }).toBuffer() : await img.removeAlpha().webp({ quality: 82 }).toBuffer();
  writeFileSync(join(OUT, file), buf);
  manifest.push({ material, file, width: src.W, height: src.H, replaces: src.name, alpha });
  console.log(`  ${material}: ${file} ${src.W}×${src.H}, ${(buf.length / 1024).toFixed(0)} KB${drawn.coverage ? `, coverage ${(drawn.coverage * 100).toFixed(1)} %, wire ${drawn.wire.toFixed(1)} px` : ''}`);
}
writeFileSync(join(OUT, 'textures.json'), JSON.stringify({ generator: 'scripts/rwanda-textures.mjs', textures: manifest }, null, 2) + '\n');
const total = manifest.reduce((s, m) => s + statSync(join(OUT, m.file)).size, 0);
console.log(`Wrote ${manifest.length} textures to ${OUT} (${(total / 1024).toFixed(0)} KB)`);
