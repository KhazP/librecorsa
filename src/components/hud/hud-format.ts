/** Shared formatting and colour rules of the LibreCorsa in-race telemetry HUD */

export const HUD_VOLT = "#CCFF00";
export const HUD_RED = "#FF2A3C";
export const HUD_GREEN = "#00E676";
export const HUD_PURPLE = "#B845FF";
export const HUD_YELLOW = "#FFB300";
export const HUD_CYAN = "#00E5FF";
export const HUD_VOID = "#08090D";
export const HUD_CARBON = "#11131A";
export const HUD_TITANIUM = "#1B1F2B";
export const HUD_BORDER = "#262B3D";
export const HUD_SLATE = "#8E96AA";
export const HUD_WHITE = "#F5F7FA";
/** Sector 3 on the circuit map (sector 1 cyan, sector 2 volt) */
export const HUD_PINK = "#FF6B8A";

/** Racing Line HUD sheet floating over the scene; add a radius (22px panels, rounded-full pills) */
export const HUD_GLASS =
  "border border-white/[0.07] bg-[#08090D]/[0.76] shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur-[14px]";
/** Inset well inside a HUD sheet (tyre cards, light pods, elevation box) */
export const HUD_WELL = "border border-[#1B1F2B] bg-[#050608]";
/** Small tracked mono label used across the HUD panels */
export const HUD_LBL = "font-f1-mono text-[9px] font-extrabold tracking-[0.18em] text-[#8E96AA] uppercase";

/** m:ss.mmm, or dashes when there is no time yet */
export function formatLapTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "-:--.---";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const millis = Math.floor(ms % 1000);
  return `${mins}:${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

/** ss.mmm for sector times */
export function formatSectorTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "--.---";
  return (ms / 1000).toFixed(3);
}

/** Signed delta in seconds: "-0.234" / "+1.020" */
export function formatDelta(seconds: number): string {
  return `${seconds < 0 ? "−" : "+"}${Math.abs(seconds).toFixed(3)}`;
}

/** Tyre surface temperature colour: cold blue → slipstream cyan → working green (85–105 °C) → caution amber → overheating rosso (> 115 °C) */
export function tyreTempColor(tempC: number): string {
  if (tempC < 70) return "#38BDF8";
  if (tempC < 85) return HUD_CYAN;
  if (tempC <= 105) return HUD_GREEN;
  if (tempC <= 115) return HUD_YELLOW;
  return HUD_RED;
}

type Rgb = [number, number, number];
const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixRgb = (a: Rgb, b: Rgb, u: number) => {
  const k = Math.max(0, Math.min(1, u));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(a[1] + (b[1] - a[1]) * k)}, ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
};
const COLD = hexRgb("#2F6BFF");
const COOL = hexRgb("#38BDF8");
const OK = hexRgb(HUD_GREEN);
const WARM = hexRgb("#FF8A00");
const HOT = hexRgb(HUD_RED);

/**
 * Continuous tread colour against the compound's working window: blue well below it, blending to green across the
 * last 25 °C, green inside it, orange 10 °C over and rosso 20 °C over (85–105 °C → red past 115 °C by default).
 */
export function tyreHeatColor(tempC: number, window: readonly [number, number] = [85, 105]): string {
  const [lo, hi] = window;
  if (tempC < lo - 25) return mixRgb(COLD, COOL, (tempC - (lo - 45)) / 20);
  if (tempC < lo) return mixRgb(COOL, OK, (tempC - (lo - 25)) / 25);
  if (tempC <= hi) return mixRgb(OK, OK, 0);
  if (tempC <= hi + 10) return mixRgb(OK, WARM, (tempC - hi) / 10);
  return mixRgb(WARM, HOT, (tempC - hi - 10) / 10);
}

/** Brake disc glow: dark when cold, orange in its working range, white-hot over 950 °C */
export function brakeGlowColor(tempC: number): string {
  if (tempC < 200) return mixRgb(hexRgb("#1B2A4A"), hexRgb("#5B3A2A"), tempC / 200);
  if (tempC < 450) return mixRgb(hexRgb("#5B3A2A"), hexRgb("#FF5A1F"), (tempC - 200) / 250);
  if (tempC < 850) return mixRgb(hexRgb("#FF5A1F"), hexRgb("#FFB300"), (tempC - 450) / 400);
  return mixRgb(hexRgb("#FFB300"), hexRgb("#FFF4D6"), (tempC - 850) / 250);
}
