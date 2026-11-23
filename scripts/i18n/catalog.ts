/**
 * Reading and writing the message files (src/i18n/messages/<locale>/<area>.json) for the i18n scripts and the
 * verify suite: flattening them to dotted keys, and what each message needs from its translation (its arguments
 * and tags must stay the same).
 */
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../..");
export const MESSAGES = join(ROOT, "src/i18n/messages");
export const NOTES = join(ROOT, "src/i18n/notes");
export const CATALOGS_FILE = join(ROOT, "src/i18n/catalogs.ts");
export const SOURCE = "en";

export type Tree = { [key: string]: string | Tree };

/** The area files of a locale, by area name */
export function readLocale(locale: string): Record<string, Tree> {
  const dir = join(MESSAGES, locale);
  const out: Record<string, Tree> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    out[file.slice(0, -5)] = JSON.parse(readFileSync(join(dir, file), "utf8")) as Tree;
  }
  return out;
}

export const areas = () => Object.keys(readLocale(SOURCE));

/** Every locale folder but English */
export const translatedLocales = () =>
  readdirSync(MESSAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== SOURCE)
    .map((d) => d.name)
    .sort();

/** "area.a.b" → message, for a whole locale */
export function flatten(locale: Record<string, Tree>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (node: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const key = `${prefix}.${k}`;
      if (typeof v === "string") out.set(key, v);
      else walk(v, key);
    }
  };
  for (const [area, tree] of Object.entries(locale)) walk(tree, area);
  return out;
}

export function readNotes(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(NOTES)) return out;
  for (const file of readdirSync(NOTES).filter((f) => f.endsWith(".json"))) {
    const area = file.slice(0, -5);
    const notes = JSON.parse(readFileSync(join(NOTES, file), "utf8")) as Record<string, string>;
    for (const [k, v] of Object.entries(notes)) out.set(`${area}.${k}`, v);
  }
  return out;
}

/**
 * What a translation must keep: every argument with its kind (plain, number, plural, select…) and every tag. Two
 * messages with the same signature format with the same values.
 */
export function signature(message: string): string {
  const parts = new Set<string>();
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      if (el.type === TYPE.argument) parts.add(`${el.value}`);
      else if (el.type === TYPE.number) parts.add(`${el.value}:number`);
      else if (el.type === TYPE.date || el.type === TYPE.time) parts.add(`${el.value}:date`);
      else if (el.type === TYPE.plural) {
        parts.add(`${el.value}:plural`);
        for (const o of Object.values(el.options)) walk(o.value);
      } else if (el.type === TYPE.select) {
        parts.add(`${el.value}:select[${Object.keys(el.options).sort().join("|")}]`);
        for (const o of Object.values(el.options)) walk(o.value);
      } else if (el.type === TYPE.tag) {
        parts.add(`<${el.value}>`);
        walk(el.children);
      }
    }
  };
  walk(parse(message));
  return [...parts].sort().join(", ");
}

/** Writes a value at a dotted key inside an area's tree, keeping the English order of keys */
export function setKey(tree: Tree, path: string[], value: string, english: Tree): void {
  const [head, ...rest] = path;
  if (!rest.length) {
    tree[head] = value;
  } else {
    const child = (tree[head] && typeof tree[head] === "object" ? tree[head] : {}) as Tree;
    setKey(child, rest, value, (english[head] ?? {}) as Tree);
    tree[head] = child;
  }
  // English order: keys English has first, in its order
  const order = Object.keys(english);
  const sorted: Tree = {};
  for (const k of order) if (k in tree) sorted[k] = tree[k];
  for (const k of Object.keys(tree)) if (!(k in sorted)) sorted[k] = tree[k];
  for (const k of Object.keys(tree)) delete tree[k];
  Object.assign(tree, sorted);
}

export const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
