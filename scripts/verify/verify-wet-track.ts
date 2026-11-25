/**
 * The wet track's look (src/lib/render/asphalt-sheen.ts): standing water from the weather's water depth, puddles where
 * the physics' own water model pools it, the shader edits landing in three's standard material exactly once, and a dry
 * road that runs none of the wet code. The trackside's wet look (src/lib/render/trackside-wet.ts): which surfaces get
 * which wet, its shader edit chained onto the circuit materials' own, and none on the road.
 *
 *   node scripts/verify/run-verify.mjs wet-track
 */
import * as THREE from "three";
import {
  PUDDLE_FULL_MM,
  PUDDLE_START_MM,
  puddleReliefAt,
  setAsphaltStandingWater,
  setAsphaltWetness,
  setWetRoadProbe,
  standingWaterLevel,
  applyAsphaltSheen,
  type RacingLineMask,
} from "../../src/lib/render/asphalt-sheen";
import {
  applyTracksideWetness,
  setTracksideWetness,
  tracksideWetKind,
  tracksideWetUniform,
  TRACKSIDE_WET_PARAMS,
} from "../../src/lib/render/trackside-wet";
import { makeWetLamp, pickWetRoadLamps, WET_LAMP_SLOTS, WET_LAMPS_BY_QUALITY, wetLampUniforms } from "../../src/lib/render/wet-road-lamps";
import { equilibriumWaterMm, topographicalPuddleFactor } from "../../src/lib/sim/weather";
import { wetnessFromWater } from "../../src/lib/sim/wet-tyres";
import type { TrackSamplePoint } from "../../src/types/f1";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

// --- Standing water from the weather's depth -------------------------------------------------------------------------
const light = equilibriumWaterMm(0.3);
const heavy = equilibriumWaterMm(0.85);
check(
  "No standing water on a damp road, full puddles in heavy rain",
  standingWaterLevel(0) === 0 && standingWaterLevel(PUDDLE_START_MM) === 0 && standingWaterLevel(PUDDLE_FULL_MM) === 1 && standingWaterLevel(heavy) > 0.95,
  `light rain ${light.toFixed(2)} mm -> ${standingWaterLevel(light).toFixed(2)}, heavy ${heavy.toFixed(2)} mm -> ${standingWaterLevel(heavy).toFixed(2)}`
);
let monotonic = true;
for (let mm = 0; mm < 4; mm += 0.05) if (standingWaterLevel(mm + 0.05) < standingWaterLevel(mm)) monotonic = false;
check("Standing water rises with the water depth and stays within 0..1", monotonic && standingWaterLevel(50) === 1 && standingWaterLevel(NaN) === 0);
check(
  "Light rain stands little water (puddles only where the water model pools it most)",
  standingWaterLevel(light) < 0.25 && wetnessFromWater(light) > 0.7,
  `level ${standingWaterLevel(light).toFixed(2)}, surface wetness ${wetnessFromWater(light).toFixed(2)}`
);

// --- Puddles follow the physics' water model ------------------------------------------------------------------------
const sample = (over: Partial<TrackSamplePoint> = {}): TrackSamplePoint =>
  ({
    index: 0,
    s: 410,
    t: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, 1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    bankingRad: 0,
    width: 14,
    curvature: 0,
    verticalCurvature: 0,
    slopeSin: 0,
    sector: 1,
    turnNumber: 0,
    turnName: "",
    runoffStyle: "asphalt",
    kerbLeft: false,
    kerbRight: false,
    drsZone: false,
    racingLineOffset: 0,
    optimalSpeedKmh: 200,
    brakingZone: 0,
    ...over,
  }) as TrackSamplePoint;
const flat = sample();
let same = true;
for (const lat of [-8, -5, -2, 0, 3, 6.5, 8]) {
  const f = topographicalPuddleFactor(flat.s, lat, 0, 0, flat.width / 2);
  if (Math.abs(puddleReliefAt(flat, lat) - Math.min(1, Math.max(0, f - 0.55))) > 1e-9) same = false;
}
check("The puddle relief is the physics' water depth factor, rescaled to 0..1", same);
check(
  "Water stands in the gutters along the road's edges more than in its middle",
  puddleReliefAt(flat, 6.8) > puddleReliefAt(flat, 0) + 0.1 && puddleReliefAt(flat, -6.8) > puddleReliefAt(flat, 0) + 0.1,
  `edge ${puddleReliefAt(flat, 6.8).toFixed(2)} / middle ${puddleReliefAt(flat, 0).toFixed(2)}`
);
const banked = sample({ bankingRad: (6 * Math.PI) / 180 });
check(
  "A banked road holds water on its low side, not its high side",
  puddleReliefAt(banked, 4) > puddleReliefAt(banked, -4),
  `low ${puddleReliefAt(banked, 4).toFixed(2)} / high ${puddleReliefAt(banked, -4).toFixed(2)}`
);
const steep = sample({ slopeSin: 0.09 });
check(
  "A steep climb sheds water a flat stretch keeps",
  puddleReliefAt(steep, 0) < puddleReliefAt(flat, 0),
  `9% ${puddleReliefAt(steep, 0).toFixed(2)} / flat ${puddleReliefAt(flat, 0).toFixed(2)}`
);

// --- The shader ---------------------------------------------------------------------------------------------------
const mask: RacingLineMask = {
  texture: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1),
  worldMin: new THREE.Vector2(),
  worldSize: new THREE.Vector2(1, 1),
};
const mat = new THREE.MeshStandardMaterial();
applyAsphaltSheen(mat, mask);
const shader = {
  uniforms: {} as Record<string, THREE.IUniform>,
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
} as unknown as THREE.WebGLProgramParametersWithUniforms;
const warnings: string[] = [];
const warn = console.warn;
console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
console.warn = warn;
const frag = shader.fragmentShader;
check("Every asphalt shader edit finds its anchor in three's standard material once", warnings.length === 0, warnings.join("; ") || "none missed");
check(
  "The wet code sits behind the dry guard; the probe's reflection behind its own switch",
  frag.includes("if ( lc26WetRaw > 0.0 ) {") && frag.includes("float lc26Mirror = 0.0;") && frag.includes("lc26Mirror = smoothstep( 0.05, 0.6, lc26Wet );") && frag.includes("uWetProbeOn > 0.5") && frag.includes("radiance = mix( radiance, lc26Probe"),
  `${frag.length} chars`
);
check(
  "Raindrop rings only near the camera, on water, in rain, above Low",
  frag.includes("if ( lc26RippleW * lc26RippleFade > 0.01 )") && frag.includes("if ( uAsphaltDetail > 0.5 ) {"),
);
const u = shader.uniforms;
check(
  "One shared set of wet, water and probe uniforms reaches the material",
  ["uWetness", "uLineWetness", "uRainIntensity", "uWetTime", "uWaterLevel", "uLineWaterLevel", "uWetProbe", "uWetProbeOn", "uWetProbePos", "uWetProbeLod", "uWetProbeIntensity"].every((k) => k in u)
);
setAsphaltWetness(0.9, 0.5, 0.8);
setAsphaltStandingWater(2.4, 1.0);
const levelSet = u.uWaterLevel.value === 1 && Math.abs(u.uLineWaterLevel.value - standingWaterLevel(1.0)) < 1e-9;
const probeTex = new THREE.CubeTexture();
probeTex.mipmaps = [{}, {}, {}, {}, {}, {}] as unknown as typeof probeTex.mipmaps;
setWetRoadProbe(probeTex, new THREE.Vector3(1, 2, 3), 0.7);
const probeOn = u.uWetProbeOn.value === 1 && u.uWetProbe.value === probeTex && u.uWetProbeLod.value === 5 && u.uWetProbeIntensity.value === 0.7;
setWetRoadProbe(null, new THREE.Vector3(), 1);
const probeOff = u.uWetProbeOn.value === 0 && u.uWetProbe.value === null;
check("Water level, probe and probe-off reach the shader's uniforms", levelSet && probeOn && probeOff);
check(
  "Lamps streak only on wet pixels, behind their count, in the material's uniforms",
  frag.includes("if ( lc26Mirror > 0.0 && uWetLampCount > 0.5 ) {") && ["uWetLampPos", "uWetLampColor", "uWetLampDir", "uWetLampCount"].every((k) => k in u)
);

// --- Which lamps the wet road mirrors ---------------------------------------------------------------------------------
const cam = new THREE.Vector3();
const lamp = (x: number, z: number, strength: number) => {
  const l = makeWetLamp();
  l.pos.set(x, 1, z);
  l.color.setRGB(strength, 0, 0);
  return l;
};
const lamps = [lamp(0, 60, 1), lamp(0, 8, 1), lamp(0, 400, 50), lamp(0, 20, 10), lamp(3, 5, 0), lamp(0, 30, 1)];
const picked = pickWetRoadLamps(lamps, lamps.length, cam, WET_LAMPS_BY_QUALITY.medium, true);
const firstTwo = [wetLampUniforms.uWetLampPos.value[0].z, wetLampUniforms.uWetLampPos.value[1].z];
check(
  "The brightest-looking lamps near the camera first; out of reach and dark ones left out",
  picked === 4 && wetLampUniforms.uWetLampCount.value === 4 && firstTwo[0] === 20 && firstTwo[1] === 8,
  `picked ${picked}, first at z ${firstTwo.join(", ")}`
);
check(
  "A slot per lamp at most, by quality; none on a dry road",
  WET_LAMPS_BY_QUALITY.high <= WET_LAMP_SLOTS &&
    pickWetRoadLamps(lamps, lamps.length, cam, 99, true) <= WET_LAMP_SLOTS &&
    pickWetRoadLamps(lamps, lamps.length, cam, WET_LAMPS_BY_QUALITY.high, false) === 0 &&
    wetLampUniforms.uWetLampCount.value === 0
);

// --- The trackside ----------------------------------------------------------------------------------------------------
const kinds: Array<[string, boolean, string | null]> = [
  ["Kerb_RedWhite", false, "paint"],
  ["Runoff_Paint", false, "paint"],
  ["Track_Pitlane_Asphalt", false, "asphalt"],
  ["Service_Asphalt", false, "asphalt"],
  ["Pit_Apron_Concrete", false, "hard"],
  ["PitWall", false, "hard"],
  ["Barrier_Tecpro", false, "hard"],
  ["Barrier_Armco", false, "metal"],
  ["Terrain_Grass", false, "soft"],
  ["Gravel_Trap", false, "soft"],
  ["Building_Glass", false, null],
  ["Lake_Water", false, null],
  ["Light_Lamp", false, null],
  ["Banner_Kigali", false, "generic"],
  ["Material #31", true, "auto"],
  ["02 - Default_buildings", true, "auto"],
];
const wrongKinds = kinds.filter(([name, scan, want]) => tracksideWetKind(name, scan) !== want).map(([n, s]) => `${n} -> ${tracksideWetKind(n, s)}`);
check("Kerbs and run-off paint, concrete, metal, grass by name; a scan's unnamed material by colour", wrongKinds.length === 0, wrongKinds.join("; ") || `${kinds.length} names`);
check(
  "Paint goes the glossiest, grass stays matte, every kind only darker and smoother",
  Object.values(TRACKSIDE_WET_PARAMS).every((p) => p.albedo > 0 && p.albedo < 1 && p.roughness > 0 && p.roughness < 1) &&
    TRACKSIDE_WET_PARAMS.paint.roughness < TRACKSIDE_WET_PARAMS.hard.roughness &&
    TRACKSIDE_WET_PARAMS.soft.roughness > 0.5
);
// Chained onto a material that already has an edit of its own (as the ground detail and the leaves do)
const kerb = new THREE.MeshStandardMaterial({ name: "Kerb_RedWhite" });
kerb.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace("#include <lights_physical_fragment>", "#include <lights_physical_fragment>\n\tmaterial.specularF90 *= 0.25;");
};
kerb.customProgramCacheKey = () => "ground-detail-v2";
const kerbKind = applyTracksideWetness(kerb, false);
const kerbShader = {
  uniforms: {} as Record<string, THREE.IUniform>,
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
} as unknown as THREE.WebGLProgramParametersWithUniforms;
const kerbWarnings: string[] = [];
console.warn = (...a: unknown[]) => kerbWarnings.push(a.join(" "));
kerb.onBeforeCompile(kerbShader, {} as THREE.WebGLRenderer);
console.warn = warn;
const kf = kerbShader.fragmentShader;
check(
  "The trackside edit chains onto the material's own, behind the dry guard",
  kerbKind === "paint" && kerbWarnings.length === 0 && kf.includes("material.specularF90 *= 0.25;") && kf.includes("if ( uLcTrackWet > 0.0 ) {") &&
    kf.indexOf("if ( uLcTrackWet > 0.0 ) {") < kf.indexOf("#include <lights_physical_fragment>") &&
    kerb.customProgramCacheKey() === "ground-detail-v2|trackside-wet-v1" && kerbShader.uniforms.uLcTrackWet === tracksideWetUniform,
  kerbWarnings.join("; ") || kerb.customProgramCacheKey()
);
check(
  "The road's asphalt and see-through glass stay out; a material is patched once",
  applyTracksideWetness(mat, false, "asphalt") === null &&
    applyTracksideWetness(new THREE.MeshStandardMaterial({ name: "Fence", transparent: true, opacity: 0.3 }), false) === null &&
    applyTracksideWetness(kerb, false) === null
);
setTracksideWetness(0.8);
const wetNow = tracksideWetUniform.value;
setTracksideWetness(Number.NaN);
check("The trackside's wetness clamps to 0..1 and dries with the road", wetNow === 0.8 && tracksideWetUniform.value === 0);

setAsphaltWetness(0, 0, 0);
setAsphaltStandingWater(0, 0);
check("Dry: every wet uniform is back at 0", u.uWetness.value === 0 && u.uLineWetness.value === 0 && u.uWaterLevel.value === 0 && u.uRainIntensity.value === 0);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(", ")}` : "\nAll wet track checks passed.");
if (failures.length) process.exit(1);
