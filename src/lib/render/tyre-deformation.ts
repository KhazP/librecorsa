/**
 * GPU tyre deformation for the VF26 tyre meshes: contact-patch flattening, sidewall bulge and lateral carcass
 * shear, driven by the physics' per-corner tyre state (`TyreVisualState`). No texture fetches in the vertex
 * shader; the per-wheel cost is a few dozen ALU ops per vertex.
 *
 * Frames. The tyre spins about its local X (the axle): world = Rx(θ) · local, θ = the spin angle (the spin group's
 * rotation.x). The vertex shader first undoes the spin (carrier = Rx(θ) · local), so the contact patch sits at a
 * fixed place (−Y) while the tread rolls through it, deforms there, then maps back with Rx(−θ). The spin group
 * re-applies Rx(θ), so the deformed vertices land in the wheel frame and the tread texture still rolls.
 *
 * Deformation in the carrier frame, with d = δ · gain the visual deflection:
 *  - patch weight w = exp(−(a / 0.45)²), a = angle from the contact direction (−Y) in the (y, z) plane.
 *  - flattening: tread vertices below the plane y = −(R − d) + x · tan(camber) are lifted onto it. Those are the
 *    patch itself (about ±0.3 rad around the bottom), so the patch comes out flat with a crisp tread edge. The plane
 *    is tilted by the camber relative to the baked model camber (camber leaning toward +X = left).
 *  - sidewall bulge: shoulders are pushed outward along the axle (sign x) by 0.8 · d · w, masked off the bead.
 *  - carcass shear: the tread is shifted along +X (car left) by shear · w, shear = clamp(Fy / 12 kN, ±2.5 cm).
 *
 * `gain` (default 1.4) exaggerates the squeeze so it reads at chase-camera distance. The same exaggerated
 * deflection drives `axleDropM`, which the caller lowers the steer pivot by so the flat patch stays on the road.
 */
import * as THREE from 'three';
import type { TyreVisualState } from '../sim/simulator-car';

/** Default visual exaggeration of the radial deflection */
const DEFAULT_GAIN = 1.4;
/** Lateral force (N) that gives the full carcass shear, and the shear limit (m) */
const SHEAR_FORCE_SCALE_N = 12000;
const SHEAR_LIMIT_M = 0.025;

export interface TyreDeformationHandle {
  material: THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  /**
   * Writes the uniforms for this frame. Allocation-free.
   * `spinAngleRad` is the spin group's rotation.x (= the physics wheelRotationRad for this corner).
   * `isLeft` is true for the car's left-side corners (FL, RL).
   */
  update(state: TyreVisualState, spinAngleRad: number, isLeft: boolean): void;
  /** How far (m) the axle should drop so the flattened patch touches the ground (the steer pivot's y is lowered by this) */
  axleDropM: number;
  dispose(): void;
}

export interface TyreDeformationOptions {
  /** Undeformed radius of the mesh (m): half the mesh height, e.g. 0.349 for the VF26 tyre */
  unloadedRadiusM: number;
  /** Half the tread width (m): the sidewall faces sit at |x| ≈ halfWidthM */
  halfWidthM: number;
  /** Visual exaggeration of the radial deflection (default 1.4) */
  gain?: number;
  /**
   * Camber the mesh is baked with (rad, leaning toward +X = car left). The flattening plane is tilted by
   * `camberRad − bakedCamberRad`, so a wheel at its baked camber has a level patch. Default 0.
   */
  bakedCamberRad?: number;
}

type UniformMap = Record<string, THREE.IUniform>;

/**
 * Shared GLSL. `tyreDeform` takes a mesh-local position and normal and returns the deformed mesh-local ones.
 * Normals are transformed with the same rotations, so they stay consistent with the deformed surface.
 */
const DEFORM_GLSL = /* glsl */ `
uniform float uSpinAngle;
uniform float uLoadedRadius;
uniform float uDeflection;
uniform float uLateralShear;
uniform float uCamber;
uniform float uUnloadedRadius;
uniform float uHalfWidth;
uniform float uGain;
uniform float uSideSign;

void tyreDeform(in vec3 pos, in vec3 nrm, out vec3 outPos, out vec3 outNrm) {
  float c = cos(uSpinAngle);
  float s = sin(uSpinAngle);
  // Carrier (non-spinning wheel) frame: Rx(theta) * local
  vec3 p = vec3(pos.x, c * pos.y - s * pos.z, s * pos.y + c * pos.z);
  vec3 n = vec3(nrm.x, c * nrm.y - s * nrm.z, s * nrm.y + c * nrm.z);

  float R = uUnloadedRadius;
  float d = uDeflection * uGain;
  float r = max(length(p.yz), 1e-6);
  // Angle from the contact direction (-Y); the clamp keeps acos defined
  float ang = acos(clamp(-p.y / r, -1.0, 1.0));
  // Contact-patch weight: 1 at the bottom, about 0 beyond ~1 rad
  float w = exp(-(ang * ang) / (0.45 * 0.45));
  float shoulder = smoothstep(0.55, 0.95, abs(p.x) / uHalfWidth);
  float bead = smoothstep(0.66 * R, 0.8 * R, r);
  float tread = smoothstep(0.6 * R, 0.85 * R, r);

  // Contact-patch flattening onto the camber-tilted plane (no flattening unloaded). Only tread below the plane is
  // lifted, which is exactly the patch (|angle| < acos((R - d) / R) ≈ 0.3 rad), so the patch comes out flat.
  float loadK = clamp(d / 0.001, 0.0, 1.0);
  float plane = -uLoadedRadius + p.x * tan(uCamber);
  float below = max(plane - p.y, 0.0) * loadK;
  p.y += below;

  // Sidewall bulge: outward along the axle normal, at the shoulders of the patch
  float bulge = 0.8 * d * w * shoulder * bead;
  p.x += (p.x >= 0.0) ? bulge : -bulge;

  // Lateral carcass shear (+X = car left, the direction of +Fy)
  p.x += uLateralShear * w * tread;

  // Normals: blend toward the road normal across the flattened patch
  float flatAmt = clamp(below / max(d, 1e-5), 0.0, 1.0);
  n = normalize(mix(n, vec3(0.0, -1.0, 0.0), flatAmt));

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
    out = out
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\n\tvec3 tyrePos;\n\ttyreDeform(position, normal, tyrePos, objectNormal);'
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed = tyrePos;');
  } else {
    out = out.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvec3 tyreNrm;\n\ttyreDeform(position, normal, transformed, tyreNrm);'
    );
  }
  return out;
}

/**
 * Clones the tyre mesh's material (each wheel gets its own uniforms), patches it, and adds matching depth and
 * distance materials so the cast shadow deforms with the tyre. All four tyres share one compiled program
 * through the stable `customProgramCacheKey`.
 */
export function installTyreDeformation(
  mesh: THREE.Mesh,
  opts: TyreDeformationOptions
): TyreDeformationHandle {
  const original = mesh.material as THREE.MeshPhysicalMaterial | THREE.MeshStandardMaterial;
  const material = original.clone();
  const gain = opts.gain ?? DEFAULT_GAIN;
  const bakedCamber = opts.bakedCamberRad ?? 0;
  const unloaded = opts.unloadedRadiusM;

  const uniforms: UniformMap = {
    uSpinAngle: { value: 0 },
    uLoadedRadius: { value: unloaded },
    uDeflection: { value: 0 },
    uLateralShear: { value: 0 },
    uCamber: { value: 0 },
    uUnloadedRadius: { value: unloaded },
    uHalfWidth: { value: opts.halfWidthM },
    uGain: { value: gain },
    uSideSign: { value: 1 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, true);
  };
  material.customProgramCacheKey = () => 'vf26-tyre-deform';
  mesh.material = material;

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, false);
  };
  depth.customProgramCacheKey = () => 'vf26-tyre-deform-depth';
  mesh.customDepthMaterial = depth;

  const distance = new THREE.MeshDistanceMaterial();
  distance.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = injectDeform(shader.vertexShader, false);
  };
  distance.customProgramCacheKey = () => 'vf26-tyre-deform-distance';
  mesh.customDistanceMaterial = distance;

  const handle: TyreDeformationHandle = {
    material,
    axleDropM: 0,
    update(state, spinAngleRad, isLeft) {
      // Physical deflection and the visually exaggerated one (both m, both >= 0)
      const delta = Math.max(0, state.verticalDeflectionM);
      const visual = delta * gain;
      uniforms.uSpinAngle.value = spinAngleRad;
      uniforms.uDeflection.value = delta;
      uniforms.uLoadedRadius.value = unloaded - visual;
      uniforms.uLateralShear.value = THREE.MathUtils.clamp(
        state.lateralForceN / SHEAR_FORCE_SCALE_N,
        -SHEAR_LIMIT_M,
        SHEAR_LIMIT_M
      );
      uniforms.uCamber.value = state.camberRad - bakedCamber;
      uniforms.uSideSign.value = isLeft ? 1 : -1;
      handle.axleDropM = visual;
    },
    dispose() {
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
