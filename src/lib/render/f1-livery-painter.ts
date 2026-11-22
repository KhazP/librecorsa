import * as THREE from "three";
import type { LiveryConfig, LiveryFinish, LiveryPatternId, LiveryVisualSpec } from "@/types/f1";

/**
 * Broadcast-grade procedural 2048px F1 livery generator + object-space tri-orthographic projection shader.
 *
 * The ported LC26 GLB (`public/cars/f12026/model/f12026.glb`) has no UVs on its bodywork — only three flat zone
 * materials (`EXT_PAINT_PRIMARY`, `EXT_PAINT_SECONDARY`, `EXT_PAINT_ACCENT`). Rather than settling for solid colour
 * swaps, this engine paints a crisp 2048x2048 6-panel orthographic livery atlas per team (Top, Left Side, Right Side,
 * Rear Wing/Face, Front Face, and dedicated Left/Right Front Wing Endplates) and projects it in car-local space onto
 * both `BODY` and the moving active-aero wing flaps (via each flap's closed-pose frame matrix).
 *
 * - Zero mirrored typography on any face (left/right side panels mirror graphics but draw right-reading sponsors & numbers).
 * - Per-livery PBR finish profiles (gloss lacquer, velvet satin, deep race matte, brushed metallic, stealth chrome).
 * - Object-space 2x2 twill carbon-weave micro-roughness on exposed carbon zones so bare carbon reads tactile beside paint.
 * - Cached per livery key (single replaceable slot for `custom` so live colour picking never leaks GPU memory).
 */

export const F1_ATLAS_SIZE = 2048;

// Car-space projection bounds matching `f12026.glb` BODY geometry (metres: +X left, +Y up, +Z forward)
const Z_MIN = -2.75;
const Z_MAX = 2.85;
const Z_SPAN = Z_MAX - Z_MIN; // 5.60 m
const X_MIN = -0.95;
const X_MAX = 0.95;
const X_SPAN = X_MAX - X_MIN; // 1.90 m
const Y_MIN = 0.0;
const Y_MAX = 1.15;
const Y_SPAN = Y_MAX - Y_MIN; // 1.15 m

// Atlas panel layout inside 2048x2048 (flipY = false, y down from top)
const TOP_H = 768;
const SIDE_H = 480;
const LEFT_Y = TOP_H; // 768..1248
const RIGHT_Y = LEFT_Y + SIDE_H; // 1248..1728
const BOTTOM_Y = RIGHT_Y + SIDE_H; // 1728..2048
const BOTTOM_H = F1_ATLAS_SIZE - BOTTOM_Y; // 320

export interface LiveryFinishParams {
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  specularIntensity: number;
}

export const LIVERY_FINISH_PROFILES: Readonly<Record<LiveryFinish, LiveryFinishParams>> = {
  gloss: {
    roughness: 0.17,
    metalness: 0.16,
    clearcoat: 0.92,
    clearcoatRoughness: 0.08,
    specularIntensity: 0.42,
  },
  satin: {
    roughness: 0.34,
    metalness: 0.18,
    clearcoat: 0.32,
    clearcoatRoughness: 0.18,
    specularIntensity: 0.24,
  },
  matte: {
    roughness: 0.62,
    metalness: 0.08,
    clearcoat: 0.06,
    clearcoatRoughness: 0.48,
    specularIntensity: 0.14,
  },
  metallic: {
    roughness: 0.24,
    metalness: 0.62,
    clearcoat: 0.68,
    clearcoatRoughness: 0.11,
    specularIntensity: 0.48,
  },
  chrome: {
    roughness: 0.18,
    metalness: 0.76,
    clearcoat: 0.84,
    clearcoatRoughness: 0.07,
    specularIntensity: 0.56,
  },
};

/** Fallback visual spec for any livery without an explicit `visual` block */
export function resolveLiveryVisual(livery: LiveryConfig): LiveryVisualSpec {
  if (livery.visual) return livery.visual;
  return {
    pattern: "custom",
    finish: "satin",
    bodyBase: livery.primary,
    bodySecondary: livery.secondary,
    stripePrimary: livery.accent,
    stripeSecondary: "#f8fafc",
    noseTip: livery.secondary,
    airbox: livery.secondary,
    halo: livery.secondary,
    wingMain: livery.secondary,
    endplate: livery.primary,
    numberBg: livery.secondary,
    numberColor: livery.accent,
    carbonExposure: 0.7,
    sponsors: {
      title: livery.team.toUpperCase().slice(0, 12) || "LIBRECORSA",
      wing: "APEX LABS",
      nose: "VELOX",
      halo: "KRONOS",
      tech: "STRATA",
    },
  };
}

/** Rich multi-colour CSS swatch background for the livery picker UI (keeps raw hexes out of `.tsx` files) */
export function liverySwatchBackground(livery: LiveryConfig): string {
  if (livery.visual?.swatchCss) return livery.visual.swatchCss;
  return `linear-gradient(130deg, ${livery.primary} 0 52%, ${livery.accent} 52% 64%, ${livery.secondary} 64% 100%)`;
}

// ---------------------------------------------------------------------------
// Coordinate mappers from car-local metres into logical 2048x2048 canvas space
// ---------------------------------------------------------------------------

/** Top panel: +Z -> right (0..2048), +X (left) -> top (0), -X (right) -> bottom (768) */
const topX = (z: number) => ((z - Z_MIN) / Z_SPAN) * F1_ATLAS_SIZE;
const topY = (x: number) => ((X_MAX - x) / X_SPAN) * TOP_H;
const topW = (dz: number) => (dz / Z_SPAN) * F1_ATLAS_SIZE;
const topH = (dx: number) => (dx / X_SPAN) * TOP_H;

/** Side panels: left side (+X) maps nose (+Z) to left (0) and rear (-Z) to right (2048); right side mirrors u */
const sideX = (z: number, isLeft: boolean) =>
  isLeft ? ((Z_MAX - z) / Z_SPAN) * F1_ATLAS_SIZE : ((z - Z_MIN) / Z_SPAN) * F1_ATLAS_SIZE;
const sideY = (y: number, isLeft: boolean) =>
  (isLeft ? LEFT_Y : RIGHT_Y) + ((Y_MAX - y) / Y_SPAN) * SIDE_H;

/** Rear face panel (0..1024, 1728..2048): +X (left) -> 0, -X (right) -> 1024, Y 1.00..0.35 */
const rearX = (x: number) => ((0.65 - x) / 1.3) * 1024;
const rearY = (y: number) => BOTTOM_Y + ((1.0 - y) / 0.65) * BOTTOM_H;

/** Front face panel (1024..1536, 1728..2048): -X -> 1024, +X -> 1536, Y 0.65..0.08 */
const frontX = (x: number) => 1024 + ((x - X_MIN) / X_SPAN) * 512;
const frontY = (y: number) => BOTTOM_Y + ((0.65 - y) / 0.57) * BOTTOM_H;

/** Front wing endplate panels (1536..2048): top half = left (+X), bottom half = right (-X) */
const fwEpX = (z: number, isLeft: boolean) =>
  1536 + (isLeft ? (2.75 - z) / 0.95 : (z - 1.8) / 0.95) * 512;
const fwEpY = (y: number, isLeft: boolean) =>
  (isLeft ? BOTTOM_Y : BOTTOM_Y + 160) + ((0.46 - y) / 0.38) * 160;

// ---------------------------------------------------------------------------
// Colour & Canvas2D graphic primitives
// ---------------------------------------------------------------------------

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const n = Number.parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  if (Number.isNaN(n)) return [20, 22, 28];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luma(hex: string): number {
  const [r, g, b] = parseHexRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function contrastInk(bgHex: string, light = "#f8fafc", dark = "#101218"): string {
  return luma(bgHex) > 0.56 ? dark : light;
}

/** Applies the livery's PBR finish profile (gloss / satin / matte / metallic / chrome) to a physical material */
export function applyLiveryFinishToMaterial(mat: THREE.MeshPhysicalMaterial, livery: LiveryConfig): void {
  const spec = resolveLiveryVisual(livery);
  const finish = LIVERY_FINISH_PROFILES[spec.finish] ?? LIVERY_FINISH_PROFILES.satin;
  mat.roughness = finish.roughness;
  mat.metalness = finish.metalness;
  mat.clearcoat = finish.clearcoat;
  mat.clearcoatRoughness = finish.clearcoatRoughness;
  mat.specularIntensity = finish.specularIntensity;
}

/** Canvas2D methods required to paint the full multi-panel procedural livery atlas */
const REQUIRED_CANVAS2D_METHODS = [
  "save",
  "restore",
  "translate",
  "rotate",
  "scale",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "quadraticCurveTo",
  "arc",
  "fill",
  "stroke",
  "fillRect",
  "strokeRect",
  "fillText",
  "strokeText",
  "measureText",
  "createLinearGradient",
] as const;

/**
 * Returns true when `ctx` implements the full Canvas2D surface used by the procedural livery painter.
 * Guards minimal headless Node/SSR canvas stubs so they degrade cleanly instead of throwing `TypeError`.
 */
function isCapableCanvas2DContext(ctx: unknown): ctx is CanvasRenderingContext2D {
  if (!ctx || typeof ctx !== "object") return false;
  const record = ctx as Record<string, unknown>;
  for (const method of REQUIRED_CANVAS2D_METHODS) {
    if (typeof record[method] !== "function") return false;
  }
  return true;
}

/** Crisp 2x2 diagonal twill carbon-fibre weave CanvasPattern */
function createCarbonFill(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (
    typeof document === "undefined" ||
    typeof document.createElement !== "function" ||
    typeof ctx.createPattern !== "function"
  ) {
    return "#15171e";
  }
  const tile = document.createElement("canvas");
  if (!tile || typeof tile.getContext !== "function") return "#15171e";
  tile.width = 16;
  tile.height = 16;
  const t = tile.getContext("2d");
  if (!t || typeof t.fillRect !== "function") return "#15171e";
  t.fillStyle = "#111319";
  t.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y += 4) {
    for (let x = 0; x < 16; x += 4) {
      const phase = ((x + y) >> 2) & 3;
      t.fillStyle = phase < 2 ? "#212530" : "#151820";
      t.fillRect(x, y, 3, 3);
      if (phase === 0) {
        t.fillStyle = "#2b303e";
        t.fillRect(x, y, 2, 1);
      }
    }
  }
  try {
    return ctx.createPattern(tile, "repeat") ?? "#15171e";
  } catch {
    return "#15171e";
  }
}

function fillPoly(ctx: CanvasRenderingContext2D, pts: readonly [number, number][], fill: string | CanvasPattern | CanvasGradient): void {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function strokePoly(ctx: CanvasRenderingContext2D, pts: readonly [number, number][], stroke: string, width: number): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

function drawTopSymmetricPoly(
  ctx: CanvasRenderingContext2D,
  carPts: readonly [number, number][], // [z, x>=0]
  fill: string | CanvasPattern | CanvasGradient
): void {
  fillPoly(
    ctx,
    carPts.map(([z, x]) => [topX(z), topY(x)]),
    fill
  );
  fillPoly(
    ctx,
    carPts.map(([z, x]) => [topX(z), topY(-x)]),
    fill
  );
}

function drawSidePoly(
  ctx: CanvasRenderingContext2D,
  isLeft: boolean,
  carPts: readonly [number, number][], // [z, y]
  fill: string | CanvasPattern | CanvasGradient
): void {
  fillPoly(
    ctx,
    carPts.map(([z, y]) => [sideX(z, isLeft), sideY(y, isLeft)]),
    fill
  );
}

function strokeSideLine(
  ctx: CanvasRenderingContext2D,
  isLeft: boolean,
  carPts: readonly [number, number][], // [z, y]
  color: string,
  width: number
): void {
  strokePoly(
    ctx,
    carPts.map(([z, y]) => [sideX(z, isLeft), sideY(y, isLeft)]),
    color,
    width
  );
}

// ---------------------------------------------------------------------------
// Fictional geometric team emblems & broadcast-style sponsor wordmarks
// ---------------------------------------------------------------------------

type EmblemKind =
  | "sunburst"
  | "shield"
  | "twinhorn"
  | "tristar"
  | "wings"
  | "chevronA"
  | "monogramW"
  | "twinbolt"
  | "monolith"
  | "rings4"
  | "crest"
  | "hornet"
  | "classic"
  | "volt";

function emblemKindFor(pattern: LiveryPatternId): EmblemKind {
  switch (pattern) {
    case "papaya26":
      return "sunburst";
    case "rosso26":
      return "shield";
    case "cobalt26":
      return "twinhorn";
    case "silver26":
      return "tristar";
    case "emerald26":
      return "wings";
    case "bleu26":
      return "chevronA";
    case "royal26":
      return "monogramW";
    case "bianco26":
      return "twinbolt";
    case "carbon26":
      return "monolith";
    case "titanium26":
      return "rings4";
    case "crest26":
      return "crest";
    case "retro99_hornet":
      return "hornet";
    case "retro88_chevron":
    case "retro78_pinstripe":
    case "retro93_tri":
    case "retro05_sky":
    case "retro09_fluoro":
      return "classic";
    default:
      return "volt";
  }
}

function drawEmblem(
  ctx: CanvasRenderingContext2D,
  kind: EmblemKind,
  cx: number,
  cy: number,
  size: number,
  primary: string,
  accent: string,
  secondary = "#f8fafc",
  rotRad = 0
): void {
  ctx.save();
  ctx.translate(cx, cy);
  if (rotRad) ctx.rotate(rotRad);
  const r = size * 0.5;

  switch (kind) {
    case "sunburst": {
      // Sweeping solar speed arc
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, r * 0.35);
      ctx.quadraticCurveTo(-r * 0.1, -r * 0.9, r * 0.95, -r * 0.45);
      ctx.quadraticCurveTo(r * 0.2, -r * 0.15, -r * 0.45, r * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(r * 0.1, r * 0.15, r * 0.24, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "shield": {
      // Classic Italian racing yellow shield with diagonal speed bar
      ctx.fillStyle = "#ffd200";
      ctx.beginPath();
      ctx.moveTo(-r * 0.65, -r * 0.8);
      ctx.lineTo(r * 0.65, -r * 0.8);
      ctx.lineTo(r * 0.58, r * 0.18);
      ctx.lineTo(0, r * 0.85);
      ctx.lineTo(-r * 0.58, r * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#14161b";
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.stroke();
      // Tricolour top bar
      ctx.fillStyle = "#009246";
      ctx.fillRect(-r * 0.58, -r * 0.72, r * 0.38, r * 0.18);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-r * 0.2, -r * 0.72, r * 0.4, r * 0.18);
      ctx.fillStyle = "#d80008";
      ctx.fillRect(r * 0.2, -r * 0.72, r * 0.38, r * 0.18);
      // Stylized geometric stallion chevron
      ctx.fillStyle = "#14161b";
      ctx.beginPath();
      ctx.moveTo(-r * 0.24, r * 0.35);
      ctx.lineTo(0, -r * 0.34);
      ctx.lineTo(r * 0.28, r * 0.05);
      ctx.lineTo(r * 0.06, r * 0.05);
      ctx.lineTo(r * 0.22, r * 0.42);
      ctx.lineTo(-r * 0.04, r * 0.22);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "twinhorn": {
      // Golden sun disc + charging crimson twin-horn velocity silhouette
      ctx.fillStyle = "#ffd200";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e01b36";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * r * 0.06, r * 0.15);
        ctx.lineTo(s * r * 0.34, -r * 0.36);
        ctx.lineTo(s * r * 0.92, -r * 0.12);
        ctx.lineTo(s * r * 0.52, r * 0.34);
        ctx.lineTo(s * r * 0.12, r * 0.28);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "tristar": {
      // 3-pointed geometric precision compass star in ring
      ctx.strokeStyle = secondary;
      ctx.lineWidth = Math.max(2, size * 0.075);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = secondary;
      for (let k = 0; k < 3; k++) {
        const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
        const aL = a - 0.22;
        const aR = a + 0.22;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(aL) * r * 0.2, Math.sin(aL) * r * 0.2);
        ctx.lineTo(Math.cos(a) * r * 0.84, Math.sin(a) * r * 0.84);
        ctx.lineTo(Math.cos(aR) * r * 0.2, Math.sin(aR) * r * 0.2);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case "wings": {
      // Swept aerodynamic twin wings with electric lime bar
      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.moveTo(-r * 1.15, -r * 0.24);
      ctx.lineTo(r * 1.15, -r * 0.24);
      ctx.lineTo(r * 0.72, r * 0.26);
      ctx.lineTo(-r * 0.72, r * 0.26);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = primary;
      ctx.fillRect(-r * 0.65, -r * 0.1, r * 1.3, r * 0.22);
      ctx.fillStyle = accent;
      ctx.fillRect(-r * 0.9, -r * 0.34, r * 1.8, r * 0.08);
      break;
    }
    case "chevronA": {
      // Italic angular speed-A monogram
      ctx.strokeStyle = secondary;
      ctx.lineWidth = Math.max(3, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(-r * 0.72, r * 0.62);
      ctx.lineTo(r * 0.18, -r * 0.68);
      ctx.lineTo(r * 0.62, r * 0.62);
      ctx.stroke();
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2.5, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(-r * 0.88, r * 0.18);
      ctx.lineTo(r * 0.84, -r * 0.08);
      ctx.stroke();
      break;
    }
    case "monogramW": {
      // Bold twin-chevron geometric W
      ctx.strokeStyle = secondary;
      ctx.lineWidth = Math.max(3, size * 0.11);
      ctx.lineJoin = "miter";
      ctx.beginPath();
      ctx.moveTo(-r * 0.86, -r * 0.55);
      ctx.lineTo(-r * 0.42, r * 0.56);
      ctx.lineTo(0, -r * 0.18);
      ctx.lineTo(r * 0.42, r * 0.56);
      ctx.lineTo(r * 0.86, -r * 0.55);
      ctx.stroke();
      break;
    }
    case "twinbolt": {
      // Forward twin lightning speed bolts
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, r * 0.35);
      ctx.lineTo(-r * 0.1, -r * 0.55);
      ctx.lineTo(r * 0.2, -r * 0.12);
      ctx.lineTo(r * 0.85, -r * 0.48);
      ctx.lineTo(r * 0.18, r * 0.52);
      ctx.lineTo(-r * 0.15, r * 0.1);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "monolith": {
      // Sharp angular V-shield
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(-r * 0.75, -r * 0.7);
      ctx.lineTo(r * 0.75, -r * 0.7);
      ctx.lineTo(0, r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#14161c";
      ctx.beginPath();
      ctx.moveTo(-r * 0.34, -r * 0.42);
      ctx.lineTo(r * 0.34, -r * 0.42);
      ctx.lineTo(0, r * 0.28);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "rings4": {
      // 4 interlocking geometric precision rings
      const rr = r * 0.38;
      const step = rr * 1.38;
      ctx.strokeStyle = secondary;
      ctx.lineWidth = Math.max(2.5, size * 0.085);
      for (let i = -1.5; i <= 1.5; i += 1) {
        ctx.beginPath();
        ctx.arc(i * step, 0, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case "crest": {
      // Angled geometric 4-quadrant heraldic crest (gold / silver / blue / crimson)
      const q = [
        { x: -r * 0.88, y: -r * 0.42, w: r * 0.86, h: r * 0.4, c: "#dfb83c" },
        { x: 0, y: -r * 0.42, w: r * 0.88, h: r * 0.4, c: "#dce2ea" },
        { x: -r * 0.72, y: 0, w: r * 0.72, h: r * 0.42, c: "#1d6fe8" },
        { x: 0, y: 0, w: r * 0.72, h: r * 0.42, c: "#d91c3a" },
      ];
      for (const b of q) {
        ctx.fillStyle = b.c;
        ctx.fillRect(b.x, b.y, b.w, b.h);
      }
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = Math.max(2, size * 0.055);
      ctx.strokeRect(-r * 0.88, -r * 0.42, r * 1.76, r * 0.84);
      break;
    }
    case "hornet": {
      // Fierce angular wasp eyes + stinger diamond
      ctx.fillStyle = "#121318";
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.82);
      ctx.lineTo(r * 0.82, 0);
      ctx.lineTo(0, r * 0.82);
      ctx.lineTo(-r * 0.82, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f6c90e";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(s * r * 0.14, r * 0.1);
        ctx.lineTo(s * r * 0.56, -r * 0.24);
        ctx.lineTo(s * r * 0.46, r * 0.22);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = "#ff3b1f";
      ctx.beginPath();
      ctx.arc(0, -r * 0.34, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "classic": {
      // Vintage racing laurel-ring roundel
      ctx.fillStyle = primary;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2.5, size * 0.09);
      ctx.stroke();
      ctx.strokeStyle = secondary;
      ctx.lineWidth = Math.max(1.5, size * 0.045);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.52, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "volt": {
      // LibreCorsa diagonal double-chevron speed mark
      ctx.fillStyle = accent;
      for (const off of [-r * 0.28, r * 0.24]) {
        ctx.beginPath();
        ctx.moveTo(off - r * 0.35, r * 0.65);
        ctx.lineTo(off + r * 0.12, -r * 0.65);
        ctx.lineTo(off + r * 0.42, -r * 0.65);
        ctx.lineTo(off - r * 0.05, r * 0.65);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
  }
  ctx.restore();
}

function drawWordmark(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  maxWidth: number,
  fontSize: number,
  color: string,
  options: {
    italic?: boolean;
    rotRad?: number;
    outline?: string;
    outlineWidth?: number;
    serif?: boolean;
    accentBar?: string;
    bgPill?: string;
  } = {}
): void {
  ctx.save();
  ctx.translate(cx, cy);
  if (options.rotRad) ctx.rotate(options.rotRad);
  const weight = options.serif ? "700" : "900";
  const family = options.serif
    ? 'Georgia, "Times New Roman", serif'
    : '"Arial Black", "Helvetica Neue", Impact, Arial, sans-serif';
  const slant = options.italic === false ? "" : "italic ";
  ctx.font = `${slant}${weight} ${Math.round(fontSize)}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const measured = Math.max(1, ctx.measureText(text)?.width ?? text.length * fontSize * 0.6);
  const scaleX = measured > maxWidth ? maxWidth / measured : 1;

  if (options.bgPill) {
    const pw = Math.min(maxWidth, measured) + fontSize * 0.55;
    const ph = fontSize * 1.24;
    ctx.fillStyle = options.bgPill;
    ctx.fillRect(-pw * 0.5, -ph * 0.5, pw, ph);
  }

  ctx.save();
  ctx.scale(scaleX, 1);
  if (options.outline) {
    ctx.strokeStyle = options.outline;
    ctx.lineWidth = options.outlineWidth ?? Math.max(3, fontSize * 0.12);
    ctx.lineJoin = "round";
    ctx.strokeText(text, 0, 0);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();

  if (options.accentBar) {
    const bw = Math.min(maxWidth, measured * scaleX) * 0.88;
    ctx.fillStyle = options.accentBar;
    ctx.fillRect(-bw * 0.5, fontSize * 0.52, bw, Math.max(3, fontSize * 0.1));
  }
  ctx.restore();
}

function drawDriverNumber(
  ctx: CanvasRenderingContext2D,
  num: string,
  cx: number,
  cy: number,
  size: number,
  fg: string,
  bg: string | null,
  outline: string,
  options: { rotRad?: number; retroBox?: boolean; serif?: boolean } = {}
): void {
  ctx.save();
  ctx.translate(cx, cy);
  if (options.rotRad) ctx.rotate(options.rotRad);

  if (bg) {
    if (options.retroBox) {
      const w = size * 1.42;
      const h = size * 1.12;
      ctx.fillStyle = bg;
      ctx.fillRect(-w * 0.5, -h * 0.5, w, h);
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(2.5, size * 0.08);
      ctx.strokeRect(-w * 0.5, -h * 0.5, w, h);
    } else {
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(-size * 0.62, -size * 0.56);
      ctx.lineTo(size * 0.72, -size * 0.56);
      ctx.lineTo(size * 0.56, size * 0.56);
      ctx.lineTo(-size * 0.78, size * 0.56);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(2, size * 0.06);
      ctx.stroke();
    }
  }

  const family = options.serif
    ? 'Georgia, "Times New Roman", serif'
    : '"Arial Black", "Helvetica Neue", Arial, sans-serif';
  ctx.font = `${options.serif ? "700" : "italic 900"} ${Math.round(size * 0.92)}px ${family}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(3, size * 0.11);
  ctx.lineJoin = "round";
  ctx.strokeText(num, 0, size * 0.04);
  ctx.fillStyle = fg;
  ctx.fillText(num, 0, size * 0.04);
  ctx.restore();
}

/** Subtle aerodynamic panel shutlines, cooling gills, and carbon floor edging */
function drawAeroDetails(
  ctx: CanvasRenderingContext2D,
  spec: LiveryVisualSpec,
  carbonFill: CanvasPattern | string
): void {
  // Subtle cooling louver gills on sidepod shoulders (TOP view)
  ctx.save();
  ctx.fillStyle = "rgba(8, 10, 14, 0.42)";
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = -0.35 - i * 0.11;
      const x = side * (0.44 - i * 0.015);
      ctx.save();
      ctx.translate(topX(z), topY(x));
      ctx.rotate(side * 0.25);
      ctx.fillRect(-5, -14, 10, 28);
      ctx.restore();
    }
  }

  // Subtle nose bulkhead & cockpit shutlines on TOP
  ctx.strokeStyle = "rgba(0, 0, 0, 0.26)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(topX(1.62), topY(0.18));
  ctx.lineTo(topX(1.62), topY(-0.18));
  ctx.moveTo(topX(0.95), topY(0.24));
  ctx.lineTo(topX(0.95), topY(-0.24));
  ctx.stroke();

  // Floor edge & lower undercut exposed carbon strip on SIDE views when carbonExposure > 0.25
  if (spec.carbonExposure > 0.25) {
    const floorH = 0.15 + spec.carbonExposure * 0.09;
    for (const isLeft of [true, false]) {
      drawSidePoly(
        ctx,
        isLeft,
        [
          [-2.05, 0.0],
          [0.95, 0.0],
          [0.82, floorH],
          [-0.45, floorH + 0.03],
          [-1.98, floorH * 0.72],
        ],
        carbonFill
      );
      // Crisp floor edge highlight line
      strokeSideLine(
        ctx,
        isLeft,
        [
          [0.82, floorH],
          [-0.45, floorH + 0.03],
          [-1.98, floorH * 0.72],
        ],
        spec.stripePrimary,
        3.5
      );
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Bespoke Team Pattern Painters (all 11 2026 Grid + 6 Retro + 3 House + Custom)
// ---------------------------------------------------------------------------

function paintPatternGraphics(
  ctx: CanvasRenderingContext2D,
  spec: LiveryVisualSpec,
  carbonFill: CanvasPattern | string
): void {
  const { pattern, bodyBase, bodySecondary, stripePrimary } = spec;
  const stripeSecondary = spec.stripeSecondary ?? "#f8fafc";

  // 1) Base fill across all 6 panels
  ctx.fillStyle = bodyBase;
  ctx.fillRect(0, 0, F1_ATLAS_SIZE, F1_ATLAS_SIZE);

  // Subtle metallic/satin longitudinal sheen gradient on TOP & SIDE base
  const topGrad = ctx.createLinearGradient(0, 0, 0, TOP_H);
  topGrad.addColorStop(0, "rgba(0,0,0,0.10)");
  topGrad.addColorStop(0.5, "rgba(255,255,255,0.06)");
  topGrad.addColorStop(1, "rgba(0,0,0,0.10)");
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, F1_ATLAS_SIZE, TOP_H);

  // 2) Pattern-specific authentic multi-zone colour blocking & geometric art
  switch (pattern) {
    case "papaya26": {
      // McLaren 2026-style: Papaya orange nose/upper wedge + dramatic exposed carbon flanks/rear + sky-blue blades
      for (const isLeft of [true, false]) {
        // Dramatic diagonal exposed carbon rear engine cover & lower sidepod sweep
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [0.65, 0.0],
            [0.35, 0.34],
            [-0.42, 0.56],
            [-1.35, 0.78],
            [-2.75, 0.85],
          ],
          carbonFill
        );
        // Carbon halo & roll hoop cowl
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-0.78, 0.72],
            [0.68, 0.72],
            [0.68, 1.15],
            [-0.78, 1.15],
          ],
          carbonFill
        );
        // Sweeping papaya spear down upper sidepod
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.55, 0.42],
            [-0.25, 0.65],
            [-1.18, 0.74],
            [-1.08, 0.60],
            [-0.20, 0.50],
            [0.45, 0.30],
          ],
          bodyBase
        );
        // Electric sky-blue velocity blade along the papaya-to-carbon seam
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.45, 0.32],
            [0.75, 0.54],
            [-0.38, 0.55],
            [-1.32, 0.76],
          ],
          stripePrimary,
          10
        );
        // Rear wing endplate: carbon lower, papaya upper, sky-blue accent slash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          carbonFill
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.64, 0.66],
            [-2.02, 0.76],
            [-2.02, 0.95],
            [-2.64, 0.95],
          ],
          bodyBase
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.65], [-2.02, 0.75]], stripePrimary, 8);
      }
      // TOP view: exposed carbon outer wings, halo & rear flanks framing crisp papaya central wedge
      ctx.fillStyle = carbonFill;
      ctx.fillRect(0, 0, topX(-1.15), TOP_H);
      drawTopSymmetricPoly(
        ctx,
        [
          [-1.3, 0.22],
          [0.35, 0.46],
          [0.65, 0.95],
          [-1.3, 0.95],
        ],
        carbonFill
      );
      // Carbon front wing mainplane + papaya outer tip flaps
      drawTopSymmetricPoly(
        ctx,
        [
          [1.82, 0.16],
          [2.78, 0.16],
          [2.78, 0.95],
          [1.82, 0.95],
        ],
        carbonFill
      );
      drawTopSymmetricPoly(
        ctx,
        [
          [1.92, 0.42],
          [2.52, 0.42],
          [2.64, 0.88],
          [1.96, 0.88],
        ],
        bodyBase
      );
      // Sky blue twin nose & sidepod pinstripes on TOP
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.65), topY(s * 0.08)],
            [topX(1.2), topY(s * 0.16)],
            [topX(0.35), topY(s * 0.44)],
            [topX(-1.2), topY(s * 0.22)],
          ],
          stripePrimary,
          8
        );
      }
      break;
    }

    case "rosso26": {
      // Ferrari 2026-style: Gloss Rosso crimson + iconic crisp white engine-cover/airbox/wing blocks + blue/yellow trim
      for (const isLeft of [true, false]) {
        // Bold crisp white angled engine-cover & airbox graphic block
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-1.72, 0.56],
            [-0.22, 0.62],
            [-0.18, 1.15],
            [-1.78, 1.15],
          ],
          bodySecondary
        );
        // Electric azure + Modena yellow twin accent stripes framing the white block
        strokeSideLine(
          ctx,
          isLeft,
          [
            [-1.74, 0.56],
            [-0.22, 0.62],
            [0.65, 0.68],
          ],
          stripeSecondary,
          10
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [-1.74, 0.53],
            [-0.22, 0.59],
            [0.65, 0.65],
          ],
          stripePrimary,
          7
        );
        // Lower carbon floor & sidepod undercut trim
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.0, 0.0],
            [0.9, 0.0],
            [0.8, 0.2],
            [-1.95, 0.18],
          ],
          carbonFill
        );
        // White & crimson rear wing endplate with blue accent chevron
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.62, 0.68],
            [-2.02, 0.68],
            [-2.02, 0.94],
            [-2.62, 0.94],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.62, 0.67], [-2.02, 0.67]], stripePrimary, 8);
      }
      // TOP view: white engine cover spine, white rear wing, white front wing upper flap, Modena yellow nose twin stripes
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(topX(-1.75), topY(0.32), topW(1.55), topH(0.64));
      ctx.fillRect(topX(-2.68), topY(0.58), topW(0.68), topH(1.16));
      drawTopSymmetricPoly(
        ctx,
        [
          [1.92, 0.18],
          [2.48, 0.18],
          [2.56, 0.88],
          [1.96, 0.88],
        ],
        bodySecondary
      );
      // Yellow + white longitudinal nose stripes
      ctx.fillStyle = stripeSecondary;
      ctx.fillRect(topX(0.75), topY(0.032), topW(1.98), topH(0.064));
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.7), topY(s * 0.048)],
            [topX(0.75), topY(s * 0.048)],
          ],
          bodySecondary,
          5
        );
        // Blue tech roundel on sidepod top deck
        ctx.fillStyle = stripePrimary;
        ctx.beginPath();
        ctx.arc(topX(-0.15), topY(s * 0.56), 28, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = bodySecondary;
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      break;
    }

    case "silver26": {
      // Mercedes 2026-style: Brushed alloy silver nose/spine transitioning to obsidian black flanks + vivid teal slash + star-field fade
      for (const isLeft of [true, false]) {
        // Obsidian black lower chassis & rear engine cover
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [1.65, 0.0],
            [0.85, 0.42],
            [-0.45, 0.68],
            [-1.35, 0.98],
            [-2.75, 1.15],
          ],
          bodySecondary
        );
        // Exposed carbon lower sill
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.1, 0.0],
            [0.8, 0.0],
            [0.7, 0.22],
            [-2.0, 0.2],
          ],
          carbonFill
        );
        // Vivid teal aerodynamic flow ribbon cutting from front to rear
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.45, 0.24],
            [1.15, 0.36],
            [0.15, 0.46],
            [-0.85, 0.54],
            [-2.05, 0.62],
          ],
          stripePrimary,
          15
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.45, 0.21],
            [1.15, 0.33],
            [0.15, 0.43],
            [-0.85, 0.51],
            [-2.05, 0.59],
          ],
          "#f8fafc",
          3
        );
        // Crimson airbox intake accent cap
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-0.65, 0.92],
            [-0.22, 0.92],
            [-0.22, 1.12],
            [-0.65, 1.12],
          ],
          stripeSecondary
        );
        // Subtle 3-point star scatter fade across dark engine cover & shark fin
        for (let i = 0; i < 18; i++) {
          const z = -0.58 - (i % 6) * 0.21 - Math.floor(i / 6) * 0.07;
          const y = 0.64 + Math.floor(i / 6) * 0.11 + (i % 2) * 0.03;
          ctx.save();
          ctx.globalAlpha = Math.max(0.14, 0.44 - (i % 6) * 0.055);
          drawEmblem(ctx, "tristar", sideX(z, isLeft), sideY(y, isLeft), 22, bodyBase, stripePrimary, "#e2e8f0");
          ctx.restore();
        }
        // Rear wing endplate: obsidian with silver top & teal flash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.84], [-2.02, 0.72]], stripePrimary, 11);
      }
      // TOP view: brushed liquid silver nose + obsidian sidepods & rear wing + teal twin sweep
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(0, 0, topX(-0.55), TOP_H);
      drawTopSymmetricPoly(
        ctx,
        [
          [-0.65, 0.22],
          [0.55, 0.38],
          [0.75, 0.95],
          [-0.65, 0.95],
        ],
        bodySecondary
      );
      // Obsidian rear wing & front wing inner flaps with teal leading stripes
      drawTopSymmetricPoly(
        ctx,
        [
          [1.86, 0.18],
          [2.68, 0.18],
          [2.72, 0.92],
          [1.86, 0.92],
        ],
        bodySecondary
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.68), topY(s * 0.2)],
            [topX(2.54), topY(s * 0.88)],
          ],
          stripePrimary,
          12
        );
        strokePoly(
          ctx,
          [
            [topX(1.65), topY(s * 0.14)],
            [topX(0.45), topY(s * 0.36)],
            [topX(-0.75), topY(s * 0.24)],
            [topX(-1.95), topY(s * 0.14)],
          ],
          stripePrimary,
          10
        );
      }
      break;
    }

    case "cobalt26": {
      // Red Bull 2026-style: Deep matte race navy + iconic bright yellow nose tip & airbox + sweeping crimson/gold bull-charge motif
      for (const isLeft of [true, false]) {
        // Subtle darker navy aerodynamic lower shadow
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [2.0, 0.0],
            [1.6, 0.25],
            [-2.75, 0.28],
          ],
          bodySecondary
        );
        // Signature bright racing-yellow nose cone tip
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.18, 0.14],
            [2.85, 0.14],
            [2.85, 0.45],
            [2.02, 0.45],
          ],
          stripeSecondary
        );
        // Iconic yellow airbox & engine cover sun crown
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-1.18, 0.66],
            [-0.18, 0.72],
            [-0.18, 1.15],
            [-1.12, 1.15],
          ],
          stripeSecondary
        );
        // Sweeping crimson charge flash across engine cover & sidepod shoulder
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-1.95, 0.56],
            [-0.95, 0.82],
            [-0.35, 0.76],
            [-0.65, 0.58],
            [-1.75, 0.44],
          ],
          stripePrimary
        );
        // Dynamic crimson & gold twin-horn charging crest over engine cover
        drawEmblem(ctx, "twinhorn", sideX(-0.78, isLeft), sideY(0.76, isLeft), 152, bodyBase, stripePrimary, stripeSecondary);
        // Sweeping red/yellow sidepod highlight pinstripe
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.65, 0.28],
            [-0.35, 0.30],
            [-1.35, 0.42],
          ],
          stripePrimary,
          9
        );
        // Rear wing endplate: navy with bold crimson slash & yellow top corner
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.64, 0.44],
            [-2.02, 0.72],
            [-2.02, 0.92],
            [-2.64, 0.68],
          ],
          stripePrimary
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.88], [-2.02, 0.88]], stripeSecondary, 9);
      }
      // TOP view: yellow nose tip, yellow airbox surround, crimson front wing & sidepod speed blades
      ctx.fillStyle = stripeSecondary;
      ctx.fillRect(topX(2.15), topY(0.24), topW(0.72), topH(0.48));
      ctx.fillRect(topX(-1.12), topY(0.24), topW(0.95), topH(0.48));
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.68), topY(s * 0.24)],
            [topX(2.56), topY(s * 0.88)],
          ],
          stripePrimary,
          14
        );
        strokePoly(
          ctx,
          [
            [topX(2.22), topY(s * 0.16)],
            [topX(2.22), topY(s * 0.0)],
          ],
          stripePrimary,
          9
        );
      }
      break;
    }

    case "emerald26": {
      // Aston Martin 2026-style: Metallic British Racing Green + razor-sharp electric lime contour pinstripe everywhere
      for (const isLeft of [true, false]) {
        // Sculpted deep emerald-black metallic shadow along lower sidepod
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [1.8, 0.0],
            [1.4, 0.24],
            [-2.75, 0.26],
          ],
          bodySecondary
        );
        // Signature electric lime continuous aero pinstripe tracing nose -> sidepod -> engine cover -> wing
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.78, 0.28],
            [1.45, 0.45],
            [0.52, 0.56],
            [-0.45, 0.54],
            [-1.65, 0.60],
          ],
          stripePrimary,
          9
        );
        // Halo lime accent edge
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.64, 0.84],
            [0.12, 0.90],
            [-0.32, 0.84],
          ],
          stripePrimary,
          8
        );
        // Rear wing endplate: emerald with crisp lime top & trailing-edge L-stripe
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [-2.62, 0.44],
            [-2.62, 0.91],
            [-2.04, 0.91],
          ],
          stripePrimary,
          10
        );
      }
      // TOP view: continuous electric lime nose & sidepod outline + leading edge front wing accent
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.74), topY(s * 0.08)],
            [topX(1.35), topY(s * 0.16)],
            [topX(0.5), topY(s * 0.48)],
            [topX(-0.95), topY(s * 0.46)],
            [topX(-1.85), topY(s * 0.18)],
          ],
          stripePrimary,
          9
        );
        strokePoly(
          ctx,
          [
            [topX(2.72), topY(s * 0.18)],
            [topX(2.58), topY(s * 0.88)],
          ],
          stripePrimary,
          12
        );
      }
      break;
    }

    case "bleu26": {
      // Alpine 2026-style: Metallic French Blue + bold electric pink swooshes + exposed carbon lower flanks
      for (const isLeft of [true, false]) {
        // Raw exposed carbon rear & lower triangular aero flanks
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [1.1, 0.0],
            [0.35, 0.34],
            [-0.62, 0.56],
            [-1.65, 0.72],
            [-2.75, 0.78],
          ],
          carbonFill
        );
        // Electric neon pink nose tip & sweeping sidepod boomerang swoosh
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.05, 0.16],
            [2.85, 0.16],
            [2.85, 0.44],
            [1.85, 0.44],
          ],
          stripePrimary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.58, 0.32],
            [-0.08, 0.54],
            [-1.12, 0.62],
            [-1.25, 0.50],
            [-0.18, 0.42],
            [0.46, 0.22],
          ],
          stripePrimary
        );
        // Crisp white speed accent line inside swoosh
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.56, 0.33],
            [-0.08, 0.55],
            [-1.12, 0.63],
          ],
          "#f8fafc",
          4
        );
        // Rear wing endplate: pink upper over carbon lower
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          carbonFill
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.64, 0.62],
            [-2.02, 0.62],
            [-2.02, 0.94],
            [-2.64, 0.94],
          ],
          stripePrimary
        );
      }
      // TOP view: pink nose cone tip & sidepod shoulder swooshes + exposed carbon rear
      ctx.fillStyle = stripePrimary;
      ctx.fillRect(topX(2.05), topY(0.24), topW(0.82), topH(0.48));
      ctx.fillStyle = carbonFill;
      ctx.fillRect(0, 0, topX(-1.3), TOP_H);
      drawTopSymmetricPoly(
        ctx,
        [
          [1.92, 0.24],
          [2.64, 0.24],
          [2.72, 0.88],
          [1.96, 0.88],
        ],
        stripePrimary
      );
      drawTopSymmetricPoly(
        ctx,
        [
          [-0.95, 0.48],
          [0.45, 0.46],
          [0.52, 0.66],
          [-0.85, 0.62],
        ],
        stripePrimary
      );
      break;
    }

    case "royal26": {
      // Williams 2026-style: Royal blue to midnight navy gradient + signature copper/black airbox intake + sky-blue pinstripes
      for (const isLeft of [true, false]) {
        const y0 = sideY(1.15, isLeft);
        const y1 = sideY(0.0, isLeft);
        const grad = ctx.createLinearGradient(0, y0, 0, y1);
        grad.addColorStop(0, "#197bf0");
        grad.addColorStop(0.52, "#0d47b8");
        grad.addColorStop(1, "#08122b");
        ctx.fillStyle = grad;
        ctx.fillRect(0, isLeft ? LEFT_Y : RIGHT_Y, F1_ATLAS_SIZE, SIDE_H);

        // Midnight navy rear taper
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [-0.45, 0.0],
            [-1.35, 0.72],
            [-2.75, 0.82],
          ],
          bodySecondary
        );
        // Signature copper-gold & black airbox battery-cell top intake graphic
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-0.86, 0.76],
            [-0.22, 0.76],
            [-0.22, 1.15],
            [-0.86, 1.15],
          ],
          "#0f1116"
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-0.86, 0.94],
            [-0.22, 0.94],
            [-0.22, 1.12],
            [-0.86, 1.12],
          ],
          stripeSecondary
        );
        // Vivid sky-blue + thin red aerodynamic pinstripes
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.65, 0.28],
            [0.85, 0.52],
            [-0.55, 0.56],
            [-1.78, 0.66],
          ],
          stripePrimary,
          9
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.65, 0.25],
            [0.85, 0.49],
            [-0.55, 0.53],
          ],
          "#ef4444",
          3.5
        );
        // Rear wing endplate
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.86], [-2.02, 0.74]], stripePrimary, 10);
      }
      // TOP view: royal-to-navy longitudinal gradient + copper airbox crown + sky twin pinstripes
      const topBlue = ctx.createLinearGradient(topX(-2.6), 0, topX(2.7), 0);
      topBlue.addColorStop(0, "#08122b");
      topBlue.addColorStop(0.55, "#0d47b8");
      topBlue.addColorStop(1, "#1c88f5");
      ctx.fillStyle = topBlue;
      ctx.fillRect(0, 0, F1_ATLAS_SIZE, TOP_H);
      ctx.fillStyle = stripeSecondary;
      ctx.fillRect(topX(-0.86), topY(0.18), topW(0.64), topH(0.36));
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.72), topY(s * 0.08)],
            [topX(0.75), topY(s * 0.16)],
            [topX(-1.5), topY(s * 0.36)],
          ],
          stripePrimary,
          8
        );
      }
      break;
    }

    case "bianco26": {
      // Racing Bulls 2026-style: Crisp pearl white + electric blue swooshes & yellow/crimson nose-to-engine-cover flashes
      for (const isLeft of [true, false]) {
        // Electric cobalt sweeping swoosh along sidepod & rear engine cover
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.25, 0.18],
            [-0.45, 0.22],
            [0.35, 0.44],
            [-0.55, 0.64],
            [-1.95, 0.78],
          ],
          bodySecondary
        );
        // Dynamic crimson & sunburst yellow lightning charge flashes
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-1.55, 0.72],
            [-0.38, 0.78],
            [-0.18, 0.68],
            [-1.35, 0.58],
          ],
          stripePrimary
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.45, 0.30],
            [1.10, 0.46],
            [-0.22, 0.68],
            [-1.48, 0.62],
          ],
          stripeSecondary,
          10
        );
        // Yellow nose flash tip
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.32, 0.16],
            [2.85, 0.16],
            [2.85, 0.42],
            [2.22, 0.42],
          ],
          stripeSecondary
        );
        // Rear wing endplate: white + cobalt lower + crimson slash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.62],
            [-2.68, 0.52],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.56], [-2.02, 0.66]], stripePrimary, 9);
      }
      // TOP view: pearl white base + cobalt sidepod wings + yellow nose flash & crimson spine flash
      ctx.fillStyle = stripeSecondary;
      ctx.fillRect(topX(2.3), topY(0.18), topW(0.56), topH(0.36));
      drawTopSymmetricPoly(
        ctx,
        [
          [-1.35, 0.28],
          [0.25, 0.46],
          [0.45, 0.78],
          [-1.35, 0.72],
        ],
        bodySecondary
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.3), topY(s * 0.06)],
            [topX(0.45), topY(s * 0.32)],
            [topX(-1.55), topY(s * 0.24)],
          ],
          stripePrimary,
          10
        );
      }
      break;
    }

    case "carbon26": {
      // Haas 2026-style: Stark glacier white & raw exposed carbon black + bold crimson racing slashes
      for (const isLeft of [true, false]) {
        // Aggressive exposed carbon lower sidepods, cockpit & rear flanks
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [2.05, 0.0],
            [1.45, 0.28],
            [0.45, 0.48],
            [-0.45, 0.48],
            [-1.45, 0.64],
            [-2.75, 0.72],
          ],
          carbonFill
        );
        // Bold crimson racing slashes on nose, sidepod & rear
        drawSidePoly(
          ctx,
          isLeft,
          [
            [1.95, 0.16],
            [2.55, 0.16],
            [2.32, 0.44],
            [1.72, 0.44],
          ],
          stripePrimary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.52, 0.44],
            [-0.35, 0.56],
            [-1.38, 0.68],
            [-1.45, 0.60],
            [-0.40, 0.48],
            [0.45, 0.36],
          ],
          stripePrimary
        );
        // Rear wing endplate: carbon with crisp white & crimson vertical slash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          carbonFill
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.48, 0.42],
            [-2.14, 0.42],
            [-2.02, 0.92],
            [-2.36, 0.92],
          ],
          stripePrimary
        );
      }
      // TOP view: stark white nose spine & engine cover crown framed by carbon wings/sidepods & crimson edge slashes
      drawTopSymmetricPoly(
        ctx,
        [
          [-2.75, 0.3],
          [0.55, 0.42],
          [0.72, 0.95],
          [-2.75, 0.95],
        ],
        carbonFill
      );
      drawTopSymmetricPoly(
        ctx,
        [
          [1.86, 0.18],
          [2.78, 0.18],
          [2.78, 0.95],
          [1.86, 0.95],
        ],
        carbonFill
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.65), topY(s * 0.22)],
            [topX(2.45), topY(s * 0.88)],
          ],
          stripePrimary,
          16
        );
        strokePoly(
          ctx,
          [
            [topX(2.4), topY(s * 0.12)],
            [topX(0.55), topY(s * 0.40)],
            [topX(-1.85), topY(s * 0.28)],
          ],
          stripePrimary,
          12
        );
      }
      break;
    }

    case "titanium26": {
      // Audi 2026-style: Brushed Titanium Silver front + 45-deg diagonal split to Matte Carbon rear + bold Lava-Red geometric slash & 4 interlocking rings
      for (const isLeft of [true, false]) {
        // Razor-sharp 45-degree geometric split: Titanium front, Matte Carbon rear
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [0.08, 0.0],
            [-0.92, 1.15],
            [-2.75, 1.15],
          ],
          carbonFill
        );
        // Bold lava-red diagonal geometric wedge along the split
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-0.22, 0.0],
            [0.14, 0.0],
            [-0.86, 1.15],
            [-1.22, 1.15],
          ],
          stripePrimary
        );
        // Lava-red airbox intake collar & rear wing endplate
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          stripePrimary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-2.24, 0.36],
            [-2.68, 0.72],
          ],
          carbonFill
        );
        // Crisp 4 interlocking rings on shark fin & rear endplate
        drawEmblem(ctx, "rings4", sideX(-1.56, isLeft), sideY(0.84, isLeft), 92, bodyBase, stripePrimary, "#f8fafc");
      }
      // TOP view: razor-sharp diagonal V-split titanium front -> lava red chevron -> matte carbon rear
      drawTopSymmetricPoly(
        ctx,
        [
          [-2.75, 0.0],
          [-0.45, 0.0],
          [0.18, 0.95],
          [-2.75, 0.95],
        ],
        carbonFill
      );
      drawTopSymmetricPoly(
        ctx,
        [
          [-0.78, 0.0],
          [-0.42, 0.0],
          [0.24, 0.95],
          [-0.12, 0.95],
        ],
        stripePrimary
      );
      // Lava red rear wing endplate top edges & front wing leading strips
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.7), topY(s * 0.2)],
            [topX(2.58), topY(s * 0.88)],
          ],
          stripePrimary,
          12
        );
      }
      break;
    }

    case "crest26": {
      // Cadillac 2026-style: Stealth carbon black & brushed chrome silver angular facets + bold gold & electric blue crest/stripes
      for (const isLeft of [true, false]) {
        // Exposed carbon base across flanks
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, isLeft ? LEFT_Y : RIGHT_Y, F1_ATLAS_SIZE, SIDE_H);
        // Sharp angular brushed chrome silver geometric flank facet
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.45, 0.24],
            [0.85, 0.54],
            [-0.65, 0.62],
            [-1.78, 0.76],
            [-1.52, 0.50],
            [0.35, 0.34],
            [2.25, 0.16],
          ],
          bodySecondary
        );
        // Metallic gold + electric royal blue sharp angular pinstripes
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.48, 0.26],
            [0.85, 0.56],
            [-0.65, 0.64],
            [-1.80, 0.78],
          ],
          stripePrimary,
          10
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.25, 0.16],
            [0.35, 0.34],
            [-1.52, 0.50],
          ],
          stripeSecondary,
          8
        );
        // Rear wing endplate: carbon + chrome triangle + gold/blue edge
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          carbonFill
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.64, 0.64],
            [-2.02, 0.92],
            [-2.64, 0.92],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.63], [-2.02, 0.91]], stripePrimary, 8);
      }
      // TOP view: stealth carbon wings & outer flanks + angular chrome nose/cockpit spine + gold & blue geometric lines
      ctx.fillStyle = carbonFill;
      ctx.fillRect(0, 0, F1_ATLAS_SIZE, TOP_H);
      drawTopSymmetricPoly(
        ctx,
        [
          [2.78, 0.0],
          [2.78, 0.14],
          [0.65, 0.34],
          [-0.95, 0.42],
          [-1.88, 0.16],
          [-1.88, 0.0],
        ],
        bodySecondary
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.74), topY(s * 0.14)],
            [topX(0.65), topY(s * 0.34)],
            [topX(-0.95), topY(s * 0.42)],
            [topX(-1.88), topY(s * 0.16)],
          ],
          stripePrimary,
          9
        );
        strokePoly(
          ctx,
          [
            [topX(2.7), topY(s * 0.22)],
            [topX(2.56), topY(s * 0.88)],
          ],
          stripeSecondary,
          10
        );
      }
      break;
    }

    // ---- 6 ICONIC RETRO LIVERIES ----

    case "retro88_chevron": {
      // 1988 Red & White Chevron: Crisp pure white nose & flanks + bold fluorescent red angular chevron on engine cover, sidepods & wings
      for (const isLeft of [true, false]) {
        // Bold fluorescent red-orange angular chevron across airbox, cockpit side & rear engine cover
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-1.95, 0.45],
            [-0.45, 0.45],
            [0.42, 0.94],
            [0.42, 1.15],
            [-1.95, 1.15],
          ],
          bodySecondary
        );
        // Forward-pointing red chevron wedge on sidepod shoulder
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.65, 0.18],
            [0.12, 0.56],
            [-0.58, 0.56],
            [-0.18, 0.18],
          ],
          bodySecondary
        );
        // Crisp black vintage floor sill
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.2, 0.0],
            [1.0, 0.0],
            [0.95, 0.13],
            [-2.15, 0.13],
          ],
          stripePrimary
        );
        // Rear wing endplate: white lower + fluorescent red upper chevron
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.62],
            [-1.98, 0.78],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
      }
      // TOP view: iconic forward-pointing fluorescent red V-chevron across cockpit, sidepods & rear wing
      drawTopSymmetricPoly(
        ctx,
        [
          [-2.05, 0.0],
          [0.58, 0.0],
          [-0.22, 0.76],
          [-2.05, 0.76],
        ],
        bodySecondary
      );
      // Red rear wing & red front wing outer chevron tips
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(topX(-2.68), topY(0.58), topW(0.68), topH(1.16));
      drawTopSymmetricPoly(
        ctx,
        [
          [1.92, 0.52],
          [2.72, 0.52],
          [2.72, 0.92],
          [1.92, 0.92],
        ],
        bodySecondary
      );
      break;
    }

    case "retro78_pinstripe": {
      // 1978 Black & Gold Pinstripe: Deep piano-black gloss lacquer + iconic double parallel metallic gold coachlines everywhere
      for (const isLeft of [true, false]) {
        // Double parallel metallic gold coachline tracing the full profile perimeter
        for (const dy of [0, 0.032]) {
          strokeSideLine(
            ctx,
            isLeft,
            [
              [2.74, 0.24 + dy],
              [1.25, 0.42 + dy],
              [0.48, 0.52 + dy],
              [-1.45, 0.52 + dy],
              [-1.92, 0.64 + dy],
            ],
            dy === 0 ? stripePrimary : stripeSecondary,
            dy === 0 ? 7 : 4
          );
          strokeSideLine(
            ctx,
            isLeft,
            [
              [0.62, 0.16 + dy * 0.8],
              [-1.45, 0.16 + dy * 0.8],
            ],
            stripePrimary,
            dy === 0 ? 6 : 3.5
          );
        }
        // Double gold coachline framing engine cover & shark fin
        strokeSideLine(
          ctx,
          isLeft,
          [
            [-0.26, 0.98],
            [-0.95, 0.92],
            [-1.78, 0.76],
          ],
          stripePrimary,
          6
        );
        // Rear wing endplate: piano black with crisp double gold box outline
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        const epX0 = Math.min(sideX(-2.64, isLeft), sideX(-2.02, isLeft));
        const epW = Math.abs(sideX(-2.02, isLeft) - sideX(-2.64, isLeft));
        const epY0 = sideY(0.92, isLeft);
        const epH = sideY(0.41, isLeft) - epY0;
        ctx.strokeStyle = stripePrimary;
        ctx.lineWidth = 6;
        ctx.strokeRect(epX0 + 8, epY0 + 8, epW - 16, epH - 16);
        ctx.strokeStyle = stripeSecondary;
        ctx.lineWidth = 3;
        ctx.strokeRect(epX0 + 18, epY0 + 18, epW - 36, epH - 36);
      }
      // TOP view: piano black with double gold coachlines tracing nose, sidepod edges, and front/rear wing borders
      for (const s of [-1, 1]) {
        for (const dx of [0, 0.028]) {
          strokePoly(
            ctx,
            [
              [topX(2.74), topY(s * (0.06 + dx))],
              [topX(0.95), topY(s * (0.14 + dx))],
              [topX(0.45), topY(s * (0.58 - dx))],
              [topX(-1.35), topY(s * (0.54 - dx))],
              [topX(-1.95), topY(s * (0.18 + dx))],
            ],
            dx === 0 ? stripePrimary : stripeSecondary,
            dx === 0 ? 7 : 4
          );
        }
        strokePoly(
          ctx,
          [
            [topX(2.68), topY(s * 0.2)],
            [topX(2.58), topY(s * 0.88)],
            [topX(1.96), topY(s * 0.88)],
          ],
          stripePrimary,
          7
        );
      }
      ctx.strokeStyle = stripePrimary;
      ctx.lineWidth = 7;
      ctx.strokeRect(topX(-2.64), topY(0.54), topW(0.6), topH(1.08));
      break;
    }

    case "retro93_tri": {
      // 1993 Blue, Yellow & White: Royal blue engine cover & nose tip, vivid yellow cockpit/sidepod sweep, crisp white flank panel + vermilion red pinstripe
      for (const isLeft of [true, false]) {
        // Vivid canary yellow upper cockpit & sweeping sidepod shoulder
        drawSidePoly(
          ctx,
          isLeft,
          [
            [1.95, 0.16],
            [0.75, 0.66],
            [-0.45, 0.72],
            [-1.35, 0.48],
            [-1.55, 0.28],
            [1.85, 0.16],
          ],
          bodySecondary
        );
        // Crisp white lower sidepod flank panel
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.85, 0.0],
            [0.72, 0.34],
            [-1.45, 0.34],
            [-1.85, 0.0],
          ],
          stripePrimary
        );
        // Signature vermilion red separator pinstripe between yellow sweep & white flank
        strokeSideLine(
          ctx,
          isLeft,
          [
            [1.95, 0.24],
            [0.72, 0.34],
            [-1.45, 0.34],
            [-1.95, 0.44],
          ],
          stripeSecondary,
          9
        );
        // Royal blue nose tip cap
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.05, 0.12],
            [2.85, 0.12],
            [2.85, 0.46],
            [1.88, 0.46],
          ],
          bodyBase
        );
        // Rear wing endplate: canary yellow with royal blue & red bottom stripe
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.56],
            [-2.68, 0.56],
          ],
          bodyBase
        );
        strokeSideLine(ctx, isLeft, [[-2.68, 0.57], [-1.98, 0.57]], stripeSecondary, 7);
      }
      // TOP view: royal blue rear/airbox & nose tip, vivid yellow mid-body/cockpit/sidepod sweep, white front wing flaps
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(topX(-0.65), topY(0.75), topW(2.65), topH(1.5));
      // Royal blue nose tip + royal blue engine cover & rear wing
      ctx.fillStyle = bodyBase;
      ctx.fillRect(topX(1.98), topY(0.24), topW(0.88), topH(0.48));
      ctx.fillRect(0, 0, topX(-0.65), TOP_H);
      // White outer front wing panels
      drawTopSymmetricPoly(
        ctx,
        [
          [1.92, 0.22],
          [2.7, 0.22],
          [2.72, 0.88],
          [1.94, 0.88],
        ],
        stripePrimary
      );
      // Red accent divider line on TOP
      strokePoly(
        ctx,
        [
          [topX(-0.65), topY(0.72)],
          [topX(-0.65), topY(-0.72)],
        ],
        stripeSecondary,
        10
      );
      break;
    }

    case "retro05_sky": {
      // 2005 Sky-Blue & Yellow: Bright sky blue chassis + bold sweeping canary-yellow nose, airbox & sidepod flashes + deep navy trim
      for (const isLeft of [true, false]) {
        // Bold sweeping canary-yellow nose & upper engine cover / airbox
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.85, 0.14],
            [2.85, 0.55],
            [0.85, 0.66],
            [-0.18, 0.72],
            [-0.18, 1.15],
            [-1.42, 1.15],
            [-1.12, 0.66],
            [0.55, 0.44],
            [1.92, 0.14],
          ],
          bodySecondary
        );
        // Sweeping canary yellow sidepod lower scoop flash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.58, 0.18],
            [-0.55, 0.24],
            [-1.15, 0.42],
            [-0.45, 0.36],
            [0.48, 0.34],
          ],
          bodySecondary
        );
        // Crisp deep navy aerodynamic outline between sky-blue and yellow
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.05, 0.18],
            [0.55, 0.44],
            [-1.12, 0.66],
            [-1.42, 1.12],
          ],
          stripePrimary,
          11
        );
        // Navy lower floor sill
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.2, 0.0],
            [1.0, 0.0],
            [0.95, 0.16],
            [-2.15, 0.16],
          ],
          stripePrimary
        );
        // Rear wing endplate: canary yellow with sky blue & navy slash
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.62],
            [-2.68, 0.48],
          ],
          bodyBase
        );
        strokeSideLine(ctx, isLeft, [[-2.68, 0.49], [-1.98, 0.63]], stripePrimary, 8);
      }
      // TOP view: sky blue sidepods & rear wing + bold canary-yellow central nose-to-airbox spear + navy keyline
      ctx.fillStyle = bodySecondary;
      drawTopSymmetricPoly(
        ctx,
        [
          [-1.55, 0.0],
          [2.85, 0.0],
          [2.85, 0.24],
          [0.75, 0.32],
          [-0.95, 0.28],
          [-1.55, 0.16],
        ],
        bodySecondary
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.75), topY(s * 0.22)],
            [topX(0.75), topY(s * 0.32)],
            [topX(-0.95), topY(s * 0.28)],
            [topX(-1.55), topY(s * 0.16)],
          ],
          stripePrimary,
          10
        );
        // Yellow front wing tips
        drawTopSymmetricPoly(
          ctx,
          [
            [1.92, 0.56],
            [2.72, 0.56],
            [2.72, 0.92],
            [1.92, 0.92],
          ],
          bodySecondary
        );
      }
      break;
    }

    case "retro09_fluoro": {
      // 2009 White & Fluoro-Lime: Brilliant pure-white chassis + electric fluorescent yellow-lime sweeping bands & crisp black outline
      for (const isLeft of [true, false]) {
        // Jet black lower sill
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.2, 0.0],
            [1.1, 0.0],
            [0.95, 0.18],
            [-2.15, 0.16],
          ],
          stripePrimary
        );
        // Signature electric fluoro-lime continuous ribbon from nose tip through sidepod to rear
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.85, 0.16],
            [2.85, 0.34],
            [0.85, 0.42],
            [-0.45, 0.32],
            [-1.85, 0.38],
            [-1.85, 0.22],
            [-0.45, 0.18],
            [0.85, 0.26],
          ],
          bodySecondary
        );
        // Crisp jet-black keylines edging the fluoro band
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.82, 0.34],
            [0.85, 0.42],
            [-0.45, 0.32],
            [-1.85, 0.38],
          ],
          stripePrimary,
          7
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.85, 0.26],
            [-0.45, 0.18],
            [-1.85, 0.22],
          ],
          stripePrimary,
          6
        );
        // Fluoro-lime cockpit collar & dorsal spine strip
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.65, 0.72],
            [-0.25, 0.98],
            [-1.65, 0.84],
          ],
          bodySecondary,
          14
        );
        strokeSideLine(
          ctx,
          isLeft,
          [
            [0.65, 0.69],
            [-0.25, 0.95],
            [-1.65, 0.81],
          ],
          stripePrimary,
          5
        );
        // Rear wing endplate: brilliant white with fluoro-lime edge & black outline
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodyBase
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.66, 0.76],
            [-2.0, 0.76],
            [-2.0, 0.94],
            [-2.66, 0.94],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.66, 0.75], [-2.0, 0.75]], stripePrimary, 7);
      }
      // TOP view: clean pure white + fluoro-lime nose tip, twin nose-to-engine bands with crisp black keyline, fluoro front wing edge
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(topX(2.38), topY(0.18), topW(0.5), topH(0.36));
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.4), topY(s * 0.12)],
            [topX(0.65), topY(s * 0.24)],
            [topX(-1.65), topY(s * 0.2)],
          ],
          bodySecondary,
          16
        );
        strokePoly(
          ctx,
          [
            [topX(2.4), topY(s * 0.15)],
            [topX(0.65), topY(s * 0.27)],
            [topX(-1.65), topY(s * 0.23)],
          ],
          stripePrimary,
          6
        );
        strokePoly(
          ctx,
          [
            [topX(2.72), topY(s * 0.18)],
            [topX(2.58), topY(s * 0.88)],
          ],
          bodySecondary,
          18
        );
        strokePoly(
          ctx,
          [
            [topX(2.65), topY(s * 0.18)],
            [topX(2.51), topY(s * 0.88)],
          ],
          stripePrimary,
          5
        );
      }
      break;
    }

    case "retro99_hornet": {
      // 1999 Buzzing Yellow & Black: Vivid hornet yellow chassis + aggressive black nose-cone wasp/stinger fangs + diagonal black hazard slashes
      for (const isLeft of [true, false]) {
        // Aggressive jet-black nose-cone graphic with jagged stinger edge
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.85, 0.10],
            [2.85, 0.48],
            [1.65, 0.48],
            [1.92, 0.34],
            [1.48, 0.26],
            [1.75, 0.10],
          ],
          bodySecondary
        );
        // Crimson wasp-eye accent slash on nose flank
        drawSidePoly(
          ctx,
          isLeft,
          [
            [2.32, 0.34],
            [1.82, 0.42],
            [1.98, 0.32],
          ],
          stripePrimary
        );
        // Bold diagonal black hornet hazard stripes across sidepod & engine cover
        for (const z0 of [0.18, -0.22, -0.62, -1.18]) {
          drawSidePoly(
            ctx,
            isLeft,
            [
              [z0, 0.12],
              [z0 - 0.18, 0.12],
              [z0 - 0.42, 0.72],
              [z0 - 0.24, 0.72],
            ],
            bodySecondary
          );
        }
        // Black lower sill & rear wing endplate with hornet yellow stripe
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.2, 0.0],
            [1.0, 0.0],
            [0.95, 0.16],
            [-2.15, 0.16],
          ],
          bodySecondary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        strokeSideLine(ctx, isLeft, [[-2.62, 0.88], [-2.04, 0.56]], bodyBase, 14);
        strokeSideLine(ctx, isLeft, [[-2.62, 0.78], [-2.04, 0.46]], stripePrimary, 5);
      }
      // TOP view: vivid hornet yellow + jet-black nose-cone wasp fangs + black diagonal shoulder slashes + black wings
      drawTopSymmetricPoly(
        ctx,
        [
          [2.85, 0.0],
          [2.85, 0.22],
          [1.62, 0.16],
          [1.92, 0.05],
          [1.52, 0.0],
        ],
        bodySecondary
      );
      ctx.fillStyle = bodySecondary;
      ctx.fillRect(topX(-2.68), topY(0.58), topW(0.68), topH(1.16));
      for (const z0 of [0.22, -0.25, -0.75]) {
        drawTopSymmetricPoly(
          ctx,
          [
            [z0, 0.24],
            [z0 - 0.16, 0.24],
            [z0 - 0.42, 0.78],
            [z0 - 0.26, 0.78],
          ],
          bodySecondary
        );
      }
      break;
    }

    // ---- HOUSE ORIGINALS & CUSTOM ----
    case "librecorsa":
    case "aurora":
    case "verdant":
    case "custom":
    default: {
      // Dynamic multi-zone modern F1 speed-chevron layout in the livery's primary / secondary / accent colours
      const darkFill = spec.carbonExposure > 0.65 ? carbonFill : bodySecondary;
      for (const isLeft of [true, false]) {
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.75, 0.0],
            [0.85, 0.0],
            [0.25, 0.36],
            [-0.75, 0.58],
            [-1.85, 0.80],
            [-2.75, 0.86],
          ],
          darkFill
        );
        // Sweeping accent chevron ribbon separating primary and secondary zones
        drawSidePoly(
          ctx,
          isLeft,
          [
            [0.65, 0.32],
            [-0.55, 0.56],
            [-1.78, 0.78],
            [-1.86, 0.70],
            [-0.62, 0.48],
            [0.55, 0.24],
          ],
          stripePrimary
        );
        // Crisp white/secondary highlight thread
        strokeSideLine(
          ctx,
          isLeft,
          [
            [2.42, 0.28],
            [0.65, 0.34],
            [-0.55, 0.58],
            [-1.78, 0.80],
          ],
          stripeSecondary,
          4
        );
        // Rear wing endplate
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.68, 0.36],
            [-1.98, 0.36],
            [-1.98, 0.96],
            [-2.68, 0.96],
          ],
          bodySecondary
        );
        drawSidePoly(
          ctx,
          isLeft,
          [
            [-2.64, 0.68],
            [-2.02, 0.78],
            [-2.02, 0.94],
            [-2.64, 0.94],
          ],
          bodyBase
        );
        strokeSideLine(ctx, isLeft, [[-2.64, 0.67], [-2.02, 0.77]], stripePrimary, 9);
      }
      // TOP view: primary nose & upper deck, dark carbon/secondary rear & outer sidepod sweep, crisp accent speed lines
      ctx.fillStyle = darkFill;
      ctx.fillRect(0, 0, topX(-1.15), TOP_H);
      drawTopSymmetricPoly(
        ctx,
        [
          [-1.25, 0.24],
          [0.32, 0.46],
          [0.65, 0.95],
          [-1.25, 0.95],
        ],
        darkFill
      );
      for (const s of [-1, 1]) {
        strokePoly(
          ctx,
          [
            [topX(2.68), topY(s * 0.08)],
            [topX(0.95), topY(s * 0.16)],
            [topX(0.28), topY(s * 0.46)],
            [topX(-1.25), topY(s * 0.24)],
          ],
          stripePrimary,
          10
        );
      }
      break;
    }
  }

  // 3) Dedicated REAR FACE panel (0..1024, 1728..2048): crisp rear-wing banner backing
  const rwBg = spec.wingMain ?? bodySecondary;
  ctx.fillStyle = rwBg;
  ctx.fillRect(0, BOTTOM_Y, 1024, BOTTOM_H);
  // Top & bottom aero accent strips on rear wing face
  ctx.fillStyle = stripePrimary;
  ctx.fillRect(0, rearY(0.94), 1024, 14);
  ctx.fillRect(0, rearY(0.67), 1024, 10);
  // Subtle lower beam wing / crash-structure carbon fill
  ctx.fillStyle = spec.carbonExposure > 0.35 ? carbonFill : bodySecondary;
  ctx.fillRect(0, rearY(0.63), 1024, BOTTOM_Y + BOTTOM_H - rearY(0.63));

  // 4) Dedicated FRONT FACE panel (1024..1536, 1728..2048): nose tip & front wing leading edge
  ctx.fillStyle = spec.noseTip ?? bodyBase;
  ctx.fillRect(1024, BOTTOM_Y, 512, BOTTOM_H);
  ctx.fillStyle = spec.carbonExposure > 0.4 ? carbonFill : bodySecondary;
  ctx.fillRect(1024, frontY(0.22), 512, BOTTOM_Y + BOTTOM_H - frontY(0.22));
  ctx.fillStyle = stripePrimary;
  ctx.fillRect(1024, frontY(0.24), 512, 12);

  // 5) Dedicated FRONT WING ENDPLATE panels (1536..2048, top=left, bottom=right)
  const epBg = spec.endplate ?? bodyBase;
  for (const isLeft of [true, false]) {
    const yTop = isLeft ? BOTTOM_Y : BOTTOM_Y + 160;
    ctx.fillStyle = epBg;
    ctx.fillRect(1536, yTop, 512, 160);
    // Carbon/dark lower footplate strip
    ctx.fillStyle = spec.carbonExposure > 0.3 ? carbonFill : bodySecondary;
    ctx.fillRect(1536, fwEpY(0.17, isLeft), 512, yTop + 160 - fwEpY(0.17, isLeft));
    // Diagonal racing accent slash across front wing endplate
    fillPoly(
      ctx,
      [
        [fwEpX(2.68, isLeft), fwEpY(0.45, isLeft)],
        [fwEpX(2.42, isLeft), fwEpY(0.45, isLeft)],
        [fwEpX(2.12, isLeft), fwEpY(0.17, isLeft)],
        [fwEpX(2.38, isLeft), fwEpY(0.17, isLeft)],
      ],
      stripePrimary
    );
    // Top leading border accent
    ctx.fillStyle = stripePrimary;
    ctx.fillRect(1536, yTop, 512, 10);
  }
}

// ---------------------------------------------------------------------------
// Sponsors, Emblems & Racing Numbers Overlay (100% right-reading on every face)
// ---------------------------------------------------------------------------

function paintBrandingAndNumbers(
  ctx: CanvasRenderingContext2D,
  livery: LiveryConfig,
  spec: LiveryVisualSpec
): void {
  const kind = emblemKindFor(spec.pattern);
  const isRetro = livery.category === "retro";
  const isSerif = spec.pattern === "retro78_pinstripe";
  const sp = spec.sponsors;

  const sideInk = (() => {
    switch (spec.pattern) {
      case "papaya26":
      case "silver26":
      case "cobalt26":
      case "emerald26":
      case "bleu26":
      case "royal26":
      case "carbon26":
      case "titanium26":
      case "crest26":
      case "verdant":
        return "#f8fafc";
      case "retro78_pinstripe":
        return "#ebca68";
      case "retro93_tri":
        return "#123296";
      case "retro88_chevron":
      case "retro09_fluoro":
      case "retro99_hornet":
      case "bianco26":
      case "aurora":
      case "librecorsa":
        return "#11131a";
      case "retro05_sky":
        return "#0e224a";
      case "rosso26":
        return "#f8fafc";
      default:
        return contrastInk(spec.bodyBase);
    }
  })();
  const sideOutline = luma(sideInk) > 0.5 ? "rgba(8,10,14,0.85)" : "rgba(255,255,255,0.85)";
  const rwBg = spec.wingMain ?? spec.bodySecondary;
  const rwInk =
    spec.pattern === "retro78_pinstripe"
      ? "#ebca68"
      : spec.pattern === "retro99_hornet"
        ? "#f6c90e"
        : contrastInk(rwBg);
  const epBg = spec.endplate ?? spec.bodyBase;
  const epInk = spec.pattern === "retro78_pinstripe" ? "#ebca68" : contrastInk(epBg);

  // ---- 1) SIDE PANELS (Left +X and Right -X): crisp unmirrored sidepod, shark fin, nose flank, halo & rear endplate ----
  for (const isLeft of [true, false]) {
    // Huge bold Title Sponsor along the main sidepod flank (z = -0.35, y = 0.42)
    drawWordmark(ctx, sp.title, sideX(-0.34, isLeft), sideY(0.41, isLeft), 330, 56, sideInk, {
      italic: !isSerif,
      serif: isSerif,
      outline: sideOutline,
      outlineWidth: 7,
      accentBar: spec.stripePrimary,
      rotRad: isLeft ? 0.04 : -0.04,
    });

    // Secondary tech partner on front cockpit / nose flank (z = 1.48, y = 0.34)
    drawWordmark(ctx, sp.nose, sideX(1.48, isLeft), sideY(0.35, isLeft), 168, 28, sideInk, {
      italic: !isSerif,
      serif: isSerif,
      outline: sideOutline,
      outlineWidth: 4,
    });

    // Halo side sponsor (z = 0.12, y = 0.84)
    const haloInk = spec.pattern === "retro78_pinstripe" ? "#ebca68" : contrastInk(spec.halo ?? spec.bodySecondary);
    drawWordmark(ctx, sp.halo, sideX(0.12, isLeft), sideY(0.84, isLeft), 150, 22, haloInk, {
      italic: !isSerif,
      serif: isSerif,
      outline: "rgba(0,0,0,0.65)",
      outlineWidth: 3,
    });

    // Shark Fin Driver Racing Number (z = -1.32, y = 0.77)
    const numBg = spec.numberBg ?? spec.bodySecondary;
    const numFg = spec.numberColor ?? contrastInk(numBg);
    drawDriverNumber(ctx, livery.number, sideX(-1.32, isLeft), sideY(0.77, isLeft), 72, numFg, numBg, spec.stripePrimary, {
      retroBox: isRetro,
      serif: isSerif,
    });

    // Small team emblem on engine cover forward of shark fin (z = -0.52, y = 0.88)
    if (spec.pattern !== "cobalt26") {
      drawEmblem(
        ctx,
        kind,
        sideX(-0.56, isLeft),
        sideY(0.88, isLeft),
        56,
        spec.bodyBase,
        spec.stripePrimary,
        spec.stripeSecondary ?? "#f8fafc"
      );
    }

    // Rear wing endplate wordmark (z = -2.33, y = 0.72)
    drawWordmark(ctx, sp.wing, sideX(-2.33, isLeft), sideY(0.73, isLeft), 175, 28, epInk, {
      italic: !isSerif,
      serif: isSerif,
      outline: luma(epInk) > 0.5 ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.75)",
      outlineWidth: 4,
    });
  }

  // ---- 2) TOP PANEL: Nose tip emblem, Nose sponsor, Nose deck driver number, Sidepod top sponsors, Rear wing top banner ----
  // Nose tip team emblem (z = 2.42, x = 0) — oriented right-side up when viewed from front (-PI/2)
  drawEmblem(
    ctx,
    kind,
    topX(2.42),
    topY(0),
    62,
    spec.bodyBase,
    spec.stripePrimary,
    spec.stripeSecondary ?? "#f8fafc",
    -Math.PI / 2
  );

  // Mid-nose sponsor wordmark (z = 1.94, x = 0)
  const noseInk =
    spec.pattern === "retro78_pinstripe"
      ? "#ebca68"
      : contrastInk(spec.noseTip ?? spec.bodyBase);
  drawWordmark(ctx, sp.nose, topX(1.94), topY(0), 115, 26, noseInk, {
    rotRad: -Math.PI / 2,
    italic: !isSerif,
    serif: isSerif,
    outline: luma(noseInk) > 0.5 ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.75)",
    outlineWidth: 4,
  });

  // Upper nose deck Driver Racing Number (z = 1.32, x = 0) — bold, broadcast-clear!
  drawDriverNumber(
    ctx,
    livery.number,
    topX(1.32),
    topY(0),
    78,
    spec.numberColor ?? contrastInk(spec.numberBg ?? spec.bodySecondary),
    spec.numberBg ?? spec.bodySecondary,
    spec.stripePrimary,
    { rotRad: -Math.PI / 2, retroBox: isRetro, serif: isSerif }
  );

  // Front wing upper plane symmetric partner wordmarks (z = 2.26, x = +-0.54)
  for (const s of [-1, 1]) {
    drawWordmark(ctx, sp.wing, topX(2.26), topY(s * 0.54), 175, 28, contrastInk(spec.bodySecondary), {
      rotRad: -Math.PI / 2,
      italic: !isSerif,
      serif: isSerif,
      outline: "rgba(0,0,0,0.72)",
      outlineWidth: 4,
    });
  }

  // Sidepod top shoulder tech wordmarks (z = -0.18, x = +-0.54)
  for (const s of [-1, 1]) {
    drawWordmark(ctx, sp.tech, topX(-0.18), topY(s * 0.54), 185, 28, sideInk, {
      rotRad: s > 0 ? 0 : Math.PI,
      italic: !isSerif,
      serif: isSerif,
      outline: sideOutline,
      outlineWidth: 4,
    });
  }

  // Rear wing top mainplane partner banner (z = -2.32, x = 0) — readable from chase cam (+PI/2)
  drawWordmark(ctx, sp.wing, topX(-2.32), topY(0), 340, 48, rwInk, {
    rotRad: Math.PI / 2,
    italic: !isSerif,
    serif: isSerif,
    outline: luma(rwInk) > 0.5 ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.8)",
    outlineWidth: 6,
  });

  // ---- 3) REAR FACE PANEL (chase-cam hero view!): HUGE ultra-crisp Rear Wing Title Sponsor Banner ----
  drawWordmark(ctx, sp.title, rearX(0), rearY(0.81), 690, 96, rwInk, {
    italic: !isSerif,
    serif: isSerif,
    outline: luma(rwInk) > 0.5 ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.85)",
    outlineWidth: 8,
  });
  // Flanking small team emblems on outer rear wing face
  for (const s of [-1, 1]) {
    drawEmblem(
      ctx,
      kind,
      rearX(s * 0.45),
      rearY(0.81),
      56,
      spec.bodyBase,
      spec.stripePrimary,
      spec.stripeSecondary ?? "#f8fafc"
    );
  }

  // ---- 4) FRONT FACE PANEL: Nose tip crest emblem ----
  drawEmblem(
    ctx,
    kind,
    frontX(0),
    frontY(0.32),
    72,
    spec.bodyBase,
    spec.stripePrimary,
    spec.stripeSecondary ?? "#f8fafc"
  );

  // ---- 5) FRONT WING ENDPLATES (dedicated Left & Right panels — zero nose-cone bleed!) ----
  for (const isLeft of [true, false]) {
    drawWordmark(ctx, sp.tech, fwEpX(2.3, isLeft), fwEpY(0.31, isLeft), 250, 34, epInk, {
      italic: !isSerif,
      serif: isSerif,
      outline: luma(epInk) > 0.5 ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.75)",
      outlineWidth: 4,
    });
  }
}

/** Paints the full 2048x2048 6-panel F1 livery atlas onto a provided 2D context (usable in browser and Node test harnesses) */
export function renderF1LiveryToContext(
  ctx: CanvasRenderingContext2D,
  livery: LiveryConfig,
  pixelSize = F1_ATLAS_SIZE
): void {
  const spec = resolveLiveryVisual(livery);
  if (!isCapableCanvas2DContext(ctx)) {
    const partial = ctx as Partial<CanvasRenderingContext2D> | null | undefined;
    if (partial && typeof partial.fillRect === "function") {
      partial.fillStyle = spec.bodyBase;
      partial.fillRect(0, 0, pixelSize, pixelSize);
    }
    return;
  }
  const scale = pixelSize / F1_ATLAS_SIZE;
  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);

  const carbonFill = createCarbonFill(ctx);
  paintPatternGraphics(ctx, spec, carbonFill);
  drawAeroDetails(ctx, spec, carbonFill);
  paintBrandingAndNumbers(ctx, livery, spec);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Atlas Texture Cache (shared across all cars wearing the same livery)
// ---------------------------------------------------------------------------

const MAX_CACHED_ATLASES = 22;
const atlasCache = new Map<string, THREE.CanvasTexture>();
let customAtlasSlot: { key: string; tex: THREE.CanvasTexture } | null = null;

function atlasCacheKey(livery: LiveryConfig): string {
  const v = livery.visual;
  return `${livery.id}|${livery.primary}|${livery.secondary}|${livery.accent}|${livery.number}|${v?.pattern ?? "def"}`;
}

function chooseAtlasResolution(): number {
  if (typeof window === "undefined") return F1_ATLAS_SIZE;
  // Crisp 2048px on desktop / tablets; 1024px on compact mobile viewports to stay GPU-memory friendly
  return typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth < 768
    ? 1024
    : F1_ATLAS_SIZE;
}

/** Generates (or retrieves from cache) the high-DPI CanvasTexture livery atlas for an F1 livery */
export function getF1LiveryAtlasTexture(livery: LiveryConfig): THREE.CanvasTexture | null {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
  const key = atlasCacheKey(livery);
  const isCustom = livery.id === "custom";
  if (isCustom) {
    if (customAtlasSlot && customAtlasSlot.key === key) return customAtlasSlot.tex;
  } else {
    const hit = atlasCache.get(key);
    if (hit) return hit;
  }

  const size = chooseAtlasResolution();
  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function") return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!isCapableCanvas2DContext(ctx)) return null;

  renderF1LiveryToContext(ctx, livery, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `f1_livery_atlas_${livery.id}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  if (isCustom) {
    customAtlasSlot?.tex.dispose();
    customAtlasSlot = { key, tex };
  } else {
    atlasCache.set(key, tex);
    while (atlasCache.size > MAX_CACHED_ATLASES) {
      const oldest = atlasCache.keys().next().value;
      if (oldest === undefined) break;
      const stale = atlasCache.get(oldest);
      atlasCache.delete(oldest);
      stale?.dispose();
    }
  }
  return tex;
}

// ---------------------------------------------------------------------------
// Object-Space Tri-Orthographic Livery Projection Shader (LC26 & Procedural F1)
// ---------------------------------------------------------------------------

/**
 * Where the rear face panel's wing artwork stops (car-space Z, m): it is drawn for the rear wing and crash structure
 * (z < -1.5 on `f12026.glb`); rear-facing surfaces ahead of the fade, above its carbon base, take the top view's colour
 */
const REAR_PANEL_Z_FROM = -1.4;
const REAR_PANEL_Z_TO = -1.3;

const BLANK_ATLAS = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
BLANK_ATLAS.colorSpace = THREE.SRGBColorSpace;
BLANK_ATLAS.needsUpdate = true;

const LIV_VERTEX_PATCH = /* glsl */ `#include <common>
uniform mat4 uLiveryFrame;
varying vec3 vLivPos;
varying vec3 vLivNrm;`;

const LIV_VERTEX_BODY = /* glsl */ `#include <begin_vertex>
vLivPos = ( uLiveryFrame * vec4( position, 1.0 ) ).xyz;
vLivNrm = normalize( mat3( uLiveryFrame ) * normal );`;

const LIV_FRAGMENT_PATCH = /* glsl */ `#include <common>
uniform sampler2D uLiveryAtlas;
uniform float uLiveryEnabled;
uniform float uLiveryCarbonStrength;
varying vec3 vLivPos;
varying vec3 vLivNrm;

vec2 f1AtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
	vec2 pad = vec2( 2.0 / 2048.0 );
	vec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
	return rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float f1CarbonTwill( vec2 p ) {
	vec2 c = floor( p );
	float warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
	return 2.0 * warp - 1.0;
}`;

const LIV_FRAGMENT_MAP = /* glsl */ `#include <map_fragment>
float f1CarbonMask = 0.0;
if ( uLiveryEnabled > 0.5 ) {
	vec3 lp = vLivPos;
	vec3 ln = normalize( vLivNrm );

	// 1) TOP panel: rect (0, 0, 1, 768/2048)
	vec2 uvTop = vec2( ( lp.z - (${Z_MIN.toFixed(2)}) ) / ${Z_SPAN.toFixed(2)}, (${X_MAX.toFixed(2)} - lp.x) / ${X_SPAN.toFixed(2)} );
	vec3 colTop = texture2D( uLiveryAtlas, f1AtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.375 ) ) ).rgb;

	// 2) SIDE panel: Left (+X), Right (-X), or dedicated Front Wing Endplates (|x|>0.55 & z>1.75)
	vec3 colSide;
	bool isLeftSide = ln.x >= 0.0;
	if ( lp.z > 1.75 && abs( lp.x ) > 0.55 ) {
		float fwU = isLeftSide ? ( 2.75 - lp.z ) / 0.95 : ( lp.z - 1.80 ) / 0.95;
		float fwV = ( 0.46 - lp.y ) / 0.38;
		float fwY0 = isLeftSide ? 0.84375 : 0.921875;
		colSide = texture2D( uLiveryAtlas, f1AtlasClamp( vec2( fwU, fwV ), vec2( 0.75, fwY0 ), vec2( 0.25, 0.078125 ) ) ).rgb;
	} else if ( isLeftSide ) {
		vec2 uvL = vec2( (${Z_MAX.toFixed(2)} - lp.z) / ${Z_SPAN.toFixed(2)}, (${Y_MAX.toFixed(2)} - lp.y) / ${Y_SPAN.toFixed(2)} );
		colSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvL, vec2( 0.0, 0.375 ), vec2( 1.0, 0.234375 ) ) ).rgb;
	} else {
		vec2 uvR = vec2( ( lp.z - (${Z_MIN.toFixed(2)}) ) / ${Z_SPAN.toFixed(2)}, (${Y_MAX.toFixed(2)} - lp.y) / ${Y_SPAN.toFixed(2)} );
		colSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvR, vec2( 0.0, 0.609375 ), vec2( 1.0, 0.234375 ) ) ).rgb;
	}

	// The halo's inner faces (above the cockpit rim, facing the car's centre line) would take the far side's panel and
	// its halo sponsor, squeezed onto the curved tube: they take the top view's colour, like the rest of the hoop
	if ( lp.y > 0.80 && lp.z > -0.06 && lp.z < 0.70 && abs( lp.x ) < 0.36 && ln.x * lp.x < 0.0 ) {
		colSide = colTop;
	}

	// 3) REAR / FRONT face panel
	vec3 colEnd;
	if ( ln.z < 0.0 ) {
		vec2 uvRear = vec2( ( 0.65 - lp.x ) / 1.30, ( 1.00 - lp.y ) / 0.65 );
		colEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
		// The rear panel's upper part is the rear wing's face (its title banner spans y 0.71..0.91): projected along Z it
		// also landed on every rear-facing surface ahead of the gearbox at that height, the halo's front arc above all,
		// where the banner showed as smeared letter slices across the hoop. Those take the top view's colour; lower down
		// the panel is plain carbon and stays
		float midCar = smoothstep( ${REAR_PANEL_Z_FROM.toFixed(2)}, ${REAR_PANEL_Z_TO.toFixed(2)}, lp.z ) * smoothstep( 0.60, 0.64, lp.y );
		colEnd = mix( colEnd, colTop, midCar );
	} else {
		vec2 uvFront = vec2( ( lp.x - (${X_MIN.toFixed(2)}) ) / ${X_SPAN.toFixed(2)}, ( 0.65 - lp.y ) / 0.57 );
		colEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.25, 0.15625 ) ) ).rgb;
	}

	// Sharp tri-orthographic weights so top/side/rear text stays crisp without ghosting
	float wx = pow( abs( ln.x ), 4.0 );
	float wy = pow( max( ln.y, 0.0 ) + 0.35 * max( -ln.y, 0.0 ), 4.0 );
	float wz = pow( abs( ln.z ), 6.0 );
	// Ensure the angled rear wing mainplane & DRS flap face shows the crisp chase-cam rear banner
	if ( lp.z < -2.02 && lp.y > 0.58 && abs( lp.x ) < 0.52 && ln.z < -0.22 ) {
		wz = max( wz, 4.0 );
	}
	vec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );
	diffuseColor.rgb = livCol;

	// Detect exposed dark carbon regions (linear max channel < 0.028) for subtle 2x2 twill sheen modulation
	float maxC = max( livCol.r, max( livCol.g, livCol.b ) );
	f1CarbonMask = ( 1.0 - smoothstep( 0.016, 0.032, maxC ) ) * uLiveryCarbonStrength;
}`;

const LIV_FRAGMENT_ROUGHNESS = /* glsl */ `#include <roughnessmap_fragment>
if ( f1CarbonMask > 0.01 ) {
	vec3 cn = abs( normalize( vLivNrm ) );
	vec2 cp = cn.y > 0.6 ? vLivPos.xz : ( cn.x > 0.6 ? vLivPos.zy : vLivPos.xy );
	float invPitch = 190.0;
	vec3 dP = fwidth( vLivPos );
	float towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
	float fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
	float twill = f1CarbonTwill( cp * invPitch ) * fade * f1CarbonMask;
	roughnessFactor = mix( roughnessFactor, 0.36, f1CarbonMask * 0.7 ) + 0.055 * twill;
	diffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

export interface F1LiverySurface {
  material: THREE.MeshPhysicalMaterial;
  /** Optional static rest transform into BODY car-space (e.g. closed-pose matrix for moving active-aero flaps) */
  frameMatrix?: THREE.Matrix4;
}

export interface F1LiveryPaintController {
  /** Applies a procedural livery (or disables procedural override when `null`) */
  set: (livery: LiveryConfig | null) => boolean;
}

/**
 * Installs the zero-recompile tri-orthographic procedural F1 livery shader onto a car's own paint materials.
 * When `set(null)` is called, the shader becomes a no-op and falls back to the base paint zone colours.
 */
export function installF1LiveryPaint(surfaces: readonly F1LiverySurface[]): F1LiveryPaintController {
  const sharedUniforms = {
    uLiveryAtlas: { value: BLANK_ATLAS as THREE.Texture },
    uLiveryEnabled: { value: 0.0 },
    uLiveryCarbonStrength: { value: 0.0 },
  };
  const identity = new THREE.Matrix4();
  const baseFinishes = surfaces.map(({ material: m }) => ({
    roughness: m.roughness,
    metalness: m.metalness,
    clearcoat: m.clearcoat,
    clearcoatRoughness: m.clearcoatRoughness,
    specularIntensity: m.specularIntensity,
  }));

  for (const s of surfaces) {
    const m = s.material;
    const frameUniform = { value: (s.frameMatrix ?? identity).clone() };
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      Object.assign(shader.uniforms, sharedUniforms, { uLiveryFrame: frameUniform });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", LIV_VERTEX_PATCH)
        .replace("#include <begin_vertex>", LIV_VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", LIV_FRAGMENT_PATCH)
        .replace("#include <map_fragment>", LIV_FRAGMENT_MAP)
        .replace("#include <roughnessmap_fragment>", LIV_FRAGMENT_ROUGHNESS);
    };
    const prevKey = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${prevKey()}|f1-procedural-livery-v1`;
    m.needsUpdate = true;
  }

  const restoreBaseFinish = () => {
    for (let i = 0; i < surfaces.length; i++) {
      const m = surfaces[i].material;
      const b = baseFinishes[i];
      m.roughness = b.roughness;
      m.metalness = b.metalness;
      m.clearcoat = b.clearcoat;
      m.clearcoatRoughness = b.clearcoatRoughness;
      m.specularIntensity = b.specularIntensity;
    }
  };

  return {
    set: (livery) => {
      if (!livery) {
        sharedUniforms.uLiveryEnabled.value = 0.0;
        sharedUniforms.uLiveryCarbonStrength.value = 0.0;
        restoreBaseFinish();
        return false;
      }
      const atlas = getF1LiveryAtlasTexture(livery);
      if (!atlas) {
        sharedUniforms.uLiveryEnabled.value = 0.0;
        sharedUniforms.uLiveryCarbonStrength.value = 0.0;
        restoreBaseFinish();
        return false;
      }
      const spec = resolveLiveryVisual(livery);
      const finish = LIVERY_FINISH_PROFILES[spec.finish] ?? LIVERY_FINISH_PROFILES.satin;
      sharedUniforms.uLiveryAtlas.value = atlas;
      sharedUniforms.uLiveryEnabled.value = 1.0;
      sharedUniforms.uLiveryCarbonStrength.value = spec.carbonExposure;

      for (const { material: m } of surfaces) {
        m.color.setHex(0xffffff);
        m.roughness = finish.roughness;
        m.metalness = finish.metalness;
        m.clearcoat = finish.clearcoat;
        m.clearcoatRoughness = finish.clearcoatRoughness;
        m.specularIntensity = finish.specularIntensity;
      }
      return true;
    },
  };
}
