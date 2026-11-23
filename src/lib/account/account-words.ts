/**
 * The account side's sentences in the player's language. The account store, the sync and the server all speak
 * English (the verify suites compare those sentences, and the server answers `{ ok: false, error }` with one), so the
 * screens pass each sentence through `accountWords` when they show it: a sentence that is the English of a message
 * under game.account.notices, .errors or .server comes back in the current language; anything else (a technical
 * answer a player shouldn't meet) stays as it came. scripts/verify-account-words.ts checks that every sentence the
 * store, the sync and the server can send is one of those messages.
 */
import game from "@/i18n/messages/en/game.json";
import type { MessageKey } from "@/i18n/types";
import { text } from "@/lib/text";

const AREAS = ["notices", "errors", "server"] as const;

interface Rule {
  key: MessageKey;
  /** For a message with plain `{name}` arguments: the English with each argument as a capture */
  pattern?: RegExp;
  names?: string[];
}

/** The apostrophe is ’ in the messages and ' in the code's English */
const plain = (s: string) => s.replace(/[’‘]/g, "'").trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let exact: Map<string, MessageKey> | null = null;
let patterns: Rule[] = [];

function build(): Map<string, MessageKey> {
  const map = new Map<string, MessageKey>();
  const found: Rule[] = [];
  for (const area of AREAS) {
    for (const [name, english] of Object.entries(game.account[area] as Record<string, string>)) {
      const key = `game.account.${area}.${name}` as MessageKey;
      if (english.includes(", plural,") || english.includes(", select,")) continue;
      const args = [...english.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (!args.length) {
        map.set(plain(english), key);
        continue;
      }
      const source = plain(english)
        .split(/\{\w+\}/)
        .map(escape)
        .join("(.+?)");
      found.push({ key, pattern: new RegExp(`^${source}$`), names: args });
    }
  }
  patterns = found;
  return map;
}

/** `sentence` in the current language when it is one of the account's messages, else as it came */
export function accountWords(sentence: string): string;
export function accountWords(sentence: string | null): string | null;
export function accountWords(sentence: string | null): string | null {
  if (!sentence) return sentence;
  exact ??= build();
  const said = plain(sentence);
  const key = exact.get(said);
  if (key) return text(key);
  for (const rule of patterns) {
    const m = rule.pattern!.exec(said);
    if (!m) continue;
    const values: Record<string, string> = {};
    rule.names!.forEach((n, i) => (values[n] = m[i + 1]));
    return text(rule.key, values);
  }
  return sentence;
}

/** Whether a sentence is one the screens can show in every language (verify-account-words.ts) */
export function isAccountMessage(sentence: string): boolean {
  exact ??= build();
  const said = plain(sentence);
  return exact.has(said) || patterns.some((r) => r.pattern!.test(said));
}
