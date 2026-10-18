/**
 * The driver key: a random secret kept in this browser that claims the player's name on the online board
 * (scripts/leaderboard-supabase/schema.sql stores only its SHA-256). It is sent with uploads and nowhere else,
 * never written into lap or ghost files, and can be exported to a file to move to another browser or device.
 */

const STORAGE_KEY = "bugesera.driverKey";
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const FILE_TYPE = "librecorsa-driver-key";
const MAX_FILE_BYTES = 4096;

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The saved key, or null when there is none (or storage is blocked) */
export function loadDriverKey(): string | null {
  try {
    const key = localStorage.getItem(STORAGE_KEY);
    return key && KEY_PATTERN.test(key) ? key : null;
  } catch {
    return null;
  }
}

function saveDriverKey(key: string): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, key);
    return true;
  } catch {
    return false;
  }
}

/** The saved key, or a new random one (32 bytes) saved for next time */
export function getOrCreateDriverKey(): string {
  const existing = loadDriverKey();
  if (existing) return existing;
  const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  saveDriverKey(key);
  return key;
}

/** Downloads the key as librecorsa-driver-key.json; false when this browser has no key yet */
export function exportDriverKeyFile(driverName: string): boolean {
  const key = loadDriverKey();
  if (!key) return false;
  try {
    const body = { type: FILE_TYPE, version: 1, name: driverName, key };
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "librecorsa-driver-key.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Reads an exported key file and makes it this browser's key; resolves the name it was saved with */
export async function importDriverKeyFile(file: File): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  try {
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: "That is not a driver key file" };
    const raw: unknown = JSON.parse(await file.text());
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "That is not a driver key file" };
    const { type, key, name } = raw as Record<string, unknown>;
    if (type !== FILE_TYPE || typeof key !== "string" || !KEY_PATTERN.test(key)) {
      return { ok: false, error: "That is not a driver key file" };
    }
    if (!saveDriverKey(key)) return { ok: false, error: "This browser blocks saving it" };
    return { ok: true, name: typeof name === "string" ? name.slice(0, 64) : "" };
  } catch {
    return { ok: false, error: "That is not a driver key file" };
  }
}
