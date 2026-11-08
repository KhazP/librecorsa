/** The room code in a `?room=` invite link, normalised to the bare code; null when there is none or it is not one */
export function roomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("room");
  const code = raw?.trim().replace(/^(RWA|LC)-/i, "").toUpperCase().slice(0, 6) ?? "";
  return code.length >= 3 ? code : null;
}
