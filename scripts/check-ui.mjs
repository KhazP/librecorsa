// Checks UI source against the rules of docs/DESIGN.md that a typecheck cannot see.
//   node scripts/check-ui.mjs                 every UI file, summary per rule
//   node scripts/check-ui.mjs <path> [...]    only these files or folders, every finding listed
//   --strict                                  exit 1 when anything is found
// A line that has to break a rule says so, on the line or the one above it:  // ui-allow: <rule-id> <the reason>
// (a driver's own colour, a livery swatch, a flag's real colours). Allowed lines are counted and listed, never hidden.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const targets = args.filter((a) => !a.startsWith("--"));
const roots = targets.length ? targets : ["src/components", "src/app"];

// The kit page draws swatches of raw values, and the logo's own colours are defined once in its geometry
const SKIP = [/^src\/app\/kit\//, /^src\/components\/ui\/logo\/geometry\.ts$/, /^src\/app\/fonts\//];
// The in-race HUD may go down to 9 px; everything else stops at 11 px (the key cap's 10 px glyph is the one exception)
const isHud = (f) =>
  /^src\/components\/(hud\/(?!PauseMenu|MultiplayerPanel|LeaderboardPanel|SeatPanel|RaceResults|LapSummary|PodiumOverlay|RacesCard)|F1TelemetryHud|TrackMinimap)/.test(
    f,
  );

const RULES = [
  {
    id: "hex-in-class",
    why: "colour comes from a token (bg-lc-volt), never a hex or rgb() in a class",
    test: (line) => /(?:^|[\s"'`:])[a-z-]+(?::[a-z-]+)*-\[(?:#[0-9a-fA-F]{3,8}|rgba?\()/.test(line),
  },
  {
    id: "hex-in-style",
    why: "inline styles and constants take var(--color-lc-*), not a hex",
    test: (line, f) =>
      /["'`]#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?["'`]/.test(line) && !/badges\/(class-colors|compounds)\.ts$/.test(f),
  },
  {
    id: "lucide-direct",
    why: "icons come through <Icon name>, one per concept (src/components/ui/icons)",
    test: (line, f) => /from ["']lucide-react["']/.test(line) && !f.startsWith("src/components/ui/icons/"),
  },
  {
    id: "glyph-as-icon",
    why: "no Unicode glyph or emoji stands in for an icon",
    test: (line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /[▲▼▴▾◂▸◀▶✓✔✕✖★☆●○←→↑↓⇧⏎ⒶⒷⓍⓎ⚠]/u.test(line.replace(/\/\/.*$/, "").replace(/\{\/\*.*?\*\/\}/g, "")),
  },
  {
    id: "dot-label-header",
    why: "a card is named by a plain heading (Card title=), not a dot plus tracked caps",
    test: (line) => /<(SectionLabel|CardHeader|PanelSection|CardLabel)\b/.test(line) || /SetupCard[^>]*\blabel=/.test(line),
  },
  {
    id: "text-too-small",
    why: "menus stop at 11 px, the HUD at 9 px",
    test: (line, f) => {
      // Key caps and pad glyphs are 10 px glyphs, and the badge's HUD size is 9 px: the sanctioned exceptions
      if (/^src\/components\/ui\/(prompts\/|Badge\.tsx$)/.test(f)) return false;
      const floor = isHud(f) ? 9 : 11;
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (Number(m[1]) < floor) return true;
      for (const m of line.matchAll(/fontSize:\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/g)) if (Number(m[1]) < floor) return true;
      return false;
    },
  },
  {
    id: "old-font-class",
    why: "font-f1-* is replaced by lc-mono / lc-data / lc-chip-text",
    test: (line) => /\bfont-f1-(mono|display|italic)\b/.test(line),
  },
  {
    id: "arbitrary-radius",
    why: "radius comes from the scale (rounded-lc-sheet / card / tile / row / nub / full)",
    test: (line) => /\brounded(?:-[tblrse]{1,2})?-\[\d+px\]/.test(line),
  },
];

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) return void (yield path);
  for (const name of readdirSync(path)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    yield* walk(join(path, name));
  }
}

const findings = [];
const allowed = [];
const allows = (text, rule) => new RegExp(`ui-allow:\\s*${rule}\\s+\\S`).test(text ?? "");
for (const root of roots) {
  for (const abs of walk(join(ROOT, root))) {
    const file = relative(ROOT, abs).split(sep).join("/");
    if (!/\.(tsx|ts|css)$/.test(file) || SKIP.some((re) => re.test(file))) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (file.endsWith(".css") && rule.id !== "old-font-class") continue;
        if (!rule.test(line, file)) continue;
        const hit = { rule: rule.id, file, line: i + 1, text: line.trim().slice(0, 140) };
        (allows(line, rule.id) || allows(lines[i - 1], rule.id) ? allowed : findings).push(hit);
      }
    });
  }
}

const byRule = new Map(RULES.map((r) => [r.id, []]));
for (const f of findings) byRule.get(f.rule).push(f);

for (const rule of RULES) {
  const list = byRule.get(rule.id);
  const files = new Set(list.map((f) => f.file)).size;
  console.log(`${String(list.length).padStart(5)}  ${rule.id.padEnd(18)} ${files} file${files === 1 ? "" : "s"}  ${rule.why}`);
  if (targets.length) for (const f of list) console.log(`         ${f.file}:${f.line}  ${f.text}`);
}
console.log(`${String(findings.length).padStart(5)}  total`);
if (allowed.length) {
  console.log(`${String(allowed.length).padStart(5)}  allowed by a ui-allow comment`);
  if (targets.length) for (const f of allowed) console.log(`         ${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
}
if (strict && findings.length) process.exit(1);
