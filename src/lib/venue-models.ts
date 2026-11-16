/**
 * Venues whose layouts share one visual model. Each layout's own GLB (`metadata.mesh.url`) holds the whole venue's
 * scenery again, though most of it is the same in every layout. scripts/split-venue-model.mjs splits a venue's GLBs
 * into one shared file and one small file per layout. The game loads the pair and puts the shared scenery under the
 * layout's own `Track_Model` (render/venue-model.ts), so after the first layout of a venue, a player downloads only
 * the next layout's file.
 *
 * The files live next to the layout's own: `/tracks/<venue>/<venue>.shared.<build>.glb` and
 * `/tracks/<layout>/<layout>.layout.<build>.glb`, where `<build>` is the shared file's hash. A new build gets new
 * names, so the old files can stay on R2 for an older deploy. The full GLBs and track_data.json don't change, so code
 * that predates this keeps loading them. Upload a build's files before deploying code that names it. When the pair
 * can't load (a local copy without them), the game loads the layout's own GLB instead.
 *
 * This list is the pointer: which hosted files the game loads for these layouts is decided here, in code, and never
 * in track_data.json on R2 (`metadata.mesh.url` stays the full GLB, the fallback and what an older deploy loads).
 * scene-builder.ts reads it through `venueModelFiles(track.id)`; scripts read it through glb-geometry.ts
 * (`trackModelFiles`). A re-split (other inputs, other texture formats) is a new build: run the splitter, upload its
 * files, then change `build` here.
 *
 * Phones also have a KTX2 build of the same pair (`ktx2Build`): the live files with their textures converted to KTX2
 * (scripts/ktx2-track-textures.mjs --venue), geometry and physics byte for byte the same. render/ktx2.ts decides who
 * loads it; anyone else, and a phone whose KTX2 pair can't load, loads the WebP pair as before.
 */

export interface VenueModel {
  /** The venue's folder under public/tracks (its first layout's id); the shared file lives there */
  venue: string;
  /** The split build (scripts/split-venue-model.mjs prints it): the first 8 hex digits of the shared file's sha256 */
  build: string;
  /** The KTX2 build of the same pair, for phones: the first 8 hex digits of its shared file's sha256 */
  ktx2Build?: string;
  layouts: readonly string[];
}

export const VENUE_MODELS: readonly VenueModel[] = [
  { venue: "vir", build: "b79628d0", ktx2Build: "13216544", layouts: ["vir", "vir_grand_east", "vir_grand_west", "vir_north", "vir_patriot", "vir_patriot_reverse", "vir_south"] },
  { venue: "spielberg", build: "7813326e", ktx2Build: "e9cd6a88", layouts: ["spielberg", "spielberg_inner", "spielberg_south"] },
  { venue: "sachsenring", build: "2f15331c", ktx2Build: "f59a16b8", layouts: ["sachsenring", "sachsenring_short"] },
  { venue: "okayama", build: "7c5a1d41", ktx2Build: "52e7ecf3", layouts: ["okayama", "okayama_drift", "okayama_piper"] },
  { venue: "riverside", build: "e3849086", ktx2Build: "3bd90ac1", layouts: ["riverside", "riverside_short", "riverside_nascar"] },
  { venue: "watkins_glen", build: "3dfe75f5", ktx2Build: "4e8208d4", layouts: ["watkins_glen", "watkins_glen_short"] },
];

/** A layout's two files (relative to the base path) */
export interface VenuePair {
  build: string;
  /** The layout's physics, its own scenery and what the game finds by name */
  layoutUrl: string;
  /** The scenery every layout of the venue shares */
  sharedUrl: string;
}

export interface VenueModelFiles extends VenuePair {
  venue: string;
  /** The same pair with KTX2 textures, if the venue has one */
  ktx2?: VenuePair;
}

const pair = (venue: string, layout: string, build: string): VenuePair => ({
  build,
  layoutUrl: `/tracks/${layout}/${layout}.layout.${build}.glb`,
  sharedUrl: `/tracks/${venue}/${venue}.shared.${build}.glb`,
});

/** The split model of a circuit, if its venue has one */
export function venueModelFiles(trackId: string | undefined): VenueModelFiles | undefined {
  if (!trackId) return undefined;
  const v = VENUE_MODELS.find((m) => m.layouts.includes(trackId));
  if (!v) return undefined;
  return { venue: v.venue, ...pair(v.venue, trackId, v.build), ...(v.ktx2Build ? { ktx2: pair(v.venue, trackId, v.ktx2Build) } : {}) };
}
