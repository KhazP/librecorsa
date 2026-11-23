/**
 * Rewrites physical Tailwind classes (ml-2, pr-4, left-0, text-right, border-l, rounded-tr-md…) as their logical
 * twins (ms-2, pe-4, start-0, text-end, border-s, rounded-se-md…), so a page laid out right to left (Arabic) mirrors.
 * Left to right the two are the same CSS, so English and every other language look exactly as before.
 *
 *   node scripts/i18n/logical-classes.mjs           (lists what it would change)
 *   node scripts/i18n/logical-classes.mjs --write   (changes the files)
 *   node scripts/i18n/logical-classes.mjs --check   (fails if any physical class is left; for after a merge)
 *
 * Left alone: `left-1/2` / `right-1/2` (they centre with a translate, which doesn't mirror), notch gutters
 * (`pl-[max(1rem,env(safe-area-inset-left))]`: a side and that side's inset), `origin-*` and
 * translate / rotate (no logical form), and the files in KEEP.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const DIRS = ["src/components", "src/app"];
/**
 * Left physical in every language: the third-party race HUD skins (the HUD is drawn left to right, F1TelemetryHud),
 * and the switch and slider, whose knob and track move left to right with a translate and a native range
 */
const KEEP = ["src/components/hud/styles/", "src/components/ui/Toggle.tsx", "src/components/ui/Slider.tsx"];

const SIDE = { l: "s", r: "e" };
const CORNER = { tl: "ss", tr: "se", bl: "es", br: "ee" };
/** physical utility (after any variants and a leading "-") → its logical form, or null to leave it */
const VALUE = /^(-?\d+(\.\d+)?|\d+\/\d+|auto|full|px|\[.+)$/;
function logical(util) {
  let m;
  // A notch gutter pairs a side with that side's inset: it stays on its physical side
  if (util.includes("safe-area-inset")) return null;
  if ((m = util.match(/^(m|p|scroll-m|scroll-p)([lr])-(.+)$/))) return VALUE.test(m[3]) ? `${m[1]}${SIDE[m[2]]}-${m[3]}` : null;
  if ((m = util.match(/^(left|right)-(.+)$/))) {
    if (m[2] === "1/2" || !VALUE.test(m[2])) return null;
    return `${m[1] === "left" ? "start" : "end"}-${m[2]}`;
  }
  if ((m = util.match(/^text-(left|right)$/))) return `text-${m[1] === "left" ? "start" : "end"}`;
  if ((m = util.match(/^float-(left|right)$/))) return `float-${m[1] === "left" ? "start" : "end"}`;
  if ((m = util.match(/^border-([lr])(-.+)?$/))) return `border-${SIDE[m[1]]}${m[2] ?? ""}`;
  if ((m = util.match(/^rounded-([lr])(-.+)?$/))) return `rounded-${SIDE[m[1]]}${m[2] ?? ""}`;
  if ((m = util.match(/^rounded-(tl|tr|bl|br)(-.+)?$/))) return `rounded-${CORNER[m[1]]}${m[2] ?? ""}`;
  return null;
}

/** A class token: optional variants ("sm:", "group-hover:", "[&>svg]:"), an optional "!" and "-", the utility */
const TOKEN = /(?<=^|[\s"'`{(,])((?:(?:\[[^\]\s"'`]*\]|[\w-]+(?:\/[\w-]+)?|@[\w-]+(?:\/[\w-]+)?):)*)(!?)(-?)((?:m|p|scroll-m|scroll-p)[lr]-[^\s"'`)]+|(?:left|right)-[^\s"'`)]+|text-(?:left|right)|float-(?:left|right)|border-[lr](?:-[^\s"'`)]+)?|rounded-(?:[lr]|tl|tr|bl|br)(?:-[^\s"'`)]+)?)(?=$|[\s"'`}),])/g;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : "list";
const changes = new Map();
let total = 0;
for (const dir of DIRS) {
  for (const file of files(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    if (KEEP.some((k) => rel.startsWith(k))) continue;
    const text = readFileSync(file, "utf8");
    let n = 0;
    const next = text.replace(TOKEN, (all, variants, bang, neg, util) => {
      const to = logical(util);
      if (!to) return all;
      n++;
      const key = `${neg}${util} → ${neg}${to}`;
      changes.set(key, (changes.get(key) ?? 0) + 1);
      return `${variants}${bang}${neg}${to}`;
    });
    if (n) {
      total += n;
      if (mode === "write") writeFileSync(file, next);
      if (mode !== "write") console.log(`${rel}: ${n}`);
    }
  }
}
if (mode === "list") for (const [k, v] of [...changes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`${total} physical classes ${mode === "write" ? "rewritten" : "found"}`);
if (mode === "check" && total) process.exit(1);
