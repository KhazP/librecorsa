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

export interface WingMirrorOptions {
  /** Material names of the mirror faces (default: the VF26's `mirror_1` / `mirror_2`) */
  materials?: readonly string[];
  /** Driver eye point in the model root's frame (default: the VF26's) */
  eyeInModel?: THREE.Vector3;
  /** Whether the mirrors show the car's flanks; false for an interior mirror only, so the HUD mirror stays */
  coversSides?: boolean;
  /** The mirror mesh's local axis pointing up its face: Y (default) or Z */
  upAxis?: "y" | "z";
  /**
   * Mirror glass modelled as part of a bigger mesh (the GT3 body's wing mirrors share the trim material): the
   * triangles of `material` inside `box` (in `frame`'s space) facing within 40 degrees of `facing` get a live
   * overlay, one per patch
   */
  glassPatches?: readonly GlassPatch[];
}

export interface GlassPatch {
  material: string;
  frame: THREE.Object3D;
  box: THREE.Box3;
  facing: THREE.Vector3;
}

/**
 * The patch's triangles in the frame's space, lifted 2 mm off the glass toward the viewer, with a planar UV set
 * (u along the frame's X like the planar mirrors above, v up its Y), cropped to the render target's aspect
 */
function buildPatchGeometry(patch: GlassPatch): THREE.BufferGeometry | null {
  const frameInv = new THREE.Matrix4();
  patch.frame.updateWorldMatrix(true, true);
  frameInv.copy(patch.frame.matrixWorld).invert();
  const facing = patch.facing.clone().normalize();
  const out: number[] = [];
  const m = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  patch.frame.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material.name !== patch.material) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    m.multiplyMatrices(frameInv, mesh.matrixWorld);
    const index = mesh.geometry.index;
    const tris = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      if (!patch.box.containsPoint(a) || !patch.box.containsPoint(b) || !patch.box.containsPoint(c)) continue;
      const n = ab.subVectors(b, a).cross(ac.subVectors(c, a));
      const len = n.length();
      if (!(len > 0) || n.dot(facing) / len < 0.77) continue;
      for (const v of [a, b, c]) out.push(v.x + facing.x * 0.002, v.y + facing.y * 0.002, v.z + facing.z * 0.002);
    }
  });
  if (out.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(out);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const w = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  if (!(w > 0) || !(h > 0)) return null;
  const aspect = w / h;
  const fx = aspect > RT_ASPECT ? 1 : aspect / RT_ASPECT;
  const fy = aspect > RT_ASPECT ? RT_ASPECT / aspect : 1;
  const uv = new Float32Array((positions.length / 3) * 2);
  for (let v = 0; v < positions.length / 3; v++) {
    uv[v * 2] = 0.5 + ((positions[v * 3] - bb.min.x) / w - 0.5) * fx;
    uv[v * 2 + 1] = 0.5 + ((positions[v * 3 + 1] - bb.min.y) / h - 0.5) * fy;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

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
function buildMirrorGeometry(src: THREE.BufferGeometry, upZ: boolean): THREE.BufferGeometry | null {
  const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
  const index = src.index;
  if (!pos || !index) return null;
  const count = pos.count;
  const used = new Uint8Array(count);
  for (let i = 0; i < index.count; i++) used[index.getX(i)] = 1;

  // Image across the mesh's X, up along its Y, or its Z for a node turned 90 degrees about X (the GT3's mirror)
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let v = 0; v < count; v++) {
    if (!used[v]) continue;
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  if (upZ) {
    yMin = zMin;
    yMax = zMax;
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
    const t = ((upZ ? pos.getZ(v) : pos.getY(v)) - yMin) / h;
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
  /** Mirrors on the car's sides (wing mirrors), not just a rear-view mirror */
  readonly coversSides: boolean = false;
  private readonly eyeInModel: THREE.Vector3;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly carModelRoot: THREE.Object3D;
  private readonly rt: THREE.WebGLRenderTarget | null = null;
  private readonly cam: THREE.PerspectiveCamera;
  private readonly slots: MirrorSlot[] = [];
  /** Live glass laid over mirror patches of bigger meshes; shown only while the mirrors are live */
  private readonly overlays: THREE.Mesh[] = [];
  private surfaceActive = false;
  private renderOnNextUpdate = false;

  // Preallocated per-frame state
  private readonly eye = new THREE.Vector3();
  private readonly chassisPos = new THREE.Vector3();
  private readonly chassisQuat = new THREE.Quaternion();
  private readonly chassisScale = new THREE.Vector3();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    carModelRoot: THREE.Object3D,
    options: WingMirrorOptions = {}
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.carModelRoot = carModelRoot;
    this.eyeInModel = (options.eyeInModel ?? EYE_IN_MODEL).clone();
    this.coversSides = options.coversSides ?? true;
    const materials = options.materials ?? MIRROR_MATERIALS;
    this.cam = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, RT_ASPECT, CAMERA_NEAR, CAMERA_FAR);

    const meshes: THREE.Mesh[] = [];
    carModelRoot.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      if (materials.includes(m.material.name)) meshes.push(m);
    });
    if (meshes.length === 0 && !options.glassPatches?.length) {
      this.found = false;
      this.coversSides = false;
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
      const surfaceGeometry = buildMirrorGeometry(glassGeometry, options.upAxis === "z");
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
    for (const patch of options.glassPatches ?? []) {
      const geometry = buildPatchGeometry(patch);
      if (!geometry) continue;
      const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: rt.texture, color: 0xffffff }));
      overlay.name = "LIVE_MIRROR_GLASS";
      overlay.visible = false;
      patch.frame.add(overlay);
      this.overlays.push(overlay);
    }
    if (this.overlays.length) this.coversSides = true;
    this.found = this.slots.length > 0 || this.overlays.length > 0;
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
      for (const o of this.overlays) o.visible = enabled;
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
    for (const o of this.overlays) {
      o.removeFromParent();
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.overlays.length = 0;
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
    this.eye.copy(this.eyeInModel).applyMatrix4(this.carModelRoot.matrixWorld);
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
    // The post-processing chain turns the renderer's autoClear off: without this the depth stays 0 and nothing draws
    r.clear();
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
      for (const o of this.overlays) proxy.add(new THREE.Mesh(o.geometry, o.material));
      r.compile(proxy, this.cam);
    } catch {
      // Compilation is an optimisation only; a failure here just moves the cost to the first cockpit frame
    } finally {
      this.carModelRoot.visible = carVisible;
      r.setRenderTarget(prevTarget);
    }
  }
}
