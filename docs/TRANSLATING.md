# Translating

The game's text lives in message files, one per area of the game, under `src/i18n/messages/<language>/`. English (`en`) is the source. Every other language is a folder of the same files, and any message it doesn't have yet shows in English, so a language can go in half done and fill up over time.

Players pick a language under Settings > Display > Interface > Language. **Automatic**, the default, follows the browser's language when the game has it.

## What's translated

The menus, Settings, first-run setup, the HUD and its layouts, the lap boards, the account screens, the home page and the game's own messages read their text from the message files: about 3,700 messages. `npm run i18n:status` counts them. To see what still shows in English, open the game with `?lang=en-XA` (for example `https://librecorsa.org/play?lang=en-XA`): that pseudo-language accents every message it knows and puts it in brackets, so plain English on screen is text that isn't in the files yet.

These stay in English on purpose: the about, privacy and press pages, the admin page, credit and licence lines, the names of cars, circuits and drivers, the car and circuit descriptions, text that goes into a bug report or wheel diagnostics, and the race-control messages the simulation worker builds.

## Adding a language

```bash
npm run i18n:add -- tr "Türkçe"
```

The code is the one browsers report for the language (`tr`, `pt-BR`, `zh-Hant`), and the name is the language's own name for itself, as the Language setting lists it. Add `--rtl` for a language written right to left. This makes `src/i18n/messages/tr/` with an empty file per area and adds the language to `src/i18n/catalogs.ts`.

## Translating with an AI model

1. Write out what the language is missing:

   ```bash
   npm run i18n:missing -- tr --out tr.json
   ```

   Each entry has the English text, a note on where it shows when there is one, and an empty `translation`. The whole game is about 3,700 messages, more than a model returns in one reply, so split it: `--area hud` writes one area, and `--max 300` cuts the output into files of at most 300 messages (`tr.1.json`, `tr.2.json`…). Translate each file in its own request.

2. Give the file to the model with the rules below, and ask it to fill in every `translation` and return the same JSON. If the language has a glossary in `src/i18n/glossary/<language>.md` (the terms and the way of addressing the player that the rest of the game uses), give the model that too, so new text matches what's there. A prompt that works:

   > Translate the "en" text of every entry in this JSON into Turkish for the "translation" field, for the interface of a racing simulator. Keep the JSON keys and structure exactly. Use the "note" to see where the text appears. Keep every `{placeholder}` and `<tag>` exactly as written, untranslated. In `{count, plural, ...}` and `{x, select, ...}` blocks keep the keyword and the argument name, translate only the text inside the braces, and use your language's plural categories. Keep it as short as the English: most of it is buttons and labels. Leave car names, circuit names, LibreCorsa and the abbreviations DRS, ERS, ABS, TC, MFD, HUD, FFB and km/h as they are. Use sim racing terms the way that language's sim racers do.

3. Put the answers back:

   ```bash
   npm run i18n:merge -- tr tr.1.json tr.2.json tr.3.json
   ```

   It checks each translation against its English: it must parse, and keep the same placeholders, plurals and tags. Any that don't are listed and left out, so you can fix them and merge again.

4. When a new term comes up that the game will use again, add it to the language's glossary.

5. Check it: `npm run i18n:status`, `npx tsx scripts/verify-i18n.ts`, then play with `?lang=tr` (or pick it in Settings) and look for text that's cut off or too long.

## Rules for the messages

- **Placeholders**: `{name}` is filled in by the game. Keep it, untranslated, anywhere in the sentence your grammar needs it.
- **Plurals**: `{count, plural, one {# lap} other {# laps}}`. `#` is the number. Use the categories your language has (`one`, `few`, `many`, `other`…).
- **Tags**: `<n>#</n> turns`. The tag styles what's inside it. Keep the tags around the same words.
- **Notes**: `src/i18n/notes/<area>.json` says where a message shows, for the ones where the English alone is ambiguous.
- **Upper case**: some labels are drawn in capitals by the design. Write them in normal case; the game sets the language on the page, so the browser capitalises your letters correctly (Turkish i to İ).

## For developers: adding text

- **In a component**: `const t = useTranslations("menu.title")`, then `t("drive")`, or `t("lapTimesBest", { time })` with values. Add the English to `src/i18n/messages/en/menu.json` under the same key. Keys are typed, so a missing one fails `npx tsc --noEmit`.
- **Outside React, in page code** (text drawn on a canvas, a toast): `t("hud.x.y")` from `@/i18n/runtime`, called when the text is shown, so a change of language reaches it. `upper(text)` capitalises the way the current language does.
- **In `src/lib`**: `text("game.weather.clear")` from `@/lib/text`. It has no React and no runtime, because the race server, the simulation worker and the server-rendered pages import those tables; on the page it reads the current language, elsewhere English. A table other files read keeps its shape, with getters for the words. Code that runs every frame builds its words once per language with `perLanguage` (`@/lib/per-language`).
- **Whole sentences**: one message per sentence, with placeholders for what changes. Don't build a sentence from pieces: word order differs between languages.
- **One key per meaning**: "Off" on a switch and "Off" for a track-limits rule are two keys. Translators can't see the screen.
- **Labels, not values**: translate what the player reads. Ids, saved values, anything sent to the server, compared in code or written into a ghost file, a bug report or diagnostics stay as they are.
- **A note** in `src/i18n/notes/<area>.json` for any message that's ambiguous on its own.
- **Right to left (Arabic)**: write sides as start and end, not left and right: `ms-2` / `pe-4` / `start-0` / `text-end` / `border-s` / `rounded-e-md`, which mirror on an Arabic page and are the same CSS everywhere else. `node scripts/i18n/logical-classes.mjs --check` lists physical classes, `--write` rewrites them. A list that steps through its items with the arrow keys flips the step when `getComputedStyle(el).direction` is `rtl` (Tabs, Segmented). The race HUD is drawn left to right in every language (`dir="ltr"` in F1TelemetryHud), and so are slider tracks. Icons that point the way the page reads (`next`, `previous`, `back`) mirror on their own.
- **Checks**: `scripts/verify-i18n.ts` runs with `npm run verify`. It checks every English message parses and every language keeps its placeholders.
