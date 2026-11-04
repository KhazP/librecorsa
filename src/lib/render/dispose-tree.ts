import * as THREE from "three";

/**
 * Frees the GPU side of everything under `root`: geometries, materials and their textures. Safe for objects that
 * share cached geometry or materials with a later copy, since three.js uploads them again on the next draw.
 */
export function disposeTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
    else if (mat) materials.add(mat);
    if (mesh.customDepthMaterial) materials.add(mesh.customDepthMaterial);
    if (mesh.customDistanceMaterial) materials.add(mesh.customDistanceMaterial);
  });
  const textures = new Set<THREE.Texture>();
  for (const m of materials) {
    for (const value of Object.values(m)) if ((value as THREE.Texture | null)?.isTexture) textures.add(value as THREE.Texture);
    m.dispose();
  }
  for (const g of geometries) g.dispose();
  for (const t of textures) t.dispose();
}
