/**
 * Circuit models with GPU-compressed textures, for phones. scripts/ktx2-track-textures.mjs converts a circuit GLB's
 * WebP textures to KTX2 (Basis Universal), which a phone's GPU keeps compressed at an eighth to a quarter of the
 * memory, in a file about the WebP one's size; geometry and physics keep their bytes. The converted model is a new
 * file next to the original: `/tracks/<id>/<id>.ktx2.<build>.glb`, where `<build>` is the first 8 hex digits of its
 * sha256, so a new conversion gets a new name and the old file can stay on R2 for an older deploy.
 *
 * This list is the pointer, as venue-models.ts is for the venues: which file the game loads is decided here, in code,
 * and never in track_data.json on R2 (`metadata.mesh.url` stays the WebP model, what desktops and older deploys load,
 * and the fallback). It is keyed by that url, so layouts that share a model (RISE's two) share its conversion.
 * render/ktx2.ts decides who loads it (phones and tablets); anyone else, `?ktx2=off`, and a conversion that can't load
 * (a local copy without it) load the WebP model. Upload a conversion before deploying code that names it.
 *
 * The layouts of a venue with a shared model are not listed here: venue-models.ts names their KTX2 pair (`ktx2Build`).
 */

export interface Ktx2Model {
  /** The WebP model's url (track data `metadata.mesh.url`) */
  model: string;
  /** The conversion (scripts/ktx2-track-textures.mjs prints it): the first 8 hex digits of its sha256 */
  build: string;
}

export const KTX2_MODELS: readonly Ktx2Model[] = [
  { model: "/tracks/barbagallo/barbagallo.glb", build: "44de8787" },
  { model: "/tracks/borgloh/borgloh.glb", build: "7f4a63bd" },
  { model: "/tracks/bridgehampton/bridgehampton.glb", build: "d8cfe1d0" },
  { model: "/tracks/chang/chang.glb", build: "563a4258" },
  { model: "/tracks/dunsfold/dunsfold.glb", build: "801d33ca" },
  { model: "/tracks/goodwood/goodwood.glb", build: "11024313" },
  { model: "/tracks/grobnik/grobnik.glb", build: "86923d13" },
  { model: "/tracks/istanbul_park/istanbul_park.glb", build: "dcbe1f52" },
  { model: "/tracks/le_mans_82/le_mans_82.glb", build: "6b85979b" },
  { model: "/tracks/monaco/monaco.glb", build: "60cb8a7b" },
  { model: "/tracks/norisring/norisring.glb", build: "243ef1c7" },
  { model: "/tracks/oschersleben/oschersleben.glb", build: "eadf95c6" },
  { model: "/tracks/rwanda_official/rwanda_official.glb", build: "de092d00" },
  { model: "/tracks/speedvegas/speedvegas.glb", build: "8c9ab5b8" },
  { model: "/tracks/willow_springs/willow_springs.glb", build: "905545a8" },
];

/** The KTX2 model that stands in for a circuit model, if it has one (relative to the base path) */
export function ktx2ModelUrl(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const entry = KTX2_MODELS.find((m) => m.model === model);
  return entry ? model.replace(/\.glb$/, `.ktx2.${entry.build}.glb`) : undefined;
}
