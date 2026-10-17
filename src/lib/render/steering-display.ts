import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";

/**
 * Steering-wheel screen for the VF26 GLB.
 *
 * The display is the `INT_DISPLAY` primitive under `STEER_BASE`: a flat 2-triangle quad facing the driver
 * (normal -Z in model space), 94 mm x 55 mm (aspect ~1.72). Its UVs run 0.04..0.96 x 0.23..0.77 of the unit
 * square, which is only a sub-rectangle of the texture, so the mesh gets its own UV set (the GLB position and
 * index buffers are shared, not copied) that maps the canvas content box onto the quad:
 *   - canvas x grows toward the driver's right (model -X), canvas y grows downward (flipY texture, v = 1 at top)
 *   - the 512x256 canvas holds a 440x256 content box (aspect 1.72) centred horizontally, so nothing is stretched
 */

const CANVAS_W = 512;
const CANVAS_H = 256;
/** Content box in canvas pixels; the UVs map this box onto the display quad */
const BOX_X = 36;
const BOX_W = 440;
const REDRAW_INTERVAL_MS = 1000 / 30;

const LED_COUNT = 15;
const LED_GAP = 4;
const LED_TOP = 6;
const LED_H = 24;
const LED_START_RPM = 10000;
const LIMITER_RPM = 12500;

const COLOR_BG = "#000000";
const COLOR_LED_OFF = "#16191e";
const COLOR_LED_GREEN = "#22ff55";
const COLOR_LED_RED = "#ff2b2b";
const COLOR_LED_BLUE = "#2f7bff";
const COLOR_TEXT = "#f4f6f8";
const COLOR_TEXT_DIM = "#7d8794";
const COLOR_SLOWER = "#ff3b3b";
const COLOR_FASTER = "#36ff7a";
const COLOR_TYRE_LABEL = "#0b0d10";

const TYRE_COLD = [47, 140, 255] as const; // <= 75 C
const TYRE_OK = [46, 224, 107] as const; // ~95 C
const TYRE_HOT = [255, 49, 49] as const; // >= 115 C
const TYRE_NAMES = ["FL", "FR", "RL", "RR"] as const;

const FONT_GEAR = "bold 190px Arial, Helvetica, sans-serif";
const FONT_SPEED = "bold 78px Arial, Helvetica, sans-serif";
const FONT_UNIT = "18px Arial, Helvetica, sans-serif";
const FONT_LAP = "bold 26px Arial, Helvetica, sans-serif";
const FONT_DELTA = "bold 30px Arial, Helvetica, sans-serif";
const FONT_TYRE = "bold 30px Arial, Helvetica, sans-serif";
const FONT_TYRE_LABEL = "bold 13px Arial, Helvetica, sans-serif";

const DISPLAY_MATERIAL = "INT_DISPLAY";

type ScreenInput = Pick<CarTelemetry, "rpm" | "gear" | "speedKmh" | "currentLapTimeMs" | "tireTempsC">;
const BLANK_SCREEN: ScreenInput = { rpm: 0, gear: 0, speedKmh: 0, currentLapTimeMs: 0, tireTempsC: [0, 0, 0, 0] };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function tyreColour(tempC: number): string {
  let a: readonly [number, number, number];
  let b: readonly [number, number, number];
  let k: number;
  if (tempC <= 75) return `rgb(${TYRE_COLD[0]},${TYRE_COLD[1]},${TYRE_COLD[2]})`;
  if (tempC <= 95) {
    a = TYRE_COLD;
    b = TYRE_OK;
    k = (tempC - 75) / 20;
  } else if (tempC <= 115) {
    a = TYRE_OK;
    b = TYRE_HOT;
    k = (tempC - 95) / 20;
  } else {
    return `rgb(${TYRE_HOT[0]},${TYRE_HOT[1]},${TYRE_HOT[2]})`;
  }
  const r = Math.round(a[0] + (b[0] - a[0]) * k);
  const g = Math.round(a[1] + (b[1] - a[1]) * k);
  const bl = Math.round(a[2] + (b[2] - a[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

function formatLap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--.---";
  const total = Math.floor(ms);
  const min = Math.floor(total / 60000);
  const sec = Math.floor(total / 1000) % 60;
  const milli = total % 1000;
  return `${min}:${sec < 10 ? "0" : ""}${sec}.${milli < 100 ? (milli < 10 ? "00" : "0") : ""}${milli}`;
}

/**
 * Builds a geometry that shares the source's attribute buffers but carries its own UV set. Only the vertices
 * referenced by the index buffer are mapped; the shared position buffer is never copied or modified.
 */
function buildDisplayGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const count = pos.count;
  const used = new Uint8Array(count);
  const index = src.index;
  if (index) {
    for (let i = 0; i < index.count; i++) used[index.getX(i)] = 1;
  } else {
    used.fill(1);
  }
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

  const uv = new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    if (!used[v]) continue;
    // Driver's left is model +X, so the left edge of the canvas sits at xMax
    const tx = (xMax - pos.getX(v)) / w;
    const ty = (pos.getY(v) - yMin) / h;
    uv[v * 2] = (BOX_X + tx * BOX_W) / CANVAS_W;
    uv[v * 2 + 1] = ty;
  }

  const geo = new THREE.BufferGeometry();
  for (const name in src.attributes) {
    if (name !== "uv") geo.setAttribute(name, src.getAttribute(name));
  }
  if (index) geo.setIndex(index);
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Steering-wheel LCD: a 512x256 canvas drawn at <= 30 Hz and used as the emissive map of a cloned INT_DISPLAY
 * material. Create one per car (the GLB template's materials and geometry are shared between clones).
 */
export class SteeringWheelDisplay {
  readonly found: boolean;

  private readonly mesh: THREE.Mesh | null = null;
  private readonly originalMaterial: THREE.Material | null = null;
  private readonly originalGeometry: THREE.BufferGeometry | null = null;
  private readonly ownGeometry: THREE.BufferGeometry | null = null;
  private readonly ownMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly canvas: HTMLCanvasElement | null = null;
  private readonly ctx: CanvasRenderingContext2D | null = null;
  private readonly texture: THREE.CanvasTexture | null = null;
  private lastDrawMs = -Infinity;

  constructor(steerRoot: THREE.Object3D) {
    let target: THREE.Mesh | null = null;
    steerRoot.traverse((obj) => {
      if (target) return;
      const m = obj as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      if (m.material.name === DISPLAY_MATERIAL) target = m;
    });

    const mesh = target as THREE.Mesh | null;
    const src = mesh?.material as THREE.MeshStandardMaterial | undefined;
    const srcGeo = mesh?.geometry as THREE.BufferGeometry | undefined;
    const ownGeo = mesh && srcGeo ? buildDisplayGeometry(srcGeo) : null;
    if (!mesh || !src || !srcGeo || !ownGeo || !src.isMeshStandardMaterial) {
      this.found = false;
      return;
    }

    this.found = true;
    this.mesh = mesh;
    this.originalMaterial = src;
    this.originalGeometry = srcGeo;
    this.ownGeometry = ownGeo;

    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext("2d", { alpha: false });

    // Uploaded as a plain (linear-format) premultiplied texture: an sRGB-format upload of a canvas leaves the
    // browser's GPU copy path and cost ~4.5 ms per 30 Hz redraw. The sRGB decode happens in the shader instead
    // (DECODE_VIDEO_TEXTURE_EMISSIVE below), so the colours are unchanged.
    const tex = new THREE.CanvasTexture(this.canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = true;
    this.texture = tex;

    // Clone so the shared template material (and every other car's wheel) keeps its dark base
    const mat = src.clone();
    mat.emissive.set(0xffffff);
    mat.emissiveIntensity = 1.6;
    mat.emissiveMap = tex;
    mat.defines = { ...mat.defines, DECODE_VIDEO_TEXTURE_EMISSIVE: "" };
    mat.needsUpdate = true;
    this.ownMaterial = mat;

    mesh.geometry = ownGeo;
    mesh.material = mat;
    this.draw(BLANK_SCREEN, 0, null);
    tex.needsUpdate = true;
  }

  /** Redraws at most 30 Hz; the texture is only flagged for upload when the canvas was redrawn */
  update(t: CarTelemetry, nowMs: number, extra?: { deltaMs?: number | null }): void {
    if (!this.found || !this.ctx || !this.texture) return;
    if (nowMs - this.lastDrawMs < REDRAW_INTERVAL_MS && nowMs >= this.lastDrawMs) return;
    this.lastDrawMs = nowMs;
    this.draw(t, nowMs, extra?.deltaMs ?? null);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    if (!this.found || !this.mesh) return;
    if (this.originalMaterial) this.mesh.material = this.originalMaterial;
    if (this.originalGeometry) this.mesh.geometry = this.originalGeometry;
    this.ownGeometry?.dispose();
    this.ownMaterial?.dispose();
    this.texture?.dispose();
  }

  private draw(t: ScreenInput, nowMs: number, deltaMs: number | null): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // RPM LEDs: green / red / blue segments, all blue and flashing at the limiter
    const rpm = Number.isFinite(t.rpm) ? t.rpm : 0;
    const segW = (BOX_W - (LED_COUNT - 1) * LED_GAP) / LED_COUNT;
    const litCount = Math.round(clamp01((rpm - LED_START_RPM) / (LIMITER_RPM - LED_START_RPM)) * LED_COUNT);
    const atLimiter = rpm >= LIMITER_RPM;
    const flashOn = Math.floor(nowMs / 100) % 2 === 0;
    for (let i = 0; i < LED_COUNT; i++) {
      let colour = COLOR_LED_OFF;
      if (atLimiter) {
        if (flashOn) colour = COLOR_LED_BLUE;
      } else if (i < litCount) {
        colour = i < 5 ? COLOR_LED_GREEN : i < 10 ? COLOR_LED_RED : COLOR_LED_BLUE;
      }
      ctx.fillStyle = colour;
      ctx.fillRect(BOX_X + i * (segW + LED_GAP), LED_TOP, segW, LED_H);
    }

    // Tyre temperatures: 2x2 grid, FL FR on top, RL RR below
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i < 4; i++) {
      const col = i & 1;
      const row = i >> 1;
      const x = BOX_X + col * 74;
      const y = 44 + row * 104;
      const temp = Number.isFinite(t.tireTempsC[i]) ? t.tireTempsC[i] : 0;
      ctx.fillStyle = tyreColour(temp);
      ctx.fillRect(x, y, 68, 98);
      ctx.fillStyle = COLOR_TYRE_LABEL;
      ctx.font = FONT_TYRE_LABEL;
      ctx.textAlign = "left";
      ctx.fillText(TYRE_NAMES[i], x + 5, y + 16);
      ctx.font = FONT_TYRE;
      ctx.textAlign = "center";
      ctx.fillText(String(Math.round(temp)), x + 34, y + 66);
    }

    // Gear, centre column
    const gear = t.gear;
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = FONT_GEAR;
    ctx.textAlign = "center";
    ctx.fillText(gear < 0 ? "R" : gear === 0 ? "N" : String(gear), 256, 196);

    // Speed, lap time and delta, right column
    const speed = Number.isFinite(t.speedKmh) ? Math.round(t.speedKmh) : 0;
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = FONT_SPEED;
    ctx.fillText(String(speed), 406, 104);
    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.font = FONT_UNIT;
    ctx.fillText("km/h", 406, 128);

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = FONT_LAP;
    ctx.fillText(formatLap(t.currentLapTimeMs), 406, 172);

    ctx.font = FONT_DELTA;
    if (deltaMs === null || !Number.isFinite(deltaMs)) {
      ctx.fillStyle = COLOR_TEXT_DIM;
      ctx.fillText("-.---", 406, 222);
    } else {
      const secs = Math.abs(deltaMs) / 1000;
      ctx.fillStyle = deltaMs > 0 ? COLOR_SLOWER : COLOR_FASTER;
      ctx.fillText(`${deltaMs > 0 ? "+" : "-"}${secs.toFixed(3)}`, 406, 222);
    }
  }
}
