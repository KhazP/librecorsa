import * as THREE from "three";

/**
 * Wing mirrors for the VF26 GLB (`mirror_1` = left, +X; `mirror_2` = right, -X).
 *
 * One rear-facing camera at the driver's eye point renders the scene behind the car into a 256x128 half-float
 * target every second frame while the cockpit view is active. Both mirror meshes show that image through a
 * planar projection in object space, so no per-vertex UVs from the GLB are used.
 *
 * Mapping (derived from the GLB, not guessed):
 *   - the mirror patches are small: x 0.51..0.70 (left) and -0.70..-0.51 (right), y 0.722..0.775, z 0.40..0.48
 *   - a camera looking backwards has screen-right = model +X, so the image's horizontal coordinate follows x
 *     directly: the outer edge of each mirror maps to the matching side of the image. No horizontal flip is needed
 *     (a flip would show the far-left scene on the inner edge of the left mirror).
 *   - each patch is about 3.4:1, the target is 2:1, so the image is cropped vertically to the patch's aspect
 *     rather than stretched.
 * Both mirrors show the same full-width image (the centre band of the rear view).
 *
 * Cost: the car's own model is hidden during the mirror pass (self-occlusion and the cockpit's own geometry
 * would otherwise fill the 35 degree frame), the shadow map is not re-rendered, and nothing is allocated per frame.
 * Shader variants are compiled in the constructor so the first cockpit switch does not hitch.
 */

const MIRROR_MATERIALS = ["mirror_1", "mirror_2"] as const;
const RT_WIDTH = 256;
const RT_HEIGHT = 128;
const RT_ASPECT = RT_WIDTH / RT_HEIGHT;
/** Driver eye point in the GLB frame (the rig's cockpit camera anchor, before the body group's offset) */
const EYE_IN_MODEL = new THREE.Vector3(0, 0.74, 0);
const CAMERA_FOV_DEG = 35;
const CAMERA_NEAR = 0.3;
const CAMERA_FAR = 400;

interface MirrorSlot {
  mesh: THREE.Mesh;
  glass: THREE.Material;
  glassGeometry: THREE.BufferGeometry;
  surfaceGeometry: THREE.BufferGeometry;
  surface: THREE.MeshBasicMaterial;
}

/**
 * Builds a geometry that shares the source's attribute and index buffers but carries its own planar UV set.
 * The GLB's BODY primitives share one vertex buffer, so the source is never modified; only referenced vertices
 * are mapped (from the index buffer, per mirror).
 */
function buildMirrorGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
  const index = src.index;
  if (!pos || !index) return null;
  const count = pos.count;
  const used = new Uint8Array(count);
  for (let i = 0; i < index.count; i++) used[index.getX(i)] = 1;

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let v = 0; v < count; v++) {
    if (!used[v]) continue;
    const x = pos.getX(v), y = pos.getY(v);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const w = xMax - xMin;
  const h = yMax - yMin;
  if (!(w > 0) || !(h > 0)) return null;

  // Crop the image to the patch's aspect instead of stretching it
  const aspect = w / h;
  const fx = aspect > RT_ASPECT ? 1 : aspect / RT_ASPECT;
  const fy = aspect > RT_ASPECT ? RT_ASPECT / aspect : 1;

  const uv = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    if (!used[v]) continue;
    const u = (pos.getX(v) - xMin) / w;
    const t = (pos.getY(v) - yMin) / h;
    uv[v * 2] = 0.5 + (u - 0.5) * fx;
    uv[v * 2 + 1] = 0.5 + (t - 0.5) * fy;
  }

  const geo = new THREE.BufferGeometry();
  for (const name in src.attributes) {
    if (name !== "uv") geo.setAttribute(name, src.getAttribute(name));
  }
  geo.setIndex(index);
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

export class WingMirrors {
  readonly found: boolean;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly carModelRoot: THREE.Object3D;
  private readonly rt: THREE.WebGLRenderTarget | null = null;
  private readonly cam: THREE.PerspectiveCamera;
  private readonly slots: MirrorSlot[] = [];
  private surfaceActive = false;
  private renderOnNextUpdate = false;

  // Preallocated per-frame state
  private readonly eye = new THREE.Vector3();
  private readonly chassisPos = new THREE.Vector3();
  private readonly chassisQuat = new THREE.Quaternion();
  private readonly chassisScale = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, carModelRoot: THREE.Object3D) {
    this.renderer = renderer;
    this.scene = scene;
    this.carModelRoot = carModelRoot;
    this.cam = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, RT_ASPECT, CAMERA_NEAR, CAMERA_FAR);

    const meshes: THREE.Mesh[] = [];
    carModelRoot.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      if ((MIRROR_MATERIALS as readonly string[]).includes(m.material.name)) meshes.push(m);
    });
    if (meshes.length === 0) {
      this.found = false;
      return;
    }

    const rt = new THREE.WebGLRenderTarget(RT_WIDTH, RT_HEIGHT, {
      type: THREE.HalfFloatType,
      samples: 0,
      depthBuffer: true,
    });
    this.rt = rt;

    for (const mesh of meshes) {
      const glassGeometry = mesh.geometry;
      const surfaceGeometry = buildMirrorGeometry(glassGeometry);
      if (!surfaceGeometry) continue;
      const surface = new THREE.MeshBasicMaterial({ map: rt.texture, color: 0xffffff });
      this.slots.push({
        mesh,
        glass: mesh.material as THREE.Material,
        glassGeometry,
        surfaceGeometry,
        surface,
      });
      // The glass material ignores UVs, so the surface geometry can stay on the mesh in both modes
      mesh.geometry = surfaceGeometry;
    }
    this.found = this.slots.length > 0;
    if (this.found) this.prewarm();
  }

  /**
   * Call once per frame before the main render, with the frame index, whether the cockpit view is active, and
   * the chassis group that carries the car's pitch/roll/heave. Renders at most every second frame, and only
   * when enabled; when disabled the mirrors go back to their dark glass material.
   */
  update(frameIndex: number, enabled: boolean, chassis: THREE.Object3D): void {
    if (!this.found || !this.rt) return;
    if (enabled !== this.surfaceActive) {
      this.surfaceActive = enabled;
      for (const s of this.slots) s.mesh.material = enabled ? s.surface : s.glass;
      // Render on the first enabled frame so the mirror is never shown empty
      this.renderOnNextUpdate = enabled;
    }
    if (!enabled) return;
    if (!this.renderOnNextUpdate && frameIndex % 2 !== 0) return;
    this.renderOnNextUpdate = false;
    this.renderRearView(chassis);
  }

  dispose(): void {
    for (const s of this.slots) {
      s.mesh.material = s.glass;
      s.mesh.geometry = s.glassGeometry;
      s.surfaceGeometry.dispose();
      s.surface.dispose();
    }
    this.slots.length = 0;
    this.rt?.dispose();
    this.surfaceActive = false;
  }

  private renderRearView(chassis: THREE.Object3D): void {
    const rt = this.rt;
    if (!rt) return;
    const r = this.renderer;

    // Pose from the live chassis (its pitch/roll/heave already applied this frame)
    chassis.updateWorldMatrix(true, false);
    this.carModelRoot.updateWorldMatrix(true, false);
    this.eye.copy(EYE_IN_MODEL).applyMatrix4(this.carModelRoot.matrixWorld);
    chassis.matrixWorld.decompose(this.chassisPos, this.chassisQuat, this.chassisScale);
    this.cam.position.copy(this.eye);
    this.cam.quaternion.copy(this.chassisQuat);
    this.cam.updateMatrixWorld(true);

    const prevTarget = r.getRenderTarget();
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    const carVisible = this.carModelRoot.visible;

    this.carModelRoot.visible = false;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(rt);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prevTarget);

    this.carModelRoot.visible = carVisible;
    r.shadowMap.autoUpdate = prevAutoUpdate;
  }

  /**
   * Compiles the rear-view shader variants (render target output) and the surface material's on-screen variant
   * up front. Runs once from the constructor; the car is hidden so only the rest of the scene is compiled for
   * the target pass.
   */
  private prewarm(): void {
    const r = this.renderer;
    const rt = this.rt;
    if (!rt) return;
    const prevTarget = r.getRenderTarget();
    const carVisible = this.carModelRoot.visible;
    try {
      this.carModelRoot.visible = false;
      r.setRenderTarget(rt);
      r.compile(this.scene, this.cam);
      r.setRenderTarget(prevTarget);

      const proxy = new THREE.Scene();
      for (const s of this.slots) proxy.add(new THREE.Mesh(s.surfaceGeometry, s.surface));
      r.compile(proxy, this.cam);
    } catch {
      // Compilation is an optimisation only; a failure here just moves the cost to the first cockpit frame
    } finally {
      this.carModelRoot.visible = carVisible;
      r.setRenderTarget(prevTarget);
    }
  }
}
