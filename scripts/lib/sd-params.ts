/**
 * Speed Dreams' parameter files (a car's `<car>.xml`, a category's `categories/<cat>.xml`, a circuit's settings): the
 * `<params>` XML that the game's tgf library reads (src/libs/tgf/params.cpp), read the same way here.
 *
 *   <params name="…">
 *     <section name="Car">
 *       <attnum name="mass" unit="kg" min="900" max="1500" val="1180"/>
 *       <attstr name="category" in="LS-GT2" val="LS-GT2"/>
 *       <section name="data points"> <section name="1"> … </section> </section>
 *     </section>
 *   </params>
 *
 * Numbers are converted to SI by their `unit` exactly as `GfParmUnit2SI` does, quirks included: "lbs" is a mass
 * (0.45359 kg), so a spring in "lbs/in" becomes 17.86 kg/m and the game's simulation uses that number as N/m. A value
 * with no `min`/`max` has its own value for both. A car's file is merged over its category's as `GfParmMergeHandles`
 * merges them (`mergeOver`): a number takes the car's value clamped into the range both files allow, a string the
 * car's when the category lists it among its `in` values and the category's otherwise.
 */
import { readFileSync } from "node:fs";

export interface SdNum {
  kind: "num";
  /** In SI */
  val: number;
  min: number;
  max: number;
  /** As written in the file, `""` for none */
  unit: string;
}

export interface SdStr {
  kind: "str";
  val: string;
  /** The `in` list, empty when the file has none */
  within: string[];
}

export type SdAttr = SdNum | SdStr;

export interface SdSection {
  name: string;
  attrs: Map<string, SdAttr>;
  sections: Map<string, SdSection>;
}

const newSection = (name: string): SdSection => ({ name, attrs: new Map(), sections: new Map() });

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (XML_ENTITIES[e] ?? m)
  );

/**
 * A number as `getValNumFromStr` reads one (strtod: leading spaces, a prefix that parses; 0 for none). strtod also
 * reads "inf", "nan" and numbers past a double's range (1e500), which no converter can use: those are NaN here, for the
 * caller to refuse
 */
const numOf = (s: string): number => {
  if (/^\s*[+-]?(inf|nan)/i.test(s)) return Number.NaN;
  const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s);
  const v = m ? Number(m[0]) : 0;
  return Number.isFinite(v) ? v : Number.NaN;
};

/** One unit name's factor to SI, as `evalUnit` (params.cpp) has it; Celsius is an offset, handled by the caller */
const UNIT_FACTORS: Record<string, number> = {
  deg: Math.PI / 180,
  lbs: 0.45359237,
  lb: 0.45359237,
  "%": 0.01,
  percent: 0.01,
  mm: 0.001,
  rpm: 0.104719755,
  RPM: 0.104719755,
  kPa: 1000,
  feet: 0.304801,
  ft: 0.304801,
  km: 1000,
  cm: 0.01,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  psi: 6894.76,
  PSI: 6894.76,
  mph: 0.44704,
  MPH: 0.44704,
  kph: 0.277778,
  KPH: 0.277778,
  MPa: 1_000_000,
  h: 3600,
  hour: 3600,
  hours: 3600,
  day: 86_400,
  days: 86_400,
  slug: 14.59484546,
  slugs: 14.59484546,
  kN: 1000,
  cc: 0.001,
  ci: 0.0163871,
};
const ZERO_C = 273.15;

function evalUnit(unit: string, value: number, invert: boolean): number {
  if (unit === "C") return invert ? value - ZERO_C : value + ZERO_C;
  const k = UNIT_FACTORS[unit];
  if (k === undefined) return value;
  return invert ? value / k : value * k;
}

/**
 * A value in `unit` in SI, as `GfParmUnit2SI` converts it: the unit is read left to right, `.` multiplies, `/` divides
 * everything after it, and a `2` squares the unit before it ("m2", "kg.m2", "lbs/in/s", "km/h")
 */
export function sdUnitToSI(unit: string, value: number): number {
  if (!unit) return value;
  let buf = "";
  let inv = false;
  let v = value;
  for (const ch of unit) {
    if (ch === ".") {
      v = evalUnit(buf, v, inv);
      buf = "";
    } else if (ch === "/") {
      v = evalUnit(buf, v, inv);
      buf = "";
      inv = true;
    } else if (ch === "2") {
      v = evalUnit(buf, v, inv);
      v = evalUnit(buf, v, inv);
      buf = "";
    } else buf += ch;
  }
  return evalUnit(buf, v, inv);
}

const ATTR_RE = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
function attributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // XML's attribute-value normalisation, as expat does it: each tab or line break is a space ("Front\tRight Brake")
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = unescape((m[3] ?? m[4] ?? "").replace(/[\t\n\r]/g, " "));
  return out;
}

/** Splits a section path ("Front Right Wheel/Compounds/soft") into its names */
const pathParts = (path: string): string[] => path.split("/").filter(Boolean);

export class SdParams {
  private constructor(
    readonly name: string,
    readonly root: SdSection,
    /** Where it was read from, for messages */
    readonly file: string
  ) {}

  static parse(xml: string, file = "params"): SdParams {
    const body = xml
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?[\s\S]*?\?>/g, "")
      .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "");
    const root = newSection("");
    const stack: SdSection[] = [];
    let name = "";
    let sawParams = false;
    // A tag runs to the first `>` outside its quoted values: a value may hold a `>` ("x > y" in a description)
    for (const m of body.matchAll(/<(\/?)([\w:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g)) {
      const [, close, tag, rest, selfClose] = m;
      if (tag === "params") {
        if (!close) {
          sawParams = true;
          name = attributes(rest).name ?? "";
          stack.length = 0;
          stack.push(root);
        }
        continue;
      }
      if (!sawParams) continue;
      const cur = stack[stack.length - 1];
      if (tag === "section") {
        if (close) {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const n = attributes(rest).name;
        if (n === undefined) throw new Error(`${file}: a <section> without a name`);
        let s = cur.sections.get(n);
        if (!s) {
          s = newSection(n);
          cur.sections.set(n, s);
        }
        if (!selfClose) stack.push(s);
        continue;
      }
      if (close || (tag !== "attnum" && tag !== "attstr")) continue;
      const a = attributes(rest);
      if (a.name === undefined || a.val === undefined) throw new Error(`${file}: <${tag}> needs a name and a val`);
      if (stack.length < 2) throw new Error(`${file}: <${tag} name="${a.name}"> outside any section`);
      if (tag === "attnum") {
        const val = numOf(a.val);
        let min = a.min !== undefined ? numOf(a.min) : val;
        let max = a.max !== undefined ? numOf(a.max) : val;
        if (min > max) [min, max] = [max, min];
        min = Math.min(min, val);
        max = Math.max(max, val);
        const unit = a.unit ?? "";
        const si = { val: sdUnitToSI(unit, val), min: sdUnitToSI(unit, min), max: sdUnitToSI(unit, max) };
        if (![si.val, si.min, si.max].every(Number.isFinite)) {
          throw new Error(`${file}: <attnum name="${a.name}" val="${a.val}"${a.min !== undefined ? ` min="${a.min}"` : ""}${a.max !== undefined ? ` max="${a.max}"` : ""}> is not a finite number`);
        }
        cur.attrs.set(a.name, { kind: "num", ...si, unit });
      } else {
        cur.attrs.set(a.name, { kind: "str", val: a.val, within: a.in !== undefined ? a.in.split(",") : [] });
      }
    }
    if (!sawParams) throw new Error(`${file}: not a Speed Dreams parameter file (no <params>)`);
    return new SdParams(name, root, file);
  }

  static read(path: string): SdParams {
    return SdParams.parse(readFileSync(path, "utf8"), path);
  }

  /** The section at `path`, or undefined */
  section(path: string): SdSection | undefined {
    let s: SdSection | undefined = this.root;
    for (const p of pathParts(path)) {
      s = s?.sections.get(p);
      if (!s) return undefined;
    }
    return s;
  }

  has(path: string, key?: string): boolean {
    const s = this.section(path);
    return !!s && (key === undefined || s.attrs.has(key));
  }

  attr(path: string, key: string): SdAttr | undefined {
    return this.section(path)?.attrs.get(key);
  }

  /** A number in SI, or undefined (also for a string attribute, which the game would read as its default) */
  num(path: string, key: string): number | undefined {
    const a = this.attr(path, key);
    return a?.kind === "num" ? a.val : undefined;
  }

  numOr(path: string, key: string, fallback: number): number {
    return this.num(path, key) ?? fallback;
  }

  str(path: string, key: string): string | undefined {
    const a = this.attr(path, key);
    return a?.kind === "str" ? a.val : undefined;
  }

  /** The names of the sections under `path`, in file order */
  sections(path: string): string[] {
    return [...(this.section(path)?.sections.keys() ?? [])];
  }

  /** The attribute names in the section at `path` */
  keys(path: string): string[] {
    return [...(this.section(path)?.attrs.keys() ?? [])];
  }

  /** Every attribute as [section path, key], depth first in file order */
  *entries(): Generator<[string, string, SdAttr]> {
    const walk = function* (s: SdSection, path: string): Generator<[string, string, SdAttr]> {
      for (const [k, a] of s.attrs) yield [path, k, a];
      for (const [n, sub] of s.sections) yield* walk(sub, path ? `${path}/${n}` : n);
    };
    yield* walk(this.root, "");
  }

  /**
   * This file merged over `ref` (a car's over its category's) as `GfParmMergeHandles(ref, this, SRC | DST)` merges
   * them: every value either has, and where both have one, `insertParamMerge`'s choice
   */
  mergeOver(ref: SdParams): SdParams {
    const merge = (r: SdSection | undefined, t: SdSection | undefined, name: string): SdSection => {
      const out = newSection(name);
      for (const [k, a] of r?.attrs ?? []) out.attrs.set(k, a);
      for (const [k, a] of t?.attrs ?? []) {
        const ra = r?.attrs.get(k);
        out.attrs.set(k, ra ? mergeAttr(ra, a) : a);
      }
      const names = new Set([...(r?.sections.keys() ?? []), ...(t?.sections.keys() ?? [])]);
      for (const n of names) out.sections.set(n, merge(r?.sections.get(n), t?.sections.get(n), n));
      return out;
    };
    return new SdParams(this.name || ref.name, merge(ref.root, this.root, ""), `${this.file} over ${ref.file}`);
  }
}

/** `insertParamMerge`: the target's (car's) value within the reference's (category's) limits */
function mergeAttr(ref: SdAttr, tgt: SdAttr): SdAttr {
  if (tgt.kind === "num") {
    // The category's limits hold where the two ranges meet; a car's own outside them is pulled in
    const refMin = ref.kind === "num" ? ref.min : tgt.min;
    const refMax = ref.kind === "num" ? ref.max : tgt.max;
    let min: number;
    if (tgt.min <= refMin && tgt.max >= refMin) min = refMin;
    else if (refMin <= tgt.min && refMax >= tgt.min) min = tgt.min;
    else min = refMin;
    let max: number;
    if (tgt.max >= refMax && tgt.min <= refMax) max = refMax;
    else if (refMax >= tgt.max && refMin <= tgt.max) max = tgt.max;
    else max = refMax;
    const val = Math.min(max, Math.max(min, tgt.val));
    return { kind: "num", val, min, max, unit: tgt.unit };
  }
  const refWithin = ref.kind === "str" ? ref.within : [];
  const refVal = ref.kind === "str" ? ref.val : tgt.val;
  return {
    kind: "str",
    val: refWithin.includes(tgt.val) ? tgt.val : refVal,
    within: tgt.within.filter((w) => refWithin.includes(w)),
  };
}
