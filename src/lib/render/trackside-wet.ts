import * as THREE from "three";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { chainShaderPatch } from "./venue-night-lighting";

/**
 * Rain on everything round the asphalt: kerbs, run-off, the pit lane, walls and barriers, grass and gravel get wet with
 * the same weather wetness the road takes off its racing line (setTracksideWetness, set with setAsphaltWetness), so a
 * dry-looking kerb no longer sits beside a soaked road. Wet surfaces go darker (water in the pores sends back less of the light the
 * dry surface scattered) and smoother (a film over the grain), each as its material allows: painted kerbs and run-off go
 * glossy, concrete and asphalt darker and a little less, grass and soil darker and still matte, metal barely darker but
 * beaded. Level ground takes the full wet; a wall about a third of it, an overhang none.
 *
 * The kind comes from the material's name (authored circuits name theirs: `Kerb_RedWhite`, `Runoff_Paint`,
 * `Barrier_Armco`, `Terrain_Grass`); the converted scans mostly don't (`Material #31`), so an unnamed scan material is
 * read per pixel: green-dominant texels (grass, hedges, trees) wet as vegetation, everything else as hard ground.
 *
 * One shader edit for every kind (the kind is uniform values per material, so materials keep sharing their programs),
 * chained onto whatever the material already has (ground detail, leaves, the night lamps). Dry, it is one uniform branch.
 */

export type TracksideWetKind = "paint" | "asphalt" | "hard" | "metal" | "soft" | "auto" | "generic";

/** Albedo at full wetness on level ground, roughness a fully wet surface tends to, and whether it reads grass by colour */
interface WetParams {
  albedo: number;
  roughness: number;
  /** 1: green-dominant texels are vegetation (unnamed scan materials); 2: the whole material is (grass, soil, gravel) */
  vegetation: 0 | 1 | 2;
}

export const TRACKSIDE_WET_PARAMS: Readonly<Record<TracksideWetKind, Readonly<WetParams>>> = {
  // Painted kerbs and run-off: the paint seals the surface, so it darkens little and goes slick
  paint: { albedo: 0.8, roughness: 0.18, vegetation: 0 },
  // Pit lane, service roads, car parks: as the soaked road's pores (asphalt-sheen.ts WET_ALBEDO 0.42), a little lighter
  asphalt: { albedo: 0.5, roughness: 0.24, vegetation: 0 },
  // Concrete, stone, tyre walls: porous, soaks dark
  hard: { albedo: 0.62, roughness: 0.34, vegetation: 0 },
  // Armco, rails, steel: no pores; water beads on it
  metal: { albedo: 0.9, roughness: 0.25, vegetation: 0 },
  // Grass, soil, gravel, sand: darker, and the blades and grains stay matte
  soft: { albedo: 0.74, roughness: 0.62, vegetation: 2 },
  // A scan's unnamed material: hard ground, or vegetation where the texel is green
  auto: { albedo: 0.66, roughness: 0.34, vegetation: 1 },
  // Anything else an authored circuit names (buildings, signs, props): a lighter touch
  generic: { albedo: 0.82, roughness: 0.45, vegetation: 0 },
};

const SKIP = /glass|glaze|window|water|lake|sea|river|lamp|light|led|screen|display|sky|cloud|collider|shadow/i;
const PAINT = /kerb|curb|cord|paint|runoff|run_off|marking|stripe|zebra|helipad|line/i;
const ASPHALT = /asph|apsh|tarmac|road|pitlane|pit_lane|parking|service|track/i;
const METAL = /metal|steel|chrome|armco|rail|guard|post|pole|truss|gantry|scaffold|fence/i;
const HARD = /concrete|apron|wall|barrier|tecpro|block|bridge|paving|pavement|stone|rock|revetment|terrace|tyre|tire|brick|cement/i;
const SOFT = /grass|gras|lawn|verge|terrain|turf|gravel|sand|soil|dirt|mud|laterite|clay|hoggin|shore|planting|field|ground/i;

/**
 * The wet kind for a circuit material by its name; `scan` says it comes from a converted scan (`Track_Model`), where a
 * name that says nothing reads the surface by colour. Null: leave it dry (glass, water, lamps, screens).
 */
export function tracksideWetKind(name: string, scan: boolean): TracksideWetKind | null {
  if (SKIP.test(name)) return null;
  // Order matters: "Kerb_RedWhite" is paint, "Barrier_Armco" metal but "Barrier_Tecpro" hard, "Track_Pitlane_Asphalt"
  // asphalt
  if (PAINT.test(name)) return "paint";
  if (SOFT.test(name)) return "soft";
  if (METAL.test(name)) return "metal";
  if (HARD.test(name)) return "hard";
  if (ASPHALT.test(name)) return "asphalt";
  return scan ? "auto" : "generic";
}

export const TRACKSIDE_WET_FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  ["#include <common>", "#include <common>\nuniform float uLcTrackWet;\nuniform vec3 uLcTrackWetKind;"],
  [
    "#include <lights_physical_fragment>",
    /* glsl */ `
if ( uLcTrackWet > 0.0 ) {
	// How much rain this face catches: level ground all of it, a wall about a third, an overhang none
	vec3 lcwN = inverseTransformDirection( normal, viewMatrix );
	float lcwWet = uLcTrackWet * ( 0.35 + 0.65 * smoothstep( -0.1, 0.8, lcwN.y ) ) * smoothstep( -0.6, -0.2, lcwN.y );
	// Vegetation: the whole material, or the texels where green leads (a scan's shared atlas)
	float lcwVeg = uLcTrackWetKind.z > 1.5 ? 1.0
		: uLcTrackWetKind.z > 0.5 ? smoothstep( 0.012, 0.05, diffuseColor.g - max( diffuseColor.r, diffuseColor.b ) ) : 0.0;
	float lcwAlbedo = mix( uLcTrackWetKind.x, ${TRACKSIDE_WET_PARAMS.soft.albedo.toFixed(2)}, lcwVeg );
	float lcwRough = mix( uLcTrackWetKind.y, ${TRACKSIDE_WET_PARAMS.soft.roughness.toFixed(2)}, lcwVeg );
	// Darker and a little richer in colour (less light scattered back out white), then smoother: never rougher
	float lcwLuma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	diffuseColor.rgb = max( mix( vec3( lcwLuma ), diffuseColor.rgb, 1.0 + 0.25 * lcwWet ), 0.0 ) * mix( 1.0, lcwAlbedo, lcwWet );
	roughnessFactor = mix( roughnessFactor, min( roughnessFactor, lcwRough ), lcwWet );
}
#include <lights_physical_fragment>`,
  ],
];

/** How wet the trackside is, 0 dry .. 1 soaked: one uniform object shared by every patched material */
export const tracksideWetUniform: { value: number } = { value: 0 };

/** The trackside's wetness (0 dry .. 1 soaked): the road's off-line wetness. Cheap: one uniform write */
export function setTracksideWetness(wetness: number): void {
  tracksideWetUniform.value = Number.isFinite(wetness) ? Math.min(1, Math.max(0, wetness)) : 0;
}

const patched = new WeakSet<THREE.Material>();

/**
 * Makes a circuit material get wet with the weather (once per material). Only lit standard / physical materials; the
 * road's own asphalt shader and the flat scenery's (scenery-detail.ts) have their own wet look and are left alone by
 * the caller. Returns the kind applied, or null when the material stays dry.
 */
export function applyTracksideWetness(mat: THREE.Material, scan: boolean, kind?: TracksideWetKind): TracksideWetKind | null {
  const std = mat as THREE.MeshStandardMaterial;
  // The road's asphalt shader has its own wet look
  if (!std.isMeshStandardMaterial || patched.has(mat) || mat.customProgramCacheKey().startsWith("asphalt-sheen")) return null;
  const k = kind ?? tracksideWetKind(mat.name ?? "", scan);
  // Faint see-through layers (glass, haze cards) stay as they are
  if (!k || (std.transparent && std.opacity < 0.6)) return null;
  patched.add(mat);
  const p = TRACKSIDE_WET_PARAMS[k];
  const uniforms = {
    uLcTrackWet: tracksideWetUniform,
    uLcTrackWetKind: { value: new THREE.Vector3(p.albedo, p.roughness, p.vegetation) },
  };
  chainShaderPatch(mat, "trackside-wet-v1", (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = patchShader(shader.fragmentShader, TRACKSIDE_WET_FRAGMENT_PATCHES, "trackside wet");
  });
  return k;
}
