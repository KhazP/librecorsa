import type * as THREE from "three";

/**
 * A headset view's projection (OpenGL style: depth -1 at the near plane, +1 at the far plane) rewritten for the
 * reversed depth buffer: 1 at the near plane, 0 at the far plane, as Camera.updateProjectionMatrix builds them when the
 * renderer draws with reversed depth.
 *
 * three r187 converts its own cameras only. Each eye's projection comes from the headset as is, and the renderer then
 * flags the eye camera as reversed without touching that matrix, so every surface failed the depth test and the
 * headset showed a black view (Reddit, 25 Nov 2026). The near and far planes are read back from the matrix and the
 * depth row rewritten from them; the off-centre terms of each eye's frustum are in other rows and stay.
 */
export function toReversedDepth(m: THREE.Matrix4, maxFar = Infinity): THREE.Matrix4 {
  // Column-major: row r of column c is e[c * 4 + r]. A perspective view's depth row is (0, 0, C, D) and its w row
  // (0, 0, -1, 0), with C = -(f + n) / (f - n) and D = -2fn / (f - n)
  const e = m.elements;
  const c = e[10];
  const d = e[14];
  const near = d / (c - 1);
  // A headset may hand over an infinite far plane (c = -1): the frustum's far plane then comes out as a zero vector and
  // three culls every object against it. The far plane is kept at the scene's own
  const rawFar = Math.abs(c + 1) < 1e-9 ? Infinity : d / (c + 1);
  const far = Math.min(rawFar > near ? rawFar : Infinity, maxFar);
  if (Number.isFinite(near) && near > 0 && Number.isFinite(far)) {
    // The reversed projection's depth row, as three's own makePerspective writes it
    e[2] = e[6] = 0;
    e[10] = near / (far - near);
    e[14] = (far * near) / (far - near);
  } else {
    // Not a plain perspective view: the general form, z' = (w - z) / 2
    for (let col = 0; col < 4; col++) e[col * 4 + 2] = 0.5 * (e[col * 4 + 3] - e[col * 4 + 2]);
  }
  return m;
}

/** The renderer's own flag for a camera whose projection already is reversed (it would rebuild it from a fov otherwise) */
const markReversed = (camera: THREE.Camera) => {
  (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
};

/**
 * The headset camera's projections, after renderer.xr.updateCamera has copied this frame's views in, made reversed.
 * Each eye's projection is fresh from the headset every frame, so this runs once per frame, before the render.
 */
export function reverseXrDepth(xrCamera: THREE.ArrayCamera, maxFar = Infinity): void {
  for (const eye of xrCamera.cameras) {
    toReversedDepth(eye.projectionMatrix, maxFar);
    eye.projectionMatrixInverse.copy(eye.projectionMatrix).invert();
    markReversed(eye);
  }
  // The array camera culls with the first eye's projection (WebXRManager.updateCamera copies it)
  toReversedDepth(xrCamera.projectionMatrix, maxFar);
  xrCamera.projectionMatrixInverse.copy(xrCamera.projectionMatrix).invert();
  markReversed(xrCamera);
}
