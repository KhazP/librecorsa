import * as THREE from "three";
import {
  eyeForWindow,
  tripleViews,
  type ScreenRig,
  type ScreenView,
  type ViewWindow,
} from "@/lib/display/screen-layout";

/**
 * A camera whose frustum is any window (left / right / bottom / top tangents at unit distance) rather than a field of
 * view and an aspect: one screen of three, seen from an eye that is not on its axis. It builds its projection itself,
 * so three's own rebuild (for the reversed depth buffer, the first time it draws with the camera) keeps the window.
 * Its `fov` and `aspect` are kept to the symmetric frustum round the window, for code that reads them.
 */
export class OffAxisCamera extends THREE.PerspectiveCamera {
  private win: ViewWindow | undefined;

  setWindow(w: ViewWindow): void {
    this.win = { left: w.left, right: w.right, bottom: w.bottom, top: w.top };
    const halfX = Math.max(Math.abs(w.left), Math.abs(w.right));
    const halfY = Math.max(Math.abs(w.bottom), Math.abs(w.top), 1e-6);
    this.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfY));
    this.aspect = halfX / halfY;
    this.updateProjectionMatrix();
  }

  get window(): ViewWindow | undefined {
    return this.win;
  }

  override updateProjectionMatrix(): void {
    // The parent's constructor calls this before the window exists
    const w = this.win;
    if (!w) {
      super.updateProjectionMatrix();
      return;
    }
    const n = this.near;
    this.projectionMatrix.makePerspective(w.left * n, w.right * n, w.top * n, w.bottom * n, n, this.far, this.coordinateSystem, this.reversedDepth);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

/** The window a three.js perspective camera shows (its fov, aspect, zoom and view offset), as tangents */
export function windowOf(camera: THREE.PerspectiveCamera): ViewWindow {
  let top = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
  let height = 2 * top;
  let width = camera.aspect * height;
  let left = -width / 2;
  const view = camera.view;
  if (view !== null && view.enabled) {
    left += (view.offsetX * width) / view.fullWidth;
    top -= (view.offsetY * height) / view.fullHeight;
    width *= view.width / view.fullWidth;
    height *= view.height / view.fullHeight;
  }
  return { left, right: left + width, bottom: top - height, top };
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The three screens' cameras, following the game's camera every frame: the centre one sees what it sees (with the
 * eye's height on top), and the side ones what lies beyond, turned and framed for where those screens stand. The game
 * camera stays the one the rest of the game reasons with (sound, culling distances, the HUD's projections).
 */
export class TripleViewRig {
  readonly cameras: [OffAxisCamera, OffAxisCamera, OffAxisCamera] = [new OffAxisCamera(), new OffAxisCamera(), new OffAxisCamera()];
  /** This frame's views (left, centre, right) */
  views: [ScreenView, ScreenView, ScreenView] | null = null;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly yawQuat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor() {
    for (const cam of this.cameras) cam.matrixAutoUpdate = false;
  }

  /** Places the three cameras for `main` (its pose, lens and layers) on the screens of `rig` */
  update(main: THREE.PerspectiveCamera, rig: ScreenRig): void {
    main.updateMatrixWorld();
    main.matrixWorld.decompose(this.pos, this.quat, this.scale);
    const eye = eyeForWindow(rig, windowOf(main), rig.eyeHeight);
    const views = tripleViews(rig, eye);
    this.views = views;
    for (let i = 0; i < 3; i++) {
      const cam = this.cameras[i];
      const view = views[i];
      cam.layers.mask = main.layers.mask;
      cam.up.copy(main.up);
      cam.near = main.near;
      cam.far = main.far;
      cam.position.copy(this.pos);
      cam.quaternion.copy(this.quat).multiply(this.yawQuat.setFromAxisAngle(UP, view.yaw));
      cam.updateMatrix();
      cam.updateMatrixWorld(true);
      cam.setWindow(view);
    }
  }
}
