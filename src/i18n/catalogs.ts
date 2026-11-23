import type { PartialMessages } from "./types";

/**
 * The languages the game can show. English is built in; every other language is a folder of the same files under
 * src/i18n/messages/<code>/, loaded only when a player picks it (or their browser asks for it). `npm run i18n:add`
 * adds a folder and its line here.
 *
 * `name` is the language's own name for itself, as the Language setting lists it. `dir: "rtl"` for a language
 * written right to left.
 */
export interface Catalog {
  name: string;
  dir?: "ltr" | "rtl";
  load: () => Promise<{ default: PartialMessages }>;
  /** Left out of the Language setting: reached only with ?lang= (the pseudo-language for testing) */
  hidden?: boolean;
}

export const SOURCE_LOCALE = "en";
export const SOURCE_NAME = "English";

/** For testing layouts: every English string accented and a third longer, opened with ?lang=en-XA */
export const PSEUDO_LOCALE = "en-XA";

export const CATALOGS: Record<string, Catalog> = {
  "it": { name: "Italiano", load: () => import("./messages/it") },
  // i18n:catalogs (npm run i18n:add writes new languages above this line)
  [PSEUDO_LOCALE]: {
    name: "Pseudo (testing)",
    hidden: true,
    load: () => Promise.all([import("./messages/en"), import("./pseudo")]).then(([en, p]) => ({ default: p.pseudoMessages(en.default) })),
  },
};

/** The languages a player can pick, English first, then by their own names */
export function languageChoices(): { code: string; name: string }[] {
  const others = Object.entries(CATALOGS)
    .filter(([, c]) => !c.hidden)
    .map(([code, c]) => ({ code, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [{ code: SOURCE_LOCALE, name: SOURCE_NAME }, ...others];
}

export const hasCatalog = (code: string) => code === SOURCE_LOCALE || code in CATALOGS;

/**
 * The language to show for a saved choice: the choice itself when there is a catalogue for it, else (and for "auto")
 * the first of the browser's languages there is one for, matched exactly, then by its base ("pt-BR" → "pt", "de" →
 * "de-CH"), else English. The pseudo-language is never picked automatically.
 */
export function resolveLocale(choice: string, browser: readonly string[]): string {
  if (choice !== "auto" && hasCatalog(choice)) return choice;
  const codes = [SOURCE_LOCALE, ...Object.keys(CATALOGS).filter((c) => !CATALOGS[c].hidden)];
  for (const wanted of browser) {
    const exact = codes.find((c) => c.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
    const base = wanted.split("-")[0].toLowerCase();
    const near = codes.find((c) => c.split("-")[0].toLowerCase() === base);
    if (near) return near;
  }
  return SOURCE_LOCALE;
}
