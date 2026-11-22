import * as THREE from "three";
import type { LiveryFinish } from "@/types/f1";

/**
 * Procedural 2048px "Middle Gear" comedy livery painter for the 2002 Suzuki Liana 1.6 (`liana_body_paint`).
 *
 * Features hand-crafted comic caricature portraits of the iconic British motoring trio (Clarkson, Hammond, May)
 * across the hood and doors, custom cogwheel "MIDDLE GEAR" branding, Union Jack roof, crooked masking-taped
 * `#106` (106 BHP) race plates, hazard chevrons, and classic chase-cam bumper stickers.
 */

export const LIANA_ATLAS_SIZE = 2048;

const TOP_H = 832;
const SIDE_H = 448;
const LEFT_Y = TOP_H;
const RIGHT_Y = LEFT_Y + SIDE_H;
const BOTTOM_Y = RIGHT_Y + SIDE_H;
const BOTTOM_H = LIANA_ATLAS_SIZE - BOTTOM_Y;
const HALF_W = LIANA_ATLAS_SIZE / 2;

export interface LianaLiverySpec {
  id: string;
  name: string;
  finish: LiveryFinish;
  swatch: readonly [string, string, string];
  carbonExposure: number;
}

export const LIANA_LIVERIES: readonly LianaLiverySpec[] = [
  {
    id: "liana_middle_gear",
    name: "#106 Middle Gear Special",
    finish: "gloss",
    swatch: ["#0d5634", "#f0c800", "#ff5a00"],
    carbonExposure: 0.25,
  },
];

export const LIANA_LIVERY_BY_ID: ReadonlyMap<string, LianaLiverySpec> = new Map(
  LIANA_LIVERIES.map((s) => [s.id, s])
);

export function lianaLiveryById(id: string): LianaLiverySpec | undefined {
  return LIANA_LIVERY_BY_ID.get(id);
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

function clipRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, draw: () => void) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  draw();
  ctx.restore();
}

const topX = (zN: number) => zN * LIANA_ATLAS_SIZE;
const topY = (xN: number) => (0.5 - xN * 0.5) * TOP_H;

interface SideMapper {
  isLeft: boolean;
  x: (zN: number) => number;
  y: (yN: number) => number;
}

function makeSideMapper(isLeft: boolean): SideMapper {
  const y0 = isLeft ? LEFT_Y : RIGHT_Y;
  return {
    isLeft,
    x: (zN: number) => (isLeft ? (1 - zN) * LIANA_ATLAS_SIZE : zN * LIANA_ATLAS_SIZE),
    y: (yN: number) => y0 + (1 - yN) * SIDE_H,
  };
}

function drawEll(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill: string,
  stroke?: string,
  lineW = 3
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.restore();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineW;
    ctx.stroke();
  }
}

/** Draws a bold comic speech bubble with pointer tail */
function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  text: string,
  tailDx: number,
  tailDy: number,
  bg = "#fffef2",
  fg = "#111318"
) {
  ctx.save();
  const r = Math.min(h * 0.35, 16);
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;

  // Tail triangle
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy + (tailDy > 0 ? h * 0.35 : -h * 0.35));
  ctx.lineTo(cx + tailDx, cy + tailDy);
  ctx.lineTo(cx + 10, cy + (tailDy > 0 ? h * 0.35 : -h * 0.35));
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3.5;
  ctx.stroke();

  // Rounded pill body
  ctx.beginPath();
  ctx.moveTo(x0 + r, y0);
  ctx.lineTo(x0 + w - r, y0);
  ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  ctx.lineTo(x0 + w, y0 + h - r);
  ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  ctx.lineTo(x0 + r, y0 + h);
  ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  ctx.lineTo(x0, y0 + r);
  ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3.5;
  ctx.stroke();

  ctx.fillStyle = fg;
  ctx.font = `900 ${Math.round(h * 0.56)}px "Arial Black", "Comic Sans MS", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 1, w * 0.9);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Hand-Crafted Expressive Comic Caricature Portraits (Clarkson, Hammond, May)
// ---------------------------------------------------------------------------

/** Sticker circular medallion backdrop behind each caricature portrait */
function drawPortraitMedallion(ctx: CanvasRenderingContext2D, r: number, bg: string, ring: string) {
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.08, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = Math.max(4, r * 0.08);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = Math.max(3, r * 0.05);
  ctx.stroke();
}

/**
 * 1. CLARKSON CARICATURE:
 * Wild curly grey-brown mop, broad rosy cheeks, big prominent nose, bushy raised mischievous brows,
 * huge smug wide-open shouting grin, denim shirt & navy jacket collar!
 */
function drawClarksonFace(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const s = radius / 100;

  drawPortraitMedallion(ctx, 100 * s, "#1e3a5f", "#f0c800");

  // Clip lower shoulders nicely inside the sticker circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 95 * s, 0, Math.PI * 2);
  ctx.clip();

  // Navy blazer + open blue denim shirt collar
  drawEll(ctx, 0, 88 * s, 72 * s, 38 * s, "#1c2842", "#0c1018", 3 * s);
  ctx.beginPath();
  ctx.moveTo(-26 * s, 56 * s);
  ctx.lineTo(0, 96 * s);
  ctx.lineTo(26 * s, 56 * s);
  ctx.closePath();
  ctx.fillStyle = "#5b89c4";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 2.5 * s;
  ctx.stroke();

  // Neck
  ctx.fillStyle = "#e6ae8c";
  ctx.fillRect(-20 * s, 38 * s, 40 * s, 32 * s);
  ctx.restore();

  // Ears
  drawEll(ctx, -56 * s, 4 * s, 12 * s, 18 * s, "#edb896", "#111318", 3 * s);
  drawEll(ctx, 56 * s, 4 * s, 12 * s, 18 * s, "#edb896", "#111318", 3 * s);

  // Broad square-jawed head
  ctx.beginPath();
  ctx.moveTo(-50 * s, -42 * s);
  ctx.quadraticCurveTo(0, -68 * s, 50 * s, -42 * s);
  ctx.quadraticCurveTo(60 * s, 8 * s, 46 * s, 46 * s);
  ctx.quadraticCurveTo(0, 68 * s, -46 * s, 46 * s);
  ctx.quadraticCurveTo(-60 * s, 8 * s, -50 * s, -42 * s);
  ctx.closePath();
  ctx.fillStyle = "#f2bfa0";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3.5 * s;
  ctx.stroke();

  // Rosy British cheeks + double chin crease
  drawEll(ctx, -32 * s, 14 * s, 14 * s, 9 * s, "rgba(220,90,90,0.32)");
  drawEll(ctx, 32 * s, 14 * s, 14 * s, 9 * s, "rgba(220,90,90,0.32)");
  ctx.beginPath();
  ctx.moveTo(-18 * s, 48 * s);
  ctx.quadraticCurveTo(0, 56 * s, 18 * s, 48 * s);
  ctx.strokeStyle = "#b57b5b";
  ctx.lineWidth = 3 * s;
  ctx.stroke();

  // Iconic wild curly salt-and-pepper hair mop (puffed wide on top & sides!)
  const curls: readonly [number, number, number, string][] = [
    [-50, -34, 21, "#8d8a84"],
    [50, -34, 21, "#8d8a84"],
    [-44, -54, 23, "#a8a49d"],
    [44, -54, 23, "#a8a49d"],
    [-24, -68, 24, "#96918a"],
    [24, -68, 24, "#96918a"],
    [0, -72, 26, "#b8b4ad"],
    [-34, -46, 17, "#76726c"],
    [34, -46, 17, "#76726c"],
    [-12, -58, 19, "#cbc7c0"],
    [14, -58, 18, "#827e78"],
    [-55, -16, 14, "#7a7670"],
    [55, -16, 14, "#7a7670"],
  ];
  for (const [hx, hy, hr, col] of curls) {
    drawEll(ctx, hx * s, hy * s, hr * s, hr * 0.88 * s, col, "#1a1a1a", 2.5 * s);
  }

  // Forehead expression creases
  ctx.strokeStyle = "#be8362";
  ctx.lineWidth = 2.2 * s;
  ctx.beginPath();
  ctx.moveTo(-22 * s, -34 * s);
  ctx.quadraticCurveTo(0, -38 * s, 22 * s, -34 * s);
  ctx.stroke();

  // Bushy mischievous arched eyebrows
  ctx.strokeStyle = "#5c5750";
  ctx.lineWidth = 6.5 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-36 * s, -18 * s);
  ctx.quadraticCurveTo(-22 * s, -28 * s, -8 * s, -18 * s);
  ctx.moveTo(8 * s, -18 * s);
  ctx.quadraticCurveTo(22 * s, -28 * s, 36 * s, -18 * s);
  ctx.stroke();

  // Squinty smug eyes
  drawEll(ctx, -22 * s, -6 * s, 11 * s, 7.5 * s, "#ffffff", "#111318", 2.5 * s);
  drawEll(ctx, 22 * s, -6 * s, 11 * s, 7.5 * s, "#ffffff", "#111318", 2.5 * s);
  drawEll(ctx, -21 * s, -6 * s, 4.5 * s, 4.5 * s, "#2c5f8a");
  drawEll(ctx, 21 * s, -6 * s, 4.5 * s, 4.5 * s, "#2c5f8a");
  drawEll(ctx, -20 * s, -7 * s, 1.8 * s, 1.8 * s, "#ffffff");
  drawEll(ctx, 22 * s, -7 * s, 1.8 * s, 1.8 * s, "#ffffff");

  // Prominent comic rounded nose
  drawEll(ctx, 0, 10 * s, 12 * s, 10 * s, "#e7a685", "#111318", 2.5 * s);
  drawEll(ctx, -7 * s, 12 * s, 5 * s, 4 * s, "#df9a78");
  drawEll(ctx, 7 * s, 12 * s, 5 * s, 4 * s, "#df9a78");

  // HUGE smug wide-open shouting grin ("POWERRR!")
  ctx.beginPath();
  ctx.moveTo(-34 * s, 22 * s);
  ctx.quadraticCurveTo(0, 20 * s, 34 * s, 22 * s);
  ctx.quadraticCurveTo(30 * s, 48 * s, 0, 48 * s);
  ctx.quadraticCurveTo(-30 * s, 48 * s, -34 * s, 22 * s);
  ctx.closePath();
  ctx.fillStyle = "#5c1118";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3 * s;
  ctx.stroke();
  // Big white shouting teeth bar
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(-26 * s, 23 * s, 52 * s, 10 * s);
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(-26 * s, 23 * s, 52 * s, 10 * s);
  // Tongue
  drawEll(ctx, 0, 42 * s, 14 * s, 6 * s, "#e05a6d");

  ctx.restore();
}

/**
 * 2. HAMMOND CARICATURE ("HAMSTER"):
 * Noticeably smaller/cheeky oval head, spiky dark-brown hair, neat goatee/soul-patch,
 * blindingly white toothy grin with comic sparkle glint, brown leather jacket!
 */
function drawHammondFace(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const s = radius / 100;

  drawPortraitMedallion(ctx, 100 * s, "#9c2218", "#f0c800");

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 95 * s, 0, Math.PI * 2);
  ctx.clip();
  // Brown leather biker jacket + white tee
  drawEll(ctx, 0, 92 * s, 66 * s, 38 * s, "#3d2415", "#111318", 3 * s);
  ctx.beginPath();
  ctx.moveTo(-20 * s, 62 * s);
  ctx.lineTo(0, 96 * s);
  ctx.lineTo(20 * s, 62 * s);
  ctx.closePath();
  ctx.fillStyle = "#f4f6fa";
  ctx.fill();
  ctx.fillStyle = "#e8ad82";
  ctx.fillRect(-16 * s, 44 * s, 32 * s, 28 * s);
  ctx.restore();

  // Slightly lower offset for visual "short guy" gag!
  ctx.translate(0, 8 * s);

  // Ears
  drawEll(ctx, -46 * s, 0, 10 * s, 15 * s, "#e8ad82", "#111318", 2.8 * s);
  drawEll(ctx, 46 * s, 0, 10 * s, 15 * s, "#e8ad82", "#111318", 2.8 * s);

  // Narrower tanned oval head
  drawEll(ctx, 0, 0, 45 * s, 54 * s, "#f0b68a", "#111318", 3.5 * s);

  // Iconic spiky shaggy dark-brown hair!
  ctx.beginPath();
  ctx.moveTo(-48 * s, -8 * s);
  ctx.lineTo(-56 * s, -36 * s);
  ctx.lineTo(-38 * s, -32 * s);
  ctx.lineTo(-42 * s, -62 * s);
  ctx.lineTo(-18 * s, -48 * s);
  ctx.lineTo(-6 * s, -74 * s);
  ctx.lineTo(12 * s, -52 * s);
  ctx.lineTo(32 * s, -68 * s);
  ctx.lineTo(36 * s, -42 * s);
  ctx.lineTo(54 * s, -46 * s);
  ctx.lineTo(48 * s, -10 * s);
  ctx.quadraticCurveTo(36 * s, -32 * s, 0, -34 * s);
  ctx.quadraticCurveTo(-36 * s, -32 * s, -48 * s, -8 * s);
  ctx.closePath();
  ctx.fillStyle = "#3a2518";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3 * s;
  ctx.stroke();

  // Excited arched eyebrows & wide bright eyes
  ctx.strokeStyle = "#2c1b10";
  ctx.lineWidth = 5 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-30 * s, -18 * s);
  ctx.quadraticCurveTo(-18 * s, -26 * s, -7 * s, -18 * s);
  ctx.moveTo(7 * s, -18 * s);
  ctx.quadraticCurveTo(18 * s, -26 * s, 30 * s, -18 * s);
  ctx.stroke();

  drawEll(ctx, -18 * s, -6 * s, 10 * s, 9 * s, "#ffffff", "#111318", 2.5 * s);
  drawEll(ctx, 18 * s, -6 * s, 10 * s, 9 * s, "#ffffff", "#111318", 2.5 * s);
  drawEll(ctx, -17 * s, -5 * s, 4.5 * s, 4.5 * s, "#4a2f1d");
  drawEll(ctx, 17 * s, -5 * s, 4.5 * s, 4.5 * s, "#4a2f1d");
  drawEll(ctx, -15 * s, -7 * s, 2 * s, 2 * s, "#ffffff");
  drawEll(ctx, 19 * s, -7 * s, 2 * s, 2 * s, "#ffffff");

  // Neat nose
  ctx.beginPath();
  ctx.moveTo(0, -4 * s);
  ctx.lineTo(6 * s, 10 * s);
  ctx.lineTo(-5 * s, 12 * s);
  ctx.strokeStyle = "#9c6340";
  ctx.lineWidth = 3 * s;
  ctx.stroke();

  // Iconic Hamster goatee / soul patch!
  ctx.beginPath();
  ctx.moveTo(-14 * s, 38 * s);
  ctx.quadraticCurveTo(0, 56 * s, 14 * s, 38 * s);
  ctx.quadraticCurveTo(0, 46 * s, -14 * s, 38 * s);
  ctx.closePath();
  ctx.fillStyle = "#3a2518";
  ctx.fill();

  // BLINDINGLY BRIGHT WHITE TOOTHY GRIN (classic whitened-teeth gag!)
  ctx.beginPath();
  ctx.moveTo(-29 * s, 20 * s);
  ctx.quadraticCurveTo(0, 26 * s, 29 * s, 20 * s);
  ctx.quadraticCurveTo(24 * s, 41 * s, 0, 41 * s);
  ctx.quadraticCurveTo(-24 * s, 41 * s, -29 * s, 20 * s);
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3 * s;
  ctx.stroke();
  // Sparkle star glint on teeth!
  ctx.fillStyle = "#ffe600";
  ctx.beginPath();
  const gx = 16 * s;
  const gy = 26 * s;
  const gr = 12 * s;
  ctx.moveTo(gx, gy - gr);
  ctx.lineTo(gx + gr * 0.28, gy - gr * 0.28);
  ctx.lineTo(gx + gr, gy);
  ctx.lineTo(gx + gr * 0.28, gy + gr * 0.28);
  ctx.lineTo(gx, gy + gr);
  ctx.lineTo(gx - gr * 0.28, gy + gr * 0.28);
  ctx.lineTo(gx - gr, gy);
  ctx.lineTo(gx - gr * 0.28, gy - gr * 0.28);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/**
 * 3. JAMES MAY CARICATURE ("CAPTAIN SLOW"):
 * Shoulder-length wavy grey-brown center-parted hair, one deadpan raised eyebrow,
 * flat unimpressed smirk, iconic purple-and-pink horizontal striped rugby shirt!
 */
function drawMayFace(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const s = radius / 100;

  drawPortraitMedallion(ctx, 100 * s, "#4b2363", "#f0c800");

  // Clip shoulders inside circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, 95 * s, 0, Math.PI * 2);
  ctx.clip();
  // Legendary James May purple & pink horizontal striped jumper!!
  ctx.fillStyle = "#6c2c91";
  ctx.fillRect(-85 * s, 54 * s, 170 * s, 50 * s);
  ctx.fillStyle = "#e85ba6";
  ctx.fillRect(-85 * s, 63 * s, 170 * s, 10 * s);
  ctx.fillRect(-85 * s, 83 * s, 170 * s, 10 * s);
  ctx.fillStyle = "#f2c3a4";
  ctx.fillRect(-16 * s, 40 * s, 32 * s, 26 * s);
  ctx.restore();

  // Back layer of shoulder-length wavy hair!
  ctx.beginPath();
  ctx.moveTo(-54 * s, -40 * s);
  ctx.quadraticCurveTo(-72 * s, 12 * s, -64 * s, 64 * s);
  ctx.lineTo(-34 * s, 64 * s);
  ctx.lineTo(34 * s, 64 * s);
  ctx.lineTo(64 * s, 64 * s);
  ctx.quadraticCurveTo(72 * s, 12 * s, 54 * s, -40 * s);
  ctx.quadraticCurveTo(0, -76 * s, -54 * s, -40 * s);
  ctx.closePath();
  ctx.fillStyle = "#8a7f74";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 3.2 * s;
  ctx.stroke();

  // Oval face
  drawEll(ctx, 0, 2 * s, 44 * s, 52 * s, "#f4c6a8", "#111318", 3.2 * s);

  // Center-parted flowing grey-brown hair curtains framing face
  ctx.beginPath();
  ctx.moveTo(0, -56 * s);
  ctx.quadraticCurveTo(-36 * s, -54 * s, -54 * s, -12 * s);
  ctx.quadraticCurveTo(-60 * s, 28 * s, -52 * s, 56 * s);
  ctx.lineTo(-36 * s, 46 * s);
  ctx.quadraticCurveTo(-40 * s, 10 * s, -34 * s, -22 * s);
  ctx.quadraticCurveTo(-16 * s, -38 * s, 0, -40 * s);
  ctx.quadraticCurveTo(16 * s, -38 * s, 34 * s, -22 * s);
  ctx.quadraticCurveTo(40 * s, 10 * s, 36 * s, 46 * s);
  ctx.lineTo(52 * s, 56 * s);
  ctx.quadraticCurveTo(60 * s, 28 * s, 54 * s, -12 * s);
  ctx.quadraticCurveTo(36 * s, -54 * s, 0, -56 * s);
  ctx.closePath();
  ctx.fillStyle = "#9c9186";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 2.8 * s;
  ctx.stroke();

  // Iconic deadpan expression: left eyebrow flat, right eyebrow skeptically raised!
  ctx.strokeStyle = "#5c534a";
  ctx.lineWidth = 5 * s;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-29 * s, -14 * s);
  ctx.lineTo(-7 * s, -14 * s);
  ctx.moveTo(8 * s, -18 * s);
  ctx.quadraticCurveTo(19 * s, -28 * s, 30 * s, -16 * s);
  ctx.stroke();

  // Half-lidded unimpressed eyes
  drawEll(ctx, -18 * s, -3 * s, 10 * s, 7.5 * s, "#ffffff", "#111318", 2.4 * s);
  drawEll(ctx, 18 * s, -3 * s, 10 * s, 7.5 * s, "#ffffff", "#111318", 2.4 * s);
  drawEll(ctx, -17 * s, -2 * s, 4 * s, 4 * s, "#3d556e");
  drawEll(ctx, 17 * s, -2 * s, 4 * s, 4 * s, "#3d556e");
  // Heavy deadpan upper eyelids
  ctx.fillStyle = "#eab99a";
  ctx.fillRect(-29 * s, -11 * s, 22 * s, 7 * s);
  ctx.fillRect(7 * s, -11 * s, 22 * s, 6 * s);
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 2.5 * s;
  ctx.beginPath();
  ctx.moveTo(-28 * s, -4 * s);
  ctx.lineTo(-8 * s, -4 * s);
  ctx.moveTo(8 * s, -5 * s);
  ctx.lineTo(28 * s, -5 * s);
  ctx.stroke();

  // Distinct long straight nose
  ctx.beginPath();
  ctx.moveTo(0, -4 * s);
  ctx.lineTo(4 * s, 14 * s);
  ctx.lineTo(-5 * s, 15 * s);
  ctx.strokeStyle = "#a8775a";
  ctx.lineWidth = 3 * s;
  ctx.stroke();

  // Classic dry flat sideways unimpressed mouth
  ctx.beginPath();
  ctx.moveTo(-20 * s, 30 * s);
  ctx.quadraticCurveTo(0, 27 * s, 22 * s, 33 * s);
  ctx.strokeStyle = "#5c2e28";
  ctx.lineWidth = 4 * s;
  ctx.stroke();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Custom Cogwheel "MIDDLE GEAR" Parody Logo + Crooked Masking-Taped Plate
// ---------------------------------------------------------------------------

function drawMiddleGearLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number, rot = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(scale, scale);

  // Stylized metallic cogwheel behind the text
  const teeth = 12;
  const rIn = 46;
  const rOut = 58;
  ctx.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? rOut : rIn;
    const x = -112 + Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "#f0c800";
  ctx.fill();
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 5;
  ctx.stroke();
  drawEll(ctx, -112, 0, 22, 22, "#0d5634", "#111318", 4);

  // Bold dark racing plaque behind MIDDLE GEAR text
  ctx.fillStyle = "#11141a";
  ctx.fillRect(-86, -42, 290, 84);
  ctx.strokeStyle = "#f0c800";
  ctx.lineWidth = 5;
  ctx.strokeRect(-86, -42, 290, 84);

  // "MIDDLE" in crisp white + "GEAR" in loud racing orange!
  ctx.font = 'italic 900 42px "Arial Black", Impact, Arial, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("MIDDLE", -72, -12, 260);
  ctx.fillStyle = "#ff6a00";
  ctx.font = 'italic 900 44px "Arial Black", Impact, Arial, sans-serif';
  ctx.fillText("GEAR", 84, 22, 130);
  ctx.fillStyle = "#f0c800";
  ctx.font = '900 16px "Arial Black", Arial, sans-serif';
  ctx.fillText("1.6L · 106 BHP", -70, 22, 145);

  ctx.restore();
}

/** Draws a deliberately slightly crooked DIY masking-taped `#106` race number square */
function drawCrookedNumberPlate(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.06); // slightly crooked for DIY comedy!
  const w = size;
  const h = size * 0.92;
  ctx.fillStyle = "#fffef5";
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 4;
  ctx.strokeRect(-w / 2, -h / 2, w, h);

  // Top orange tape bar
  ctx.fillStyle = "#ff5a00";
  ctx.fillRect(-w / 2, -h / 2, w, h * 0.24);
  ctx.fillStyle = "#ffffff";
  ctx.font = `900 ${Math.round(h * 0.16)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("106 BHP", 0, -h / 2 + h * 0.13, w * 0.9);

  // Hand-scrawled bold #106
  ctx.fillStyle = "#111318";
  ctx.font = `italic 900 ${Math.round(h * 0.48)}px "Arial Black", Impact, Arial, sans-serif`;
  ctx.fillText("106", -2, h * 0.12, w * 0.88);

  // Beige masking tape strips holding the corners on!
  ctx.fillStyle = "rgba(235, 220, 170, 0.9)";
  for (const [tx, ty, a] of [
    [-w * 0.46, -h * 0.44, -0.7],
    [w * 0.46, -h * 0.44, 0.7],
    [-w * 0.46, h * 0.44, 0.7],
    [w * 0.46, h * 0.44, -0.7],
  ] as const) {
    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(a);
    ctx.fillRect(-18, -6, 36, 12);
    ctx.restore();
  }
  ctx.restore();
}

/** Draws a bold British Union Jack inside the given top-panel rectangle */
function drawUnionJack(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = "#012169";
  ctx.fillRect(x, y, w, h);

  // White diagonals
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = h * 0.18;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();

  // Red diagonals
  ctx.strokeStyle = "#c8102e";
  ctx.lineWidth = h * 0.08;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.moveTo(x + w, y);
  ctx.lineTo(x, y + h);
  ctx.stroke();

  // White cross
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x + w * 0.5 - w * 0.11, y, w * 0.22, h);
  ctx.fillRect(x, y + h * 0.5 - h * 0.15, w, h * 0.30);

  // Red cross
  ctx.fillStyle = "#c8102e";
  ctx.fillRect(x + w * 0.5 - w * 0.065, y, w * 0.13, h);
  ctx.fillRect(x, y + h * 0.5 - h * 0.09, w, h * 0.18);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Main "Middle Gear" Atlas Renderer
// ---------------------------------------------------------------------------

export function renderLianaLiveryToContext(
  ctx: CanvasRenderingContext2D,
  _spec: LianaLiverySpec,
  pixelSize = LIANA_ATLAS_SIZE
): void {
  if (!isCapableCtx(ctx)) {
    const partial = ctx as Partial<CanvasRenderingContext2D> | null | undefined;
    if (partial && typeof partial.fillRect === "function") {
      partial.fillStyle = "#0d5634";
      partial.fillRect(0, 0, pixelSize, pixelSize);
    }
    return;
  }

  const scale = pixelSize / LIANA_ATLAS_SIZE;
  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);

  // Base British Racing Green across the entire Liana body
  ctx.fillStyle = "#0d5634";
  ctx.fillRect(0, 0, LIANA_ATLAS_SIZE, LIANA_ATLAS_SIZE);

  // ==================== 1) TOP PANEL: UNION JACK ROOF + TRIO FACES ON HOOD ====================
  clipRect(ctx, 0, 0, LIANA_ATLAS_SIZE, TOP_H, () => {
    // Classic twin off-center racing stripes in yellow & orange running front-to-back
    ctx.fillStyle = "#f0c800";
    ctx.fillRect(0, topY(0.14), LIANA_ATLAS_SIZE, topY(-0.14) - topY(0.14));
    ctx.fillStyle = "#ff5a00";
    ctx.fillRect(0, topY(0.18), LIANA_ATLAS_SIZE, topY(0.14) - topY(0.18));
    ctx.fillRect(0, topY(-0.14), LIANA_ATLAS_SIZE, topY(-0.18) - topY(-0.14));

    // Giant Union Jack covering the flat Liana roof (zN 0.24..0.58)
    const roofX0 = topX(0.24);
    const roofW = topX(0.58) - roofX0;
    const roofY0 = topY(0.68);
    const roofH = topY(-0.68) - roofY0;
    drawUnionJack(ctx, roofX0, roofY0, roofW, roofH);
    ctx.strokeStyle = "#f0c800";
    ctx.lineWidth = 8;
    ctx.strokeRect(roofX0, roofY0, roofW, roofH);

    // Bold "AMBITIOUS BUT RUBBISH" banner across roof!
    ctx.save();
    ctx.translate(topX(0.41), topY(0));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(15, 19, 26, 0.88)";
    ctx.fillRect(-210, -48, 420, 96);
    ctx.strokeStyle = "#f0c800";
    ctx.lineWidth = 5;
    ctx.strokeRect(-210, -48, 420, 96);
    ctx.fillStyle = "#ffffff";
    ctx.font = 'italic 900 38px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("MIDDLE GEAR", 0, -14, 390);
    ctx.fillStyle = "#f0c800";
    ctx.font = '900 22px "Arial Black", Arial, sans-serif';
    ctx.fillText("AMBITIOUS BUT RUBBISH", 0, 24, 390);
    ctx.restore();

    // HOOD HERO STAGE (zN 0.76..0.97): ALL THREE HUGE CARICATURE FACES + MIDDLE GEAR LOGO!!
    // Clean dark green hood background patch so the portraits pop with maximum clarity!
    ctx.fillStyle = "#0b492c";
    ctx.fillRect(topX(0.75), topY(0.84), topX(0.98) - topX(0.75), topY(-0.84) - topY(0.84));
    ctx.strokeStyle = "#f0c800";
    ctx.lineWidth = 6;
    ctx.strokeRect(topX(0.75), topY(0.84), topX(0.98) - topX(0.75), topY(-0.84) - topY(0.84));

    // Three hilarious portraits lined up across the hood (reads left->right from front 3/4 view: HAMMOND, CLARKSON, MAY!)
    // Recall: at -Math.PI/2 rotation, viewer's left = -X (larger topY), viewer's right = +X (smaller topY)!
    const faceZ = 0.83;
    drawHammondFace(ctx, topX(faceZ + 0.008), topY(-0.48), 82, -Math.PI / 2);
    drawClarksonFace(ctx, topX(faceZ - 0.006), topY(0.0), 92, -Math.PI / 2);
    drawMayFace(ctx, topX(faceZ + 0.004), topY(0.48), 84, -Math.PI / 2);

    // Huge "MIDDLE GEAR" cogwheel logo across the lower hood right beneath their chins (centered cleanly!)
    drawMiddleGearLogo(ctx, topX(0.922), topY(0.02), 0.84, -Math.PI / 2);

    // Trunk lid top strip (zN 0.02..0.14): "STAR IN A REASONABLY PRICED CAR"
    ctx.save();
    ctx.translate(topX(0.085), topY(0));
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#f0c800";
    ctx.font = 'italic 900 32px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("REASONABLY PRICED CAR", 0, 0, 520);
    ctx.restore();
  });

  // ==================== 2) LEFT & RIGHT SIDES: FACES + SPEECH BUBBLES + MIDDLE GEAR + HAZARD SILLS ====================
  for (const isLeft of [true, false]) {
    const m = makeSideMapper(isLeft);
    const y0 = isLeft ? LEFT_Y : RIGHT_Y;

    clipRect(ctx, 0, y0, LIANA_ATLAS_SIZE, SIDE_H, () => {
      // Loud yellow & black hazard caution stripes along the entire lower rocker skirt (yN 0.0..0.15)
      ctx.fillStyle = "#f0c800";
      ctx.fillRect(0, m.y(0.15), LIANA_ATLAS_SIZE, m.y(0.0) - m.y(0.15));
      ctx.fillStyle = "#111318";
      for (let px = -80; px < LIANA_ATLAS_SIZE + 80; px += 48) {
        ctx.beginPath();
        ctx.moveTo(px, m.y(0.15));
        ctx.lineTo(px + 22, m.y(0.15));
        ctx.lineTo(px - 6, m.y(0.0));
        ctx.lineTo(px - 28, m.y(0.0));
        ctx.closePath();
        ctx.fill();
      }

      // Racing orange side mirror caps!
      ctx.fillStyle = "#ff5a00";
      ctx.fillRect(m.x(0.64) - 85, m.y(0.66) - 52, 170, 104);

      // Subtle orange racing accent stripe right above the black plastic rub-strip (yN ≈ 0.30..0.33)
      ctx.fillStyle = "#ff5a00";
      ctx.fillRect(0, m.y(0.34), LIANA_ATLAS_SIZE, m.y(0.30) - m.y(0.34));

      // UPPER DOOR BILLBOARD (above black rub strip, yN ≈ 0.35..0.60):
      // Front door (zN ≈ 0.59): HUGE MIDDLE GEAR cog logo!
      drawMiddleGearLogo(ctx, m.x(0.585), m.y(0.475), 0.72, 0);

      // Rear door (zN ≈ 0.37): Crooked masking-taped #106 plate!
      drawCrookedNumberPlate(ctx, m.x(0.37), m.y(0.46), 104);

      // ALL THREE CARICATURE FACES PEEKING ALONG THE FLANK + SPEECH BUBBLES!!
      // Clarkson on front fender behind wheel arch? Wait: front wheel is at zN=0.80, rear wheel at zN=0.23.
      // Put ALL THREE FACES right on the big clean upper/mid doors & quarter panel where they're HUGE and unmistakable:
      // Actually even funnier & cleaner:
      // - Front Door upper (zN 0.61, yN 0.48): CLARKSON + HAMMOND + MAY peeking in a row!
      // - Rear Door (zN 0.36, yN 0.48): HUGE MIDDLE GEAR LOGO + #106 crooked plate!
      // Wait: let's check space! Doors span zN = 0.27..0.71 = 901 pixels wide!!
      // We have 901 pixels of completely flat clean door!!
      // Let's re-paint upper door cleanly so BOTH the 3 faces AND "MIDDLE GEAR" + "#106" are HUGE, ZERO overlap!
      ctx.fillStyle = "#0d5634";
      ctx.fillRect(0, m.y(0.64), LIANA_ATLAS_SIZE, m.y(0.34) - m.y(0.64));

      // Side panel aspect correction: horizontal scale (2048/4.34=472 px/m) vs vertical (448/1.36=329 px/m) => 1.43x
      // Scaling circular decals by (1.43, 1.0) in canvas space makes them render 100% round on the 3D doors!
      const sideAspectX = 1.43;

      // Put the 3 iconic caricature portraits in a hilarious comic trio across the FRONT DOOR (clear of the side mirror!)
      const dir = isLeft ? -1 : 1; // left->right reading order on screen!
      const trioCenterZ = 0.565;
      const drawSideFace = (
        fn: (c: CanvasRenderingContext2D, x: number, y: number, r: number, rot?: number) => void,
        zN: number,
        yN: number,
        r: number
      ) => {
        ctx.save();
        ctx.translate(m.x(zN), m.y(yN));
        ctx.scale(sideAspectX, 1.0);
        fn(ctx, 0, 0, r, 0);
        ctx.restore();
      };
      drawSideFace(drawHammondFace, trioCenterZ - dir * 0.072, 0.445, 42);
      drawSideFace(drawClarksonFace, trioCenterZ, 0.455, 46);
      drawSideFace(drawMayFace, trioCenterZ + dir * 0.072, 0.445, 43);

      // Punchy comic speech bubbles tucked neatly inside the painted upper door zone (below window sill!)
      drawSpeechBubble(ctx, m.x(trioCenterZ), m.y(0.565), 146, 26, "POWERRR!!", 0, 14, "#fff8cc", "#c40814");

      // HUGE "MIDDLE GEAR" cog logo across the REAR DOOR (aspect-corrected so the cogwheel is a true circle!)
      ctx.save();
      ctx.translate(m.x(0.365), m.y(0.465));
      ctx.scale(sideAspectX * 0.62, 0.68);
      drawMiddleGearLogo(ctx, 0, 0, 1.0, 0);
      ctx.restore();

      // Crooked masking-taped "#106" number plate on the rear haunch behind the rear door
      ctx.save();
      ctx.translate(m.x(0.125), m.y(0.49));
      ctx.scale(sideAspectX * 0.85, 0.85);
      drawCrookedNumberPlate(ctx, 0, 0, 92);
      ctx.restore();

      // LOWER DOOR PANEL (below the black plastic rub strip, yN ≈ 0.22):
      // Hilarious DIY endurance gag text!
      ctx.font = 'italic 900 26px "Arial Black", Arial, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "#111318";
      ctx.lineWidth = 5;
      const lowerText = "STAR IN A REASONABLY PRICED CAR";
      ctx.strokeText(lowerText, m.x(0.50), m.y(0.225), 760);
      ctx.fillStyle = "#f0c800";
      ctx.fillText(lowerText, m.x(0.50), m.y(0.225), 760);

      // Front bumper cheek gag decals cleanly below the black bumper rub-strip (zN 0.90)
      ctx.font = '900 17px "Arial Black", Arial, sans-serif';
      ctx.strokeStyle = "#111318";
      ctx.lineWidth = 4;
      ctx.strokeText("HAMMER &", m.x(0.905), m.y(0.245), 120);
      ctx.fillStyle = "#ffffff";
      ctx.fillText("HAMMER &", m.x(0.905), m.y(0.245), 120);
      ctx.strokeText("SPANNERS", m.x(0.905), m.y(0.185), 120);
      ctx.fillStyle = "#f0c800";
      ctx.fillText("SPANNERS", m.x(0.905), m.y(0.185), 120);
    });
  }

  // ==================== 3) REAR PANEL: CHASE-CAM BUMPER STICKER COMEDY GOLD!! ====================
  clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    // Trunk lid "MIDDLE GEAR" badge
    drawMiddleGearLogo(ctx, HALF_W * 0.50, BOTTOM_Y + BOTTOM_H * 0.38, 0.72, 0);

    // Classic yellow bumper sticker: "MY OTHER CAR IS A DACIA SANDERO"
    ctx.fillStyle = "#f0c800";
    ctx.fillRect(HALF_W * 0.08, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.44, 38);
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = 4;
    ctx.strokeRect(HALF_W * 0.08, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.44, 38);
    ctx.fillStyle = "#111318";
    ctx.font = '900 20px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("MY OTHER CAR IS A SANDERO", HALF_W * 0.30, BOTTOM_Y + BOTTOM_H * 0.62 + 19, HALF_W * 0.42);

    // Classic red/white bumper sticker: "0-60: EVENTUALLY"
    ctx.fillStyle = "#d60024";
    ctx.fillRect(HALF_W * 0.56, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.36, 38);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.strokeRect(HALF_W * 0.56, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.36, 38);
    ctx.fillStyle = "#ffffff";
    ctx.font = 'italic 900 22px "Arial Black", Arial, sans-serif';
    ctx.fillText("0-60: EVENTUALLY", HALF_W * 0.74, BOTTOM_Y + BOTTOM_H * 0.62 + 19, HALF_W * 0.34);

    // Subtle "HOW HARD CAN IT BE?" along lower bumper
    ctx.fillStyle = "#ffffff";
    ctx.font = '900 18px "Arial Black", Arial, sans-serif';
    ctx.fillText("HOW HARD CAN IT BE?", HALF_W * 0.50, BOTTOM_Y + BOTTOM_H * 0.82, HALF_W * 0.6);
  });

  // ==================== 4) FRONT BUMPER PANEL ====================
  clipRect(ctx, HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    // Hazard yellow front chin stripe + fake tow arrow
    ctx.fillStyle = "#f0c800";
    ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.80, HALF_W, 24);
    ctx.fillStyle = "#ff5a00";
    ctx.font = '900 20px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("106 BHP · MOVE OVER", HALF_W + HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.80 + 12, HALF_W * 0.6);
  });

  ctx.restore();
}

const lianaAtlasCache = new Map<string, THREE.CanvasTexture>();

export function getLianaLiveryAtlasTexture(id: string): THREE.CanvasTexture | null {
  const spec = lianaLiveryById(id);
  if (!spec || typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const hit = lianaAtlasCache.get(id);
  if (hit) return hit;

  const size =
    typeof window !== "undefined" && typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth < 768
      ? 1024
      : LIANA_ATLAS_SIZE;
  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function") return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!isCapableCtx(ctx)) return null;

  renderLianaLiveryToContext(ctx, spec, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `liana_livery_atlas_${id}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  lianaAtlasCache.set(id, tex);
  return tex;
}

export function clearLianaLiveryCache(): void {
  for (const tex of lianaAtlasCache.values()) tex.dispose();
  lianaAtlasCache.clear();
}
