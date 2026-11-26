import * as THREE from "three";
import { text as tx } from "@/lib/text";
import type { SpeedUnit } from "@/lib/settings/interface-settings";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import type { CarTelemetry } from "@/types/f1";

/**
 * The HUD in the headset. The page's HUD is HTML and a headset shows none of it. Sims and the WebXR cockpit games
 * looked at keep the HUD in the car rather than on the head, and few things on it, so it is three small plates bolted
 * to the car, facing the driver's eye:
 *
 * - left of the steering wheel: gear and speed;
 * - right of it: position, lap, the lap's time, the last and best laps;
 * - in the middle, only when there is something to say: the start lights (just over the nose), and the paused panel
 *   with what the headset's buttons do (the pause menu is HTML too).
 *
 * The side plates sit beside the wheel, not over it: a plate drawn over something nearer than itself shows the eyes
 * two depths at once. They are drawn over the cockpit, unlit, unfogged and not tone mapped (a display, not a surface),
 * each on a canvas redrawn only when what it shows changes, at most 15 times a second.
 */

const REDRAW_MS = 1000 / 15;
/** Plates' canvases: pixels per metre of plate (about 2 px per arcminute at the plates' distance) */
const PX_PER_M = 2300;

interface PlatePlace {
  /** Distance from the eye (m), angle right of straight ahead and below the horizon (degrees), width and height (m) */
  distanceM: number;
  yawDeg: number;
  pitchDeg: number;
  widthM: number;
  heightM: number;
}

const LEFT: PlatePlace = { distanceM: 0.95, yawDeg: -28, pitchDeg: -12, widthM: 0.22, heightM: 0.11 };
const RIGHT: PlatePlace = { distanceM: 0.95, yawDeg: 29, pitchDeg: -12, widthM: 0.24, heightM: 0.13 };
const CENTER: PlatePlace = { distanceM: 1.1, yawDeg: 0, pitchDeg: -6, widthM: 0.5, heightM: 0.2 };
/** The start lights' plate, just over the horizon where the gantry is */
const LIGHTS: PlatePlace = { distanceM: 2.2, yawDeg: 0, pitchDeg: 5, widthM: 0.7, heightM: 0.16 };

export type VrHudModel =
  | {
      kind: "drive";
      speed: number;
      speedUnit: string;
      gear: string;
      position: string | null;
      lap: string;
      lapTime: string;
      last: string;
      best: string;
      /** Red start lights lit (0-5) while the start sequence runs, else null */
      lights: number | null;
      countdown: number | null;
      limiter: boolean;
      /** A line in place of the lap times for a while (how to pause, just after putting the headset on) */
      hint: string | null;
    }
  | { kind: "paused"; title: string; lines: string[] }
  | { kind: "menu"; title: string; lines: string[] };

export function formatLapTime(ms: number | null | undefined): string {
  if (!(typeof ms === "number" && ms > 0)) return "-:--.---";
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

export const gearLabel = (gear: number): string => (gear < 0 ? "R" : gear === 0 ? "N" : String(gear));

/**
 * The lap on the plate, as the page's lap counter has it (TimingPanels.tsx): the telemetry's lap count is the lap under
 * way (1 from the start), the out-lap is called so, and a point-to-point course counts runs
 */
function lapLabel(t: CarTelemetry, pointToPoint: boolean): string {
  const race = t.race;
  const total = race?.totalLaps;
  if (race && total) return tx("game.vr.lapOf", { lap: Math.max(1, Math.min(race.lap, total)), total });
  if (!race && t.outLap) return tx("game.vr.outLap");
  const lap = Math.max(1, race ? race.lap : t.lapCount);
  return pointToPoint ? tx("game.vr.run", { lap }) : tx("game.vr.lap", { lap });
}

/** What the panel shows while driving */
export function driveModel(t: CarTelemetry, unit: SpeedUnit, hint: string | null = null, pointToPoint = false): VrHudModel {
  const race = t.race;
  const racing = race && race.phase !== "finished" && race.fieldSize > 1;
  return {
    kind: "drive",
    speed: Math.round(speedIn(Math.abs(t.speedKmh), unit)),
    speedUnit: SPEED_LABEL[unit],
    gear: gearLabel(t.gear),
    position: racing ? `P${race.position}/${race.fieldSize}` : null,
    lap: lapLabel(t, pointToPoint),
    lapTime: formatLapTime(t.currentLapTimeMs),
    last: formatLapTime(t.lastLapTimeMs),
    best: formatLapTime(t.bestLapTimeMs),
    lights: race?.phase === "lights" && race.countdownS === undefined ? race.lightsOn : null,
    countdown: race?.phase === "lights" && race.countdownS !== undefined ? Math.ceil(race.countdownS) : null,
    limiter: Boolean(t.pit?.limiterOn || race?.rollingFormation?.limiterActive),
    hint,
  };
}

/** What the panel says while paused: the pause menu's few things a headset can do */
export function pausedModel(): VrHudModel {
  return {
    kind: "paused",
    title: tx("game.vr.paused"),
    lines: [tx("game.vr.resumeHint"), tx("game.vr.recenterHint"), tx("game.vr.leaveHint")],
  };
}

/** Outside a drive (title menu, setup screens), which only the page shows */
export function menuModel(): VrHudModel {
  return { kind: "menu", title: tx("game.vr.menusOutside"), lines: [tx("game.vr.leaveHint")] };
}

const modelKey = (m: unknown) => JSON.stringify(m);

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, font: (weight: number, px: number) => string) => void;

/** One plate: a canvas on a quad facing the eye, redrawn when its content changes */
class Plate {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly w: number;
  private readonly h: number;
  private key = "";
  private drawnAtMs = -Infinity;

  constructor(place: PlatePlace, layer: number, private readonly fontFamily: () => string) {
    const canvas = document.createElement("canvas");
    this.w = canvas.width = Math.round(place.widthM * PX_PER_M);
    this.h = canvas.height = Math.round(place.heightM * PX_PER_M);
    this.ctx = canvas.getContext("2d")!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(place.widthM, place.heightM),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false })
    );
    // On a sphere round the eye, turned to face it
    const yaw = THREE.MathUtils.degToRad(-place.yawDeg);
    const pitch = THREE.MathUtils.degToRad(place.pitchDeg);
    this.mesh.rotation.set(pitch, yaw, 0, "YXZ");
    this.mesh.position.set(0, 0, -place.distanceM).applyEuler(this.mesh.rotation);
    this.mesh.renderOrder = 10_000;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
    this.mesh.visible = false;
  }

  /** Shows `content` (hidden when null), redrawn when it changed: at once if it was hidden, else at most 15 times a second */
  show(content: unknown, draw: Draw, nowMs: number): void {
    if (content === null) {
      this.mesh.visible = false;
      this.key = "";
      return;
    }
    const key = modelKey(content);
    const wasHidden = !this.mesh.visible;
    this.mesh.visible = true;
    if (key === this.key || (!wasHidden && nowMs - this.drawnAtMs < REDRAW_MS)) return;
    this.key = key;
    this.drawnAtMs = nowMs;
    const ctx = this.ctx;
    const family = this.fontFamily();
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = "rgba(8, 10, 14, 0.78)";
    roundRect(ctx, 3, 3, this.w - 6, this.h - 6, Math.min(this.w, this.h) * 0.12);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
    // The canvas is not in the page, so it would inherit no direction and lay Arabic lines out left to right ("B: leave
    // VR" read from its end). The page's own direction, as the language set it (i18n/runtime.ts)
    ctx.direction = document.documentElement.dir === "rtl" ? "rtl" : "ltr";
    draw(ctx, this.w, this.h, (weight, px) => `${weight} ${px}px ${family}`);
    this.texture.needsUpdate = true;
  }

  hide(): void {
    this.mesh.visible = false;
    this.key = "";
  }

  dispose(): void {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const DIM = "rgba(255, 255, 255, 0.62)";
const ACCENT = "#d7ff3a";

export class VrHud {
  /** The plates, children of the seat rig (bolted to the car with it) */
  readonly root = new THREE.Group();
  private readonly left: Plate;
  private readonly right: Plate;
  private readonly center: Plate;
  private readonly lights: Plate;
  private font = "Arial, Helvetica, sans-serif";

  constructor(layer: number) {
    try {
      const family = getComputedStyle(document.body).fontFamily;
      if (family) this.font = family;
    } catch {
      // Arial it is
    }
    const font = () => this.font;
    this.left = new Plate(LEFT, layer, font);
    this.right = new Plate(RIGHT, layer, font);
    this.center = new Plate(CENTER, layer, font);
    this.lights = new Plate(LIGHTS, layer, font);
    this.root.add(this.left.mesh, this.right.mesh, this.center.mesh, this.lights.mesh);
  }

  set visible(on: boolean) {
    this.root.visible = on;
  }

  update(model: VrHudModel, nowMs: number): void {
    if (model.kind !== "drive") {
      this.left.hide();
      this.right.hide();
      this.lights.hide();
      this.center.show(model, (ctx, w, h, font) => {
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffffff";
        ctx.font = font(700, Math.round(h * 0.2));
        ctx.fillText(model.title, w / 2, h * 0.27, w * 0.92);
        ctx.font = font(500, Math.round(h * 0.12));
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        model.lines.forEach((line, i) => ctx.fillText(line, w / 2, h * (0.5 + i * 0.17), w * 0.92));
      }, nowMs);
      return;
    }

    this.left.show({ g: model.gear, s: model.speed, u: model.speedUnit, l: model.limiter }, (ctx, w, h, font) => {
      ctx.fillStyle = model.limiter ? "#ffb020" : ACCENT;
      roundRect(ctx, h * 0.12, h * 0.12, h * 0.76, h * 0.76, h * 0.1);
      ctx.fill();
      ctx.fillStyle = "#0a0c10";
      ctx.textAlign = "center";
      ctx.font = font(800, Math.round(h * 0.66));
      ctx.fillText(model.gear, h * 0.5, h * 0.74);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "right";
      ctx.font = font(800, Math.round(h * 0.42));
      ctx.fillText(String(model.speed), w - h * 0.12, h * 0.56, w - h * 1.1);
      ctx.fillStyle = DIM;
      ctx.font = font(600, Math.round(h * 0.17));
      ctx.fillText(model.speedUnit, w - h * 0.12, h * 0.84);
    }, nowMs);

    const right = { p: model.position, lap: model.lap, t: model.lapTime, last: model.last, best: model.best, hint: model.hint };
    this.right.show(right, (ctx, w, h, font) => {
      const pad = h * 0.1;
      // A lap time reads left to right in every language: under a right-to-left direction "-:--.---" came out mirrored
      const time = (value: string, x: number, y: number, maxWidth?: number) => {
        const dir = ctx.direction;
        ctx.direction = "ltr";
        ctx.fillText(value, x, y, maxWidth);
        ctx.direction = dir;
      };
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = font(800, Math.round(h * 0.2));
      ctx.fillText(model.position ?? model.lap, pad, h * 0.24, w * 0.45);
      ctx.textAlign = "right";
      ctx.font = font(600, Math.round(h * 0.15));
      ctx.fillStyle = model.position ? DIM : "#ffffff";
      if (model.position) ctx.fillText(model.lap, w - pad, h * 0.23, w * 0.5);
      else time(model.lapTime, w - pad, h * 0.23, w * 0.5);
      if (model.hint) {
        ctx.textAlign = "left";
        ctx.fillStyle = ACCENT;
        ctx.font = font(600, Math.round(h * 0.13));
        ctx.fillText(model.hint, pad, h * 0.55, w - 2 * pad);
        ctx.fillStyle = "#ffffff";
        ctx.font = font(600, Math.round(h * 0.15));
        if (model.position) time(model.lapTime, pad, h * 0.84, w - 2 * pad);
        return;
      }
      const row = (label: string, value: string, y: number, colour: string) => {
        ctx.textAlign = "left";
        ctx.fillStyle = DIM;
        ctx.font = font(600, Math.round(h * 0.14));
        ctx.fillText(label, pad, y, w * 0.38);
        ctx.textAlign = "right";
        ctx.fillStyle = colour;
        ctx.font = font(700, Math.round(h * 0.16));
        time(value, w - pad, y);
      };
      if (model.position) row("", model.lapTime, h * 0.48, "#ffffff");
      row(tx("game.vr.last"), model.last, model.position ? h * 0.69 : h * 0.55, "#ffffff");
      row(tx("game.vr.best"), model.best, model.position ? h * 0.9 : h * 0.8, "#c58bff");
    }, nowMs);

    const lights = model.lights !== null ? { lights: model.lights } : model.countdown !== null ? { countdown: model.countdown } : null;
    this.lights.show(lights, (ctx, w, h, font) => {
      if (model.lights !== null) {
        const r = h * 0.3;
        const gap = (w - 2 * h * 0.2) / 5;
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.arc(h * 0.2 + gap * (i + 0.5), h / 2, r, 0, Math.PI * 2);
          ctx.fillStyle = i < model.lights ? "#ff2a2a" : "rgba(255, 255, 255, 0.12)";
          ctx.fill();
        }
      } else {
        ctx.textAlign = "center";
        ctx.fillStyle = "#ffffff";
        ctx.font = font(800, Math.round(h * 0.7));
        ctx.fillText(String(model.countdown), w / 2, h * 0.76);
      }
    }, nowMs);
    this.center.hide();
  }

  dispose(): void {
    for (const p of [this.left, this.right, this.center, this.lights]) p.dispose();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
