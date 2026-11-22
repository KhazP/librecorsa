import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Merges static meshes sharing the same material inside `root` into one draw call per material/attribute bucket.
 *
 * Designed for car bodies, steering wheels and opponent suspension arms where a GLB splits a rigid assembly into
 * dozens of same-material primitives. Safely handles meshopt interleaved / quantized attributes and mirrored
 * (negative-determinant) transforms by de-interleaving into plain float attributes and reversing triangle winding when
 * a baked transform flips handedness.
 */

export interface MergeStaticOptions {
  /** Return true to skip an object and its entire subtree (e.g. moving aero flaps, steering wheel, wheels, lights) */
  skip?: (obj: THREE.Object3D) => boolean;
  /** Prefix for created merged mesh names */
  namePrefix?: string;
  /** Dispose replaced source geometries (set true only when mutating a one-time template, never on a shared clone) */
  disposeSources?: boolean;
  /**
   * Optional per-template cache for merged BufferGeometries: repeated clones from the same template reuse one GPU
   * vertex/index buffer instead of re-baking and duplicating megabytes of static bodywork across every opponent.
   */
  geometryCache?: Map<string, THREE.BufferGeometry>;
  /** Optional sink collecting every uncached BufferGeometry newly allocated by this call, so the caller can dispose them */
  createdGeometries?: THREE.BufferGeometry[];
}

const _invRoot = new THREE.Matrix4();
const _rel = new THREE.Matrix4();
const _normalMat = new THREE.Matrix3();
const _v3 = new THREE.Vector3();

/** Copies any BufferAttribute / InterleavedBufferAttribute (including normalized ints & Float16) into a plain Float32 BufferAttribute */
function toFloatAttribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const { count, itemSize } = attr;
  const out = new Float32Array(count * itemSize);
  if (itemSize === 1) {
    for (let i = 0; i < count; i++) out[i] = attr.getX(i);
  } else if (itemSize === 2) {
    for (let i = 0; i < count; i++) {
      out[i * 2] = attr.getX(i);
      out[i * 2 + 1] = attr.getY(i);
    }
  } else if (itemSize === 3) {
    for (let i = 0; i < count; i++) {
      out[i * 3] = attr.getX(i);
      out[i * 3 + 1] = attr.getY(i);
      out[i * 3 + 2] = attr.getZ(i);
    }
  } else if (itemSize === 4) {
    for (let i = 0; i < count; i++) {
      out[i * 4] = attr.getX(i);
      out[i * 4 + 1] = attr.getY(i);
      out[i * 4 + 2] = attr.getZ(i);
      out[i * 4 + 3] = attr.getW(i);
    }
  }
  return new THREE.BufferAttribute(out, itemSize);
}

/** Reverses triangle winding in place so mirrored (negative-determinant) geometry keeps outward-facing front faces */
function flipTriangleWinding(geom: THREE.BufferGeometry): void {
  const idx = geom.index;
  if (idx) {
    for (let i = 0; i + 2 < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      const c = idx.getX(i + 2);
      idx.setX(i + 1, c);
      idx.setX(i + 2, b);
    }
    idx.needsUpdate = true;
    return;
  }
  const attrs = Object.values(geom.attributes);
  const count = geom.attributes.position?.count ?? 0;
  for (const attr of attrs) {
    const s = attr.itemSize;
    const arr = attr.array as Float32Array;
    for (let i = 0; i + 2 < count; i += 3) {
      const o1 = (i + 1) * s;
      const o2 = (i + 2) * s;
      for (let k = 0; k < s; k++) {
        const tmp = arr[o1 + k];
        arr[o1 + k] = arr[o2 + k];
        arr[o2 + k] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

/** Clones `src` into plain Float32 attributes and bakes `matrix` into position, normal and tangent */
function bakeGeometry(src: THREE.BufferGeometry, matrix: THREE.Matrix4, forceNonIndexed: boolean): THREE.BufferGeometry {
  const work = forceNonIndexed && src.index ? src.toNonIndexed() : src;
  const geom = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(work.attributes)) {
    geom.setAttribute(name, toFloatAttribute(attr as THREE.BufferAttribute | THREE.InterleavedBufferAttribute));
  }
  if (!forceNonIndexed && work.index) {
    const idx = work.index;
    const copy = idx.count > 65535 || idx.array instanceof Uint32Array ? new Uint32Array(idx.count) : new Uint16Array(idx.count);
    for (let i = 0; i < idx.count; i++) copy[i] = idx.getX(i);
    geom.setIndex(new THREE.BufferAttribute(copy, 1));
  }
  if (work !== src) work.dispose();

  const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (pos) pos.applyMatrix4(matrix);
  const norm = geom.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (norm) {
    _normalMat.getNormalMatrix(matrix);
    norm.applyNormalMatrix(_normalMat);
  }
  const tangent = geom.getAttribute("tangent") as THREE.BufferAttribute | undefined;
  if (tangent && tangent.itemSize === 4) {
    const detSign = matrix.determinant() < 0 ? -1 : 1;
    for (let i = 0; i < tangent.count; i++) {
      _v3.set(tangent.getX(i), tangent.getY(i), tangent.getZ(i)).transformDirection(matrix);
      tangent.setXYZW(i, _v3.x, _v3.y, _v3.z, tangent.getW(i) * detSign);
    }
  }
  if (matrix.determinant() < 0) flipTriangleWinding(geom);
  return geom;
}

function attributeSignature(geom: THREE.BufferGeometry): string | null {
  const keys = Object.keys(geom.attributes).sort();
  if (!keys.includes("position")) return null;
  const parts: string[] = [];
  for (const k of keys) {
    const a = geom.attributes[k];
    if (!a || a.itemSize < 1 || a.itemSize > 4) return null;
    parts.push(`${k}:${a.itemSize}`);
  }
  return parts.join("|");
}

function hasFullDrawRange(geom: THREE.BufferGeometry): boolean {
  const total = geom.index ? geom.index.count : (geom.attributes.position?.count ?? 0);
  return geom.drawRange.start === 0 && geom.drawRange.count >= total;
}

/**
 * Merges eligible static meshes under `root` by shared material and returns the number of draw calls saved.
 * Source meshes with unique materials or incompatible attributes are left untouched.
 */
export function mergeStaticMeshesByMaterial(root: THREE.Object3D, options: MergeStaticOptions = {}): number {
  const skip = options.skip;
  const prefix = options.namePrefix ?? "Merged";
  root.updateMatrixWorld(true);
  _invRoot.copy(root.matrixWorld).invert();

  const buckets = new Map<string, { material: THREE.Material; sig: string; meshes: THREE.Mesh[] }>();

  const visit = (obj: THREE.Object3D) => {
    if (obj !== root && (skip?.(obj) || !obj.visible)) return;
    if ((obj as THREE.LOD).isLOD) return;
    const mesh = obj as THREE.Mesh;
    if (
      mesh.isMesh &&
      !(mesh as THREE.SkinnedMesh).isSkinnedMesh &&
      !(mesh as THREE.InstancedMesh).isInstancedMesh &&
      !Array.isArray(mesh.material) &&
      mesh.material &&
      !(mesh.material as THREE.Material).transparent &&
      mesh.geometry &&
      mesh.visible &&
      Object.keys(mesh.geometry.morphAttributes).length === 0 &&
      mesh.geometry.groups.length === 0 &&
      hasFullDrawRange(mesh.geometry)
    ) {
      const sig = attributeSignature(mesh.geometry);
      if (sig) {
        const key = `${mesh.material.uuid}|${mesh.layers.mask}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${mesh.renderOrder}|${sig}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { material: mesh.material, sig, meshes: [] };
          buckets.set(key, bucket);
        }
        bucket.meshes.push(mesh);
      }
    }
    for (const child of [...obj.children]) visit(child);
  };
  visit(root);

  let saved = 0;
  let mergedIdx = 0;
  for (const { material, sig, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;
    const cacheKey = options.geometryCache
      ? `${prefix}|${material.name}|${sig}|${meshes.map((m) => m.geometry.uuid).join(",")}`
      : null;
    let combined = cacheKey ? options.geometryCache!.get(cacheKey) ?? null : null;
    if (!combined) {
      const allIndexed = meshes.every((m) => m.geometry.index !== null);
      const forceNonIndexed = !allIndexed;
      const baked: THREE.BufferGeometry[] = [];
      for (const m of meshes) {
        _rel.multiplyMatrices(_invRoot, m.matrixWorld);
        baked.push(bakeGeometry(m.geometry, _rel, forceNonIndexed));
      }
      combined = mergeGeometries(baked, false);
      for (const g of baked) g.dispose();
      if (!combined) continue;
      combined.computeBoundingBox();
      combined.computeBoundingSphere();
      if (cacheKey) options.geometryCache!.set(cacheKey, combined);
      else options.createdGeometries?.push(combined);
    }

    const ref = meshes[0];
    const mergedMesh = new THREE.Mesh(combined, material);
    mergedMesh.name = `${prefix}_${material.name || mergedIdx++}`;
    mergedMesh.castShadow = ref.castShadow;
    mergedMesh.receiveShadow = ref.receiveShadow;
    mergedMesh.renderOrder = ref.renderOrder;
    mergedMesh.layers.mask = ref.layers.mask;
    mergedMesh.frustumCulled = ref.frustumCulled;
    root.add(mergedMesh);

    for (const m of meshes) {
      // Preserve any non-mesh children attached beneath a merged mesh by lifting them into root
      for (const child of [...m.children]) {
        root.attach(child);
      }
      m.removeFromParent();
      if (options.disposeSources) m.geometry.dispose();
    }
    saved += meshes.length - 1;
  }

  return saved;
}
