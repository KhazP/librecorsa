import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { printAST } from "@formatjs/icu-messageformat-parser/printer.js";
import type { Messages, PartialMessages } from "./types";

/**
 * The pseudo-language (?lang=en-XA): every English message with its letters accented, a third longer and in brackets,
 * so text the code still hard-codes stands out in plain English, text that gets cut off shows its missing bracket,
 * and a layout can be checked against longer languages without a translation. Placeholders, plurals and tags are
 * kept as they are, so every message still formats.
 */
const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ö",
  p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Å", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ö",
  P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

const accent = (text: string) => text.replace(/[A-Za-z]/g, (ch) => ACCENTS[ch] ?? ch);

function walk(elements: MessageFormatElement[]): number {
  let letters = 0;
  for (const el of elements) {
    if (el.type === TYPE.literal) {
      letters += el.value.replace(/[^A-Za-z]/g, "").length;
      el.value = accent(el.value);
    } else if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values(el.options)) letters += walk(option.value);
    } else if (el.type === TYPE.tag) {
      letters += walk(el.children);
    }
  }
  return letters;
}

export function pseudoMessage(message: string): string {
  try {
    const ast = parse(message);
    const letters = walk(ast);
    const pad = "~".repeat(Math.ceil(letters / 3));
    return `[${printAST(ast)}${pad ? ` ${pad}` : ""}]`;
  } catch {
    return `[${accent(message)}]`;
  }
}

function transform(value: unknown): unknown {
  if (typeof value === "string") return pseudoMessage(value);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v)]));
  }
  return value;
}

export const pseudoMessages = (en: Messages): PartialMessages => transform(en) as PartialMessages;
