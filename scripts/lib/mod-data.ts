/**
 * Reads a car mod's unpacked data folder (Assetto Corsa compatible: `car.ini`, `suspensions.ini`, `tyres.ini`, `*.lut`,
 * …) for the scripts that compare a car's config with the data it was taken from. The folders are local reference
 * material, not part of the repository: `modDir` says where one would be, and a suite skips a car whose folder is absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** One data folder: its ini files by section and key (both upper case), its tables by file name */
export class ModData {
  private readonly inis = new Map<string, Record<string, IniSection>>();

  constructor(readonly dir: string) {}

  get present(): boolean {
    return existsSync(join(this.dir, 'car.ini')) || existsSync(join(this.dir, 'tyres.ini'));
  }

  has(file: string): boolean {
    return existsSync(join(this.dir, file));
  }

  ini(file: string): Record<string, IniSection> {
    let parsed = this.inis.get(file);
    if (parsed) return parsed;
    parsed = {};
    let section: IniSection = {};
    let open = '';
    for (const raw of readFileSync(join(this.dir, file), 'utf8').split(/\r?\n/)) {
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
    return this.has(nameOrInline) ? parseLut(readFileSync(join(this.dir, nameOrInline), 'utf8')) : [];
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
