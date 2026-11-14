// Moves UI source from hard-coded colours, radii, old font classes and arbitrary spacing onto the design tokens
// in the `@theme` block of src/app/globals.css (UI standard §0, §1, §2).
//
//   node scripts/codemod-ui-tokens.mjs                    dry run: what would change, per rule and per file,
//                                                         and every value it refuses
//   node scripts/codemod-ui-tokens.mjs --write            apply
//   node scripts/codemod-ui-tokens.mjs <path> [...]       only these files or folders
//   --root <dir>                                          run against another checkout or a copy of `src`
//   --report <file.md>                                    also write the report to a file
//   --json <file.json>                                    also write every replacement and refusal as JSON
//   --spacing=all                                         rule 6 for every even px value (default: only 6 10 14 18 22 26 30)
//   --near-miss                                           the second pass: only the owner-approved near misses below,
//                                                         which are not value-identical (run it after the first pass)
//
// Plain Node, no dependencies. It works on text patterns, never on line numbers, so it can run again after other
// branches are merged; a second run changes nothing. Token values are read from globals.css at run time.
// Every replacement is checked to be value-identical before anything is written; one failed check writes nothing.
//
// Rules, most confident first:
//   1  `<utility>-[#HEX](/op)`            -> `<utility>-lc-<token>(/op)` when HEX is a token's value
//   2  `<utility>-[rgba(r,g,b,a)]`         -> `<utility>-lc-<token>/<a*100>`, `white/..`, `black/..`;
//      `shadow-[<recipe>]`                 -> `shadow-lc-<name>` when the recipe is a `--shadow-lc-*` value
//   3  `"#HEX"` in a JSX paint attribute or an inline style colour on a DOM / SVG element (or a module constant
//      used only there)                   -> `"var(--color-lc-<token>)"`
//   4  `rounded(-side)-[Npx]`              -> `rounded(-side)-lc-<name>` when N is a `--radius-lc-*` value
//   5  `font-f1-mono`                      -> `lc-mono`
//   6  `<spacing>-[Npx]`, N even           -> `<spacing>-<N/4>`
// A class replacement is held back when it would change which of two same-property classes wins on one element
// (Tailwind breaks that tie by class name), unless the two are different results of one conditional.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------
// Arguments and scope
// ---------------------------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ROOT = resolve(flagValue("--root") ?? process.cwd());
const REPORT = flagValue("--report");
const JSON_OUT = flagValue("--json");
const SPACING_MODE = argv.find((a) => a.startsWith("--spacing="))?.slice("--spacing=".length) ?? "named";
const NEAR_MISS = argv.includes("--near-miss");
if (!["all", "named"].includes(SPACING_MODE)) throw new Error("--spacing= takes all or named");
const positional = argv.filter((a, i) => !a.startsWith("--") && !["--root", "--report", "--json"].includes(argv[i - 1]));
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const SCOPE = ["src/components", "src/app"];
/** Never touched: other owners' folders, generated fonts */
const SKIP = [/^src\/app\/kit\//, /^src\/components\/ui\//, /^src\/app\/fonts\//];

/** Rule 3 never edits these: their colours belong to a drawing of a real object, not to the UI chrome */
const ARTWORK = {
  "src/components/menu/steps/PadMap.tsx": "drawing of a gamepad",
  "src/components/hud/DamageWidget.tsx": "drawing of the car",
  "src/components/hud/StartLights.tsx": "start lights and a chequered flag",
  "src/components/hud/ProximityRadar.tsx": "drawing of the cars around the player",
  "src/app/play/error.tsx": "illustration of a red flag on a pole",
};
/** Rule 3 never edits these: they define data palettes (HUD palette constants, pad faces, grade badges) */
const DATA_PALETTE = {
  "src/components/hud/hud-format.ts": "HUD palette constants and tyre / brake temperature ramps",
  "src/components/menu/input-mode.ts": "pad face-button colours",
  "src/components/home/home-data.ts": "grade badge colours",
};

/**
 * Near misses the owner approved on 13 Nov 2026, applied only with --near-miss. These are NOT value-identical: each
 * moves a colour, radius or shadow onto the nearest token. Anything not listed here is reported, never mapped.
 */
const NEAR_COLOURS = {
  "5a6275": "lc-dim",
  "1a1e2a": "lc-titanium",
  c7ccd8: "lc-fog",
  c9cfdb: "lc-fog",
  c9d1e0: "lc-fog",
  "07070c": "lc-void",
  "0a0b10": "lc-void",
  "0b0b10": "lc-void",
  "0b0d12": "lc-void",
  "0d0f15": "lc-carbon",
  141822: "lc-carbon",
  ffb020: "lc-amber",
  e2ff4d: "lc-volt-hi",
  "4a5268": "lc-keyline",
};
/** Near misses the owner chose not to map: the surface writers set them by meaning */
const NEAR_SKIPPED = { ff6b78: "light error text, set by meaning", ff6b6b: "light error text, set by meaning" };
const NEAR_RADII = { 22: "lc-card", 20: "lc-tile", 16: "lc-row", 12: "lc-nub", 26: "lc-sheet", 30: "lc-sheet", 32: "lc-sheet" };
// Shadows: a single volt halo ring -> shadow-lc-focus; a single black drop (downwards) -> the theme shadow with the
// nearest blur; a 1 px inset hairline in lc-line -> inset-ring inset-ring-lc-line. Volt glow combos are left alone.

// ---------------------------------------------------------------------------------------------------------------
// Tokens, read from globals.css at run time
// ---------------------------------------------------------------------------------------------------------------

const GLOBALS = join(ROOT, "src/app/globals.css");
const css = readFileSync(GLOBALS, "utf8");

function themeBlock(text) {
  // The plain `@theme {` block only, not `@theme inline` / `@theme static`
  const m = /@theme\s*\{/.exec(text);
  if (!m) throw new Error("no @theme { } block in globals.css");
  let depth = 0;
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(m.index + m[0].length, i);
  }
  throw new Error("unterminated @theme block");
}
const themeDecls = new Map();
for (const m of themeBlock(css)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
  themeDecls.set(m[1], m[2].trim());

const hex6 = (h) => {
  h = h.replace(/^#/, "").toLowerCase();
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  return h;
};
const rgbOf = (h) => [0, 2, 4].map((k) => parseInt(hex6(h).slice(k, k + 2), 16));

/** token name (lc-volt) -> { hex, rgb } */
const COLORS = new Map();
/** rrggbb -> token name */
const COLOR_BY_HEX = new Map();
const RADII = new Map(); // px -> name (lc-card)
const SHADOWS = new Map(); // normalised recipe -> name (lc-focus)
const normShadow = (v) =>
  v
    .replace(/_/g, " ")
    .replace(/\s*,\s*/g, ",")
    .replace(/\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
for (const [name, value] of themeDecls) {
  let m;
  if ((m = /^--color-(lc-[\w-]+)$/.exec(name)) && /^#[0-9a-f]{6}$/i.test(value)) {
    COLORS.set(m[1], { hex: hex6(value), rgb: rgbOf(value) });
    if (!COLOR_BY_HEX.has(hex6(value))) COLOR_BY_HEX.set(hex6(value), m[1]);
  } else if ((m = /^--radius-(lc-[\w-]+)$/.exec(name)) && /^\d+(\.\d+)?px$/.test(value)) {
    RADII.set(parseFloat(value), m[1]);
  } else if ((m = /^--shadow-(lc-[\w-]+)$/.exec(name))) {
    SHADOWS.set(normShadow(value), m[1]);
  }
}
if (!COLORS.size) throw new Error("no --color-lc-* tokens found in the @theme block");

// Tailwind's own values for white, black and the spacing unit: from its theme.css when installed, else its defaults
function tailwindTheme() {
  for (const base of [ROOT, join(SCRIPT_DIR, "..")]) {
    const p = join(base, "node_modules/tailwindcss/theme.css");
    if (existsSync(p)) return { path: relative(ROOT, p) || p, text: readFileSync(p, "utf8") };
  }
  return null;
}
const twTheme = tailwindTheme();
const twVar = (name, fallback) => {
  const local = themeDecls.get(name);
  if (local) return { value: local, from: "globals.css @theme" };
  const m = twTheme && new RegExp(`${name}:\\s*([^;]+);`).exec(twTheme.text);
  return m ? { value: m[1].trim(), from: "tailwindcss/theme.css" } : { value: fallback, from: "Tailwind default (theme.css not found)" };
};
const WHITE = twVar("--color-white", "#fff");
const BLACK = twVar("--color-black", "#000");
const SPACING = twVar("--spacing", "0.25rem");
const spacingPx = (() => {
  const m = /^([\d.]+)(rem|px)$/.exec(SPACING.value);
  if (!m) throw new Error(`--spacing is ${SPACING.value}, not a rem or px length`);
  return m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16; // rem at the browser's default 16 px root
})();
const rootFontSize = /(?:^|[\s}])(?:html|:root)\s*\{[^}]*\bfont-size\s*:\s*([^;]+);/.exec(css)?.[1] ?? null;

// Rule 5: the two class bodies, compared rather than assumed
function cssRuleBody(selector) {
  const re = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  if (!m) return null;
  const layered = (() => {
    // Is the rule inside an @layer block? Count unclosed braces of @layer openings before it
    const before = css.slice(0, m.index);
    const lm = [...before.matchAll(/@layer\s+([\w-]+)\s*\{/g)].pop();
    if (!lm) return null;
    let depth = 0;
    for (let i = lm.index; i < m.index; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    return depth > 0 ? lm[1] : null;
  })();
  const decls = new Map();
  for (const d of m[2].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) decls.set(d[1], d[2].trim());
  return { decls, layer: layered };
}
const F1_MONO = cssRuleBody(".font-f1-mono");
const LC_MONO = cssRuleBody(".lc-mono");

// ---------------------------------------------------------------------------------------------------------------
// Lexer: finds string literals, template chunks and JSX attribute strings in TS / TSX, with enough context
// (enclosing JSX element and attribute, bracket stack) for rule 3. Comments, regexes and JSX text are skipped.
// ---------------------------------------------------------------------------------------------------------------

class LexError extends Error {}
class JsxAbort extends Error {}
const KW_BEFORE_EXPR = new Set(
  "return typeof case do else in of new delete void throw yield await instanceof extends default".split(" "),
);
const M_CODE = 0,
  M_STRING = 1,
  M_COMMENT = 2,
  M_TEXT = 3,
  M_REGEX = 4;

function lex(src, jsx) {
  const n = src.length;
  const mask = new Uint8Array(n);
  const strings = []; // { s, e, q, ctx, stack, kind: "js" | "attr" }
  const chunks = []; // template text { s, e, tpl, holeBefore, holeAfter }
  const templates = []; // { s, e, ctx, stack, chunks: [] }
  const idents = []; // { s, e, name, ctx, stack }
  let i = 0;
  const fail = (msg) => {
    throw new LexError(`${msg} at offset ${i}`);
  };
  const markRange = (s, e, kind) => mask.fill(kind, s, e);
  let siteSeq = 0;
  const snap = (stack) => stack.map((b) => ({ ch: b.ch, pos: b.pos, prev: b.prev, prevKind: b.prevKind }));

  function quoted(q) {
    const start = i;
    i++;
    while (i < n && src[i] !== q) {
      if (src[i] === "\\") i++;
      else if (src[i] === "\n") fail("newline in string");
      i++;
    }
    if (i >= n) fail("unterminated string");
    i++;
    markRange(start, i, M_STRING);
    return [start + 1, i - 1];
  }

  function template(ctx, stack) {
    if (ctx.site === undefined) ctx = { ...ctx, site: `tpl${++siteSeq}` };
    const tpl = { s: i, e: -1, ctx, stack: snap(stack), chunks: [] };
    templates.push(tpl);
    i++;
    let cs = i;
    let holeBefore = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        tpl.chunks.push(chunks.push({ s: cs, e: i, tpl, holeBefore, holeAfter: false }) - 1);
        markRange(cs - 1, i + 1, M_STRING);
        i++;
        tpl.e = i;
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        tpl.chunks.push(chunks.push({ s: cs, e: i, tpl, holeBefore, holeAfter: true }) - 1);
        markRange(cs - 1, i + 2, M_STRING);
        i += 2;
        code({ ...ctx, inTemplate: true, from: i }, true);
        cs = i + 1; // past the closing brace
        i++;
        holeBefore = true;
        continue;
      }
      i++;
    }
    fail("unterminated template");
  }

  function regex() {
    const start = i;
    i++;
    let inClass = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") fail(`newline in regex starting at ${start}`);
      if (inClass) {
        if (c === "]") inClass = false;
      } else if (c === "[") inClass = true;
      else if (c === "/") break;
      i++;
    }
    i++;
    while (i < n && /[a-z]/i.test(src[i])) i++;
    markRange(start, i, M_REGEX);
  }

  function skipWsAndComments() {
    for (;;) {
      if (/\s/.test(src[i] ?? "")) i++;
      else if (src[i] === "/" && src[i + 1] === "/") {
        const s = i;
        while (i < n && src[i] !== "\n") i++;
        markRange(s, i, M_COMMENT);
      } else if (src[i] === "/" && src[i + 1] === "*") {
        const s = i;
        const e = src.indexOf("*/", i + 2);
        if (e < 0) fail("unterminated comment");
        i = e + 2;
        markRange(s, i, M_COMMENT);
      } else return;
    }
  }

  /** JS / TS code until EOF, or until an unmatched `}` when `stopAtBrace` (left at that brace) */
  function code(ctx, stopAtBrace) {
    const stack = [];
    let last = "start"; // start | ident | value | close | op | kw
    let lastText = stopAtBrace ? "{" : ""; // entered just past an opening brace (JSX attribute, child or ${})
    while (i < n) {
      const c = src[i];
      if (/\s/.test(c) || (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*"))) {
        skipWsAndComments();
        continue;
      }
      if (c === '"' || c === "'") {
        const [s, e] = quoted(c);
        strings.push({ s, e, q: c, ctx, stack: snap(stack), kind: "js" });
        last = "value";
        lastText = "str";
        continue;
      }
      if (c === "`") {
        template(ctx, stack);
        last = "value";
        lastText = "tpl";
        continue;
      }
      if (c === "{" || c === "(" || c === "[") {
        stack.push({ ch: c, pos: i, prev: lastText, prevKind: last });
        i++;
        last = "op";
        lastText = c;
        continue;
      }
      if (c === "}" || c === ")" || c === "]") {
        if (!stack.length) {
          if (c === "}" && stopAtBrace) return;
          fail(`unbalanced ${c}`);
        }
        const top = stack.pop();
        if ({ "}": "{", ")": "(", "]": "[" }[c] !== top.ch) fail(`mismatched ${c}`);
        i++;
        last = "close";
        lastText = c;
        continue;
      }
      if (c === "/") {
        if (last === "ident" || last === "value" || last === "close") {
          i++;
          last = "op";
          lastText = "/";
        } else {
          regex();
          last = "value";
          lastText = "re";
        }
        continue;
      }
      if (c === "<" && jsx && !(last === "ident" || last === "value" || last === "close") && /[A-Za-z>]/.test(src[i + 1] ?? "")) {
        if (tryJsx()) {
          last = "close";
          lastText = "jsx";
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c)) {
        const s = i;
        while (i < n && /[\w$]/.test(src[i])) i++;
        const name = src.slice(s, i);
        idents.push({ s, e: i, name, ctx, stack: snap(stack) });
        last = KW_BEFORE_EXPR.has(name) ? "kw" : "ident";
        lastText = name;
        continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
        while (i < n && /[\w.]/.test(src[i])) i++;
        last = "value";
        lastText = "num";
        continue;
      }
      i++;
      last = "op";
      lastText = c;
    }
    if (stopAtBrace) fail("end of file inside an expression");
    if (stack.length) fail("unclosed bracket at end of file");
  }

  function tryJsx() {
    const save = { i, s: strings.length, c: chunks.length, t: templates.length, id: idents.length };
    const maskCopy = mask.slice();
    try {
      element();
      return true;
    } catch (e) {
      if (!(e instanceof JsxAbort)) throw e;
      i = save.i;
      strings.length = save.s;
      chunks.length = save.c;
      templates.length = save.t;
      idents.length = save.id;
      mask.set(maskCopy);
      return false;
    }
  }

  function element() {
    i++; // <
    if (src[i] === ">") {
      i++;
      children();
      return;
    }
    const m = /^[A-Za-z_$][\w$.:-]*/.exec(src.slice(i, i + 200));
    if (!m) throw new JsxAbort();
    const tag = m[0];
    i += tag.length;
    if (src[i] === "<") {
      // Type arguments on a component: <Segmented<string> ...>
      let depth = 0;
      do {
        if (src[i] === "<") depth++;
        else if (src[i] === ">") depth--;
        i++;
      } while (i < n && depth > 0 && src[i] !== "\n");
      if (depth !== 0) throw new JsxAbort();
    }
    let first = true;
    for (;;) {
      skipWsAndComments();
      const c = src[i];
      if (c === "/" && src[i + 1] === ">") {
        i += 2;
        return;
      }
      if (c === ">") {
        i++;
        children();
        return;
      }
      if (c === "{") {
        i++;
        code({ tag, attr: "...", jsx: true, site: `attr${++siteSeq}`, from: i }, true);
        i++;
        first = false;
        continue;
      }
      const a = /^[A-Za-z_$][\w$:-]*/.exec(src.slice(i, i + 100));
      if (!a || (first && (a[0] === "extends" || src[i + a[0].length] === ","))) throw new JsxAbort();
      first = false;
      const attr = a[0];
      i += attr.length;
      skipWsAndComments();
      if (src[i] !== "=") continue;
      i++;
      skipWsAndComments();
      const v = src[i];
      if (v === '"' || v === "'") {
        const s = i + 1;
        const e = src.indexOf(v, s);
        if (e < 0) fail("unterminated JSX attribute");
        markRange(i, e + 1, M_STRING);
        strings.push({ s, e, q: v, ctx: { tag, attr, jsx: true, site: `attr${++siteSeq}` }, stack: [], kind: "attr" });
        i = e + 1;
      } else if (v === "{") {
        i++;
        code({ tag, attr, jsx: true, site: `attr${++siteSeq}`, from: i }, true);
        i++;
      } else if (v === "<") nested();
      else if (first) throw new JsxAbort();
      else fail("bad JSX attribute value");
    }
  }

  /** An element inside JSX is JSX for certain: a parse problem there is an error, not a reason to back out */
  function nested() {
    try {
      element();
    } catch (e) {
      if (e instanceof JsxAbort) fail("JSX element not understood");
      throw e;
    }
  }

  function children() {
    for (;;) {
      if (i >= n) fail("end of file inside JSX");
      const c = src[i];
      if (c === "{") {
        i++;
        code({ tag: null, attr: null, jsx: true, child: true, from: i }, true);
        i++;
      } else if (c === "<") {
        if (src[i + 1] === "/") {
          const e = src.indexOf(">", i);
          if (e < 0) fail("unterminated closing tag");
          i = e + 1;
          return;
        }
        nested();
      } else {
        mask[i] = M_TEXT;
        i++;
      }
    }
  }

  code({ from: 0 }, false);
  return { strings, chunks, templates, idents, mask };
}

// ---------------------------------------------------------------------------------------------------------------
// Class-token rules (1, 2, 4, 5, 6)
// ---------------------------------------------------------------------------------------------------------------

const COLOR_UTIL =
  "bg|text|border|border-[xytrblse]|outline|ring|ring-offset|inset-ring|fill|stroke|shadow|inset-shadow|from|via|to|decoration|caret|accent|divide|placeholder";
const RE_COLOR = new RegExp(`^(${COLOR_UTIL})-\\[(?:color:)?(#[0-9a-fA-F]{3,8}|rgba?\\([^\\]]*\\))\\](?:/(\\d+(?:\\.\\d+)?|\\[[^\\]]+\\]|\\([^)]+\\)))?$`);
const RE_SHADOW = /^(shadow|inset-shadow|drop-shadow)-\[(.+)\]$/;
const RE_RADIUS = /^rounded(-(?:tl|tr|br|bl|ss|se|es|ee|ts|te|bs|be|t|r|b|l|s|e))?-\[(\d+(?:\.\d+)?)px\]$/;
const SPACE_UTIL = "p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|inset|inset-x|inset-y|start|end|top|right|bottom|left|space-x|space-y|size|w|h";
const RE_SPACE = new RegExp(`^(-?)(${SPACE_UTIL})-\\[(\\d+(?:\\.\\d+)?)px\\]$`);
const NEGATABLE = /^(m|mx|my|mt|mr|mb|ml|ms|me|inset|inset-x|inset-y|start|end|top|right|bottom|left|space-x|space-y)$/;
const NAMED_SPACE_PX = new Set([6, 10, 14, 18, 22, 26, 30]);
/** Classes that set font-family or font-variant-numeric: beside font-f1-mono they decide the cascade (rule 5) */
const RE_FONT_CONFLICT =
  /^(font-(sans|serif|mono|lc-display|lc-body|lc-mono|f1-display|f1-italic)|font-\[(?![\d]).*\]|normal-nums|proportional-nums|oldstyle-nums|lining-nums|ordinal|slashed-zero|diagonal-fractions|stacked-fractions|lc-(disp|title|h1|h2|h3|row-label|body|hint)|hud-num|hud-label)$/;

function splitVariants(token) {
  let depth = 0;
  let cut = -1;
  for (let k = 0; k < token.length; k++) {
    const c = token[k];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) cut = k;
  }
  let variants = token.slice(0, cut + 1);
  let base = token.slice(cut + 1);
  let lead = "";
  let trail = "";
  if (base.startsWith("!")) {
    lead = "!";
    base = base.slice(1);
  }
  if (base.endsWith("!")) {
    trail = "!";
    base = base.slice(0, -1);
  }
  return { variants, lead, base, trail };
}

/** "0.12" -> 12, "12%" -> 12, "1" -> 100; null unless it is a whole percent. String arithmetic, no float error */
function alphaPercent(a) {
  if (a === undefined) return 100;
  a = a.trim();
  let m;
  if ((m = /^(\d+(?:\.\d+)?)%$/.exec(a))) return /^\d+$/.test(m[1]) || /^\d+\.0+$/.test(m[1]) ? parseInt(m[1], 10) : null;
  if (!(m = /^(0|1)?(?:\.(\d+))?$/.exec(a)) || a === "" || a === ".") return null;
  const whole = m[1] ?? "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > 2) return null;
  const pct = parseInt(whole, 10) * 100 + parseInt((frac + "00").slice(0, 2), 10);
  return pct <= 100 ? pct : null;
}

function parseRgb(v) {
  const m = /^rgba?\(\s*(\d+)[\s,_]+(\d+)[\s,_]+(\d+)(?:(?:[\s,_]+|[\s_]*\/[\s_]*)([\d.]+%?))?[\s_]*\)$/.exec(v);
  if (!m) return null;
  return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] };
}

const toHex = (rgb) => rgb.map((x) => x.toString(16).padStart(2, "0")).join("");
const dist = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
function nearestToken(rgb) {
  let best = null;
  for (const [name, t] of COLORS) {
    const d = dist(rgb, t.rgb);
    if (!best || d < best.d) best = { name, d };
  }
  return best;
}
const fmtStep = (n) => String(Number(n.toFixed(4)));

/**
 * One class token -> { to, rule, check } when it can be replaced, { refuse, why, table } when it is listed instead,
 * or null when no rule is about it.
 */
function classToken(token, siblings) {
  if (!/-\[|font-f1-/.test(token)) return null;
  const { variants, lead, base, trail } = splitVariants(token);
  const wrap = (b) => `${variants}${lead}${b}${trail}`;
  let m;

  // Rule 5
  if (/^font-f1-(mono|display|italic)$/.test(base)) {
    if (base !== "font-f1-mono") return { refuse: true, rule: "font", table: "font-keep", value: base, why: `${base} is kept` };
    if (variants || lead || trail)
      return { refuse: true, rule: "font", table: "font-mono-refused", value: token, why: "has a variant or !: lc-mono is a component class, variants do not apply to it" };
    const clash = siblings.map((t) => splitVariants(t).base).filter((b) => RE_FONT_CONFLICT.test(b));
    if (clash.length)
      return { refuse: true, rule: "font", table: "font-mono-refused", value: token, why: `same class list also sets the font: ${[...new Set(clash)].join(", ")}` };
    return { to: "lc-mono", rule: "5", check: { kind: "font" } };
  }

  // Rule 2 (shadow recipes) and the shadow table
  if ((m = RE_SHADOW.exec(base)) && !/^#[0-9a-fA-F]{3,8}$/.test(m[2]) && !/^rgba?\(/.test(m[2])) {
    const name = m[1] === "shadow" ? SHADOWS.get(normShadow(m[2])) : undefined;
    if (name) return { to: wrap(`shadow-${name}`), rule: "2-shadow", check: { kind: "shadow", from: m[2], name } };
    const near = m[1] === "shadow" && NEAR_MISS ? nearShadow(normShadow(m[2])) : null;
    if (near) return { to: near.to.split(" ").map(wrap).join(" "), rule: "N-shadow", near: true, check: { kind: "near-shadow", from: m[2], ...near } };
    return { refuse: true, rule: "shadow", table: "shadow", value: base, why: "arbitrary shadow" };
  }

  // Rules 1 and 2
  if ((m = RE_COLOR.exec(base))) {
    const [, util, value, op] = m;
    if (value.startsWith("#")) {
      const h = value.slice(1);
      if (![3, 4, 6, 8].includes(h.length)) return { refuse: true, rule: "1", table: "colour", value, why: "malformed hex" };
      const six = hex6(value).slice(0, 6);
      const alphaHex = h.length === 8 ? h.slice(6).toLowerCase() : h.length === 4 ? (h[3] + h[3]).toLowerCase() : null;
      const name = COLOR_BY_HEX.get(six);
      if (!name && NEAR_MISS && NEAR_COLOURS[six] && alphaHex === null)
        return { to: wrap(`${util}-${NEAR_COLOURS[six]}${op ? `/${op}` : ""}`), rule: "N1", near: true, check: { kind: "near-colour", from: six, name: NEAR_COLOURS[six] } };
      if (!name) return { refuse: true, rule: "1", table: "colour", value: `#${six}`, rgb: rgbOf(six), why: "no token has this value" };
      if (alphaHex === null) return { to: wrap(`${util}-${name}${op ? `/${op}` : ""}`), rule: "1", check: { kind: "colour", from: six, name, alpha: op ?? null, keepsSuffix: true } };
      if (op) return { refuse: true, rule: "1", table: "refused-class", value: token, why: "8-digit hex and an opacity suffix together" };
      const byte = parseInt(alphaHex, 16);
      const pct = (byte * 100) / 255;
      if (!Number.isInteger(pct)) return { refuse: true, rule: "1", table: "refused-class", value: token, why: `alpha byte ${alphaHex} is ${pct.toFixed(2)} %, not a whole percent` };
      return { to: wrap(`${util}-${name}${pct === 100 ? "" : `/${pct}`}`), rule: "1", check: { kind: "colour-alpha", from: six, name, alphaByte: byte, pct } };
    }
    const p = parseRgb(value);
    if (!p) return { refuse: true, rule: "2", table: "refused-class", value: token, why: "rgb() form not understood" };
    if (op && p.alpha !== undefined) return { refuse: true, rule: "2", table: "refused-class", value: token, why: "rgba alpha and an opacity suffix together" };
    const pct = op ? null : alphaPercent(p.alpha);
    if (!op && pct === null) return { refuse: true, rule: "2", table: "refused-class", value: token, why: `alpha ${p.alpha} is not a whole percent` };
    const sixRgb = toHex(p.rgb);
    let name = COLOR_BY_HEX.get(sixRgb);
    if (!name && sixRgb === hex6(WHITE.value)) name = "white";
    if (!name && sixRgb === hex6(BLACK.value)) name = "black";
    if (!name) return { refuse: true, rule: "2", table: "colour", value: `rgb(${p.rgb.join(",")})`, rgb: p.rgb, why: "no token has this value" };
    const suffix = op ? `/${op}` : pct === 100 ? "" : `/${pct}`;
    return { to: wrap(`${util}-${name}${suffix}`), rule: "2", check: { kind: "rgba", rgb: p.rgb, alpha: p.alpha ?? null, pct, name, keepsSuffix: !!op } };
  }

  // Rule 4
  if ((m = RE_RADIUS.exec(base))) {
    const px = parseFloat(m[2]);
    const name = RADII.get(px);
    if (!name && NEAR_MISS && NEAR_RADII[px])
      return { to: wrap(`rounded${m[1] ?? ""}-${NEAR_RADII[px]}`), rule: "N4", near: true, check: { kind: "near-radius", px, name: NEAR_RADII[px] } };
    if (!name) return { refuse: true, rule: "4", table: "radius", value: base, why: "not a radius token" };
    return { to: wrap(`rounded${m[1] ?? ""}-${name}`), rule: "4", check: { kind: "radius", px, name } };
  }

  // Rule 6
  if ((m = RE_SPACE.exec(base))) {
    const [, neg, util, v] = m;
    const px = parseFloat(v);
    if (neg && !NEGATABLE.test(util)) return null;
    if (!Number.isInteger(px) || px % 2 !== 0) return { refuse: true, rule: "6", table: "spacing", value: `${util}-[${v}px]`, why: "odd or fractional px" };
    const step = px / spacingPx;
    if (Math.abs(step * 4 - Math.round(step * 4)) > 1e-9) return { refuse: true, rule: "6", table: "spacing", value: `${util}-[${v}px]`, why: "not a quarter step" };
    if (SPACING_MODE === "named" && !NAMED_SPACE_PX.has(px)) return { refuse: true, rule: "6", table: "spacing", value: `${util}-[${v}px]`, why: "--spacing=named" };
    return { to: wrap(`${neg}${util}-${fmtStep(step)}`), rule: NAMED_SPACE_PX.has(px) ? "6" : "6-other", check: { kind: "spacing", px, step } };
  }
  // Gradients and other multi-part values that carry a colour: listed, never changed
  if (/^[\w-]+-\[.*(#[0-9a-fA-F]{3,8}|rgba?\().*\]/.test(base)) return { refuse: true, rule: "2", table: "multipart", value: base, why: "multi-part arbitrary value" };
  return null;
}

/** The approved shadow near misses (normalised recipe in, { to, name } out), or null */
function nearShadow(v) {
  if (v.includes("),") || /,(?![^(]*\))/.test(v)) return null; // one layer only: combos (volt glows) stay
  const volt = COLORS.get("lc-volt")?.rgb.join(",");
  let m;
  if ((m = /^0 0 0 (\d+(?:\.\d+)?)px rgba\((\d+,\d+,\d+),([\d.]+)\)$/.exec(v)) && m[2] === volt && SHADOWS.size)
    return { to: "shadow-lc-focus", name: "lc-focus", what: "volt halo" };
  if ((m = /^0 (\d+(?:\.\d+)?)px (\d+(?:\.\d+)?)px rgba\(0,0,0,([\d.]+)\)$/.exec(v))) {
    const blur = Number(m[2]);
    let best = null;
    for (const [recipe, name] of SHADOWS) {
      const b = /^0 [\d.-]+px ([\d.]+)px rgba\(0,0,0,/.exec(recipe);
      if (b && (!best || Math.abs(Number(b[1]) - blur) < best.d)) best = { name, d: Math.abs(Number(b[1]) - blur) };
    }
    return best ? { to: `shadow-${best.name}`, name: best.name, what: "black drop" } : null;
  }
  const line = COLORS.get("lc-line")?.hex;
  if (line && v === `inset 0 0 0 1px #${line}`) return { to: "inset-ring inset-ring-lc-line", name: "lc-line", what: "inset hairline", inset: true };
  return null;
}

/** Tailwind 4's tie-break between utilities that set the same properties: class names compared with numbers as numbers */
function natCmp(a, b) {
  const digit = (c) => c >= 48 && c <= 57;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(j);
    if (digit(ca) && digit(cb)) {
      let ie = i;
      let je = j;
      while (ie < a.length && digit(a.charCodeAt(ie))) ie++;
      while (je < b.length && digit(b.charCodeAt(je))) je++;
      const d = Number(a.slice(i, ie)) - Number(b.slice(j, je));
      if (d !== 0) return d;
      i = ie;
      j = je;
      continue;
    }
    if (ca !== cb) return ca - cb;
    i++;
    j++;
  }
  return a.length - i - (b.length - j);
}

const FAMILY_COLOUR = "ring-offset inset-shadow inset-ring placeholder decoration border-x border-y border-t border-r border-b border-l border-s border-e outline stroke accent divide border caret ring fill from text via bg to"
  .split(" ");
const FAMILY_SPACE = SPACE_UTIL.split("|").sort((x, y) => y.length - x.length);
const RE_COLOUR_VALUE =
  /^(lc-[\w-]+|white|black|transparent|current|inherit|[a-z]+-\d{2,3}|\[(?:color:)?(?:#|rgba?\(|hsla?\(|oklch\(|oklab\(|var\(--color).*\]|\(--color[\w-]*\))(\/.+)?$/;
/** A colour value: an lc- name counts only when it is a colour token (shadow-lc-focus is a shadow, not a colour) */
const isColourValue = (v) => RE_COLOUR_VALUE.test(v) && (!v.startsWith("lc-") || COLORS.has(v.split("/")[0]));
/** Which utilities compete for the same properties: same variants, same importance, same family; null when none of ours */
function sigOf(token) {
  const { variants, lead, base, trail } = splitVariants(token);
  const head = `${variants}|${lead || trail ? "!" : ""}|`;
  let m;
  if ((m = /^rounded(-(?:tl|tr|br|bl|ss|se|es|ee|ts|te|bs|be|t|r|b|l|s|e))?(?:-(.+))?$/.exec(base))) return `${head}radius${m[1] ?? ""}`;
  if ((m = /^(shadow|inset-shadow)(?:-(.+))?$/.exec(base))) return `${head}${m[1]}${m[2] && isColourValue(m[2]) ? "-colour" : ""}`;
  for (const u of FAMILY_COLOUR) if (base.startsWith(`${u}-`) && isColourValue(base.slice(u.length + 1))) return `${head}colour:${u}`;
  for (const u of FAMILY_SPACE) if (base.startsWith(`${u}-`) || base.startsWith(`-${u}-`)) return `${head}space:${u}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Value-identity checks: each replacement must give back the literal it replaced
// ---------------------------------------------------------------------------------------------------------------

const failures = [];
let checksPassed = 0;
function assertSame(cond, what) {
  if (cond) checksPassed++;
  else failures.push(what);
}
const colourOfName = (name) =>
  name === "white" ? hex6(WHITE.value) : name === "black" ? hex6(BLACK.value) : COLORS.get(name)?.hex;

function verify(rep, where) {
  const c = rep.check;
  const tag = `${where}: ${rep.from} -> ${rep.to}`;
  switch (c.kind) {
    case "colour":
      return assertSame(colourOfName(c.name) === c.from, tag);
    case "colour-alpha":
      return assertSame(colourOfName(c.name) === c.from && Math.round((c.pct * 255) / 100) === c.alphaByte && (c.pct * 255) % 100 === 0, tag);
    case "rgba": {
      const same = colourOfName(c.name) === toHex(c.rgb);
      const alphaOk = c.keepsSuffix || (c.alpha === null ? c.pct === 100 : alphaPercent(c.alpha) === c.pct && rep.to.endsWith(c.pct === 100 ? c.name : `/${c.pct}`));
      return assertSame(same && alphaOk, tag);
    }
    case "shadow": {
      const theme = themeDecls.get(`--shadow-${c.name}`);
      return assertSame(theme !== undefined && normShadow(theme) === normShadow(c.from), tag);
    }
    case "radius":
      return assertSame(themeDecls.get(`--radius-${c.name}`) === `${c.px}px`, tag);
    case "spacing":
      return assertSame(Math.abs(c.step * spacingPx - c.px) < 1e-9, tag);
    case "font": {
      // Same primary face and the same figures; the full stacks and layers are compared in the report
      const fam = (r) => r?.decls.get("font-family")?.split(",")[0].trim();
      return assertSame(
        !!F1_MONO && !!LC_MONO && fam(F1_MONO) === fam(LC_MONO) && F1_MONO.decls.get("font-variant-numeric") === LC_MONO.decls.get("font-variant-numeric"),
        tag,
      );
    }
    case "var":
      return assertSame(COLORS.get(c.name)?.hex === c.from, tag);
    // The near-miss pass: not value-identical by design. Checked to be exactly an approved mapping onto a real token
    case "near-colour":
      return assertSame(NEAR_MISS && NEAR_COLOURS[c.from] === c.name && COLORS.has(c.name), tag);
    case "near-radius":
      return assertSame(NEAR_MISS && NEAR_RADII[c.px] === c.name && themeDecls.has(`--radius-${c.name}`), tag);
    case "near-shadow":
      return assertSame(NEAR_MISS && (c.inset ? COLORS.has(c.name) : themeDecls.has(`--shadow-${c.name}`)), tag);
    default:
      return assertSame(false, `${tag} (unknown check)`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rule 3: hex literals in DOM / SVG styling
// ---------------------------------------------------------------------------------------------------------------

const PAINT_ATTRS = new Set(["fill", "stroke", "stopColor", "floodColor", "lightingColor", "color"]);
/** Paint attributes are only rewritten on these: a lower-case react-three-fiber element (meshBasicMaterial) is not SVG */
const SVG_TAGS = new Set(
  "svg g path circle rect line polyline polygon ellipse text tspan textPath stop use symbol marker pattern mask clipPath linearGradient radialGradient feFlood feDropShadow".split(" "),
);
/** Inline styles are only rewritten on HTML elements and the SVG elements above */
const isDomTag = (tag) => /^[a-z][a-z0-9]*$/.test(tag) || SVG_TAGS.has(tag);
const COLOUR_KEYS = new Set([
  "color",
  "background",
  "backgroundColor",
  "borderColor",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "borderInlineColor",
  "borderBlockColor",
  "borderInlineStartColor",
  "borderInlineEndColor",
  "outlineColor",
  "textDecorationColor",
  "caretColor",
  "accentColor",
  "columnRuleColor",
  "fill",
  "stroke",
  "stopColor",
  "floodColor",
  "lightingColor",
]);
const RE_HEX_LITERAL = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RE_CANVAS = /\bgetContext\s*\(|\.fillStyle\b|\.strokeStyle\b|\bTHREE\b|from\s+["']three["']|new\s+Color\s*\(|\buniforms?\b|CanvasTexture|DataTexture/;

function makeContext(src, mask) {
  const prevTok = (pos) => {
    let k = pos - 1;
    while (k >= 0 && (/\s/.test(src[k]) || mask[k] === M_COMMENT)) k--;
    if (k < 0) return "";
    if (/[\w$]/.test(src[k])) {
      let s = k;
      while (s > 0 && /[\w$]/.test(src[s - 1])) s--;
      return src.slice(s, k + 1);
    }
    if (/[=!<>?:|&+\-*/%]/.test(src[k])) {
      let s = k;
      while (s > 0 && /[=!<>?|&+\-*/%]/.test(src[s - 1]) && mask[s - 1] === M_CODE && src[k] !== ":") s--;
      return src.slice(s, k + 1);
    }
    return src[k];
  };
  const nextTok = (pos) => {
    let k = pos;
    while (k < src.length && (/\s/.test(src[k]) || mask[k] === M_COMMENT)) k++;
    if (k >= src.length) return "";
    if (/[\w$]/.test(src[k])) return /^[\w$]+/.exec(src.slice(k, k + 40))[0];
    if (/[=!<>?|&+\-*/%]/.test(src[k])) return /^[=!<>?|&+\-*/%]+/.exec(src.slice(k, k + 4))[0];
    return src[k];
  };
  /** Property key of the object member containing `pos`, given the object's opening brace */
  const memberKey = (open, pos) => {
    let depth = 0;
    let lastComma = open;
    for (let k = open + 1; k < pos; k++) {
      if (mask[k] !== M_CODE) continue;
      const c = src[k];
      if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) lastComma = k;
    }
    return /^\s*(?:["']?)([\w$-]+)(?:["']?)\s*:/.exec(src.slice(lastComma + 1, pos))?.[1] ?? null;
  };
  return { prevTok, nextTok, memberKey };
}

/** Is this atom (string literal or identifier) a plain DOM / SVG colour value? */
function domColourSite(atom, cx) {
  const prev = cx.prevTok(atom.a);
  const next = cx.nextTok(atom.b);
  const { ctx, stack } = atom;
  if (ctx.inTemplate) return { ok: false, reason: "concatenated into a template literal" };
  if (prev === "+" || next === "+") return { ok: false, reason: "concatenated" };
  if (/^[=!]==?$/.test(prev) || /^[=!]==?$/.test(next)) return { ok: false, reason: "compared" };
  if (ctx.child) return { ok: false, reason: "JSX child expression" };
  if (ctx.attr && ctx.tag) {
    const intrinsic = /^[a-z][\w-]*$/.test(ctx.tag);
    if (!intrinsic) return { ok: false, reason: `prop of a component (<${ctx.tag} ${ctx.attr}>), which may compare, concatenate or pass it on` };
    if (!isDomTag(ctx.tag)) return { ok: false, reason: `<${ctx.tag}> is not an HTML or SVG element` };
    if (stack.length === 0) {
      if (!PAINT_ATTRS.has(ctx.attr)) return { ok: false, reason: `attribute ${ctx.attr} is not a paint attribute` };
      if (!SVG_TAGS.has(ctx.tag)) return { ok: false, reason: `paint attribute on <${ctx.tag}>, not an SVG element` };
      const slotOk = ((prev === "{" || prev === ":" || prev === "??" || prev === "||") && next === "}") || (prev === "?" && next === ":");
      return slotOk ? { ok: true, how: "attribute" } : { ok: false, reason: "inside a larger expression" };
    }
    if (ctx.attr === "style" && stack.length === 1 && stack[0].ch === "{" && ["{", "?", ":"].includes(stack[0].prev)) {
      const key = cx.memberKey(stack[0].pos, atom.a);
      if (!key || !COLOUR_KEYS.has(key)) return { ok: false, reason: `style key ${key ?? "?"} is not a plain colour property` };
      const slotOk = ((prev === ":" || prev === "??" || prev === "||") && (next === "," || next === "}")) || (prev === "?" && next === ":");
      return slotOk ? { ok: true, how: "style" } : { ok: false, reason: "inside a larger expression" };
    }
    if (stack.some((b) => b.ch === "(" && b.prevKind === "ident")) return { ok: false, reason: "passed to a function" };
    return { ok: false, reason: `nested inside the ${ctx.attr} expression (object, array or call)` };
  }
  const top = stack[stack.length - 1];
  if (top?.ch === "(" && top.prevKind === "ident") return { ok: false, reason: "passed to a function" };
  if (prev === "return" || prev === "=>") return { ok: false, reason: "returned from a function" };
  if (top?.ch === "[") return { ok: false, reason: "in an array (data table)" };
  if (top?.ch === "{" && (prev === "," || (prev === ":" && cx.memberKey(top.pos, atom.a)))) return { ok: false, reason: "in an object (data table or style map)" };
  if (prev === "=" && stack.some((b) => b.ch === "(" || b.ch === "{") && /^[,})]$/.test(next)) return { ok: false, reason: "prop or parameter default" };
  if (prev === "=" && stack.length) return { ok: false, reason: "local variable" };
  if (prev === "?" || prev === ":" || prev === "??" || prev === "||") return { ok: false, reason: "computed value (ternary or fallback outside JSX)" };
  return { ok: false, reason: "not a DOM / SVG styling site" };
}

// ---------------------------------------------------------------------------------------------------------------
// Per file
// ---------------------------------------------------------------------------------------------------------------

function* walk(path) {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isFile()) return void (yield path);
  for (const name of readdirSync(path).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    yield* walk(join(path, name));
  }
}

function lineOf(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** All edits for one file's text, plus what it refused. Pure: does not write */
function transform(file, src, sink) {
  const jsx = file.endsWith(".tsx");
  let lx;
  try {
    lx = lex(src, jsx);
  } catch (e) {
    if (e instanceof LexError || e instanceof JsxAbort) return { error: e.message, edits: [] };
    throw e;
  }
  const starts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") starts.push(k + 1);
  const where = (pos) => `${file}:${lineOf(starts, pos)}`;
  const lineText = (pos) => {
    const l = lineOf(starts, pos);
    return src.slice(starts[l - 1], (starts[l] ?? src.length + 1) - 1).trim();
  };
  const edits = [];
  const note = (table, value, pos, why, extra = {}) => sink?.refusal({ table, value, where: where(pos), line: lineText(pos), why, file, ...extra });

  // Class lists: every string literal, JSX attribute string and template chunk
  const pieces = [];
  for (const s of lx.strings) pieces.push({ s: s.s, e: s.e, group: s, holeBefore: false, holeAfter: false });
  for (const c of lx.chunks) pieces.push({ s: c.s, e: c.e, group: c.tpl, holeBefore: c.holeBefore, holeAfter: c.holeAfter });
  const groupTokens = new Map();
  const tokensOf = (group) => {
    if (!groupTokens.has(group)) {
      const text = group.chunks ? group.chunks.map((ci) => src.slice(lx.chunks[ci].s, lx.chunks[ci].e)).join(" ") : src.slice(group.s, group.e);
      groupTokens.set(group, text.split(/\s+/).filter(Boolean));
    }
    return groupTokens.get(group);
  };
  // Class lists that can land on one element together: one JSX attribute (with every literal and template inside it),
  // one template, one call's arguments; otherwise the literal alone
  const siteOf = (g) => g.ctx?.site ?? (g.stack?.find((b) => b.ch === "(") ? `call${g.stack.find((b) => b.ch === "(").pos}` : `lit${g.s}`);
  const allTokens = [];
  const classEdits = [];
  for (const p of pieces) {
    const text = src.slice(p.s, p.e);
    // Import paths and non-class strings never hold class-shaped tokens; skip import specifiers outright
    if (p.group.kind === "js" && /\b(from|import|require)\s*\(?\s*$/.test(src.slice(Math.max(0, p.s - 30), p.s - 1))) continue;
    const site = siteOf(p.group);
    const literal = p.group.s;
    // Where the literal (or the whole template, for template text) sits in its expression
    const place = { from: p.group.ctx?.from ?? 0, stack: p.group.stack ?? [], at: p.group.chunks ? p.group.s : p.group.s - 1 };
    for (const m of text.matchAll(/\S+/g)) {
      const tok = m[0];
      const a = p.s + m.index;
      const b = a + tok.length;
      allTokens.push({ tok, a, site, literal, place });
      if (!/-\[|font-f1-/.test(tok)) continue;
      const touchesHole = (p.holeBefore && m.index === 0) || (p.holeAfter && b === p.e);
      const r = classToken(tok, tokensOf(p.group));
      if (!r) continue;
      if (touchesHole) {
        if (!r.refuse) note("refused-class", tok, a, "touches a ${} hole, so the full class is not known");
        else note(r.table, r.value, a, r.why, { rgb: r.rgb });
        continue;
      }
      if (r.refuse) {
        note(r.table, r.value, a, r.why, { rgb: r.rgb });
        continue;
      }
      if (NEAR_MISS !== !!r.near) continue; // each pass applies only its own kind
      classEdits.push({ a, b, from: tok, to: r.to, rule: r.rule, check: r.check, where: where(a), inset: !!r.check.inset });
    }
  }

  // Cascade order. Tailwind sorts utilities that set the same properties by class name, so renaming one can change
  // which of two classes on the same element wins (`text-[#8E96AA]` beat `text-[#F5F7FA]`'s rival order differently
  // than `text-lc-slate` and `text-lc-chalk`). Any replacement that would flip such a pair is refused, until none do.
  const editAt = new Map(classEdits.map((e) => [e.a, e]));
  const refusedAt = new Map();
  const bySite = new Map();
  for (const t of allTokens) {
    const sig = sigOf(t.tok);
    if (!sig) continue;
    if (!bySite.has(t.site)) bySite.set(t.site, []);
    bySite.get(t.site).push({ ...t, sig });
  }
  const now = (t) => (editAt.has(t.a) && !refusedAt.has(t.a) ? editAt.get(t.a).to : t.tok);
  // Two literals that are different results of one conditional (`on ? "text-a" : "text-b"`) never land together
  const exclusive = (p, q) => {
    if (!p || !q || p.from !== q.from || p.at === q.at) return false;
    let k = 0;
    while (k < p.stack.length && k < q.stack.length && p.stack[k].pos === q.stack[k].pos) k++;
    const start = k ? p.stack[k - 1].pos + 1 : p.from;
    const end = Math.max(p.at, q.at);
    const seps = [];
    let depth = 0;
    for (let x = start; x < end; x++) {
      if (lx.mask[x] !== M_CODE) continue;
      const c = src[x];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && (c === "," || c === ":" || (c === "?" && src[x + 1] !== "." && src[x + 1] !== "?" && src[x - 1] !== "?"))) seps.push({ x, c });
    }
    const placeOf = (pos) => {
      const before = seps.filter((sp) => sp.x < pos);
      const arg = before.filter((sp) => sp.c === ",").length;
      const lastComma = before.filter((sp) => sp.c === ",").pop()?.x ?? -1;
      const inArg = before.filter((sp) => sp.x > lastComma && sp.c !== ",");
      const after = seps.find((sp) => sp.x > pos);
      const lead = inArg.length ? inArg[inArg.length - 1].c : null;
      // a result: just after "?", or after ":" with no "?" closing the segment
      const result = lead === "?" || (lead === ":" && !(after && after.c === "?"));
      return { arg, seg: inArg.length, result };
    };
    const a = placeOf(p.at);
    const b = placeOf(q.at);
    return a.arg === b.arg && a.result && b.result && a.seg !== b.seg;
  };
  let exclusiveFlips = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (const toks of bySite.values()) {
      for (let x = 0; x < toks.length; x++)
        for (let y = x + 1; y < toks.length; y++) {
          const [t, u] = [toks[x], toks[y]];
          if (t.sig !== u.sig || t.tok === u.tok || !(editAt.has(t.a) || editAt.has(u.a))) continue;
          if (editAt.get(t.a)?.inset || editAt.get(u.a)?.inset) continue; // checked below: it leaves the shadow slot
          if (Math.sign(natCmp(t.tok, u.tok)) === Math.sign(natCmp(now(t), now(u)))) continue;
          if (exclusive(t.place, u.place)) {
            if (!t.counted || !u.counted) exclusiveFlips++;
            t.counted = u.counted = true;
            continue;
          }
          const why = `would change which of ${t.tok} / ${u.tok} wins on one element (${t.literal === u.literal ? "same class string" : "same attribute, template or call"})`;
          for (const v of [t, u]) if (editAt.has(v.a) && !refusedAt.has(v.a)) refusedAt.set(v.a, { why, same: t.literal === u.literal });
          changed = true;
        }
    }
  }
  // An inset hairline moved to inset-ring no longer shares the box-shadow slot: refuse it where another shadow or inset
  // ring on the same element (any state) used to replace it and would now draw beside it
  const isShadowish = (tok) => {
    const b = splitVariants(tok).base;
    return /^(shadow|inset-shadow|inset-ring)(-|$)/.test(b) && !(/^shadow-/.test(b) && isColourValue(b.slice(7)));
  };
  for (const e of classEdits) {
    if (!e.inset) continue;
    const me = allTokens.find((t) => t.a === e.a);
    const other = allTokens.find((t) => t.site === me.site && t.a !== e.a && isShadowish(t.tok) && !exclusive(t.place, me.place));
    if (other) refusedAt.set(e.a, { why: `would draw beside ${other.tok} instead of being replaced by it`, same: other.literal === me.literal });
  }
  for (const e of classEdits) {
    const r = refusedAt.get(e.a);
    if (r) note("order", e.from, e.a, r.why, { same: r.same, to: e.to });
    else edits.push(e);
  }
  if (sink && exclusiveFlips) sink.exclusiveFlips?.(exclusiveFlips);
  // Every class list that gets a replacement, as it is before and after, for checking against Tailwind itself
  if (sink?.site) {
    const sites = new Map();
    for (const t of allTokens) {
      if (!sites.has(t.site)) sites.set(t.site, []);
      sites.get(t.site).push(t);
    }
    for (const toks of sites.values()) {
      if (!toks.some((t) => editAt.has(t.a) && !refusedAt.has(t.a))) continue;
      const exclusivePairs = [];
      for (let x = 0; x < toks.length; x++)
        for (let y = x + 1; y < toks.length; y++) if (exclusive(toks[x].place, toks[y].place)) exclusivePairs.push([x, y]);
      sink.site({ where: where(toks[0].a), tokens: toks.map((t) => [t.tok, now(t)]), exclusivePairs });
    }
  }
  if (sink) for (const toks of bySite.values())
    for (let x = 0; x < toks.length; x++)
      for (let y = x + 1; y < toks.length; y++) {
        const [t, u] = [toks[x], toks[y]];
        if (t.sig === u.sig && t.tok !== u.tok && (editAt.has(t.a) || editAt.has(u.a)))
          sink.pair?.({ a: t.tok, b: u.tok, a2: now(t), b2: now(u), where: where(t.a), exclusive: exclusive(t.place, u.place) });
      }

  // Rule 3: string literals that are exactly a hex colour, and hex inside longer non-class values
  const cx = makeContext(src, lx.mask);
  const artwork = ARTWORK[file];
  const palette = DATA_PALETTE[file];
  const canvasFile = RE_CANVAS.test(src);
  const threeFile = /from\s+["'](three|@react-three\/[\w-]+)["']/.test(src);
  for (const s of lx.strings) {
    const text = src.slice(s.s, s.e);
    const atom = { a: s.s - 1, b: s.e + 1, ctx: s.ctx, stack: s.stack };
    if (!RE_HEX_LITERAL.test(text)) {
      // hex embedded in a longer, non-class string ("1px solid #262B3D", "drop-shadow(0 0 4px #00E5FF)")
      if (/#[0-9a-fA-F]{6}\b/.test(text) && !/(^|\s)[\w:-]*-\[/.test(text) && s.ctx.attr !== "className")
        for (const h of text.matchAll(/#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/g))
          note("literal-refused", h[0], s.s, "embedded in a longer value", { rgb: rgbOf(h[0].slice(0, 7)), longer: text });
      continue;
    }
    const six = hex6(text);
    const isToken = six.length === 6 && COLOR_BY_HEX.has(six);
    const nearName = NEAR_MISS && six.length === 6 ? NEAR_COLOURS[six] : undefined;
    if (isToken && NEAR_MISS) continue; // the first pass's job
    if (!isToken && !nearName) {
      note("colour", `#${six.slice(0, 6)}${six.length > 6 ? six.slice(6) : ""}`, s.s, six.length > 6 ? "8-digit literal" : "no token has this value", {
        rgb: rgbOf(six.slice(0, 6)),
        literal: true,
        excluded: artwork ? "artwork" : palette ? "data palette" : null,
      });
      continue;
    }
    if (text.length === 4) {
      note("literal-refused", text, s.s, "3-digit hex");
      continue;
    }
    if (artwork) {
      note("literal-refused", text, s.s, `artwork: ${artwork}`);
      continue;
    }
    if (palette) {
      note("literal-refused", text, s.s, `data palette: ${palette}`);
      continue;
    }
    if (threeFile) {
      note("literal-refused", text, s.s, "file imports three or react-three-fiber");
      continue;
    }
    const name = nearName ?? COLOR_BY_HEX.get(six);
    const rule3 = nearName ? "N3" : "3";
    const check3 = nearName ? { kind: "near-colour", from: six, name } : { kind: "var", from: six, name };
    const site = s.kind === "attr" ? attrSite(s) : domColourSite(atom, cx);
    if (site.ok) {
      edits.push({ a: s.s, b: s.e, from: text, to: `var(--color-${name})`, rule: rule3, check: check3, where: where(s.s), how: site.how });
      continue;
    }
    // A module constant used only at DOM / SVG styling sites
    const prev = cx.prevTok(atom.a);
    const decl = /(?:^|\n)([ \t]*)(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*$/.exec(src.slice(Math.max(0, atom.a - 200), atom.a));
    const next = cx.nextTok(atom.b);
    if (prev === "=" && decl && s.stack.length === 0 && !s.ctx.attr && (next === ";" || next === "as" || next === "")) {
      if (decl[2]) {
        note("literal-refused", text, s.s, `exported constant ${decl[3]}`);
        continue;
      }
      if (canvasFile) {
        note("literal-refused", text, s.s, `constant ${decl[3]} in a file that also drives a canvas or three.js`);
        continue;
      }
      const declPos = src.lastIndexOf(decl[3], atom.a);
      const uses = lx.idents.filter((d) => d.name === decl[3] && d.s !== declPos);
      const verdicts = uses.map((u) => {
        if (src[u.s - 1] === "." || cx.nextTok(u.e) === ":") return { ok: false, reason: "member or key with the same name" };
        return domColourSite({ a: u.s, b: u.e, ctx: u.ctx, stack: u.stack }, cx);
      });
      if (uses.length && verdicts.every((v) => v.ok)) {
        edits.push({ a: s.s, b: s.e, from: text, to: `var(--color-${name})`, rule: rule3, check: check3, where: where(s.s), how: `constant ${decl[3]}` });
      } else {
        const bad = verdicts.find((v) => !v.ok);
        note("literal-refused", text, s.s, uses.length ? `constant ${decl[3]} is also used where it is ${bad.reason}` : `constant ${decl[3]} is unused`);
      }
      continue;
    }
    note("literal-refused", text, s.s, site.reason);
  }

  function attrSite(s) {
    const intrinsic = /^[a-z][\w-]*$/.test(s.ctx.tag);
    if (!intrinsic) return { ok: false, reason: `prop of a component (<${s.ctx.tag} ${s.ctx.attr}>), which may compare, concatenate or pass it on` };
    if (!PAINT_ATTRS.has(s.ctx.attr)) return { ok: false, reason: `attribute ${s.ctx.attr} is not a paint attribute` };
    if (!SVG_TAGS.has(s.ctx.tag)) return { ok: false, reason: `paint attribute on <${s.ctx.tag}>, not an SVG element` };
    return { ok: true, how: "attribute" };
  }

  // Lexer cross-check: every class-shaped or hex hit in the raw text must sit in a string or a comment
  for (const m of src.matchAll(/-\[(?:#[0-9a-fA-F]{3,8}|rgba?\()|rounded(?:-[a-z]{1,2})?-\[\d|font-f1-|["'`]#[0-9a-fA-F]{6}/g)) {
    const k = lx.mask[m.index + (m[0][0] === "-" ? 0 : 1)];
    if (k !== M_STRING && k !== M_COMMENT) note("lexer-gap", m[0], m.index, k === M_TEXT ? "in JSX text" : k === M_REGEX ? "in a regex" : "in code, not in a string");
  }

  edits.sort((x, y) => x.a - y.a);
  for (let k = 1; k < edits.length; k++) if (edits[k].a < edits[k - 1].b) throw new Error(`overlapping edits in ${file} at ${edits[k].where}`);
  return { edits, lx };
}

function apply(src, edits) {
  let out = "";
  let at = 0;
  for (const e of edits) {
    out += src.slice(at, e.a) + e.to;
    at = e.b;
  }
  return out + src.slice(at);
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

const refusals = [];
const orderPairs = [];
let exclusiveFlipCount = 0;
const siteLists = [];
const sink = {
  refusal: (r) => refusals.push(r),
  pair: (p) => orderPairs.push(p),
  exclusiveFlips: (n) => (exclusiveFlipCount += n),
  site: (x) => siteLists.push(x),
};
const results = [];
const skipped = [];
const roots = positional.length ? positional : SCOPE;
for (const r of roots) {
  for (const abs of walk(resolve(ROOT, r))) {
    const file = relative(ROOT, abs).split(sep).join("/");
    if (!/\.(tsx|ts)$/.test(file) || /\.d\.ts$/.test(file)) continue;
    if (!SCOPE.some((s) => file.startsWith(`${s}/`)) || SKIP.some((re) => re.test(file))) continue;
    const src = readFileSync(abs, "utf8");
    if (/from\s+["']next\/og["']|ImageResponse/.test(src)) {
      skipped.push({ file, why: "renders through next/og (no CSS variables or classes there)" });
      continue;
    }
    const t = transform(file, src, sink);
    if (t.error) {
      skipped.push({ file, why: `could not be read safely (${t.error}); nothing in it is changed` });
      continue;
    }
    let out = src;
    if (t.edits.length) {
      for (const e of t.edits) verify(e, e.where);
      out = apply(src, t.edits);
      // Idempotence and structure: the result lexes, keeps every literal, and a second pass finds nothing to do
      const again = transform(file, out, null);
      if (again.error) failures.push(`${file}: the result no longer lexes (${again.error})`);
      else {
        if (again.edits.length) failures.push(`${file}: a second run would change ${again.edits.length} more`);
        if (again.lx.strings.length !== t.lx.strings.length || again.lx.chunks.length !== t.lx.chunks.length)
          failures.push(`${file}: the number of string literals changed`);
      }
    }
    results.push({ file, abs, src, out, edits: t.edits });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

const RULE_NAMES = {
  1: "1  hex in a class -> lc token",
  2: "2  rgba in a class -> lc token / white / black",
  "2-shadow": "2  shadow recipe -> theme shadow",
  3: "3  hex literal in DOM / SVG styling -> var()",
  4: "4  arbitrary radius -> lc radius",
  5: "5  font-f1-mono -> lc-mono",
  6: "6  spacing, the named values (6 10 14 18 22 26 30 px)",
  "6-other": "6  spacing, other even px values",
  N1: "near miss: colour in a class (approved list)",
  N3: "near miss: colour literal in DOM / SVG styling (approved list)",
  N4: "near miss: radius (approved list)",
  "N-shadow": "near miss: shadow to lc-focus / lc-pop / lc-sheet / inset-ring",
};
if (!NEAR_MISS) for (const k of ["N1", "N3", "N4", "N-shadow"]) delete RULE_NAMES[k];
else for (const k of Object.keys(RULE_NAMES)) if (!k.startsWith("N")) delete RULE_NAMES[k];
const allEdits = results.flatMap((r) => r.edits);
const byRule = new Map(Object.keys(RULE_NAMES).map((k) => [k, 0]));
for (const e of allEdits) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + 1);

const L = [];
const out = (s = "") => L.push(s);
const cell = (s) => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "'");
const code = (s) => "`" + String(s).replace(/`/g, "'") + "`";
const group = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

out(`# UI token codemod, ${NEAR_MISS ? "second pass (--near-miss: approved near misses, not value-identical)" : "first pass (value-identical)"}: ${WRITE ? "applied" : "dry run"}`);
out();
out(`Spacing mode: ${SPACING_MODE === "named" ? "the seven named values only" : "every even px value"}.`);
out();
out(`Root: ${ROOT}`);
out(`Scope: ${roots.join(", ")} (.ts / .tsx), skipping src/app/kit/**, src/components/ui/**, src/app/fonts/**`);
out(`Tokens read from ${relative(ROOT, GLOBALS)} @theme: ${COLORS.size} colours, ${RADII.size} radii, ${SHADOWS.size} shadows.`);
out(`White ${WHITE.value} and black ${BLACK.value} from ${WHITE.from}; --spacing ${SPACING.value} from ${SPACING.from}.`);
out(
  `Spacing check assumes a ${spacingPx / 0.25 === 16 ? "16 px" : "?"} root: ${rootFontSize ? `globals.css sets the root font-size to ${rootFontSize}, check rule 6 by hand` : "globals.css does not set a root font-size, so 1rem is the browser default (16 px unless the player changed it)"}.`,
);
out();
out(`Files scanned: ${results.length}. Files with changes: ${results.filter((r) => r.edits.length).length}. Replacements: ${allEdits.length}.`);
out(`Value checks passed: ${checksPassed}. Failed: ${failures.length}.`);
if (failures.length) {
  out();
  out("## Failed checks (nothing was written)");
  for (const f of failures) out(`- ${f}`);
}
out();
out("## Replacements per rule");
out();
out("| Rule | Replacements |");
out("|---|---:|");
for (const [k, v] of byRule) out(`| ${RULE_NAMES[k]} | ${v} |`);
out(`| total | ${allEdits.length} |`);
out();
out("Rule 3 sites: " + [...group(allEdits.filter((e) => e.rule === "3" || e.rule === "N3"), (e) => (e.how.startsWith("constant") ? "module constant" : e.how))].map(([k, v]) => `${k} ${v.length}`).join(", ") + ".");
out();
out("## Replacements per file");
out();
out("| File | 1 | 2 | 3 | 4 | 5 | 6 | near miss | Total |");
out("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const r of results.filter((x) => x.edits.length).sort((a, b) => b.edits.length - a.edits.length)) {
  const c = (pred) => r.edits.filter(pred).length;
  out(
    `| ${r.file} | ${c((e) => e.rule === "1")} | ${c((e) => e.rule.startsWith("2"))} | ${c((e) => e.rule === "3")} | ${c((e) => e.rule === "4")} | ${c((e) => e.rule === "5")} | ${c((e) => e.rule.startsWith("6"))} | ${c((e) => e.rule.startsWith("N"))} | ${r.edits.length} |`,
  );
}
out();
out("## Rule 3 sites, one by one");
out();
for (const e of allEdits.filter((x) => x.rule === "3" || x.rule === "N3")) out(`- ${e.where} (${e.how}) ${code(e.from)} -> ${code(e.to)}`);
if (NEAR_MISS) {
  out();
  out("## Approved near misses applied in this pass");
  out();
  out("| From | To | Uses | Change |");
  out("|---|---|---:|---|");
  for (const [k, v] of group(allEdits, (e) => `${e.check.kind}\u0000${e.check.from ?? e.check.px}\u0000${e.check.name}`)) {
    const [kind, from, name] = k.split("\u0000");
    const change =
      kind === "near-colour"
        ? `ΔRGB ${dist(rgbOf(from), COLORS.get(name).rgb).toFixed(1)}`
        : kind === "near-radius"
          ? `${from} px -> ${themeDecls.get(`--radius-${name}`)}`
          : `${v[0].check.what}: ${code(from)}`;
    out(`| ${kind === "near-colour" ? code("#" + from) : kind === "near-radius" ? `${from}px` : "shadow"} | ${kind === "near-shadow" ? code(v[0].check.inset ? "inset-ring inset-ring-lc-line" : `shadow-${name}`) : name} | ${v.length} | ${change} |`);
  }
}
out();
out("## What each distinct replacement becomes");
out();
out("| Rule | From | To | Uses |");
out("|---|---|---|---:|");
for (const [k, v] of [...group(allEdits, (e) => `${e.rule}\u0000${e.from}\u0000${e.to}`)].sort((a, b) => b[1].length - a[1].length)) {
  const [rule, from, to] = k.split("\u0000");
  out(`| ${rule} | ${code(from)} | ${code(to)} | ${v.length} |`);
}

// Near-miss colours
const colourRefusals = refusals.filter((r) => r.table === "colour");
out();
out("## Colours with no token (never changed)");
out();
out("Every distinct hex or rgb() value, in a class or as a string literal, that equals no `--color-lc-*` token. Distance is Euclidean RGB, as in the audit. Data palettes and artwork are counted in their own column.");
out();
out("The last column says what the second pass (`--near-miss`) does with it: the owner-approved token, or report only.");
out();
out("| Value | Uses | In UI | In data / artwork | Nearest token | Distance | --near-miss | Examples |");
out("|---|---:|---:|---:|---|---:|---|---|");
const colourRows = [...group(colourRefusals, (r) => r.value.toLowerCase())].map(([value, list]) => {
  const near = nearestToken(list[0].rgb);
  return { value, list, near };
});
colourRows.sort((a, b) => a.near.d - b.near.d || b.list.length - a.list.length);
for (const { value, list, near } of colourRows) {
  const ui = list.filter((r) => !r.excluded);
  const ex = (ui.length ? ui : list).slice(0, 5).map((r) => r.where.replace(/^src\//, ""));
  const approved = NEAR_COLOURS[value.replace(/^#/, "").slice(0, 6)];
  out(
    `| ${code(value)} | ${list.length} | ${ui.length} | ${list.length - ui.length} | ${near.name} ${COLORS.get(near.name).hex} | ${near.d.toFixed(1)} | ${approved && value.length === 7 ? approved : NEAR_SKIPPED[value.replace(/^#/, "")] ? `skipped: ${NEAR_SKIPPED[value.replace(/^#/, "")]}` : "report only"} | ${ex.join(", ")} |`,
  );
}

// Rule 3 refusals
const litRefused = refusals.filter((r) => r.table === "literal-refused");
out();
out("## Rule 3: hex literals left alone, by reason");
out();
out("Only literals equal to a token are listed here; literals with no token value are in the colour table above.");
const reasonKey = (why) =>
  why.startsWith("prop of a component")
    ? "prop of a component (it may compare, concatenate or pass the colour on)"
    : why.startsWith("constant ") && why.includes("also used")
      ? "module constant also used outside DOM / SVG styling"
      : why.startsWith("artwork")
        ? "artwork (drawing of a real object)"
        : why.startsWith("data palette")
          ? "data palette file"
          : why.startsWith("attribute ")
            ? "attribute that is not a paint attribute"
            : why.startsWith("style key")
              ? "style key that is not a plain colour property"
              : why;
for (const [reason, list] of [...group(litRefused, (r) => reasonKey(r.why))].sort((a, b) => b[1].length - a[1].length)) {
  out();
  out(`### ${reason} (${list.length})`);
  out();
  for (const r of list) out(`- ${r.where} ${code(r.value)}${r.why !== reason ? ` (${r.why})` : ""}: ${code(r.line.slice(0, 150))}`);
}

// Radius near misses
const radius = refusals.filter((r) => r.table === "radius");
out();
out("## Radius values with no token (never changed)");
out();
out(`Tokens: ${[...RADII].map(([px, n]) => `${px}px ${n}`).join(", ")}.`);
out();
out("| Value | Uses | Examples |");
out("|---|---:|---|");
for (const [v, list] of [...group(radius, (r) => r.value)].sort((a, b) => b[1].length - a[1].length))
  out(`| ${code(v)} | ${list.length} | ${list.slice(0, 3).map((r) => `${r.where.replace(/^src\//, "")} ${code(r.line.slice(0, 90))}`).join("<br>")} |`);

// Shadows
const shadows = refusals.filter((r) => r.table === "shadow");
out();
out("## Arbitrary shadows (never changed)");
out();
out(`Theme shadows: ${[...SHADOWS].map(([v, n]) => `${n} = ${code(v)}`).join("; ")}.`);
out();
out("| Shadow | Uses | Examples |");
out("|---|---|---|");
for (const [v, list] of [...group(shadows, (r) => r.value)].sort((a, b) => b[1].length - a[1].length))
  out(`| ${code(v)} | ${list.length} | ${list.slice(0, 3).map((r) => r.where.replace(/^src\//, "")).join(", ")} |`);

// Fonts
out();
out("## Fonts");
out();
const decls = (r) => (r ? [...r.decls].map(([k, v]) => `${k}: ${v}`).join("; ") : "missing");
out(`- .font-f1-mono (${F1_MONO?.layer ? `@layer ${F1_MONO.layer}` : "unlayered"}): ${code(decls(F1_MONO))}`);
out(`- .lc-mono (${LC_MONO?.layer ? `@layer ${LC_MONO.layer}` : "unlayered"}): ${code(decls(LC_MONO))}`);
const famDiff = F1_MONO && LC_MONO && F1_MONO.decls.get("font-family") !== LC_MONO.decls.get("font-family");
out(
  `- Checked: same first face and the same font-variant-numeric. ${famDiff ? "The fallback stacks differ (only matters if Geist Mono fails to load)." : "The stacks are identical."} ${F1_MONO?.layer !== LC_MONO?.layer ? "The layers differ: an unlayered rule beats every Tailwind utility and @layer components rule, lc-mono does not. Class lists where that could matter are refused below." : ""}`,
);
for (const t of ["font-mono-refused", "font-keep"]) {
  const list = refusals.filter((r) => r.table === t);
  out();
  out(t === "font-mono-refused" ? `### font-f1-mono left alone (${list.length})` : `### font-f1-display / font-f1-italic, kept (${list.length})`);
  out();
  if (t === "font-keep") {
    if (!list.length) out("No uses in the files in scope. The three class definitions in globals.css stay for you to retire.");
    for (const [v, l] of group(list, (r) => r.value)) {
      out(`- ${code(v)} ${l.length} uses in ${new Set(l.map((r) => r.file)).size} files:`);
      for (const [f, fl] of group(l, (r) => r.file)) out(`  - ${f}: lines ${fl.map((r) => r.where.split(":").pop()).join(", ")}`);
    }
  } else for (const r of list) out(`- ${r.where}: ${r.why}: ${code(r.line.slice(0, 150))}`);
}

// Spacing and other class refusals
const spacing = refusals.filter((r) => r.table === "spacing");
out();
out("## Spacing left alone");
out();
out(spacing.length ? [...group(spacing, (r) => r.value.replace(/^.*-\[/, "["))].sort((a, b) => b[1].length - a[1].length).map(([v, l]) => `${code(v)} ${l.length}`).join(", ") : "None.");
const multipart = refusals.filter((r) => r.table === "multipart");
out();
out("## Other multi-part arbitrary values with a colour (never changed)");
out();
if (!multipart.length) out("None.");
for (const [v, list] of group(multipart, (r) => r.value)) out(`- ${code(v)} ${list.length}: ${list.map((r) => r.where.replace(/^src\//, "")).join(", ")}`);
const other = refusals.filter((r) => r.table === "refused-class");
out();
out("## Other class tokens left alone");
out();
if (!other.length) out("None.");
for (const r of other) out(`- ${r.where} ${code(r.value)}: ${r.why}`);
const order = refusals.filter((r) => r.table === "order");
out();
out("## Left alone because the cascade order would change");
out();
out(
  `Tailwind sorts utilities that set the same properties by class name, so a rename can change which of two classes on one element wins. ${orderPairs.length} same-property pairs that share an attribute, template or call were compared; replacements that would flip one are refused (${order.length}: ${order.filter((r) => r.same).length} where both classes sit in the same string, ${order.filter((r) => !r.same).length} where they sit in different strings of one expression). Flips between two results of one conditional, which never land on an element together, are allowed: ${exclusiveFlipCount}.`,
);
if (order.length) out();
for (const r of order) out(`- ${r.where} ${code(r.value)} (would be ${code(r.to)}): ${r.why}`);
const gaps = refusals.filter((r) => r.table === "lexer-gap");
out();
out("## Lexer cross-check");
out();
out(gaps.length ? `${gaps.length} hits outside any string or comment (left alone):` : "Every class-shaped or hex hit in the raw text was found inside a string literal, template or comment.");
for (const r of gaps) out(`- ${r.where} ${code(r.value)} ${r.why}: ${code(r.line.slice(0, 140))}`);
out();
out("## Files not touched");
out();
for (const [f, why] of Object.entries(ARTWORK)) out(`- ${f}: rule 3 skipped, ${why}`);
for (const [f, why] of Object.entries(DATA_PALETTE)) out(`- ${f}: rule 3 skipped, ${why}`);
for (const s of skipped) out(`- ${s.file}: ${s.why}`);
if (!skipped.length) out("- Every other in-scope file was read.");

// Tailwind 4 emits a theme variable only when a utility or the CSS uses it; its scanner does not see var() in TSX.
// So every token rule 3 writes as var() must also be used as a class somewhere in src, or through var() in a .css file.
const outByAbs = new Map(results.map((r) => [r.abs, r.out]));
let classText = "";
let cssText = "";
for (const abs of walk(join(ROOT, "src"))) {
  if (/\.css$/.test(abs)) cssText += readFileSync(abs, "utf8");
  else if (/\.(tsx|ts)$/.test(abs)) classText += (outByAbs.get(abs) ?? readFileSync(abs, "utf8")).replace(/var\(--color-lc-[\w-]+\)/g, "");
}
const emitted = new Set(allEdits.filter((e) => e.rule === "3" || e.rule === "N3").map((e) => e.check.name));
const varOnly = [...emitted].filter((n) => !new RegExp(`-${n}(?![\\w-])`).test(classText) && !cssText.includes(`var(--color-${n})`));
out();
out("## Tokens rule 3 writes as var() that nothing else keeps in the built CSS");
out();
out(
  varOnly.length
    ? `${varOnly.join(", ")}: Tailwind would drop these variables. Use one as a class somewhere or reference it in globals.css before applying.`
    : `None. Each of ${[...emitted].join(", ") || "(none)"} is also used as a class in src or through var() in a stylesheet, so Tailwind keeps the variable.`,
);

const report = L.join("\n") + "\n";
process.stdout.write(report);
if (REPORT) writeFileSync(resolve(REPORT), report);
if (JSON_OUT)
  writeFileSync(
    resolve(JSON_OUT),
    JSON.stringify(
      {
        edits: allEdits.map(({ where, rule, from, to, how }) => ({ where, rule, from, to, how })),
        refusals: refusals.map(({ where, table, value, why }) => ({ where, table, value, why })),
        orderPairs,
        sites: siteLists,
        skipped,
        failures,
      },
      null,
      1,
    ),
  );

if (failures.length) {
  console.error(`\n${failures.length} value checks failed: nothing written.`);
  process.exit(1);
}
if (WRITE) {
  let n = 0;
  for (const r of results) if (r.out !== r.src) (writeFileSync(r.abs, r.out), n++);
  console.error(`\nWrote ${n} files.`);
} else console.error("\nDry run: nothing written. Run with --write to apply.");
