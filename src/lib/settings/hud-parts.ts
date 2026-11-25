/**
 * Where the player has moved and resized the HUD's corner groups (Settings > Display > HUD > Edit layout), per
 * layout drawn: each layout fills its corners differently, so moving Classic's map leaves Broadcast's top right alone,
 * and the Phone HUD (which a phone or the touch pads draw in place of the chosen layout) keeps its own.
 * Offsets are in percent of the window (vw / vh), so a moved panel keeps its place across window sizes, a
 * fullscreen switch and a phone turned on its side. Saved with the settings; a part without one is where its
 * layout puts it.
 */
import { isHudPreset, type HudPreset } from "@/lib/settings/hud-layouts";

/** The HUD's corner groups: every layout anchors its panels to these (hud-style-parts.tsx `anchor`) */
export const HUD_PART_IDS = [
  "top-left",
  "top-center",
  "top-right",
  "center-right",
  "center",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

export type HudPartId = (typeof HUD_PART_IDS)[number];

export const isHudPartId = (v: unknown): v is HudPartId => typeof v === "string" && (HUD_PART_IDS as readonly string[]).includes(v);

/** The part a corner group's transform origin ("top left", "center") stands for */
export const hudPartOfOrigin = (origin: string): HudPartId | null => {
  const id = origin.trim().replace(/\s+/g, "-");
  return isHudPartId(id) ? id : null;
};

/** One part's offset from where its layout puts it (% of the window: x right, y down) and its size (× the HUD size) */
export interface HudPart {
  x: number;
  y: number;
  scale: number;
  hidden?: boolean;
}

export type HudLayoutParts = Partial<Record<HudPartId, HudPart>>;

/** The Phone HUD's parts are kept under this key: it stands in for whichever layout is chosen */
export const PHONE_HUD_PARTS = "phone";
/** What a layout's parts are kept under: the layout chosen, or the Phone HUD where it is drawn instead */
export type HudPartsKey = HudPreset | typeof PHONE_HUD_PARTS;
export const hudPartsKey = (preset: HudPreset, phoneHud: boolean): HudPartsKey => (phoneHud ? PHONE_HUD_PARTS : preset);
const isPartsKey = (v: string): v is HudPartsKey => v === PHONE_HUD_PARTS || isHudPreset(v);

export type HudParts = Partial<Record<HudPartsKey, HudLayoutParts>>;

export const NO_HUD_PART: HudPart = { x: 0, y: 0, scale: 1 };
/** As far as a part can move: the whole window either way (%) */
export const HUD_PART_OFFSET_MAX = 100;
export const HUD_PART_SCALE_MIN = 0.5;
export const HUD_PART_SCALE_MAX = 2;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Hundredths of a percent and of the scale: fine enough for a pixel on a 4K screen, no float noise in the save */
const round2 = (v: number) => Math.round(v * 100) / 100;

export const isDefaultHudPart = (p: HudPart): boolean => p.x === 0 && p.y === 0 && p.scale === 1 && !p.hidden;

/** A part clamped to its limits, or null where it is where its layout puts it */
export function cleanHudPart(p: Partial<HudPart> | null | undefined): HudPart | null {
  if (!p || typeof p !== "object") return null;
  const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? round2(clamp(v, lo, hi)) : d);
  const out: HudPart = {
    x: num(p.x, -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX, 0),
    y: num(p.y, -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX, 0),
    scale: num(p.scale, HUD_PART_SCALE_MIN, HUD_PART_SCALE_MAX, 1),
    ...(p.hidden === true ? { hidden: true } : null),
  };
  return isDefaultHudPart(out) ? null : out;
}

/** One layout's parts, clamped; anything malformed or unmoved is dropped */
export function cleanHudLayoutParts(raw: unknown): HudLayoutParts {
  const out: HudLayoutParts = {};
  if (!raw || typeof raw !== "object") return out;
  for (const id of HUD_PART_IDS) {
    const p = cleanHudPart((raw as Record<string, unknown>)[id] as Partial<HudPart> | undefined);
    if (p) out[id] = p;
  }
  return out;
}

/** A save's parts for the layouts this game has (and the Phone HUD); anything malformed is dropped */
export function parseHudParts(raw: unknown): HudParts {
  const out: HudParts = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [layout, parts] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPartsKey(layout)) continue;
    const kept = cleanHudLayoutParts(parts);
    if (Object.keys(kept).length) out[layout] = kept;
  }
  return out;
}

/** `parts` with one layout's parts replaced (empty: that layout back to how it comes) */
export function withLayoutParts(parts: HudParts, layout: HudPartsKey, next: HudLayoutParts): HudParts {
  const kept = cleanHudLayoutParts(next);
  const out: HudParts = { ...parts };
  if (Object.keys(kept).length) out[layout] = kept;
  else delete out[layout];
  return out;
}

export const layoutMoved = (parts: HudParts | undefined, layout: HudPartsKey): boolean => Object.keys(parts?.[layout] ?? {}).length > 0;
