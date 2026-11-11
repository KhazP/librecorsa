import { existsSync } from "node:fs";
import { join } from "node:path";
import { HomeHub } from "@/components/home/HomeHub";
import type { HomeData } from "@/components/home/home-data";
import { withBasePath } from "@/lib/base-path";
import { CAR_CLASSES, CARS, carThumbUrl, type CarId } from "@/lib/cars/car-registry";
import { REPO_CAR_IDS } from "@/lib/hosted-content";
import outlines from "@/lib/home/circuit-outlines.json";
import type { LapOutline } from "@/lib/home/lap-outline";
import { coverage } from "@/lib/press";
import { REPO_URL, SUPPORT_URL } from "@/lib/site";
import { CIRCUIT_VENUES, DEFAULT_TRACK_ID } from "@/lib/track-registry";

/**
 * Links made before the home page existed open the game at "/": invites (`?room=`), car links, the developer
 * switches, sites that frame the game and installs from before the manifest pointed at /play. Those go on to /play
 * with their query and hash, before anything here is drawn. The parameter list is every one the game reads.
 */
const GAME_PARAMS = ["room", "car", "sim", "f1physics", "vf26engine", "depth", "sky", "colliders", "perf", "profile"];
const FORWARD_TO_GAME = `(function(){try{var q=new URLSearchParams(location.search);var game=${JSON.stringify(GAME_PARAMS)}.some(function(k){return q.has(k)});var framed=window.self!==window.top;var app=matchMedia("(display-mode: standalone)").matches||matchMedia("(display-mode: fullscreen)").matches;if(game||framed||app)location.replace(${JSON.stringify(withBasePath("/play"))}+location.search+location.hash)}catch(e){}})()`;

/** Written by scripts/build-home-outlines.ts, so its shape is LapOutline's (JSON reads a tuple as an array) */
const OUTLINES = outlines as unknown as Record<string, LapOutline>;

/**
 * A car's picture, or null when this copy has none. The repository's own cars keep theirs in the repository, so a
 * missing file means there is no picture; a hosted car's is served from the asset bucket, not from this folder.
 */
function thumbOf(id: CarId): string | null {
  const url = carThumbUrl(id);
  if (REPO_CAR_IDS.has(id) && !existsSync(join(process.cwd(), "public", url))) return null;
  return withBasePath(url);
}

/** The home page: the game's circuits, cars and press, with Drive into the game at /play */
export default function HomePage() {
  const missing = CIRCUIT_VENUES.flatMap((v) => v.layouts.filter((t) => !OUTLINES[t.id]).map((t) => t.id));
  if (missing.length) console.warn(`Home page: no outline for ${missing.join(", ")} (npm run home-outlines)`);

  const data: HomeData = {
    defaultTrackId: DEFAULT_TRACK_ID,
    defaultCarId: CARS[0].id,
    venues: CIRCUIT_VENUES.map((v) => ({
      name: v.name,
      country: v.country,
      layouts: v.layouts.map((t) => ({
        id: t.id,
        layout: t.layout,
        lengthM: t.lengthM,
        turns: t.turns,
        grade: t.quality === "sketchfab" ? "model" : "sim",
        outline: OUTLINES[t.id] ?? null,
      })),
    })),
    cars: CARS.map((c) => ({
      id: c.id,
      title: c.title,
      classTitle: CAR_CLASSES.find((k) => k.id === c.classId)?.title ?? "",
      year: c.year,
      grade: c.quality === "own" ? "sim" : "model",
      thumb: thumbOf(c.id),
    })),
    coverage: coverage()
      .slice(0, 4)
      .map((a) => ({ outlet: a.outlet, title: a.title, url: a.url, date: a.date })),
    repoUrl: REPO_URL,
    supportUrl: SUPPORT_URL,
  };

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: FORWARD_TO_GAME }} />
      <HomeHub data={data} />
    </>
  );
}
