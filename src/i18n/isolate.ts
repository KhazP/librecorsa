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

/** Latin letters and signs written against a value with no space ("P{place}", "+{points}", "×{n}", "FL·{n}"): part of it */
const PREFIX = /[A-Za-z+\-−±×#~·$€£]+$/;
/** The same after a value ("{n}%", "{n}°", "{n}×", "{n}s"), and a Latin unit one space after it ("{km} km") */
const SUFFIX = /^(?:[A-Za-z%°×+′″]+|[  ](?:km\/h|km|mph|kph|kW|bhp|hp|Nm|rpm|ms|m|s|kg|L|cm|mm|psi|bar|kPa|MB|GB)(?![A-Za-z]))/;
/**
 * Between two values, a slash makes one fraction ("{done} / {total}"), and signs or letters with no space bind them
 * ("FL·{class}×{n}"): isolated whole, or the fraction reads "3 / 2"
 */
const JOIN = /^(?: ?\/ ?|[A-Za-z%\u00b0\u00d7+\u00b7:.\-\u2212]+)$/;

/** A file type written in the text (".zip", ".tar.gz"): right to left, its dot would land at the far end ("zip.") */
const FILE_TYPE = /(?<![\p{L}\p{N}._-])\.[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*(?![\p{L}\p{N}])/gu;

const literal = (value: string): MessageFormatElement => ({ type: TYPE.literal, value });

function isolate(elements: MessageFormatElement[]): MessageFormatElement[] {
  const out: MessageFormatElement[] = [];
  const queue = [...elements];
  while (queue.length) {
    const el = queue.shift()!;
    if (VALUE.has(el.type)) {
      const run: MessageFormatElement[] = [];
      // The glued sign or letters before it, taken off the text before
      const before = out[out.length - 1];
      const glued = before?.type === TYPE.literal ? PREFIX.exec(before.value) : null;
      if (before?.type === TYPE.literal && glued) {
        before.value = before.value.slice(0, glued.index);
        if (!before.value) out.pop();
        run.push(literal(glued[0]));
      }
      run.push(el);
      while (queue[0]?.type === TYPE.literal && JOIN.test(queue[0].value) && queue[1] && VALUE.has(queue[1].type)) {
        run.push(queue.shift()!, queue.shift()!);
      }
      const after = queue[0];
      const tail = after?.type === TYPE.literal ? SUFFIX.exec(after.value) : null;
      if (after?.type === TYPE.literal && tail) {
        after.value = after.value.slice(tail[0].length);
        if (!after.value) queue.shift();
        run.push(literal(tail[0]));
      }
      out.push(literal(FSI), ...run, literal(PDI));
      continue;
    }
    if (el.type === TYPE.literal) {
      el.value = el.value.replace(FILE_TYPE, (m) => FSI + m + PDI);
    } else if (el.type === TYPE.plural || el.type === TYPE.select) {
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
