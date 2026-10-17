/** Shared formatting and colour rules of the in-race HUD */

export const HUD_RED = "#E10600";
export const HUD_GREEN = "#00D26A";
export const HUD_PURPLE = "#B138FF";
export const HUD_YELLOW = "#FFD700";
export const HUD_CYAN = "#00D2BE";

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

/** Tyre surface temperature colour: cold blue → working green → hot orange / red */
export function tyreTempColor(tempC: number): string {
  if (tempC < 70) return "#3B82F6";
  if (tempC < 85) return "#22D3EE";
  if (tempC <= 110) return HUD_GREEN;
  if (tempC <= 125) return "#F59E0B";
  return HUD_RED;
}
