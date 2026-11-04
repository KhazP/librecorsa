import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";

/**
 * Live dash for the Mercedes-AMG GT3 cockpit (`AMG_GT3_DISPALY_MESH`).
 *
 * The cockpit ships the mod's 1024x1024 dash template (box frames and labels only; the game drew the values),
 * mapped with glTF UVs (v = 0 at the image top, repeat-wrapped): the screen shows x 21..1003, y 129..895 of the
 * image. The template is drawn into a canvas of the same layout with the live values over it, and the canvas
 * becomes the material's colour and emissive map, so the screen glows like a backlit LCD.
 *
 * Values with no channel in the simulation (water, oil and gearbox temperatures) read "--".
 */

/** The dash screen's node in the cockpit model (the mod's spelling) */
export const GT3_DASH_MESH = "AMG_GT3_DISPALY_MESH";
/** The body material that carries the wing mirrors' glass (with other trim) */
export const GT3_WING_MIRROR_MATERIAL = "amgMercedesAMG_GT3_2020Coloured_Material1";
const SIZE = 1024;
/** The canvas is drawn at half the template's resolution: the screen is 12 cm wide */
const SCALE = 0.5;
const REDRAW_INTERVAL_MS = 1000 / 15;
const RPM_FULL_SCALE = 8000;
const FONT = "Arial, Helvetica, sans-serif";
const WHITE = "#f2f4f7";
const DIM = "#8a919c";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Value areas of the template's boxes (template pixels, below each box's label) */
const BOX = {
  water: { x: 32, y: 335, w: 160, h: 105 },
  lap: { x: 218, y: 335, w: 156, h: 105 },
  delta: { x: 386, y: 335, w: 252, h: 105 },
  speed: { x: 650, y: 335, w: 342, h: 105 },
  oil: { x: 32, y: 495, w: 160, h: 107 },
  gearT: { x: 218, y: 495, w: 160, h: 107 },
  gear: { x: 412, y: 510, w: 204, h: 232 },
  abs: { x: 648, y: 495, w: 108, h: 107 },
  tc: { x: 770, y: 495, w: 108, h: 107 },
  map: { x: 892, y: 495, w: 100, h: 107 },
  lapTime: { x: 32, y: 665, w: 346, h: 97 },
  fuel: { x: 650, y: 665, w: 342, h: 97 },
} satisfies Record<string, Box>;

/** The rpm scale's bar, under the 0..8 numerals */
const RPM_BAR: Box = { x: 40, y: 212, w: 940, h: 46 };

function formatLapTime(ms: number): string {
  if (!(ms > 0)) return "-:--.---";
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export interface Gt3DashExtra {
  /** Live delta to the best lap, ms (+ = slower) */
  deltaMs?: number | null;
}

export class Gt3DashDisplay {
  readonly found: boolean;
  private readonly canvas: HTMLCanvasElement | null = null;
  private readonly ctx: CanvasRenderingContext2D | null = null;
  private readonly texture: THREE.CanvasTexture | null = null;
  private readonly template: CanvasImageSource | null = null;
  private readonly material: THREE.MeshStandardMaterial | null = null;
  private readonly original: THREE.Material | null = null;
  private readonly mesh: THREE.Mesh | null = null;
  private lastDrawMs = -Infinity;

  constructor(root: THREE.Object3D) {
    const mesh = root.getObjectByName(GT3_DASH_MESH) as THREE.Mesh | undefined;
    const src = mesh?.isMesh && !Array.isArray(mesh.material) ? (mesh.material as THREE.MeshStandardMaterial) : null;
    const image = src?.map?.image as (CanvasImageSource & { width?: number }) | undefined;
    if (!mesh || !src || !image || typeof document === "undefined") {
      this.found = false;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE * SCALE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.found = false;
      return;
    }
    const texture = new THREE.CanvasTexture(canvas);
    // Same sampling as the template it replaces: glTF orientation, repeat-wrapped UVs
    texture.flipY = false;
    texture.wrapS = src.map!.wrapS;
    texture.wrapT = src.map!.wrapT;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = src.clone();
    material.map = texture;
    material.emissiveMap = texture;
    material.emissive.setRGB(1, 1, 1);
    material.emissiveIntensity = 1.1;
    material.roughness = 0.25;
    material.metalness = 0;
    this.canvas = canvas;
    this.ctx = ctx;
    this.texture = texture;
    this.template = image;
    this.material = material;
    this.original = src;
    this.mesh = mesh;
    mesh.material = material;
    this.found = true;
    this.draw(null, {});
  }

  update(t: CarTelemetry, nowMs: number, extra: Gt3DashExtra = {}): void {
    if (!this.found || nowMs - this.lastDrawMs < REDRAW_INTERVAL_MS) return;
    this.lastDrawMs = nowMs;
    this.draw(t, extra);
  }

  dispose(): void {
    if (this.mesh && this.original) this.mesh.material = this.original;
    this.texture?.dispose();
    this.material?.dispose();
  }

  private draw(t: CarTelemetry | null, extra: Gt3DashExtra): void {
    const ctx = this.ctx;
    if (!ctx || !this.template || !this.texture) return;
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.template, 0, 0, SIZE, SIZE);

    // Rpm bar: green to the shift zone, then amber and red
    const rpm = t?.rpm ?? 0;
    const frac = Math.min(1, Math.max(0, rpm / RPM_FULL_SCALE));
    const bar = RPM_BAR;
    ctx.fillStyle = "#15181d";
    ctx.fillRect(bar.x, bar.y, bar.w, bar.h);
    ctx.fillStyle = frac > 0.9 ? "#ff3030" : frac > 0.78 ? "#ffb020" : "#38e070";
    ctx.fillRect(bar.x, bar.y, bar.w * frac, bar.h);

    const text = (box: Box, value: string, size: number, color = WHITE) => {
      ctx.fillStyle = color;
      ctx.font = `bold ${size}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(value, box.x + box.w / 2, box.y + box.h / 2, box.w - 12);
    };

    if (!t) return void (this.texture.needsUpdate = true);
    const gear = t.gear < 0 ? "R" : t.gear === 0 ? "N" : String(t.gear);
    text(BOX.gear, gear, 200);
    text(BOX.speed, String(Math.round(t.speedKmh)), 78);
    text(BOX.lap, String(Math.max(1, t.race?.lap ?? t.lapCount)), 70);
    const delta = extra.deltaMs;
    if (delta === null || delta === undefined || !Number.isFinite(delta)) text(BOX.delta, "--.--", 62, DIM);
    else text(BOX.delta, `${delta >= 0 ? "+" : "-"}${(Math.abs(delta) / 1000).toFixed(2)}`, 62, delta > 0 ? "#ff4a4a" : "#3cff7a");
    text(BOX.lapTime, formatLapTime(t.currentLapTimeMs), 60);
    // About 0.74 kg per litre of race fuel
    text(BOX.fuel, `${(t.fuelKg / 0.74).toFixed(1)} L`, 60);
    for (const box of [BOX.water, BOX.oil, BOX.gearT]) text(box, "--", 56, DIM);
    const aids = t.f12026;
    text(BOX.abs, aids?.absActive ? "ON" : "", 46, "#f0e040");
    text(BOX.tc, aids?.tcActive ? "ON" : "", 46, "#30b0ff");
    text(BOX.map, "1", 56);
    this.texture.needsUpdate = true;
  }
}
