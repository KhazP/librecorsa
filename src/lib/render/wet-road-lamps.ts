import * as THREE from "three";

/*
 * Lamps mirrored in the wet road: the cars' tail and rain lights (and their brake lights), the headlights coming
 * toward the camera, and the circuit's street lamps at night. A wet road at a grazing angle draws each of them out
 * into a long streak toward the viewer; the road's shader (asphalt-sheen.ts) does that per lamp with a glossy
 * highlight stretched along the view, so this only picks which lamps: the brightest-looking few near the camera.
 *
 * Costs per frame: a pass over the candidate lamps (the cars, and the street lamps within reach of the camera) and a
 * short sort; in the road's shader, a loop over the picked lamps on wet pixels only (none when dry or with no lamps).
 */

/** Lamps the road's shader takes at most (its uniform arrays' size) */
export const WET_LAMP_SLOTS = 8;
/** Lamps picked by graphics quality: each costs a highlight on every wet road pixel */
export const WET_LAMPS_BY_QUALITY = { low: 2, medium: 4, high: 8 } as const;
/** Lamps further from the camera than this are not worth a slot (m) */
const WET_LAMP_REACH_M = 140;

/** One lamp for the road to mirror */
export interface WetLamp {
  /** World position of the lamp */
  pos: THREE.Vector3;
  /** Linear colour times its strength (as a point light's intensity, three's units) */
  color: THREE.Color;
  /** Size of the light (m): a bigger lamp makes a broader, dimmer highlight */
  radiusM: number;
  /** A headlight's beam: its unit direction and the cosine of its cone; null for a lamp shining all round */
  dir: THREE.Vector3 | null;
  coneCos: number;
}

/** The uniforms the road's shader reads (one shared set for every asphalt material) */
export const wetLampUniforms = {
  uWetLampPos: { value: Array.from({ length: WET_LAMP_SLOTS }, () => new THREE.Vector4()) },
  uWetLampColor: { value: Array.from({ length: WET_LAMP_SLOTS }, () => new THREE.Vector3()) },
  uWetLampDir: { value: Array.from({ length: WET_LAMP_SLOTS }, () => new THREE.Vector4(0, 0, 1, -2)) },
  uWetLampCount: { value: 0 },
};

/** A fresh lamp to fill (reuse it: the picker keeps references only until the next pick) */
export function makeWetLamp(): WetLamp {
  return { pos: new THREE.Vector3(), color: new THREE.Color(), radiusM: 0.1, dir: null, coneCos: -2 };
}

const order: number[] = [];
const weight: number[] = [];
const toCam = new THREE.Vector3();

/**
 * Picks up to `max` of `lamps[0..count)` for the road: by how bright each looks from `camera` (its strength over the
 * square of its distance), nearest-brightest first, and writes them into the shader's uniforms. A headlight counts
 * only as far as it faces the camera: one shining away lights road whose reflection runs on away from the camera too,
 * and on a grid in the rain the cars' headlights took every slot from the tail lights the camera does see in the
 * road. `max` 0 (or a dry road, `wet` false) clears them, so the shader's loop does nothing.
 */
export function pickWetRoadLamps(lamps: readonly WetLamp[], count: number, camera: THREE.Vector3, max: number, wet: boolean): number {
  const u = wetLampUniforms;
  order.length = 0;
  const n = Math.min(WET_LAMP_SLOTS, Math.max(0, Math.floor(max)));
  if (wet && n > 0) {
    for (let i = 0; i < count; i++) {
      const l = lamps[i];
      const d = l.pos.distanceTo(camera);
      if (d > WET_LAMP_REACH_M) continue;
      let strength = Math.max(l.color.r, l.color.g, l.color.b);
      if (l.dir) {
        const facing = toCam.subVectors(camera, l.pos).normalize().dot(l.dir);
        strength *= THREE.MathUtils.smoothstep(facing, 0.2, 0.8);
      }
      if (!(strength > 0)) continue;
      weight[i] = strength / Math.max(4, d * d);
      order.push(i);
    }
    order.sort((a, b) => weight[b] - weight[a]);
  }
  const k = Math.min(n, order.length);
  for (let s = 0; s < k; s++) {
    const l = lamps[order[s]];
    u.uWetLampPos.value[s].set(l.pos.x, l.pos.y, l.pos.z, Math.max(0.02, l.radiusM));
    u.uWetLampColor.value[s].set(l.color.r, l.color.g, l.color.b);
    if (l.dir) u.uWetLampDir.value[s].set(l.dir.x, l.dir.y, l.dir.z, l.coneCos);
    else u.uWetLampDir.value[s].set(0, 0, 1, -2);
  }
  u.uWetLampCount.value = k;
  return k;
}
