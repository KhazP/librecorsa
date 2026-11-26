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
 * - The Ferrari's early-season liveries wear the early body their skins swap in (ext_config.ini MODEL_REPLACEMENT), as
 *   a part variant, and none of the late body's files.
 * - The Ferrari's wheel LCD: each reading at its widest stays in its own cell (none overlaps another), its digits
 *   0.68 of SIZE tall on a line 0.22 of SIZE above its POSITION, f2004 narrow.
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as THREE from 'three';
import { cleanPortedCarMaterial, hasAcFinish } from '../../src/lib/render/ported-car-materials';
import { fontMetrics, type AcDigitalItem } from '../../src/lib/render/ac-digital-items';
import { F1_2007_SKINS, f12007BodyUrl } from '../../src/lib/cars/f1-2007-skins';
import { hasFile, noteSkip } from '../lib/hosted-files';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failures.push(name);
};

const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

const TEAMS = ['ferrari', 'mclaren', 'renault', 'honda', 'bmw-sauber', 'toyota', 'red-bull', 'williams', 'toro-rosso', 'spyker', 'super-aguri'];

interface TextureInfo {
  index: number;
  extensions?: { KHR_texture_transform?: { scale?: number[] } };
}
interface GltfMaterial {
  name: string;
  extras?: { kn5?: string[]; acFinish?: Record<string, number> };
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; metallicRoughnessTexture?: TextureInfo };
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
  // Red Bull's and Toro Rosso's paint is the metallic one their extension config gives them: its coat still mirrors
  // sharply, and the share of its light it reflects in its own colour is a metal share (0.4) under that coat
  const METALLIC = ['red-bull', 'toro-rosso'];
  const metalShare = async (glb: { json: GltfJson; bin: Buffer }, ti: number | undefined) => {
    if (ti === undefined) return NaN;
    const view = glb.json.bufferViews[glb.json.images![glb.json.textures![ti].source].bufferView];
    const { data, info } = await sharp(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)).raw().toBuffer({ resolveWithObject: true });
    const blue: number[] = [];
    for (let i = 2; i < data.length; i += info.channels) blue.push(data[i] / 255);
    blue.sort((a, b) => a - b);
    return blue[Math.floor(blue.length / 2)];
  };
  for (const [team, glb] of glbs) {
    const paint = byKn5(glb, 'WCCARBODY');
    const coat = paint?.extensions?.KHR_materials_clearcoat;
    const paintCoated = (coat?.clearcoatFactor ?? 0) > 0 && coat?.clearcoatTexture !== undefined;
    const metal = await metalShare(glb, paint?.pbrMetallicRoughness?.metallicRoughnessTexture?.index);
    check(
      METALLIC.includes(team) ? `${team}: the paint's own finish, its config's metallic paint under a polished coat` : `${team}: the paint's own finish, a polished coat masked per pixel`,
      !!paint?.extras?.acFinish && !!paint.extensions?.KHR_materials_specular && paintCoated &&
        (!METALLIC.includes(team) || Math.abs(metal - 0.4) < 0.01),
      paint ? `${paint.name} coat ${coat?.clearcoatFactor}, metal (median) ${fmt(metal)}` : 'no WCCARBODY material',
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

  console.log('\n== The McLaren\'s chrome');
  {
    // Its skins' txMaps alpha marks the chrome (about 0.27 on the silver, 0.95 on the red and black): those pixels are
    // metal in the finish map's B, the rest are not
    const glb = glbs.get('mclaren')!;
    for (const kn5 of ['WCCARBODY', 'WCEXTRA0', 'WCEXTRA1']) {
      const m = byKn5(glb, kn5);
      const ti = m?.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
      const im = ti === undefined ? -1 : glb.json.textures![ti].source;
      let stats = { lo: NaN, hi: NaN };
      if (im >= 0) {
        const view = glb.json.bufferViews[glb.json.images![im].bufferView];
        const { data, info } = await sharp(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)).raw().toBuffer({ resolveWithObject: true });
        const blue: number[] = [];
        for (let i = 2; i < data.length; i += info.channels) blue.push(data[i] / 255);
        blue.sort((a, b) => a - b);
        stats = { lo: blue[Math.floor(blue.length * 0.25)], hi: blue[Math.floor(blue.length * 0.95)] };
      }
      check(`${kn5}: metal where the skin marks chrome, not elsewhere`, stats.hi > 0.6 && stats.lo < 0.15, `B p25 ${fmt(stats.lo)} p95 ${fmt(stats.hi)}`);
    }
    const ferrari = byKn5(glbs.get('ferrari')!, 'WCCARBODY');
    check('a paint whose txMaps marks nothing is no metal', (ferrari?.pbrMetallicRoughness?.metallicFactor ?? 1) === 1 && ferrari?.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined);
  }

  console.log('\n== Suspension and wheels from their AC values');
  {
    // The carbon wishbones' reflection masked by their detail's alpha (Red Bull's 0.17, Williams' 0.03), and every
    // part finished from its AC values dimmed by ksDiffuse's 2.2th power (AC lights in gamma space)
    const spec = (team: string, kn5: string) => byKn5(glbs.get(team)!, kn5)?.extensions?.KHR_materials_specular?.specularFactor ?? NaN;
    const base = (team: string, kn5: string) => byKn5(glbs.get(team)!, kn5)?.pbrMetallicRoughness?.baseColorFactor?.[0] ?? NaN;
    check("Red Bull's and Williams' wishbones barely reflect", spec('red-bull', 'RBR3_SUSPENSION') < 0.03 && spec('williams', 'FW29_SUSPENSION') < 0.01, `${spec('red-bull', 'RBR3_SUSPENSION')} / ${spec('williams', 'FW29_SUSPENSION')}`);
    // The McLaren's wishbone detail is a DXT1 (no alpha, so no mask of its own): its brightness masks it instead
    check("the McLaren's wishbones (a detail with no alpha) reflect as little as the others'", spec('mclaren', 'MP4_22_SUSPENSION') < 0.04, String(spec('mclaren', 'MP4_22_SUSPENSION')));
    check('a ksAmbient 0.3 / ksDiffuse 0.2 rim at 0.53, a 0.2 one at 0.22', Math.abs(base('honda', 'RA107_RIMS') - 0.53) < 1e-3 && Math.abs(base('ferrari', 'F2007_RIMS_FRONT') - 0.22) < 1e-3, `${base('honda', 'RA107_RIMS')} / ${base('ferrari', 'F2007_RIMS_FRONT')}`);
    check("a livery's own parts keep the paint's plain dimming (the Ferrari's sidepods 0.8, not 0.53)", Math.abs(base('ferrari', 'WCEXTRA0') - 0.8) < 0.06, String(base('ferrari', 'WCEXTRA0')));
  }

  console.log('\n== The T-cam over each airbox');
  for (const [team, glb] of glbs) {
    const root = (glb.json as GltfJson & { nodes?: { extras?: Record<string, unknown> }[] }).nodes?.find((n) => n.extras?.wheelCentres);
    const cams = root?.extras?.cameras as Record<string, { pos: number[] }> | undefined;
    const t = cams?.tcam?.pos ?? [NaN, NaN, NaN];
    const eye = cams?.cockpit?.pos ?? [NaN, NaN, NaN];
    // The pods sit 1.05-1.08 m up, 0.3-0.45 m behind the driver's eyes: the camera 5 cm over them
    check(`${team}: T-cam over the airbox, behind the driver's head`, t[1] > 1.09 && t[1] < 1.16 && eye[2] - t[2] > 0.2 && eye[2] - t[2] < 0.5, `y ${fmt(t[1])}, ${fmt(eye[2] - t[2])} m behind the eyes`);
  }

  console.log('\n== The Ferrari\'s early-season body');
  {
    const ferrari = glbs.get('ferrari')!.json as GltfJson & { nodes?: { name?: string; extras?: Record<string, unknown> }[] };
    const root = ferrari.nodes?.find((n) => n.extras?.wheelCentres);
    const parts = (root?.extras?.partVariants ?? {}) as Record<string, string[]>;
    check(
      'the early body a part of its own, the late body shown for every other livery',
      JSON.stringify(parts.PART_early_model) === '["early"]' && JSON.stringify(parts.PART_body_main) === '["base"]',
      JSON.stringify(parts),
    );
    // The early body's mirrors sit 6 cm further out: the late car's live mirror is shown for the late liveries alone,
    // the early model keeps its own glass
    check(
      "the late car's live mirror shown only for the liveries that keep its body",
      JSON.stringify(parts.MIRROR_0) === '["base"]' && ferrari.nodes!.some((n) => n.name === 'MIRROR_0'),
      JSON.stringify(parts.MIRROR_0),
    );
    // ... and the early body's own glass (mirrors.ini's mesh name, in its model) a live mirror of its own
    const earlyMirror = ferrari.nodes?.find((n) => n.name === 'MIRROR_0_early_model');
    check(
      "the early body's mirror live too, shown only for the early liveries",
      JSON.stringify(parts.MIRROR_0_early_model) === '["early"]' && !!earlyMirror?.extras?.mirror,
      JSON.stringify(parts.MIRROR_0_early_model),
    );
    const early = F1_2007_SKINS.filter((s) => s.id.startsWith('ferrari-') && s.id.endsWith('-early'));
    check('both early liveries wear it', early.length === 2 && early.every((s) => s.variant === 'early'), early.map((s) => `${s.id}:${s.variant}`).join(' '));
    const lateFiles = ['wccarbody.jpg', 'wcextra0.jpg', 'wcextra1.jpg'];
    check(
      'an early livery carries no file of the late body (Räikkönen early wore Massa\'s)',
      early.every((s) => (s.files ?? []).every((f) => !lateFiles.includes(f))),
      early.map((s) => `${s.id}: ${(s.files ?? []).join(',')}`).join(' | '),
    );
    // Räikkönen's early paint is the one the early body comes in (his #6); Massa's early files are his own
    const massa = F1_2007_SKINS.find((s) => s.id === 'ferrari-massa-early');
    check("Massa's early livery paints the early body in his files", ['wcextra5.jpg', 'wcextra6.jpg', 'wcextra7.jpg'].every((f) => massa?.files?.includes(f)));
  }

  console.log('\n== The Ferrari\'s wheel LCD');
  {
    const ferrari = glbs.get('ferrari')!.json as GltfJson & { nodes?: { extras?: Record<string, unknown> }[] };
    const items = ((ferrari.nodes?.find((n) => n.extras?.wheelCentres)?.extras?.digitalItems ?? []) as AcDigitalItem[]).filter(
      (i) => JSON.stringify(i.frame) === JSON.stringify(((ferrari.nodes?.find((n) => n.extras?.wheelCentres)?.extras?.digitalItems ?? []) as AcDigitalItem[]).find((j) => j.type === 'GEAR')?.frame),
    );
    const widest: Record<string, string> = { GEAR: '8', RPM: '18888', SPEED: '388', TC_LEVEL: '8', CURRENT_LAP: '88/', PERF: '-8.88', WATER_TEMP: '188' };
    const boxes = items.map((i) => {
      const m = fontMetrics(i.font);
      const text = i.type === 'PLACE_HOLDER' ? (i.text ?? '') : `${i.prefix ?? ''}${widest[i.type] ?? '888'}${i.postfix ?? ''}`;
      const w = text.length * m.advance * i.size;
      // The driver's view: x to the right is the node's -X
      const x = -i.position[0];
      const left = i.align === 'LEFT' ? x : i.align === 'RIGHT' ? x - w - m.inset * i.size : x - w / 2;
      const bottom = i.position[1] + m.lift * i.size;
      return { type: `${i.type}${i.text ? ` ${i.text}` : ''}`, left, right: left + w, bottom, top: bottom + m.digitH * i.size };
    });
    const clash: string[] = [];
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const p = boxes[a], q = boxes[b];
        if (p.left < q.right && q.left < p.right && p.bottom < q.top && q.bottom < p.top) clash.push(`${p.type} x ${q.type}`);
      }
    check('every reading in a cell of its own', boxes.length >= 8 && clash.length === 0, `${boxes.length} readings${clash.length ? `; ${clash.join(', ')}` : ''}`);
    const f2004 = fontMetrics('f2004');
    check("AC's f2004 narrow, its digits 0.68 tall 0.22 above the line", f2004.narrow < 1 && f2004.digitH === 0.68 && f2004.lift === 0.22);
    // A right-aligned text ends a character's spacing inside POSITION (the lap count "1/" sat on its cell's edge)
    const lap = items.find((i) => i.type === 'CURRENT_LAP');
    check("the lap count ends inside its cell's right edge", !!lap && f2004.inset > 0 && fontMetrics('digital_big').inset === 0, String(f2004.inset));
    // The BMW's seven-segment gear: its window (BMW_GEARSBK) spans 5.5 mm under its node to 5.7 mm over it, the item
    // 12 mm under it and 17 mm high
    const seg = fontMetrics('digital_big');
    const gearBottom = -0.012 + seg.lift * 0.017;
    const gearTop = gearBottom + seg.digitH * 0.017;
    check("the BMW's seven-segment gear inside its window", seg.segments && gearBottom >= -0.0055 && gearTop <= 0.0057, `${(gearBottom * 1000).toFixed(1)}..${(gearTop * 1000).toFixed(1)} mm`);
    // Its 0.9 mm rpm, which AC draws as a speck, is left out
    const bmw = glbs.get('bmw-sauber')!.json as GltfJson & { nodes?: { extras?: Record<string, unknown> }[] };
    const bmwItems = (bmw.nodes?.find((n) => n.extras?.wheelCentres)?.extras?.digitalItems ?? []) as AcDigitalItem[];
    check("the BMW's shrunk-away rpm left out, its other four kept", bmwItems.length === 4 && bmwItems.every((i) => i.size >= 0.002), bmwItems.map((i) => i.type).join(' '));
    // Its fuel and speed sink only to the plate 0.2-0.35 mm deep under their boxes, not to the screen 0.9-1.05 mm
    // behind their POSITIONs (behind that plate, they were lost from the cockpit view)
    const sunk = bmwItems.filter((i) => i.type === 'FUEL' || i.type === 'SPEED').map((i) => i.depth ?? NaN);
    check("the BMW's fuel and speed in front of the plate under them", sunk.length === 2 && sunk.every((d) => d < 0.0005), sunk.map((d) => fmt(d * 1000, 2)).join(' / ') + ' mm');
  }

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
