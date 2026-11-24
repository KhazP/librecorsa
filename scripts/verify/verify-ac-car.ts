/**
 * The Assetto Corsa car importer (scripts/mods/importers/ac-car.ts) and what it is made of: the automatic preset's
 * detection (port_ac_car.py) on models described in JSON, ui_car.json read as mods write it, the licence and Kunos
 * checks, the base model's choice, and the physics patch on a data folder written here. No car mod is needed for those.
 *
 *   npx tsx scripts/verify/verify-ac-car.ts
 *
 * Two parts read real mods and are skipped when they are absent: the patch made from each parity-checked car's own data
 * (REALISM_REF, scripts/lib/mod-data.ts) onto its own vehicle model, which must give that model's values back; and the
 * detection on full car folders (AC_CARS_DIR: a folder of content/cars folders), against the repository's presets.
 * The detection runs Python through uv, and is skipped without it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VEHICLE_MODELS } from '../../src/lib/cars/vehicle-models';
import { modSimProfile } from '../../src/lib/mods/mod-physics';
import { turboSteadyBoost } from '../../src/lib/sim/f12026-car/F12026CarConfig';
import type { VehicleModelId } from '../../src/types/f1';
import { findKn5, kn5IsPlain, kunosContent, parseLooseJson, parseUiCar, readLicence } from '../cars/ac-car-info';
import { acPhysicsPatch, chooseBaseModel, driveCheck, valueAt, type AcCarFacts } from '../cars/ac-physics-patch';
import { lutAt, modDir } from '../lib/mod-data';
import importer from '../mods/importers/ac-car';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(78)} ${detail}`);
  if (!ok) failed++;
}
const near = (a: unknown, b: number, tol = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const tmp = mkdtempSync(join(tmpdir(), 'ac-car-'));
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const uv = spawnSync('uv', ['--version']).status === 0;

/** port_ac_car.py --detect on a model or a car folder */
function detect(target: string, extra: string[] = []): Record<string, unknown> | null {
  const r = spawnSync('uv', ['run', '--python', '3.14', '--no-project', '--with', 'numpy', '--with', 'pillow', 'python', '-P', 'scripts/cars/port_ac_car.py', '--detect', target, ...extra], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(r.stderr.slice(-800));
    return null;
  }
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== The automatic preset, on models described in JSON');
  // A car of boxes: a painted body, an interior, a windscreen ahead of the driver and a gauge's glass under his eyes,
  // four wheels of a tyre (a ring round the hub) and a rim (a disc), blurred rims and broken glass to leave out
  function model(tyre: { name: string; shader: string }, opts: { paintName?: string; overrides?: Record<string, number>; skins?: number } = {}) {
    const materials = [
      { name: opts.paintName ?? 'carPaint', shader: 'ksPerPixelMultiMap', maps: { txDiffuse: 'car_paint.dds', txDetail: 'paint_detail.dds' } },
      { name: 'interior_mat', shader: 'ksPerPixel', maps: { txDiffuse: 'interior.dds' } },
      { name: 'EXT_Glass', shader: 'ksPerPixelAlphaBlend', blend: 1, maps: { txDiffuse: 'glass.dds' } },
      { name: 'gauge_glass', shader: 'ksPerPixelAlphaBlend', blend: 1, maps: { txDiffuse: 'gauge.dds' } },
      { name: 'rim_alloy', shader: 'ksPerPixel', maps: { txDiffuse: 'rim.dds' } },
      { name: tyre.name, shader: tyre.shader, maps: { txDiffuse: 'tread.dds' } },
      { name: 'Rim_Blur', shader: 'ksPerPixelAlphaBlend', blend: 1, maps: { txDiffuse: 'blur.dds' } },
      { name: 'DAMAGE_GLASS', shader: 'ksPerPixelAlphaBlend', blend: 1, maps: { txDiffuse: 'broken.dds' } },
      { name: 'livery_b', shader: 'ksPerPixel', maps: { txDiffuse: 'b.dds' } },
    ];
    const nodes: Record<string, unknown>[] = [
      { name: 'CAR' },
      { name: 'BODY_MESH', parent: 0, mat: 0, size: [1.8, 0.6, 4.2], at: [0, 0.6, 0] },
      { name: 'SIDE_PANELS', parent: 0, mat: 8, size: [1.82, 0.3, 3.0], at: [0, 0.45, 0] },
      { name: 'INTERIOR', parent: 0, mat: 1, size: [1.2, 0.3, 1.2], at: [0, 0.5, -0.3] },
      { name: 'WINDSCREEN', parent: 0, mat: 2, size: [1.3, 0.45, 0.04], at: [0, 0.95, 0.5] },
      { name: 'GAUGES', parent: 0, mat: 3, shape: 'ring', r: 0.06, r0: 0.0, w: 0.02, at: [0.35, 0.55, 0.15] },
      { name: 'BROKEN', parent: 0, mat: 7, size: [1.3, 0.45, 0.04], at: [0, 0.95, 0.52] },
    ];
    for (const [c, x, z] of [['LF', 0.75, 1.3], ['RF', -0.75, 1.3], ['LR', 0.75, -1.3], ['RR', -0.75, -1.3]] as const) {
      const hub = nodes.length;
      nodes.push({ name: `WHEEL_${c}`, parent: 0, t: [x, 0.32, z] });
      nodes.push({ name: `tread_${c}`, parent: hub, mat: 5, shape: 'ring', r: 0.32, r0: 0.22, w: 0.25 });
      nodes.push({ name: `rim_${c}`, parent: hub, mat: 4, shape: 'disc', r: 0.23, w: 0.22 });
      nodes.push({ name: `blur_${c}`, parent: hub, mat: 6, shape: 'disc', r: 0.24, w: 0.2 });
    }
    return { materials, nodes, eyes: [0.35, 0.8, -0.3], overrides: opts.overrides ?? { 'car_paint.dds': 3 }, skins: opts.skins ?? 3 };
  }
  if (!uv) console.log('SKIP  the detection: uv is not on this machine (docs/PORTING-CARS.md)');
  else {
    const run = (name: string, spec: unknown) => {
      const p = join(tmp, `${name}.json`);
      writeFileSync(p, JSON.stringify(spec));
      return detect(p);
    };
    const a = run('shader', model({ name: 'tyre_mat', shader: 'ksTyres' }));
    const how = (d: Record<string, unknown> | null) => Object.values((d?.tyres ?? {}) as Record<string, string>);
    check('tyres: AC\'s tyre shader under each WHEEL_xx', how(a).length === 4 && how(a).every((h) => h === 'tyre shader'), JSON.stringify(a?.tyres));
    check('tyres: the tyre meshes alone, not the rims or the blurred rims', JSON.stringify(a?.tyreNodes) === JSON.stringify(['tread_LF', 'tread_LR', 'tread_RF', 'tread_RR']), JSON.stringify(a?.tyreNodes));
    check('paint: the body material named as paint', a?.paint === 'carPaint', String(a?.paint));
    check('windscreen: the glass the driver looks through, not the gauge glass under the eyes', a?.windscreen === 'EXT_Glass', String(a?.windscreen));
    check('left out: the blurred rims and the broken glass', JSON.stringify(a?.skipMaterials) === JSON.stringify(['DAMAGE_GLASS', 'Rim_Blur']), JSON.stringify(a?.skipMaterials));
    check('no DISC_xx nodes: nothing spins beside the wheels', JSON.stringify(a?.spinning) === '[]');
    const b = run('name', model({ name: 'Tyre_Rubber', shader: 'ksPerPixel' }));
    check('tyres: by the material\'s name, without the tyre shader', how(b).every((h) => h === 'material name') && how(b).length === 4, JSON.stringify(b?.tyres));
    const c = run('ring', model({ name: 'mat_017', shader: 'ksPerPixel' }));
    check('tyres: by shape, the outermost ring round the hub, when nothing names them', how(c).every((h) => h === 'outermost ring') && JSON.stringify(c?.tyreNodes) === JSON.stringify(['tread_LF', 'tread_LR', 'tread_RF', 'tread_RR']), JSON.stringify(c?.tyres));
    const d = run('repaint', model({ name: 'tyre_mat', shader: 'ksTyres' }, { paintName: 'mat_a', overrides: { 'b.dds': 5 }, skins: 5 }));
    check('paint: by the skins that repaint it, when no name says', d?.paint === 'livery_b', `${String(d?.paint)} ${JSON.stringify(d?.paintScores)}`);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log("\n== The automatic sound config, on a bank's sample names");
  if (!uv) console.log('SKIP  uv is not on this machine');
  else {
    const names: [string, number][] = [
      ['car_int_on_3000', 6], ['car_int_on_6000', 6], ['car_int_on_6020_b', 4], ['int_idle', 8], ['car_ext_onlow', 5], ['car_ext_onhigh', 5],
      ['car_AFT_ext_offmed', 5], ['car_Front_ext_offmed', 9], ['car_ext_offhigh', 5], ['backfire_1', 0.8], ['ext_bf_2', 0.7], ['shift_up_1', 0.4],
      ['shift_down_1', 0.5], ['missgear', 3], ['turbo', 8], ['Skid', 3], ['traction_control', 2], ['limiter_loop', 1.2], ['door_open', 0.6],
    ];
    const list = join(tmp, 'bank.json');
    writeFileSync(list, JSON.stringify(names.map(([name, seconds], index) => ({ index, name, rate: 44100, channels: 1, frames: seconds * 44100, seconds, mode: 2 }))));
    const run = (boost: string) => {
      const r = spawnSync('uv', ['run', '--python', '3.14', '--no-project', '--with', 'numpy', '--with', 'scipy', '--with', 'fsb5', 'python', '-P', 'scripts/audio/port_ac_bank.py', '--auto-plan', list, '--limiter', '8000', '--idle', '1000', '--boost', boost], { encoding: 'utf8' });
      if (r.status !== 0) console.log(r.stderr.slice(-600));
      return r.status === 0 ? (JSON.parse(r.stdout) as { engine: Record<string, Record<string, { rpm: number; rootRpm: number; sample: string }[]>>; oneshots?: Record<string, string[]>; turbo?: unknown[]; skid?: unknown; tractionControl?: string; limiterFallbackSample?: string }) : null;
    };
    const cfg = run('1');
    const rows = (view: string, layer: string) => (cfg?.engine[view][layer] ?? []).map((a) => `${a.rpm}/${a.rootRpm}/${a.sample.split('#')[0]}`);
    check('engine loops by the rpm in their names, the idle loop under them', JSON.stringify(rows('int', 'on')) === JSON.stringify(['1000/1000/int_idle', '3000/3000/car_int_on_3000', '8000/6000/car_int_on_6000']), JSON.stringify(rows('int', 'on')));
    check('the top loop plays at the limiter, pitched from the speed it was recorded at', cfg?.engine.int.on.at(-1)?.rootRpm === 6000);
    check('two recordings 20 rpm apart: one loop, the longer', !rows('int', 'on').some((r) => r.includes('6020')));
    check('a layer with no loops of its own borrows the other layer\'s', JSON.stringify(rows('int', 'off')) === JSON.stringify(rows('int', 'on')));
    check('by the speed words (low, high) over the idle-to-limiter range', JSON.stringify(rows('ext', 'on')) === JSON.stringify(['1000/1000/int_idle', '2750/2750/car_ext_onlow', '8000/6600/car_ext_onhigh']), JSON.stringify(rows('ext', 'on')));
    check('outside, the exhaust side\'s recording before the front\'s', rows('ext', 'off').some((r) => r.endsWith('car_AFT_ext_offmed')) && !rows('ext', 'off').some((r) => r.includes('Front')), JSON.stringify(rows('ext', 'off')));
    const shots = cfg?.oneshots ?? {};
    check('the shifts, the backfires, the limiter, skid and traction control by name; never the missed-gear grind', shots.gear_up?.[0]?.startsWith('shift_up_1') === true && shots.gear_down?.[0]?.startsWith('shift_down_1') === true && !JSON.stringify(shots).includes('missgear') && (shots.backfire_ext?.length ?? 0) === 2 && cfg?.limiterFallbackSample?.startsWith('limiter_loop') === true && !!cfg?.skid && cfg?.tractionControl?.startsWith('traction_control') === true, JSON.stringify(shots));
    check('the turbo loop only for a car with boost', !!cfg?.turbo && !run('0')?.turbo);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== ui_car.json, as mods write it');
  {
    const ui = parseUiCar(
      [
        '\uFEFF{',
        '  "name": "Nissan 300ZX GT&#39;s",',
        '  "brand": "Nissan",',
        '  "class": "Race",',
        '  "tags": ["GT", "#JGTC", "rwd",],',
        '  "year": "1997",',
        '  "description": "A line',
        'and another<br>with a break",',
        '  "specs": { "bhp": "750 bhp", "weight": "1200 kg", },',
        '  "author": "Someone",',
        '  "url": "https://example.org/zx",',
        '}',
      ].join('\n'),
    );
    check('a byte-order mark, raw line breaks and trailing commas are let pass', ui.name === "Nissan 300ZX GT's" && ui.brand === 'Nissan' && ui.tags.length === 3, JSON.stringify(ui.tags));
    check('its class in lower case, its year a number, its specs and author', ui.class === 'race' && ui.year === 1997 && ui.specs.bhp === '750 bhp' && ui.author === 'Someone');
    check('its description as plain text', ui.description === 'A line\nand another\nwith a break', JSON.stringify(ui.description));
    const broken = parseLooseJson('{ "name": "Half a file", "year": 1975, "tags": ["x" ');
    check('a file that is not JSON at all: its "key": value pairs', broken.name === 'Half a file' && broken.year === 1975);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== Kunos cars and licences');
  {
    const kunosDir = join(tmp, 'ks_ferrari_488_gt3');
    write(join(kunosDir, 'ui', 'ui_car.json'), '{ "name": "Ferrari 488 GT3" }');
    check('a "ks_" car is refused', /Kunos/.test(kunosContent(kunosDir, parseUiCar('{}')) ?? ''));
    check('one of the base game\'s cars is refused', !!kunosContent(join(tmp, 'ferrari_458'), parseUiCar('{}')));
    check('a car whose ui_car.json names Kunos is refused', !!kunosContent(join(tmp, 'my_car'), parseUiCar('{ "author": "Kunos Simulazioni" }')));
    check("a modder's car is not Kunos's", kunosContent(join(tmp, 'pfa_vw_scirocco_53b'), parseUiCar('{ "author": "Pfalzdriver" }')) === null);
    // A mod made of a Kunos car, however its folder is named: its models, its parent, its sound
    const renamed = (name: string, files: Record<string, string>) => {
      const dir = join(tmp, 'renamed', name);
      write(join(dir, 'my_car.kn5'), 'sc6969');
      for (const [f, text] of Object.entries(files)) write(join(dir, f), text);
      return dir;
    };
    const ui0 = parseUiCar('{ "author": "Someone" }');
    check("a renamed base-game car: its model's name gives it away", /"ferrari_458\.kn5"/.test(kunosContent(renamed('a', { 'ferrari_458.kn5': 'sc6969' }), ui0) ?? ''));
    check('... or a lower LOD of one', !!kunosContent(renamed('b', { 'ferrari_458_lod_b.kn5': 'sc6969' }), ui0));
    check('... a "ks_" model', !!kunosContent(renamed('c', { 'ks_porsche_911_gt3_r_2016.kn5': 'sc6969' }), ui0));
    check("... a model lods.ini names", !!kunosContent(renamed('d', {}), ui0, ['ks_mazda_mx5_cup.kn5']));
    check('... a ui_car.json "parent" that is a Kunos car', /version of "ferrari_458"/.test(kunosContent(renamed('e', {}), parseUiCar('{ "parent": "ferrari_458" }')) ?? ''));
    check('... a sound bank named for one', /sfx\/ks_ferrari_488_gt3\.bank/.test(kunosContent(renamed('f', { 'sfx/ks_ferrari_488_gt3.bank': 'x' }), ui0) ?? ''));
    check("... sfx/GUIDs.txt playing a Kunos car's events", /"ks_ferrari_488_gt3"/.test(kunosContent(renamed('g', { 'sfx/my_car.bank': 'x', 'sfx/GUIDs.txt': '{0001} event:/cars/ks_ferrari_488_gt3/engine_ext\n' }), ui0) ?? ''));
    check("a modder's own models, bank and events are not", kunosContent(renamed('h', { 'my_car_lod_b.kn5': 'sc6969', 'sfx/my_car.bank': 'x', 'sfx/GUIDs.txt': '{0001} event:/cars/my_car/engine_ext\n' }), parseUiCar('{ "parent": "my_car_base" }')) === null);
    let refused = '';
    try {
      await importer.run([kunosDir, '--out', join(tmp, 'mods')]);
    } catch (err) {
      refused = (err as Error).message;
    }
    check('the importer refuses a Kunos car outright, before converting anything', /^refused: .*Kunos/.test(refused) && !existsSync(join(tmp, 'mods')), refused);
    const enc = join(tmp, 'enc_car');
    write(join(enc, 'enc_car.kn5'), 'ENCRYPTEDxxxx');
    write(join(enc, 'enc_car_lod_b.kn5'), 'sc6969');
    write(join(enc, 'collider.kn5'), 'sc6969');
    check('the main model is <folder>.kn5, and an encrypted one is seen', findKn5(enc) === 'enc_car.kn5' && !kn5IsPlain(join(enc, 'enc_car.kn5')));
    const other = join(tmp, 'other_name');
    write(join(other, 'model_main.kn5'), 'sc6969 a bigger plain model');
    write(join(other, 'model_main_lod_b.kn5'), 'sc6969');
    check('else the largest kn5 that is no LOD or collider', findKn5(other) === 'model_main.kn5' && kn5IsPlain(join(other, 'model_main.kn5')));

    // lods.ini's LOD_0 FILE: a model inside the car folder, or none at all. Both readers agree on which file it is
    const lods = join(tmp, 'lods_car');
    write(join(lods, 'body_main.kn5'), 'sc6969 the model');
    write(join(lods, 'sub', 'lod0.kn5'), 'sc6969');
    write(join(lods, 'notes.txt'), 'sc6969');
    write(join(tmp, 'outside.kn5'), 'sc6969 a much bigger model, outside the car folder');
    symlinkSync(join(tmp, 'outside.kn5'), join(lods, 'linked.kn5'));
    const lod0s = ['../outside.kn5', join(tmp, 'outside.kn5'), 'sub/../../outside.kn5', 'linked.kn5', 'notes.txt', 'sub\\lod0.kn5', './sub/lod0.kn5'];
    const want = ['body_main.kn5', 'body_main.kn5', 'body_main.kn5', 'body_main.kn5', 'body_main.kn5', 'sub/lod0.kn5', 'sub/lod0.kn5'];
    const ts = lod0s.map((l) => findKn5(lods, l));
    check("lods.ini: a model outside the folder (an absolute path, '..', a link), or no .kn5, is never the model", JSON.stringify(ts) === JSON.stringify(want), JSON.stringify(ts));
    if (uv) {
      const py = spawnSync(
        'uv',
        ['run', '--python', '3.14', '--no-project', '--with', 'numpy', '--with', 'pillow', 'python', '-P', '-c',
          "import json, sys; sys.path.insert(0, 'scripts/cars'); import port_ac_car as p; " +
            "print(json.dumps([p.find_kn5(sys.argv[1], {'lods.ini': f'[LOD_0]\\nFILE={n}\\n'}) for n in json.loads(sys.argv[2])]))",
          lods, JSON.stringify(lod0s)],
        { encoding: 'utf8' },
      );
      const got = py.stdout.trim().split('\n').at(-1) ?? '';
      check('... and port_ac_car.py reads lods.ini the same way', got === JSON.stringify(want).replace(/,/g, ', '), got || py.stderr.slice(-300));
    }

    const licence = (files: Record<string, string>, ui = '{}') => {
      const dir = mkdtempSync(join(tmp, 'lic-'));
      for (const [f, text] of Object.entries(files)) write(join(dir, f), text);
      return readLicence(dir, parseUiCar(ui));
    };
    const none = licence({});
    check('no licence stated: not shareable, "All rights reserved"', !none.shareable && none.license === 'All rights reserved' && none.source === null, none.reason);
    const cc = licence({ 'readme.txt': 'Released under CC BY-NC-SA 4.0. Have fun!' });
    check('a Creative Commons licence lets it be shared, named as such', cc.shareable && cc.license === 'CC BY-NC-SA 4.0' && cc.licenseUrl === 'https://creativecommons.org/licenses/by-nc-sa/4.0/', `${cc.license} ${cc.licenseUrl}`);
    const nd = licence({ 'LICENSE.txt': 'CC BY-ND 4.0' });
    check('"ND" (no derivatives) does not: a conversion is a changed copy', !nd.shareable && nd.license === 'CC BY-ND 4.0', nd.reason);
    const deny = licence({ 'readme.txt': 'Free to use. Do not reupload or convert this mod to other games.' }, '{ "license": "CC BY 4.0" }');
    check('a line forbidding sharing wins over any licence', !deny.shareable, deny.reason);
    const gpl = licence({}, '{ "license": "GPL-3.0" }');
    check('an open licence in ui_car.json lets it be shared', gpl.shareable && gpl.source === 'ui_car.json', gpl.license);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== The base model');
  {
    const facts = (f: Partial<AcCarFacts>): AcCarFacts => ({ name: '', className: 'race', tags: [], traction: 'RWD', massKg: 1200, peakKw: 350, turbo: false, clA: 0, ...f });
    const cases: [string, Partial<AcCarFacts>, VehicleModelId][] = [
      ['an open-wheeler', { tags: ['formula', 'open wheel'], massKg: 650, peakKw: 450 }, 'f12026-car'],
      ['a light prototype', { tags: ['lmp', 'prototype'], massKg: 1000, peakKw: 440 }, 'mtr-496r'],
      ['a powerful prototype', { tags: ['lmdh', 'prototype'], massKg: 1030, peakKw: 520 }, 'lc-lmdh'],
      ['a GT3', { tags: ['gt3'], year: 2019 }, 'amg-gt3'],
      ['a 1990s JGTC car', { tags: ['gt', 'jgtc'], year: 1997, turbo: true }, 'nissan-r33-jgtc'],
      ['a four-wheel-drive touring car', { tags: ['touring'], traction: 'AWD2', year: 1990 }, 'nissan-r32-jtcc'],
      ['a turbo classic racer', { tags: ['vintage'], year: 1976, turbo: true }, 'porsche-934-rsr'],
      ['an atmospheric classic racer', { tags: ['classic', 'group 4'], year: 1979 }, 'bmw-m1-procar'],
      ['a front-driven classic racer', { tags: ['vintage'], year: 1985, traction: 'FWD' }, 'vw-scirocco-gtx'],
      ['a front-driven modern touring car', { tags: ['tcr', 'touring'], year: 2020, traction: 'FWD', peakKw: 250 }, 'vw-scirocco-gtx'],
      ['a small road car', { className: 'street', tags: ['hatchback'], peakKw: 80, massKg: 1050 }, 'liana'],
      ['a quicker road car', { className: 'street', tags: [], peakKw: 150, massKg: 1150 }, 'vw-scirocco-gtx'],
      ['a modern race car making real downforce', { year: 2015, massKg: 900, peakKw: 300, clA: 2.5 }, 'mtr-496r'],
      ['any other modern race car', { year: 2015, massKg: 1250, peakKw: 400, clA: 0.6 }, 'amg-gt3'],
    ];
    for (const [label, f, want] of cases) {
      const got = chooseBaseModel(facts(f));
      check(`${label} → ${want}`, got.base === want, `${got.base}: ${got.why}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== The physics patch, on a data folder written here');
  const INI: Record<string, string> = {
    'car.ini': `[BASIC]\nTOTALMASS=1100\nINERTIA=1.8,1.1,4.2\n[CONTROLS]\nSTEER_LOCK=270\nSTEER_RATIO=15\n[FUEL]\nCONSUMPTION=0.003\n[FUELTANK]\nPOSITION=0,-0.15,-0.7\n[GRAPHICS]\nDRIVEREYES=0.35,0.75,-0.3\n[RIDE]\nPICKUP_FRONT_HEIGHT=-0.30\nPICKUP_REAR_HEIGHT=-0.34\n`,
    'suspensions.ini': ['[BASIC]\nWHEELBASE=2.56\nCG_LOCATION=0.45\n[ARB]\nFRONT=60000\nREAR=30000'].concat(
      ['FRONT', 'REAR'].map((ax, i) => `[${ax}]\nTYPE=DWB\nBASEY=-0.12\nTRACK=${1.55 + 0.03 * i}\nROD_LENGTH=0.02\nHUB_MASS=40\nSTATIC_CAMBER=${-1.5 + 0.5 * i}\nSPRING_RATE=${120000 - 20000 * i}\nPROGRESSIVE_SPRING_RATE=0\nBUMP_STOP_RATE=80000\nBUMPSTOP_UP=0.06\nBUMPSTOP_DN=0.08\nPACKER_RANGE=0.09\nDAMP_BUMP=4000\nDAMP_FAST_BUMP=2000\nDAMP_FAST_BUMPTHRESHOLD=0.08\nDAMP_REBOUND=6000\nDAMP_FAST_REBOUND=3000\nDAMP_FAST_REBOUNDTHRESHOLD=0.1\nWBCAR_TOP_FRONT=0.30, 0.17, 0.10\nWBCAR_TOP_REAR=0.30, 0.17, -0.10\nWBCAR_BOTTOM_FRONT=0.38, -0.12, 0.10\nWBCAR_BOTTOM_REAR=0.38, -0.12, -0.15\nWBTYRE_TOP=0.10, 0.18, 0.0\nWBTYRE_BOTTOM=0.06, -0.12, 0.0\nWBCAR_STEER=0.38, -0.10, ${i ? -0.12 : 0.12}\nWBTYRE_STEER=0.06, -0.10, ${i ? -0.12 : 0.12}`),
    ).join('\n'),
    'tyres.ini': `[HEADER]\nVERSION=10\n[COMPOUND_DEFAULT]\nINDEX=0\n${['FRONT', 'REAR'].map((ax, i) => `[${ax}]\nNAME=Slick\nSHORT_NAME=S\nWIDTH=${0.25 + 0.03 * i}\nRADIUS=0.31\nRIM_RADIUS=0.23\nANGULAR_INERTIA=1.2\nDAMP=500\nRATE=280000\nDY_REF=${1.4 - 0.02 * i}\nDX_REF=1.45\nFZ0=3000\nLS_EXPY=0.85\nLS_EXPX=0.88\nFLEX_GAIN=0.02\nFRICTION_LIMIT_ANGLE=8\nXMU=0.25\nPRESSURE_STATIC=24\nPRESSURE_SPRING_GAIN=4000\nPRESSURE_FLEX_GAIN=0.3\nPRESSURE_RR_GAIN=0.5\nPRESSURE_D_GAIN=0.004\nPRESSURE_IDEAL=30\nCAMBER_GAIN=0.15\nDCAMBER_0=1.2\nDCAMBER_1=-12\nRELAXATION_LENGTH=0.08\nROLLING_RESISTANCE_0=12\nROLLING_RESISTANCE_1=0.0004\nROLLING_RESISTANCE_SLIP=3000\nSPEED_SENSITIVITY=0.003\nCX_MULT=1.05\nFALLOFF_LEVEL=0.85\nFALLOFF_SPEED=3\nCOMBINED_FACTOR=2\nBRAKE_DX_MOD=0.05\nWEAR_CURVE=(0=100|10=99|30=96|60=90)\n[THERMAL_${ax}]\nPERFORMANCE_CURVE=(0=0.8|60=0.95|85=1|100=1|130=0.9)`).join('\n')}\n`,
    'engine.ini': `[ENGINE_DATA]\nALTITUDE_SENSITIVITY=0.1\nINERTIA=0.15\nLIMITER=8500\nLIMITER_HZ=30\nMINIMUM=1000\n[COAST_REF]\nRPM=8000\nTORQUE=100\n[TURBO_0]\nLAG_DN=0.99\nLAG_UP=0.997\nMAX_BOOST=0.8\nWASTEGATE=0.8\nDISPLAY_MAX_BOOST=1\nREFERENCE_RPM=5000\nGAMMA=2\n`,
    'power.lut': '0|0\n1000|150\n3000|250\n5000|330\n7000|350\n8500|320\n',
    'drivetrain.ini': `[TRACTION]\nTYPE=RWD\n[GEARS]\nCOUNT=5\nGEAR_R=-3.0\nGEAR_1=2.8\nGEAR_2=2.0\nGEAR_3=1.55\nGEAR_4=1.25\nGEAR_5=1.05\nFINAL=3.9\n[DIFFERENTIAL]\nPOWER=0.4\nCOAST=0.3\nPRELOAD=50\n[GEARBOX]\nCHANGE_UP_TIME=150\nCHANGE_DN_TIME=180\nAUTO_CUTOFF_TIME=150\nINERTIA=0.02\n[CLUTCH]\nMAX_TORQUE=800\n[AUTOCLUTCH]\nMIN_RPM=1500\nMAX_RPM=2500\n[DOWNSHIFT_PROFILE]\nPOINT_0=20\nPOINT_1=150\nPOINT_2=300\n[AUTOBLIP]\nLEVEL=0.6\nPOINT_0=30\n[AUTO_SHIFTER]\nUP=8200\nDOWN=5000\n`,
    'brakes.ini': '[DATA]\nMAX_TORQUE=2600\nFRONT_SHARE=0.62\nHANDBRAKE_TORQUE=0\nADJUST_STEP=1\n',
    'aero.ini': '[WING_0]\nNAME=BODY\nCHORD=1\nSPAN=1.4\nPOSITION=0,0,0\nLUT_AOA_CL=(-10=-0.1|0=0.1|10=0.2)\nCL_GAIN=1\nLUT_AOA_CD=(-10=0.35|0=0.32|10=0.35)\nCD_GAIN=1\nANGLE=0\n[WING_1]\nNAME=Rear Wing\nCHORD=0.4\nSPAN=1.6\nPOSITION=0,0.6,-2.0\nLUT_AOA_CL=(-5=0|0=0.3|10=0.8|15=0.9)\nLUT_AOA_CD=(-5=0.02|0=0.05|10=0.12|15=0.2)\nCL_GAIN=1\nCD_GAIN=1\nANGLE=8\nYAW_CL_GAIN=-0.2\n',
    'electronics.ini': '[ABS]\nSLIP_RATIO_LIMIT=0.12\nPRESENT=0\nRATE_HZ=50\n[TRACTION_CONTROL]\nSLIP_RATIO_LIMIT=0.1\nPRESENT=0\nRATE_HZ=100\nMIN_SPEED_KMH=20\n',
    'setup.ini': '[PRESSURE_LF]\nMIN=20\nMAX=34\n[CAMBER_LF]\nMIN=-3.0\nMAX=0\n',
    'colliders.ini': '[COLLIDER_0]\nCENTRE=0,-0.25,0.1\nSIZE=1.9,0.1,3.8\n',
  };
  const dataDir = join(tmp, 'synthetic', 'data');
  for (const [f, text] of Object.entries(INI)) write(join(dataDir, f), text);
  {
    const p = acPhysicsPatch(dataDir, { base: 'bmw-m1-procar' });
    const v = (path: string) => valueAt(p.file.profile, path);
    const base = VEHICLE_MODELS['bmw-m1-procar'].simProfile!;
    const eff = base.config.gearbox.efficiency;
    const soft = `config.tyreCompounds.${base.config.compoundSlots.soft}`;
    check('the patch passes the game\'s own check on its base', modSimProfile(base, p.file, 'mod:test/x').ok && p.profile.config.chassis.totalMassKg === 1100);
    check('mass, the inertia box, the steering lock and ratio', v('config.chassis.totalMassKg') === 1100 && near(v('config.chassis.inertia.yaw'), (1100 / 12) * (1.8 ** 2 + 4.2 ** 2), 1e-5) && near(v('config.chassis.maxRoadWheelDeg'), 18) && v('steerRatio') === 15);
    const boost = turboSteadyBoost({ maxBoost: 0.8, referenceRpm: 5000, gamma: 2, spoolUpS: 1, spoolRefRpm: 5000, spoolDownS: 1, displayMaxBoostBar: 1 }, 5000);
    const kw5000 = lutAt(v('config.engine.powerCurve') as [number, number][], 5000);
    check('power.lut as crank power: torque × the full boost ÷ the efficiency', near(kw5000, (((330 * (1 + boost)) / eff) * 5000 * Math.PI) / 30 / 1000, 1e-5), `${kw5000.toFixed(1)} kW at 5000 rpm`);
    check('a turbo on a base without one: its boost in the curve, its lag listed as not carried', p.unmapped.some((u) => /TURBO_0/.test(u.from) && /no turbo/.test(u.why)) && v('turbo') !== true);
    check('the gears, the final drive, the limiter and the shift points', JSON.stringify(v('config.gearbox.ratios')) === '[2.8,2,1.55,1.25,1.05]' && v('config.gearbox.finalDrive') === 3.9 && v('config.gearbox.gears.redline_rpm') === 8500 && v('config.gearbox.gears.upshift_rpm') === 8200);
    check('the overrun line from nothing at idle', JSON.stringify((v('config.engine.coastCurve') as number[][]).slice(0, 3)) === '[[0,0],[1000,0],[8000,100]]');
    check('the differential, the brakes and their bias', v('config.differential.settings.power') === 0.4 && v('config.brakes.maxTorqueNm') === 2600 && v('config.brakes.front_bias') === 0.62);
    check('springs, bars, dampers and the hardpoints', v('config.suspensions.front.springs.wheel_rate') === 120000 && v('config.suspensions.rear.arb') === 30000 && JSON.stringify((v('config.suspensions.front.hardpoints') as number[][])[4]) === '[0.1,0.18,0]' && v('config.suspensions.dampers_controller.front.base.slow_rebound') === 6000);
    check('the tyres: sizes per axle, grip at FZ0 and its load law', v(`${soft}.front.width`) === 0.25 && v(`${soft}.rear.width`) === 0.28 && near(v(`${soft}.modelData.Dy0`), 1.4, 1e-5) && near(v(`${soft}.modelData.lsExpY`), 0.85, 1e-5));
    check("the rear's own grip, where the base keeps a rear value", near(v(`${soft}.rearOverride.modelData.Dy0`), 1.38, 1e-5));
    check('the rear wing in the base\'s rear wing, with its tables; the body as constants', v('config.aero.wings[1].area') === 0.64 && v('config.aero.wings[1].angleDeg') === 8 && v('config.aero.wings[0].area') === 0 && near(v('config.aero.drag'), 1.4 * 0.32, 1e-5));
    check("the garage's pressures and front camber from setup.ini", JSON.stringify(v('coldPsiRange')) === '[20,34]' && JSON.stringify(v('frontCamberRange')) === '[-3,0]');
    check('the plank under the colliders', JSON.stringify(v('config.aero.plank')) === JSON.stringify({ y: -0.3, frontZ: 2, rearZ: -1.8 }), JSON.stringify(v('config.aero.plank')));
    const fwd = join(tmp, 'synthetic-fwd', 'data');
    for (const [f, text] of Object.entries(INI)) write(join(fwd, f), f === 'drivetrain.ini' ? text.replace('TYPE=RWD', 'TYPE=FWD') : text);
    const liana = acPhysicsPatch(fwd, { base: 'liana' });
    check('front-wheel drive on a base with the switch', valueAt(liana.file.profile, 'config.drivenAxle') === 'front');
    check("a wishbone car on a base whose front is a strut: the base's front geometry, said why", liana.unmapped.some((u) => /\[FRONT\] TYPE=DWB hardpoints/.test(u.from)) && valueAt(liana.file.profile, 'config.suspensions.rear.hardpoints') !== undefined);
    check('wings on a base without any: folded into the body\'s lift and drag', near(valueAt(liana.file.profile, 'config.aero.drag'), 1.4 * 0.32 + 0.64 * 0.106, 1e-4), String(valueAt(liana.file.profile, 'config.aero.drag')));
    const r33 = acPhysicsPatch(dataDir, { base: 'nissan-r33-jgtc' });
    check("a base with a ride-height map: the body in the map's coefficients, flat grids", near(valueAt(r33.file.profile, 'config.aero.rhMap.cdA'), 1.4 * 0.32, 1e-5) && (valueAt(r33.file.profile, 'config.aero.rhMap.cl') as number[][]).every((row) => row.every((x) => x === 1)));
    check('a turbo on a base with one: its own boost law', valueAt(r33.file.profile, 'config.engine.turbo.maxBoost') === 0.8 && valueAt(r33.file.profile, 'turbo') === true);
    // No ers.ini on a hybrid base: no motor, no harvest, not only no HUD
    for (const model of ['f12026-car', 'lc-lmdh'] as const) {
      const e = acPhysicsPatch(dataDir, { base: model }).profile;
      const modes = Object.values(e.config.performanceModes);
      check(`no ers.ini on ${model}: no deploy, no harvest of any kind`, !e.hasErs && e.config.ers.ERS_MAX_DEPLOY === 0 && e.config.ers.maxHarvestW === 0 && e.config.ers.topGearLiftHarvestW === 0 && modes.every((x) => x.topGearClipHarvestW === 0 && x.partThrottleHarvestW === 0));
    }

    const drive = await driveCheck(p.profile);
    check('it drives: no spin flat out, a plausible top speed, braking', drive.ok, `0–100 ${drive.t100.toFixed(2)} s, ${drive.topKmh.toFixed(0)} km/h, ${drive.brakeFromKmh}→0 in ${drive.brakeM.toFixed(0)} m (${drive.brakeG.toFixed(2)} g) ${drive.problems.join('; ')}`);
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log("\n== Real cars' data onto their own models (REALISM_REF)");
  {
    // What the patch takes from a car's own data must be what the parity-checked config took from it
    const own: [string, VehicleModelId, string[]][] = [
      ['pddw_bmw_procar_m1', 'bmw-m1-procar', []],
      ['pfa_vw_scirocco_53b', 'vw-scirocco-gtx', []],
      ['pfa_porsche_934t_rsr_rr', 'porsche-934-rsr', []],
      ['mt_mtr_496r', 'mtr-496r', []],
    ];
    const PATHS = [
      'config.chassis.totalMassKg', 'config.chassis.wheelbase', 'config.chassis.frontWeightFraction', 'config.chassis.trackWidthFront',
      'config.chassis.trackWidthRear', 'config.chassis.cgHeight', 'config.chassis.inertia.yaw', 'config.chassis.unsprungMassFront',
      'config.chassis.maxRoadWheelDeg', 'config.gearbox.finalDrive', 'config.gearbox.gears.redline_rpm', 'config.engine.idleRpm',
      'config.engine.inertia', 'config.suspensions.front.springs.wheel_rate', 'config.suspensions.rear.springs.wheel_rate',
      'config.suspensions.front.arb', 'config.suspensions.rear.arb', 'config.suspensions.front.droopTravel', 'config.brakes.maxTorqueNm',
    ];
    for (const [folder, model] of own) {
      const dir = modDir(folder);
      if (!existsSync(dir)) {
        console.log(`SKIP  ${folder}: its data isn't on this machine`);
        continue;
      }
      const p = acPhysicsPatch(dir, { base: model });
      const base = VEHICLE_MODELS[model].simProfile!;
      const off = PATHS.filter((path) => !near(valueAt(p.file.profile, path), valueAt(base, path) as number, 2e-3));
      const ratios = JSON.stringify(valueAt(p.file.profile, 'config.gearbox.ratios')) === JSON.stringify(base.config.gearbox.ratios);
      // At the data's own points, where both curves are exact (a config may add points between them)
      const curve = p.profile.config.engine.powerCurve.filter(([rpm]) => rpm > 0 && rpm <= base.config.gearbox.gears.redline_rpm);
      const worst = Math.max(...curve.map(([rpm, kw]) => Math.abs(kw / lutAt(base.config.engine.powerCurve, rpm) - 1)));
      check(`${model} from its own data: ${PATHS.length} values, the gears and the power curve as its config's`, !off.length && ratios && worst < 5e-3, off.map((path) => `${path} ${valueAt(p.file.profile, path)} vs ${valueAt(base, path)}`).join('; ') + ` power ±${(worst * 100).toFixed(2)} %`);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  console.log('\n== The automatic preset on real cars, against their presets (AC_CARS_DIR)');
  {
    const root = process.env.AC_CARS_DIR;
    if (!root || !existsSync(root) || !uv) console.log(`SKIP  ${!uv ? 'uv is not on this machine' : 'AC_CARS_DIR names no folder of Assetto Corsa cars'}`);
    else {
      for (const folder of readdirSync(root).sort()) {
        const d = detect(join(root, folder));
        const det = d?.detected as Record<string, unknown> | undefined;
        const preset = d?.preset as { paint: string[]; windscreen: string[]; tyreMaterials: string[]; tyrePrefix: string | null; paintByTable: string[] } | undefined;
        if (!det || !preset) {
          console.log(`SKIP  ${folder}: ${!d ? 'not read' : 'no preset of its own to compare with'}`);
          continue;
        }
        const paints = [...preset.paint, ...preset.paintByTable];
        const tyres = det.tyreMaterials as string[];
        const tyreOk = preset.tyreMaterials.length ? tyres.every((t) => preset.tyreMaterials.includes(t)) : (det.tyreNodes as string[]).every((n) => n.startsWith(preset.tyrePrefix ?? '\0'));
        check(`${folder}: the preset's paint, tyres and windscreen`, paints.includes(det.paint as string) && tyreOk && preset.windscreen.includes(det.windscreen as string), `paint ${det.paint}, tyres ${tyres.join('+')}, glass ${det.windscreen}`);
      }
    }
  }

  rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll AC car importer checks passed');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
