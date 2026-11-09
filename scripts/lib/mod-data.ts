/**
 * Reads a car mod's data (Assetto Corsa compatible: `car.ini`, `suspensions.ini`, `tyres.ini`, `*.lut`, …), unpacked or
 * packed, for the scripts that compare a car's config with the data it was taken from or start a config from one. The
 * folders are local reference material, not part of the repository: `modDir` says where one would be, and a suite skips
 * a car whose folder is absent.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { REALISM_REF } from '../ai/lib/references';

/** A table of (x, y) points, x ascending */
export type Lut = ReadonlyArray<readonly [number, number]>;
export type IniSection = Record<string, string>;

/** Where a mod's unpacked data folder is kept on a machine that has it */
export const modDir = (id: string): string => join(REALISM_REF, 'mods', id);

const stripComment = (line: string): string => line.replace(/(;|\/\/).*$/, '').trim();

/** `x|y` lines of a table file */
export function parseLut(text: string): Lut {
  const out: [number, number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const [x, y] = line.split('|').map((v) => Number(v.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/** A table written inline, `(0=2.1|1000=2.0|…)`, possibly over several lines */
export function parseInlineLut(text: string): Lut {
  const out: [number, number][] = [];
  for (const pair of text.replace(/[()]/g, '').split('|')) {
    const [x, y] = pair.split('=').map((v) => Number(v.trim()));
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

const i32 = (x: number): number => x | 0;
/** Integer division that rounds toward zero */
const cdiv = (a: number, b: number): number => Math.trunc(a / b);

/** The key a packed `data.acd` is written with: eight bytes worked out from its car folder's name */
function packedDataKey(folderName: string): number[] {
  const s = [...folderName.toLowerCase()].map((c) => c.charCodeAt(0));
  const n = s.length;
  const k = [i32(s.reduce((a, b) => a + b, 0)), 0, 0, -125, 66, 101, 171, 171];
  for (let i = 0; i < n - 1; i += 2) k[1] = i32(Math.imul(s[i], k[1]) - s[i + 1]);
  for (let i = 1; i < n - 3; i += 3) k[2] = i32(-27 - s[i - 1] + cdiv(Math.imul(s[i], k[2]), s[i + 1] + 27));
  for (let i = 1; i < n; i++) k[3] = i32(k[3] - s[i]);
  for (let i = 1; i < n - 4; i += 4) k[4] = i32(Math.imul(s[i - 1] + 15, Math.imul(s[i] + 15, k[4])) + 22);
  for (let i = 0; i < n - 2; i += 2) k[5] = i32(k[5] - s[i]);
  for (let i = 0; i < n - 2; i += 2) k[6] = k[6] - cdiv(k[6], s[i]) * s[i];
  for (let i = 0; i < n - 1; i++) k[7] = i32(cdiv(k[7], s[i]) + s[i + 1]);
  return [...k.map((v) => String(v & 0xff)).join('-')].map((c) => c.charCodeAt(0));
}

/** The files of a packed `data.acd` ({name → text}); `folderName` is the car folder it shipped in */
function readPackedData(path: string, folderName: string): Map<string, string> {
  const key = packedDataKey(folderName);
  const d = readFileSync(path);
  const out = new Map<string, string>();
  let o = 0;
  while (o + 4 <= d.length) {
    const nameLen = d.readInt32LE(o);
    o += 4;
    // Versioned archives start with a header word
    if (nameLen < 0) {
      o += 4;
      continue;
    }
    const name = d.toString('latin1', o, o + nameLen);
    o += nameLen;
    const len = d.readInt32LE(o);
    o += 4;
    let text = '';
    for (let i = 0; i < len; i++) text += String.fromCharCode((d[o + 4 * i] - key[i % key.length]) & 0xff);
    o += 4 * len;
    out.set(name.toLowerCase(), text);
  }
  return out;
}

/**
 * The data files of a car ({lower-case name → text}) from any of: an unpacked data folder, a car folder holding
 * `data/`, or a car folder holding a packed `data.acd`. Empty when there is none.
 */
export function readCarData(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  const unpacked = existsSync(join(dir, 'data')) && statSync(join(dir, 'data')).isDirectory() ? join(dir, 'data') : dir;
  const names = readdirSync(unpacked);
  if (names.some((f) => /\.ini$/i.test(f))) {
    for (const f of names) if (/\.(ini|lut|2dlut)$/i.test(f)) out.set(f.toLowerCase(), readFileSync(join(unpacked, f), 'latin1'));
    return out;
  }
  const packed = join(dir, 'data.acd');
  return existsSync(packed) ? readPackedData(packed, basename(resolve(dir))) : out;
}

/** One car's data: its ini files by section and key (both upper case), its tables by file name */
export class ModData {
  private readonly files: Map<string, string>;
  private readonly inis = new Map<string, Record<string, IniSection>>();

  constructor(readonly dir: string) {
    this.files = readCarData(dir);
  }

  get present(): boolean {
    return this.files.has('car.ini') || this.files.has('tyres.ini');
  }

  has(file: string): boolean {
    return this.files.has(file.toLowerCase());
  }

  /** The names of the ini file's sections, in upper case */
  sections(file: string): string[] {
    return Object.keys(this.ini(file));
  }

  ini(file: string): Record<string, IniSection> {
    let parsed = this.inis.get(file);
    if (parsed) return parsed;
    parsed = {};
    let section: IniSection = {};
    let open = '';
    for (const raw of (this.files.get(file.toLowerCase()) ?? '').split(/\r?\n/)) {
      const line = stripComment(raw);
      if (!line) continue;
      const head = /^\[(.+)\]$/.exec(line);
      if (head) {
        section = parsed[head[1].trim().toUpperCase()] ??= {};
        open = '';
        continue;
      }
      const eq = line.indexOf('=');
      // A table written inline runs on over the following lines until its bracket closes
      if (open) {
        section[open] += line;
        if (line.includes(')')) open = '';
        continue;
      }
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().toUpperCase();
      const value = line.slice(eq + 1).trim();
      section[key] = value;
      if (value.startsWith('(') && !value.includes(')')) open = key;
    }
    this.inis.set(file, parsed);
    return parsed;
  }

  /** A key's text, `undefined` when the section or key is absent */
  text(file: string, section: string, key: string): string | undefined {
    return this.ini(file)[section.toUpperCase()]?.[key.toUpperCase()];
  }

  /** A key's number; NaN when absent, so a comparison against it fails */
  num(file: string, section: string, key: string): number {
    const v = this.text(file, section, key);
    return v === undefined || v === '' ? NaN : Number(v);
  }

  /** A comma-separated key (`INERTIA=1.9,0.9,4.5`, a hardpoint) */
  vec(file: string, section: string, key: string): number[] {
    return (this.text(file, section, key) ?? '').split(',').map((v) => Number(v.trim()));
  }

  /** A table: the file a key names, or the table written inline in its place */
  lut(nameOrInline: string | undefined): Lut {
    if (!nameOrInline) return [];
    if (nameOrInline.startsWith('(')) return parseInlineLut(nameOrInline);
    return parseLut(this.files.get(nameOrInline.toLowerCase()) ?? '');
  }

  /** The table a key points at */
  lutOf(file: string, section: string, key: string): Lut {
    return this.lut(this.text(file, section, key));
  }
}

/** Linear lookup, held at the ends */
export function lutAt(lut: Lut, x: number): number {
  if (!lut.length) return NaN;
  if (x <= lut[0][0]) return lut[0][1];
  for (let i = 1; i < lut.length; i++) {
    if (x <= lut[i][0]) {
      const [x0, y0] = lut[i - 1];
      const [x1, y1] = lut[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return lut[lut.length - 1][1];
}

/**
 * Largest difference between two tables over the range both cover, read at every point of either (so a table that
 * leaves out a point lying on its neighbours' line still matches)
 */
export function lutGap(a: Lut, b: Lut): number {
  if (!a.length || !b.length) return Infinity;
  const lo = Math.max(a[0][0], b[0][0]);
  const hi = Math.min(a[a.length - 1][0], b[b.length - 1][0]);
  let gap = 0;
  for (const [x] of [...a, ...b]) {
    if (x < lo || x > hi) continue;
    gap = Math.max(gap, Math.abs(lutAt(a, x) - lutAt(b, x)));
  }
  return gap;
}
