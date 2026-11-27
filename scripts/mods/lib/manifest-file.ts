/**
 * A package folder's mod.json as the tools write it: read (or started), a circuit or car added or replaced by its id,
 * and written back. What they write is what src/lib/mods/mod-manifest.ts `validateModManifest` takes; the packagers
 * check the whole folder afterwards (package-check.ts), so a value out of range is caught there, by its path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isModPackageId, type ModCar, type ModCarSkin, type ModCredit, type ModManifest, type ModTrack } from "../../../src/lib/mods/mod-manifest";

/** What every package starts with */
export interface PackageInfo {
  /** `author.name` */
  id: string;
  name: string;
  version: string;
  description?: string;
  credit: ModCredit;
}

/** A credit as the converters write it (scripts/tracks: `title`, `author`, `url`, `short`, `license`, `licenseUrl`) */
export interface SourceCredit {
  author?: string | null;
  url?: string | null;
  authorUrl?: string | null;
  short?: string | null;
  license?: string | null;
  licenseUrl?: string | null;
  note?: string | null;
  title?: string | null;
}

/** An https link, or nothing: a package's links must be https (mod-manifest.ts `httpsUrl`) */
const https = (v: string | null | undefined): string | undefined => {
  if (!v) return undefined;
  try {
    return new URL(v).protocol === "https:" ? v : undefined;
  } catch {
    return undefined;
  }
};

/** A converter's credit as a package's: the author and licence it must have, its https links */
export function packageCredit(c: SourceCredit, fallback?: Partial<ModCredit>): ModCredit {
  const credit: ModCredit = {
    author: (c.author ?? fallback?.author ?? "").trim() || "Unknown",
    license: (c.license ?? fallback?.license ?? "").trim() || "All rights reserved",
  };
  const url = https(c.url) ?? https(fallback?.url);
  const authorUrl = https(c.authorUrl) ?? https(fallback?.authorUrl);
  const licenseUrl = https(c.licenseUrl) ?? https(fallback?.licenseUrl);
  const note = c.note ?? fallback?.note;
  if (url) credit.url = url;
  if (authorUrl) credit.authorUrl = authorUrl;
  if (licenseUrl) credit.licenseUrl = licenseUrl;
  if (note) credit.note = note.slice(0, 500);
  return credit;
}

/**
 * A package-local id (a circuit's, a car's, a livery's) made from any name: lowercase letters, digits, `-` and `_`,
 * starting with a letter or digit, at most 16 characters
 */
export function localIdFrom(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 16)
    .replace(/[-_]+$/, "");
  return id || "item";
}

/** A package id (`author.name`) made from an author and a name, each cut to the lengths ids allow */
export function packageIdFrom(author: string, name: string): string {
  const part = (s: string, max: number) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, max)
      .replace(/[-_]+$/, "") || "x";
  const id = `${part(author, 16)}.${part(name, 24)}`;
  if (!isModPackageId(id)) throw new Error(`can't make a package id from "${author}" and "${name}"`);
  return id;
}

/** The package's mod.json, or a new one from `info` (its id, name, version, credit and description win when given) */
export function readOrStartManifest(packageDir: string, info: PackageInfo): ModManifest {
  if (!isModPackageId(info.id)) throw new Error(`"${info.id}" is not a package id ("author.name", lowercase)`);
  const path = join(packageDir, "mod.json");
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ModManifest) : null;
  if (existing && existing.id !== info.id) {
    throw new Error(`${path} is package "${existing.id}", not "${info.id}": pick another folder or the same id`);
  }
  const creditChanged = existing !== null && JSON.stringify(existing.credit) !== JSON.stringify(info.credit);
  const tracks =
    creditChanged && existing.tracks
      ? existing.tracks.map((t) => (t.credit ? t : { ...t, credit: existing.credit }))
      : existing?.tracks;
  const cars =
    creditChanged && existing.cars
      ? existing.cars.map((c) => (c.credit ? c : { ...c, credit: existing.credit }))
      : existing?.cars;
  return {
    ...(existing ?? {}),
    ...(tracks ? { tracks } : {}),
    ...(cars ? { cars } : {}),
    format: 1,
    id: info.id,
    name: info.name,
    version: info.version,
    ...(info.description ? { description: info.description } : existing?.description ? { description: existing.description } : {}),
    credit: info.credit,
  } as ModManifest;
}

const upsert = <T extends { id: string }>(list: T[] | undefined, item: T): T[] => [...(list ?? []).filter((x) => x.id !== item.id), item];

export const withTrack = (m: ModManifest, t: ModTrack): ModManifest => ({ ...m, tracks: upsert(m.tracks, t) });
export const withCar = (m: ModManifest, c: ModCar): ModManifest => ({ ...m, cars: upsert(m.cars, c) });
export const withSkin = (m: ModManifest, s: ModCarSkin): ModManifest => ({
  ...m,
  skins: [...(m.skins ?? []).filter((x) => !(x.id === s.id && x.car === s.car)), s],
});

/** Writes mod.json, its keys in the order the docs show them */
export function writeManifest(packageDir: string, m: ModManifest): void {
  mkdirSync(packageDir, { recursive: true });
  const ordered = {
    format: m.format,
    id: m.id,
    name: m.name,
    version: m.version,
    ...(m.description ? { description: m.description } : {}),
    credit: m.credit,
    ...(m.tracks?.length ? { tracks: m.tracks } : {}),
    ...(m.skins?.length ? { skins: m.skins } : {}),
    ...(m.cars?.length ? { cars: m.cars } : {}),
  };
  writeFileSync(join(packageDir, "mod.json"), `${JSON.stringify(ordered, null, 2)}\n`);
}
