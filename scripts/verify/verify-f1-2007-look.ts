/**
 * How F1 2007's eleven bodies are drawn against Cimmerian Iter's own renders of them (each skin's preview.jpg), from
 * the GLBs and livery files scripts/cars/port_ac_car.py makes (`--car auto`). Skipped where this copy has no bodies.
 *
 *   npx tsx scripts/verify/verify-f1-2007-look.ts
 *
 * - The top bodywork's livery (the WCCARBODY multimap: an AO map under a 1:1 detail holding the nose, its race number,
 *   the headrest and the sidepod tops) is baked at the detail's own 2048 px, in each body and in every livery's file;
 *   never as the detail's mean colour, which painted the whole top one flat colour.
 * - Finishes from each material's own AC values (`apply_ac_finish`), marked extras.acFinish so the game keeps them:
 *   the paints' polished coat (a clearcoat masked by a per-pixel map) over their own ksDiffuse (the McLaren's silver at
 *   0.25 of AC's 0.4, the Ferrari's red at its skin's 0.3), and the carbon's reflection capped at its fresnelMaxLevel,
 *   with no coat and its weave tiled as many times as AC tiles it. Other cars' materials keep the game's name rules.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as THREE from 'three';
import { cleanPortedCarMaterial, hasAcFinish } from '../../src/lib/render/ported-car-materials';
import { F1_2007_SKINS, f12007BodyUrl } from '../../src/lib/cars/f1-2007-skins';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failures.push(name);
};

const TEAMS = ['ferrari', 'mclaren', 'renault', 'honda', 'bmw-sauber', 'toyota', 'red-bull', 'williams', 'toro-rosso', 'spyker', 'super-aguri'];

interface TextureInfo {
  index: number;
  extensions?: { KHR_texture_transform?: { scale?: number[] } };
}
interface GltfMaterial {
  name: string;
  extras?: { kn5?: string[]; acFinish?: Record<string, number> };
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicRoughnessTexture?: TextureInfo };
  extensions?: {
    KHR_materials_clearcoat?: { clearcoatFactor?: number; clearcoatTexture?: TextureInfo };
    KHR_materials_specular?: { specularFactor?: number; specularColorFactor?: number[]; specularTexture?: TextureInfo };
  };
}
interface GltfJson {
  images?: { name?: string; bufferView: number; mimeType: string }[];
  textures?: { source: number }[];
  bufferViews: { byteOffset?: number; byteLength: number }[];
  materials?: GltfMaterial[];
  extensionsUsed?: string[];
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

  console.log('\n== Finishes from the AC values');
  const byKn5 = (glb: { json: GltfJson }, kn5: string) => (glb.json.materials ?? []).find((m) => m.extras?.kn5?.includes(kn5));
  for (const [team, glb] of glbs) {
    const paint = byKn5(glb, 'WCCARBODY');
    const coat = paint?.extensions?.KHR_materials_clearcoat;
    check(
      `${team}: the paint's own finish, a polished coat masked per pixel`,
      !!paint?.extras?.acFinish && (coat?.clearcoatFactor ?? 0) > 0 && coat?.clearcoatTexture !== undefined && !!paint.extensions?.KHR_materials_specular,
      paint ? `${paint.name} coat ${coat?.clearcoatFactor}` : 'no WCCARBODY material',
    );
    const used = glb.json.extensionsUsed ?? [];
    check(`${team}: the extensions it uses are declared`, ['KHR_materials_specular', 'KHR_materials_clearcoat'].every((e) => used.includes(e)), used.join(', '));
    const board = byKn5(glb, 'board') ?? byKn5(glb, 'BOARD') ?? byKn5(glb, 'floor');
    const spec = board?.extensions?.KHR_materials_specular;
    const scale = board?.pbrMetallicRoughness?.metallicRoughnessTexture?.extensions?.KHR_texture_transform?.scale?.[0];
    // Coated only where its AC values make it a polished coat (Toro Rosso's floor: fresnelMaxLevel 0.5 under a tight highlight)
    const fmax = board?.extras?.acFinish?.fresnelMaxLevel ?? 0;
    const coated = !!board?.extensions?.KHR_materials_clearcoat;
    check(
      `${team}: the floor's carbon reflects at most its fresnelMaxLevel, its weave tiled`,
      !!board?.extras?.acFinish && (spec?.specularFactor ?? 1) <= Math.max(fmax, 0.1) + 1e-6 && coated === fmax >= 0.3 &&
        spec?.specularTexture !== undefined && (scale ?? 0) > 100,
      board ? `specular ${spec?.specularFactor}, fresnelMaxLevel ${fmax}, coat ${coated}, weave x${scale}` : 'no floor material',
    );
  }
  const factor = (team: string) => byKn5(glbs.get(team)!, 'WCCARBODY')?.pbrMetallicRoughness?.baseColorFactor?.[0] ?? 0;
  check("McLaren's silver under its own ksDiffuse 0.25 (of AC's usual 0.4)", Math.abs(factor('mclaren') - 0.625) < 1e-3, String(factor('mclaren')));
  check("Ferrari's red under its skin's ksDiffuse 0.3", Math.abs(factor('ferrari') - 0.75) < 1e-3, String(factor('ferrari')));
  check('a team at AC\'s usual 0.4 keeps its paint as baked', Math.abs(factor('williams') - 1) < 1e-3, String(factor('williams')));

  // The game keeps a porter-made finish as made, and still finishes other cars' paint by its name
  const made = new THREE.MeshPhysicalMaterial({ name: 'paint_002', clearcoat: 0.5, roughness: 0.27, specularIntensity: 0.1 });
  made.userData = { acFinish: { ksDiffuse: 0.4 } };
  const kept = cleanPortedCarMaterial(made) as THREE.MeshPhysicalMaterial;
  check('a material with acFinish keeps its own coat, roughness and reflection', hasAcFinish(made) && kept === made && kept.clearcoat === 0.5 && kept.roughness === 0.27 && kept.specularIntensity === 0.1);
  const other = cleanPortedCarMaterial(new THREE.MeshStandardMaterial({ name: 'mtr_body_paint', roughness: 0.1 })) as THREE.MeshPhysicalMaterial;
  check("another car's paint still takes the satin finish by its name", other.roughness === 0.55 && other.clearcoat === 0.15, `${other.roughness} ${other.clearcoat}`);
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
