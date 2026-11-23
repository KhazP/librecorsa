import type { MessageKey } from "@/i18n/types";
import game from "@/i18n/messages/en/game.json";

/**
 * The words the game's own code shows (labels in shared tables, banners, statuses), as code outside React reads them:
 * `text("game.weather.clear")`, called when the text is shown so a change of language reaches it.
 *
 * This file stays free of React and of the language runtime (src/i18n/runtime.ts), because the race server, the
 * simulation worker and the server-rendered pages import the tables that use it. On the page, ui-prefs.ts binds it to
 * the runtime, and from then on it reads the current language. Unbound (on the server, in the worker, in a script)
 * it reads the English of messages/en/game.json, formatted here: plain `{name}` arguments, `plural` (one / other /
 * =n, with #) and `select`, the forms game.json uses.
 */
type Values = Record<string, string | number | Date>;
type Translate = (key: MessageKey, values?: Values) => string;

let bound: { translate: Translate; locale: () => string } | null = null;

/** Hands the messages to the language runtime (the page does this once; see ui-prefs.ts) */
export function bindText(translate: Translate, locale: () => string): void {
  bound = { translate, locale };
}

export function text(key: MessageKey, values?: Values): string {
  return bound ? bound.translate(key, values) : english(key, values);
}

/** `read` with every word in English whatever the language: for bug reports, which stay English */
export function inEnglish<T>(read: () => T): T {
  const was = bound;
  bound = null;
  try {
    return read();
  } finally {
    bound = was;
  }
}

/** The language the words are in: the runtime's once bound, else English */
export const textLocale = (): string => (bound ? bound.locale() : "en");

/** Upper case as the current language writes it (Turkish i → İ), for words drawn in capitals on a canvas */
export const upperText = (words: string): string => words.toLocaleUpperCase(textLocale());

function english(key: string, values: Values = {}): string {
  const path = key.split(".");
  if (path[0] !== "game") return key;
  const message = path.slice(1).reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), game);
  return typeof message === "string" ? format(message, values) : key;
}

/** The index of the `}` that closes the `{` at `open` */
function closing(msg: string, open: number): number {
  let depth = 0;
  for (let i = open; i < msg.length; i++) {
    if (msg[i] === "{") depth++;
    else if (msg[i] === "}" && --depth === 0) return i;
  }
  return msg.length;
}

function format(msg: string, values: Values, hash?: string): string {
  let out = "";
  for (let i = 0; i < msg.length; i++) {
    const c = msg[i];
    if (c === "{") {
      const end = closing(msg, i);
      out += argument(msg.slice(i + 1, end), values, hash);
      i = end;
    } else if (c === "#" && hash !== undefined) out += hash;
    else if (c === "'" && msg[i + 1] === "'") {
      out += "'";
      i++;
    } else out += c;
  }
  return out;
}

function argument(body: string, values: Values, hash?: string): string {
  const first = body.indexOf(",");
  const name = (first < 0 ? body : body.slice(0, first)).trim();
  const value = values[name];
  if (first < 0) return value === undefined ? `{${name}}` : String(value);
  const second = body.indexOf(",", first + 1);
  const type = body.slice(first + 1, second).trim();
  // The choices: `selector {message}` pairs
  const choices = new Map<string, string>();
  const rest = body.slice(second + 1);
  for (let i = 0; i < rest.length; ) {
    const open = rest.indexOf("{", i);
    if (open < 0) break;
    const end = closing(rest, open);
    choices.set(rest.slice(i, open).trim(), rest.slice(open + 1, end));
    i = end + 1;
  }
  if (type === "plural") {
    const n = Number(value);
    const chosen = choices.get(`=${n}`) ?? choices.get(n === 1 ? "one" : "other") ?? choices.get("other") ?? "";
    return format(chosen, values, String(n));
  }
  return format(choices.get(String(value)) ?? choices.get("other") ?? "", values, hash);
}
