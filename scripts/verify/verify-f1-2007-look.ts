/**
 * How F1 2007's eleven bodies are drawn against Cimmerian Iter's own renders of them (each skin's preview.jpg), from
 * the GLBs and livery files scripts/cars/port_ac_car.py makes (`--car auto`). Skipped where this copy has no bodies.
 *
 *   npx tsx scripts/verify/verify-f1-2007-look.ts
 *
 * - The top bodywork's livery (the WCCARBODY multimap: an AO map under a 1:1 detail holding the nose, its race number,
 *   the headrest and the sidepod tops) is baked at the detail's own 2048 px, in each body and in every livery's file;
 *   never as the detail's mean colour, which painted the whole top one flat colour.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { F1_2007_SKINS, f12007BodyUrl } from '../../src/lib/cars/f1-2007-skins';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failures.push(name);
};

const TEAMS = ['ferrari', 'mclaren', 'renault', 'honda', 'bmw-sauber', 'toyota', 'red-bull', 'williams', 'toro-rosso', 'spyker', 'super-aguri'];

interface GltfJson {
  images?: { name?: string; bufferView: number; mimeType: string }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
  materials?: { name: string; extras?: Record<string, unknown> }[];
}

/** A GLB's JSON and its binary chunk */
function readGlb(path: string): { json: GltfJson; bin: Buffer } {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + n).toString('utf8')) as GltfJson;
  const binStart = 20 + n + 8;
  return { json, bin: buf.subarray(binStart, binStart + buf.readUInt32LE(20 + n)) };
}

/** Width and height of a GLB image */
async function imageSize(glb: { json: GltfJson; bin: Buffer }, index: number): Promise<[number, number]> {
  const im = glb.json.images![index];
  const view = glb.json.bufferViews[im.bufferView];
  const meta = await sharp(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)).metadata();
  return [meta.width ?? 0, meta.height ?? 0];
}

async function main(): Promise<void> {
  if (!hasFile(`public${f12007BodyUrl('ferrari')}`)) {
    noteSkip('F1 2007 bodies', `public${f12007BodyUrl('ferrari')}`);
    return;
  }
  const glbs = new Map(TEAMS.map((t) => [t, readGlb(`public${f12007BodyUrl(t)}`)]));

  console.log('== The top bodywork\'s livery, baked whole');
  for (const [team, glb] of glbs) {
    const images = glb.json.images ?? [];
    const top = images.findIndex((i) => i.name === 'bake:WCCARBODY');
    const size = top >= 0 ? await imageSize(glb, top) : [0, 0];
    check(`${team}: WCCARBODY baked at its detail's 2048 px`, size[0] === 2048 && size[1] === 2048, size.join('x'));
    const flat = images.filter((i) => /^bakemean:WC(CARBODY|EXTRA\d|WING)$/.test(i.name ?? '')).map((i) => i.name);
    check(`${team}: no livery multimap as one mean colour`, flat.length === 0, flat.join(', '));
  }
  // The two Vettel skins' own details are 1024 px: their files are as large as their source, the rest 2048
  const ownSize = (id: string) => (id.endsWith('-vettel') ? 1024 : 2048);
  const listed = F1_2007_SKINS.filter((s) => (s.files ?? []).includes('wccarbody.jpg'));
  const small: string[] = [];
  const flatFiles: string[] = [];
  for (const s of listed) {
    const file = `public/cars/f1-2007/skins/${s.id}/wccarbody.jpg`;
    const meta = await sharp(file).metadata();
    if (meta.width !== ownSize(s.id) || meta.height !== ownSize(s.id)) small.push(`${s.id} ${meta.width}x${meta.height}`);
    // A picture (numbers, sponsors, stripes), not one colour under AO: many distinct colours
    const { data } = await sharp(file).resize(256, 256).raw().toBuffer({ resolveWithObject: true });
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 3) seen.add((data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4));
    if (seen.size < 60) flatFiles.push(`${s.id} ${seen.size}`);
  }
  check(`every livery's wccarbody.jpg at its detail's size (${listed.length} liveries)`, listed.length > 0 && small.length === 0, small.join(', '));
  check('every livery\'s wccarbody.jpg a picture, not one colour', listed.length > 0 && flatFiles.length === 0, flatFiles.join(', '));
}

main().then(
  () => {
    if (failures.length) {
      console.log(`\n${failures.length} F1 2007 look check(s) failed:\n  ${failures.join('\n  ')}`);
      process.exit(1);
    }
    console.log('\nAll F1 2007 look checks passed.');
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
