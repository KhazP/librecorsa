/**
 * Puts translated messages into a language's files. Takes the file `npm run i18n:missing` wrote, with each
 * "translation" filled in, or a plain { "area.key": "translation" } object. Every translation is checked against its
 * English: it must parse, and keep the same placeholders, plurals and tags. Bad ones are listed and left out.
 *
 *   npm run i18n:merge -- tr tr.json
 *   npm run i18n:merge -- tr tr.1.json tr.2.json tr.3.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flatten, MESSAGES, readLocale, setKey, signature, SOURCE, writeJson, type Tree } from "./catalog";

const [locale, ...files] = process.argv.slice(2);
if (!locale || !files.length) {
  console.error("Usage: npm run i18n:merge -- <locale> <file.json> [more files…]");
  process.exit(1);
}
const input = Object.assign({}, ...files.map((f) => JSON.parse(readFileSync(f, "utf8")))) as Record<string, string | { translation?: string }>;
const englishTrees = readLocale(SOURCE);
const english = flatten(englishTrees);
const trees = readLocale(locale);

let merged = 0;
const refused: string[] = [];
for (const [key, entry] of Object.entries(input)) {
  const text = (typeof entry === "string" ? entry : entry?.translation)?.trim();
  if (!text) continue;
  const en = english.get(key);
  if (en === undefined) {
    refused.push(`${key}: no such English message`);
    continue;
  }
  let sig: string;
  try {
    sig = signature(text);
  } catch (err) {
    refused.push(`${key}: doesn't parse (${(err as Error).message})`);
    continue;
  }
  if (sig !== signature(en)) {
    refused.push(`${key}: placeholders differ from English (${signature(en) || "none"} vs ${sig || "none"})`);
    continue;
  }
  const [area, ...path] = key.split(".");
  trees[area] ??= {};
  setKey(trees[area], path, text, (englishTrees[area] ?? {}) as Tree);
  merged++;
}
for (const [area, tree] of Object.entries(trees)) writeJson(join(MESSAGES, locale, `${area}.json`), tree);
console.log(`${merged} messages merged into ${locale}`);
if (refused.length) {
  console.log(`${refused.length} left out:`);
  for (const r of refused) console.log(`  ${r}`);
  process.exitCode = 1;
}
