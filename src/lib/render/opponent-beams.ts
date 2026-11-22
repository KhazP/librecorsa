import * as THREE from "three";
import type { HeadlightBeam } from "./car-headlights";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { chainShaderPatch } from "./venue-night-lighting";

/*
 * The other cars' headlights on the road. The player's car lights the road with real SpotLights, but three.js walks
 * every SpotLight in the scene for every lit pixel, so twenty cars with their own would cost twenty lights a pixel.
 * Instead the circuit's own materials take a short list of beams (the cars nearest the camera, merged into one beam
 * each, as Medium's single headlight) and light themselves by them: the same cone, the same fall-off with distance and
 * the same angle to the ground as a SpotLight, added as diffuse light (no shine). Other cars are not lit by them.
 *
 * Beams are in world space, so the mirrors and the reflection probe see them right too. Costs per frame: picking the
 * nearest cars; in the circuit's shaders, a short loop over the beams (MAX_BEAMS by quality, skipped for unused slots).
 */

/** Beams the circuit's shaders loop over, by graphics quality */
export const MAX_BEAMS = { low: 2, medium: 4, high: 8 } as const;
/** Cars further from the camera than this light nothing worth the slot (m) */
const BEAM_CULL_M = 220;
/** The merged beam's cone (as car-headlights' single SpotLight: about 31 deg half angle, a wide soft edge) */
const CONE_OUTER_RAD = 0.548;
const CONE_PENUMBRA = 0.86;

const vertexPatches: readonly ShaderPatch[] = [
  ["#include <common>", "#include <common>\nvarying vec3 vLcBeamWorld;"],
  [
    "#include <project_vertex>",
    /* glsl */ `#include <project_vertex>
	{
		vec4 lcBeamWorld = vec4( transformed, 1.0 );
		#ifdef USE_BATCHING
			lcBeamWorld = batchingMatrix * lcBeamWorld;
		#endif
		#ifdef USE_INSTANCING
			lcBeamWorld = instanceMatrix * lcBeamWorld;
		#endif
		vLcBeamWorld = ( modelMatrix * lcBeamWorld ).xyz;
	}`,
  ],
];

const fragmentPatches = (count: number): readonly ShaderPatch[] => [
  [
    "#include <common>",
    `#include <common>
#define LC_BEAMS ${count}
uniform vec4 uLcBeamPos[ LC_BEAMS ];
uniform vec4 uLcBeamDir[ LC_BEAMS ];
uniform vec3 uLcBeamColor;
uniform vec2 uLcBeamCone;
varying vec3 vLcBeamWorld;`,
  ],
  [
    "#include <lights_fragment_end>",
    /* glsl */ `
	#if defined( RE_IndirectDiffuse )
	{
		// the surface's normal in world space (normal is in view space here)
		vec3 lcBeamN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
		for ( int i = 0; i < LC_BEAMS; i ++ ) {
			float lcI = uLcBeamPos[ i ].w;
			if ( lcI <= 0.0 ) continue;
			vec3 lcL = uLcBeamPos[ i ].xyz - vLcBeamWorld;
			float lcD = length( lcL );
			vec3 lcDir = lcL / max( lcD, 1e-3 );
			float lcSpot = smoothstep( uLcBeamCone.x, uLcBeamCone.y, dot( -lcDir, uLcBeamDir[ i ].xyz ) );
			float lcNdl = max( dot( lcBeamN, lcDir ), 0.0 );
			// as a SpotLight with decay 1: intensity over distance, faded out toward its reach
			float lcR = lcD / uLcBeamDir[ i ].w;
			float lcWin = clamp( 1.0 - lcR * lcR * lcR * lcR, 0.0, 1.0 );
			irradiance += uLcBeamColor * ( lcI * lcSpot * lcNdl * lcWin * lcWin / max( lcD, 0.1 ) );
		}
	}
	#endif
#include <lights_fragment_end>`,
  ],
];

export interface OpponentBeams {
  /** The beams this frame (any number; the nearest to `camera` are used), then the shaders' list is filled */
  update(beams: readonly HeadlightBeam[], count: number, camera: THREE.Vector3): void;
  dispose(): void;
}

interface BeamUniformHolder {
  n: number;
  pos: THREE.Vector4[];
  dir: THREE.Vector4[];
  uniforms: {
    uLcBeamPos: { value: THREE.Vector4[] };
    uLcBeamDir: { value: THREE.Vector4[] };
    uLcBeamColor: { value: THREE.Color };
    uLcBeamCone: { value: THREE.Vector2 };
  };
}

/** Keyed by material identity (not userData) so Material.clone() never inherits a JSON-copied holder without the shader patch */
const patchedBeamHolders = new WeakMap<THREE.Material, BeamUniformHolder>();

/**
 * Patches the circuit's materials (the loaded model under `root`) for the other cars' beams, `maxBeams` of them. Call
 * once the model is in and the session can get dark, before its first night frame (a shader compile per material).
 * Calling again on already-patched circuit materials reuses their bound uniform holder instead of double-patching GLSL.
 */
export function createOpponentBeams(root: THREE.Object3D, maxBeams: number, color: THREE.ColorRepresentation = 0xf6f9ff): OpponentBeams {
  const n = Math.max(1, Math.round(maxBeams));
  let freshHolder: BeamUniformHolder | null = null;
  let frag: ReturnType<typeof fragmentPatches> | null = null;
  const holders = new Set<BeamUniformHolder>();
  const visited = new Set<THREE.Material>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial || visited.has(mat)) continue;
      visited.add(mat);
      const existing = patchedBeamHolders.get(mat);
      if (existing) {
        existing.uniforms.uLcBeamColor.value.set(color);
        holders.add(existing);
        continue;
      }
      if (!freshHolder) {
        const pos = Array.from({ length: n }, () => new THREE.Vector4(0, 0, 0, 0));
        const dir = Array.from({ length: n }, () => new THREE.Vector4(0, 0, 1, 1));
        freshHolder = {
          n,
          pos,
          dir,
          uniforms: {
            uLcBeamPos: { value: pos },
            uLcBeamDir: { value: dir },
            uLcBeamColor: { value: new THREE.Color(color) },
            uLcBeamCone: { value: new THREE.Vector2(Math.cos(CONE_OUTER_RAD), Math.cos(CONE_OUTER_RAD * (1 - CONE_PENUMBRA))) },
          },
        };
        frag = fragmentPatches(n);
      }
      const h = freshHolder;
      const f = frag!;
      patchedBeamHolders.set(mat, h);
      holders.add(h);
      chainShaderPatch(mat, `opponent-beams-${n}`, (shader) => {
        Object.assign(shader.uniforms, h.uniforms);
        shader.vertexShader = patchShader(shader.vertexShader, vertexPatches, "opponent beams");
        shader.fragmentShader = patchShader(shader.fragmentShader, f, "opponent beams");
      });
    }
  });

  // nearest first, without allocating each frame
  const order: number[] = [];
  const dist: number[] = [];
  return {
    update(beams, count, camera) {
      order.length = 0;
      for (let i = 0; i < count; i++) {
        const d = beams[i].pos.distanceTo(camera);
        if (d > BEAM_CULL_M) continue;
        dist[i] = d;
        order.push(i);
      }
      order.sort((a, b) => dist[a] - dist[b]);
      for (const h of holders) {
        const activeLimit = Math.min(n, h.n);
        for (let k = 0; k < h.n; k++) {
          const b = k < activeLimit && k < order.length ? beams[order[k]] : null;
          if (!b) {
            h.pos[k].w = 0;
            continue;
          }
          h.pos[k].set(b.pos.x, b.pos.y, b.pos.z, b.intensity);
          h.dir[k].set(b.dir.x, b.dir.y, b.dir.z, Math.max(1, b.range));
        }
      }
    },
    dispose() {
      for (const h of holders) for (const p of h.pos) p.w = 0;
    },
  };
}
