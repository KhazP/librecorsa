import * as THREE from "three";

/**
 * Virtual rear-view mirror: a top-centre strip on screen showing the road behind, for the views where the car's own
 * wing mirrors are not in shot (TV pod, bumper / nose, shoulder, and the cockpit of cars without working mirrors).
 *
 * A rear-facing camera on the chassis (roof height, the car's own model hidden) renders into a 640x160 half-float
 * target every second frame. After the main post-processed frame, one screen quad draws that image into a rounded
 * rectangle through renderer.toneMapping (AgX) and the sRGB output transform, so it matches the main image. The quad
 * mirrors the image horizontally: a camera looking backwards has screen-right = the car's left, a mirror shows the
 * car's left on the left.
 */

const RT_W = 640;
const RT_H = 160;
const ASPECT = RT_W / RT_H;
/** Horizontal field of view of the mirror (deg) */
const H_FOV_DEG = 64;
const V_FOV_DEG = (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(H_FOV_DEG / 2)) / ASPECT) * 180) / Math.PI;
/** Camera in the chassis frame: over the roll hoop, a little behind the driver */
const EYE = new THREE.Vector3(0, 1.08, -0.35);
/** Tilted slightly down so the road fills the lower half */
const PITCH_RAD = -0.035;

/** Where the mirror sits on screen (CSS px from the top-left), shared with the HUD so it can make room */
export function virtualMirrorRect(viewW: number, _viewH: number): { x: number; y: number; w: number; h: number } {
  const w = Math.round(Math.min(460, Math.max(260, viewW * 0.26)));
  const h = Math.round(w / ASPECT);
  return { x: Math.round((viewW - w) / 2), y: 12, w, h };
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec2 sizePx;
uniform float radiusPx;
varying vec2 vUv;

float roundedBox(vec2 p, vec2 halfSize, float r) {
  vec2 q = abs(p) - halfSize + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = (vUv - 0.5) * sizePx;
  float d = roundedBox(p, sizePx * 0.5, radiusPx);
  if (d > 0.5) discard;
  // Mirror image: flip horizontally
  vec3 scene = texture2D(map, vec2(1.0 - vUv.x, vUv.y)).rgb;
  // A thin dark bezel with a light inner edge, faded at the very rim for anti-aliasing
  float rim = smoothstep(-3.0, -1.5, d);
  float edge = smoothstep(-4.5, -3.0, d) * (1.0 - rim);
  vec3 col = mix(scene, vec3(0.006), rim);
  col = mix(col, vec3(0.6), edge * 0.25);
  gl_FragColor = vec4(col, 1.0 - smoothstep(-0.5, 0.5, d));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class VirtualMirror {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly cam: THREE.PerspectiveCamera;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private active = false;
  private renderNext = false;

  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PITCH_RAD);
  private readonly prevViewport = new THREE.Vector4();
  private readonly prevScissor = new THREE.Vector4();
  private readonly size = new THREE.Vector2();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.rt = new THREE.WebGLRenderTarget(RT_W, RT_H, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true });
    this.cam = new THREE.PerspectiveCamera(V_FOV_DEG, ASPECT, 0.3, 600);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.rt.texture },
        sizePx: { value: new THREE.Vector2(1, 1) },
        radiusPx: { value: 14 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  get shown(): boolean {
    return this.active;
  }

  /**
   * Before the main render: refresh the rear view (every second frame) when the mirror is on. `hide` is the player's
   * car, kept out of its own mirror.
   */
  update(frameIndex: number, enabled: boolean, chassis: THREE.Object3D, hide: THREE.Object3D): void {
    if (enabled !== this.active) {
      this.active = enabled;
      this.renderNext = enabled;
    }
    if (!enabled) return;
    if (!this.renderNext && frameIndex % 2 !== 0) return;
    this.renderNext = false;

    chassis.updateWorldMatrix(true, false);
    chassis.matrixWorld.decompose(this.pos, this.quat, this.scale);
    // The chassis' +Z is the nose, so a camera with its orientation looks backwards (cameras look down -Z)
    this.cam.position.copy(EYE).applyMatrix4(chassis.matrixWorld);
    this.cam.quaternion.copy(this.quat).multiply(this.pitch);
    this.cam.updateMatrixWorld(true);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoUpdate = r.shadowMap.autoUpdate;
    const visible = hide.visible;
    hide.visible = false;
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(this.scene, this.cam);
    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevAutoUpdate;
    hide.visible = visible;
  }

  /** After the main render: draw the mirror over the frame (default framebuffer) */
  draw(): void {
    if (!this.active) return;
    const r = this.renderer;
    r.getSize(this.size);
    const rect = virtualMirrorRect(this.size.x, this.size.y);
    (this.material.uniforms.sizePx.value as THREE.Vector2).set(rect.w, rect.h);
    r.getViewport(this.prevViewport);
    r.getScissor(this.prevScissor);
    const prevScissorTest = r.getScissorTest();
    const prevAutoClear = r.autoClear;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(null);
    r.autoClear = false;
    // three's viewport origin is the bottom-left corner
    const y = this.size.y - rect.y - rect.h;
    r.setViewport(rect.x, y, rect.w, rect.h);
    r.setScissor(rect.x, y, rect.w, rect.h);
    r.setScissorTest(true);
    r.render(this.quadScene, this.quadCam);
    r.setScissorTest(prevScissorTest);
    r.setScissor(this.prevScissor);
    r.setViewport(this.prevViewport);
    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.rt.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
    this.active = false;
  }
}
