/**
 * The wet track's look (src/lib/render/asphalt-sheen.ts): standing water from the weather's water depth, puddles where
 * the physics' own water model pools it, the shader edits landing in three's standard material exactly once, and a dry
 * road that runs none of the wet code.
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
  standingWaterLevel,
  applyAsphaltSheen,
  type RacingLineMask,
} from "../../src/lib/render/asphalt-sheen";
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
check("The wet code sits behind the dry guard", frag.includes("if ( lc26WetRaw > 0.0 ) {"), `${frag.length} chars`);
check(
  "Raindrop rings only near the camera, on water, in rain, above Low",
  frag.includes("if ( lc26RippleW * lc26RippleFade > 0.01 )") && frag.includes("if ( uAsphaltDetail > 0.5 ) {"),
);
const u = shader.uniforms;
check(
  "One shared set of wet and water uniforms reaches the material",
  ["uWetness", "uLineWetness", "uRainIntensity", "uWetTime", "uWaterLevel", "uLineWaterLevel"].every((k) => k in u)
);
setAsphaltWetness(0.9, 0.5, 0.8);
setAsphaltStandingWater(2.4, 1.0);
const levelSet = u.uWaterLevel.value === 1 && Math.abs(u.uLineWaterLevel.value - standingWaterLevel(1.0)) < 1e-9;
check("The water level reaches the shader's uniforms", levelSet);
setAsphaltWetness(0, 0, 0);
setAsphaltStandingWater(0, 0);
check("Dry: every wet uniform is back at 0", u.uWetness.value === 0 && u.uLineWetness.value === 0 && u.uWaterLevel.value === 0 && u.uRainIntensity.value === 0);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(", ")}` : "\nAll wet track checks passed.");
if (failures.length) process.exit(1);
