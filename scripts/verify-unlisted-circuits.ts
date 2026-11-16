/**
 * Unlisted circuits (`unlisted` in public/tracks/index.json, src/lib/track-registry.ts): a circuit opened only by its
 * link (`?track=<id>`) stays out of every list the game and the home page build (modders included), still resolves
 * by id, and keeps the flag when the converter rebuilds its index entry.
 *
 *   npx tsx scripts/verify-unlisted-circuits.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import trackIndex from "../public/tracks/index.json";
import {
  CIRCUIT_VENUES,
  LINKED_TRACK_ID,
  LISTED_TRACKS,
  TRACKS,
  getTrackInfo,
  listedTracks,
  type TrackInfo,
} from "../src/lib/track-registry";
import { FORWARD_TO_GAME } from "../src/lib/home/forward-to-game";
import { moddersList } from "../src/lib/modders";
import { CARS } from "../src/lib/cars/car-registry";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failed++;
}

const ROOT = path.resolve(__dirname, "..");
const index = trackIndex as TrackInfo[];
const unlisted = index.filter((t) => t.unlisted);

// The rule itself, on a made-up list
const a = { id: "a" } as TrackInfo;
const b = { id: "b", unlisted: true } as TrackInfo;
const c = { id: "c", unlisted: true } as TrackInfo;
check("an unlisted circuit is left out of a list", listedTracks([a, b, c], null).map((t) => t.id).join() === "a");
check("the one a link names is listed, the other unlisted one is not", listedTracks([a, b, c], "b").map((t) => t.id).join() === "a,b");
check("a link to a listed circuit changes nothing", listedTracks([a, b, c], "a").map((t) => t.id).join() === "a");
check("a link to an unknown circuit changes nothing", listedTracks([a, b, c], "zzz").map((t) => t.id).join() === "a");

// The real index, as the static export builds it (no page, so no link)
check("no link outside a browser", LINKED_TRACK_ID === null);
for (const t of unlisted) {
  const hosted = TRACKS.some((o) => o.id === t.id);
  if (!hosted) {
    check(`${t.id}: not in this copy's circuits (a clone), nothing to list`, true);
    continue;
  }
  check(`${t.id}: resolves by id`, getTrackInfo(t.id).id === t.id);
  check(`${t.id}: not in the listed circuits`, !LISTED_TRACKS.some((o) => o.id === t.id));
  check(`${t.id}: in no venue of the circuit browser or the home page`, !CIRCUIT_VENUES.some((v) => v.layouts.some((l) => l.id === t.id)));
  check(`${t.id}: not the default circuit`, TRACKS[0].id !== t.id);
}
check("every listed circuit is still listed", LISTED_TRACKS.length === TRACKS.length - unlisted.filter((t) => TRACKS.some((o) => o.id === t.id)).length);

// The modders list (Credits panel, home page About) names no one for an unlisted circuit alone
const modders = moddersList();
for (const t of unlisted) {
  const author = t.credit?.author;
  if (!author) continue;
  const otherWork = LISTED_TRACKS.some((o) => o.credit?.author === author) || CARS.some((c) => c.credit.author === author || c.tyreCredit?.author === author);
  const named = modders.find((m) => m.name === author);
  check(`${t.id}: the modders list leaves out its circuit`, !named?.works.includes(t.name) || otherWork, named ? named.works.join(", ") : "not listed");
  check(`${t.id}: the modders list names ${author} only for other work`, !named || otherWork);
}

// A rebuild writes the index entry from the converter's own config: the flag must be there too, or the circuit lists
const porter = readFileSync(path.join(ROOT, "scripts/tracks/port_ac_track.py"), "utf8");
for (const t of unlisted) {
  const start = porter.indexOf(`\n    '${t.id}': {`);
  const end = start < 0 ? -1 : porter.indexOf("\n    },", start);
  const entry = start < 0 ? null : porter.slice(start, end);
  check(`${t.id}: the converter's entry keeps it unlisted`, entry === null || /'unlisted': True/.test(entry), entry === null ? "no converter entry" : "");
}

// librecorsa.org/?track=<id> goes on to the game, like ?car=
check("the home page sends ?track= on to the game", /"track"/.test(FORWARD_TO_GAME));

console.log(failed ? `\n${failed} unlisted circuit check(s) failed.` : `\nAll unlisted circuit checks passed (${unlisted.length} unlisted: ${unlisted.map((t) => t.id).join(", ") || "none"}).`);
if (failed) process.exit(1);
