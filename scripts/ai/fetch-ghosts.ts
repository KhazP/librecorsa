/**
 * Downloads the fastest laps of the online boards (their ghosts) for the AI line tools: every circuit, car and physics
 * revision with laps, the top drivers of each assist class, dry and wet. The ghosts carry driver names, so they stay
 * in the local reference folder ($REALISM_REF/ghosts), never in the repository; only lines derived from them are.
 *
 *   npx tsx scripts/ai/fetch-ghosts.ts [--top 10] [--track spielberg] [--base https://librecorsa.org]
 *
 * Writes $REALISM_REF/ghosts/<track>/<id>.json (the LapRecording as served) and $REALISM_REF/ghosts/index.json (one
 * row per lap: circuit, car, physics, conditions, lap time; no names). A ghost already on disk is not fetched again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VEHICLE_MODEL_IDS } from "../../src/types/f1";
import { lapPhysicsVersion } from "../../src/lib/sim/lap-types";
import { ASSIST_PRESETS } from "../../src/lib/sim/lap-types";
import { GHOST_DIR, type GhostIndexRow } from "./lib/ghosts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const BASE = opt("base", "https://librecorsa.org").replace(/\/$/, "");
const TOP = Math.max(1, Math.min(100, Number(opt("top", "10"))));
const only = opt("track", "");
const tracks = (
  JSON.parse(readFileSync("public/tracks/index.json", "utf8")) as {
    id: string;
  }[]
)
  .map((e) => e.id)
  .filter((id) => !only || id === only);

interface BoardLap {
  id?: string;
  lapTimeMs: number;
  conditions?: {
    assists: string;
    realism: string;
    surface: string;
    physicsVersion: number;
    tyre?: string;
  };
}

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      headers: { "User-Agent": "librecorsa-ai-tools" },
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    if (r?.ok) return r.json();
    if (r && r.status === 404) return null;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return null;
}

async function board(
  track: string,
  vehicle: string,
  physics: number,
  assists?: string,
) {
  const q = new URLSearchParams({
    track,
    vehicle,
    physics: String(physics),
    limit: String(TOP),
  });
  if (assists) q.set("assists", assists);
  return (await getJson(`${BASE}/api/laps?${q}`)) as {
    laps: BoardLap[];
    total: number;
    physics: number[];
  } | null;
}

async function main(): Promise<void> {
  const indexPath = join(GHOST_DIR, "index.json");
  mkdirSync(GHOST_DIR, { recursive: true });
  const index = new Map<string, GhostIndexRow>(
    existsSync(indexPath)
      ? (JSON.parse(readFileSync(indexPath, "utf8")) as GhostIndexRow[]).map(
          (r) => [r.id, r],
        )
      : [],
  );
  let fetched = 0,
    kept = 0;
  for (const track of tracks) {
    for (const vehicle of VEHICLE_MODEL_IDS) {
      const first = await board(
        track,
        vehicle,
        lapPhysicsVersion(vehicle === "lc26" ? undefined : vehicle),
      );
      // The revisions with laps here (the LC26's rigid-body revision is not this process's default: ask the server)
      const revisions = new Set<number>(first?.physics ?? []);
      for (const physics of revisions) {
        const ids = new Map<string, BoardLap>();
        // The open board lists each driver's best; each assist class may hold another driver's (or the same driver's) lap
        for (const assists of [undefined, ...ASSIST_PRESETS]) {
          const b = await board(track, vehicle, physics, assists);
          for (const lap of b?.laps ?? []) if (lap.id) ids.set(lap.id, lap);
        }
        for (const [id, lap] of ids) {
          const dir = join(GHOST_DIR, track);
          const file = join(dir, `${id}.json`);
          if (!existsSync(file)) {
            const rec = await getJson(
              `${BASE}/api/laps/${encodeURIComponent(id)}`,
            );
            if (!rec) continue;
            mkdirSync(dir, { recursive: true });
            writeFileSync(file, JSON.stringify(rec));
            fetched++;
          }
          index.set(id, {
            id,
            track,
            vehicle,
            physics,
            lapTimeMs: lap.lapTimeMs,
            assists: lap.conditions?.assists ?? null,
            realism: lap.conditions?.realism ?? null,
            surface: lap.conditions?.surface ?? null,
          });
          kept++;
        }
        if (ids.size)
          console.log(`${track} · ${vehicle} · p${physics}: ${ids.size} laps`);
      }
    }
  }
  writeFileSync(
    indexPath,
    JSON.stringify(
      [...index.values()].sort(
        (a, b) => a.track.localeCompare(b.track) || a.lapTimeMs - b.lapTimeMs,
      ),
      null,
      1,
    ),
  );
  console.log(
    `${kept} laps indexed, ${fetched} ghosts downloaded, in ${GHOST_DIR}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
