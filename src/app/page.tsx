import { existsSync } from "node:fs";
import { join } from "node:path";
import { HomeHub } from "@/components/home/HomeHub";
import type { HomeData } from "@/components/home/home-data";
import { withBasePath } from "@/lib/base-path";
import { CAR_CLASSES, CARS, carThumbUrl, type CarId } from "@/lib/cars/car-registry";
import { REPO_CAR_IDS } from "@/lib/hosted-content";
import outlines from "@/lib/home/circuit-outlines.json";
import type { LapOutline } from "@/lib/home/lap-outline";
import { carModelSource, trackModelSource } from "@/lib/model-source";
import { coverage } from "@/lib/press";
import { CONTACT_EMAIL, REPO_URL, SUPPORT_URL } from "@/lib/site";
import { CIRCUIT_TYPE_LABELS, CIRCUIT_VENUES, DEFAULT_TRACK_ID, circuitModder, circuitType } from "@/lib/track-registry";

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
  const articles = coverage();

  const data: HomeData = {
    defaultTrackId: DEFAULT_TRACK_ID,
    defaultCarId: CARS[0].id,
    venues: CIRCUIT_VENUES.map((v) => ({
      name: v.name,
      country: v.country,
      types: [...new Set(v.layouts.map((t) => CIRCUIT_TYPE_LABELS[circuitType(t)]))],
      modders: [...new Set(v.layouts.map(circuitModder))],
      layouts: v.layouts.map((t) => ({
        id: t.id,
        layout: t.layout,
        lengthM: t.lengthM,
        turns: t.turns,
        grade: t.quality === "sketchfab" ? "model" : "sim",
        outline: OUTLINES[t.id] ?? null,
      })),
      source: trackModelSource(v.layouts[0]),
    })),
    cars: CARS.map((c) => ({
      id: c.id,
      title: c.title,
      classTitle: CAR_CLASSES.find((k) => k.id === c.classId)?.title ?? "",
      year: c.year,
      grade: c.quality === "own" ? "sim" : "model",
      thumb: thumbOf(c.id),
      source: carModelSource(c),
    })),
    coverage: articles.slice(0, 4).map((a) => ({ outlet: a.outlet, title: a.title, url: a.url, date: a.date })),
    coverageCount: articles.length,
    contactEmail: CONTACT_EMAIL,
    repoUrl: REPO_URL,
    supportUrl: SUPPORT_URL,
  };

  // Old links to "/" that belong to the game go on to /play from the root layout (forward-to-game.ts)
  return <HomeHub data={data} />;
}
