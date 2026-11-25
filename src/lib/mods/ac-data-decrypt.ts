/**
 * Decrypts Assetto Corsa `data.acd` packed archives and parses INI configuration files and LUT tables.
 * Fully isomorphic (runs in browser Web Workers, Main Thread, and Node.js without node:fs / Buffer).
 */

export type LutTable = [number, number][];
export type IniSection = Record<string, string>;
export type IniFile = Record<string, IniSection>;

const i32 = (x: number): number => x | 0;
/** Integer division rounding toward zero */
const cdiv = (a: number, b: number): number => Math.trunc(a / b);

/**
 * Calculates the 8-byte decryption key from the car folder name (in lowercase).
 * Matches the official Assetto Corsa and Content Manager key-generation algorithm.
 */
export function packedDataKey(folderName: string): number[] {
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

/**
 * Decrypts a packed `data.acd` binary buffer.
 *
 * Archive format:
 * - Each entry starts with `nameLen: int32LE`. If `nameLen < 0`, it is a versioned header, skip next 4 bytes.
 * - `name: bytes[nameLen]` (ascii/latin1).
 * - `contentLen: int32LE`.
 * - `data: int32LE[contentLen]` where each char is `(byte[o + 4*i] - key[i % key.length]) & 0xff`.
 */
export function decryptDataAcd(data: ArrayBuffer | Uint8Array, folderName: string): Map<string, string> {
  const key = packedDataKey(folderName);
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Map<string, string>();
  let o = 0;

  while (o + 4 <= u8.length) {
    let nameLen = view.getInt32(o, true);
    o += 4;
    // Versioned archives start with a negative header word
    if (nameLen < 0) {
      if (o + 4 > u8.length) break;
      o += 4;
      continue;
    }
    if (o + nameLen > u8.length) break;

    let name = '';
    for (let i = 0; i < nameLen; i++) {
      name += String.fromCharCode(u8[o + i]);
    }
    o += nameLen;

    if (o + 4 > u8.length) break;
    const len = view.getInt32(o, true);
    o += 4;

    if (o + 4 * len > u8.length) break;
    let text = '';
    for (let i = 0; i < len; i++) {
      const rawByte = u8[o + 4 * i];
      const k = key[i % key.length];
      text += String.fromCharCode((rawByte - k) & 0xff);
    }
    o += 4 * len;

    out.set(name.toLowerCase(), text);
  }

  return out;
}

const stripComment = (line: string): string => line.replace(/(;|\/\/).*$/, '').trim();

/**
 * Parses a standard LUT table file (`x|y` per line).
 */
export function parseLut(text: string): LutTable {
  const out: [number, number][] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    const [xStr, yStr] = line.split('|').map((v) => v.trim());
    const x = Number(xStr);
    const y = Number(yStr);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/**
 * Parses an inline LUT string such as `(0=2.1|1000=2.0|...)`.
 */
export function parseInlineLut(text: string): LutTable {
  const out: [number, number][] = [];
  for (const pair of text.replace(/[()]/g, '').split('|')) {
    const [xStr, yStr] = pair.split('=').map((v) => v.trim());
    const x = Number(xStr);
    const y = Number(yStr);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
  }
  return out;
}

/**
 * Parses INI configuration text into uppercase section and key maps.
 * Handles multiline inline tables spanning across lines inside parentheses `(...)`.
 */
export function parseIni(text: string): IniFile {
  const parsed: IniFile = {};
  let currentSection: IniSection = {};
  let openMultilineKey = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;

    const sectionMatch = /^\[(.+)\]$/.exec(line);
    if (sectionMatch) {
      const secName = sectionMatch[1].trim().toUpperCase();
      currentSection = parsed[secName] ??= {};
      openMultilineKey = '';
      continue;
    }

    if (openMultilineKey) {
      currentSection[openMultilineKey] += line;
      if (line.includes(')')) openMultilineKey = '';
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    const value = line.slice(eq + 1).trim();
    currentSection[key] = value;
    if (value.startsWith('(') && !value.includes(')')) {
      openMultilineKey = key;
    }
  }

  return parsed;
}

/**
 * Accessor class for car mod configuration and data tables.
 */
export class AcModData {
  private readonly files: Map<string, string>;
  private readonly inis = new Map<string, IniFile>();

  constructor(files: Map<string, string> | Record<string, string>) {
    if (files instanceof Map) {
      this.files = new Map([...files.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    } else {
      this.files = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
    }
  }

  get present(): boolean {
    return this.files.has('car.ini') || this.files.has('tyres.ini');
  }

  get rawFiles(): Map<string, string> {
    return this.files;
  }

  has(filename: string): boolean {
    return this.files.has(filename.toLowerCase());
  }

  sections(filename: string): string[] {
    return Object.keys(this.ini(filename));
  }

  ini(filename: string): IniFile {
    const key = filename.toLowerCase();
    let cached = this.inis.get(key);
    if (cached) return cached;
    cached = parseIni(this.files.get(key) ?? '');
    this.inis.set(key, cached);
    return cached;
  }

  text(filename: string, section: string, key: string): string | undefined {
    return this.ini(filename)[section.toUpperCase()]?.[key.toUpperCase()];
  }

  num(filename: string, section: string, key: string, fallback = NaN): number {
    const val = this.text(filename, section, key);
    if (val === undefined || val === '') return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  vec(filename: string, section: string, key: string): number[] {
    const raw = this.text(filename, section, key) ?? '';
    return raw
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
  }

  lut(nameOrInline: string | undefined): LutTable {
    if (!nameOrInline) return [];
    if (nameOrInline.startsWith('(')) return parseInlineLut(nameOrInline);
    const content = this.files.get(nameOrInline.toLowerCase());
    return content ? parseLut(content) : [];
  }

  lutOf(filename: string, section: string, key: string): LutTable {
    return this.lut(this.text(filename, section, key));
  }
}
