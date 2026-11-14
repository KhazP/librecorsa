/**
 * GPU tyre deformation for the car models' tyre meshes: contact-patch flattening against the road, sidewall bulge and
 * carcass shear (lateral and fore-aft wind-up), driven by the physics' per-corner tyre state (`TyreVisualState`) and
 * the road under the tyre (`TyreRoad`, written each frame by the corner rig, `corner-rig.ts`). No texture fetches in
 * the vertex shader; the per-wheel cost is a few dozen ALU ops per vertex.
 *
 * Frames. The tyre spins about its local X (the axle): world = Rx(θ) · local, θ = the spin angle (the spin group's
 * rotation.x). The vertex shader first undoes the spin (carrier = Rx(θ) · local, the wheel node's frame: steered,
 * cambered, not spinning), so the contact patch sits at a fixed place while the tread rolls through it, deforms there,
 * then maps back with Rx(−θ). The spin group re-applies Rx(θ), so the deformed vertices land in the wheel frame and
 * the tread texture still rolls.
 *
 * Deformation in the carrier frame, with d = δ · gain the visual deflection:
 *  - road: the plane n · p = w under the hub (n its normal in the carrier frame, so body roll and pitch, crown,
 *    banking, kerb slopes and the wheel's own camber all come from the relative orientation), plus a piecewise-linear
 *    profile e(x) + e(z) above that plane through road samples across and along the tread, with a knot either side
 *    of a kerb's edge where the rig found one (`TyreRoadProfile`).
 *  - patch weight w: 1 across the contact patch (angle from the contact direction below its half-angle
 *    acos((R − d) / R), the patch's half-length √(2Rd − d²)), falling off as a Gaussian of the arc past its edge over
 *    about a relaxation length (PATCH_FALLOFF_M), as the carcass deflection does outside the patch.
 *  - carcass shear: the tread around the patch moves with the tyre model's carcass deflection relative to the rim
 *    (`TyreVisualState.carcassDeflectionXM / YM`): sideways in the direction of the lateral force, fore-aft in the
 *    direction of the longitudinal force (behind the hub under braking, ahead under traction).
 *  - flattening: tread vertices below the road under them are lifted onto it along n, their normals blended toward
 *    the road's, so the patch comes out flat (and follows a kerb's step across or along it) with a crisp tread edge.
 *  - sidewall bulge: shoulders are pushed outward along the axle (on the road plane) by 0.8 · d · w, off the bead.
 *
 * `gain` (default 1.4) exaggerates the squeeze and shear so they read at chase-camera distance. The same exaggerated
 * deflection is `axleDropM`: the rig puts the hub (R − d) from the road, so the flat patch lands on it.
 */
import * as THREE from 'three';
import type { TireCompound } from '@/types/f1';
import type { TyreVisualState } from '../sim/simulator-car';
import { createPirelliSidewall, loadSidewallTexture } from './pirelli-sidewall';
import { createTyreWrap } from './tyre-wrap';
import { subdivideTyreTread } from './tyre-subdivide';

/** Default visual exaggeration of the radial deflection and the carcass shear */
const DEFAULT_GAIN = 1.4;
/** Carcass shear limit (m): the visual shear eases into it (tanh), so a sliding tyre does not tear off its rim */
const SHEAR_LIMIT_M = 0.025;
/** Without carcass states (a replayed or remote car): the lateral force (N) that gives the full shear */
const SHEAR_FORCE_SCALE_N = 12000;
/** Arc past the patch edge (m) over which the shear and bulge fall off: about the tyres' relaxation length */
const PATCH_FALLOFF_M = 0.12;

/**
 * The road's height e above the plane under the hub (m, along its normal) along one carrier axis t (x across the
 * tread, z along it): piecewise linear from e = 0 at t = 0 through knots a and b to the end sample on each side,
 * held beyond it. Distances |t| are measured outward from the hub on both sides.
 */
export interface TyreRoadProfile {
  /** Knots on the t < 0 side and on the t > 0 side: (|t|ₐ, eₐ, |t|_b, e_b), 0 ≤ |t|ₐ ≤ |t|_b ≤ the end's */
  neg: THREE.Vector4;
  pos: THREE.Vector4;
  /** The end samples: (|t|₋, e₋, |t|₊, e₊) */
  ends: THREE.Vector4;
}

/**
 * The road under a tyre in its carrier frame (the non-spinning wheel frame the shader deforms in), written by the rig
 * each frame before `TyreDeformationHandle.update`. The vectors are the shader's uniforms: write into them.
 */
export interface TyreRoad {
  /** Road plane under the hub: unit normal (xyz, from the road toward the hub) and offset (w); n · p = w on it */
  plane: THREE.Vector4;
  /** The road's profile above that plane across the tread (carrier x) and along it (carrier z) */
  across: TyreRoadProfile;
  along: TyreRoadProfile;
  /** The wheel's +left and forward along the road, in the carrier frame (unit): the carcass shear's axes */
  left: THREE.Vector3;
  forward: THREE.Vector3;
  /** 1 while the tyre stands on the road (it flattens against it), 0 in the air */
  contact: number;
}

export interface TyreDeformationHandle {
  material: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  /** Undeformed radius and half tread width of the mesh (m) */
  readonly unloadedRadiusM: number;
  readonly halfWidthM: number;
  /** The road under the tyre, in its carrier frame (`corner-rig.ts` writes it each frame before `update`) */
  readonly road: TyreRoad;
  /** Visual radial deflection (m) the tyre takes under this state: what `update` sets `axleDropM` to */
  deflectionOf(state: TyreVisualState): number;
  /**
   * Writes the uniforms for this frame from the tyre state and `road`. Allocation-free.
   * `spinAngleRad` is the spin group's rotation.x (= the physics wheelRotationRad for this corner). The sidewall
   * bulge takes its side from the vertex's own x, so the corner's side is not needed.
   */
  update(state: TyreVisualState, spinAngleRad: number): void;
  /** Recolours the Pirelli branding, and with a tyre wrap swaps the rubber too (no-op on a tyre with neither) */
  setCompound(compound: TireCompound): void;
  /** How much closer to the road (m) the hub sits than the unloaded radius: the visual deflection */
  axleDropM: number;
  dispose(): void;
}

export interface TyreDeformationOptions {
  /** Undeformed radius of the mesh (m): half the mesh height, e.g. 0.349 for the LC26 tyre */
  unloadedRadiusM: number;
  /** Half the tread width (m): the sidewall faces sit at |x| ≈ halfWidthM */
  halfWidthM: number;
  /** Visual exaggeration of the radial deflection and carcass shear (default 1.4) */
  gain?: number;
  /** Draw the Pirelli sidewall (pirelli-sidewall.ts) over the model's own, in this compound's colours */
  pirelliSidewall?: TireCompound;
  /**
   * Wrap the whole tyre in the 2025 Pirelli textures (tyre-wrap.ts), for a tyre mesh with no usable UVs: the
   * mesh-local X the car's outside is on. With `pirelliSidewall` too, the sidewall is what shows if the wrap's
   * textures cannot be fetched
   */
  tyreWrapOuterSide?: 1 | -1;
}

type UniformMap = Record<string, THREE.IUniform>;

/**
 * Shared GLSL. `tyreDeform` takes a mesh-local position and normal and returns the deformed mesh-local ones.
 * Normals are transformed with the same rotations, so they stay consistent with the deformed surface.
 */
const DEFORM_GLSL = /* glsl */ `
uniform float uSpinAngle;
uniform float uDeflection;
uniform float uUnloadedRadius;
uniform float uHalfWidth;
uniform vec4 uRoadPlane;
uniform vec4 uAcrossNeg;
uniform vec4 uAcrossPos;
uniform vec4 uAcrossEnds;
uniform vec4 uAlongNeg;
uniform vec4 uAlongPos;
uniform vec4 uAlongEnds;
uniform vec3 uShear;
uniform vec3 uPatch;

// One side of a road profile at distance u >= 0 from the hub: 0 -> knot a (ab.xy) -> knot b (ab.zw) -> end, held
// beyond; returns the height and its slope de/du
vec2 tyreRoadSide(float u, vec4 ab, vec2 end) {
  if (u <= ab.x) {
    float k = ab.y / max(ab.x, 1e-4);
    return vec2(k * u, k);
  }
  if (u <= ab.z) {
    float k = (ab.w - ab.y) / max(ab.z - ab.x, 1e-4);
    return vec2(ab.y + k * (u - ab.x), k);
  }
  if (u <= end.x) {
    float k = (end.y - ab.w) / max(end.x - ab.z, 1e-4);
    return vec2(ab.w + k * (u - ab.z), k);
  }
  return vec2(end.y, 0.0);
}

// Road profile above the plane at carrier coordinate t, and its slope de/dt
vec2 tyreRoadProfile(float t, vec4 neg, vec4 pos, vec4 ends) {
  if (t < 0.0) {
    vec2 e = tyreRoadSide(-t, neg, ends.xy);
    return vec2(e.x, -e.y);
  }
  return tyreRoadSide(t, pos, ends.zw);
}

void tyreDeform(in vec3 pos, in vec3 nrm, out vec3 outPos, out vec3 outNrm) {
  float c = cos(uSpinAngle);
  float s = sin(uSpinAngle);
  // Carrier (non-spinning wheel) frame: Rx(theta) * local
  vec3 p = vec3(pos.x, c * pos.y - s * pos.z, s * pos.y + c * pos.z);
  vec3 n = vec3(nrm.x, c * nrm.y - s * nrm.z, s * nrm.y + c * nrm.z);

  float R = uUnloadedRadius;
  float d = uDeflection;
  vec3 roadN = uRoadPlane.xyz;
  float r = max(length(p.yz), 1e-6);
  // Angle from the contact direction (toward the road, in the wheel's plane); the clamp keeps acos defined
  vec2 down = -roadN.yz / max(length(roadN.yz), 1e-6);
  float ang = acos(clamp(dot(p.yz, down) / r, -1.0, 1.0));
  // Patch weight: 1 across the contact patch (uPatch.x its half-angle), a Gaussian of the angle past its edge
  float past = max(ang - uPatch.x, 0.0) / uPatch.y;
  float w = exp(-past * past);
  float shoulder = smoothstep(0.55, 0.95, abs(p.x) / uHalfWidth);
  float bead = smoothstep(0.66 * R, 0.8 * R, r);
  float tread = smoothstep(0.6 * R, 0.85 * R, r);

  // Carcass shear: the tread around the patch moves with the carcass deflection relative to the rim
  p += uShear * (w * tread);

  // Contact-patch flattening (on the road only): tread below the road under it (the plane plus the profile across
  // and along the tread) is lifted onto it along the road normal, so the patch comes out flat and follows a kerb
  vec2 across = tyreRoadProfile(p.x, uAcrossNeg, uAcrossPos, uAcrossEnds);
  vec2 along = tyreRoadProfile(p.z, uAlongNeg, uAlongPos, uAlongEnds);
  float height = dot(roadN, p) - uRoadPlane.w - across.x - along.x;
  float below = max(-height, 0.0) * uPatch.z;
  p += roadN * below;

  // Sidewall bulge: outward along the axle (on the road plane), at the shoulders of the patch
  vec3 axle = normalize(vec3(1.0, 0.0, 0.0) - roadN * roadN.x);
  float bulge = 0.8 * d * w * shoulder * bead;
  p += axle * ((p.x >= 0.0) ? bulge : -bulge);

  // Normals: blend toward the road's (tilted by the profile's slope) across the flattened patch
  float flatAmt = clamp(below / max(d, 0.003), 0.0, 1.0);
  vec3 surfN = normalize(roadN - vec3(across.y, 0.0, along.y));
  n = normalize(mix(n, surfN, flatAmt));

  // Back to mesh-local space: Rx(-theta)
  outPos = vec3(p.x, c * p.y + s * p.z, -s * p.y + c * p.z);
  outNrm = normalize(vec3(n.x, c * n.y + s * n.z, -s * n.y + c * n.z));
}
`;

/**
 * Inserts the deformation into a three.js vertex shader. The physical material needs the normal path too (its
 * `objectNormal` is set in `beginnormal_vertex`, before `begin_vertex`); the depth / distance materials only
 * need the position.
 */
function injectDeform(vertexShader: string, withNormal: boolean): string {
  let out = vertexShader.replace('#include <common>', `#include <common>\n${DEFORM_GLSL}`);
  if (withNormal) {
    // Unlit materials only reach beginnormal_vertex under #ifdef, so the position is deformed on its own below
    out = out.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n\tvec3 tyrePosN;\n\ttyreDeform(position, normal, tyrePosN, objectNormal);'
    );
  }
  return out.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\n\tvec3 tyreNrm;\n\ttyreDeform(position, normal, transformed, tyreNrm);'
  );
}

/** A level road profile out to `extentM` either side */
export function levelProfile(extentM: number): TyreRoadProfile {
  const p: TyreRoadProfile = { neg: new THREE.Vector4(), pos: new THREE.Vector4(), ends: new THREE.Vector4() };
  setLevelProfile(p, extentM);
  return p;
}

/** Makes `p` level out to `extentM` either side (allocation-free) */
export function setLevelProfile(p: TyreRoadProfile, extentM: number): void {
  p.neg.set(extentM / 3, 0, (2 * extentM) / 3, 0);
  p.pos.copy(p.neg);
  p.ends.set(extentM, 0, extentM, 0);
}

/** x eased into ±limit (tanh): linear while small, never past the limit */
function softClamp(x: number, limit: number): number {
  return limit * Math.tanh(x / limit);
}

/**
 * Clones the tyre mesh's material (each wheel gets its own uniforms), patches it, and adds matching depth and
 * distance materials so the cast shadow deforms with the tyre. All four tyres share one compiled program
 * through the stable `customProgramCacheKey`. A coarse tread is subdivided first (`tyre-subdivide.ts`).
 */
export function installTyreDeformation(
  mesh: THREE.Mesh,
  opts: TyreDeformationOptions
): TyreDeformationHandle {
  const original = mesh.material as THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  const originalGeometry = mesh.geometry;
  const material = original.clone();
  const gain = opts.gain ?? DEFAULT_GAIN;
  const unloaded = opts.unloadedRadiusM;
  const halfWidth = opts.halfWidthM;

  const road: TyreRoad = {
    plane: new THREE.Vector4(0, 1, 0, -unloaded),
    across: levelProfile(halfWidth),
    along: levelProfile(0.5 * unloaded),
    left: new THREE.Vector3(1, 0, 0),
    forward: new THREE.Vector3(0, 0, 1),
    contact: 0,
  };
  const shear = new THREE.Vector3();
  const patch = new THREE.Vector3(0, PATCH_FALLOFF_M / unloaded, 0);
  const uniforms: UniformMap = {
    uSpinAngle: { value: 0 },
    uDeflection: { value: 0 },
    uUnloadedRadius: { value: unloaded },
    uHalfWidth: { value: halfWidth },
    uRoadPlane: { value: road.plane },
    uAcrossNeg: { value: road.across.neg },
    uAcrossPos: { value: road.across.pos },
    uAcrossEnds: { value: road.across.ends },
    uAlongNeg: { value: road.along.neg },
    uAlongPos: { value: road.along.pos },
    uAlongEnds: { value: road.along.ends },
    uShear: { value: shear },
    uPatch: { value: patch },
  };

  // The sidewall fits itself to the model's own tyre; the subdivided tread keeps its bead and shoulder radii
  const wrapped = opts.tyreWrapOuterSide !== undefined;
  const sidewall = opts.pirelliSidewall ? createPirelliSidewall(originalGeometry, opts.pirelliSidewall, wrapped) : null;
  mesh.geometry = subdivideTyreTread(originalGeometry);
  // The wrap reads the cross-section off the geometry the tyre is drawn with
  const wrap = wrapped
    ? createTyreWrap(mesh.geometry, opts.tyreWrapOuterSide!, opts.pirelliSidewall, sidewall ? loadSidewallTexture : undefined)
    : null;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, true);
    // The wrap first: the sidewall's colour is then written before it, so the wrap covers it once it is in
    wrap?.patch(shader);
    sidewall?.patch(shader);
  };
  // Tyres with and without the sidewall and the wrap compile to different programs
  const programKey = `lc26-tyre-deform${sidewall ? '-sidewall' : ''}${wrap ? '-wrap' : ''}`;
  material.customProgramCacheKey = () => programKey;
  mesh.material = material;

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, false);
  };
  depth.customProgramCacheKey = () => 'lc26-tyre-deform-depth';
  mesh.customDepthMaterial = depth;

  const distance = new THREE.MeshDistanceMaterial();
  distance.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, false);
  };
  distance.customProgramCacheKey = () => 'lc26-tyre-deform-distance';
  mesh.customDistanceMaterial = distance;

  const deflectionOf = (state: TyreVisualState) =>
    // Physical deflection exaggerated, never past half the radius (a wild load spike would fold the tyre)
    Math.min(Math.max(0, state.verticalDeflectionM) * gain, 0.5 * unloaded);

  const handle: TyreDeformationHandle = {
    material,
    unloadedRadiusM: unloaded,
    halfWidthM: halfWidth,
    road,
    axleDropM: 0,
    deflectionOf,
    update(state, spinAngleRad) {
      const visual = deflectionOf(state);
      uniforms.uSpinAngle.value = spinAngleRad;
      uniforms.uDeflection.value = visual;
      // Contact-patch half-angle acos((R − d) / R): its half-length is √(2Rd − d²)
      patch.x = Math.acos(THREE.MathUtils.clamp((unloaded - visual) / unloaded, -1, 1));
      patch.z = road.contact;
      // Carcass shear in the wheel frame: the tread follows the force on the tyre, opposite the slip states' sign
      // for the lateral one (deflection y + while the contact slides left, Fy −), with it for the longitudinal one
      // (x + while driving, Fx +: the patch winds up ahead of the hub; under braking it trails behind)
      let leftM: number;
      let forwardM: number;
      if (state.carcassDeflectionYM !== undefined) {
        leftM = softClamp(-state.carcassDeflectionYM * gain, SHEAR_LIMIT_M);
        forwardM = softClamp((state.carcassDeflectionXM ?? 0) * gain, SHEAR_LIMIT_M);
      } else {
        leftM = THREE.MathUtils.clamp(state.lateralForceN / SHEAR_FORCE_SCALE_N, -SHEAR_LIMIT_M, SHEAR_LIMIT_M);
        forwardM = 0;
      }
      shear.copy(road.left).multiplyScalar(leftM).addScaledVector(road.forward, forwardM);
      handle.axleDropM = visual;
    },
    setCompound(compound) {
      sidewall?.setCompound(compound);
      wrap?.setCompound(compound);
    },
    dispose() {
      // The mesh keeps the (shared, cached) subdivided tread: it draws the same undeformed
      mesh.material = original;
      mesh.customDepthMaterial = undefined;
      mesh.customDistanceMaterial = undefined;
      material.dispose();
      depth.dispose();
      distance.dispose();
    },
  };
  return handle;
}

/**
 * Swaps the tread / sidewall map on every tyre clone (the replacement for the shared-material compound swap).
 * Only the map changes, so the compiled program is reused.
 */
export function setTyreDeformationMap(handles: TyreDeformationHandle[], map: THREE.Texture): void {
  for (const h of handles) {
    if (h.material.map === map) continue;
    h.material.map = map;
    h.material.needsUpdate = true;
  }
}
