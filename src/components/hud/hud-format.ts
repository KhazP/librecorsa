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

/** Tyre surface temperature colour: cold blue → slipstream cyan → working green → caution amber → overheating rosso */
export function tyreTempColor(tempC: number): string {
  if (tempC < 70) return "#38BDF8";
  if (tempC < 85) return HUD_CYAN;
  if (tempC <= 110) return HUD_GREEN;
  if (tempC <= 125) return HUD_YELLOW;
  return HUD_RED;
}
