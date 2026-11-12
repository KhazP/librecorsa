import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";
import { planarUvGeometry } from "./planar-uv";
import type { GlassPatch } from "./wing-mirrors";

/**
 * Live dash screens for the GT3 bodies, whose models only carry a still photo of a page.
 *
 * Mercedes-AMG GT3 Evo (Vecarz's model, `/cars/amg-gt3-evo/model/amg-gt3-evo.glb`):
 * - the dash screen (`EVO_SCREEN_MATERIAL`, 118 x 89 mm on the pod behind the wheel; the photo is stuck in reverse
 *   with the pit limiter on) gets planar UVs and a page in the layout of the Bosch DDU the real car runs;
 * - the shift lights (`EVO_LIGHTS_MATERIAL`, the strip over the screen): ten lenses in one mesh, 2 + 6 + 2 across,
 *   lit in pairs from the ends inwards through the rev range and flashing blue at the shift point;
 * - its mirrors and rear-view monitor (`gt3MirrorPatches`): four islands of one mesh, for `WingMirrors`.
 *
 * BMW M4 GT3 Evo (Ddiaz Design's model): the screen is ten triangles of the interior atlas (`BMW_SCREEN`, 183 x 124 mm
 * behind the wheel, its LED dashes printed round it), so a live copy of them is laid 1.5 mm over the photo, with its
 * own bezel LEDs and a page laid out like the real car's (big green gear, coloured MAP / TC / ABS blocks).
 *
 * Both pages show only channels the simulation has: rpm, speed, gear, lap, position, delta (the last lap for a few
 * seconds after the line), tyre temperatures, ABS / TC / map and brake bias (a changed aid pops up, as on the real
 * dashes), lap time and fuel, with race control's messages over the top. The rig shares the template's materials and
 * geometry with every car in the same body (the AI GT3s), so everything here is this car's copy; `dispose` puts the
 * template's back.
 */

const EVO_SCREEN_MATERIAL = "MI_Mercedes_AMG_GT3_Evo_Cockpit_Screen";
const EVO_LIGHTS_MATERIAL = "MI_Mercedes_AMG_GT3_Evo_Interactive_Lights";
/** The export's placeholder material, on the Evo's wing mirrors, interior mirror and rear-view monitor */
const EVO_MIRROR_MATERIAL = "WorldGridMaterial";

/** The BMW's screen: the triangles of its interior material sampling the atlas' dash photo, behind the wheel */
const BMW_SCREEN = {
  material: "BMWMAT_Details_INT1",
  /** The photo in the atlas (u0, v0, u1, v1; glTF v, 0 at the image's top) */
  uv: [0.028, 0.78, 0.32, 0.985],
  /** Behind the wheel, in the model's car frame: the atlas photo is used again under the centre screen's cover */
  box: [
    [0.19, 0.74, 0.33],
    [0.43, 0.9, 0.4],
  ],
  /** The driver's eye, which the copy is lifted toward */
  eye: [0.311, 0.96, -0.39],
} as const;

const REDRAW_INTERVAL_MS = 1000 / 20;
/** How bright the screens glow (the Evo's model asks for 10, which washed the page out) */
const SCREEN_GLOW = 1.5;
/** Race fuel, kg per litre */
const FUEL_KG_PER_L = 0.74;
const LAST_LAP_HOLD_MS = 5000;
const POPUP_HOLD_MS = 2000;

const FONT = "Arial, Helvetica, sans-serif";
const WHITE = "#f2f4f7";
const DIM = "#7d8794";
const OUTLINE = "#e8ecf2";
const GREEN = "#36e07a";
const RED = "#ff3b3b";
const AMBER = "#ffb020";
const BLUE = "#2f7bff";
const TC_LIT = "#add8e6";
const ABS_LIT = "#ffe600";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function findMesh(root: THREE.Object3D, materialName: string): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!found && m.isMesh && !Array.isArray(m.material) && m.material.name === materialName) found = m;
  });
  return found;
}

function formatLapTime(ms: number | null | undefined): string {
  if (!(typeof ms === "number" && ms > 0)) return "-:--.---";
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

function formatDelta(ms: number): string {
  const sign = ms > 0 ? "+" : ms < 0 ? "-" : "";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(2)}`;
}

type AidKind = "tc" | "abs" | "map" | "bias";

/** What the pages remember between frames: the lap's fuel, the last lap's moment, a changed aid's pop-up */
class DashState {
  fuelPerLapL: number | null = null;
  lastLapUntilMs = 0;
  popup: { kind: AidKind; value: number; untilMs: number } | null = null;
  private lapSeen = -1;
  private fuelAtLapStartKg = NaN;
  private aids: Record<AidKind, number> | null = null;

  /** Every frame, so a lap or an aid change between redraws isn't missed */
  track(t: CarTelemetry, nowMs: number): void {
    if (t.lapCount !== this.lapSeen) {
      const used = this.fuelAtLapStartKg - t.fuelKg;
      if (this.lapSeen >= 0 && t.lapCount === this.lapSeen + 1) {
        if (used > 0) this.fuelPerLapL = used / FUEL_KG_PER_L;
        if (t.lastLapTimeMs) this.lastLapUntilMs = nowMs + LAST_LAP_HOLD_MS;
      } else {
        // A new run (or a jump in the lap count): nothing to compare yet
        this.fuelPerLapL = null;
        this.lastLapUntilMs = 0;
      }
      this.lapSeen = t.lapCount;
      this.fuelAtLapStartKg = t.fuelKg;
    }
    const tuner = t.liveTuner;
    if (!tuner) return;
    const now: Record<AidKind, number> = {
      tc: tuner.tcLevel,
      abs: tuner.absLevel,
      map: tuner.engineMap,
      bias: tuner.brakeBiasPct,
    };
    const before = this.aids;
    this.aids = now;
    if (!before) return;
    for (const kind of ["tc", "abs", "map", "bias"] as const) {
      if (now[kind] !== before[kind]) this.popup = { kind, value: now[kind], untilMs: nowMs + POPUP_HOLD_MS };
    }
  }

  /** The pop-up to show now, if any */
  popupAt(nowMs: number): { kind: AidKind; value: number } | null {
    if (this.popup && nowMs >= this.popup.untilMs) this.popup = null;
    return this.popup;
  }
}

/** Canvas drawing in page units (the page's own grid, scaled onto the canvas) */
class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly revRange: readonly [number, number]
  ) {}

  text(x: number, y: number, value: string, size: number, color: string, maxWidth?: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // "middle" centres the em box, which leaves digits riding high: drop them by a share of the size
    ctx.fillText(value, x, y + size * 0.06, maxWidth);
  }

  rect(box: Box, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(box.x, box.y, box.w, box.h);
  }

  /**
   * A boxed value. `edge`: the label sits on the top edge (the DDU's style), else inside at the top. `fill` lights the
   * box (an aid at work), and its text goes black.
   */
  field(
    box: Box,
    label: string,
    value: string,
    size: number,
    opts: { color?: string; fill?: string; edge?: boolean; labelSize?: number } = {}
  ): void {
    const ctx = this.ctx;
    const edge = opts.edge ?? true;
    const labelSize = opts.labelSize ?? 22;
    if (opts.fill) this.rect(box, opts.fill);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 3;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.font = `bold ${labelSize}px ${FONT}`;
    if (edge) {
      const labelW = Math.min(box.w - 8, ctx.measureText(label).width + 14);
      this.rect({ x: box.x + (box.w - labelW) / 2, y: box.y - labelSize / 2 - 1, w: labelW, h: labelSize + 2 }, "#000");
      this.text(box.x + box.w / 2, box.y - labelSize * 0.06, label, labelSize, WHITE, box.w - 8);
      this.text(box.x + box.w / 2, box.y + box.h / 2 + 6, value, size, opts.fill ? "#000" : (opts.color ?? WHITE), box.w - 12);
    } else {
      const ink = opts.fill ? "#000" : WHITE;
      this.text(box.x + box.w / 2, box.y + labelSize * 0.75, label, labelSize, ink, box.w - 8);
      const top = box.y + labelSize * 1.4;
      this.text(box.x + box.w / 2, (top + box.y + box.h) / 2, value, size, opts.fill ? "#000" : (opts.color ?? WHITE), box.w - 12);
    }
  }

  /** The rpm bar: white below the shift lights' range, amber in it, red past the shift point */
  rpmBar(bar: Box, rpm: number, fullScaleK: number, numerals: boolean): void {
    const ctx = this.ctx;
    const [start, shift] = this.revRange;
    this.rect(bar, "#14171c");
    const frac = Math.min(1, Math.max(0, rpm / (fullScaleK * 1000)));
    this.rect({ ...bar, w: bar.w * frac }, rpm >= shift ? RED : rpm >= start ? AMBER : WHITE);
    ctx.fillStyle = WHITE;
    for (let k = 0; k <= fullScaleK; k++) {
      const x = bar.x + (bar.w * k) / fullScaleK;
      ctx.fillStyle = WHITE;
      ctx.fillRect(x - 1.5, bar.y, 3, bar.h);
      if (numerals) this.text(Math.min(bar.x + bar.w - 10, Math.max(bar.x + 10, x)), bar.y - 22, String(k), 30, WHITE);
    }
  }

  /** Tread temperatures, each corner coloured against the compound's window: blue cold, green in it, red hot */
  tyres(area: Box, t: CarTelemetry, size: number): void {
    const [lo, hi] = t.tireOptimalTempC ?? [80, 105];
    const gap = 8;
    const cw = (area.w - gap) / 2;
    const ch = (area.h - gap) / 2;
    for (let i = 0; i < 4; i++) {
      const temp = t.tireTempsC[i];
      const cell = { x: area.x + (i % 2) * (cw + gap), y: area.y + Math.floor(i / 2) * (ch + gap), w: cw, h: ch };
      this.rect(cell, !Number.isFinite(temp) ? "#30343b" : temp < lo ? "#4a9dff" : temp > hi ? RED : GREEN);
      this.text(cell.x + cw / 2, cell.y + ch / 2, Number.isFinite(temp) ? String(Math.round(temp)) : "--", size, "#000", cw - 8);
    }
  }

  /** A changed aid's value over `box`, in the aid's colours */
  popup(box: Box, p: { kind: AidKind; value: number }): void {
    const style = {
      tc: { bg: TC_LIT, fg: "#000", border: TC_LIT, label: "TC" },
      abs: { bg: ABS_LIT, fg: "#000", border: ABS_LIT, label: "ABS" },
      map: { bg: "#000", fg: WHITE, border: RED, label: "ENGINE MAP" },
      bias: { bg: "#000", fg: WHITE, border: OUTLINE, label: "BRAKE BIAS" },
    }[p.kind];
    this.rect({ x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 }, style.border);
    this.rect(box, style.bg);
    this.text(box.x + box.w / 2, box.y + 30, style.label, 30, style.fg, box.w - 16);
    const value = p.kind === "bias" ? p.value.toFixed(1) : (p.kind === "tc" || p.kind === "abs") && p.value <= 0 ? "OFF" : String(p.value);
    this.text(box.x + box.w / 2, box.y + box.h / 2 + 18, value, Math.min(130, box.h * 0.6), style.fg, box.w - 20);
  }

  /** Race control's message across `box`: a penalty in red, anything else in yellow; false when there is none */
  banner(box: Box, t: CarTelemetry): boolean {
    const message = t.trackLimits?.message;
    const text = message ? message.text : t.race?.yellow ? "YELLOW FLAG" : null;
    if (!text) return false;
    const penalty = message?.kind === "penalty";
    this.rect(box, penalty ? RED : ABS_LIT);
    this.text(box.x + box.w / 2, box.y + box.h / 2, text.toUpperCase(), Math.min(50, box.h * 0.55), penalty ? WHITE : "#000", box.w - 24);
    return true;
  }

  aidValue(level: number | undefined): string {
    return level === undefined ? "--" : level > 0 ? String(level) : "OFF";
  }
}

/** A page: its grid, the canvas it is drawn on, and how it is drawn */
interface PageSpec {
  width: number;
  height: number;
  canvasW: number;
  canvasH: number;
  draw(p: Painter, t: CarTelemetry | null, deltaMs: number | null, nowMs: number, s: DashState): void;
}

/** The Evo's page, after the Bosch DDU: 800 x 600 (the screen is 4:3) */
const DDU = {
  lap: { x: 16, y: 116, w: 112, h: 116 },
  pos: { x: 144, y: 116, w: 112, h: 116 },
  delta: { x: 272, y: 116, w: 256, h: 116 },
  speed: { x: 544, y: 116, w: 240, h: 116 },
  tyres: { x: 16, y: 260, w: 240, h: 188 },
  gear: { x: 272, y: 260, w: 256, h: 188 },
  abs: { x: 544, y: 260, w: 72, h: 100 },
  tc: { x: 628, y: 260, w: 72, h: 100 },
  map: { x: 712, y: 260, w: 72, h: 100 },
  bias: { x: 544, y: 384, w: 240, h: 64 },
  lapTime: { x: 16, y: 476, w: 344, h: 108 },
  fuelLap: { x: 376, y: 476, w: 192, h: 108 },
  fuel: { x: 584, y: 476, w: 200, h: 108 },
  popup: { x: 544, y: 248, w: 240, h: 200 },
  rpm: { x: 24, y: 44, w: 752, h: 40 },
  band: { x: 8, y: 4, w: 784, h: 92 },
} satisfies Record<string, Box>;

const DDU_PAGE: PageSpec = {
  width: 800,
  height: 600,
  canvasW: 640,
  canvasH: 480,
  draw(p, t, deltaMs, nowMs, s) {
    const rpm = t?.rpm ?? 0;
    const fullScaleK = Math.max(1, Math.ceil(p.revRange[1] / 1000));
    // At the shift point the whole rpm band flashes blue
    if (rpm >= p.revRange[1] && Math.floor(nowMs / 60) % 2 === 0) p.rect(DDU.band, BLUE);
    p.rpmBar(DDU.rpm, rpm, fullScaleK, true);
    if (!t) return;

    p.field(DDU.lap, "LAP", String(Math.max(1, t.race?.lap ?? t.lapCount)), 64);
    p.field(DDU.pos, "POS", t.race ? String(t.race.position) : "--", 64, { color: t.race ? WHITE : DIM });
    if (nowMs < s.lastLapUntilMs) {
      const best = t.bestLapTimeMs !== null && t.lastLapTimeMs !== null && t.lastLapTimeMs <= t.bestLapTimeMs;
      p.field(DDU.delta, "LAST LAP", formatLapTime(t.lastLapTimeMs), 56, { color: best ? GREEN : WHITE });
    } else if (deltaMs === null || !Number.isFinite(deltaMs)) {
      p.field(DDU.delta, "DELTA", "--.--", 72, { color: DIM });
    } else {
      p.field(DDU.delta, "DELTA", formatDelta(deltaMs), 72, { color: deltaMs > 0 ? RED : GREEN });
    }
    p.field(DDU.speed, "SPEED", String(Math.round(t.speedKmh)), 84);

    p.field(DDU.tyres, "TYRES °C", "", 10);
    p.tyres({ x: DDU.tyres.x + 14, y: DDU.tyres.y + 14, w: DDU.tyres.w - 28, h: DDU.tyres.h - 28 }, t, 52);
    p.field(DDU.gear, "GEAR", t.gear < 0 ? "R" : t.gear === 0 ? "N" : String(t.gear), 180);

    const tuner = t.liveTuner;
    const aids = t.f12026;
    p.field(DDU.abs, "ABS", p.aidValue(tuner?.absLevel), 56, { fill: aids?.absActive ? ABS_LIT : undefined });
    p.field(DDU.tc, "TC", p.aidValue(tuner?.tcLevel), 56, { fill: aids?.tcActive ? TC_LIT : undefined });
    p.field(DDU.map, "MAP", tuner ? String(tuner.engineMap) : "--", 56);
    p.field(DDU.bias, "BIAS", tuner ? tuner.brakeBiasPct.toFixed(1) : "--", 44);

    p.field(DDU.lapTime, "LAP TIME", formatLapTime(t.currentLapTimeMs), 64);
    p.field(DDU.fuelLap, "FUEL/LAP", s.fuelPerLapL === null ? "--" : s.fuelPerLapL.toFixed(2), 60, {
      color: s.fuelPerLapL === null ? DIM : WHITE,
    });
    p.field(DDU.fuel, "FUEL L", (t.fuelKg / FUEL_KG_PER_L).toFixed(1), 60);

    const popup = s.popupAt(nowMs);
    if (popup) p.popup(DDU.popup, popup);
    p.banner(DDU.band, t);
  },
};

/** The BMW's page: 880 x 600 for the photo's patch (bezel with its LEDs round the LCD), 1.48:1 like the patch */
const BMW = {
  lcd: { x: 60, y: 78, w: 760, h: 482 },
  rpm: { x: 72, y: 90, w: 736, h: 28 },
  band: { x: 72, y: 84, w: 736, h: 80 },
  fuelLap: { x: 72, y: 132, w: 220, h: 100 },
  fuel: { x: 72, y: 244, w: 220, h: 100 },
  tyres: { x: 72, y: 356, w: 220, h: 192 },
  map: { x: 588, y: 132, w: 68, h: 100 },
  tc: { x: 664, y: 132, w: 68, h: 100 },
  abs: { x: 740, y: 132, w: 68, h: 100 },
  delta: { x: 588, y: 244, w: 220, h: 100 },
  best: { x: 588, y: 356, w: 220, h: 88 },
  lap: { x: 588, y: 456, w: 104, h: 92 },
  pos: { x: 704, y: 456, w: 104, h: 92 },
  lapTime: { x: 304, y: 456, w: 272, h: 92 },
  popup: { x: 588, y: 132, w: 220, h: 416 },
} satisfies Record<string, Box>;
/** The bezel's LEDs: a shift-light row over the LCD and a column each side */
const BMW_LED_ROW = { count: 10, x0: 222, step: 48, y: 34, w: 34, h: 16 };
const BMW_LED_COLUMN = { count: 5, xs: [14, 846], y0: 140, step: 40, w: 20, h: 10 };
const BMW_BLOCKS = { map: "#c81a1a", tc: "#1d2c8c", abs: "#8c1c1c" };

const BMW_PAGE: PageSpec = {
  width: 880,
  height: 600,
  canvasW: 704,
  canvasH: 480,
  draw(p, t, deltaMs, nowMs, s) {
    const rpm = t?.rpm ?? 0;
    const [start, shift] = p.revRange;
    const atShift = rpm >= shift;
    const blinkOn = !atShift || Math.floor(nowMs / 62) % 2 === 0;

    // Bezel LEDs: the row lights in pairs from its ends inwards; everything flashes blue at the shift point
    const row = BMW_LED_ROW;
    const stages = Math.ceil(row.count / 2);
    const lit = atShift ? stages : rpm < start ? 0 : Math.min(stages, 1 + Math.floor(((rpm - start) / Math.max(1, shift - start)) * stages));
    for (let i = 0; i < row.count; i++) {
      const stage = Math.min(i, row.count - 1 - i);
      const k = stages > 1 ? stage / (stages - 1) : 1;
      const on = stage < lit && blinkOn;
      p.rect({ x: row.x0 + i * row.step, y: row.y, w: row.w, h: row.h }, !on ? "#1a1c20" : atShift ? BLUE : k < 0.4 ? GREEN : k < 0.7 ? AMBER : RED);
    }
    const col = BMW_LED_COLUMN;
    for (const x of col.xs) {
      for (let i = 0; i < col.count; i++) p.rect({ x, y: col.y0 + i * col.step, w: col.w, h: col.h }, atShift && blinkOn ? BLUE : "#1a1c20");
    }

    p.rect(BMW.lcd, "#05070a");
    p.ctx.strokeStyle = "#3a3f47";
    p.ctx.lineWidth = 4;
    p.ctx.strokeRect(BMW.lcd.x, BMW.lcd.y, BMW.lcd.w, BMW.lcd.h);
    p.rpmBar(BMW.rpm, rpm, Math.max(1, Math.ceil(shift / 1000)), false);
    if (!t) return;

    const inside = { edge: false, labelSize: 20 } as const;
    p.field(BMW.fuelLap, "LAP FUEL L", s.fuelPerLapL === null ? "--" : s.fuelPerLapL.toFixed(2), 50, {
      ...inside,
      color: s.fuelPerLapL === null ? DIM : WHITE,
    });
    p.field(BMW.fuel, "FUEL L", (t.fuelKg / FUEL_KG_PER_L).toFixed(1), 50, inside);
    p.tyres(BMW.tyres, t, 46);

    // Gear and speed in the middle, the gear in the car's green
    const midX = BMW.lapTime.x + BMW.lapTime.w / 2;
    p.text(midX, 262, t.gear < 0 ? "R" : t.gear === 0 ? "N" : String(t.gear), 230, GREEN);
    p.text(midX, 404, String(Math.round(t.speedKmh)), 76, WHITE);
    p.text(midX + 98, 420, "KM/H", 18, DIM);
    p.field(BMW.lapTime, "LAP TIME", formatLapTime(t.currentLapTimeMs), 46, inside);

    const tuner = t.liveTuner;
    const aids = t.f12026;
    const block = (box: Box, label: string, value: string, color: string, lit?: string) => {
      p.rect(box, lit ?? color);
      p.text(box.x + box.w / 2, box.y + 18, label, 20, lit ? "#000" : WHITE, box.w - 6);
      p.text(box.x + box.w / 2, box.y + 62, value, 50, lit ? "#000" : WHITE, box.w - 8);
    };
    block(BMW.map, "MAP", tuner ? String(tuner.engineMap) : "--", BMW_BLOCKS.map);
    block(BMW.tc, "TC", p.aidValue(tuner?.tcLevel), BMW_BLOCKS.tc, aids?.tcActive ? TC_LIT : undefined);
    block(BMW.abs, "ABS", p.aidValue(tuner?.absLevel), BMW_BLOCKS.abs, aids?.absActive ? ABS_LIT : undefined);

    if (nowMs < s.lastLapUntilMs) {
      const best = t.bestLapTimeMs !== null && t.lastLapTimeMs !== null && t.lastLapTimeMs <= t.bestLapTimeMs;
      p.field(BMW.delta, "LAST LAP", formatLapTime(t.lastLapTimeMs), 44, { ...inside, color: best ? GREEN : WHITE });
    } else if (deltaMs === null || !Number.isFinite(deltaMs)) {
      p.field(BMW.delta, "DELTA", "--.--", 56, { ...inside, color: DIM });
    } else {
      p.field(BMW.delta, "DELTA", formatDelta(deltaMs), 56, { ...inside, color: deltaMs > 0 ? RED : GREEN });
    }
    p.field(BMW.best, "BEST LAP", formatLapTime(t.bestLapTimeMs), 40, inside);
    p.field(BMW.lap, "LAP", String(Math.max(1, t.race?.lap ?? t.lapCount)), 48, inside);
    p.field(BMW.pos, "POS", t.race ? String(t.race.position) : "--", 48, { ...inside, color: t.race ? WHITE : DIM });

    const popup = s.popupAt(nowMs);
    if (popup) p.popup(BMW.popup, popup);
    p.banner(BMW.band, t);
  },
};

/**
 * Where a page is shown: the Evo's screen mesh itself (its own UVs and material), or a copy of the BMW's photo
 * triangles laid over them
 */
interface Surface {
  /** The geometry to show the page on: planar UVs, u from the driver's left, v up the screen */
  geometry: THREE.BufferGeometry;
  /** Material to clone for the screen (null: a fresh one) */
  base: THREE.MeshStandardMaterial | null;
  attach(material: THREE.Material): void;
  detach(): void;
}

/** Planar UVs across a screen: u from the driver's left (model +X) to right, v up the screen */
function screenUvs(src: THREE.BufferGeometry): THREE.BufferGeometry | null {
  return planarUvGeometry(src, { flipX: true, map: (u, v) => [u, v] });
}

function evoSurface(root: THREE.Object3D): Surface | null {
  const mesh = findMesh(root, EVO_SCREEN_MATERIAL);
  const base = mesh?.material as THREE.MeshStandardMaterial | undefined;
  if (!mesh || !base?.isMeshStandardMaterial) return null;
  const geometry = screenUvs(mesh.geometry);
  if (!geometry) return null;
  const originalGeometry = mesh.geometry;
  return {
    geometry,
    base,
    attach: (material) => {
      mesh.geometry = geometry;
      mesh.material = material;
    },
    detach: () => {
      mesh.geometry = originalGeometry;
      mesh.material = base;
    },
  };
}

/**
 * The BMW's photo triangles (in `BMW_SCREEN.box`, every corner inside the photo's UVs) copied into the `BODY` node's
 * frame (the model's car frame, where the box and the eye are), 1.5 mm toward the driver's eye, as one overlay mesh
 */
function bmwSurface(root: THREE.Object3D): Surface | null {
  const frame = root.getObjectByName("BODY");
  if (!frame) return null;
  const [u0, v0, u1, v1] = BMW_SCREEN.uv;
  const box = new THREE.Box3(new THREE.Vector3(...BMW_SCREEN.box[0]), new THREE.Vector3(...BMW_SCREEN.box[1]));
  const eye = new THREE.Vector3(...BMW_SCREEN.eye);
  const out: number[] = [];
  const frameInv = new THREE.Matrix4();
  const toFrame = new THREE.Matrix4();
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const n = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const centre = new THREE.Vector3();
  frame.updateWorldMatrix(true, true);
  frameInv.copy(frame.matrixWorld).invert();
  frame.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.material.name !== BMW_SCREEN.material) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    const uv = mesh.geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
    if (!pos || !uv) return;
    toFrame.multiplyMatrices(frameInv, mesh.matrixWorld);
    const index = mesh.geometry.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      let inPhoto = true;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        const u = uv.getX(vi);
        const v = uv.getY(vi);
        if (u < u0 || u > u1 || v < v0 || v > v1) inPhoto = false;
        tri[k].fromBufferAttribute(pos, vi).applyMatrix4(toFrame);
      }
      if (!inPhoto) continue;
      centre.copy(tri[0]).add(tri[1]).add(tri[2]).multiplyScalar(1 / 3);
      if (!box.containsPoint(centre)) continue;
      n.subVectors(tri[1], tri[0]).cross(ab.subVectors(tri[2], tri[0])).normalize();
      if (n.dot(ab.subVectors(eye, centre)) < 0) n.negate();
      for (const p of tri) out.push(p.x + n.x * 0.0015, p.y + n.y * 0.0015, p.z + n.z * 0.0015);
    }
  });
  if (out.length === 0) return null;
  const source = new THREE.BufferGeometry();
  source.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  const geometry = screenUvs(source);
  source.dispose();
  if (!geometry) return null;
  geometry.computeVertexNormals();
  const parent: THREE.Object3D = frame;
  let overlay: THREE.Mesh | null = null;
  return {
    geometry,
    base: null,
    attach: (material) => {
      overlay = new THREE.Mesh(geometry, material);
      overlay.name = "LIVE_DASH_SCREEN";
      parent.add(overlay);
    },
    detach: () => {
      overlay?.removeFromParent();
      overlay = null;
    },
  };
}

/** A page drawn on a canvas, shown glowing on a surface */
class LiveScreen {
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly painter: Painter;
  private readonly state = new DashState();
  private lastDrawMs = -Infinity;

  static create(surface: Surface | null, page: PageSpec, revRange: readonly [number, number]): LiveScreen | null {
    if (!surface || typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = page.canvasW;
    canvas.height = page.canvasH;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      surface.geometry.dispose();
      return null;
    }
    return new LiveScreen(surface, page, canvas, ctx, revRange);
  }

  private constructor(
    private readonly surface: Surface,
    private readonly page: PageSpec,
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
    revRange: readonly [number, number]
  ) {
    // As the steering-wheel screens: a linear-format upload (the sRGB decode happens in the shader), no mipmaps
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.premultiplyAlpha = true;
    texture.anisotropy = 4;
    this.texture = texture;

    // Dark glass lit by the page; the model's photo of a page goes
    const material = surface.base ? surface.base.clone() : new THREE.MeshStandardMaterial();
    material.map = null;
    material.color.setRGB(0.02, 0.02, 0.025);
    material.emissive.set(0xffffff);
    material.emissiveMap = texture;
    material.emissiveIntensity = SCREEN_GLOW;
    material.roughness = 0.18;
    material.metalness = 0;
    material.defines = { ...material.defines, DECODE_VIDEO_TEXTURE_EMISSIVE: "" };
    material.needsUpdate = true;
    this.material = material;

    ctx.setTransform(page.canvasW / page.width, 0, 0, page.canvasH / page.height, 0, 0);
    this.painter = new Painter(ctx, revRange);
    surface.attach(material);
    this.draw(null, null, 0);
  }

  update(t: CarTelemetry, nowMs: number, deltaMs: number | null): void {
    this.state.track(t, nowMs);
    if (nowMs - this.lastDrawMs < REDRAW_INTERVAL_MS && nowMs >= this.lastDrawMs) return;
    this.lastDrawMs = nowMs;
    this.draw(t, deltaMs, nowMs);
  }

  dispose(): void {
    this.surface.detach();
    this.surface.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private draw(t: CarTelemetry | null, deltaMs: number | null, nowMs: number): void {
    this.painter.rect({ x: 0, y: 0, w: this.page.width, h: this.page.height }, "#000");
    this.page.draw(this.painter, t, deltaMs, nowMs, this.state);
    this.texture.needsUpdate = true;
  }
}

/** Shift-light colours, 0..1 RGB, scaled past 1 so the lit lenses bloom */
const LED_GLOW = 3;
const LED_OFF: readonly [number, number, number] = [0.03, 0.03, 0.035];
const LED_GREEN: readonly [number, number, number] = [0.1, 1, 0.25];
const LED_YELLOW: readonly [number, number, number] = [1, 0.75, 0.05];
const LED_RED: readonly [number, number, number] = [1, 0.08, 0.06];
const LED_BLUE: readonly [number, number, number] = [0.15, 0.4, 1];
/** Lenses further apart than this (m, across the strip) are separate lights */
const LED_GAP_M = 0.003;
const LED_BLINK_HZ = 8;

/** The Evo's shift-light strip: each lens a cluster of the mesh's vertices along X, coloured through a vertex colour */
class ShiftLights {
  private readonly mesh: THREE.Mesh;
  private readonly originalMaterial: THREE.Material;
  private readonly originalGeometry: THREE.BufferGeometry;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly colors: THREE.BufferAttribute;
  /** Each vertex's lens, numbered from the driver's left */
  private readonly lensOf: Int16Array;
  private readonly lensCount: number;
  private readonly revRange: readonly [number, number];
  private shown = "";

  static from(root: THREE.Object3D, revRange: readonly [number, number]): ShiftLights | null {
    const mesh = findMesh(root, EVO_LIGHTS_MATERIAL);
    return mesh ? new ShiftLights(mesh, revRange) : null;
  }

  private constructor(mesh: THREE.Mesh, revRange: readonly [number, number]) {
    this.mesh = mesh;
    this.revRange = revRange;
    this.originalMaterial = mesh.material as THREE.Material;
    this.originalGeometry = mesh.geometry;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;

    // Lenses from the driver's left (model +X) to right: split the vertices' X where they leave a gap
    const xs = Array.from({ length: pos.count }, (_, i) => pos.getX(i)).sort((a, b) => b - a);
    const starts: number[] = [xs[0]];
    for (let i = 1; i < xs.length; i++) if (xs[i - 1] - xs[i] > LED_GAP_M) starts.push(xs[i]);
    this.lensCount = starts.length;
    this.lensOf = new Int16Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      let lens = 0;
      while (lens + 1 < starts.length && x <= starts[lens + 1] + 1e-6) lens++;
      this.lensOf[i] = lens;
    }

    // Shares the template's buffers; only the colours are this car's
    const geometry = new THREE.BufferGeometry();
    for (const name in mesh.geometry.attributes) geometry.setAttribute(name, mesh.geometry.getAttribute(name));
    if (mesh.geometry.index) geometry.setIndex(mesh.geometry.index);
    this.colors = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geometry.setAttribute("color", this.colors);
    this.geometry = geometry;
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mesh.geometry = geometry;
    mesh.material = this.material;
    this.paint(0, false);
  }

  update(rpm: number, nowMs: number): void {
    const [start, shift] = this.revRange;
    const stages = Math.ceil(this.lensCount / 2);
    const atShift = rpm >= shift;
    const lit = atShift
      ? stages
      : rpm < start
        ? 0
        : Math.min(stages, 1 + Math.floor(((rpm - start) / Math.max(1, shift - start)) * stages));
    const blinkOn = !atShift || Math.floor((nowMs / 1000) * LED_BLINK_HZ * 2) % 2 === 0;
    this.paint(blinkOn ? lit : 0, atShift);
  }

  dispose(): void {
    this.mesh.geometry = this.originalGeometry;
    this.mesh.material = this.originalMaterial;
    this.geometry.dispose();
    this.material.dispose();
  }

  /** Lights the outer `lit` pairs (blue for all of them at the shift point); a no-op when nothing changed */
  private paint(lit: number, atShift: boolean): void {
    const key = `${lit}${atShift ? "s" : ""}`;
    if (key === this.shown) return;
    this.shown = key;
    const stages = Math.ceil(this.lensCount / 2);
    const arr = this.colors.array as Float32Array;
    for (let i = 0; i < this.lensOf.length; i++) {
      const lens = this.lensOf[i];
      const stage = Math.min(lens, this.lensCount - 1 - lens);
      const k = stages > 1 ? stage / (stages - 1) : 1;
      const on = stage < lit;
      const rgb = !on ? LED_OFF : atShift ? LED_BLUE : k < 0.4 ? LED_GREEN : k < 0.7 ? LED_YELLOW : LED_RED;
      const glow = on ? LED_GLOW : 1;
      arr[i * 3] = rgb[0] * glow;
      arr[i * 3 + 1] = rgb[1] * glow;
      arr[i * 3 + 2] = rgb[2] * glow;
    }
    this.colors.needsUpdate = true;
  }
}

export interface Gt3DashExtra {
  /** Live delta to the best lap, ms (+ = slower) */
  deltaMs?: number | null;
}

/** A GT3 body's live dash (the Evo's screen and shift lights, or the BMW's screen), on a rig whose model has loaded */
export class Gt3DashDisplay {
  readonly found: boolean;
  private readonly screen: LiveScreen | null;
  private readonly lights: ShiftLights | null;

  /** `revRange`: where the shift lights start and the shift point (rpm), `revRangeFor` the car's vehicle model */
  constructor(root: THREE.Object3D, revRange: readonly [number, number]) {
    const evo = evoSurface(root);
    this.screen = evo
      ? LiveScreen.create(evo, DDU_PAGE, revRange)
      : LiveScreen.create(bmwSurface(root), BMW_PAGE, revRange);
    this.lights = ShiftLights.from(root, revRange);
    this.found = this.screen !== null || this.lights !== null;
  }

  update(t: CarTelemetry, nowMs: number, extra: Gt3DashExtra = {}): void {
    this.screen?.update(t, nowMs, extra.deltaMs ?? null);
    this.lights?.update(Number.isFinite(t.rpm) ? t.rpm : 0, nowMs);
  }

  dispose(): void {
    this.screen?.dispose();
    this.lights?.dispose();
  }
}

/**
 * The Evo's mirror glass and rear-view monitor, for `WingMirrors`' glass patches: one material on four islands of one
 * mesh, each with the box (the model's car frame, the mesh's parent's space) and the way it faces, from the GLB
 */
const EVO_MIRROR_ISLANDS: readonly { min: [number, number, number]; max: [number, number, number]; facing: [number, number, number] }[] = [
  // Rear-view camera monitor, on the dash right of the wheel, turned toward the driver
  { min: [0.03, 0.75, 0.02], max: [0.2, 0.865, 0.105], facing: [0.27, 0.19, -0.95] },
  // Interior mirror under the roof
  { min: [-0.12, 1.005, 0.05], max: [0.12, 1.085, 0.075], facing: [0, 0, -1] },
  // Left and right wing mirrors, each turned in toward the driver
  { min: [0.85, 0.855, -0.025], max: [1.025, 0.96, 0.07], facing: [-0.44, 0, -0.9] },
  { min: [-1.025, 0.855, -0.025], max: [-0.85, 0.96, 0.07], facing: [0.44, 0, -0.9] },
];

export function gt3MirrorPatches(root: THREE.Object3D): GlassPatch[] {
  // Unreal's default material name could turn up in another export: only the Evo body, known by its dash screen
  const frame = findMesh(root, EVO_SCREEN_MATERIAL) ? findMesh(root, EVO_MIRROR_MATERIAL)?.parent : null;
  if (!frame) return [];
  return EVO_MIRROR_ISLANDS.map((island) => ({
    material: EVO_MIRROR_MATERIAL,
    frame,
    box: new THREE.Box3(new THREE.Vector3(...island.min), new THREE.Vector3(...island.max)),
    facing: new THREE.Vector3(...island.facing).normalize(),
  }));
}
