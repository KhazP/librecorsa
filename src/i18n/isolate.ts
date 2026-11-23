import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { printAST } from "@formatjs/icu-messageformat-parser/printer.js";
import type { PartialMessages } from "./types";

/**
 * For a language written right to left: every value the game fills into a message (a time, a speed, a name, a
 * plural's number) wrapped in Unicode isolates, so it reads as one unit. Without them the browser's bidi rules glue a
 * number to the Latin unit or code beside it: "5.34 km · 14 منعطفًا" shows as "منعطفًا km · 14 5.34". Loaded only for
 * a right-to-left language (runtime.ts).
 */
const FSI = "⁨";
const PDI = "⁩";

const VALUE = new Set<TYPE>([TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.pound]);

function isolate(elements: MessageFormatElement[]): MessageFormatElement[] {
  const out: MessageFormatElement[] = [];
  for (const el of elements) {
    if (VALUE.has(el.type)) {
      out.push({ type: TYPE.literal, value: FSI }, el, { type: TYPE.literal, value: PDI });
      continue;
    }
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values(el.options)) option.value = isolate(option.value);
    } else if (el.type === TYPE.tag) {
      el.children = isolate(el.children);
    }
    out.push(el);
  }
  return out;
}

export function isolateMessage(message: string): string {
  try {
    return printAST(isolate(parse(message)));
  } catch {
    return message;
  }
}

function transform(value: unknown): unknown {
  if (typeof value === "string") return isolateMessage(value);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, transform(v)]));
  return value;
}

export const isolateMessages = (messages: PartialMessages): PartialMessages => transform(messages) as PartialMessages;
