/**
 * The translations (src/i18n): every English message parses, every note belongs to a message, and every language
 * folder has the English areas, only English keys, messages that parse and keep their English placeholders,
 * plurals and tags, and its line in catalogs.ts. Also the pseudo-language and how a browser's languages resolve.
 * A message a language hasn't translated yet is fine: it shows in English.
 *
 *   npx tsx scripts/verify-i18n.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatLocale, resolveLocale } from "../src/i18n/catalogs";
import en from "../src/i18n/messages/en";
import { isolateMessage } from "../src/i18n/isolate";
import { pseudoMessage } from "../src/i18n/pseudo";
import { areas, CATALOGS_FILE, flatten, MESSAGES, readLocale, readNotes, signature, SOURCE, translatedLocales, type Tree } from "./i18n/catalog";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const englishTrees = readLocale(SOURCE);
const english = flatten(englishTrees);
const areaList = areas();

// English
const indexSrc = readFileSync(join(MESSAGES, SOURCE, 'index.ts'), 'utf8');
const unimported = areaList.filter((a) => !indexSrc.includes(`from "./${a}.json"`));
check('every English area file is in messages/en/index.ts', unimported.length === 0, unimported.join(', '));
check('the English catalogue object has every area', areaList.every((a) => a in en), Object.keys(en).join(', '));
const onlyStrings = (t: Tree): boolean => Object.values(t).every((v) => typeof v === 'string' || (v && typeof v === 'object' && onlyStrings(v)));
check('English messages are strings in nested objects', Object.values(englishTrees).every(onlyStrings));
const badEnglish: string[] = [];
for (const [key, msg] of english) {
  try {
    signature(msg);
  } catch (err) {
    badEnglish.push(`${key} (${(err as Error).message})`);
  }
}
check('every English message parses', badEnglish.length === 0, badEnglish.slice(0, 5).join('; '));
const emptyEnglish = [...english].filter(([, v]) => !v.trim()).map(([k]) => k);
check('no English message is empty', emptyEnglish.length === 0, emptyEnglish.slice(0, 5).join(', '));

const notes = readNotes();
const staleNotes = [...notes.keys()].filter((k) => !english.has(k));
check('every note belongs to an English message', staleNotes.length === 0, staleNotes.slice(0, 5).join(', '));
const noNotes = areaList.filter((a) => !existsSync(join(MESSAGES, '..', 'notes', `${a}.json`)));
check('every area has a notes file', noNotes.length === 0, noNotes.join(', '));

// Languages
const catalogsSrc = readFileSync(CATALOGS_FILE, 'utf8');
for (const locale of translatedLocales()) {
  const trees = readLocale(locale);
  const have = Object.keys(trees);
  check(`${locale}: has every English area`, areaList.every((a) => have.includes(a)), areaList.filter((a) => !have.includes(a)).join(', '));
  check(`${locale}: no area English lacks`, have.every((a) => areaList.includes(a)), have.filter((a) => !areaList.includes(a)).join(', '));
  const index = (() => {
    try {
      return readFileSync(join(MESSAGES, locale, 'index.ts'), 'utf8');
    } catch {
      return '';
    }
  })();
  check(`${locale}: index.ts imports every area`, areaList.every((a) => index.includes(`from "./${a}.json"`)));
  check(`${locale}: listed in catalogs.ts`, catalogsSrc.includes(`import("./messages/${locale}")`));
  const msgs = flatten(trees);
  const extra = [...msgs.keys()].filter((k) => !english.has(k));
  check(`${locale}: only keys English has`, extra.length === 0, extra.slice(0, 5).join(', '));
  const bad: string[] = [];
  for (const [key, msg] of msgs) {
    if (!english.has(key) || !msg.trim()) continue;
    try {
      const a = signature(msg);
      const b = signature(english.get(key)!);
      if (a !== b) bad.push(`${key}: ${a || 'none'} vs English ${b || 'none'}`);
    } catch (err) {
      bad.push(`${key}: ${(err as Error).message}`);
    }
  }
  check(`${locale}: messages parse and keep English placeholders`, bad.length === 0, bad.slice(0, 5).join('; '));
  const done = [...msgs].filter(([k, v]) => english.has(k) && v.trim()).length;
  console.log(`      ${locale}: ${done} / ${english.size} translated`);
}

// Pseudo-language
const pseudoBad: string[] = [];
for (const [key, msg] of english) {
  const p = pseudoMessage(msg);
  try {
    if (signature(p) !== signature(msg)) pseudoBad.push(key);
  } catch {
    pseudoBad.push(key);
  }
}
check('pseudo-language keeps every placeholder, plural and tag', pseudoBad.length === 0, pseudoBad.slice(0, 5).join(', '));
check('pseudo-language accents and lengthens', /^\[Ðŕîṽé ~+\]$/.test(pseudoMessage('Drive')), pseudoMessage('Drive'));
check('pseudo-language keeps an argument', pseudoMessage('Best {time}').includes('{time}'), pseudoMessage('Best {time}'));

// Which language a browser gets
check('auto with no other catalogue is English', resolveLocale('auto', ['tr-TR', 'de']) === 'en' || translatedLocales().length > 0);
check('a choice without a catalogue falls back to the browser, then English', resolveLocale('xx', ['yy']) === 'en');
check('English picked by name stays English', resolveLocale('en', ['tr']) === 'en');
check('the pseudo-language is never picked for a browser', resolveLocale('auto', ['en-XA']) === 'en');
for (const locale of translatedLocales()) {
  // A catalogue named with a script ("zh-Hant") is matched by script, so its stand-in browser carries the script too
  const scripted = locale.split('-').some((part) => /^[A-Z][a-z]{3}$/.test(part));
  const asked = scripted ? `${locale}-ZZ` : `${locale.split('-')[0]}-ZZ`;
  check(`${locale}: a browser asking for ${asked} gets it`, resolveLocale('auto', [asked]) === locale);
}
if (translatedLocales().includes('zh-Hant')) {
  check('zh-TW, zh-HK and zh-MO get Traditional Chinese', ['zh-TW', 'zh-HK', 'zh-MO'].every((b) => resolveLocale('auto', [b]) === 'zh-Hant'));
  check('zh-CN, zh-SG and plain zh do not get Traditional Chinese', ['zh-CN', 'zh-SG', 'zh', 'zh-Hans'].every((b) => resolveLocale('auto', [b]) === 'en'));
}
// Right to left, the values in every message are isolated (isolate.ts): that must keep each message's placeholders
for (const locale of ['ar'].filter((l) => translatedLocales().includes(l))) {
  const bad = [...flatten(readLocale(locale))].filter(([, m]) => { try { return signature(isolateMessage(m)) !== signature(m); } catch { return true; } }).map(([k]) => k);
  check(`${locale}: isolating the filled-in values keeps every message whole`, bad.length === 0, bad.slice(0, 5).join(', '));
}
check('numbers are formatted with Latin digits in every language', new Intl.NumberFormat(formatLocale('ar')).format(1234) === '1,234');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll translation checks passed.');
