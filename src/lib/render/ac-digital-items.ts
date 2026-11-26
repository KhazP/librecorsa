/**
 * The texts an Assetto Corsa car's digital_instruments.ini draws on its wheel and dash ([ITEM_n]: the gear, speed,
 * rpm, fuel, lap times ... in the LCD windows the model leaves for them), live from the telemetry. The porter
 * (scripts/cars/port_ac_car.py, `read_digital_items`) hands each one over as the CAR node's `digitalItems` extras: the
 * frame of the node it is drawn on, in the rig node it rides on (the steering wheel's STEER or the BODY), and its
 * place, size, colour, font and format.
 *
 * AC draws an item in its node's XY plane, from its POSITION along the node's -X (the driver's right), its baseline
 * there and SIZE metres high, facing the driver (-Z). Each item here is a quad of that size with a canvas of its text,
 * redrawn only when the text changes. The 'digital_big' font is AC's seven-segment one: digits are drawn as segments;
 * the other fonts are a bold sans.
 */
import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";

export interface AcDigitalItem {
  attach: "STEER" | "BODY";
  /** The item's node in the rig node it rides on (4 x 4, column-major) */
  frame: number[];
  type: string;
  position: [number, number, number];
  /** Text height (m) */
  size: number;
  /** RGBA, 0..1 */
  color: [number, number, number, number];
  intensity: number;
  font: string;
  align: "LEFT" | "CENTER" | "RIGHT";
  /** A PLACE_HOLDER's fixed text */
  text?: string;
  prefix?: string;
  postfix?: string;
  units?: string;
  decimals?: number;
}

export interface AcDigitalExtra {
  /** Delta to the best lap (ms), for PERF */
  deltaMs?: number | null;
}

/** Canvas pixels per text height */
const PX = 64;
/** Margins round the text, in text heights */
const MARGIN_X = 0.12;
const MARGIN_Y = 0.15;
/** Width of one character, in text heights (seven-segment and sans alike) */
const CHAR_W = 0.62;
/** How far in front of its LCD window a text floats (m), clear of z-fighting */
const LIFT_M = 0.0006;
/** Brightest a lit text glows (an AC INTENSITY of 4.5 is a bright LED) */
const MAX_GLOW = 2.5;
/** Fuel's density, for litres from kilograms */
const FUEL_KG_PER_L = 0.745;
const REDRAW_INTERVAL_MS = 1000 / 15;

/** The widest text a type shows, in characters */
function maxChars(item: AcDigitalItem): number {
  const fixed = (item.prefix?.length ?? 0) + (item.postfix?.length ?? 0);
  const body: Record<string, number> = {
    GEAR: 1,
    SPEED: 3,
    RPM: 5,
    FUEL: 3 + (item.decimals ? item.decimals + 1 : 0),
    LAPTIME: 8,
    BEST_LAP: 8,
    LAST_LAP: 8,
    CURRENT_LAP: 3,
    TC_LEVEL: 2,
    PERF: 6,
    WATER_TEMP: 3,
  };
  return Math.max(1, fixed + (item.type === "PLACE_HOLDER" ? (item.text?.length ?? 1) : (body[item.type] ?? 6)));
}

function lapTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "-:--.-";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** An item's text now, or "" for one with nothing to show (a value the simulation doesn't have) */
function itemText(item: AcDigitalItem, t: CarTelemetry, extra: AcDigitalExtra | undefined): string {
  let body: string;
  switch (item.type) {
    case "GEAR":
      body = t.gear < 0 ? "R" : t.gear === 0 ? "N" : String(t.gear);
      break;
    case "SPEED":
      body = String(Math.round(Math.max(0, t.speedKmh)));
      break;
    case "RPM":
      body = String(Math.round(Math.max(0, t.rpm)));
      break;
    case "FUEL":
      body = (Math.max(0, t.fuelKg) / FUEL_KG_PER_L).toFixed(item.decimals ?? 0);
      break;
    case "LAPTIME":
      body = lapTime(t.currentLapTimeMs);
      break;
    case "BEST_LAP":
      body = lapTime(t.bestLapTimeMs);
      break;
    case "LAST_LAP":
      body = lapTime(t.lastLapTimeMs);
      break;
    case "CURRENT_LAP":
      body = String(Math.max(1, t.lapCount));
      break;
    case "TC_LEVEL":
      if (!t.liveTuner) return "";
      body = String(t.liveTuner.tcLevel);
      break;
    case "PERF": {
      const d = extra?.deltaMs;
      if (d === null || d === undefined || !Number.isFinite(d)) return "";
      body = `${d < 0 ? "-" : "+"}${(Math.abs(d) / 1000).toFixed(item.decimals ?? 2)}`;
      break;
    }
    case "PLACE_HOLDER":
      body = item.text ?? "";
      break;
    default:
      // A reading the simulation has no value for (WATER_TEMP, ...): the window stays dark
      return "";
  }
  return `${item.prefix ?? ""}${body}${item.postfix ?? ""}`;
}

/** Seven-segment patterns: segments a b c d e f g (top, top right, bottom right, bottom, bottom left, top left, middle) */
const SEGMENTS: Record<string, string> = {
  "0": "abcdef",
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  "4": "bcfg",
  "5": "acdfg",
  "6": "acdefg",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcdfg",
  "-": "g",
  N: "abcef",
  R: "eg",
  E: "adefg",
  F: "aefg",
  P: "abefg",
  L: "def",
  H: "bcefg",
  A: "abcefg",
};

/** A seven-segment character in the box (x, top, w, h); false for one it has no segments for */
function drawSegments(ctx: CanvasRenderingContext2D, ch: string, x: number, top: number, w: number, h: number): boolean {
  const segs = SEGMENTS[ch.toUpperCase()];
  if (segs === undefined) return false;
  const th = Math.max(2, h * 0.13);
  const g = th * 0.25;
  const mid = top + h / 2;
  const rects: Record<string, [number, number, number, number]> = {
    a: [x + th, top, w - 2 * th, th],
    b: [x + w - th, top + th + g, th, h / 2 - th - 2 * g],
    c: [x + w - th, mid + g, th, h / 2 - th - 2 * g],
    d: [x + th, top + h - th, w - 2 * th, th],
    e: [x, mid + g, th, h / 2 - th - 2 * g],
    f: [x, top + th + g, th, h / 2 - th - 2 * g],
    g: [x + th, mid - th / 2, w - 2 * th, th],
  };
  for (const s of segs) ctx.fillRect(...rects[s]);
  return true;
}

interface LiveItem {
  item: AcDigitalItem;
  mesh: THREE.Mesh;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  shown: string | null;
}

/** The live texts of one car's digital_instruments.ini; `found` is false when it draws none */
export class AcDigitalItems {
  readonly found: boolean;
  private readonly items: LiveItem[] = [];
  private readonly groups: THREE.Object3D[] = [];
  private lastDrawMs = -Infinity;

  /** `steer` is the rig's STEER node; BODY items go on the BODY node beside it */
  constructor(steer: THREE.Object3D, items: readonly AcDigitalItem[]) {
    const body = steer.parent?.getObjectByName("BODY") ?? null;
    if (typeof document !== "undefined") {
      for (const item of items) {
        const host = item.attach === "BODY" ? body : steer;
        if (!host || item.frame.length !== 16 || !(item.size > 0)) continue;
        const live = this.build(item);
        if (!live) continue;
        const frame = new THREE.Object3D();
        frame.name = `AC_ITEM_${item.type}`;
        frame.matrixAutoUpdate = false;
        frame.matrix.fromArray(item.frame);
        frame.add(live.mesh);
        host.add(frame);
        this.groups.push(frame);
        this.items.push(live);
      }
    }
    this.found = this.items.length > 0;
  }

  private build(item: AcDigitalItem): LiveItem | null {
    const chars = maxChars(item);
    const w = Math.ceil((chars * CHAR_W + 2 * MARGIN_X) * PX);
    const h = Math.ceil((1 + 2 * MARGIN_Y) * PX);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const glow = Math.min(MAX_GLOW, Math.max(0.2, item.intensity));
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      opacity: item.color[3],
      // Dark ink on a lit LCD stays dark; a lit segment glows with its intensity
      color: new THREE.Color(item.color[0], item.color[1], item.color[2]).multiplyScalar(glow),
    });
    const widthM = (w / PX) * item.size;
    const heightM = (h / PX) * item.size;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), material);
    // Facing the driver (-Z), its +X along the node's -X, the way AC writes
    mesh.rotation.y = Math.PI;
    const [px, py, pz] = item.position;
    const cx = item.align === "LEFT" ? px - widthM / 2 + MARGIN_X * item.size : item.align === "RIGHT" ? px + widthM / 2 - MARGIN_X * item.size : px;
    mesh.position.set(cx, py - MARGIN_Y * item.size + heightM / 2, pz - LIFT_M);
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return { item, mesh, ctx, texture, material, shown: null };
  }

  private draw(live: LiveItem, text: string): void {
    const { ctx, item } = live;
    const { width: w, height: h } = ctx.canvas;
    ctx.clearRect(0, 0, w, h);
    if (!text) return;
    ctx.fillStyle = "#ffffff";
    const top = MARGIN_Y * PX;
    const segments = item.font.toLowerCase().startsWith("digital");
    const textW = text.length * CHAR_W * PX;
    const left = item.align === "LEFT" ? MARGIN_X * PX : item.align === "RIGHT" ? w - MARGIN_X * PX - textW : (w - textW) / 2;
    if (segments) {
      const cw = CHAR_W * PX;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const x = left + i * cw;
        if (ch === "." || ch === ":") {
          const d = PX * 0.12;
          if (ch === ":") ctx.fillRect(x + cw * 0.4, top + PX * 0.3, d, d);
          ctx.fillRect(x + cw * 0.4, top + PX - d, d, d);
          continue;
        }
        if (ch === " ") continue;
        if (!drawSegments(ctx, ch, x + cw * 0.08, top, cw * 0.84, PX)) {
          ctx.font = `bold ${PX}px Arial, Helvetica, sans-serif`;
          ctx.textBaseline = "bottom";
          ctx.fillText(ch, x, top + PX);
        }
      }
      return;
    }
    ctx.font = `bold ${PX}px Arial, Helvetica, sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = item.align === "LEFT" ? "left" : item.align === "RIGHT" ? "right" : "center";
    const x = item.align === "LEFT" ? MARGIN_X * PX : item.align === "RIGHT" ? w - MARGIN_X * PX : w / 2;
    ctx.fillText(text, x, top + PX, w - 2 * MARGIN_X * PX);
  }

  /** Redraws the texts that changed, at most 15 times a second */
  update(t: CarTelemetry, nowMs: number, extra?: AcDigitalExtra): void {
    if (!this.found) return;
    if (nowMs - this.lastDrawMs < REDRAW_INTERVAL_MS && nowMs >= this.lastDrawMs) return;
    this.lastDrawMs = nowMs;
    for (const live of this.items) {
      const text = itemText(live.item, t, extra);
      if (text === live.shown) continue;
      live.shown = text;
      this.draw(live, text);
      live.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const g of this.groups) g.removeFromParent();
    for (const live of this.items) {
      live.mesh.geometry.dispose();
      live.material.dispose();
      live.texture.dispose();
    }
    this.items.length = 0;
  }
}
