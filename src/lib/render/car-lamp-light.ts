import * as THREE from "three";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { chainShaderPatch } from "./venue-night-lighting";

/*
 * Street lamps on the cars. On a moonlit circuit with lamps (venue-night-lighting.ts, "lamps" mode) the lamps' pools
 * reach only the circuit's own materials, so a car under a lamp stayed a dark shape on a lit road. Each car now takes
 * the pools' light at its own position, as light that is simply there, like the road under it.
 *
 * Car materials are shared: the same template paints every car of a model, the ghost, and the menus' previews. So the
 * light is not a material setting: each car mesh sets it just before its own draw and puts it back to black just after
 * (onBeforeRender / onAfterRender). three.js uploads a built-in material's uniforms only when the material or the
 * program changes between draws, and two cars of one model are drawn back to back with the same material, so each
 * change also clears the renderer's note of the program in use (`forceUniformUpload`): the next draw then sets its
 * program again and uploads all its uniforms, this one included. Anything else drawn with the material, a preview
 * included, sees black and looks as it always did.
 *
 * Costs: one shader compile per car material when the car is prepared; per car mesh draw, a function call, and only
 * while the car stands in lamp light, a full uniform upload for the draw and the one after it (three.js sends only the
 * values that changed).
 */

const PATCHES: readonly ShaderPatch[] = [
  ["#include <common>", "#include <common>\nuniform vec3 uLcLampLight;"],
  [
    "#include <lights_fragment_end>",
    /* glsl */ `
	#if defined( RE_IndirectDiffuse )
		irradiance += uLcLampLight;
	#endif
#include <lights_fragment_end>`,
  ],
];

/** Each patched material's uniform (black outside a lit car's draw) */
const uniforms = new WeakMap<THREE.Material, { value: THREE.Color }>();

function uniformFor(mat: THREE.Material): { value: THREE.Color } | null {
  const existing = uniforms.get(mat);
  if (existing) return existing;
  if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return null;
  const u = { value: new THREE.Color(0, 0, 0) };
  uniforms.set(mat, u);
  chainShaderPatch(mat, "car-lamp-v1", (shader) => {
    shader.uniforms.uLcLampLight = u;
    shader.fragmentShader = patchShader(shader.fragmentShader, PATCHES, "car lamp light");
  });
  return u;
}

interface CarState {
  /** The light at the car now (linear irradiance) */
  light: THREE.Color;
  lit: boolean;
  hooked: WeakSet<THREE.Object3D>;
  nextScanMs: number;
}

/** How often a car is walked for meshes its model added since (a late model load, a level of detail) */
const RESCAN_MS = 1000;
/** Below this the light is left out (black): no upload per draw for a car in the dark */
const MIN_LIGHT = 0.004;

const cars = new WeakMap<THREE.Object3D, CarState>();

/**
 * The next draw uploads every uniform of its program, as after a program change. (Switching to the material's own
 * program here instead would make three.js skip the upload of the camera and the lights for the draw.)
 */
function forceUniformUpload(renderer: THREE.WebGLRenderer): void {
  renderer.state.useProgram(null as unknown as WebGLProgram);
}

function hook(mesh: THREE.Mesh, state: CarState): void {
  const before = mesh.onBeforeRender;
  const after = mesh.onAfterRender;
  mesh.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    before.call(this, renderer, scene, camera, geometry, material, group);
    if (!state.lit) return;
    const u = uniforms.get(material);
    if (!u) return;
    u.value.copy(state.light);
    forceUniformUpload(renderer);
  };
  mesh.onAfterRender = function (renderer, scene, camera, geometry, material, group) {
    after.call(this, renderer, scene, camera, geometry, material, group);
    const u = uniforms.get(material);
    if (!u || (u.value.r === 0 && u.value.g === 0 && u.value.b === 0)) return;
    u.value.setRGB(0, 0, 0);
    forceUniformUpload(renderer);
  };
}

/**
 * Lights one car (its rig's root) with `light`, the lamps' light at its position, until the next call. Call each frame
 * for every car on a circuit with lamps at night; a car not called keeps its last light, so pass black when it leaves.
 * The first call walks the car and patches its materials (a shader compile each): make it early, while loading
 * (`prepareCarForLamps`), not when the car first drives under a lamp.
 */
export function lightCarByLamps(root: THREE.Object3D, light: THREE.Color, nowMs: number): void {
  let state = cars.get(root);
  if (!state) {
    state = { light: new THREE.Color(0, 0, 0), lit: false, hooked: new WeakSet(), nextScanMs: 0 };
    cars.set(root, state);
  }
  const lit = Math.max(light.r, light.g, light.b) >= MIN_LIGHT;
  state.lit = lit;
  if (lit) state.light.copy(light);
  if (nowMs < state.nextScanMs) return;
  state.nextScanMs = nowMs + RESCAN_MS;
  const s = state;
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    // a livery or a late model load brings new materials: patch those too (already patched ones are kept)
    let any = false;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (uniformFor(mat)) any = true;
    if (any && !s.hooked.has(mesh)) {
      s.hooked.add(mesh);
      hook(mesh, s);
    }
  });
}

const BLACK = new THREE.Color(0, 0, 0);

/** Patches a car's materials for lamp light now (in the dark), so the shader compiles happen while loading */
export function prepareCarForLamps(root: THREE.Object3D): void {
  lightCarByLamps(root, BLACK, Number.MAX_VALUE);
  const state = cars.get(root);
  // the next frame's call walks it again (a model that was still loading)
  if (state) state.nextScanMs = 0;
}
