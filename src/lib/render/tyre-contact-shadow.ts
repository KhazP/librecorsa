import * as THREE from "three";

/**
 * A soft dark patch on the road under each tyre, where the tread meets it. The car-wide contact shadow
 * (`contact-shadow.ts`) darkens the floor's footprint but fades out toward the wheels, and the sun's shadow map is too
 * coarse (and off on Low) to darken the road in the thin wedge between the tread and the asphalt, so the tyres looked
 * set on the road rather than pressed into it. One texture and one quad for every tyre, a material per tyre so each
 * fades with its own load; laid on the road plane under the hub and turned with the steering (`corner-rig.ts`).
 */
let texture: THREE.CanvasTexture | null = null;
let geometry: THREE.PlaneGeometry | null = null;
let baseMaterial: THREE.MeshBasicMaterial | null = null;

/** Darkness of a fully loaded tyre's shadow; light, as the car-wide shadow already darkens the road under it */
const OPACITY = 0.5;
/** The shadow sits this far above the road (m), clear of its z-fighting, as the car-wide one */
const LIFT_M = 0.012;
/** How far ahead of and behind the patch the wedge under the tread stays dark (m): a gap under ~5 cm */
const WEDGE_M = 0.18;
/** Width of the shadow over the tread's (the shoulders' wedges spread it a little) */
const WIDTH_SCALE = 1.3;
/** Physical radial deflection (m) at which the shadow is fully dark: it fades as the tyre unloads */
const FULL_LOAD_DEFLECTION_M = 0.004;

function shadowTexture(): THREE.CanvasTexture | null {
  if (texture) return texture;
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A radial falloff (no canvas filter, so older Safari draws it too); the quad's scale stretches it to the tyre
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(0, 0, 0, 1)");
  grad.addColorStop(0.35, "rgba(0, 0, 0, 0.75)");
  grad.addColorStop(0.7, "rgba(0, 0, 0, 0.22)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/** A tyre's contact shadow, added to `parent` (the car rig's root: the car frame); null without a document */
export function createTyreContactShadow(parent: THREE.Object3D): THREE.Mesh | null {
  const map = shadowTexture();
  if (!map) return null;
  geometry ??= new THREE.PlaneGeometry(1, 1);
  baseMaterial ??= new THREE.MeshBasicMaterial({
    map,
    color: 0x000000,
    transparent: true,
    opacity: OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, baseMaterial.clone());
  mesh.name = "TyreContactShadow";
  mesh.renderOrder = -1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  parent.add(mesh);
  return mesh;
}

const _basis = new THREE.Matrix4();

/**
 * Lays a tyre's contact shadow on the road at `point` (car frame), facing the road normal `up`, its length along the
 * wheel's `forward` and its width along its `left` (both unit, on the road plane). `patchHalfLengthM` is the visual
 * contact patch's, `halfWidthM` the tread's, `deflectionM` the physical radial deflection (it fades the shadow).
 */
export function placeTyreContactShadow(
  mesh: THREE.Mesh,
  point: THREE.Vector3,
  up: THREE.Vector3,
  left: THREE.Vector3,
  forward: THREE.Vector3,
  patchHalfLengthM: number,
  halfWidthM: number,
  deflectionM: number
): void {
  const strength = THREE.MathUtils.clamp(deflectionM / FULL_LOAD_DEFLECTION_M, 0, 1);
  mesh.visible = strength > 0.02;
  if (!mesh.visible) return;
  // The quad's X along the wheel, Y across it, its normal (Z) up off the road: forward × left = up
  _basis.makeBasis(forward, left, up);
  mesh.quaternion.setFromRotationMatrix(_basis);
  mesh.position.copy(point).addScaledVector(up, LIFT_M);
  mesh.scale.set(2 * (patchHalfLengthM + WEDGE_M), 2 * halfWidthM * WIDTH_SCALE, 1);
  (mesh.material as THREE.MeshBasicMaterial).opacity = OPACITY * strength;
}
