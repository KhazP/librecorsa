import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";
import type { LiveryDecal, LiveryDecalSet } from "@/types/f1";

/**
 * Livery decals for a body painted in zones (no UVs): each decal is a picture from one atlas, projected flat onto the
 * paint along an axis in the body's own space (`LiveryDecal`). A decal paints only surfaces that face its projection
 * (normal within ~70 degrees) and lie within `depth` of its plane, so a side decal stops at the top of a sidepod and
 * never shows through on the other side. Every paint material of every car carries the same shader; a livery without
 * decals sets the count to 0, so changing livery never recompiles.
 */

const MAX_DECALS = 12;

interface DecalUniforms {
  decalAtlas: { value: THREE.Texture };
  decalCount: { value: number };
  /** Centre (xyz) and half-depth (w) */
  decalCentre: { value: THREE.Vector4[] };
  /** Picture right / up across the surface, already divided by the decal's width / height */
  decalU: { value: THREE.Vector3[] };
  decalV: { value: THREE.Vector3[] };
  /** Projection direction (out of the surface) */
  decalN: { value: THREE.Vector3[] };
  /** Atlas rectangle: x, y, width, height (0-1, y down from the top of the picture) */
  decalRect: { value: THREE.Vector4[] };
}

const BLANK = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
BLANK.needsUpdate = true;

/** Atlases, loaded once each and shared by every car wearing them */
const atlases = new Map<string, Promise<THREE.Texture | null>>();

function loadAtlas(url: string): Promise<THREE.Texture | null> {
  let p = atlases.get(url);
  if (!p) {
    p = new THREE.TextureLoader()
      .loadAsync(withBasePath(url))
      .then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.flipY = false;
        t.anisotropy = 8;
        t.needsUpdate = true;
        return t;
      })
      .catch((err) => {
        console.warn(`Livery decals ${url} not loaded`, err);
        return null;
      });
    atlases.set(url, p);
  }
  return p;
}

const AXES: Record<LiveryDecal["face"], { n: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3 }> = {
  // Read from outside the car: on the left (+X) the picture runs front to back, on the right back to front
  left: { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, 1, 0) },
  right: { n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0) },
  // From above with the nose at the top of the picture
  top: { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  // From behind, upright
  rear: { n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
};

function makeUniforms(): DecalUniforms {
  return {
    decalAtlas: { value: BLANK },
    decalCount: { value: 0 },
    decalCentre: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector4()) },
    decalU: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector3()) },
    decalV: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector3()) },
    decalN: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector3()) },
    decalRect: { value: Array.from({ length: MAX_DECALS }, () => new THREE.Vector4()) },
  };
}

const VERTEX_PATCH = /* glsl */ `#include <common>
varying vec3 vDecalPos;
varying vec3 vDecalNrm;`;
const VERTEX_BODY = /* glsl */ `#include <begin_vertex>
vDecalPos = position;
vDecalNrm = normal;`;

const FRAGMENT_PATCH = /* glsl */ `#include <common>
#define MAX_DECALS ${MAX_DECALS}
uniform sampler2D decalAtlas;
uniform int decalCount;
uniform vec4 decalCentre[MAX_DECALS];
uniform vec3 decalU[MAX_DECALS];
uniform vec3 decalV[MAX_DECALS];
uniform vec3 decalN[MAX_DECALS];
uniform vec4 decalRect[MAX_DECALS];
varying vec3 vDecalPos;
varying vec3 vDecalNrm;`;
const FRAGMENT_BODY = /* glsl */ `#include <map_fragment>
{
	vec3 dn = normalize( vDecalNrm );
	for ( int i = 0; i < MAX_DECALS; i ++ ) {
		if ( i >= decalCount ) break;
		vec3 d = vDecalPos - decalCentre[ i ].xyz;
		float face = dot( dn, decalN[ i ] );
		if ( face < 0.35 || abs( dot( d, decalN[ i ] ) ) > decalCentre[ i ].w ) continue;
		vec2 uv = vec2( dot( d, decalU[ i ] ), dot( d, decalV[ i ] ) ) + 0.5;
		if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) continue;
		vec4 t = texture2D( decalAtlas, decalRect[ i ].xy + vec2( uv.x, 1.0 - uv.y ) * decalRect[ i ].zw );
		diffuseColor.rgb = mix( diffuseColor.rgb, t.rgb, t.a * smoothstep( 0.35, 0.5, face ) );
	}
}`;

export interface LiveryDecalPaint {
  /** Shows a livery's decals (null: none) */
  set: (decals: LiveryDecalSet | null | undefined) => void;
}

/**
 * Gives a car's paint materials the decal shader (they must be that car's own: the uniforms are per car). The meshes
 * they are on must be in the body's space (BODY, not a flap with its own node transform).
 */
export function installLiveryDecals(materials: THREE.Material[]): LiveryDecalPaint {
  const u = makeUniforms();
  for (const m of materials) {
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", VERTEX_PATCH)
        .replace("#include <begin_vertex>", VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", FRAGMENT_PATCH)
        .replace("#include <map_fragment>", FRAGMENT_BODY);
    };
    const key = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${key()}|livery-decals`;
    m.needsUpdate = true;
  }
  let wanted: LiveryDecalSet | null = null;
  return {
    set: (set) => {
      wanted = set ?? null;
      u.decalCount.value = 0;
      if (!set) return;
      void loadAtlas(set.atlas).then((atlas) => {
        if (!atlas || wanted !== set) return;
        const n = Math.min(set.decals.length, MAX_DECALS);
        for (let i = 0; i < n; i++) {
          const d = set.decals[i];
          const ax = AXES[d.face];
          const rot = THREE.MathUtils.degToRad(d.rotDeg ?? 0);
          // In-plane rotation of the picture (counter-clockwise as seen from outside)
          const right = ax.u.clone().multiplyScalar(Math.cos(rot)).addScaledVector(ax.v, Math.sin(rot));
          if (d.flipX) right.negate();
          const up = ax.v.clone().multiplyScalar(Math.cos(rot)).addScaledVector(ax.u, -Math.sin(rot));
          u.decalCentre.value[i].set(d.centre[0], d.centre[1], d.centre[2], d.depth ?? 0.2);
          u.decalU.value[i].copy(right).divideScalar(d.size[0]);
          u.decalV.value[i].copy(up).divideScalar(d.size[1]);
          u.decalN.value[i].copy(ax.n);
          u.decalRect.value[i].set(d.rect[0], d.rect[1], d.rect[2], d.rect[3]);
        }
        u.decalAtlas.value = atlas;
        u.decalCount.value = n;
      });
    },
  };
}
