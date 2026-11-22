import * as THREE from "three";
import type { LiveryFinish } from "@/types/f1";

/**
 * Broadcast-grade procedural 2048px LMDh Hypercar / GTP livery painter for the LC-LMDH (`public/cars/lc-lmdh/model/lc-lmdh.glb`).
 *
 * Paints a 2048x2048 5-panel orthographic atlas calibrated to LC-LMDH's measured BODY paint surfaces
 * (`paint_primary`, `paint_accent`, `paint_secondary`), keeping all `carbon_weave` aero vents, splitter,
 * diffuser, and fender louvers exposed carbon fiber.
 *
 * Designed specifically for prototype bodywork:
 * - Giant vertical shark fin (zN 0.12..0.50, yN 0.52..0.98) carrying iconic Hypercar racing numbers & team motifs
 * - Wide sculpted flat prototype nose (zN 0.72..1.00) with WEC Hypercar number plates & arrow graphics
 * - Sweeping sidepods (zN 0.25..0.68, yN 0.04..0.46) with right-reading sponsors & class plates
 * - Tall rear wing endplates & chase-cam rear wing banner
 */

export const LMDH_ATLAS_SIZE = 2048;

const TOP_H = 832;
const SIDE_H = 448;
const LEFT_Y = TOP_H;
const RIGHT_Y = LEFT_Y + SIDE_H;
const BOTTOM_Y = RIGHT_Y + SIDE_H;
const BOTTOM_H = LMDH_ATLAS_SIZE - BOTTOM_Y;
const HALF_W = LMDH_ATLAS_SIZE / 2;

export type LmdhPattern =
  | "rossa"
  | "penske"
  | "jota_gold"
  | "bleu_endurance"
  | "bavaria_hybrid"
  | "british_works"
  | "matte_kuro";

export interface LmdhLiverySpec {
  id: string;
  name: string;
  team: string;
  number: string;
  pattern: LmdhPattern;
  finish: LiveryFinish;
  swatch: readonly [string, string, string];
  primary: string;
  secondary: string;
  accent: string;
  highlight: string;
  wingColor: string;
  wingText: string;
  wingTextColor: string;
  carbonExposure: number;
  plate: {
    bg: string;
    text: string;
    headerBg: string;
    headerText: string;
    headerLabel: string;
    border: string;
  };
  sponsors: {
    side: string;
    sideSub: string;
    nose: string;
    fin: string;
    rear: string;
  };
}

export const LMDH_LIVERIES: readonly LmdhLiverySpec[] = [
  {
    id: "lmdh_rossa_51",
    name: "#51 Scuderia Rossa",
    team: "Scuderia Rossa",
    number: "51",
    pattern: "rossa",
    finish: "gloss",
    swatch: ["#c40814", "#f2c200", "#111419"],
    primary: "#c40814",
    secondary: "#f2c200",
    accent: "#111419",
    highlight: "#ffffff",
    wingColor: "#c40814",
    wingText: "SCUDERIA ROSSA",
    wingTextColor: "#f2c200",
    carbonExposure: 0.72,
    plate: {
      bg: "#ffffff",
      text: "#0d1016",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#111419",
    },
    sponsors: {
      side: "VELOX CORSE",
      sideSub: "ENDURANCE",
      nose: "ROSSA 499",
      fin: "51",
      rear: "SCUDERIA ROSSA",
    },
  },
  {
    id: "lmdh_penske_6",
    name: "#6 Stuttgart Penske",
    team: "Stuttgart Works",
    number: "6",
    pattern: "penske",
    finish: "gloss",
    swatch: ["#f4f6fa", "#d91628", "#12151c"],
    primary: "#f4f6fa",
    secondary: "#d91628",
    accent: "#12151c",
    highlight: "#e5b828",
    wingColor: "#12151c",
    wingText: "STUTTGART WORKS",
    wingTextColor: "#ffffff",
    carbonExposure: 0.82,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#d91628",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#12151c",
    },
    sponsors: {
      side: "KRONOS LABS",
      sideSub: "MOTORSPORT",
      nose: "STUTTGART",
      fin: "6",
      rear: "STUTTGART WORKS",
    },
  },
  {
    id: "lmdh_gold_12",
    name: "#12 Jota Gold",
    team: "Team Jota",
    number: "12",
    pattern: "jota_gold",
    finish: "metallic",
    swatch: ["#cfa024", "#101319", "#f8fafc"],
    primary: "#cfa024",
    secondary: "#101319",
    accent: "#f8fafc",
    highlight: "#e82230",
    wingColor: "#101319",
    wingText: "TEAM JOTA",
    wingTextColor: "#f2c641",
    carbonExposure: 0.78,
    plate: {
      bg: "#ffffff",
      text: "#0b0e14",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#101319",
    },
    sponsors: {
      side: "SOLARIS GOLD",
      sideSub: "TEAM JOTA",
      nose: "TEAM JOTA",
      fin: "12",
      rear: "TEAM JOTA",
    },
  },
  {
    id: "lmdh_alpine_36",
    name: "#36 Bleu Endurance",
    team: "Bleu Endurance",
    number: "36",
    pattern: "bleu_endurance",
    finish: "metallic",
    swatch: ["#004ec7", "#11151d", "#e11d2e"],
    primary: "#004ec7",
    secondary: "#11151d",
    accent: "#e11d2e",
    highlight: "#f4f8fc",
    wingColor: "#004ec7",
    wingText: "BLEU ENDURANCE",
    wingTextColor: "#ffffff",
    carbonExposure: 0.85,
    plate: {
      bg: "#ffffff",
      text: "#0a0f1c",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#004ec7",
    },
    sponsors: {
      side: "AETHER FRANCE",
      sideSub: "ENDURANCE",
      nose: "BLEU 424",
      fin: "36",
      rear: "BLEU ENDURANCE",
    },
  },
  {
    id: "lmdh_bavaria_15",
    name: "#15 WRT Hybrid V8",
    team: "Team WRT",
    number: "15",
    pattern: "bavaria_hybrid",
    finish: "satin",
    swatch: ["#12161f", "#009fe3", "#e11d2e"],
    primary: "#12161f",
    secondary: "#f3f6fa",
    accent: "#009fe3",
    highlight: "#e11d2e",
    wingColor: "#12161f",
    wingText: "WRT HYBRID V8",
    wingTextColor: "#ffffff",
    carbonExposure: 0.88,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#009fe3",
    },
    sponsors: {
      side: "TEAM WRT",
      sideSub: "HYBRID V8",
      nose: "WRT HYBRID",
      fin: "15",
      rear: "TEAM WRT HYBRID",
    },
  },
  {
    id: "lmdh_valkyrie_009",
    name: "#009 British Racing Works",
    team: "British Works",
    number: "009",
    pattern: "british_works",
    finish: "metallic",
    swatch: ["#004d3d", "#b4ee00", "#10141a"],
    primary: "#004d3d",
    secondary: "#b4ee00",
    accent: "#10141a",
    highlight: "#f8fafc",
    wingColor: "#004d3d",
    wingText: "BRITISH WORKS",
    wingTextColor: "#b4ee00",
    carbonExposure: 0.8,
    plate: {
      bg: "#ffffff",
      text: "#0a1210",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#b4ee00",
    },
    sponsors: {
      side: "VORTEX WORKS",
      sideSub: "V12 ENDURANCE",
      nose: "VALKYRIE",
      fin: "009",
      rear: "BRITISH WORKS",
    },
  },
  {
    id: "lmdh_gazoo_7",
    name: "#7 Matte Works Kuro",
    team: "Kuro Racing",
    number: "7",
    pattern: "matte_kuro",
    finish: "matte",
    swatch: ["#13161c", "#e11d2e", "#f4f7fb"],
    primary: "#13161c",
    secondary: "#e11d2e",
    accent: "#f4f7fb",
    highlight: "#94a3b8",
    wingColor: "#13161c",
    wingText: "KURO WORKS",
    wingTextColor: "#ffffff",
    carbonExposure: 0.92,
    plate: {
      bg: "#ffffff",
      text: "#0a0d12",
      headerBg: "#e11d2e",
      headerText: "#ffffff",
      headerLabel: "HYPERCAR",
      border: "#e11d2e",
    },
    sponsors: {
      side: "KURO HYBRID",
      sideSub: "TURBINE LABS",
      nose: "GR KURO",
      fin: "7",
      rear: "KURO RACING",
    },
  },
];

export const LMDH_LIVERY_BY_ID: ReadonlyMap<string, LmdhLiverySpec> = new Map(
  LMDH_LIVERIES.map((s) => [s.id, s])
);

export function lmdhLiveryById(id: string): LmdhLiverySpec | undefined {
  return LMDH_LIVERY_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Canvas2D Helpers
// ---------------------------------------------------------------------------

function isCapableCtx(ctx: CanvasRenderingContext2D | null | undefined): ctx is CanvasRenderingContext2D {
  return Boolean(
    ctx &&
      typeof ctx.save === "function" &&
      typeof ctx.beginPath === "function" &&
      typeof ctx.fillRect === "function" &&
      typeof ctx.fillText === "function" &&
      typeof ctx.createLinearGradient === "function"
  );
}

function createCarbonFill(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (typeof document === "undefined" || typeof ctx.createPattern !== "function") return "#111419";
  const tile = document.createElement("canvas");
  tile.width = 16;
  tile.height = 16;
  const tc = tile.getContext("2d");
  if (!tc || typeof tc.fillRect !== "function") return "#111419";
  tc.fillStyle = "#101318";
  tc.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y += 4) {
    for (let x = 0; x < 16; x += 4) {
      const p = ((x + y) / 4) % 4;
      tc.fillStyle = p < 2 ? "#1a1f28" : "#0c0f14";
      tc.fillRect(x, y, 4, 4);
    }
  }
  return ctx.createPattern(tile, "repeat") ?? "#111419";
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], fill: string | CanvasGradient | CanvasPattern) {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], color: string, width: number) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "miter";
  ctx.stroke();
}

function clipRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  draw();
  ctx.restore();
}

interface SideMapper {
  isLeft: boolean;
  x: (zN: number) => number;
  y: (yN: number) => number;
  pts: (coords: readonly (readonly [number, number])[]) => [number, number][];
}

function makeSideMapper(isLeft: boolean): SideMapper {
  const y0 = isLeft ? LEFT_Y : RIGHT_Y;
  const x = (zN: number) => (isLeft ? (1 - zN) * LMDH_ATLAS_SIZE : zN * LMDH_ATLAS_SIZE);
  const y = (yN: number) => y0 + (1 - yN) * SIDE_H;
  return { isLeft, x, y, pts: (coords) => coords.map(([zN, yN]) => [x(zN), y(yN)]) };
}

const topX = (zN: number) => zN * LMDH_ATLAS_SIZE;
const topY = (xN: number) => (0.5 - xN * 0.5) * TOP_H;
const topPts = (coords: readonly (readonly [number, number])[]): [number, number][] =>
  coords.map(([zN, xN]) => [topX(zN), topY(xN)]);

function fillTopMirror(
  ctx: CanvasRenderingContext2D,
  coords: readonly (readonly [number, number])[],
  fill: string | CanvasGradient | CanvasPattern
) {
  fillPoly(ctx, topPts(coords), fill);
  fillPoly(ctx, topPts(coords.map(([z, x]) => [z, -x] as const)), fill);
}

function drawTopText(
  ctx: CanvasRenderingContext2D,
  text: string,
  zN: number,
  xN: number,
  fontPx: number,
  color: string,
  opts?: { italic?: boolean; maxW?: number; outline?: string; outlineW?: number }
) {
  ctx.save();
  ctx.translate(topX(zN), topY(xN));
  ctx.rotate(-Math.PI / 2);
  ctx.font = `${opts?.italic ? "italic " : ""}900 ${fontPx}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (opts?.outline) {
    ctx.strokeStyle = opts.outline;
    ctx.lineWidth = opts.outlineW ?? Math.max(3, fontPx * 0.12);
    ctx.lineJoin = "round";
    ctx.strokeText(text, 0, 0, opts.maxW);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0, opts?.maxW);
  ctx.restore();
}

function drawSideText(
  ctx: CanvasRenderingContext2D,
  m: SideMapper,
  text: string,
  zN: number,
  yN: number,
  fontPx: number,
  color: string,
  opts?: { italic?: boolean; maxW?: number; outline?: string; outlineW?: number }
) {
  ctx.save();
  ctx.translate(m.x(zN), m.y(yN));
  ctx.font = `${opts?.italic ? "italic " : ""}900 ${fontPx}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (opts?.outline) {
    ctx.strokeStyle = opts.outline;
    ctx.lineWidth = opts.outlineW ?? Math.max(3, fontPx * 0.12);
    ctx.lineJoin = "round";
    ctx.strokeText(text, 0, 0, opts.maxW);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0, opts?.maxW);
  ctx.restore();
}

function drawHypercarPlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  number: string,
  style: LmdhLiverySpec["plate"],
  rotationRad = 0
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotationRad);
  const x0 = -w / 2;
  const y0 = -h / 2;
  const headerH = h * 0.25;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x0 + 3, y0 + 3, w, h);
  ctx.fillStyle = style.bg;
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = style.headerBg;
  ctx.fillRect(x0, y0, w, headerH);
  ctx.strokeStyle = style.border;
  ctx.lineWidth = Math.max(2.5, w * 0.025);
  ctx.strokeRect(x0, y0, w, h);
  ctx.fillStyle = style.headerText;
  ctx.font = `900 ${Math.round(headerH * 0.64)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.headerLabel, 0, y0 + headerH * 0.54, w * 0.92);
  const numPx = Math.round(h * (number.length >= 3 ? 0.44 : number.length === 2 ? 0.54 : 0.60));
  ctx.fillStyle = style.text;
  ctx.font = `italic 900 ${numPx}px "Arial Black", Impact, Arial, sans-serif`;
  ctx.fillText(number, -1, y0 + headerH + (h - headerH) * 0.54, w * 0.88);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 7 Bespoke Prototype Livery Pattern Painters
// ---------------------------------------------------------------------------

function paintLmdhPattern(
  ctx: CanvasRenderingContext2D,
  spec: LmdhLiverySpec,
  carbonFill: CanvasPattern | string
) {
  ctx.fillStyle = spec.primary;
  ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, LMDH_ATLAS_SIZE);

  const paintTop = (fn: () => void) => clipRect(ctx, 0, 0, LMDH_ATLAS_SIZE, TOP_H, fn);
  const paintSides = (fn: (m: SideMapper) => void) => {
    for (const isLeft of [true, false]) {
      const m = makeSideMapper(isLeft);
      clipRect(ctx, 0, isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H, () => fn(m));
    }
  };
  const paintRear = (fn: () => void) => clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, fn);
  const paintFront = (fn: () => void) => clipRect(ctx, HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H, fn);

  switch (spec.pattern) {
    // 1. #51 SCUDERIA ROSSA (Ferrari 499P Le Mans Winner tribute)
    case "rossa": {
      paintTop(() => {
        // Bold Modena yellow longitudinal nose-to-cockpit racing arrow
        fillPoly(
          ctx,
          topPts([
            [0.42, -0.16],
            [0.98, -0.09],
            [0.98, 0.09],
            [0.42, 0.16],
          ]),
          spec.secondary
        );
        // Sculpted yellow diagonal sweeps across outer front fenders & cockpit shoulders
        fillTopMirror(
          ctx,
          [
            [0.64, 0.24],
            [0.92, 0.56],
            [0.86, 0.64],
            [0.58, 0.30],
          ],
          spec.secondary
        );
        // Gloss carbon black rear deck engine bay accents
        fillTopMirror(
          ctx,
          [
            [0.10, 0.16],
            [0.42, 0.24],
            [0.42, 0.52],
            [0.10, 0.46],
          ],
          carbonFill
        );
      });

      paintSides((m) => {
        // Exposed carbon lower sill
        fillPoly(ctx, m.pts([[0.0, 0.0], [1.0, 0.0], [1.0, 0.14], [0.0, 0.14]]), carbonFill);
        // Iconic diagonal Modena-yellow blade slicing from front fender across sidepod up onto the shark fin!
        fillPoly(
          ctx,
          m.pts([
            [0.88, 0.14],
            [0.96, 0.14],
            [0.54, 0.56],
            [0.42, 0.56],
          ]),
          spec.secondary
        );
        // Yellow shark fin leading spine + crimson body
        fillPoly(
          ctx,
          m.pts([
            [0.14, 0.54],
            [0.48, 0.54],
            [0.46, 0.98],
            [0.36, 0.98],
            [0.14, 0.72],
          ]),
          spec.primary
        );
        fillPoly(
          ctx,
          m.pts([
            [0.14, 0.72],
            [0.38, 0.98],
            [0.24, 0.98],
            [0.12, 0.84],
          ]),
          spec.secondary
        );
        // Yellow diagonal rear wing endplate flash
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.primary);
        fillPoly(ctx, m.pts([[0.01, 0.52], [0.09, 0.74], [0.09, 0.86], [0.01, 0.64]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W + HALF_W * 0.14, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W * 0.72, 22);
      });
      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W, 18);
      });
      break;
    }

    // 2. #6 STUTTGART PENSKE (Porsche 963 Factory Works tribute)
    case "penske": {
      paintTop(() => {
        // Bold blazing crimson nose & leading hood chevron
        fillPoly(
          ctx,
          topPts([
            [0.64, -1.0],
            [1.0, -1.0],
            [1.0, 1.0],
            [0.64, 1.0],
            [0.78, 0.0],
          ]),
          spec.secondary
        );
        // Stealth carbon-black center cockpit canopy & engine cover arrow!
        fillPoly(
          ctx,
          topPts([
            [0.08, -0.44],
            [0.68, -0.26],
            [0.80, 0.0],
            [0.68, 0.26],
            [0.08, 0.44],
          ]),
          spec.accent
        );
        // Crisp gold metallic pinstripe separating crimson nose from black canopy arrow
        fillTopMirror(
          ctx,
          [
            [0.68, 0.26],
            [0.80, 0.0],
            [0.825, 0.0],
            [0.70, 0.28],
          ],
          spec.highlight
        );
        // Red rear fender spears
        fillTopMirror(
          ctx,
          [
            [0.08, 0.64],
            [0.32, 0.72],
            [0.36, 1.0],
            [0.08, 1.0],
          ],
          spec.secondary
        );
      });

      paintSides((m) => {
        // Tri-color Works split: crimson front nose -> stark white mid-flank -> carbon black rear & shark fin!
        fillPoly(ctx, m.pts([[0.68, 0.0], [1.0, 0.0], [1.0, 0.66], [0.76, 0.66]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.0, 0.0], [0.34, 0.0], [0.22, 0.72], [0.0, 0.72]]), spec.accent);
        // Iconic black & red forward-thrusting Penske stripe across the white sidepod
        fillPoly(ctx, m.pts([[0.22, 0.34], [0.74, 0.30], [0.76, 0.40], [0.20, 0.46]]), spec.accent);
        fillPoly(ctx, m.pts([[0.20, 0.46], [0.76, 0.40], [0.77, 0.45], [0.19, 0.52]]), spec.secondary);
        // Shark fin: matte black with crimson diagonal top slash & white border
        fillPoly(ctx, m.pts([[0.12, 0.52], [0.50, 0.52], [0.48, 1.0], [0.12, 1.0]]), spec.accent);
        fillPoly(ctx, m.pts([[0.12, 0.72], [0.36, 1.0], [0.48, 1.0], [0.18, 0.62]]), spec.secondary);
        // Rear wing endplate: white with red/black bars
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.primary);
        fillPoly(ctx, m.pts([[0.0, 0.72], [0.095, 0.72], [0.095, 1.0], [0.0, 1.0]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H * 0.78);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 14);
      });
      paintRear(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.56, HALF_W, 20);
      });
      break;
    }

    // 3. #12 JOTA GOLD (Hertz Team JOTA metallic gold & obsidian black tribute)
    case "jota_gold": {
      paintTop(() => {
        const g = ctx.createLinearGradient(0, 0, LMDH_ATLAS_SIZE, 0);
        g.addColorStop(0, "#b28416");
        g.addColorStop(0.5, "#e6ba3a");
        g.addColorStop(1, "#c4941d");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, TOP_H);

        // Obsidian black sculpted nose V-hood & canopy frame
        fillPoly(
          ctx,
          topPts([
            [0.08, -0.34],
            [0.64, -0.30],
            [0.92, -0.14],
            [0.92, 0.14],
            [0.64, 0.30],
            [0.08, 0.34],
          ]),
          spec.secondary
        );
        // Stark white speed outlines flanking the obsidian spine
        fillTopMirror(
          ctx,
          [
            [0.08, 0.34],
            [0.64, 0.30],
            [0.92, 0.14],
            [0.92, 0.175],
            [0.64, 0.34],
            [0.08, 0.38],
          ],
          spec.accent
        );
        // Red front splitter accents
        fillTopMirror(ctx, [[0.92, 0.45], [1.0, 0.52], [1.0, 0.68], [0.92, 0.60]], spec.highlight);
      });

      paintSides((m) => {
        const g = ctx.createLinearGradient(0, m.isLeft ? LEFT_Y : RIGHT_Y, 0, (m.isLeft ? LEFT_Y : RIGHT_Y) + SIDE_H);
        g.addColorStop(0, "#e6ba3a");
        g.addColorStop(0.55, "#c9981f");
        g.addColorStop(1, "#8c640d");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H);

        // Sleek obsidian-black lower sidepod & rear haunch wrap
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.0],
            [0.94, 0.0],
            [0.88, 0.22],
            [0.28, 0.24],
            [0.14, 0.52],
            [0.0, 0.56],
          ]),
          spec.secondary
        );
        strokePolyline(ctx, m.pts([[0.90, 0.22], [0.28, 0.24], [0.14, 0.52], [0.0, 0.56]]), spec.accent, 8);
        // Obsidian black shark fin with metallic gold trailing wedge
        fillPoly(ctx, m.pts([[0.12, 0.52], [0.50, 0.52], [0.48, 1.0], [0.12, 1.0]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.12, 0.52], [0.24, 0.52], [0.14, 0.92], [0.12, 0.92]]), spec.primary);
        // Wing endplate: obsidian with gold stripe
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.02, 0.50], [0.075, 0.50], [0.075, 0.94], [0.02, 0.94]]), spec.primary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 30);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W + HALF_W * 0.2, BOTTOM_Y + BOTTOM_H * 0.56, HALF_W * 0.6, 10);
      });
      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.primary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.56, HALF_W, 24);
      });
      break;
    }

    // 4. #36 BLEU ENDURANCE (Alpine A424 French Hypercar tribute)
    case "bleu_endurance": {
      paintTop(() => {
        // Electric French blue front fading into stealth carbon rear deck
        const g = ctx.createLinearGradient(LMDH_ATLAS_SIZE, 0, 0, 0);
        g.addColorStop(0.0, "#0058e6");
        g.addColorStop(0.42, "#003fa8");
        g.addColorStop(0.62, "#121722");
        g.addColorStop(1.0, "#0d1016");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, TOP_H);

        // Bold angular French Tricolore "A" arrow sweeping over the nose & fenders!
        fillTopMirror(
          ctx,
          [
            [0.98, 0.0],
            [0.62, 0.66],
            [0.52, 0.66],
            [0.86, 0.0],
          ],
          spec.highlight
        );
        fillTopMirror(
          ctx,
          [
            [0.86, 0.0],
            [0.52, 0.66],
            [0.44, 0.66],
            [0.76, 0.0],
          ],
          spec.accent
        );
      });

      paintSides((m) => {
        const g = ctx.createLinearGradient(m.x(1), 0, m.x(0), 0);
        g.addColorStop(0.0, "#0058e6");
        g.addColorStop(0.46, "#003ea6");
        g.addColorStop(0.64, "#11151d");
        g.addColorStop(1.0, "#0c1016");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H);

        // Sharp tricolore slashes climbing diagonally from sidepod up onto the shark fin
        fillPoly(ctx, m.pts([[0.52, 0.14], [0.60, 0.14], [0.34, 0.98], [0.26, 0.98]]), spec.highlight);
        fillPoly(ctx, m.pts([[0.44, 0.14], [0.52, 0.14], [0.26, 0.98], [0.18, 0.98]]), spec.accent);
        // Blue & red wing endplate
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.primary);
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.032, 0.42], [0.032, 1.0], [0.0, 1.0]]), spec.accent);
        fillPoly(ctx, m.pts([[0.032, 0.42], [0.06, 0.42], [0.06, 1.0], [0.032, 1.0]]), spec.highlight);
      });

      paintFront(() => {
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 14);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.70, HALF_W, 14);
      });
      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.58, HALF_W * 0.34, 22);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W * 0.34, BOTTOM_Y + BOTTOM_H * 0.58, HALF_W * 0.32, 22);
        ctx.fillStyle = spec.primary;
        ctx.fillRect(HALF_W * 0.66, BOTTOM_Y + BOTTOM_H * 0.58, HALF_W * 0.34, 22);
      });
      break;
    }

    // 5. #15 WRT HYBRID V8 (BMW M Hybrid V8 fractured M-shard livery tribute)
    case "bavaria_hybrid": {
      const mSky = "#009fe3";
      const mNavy = "#1b2f7a";
      const mRed = "#e11d2e";

      paintTop(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, TOP_H);

        // Bold fractured Alpine White + M tri-color angular shards slicing asymmetrically across nose & canopy!
        fillPoly(ctx, topPts([[0.74, -1.0], [1.0, -0.55], [0.88, 0.42], [0.56, 0.12]]), spec.secondary);
        fillPoly(ctx, topPts([[0.36, -0.25], [0.68, 0.30], [0.52, 1.0], [0.16, 0.72]]), spec.secondary);
        fillPoly(ctx, topPts([[0.64, -0.82], [0.76, -0.82], [0.46, 0.88], [0.34, 0.88]]), mSky);
        fillPoly(ctx, topPts([[0.54, -0.82], [0.64, -0.82], [0.34, 0.88], [0.24, 0.88]]), mNavy);
        fillPoly(ctx, topPts([[0.44, -0.82], [0.54, -0.82], [0.24, 0.88], [0.14, 0.88]]), mRed);
      });

      paintSides((m) => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H);

        // Fractured geometric white & M-color shards sweeping from front fender across sidepod & shark fin
        fillPoly(ctx, m.pts([[0.58, 0.12], [0.96, 0.12], [0.88, 0.56], [0.48, 0.48]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.46, 0.10], [0.56, 0.10], [0.34, 0.98], [0.24, 0.98]]), mSky);
        fillPoly(ctx, m.pts([[0.36, 0.10], [0.46, 0.10], [0.24, 0.98], [0.14, 0.98]]), mNavy);
        fillPoly(ctx, m.pts([[0.26, 0.10], [0.36, 0.10], [0.14, 0.98], [0.06, 0.98]]), mRed);

        // Wing endplate with vertical M-stripes
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), "#12161f");
        fillPoly(ctx, m.pts([[0.015, 0.48], [0.04, 0.48], [0.04, 0.94], [0.015, 0.94]]), mSky);
        fillPoly(ctx, m.pts([[0.04, 0.48], [0.065, 0.48], [0.065, 0.94], [0.04, 0.94]]), mNavy);
        fillPoly(ctx, m.pts([[0.065, 0.48], [0.088, 0.48], [0.088, 0.94], [0.065, 0.94]]), mRed);
      });

      paintFront(() => {
        ctx.fillStyle = mSky;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.34, 22);
        ctx.fillStyle = mNavy;
        ctx.fillRect(HALF_W + HALF_W * 0.34, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.32, 22);
        ctx.fillStyle = mRed;
        ctx.fillRect(HALF_W + HALF_W * 0.66, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.34, 22);
      });
      paintRear(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = mRed;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 18);
      });
      break;
    }

    // 6. #009 BRITISH RACING WORKS (Emerald Green & electric acid-lime aero pinstripe tribute)
    case "british_works": {
      paintTop(() => {
        const g = ctx.createLinearGradient(0, 0, LMDH_ATLAS_SIZE, 0);
        g.addColorStop(0, "#00352a");
        g.addColorStop(0.5, "#005a47");
        g.addColorStop(1, "#004637");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, TOP_H);

        // Exposed carbon rear deck louvres
        fillTopMirror(ctx, [[0.10, 0.14], [0.46, 0.20], [0.46, 0.46], [0.10, 0.42]], carbonFill);

        // Razor acid-lime aero contour stripes tracing nose tip, fenders, and cockpit canopy!
        fillTopMirror(
          ctx,
          [
            [0.98, 0.08],
            [0.72, 0.40],
            [0.10, 0.52],
            [0.10, 0.58],
            [0.72, 0.46],
            [0.98, 0.15],
          ],
          spec.secondary
        );
        // Acid-lime nose lip arch
        fillPoly(ctx, topPts([[0.95, -0.45], [1.0, -0.52], [1.0, 0.52], [0.95, 0.45]]), spec.secondary);
      });

      paintSides((m) => {
        const g = ctx.createLinearGradient(0, m.isLeft ? LEFT_Y : RIGHT_Y, 0, (m.isLeft ? LEFT_Y : RIGHT_Y) + SIDE_H);
        g.addColorStop(0, "#005a47");
        g.addColorStop(0.6, "#004637");
        g.addColorStop(1, "#002b21");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H);

        // Carbon lower floor edge + electric acid-lime flowing aero ribbon along entire flank
        fillPoly(ctx, m.pts([[0.0, 0.0], [1.0, 0.0], [1.0, 0.14], [0.0, 0.14]]), carbonFill);
        fillPoly(ctx, m.pts([[0.04, 0.14], [0.98, 0.14], [0.98, 0.20], [0.04, 0.20]]), spec.secondary);
        strokePolyline(
          ctx,
          m.pts([
            [0.96, 0.42],
            [0.64, 0.48],
            [0.34, 0.44],
            [0.12, 0.56],
          ]),
          spec.secondary,
          10
        );
        // Shark fin spine in blazing acid lime
        fillPoly(ctx, m.pts([[0.12, 0.88], [0.46, 0.88], [0.48, 1.0], [0.12, 1.0]]), spec.secondary);
        // Wing endplate: dark emerald with bright lime edge
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.primary);
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.025, 0.42], [0.025, 1.0], [0.0, 1.0]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.66, HALF_W, 22);
      });
      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 20);
      });
      break;
    }

    // 7. #7 MATTE WORKS KURO (Toyota GR010 Stealth Matte Black & Crimson tribute)
    case "matte_kuro": {
      paintTop(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, LMDH_ATLAS_SIZE, TOP_H);

        // Aggressive crimson & stark white Japanese diagonal speed slashes across nose & front fenders
        fillTopMirror(
          ctx,
          [
            [0.98, 0.18],
            [0.98, 0.34],
            [0.62, 0.68],
            [0.54, 0.56],
          ],
          spec.secondary
        );
        fillTopMirror(
          ctx,
          [
            [0.92, 0.36],
            [0.92, 0.42],
            [0.56, 0.76],
            [0.52, 0.70],
          ],
          spec.accent
        );
        // Crimson cockpit canopy halo rim
        fillTopMirror(ctx, [[0.44, 0.28], [0.70, 0.24], [0.70, 0.30], [0.44, 0.34]], spec.secondary);
      });

      paintSides((m) => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H);

        // Razor crimson lower sill + aggressive angular white & red sidepod blades
        fillPoly(ctx, m.pts([[0.02, 0.11], [0.98, 0.11], [0.98, 0.17], [0.02, 0.17]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.64, 0.17], [0.74, 0.17], [0.56, 0.52], [0.48, 0.52]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.76, 0.17], [0.81, 0.17], [0.63, 0.50], [0.59, 0.50]]), spec.accent);

        // Bold crimson rear fin accent
        fillPoly(ctx, m.pts([[0.12, 0.54], [0.22, 0.54], [0.16, 1.0], [0.12, 1.0]]), spec.secondary);
        // Wing endplate: stealth black with crimson top bar
        fillPoly(ctx, m.pts([[0.0, 0.42], [0.095, 0.42], [0.095, 1.0], [0.0, 1.0]]), spec.primary);
        fillPoly(ctx, m.pts([[0.0, 0.84], [0.095, 0.84], [0.095, 1.0], [0.0, 1.0]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.66, HALF_W, 20);
      });
      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 18);
      });
      break;
    }
  }
}

function paintLmdhBranding(ctx: CanvasRenderingContext2D, spec: LmdhLiverySpec) {
  const isLightSide = spec.pattern === "penske" || spec.pattern === "jota_gold" || spec.pattern === "bavaria_hybrid";
  const sideTextColor =
    spec.pattern === "penske" || spec.pattern === "jota_gold" || spec.pattern === "bavaria_hybrid" ? "#0d1118" : "#ffffff";
  const sideSubColor =
    spec.pattern === "rossa"
      ? "#f2c200"
      : spec.pattern === "british_works"
        ? "#b4ee00"
        : spec.pattern === "bavaria_hybrid"
          ? "#0069a8"
          : spec.pattern === "matte_kuro"
            ? "#e11d2e"
            : spec.pattern === "jota_gold"
              ? "#ffffff"
              : "#e11d2e";
  const sideOutline = isLightSide ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.72)";

  // 1) TOP PANEL: Rear wing mainplane banner + wide flat prototype nose wordmark & Hypercar plate
  clipRect(ctx, 0, 0, LMDH_ATLAS_SIZE, TOP_H, () => {
    // Rear wing mainplane (zN 0.00..0.09)
    ctx.fillStyle = spec.wingColor;
    ctx.fillRect(0, topY(0.92), topX(0.095), topY(-0.92) - topY(0.92));
    drawTopText(ctx, spec.wingText, 0.048, 0, 44, spec.wingTextColor, { maxW: TOP_H * 0.78 });

    // Authentic WEC Hypercar nose number plate centered squarely on the flat nose spine ahead of the cockpit!
    drawHypercarPlate(ctx, topX(0.795), topY(0.0), 96, 88, spec.number, spec.plate, -Math.PI / 2);

    // Compact crisp nose sponsor wordmark right ahead of the plate on the flat central nose channel
    const noseTextCol =
      spec.pattern === "penske" || spec.pattern === "rossa" || spec.pattern === "matte_kuro" || spec.pattern === "british_works"
        ? "#ffffff"
        : spec.pattern === "bleu_endurance"
          ? "#003087"
          : "#0d1118";
    drawTopText(ctx, spec.sponsors.nose, 0.905, 0, 34, noseTextCol, {
      italic: true,
      maxW: 205,
      outline: noseTextCol === "#ffffff" ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.8)",
      outlineW: 5,
    });

    // Subtle roof canopy class ID
    drawTopText(ctx, spec.number, 0.56, 0, 70, "#ffffff", {
      italic: true,
      outline: "rgba(0,0,0,0.75)",
      outlineW: 6,
    });
  });

  // 2) LEFT & RIGHT SIDES: Giant Shark Fin number + Shark Fin sponsor + clean rear sidepod Hypercar plate!
  for (const isLeft of [true, false]) {
    const m = makeSideMapper(isLeft);
    clipRect(ctx, 0, isLeft ? LEFT_Y : RIGHT_Y, LMDH_ATLAS_SIZE, SIDE_H, () => {
      // GIANT SHARK FIN RACING NUMBER centered cleanly on the wide vertical shark fin belly (zN 0.23, yN 0.78)!
      const finNumColor =
        spec.pattern === "rossa"
          ? "#ffffff"
          : spec.pattern === "jota_gold"
            ? "#f2c641"
            : spec.pattern === "british_works"
              ? "#b4ee00"
              : "#ffffff";
      drawSideText(ctx, m, spec.sponsors.fin, 0.23, 0.78, spec.number.length >= 3 ? 76 : 98, finNumColor, {
        italic: true,
        maxW: 200,
        outline: "rgba(0,0,0,0.8)",
        outlineW: 8,
      });

      // Shark fin team/title sponsor directly below the number on the flat vertical fin!
      drawSideText(ctx, m, spec.sponsors.side, 0.225, 0.62, 22, "#ffffff", {
        italic: true,
        maxW: 200,
        outline: "rgba(0,0,0,0.85)",
        outlineW: 4,
      });

      // Rear sidepod framed Hypercar number plate (smooth flat sidepod flank behind intake undercut: zN 0.36, yN 0.24)
      drawHypercarPlate(ctx, m.x(0.36), m.y(0.245), 112, 98, spec.number, spec.plate);

      // Compact clean sponsor badge on the flat lower front sidepod flank (below the air intake undercut: zN 0.625, yN 0.17)
      drawSideText(ctx, m, spec.sponsors.side, 0.625, 0.185, 22, sideTextColor, {
        italic: true,
        maxW: 165,
        outline: sideOutline,
        outlineW: 4,
      });
      drawSideText(ctx, m, spec.sponsors.sideSub, 0.625, 0.115, 13, sideSubColor, {
        maxW: 145,
        outline: "rgba(0,0,0,0.7)",
        outlineW: 2.5,
      });

      // Front fender aero tag (ahead of front wheel at zN 0.89, yN 0.29)
      drawSideText(ctx, m, "HYPERCAR", 0.895, 0.29, 14, "#ffffff", {
        maxW: 105,
        outline: "rgba(0,0,0,0.75)",
        outlineW: 3,
      });
    });
  }

  // 3) REAR PANEL: Chase-cam rear wing trailing banner
  clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    ctx.fillStyle = spec.wingColor;
    ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H * 0.30);
    ctx.fillStyle = spec.wingTextColor;
    ctx.font = 'italic 900 44px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.wingText, HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.16, HALF_W * 0.84);

    ctx.fillStyle = "#ffffff";
    ctx.font = 'italic 900 30px "Arial Black", Arial, sans-serif';
    ctx.fillText(spec.sponsors.rear, HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.52, HALF_W * 0.72);
  });
}

export function renderLmdhLiveryToContext(
  ctx: CanvasRenderingContext2D,
  spec: LmdhLiverySpec,
  pixelSize = LMDH_ATLAS_SIZE
): void {
  if (!isCapableCtx(ctx)) {
    const partial = ctx as Partial<CanvasRenderingContext2D> | null | undefined;
    if (partial && typeof partial.fillRect === "function") {
      partial.fillStyle = spec.primary;
      partial.fillRect(0, 0, pixelSize, pixelSize);
    }
    return;
  }
  const scale = pixelSize / LMDH_ATLAS_SIZE;
  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);
  const carbonFill = createCarbonFill(ctx);
  paintLmdhPattern(ctx, spec, carbonFill);
  paintLmdhBranding(ctx, spec);
  ctx.restore();
}

const lmdhAtlasCache = new Map<string, THREE.CanvasTexture>();

export function getLmdhLiveryAtlasTexture(id: string): THREE.CanvasTexture | null {
  const spec = lmdhLiveryById(id);
  if (!spec || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const hit = lmdhAtlasCache.get(id);
  if (hit) return hit;

  const size =
    typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth < 768
      ? 1024
      : LMDH_ATLAS_SIZE;
  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function") return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!isCapableCtx(ctx)) return null;

  renderLmdhLiveryToContext(ctx, spec, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `lmdh_livery_atlas_${id}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  lmdhAtlasCache.set(id, tex);
  return tex;
}

export function clearLmdhLiveryCache(): void {
  for (const tex of lmdhAtlasCache.values()) tex.dispose();
  lmdhAtlasCache.clear();
}
