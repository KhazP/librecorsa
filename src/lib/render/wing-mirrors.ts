import * as THREE from "three";
import { planarUvGeometry } from "./planar-uv";
import { aimMirrorCamera, fitMirrorView, reflectingGeometry, reflectingMirrorMaterial, type MirrorIsland } from "./mirror-reflection";

/**
 * Wing mirrors for the LC26 GLB (`mirror_1` = left, +X; `mirror_2` = right, -X).
 *
 * One rear-facing camera at the driver's eye point renders the scene behind the car into a 256x128 half-float
 * target while the cockpit view is active (every second frame, or every frame at a low frame rate: `MirrorClock`). Both mirror meshes show that image through a
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
 *
 * A ported AC car's mirrors (`reflecting`, its mirrors.ini meshes) work differently: each fragment of their glass shows
 * what it reflects from the driver's eye (`mirror-reflection.ts`), out of one rear view whose frustum and target size
 * are fitted to the mirrors (the same pixel count). Those can be on the car's outside (`outside`): the chase and T-cam
 * views see them too, so `inView` says when any of their glass faces the camera on screen.
 */

const MIRROR_MATERIALS = ["mirror_1", "mirror_2"] as const;
const RT_WIDTH = 256;
const RT_HEIGHT = 128;
const RT_ASPECT = RT_WIDTH / RT_HEIGHT;
/** Driver eye point in the GLB frame (the rig's cockpit camera anchor, before the body group's offset) */
const EYE_IN_MODEL = new THREE.Vector3(0, 0.74, 0);
const CAMERA_FOV_DEG = 35;
const CAMERA_NEAR = 0.3;
const CAMERA_FAR = 250;

export interface WingMirrorOptions {
  /** Material names of the mirror faces (default: the LC26's `mirror_1` / `mirror_2`) */
  materials?: readonly string[];
  /** Driver eye point in the model root's frame (default: the LC26's) */
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
  /**
   * A ported AC car's mirror meshes (the porter's MIRROR_n): each fragment shows what its glass reflects from
   * `eyeInModel`, through a rear view fitted to them. Used on its own, without `materials` or `glassPatches`
   */
  reflecting?: readonly THREE.Mesh[];
  /** What the rear view leaves out: the car's model (default `carModelRoot`), or its whole rig with the wheels */
  hide?: THREE.Object3D;
  /** The mirrors are on the car's outside (sidepods, doors), in shot from the chase and T-cam views too */
  outside?: boolean;
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
 * The mirror glass with its own planar UVs: the image across the mesh's X, up along its Y, or its Z for a node
 * turned 90 degrees about X (the GT3's mirror), cropped to the patch's aspect instead of stretched
 */
function buildMirrorGeometry(src: THREE.BufferGeometry, upZ: boolean): THREE.BufferGeometry | null {
  return planarUvGeometry(src, {
    vAxis: upZ ? "z" : "y",
    requireIndex: true,
    map: (u, t, w, h) => {
      const aspect = w / h;
      const fx = aspect > RT_ASPECT ? 1 : aspect / RT_ASPECT;
      const fy = aspect > RT_ASPECT ? RT_ASPECT / aspect : 1;
      return [0.5 + (u - 0.5) * fx, 0.5 + (t - 0.5) * fy];
    },
  });
}

/** Smallest reflecting glass on screen (px across) that gets the rear-view pass */
const MIN_GLASS_PX = 8;

export class WingMirrors {
  readonly found: boolean;
  /** Mirrors on the car's sides (wing mirrors), not just a rear-view mirror */
  readonly coversSides: boolean = false;
  /** On the car's outside: in shot from outside views (`CameraModeSpec.outsideMirrorsInShot`), when `inView` */
  readonly outside: boolean;
  private readonly eyeInModel: THREE.Vector3;
  /** Where the rear view is rendered from (model frame): the eye, or between the reflecting mirrors */
  private readonly camInModel: THREE.Vector3;
  private readonly hideRoot: THREE.Object3D;
  /** The reflecting glass's islands (model frame), for `inView` */
  private readonly islands: MirrorIsland[] = [];

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
  /** After dispose(): the render target and surfaces are gone, so update() does nothing */
  private disposed = false;

  // Preallocated per-frame state
  private readonly eye = new THREE.Vector3();
  private readonly chassisPos = new THREE.Vector3();
  private readonly chassisQuat = new THREE.Quaternion();
  private readonly chassisScale = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly islandCentre = new THREE.Vector3();
  private readonly islandNormal = new THREE.Vector3();
  private readonly camWorld = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();

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
    this.camInModel = this.eyeInModel;
    this.hideRoot = options.hide ?? carModelRoot;
    this.outside = options.outside ?? false;
    this.coversSides = options.coversSides ?? true;
    const materials = options.materials ?? MIRROR_MATERIALS;
    this.cam = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, RT_ASPECT, CAMERA_NEAR, CAMERA_FAR);

    // Reflecting glass: its surfaces and the rear view fitted to them
    const reflecting: { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; model: Float32Array; islands: MirrorIsland[] }[] = [];
    carModelRoot.updateWorldMatrix(true, true);
    const toModel = carModelRoot.matrixWorld.clone().invert();
    for (const mesh of options.reflecting ?? []) {
      if (Array.isArray(mesh.material)) continue;
      const built = reflectingGeometry(mesh, toModel.clone().multiply(mesh.matrixWorld), this.eyeInModel);
      if (built) reflecting.push({ mesh, ...built });
    }
    const view = reflecting.length ? fitMirrorView(reflecting, this.eyeInModel) : null;
    if (!view) for (const r of reflecting) r.geometry.dispose();
    if (view) {
      this.camInModel = view.camera.clone();
      aimMirrorCamera(this.cam, view, CAMERA_NEAR, CAMERA_FAR);
      for (const r of reflecting) this.islands.push(...r.islands.filter((i) => i.normal));
      // Wing mirrors when any glass is off the centre line, else a cockpit's interior mirror alone
      this.coversSides = options.coversSides ?? this.islands.some((i) => Math.abs(i.centre.x) > 0.25);
    }

    const meshes: THREE.Mesh[] = [];
    carModelRoot.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      if (materials.includes(m.material.name)) meshes.push(m);
    });
    if (meshes.length === 0 && !options.glassPatches?.length && !view) {
      this.found = false;
      this.coversSides = false;
      return;
    }

    const rt = new THREE.WebGLRenderTarget(view?.width ?? RT_WIDTH, view?.height ?? RT_HEIGHT, {
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
    if (view) {
      for (const r of reflecting) {
        const glass = r.mesh.material as THREE.Material;
        this.slots.push({
          mesh: r.mesh,
          glass,
          glassGeometry: r.mesh.geometry,
          surfaceGeometry: r.geometry,
          surface: reflectingMirrorMaterial(rt.texture, view, this.eyeInModel, glass.side),
        });
        // Its own attributes kept: the glass material draws the same triangles when the mirrors are off
        r.mesh.geometry = r.geometry;
      }
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
   * Call once per drawn frame before the main render, with whether the mirrors render this frame (`MirrorClock`),
   * whether the cockpit view is active, and the chassis group that carries the car's pitch/roll/heave. Renders only
   * when enabled; when disabled the mirrors go back to their dark glass material.
   */
  update(refresh: boolean, enabled: boolean, chassis: THREE.Object3D): void {
    if (this.disposed || !this.found || !this.rt) return;
    if (enabled !== this.surfaceActive) {
      this.surfaceActive = enabled;
      for (const s of this.slots) s.mesh.material = enabled ? s.surface : s.glass;
      for (const o of this.overlays) o.visible = enabled;
      // Render on the first enabled frame so the mirror is never shown empty
      this.renderOnNextUpdate = enabled;
    }
    if (!enabled) return;
    if (!this.renderOnNextUpdate && !refresh) return;
    this.renderOnNextUpdate = false;
    this.renderRearView(chassis);
  }

  /**
   * Whether any reflecting glass is on screen from `camera` (`heightPx` tall): facing it, inside its frustum and at least
   * `MIN_GLASS_PX` across (a chase view's glass on a phone, about 5 px, isn't worth a rear-view pass); `framed`: with
   * its centre inside the frame, not just an edge of it in shot. True for mirrors that aren't reflecting ones (the
   * caller's view flags decide those)
   */
  inView(camera: THREE.Camera, heightPx: number, framed = false): boolean {
    if (!this.found) return false;
    if (this.islands.length === 0) return true;
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    this.camWorld.setFromMatrixPosition(camera.matrixWorld);
    this.carModelRoot.updateWorldMatrix(true, false);
    const m = this.carModelRoot.matrixWorld;
    // Pixels per metre at 1 m (a perspective projection's y scale is 1 / tan(fov / 2))
    const pxPerM = (camera.projectionMatrix.elements[5] * heightPx) / 2;
    for (const isl of this.islands) {
      this.islandCentre.copy(isl.centre).applyMatrix4(m);
      this.islandNormal.copy(isl.normal!).transformDirection(m);
      const toCam = this.camWorld.sub(this.islandCentre);
      const dist = toCam.length();
      const facing = this.islandNormal.dot(toCam) > 0;
      this.camWorld.setFromMatrixPosition(camera.matrixWorld);
      if (!facing || !(dist > 0)) continue;
      if (!this.frustum.intersectsSphere(this.sphere.set(this.islandCentre, isl.radius))) continue;
      if (framed) {
        const c = this.islandCentre.applyMatrix4(camera.matrixWorldInverse);
        if (c.z >= 0) continue;
        c.applyMatrix4(camera.projectionMatrix);
        if (Math.abs(c.x) > 1 || Math.abs(c.y) > 1) continue;
      }
      if (2 * (isl.radius / dist) * pxPerM >= MIN_GLASS_PX) return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
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
    this.eye.copy(this.camInModel).applyMatrix4(this.carModelRoot.matrixWorld);
    chassis.matrixWorld.decompose(this.chassisPos, this.chassisQuat, this.chassisScale);
    this.cam.position.copy(this.eye);
    this.cam.quaternion.copy(this.chassisQuat);
    this.cam.updateMatrixWorld(true);

    const prevTarget = r.getRenderTarget();
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    const prevXr = r.xr.enabled;
    const carVisible = this.hideRoot.visible;

    this.hideRoot.visible = false;
    r.shadowMap.autoUpdate = false;
    // In a headset every render() draws with the headset's eyes unless XR is off
    r.xr.enabled = false;
    // Restored even if the render throws, or the player's car would stay hidden
    try {
      r.setRenderTarget(rt);
      // The post-processing chain turns the renderer's autoClear off: without this the depth stays 0 and nothing draws
      r.clear();
      r.render(this.scene, this.cam);
    } finally {
      r.setRenderTarget(prevTarget);
      r.xr.enabled = prevXr;
      this.hideRoot.visible = carVisible;
      r.shadowMap.autoUpdate = prevAutoUpdate;
    }
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
    const carVisible = this.hideRoot.visible;
    try {
      this.hideRoot.visible = false;
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
      this.hideRoot.visible = carVisible;
      r.setRenderTarget(prevTarget);
    }
  }
}
