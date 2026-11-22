import * as THREE from "three";
import { LIVERY_FINISH_PROFILES } from "@/lib/render/f1-livery-painter";
import type { LiveryFinish } from "@/types/f1";

/**
 * Broadcast-grade procedural 2048px GT3 livery engine + object-space tri-orthographic PBR projection shader
 * for the Mercedes-AMG GT3 Evo (`MI_Mercedes_AMG_GT3_Evo_Livery`) and BMW M4 GT3 Evo (`BMWMAT_GT3_EVO_car_paint1`).
 *
 * Paints a 2048x2048 5-panel orthographic atlas (Top, Left Side, Right Side, Rear, Front) calibrated to each car's
 * measured BODY geometry bounds and panel coordinates (hood, roof, doors, wheel arches, mirrors, rear wing).
 *
 * - Zero mirrored typography on any panel (left/right sides mirror graphics symmetrically while painting right-reading
 *   sponsors and framed GT3 number plates on both sides; hood/roof/wing-top text reads upright from the front 3/4 view).
 * - Per-livery PBR finish profiles (gloss lacquer, velvet satin, deep race matte, liquid metallic, brushed chrome).
 * - Procedural 2x2 twill carbon-weave roughness modulation on dark carbon aero zones (rocker skirts, vents, rear quarters).
 * - Zero shader recompiles on livery swap: `set(null)` restores the GLB's original material & baked paint seamlessly.
 */

export const GT3_ATLAS_SIZE = 2048;

// Atlas panel layout inside 2048x2048 (flipY = false, y increases downward)
const TOP_H = 832; // 0..832       (0.40625)
const SIDE_H = 448; // 832..1280, 1280..1728 (0.21875 each)
const LEFT_Y = TOP_H; // 832
const RIGHT_Y = LEFT_Y + SIDE_H; // 1280
const BOTTOM_Y = RIGHT_Y + SIDE_H; // 1728
const BOTTOM_H = GT3_ATLAS_SIZE - BOTTOM_Y; // 320 (0.15625)
const HALF_W = GT3_ATLAS_SIZE / 2; // 1024

export type Gt3CarTarget = "amg-gt3" | "bmw-m4-gt3";

export type Gt3LiveryPattern =
  | "verstappen"
  | "wrt_works"
  | "wrt_46"
  | "rowe"
  | "schubert"
  | "paul_miller"
  | "turner"
  | "mamba"
  | "iron_lynx_lime"
  | "iron_lynx_cobalt"
  | "getspeed"
  | "gruppem"
  | "express_75"
  | "silver_arrow";

export interface Gt3NumberPlateStyle {
  bg: string;
  text: string;
  headerBg: string;
  headerText: string;
  headerLabel: string;
  border: string;
}

export interface Gt3LiverySpec {
  id: string;
  car: Gt3CarTarget;
  name: string;
  team: string;
  number: string;
  pattern: Gt3LiveryPattern;
  finish: LiveryFinish;
  /** Swatch colours [primary, secondary, accent] for the skin picker */
  swatch: readonly [string, string, string];
  primary: string;
  secondary: string;
  accent: string;
  highlight: string;
  mirrorColor: string;
  wingColor: string;
  wingText: string;
  wingTextColor: string;
  carbonExposure: number;
  plate: Gt3NumberPlateStyle;
  sponsors: {
    door: string;
    doorSub?: string;
    hood: string;
    hoodSub?: string;
    rear: string;
    fender: readonly [string, string, string];
  };
}

/** Measured car-local paint surface bounds and normalized panel positions for each GT3 GLB */
export interface Gt3BodyProfile {
  car: Gt3CarTarget;
  paintMaterial: string;
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Normalized Z (0 = rear tail, 1 = front nose) for body zones */
  wingZ1: number;
  roofZ0: number;
  roofZ1: number;
  hoodZ0: number;
  hoodZ1: number;
  doorZ0: number;
  doorZ1: number;
  rearWheelZ: number;
  frontWheelZ: number;
  mirrorZ: number;
  /** Normalized Y (0 = floor, 1 = roof top) for key vertical landmarks */
  rockerY: number;
  doorMidY: number;
  beltY: number;
  mirrorY: number;
  wingY: number;
  /** World-space Z threshold behind which the rear wing sits */
  wingRearZ: number;
  /** World-space Z threshold ahead of which the hood sits */
  hoodStartZ: number;
  /** Optional world-space Y/Z bounds for an exposed carbon front splitter shelf (AMG GT3 Evo) */
  splitterMaxY: number;
  splitterMinZ: number;
}

export const GT3_BODY_PROFILES: Readonly<Record<Gt3CarTarget, Gt3BodyProfile>> = {
  "amg-gt3": {
    car: "amg-gt3",
    paintMaterial: "MI_Mercedes_AMG_GT3_Evo_Livery",
    min: [-1.03, 0.07, -2.28],
    max: [1.03, 1.25, 2.38],
    wingZ1: 0.11,
    roofZ0: 0.24,
    roofZ1: 0.52,
    hoodZ0: 0.61,
    hoodZ1: 0.97,
    doorZ0: 0.31,
    doorZ1: 0.68,
    rearWheelZ: 0.226,
    frontWheelZ: 0.79,
    mirrorZ: 0.54,
    rockerY: 0.19,
    doorMidY: 0.42,
    beltY: 0.64,
    mirrorY: 0.72,
    wingY: 0.87,
    wingRearZ: -1.80,
    hoodStartZ: 0.55,
    splitterMaxY: 0.185,
    splitterMinZ: 2.02,
  },
  "bmw-m4-gt3": {
    car: "bmw-m4-gt3",
    paintMaterial: "BMWMAT_GT3_EVO_car_paint1",
    min: [-1.025, 0.05, -2.495],
    max: [1.025, 1.30, 2.445],
    wingZ1: 0.10,
    roofZ0: 0.29,
    roofZ1: 0.60,
    hoodZ0: 0.67,
    hoodZ1: 0.965,
    doorZ0: 0.39,
    doorZ1: 0.675,
    rearWheelZ: 0.235,
    frontWheelZ: 0.823,
    mirrorZ: 0.595,
    rockerY: 0.17,
    doorMidY: 0.43,
    beltY: 0.65,
    mirrorY: 0.72,
    wingY: 0.85,
    wingRearZ: -2.02,
    hoodStartZ: 0.78,
    splitterMaxY: 0.0,
    splitterMinZ: 99.0,
  },
};

export const GT3_BODY_PROFILE_BY_MATERIAL: Readonly<Record<string, Gt3BodyProfile>> = {
  [GT3_BODY_PROFILES["amg-gt3"].paintMaterial]: GT3_BODY_PROFILES["amg-gt3"],
  [GT3_BODY_PROFILES["bmw-m4-gt3"].paintMaterial]: GT3_BODY_PROFILES["bmw-m4-gt3"],
};

// ---------------------------------------------------------------------------
// 14 Broadcast-Grade Procedural GT3 Liveries (7 BMW M4 GT3 Evo + 7 AMG GT3 Evo)
// ---------------------------------------------------------------------------

export const GT3_LIVERIES: readonly Gt3LiverySpec[] = [
  // ===================== BMW M4 GT3 EVO (7 procedural) =====================
  {
    id: "bmw_verstappen_33",
    car: "bmw-m4-gt3",
    name: "#33 Verstappen Racing",
    team: "Verstappen Racing",
    number: "33",
    pattern: "verstappen",
    finish: "matte",
    swatch: ["#0d1c45", "#dc143c", "#f6c915"],
    primary: "#0c1a42",
    secondary: "#dc143c",
    accent: "#f6c915",
    highlight: "#f8fafc",
    mirrorColor: "#f6c915",
    wingColor: "#0c1a42",
    wingText: "VERSTAPPEN RACING",
    wingTextColor: "#f8fafc",
    carbonExposure: 0.65,
    plate: {
      bg: "#f8fafc",
      text: "#0b1224",
      headerBg: "#dc143c",
      headerText: "#ffffff",
      headerLabel: "PRO",
      border: "#0c1a42",
    },
    sponsors: {
      door: "VERSTAPPEN",
      doorSub: "RACING",
      hood: "VERSTAPPEN",
      hoodSub: "RACING",
      rear: "VERSTAPPEN RACING",
      fender: ["KRONOS", "VELOX", "APEX OIL"],
    },
  },
  {
    id: "bmw_wrt_32",
    car: "bmw-m4-gt3",
    name: "#32 Team WRT Works",
    team: "Team WRT",
    number: "32",
    pattern: "wrt_works",
    finish: "gloss",
    swatch: ["#f3f6fa", "#009fe3", "#e11d2e"],
    primary: "#f3f6fa",
    secondary: "#131822",
    accent: "#009fe3",
    highlight: "#e11d2e",
    mirrorColor: "#009fe3",
    wingColor: "#131822",
    wingText: "TEAM WRT",
    wingTextColor: "#ffffff",
    carbonExposure: 0.8,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#1b2f7a",
      headerText: "#ffffff",
      headerLabel: "GTWC PRO",
      border: "#0b0f17",
    },
    sponsors: {
      door: "TEAM WRT",
      doorSub: "M MOTORSPORT",
      hood: "WRT WORKS",
      hoodSub: "MOTORSPORT",
      rear: "TEAM WRT",
      fender: ["VORTEX", "STRATA", "KINETIX"],
    },
  },
  {
    id: "bmw_wrt_46",
    car: "bmw-m4-gt3",
    name: "#46 WRT \"Il Dottore\"",
    team: "Team WRT",
    number: "46",
    pattern: "wrt_46",
    finish: "gloss",
    swatch: ["#0b2363", "#d8ec00", "#f4f7fb"],
    primary: "#0b2363",
    secondary: "#f4f7fb",
    accent: "#d6ea00",
    highlight: "#00b8f0",
    mirrorColor: "#d6ea00",
    wingColor: "#0b2363",
    wingText: "WRT · 46",
    wingTextColor: "#d6ea00",
    carbonExposure: 0.7,
    plate: {
      bg: "#0b111e",
      text: "#e2f500",
      headerBg: "#ff6600",
      headerText: "#ffffff",
      headerLabel: "LMGT3",
      border: "#d6ea00",
    },
    sponsors: {
      door: "SOLARIS",
      doorSub: "TEAM WRT",
      hood: "TEAM WRT",
      hoodSub: "MOTORSPORT",
      rear: "SOLARIS · WRT",
      fender: ["TURBINE", "CORSA", "VELOX"],
    },
  },
  {
    id: "bmw_rowe_98",
    car: "bmw-m4-gt3",
    name: "#98 ROWE Racing",
    team: "ROWE Racing",
    number: "98",
    pattern: "rowe",
    finish: "satin",
    swatch: ["#13161d", "#f2f5f9", "#f2cf00"],
    primary: "#13161d",
    secondary: "#f2f5f9",
    accent: "#f2cf00",
    highlight: "#d91c2b",
    mirrorColor: "#f2cf00",
    wingColor: "#13161d",
    wingText: "ROWE RACING",
    wingTextColor: "#f2cf00",
    carbonExposure: 0.85,
    plate: {
      bg: "#ffffff",
      text: "#0e1116",
      headerBg: "#0056b3",
      headerText: "#ffffff",
      headerLabel: "24H PRO",
      border: "#f2cf00",
    },
    sponsors: {
      door: "ROWE SPEC",
      doorSub: "SYNTHETIC OIL",
      hood: "ROWE RACING",
      hoodSub: "APEX OIL",
      rear: "ROWE RACING",
      fender: ["APEX OIL", "KRONOS", "STRATA"],
    },
  },
  {
    id: "bmw_schubert_11",
    car: "bmw-m4-gt3",
    name: "#11 Schubert Motorsport",
    team: "Schubert Motorsport",
    number: "11",
    pattern: "schubert",
    finish: "gloss",
    swatch: ["#f5f7fa", "#008f36", "#13171f"],
    primary: "#f5f7fa",
    secondary: "#008f36",
    accent: "#13171f",
    highlight: "#e11d2e",
    mirrorColor: "#008f36",
    wingColor: "#13171f",
    wingText: "SCHUBERT",
    wingTextColor: "#00d455",
    carbonExposure: 0.78,
    plate: {
      bg: "#ffffff",
      text: "#0d1117",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "DTM",
      border: "#13171f",
    },
    sponsors: {
      door: "KINETIX",
      doorSub: "SCHUBERT",
      hood: "SCHUBERT",
      hoodSub: "MOTORSPORT",
      rear: "KINETIX MOTION",
      fender: ["AETHER", "VELOX", "CORSA"],
    },
  },
  {
    id: "bmw_paul_miller_1",
    car: "bmw-m4-gt3",
    name: "#1 Paul Miller Racing",
    team: "Paul Miller Racing",
    number: "1",
    pattern: "paul_miller",
    finish: "gloss",
    swatch: ["#f6f8fb", "#008e42", "#004da8"],
    primary: "#f6f8fb",
    secondary: "#008e42",
    accent: "#004da8",
    highlight: "#d91c2b",
    mirrorColor: "#d91c2b",
    wingColor: "#004da8",
    wingText: "PAUL MILLER",
    wingTextColor: "#ffffff",
    carbonExposure: 0.75,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#d91c2b",
      headerText: "#ffffff",
      headerLabel: "GTD PRO",
      border: "#d91c2b",
    },
    sponsors: {
      door: "PMR RACING",
      doorSub: "GTD PRO",
      hood: "PAUL MILLER",
      hoodSub: "RACING",
      rear: "PAUL MILLER RACING",
      fender: ["TURBINE", "STRATA", "APEX OIL"],
    },
  },
  {
    id: "bmw_turner_96",
    car: "bmw-m4-gt3",
    name: "#96 Turner Motorsport",
    team: "Turner Motorsport",
    number: "96",
    pattern: "turner",
    finish: "gloss",
    swatch: ["#ebb800", "#003fa8", "#f8fafc"],
    primary: "#ebb800",
    secondary: "#003fa8",
    accent: "#f8fafc",
    highlight: "#111622",
    mirrorColor: "#003fa8",
    wingColor: "#003fa8",
    wingText: "TURNER MOTORSPORT",
    wingTextColor: "#f5c800",
    carbonExposure: 0.7,
    plate: {
      bg: "#ffffff",
      text: "#0a1020",
      headerBg: "#00843d",
      headerText: "#ffffff",
      headerLabel: "GTD",
      border: "#003fa8",
    },
    sponsors: {
      door: "TURNER",
      doorSub: "MOTORSPORT",
      hood: "TURNER",
      hoodSub: "VELOX",
      rear: "TURNER MOTORSPORT",
      fender: ["VELOX", "CORSA", "VORTEX"],
    },
  },

  // =================== MERCEDES-AMG GT3 EVO (7 procedural) =================
  {
    id: "amg_mamba_48",
    car: "amg-gt3",
    name: "#48 Mamba Racing",
    team: "Mamba Racing",
    number: "48",
    pattern: "mamba",
    finish: "gloss",
    swatch: ["#e8cc00", "#007c36", "#111318"],
    primary: "#e8cc00",
    secondary: "#007c36",
    accent: "#111318",
    highlight: "#ffffff",
    mirrorColor: "#007c36",
    wingColor: "#111318",
    wingText: "MAMBA RACING",
    wingTextColor: "#f2dc00",
    carbonExposure: 0.72,
    plate: {
      bg: "#ffffff",
      text: "#0b0e13",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "DTM",
      border: "#111318",
    },
    sponsors: {
      door: "MAMBA",
      doorSub: "RACING TEAM",
      hood: "MAMBA",
      hoodSub: "CORSA",
      rear: "MAMBA RACING",
      fender: ["CORSA", "VELOX", "APEX OIL"],
    },
  },
  {
    id: "amg_iron_lynx_61",
    car: "amg-gt3",
    name: "#61 Iron Lynx (WEC)",
    team: "Iron Lynx",
    number: "61",
    pattern: "iron_lynx_lime",
    finish: "satin",
    swatch: ["#11141a", "#b0ea00", "#eef3f8"],
    primary: "#11141a",
    secondary: "#b0ea00",
    accent: "#eef3f8",
    highlight: "#76a800",
    mirrorColor: "#b0ea00",
    wingColor: "#11141a",
    wingText: "IRON LYNX",
    wingTextColor: "#b0ea00",
    carbonExposure: 0.9,
    plate: {
      bg: "#ffffff",
      text: "#0a0e14",
      headerBg: "#ff6a00",
      headerText: "#ffffff",
      headerLabel: "LMGT3",
      border: "#b0ea00",
    },
    sponsors: {
      door: "IRON LYNX",
      doorSub: "AETHER LABS",
      hood: "IRON LYNX",
      hoodSub: "MOTORSPORT",
      rear: "IRON LYNX",
      fender: ["AETHER", "KRONOS", "STRATA"],
    },
  },
  {
    id: "amg_iron_lynx_79",
    car: "amg-gt3",
    name: "#79 Iron Lynx Cobalt",
    team: "Iron Lynx",
    number: "79",
    pattern: "iron_lynx_cobalt",
    finish: "gloss",
    swatch: ["#0042b0", "#10141d", "#29ccf5"],
    primary: "#0042b0",
    secondary: "#10141d",
    accent: "#29ccf5",
    highlight: "#f4f8fc",
    mirrorColor: "#29ccf5",
    wingColor: "#10141d",
    wingText: "IRON LYNX",
    wingTextColor: "#29ccf5",
    carbonExposure: 0.82,
    plate: {
      bg: "#ffffff",
      text: "#0b111c",
      headerBg: "#ff6a00",
      headerText: "#ffffff",
      headerLabel: "LMGT3",
      border: "#29ccf5",
    },
    sponsors: {
      door: "IRON LYNX",
      doorSub: "SOLARIS",
      hood: "IRON LYNX",
      hoodSub: "SOLARIS",
      rear: "IRON LYNX · 79",
      fender: ["SOLARIS", "VORTEX", "TURBINE"],
    },
  },
  {
    id: "amg_getspeed_17",
    car: "amg-gt3",
    name: "#17 GetSpeed Performance",
    team: "GetSpeed",
    number: "17",
    pattern: "getspeed",
    finish: "satin",
    swatch: ["#f2f5f9", "#131720", "#e11d2e"],
    primary: "#f2f5f9",
    secondary: "#131720",
    accent: "#e11d2e",
    highlight: "#0077ff",
    mirrorColor: "#e11d2e",
    wingColor: "#131720",
    wingText: "GETSPEED",
    wingTextColor: "#ffffff",
    carbonExposure: 0.85,
    plate: {
      bg: "#ffffff",
      text: "#0c1018",
      headerBg: "#0056b3",
      headerText: "#ffffff",
      headerLabel: "24H PRO",
      border: "#e11d2e",
    },
    sponsors: {
      door: "GETSPEED",
      doorSub: "PERFORMANCE",
      hood: "GETSPEED",
      hoodSub: "TURBINE",
      rear: "GETSPEED",
      fender: ["TURBINE", "KINETIX", "VELOX"],
    },
  },
  {
    id: "amg_gruppem_99",
    car: "amg-gt3",
    name: "#99 GruppeM Racing",
    team: "GruppeM Racing",
    number: "99",
    pattern: "gruppem",
    finish: "metallic",
    swatch: ["#dde4ec", "#d60024", "#0d2042"],
    primary: "#dde4ec",
    secondary: "#d60024",
    accent: "#0d2042",
    highlight: "#eab308",
    mirrorColor: "#d60024",
    wingColor: "#0d2042",
    wingText: "GRUPPEM RACING",
    wingTextColor: "#ffffff",
    carbonExposure: 0.72,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#d60024",
      headerText: "#ffffff",
      headerLabel: "IGTC PRO",
      border: "#0d2042",
    },
    sponsors: {
      door: "GRUPPEM",
      doorSub: "RACING",
      hood: "GRUPPEM",
      hoodSub: "KRONOS",
      rear: "GRUPPEM RACING",
      fender: ["KRONOS", "CORSA", "STRATA"],
    },
  },
  {
    id: "amg_express_75",
    car: "amg-gt3",
    name: "#75 75 Express",
    team: "75 Express",
    number: "75",
    pattern: "express_75",
    finish: "metallic",
    swatch: ["#ff5a00", "#0e1117", "#f5c542"],
    primary: "#ff5a00",
    secondary: "#0e1117",
    accent: "#f5c542",
    highlight: "#ffffff",
    mirrorColor: "#ff5a00",
    wingColor: "#0e1117",
    wingText: "75 EXPRESS",
    wingTextColor: "#ff5a00",
    carbonExposure: 0.78,
    plate: {
      bg: "#0d1016",
      text: "#ffffff",
      headerBg: "#ff5a00",
      headerText: "#ffffff",
      headerLabel: "IGTC",
      border: "#f5c542",
    },
    sponsors: {
      door: "75 EXPRESS",
      doorSub: "SOLARIS ENERGY",
      hood: "75 EXPRESS",
      hoodSub: "SOLARIS",
      rear: "75 EXPRESS",
      fender: ["SOLARIS", "APEX OIL", "VELOX"],
    },
  },
  {
    id: "amg_silver_arrow_00",
    car: "amg-gt3",
    name: "#00 Affalterbach Works",
    team: "Affalterbach Works",
    number: "00",
    pattern: "silver_arrow",
    finish: "chrome",
    swatch: ["#c7d0da", "#10141a", "#00d4be"],
    primary: "#c7d0da",
    secondary: "#10141a",
    accent: "#00d4be",
    highlight: "#f8fafc",
    mirrorColor: "#00d4be",
    wingColor: "#10141a",
    wingText: "AFFALTERBACH",
    wingTextColor: "#00d4be",
    carbonExposure: 0.92,
    plate: {
      bg: "#ffffff",
      text: "#0b0f17",
      headerBg: "#00b8a4",
      headerText: "#061314",
      headerLabel: "WORKS",
      border: "#00d4be",
    },
    sponsors: {
      door: "AFFALTERBACH",
      doorSub: "WORKS RACING",
      hood: "WORKS GT3",
      hoodSub: "KRONOS",
      rear: "AFFALTERBACH WORKS",
      fender: ["KRONOS", "AETHER", "VORTEX"],
    },
  },
];

export const GT3_LIVERY_BY_ID: ReadonlyMap<string, Gt3LiverySpec> = new Map(
  GT3_LIVERIES.map((spec) => [spec.id, spec])
);

export function gt3LiveryById(id: string): Gt3LiverySpec | undefined {
  return GT3_LIVERY_BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Canvas2D Drawing Helpers
// ---------------------------------------------------------------------------

function isCapableCanvas2DContext(ctx: CanvasRenderingContext2D | null | undefined): ctx is CanvasRenderingContext2D {
  return Boolean(
    ctx &&
      typeof ctx.save === "function" &&
      typeof ctx.beginPath === "function" &&
      typeof ctx.fillRect === "function" &&
      typeof ctx.fillText === "function" &&
      typeof ctx.createLinearGradient === "function"
  );
}

/** Creates a 2x2 diagonal carbon-weave CanvasPattern for exposed carbon aero zones */
function createCarbonPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
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
      const phase = ((x + y) / 4) % 4;
      tc.fillStyle = phase < 2 ? "#191e26" : "#0c0f14";
      tc.fillRect(x, y, 4, 4);
      if (phase === 0) {
        tc.fillStyle = "rgba(255,255,255,0.045)";
        tc.fillRect(x, y, 4, 2);
      }
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

function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: readonly (readonly [number, number])[],
  color: string,
  width: number
) {
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

/**
 * Helper to draw symmetric graphics across BOTH side panels using a unified car-space side coordinate system:
 * - `zN`: 0 = rear tail, 1 = front nose
 * - `yN`: 0 = floor (`yMin`), 1 = roof top (`yMax`)
 *
 * Maps cleanly to Left panel (nose on left, tail on right) and Right panel (tail on left, nose on right)
 * so stripes, wedges, scales, and carbon splits flow identically on both sides!
 */
interface SideMapper {
  isLeft: boolean;
  /** X pixel in canvas space for normalized longitudinal position zN (0 = rear, 1 = front) */
  x: (zN: number) => number;
  /** Y pixel in canvas space for normalized vertical position yN (0 = floor, 1 = roof) */
  y: (yN: number) => number;
  /** Convert an array of [zN, yN] points to canvas [px, py] */
  pts: (coords: readonly (readonly [number, number])[]) => [number, number][];
}

function makeSideMapper(isLeft: boolean): SideMapper {
  const y0 = isLeft ? LEFT_Y : RIGHT_Y;
  const x = (zN: number) => (isLeft ? (1 - zN) * GT3_ATLAS_SIZE : zN * GT3_ATLAS_SIZE);
  const y = (yN: number) => y0 + (1 - yN) * SIDE_H;
  return {
    isLeft,
    x,
    y,
    pts: (coords) => coords.map(([zN, yN]) => [x(zN), y(yN)]),
  };
}

/**
 * Helper for TOP panel in car-space coordinates:
 * - `zN`: 0 = rear tail (canvas x = 0), 1 = front nose (canvas x = 2048)
 * - `xN`: -1 = right edge (canvas y = TOP_H), 0 = centerline (canvas y = TOP_H/2), +1 = left edge (canvas y = 0)
 */
const topX = (zN: number) => zN * GT3_ATLAS_SIZE;
const topY = (xN: number) => (0.5 - xN * 0.5) * TOP_H;
const topPts = (coords: readonly (readonly [number, number])[]): [number, number][] =>
  coords.map(([zN, xN]) => [topX(zN), topY(xN)]);

/** Draw symmetric polygon on TOP panel (mirrored across centerline xN = 0) */
function fillTopMirror(
  ctx: CanvasRenderingContext2D,
  coords: readonly (readonly [number, number])[],
  fill: string | CanvasGradient | CanvasPattern
) {
  fillPoly(ctx, topPts(coords), fill);
  fillPoly(ctx, topPts(coords.map(([z, x]) => [z, -x] as const)), fill);
}

/** Draw upright motorsport wordmark on TOP panel (reads left-to-right when viewing the front of the car!) */
function drawTopText(
  ctx: CanvasRenderingContext2D,
  text: string,
  zN: number,
  xN: number,
  fontPx: number,
  color: string,
  opts?: { italic?: boolean; maxW?: number; outline?: string; outlineW?: number; letterSpacing?: number }
) {
  const cx = topX(zN);
  const cy = topY(xN);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2);
  ctx.font = `${opts?.italic ? "italic " : ""}900 ${fontPx}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
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

/** Draw upright right-reading text on a SIDE panel (never mirrored!) */
function drawSideText(
  ctx: CanvasRenderingContext2D,
  m: SideMapper,
  text: string,
  zN: number,
  yN: number,
  fontPx: number,
  color: string,
  opts?: { italic?: boolean; maxW?: number; outline?: string; outlineW?: number; tiltDeg?: number }
) {
  ctx.save();
  ctx.translate(m.x(zN), m.y(yN));
  if (opts?.tiltDeg) {
    ctx.rotate(((m.isLeft ? -opts.tiltDeg : opts.tiltDeg) * Math.PI) / 180);
  }
  ctx.font = `${opts?.italic ? "italic " : ""}900 ${fontPx}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
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

/** Draw stylized angular racing lion crest (original geometric vector emblem for Verstappen Racing!) */
function drawGeometricLionCrest(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  primaryColor: string,
  accentColor: string,
  rotationRad = 0,
  alpha = 1
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotationRad);
  ctx.globalAlpha = alpha;
  const s = radius / 100;

  // Outer angular crown / mane shards
  const maneShards: readonly (readonly [number, number][])[] = [
    // Top crown spikes
    [[-36, -68], [-22, -96], [-10, -70]],
    [[-12, -74], [0, -104], [12, -74]],
    [[10, -70], [22, -96], [36, -68]],
    // Left mane blades
    [[-46, -54], [-82, -62], [-56, -26]],
    [[-58, -22], [-96, -18], [-62, 12]],
    [[-60, 16], [-84, 38], [-44, 46]],
    // Right mane blades
    [[46, -54], [82, -62], [56, -26]],
    [[58, -22], [96, -18], [62, 12]],
    [[60, 16], [84, 38], [44, 46]],
    // Lower jaw beard
    [[-34, 52], [0, 96], [34, 52], [0, 68]],
  ];
  for (const poly of maneShards) {
    fillPoly(
      ctx,
      poly.map(([px, py]) => [px * s, py * s] as const),
      primaryColor
    );
  }

  // Sculpted angular face mask
  const face: readonly (readonly [number, number])[] = [
    [-42, -46],
    [0, -64],
    [42, -46],
    [48, -6],
    [32, 42],
    [0, 62],
    [-32, 42],
    [-48, -6],
  ];
  fillPoly(
    ctx,
    face.map(([px, py]) => [px * s, py * s] as const),
    accentColor
  );

  // Dark recessed inner brow & nose bridge
  const brow: readonly (readonly [number, number])[] = [
    [-34, -32],
    [0, -46],
    [34, -32],
    [22, -10],
    [10, 14],
    [0, 26],
    [-10, 14],
    [-22, -10],
  ];
  fillPoly(
    ctx,
    brow.map(([px, py]) => [px * s, py * s] as const),
    primaryColor
  );

  // Fierce slanted eyes
  fillPoly(
    ctx,
    [[-28 * s, -22 * s], [-8 * s, -14 * s], [-14 * s, -6 * s], [-30 * s, -12 * s]],
    "#ffffff"
  );
  fillPoly(
    ctx,
    [[28 * s, -22 * s], [8 * s, -14 * s], [14 * s, -6 * s], [30 * s, -12 * s]],
    "#ffffff"
  );

  // Sharp nose diamond & roar fangs
  fillPoly(
    ctx,
    [[0, 10 * s], [11 * s, 20 * s], [0, 32 * s], [-11 * s, 20 * s]],
    accentColor
  );
  fillPoly(
    ctx,
    [[-22 * s, 32 * s], [-12 * s, 46 * s], [-4 * s, 36 * s]],
    primaryColor
  );
  fillPoly(
    ctx,
    [[22 * s, 32 * s], [12 * s, 46 * s], [4 * s, 36 * s]],
    primaryColor
  );

  ctx.restore();
}

/** Deterministic PRNG for repeatable geometric Voronoi/scale wraps */
function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Draws hexagonal snake-scale mosaic inside a clipped region (for Mamba Racing!) */
function drawHexScales(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  radius: number,
  palette: readonly string[],
  strokeColor: string,
  seed: number
) {
  const rand = seededRand(seed);
  const dx = radius * 1.62;
  const dy = radius * 1.42;
  let row = 0;
  for (let py = y0 - radius; py < y0 + h + radius; py += dy) {
    const offset = row % 2 === 0 ? 0 : dx * 0.5;
    for (let px = x0 - radius + offset; px < x0 + w + radius; px += dx) {
      const col = palette[Math.floor(rand() * palette.length)];
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3 + Math.PI / 6;
        const vx = px + Math.cos(a) * radius * 0.88;
        const vy = py + Math.sin(a) * radius * 0.88;
        if (k === 0) ctx.moveTo(vx, vy);
        else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
    row++;
  }
}

/** Draws faceted crimson/navy motorsport triangles (signature Verstappen Racing geometric wrap!) */
function drawFacetedMesh(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  w: number,
  h: number,
  cols: number,
  rows: number,
  palette: readonly string[],
  wireColor: string,
  seed: number,
  density = 0.82
) {
  const rand = seededRand(seed);
  const grid: [number, number][][] = [];
  for (let r = 0; r <= rows; r++) {
    const line: [number, number][] = [];
    for (let c = 0; c <= cols; c++) {
      const jx = c === 0 || c === cols ? 0 : (rand() - 0.5) * (w / cols) * 0.65;
      const jy = r === 0 || r === rows ? 0 : (rand() - 0.5) * (h / rows) * 0.65;
      line.push([x0 + (c / cols) * w + jx, y0 + (r / rows) * h + jy]);
    }
    grid.push(line);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = grid[r][c];
      const b = grid[r][c + 1];
      const d = grid[r + 1][c];
      const e = grid[r + 1][c + 1];
      const tris: readonly (readonly [number, number][])[] =
        (r + c) % 2 === 0
          ? [
              [a, b, e],
              [a, e, d],
            ]
          : [
              [a, b, d],
              [b, e, d],
            ];
      for (const tri of tris) {
        if (rand() > density) continue;
        fillPoly(ctx, tri, palette[Math.floor(rand() * palette.length)]);
        ctx.strokeStyle = wireColor;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
  }
}

/** Draws radial sunburst / crescent rays (for WRT #46 "Il Dottore") */
function drawSunburstMotif(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  rays: number,
  color: string,
  alpha = 0.9
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  for (let i = 0; i < rays; i++) {
    const a0 = (i / rays) * Math.PI * 2;
    const a1 = a0 + (Math.PI / rays) * 0.72;
    const aMid = (a0 + a1) * 0.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a0) * innerR, Math.sin(a0) * innerR);
    ctx.lineTo(Math.cos(aMid) * outerR, Math.sin(aMid) * outerR);
    ctx.lineTo(Math.cos(a1) * innerR, Math.sin(a1) * innerR);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, innerR * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Per-Pattern Graphic Painters (All 14 Bespoke GT3 Team Liveries)
// ---------------------------------------------------------------------------

function paintBaseAndCarbon(
  ctx: CanvasRenderingContext2D,
  spec: Gt3LiverySpec,
  profile: Gt3BodyProfile,
  carbonFill: CanvasPattern | string
) {
  // Fill entire atlas with primary body colour
  ctx.fillStyle = spec.primary;
  ctx.fillRect(0, 0, GT3_ATLAS_SIZE, GT3_ATLAS_SIZE);

  // Exposed carbon rocker skirt & rear wing default underlayer on both sides
  for (const isLeft of [true, false]) {
    const m = makeSideMapper(isLeft);
    clipRect(ctx, 0, isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H, () => {
      // Lower aero rocker blade in carbon weave
      fillPoly(
        ctx,
        m.pts([
          [0.02, 0.0],
          [0.98, 0.0],
          [0.98, profile.rockerY * 0.82],
          [0.02, profile.rockerY * 0.82],
        ]),
        carbonFill
      );
      // Mirror cap paint region (z ≈ mirrorZ, y ≈ mirrorY)
      const mx = m.x(profile.mirrorZ);
      const my = m.y(profile.mirrorY);
      ctx.fillStyle = spec.mirrorColor;
      ctx.fillRect(mx - 88, my - 46, 176, 92);
    });
  }

  // Front splitter lower lip & rear diffuser lower edge in carbon
  clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    ctx.fillStyle = carbonFill;
    ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.72, HALF_W, BOTTOM_H * 0.28);
  });
  clipRect(ctx, HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    ctx.fillStyle = carbonFill;
    ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.78, HALF_W, BOTTOM_H * 0.22);
  });
}

function paintPatternGraphics(
  ctx: CanvasRenderingContext2D,
  spec: Gt3LiverySpec,
  profile: Gt3BodyProfile,
  carbonFill: CanvasPattern | string
) {
  paintBaseAndCarbon(ctx, spec, profile, carbonFill);

  const paintSides = (fn: (m: SideMapper) => void) => {
    for (const isLeft of [true, false]) {
      const m = makeSideMapper(isLeft);
      clipRect(ctx, 0, isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H, () => fn(m));
    }
  };
  const paintTop = (fn: () => void) => clipRect(ctx, 0, 0, GT3_ATLAS_SIZE, TOP_H, fn);
  const paintRear = (fn: () => void) => clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, fn);
  const paintFront = (fn: () => void) => clipRect(ctx, HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H, fn);

  switch (spec.pattern) {
    // -----------------------------------------------------------------------
    // 1. #33 VERSTAPPEN RACING (BMW M4 GT3 Evo DEFAULT!)
    // Matte navy blue + crisp crimson geometric Voronoi shard flanks/fenders +
    // golden-yellow sweeping lower flank & sculpted nose flash + angular lion crest!
    // -----------------------------------------------------------------------
    case "verstappen": {
      const crimsonMeshPalette = ["#dc143c", "#b80d2f", "#e81e42", "#920923", "#c91034"];

      paintTop(() => {
        // Deep matte racing navy gradient across hood & roof
        const g = ctx.createLinearGradient(0, 0, GT3_ATLAS_SIZE, 0);
        g.addColorStop(0, "#081230");
        g.addColorStop(0.5, "#0d1d4a");
        g.addColorStop(1, "#0a163a");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, GT3_ATLAS_SIZE, TOP_H);

        // Bold crimson geometric mesh sweeping over outer front fenders & rear haunches
        ctx.save();
        ctx.beginPath();
        // Front outer fender wedges + hood corners (left + right)
        for (const sgn of [1, -1]) {
          ctx.moveTo(topX(profile.hoodZ0 - 0.02), topY(sgn * 1.0));
          ctx.lineTo(topX(profile.hoodZ0 + 0.12), topY(sgn * 0.48));
          ctx.lineTo(topX(0.95), topY(sgn * 0.34));
          ctx.lineTo(topX(1.0), topY(sgn * 1.0));
          ctx.closePath();
          // Rear quarter haunches
          ctx.moveTo(topX(0.08), topY(sgn * 1.0));
          ctx.lineTo(topX(0.14), topY(sgn * 0.46));
          ctx.lineTo(topX(0.36), topY(sgn * 0.56));
          ctx.lineTo(topX(0.34), topY(sgn * 1.0));
          ctx.closePath();
        }
        ctx.clip();
        drawFacetedMesh(ctx, 0, 0, GT3_ATLAS_SIZE, TOP_H, 26, 11, crimsonMeshPalette, "rgba(12,24,62,0.55)", 3301, 0.96);
        ctx.restore();

        // Sleek golden-yellow twin hood V-spears framing the sculpted center hood
        fillTopMirror(
          ctx,
          [
            [profile.hoodZ0 + 0.05, 0.44],
            [0.955, 0.22],
            [0.97, 0.14],
            [0.935, 0.17],
            [profile.hoodZ0 + 0.07, 0.39],
          ],
          spec.accent
        );
        // White inner hairline inside the yellow hood V
        fillTopMirror(
          ctx,
          [
            [profile.hoodZ0 + 0.08, 0.37],
            [0.935, 0.16],
            [0.93, 0.148],
            [profile.hoodZ0 + 0.085, 0.358],
          ],
          "#ffffff"
        );
        // Sleek tapered golden-yellow nose spear tip (hugs the kidney grille top without overwhelming the nose)
        fillPoly(
          ctx,
          topPts([
            [0.95, -0.18],
            [1.0, -0.22],
            [1.0, 0.22],
            [0.95, 0.18],
            [0.97, 0.0],
          ]),
          spec.accent
        );

        // Roof center crimson racing rails + subtle watermark lion
        fillPoly(
          ctx,
          topPts([
            [profile.roofZ0, -0.52],
            [profile.roofZ1, -0.52],
            [profile.roofZ1, -0.44],
            [profile.roofZ0, -0.44],
          ]),
          spec.secondary
        );
        fillPoly(
          ctx,
          topPts([
            [profile.roofZ0, 0.44],
            [profile.roofZ1, 0.44],
            [profile.roofZ1, 0.52],
            [profile.roofZ0, 0.52],
          ]),
          spec.secondary
        );
        drawGeometricLionCrest(
          ctx,
          topX((profile.roofZ0 + profile.roofZ1) * 0.5),
          topY(0),
          128,
          "#dc143c",
          "#f6c915",
          -Math.PI / 2,
          0.32
        );

        // Iconic hood geometric lion emblem centered cleanly on the upper hood power-dome spine
        drawGeometricLionCrest(
          ctx,
          topX(profile.hoodZ0 + (profile.hoodZ1 - profile.hoodZ0) * 0.44),
          topY(0),
          78,
          "#dc143c",
          "#f6c915",
          -Math.PI / 2,
          0.98
        );
      });

      paintSides((m) => {
        // Crimson geometric shard field across front fender & rear haunch
        ctx.save();
        ctx.beginPath();
        // Front fender sweep
        const fPts = m.pts([
          [0.67, 0.18],
          [0.75, 0.72],
          [1.0, 0.70],
          [1.0, 0.16],
        ]);
        ctx.moveTo(fPts[0][0], fPts[0][1]);
        for (let i = 1; i < fPts.length; i++) ctx.lineTo(fPts[i][0], fPts[i][1]);
        ctx.closePath();
        // Rear haunch sweep
        const rPts = m.pts([
          [0.02, 0.18],
          [0.02, 0.80],
          [0.37, 0.78],
          [0.29, 0.18],
        ]);
        ctx.moveTo(rPts[0][0], rPts[0][1]);
        for (let i = 1; i < rPts.length; i++) ctx.lineTo(rPts[i][0], rPts[i][1]);
        ctx.closePath();
        ctx.clip();
        drawFacetedMesh(ctx, 0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H, 28, 7, crimsonMeshPalette, "rgba(12,24,62,0.52)", 3309, 0.96);
        ctx.restore();

        // Bold crimson upper shoulder blade connecting front fender to rear quarter
        fillPoly(
          ctx,
          m.pts([
            [0.24, 0.63],
            [0.75, 0.61],
            [0.79, 0.68],
            [0.20, 0.71],
          ]),
          spec.secondary
        );

        // Sweeping golden-yellow lower flank & rising diagonal flash
        fillPoly(
          ctx,
          m.pts([
            [0.10, 0.13],
            [0.86, 0.13],
            [0.96, 0.25],
            [0.98, 0.34],
            [0.82, 0.22],
            [0.36, 0.22],
            [0.26, 0.34],
            [0.12, 0.24],
          ]),
          spec.accent
        );
        // Crisp white speed accent line above the golden lower ribbon
        strokePolyline(
          ctx,
          m.pts([
            [0.12, 0.25],
            [0.26, 0.35],
            [0.36, 0.235],
            [0.82, 0.235],
            [0.97, 0.35],
          ]),
          "#ffffff",
          4
        );

        // Stylized angular lion emblem on rear quarter haunch above rear wheel
        drawGeometricLionCrest(
          ctx,
          m.x(profile.rearWheelZ - 0.045),
          m.y(0.55),
          58,
          "#f6c915",
          "#0c1a42",
          0,
          0.95
        );

        // Wing endplate: crimson & golden flash
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.76],
            [profile.wingZ1, 0.76],
            [profile.wingZ1, 1.0],
            [0.0, 1.0],
          ]),
          spec.secondary
        );
        fillPoly(
          ctx,
          m.pts([
            [0.01, 0.78],
            [profile.wingZ1 * 0.92, 0.78],
            [profile.wingZ1 * 0.92, 0.86],
            [0.01, 0.86],
          ]),
          spec.accent
        );
      });

      paintFront(() => {
        // Golden-yellow front nose intake outline + crimson outer bumper flanks
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.34, HALF_W * 0.24, BOTTOM_H * 0.44);
        ctx.fillRect(HALF_W + HALF_W * 0.76, BOTTOM_Y + BOTTOM_H * 0.34, HALF_W * 0.24, BOTTOM_H * 0.44);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W + HALF_W * 0.24, BOTTOM_Y + BOTTOM_H * 0.70, HALF_W * 0.52, BOTTOM_H * 0.11);
      });

      paintRear(() => {
        // Crimson & yellow rear bumper trim
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.58, HALF_W, BOTTOM_H * 0.12);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.70, HALF_W, BOTTOM_H * 0.05);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 2. #32 TEAM WRT WORKS (BMW M4 GT3 Evo)
    // Gloss Alpine White + sweeping asymmetric BMW M tri-color slashes + carbon lowers
    // -----------------------------------------------------------------------
    case "wrt_works": {
      const mSky = "#009fe3";
      const mNavy = "#1b2f7a";
      const mRed = "#e11d2e";

      paintTop(() => {
        // Carbon rear deck & wing base
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, topX(0.18), TOP_H);

        // Asymmetric BMW M tri-color slashes cutting diagonally across the hood & roof!
        const drawBand = (zShift: number, width: number, col: string) => {
          fillPoly(
            ctx,
            topPts([
              [0.98 + zShift, -0.78],
              [0.98 + zShift - width, -0.78],
              [0.24 + zShift - width, 0.84],
              [0.24 + zShift, 0.84],
            ]),
            col
          );
        };
        drawBand(0.06, 0.075, mSky);
        drawBand(-0.015, 0.075, mNavy);
        drawBand(-0.09, 0.075, mRed);

        // Clean carbon hood vent frame
        fillPoly(
          ctx,
          topPts([
            [0.80, -0.26],
            [0.89, -0.22],
            [0.89, 0.22],
            [0.80, 0.26],
          ]),
          carbonFill
        );
      });

      paintSides((m) => {
        // Carbon lower rocker & wheel-arch aero wrap
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 0.24],
            [0.72, 0.22],
            [0.32, 0.22],
            [0.0, 0.34],
          ]),
          carbonFill
        );
        // Iconic forward-leaning BMW M tri-color stripes sweeping from rocker up across doors to rear haunch!
        const mBand = (zBase: number, col: string) => {
          fillPoly(
            ctx,
            m.pts([
              [zBase, 0.16],
              [zBase + 0.065, 0.16],
              [zBase - 0.155, 0.78],
              [zBase - 0.22, 0.78],
            ]),
            col
          );
        };
        mBand(0.42, mSky);
        mBand(0.355, mNavy);
        mBand(0.29, mRed);

        // Secondary sharp front fender M-slashes behind front splitter
        fillPoly(ctx, m.pts([[0.90, 0.16], [0.94, 0.16], [0.87, 0.44], [0.83, 0.44]]), mSky);
        fillPoly(ctx, m.pts([[0.94, 0.16], [0.975, 0.16], [0.905, 0.44], [0.87, 0.44]]), mRed);

        // Asymmetric mirrors: left sky-blue, right M red!
        ctx.fillStyle = m.isLeft ? mSky : mRed;
        ctx.fillRect(m.x(profile.mirrorZ) - 92, m.y(profile.mirrorY) - 48, 184, 96);

        // Wing endplate with M tri-color bar
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), "#131822");
        fillPoly(ctx, m.pts([[0.015, 0.80], [0.035, 0.80], [0.035, 0.96], [0.015, 0.96]]), mSky);
        fillPoly(ctx, m.pts([[0.035, 0.80], [0.055, 0.80], [0.055, 0.96], [0.035, 0.96]]), mNavy);
        fillPoly(ctx, m.pts([[0.055, 0.80], [0.075, 0.80], [0.075, 0.96], [0.055, 0.96]]), mRed);
      });

      paintFront(() => {
        ctx.fillStyle = mSky;
        ctx.fillRect(HALF_W + 40, BOTTOM_Y + BOTTOM_H * 0.66, 290, 24);
        ctx.fillStyle = mNavy;
        ctx.fillRect(HALF_W + 330, BOTTOM_Y + BOTTOM_H * 0.66, 364, 24);
        ctx.fillStyle = mRed;
        ctx.fillRect(HALF_W + 694, BOTTOM_Y + BOTTOM_H * 0.66, 290, 24);
      });

      paintRear(() => {
        ctx.fillStyle = mSky;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.34, 22);
        ctx.fillStyle = mNavy;
        ctx.fillRect(HALF_W * 0.34, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.32, 22);
        ctx.fillStyle = mRed;
        ctx.fillRect(HALF_W * 0.66, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W * 0.34, 22);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 3. #46 WRT "IL DOTTORE" (BMW M4 GT3 Evo)
    // Deep WRT royal blue + crisp white shoulder wedge + electric neon yellow nose, roof, sun-and-moon!
    // -----------------------------------------------------------------------
    case "wrt_46": {
      paintTop(() => {
        // Electric neon-yellow nose & leading hood chevron
        fillPoly(
          ctx,
          topPts([
            [0.84, -1.0],
            [1.0, -1.0],
            [1.0, 1.0],
            [0.84, 1.0],
            [0.90, 0.0],
          ]),
          spec.accent
        );
        // Stark white sculpted central hood & roof frame
        fillTopMirror(
          ctx,
          [
            [0.34, 0.38],
            [0.84, 0.56],
            [0.88, 0.72],
            [0.34, 0.62],
          ],
          spec.secondary
        );
        // Electric cyan pinstripe lining the white wedge
        fillTopMirror(
          ctx,
          [
            [0.34, 0.36],
            [0.84, 0.54],
            [0.85, 0.57],
            [0.34, 0.39],
          ],
          spec.highlight
        );
        // Neon-yellow roof sunburst motif
        drawSunburstMotif(ctx, topX((profile.roofZ0 + profile.roofZ1) * 0.5), topY(0), 62, 132, 12, spec.accent, 0.92);
        // Giant unmistakable #46 silhouette on hood center (drawn sharply later too)
      });

      paintSides((m) => {
        // Electric neon-yellow front bumper & nose flare
        fillPoly(
          ctx,
          m.pts([
            [0.84, 0.14],
            [1.0, 0.14],
            [1.0, 0.72],
            [0.91, 0.72],
          ]),
          spec.accent
        );
        // Crisp white diagonal shoulder band sweeping back into the rear haunch
        fillPoly(
          ctx,
          m.pts([
            [0.12, 0.44],
            [0.82, 0.58],
            [0.85, 0.70],
            [0.10, 0.58],
          ]),
          spec.secondary
        );
        // Cyan speed accent line beneath the white sweep
        strokePolyline(
          ctx,
          m.pts([
            [0.10, 0.43],
            [0.82, 0.57],
          ]),
          spec.highlight,
          7
        );
        // Neon-yellow lower rocker accent strip
        fillPoly(
          ctx,
          m.pts([
            [0.16, 0.14],
            [0.85, 0.14],
            [0.88, 0.21],
            [0.14, 0.21],
          ]),
          spec.accent
        );
        // Sunburst graphic over the rear haunch!
        drawSunburstMotif(ctx, m.x(profile.rearWheelZ - 0.04), m.y(0.62), 32, 74, 12, spec.accent, 0.95);
        // Neon-yellow wing endplates
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.accent);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.22, HALF_W, BOTTOM_H * 0.58);
      });

      paintRear(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, BOTTOM_H * 0.12);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 4. #98 ROWE RACING (BMW M4 GT3 Evo)
    // Diagonal stealth satin-black vs crisp white split + fluo yellow & crimson ribbons
    // -----------------------------------------------------------------------
    case "rowe": {
      paintTop(() => {
        // Stealth carbon-black front/left diagonal split against crisp Alpine White rear/right
        fillPoly(
          ctx,
          topPts([
            [0.0, -1.0],
            [0.62, -1.0],
            [0.86, 1.0],
            [0.0, 1.0],
          ]),
          spec.secondary
        );
        // Bold fluorescent yellow & crimson twin ribbons slicing along the diagonal split!
        fillPoly(
          ctx,
          topPts([
            [0.57, -1.0],
            [0.64, -1.0],
            [0.88, 1.0],
            [0.81, 1.0],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          topPts([
            [0.54, -1.0],
            [0.57, -1.0],
            [0.81, 1.0],
            [0.78, 1.0],
          ]),
          spec.highlight
        );
        // Dark carbon rear deck
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, topX(0.14), TOP_H);
      });

      paintSides((m) => {
        // Diagonal monochrome split: satin black front/lower vs crisp white rear/upper
        fillPoly(
          ctx,
          m.pts([
            [0.02, 0.24],
            [0.44, 0.24],
            [0.72, 0.88],
            [0.02, 0.88],
          ]),
          spec.secondary
        );
        // Bold fluorescent yellow & red technical racing ribbons right along the split
        fillPoly(
          ctx,
          m.pts([
            [0.42, 0.16],
            [0.50, 0.16],
            [0.78, 0.88],
            [0.70, 0.88],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          m.pts([
            [0.50, 0.16],
            [0.535, 0.16],
            [0.815, 0.88],
            [0.78, 0.88],
          ]),
          spec.highlight
        );
        // Horizontal neon-yellow lower rocker accent
        fillPoly(
          ctx,
          m.pts([
            [0.06, 0.14],
            [0.94, 0.14],
            [0.96, 0.19],
            [0.04, 0.19],
          ]),
          spec.accent
        );
        // Wing endplate: black with yellow diagonal stripe
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), "#13161d");
        fillPoly(ctx, m.pts([[0.02, 0.78], [0.055, 0.78], [0.09, 0.98], [0.055, 0.98]]), spec.accent);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 24);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 10);
      });

      paintRear(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W, 20);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 5. #11 SCHUBERT MOTORSPORT (DTM BMW M4 GT3 Evo)
    // Brilliant white + gloss black canopy/spine + vivid emerald-green angular DTM blocks
    // -----------------------------------------------------------------------
    case "schubert": {
      paintTop(() => {
        // Gloss black central spine across roof & hood vents
        fillPoly(
          ctx,
          topPts([
            [0.0, -0.34],
            [0.86, -0.24],
            [0.86, 0.24],
            [0.0, 0.34],
          ]),
          spec.accent
        );
        // Vivid emerald-green angular fracture blocks on front fenders, hood edges & rear haunches
        fillTopMirror(
          ctx,
          [
            [0.66, 0.28],
            [0.98, 0.20],
            [1.0, 1.0],
            [0.74, 1.0],
          ],
          spec.secondary
        );
        fillTopMirror(
          ctx,
          [
            [0.10, 0.36],
            [0.36, 0.44],
            [0.42, 1.0],
            [0.06, 1.0],
          ],
          spec.secondary
        );
        // Sharp white diagonal cuts inside the green hood blocks for modern DTM drama
        fillTopMirror(
          ctx,
          [
            [0.75, 0.34],
            [0.92, 0.86],
            [0.87, 0.92],
            [0.70, 0.40],
          ],
          spec.primary
        );
        // Crimson M-accent pinstripe framing the black central spine
        fillTopMirror(
          ctx,
          [
            [0.12, 0.34],
            [0.86, 0.24],
            [0.86, 0.27],
            [0.12, 0.37],
          ],
          spec.highlight
        );
      });

      paintSides((m) => {
        // Gloss black lower aero & rear bumper zone
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 0.24],
            [0.0, 0.24],
          ]),
          carbonFill
        );
        // Vivid emerald-green angular DTM front fender & rear haunch blocks
        fillPoly(
          ctx,
          m.pts([
            [0.68, 0.20],
            [1.0, 0.20],
            [1.0, 0.72],
            [0.76, 0.72],
          ]),
          spec.secondary
        );
        fillPoly(
          ctx,
          m.pts([
            [0.02, 0.22],
            [0.36, 0.22],
            [0.24, 0.78],
            [0.02, 0.78],
          ]),
          spec.secondary
        );
        // Crisp black geometric chevrons bisecting the white door into the green blocks
        fillPoly(
          ctx,
          m.pts([
            [0.27, 0.22],
            [0.34, 0.22],
            [0.22, 0.78],
            [0.15, 0.78],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          m.pts([
            [0.66, 0.20],
            [0.71, 0.20],
            [0.79, 0.72],
            [0.74, 0.72],
          ]),
          spec.accent
        );
        // Subtle red & blue M trim tick behind front wheel
        fillPoly(ctx, m.pts([[0.71, 0.20], [0.73, 0.20], [0.81, 0.72], [0.79, 0.72]]), spec.highlight);
        // Green wing endplates
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.24, HALF_W * 0.32, BOTTOM_H * 0.56);
        ctx.fillRect(HALF_W + HALF_W * 0.68, BOTTOM_Y + BOTTOM_H * 0.24, HALF_W * 0.32, BOTTOM_H * 0.56);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W + HALF_W * 0.32, BOTTOM_Y + BOTTOM_H * 0.72, HALF_W * 0.36, 14);
      });

      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.52, HALF_W, BOTTOM_H * 0.20);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 6. #1 PAUL MILLER RACING (IMSA GTD Pro BMW M4 GT3 Evo)
    // Stark snow white + architectural emerald-green & royal-blue diagonal blocks + red GTD Pro accents
    // -----------------------------------------------------------------------
    case "paul_miller": {
      paintTop(() => {
        // Bold architectural parallel diagonal bands across hood & roof
        const diag = (z0: number, w: number, col: string) => {
          fillPoly(
            ctx,
            topPts([
              [z0, -1.0],
              [z0 + w, -1.0],
              [z0 + w - 0.32, 1.0],
              [z0 - 0.32, 1.0],
            ]),
            col
          );
        };
        diag(0.84, 0.14, spec.accent);
        diag(0.68, 0.14, spec.secondary);
        diag(0.32, 0.11, spec.accent);
        diag(0.19, 0.11, spec.secondary);
        // Subtle metallic silver divider lines
        diag(0.825, 0.015, "#cbd5e1");
        diag(0.305, 0.015, "#cbd5e1");
      });

      paintSides((m) => {
        // Forward-leaning architectural emerald-green & royal-blue parallelograms along flanks
        const block = (zBase: number, w: number, col: string) => {
          fillPoly(
            ctx,
            m.pts([
              [zBase, 0.14],
              [zBase + w, 0.14],
              [zBase + w + 0.14, 0.80],
              [zBase + 0.14, 0.80],
            ]),
            col
          );
        };
        block(0.12, 0.14, spec.accent);
        block(0.28, 0.12, spec.secondary);
        block(0.74, 0.11, spec.accent);
        block(0.86, 0.10, spec.secondary);

        // Clean royal-blue lower sill stripe + red GTD Pro trim line
        fillPoly(ctx, m.pts([[0.04, 0.14], [0.96, 0.14], [0.96, 0.21], [0.04, 0.21]]), spec.accent);
        fillPoly(ctx, m.pts([[0.04, 0.21], [0.96, 0.21], [0.96, 0.235], [0.04, 0.235]]), spec.highlight);

        // Iconic IMSA GTD Pro red wing endplates
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.highlight);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.5, 22);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W + HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W * 0.5, 22);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.72, HALF_W, 12);
      });

      paintRear(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.56, HALF_W * 0.5, 26);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.56, HALF_W * 0.5, 26);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 7. #96 TURNER MOTORSPORT (IMSA BMW M4 GT3 Evo)
    // Gloss racing yellow + cobalt blue twin hood stripes & sweeping lower-rear chevrons
    // -----------------------------------------------------------------------
    case "turner": {
      paintTop(() => {
        // Cobalt blue rear deck & rear fenders
        fillPoly(
          ctx,
          topPts([
            [0.0, -1.0],
            [0.34, -1.0],
            [0.24, 0.0],
            [0.34, 1.0],
            [0.0, 1.0],
          ]),
          spec.secondary
        );
        // Classic Turner twin cobalt-blue hood & roof racing stripes with crisp white pinlines!
        fillTopMirror(
          ctx,
          [
            [0.22, 0.055],
            [0.98, 0.045],
            [0.98, 0.24],
            [0.22, 0.26],
          ],
          spec.secondary
        );
        fillTopMirror(
          ctx,
          [
            [0.22, 0.26],
            [0.98, 0.24],
            [0.98, 0.275],
            [0.22, 0.295],
          ],
          "#ffffff"
        );
      });

      paintSides((m) => {
        // Bold cobalt-blue lower-to-rear sweeping wedge
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.12],
            [0.92, 0.12],
            [0.86, 0.25],
            [0.44, 0.28],
            [0.26, 0.76],
            [0.0, 0.78],
          ]),
          spec.secondary
        );
        // Crisp white speed border tracing the blue/yellow split
        strokePolyline(
          ctx,
          m.pts([
            [0.92, 0.12],
            [0.86, 0.25],
            [0.44, 0.28],
            [0.26, 0.76],
          ]),
          "#ffffff",
          9
        );
        // Dynamic white & yellow speed ticks across the cobalt rear quarter
        for (let i = 0; i < 4; i++) {
          const z = 0.08 + i * 0.045;
          fillPoly(
            ctx,
            m.pts([
              [z, 0.32],
              [z + 0.022, 0.32],
              [z + 0.045, 0.64],
              [z + 0.023, 0.64],
            ]),
            i % 2 === 0 ? spec.primary : "#ffffff"
          );
        }
        // Cobalt blue wing endplate with yellow stripe
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.02, 0.84], [profile.wingZ1 - 0.01, 0.84], [profile.wingZ1 - 0.01, 0.90], [0.02, 0.90]]), spec.primary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W, 28);
      });

      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H * 0.74);
        ctx.fillStyle = spec.primary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.66, HALF_W, 18);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 8. #48 MAMBA RACING (DTM Mercedes-AMG GT3 Evo)
    // Vivid fluo venom yellow + emerald snake-scale hexagonal mosaic + satin black spine + fangs!
    // -----------------------------------------------------------------------
    case "mamba": {
      const scalePalette = ["#008a3e", "#006c30", "#00a64b", "#1f8c2a", "#0d5728", "#b9df00"];

      paintTop(() => {
        // Satin-black roof center & AMG hood vent spine
        fillPoly(
          ctx,
          topPts([
            [0.0, -0.36],
            [0.54, -0.36],
            [0.58, -0.24],
            [0.84, -0.20],
            [0.84, 0.20],
            [0.58, 0.24],
            [0.54, 0.36],
            [0.0, 0.36],
          ]),
          spec.accent
        );

        // Emerald hexagonal snake-scale mosaic sweeping over rear quarters & hood outer edges!
        ctx.save();
        ctx.beginPath();
        // Rear deck & rear fenders
        ctx.moveTo(topX(0.0), topY(-1.0));
        ctx.lineTo(topX(0.36), topY(-1.0));
        ctx.lineTo(topX(0.24), topY(-0.34));
        ctx.lineTo(topX(0.24), topY(0.34));
        ctx.lineTo(topX(0.36), topY(1.0));
        ctx.lineTo(topX(0.0), topY(1.0));
        ctx.closePath();
        // Hood side flanks
        for (const sgn of [1, -1]) {
          ctx.moveTo(topX(0.56), topY(sgn * 1.0));
          ctx.lineTo(topX(0.86), topY(sgn * 1.0));
          ctx.lineTo(topX(0.74), topY(sgn * 0.42));
          ctx.lineTo(topX(0.54), topY(sgn * 0.48));
          ctx.closePath();
        }
        ctx.clip();
        drawHexScales(ctx, 0, 0, GT3_ATLAS_SIZE, TOP_H, 24, scalePalette, "#082914", 4801);
        ctx.restore();

        // Crisp black jagged contour borders separating yellow from emerald scales
        fillTopMirror(
          ctx,
          [
            [0.24, 0.34],
            [0.37, 1.0],
            [0.39, 1.0],
            [0.26, 0.34],
          ],
          spec.accent
        );
      });

      paintSides((m) => {
        // Jagged emerald snake-scale rear half & lower sweep
        ctx.save();
        ctx.beginPath();
        const zone = m.pts([
          [0.0, 0.14],
          [0.72, 0.14],
          [0.64, 0.27],
          [0.44, 0.28],
          [0.32, 0.56],
          [0.40, 0.72],
          [0.26, 0.84],
          [0.0, 0.84],
        ]);
        ctx.moveTo(zone[0][0], zone[0][1]);
        for (let i = 1; i < zone.length; i++) ctx.lineTo(zone[i][0], zone[i][1]);
        ctx.closePath();
        ctx.clip();
        drawHexScales(ctx, 0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H, 20, scalePalette, "#072613", 4809);
        ctx.restore();

        // Bold black serrated border separating venom yellow from emerald scales
        strokePolyline(
          ctx,
          m.pts([
            [0.72, 0.14],
            [0.64, 0.27],
            [0.44, 0.28],
            [0.32, 0.56],
            [0.40, 0.72],
            [0.26, 0.84],
          ]),
          spec.accent,
          8
        );

        // Signature white & black Mamba fangs behind the front splitter!
        fillPoly(
          ctx,
          m.pts([
            [0.86, 0.42],
            [0.95, 0.42],
            [0.92, 0.16],
            [0.89, 0.26],
            [0.86, 0.16],
          ]),
          "#ffffff"
        );
        strokePolyline(
          ctx,
          m.pts([
            [0.86, 0.42],
            [0.86, 0.16],
            [0.89, 0.26],
            [0.92, 0.16],
            [0.95, 0.42],
          ]),
          "#0b0e13",
          4
        );

        // Emerald wing endplate with venom yellow claw bar
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.secondary);
        fillPoly(ctx, m.pts([[0.02, 0.82], [profile.wingZ1 - 0.01, 0.88], [profile.wingZ1 - 0.01, 0.94], [0.02, 0.88]]), spec.primary);
      });

      paintFront(() => {
        // Bold Mamba yellow nose with dark green outer intakes & twin fang spikes
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.55, HALF_W * 0.25, BOTTOM_H * 0.25);
        ctx.fillRect(HALF_W + HALF_W * 0.75, BOTTOM_Y + BOTTOM_H * 0.55, HALF_W * 0.25, BOTTOM_H * 0.25);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W + HALF_W * 0.25, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W * 0.5, 18);
      });

      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.42, HALF_W, BOTTOM_H * 0.34);
        ctx.fillStyle = spec.primary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W, 18);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 9. #61 IRON LYNX (WEC LMGT3 Mercedes-AMG GT3 Evo)
    // Stealth satin obsidian carbon + razor acid-lime & silver-white angular lynx claws!
    // -----------------------------------------------------------------------
    case "iron_lynx_lime": {
      paintTop(() => {
        // Exposed satin carbon-weave base across entire top
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, GT3_ATLAS_SIZE, TOP_H);

        // Sharp geometric acid-lime & metallic-white lynx claw slashes across hood & roof!
        fillTopMirror(
          ctx,
          [
            [0.98, 0.16],
            [0.98, 0.30],
            [0.54, 0.76],
            [0.48, 0.68],
          ],
          spec.secondary
        );
        fillTopMirror(
          ctx,
          [
            [0.90, 0.34],
            [0.90, 0.42],
            [0.44, 0.88],
            [0.40, 0.82],
          ],
          spec.accent
        );
        // Rear haunch acid-lime angular shards
        fillTopMirror(
          ctx,
          [
            [0.08, 0.42],
            [0.24, 0.96],
            [0.16, 1.0],
            [0.04, 0.54],
          ],
          spec.secondary
        );
        // Roof lime halo strip
        fillTopMirror(
          ctx,
          [
            [profile.roofZ0, 0.38],
            [profile.roofZ1, 0.38],
            [profile.roofZ1, 0.44],
            [profile.roofZ0, 0.44],
          ],
          spec.secondary
        );
      });

      paintSides((m) => {
        // Satin carbon weave side base
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H);

        // Triple dynamic acid-lime & white lynx claw slashes tearing across front fender, door, and rear haunch!
        fillPoly(
          ctx,
          m.pts([
            [0.96, 0.24],
            [0.99, 0.34],
            [0.64, 0.70],
            [0.58, 0.66],
          ]),
          spec.secondary
        );
        fillPoly(
          ctx,
          m.pts([
            [0.86, 0.18],
            [0.91, 0.18],
            [0.52, 0.60],
            [0.48, 0.58],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          m.pts([
            [0.06, 0.24],
            [0.16, 0.24],
            [0.38, 0.74],
            [0.28, 0.76],
          ]),
          spec.secondary
        );
        fillPoly(
          ctx,
          m.pts([
            [0.18, 0.24],
            [0.22, 0.24],
            [0.44, 0.72],
            [0.40, 0.74],
          ]),
          spec.accent
        );
        // Razor acid-lime lower aero blade highlight
        fillPoly(ctx, m.pts([[0.04, 0.14], [0.96, 0.14], [0.98, 0.185], [0.02, 0.185]]), spec.secondary);
        // Bright acid-lime wing endplate
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 24);
      });

      paintRear(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.64, HALF_W, 22);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 10. #79 IRON LYNX COBALT (WEC Mercedes-AMG GT3 Evo)
    // Vibrant electric race blue front colliding with stealth carbon black rear via ice-cyan slashes
    // -----------------------------------------------------------------------
    case "iron_lynx_cobalt": {
      paintTop(() => {
        // Rear half in stealth carbon black, colliding diagonally with cobalt front
        fillPoly(
          ctx,
          topPts([
            [0.0, -1.0],
            [0.52, -1.0],
            [0.38, 0.0],
            [0.52, 1.0],
            [0.0, 1.0],
          ]),
          carbonFill
        );
        // Razor ice-cyan & white claw chevrons along the collision line
        fillTopMirror(
          ctx,
          [
            [0.36, 0.0],
            [0.50, 1.0],
            [0.56, 1.0],
            [0.42, 0.0],
          ],
          spec.accent
        );
        fillTopMirror(
          ctx,
          [
            [0.44, 0.0],
            [0.58, 1.0],
            [0.61, 1.0],
            [0.47, 0.0],
          ],
          spec.highlight
        );
        // Hood twin cyan spear lines
        fillTopMirror(
          ctx,
          [
            [0.62, 0.30],
            [0.98, 0.16],
            [0.98, 0.22],
            [0.62, 0.36],
          ],
          spec.accent
        );
      });

      paintSides((m) => {
        // Rear & lower carbon black colliding with cobalt blue nose/doors
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.12],
            [0.54, 0.12],
            [0.34, 0.84],
            [0.0, 0.84],
          ]),
          carbonFill
        );
        // Serrated ice-cyan & crisp white claw slashes along the split
        fillPoly(
          ctx,
          m.pts([
            [0.50, 0.12],
            [0.58, 0.12],
            [0.38, 0.84],
            [0.30, 0.84],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          m.pts([
            [0.59, 0.12],
            [0.63, 0.12],
            [0.43, 0.84],
            [0.39, 0.84],
          ]),
          spec.highlight
        );
        // Lower cyan splitter-to-rocker highlight
        fillPoly(ctx, m.pts([[0.06, 0.14], [0.96, 0.14], [0.98, 0.185], [0.04, 0.185]]), spec.accent);
        // Cyan wing endplate
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.accent);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.66, HALF_W, 22);
      });

      paintRear(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 20);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 11. #17 GETSPEED PERFORMANCE (N24/Spa Mercedes-AMG GT3 Evo)
    // Stark motorsport white upper + exposed dark carbon lowers + crimson & electric cobalt technical bands
    // -----------------------------------------------------------------------
    case "getspeed": {
      paintTop(() => {
        // Dark carbon rear deck, outer fender lowers & hood vent
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, topX(0.18), TOP_H);
        fillPoly(
          ctx,
          topPts([
            [0.74, -0.24],
            [0.88, -0.20],
            [0.88, 0.20],
            [0.74, 0.24],
          ]),
          carbonFill
        );
        // Twin dramatic crimson & cobalt-blue technical stripes framing hood & roof
        fillTopMirror(
          ctx,
          [
            [0.14, 0.56],
            [0.56, 0.44],
            [0.98, 0.26],
            [0.98, 0.37],
            [0.56, 0.54],
            [0.14, 0.68],
          ],
          spec.accent
        );
        fillTopMirror(
          ctx,
          [
            [0.14, 0.68],
            [0.56, 0.54],
            [0.98, 0.37],
            [0.98, 0.45],
            [0.56, 0.62],
            [0.14, 0.78],
          ],
          spec.highlight
        );
      });

      paintSides((m) => {
        // Exposed dark carbon lower flank sweeping up into the rear bumper
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 0.24],
            [0.42, 0.24],
            [0.18, 0.46],
            [0.0, 0.46],
          ]),
          carbonFill
        );
        // Bold crimson & electric cobalt lightning ribbons riding the carbon/white split
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.46],
            [0.18, 0.46],
            [0.42, 0.24],
            [0.98, 0.24],
            [0.98, 0.305],
            [0.44, 0.305],
            [0.20, 0.54],
            [0.0, 0.54],
          ]),
          spec.accent
        );
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.54],
            [0.20, 0.54],
            [0.44, 0.305],
            [0.98, 0.305],
            [0.98, 0.345],
            [0.46, 0.345],
            [0.22, 0.59],
            [0.0, 0.59],
          ]),
          spec.highlight
        );
        // Crimson wing endplates
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.accent);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 20);
        ctx.fillStyle = spec.highlight;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.70, HALF_W, 14);
      });

      paintRear(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.52, HALF_W, BOTTOM_H * 0.48);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.48, HALF_W, 18);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 12. #99 GRUPPEM RACING (IGTC Mercedes-AMG GT3 Evo)
    // Liquid metallic pearl silver + sweeping crimson & midnight-navy endurance twin-chevrons + gold pinstripe!
    // -----------------------------------------------------------------------
    case "gruppem": {
      paintTop(() => {
        // Metallic silver gradient base
        const g = ctx.createLinearGradient(0, 0, GT3_ATLAS_SIZE, 0);
        g.addColorStop(0, "#c8d2dd");
        g.addColorStop(0.5, "#eef3f8");
        g.addColorStop(1, "#cfd8e2");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, GT3_ATLAS_SIZE, TOP_H);

        // Midnight navy roof & rear wing deck
        fillPoly(
          ctx,
          topPts([
            [0.0, -0.58],
            [profile.roofZ1 + 0.02, -0.52],
            [profile.roofZ1 + 0.02, 0.52],
            [0.0, 0.58],
          ]),
          spec.accent
        );

        // Dramatic sweeping crimson & navy endurance twin-arrows from nose across hood & fenders
        fillTopMirror(
          ctx,
          [
            [0.98, 0.08],
            [0.64, 0.54],
            [0.14, 0.74],
            [0.14, 0.96],
            [0.68, 0.72],
            [0.98, 0.28],
          ],
          spec.secondary
        );
        // Gold metallic pinstripe along the inner crimson arrow edge
        fillTopMirror(
          ctx,
          [
            [0.98, 0.06],
            [0.64, 0.51],
            [0.14, 0.71],
            [0.14, 0.74],
            [0.64, 0.54],
            [0.98, 0.08],
          ],
          spec.highlight
        );
      });

      paintSides((m) => {
        // Metallic silver gradient base
        const g = ctx.createLinearGradient(0, m.isLeft ? LEFT_Y : RIGHT_Y, 0, (m.isLeft ? LEFT_Y : RIGHT_Y) + SIDE_H);
        g.addColorStop(0, "#eef3f8");
        g.addColorStop(0.6, "#d5dee8");
        g.addColorStop(1, "#b4c0ce");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H);

        // Exposed carbon lower sill (matches real AMG side exhaust surround)
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.0],
            [1.0, 0.0],
            [1.0, 0.17],
            [0.0, 0.17],
          ]),
          carbonFill
        );
        // Midnight navy lower skirt sweeping up behind rear wheel
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.17],
            [0.98, 0.17],
            [0.98, 0.26],
            [0.36, 0.26],
            [0.16, 0.58],
            [0.0, 0.64],
          ]),
          spec.accent
        );
        // Sweeping crimson endurance chevron over front wheel arch & down the door into the rear haunch
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.64],
            [0.16, 0.58],
            [0.36, 0.25],
            [0.72, 0.25],
            [0.98, 0.44],
            [0.98, 0.56],
            [0.70, 0.34],
            [0.38, 0.34],
            [0.20, 0.70],
            [0.0, 0.76],
          ]),
          spec.secondary
        );
        // Gold metallic hairline trim along top edge of crimson ribbon
        strokePolyline(
          ctx,
          m.pts([
            [0.0, 0.76],
            [0.20, 0.70],
            [0.38, 0.34],
            [0.70, 0.34],
            [0.98, 0.56],
          ]),
          spec.highlight,
          5
        );
        // Navy wing endplate with crimson & gold bars
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.accent);
        fillPoly(ctx, m.pts([[0.015, 0.80], [profile.wingZ1 - 0.01, 0.80], [profile.wingZ1 - 0.01, 0.88], [0.015, 0.88]]), spec.secondary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.58, HALF_W, 24);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 22);
      });

      paintRear(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.45, HALF_W, BOTTOM_H * 0.35);
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.42, HALF_W, 18);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 13. #75 75 EXPRESS (Bathurst / IGTC Mercedes-AMG GT3 Evo)
    // Blazing metallic sunset orange fading into gloss obsidian black via speed-flame blades + gold streaks!
    // -----------------------------------------------------------------------
    case "express_75": {
      paintTop(() => {
        // Blazing sunset-orange to deep obsidian gradient across length of car
        const g = ctx.createLinearGradient(GT3_ATLAS_SIZE, 0, 0, 0);
        g.addColorStop(0.0, "#ff7300");
        g.addColorStop(0.32, "#ff4d00");
        g.addColorStop(0.54, "#9a1e00");
        g.addColorStop(0.68, "#101319");
        g.addColorStop(1.0, "#0b0d12");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, GT3_ATLAS_SIZE, TOP_H);

        // Aggressive obsidian-black speed blades slicing forward across roof & rear hood
        fillTopMirror(
          ctx,
          [
            [0.0, 0.0],
            [0.60, 0.0],
            [0.44, 0.46],
            [0.54, 0.70],
            [0.36, 1.0],
            [0.0, 1.0],
          ],
          spec.secondary
        );
        // Shimmering gold-chrome flame streaks outlining the orange/black surge
        fillTopMirror(
          ctx,
          [
            [0.62, 0.02],
            [0.46, 0.46],
            [0.56, 0.70],
            [0.38, 1.0],
            [0.34, 1.0],
            [0.52, 0.70],
            [0.42, 0.46],
            [0.58, 0.02],
          ],
          spec.accent
        );
      });

      paintSides((m) => {
        const g = ctx.createLinearGradient(m.x(1), 0, m.x(0), 0);
        g.addColorStop(0.0, "#ff6e00");
        g.addColorStop(0.38, "#ff4800");
        g.addColorStop(0.60, "#240d05");
        g.addColorStop(0.75, "#0e1117");
        g.addColorStop(1.0, "#0b0d12");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H);

        // Dynamic sweeping sunset-orange & gold speed-spears piercing back into the black rear haunches!
        fillPoly(
          ctx,
          m.pts([
            [0.72, 0.62],
            [0.24, 0.74],
            [0.34, 0.62],
            [0.14, 0.56],
            [0.44, 0.44],
            [0.18, 0.34],
            [0.68, 0.24],
            [0.88, 0.24],
            [0.88, 0.64],
          ]),
          spec.primary
        );
        // Gold-chrome speed-lines tracing the fiery spears
        strokePolyline(
          ctx,
          m.pts([
            [0.76, 0.63],
            [0.24, 0.74],
            [0.34, 0.62],
            [0.14, 0.56],
            [0.44, 0.44],
            [0.18, 0.34],
            [0.70, 0.24],
          ]),
          spec.accent,
          6
        );
        // Sunset-orange lower sill accent + wing endplate
        fillPoly(ctx, m.pts([[0.04, 0.14], [0.96, 0.14], [0.96, 0.19], [0.04, 0.19]]), spec.primary);
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), spec.primary);
      });

      paintFront(() => {
        ctx.fillStyle = spec.primary;
        ctx.fillRect(HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H * 0.78);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 16);
      });

      paintRear(() => {
        ctx.fillStyle = spec.secondary;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.primary;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 20);
      });
      break;
    }

    // -----------------------------------------------------------------------
    // 14. #00 AFFALTERBACH WORKS (Factory Works Mercedes-AMG GT3 Evo)
    // Brushed liquid silver fading into exposed satin carbon via geometric diamond stars + electric turquoise ribbons!
    // -----------------------------------------------------------------------
    case "silver_arrow": {
      const drawDiamondStars = (x0: number, y0: number, w: number, h: number, seed: number) => {
        const rand = seededRand(seed);
        for (let i = 0; i < 110; i++) {
          const sx = x0 + rand() * w;
          const sy = y0 + rand() * h;
          const r = 6 + rand() * 14;
          const alpha = 0.18 + rand() * 0.52;
          ctx.save();
          ctx.translate(sx, sy);
          ctx.fillStyle = `rgba(226, 236, 246, ${alpha.toFixed(2)})`;
          ctx.beginPath();
          ctx.moveTo(0, -r);
          ctx.lineTo(r * 0.28, -r * 0.28);
          ctx.lineTo(r, 0);
          ctx.lineTo(r * 0.28, r * 0.28);
          ctx.lineTo(0, r);
          ctx.lineTo(-r * 0.28, r * 0.28);
          ctx.lineTo(-r, 0);
          ctx.lineTo(-r * 0.28, -r * 0.28);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      };

      paintTop(() => {
        // Liquid brushed silver front fading smoothly into exposed satin carbon rear!
        const g = ctx.createLinearGradient(GT3_ATLAS_SIZE, 0, 0, 0);
        g.addColorStop(0.0, "#dce4ec");
        g.addColorStop(0.36, "#c2ccd6");
        g.addColorStop(0.56, "#2c333e");
        g.addColorStop(0.68, "#11151c");
        g.addColorStop(1.0, "#0d1016");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, GT3_ATLAS_SIZE, TOP_H);

        // Carbon texture overlay over the dark rear half
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, 0, topX(0.42), TOP_H);
        ctx.restore();

        // Geometric star halftone fade across rear roof & rear quarters
        drawDiamondStars(topX(0.08), 0, topX(0.42), TOP_H, 1001);

        // Flowing electric turquoise aero ribbons sweeping from nose over hood flanks to rear wing!
        fillTopMirror(
          ctx,
          [
            [0.02, 0.52],
            [0.46, 0.44],
            [0.98, 0.26],
            [0.98, 0.31],
            [0.46, 0.50],
            [0.02, 0.59],
          ],
          spec.accent
        );
        fillTopMirror(
          ctx,
          [
            [0.02, 0.60],
            [0.46, 0.51],
            [0.98, 0.32],
            [0.98, 0.34],
            [0.46, 0.53],
            [0.02, 0.62],
          ],
          "#ffffff"
        );
      });

      paintSides((m) => {
        const g = ctx.createLinearGradient(m.x(1), 0, m.x(0), 0);
        g.addColorStop(0.0, "#dce4ec");
        g.addColorStop(0.42, "#bec8d3");
        g.addColorStop(0.60, "#242a34");
        g.addColorStop(0.72, "#10141a");
        g.addColorStop(1.0, "#0c1015");
        ctx.fillStyle = g;
        ctx.fillRect(0, m.isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H);

        // Carbon overlay & star-sparkle fade on rear haunches
        const rx0 = m.isLeft ? m.x(0.42) : 0;
        const rw = GT3_ATLAS_SIZE * 0.42;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = carbonFill;
        ctx.fillRect(rx0, m.isLeft ? LEFT_Y : RIGHT_Y, rw, SIDE_H);
        ctx.restore();
        drawDiamondStars(rx0, m.isLeft ? LEFT_Y : RIGHT_Y, rw, SIDE_H, 1007);

        // Iconic flowing electric turquoise & crisp white aero flow-ribbon from front splitter to rear haunch!
        fillPoly(
          ctx,
          m.pts([
            [0.0, 0.60],
            [0.24, 0.56],
            [0.46, 0.36],
            [0.74, 0.30],
            [0.98, 0.24],
            [0.98, 0.295],
            [0.74, 0.36],
            [0.46, 0.43],
            [0.24, 0.64],
            [0.0, 0.68],
          ]),
          spec.accent
        );
        strokePolyline(
          ctx,
          m.pts([
            [0.0, 0.685],
            [0.24, 0.645],
            [0.46, 0.435],
            [0.74, 0.365],
            [0.98, 0.30],
          ]),
          "#ffffff",
          4
        );
        // Exposed carbon lower sill (matches AMG side exhaust shroud)
        fillPoly(ctx, m.pts([[0.0, 0.0], [1.0, 0.0], [1.0, 0.165], [0.0, 0.165]]), carbonFill);
        // Turquoise lower sill line + wing endplate
        fillPoly(ctx, m.pts([[0.04, 0.165], [0.96, 0.165], [0.96, 0.195], [0.04, 0.195]]), spec.accent);
        fillPoly(ctx, m.pts([[0.0, 0.76], [profile.wingZ1, 0.76], [profile.wingZ1, 1.0], [0.0, 1.0]]), "#10141a");
        fillPoly(ctx, m.pts([[0.02, 0.80], [profile.wingZ1 - 0.01, 0.80], [profile.wingZ1 - 0.01, 0.88], [0.02, 0.88]]), spec.accent);
      });

      paintFront(() => {
        ctx.fillStyle = spec.accent;
        ctx.fillRect(HALF_W, BOTTOM_Y + BOTTOM_H * 0.68, HALF_W, 20);
      });

      paintRear(() => {
        ctx.fillStyle = carbonFill;
        ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H);
        ctx.fillStyle = spec.accent;
        ctx.fillRect(0, BOTTOM_Y + BOTTOM_H * 0.62, HALF_W, 18);
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Authentic GT3 Number Plates, Rear Wing Banners, Contingency Stacks & Details
// ---------------------------------------------------------------------------

function drawGt3NumberPlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  number: string,
  style: Gt3NumberPlateStyle,
  rotationRad = 0
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotationRad);

  const x0 = -w / 2;
  const y0 = -h / 2;
  const headerH = h * 0.25;

  // Crisp outer drop shadow + border
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x0 + 4, y0 + 4, w, h);

  ctx.fillStyle = style.bg;
  ctx.fillRect(x0, y0, w, h);

  // Series / Class colored top banner bar
  ctx.fillStyle = style.headerBg;
  ctx.fillRect(x0, y0, w, headerH);

  ctx.strokeStyle = style.border;
  ctx.lineWidth = Math.max(3, w * 0.025);
  ctx.strokeRect(x0, y0, w, h);

  // Class header label
  ctx.fillStyle = style.headerText;
  ctx.font = `900 ${Math.round(headerH * 0.68)}px "Arial Black", Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.headerLabel, 0, y0 + headerH * 0.54, w * 0.9);

  // Bold racing number
  const numFont = Math.round(h * (number.length >= 2 ? 0.56 : 0.62));
  ctx.fillStyle = style.text;
  ctx.font = `italic 900 ${numFont}px "Arial Black", Impact, Arial, sans-serif`;
  ctx.fillText(number, -2, y0 + headerH + (h - headerH) * 0.54, w * 0.88);

  ctx.restore();
}

function paintBrandingAndDetails(
  ctx: CanvasRenderingContext2D,
  spec: Gt3LiverySpec,
  profile: Gt3BodyProfile
) {
  const doorTextColor =
    spec.pattern === "verstappen" || spec.pattern === "wrt_46" || spec.pattern === "iron_lynx_lime" || spec.pattern === "iron_lynx_cobalt" || spec.pattern === "express_75"
      ? "#ffffff"
      : "#0c1018";

  const doorSubColor =
    spec.pattern === "verstappen"
      ? "#f6c915"
      : spec.pattern === "iron_lynx_lime"
        ? "#b0ea00"
        : spec.pattern === "iron_lynx_cobalt"
          ? "#29ccf5"
          : spec.pattern === "wrt_46"
            ? "#d6ea00"
            : spec.pattern === "express_75"
              ? "#f5c542"
              : spec.pattern === "rowe"
                ? "#d91c2b"
                : spec.pattern === "turner"
                  ? "#003fa8"
                  : spec.accent === "#111318" || spec.accent === "#13171f"
                    ? spec.secondary
                    : spec.accent;

  const doorOutline =
    doorTextColor === "#ffffff" ? "rgba(0,0,0,0.68)" : "rgba(255,255,255,0.78)";

  // -------------------- 1) TOP PANEL: Rear wing banner, roof number, hood wordmark & hood plate --------------------
  clipRect(ctx, 0, 0, GT3_ATLAS_SIZE, TOP_H, () => {
    // Rear wing top mainplane paint & bold team banner
    ctx.fillStyle = spec.wingColor;
    ctx.fillRect(0, topY(0.92), topX(profile.wingZ1), topY(-0.92) - topY(0.92));
    drawTopText(ctx, spec.wingText, profile.wingZ1 * 0.48, 0, 44, spec.wingTextColor, {
      maxW: TOP_H * 0.76,
    });

    // Roof racing number (clean motorsport roof ID for overhead / helicopter shots)
    const roofMidZ = (profile.roofZ0 + profile.roofZ1) * 0.52;
    const roofNumColor =
      spec.pattern === "wrt_46"
        ? "#0b1224"
        : spec.pattern === "wrt_works" || spec.pattern === "paul_miller" || spec.pattern === "getspeed" || spec.pattern === "turner"
          ? "#0d121c"
          : "#ffffff";
    drawTopText(ctx, spec.number, roofMidZ, 0, 116, roofNumColor, {
      italic: true,
      outline: roofNumColor === "#ffffff" ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.7)",
      outlineW: 8,
    });

    // Hood main title sponsor + subline:
    // - On BMW M4 GT3 Evo, the wide unobstructed front hood bridge sits ahead of the twin extractor vents (0.855..0.92)
    // - On AMG GT3 Evo, the broad flat hood canvas sits behind the central extractor vent (0.34..0.47)
    const hoodSpan = profile.hoodZ1 - profile.hoodZ0;
    const isBmw = profile.car === "bmw-m4-gt3";
    const hoodTitleZ = profile.hoodZ0 + hoodSpan * (isBmw ? 0.855 : 0.34);
    const hoodSubZ = profile.hoodZ0 + hoodSpan * (isBmw ? 0.925 : 0.47);
    const hoodColor =
      spec.pattern === "verstappen" || spec.pattern === "iron_lynx_lime" || spec.pattern === "iron_lynx_cobalt" || spec.pattern === "express_75"
        ? "#ffffff"
        : spec.pattern === "rowe"
          ? "#f2cf00"
          : "#0c111b";
    drawTopText(ctx, spec.sponsors.hood, hoodTitleZ, isBmw ? 0.0 : 0.08, isBmw ? 36 : 48, hoodColor, {
      italic: true,
      maxW: isBmw ? 215 : 285,
      outline: hoodColor === "#ffffff" || spec.pattern === "rowe" ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)",
      outlineW: 5,
    });
    if (spec.sponsors.hoodSub && !isBmw) {
      drawTopText(ctx, spec.sponsors.hoodSub, hoodSubZ, 0.08, 23, doorSubColor, {
        maxW: 240,
        outline:
          spec.pattern === "turner" || spec.pattern === "rowe"
            ? "rgba(255,255,255,0.75)"
            : "rgba(0,0,0,0.55)",
        outlineW: 3,
      });
    }

    // Authentic offset GT3 hood number plate on the flat right fender shoulder (zero overlap with hood wordmark!)
    const hoodPlateZ = profile.hoodZ0 + hoodSpan * (isBmw ? 0.22 : 0.26);
    drawGt3NumberPlate(
      ctx,
      topX(hoodPlateZ),
      topY(-0.62),
      96,
      92,
      spec.number,
      spec.plate,
      -Math.PI / 2
    );
  });

  // -------------------- 2) LEFT & RIGHT SIDE PANELS: Door plate, sponsor wordmark, fender stack --------------------
  for (const isLeft of [true, false]) {
    const m = makeSideMapper(isLeft);
    clipRect(ctx, 0, isLeft ? LEFT_Y : RIGHT_Y, GT3_ATLAS_SIZE, SIDE_H, () => {
      const doorCenterZ = (profile.doorZ0 + profile.doorZ1) * 0.5;
      const doorSpan = profile.doorZ1 - profile.doorZ0;
      const isBmw = profile.car === "bmw-m4-gt3";

      // Framed GT3 Door Number Plate (rear-mid section of flat door panel)
      const plateZ = doorCenterZ - doorSpan * (isBmw ? 0.30 : 0.28);
      drawGt3NumberPlate(
        ctx,
        m.x(plateZ),
        m.y(profile.doorMidY + 0.03),
        132,
        124,
        spec.number,
        spec.plate
      );

      // Bold Door Team / Title Sponsor Wordmark (centered squarely on the flat door with clear margin before front fender!)
      const sponsorZ = doorCenterZ + doorSpan * (isBmw ? 0.14 : 0.12);
      drawSideText(ctx, m, spec.sponsors.door, sponsorZ, profile.doorMidY + 0.05, isBmw ? 40 : 42, doorTextColor, {
        italic: true,
        maxW: isBmw ? 225 : 265,
        outline: doorOutline,
        outlineW: 5.5,
      });
      if (spec.sponsors.doorSub) {
        drawSideText(ctx, m, spec.sponsors.doorSub, sponsorZ, profile.doorMidY - 0.075, 22, doorSubColor, {
          maxW: isBmw ? 200 : 230,
          outline: spec.pattern === "turner" || spec.pattern === "rowe" ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.62)",
          outlineW: 3.5,
        });
      }

      // Authentic GT3 contingency decals neatly tucked on smooth upper front bumper cheek (never clipped by intake!)
      const fenderZ = profile.frontWheelZ + (isBmw ? 0.092 : 0.102);
      const fenderTextColor =
        spec.pattern === "wrt_46" || spec.pattern === "mamba" || spec.pattern === "turner" || spec.pattern === "paul_miller" || spec.pattern === "wrt_works" || spec.pattern === "getspeed" || spec.pattern === "gruppem" || spec.pattern === "silver_arrow"
          ? "#0e131c"
          : "#ffffff";
      spec.sponsors.fender.slice(0, 2).forEach((brand, idx) => {
        drawSideText(ctx, m, brand, fenderZ, 0.35 - idx * 0.075, 16, fenderTextColor, {
          maxW: 92,
          outline: fenderTextColor === "#ffffff" ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.65)",
          outlineW: 2.5,
        });
      });

      // Rear bumper side sponsor tag (behind rear wheel)
      const rearTagZ = profile.rearWheelZ - 0.12;
      const rearTagColor =
        spec.pattern === "wrt_works" || spec.pattern === "paul_miller" || spec.pattern === "rowe"
          ? "#0e131c"
          : "#ffffff";
      drawSideText(ctx, m, spec.sponsors.fender[0], rearTagZ, 0.44, 21, rearTagColor, {
        maxW: 140,
        outline: rearTagColor === "#ffffff" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.55)",
        outlineW: 3,
      });

      // Subtle FIA safety E-cutout decal near A-pillar base
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(m.x(profile.doorZ1 + 0.02), m.y(0.62), 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "900 9px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("E", m.x(profile.doorZ1 + 0.02), m.y(0.62));
    });
  }

  // -------------------- 3) REAR PANEL: Chase-cam rear wing banner & bumper lettering --------------------
  clipRect(ctx, 0, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    // Upper rear strip = rear wing trailing face (chase-cam hero!)
    ctx.fillStyle = spec.wingColor;
    ctx.fillRect(0, BOTTOM_Y, HALF_W, BOTTOM_H * 0.28);
    ctx.fillStyle = spec.wingTextColor;
    ctx.font = 'italic 900 44px "Arial Black", Arial, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.wingText, HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.15, HALF_W * 0.84);

    // Lower rear bumper sponsor wordmark
    ctx.fillStyle = spec.pattern === "wrt_works" || spec.pattern === "paul_miller" || spec.pattern === "rowe" ? "#0d121c" : "#ffffff";
    ctx.font = 'italic 900 32px "Arial Black", Arial, sans-serif';
    ctx.fillText(spec.sponsors.rear, HALF_W * 0.5, BOTTOM_Y + BOTTOM_H * 0.50, HALF_W * 0.72);
  });

  // -------------------- 4) FRONT PANEL: Subtle front nose number / splitter accent --------------------
  clipRect(ctx, HALF_W, BOTTOM_Y, HALF_W, BOTTOM_H, () => {
    ctx.fillStyle = spec.accent;
    ctx.fillRect(HALF_W + HALF_W * 0.16, BOTTOM_Y + BOTTOM_H * 0.80, HALF_W * 0.68, 8);
  });
}

/** Renders a procedural GT3 livery atlas onto a 2D canvas context (used at runtime and in verification tests) */
export function renderGt3LiveryToContext(
  ctx: CanvasRenderingContext2D,
  spec: Gt3LiverySpec,
  pixelSize = GT3_ATLAS_SIZE
): void {
  const profile = GT3_BODY_PROFILES[spec.car];
  if (!isCapableCanvas2DContext(ctx)) {
    const partial = ctx as Partial<CanvasRenderingContext2D> | null | undefined;
    if (partial && typeof partial.fillRect === "function") {
      partial.fillStyle = spec.primary;
      partial.fillRect(0, 0, pixelSize, pixelSize);
    }
    return;
  }

  const scale = pixelSize / GT3_ATLAS_SIZE;
  ctx.save();
  if (scale !== 1) ctx.scale(scale, scale);

  const carbonFill = createCarbonPattern(ctx);
  paintPatternGraphics(ctx, spec, profile, carbonFill);
  paintBrandingAndDetails(ctx, spec, profile);

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Atlas Texture Cache (shared across all GT3 cars wearing the same procedural livery)
// ---------------------------------------------------------------------------

const MAX_CACHED_GT3_ATLASES = 18;
const gt3AtlasCache = new Map<string, THREE.CanvasTexture>();

function chooseGt3AtlasResolution(): number {
  if (typeof window === "undefined") return GT3_ATLAS_SIZE;
  return typeof window.innerWidth === "number" && window.innerWidth > 0 && window.innerWidth < 768
    ? 1024
    : GT3_ATLAS_SIZE;
}

export function getGt3LiveryAtlasTexture(id: string): THREE.CanvasTexture | null {
  const spec = gt3LiveryById(id);
  if (!spec) return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return null;

  const hit = gt3AtlasCache.get(id);
  if (hit) return hit;

  const size = chooseGt3AtlasResolution();
  const canvas = document.createElement("canvas");
  if (!canvas || typeof canvas.getContext !== "function") return null;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!isCapableCanvas2DContext(ctx)) return null;

  renderGt3LiveryToContext(ctx, spec, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = `gt3_livery_atlas_${id}`;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  gt3AtlasCache.set(id, tex);
  while (gt3AtlasCache.size > MAX_CACHED_GT3_ATLASES) {
    const oldest = gt3AtlasCache.keys().next().value;
    if (oldest === undefined) break;
    const stale = gt3AtlasCache.get(oldest);
    gt3AtlasCache.delete(oldest);
    stale?.dispose();
  }
  return tex;
}

/** Disposes and clears cached procedural GT3 livery atlases (paired with `clearSkinTextureCache`) */
export function clearGt3LiveryCache(): void {
  for (const tex of gt3AtlasCache.values()) tex.dispose();
  gt3AtlasCache.clear();
}

// ---------------------------------------------------------------------------
// Object-Space Tri-Orthographic Projection Shader for Ported GT3 Bodywork
// ---------------------------------------------------------------------------

const BLANK_GT3_ATLAS = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
BLANK_GT3_ATLAS.colorSpace = THREE.SRGBColorSpace;
BLANK_GT3_ATLAS.needsUpdate = true;

const GT3_VERTEX_PATCH = /* glsl */ `#include <common>
uniform mat4 uGt3Frame;
varying vec3 vGt3Pos;
varying vec3 vGt3Nrm;`;

const GT3_VERTEX_BODY = /* glsl */ `#include <begin_vertex>
vGt3Pos = ( uGt3Frame * vec4( position, 1.0 ) ).xyz;
vGt3Nrm = normalize( mat3( uGt3Frame ) * normal );`;

const GT3_FRAGMENT_PATCH = /* glsl */ `#include <common>
uniform sampler2D uGt3Atlas;
uniform float uGt3Enabled;
uniform float uGt3CarbonStrength;
uniform vec3 uGt3Min;
uniform vec3 uGt3Max;
uniform float uGt3WingRearZ;
uniform float uGt3HoodStartZ;
uniform float uGt3SplitterMaxY;
uniform float uGt3SplitterMinZ;
varying vec3 vGt3Pos;
varying vec3 vGt3Nrm;

vec2 gt3AtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
	vec2 pad = vec2( 2.0 / 2048.0 );
	vec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
	return rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float gt3CarbonTwill( vec2 p ) {
	vec2 c = floor( p );
	float warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
	return 2.0 * warp - 1.0;
}`;

const GT3_FRAGMENT_MAP = /* glsl */ `#include <map_fragment>
float gt3CarbonMask = 0.0;
if ( uGt3Enabled > 0.5 ) {
	vec3 lp = vGt3Pos;
	vec3 ln = normalize( vGt3Nrm );
	vec3 span = max( uGt3Max - uGt3Min, vec3( 0.001 ) );

	// 1) TOP panel: rect (0, 0, 1.0, 832/2048 = 0.40625)
	vec2 uvTop = vec2( ( lp.z - uGt3Min.z ) / span.z, ( uGt3Max.x - lp.x ) / span.x );
	vec3 colTop = texture2D( uGt3Atlas, gt3AtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.40625 ) ) ).rgb;

	// 2) LEFT (+X) and RIGHT (-X) SIDE panels: rects (0, 0.40625, 1.0, 0.21875) and (0, 0.625, 1.0, 0.21875)
	vec3 colSide;
	float sideV = ( uGt3Max.y - lp.y ) / span.y;
	if ( ln.x >= 0.0 ) {
		float leftU = ( uGt3Max.z - lp.z ) / span.z;
		colSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( leftU, sideV ), vec2( 0.0, 0.40625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
	} else {
		float rightU = ( lp.z - uGt3Min.z ) / span.z;
		colSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( rightU, sideV ), vec2( 0.0, 0.625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
	}

	// 3) REAR (-Z) and FRONT (+Z) panels: rects (0, 0.84375, 0.5, 0.15625) and (0.5, 0.84375, 0.5, 0.15625)
	vec3 colEnd;
	if ( ln.z < 0.0 ) {
		vec2 uvRear = vec2( ( uGt3Max.x - lp.x ) / span.x, sideV );
		colEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
	} else {
		vec2 uvFront = vec2( ( lp.x - uGt3Min.x ) / span.x, sideV );
		colEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
	}

	// Sharp tri-orthographic weights so hood/door/rear graphics stay crisp with zero ghosting
	float wx = pow( abs( ln.x ), 4.0 );
	float wy = pow( max( ln.y, 0.0 ) + 0.30 * max( -ln.y, 0.0 ), 4.0 );
	float wz = pow( abs( ln.z ), 5.0 );

	// Keep gently sloped GT3 hoods sharp on the TOP projection
	if ( lp.z > uGt3HoodStartZ && lp.y > 0.50 && ln.y > 0.42 ) {
		wy *= 2.4;
	}
	// Rear wing mainplane top/rear crispness & wing endplate side crispness
	if ( lp.z < uGt3WingRearZ && lp.y > 1.00 ) {
		if ( abs( lp.x ) < 0.86 ) {
			if ( ln.z < -0.35 ) wz = max( wz, 3.5 );
			else wy = max( wy, 3.5 );
		} else {
			wx = max( wx, 4.0 );
		}
	}

	vec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );

	// Keep the protruding AMG GT3 Evo front aero splitter tray exposed dark carbon fiber
	if ( uGt3SplitterMaxY > 0.0 && lp.y < uGt3SplitterMaxY && lp.z > uGt3SplitterMinZ ) {
		livCol = vec3( 0.011, 0.012, 0.015 );
	}

	diffuseColor.rgb = livCol;

	// Detect exposed dark carbon regions (linear max channel < 0.025) for 2x2 twill weave roughness sheen
	float maxC = max( livCol.r, max( livCol.g, livCol.b ) );
	gt3CarbonMask = ( 1.0 - smoothstep( 0.014, 0.028, maxC ) ) * uGt3CarbonStrength;
}`;

const GT3_FRAGMENT_ROUGHNESS = /* glsl */ `#include <roughnessmap_fragment>
if ( gt3CarbonMask > 0.01 ) {
	vec3 cn = abs( normalize( vGt3Nrm ) );
	vec2 cp = cn.y > 0.6 ? vGt3Pos.xz : ( cn.x > 0.6 ? vGt3Pos.zy : vGt3Pos.xy );
	float invPitch = 190.0;
	vec3 dP = fwidth( vGt3Pos );
	float towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
	float fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
	float twill = gt3CarbonTwill( cp * invPitch ) * fade * gt3CarbonMask;
	roughnessFactor = mix( roughnessFactor, 0.36, gt3CarbonMask * 0.72 ) + 0.055 * twill;
	diffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

export interface Gt3LiverySurface {
  material: THREE.MeshStandardMaterial;
  frameMatrix?: THREE.Matrix4;
}

export interface Gt3LiveryPaintController {
  /** Applies a procedural GT3 livery id (or `null` to restore the GLB's original paint) */
  set: (liveryId: string | null) => boolean;
  /** Disposes per-rig cloned paint materials owned by this controller */
  dispose: () => void;
}

/**
 * Installs the zero-recompile procedural GT3 livery projection shader onto cloned exterior paint materials
 * of a ported GT3 car rig (`MI_Mercedes_AMG_GT3_Evo_Livery` or `BMWMAT_GT3_EVO_car_paint1`).
 */
export function installGt3LiveryPaint(
  surfaces: readonly Gt3LiverySurface[],
  profile: Gt3BodyProfile
): Gt3LiveryPaintController {
  const sharedUniforms = {
    uGt3Atlas: { value: BLANK_GT3_ATLAS as THREE.Texture },
    uGt3Enabled: { value: 0.0 },
    uGt3CarbonStrength: { value: 0.0 },
    uGt3Min: { value: new THREE.Vector3(...profile.min) },
    uGt3Max: { value: new THREE.Vector3(...profile.max) },
    uGt3WingRearZ: { value: profile.wingRearZ },
    uGt3HoodStartZ: { value: profile.hoodStartZ },
    uGt3SplitterMaxY: { value: profile.splitterMaxY },
    uGt3SplitterMinZ: { value: profile.splitterMinZ },
  };
  const identity = new THREE.Matrix4();

  const originals = surfaces.map(({ material: m }) => {
    const phys = m as THREE.MeshPhysicalMaterial;
    return {
      color: m.color.clone(),
      roughness: m.roughness,
      metalness: m.metalness,
      clearcoat: phys.isMeshPhysicalMaterial ? phys.clearcoat : 0,
      clearcoatRoughness: phys.isMeshPhysicalMaterial ? phys.clearcoatRoughness : 0,
      specularIntensity: phys.isMeshPhysicalMaterial ? phys.specularIntensity : 1,
      normalScale: m.normalScale ? m.normalScale.clone() : null,
    };
  });

  for (const s of surfaces) {
    const m = s.material;
    const frameUniform = { value: (s.frameMatrix ?? identity).clone() };
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      Object.assign(shader.uniforms, sharedUniforms, { uGt3Frame: frameUniform });
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", GT3_VERTEX_PATCH)
        .replace("#include <begin_vertex>", GT3_VERTEX_BODY);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", GT3_FRAGMENT_PATCH)
        .replace("#include <map_fragment>", GT3_FRAGMENT_MAP)
        .replace("#include <roughnessmap_fragment>", GT3_FRAGMENT_ROUGHNESS);
    };
    const prevKey = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${prevKey()}|gt3-procedural-livery-v1`;
    m.needsUpdate = true;
  }

  const restoreOriginals = () => {
    for (let i = 0; i < surfaces.length; i++) {
      const m = surfaces[i].material;
      const orig = originals[i];
      const phys = m as THREE.MeshPhysicalMaterial;
      m.color.copy(orig.color);
      m.roughness = orig.roughness;
      m.metalness = orig.metalness;
      if (phys.isMeshPhysicalMaterial) {
        phys.clearcoat = orig.clearcoat;
        phys.clearcoatRoughness = orig.clearcoatRoughness;
        phys.specularIntensity = orig.specularIntensity;
      }
      if (orig.normalScale && m.normalScale) {
        m.normalScale.copy(orig.normalScale);
      }
    }
  };

  return {
    set: (liveryId) => {
      if (!liveryId) {
        sharedUniforms.uGt3Enabled.value = 0.0;
        sharedUniforms.uGt3CarbonStrength.value = 0.0;
        restoreOriginals();
        return false;
      }
      const spec = gt3LiveryById(liveryId);
      const atlas = spec ? getGt3LiveryAtlasTexture(liveryId) : null;
      if (!spec || !atlas) {
        sharedUniforms.uGt3Enabled.value = 0.0;
        sharedUniforms.uGt3CarbonStrength.value = 0.0;
        restoreOriginals();
        return false;
      }
      const finish = LIVERY_FINISH_PROFILES[spec.finish] ?? LIVERY_FINISH_PROFILES.gloss;
      sharedUniforms.uGt3Atlas.value = atlas;
      sharedUniforms.uGt3Enabled.value = 1.0;
      sharedUniforms.uGt3CarbonStrength.value = spec.carbonExposure;

      for (let i = 0; i < surfaces.length; i++) {
        const m = surfaces[i].material;
        const orig = originals[i];
        const phys = m as THREE.MeshPhysicalMaterial;
        m.color.setHex(0xffffff);
        m.roughness = finish.roughness;
        m.metalness = finish.metalness;
        if (phys.isMeshPhysicalMaterial) {
          phys.clearcoat = finish.clearcoat;
          phys.clearcoatRoughness = finish.clearcoatRoughness;
          phys.specularIntensity = finish.specularIntensity;
        }
        if (orig.normalScale && m.normalScale) {
          // Tone down flake micro-normal slightly on velvet matte wraps so matte reads silky smooth
          const factor = spec.finish === "matte" ? 0.35 : 0.85;
          m.normalScale.copy(orig.normalScale).multiplyScalar(factor);
        }
      }
      return true;
    },
    dispose: () => {
      for (const s of surfaces) s.material.dispose();
    },
  };
}
