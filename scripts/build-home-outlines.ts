/**
 * Remakes the home page's circuit outlines (src/lib/home/circuit-outlines.json) from each circuit's track data:
 * `npm run home-outlines`. Run it after adding a circuit or changing a circuit's line.
 *
 * Most circuits' track data lives in the asset bucket, not in the repository, so the outlines are kept in a file of
 * their own that the build reads. A circuit whose track data isn't in this copy keeps the outline it already has.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import trackIndex from "../public/tracks/index.json";
import { lapOutlineOf, type LapOutline, type RawLap } from "../src/lib/home/lap-outline";

const OUT = join(process.cwd(), "src/lib/home/circuit-outlines.json");

const before: Record<string, LapOutline> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const after: Record<string, LapOutline> = {};
const kept: string[] = [];
const missing: string[] = [];

for (const t of trackIndex as { id: string; dataUrl?: string }[]) {
  const file = join(process.cwd(), "public", t.dataUrl ?? `/tracks/${t.id}/track_data.json`);
  if (existsSync(file)) after[t.id] = lapOutlineOf(JSON.parse(readFileSync(file, "utf8")) as RawLap);
  else if (before[t.id]) {
    after[t.id] = before[t.id];
    kept.push(t.id);
  } else missing.push(t.id);
}

writeFileSync(OUT, `${JSON.stringify(after)}\n`);
console.log(`${Object.keys(after).length} outlines, ${(readFileSync(OUT).length / 1024).toFixed(1)} KB`);
if (kept.length) console.log(`Kept as they were (no track data here): ${kept.join(", ")}`);
if (missing.length) console.warn(`No outline (no track data here): ${missing.join(", ")}`);
