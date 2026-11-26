# Translating

All localizable text in LibreCorsa lives in JSON message catalogs organized by feature area under `src/i18n/messages/<language>/`. English (`en`) is the canonical source. Every other language mirrors the same folder structure, and any missing key falls back to English automatically, so partial translations can ship immediately and grow incrementally.

Players choose their display language under **Settings > Display > Interface > Language**. The default **Automatic** option follows the browser's locale whenever a matching translation exists.

## What is translated

The menus, Settings, first-run setup, the HUD and its layouts, the lap boards, the account screens, the home page and the game's own messages read their text from the message files: about 3,700 messages. `npm run i18n:status` counts them. To see what still shows in English, open the game with `?lang=en-XA` (for example `https://librecorsa.org/play?lang=en-XA`): that pseudo-language accents every message it knows and puts it in brackets, so plain English on screen is text that isn't in the files yet.

These stay in English on purpose: the about, privacy and press pages, the admin page, credit and licence lines, the names of cars, circuits and drivers, the car and circuit descriptions, text that goes into a bug report or wheel diagnostics, and the race-control messages the simulation worker builds.

The following areas intentionally stay in English:

- Privacy, press, and admin pages
- Credit and licence lines
- Car, circuit, and driver names, as well as car and circuit descriptions
- Text included in bug reports and wheel diagnostics
- Race-control messages constructed inside the simulation worker

## Adding a new language

```bash
npm run i18n:add -- tr "Türkçe"
```

Pass the standard browser language tag (`tr`, `pt-BR`, `zh-Hant`) followed by the language's endonym (its own name for itself, displayed in the **Language** picker). Append `--rtl` for right-to-left scripts. The script scaffolds empty area files under `src/i18n/messages/<code>/` and registers the locale in `src/i18n/catalogs.ts`.

## Translating with an AI model

1. **Export missing strings:**

   ```bash
   npm run i18n:missing -- tr --out tr.json
   ```

   Each entry has the English text, a note on where it shows when there is one, and an empty `translation`. The whole game is about 3,700 messages, more than a model returns in one reply, so split it: `--area hud` writes one area, and `--max 300` cuts the output into files of at most 300 messages (`tr.1.json`, `tr.2.json`…). Translate each file in its own request.

2. **Translate using the language glossary:**

   Send each JSON chunk to the model along with the rules below. If a glossary exists at `src/i18n/glossary/<language>.md` (defining recurring sim-racing terminology and form of address), include it so new translations stay consistent with the rest of the UI. Example prompt:

   > Translate the "en" text of every entry in this JSON into Turkish for the "translation" field, for the interface of a racing simulator. Keep the JSON keys and structure exactly. Use the "note" to see where the text appears. Keep every `{placeholder}` and `<tag>` exactly as written, untranslated. In `{count, plural, ...}` and `{x, select, ...}` blocks keep the keyword and the argument name, translate only the text inside the braces, and use your language's plural categories. Keep it as short as the English: most of it is buttons and labels. Leave car names, circuit names, LibreCorsa and the abbreviations DRS, ERS, ABS, TC, MFD, HUD, FFB and km/h as they are. Use sim racing terms the way that language's sim racers do.

3. **Merge and validate:**

   ```bash
   npm run i18n:merge -- tr tr.1.json tr.2.json tr.3.json
   ```

   The merge tool checks every string against its English counterpart to ensure valid ICU syntax and intact placeholders, plurals, and tags. Any invalid entries are reported and skipped so you can correct them and re-run the merge.

4. **Update the glossary:** Whenever you establish a translation for a recurring sim-racing term, add it to `src/i18n/glossary/<language>.md`.

5. **Verify in code and in-game:** Run `npm run i18n:status` and `npx tsx scripts/verify/verify-i18n.ts`, then open the game with `?lang=tr` (or pick the language in Settings) to check for truncation or layout overflow.

## Message formatting rules

- **Placeholders:** Keep `{name}` tokens verbatim and untranslated, placed wherever natural grammar dictates.
- **ICU plurals:** In blocks like `{count, plural, one {# lap} other {# laps}}`, `#` renders the number. Use your language's standard CLDR plural categories (`one`, `few`, `many`, `other`, etc.).
- **Rich-text tags:** In strings like `<n>#</n> turns`, tags apply styling; keep them wrapped around the corresponding translated span.
- **Translator notes:** Check `src/i18n/notes/<area>.json` for UI context whenever an English label could be ambiguous in isolation.
- **Normal capitalization:** Write labels in normal sentence case even when the UI displays them in all caps. Because LibreCorsa sets the document `lang` attribute, CSS handles locale-aware uppercasing accurately (such as Turkish `i` → `İ`).

## Developer guide: adding UI text

- **Inside React components:** Call `const t = useTranslations("menu.title")` and render `t("drive")` or `t("lapTimesBest", { time })`. Add the source string to `src/i18n/messages/en/menu.json`. Message keys are strongly typed, so missing keys fail `npx tsc --noEmit`.
- **Outside React (canvas HUD, toasts):** Import `t("hud.x.y")` from `@/i18n/runtime` and invoke it at render/display time so live language switches take effect immediately. Use `upper(text)` for locale-aware uppercasing.
- **Inside `src/lib`:** Use `text("game.weather.clear")` from `@/lib/text`, which has zero React or client-runtime dependencies so it can be safely imported by the race server, simulation worker, and static pages (returning the active locale in the browser and English elsewhere). Shared lookup tables expose localized strings through getters while preserving their object shape; hot-loop code caches translated strings once per locale via `perLanguage` (`@/lib/per-language`).
- **Keep sentences whole:** Store one complete message per sentence using placeholders for dynamic values. Never concatenate fragments, as word order varies across languages.
- **One key per context:** Give distinct contexts distinct keys (for example, `"Off"` on a toggle switch vs. `"Off"` for a track-limits rule), since translators cannot see the screen.
- **Translate labels, never data:** Only localize user-facing labels. IDs, persisted settings values, wire protocol tokens, code comparisons, ghost files, bug reports, and diagnostics must remain canonical.
- **Add context notes:** Document any short or ambiguous string in `src/i18n/notes/<area>.json`.
- **Right-to-left (Arabic) layout:** Use CSS logical properties rather than physical left/right utilities (`ms-2`, `pe-4`, `start-0`, `text-end`, `border-s`, `rounded-e-md`), which mirror cleanly in RTL while rendering identically in LTR. Check with `node scripts/i18n/logical-classes.mjs --check` (or auto-convert with `--write`). Keyboard arrow navigation in horizontal lists (`Tabs`, `Segmented`) flips automatically when `getComputedStyle(el).direction === "rtl"`. The on-track race HUD (`dir="ltr"` in `F1TelemetryHud`) and slider tracks intentionally stay left-to-right across all languages, while directional icons (`next`, `previous`, `back`) mirror automatically.
- **Verification:** `scripts/verify/verify-i18n.ts` runs as part of `npm run verify`, confirming every English message parses cleanly and every translation preserves its placeholders and tags.
