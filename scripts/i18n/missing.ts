/**
 * The messages a language still lacks, as one JSON file to hand to a translator (a person or an AI model): each key
 * with its English text, the note on where it shows, and an empty "translation" to fill in. Fill it, then
 * `npm run i18n:merge -- <locale> <file>` puts the translations into the language's files.
 *
 *   npm run i18n:missing -- tr                  (prints)
 *   npm run i18n:missing -- tr --out tr.json    (writes a file)
 *   npm run i18n:missing -- tr --area settings  (one area only)
 *   npm run i18n:missing -- tr --out tr.json --max 300   (tr.1.json, tr.2.json…: at most 300 messages each, a size one
 *                                                          model reply can return whole)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { flatten, MESSAGES, readLocale, readNotes, SOURCE, writeJson } from "./catalog";

const args = process.argv.slice(2);
const locale = args[0];
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!locale || locale.startsWith("-") || !existsSync(join(MESSAGES, locale))) {
  console.error("Usage: npm run i18n:missing -- <locale> [--out file.json] [--area name]  (add a language first: npm run i18n:add)");
  process.exit(1);
}
const area = opt("--area");
const english = flatten(readLocale(SOURCE));
const have = flatten(readLocale(locale));
const notes = readNotes();

const out: Record<string, { en: string; note?: string; translation: string }> = {};
for (const [key, en] of english) {
  if (area && !key.startsWith(`${area}.`)) continue;
  if (have.get(key)?.trim()) continue;
  const note = notes.get(key);
  out[key] = { en, ...(note ? { note } : {}), translation: "" };
}

const file = opt("--out");
const max = Number(opt("--max") ?? 0);
const entries = Object.entries(out);
if (file && max > 0 && entries.length > max) {
  const parts = Math.ceil(entries.length / max);
  for (let i = 0; i < parts; i++) {
    const part = file.replace(/(\.json)?$/, `.${i + 1}.json`);
    writeJson(part, Object.fromEntries(entries.slice(i * max, (i + 1) * max)));
  }
  console.log(`${entries.length} messages missing in ${locale}, written to ${parts} files of at most ${max}: ${file.replace(/(\.json)?$/, ".1.json")} …`);
} else if (file) {
  writeJson(file, out);
  console.log(`${entries.length} messages missing in ${locale}, written to ${file}`);
} else {
  console.log(JSON.stringify(out, null, 2));
}
