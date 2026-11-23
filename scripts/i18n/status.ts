/**
 * How much of each language is translated.
 *
 *   npm run i18n:status
 */
import { flatten, readLocale, SOURCE, translatedLocales } from "./catalog";

const english = flatten(readLocale(SOURCE));
console.log(`English: ${english.size} messages`);
for (const locale of translatedLocales()) {
  const done = [...flatten(readLocale(locale)).entries()].filter(([k, v]) => english.has(k) && v.trim()).length;
  const pct = english.size ? Math.floor((done / english.size) * 100) : 100;
  console.log(`${locale.padEnd(8)} ${String(done).padStart(5)} / ${english.size}  ${pct}%`);
}
