import * as THREE from "three";

/**
 * Mirrors that reflect: each fragment of a mirror's glass shows what it reflects from the driver's eye, for the
 * mirrors a ported AC car's mirrors.ini names (the porter's MIRROR_n nodes). `WingMirrors` renders one rear view and
 * these surfaces look into it.
 *
 * - The glass is split into islands (one mesh holds both of F1 2007's mirrors), each a flat mirror with the
 *   area-weighted normal of its faces, turned toward the eye. An island seen edge-on (or from behind) has no reflection.
 * - Glass modelled upright is aimed as a driver sets a mirror: tilted so the ray from the eye through its centre leaves
 *   it `MIRROR_AIM_DEG` below level. F1 2007's glass is upright and above the eye, so as modelled it showed the sky 3-5
 *   degrees up and missed a car 12 m behind.
 * - Its yaw stays as modelled unless the glass looks nowhere near behind the car: one whose inner edge looks more than
 *   `MIRROR_INNER_EDGE_DEG.max` out (F1 2007's McLaren and Red Bull, 23-27: only the wall) or more than `.min` across
 *   the car (the Spyker's, 12) is turned until that edge is at the limit, as a driver would set it.
 * - A fragment at p reflects the ray from the eye: r = reflect(normalize(p - eye), n). What it shows is the scene
 *   point `MIRROR_FOCUS_M` along that ray, looked up in the rear view, which is rendered from one camera between the
 *   mirrors (`MirrorView.camera`) with the car's axes. Exact at that distance; nearer or farther things are off by the
 *   mirror's offset from that camera over their distance (cars 5-50 m behind: a few degrees).
 * - The rear view's frustum is fitted to every island's reflected window, at the planar mirrors' pixel count, so the
 *   one pass covers both mirrors and no more. The left/right flip follows from the reflection itself: nothing is
 *   flipped by hand, and the mesh's own UVs (F1 2007's are broken on some cars) are not used.
 */

/** Distance (m) at which a mirror's reflection is exact: a car close behind */
export const MIRROR_FOCUS_M = 12;
/** Pixels of the rear view: the planar mirrors' 256 x 128 */
export const MIRROR_PIXEL_BUDGET = 256 * 128;
/** An island whose glass is closer than this to edge-on (cos of the angle to the eye ray) shows no reflection */
const MIN_FACING = 0.1;
/** Where an upright glass's centre ray is aimed (deg, below level): the road behind in its lower part, the horizon high */
export const MIRROR_AIM_DEG = 1;
/** A glass whose normal is within this (sine) of level is taken as modelled upright, not aimed by its modeller */
const UPRIGHT = 0.02;
/** How far out (deg, + away from the car) a side mirror's inner edge may look before it is turned in, or across it */
export const MIRROR_INNER_EDGE_DEG = { min: -3, max: 10 } as const;
/** Glass this close to the centre line (m) is an interior mirror: its yaw is left alone */
const SIDE_MIRROR_X = 0.15;
/** Room round the fitted window, as a fraction of its size on each side */
const WINDOW_MARGIN = 0.03;

export interface MirrorIsland {
  /** Its triangles, as indices into the surface's triangle list */
  tris: number[];
  /** Unit normal of the glass toward the eye (model frame); null where it shows no reflection */
  normal: THREE.Vector3 | null;
  /** Area-weighted centre (model frame) */
  centre: THREE.Vector3;
  /** Area (m²) */
  area: number;
  /** Farthest vertex from the centre (m) */
  radius: number;
}

/** The rear view's camera (model frame, the car's axes: it looks down -Z) and its window in tangent space */
export interface MirrorView {
  camera: THREE.Vector3;
  /** x = model +X (the car's left) over the distance behind, y = up */
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** Render target size (px) */
  width: number;
  height: number;
}

/**
 * The flat islands of a triangle list (`model`: 9 floats per triangle, model frame), joined where triangles share a
 * vertex position (to 0.1 mm), each with its normal toward `eye`
 */
export function glassIslands(model: ArrayLike<number>, eye: THREE.Vector3): MirrorIsland[] {
  const triCount = Math.floor(model.length / 9);
  const parent = Array.from({ length: triCount }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const owner = new Map<string, number>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${Math.round(model[o] * 1e4)},${Math.round(model[o + 1] * 1e4)},${Math.round(model[o + 2] * 1e4)}`;
      const other = owner.get(key);
      if (other === undefined) owner.set(key, t);
      else parent[find(t)] = find(other);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(t);
  }
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const toEye = new THREE.Vector3();
  const islands: MirrorIsland[] = [];
  for (const tris of groups.values()) {
    const sum = new THREE.Vector3();
    const centre = new THREE.Vector3();
    let area = 0;
    for (const t of tris) {
      a.fromArray(model as number[], t * 9);
      b.fromArray(model as number[], t * 9 + 3);
      c.fromArray(model as number[], t * 9 + 6);
      n.subVectors(b, a).cross(mid.subVectors(c, a));
      const twice = n.length();
      if (!(twice > 0)) continue;
      mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      // Each face toward the eye on its own, so a glass modelled double-sided doesn't cancel out
      if (n.dot(toEye.subVectors(eye, mid)) < 0) n.negate();
      sum.add(n);
      centre.addScaledVector(mid, twice);
      area += twice / 2;
    }
    if (!(area > 0)) continue;
    centre.multiplyScalar(1 / (2 * area));
    let radius = 0;
    for (const t of tris) for (let k = 0; k < 3; k++) radius = Math.max(radius, a.fromArray(model as number[], t * 9 + k * 3).distanceTo(centre));
    const normal = sum.normalize();
    const facing = normal.dot(toEye.subVectors(eye, centre).normalize());
    if (facing >= MIN_FACING) aimGlass(normal, centre, eye, model, tris);
    islands.push({ tris, normal: facing >= MIN_FACING ? normal : null, centre, area, radius });
  }
  return islands;
}

/**
 * Sets a glass as a driver would (`normal` in place): an upright one tilted to `MIRROR_AIM_DEG` below level, a side
 * mirror looking nowhere near behind the car turned until its inner edge is inside `MIRROR_INNER_EDGE_DEG`. A turn
 * about the vertical turns the reflection by about twice as much, so a few rounds settle both
 */
function aimGlass(normal: THREE.Vector3, centre: THREE.Vector3, eye: THREE.Vector3, model: ArrayLike<number>, tris: readonly number[]): void {
  const upright = Math.abs(normal.y) < UPRIGHT;
  const side = Math.abs(centre.x) > SIDE_MIRROR_X ? Math.sign(centre.x) : 0;
  const up = new THREE.Vector3(0, 1, 0);
  for (let round = 0; round < 4; round++) {
    if (upright) aimUpright(normal, centre, eye);
    if (!side) break;
    const inner = innerEdgeDeg(normal, eye, model, tris, side);
    const target = THREE.MathUtils.clamp(inner, MIRROR_INNER_EDGE_DEG.min, MIRROR_INNER_EDGE_DEG.max);
    if (Math.abs(target - inner) < 0.01) break;
    normal.applyAxisAngle(up, THREE.MathUtils.degToRad(-(target - inner) * side) / 2).normalize();
  }
}

/** How far out from straight back (deg, + away from the car on `side`) the glass's innermost reflected ray looks */
function innerEdgeDeg(normal: THREE.Vector3, eye: THREE.Vector3, model: ArrayLike<number>, tris: readonly number[], side: number): number {
  const p = new THREE.Vector3();
  let inner = Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const d = p.fromArray(model as number[], t * 9 + k * 3).sub(eye).normalize();
      d.addScaledVector(normal, -2 * d.dot(normal));
      inner = Math.min(inner, THREE.MathUtils.radToDeg(Math.atan2(d.x * side, -d.z)));
    }
  }
  return inner;
}

/** Tilts an upright glass's `normal` (in place) so the ray from `eye` through `centre` leaves it `MIRROR_AIM_DEG` below
 * level, in the direction it reflects to now: the normal halfway between the incoming ray and that one */
function aimUpright(normal: THREE.Vector3, centre: THREE.Vector3, eye: THREE.Vector3): void {
  const d = new THREE.Vector3().subVectors(centre, eye).normalize();
  const r = d.clone().addScaledVector(normal, -2 * d.dot(normal));
  const level = Math.hypot(r.x, r.z);
  if (!(level > 1e-6)) return;
  const aim = THREE.MathUtils.degToRad(-MIRROR_AIM_DEG);
  const target = new THREE.Vector3((r.x / level) * Math.cos(aim), Math.sin(aim), (r.z / level) * Math.cos(aim));
  normal.subVectors(target, d).normalize();
}

/**
 * Where the glass at `p` (normal `n`, toward the eye) looks in the rear view: the tangent-space point of what it
 * reflects (x, y), or null for a reflection that doesn't go backwards. The shader's twin (`reflectingMirrorMaterial`)
 */
export function mirrorLookup(
  p: THREE.Vector3,
  n: THREE.Vector3,
  eye: THREE.Vector3,
  camera: THREE.Vector3,
  out = new THREE.Vector2()
): THREE.Vector2 | null {
  const d = new THREE.Vector3().subVectors(p, eye).normalize();
  const r = d.addScaledVector(n, -2 * d.dot(n));
  const q = r.multiplyScalar(MIRROR_FOCUS_M).add(p).sub(camera);
  if (!(q.z < -1e-3)) return null;
  return out.set(q.x / -q.z, q.y / -q.z);
}

/**
 * The rear view for `islands` (with their surfaces' vertices, model frame): the camera at their area-weighted centre,
 * the window round every live island's reflected corners, the target at `budget` pixels in the window's aspect
 */
export function fitMirrorView(
  surfaces: readonly { model: ArrayLike<number>; islands: readonly MirrorIsland[] }[],
  eye: THREE.Vector3,
  budget = MIRROR_PIXEL_BUDGET
): MirrorView | null {
  const camera = new THREE.Vector3();
  let area = 0;
  for (const s of surfaces) {
    for (const isl of s.islands) {
      if (!isl.normal) continue;
      camera.addScaledVector(isl.centre, isl.area);
      area += isl.area;
    }
  }
  if (!(area > 0)) return null;
  camera.multiplyScalar(1 / area);
  let left = Infinity;
  let right = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  const p = new THREE.Vector3();
  const t = new THREE.Vector2();
  for (const s of surfaces) {
    for (const isl of s.islands) {
      if (!isl.normal) continue;
      for (const tri of isl.tris) {
        for (let k = 0; k < 3; k++) {
          if (!mirrorLookup(p.fromArray(s.model as number[], tri * 9 + k * 3), isl.normal, eye, camera, t)) continue;
          left = Math.min(left, t.x);
          right = Math.max(right, t.x);
          bottom = Math.min(bottom, t.y);
          top = Math.max(top, t.y);
        }
      }
    }
  }
  if (!(right > left) || !(top > bottom)) return null;
  const mx = (right - left) * WINDOW_MARGIN;
  const my = (top - bottom) * WINDOW_MARGIN;
  left -= mx;
  right += mx;
  bottom -= my;
  top += my;
  const aspect = (right - left) / (top - bottom);
  const width = THREE.MathUtils.clamp(Math.round(Math.sqrt(budget * aspect) / 4) * 4, 32, 1024);
  const height = THREE.MathUtils.clamp(Math.round(budget / width / 4) * 4, 16, 512);
  return { camera, left, right, bottom, top, width, height };
}

/**
 * A reflecting copy of `mesh`'s geometry: unindexed, its own attributes kept (the glass material still draws it when
 * the mirrors are off), plus each vertex's model-frame position (`mirrorPos`) and its island's normal
 * (`mirrorNormal`, zero where there is no reflection). `toModel` takes the mesh's space to the model frame.
 */
export function reflectingGeometry(
  mesh: THREE.Mesh,
  toModel: THREE.Matrix4,
  eye: THREE.Vector3
): { geometry: THREE.BufferGeometry; model: Float32Array; islands: MirrorIsland[] } | null {
  const src = mesh.geometry;
  if (!src.getAttribute("position")) return null;
  const geometry = src.index ? src.toNonIndexed() : src.clone();
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const model = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(toModel).toArray(model, i * 3);
  const islands = glassIslands(model, eye);
  if (!islands.some((i) => i.normal)) {
    geometry.dispose();
    return null;
  }
  const normals = new Float32Array(pos.count * 3);
  for (const isl of islands) {
    if (!isl.normal) continue;
    for (const t of isl.tris) for (let k = 0; k < 3; k++) isl.normal.toArray(normals, (t * 3 + k) * 3);
  }
  geometry.setAttribute("mirrorPos", new THREE.BufferAttribute(model, 3));
  geometry.setAttribute("mirrorNormal", new THREE.BufferAttribute(normals, 3));
  if (!geometry.getAttribute("uv")) geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
  return { geometry, model, islands };
}

/**
 * The live glass: the rear view (`map`) looked up per fragment as `mirrorLookup` does; glass with no reflection
 * draws near black
 */
export function reflectingMirrorMaterial(
  map: THREE.Texture,
  view: MirrorView,
  eye: THREE.Vector3,
  side: THREE.Side
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ map, color: 0xffffff, side });
  material.name = "LIVE_MIRROR_REFLECTION";
  const uniforms = {
    mirrorEye: { value: eye.clone() },
    mirrorCamera: { value: view.camera.clone() },
    mirrorWindow: { value: new THREE.Vector4(view.left, view.bottom, view.right, view.top) },
    mirrorFocus: { value: MIRROR_FOCUS_M },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute vec3 mirrorPos;\nattribute vec3 mirrorNormal;\nvarying vec3 vMirrorPos;\nvarying vec3 vMirrorNormal;"
      )
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMirrorPos = mirrorPos;\nvMirrorNormal = mirrorNormal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 mirrorEye;\nuniform vec3 mirrorCamera;\nuniform vec4 mirrorWindow;\nuniform float mirrorFocus;\nvarying vec3 vMirrorPos;\nvarying vec3 vMirrorNormal;"
      )
      .replace(
        "#include <map_fragment>",
        [
          "#ifdef USE_MAP",
          "  float mirrorLive = step(0.25, dot(vMirrorNormal, vMirrorNormal));",
          "  vec3 mirrorN = normalize(vMirrorNormal + vec3(0.0, 0.0, 1e-6));",
          "  vec3 mirrorQ = vMirrorPos + reflect(normalize(vMirrorPos - mirrorEye), mirrorN) * mirrorFocus - mirrorCamera;",
          "  vec2 mirrorT = mirrorQ.xy / max(-mirrorQ.z, 1e-3);",
          "  vec2 mirrorUv = clamp((mirrorT - mirrorWindow.xy) / (mirrorWindow.zw - mirrorWindow.xy), 0.0, 1.0);",
          "  diffuseColor *= mix(vec4(vec3(0.03), 1.0), texture2D(map, mirrorUv), mirrorLive);",
          "#endif",
        ].join("\n")
      );
  };
  material.customProgramCacheKey = () => "live-mirror-reflection";
  return material;
}

/**
 * Aims `camera`'s frustum through `view`'s window (off-axis): a symmetric frustum round it with the window as its view
 * offset, so the renderer's own rebuilds of the projection (it makes it anew for the reversed depth buffer) keep it
 */
export function aimMirrorCamera(camera: THREE.PerspectiveCamera, view: MirrorView, near: number, far: number): void {
  const halfW = Math.max(Math.abs(view.left), Math.abs(view.right));
  const halfH = Math.max(Math.abs(view.bottom), Math.abs(view.top));
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfH));
  camera.aspect = halfW / halfH;
  camera.near = near;
  camera.far = far;
  camera.setViewOffset(2 * halfW, 2 * halfH, view.left + halfW, halfH - view.top, view.right - view.left, view.top - view.bottom);
  camera.updateProjectionMatrix();
}

/** A ported body's mirror glass: the meshes of the porter's MIRROR_n nodes (`userData.mirror`, from mirrors.ini) */
export function portedMirrorMeshes(body: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  body.traverse((o) => {
    if (!(o.userData as { mirror?: unknown }).mirror) return;
    o.traverse((m) => {
      if ((m as THREE.Mesh).isMesh && !out.includes(m as THREE.Mesh)) out.push(m as THREE.Mesh);
    });
  });
  return out;
}
