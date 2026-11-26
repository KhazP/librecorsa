import * as THREE from "three";
import type { PadLike } from "@/lib/input/device-input";
import { reverseXrDepth } from "./reversed-depth";
import { VrHud, type VrHudModel } from "./vr-hud";
import { HeadsetButtons, type VrPauseInput, XrPadMapper } from "./xr-pad";

/**
 * The headset: its session, the seat it puts the player in, the HUD panel, the hand controllers as a pad, and the frame.
 *
 * - Seat: a rig at the driver's eye point of the car (the cockpit camera, without the shake or the model's pitch), with
 *   the headset's own pose on top. The reference space is "local", the seated one; the head is put on the eye point
 *   and facing the car's nose when the session starts, when the headset recentres itself, and when the player asks.
 *   Only the heading is taken from the head: the horizon stays level whatever the head's tilt was (osgXR's recentre).
 * - Frame: drawn straight into the headset's eye buffers. The post-processing composer cannot draw per eye (pmndrs
 *   postprocessing has no XR support), so the headset gets the scene with three's own AgX tone mapping.
 * - Rate and load on standalone headsets: 72 Hz where offered (Quest 2 starts at 90), medium foveation (three's
 *   default is the strongest), and the player's render resolution as the eye buffers' scale.
 */

export type VrUnavailable = "unsupported" | "refused";

export interface VrPresenterOptions {
  /** A standalone headset's browser (headset.ts): the lighter rate and foveation */
  standalone: boolean;
  /** Layers the view camera draws besides the default one (the cockpit detail, the driving aids) */
  viewLayers: readonly number[];
  /** The layer of the HUD panel: only this camera draws it */
  hudLayer: number;
  onPresenting(on: boolean): void;
  /** The headset was taken off, its system menu opened or the session ended: the drive should wait */
  onInterrupted(): void;
}

/** How long the HUD says how to pause after the headset goes on (ms) */
const PAUSE_HINT_MS = 10_000;
/** The headset's own refresh on a standalone headset, when it offers it */
const STANDALONE_RATE_HZ = 72;
/** Foveation 0..1 on a standalone headset: Meta notes the strongest is visible, three defaults to it */
const STANDALONE_FOVEATION = 0.5;

export class VrPresenter {
  readonly rig = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 5500);
  private readonly hud: VrHud;
  private readonly padMapper = new XrPadMapper();
  private session: XRSession | null = null;
  private baseSpace: XRReferenceSpace | null = null;
  private recenterPending = false;
  private requesting = false;
  private pad: PadLike | null = null;
  private readonly buttons = new HeadsetButtons();
  /** When the session started (performance.now()): the HUD says how to pause for a while after */
  private startedAtMs = -Infinity;
  private readonly onReset = () => {
    this.recenterPending = true;
  };
  private readonly onVisibility = () => {
    if (this.session && this.session.visibilityState !== "visible") this.options.onInterrupted();
  };
  private readonly onEnd = () => {
    this.session?.removeEventListener("visibilitychange", this.onVisibility);
    this.baseSpace?.removeEventListener("reset", this.onReset);
    this.session = null;
    this.baseSpace = null;
    this.pad = null;
    this.hud.visible = false;
    // After three's own handler of the same event, which gives the page its renderer state back
    setTimeout(() => {
      this.options.onPresenting(false);
      this.options.onInterrupted();
    }, 0);
  };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly options: VrPresenterOptions
  ) {
    for (const layer of options.viewLayers) this.camera.layers.enable(layer);
    this.camera.layers.enable(options.hudLayer);
    this.rig.add(this.camera);
    this.hud = new VrHud(options.hudLayer);
    this.hud.visible = false;
    this.rig.add(this.hud.root);
    // The frame loop places the rig first, then updates the headset camera from it and reverses its depth
    renderer.xr.cameraAutoUpdate = false;
  }

  get presenting(): boolean {
    return this.session !== null && this.renderer.xr.isPresenting;
  }

  get busy(): boolean {
    return this.requesting || this.session !== null;
  }

  /** Asks the headset for a session (from a click: browsers refuse one without the player's gesture) */
  async enter(renderScale: number): Promise<VrUnavailable | null> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) return "unsupported";
    if (this.busy) return null;
    this.requesting = true;
    let session: XRSession | null = null;
    try {
      session = await xr.requestSession("immersive-vr");
      const s = session;
      this.renderer.xr.setReferenceSpaceType("local");
      this.renderer.xr.setFramebufferScaleFactor(THREE.MathUtils.clamp(renderScale, 0.5, 1));
      s.addEventListener("end", this.onEnd, { once: true });
      await this.renderer.xr.setSession(s);
      // Ended while it was being set up
      if (!this.renderer.xr.isPresenting) return "refused";
      this.session = s;
      this.baseSpace = this.renderer.xr.getReferenceSpace();
      this.baseSpace?.addEventListener("reset", this.onReset);
      s.addEventListener("visibilitychange", this.onVisibility);
      this.recenterPending = true;
      this.startedAtMs = performance.now();
      this.buttons.reset();
      if (this.options.standalone) {
        this.renderer.xr.setFoveation(STANDALONE_FOVEATION);
        const rates = s.supportedFrameRates;
        if (rates && Array.from(rates).includes(STANDALONE_RATE_HZ)) {
          void s.updateTargetFrameRate?.(STANDALONE_RATE_HZ).catch(() => {});
        }
      }
      this.hud.visible = true;
      this.options.onPresenting(true);
      return null;
    } catch (reason) {
      console.warn("[vr] the headset session did not start", reason);
      if (session && !this.session) void session.end().catch(() => {});
      return "refused";
    } finally {
      this.requesting = false;
    }
  }

  /** The first seconds in the headset, when the HUD says how to pause */
  showingPauseHint(nowMs: number): boolean {
    return nowMs - this.startedAtMs < PAUSE_HINT_MS;
  }

  exit(): void {
    void this.session?.end().catch(() => {});
  }

  /** Puts the head back on the driver's eye point, facing the nose (done in the next headset frame) */
  recenter(): void {
    if (this.session) this.recenterPending = true;
  }

  /**
   * The controllers as a standard pad for this frame, read once at the top of the frame (null outside the headset or
   * with no controller). The drive reads it with the other pads.
   */
  readPad(): PadLike | null {
    this.pad = this.session && this.presenting ? this.padMapper.read(this.session.inputSources) : null;
    return this.pad;
  }

  /**
   * The headset's own buttons this frame: the long B that pauses, and the paused panel's A / B / Y, which a pad
   * plugged in (`pads`, the controllers' own left out) can press too
   */
  pauseInput(nowMs: number, paused: boolean, pads: readonly PadLike[] = []): VrPauseInput {
    return this.buttons.read(this.pad, nowMs, paused, pads);
  }

  /**
   * One headset frame: the rig on the eye point, the HUD's page, then the scene for both eyes. Runs inside the
   * headset's frame callback (renderer.setAnimationLoop), where the session's pose for this frame is known.
   */
  render(scene: THREE.Scene, eyePosition: THREE.Vector3, eyeQuaternion: THREE.Quaternion, hud: VrHudModel, nowMs: number): void {
    const xr = this.renderer.xr;
    this.rig.position.copy(eyePosition);
    this.rig.quaternion.copy(eyeQuaternion);
    this.rig.updateMatrixWorld(true);
    if (this.recenterPending) this.tryRecenter();
    this.hud.update(hud, nowMs);
    xr.updateCamera(this.camera);
    const eyes = xr.getCamera();
    // The eyes have no parent: three sets their world matrices from the rig itself, and anything that asks one for its
    // world position (the physical sky's material does, per draw) would rebuild it without the rig, at the world's
    // origin, for every draw after. Kept as three set them for the frame
    eyes.matrixWorldAutoUpdate = false;
    for (const eye of eyes.cameras) eye.matrixWorldAutoUpdate = false;
    if (this.renderer.state.buffers.depth.getReversed()) reverseXrDepth(eyes, this.camera.far);
    // The composer turns the renderer's own clear off (it clears its targets itself): the eye buffers keep last frame's
    // depth otherwise, and under the reversed depth buffer nothing passes the test against it
    const autoClear = this.renderer.autoClear;
    this.renderer.autoClear = true;
    try {
      this.renderer.render(scene, this.camera);
    } finally {
      this.renderer.autoClear = autoClear;
    }
  }

  private tryRecenter(): void {
    const frame = this.renderer.xr.getFrame();
    const base = this.baseSpace;
    if (!frame || !base) return;
    const pose = frame.getViewerPose(base);
    if (!pose) return;
    const p = pose.transform.position;
    const o = pose.transform.orientation;
    // The heading alone: the direction the head looks, flattened, as a turn about the vertical
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    const yaw = Math.hypot(forward.x, forward.z) > 1e-4 ? Math.atan2(-forward.x, -forward.z) : 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // The new space's origin at the head: the head is then on the rig's origin, the eye point, looking ahead
    const offset = base.getOffsetReferenceSpace(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }, { x: q.x, y: q.y, z: q.z, w: q.w }));
    this.renderer.xr.setReferenceSpace(offset);
    this.recenterPending = false;
  }

  dispose(): void {
    this.exit();
    this.rig.removeFromParent();
    this.hud.dispose();
  }
}
