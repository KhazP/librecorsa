/**
 * Assetto Corsa Web Mod Extractor and Pipeline.
 * Handles decompression of `.zip`, `.rar`, and folder drops, decrypts physics,
 * validates 3D model assets, and stores the custom car into IndexedDB.
 */

import * as fflate from 'fflate';
import { createExtractorFromData } from 'node-unrar-js';
import type { CarClassId, CarDefinition } from '@/lib/cars/car-registry';
import {
  decryptDataAcd,
  parseIni,
  AcModData,
} from './ac-data-decrypt';
import { mapAcPhysics } from './ac-physics-mapper';
import { parseKn5 } from './kn5-loader';
import { readCspKn5Footer } from './kn5-protection';
import { getAllCustomCars, saveCustomCar, type CustomCarRecord, type CustomCarSkin } from './mod-store';
import { registerCustomCarMod } from './dynamic-vehicle';
import { isTextureFile } from './texture-files';
import { withBasePath } from '@/lib/base-path';

export type ModImportStage =
  | 'reading'
  | 'extracting'
  | 'decrypting'
  | 'rigging'
  | 'saving'
  | 'done';

export interface ModImportProgress {
  stage: ModImportStage;
  message: string;
  percent: number; // 0 to 100
}

/**
 * Stable custom-car ID for a normalized source slug.
 *
 * Keep the historical ID for simple slugs and for an already-installed slug. Slugs that need
 * lossy sanitization get their normalized slug encoded after `--`, preventing names like
 * `test-road` and `test_road` from sharing a storage/registry key.
 */
export function customCarIdForSlug(
  slug: string,
  existingRecords: readonly Pick<CustomCarRecord, 'id' | 'slug'>[] = [],
): string {
  const normalizedSlug = slug.toLowerCase();
  const installedMatch = existingRecords.find((record) => record.slug?.toLowerCase() === normalizedSlug);
  if (installedMatch) return installedMatch.id;

  const baseId = `custom_${normalizedSlug.replace(/[^a-z0-9_]/g, '_')}`;
  const baseIsUnambiguous = /^[a-z0-9_]+$/.test(normalizedSlug) &&
    !existingRecords.some((record) => record.id === baseId);
  if (baseIsUnambiguous) return baseId;

  const encodedSlug = Array.from(normalizedSlug, (character) =>
    character.codePointAt(0)!.toString(16).padStart(6, '0'),
  ).join('');
  const encodedBaseId = `${baseId}--${encodedSlug}`;
  let candidateId = encodedBaseId;
  let collisionIndex = 2;
  while (existingRecords.some((record) => record.id === candidateId)) {
    candidateId = `${encodedBaseId}--${collisionIndex++}`;
  }
  return candidateId;
}

/** Drag-and-drop entries supply a path; a file from a directory picker has it already. */
export type ModFolderFile = File | { file: File; path: string };

type ModAsset = Blob | Uint8Array;

export interface ExtractedCarPackage {
  slug: string;
  title: string;
  subTitle?: string;
  author?: string;
  year?: number;
  classId?: CarClassId;
  specs?: Record<string, string>;
  files: Map<string, ModAsset>;
  primaryKn5Name: string;
  primaryKn5: ModAsset;
  badge?: ModAsset;
  preview?: ModAsset;
  skins?: CustomCarSkin[];
}

async function assetText(asset: ModAsset): Promise<string> {
  return asset instanceof Blob ? asset.text() : new TextDecoder().decode(asset);
}

function assetBlob(asset: ModAsset, type?: string): Blob {
  if (asset instanceof Blob) return type ? asset.slice(0, asset.size, type) : asset;
  return new Blob([asset as BlobPart], { type });
}

/**
 * Checks archive header magic bytes.
 */
function isZipHeader(header: Uint8Array): boolean {
  return header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04;
}

function isRarHeader(header: Uint8Array): boolean {
  return header.length >= 7 && header[0] === 0x52 && header[1] === 0x61 && header[2] === 0x72 && header[3] === 0x21 && header[4] === 0x1a && header[5] === 0x07;
}

function is7zHeader(header: Uint8Array): boolean {
  return (
    header.length >= 6 &&
    header[0] === 0x37 &&
    header[1] === 0x7a &&
    header[2] === 0xbc &&
    header[3] === 0xaf &&
    header[4] === 0x27 &&
    header[5] === 0x1c
  );
}

/**
 * Normalizes file path: replaces backslashes with slashes and strips leading slashes.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

/**
 * Decides whether a file in the mod archive is needed by LibreCorsa.
 * Excludes heavy FMOD audio banks (.bank), sound tracks, low-detail LOD kn5 meshes,
 * and large source archives that can exceed browser worker memory limits.
 */
export function isEssentialModFile(name: string): boolean {
  const lower = name.toLowerCase();
  // Exclude audio banks and sound tracks which can be hundreds of MBs and are not used by the web engine
  if (lower.endsWith('.bank') || lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg') || lower.endsWith('.flac')) {
    return false;
  }
  // Exclude low-detail LOD kn5 meshes and collider kn5
  if (lower.includes('_lod_b.kn5') || lower.includes('_lod_c.kn5') || lower.includes('_lod_d.kn5') || lower.includes('collider.kn5')) {
    return false;
  }
  // Exclude source files / nested archives
  if (lower.endsWith('.psd') || lower.endsWith('.pdn') || lower.endsWith('.xcf') || lower.endsWith('.zip') || lower.endsWith('.rar') || lower.endsWith('.7z')) {
    return false;
  }
  return true;
}

/**
 * Unpacks a ZIP archive into a map of files.
 * Uses synchronous decompression with filtering to avoid browser Web Worker OOM
 * and postMessage DataCloneError on large archives (>100MB).
 */
export async function unpackZip(
  buffer: ArrayBuffer | Uint8Array,
  onProgress?: (percent: number) => void
): Promise<Map<string, Uint8Array>> {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const fileMap = new Map<string, Uint8Array>();

  // Yield to allow browser UI thread to render the extraction progress state
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const unzipped = fflate.unzipSync(u8, {
      filter: (file) => isEssentialModFile(file.name),
    });
    for (const [rawPath, data] of Object.entries(unzipped)) {
      if (!rawPath.endsWith('/')) {
        fileMap.set(normalizePath(rawPath), data);
      }
    }
    onProgress?.(100);
    return fileMap;
  } catch (syncErr) {
    console.warn('unzipSync failed, attempting filtered async fallback:', syncErr);
    return new Promise((resolve, reject) => {
      fflate.unzip(
        u8,
        { filter: (file) => isEssentialModFile(file.name) },
        (err, unzipped) => {
          if (err) return reject(err);
          if (!unzipped) return resolve(fileMap);
          for (const [rawPath, data] of Object.entries(unzipped)) {
            if (!rawPath.endsWith('/') && data) {
              fileMap.set(normalizePath(rawPath), data);
            }
          }
          onProgress?.(100);
          resolve(fileMap);
        }
      );
    });
  }
}

/**
 * Unpacks a RAR archive into a map of files.
 */
export async function unpackRar(
  buffer: ArrayBuffer | Uint8Array,
  onProgress?: (percent: number) => void
): Promise<Map<string, Uint8Array>> {
  const arrayBuf = buffer instanceof Uint8Array
    ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    : buffer;

  let wasmBinary: ArrayBuffer | undefined;
  if (typeof window !== 'undefined') {
    try {
      const res = await fetch(withBasePath('/wasm/unrar.wasm'));
      if (res.ok) {
        wasmBinary = await res.arrayBuffer();
      }
    } catch (e) {
      console.warn('Could not fetch /wasm/unrar.wasm from public directory:', e);
    }
  }

  const extractor = await createExtractorFromData({
    data: arrayBuf as ArrayBuffer,
    ...(wasmBinary ? { wasmBinary } : {}),
  });

  const list = extractor.getFileList();
  const fileHeaders = [...list.fileHeaders].filter((h) => !h.flags.directory);

  // We find candidate files for car:
  // Either extract all, or find relevant prefix
  let carPrefix = '';
  for (const h of fileHeaders) {
    const norm = normalizePath(h.name);
    const m = norm.match(/(?:^|content\/cars\/)([^/]+)\/(data\.acd|data\/car\.ini)$/i);
    if (m) {
      carPrefix = norm.slice(0, norm.length - m[2].length);
      break;
    }
  }

  // Filter files belonging to this car and exclude non-essential files
  const targetHeaders = (carPrefix
    ? fileHeaders.filter((h) => normalizePath(h.name).startsWith(carPrefix))
    : fileHeaders
  ).filter((h) => isEssentialModFile(h.name));

  const targetNames = targetHeaders.map((h) => h.name);
  onProgress?.(30);

  const extracted = extractor.extract({ files: targetNames });
  const fileMap = new Map<string, Uint8Array>();

  let count = 0;
  for (const f of extracted.files) {
    if (f.extraction) {
      fileMap.set(normalizePath(f.fileHeader.name), f.extraction);
    }
    count++;
    if (onProgress && targetNames.length > 0) {
      onProgress(30 + Math.floor((count / targetNames.length) * 70));
    }
  }

  return fileMap;
}

/**
 * Unpacks a 7z archive into a map of files using libarchive-wasm.
 */
export async function unpack7z(
  input: Blob | ArrayBuffer | Uint8Array,
  onProgress?: (percent: number) => void
): Promise<Map<string, Blob>> {
  const fileMap = new Map<string, Blob>();
  onProgress?.(10);

  const { ArchiveReader, libarchiveWasm } = await import('./libarchive');

  let locateFile: ((file: string) => string) | undefined;
  let wasmBinary: ArrayBuffer | undefined;

  if (typeof window !== 'undefined') {
    locateFile = (file: string) => withBasePath(`/wasm/${file}`);
    try {
      const res = await fetch(withBasePath('/wasm/libarchive.wasm'));
      if (res.ok) {
        wasmBinary = await res.arrayBuffer();
      }
    } catch (e) {
      console.warn('Could not pre-fetch /wasm/libarchive.wasm:', e);
    }
  } else {
    // Node.js environment (tests / CLI)
    try {
      const nodePath = await import('path');
      const nodeFs = await import('fs');
      const wasmPath = nodePath.resolve(process.cwd(), 'public/wasm/libarchive.wasm');
      if (nodeFs.existsSync(wasmPath)) {
        const buf = nodeFs.readFileSync(wasmPath);
        wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      locateFile = (file: string) => nodePath.resolve(process.cwd(), 'public/wasm', file);
    } catch {}
  }

  const mod = await libarchiveWasm({
    ...(locateFile ? { locateFile } : {}),
    ...(wasmBinary ? { wasmBinary } : {}),
  });

  onProgress?.(25);

  const reader = await ArchiveReader.open(mod, input instanceof ArrayBuffer ? new Uint8Array(input) : input);
  try {
    // 7z is often solid: a small archive can contain hundreds of megabytes of copies of the same texture.
    // Keep decompressed assets as Blobs, not live JS buffers, and share byte-identical large textures.
    const sharedTextures = new Map<string, Blob>();
    const sharedChunks = new Map<string, Blob>();
    const digest = globalThis.crypto?.subtle;
    let count = 0;
    for (const entry of reader.entries()) {
      const path = normalizePath(entry.getPathname());
      if (entry.getFiletype() === 'File' && isEssentialModFile(path)) {
        const size = entry.getSize();
        const hash = digest && size >= 1024 * 1024 && isTextureFile(path)
          ? [String(size)]
          : undefined;
        const parts: Blob[] = [];
        for (const chunk of entry.readChunks()) {
          if (hash && digest) {
            const sum = new Uint8Array(await digest.digest('SHA-256', chunk));
            const chunkKey = Array.from(sum, (byte) => byte.toString(16).padStart(2, '0')).join('');
            hash.push(chunkKey);
            // Reuse known chunks before creating a Blob, so even transient copies are avoided.
            const existing = sharedChunks.get(chunkKey);
            if (existing) {
              parts.push(existing);
              continue;
            }
            const part = new Blob([chunk]);
            sharedChunks.set(chunkKey, part);
            parts.push(part);
          } else {
            parts.push(new Blob([chunk]));
          }
        }
        const key = hash?.join(':');
        const existing = key ? sharedTextures.get(key) : undefined;
        const blob = existing ?? new Blob(parts);
        if (key && !existing) sharedTextures.set(key, blob);
        fileMap.set(path, blob);
      }
      count++;
      if (count % 25 === 0) {
        onProgress?.(25 + Math.min(70, Math.floor(count * 0.4)));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    reader.free();
  }
  onProgress?.(100);
  return fileMap;
}

/**
 * Indexes files from a folder without copying disk-backed File objects into memory.
 */
export function readDroppedFiles(
  files: readonly ModFolderFile[],
  onProgress?: (percent: number) => void
): Map<string, Blob> {
  const fileMap = new Map<string, Blob>();
  let loaded = 0;

  for (const entry of files) {
    const file = 'file' in entry ? entry.file : entry;
    const relPath = normalizePath('file' in entry ? entry.path : file.webkitRelativePath || file.name);
    if (isEssentialModFile(relPath)) {
      fileMap.set(relPath, file);
    }
    loaded++;
    onProgress?.(Math.floor((loaded / files.length) * 100));
  }

  return fileMap;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

export function colorSaturation(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return 0;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

export function isColorAchromatic(hex: string): boolean {
  return colorSaturation(hex) < 0.14;
}

export function isMonochromeName(name: string): boolean {
  const l = name.toLowerCase();
  return (
    l.includes('white') ||
    l.includes('blanco') ||
    l.includes('black') ||
    l.includes('negro') ||
    l.includes('grey') ||
    l.includes('gray') ||
    l.includes('silver') ||
    l.includes('plata') ||
    l.includes('carbon')
  );
}

/**
 * Clusters dominant colors from raw RGBA pixel data to generate a two-tone swatch.
 * Prioritizes chromatic / car paint pixels over pure black or white studio backgrounds.
 */
export function extractSwatchFromRgba(data: Uint8Array | Uint8ClampedArray, channels = 4): [string, string] {
  const colorCounts = new Map<string, { count: number; r: number; g: number; b: number; sat: number }>();
  for (let p = 0; p < data.length; p += channels) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const a = channels === 4 ? data[p + 3] : 255;
    if (a < 50) continue; // ignore transparent
    const qr = (r >> 4) << 4;
    const qg = (g >> 4) << 4;
    const qb = (b >> 4) << 4;
    const key = `${qr},${qg},${qb}`;
    const curr = colorCounts.get(key) || { count: 0, r: 0, g: 0, b: 0, sat: 0 };
    curr.count++;
    curr.r += r;
    curr.g += g;
    curr.b += b;
    colorCounts.set(key, curr);
  }

  // Calculate saturation and detect studio backgrounds (near-black < 28 or near-white > 240)
  for (const entry of colorCounts.values()) {
    const avgR = entry.r / entry.count / 255;
    const avgG = entry.g / entry.count / 255;
    const avgB = entry.b / entry.count / 255;
    const max = Math.max(avgR, avgG, avgB);
    const min = Math.min(avgR, avgG, avgB);
    const d = max - min;
    const l = (max + min) / 2;
    entry.sat = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
  }

  const allSorted = [...colorCounts.values()].sort((a, b) => b.count - a.count);
  if (allSorted.length === 0) return ['#333333', '#e0e0e0'];

  // Prefer chromatic colors (saturation > 0.18) if available
  const chromatic = allSorted.filter((c) => c.sat > 0.18);
  const pool = chromatic.length > 0 ? chromatic : allSorted;

  const top1 = pool[0];
  const c1 = '#' + [Math.round(top1.r / top1.count), Math.round(top1.g / top1.count), Math.round(top1.b / top1.count)].map((x) => x.toString(16).padStart(2, '0')).join('');
  let c2 = '';
  for (let j = 1; j < allSorted.length; j++) {
    const r2 = Math.round(allSorted[j].r / allSorted[j].count);
    const g2 = Math.round(allSorted[j].g / allSorted[j].count);
    const b2 = Math.round(allSorted[j].b / allSorted[j].count);
    const dist = Math.hypot(
      r2 - top1.r / top1.count,
      g2 - top1.g / top1.count,
      b2 - top1.b / top1.count
    );
    if (dist > 45) {
      c2 = '#' + [r2, g2, b2].map((x) => x.toString(16).padStart(2, '0')).join('');
      break;
    }
  }
  if (!c2) {
    const lum = 0.299 * (top1.r / top1.count) + 0.587 * (top1.g / top1.count) + 0.114 * (top1.b / top1.count);
    c2 = lum > 128 ? '#1a1a1a' : '#f0f0f0';
  }
  return [c1, c2];
}

/**
 * Extracts a two-tone color swatch from a livery image blob (livery.png or preview.jpg).
 */
export async function extractSwatchFromImageBlob(blob: Blob): Promise<[string, string] | null> {
  if (typeof createImageBitmap !== 'undefined' && typeof document !== 'undefined') {
    try {
      const bmp = await createImageBitmap(blob, { resizeWidth: 16, resizeHeight: 16, resizeQuality: 'pixelated' });
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const imgData = ctx.getImageData(0, 0, 16, 16);
      return extractSwatchFromRgba(imgData.data, 4);
    } catch {
      return null;
    }
  }
  return null;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Generates an aesthetic, deterministic two-tone color swatch based on skin name, index and car context.
 */
export function deterministicSkinSwatch(
  name: string,
  index: number,
  carContext?: string
): [string, string] {
  const lowerName = name.toLowerCase();
  const ctx = (carContext || '').toLowerCase();

  // Explicit colour keywords in skin title
  if (lowerName.includes('white') || lowerName.includes('blanco')) return ['#f5f5f5', '#1a1a1a'];
  if (lowerName.includes('black') || lowerName.includes('negro')) return ['#141414', '#e00201'];
  if (lowerName.includes('carbon')) return ['#262626', '#121212'];
  if (lowerName.includes('red') || lowerName.includes('rojo') || lowerName.includes('rosso')) return ['#d6001c', '#111111'];
  if (lowerName.includes('blue') || lowerName.includes('azul') || lowerName.includes('azzurro')) return ['#0044bb', '#f0f0f0'];
  if (lowerName.includes('green') || lowerName.includes('verde')) return ['#008833', '#111111'];
  if (lowerName.includes('yellow') || lowerName.includes('amarillo') || lowerName.includes('giallo')) return ['#ffcc00', '#111111'];
  if (lowerName.includes('orange') || lowerName.includes('naranja')) return ['#ff6600', '#111111'];
  if (lowerName.includes('silver') || lowerName.includes('grey') || lowerName.includes('gray') || lowerName.includes('plata')) return ['#cccccc', '#222222'];
  if (lowerName.includes('gold') || lowerName.includes('oro')) return ['#d4af37', '#111111'];
  if (lowerName.includes('dragons')) return ['#ffffff', '#0a0a0a'];
  if (lowerName.includes('junior')) return ['#1c242c', '#f07900'];

  // Formula RSS specific liveries
  if (lowerName.includes('smith')) return ['#0a1931', '#f4b41a'];
  if (lowerName.includes('greenery')) return ['#008833', '#ffffff'];
  if (lowerName.includes('rss') || ctx.includes('rss') || lowerName.includes('team rss')) {
    const numMatch = lowerName.match(/#?(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : index + 1;
    const rssHues = [0, 215, 35, 145, 275, 45, 185, 320, 95, 240, 15, 170, 300, 60, 200, 110];
    const hue = rssHues[(Math.abs(num - 1)) % rssHues.length];
    return ['#141414', hslToHex(hue, 90, 52)];
  }

  // F1 / Grand Prix round-specific liveries & team contexts:
  const isMcLaren = ctx.includes('mclaren') || lowerName.includes('mclaren') || ctx.includes('mcl39') || ctx.includes('mcl38');
  const isFerrari = ctx.includes('ferrari') || lowerName.includes('ferrari');
  const isRedBull = ctx.includes('red bull') || ctx.includes('redbull') || lowerName.includes('redbull');
  const isMercedes = ctx.includes('mercedes') || lowerName.includes('mercedes');
  const isAston = ctx.includes('aston') || lowerName.includes('aston');
  const isAlpine = ctx.includes('alpine') || lowerName.includes('alpine');

  const baseColor = isMcLaren
    ? '#ff8000' // McLaren Papaya Orange
    : isFerrari
      ? '#dc0000' // Rosso Corsa
      : isRedBull
        ? '#001a30' // Navy Blue
        : isMercedes
          ? '#00a19c' // Petronas Teal
          : isAston
            ? '#00594f' // British Racing Green
            : isAlpine
              ? '#0090ff' // Alpine Blue
              : null;

  if (baseColor) {
    if (lowerName.includes('preseason') || lowerName.includes('testing') || lowerName.includes('rd.00')) {
      return isMcLaren ? ['#ff8000', '#d4ff00'] : [baseColor, '#141414'];
    }
    if (lowerName.includes('australia') || lowerName.includes('rd.01')) return [baseColor, '#00843d'];
    if (lowerName.includes('china') || lowerName.includes('rd.02')) return [baseColor, '#de2910'];
    if (lowerName.includes('japan') || lowerName.includes('rd.03')) return [baseColor, '#ff85a1'];
    if (lowerName.includes('bahrain') || lowerName.includes('rd.04')) return [baseColor, '#8a1538'];
    if (lowerName.includes('saudi') || lowerName.includes('rd.05')) return [baseColor, '#006c35'];
    if (lowerName.includes('miami') || lowerName.includes('rd.06')) return [baseColor, '#00e5ff'];
    if (lowerName.includes('emilia') || lowerName.includes('imola') || lowerName.includes('rd.07')) return [baseColor, '#009246'];
    if (lowerName.includes('monaco') || lowerName.includes('rd.08')) return [baseColor, '#ffffff'];
    if (lowerName.includes('canada') || lowerName.includes('rd.09')) return [baseColor, '#ff0000'];
    if (lowerName.includes('spain') || lowerName.includes('rd.10')) return [baseColor, '#ffc400'];
    if (lowerName.includes('austria') || lowerName.includes('rd.11')) return [baseColor, '#ed2939'];
    if (lowerName.includes('britain') || lowerName.includes('silverstone') || lowerName.includes('rd.12')) return [baseColor, '#00247d'];
    if (lowerName.includes('hungary') || lowerName.includes('rd.13')) return [baseColor, '#477050'];
    if (lowerName.includes('belgium') || lowerName.includes('spa') || lowerName.includes('rd.14')) return [baseColor, '#ffd90c'];
    if (lowerName.includes('netherlands') || lowerName.includes('zandvoort') || lowerName.includes('rd.15')) return [baseColor, '#21468b'];
    if (lowerName.includes('monza') || lowerName.includes('italy') || lowerName.includes('rd.16')) return [baseColor, '#ffe600'];
    if (lowerName.includes('baku') || lowerName.includes('azerbaijan') || lowerName.includes('rd.17')) return [baseColor, '#00b5e2'];
    if (lowerName.includes('singapore') || lowerName.includes('rd.18')) return [baseColor, '#9b51e0'];
    if (lowerName.includes('austin') || lowerName.includes('usa') || lowerName.includes('rd.19')) return [baseColor, '#0a3161'];
    if (lowerName.includes('mexico') || lowerName.includes('rd.20')) return [baseColor, '#006847'];
    if (lowerName.includes('brazil') || lowerName.includes('interlagos') || lowerName.includes('rd.21')) return [baseColor, '#009c3b'];
    if (lowerName.includes('vegas') || lowerName.includes('rd.22')) return [baseColor, '#ff007f'];
    if (lowerName.includes('qatar') || lowerName.includes('rd.23')) return [baseColor, '#8a1538'];
    if (lowerName.includes('abu dhabi') || lowerName.includes('yas marina') || lowerName.includes('rd.24')) return [baseColor, '#4169e1'];

    // Default driver livery for that team
    if (index === 0) return [baseColor, '#141414'];
    const roundHue = Math.round((index * 137.508) % 360);
    return [baseColor, hslToHex(roundHue, 80, 50)];
  }

  // Golden ratio hue cycle for distinct and vibrant pairings
  const hue = Math.round((index * 137.508) % 360);
  const c1 = hslToHex(hue, 75, 45);
  const hue2 = (hue + 180) % 360;
  const c2 = hslToHex(hue2, 80, 55);
  return [c1, c2];
}

/**
 * Given raw files from an archive or folder, analyzes directory structure,
 * identifies the car slug, and collects the normalized car package.
 */
export async function analyzeCarPackage(rawFiles: ReadonlyMap<string, ModAsset>): Promise<ExtractedCarPackage> {
  let carSlug = '';
  let carPrefix = '';

  // Look for data.acd or data/car.ini
  for (const fullPath of rawFiles.keys()) {
    const m = fullPath.match(/(?:^|\/)([^/]+)\/(data\.acd|data\/car\.ini)$/i);
    if (m) {
      carSlug = m[1];
      carPrefix = fullPath.slice(0, fullPath.length - m[2].length);
      break;
    }
  }

  // Fallback: look for any .kn5
  if (!carSlug) {
    for (const fullPath of rawFiles.keys()) {
      const m = fullPath.match(/(?:^|\/)([^/]+)\/([^/]+\.kn5)$/i);
      if (m && !/collider|shadow/i.test(m[2]) && !/(?:^|\/)(extension|skins)\//i.test(fullPath)) {
        carSlug = m[1];
        carPrefix = fullPath.slice(0, fullPath.length - m[2].length);
        break;
      }
    }
  }

  // If still no prefix, take root
  if (!carSlug) {
    carSlug = 'custom_car';
    carPrefix = '';
  }

  // Build map of files relative to car directory
  const carFiles = new Map<string, ModAsset>();
  for (const [fullPath, data] of rawFiles.entries()) {
    if (carPrefix) {
      if (fullPath.toLowerCase().startsWith(carPrefix.toLowerCase())) {
        const rel = fullPath.slice(carPrefix.length);
        if (rel) carFiles.set(rel.toLowerCase(), data);
      }
    } else {
      carFiles.set(fullPath.toLowerCase(), data);
    }
  }

  // Select primary .kn5 file
  const kn5Candidates: { name: string; size: number }[] = [];
  for (const [relPath, data] of carFiles.entries()) {
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.kn5') && !lower.includes('/') && !/collider|_lod_|shadow/.test(lower)) {
      kn5Candidates.push({ name: relPath, size: data instanceof Blob ? data.size : data.byteLength });
    }
  }

  if (kn5Candidates.length === 0) {
    // If all .kn5 were filtered, take any non-collider .kn5
    for (const [relPath, data] of carFiles.entries()) {
      if (relPath.endsWith('.kn5') && !relPath.includes('/') && !/collider|shadow/.test(relPath)) {
        kn5Candidates.push({ name: relPath, size: data instanceof Blob ? data.size : data.byteLength });
      }
    }
  }

  // AC declares the main model in lods.ini; filesystem size is only a fallback.
  const lodsIni = carFiles.get('lods.ini') ?? carFiles.get('data/lods.ini');
  const lodZero = lodsIni ? parseIni(await assetText(lodsIni)).LOD_0?.FILE : undefined;
  const declared = lodZero ? normalizePath(lodZero.replace(/^"(.*)"$/, '$1')).toLowerCase() : undefined;
  kn5Candidates.sort((a, b) => b.size - a.size);
  const primaryKn5Name =
    (declared?.endsWith('.kn5') && carFiles.has(declared) ? declared : undefined) ??
    kn5Candidates.find(({ name }) => name === `${carSlug.toLowerCase()}.kn5`)?.name ??
    kn5Candidates[0]?.name;
  if (!primaryKn5Name) throw new Error(`No se encontró el modelo 3D (.kn5) de "${carSlug}".`);
  if (!carPrefix) carSlug = primaryKn5Name.split('/').pop()!.replace(/\.kn5$/i, '');
  const primaryKn5 = carFiles.get(primaryKn5Name)!;

  // Metadata from ui/ui_car.json
  let title = carSlug.replace(/_/g, ' ');
  let subTitle = 'Assetto Corsa Mod';
  let author = 'Assetto Corsa Community';
  let year = new Date().getFullYear();
  let classId: CarClassId = 'road';
  let specs: Record<string, string> | undefined;

  const uiJsonBytes = carFiles.get('ui/ui_car.json') || carFiles.get('ui_car.json');
  if (uiJsonBytes) {
    try {
      const text = await assetText(uiJsonBytes);
      const parsed = JSON.parse(text);
      if (parsed.name) title = String(parsed.name);
      if (parsed.brand) subTitle = `${parsed.brand}${parsed.class ? ` · ${parsed.class}` : ''}`;
      if (parsed.author) author = String(parsed.author);
      if (parsed.year && Number.isFinite(Number(parsed.year))) year = Number(parsed.year);
      if (parsed.specs) specs = parsed.specs;

      // Class heuristic
      const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).toLowerCase()) : [];
      const lowerName = title.toLowerCase();
      const lowerSub = subTitle.toLowerCase();
      const lowerSlug = carSlug.toLowerCase();

      if (
        tags.includes('formula') ||
        tags.includes('singleseater') ||
        tags.includes('f1') ||
        tags.includes('openwheel') ||
        lowerName.includes('f1') ||
        lowerName.includes('formula') ||
        lowerName.includes('mcl3') ||
        lowerSub.includes('f1') ||
        lowerSub.includes('formula') ||
        lowerSlug.includes('f1') ||
        lowerSlug.includes('formula')
      ) {
        classId = 'f1';
      } else if (
        tags.includes('gt3') ||
        tags.includes('gt4') ||
        tags.includes('gt') ||
        tags.includes('cup') ||
        lowerName.includes('gt3') ||
        lowerName.includes('gt4') ||
        lowerName.includes('cup') ||
        lowerName.includes('supra') ||
        lowerSub.includes('gt3') ||
        lowerSub.includes('gt4') ||
        lowerSlug.includes('gt3') ||
        lowerSlug.includes('gt4') ||
        lowerSlug.includes('supra')
      ) {
        classId = 'gt3';
      } else if (tags.includes('proto') || tags.includes('lmp') || tags.includes('lmdh') || lowerName.includes('lmp')) {
        classId = 'proto';
      } else if (year < 2000) {
        classId = 'classic';
      } else {
        classId = 'road';
      }
    } catch (e) {
      console.warn('Failed to parse ui_car.json:', e);
    }
  }

  const rootBlobs: Record<string, Blob> = Object.create(null);
  for (const [path, data] of carFiles.entries()) {
    if ((!path.includes('/') || path.startsWith('extension/')) && isTextureFile(path)) {
      rootBlobs[path] = assetBlob(data);
    }
  }

  // Discover skins under skins/<skin_name>/
  const skins: CustomCarSkin[] = [];
  const skinFolders = new Set<string>();
  for (const path of carFiles.keys()) {
    const m = path.match(/^skins\/([^/]+)\//i);
    if (m) skinFolders.add(m[1]);
  }

  const sortedSkinFolders = Array.from(skinFolders).sort((a, b) => a.localeCompare(b));
  for (const folder of sortedSkinFolders) {
    const prefix = `skins/${folder}/`;
    const textures: Record<string, Blob> = { ...rootBlobs };
    let skinTitle = folder.replace(/^[0-9]+_/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    let skinSwatch: [string, string] | undefined;
    let hasSkinFiles = false;
    let appearanceConfig: string | undefined;

    for (const [path, data] of carFiles.entries()) {
      if (path.startsWith(prefix)) {
        const name = path.slice(prefix.length);
        if (isTextureFile(name)) {
          textures[name] = assetBlob(data);
          hasSkinFiles = true;
        }
        if (name === 'ext_config.ini') {
          appearanceConfig = await assetText(data);
          hasSkinFiles = true;
        }
        if (name === 'ui_skin.json') {
          try {
            const parsed = JSON.parse(await assetText(data));
            if (typeof parsed.skinname === 'string' && parsed.skinname.trim()) {
              skinTitle = parsed.skinname
                .replace(/[\u00a0\s]+/g, ' ')
                .replace(/_/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            }
            const colors = (Array.isArray(parsed.colors) ? parsed.colors : [parsed.color])
              .filter((color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color));
            if (colors.length) {
              skinSwatch = [colors[0], colors[1] ?? colors[0]];
            }
            hasSkinFiles = true;
          } catch {}
        }
      }
    }

    if (hasSkinFiles) {
      skins.push({
        name: skinTitle,
        swatch: skinSwatch ?? deterministicSkinSwatch(skinTitle, skins.length, `${carSlug} ${title}`),
        swatchSource: skinSwatch ? 'authored' : undefined,
        appearanceConfig,
        textures,
      });
    }
  }

  // If no skins were found in skins/, but root-level textures exist, create a default skin
  if (skins.length === 0 && Object.keys(rootBlobs).length > 0) {
    skins.push({
      name: 'Default',
      textures: rootBlobs,
    });
  }

  // Thumbnails: badge and preview
  const badge = carFiles.get('ui/badge.png') || carFiles.get('logo.png');
  let preview = carFiles.get('ui/preview.jpg') || carFiles.get('ui/preview.png');
  if (!preview && sortedSkinFolders.length > 0) {
    for (const folder of sortedSkinFolders) {
      preview = carFiles.get(`skins/${folder}/preview.jpg`) || carFiles.get(`skins/${folder}/preview.png`);
      if (preview) break;
    }
  }

  return {
    slug: carSlug,
    title,
    subTitle,
    author,
    year,
    classId,
    specs,
    files: carFiles,
    primaryKn5Name,
    primaryKn5,
    badge,
    preview,
    skins,
  };
}

/**
 * End-to-end import function: Takes an archive (ZIP/RAR) or dropped files,
 * decompresses, decrypts physics, parses 3D model, saves to IndexedDB,
 * and registers into LibreCorsa runtime.
 */
export async function importAssettoCorsaMod(
  input: Blob | ArrayBuffer | Uint8Array | ModFolderFile[],
  onProgress?: (progress: ModImportProgress) => void
): Promise<CarDefinition> {
  onProgress?.({ stage: 'reading', message: 'Leyendo archivo...', percent: 10 });

  let rawFiles: Map<string, ModAsset>;

  if (Array.isArray(input)) {
    onProgress?.({ stage: 'extracting', message: 'Procesando archivos...', percent: 20 });
    rawFiles = readDroppedFiles(input, (pct) => {
      onProgress?.({ stage: 'extracting', message: 'Cargando archivos...', percent: 20 + Math.floor(pct * 0.2) });
    });
  } else {
    const source = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    const header = source instanceof Blob ? new Uint8Array(await source.slice(0, 16).arrayBuffer()) : source.subarray(0, 16);

    if (isZipHeader(header)) {
      onProgress?.({ stage: 'extracting', message: 'Descomprimiendo archivo ZIP...', percent: 25 });
      rawFiles = await unpackZip(source instanceof Blob ? await source.arrayBuffer() : source, (pct) => {
        onProgress?.({ stage: 'extracting', message: 'Descomprimiendo ZIP...', percent: 25 + Math.floor(pct * 0.2) });
      });
    } else if (isRarHeader(header)) {
      onProgress?.({ stage: 'extracting', message: 'Descomprimiendo archivo RAR...', percent: 25 });
      rawFiles = await unpackRar(source instanceof Blob ? await source.arrayBuffer() : source, (pct) => {
        onProgress?.({ stage: 'extracting', message: 'Descomprimiendo RAR...', percent: 25 + Math.floor(pct * 0.2) });
      });
    } else if (is7zHeader(header)) {
      onProgress?.({ stage: 'extracting', message: 'Descomprimiendo archivo 7Z...', percent: 25 });
      rawFiles = await unpack7z(source, (pct) => {
        onProgress?.({ stage: 'extracting', message: 'Descomprimiendo 7Z...', percent: 25 + Math.floor(pct * 0.2) });
      });
    } else {
      throw new Error('Formato de archivo no soportado. Arrastra un archivo .zip, .rar, .7z o la carpeta del mod.');
    }
  }

  onProgress?.({ stage: 'decrypting', message: 'Analizando paquete del mod...', percent: 50 });
  const pkg = await analyzeCarPackage(rawFiles);
  rawFiles.clear();

  // Decrypt physics
  onProgress?.({ stage: 'decrypting', message: 'Desencriptando físicas (data.acd)...', percent: 60 });
  const textFiles = new Map<string, string>();

  const dataAcd = pkg.files.get('data.acd');
  const acdBytes = dataAcd instanceof Blob ? new Uint8Array(await dataAcd.arrayBuffer()) : dataAcd;
  if (acdBytes) {
    const decrypted = decryptDataAcd(acdBytes, pkg.slug);
    for (const [filename, content] of decrypted.entries()) {
      textFiles.set(filename.toLowerCase(), content);
    }
  } else {
    // Look for uncompressed data/*.ini and *.lut files
    for (const [path, data] of pkg.files.entries()) {
      const lower = path.toLowerCase();
      if (lower.startsWith('data/')) {
        const name = lower.slice(5);
        textFiles.set(name, await assetText(data));
      }
    }
  }

  if (textFiles.size === 0) {
    throw new Error(`No se encontraron físicas para "${pkg.slug}" (ni data.acd ni archivos data/*.ini).`);
  }

  const modData = new AcModData(textFiles);
  const physicsConfig = mapAcPhysics(modData);
  const appearanceConfig: string[] = [];
  for (const path of ['ext_config.ini', 'extension/ext_config.ini']) {
    const asset = pkg.files.get(path);
    if (asset) appearanceConfig.push(await assetText(asset));
  }
  pkg.files.clear();

  // Recover the protected main model before the shared parser can see its preview.
  const modelData = pkg.primaryKn5 instanceof Blob ? new Uint8Array(await pkg.primaryKn5.arrayBuffer()) : pkg.primaryKn5;
  const footer = readCspKn5Footer(modelData);
  let restored: Blob | undefined;
  if (footer) {
    onProgress?.({ stage: 'rigging', message: 'Recuperando texturas y geometría CSP...', percent: 70 });
    const { rebuildCspKn5 } = await import('./kn5-csp-rebuild');
    restored = await rebuildCspKn5(modelData, footer, pkg.primaryKn5Name, pkg.slug, acdBytes);
  }
  onProgress?.({ stage: 'rigging', message: 'Validando modelo 3D (.kn5)...', percent: 75 });
  const kn5Model = parseKn5(restored ? await restored.arrayBuffer() : modelData, pkg.primaryKn5Name);
  if (!kn5Model.nodes || kn5Model.nodes.length === 0) {
    throw new Error(`El archivo .kn5 "${pkg.primaryKn5Name}" no contiene nodos válidos.`);
  }

  // Build blobs
  const kn5Blob = restored ?? assetBlob(pkg.primaryKn5, 'application/octet-stream');
  const badgeBlob = pkg.badge ? assetBlob(pkg.badge, 'image/png') : undefined;
  const previewBlob = pkg.preview ? assetBlob(pkg.preview, 'image/jpeg') : undefined;

  const recordId = customCarIdForSlug(pkg.slug, await getAllCustomCars());

  const record: CustomCarRecord = {
    id: recordId,
    slug: pkg.slug,
    title: pkg.title,
    subTitle: pkg.subTitle,
    author: pkg.author,
    year: pkg.year,
    classId: pkg.classId,
    physicsConfig,
    kn5Blob,
    badgeBlob,
    previewBlob,
    skins: pkg.skins && pkg.skins.length > 0 ? pkg.skins : undefined,
    appearanceConfig,
    importedAt: Date.now(),
  };

  // Enhance skin swatches with real image pixels from livery.png or preview.jpg if available
  if (pkg.skins && pkg.skins.length > 0) {
    // Check if livery.png is identical in size across all skins (author badge/icon)
    let identicalLiveryBadge = false;
    if (pkg.skins.length > 1) {
      const liverySizes = pkg.skins.map((s) => s.textures?.['livery.png']?.size).filter((sz) => typeof sz === 'number');
      if (liverySizes.length === pkg.skins.length && new Set(liverySizes).size === 1) {
        identicalLiveryBadge = true;
      }
    }

    for (let i = 0; i < pkg.skins.length; i++) {
      const s = pkg.skins[i];
      if (s.swatchSource === 'authored') continue;
      // If livery.png is an identical author badge across all skins, prefer preview.jpg or keep deterministic
      const liveryBlob = identicalLiveryBadge
        ? s.textures?.['preview.jpg']
        : (s.textures?.['livery.png'] ?? s.textures?.['preview.jpg']);
      if (liveryBlob) {
        try {
          const sw = await extractSwatchFromImageBlob(liveryBlob);
          if (sw && (!isColorAchromatic(sw[0]) || !isColorAchromatic(sw[1]) || isMonochromeName(s.name))) {
            s.swatch = sw;
          }
        } catch {}
      }
    }

    // Post-check: If all skins ended up with identical swatches or generic grey swatches,
    // ensure each skin has a distinct, beautiful deterministic swatch
    const carCtx = `${pkg.slug} ${pkg.title} ${pkg.author || ''}`;
    const firstKey = pkg.skins[0]?.swatch ? `${pkg.skins[0].swatch[0]}_${pkg.skins[0].swatch[1]}` : '';
    const allIdentical = pkg.skins.length > 1 && pkg.skins.every((s) => s.swatch && `${s.swatch[0]}_${s.swatch[1]}` === firstKey);

    if (allIdentical) {
      for (let i = 0; i < pkg.skins.length; i++) {
        if (!pkg.skins[i].swatchSource) {
          pkg.skins[i].swatch = deterministicSkinSwatch(pkg.skins[i].name, i, carCtx);
        }
      }
    }
  }

  // Save to IndexedDB
  onProgress?.({ stage: 'saving', message: 'Guardando mod en IndexedDB...', percent: 90 });
  await saveCustomCar(record);

  // Register in runtime memory
  onProgress?.({ stage: 'done', message: '¡Mod importado con éxito!', percent: 100 });
  const carDef = registerCustomCarMod(record, kn5Model);

  return carDef;
}
