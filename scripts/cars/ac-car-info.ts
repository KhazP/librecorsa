/**
 * What an Assetto Corsa car folder says about itself, apart from its physics: its `ui/ui_car.json` (name, brand, class,
 * tags, year, specs, author), whether it is Kunos's own (the base game's cars, which are never converted), and what its
 * author allows (ui_car.json's licence and the text files beside the car, read by scripts/mods/lib/licences.ts). The car importer
 * (scripts/mods/importers/ac-car.ts) and the physics patch (ac-physics-patch.ts) read it.
 */
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { mergeReadings, readLicenceEntry, statementFiles, type LicenceReading, type Statement } from '../mods/lib/licences';

export interface UiCar {
  name?: string;
  brand?: string;
  /** AC's class: `race`, `street`, … */
  class?: string;
  tags: string[];
  /** The car whose variant it is, by folder (`parent`): AC lists them together */
  parent?: string;
  year?: number;
  country?: string;
  author?: string;
  url?: string;
  version?: string;
  description?: string;
  specs: { bhp?: string; torque?: string; weight?: string; topspeed?: string; acceleration?: string; pwratio?: string };
  /** A licence the file states (`license` or `licence`) */
  license?: string;
}

/** Raw line breaks and tabs inside strings escaped, as JSON wants them (mods often leave them raw) */
function escapeControlChars(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString && c === '\\') {
      out += c + (text[++i] ?? '');
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString && c < ' ') out += c === '\n' ? '\\n' : c === '\t' ? '\\t' : c === '\r' ? '' : ' ';
    else out += c;
  }
  return out;
}

/**
 * A JSON object as mods write it: a byte-order mark, raw line breaks in strings and trailing commas are let pass; past
 * those, its `"key": "text"` and `"key": number` pairs are read one by one. {} when nothing can be read
 */
export function parseLooseJson(text: string): Record<string, unknown> {
  const t = text.replace(/^﻿/, '');
  const fixed = escapeControlChars(t);
  for (const attempt of [t, fixed, fixed.replace(/,(\s*[}\]])/g, '$1')]) {
    try {
      const v: unknown = JSON.parse(attempt);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // the next, more forgiving reading
    }
  }
  const out: Record<string, unknown> = {};
  for (const m of t.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) out[m[1]] ??= m[2];
  for (const m of t.matchAll(/"(\w+)"\s*:\s*(-?\d+(?:\.\d+)?)/g)) out[m[1]] ??= Number(m[2]);
  return out;
}

/** HTML entities and tags (AC's descriptions use `<br>` and `&#39;`) as plain text */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? plainText(v) : typeof v === 'number' ? String(v) : undefined);

/** A car's ui_car.json, read as AC reads it (absent: no name, no tags) */
export function parseUiCar(text: string): UiCar {
  const j = parseLooseJson(text);
  const specs = (j.specs && typeof j.specs === 'object' ? j.specs : {}) as Record<string, unknown>;
  const yearText = str(j.year);
  const year = yearText && /^\d{4}/.test(yearText) ? Number(yearText.slice(0, 4)) : undefined;
  return {
    name: str(j.name),
    brand: str(j.brand),
    class: str(j.class)?.toLowerCase(),
    tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === 'string').map((t) => plainText(t)) : [],
    parent: str(j.parent)?.toLowerCase(),
    year,
    country: str(j.country),
    author: str(j.author),
    url: str(j.url),
    version: str(j.version),
    description: str(j.description),
    specs: Object.fromEntries(['bhp', 'torque', 'weight', 'topspeed', 'acceleration', 'pwratio'].map((k) => [k, str(specs[k])]).filter(([, v]) => v)),
    license: str(j.license ?? j.licence),
  };
}

export function readUiCar(carDir: string): UiCar {
  const path = join(carDir, 'ui', 'ui_car.json');
  return parseUiCar(existsSync(path) ? readFileSync(path, 'utf8') : '{}');
}

/**
 * The base game's own cars, by folder: Kunos's original release and its later free cars. Its paid packs' cars all
 * start with `ks_`
 */
const KUNOS_CARS = new Set([
  'abarth500', 'abarth500_s1', 'bmw_1m', 'bmw_1m_s3', 'bmw_m3_e30', 'bmw_m3_e30_drift', 'bmw_m3_e30_dtm', 'bmw_m3_e30_gra',
  'bmw_m3_e30_s1', 'bmw_m3_e92', 'bmw_m3_e92_drift', 'bmw_m3_e92_s1', 'bmw_m3_gt2', 'bmw_z4', 'bmw_z4_drift', 'bmw_z4_gt3',
  'bmw_z4_s1', 'ferrari_312t', 'ferrari_458', 'ferrari_458_gt2', 'ferrari_458_s3', 'ferrari_599xxevo', 'ferrari_f40',
  'ferrari_f40_s3', 'ferrari_laferrari', 'ktm_xbow_r', 'lotus_2_eleven', 'lotus_2_eleven_gt4', 'lotus_49', 'lotus_98t',
  'lotus_elise_sc', 'lotus_elise_sc_s1', 'lotus_elise_sc_s2', 'lotus_evora_gtc', 'lotus_evora_gte', 'lotus_evora_gte_carbon',
  'lotus_evora_gx', 'lotus_evora_s', 'lotus_evora_s_s2', 'lotus_exige_240', 'lotus_exige_240_s3', 'lotus_exige_s',
  'lotus_exige_s_roadster', 'lotus_exige_scura', 'lotus_exige_v6_cup', 'lotus_exos_125', 'lotus_exos_125_s1', 'mclaren_mp412c',
  'mclaren_mp412c_gt3', 'mercedes_sls', 'mercedes_sls_gt3', 'p4-5_2011', 'pagani_huayra', 'pagani_zonda_r', 'ruf_yellowbird',
  'shelby_cobra_427sc', 'tatuusfa1',
]);

/**
 * Whether a name (a folder, a model's or a sound bank's file name without its extension) is one of Kunos's cars: a
 * "ks_" car of the game or its packs, or one of the base game's, its lower LODs (`_b`, `_lod_c`, to D) included
 */
function kunosCarName(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('ks_') || KUNOS_CARS.has(n) || KUNOS_CARS.has(n.replace(/_lod_?[b-d]$|_[b-d]$/, ''));
}

/** A folder's file names (none when it isn't there) */
const filesIn = (dir: string): string[] => (existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : []);

/**
 * Why a car folder is Kunos's own content (the base game's cars and its packs'), or null. Such a car is never
 * converted, whether or not its files are encrypted, and neither is a mod built from one, however its folder is named:
 * - its folder's name ("ks_…", or one of the base game's cars);
 * - its models: any .kn5 in the folder, or that lods.ini names (`lodFiles`), named for a Kunos car;
 * - ui_car.json: a `parent` that is a Kunos car, or an author or link naming Kunos;
 * - its sound: a bank in sfx/ named for a Kunos car, or sfx/GUIDs.txt playing a Kunos car's events (`event:/cars/ks_…`)
 */
export function kunosContent(carDir: string, ui: UiCar, lodFiles: string[] = []): string | null {
  const folder = basename(resolve(carDir)).toLowerCase();
  if (folder.startsWith('ks_')) return `"${folder}" is one of Kunos's own cars (a "ks_" car from the game or its packs)`;
  if (KUNOS_CARS.has(folder)) return `"${folder}" is one of the base game's own cars`;
  const stem = (f: string) => basename(f.replace(/\\/g, '/')).replace(/\.[^.]*$/, '');
  const model = [...filesIn(carDir).filter((f) => /\.kn5$/i.test(f)), ...lodFiles].find((f) => kunosCarName(stem(f)));
  if (model) return `its model "${model}" is one of Kunos's own cars'`;
  if (ui.parent && kunosCarName(ui.parent)) return `its ui_car.json makes it a version of "${ui.parent}", one of Kunos's own cars`;
  if (/kunos/i.test(`${ui.author ?? ''} ${ui.url ?? ''}`) || /assettocorsa\.net|kunos-simulazioni\.com/i.test(ui.url ?? '')) {
    return 'its ui_car.json names Kunos Simulazioni as the author';
  }
  const sfx = join(carDir, 'sfx');
  const bank = filesIn(sfx).find((f) => /\.bank$/i.test(f) && kunosCarName(stem(f)));
  if (bank) return `its sound bank "sfx/${bank}" is one of Kunos's own cars'`;
  const guids = filesIn(sfx).find((f) => /^guids\.txt$/i.test(f));
  if (guids) {
    const text = readFileSync(join(sfx, guids)).subarray(0, 1 << 20).toString('latin1');
    const used = [...text.matchAll(/event:\/cars\/([\w.-]+)/gi)].map((m) => m[1]).find(kunosCarName);
    if (used) return `its sfx/${guids} plays the sounds of "${used}", one of Kunos's own cars`;
  }
  return null;
}

/**
 * A model a car's data names (lods.ini's FILE), as a path inside the car folder with '/' between its folders, or null:
 * not a .kn5, an absolute path, a drive, a '..' step, a link that leads out of the folder, or no such file. As
 * port_ac_car.py `car_model_path` reads it
 */
export function carModelPath(carDir: string, name: string): string | null {
  const raw = name.trim();
  const parts = raw.replace(/\\/g, '/').split('/');
  if (!/\.kn5$/i.test(raw) || parts[0] === '' || /^[A-Za-z]:/.test(parts[0]) || parts.includes('..')) return null;
  const rel = parts.filter((p) => p && p !== '.');
  const root = realpathSync(carDir);
  const full = join(root, ...rel);
  if (!rel.length || !existsSync(full) || !statSync(full).isFile()) return null;
  const real = realpathSync(full);
  return real.startsWith(root + sep) ? rel.join('/') : null;
}

/**
 * The car's main model, as port_ac_car.py `find_kn5` finds it: <folder name>.kn5, else the file lods.ini names for
 * LOD_0 when it is a model inside the folder (`carModelPath`), else the largest kn5 in the folder that is neither its
 * collider nor a lower LOD (nor a link out of the folder). `lod0`: lods.ini's [LOD_0] FILE, when the data has one
 */
export function findKn5(carDir: string, lod0?: string): string | null {
  const folder = basename(resolve(carDir));
  if (existsSync(join(carDir, `${folder}.kn5`))) return `${folder}.kn5`;
  const named = lod0 ? carModelPath(carDir, lod0) : null;
  if (named) return named;
  const lower = /(^collider|_lod_?[b-z]|_[b-z])\.kn5$/i;
  const found = readdirSync(carDir).filter((f) => /\.kn5$/i.test(f) && !lower.test(f) && carModelPath(carDir, f) !== null);
  return found.length ? found.reduce((a, b) => (statSync(join(carDir, a)).size >= statSync(join(carDir, b)).size ? a : b)) : null;
}

/** Whether a kn5 model can be read: a plain one starts with "sc6969"; an encrypted one (the game's, some paid mods') doesn't */
export function kn5IsPlain(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(6);
    readSync(fd, head, 0, 6, 0);
    return head.toString('latin1') === 'sc6969';
  } finally {
    closeSync(fd);
  }
}

/**
 * What the mod's author allows (scripts/mods/lib/licences.ts): ui_car.json's `license`, read as a licence field, and
 * every text file beside the car (readme, licence, credits, notes), each read whole. A mod that states nothing is the
 * author's alone. Its skins' own statements are the importer's to add
 */
export function readLicence(carDir: string, ui: UiCar): { reading: LicenceReading; statements: Statement[] } {
  const statements = statementFiles(carDir, { anyText: true });
  const reading = mergeReadings([...(ui.license ? [readLicenceEntry(ui.license)] : []), ...statements.map((s) => s.reading)]);
  if (!reading.licences.length && !reading.problems.length) reading.problems.push('the mod states no licence');
  return { reading, statements };
}
