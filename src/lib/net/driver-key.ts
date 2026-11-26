/**
 * The driver key: a random secret kept in this browser that claims the player's name on the online board
 * (cloudflare/api/board.ts stores only its SHA-256). It is sent with uploads, renames, key lookups and account joins
 * and nowhere else, never written into lap or ghost files, and can be exported to a file to move to another browser or
 * device.
 */
import { text as t } from "@/lib/text";
import { codeFromName, sanitizeDriverCode, sanitizeDriverName, type DriverProfile } from "@/lib/settings/player-settings";
import { driverNameKey } from "./board-client";
import { nameProblem } from "./name-filter";

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
    sessionKey = null;
    return true;
  } catch {
    return false;
  }
}

/** The saved key, or a new random one (32 bytes) saved for next time */
export function getOrCreateDriverKey(): string {
  const existing = loadDriverKey() ?? sessionKey;
  if (existing) return existing;
  const key = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  // Storage blocked: keep it for this session at least, or every upload would mint a new key and the player's own
  // name would read as taken on the second one
  if (!saveDriverKey(key)) sessionKey = key;
  return key;
}

/** The key minted while storage is blocked; lost with the page */
let sessionKey: string | null = null;

/** Downloads the key as librecorsa-driver-key.json; false when this browser has no key yet */
export function exportDriverKeyFile(driverName: string, driverCode?: string): boolean {
  const key = loadDriverKey() ?? sessionKey;
  if (!key) return false;
  try {
    const body = {
      type: FILE_TYPE,
      version: 1,
      name: driverName,
      ...(driverCode ? { code: driverCode } : {}),
      key,
    };
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

/** Reads an exported key file and makes it this browser's key; resolves the name (and optional code) it was saved with */
export async function importDriverKeyFile(
  file: File,
): Promise<{ ok: true; name: string; code: string } | { ok: false; error: string }> {
  try {
    if (file.size > MAX_FILE_BYTES) return { ok: false, error: t("game.driverKey.notAKeyFile") };
    const raw: unknown = JSON.parse(await file.text());
    if (typeof raw !== "object" || raw === null) return { ok: false, error: t("game.driverKey.notAKeyFile") };
    const { type, key, name, code } = raw as Record<string, unknown>;
    if (type !== FILE_TYPE || typeof key !== "string" || !KEY_PATTERN.test(key)) {
      return { ok: false, error: t("game.driverKey.notAKeyFile") };
    }
    if (!saveDriverKey(key)) return { ok: false, error: t("game.driverKey.blocked") };
    return {
      ok: true,
      name: typeof name === "string" ? name.slice(0, 64) : "",
      code: typeof code === "string" ? code.slice(0, 16) : "",
    };
  } catch {
    return { ok: false, error: t("game.driverKey.notAKeyFile") };
  }
}

/** Identity fields learned from an exported key file or from POST /api/drivers/lookup */
export interface ImportedDriverIdentity {
  name?: string | null;
  code?: string | null;
  /** Canonical lower-cased claim key when the server found a claim without a display-cased lap or race row */
  nameKey?: string | null;
}

const cleanPrintableName = (raw: string | null | undefined): string | null => {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  if (!trimmed) return null;
  const sanitized = sanitizeDriverName(trimmed);
  return nameProblem(sanitized) ? null : sanitized;
};

const cleanCode = (raw: string | null | undefined): string | null => {
  if (typeof raw !== "string") return null;
  const letters = raw.normalize("NFD").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  return letters.length > 0 ? sanitizeDriverCode(letters) : null;
};

/**
 * Picks the display name to restore from `identity` (server lookup or key file), preserving `fallback.name`'s letter
 * casing when the server only has a lower-cased `nameKey` for the same name. Returns null when neither carries a valid
 * name.
 */
export function resolveImportedDriverName(
  identity: ImportedDriverIdentity,
  fallback?: { name?: string | null },
): string | null {
  const direct = cleanPrintableName(identity.name);
  if (direct) return direct;
  const fallbackName = cleanPrintableName(fallback?.name);
  const key = typeof identity.nameKey === "string" ? identity.nameKey.trim() : "";
  if (key) {
    if (fallbackName && driverNameKey(fallbackName) === key) return fallbackName;
    return cleanPrintableName(key);
  }
  return fallbackName;
}

/**
 * Applies an imported key's driver name and three-letter code onto `prev` without renaming anything on the online
 * boards (the imported key already owns the name there). Marks the profile as non-generated when a name is restored,
 * derives the code from the restored name when switching away from a generated or different identity unless an explicit
 * code is provided, and returns `prev` unchanged when nothing differs.
 */
export function applyImportedDriverIdentity(
  prev: DriverProfile,
  identity: ImportedDriverIdentity,
  fallback?: { name?: string | null; code?: string | null },
): DriverProfile {
  const nextName = resolveImportedDriverName(identity, fallback);
  const directCode = cleanCode(identity.code);
  const fallbackName = cleanPrintableName(fallback?.name);
  const fallbackCode =
    cleanCode(fallback?.code) &&
    (!nextName || !fallbackName || driverNameKey(nextName) === driverNameKey(fallbackName))
      ? cleanCode(fallback?.code)
      : null;
  const explicitCode = directCode ?? fallbackCode;

  let nextCode = prev.code;
  if (explicitCode) {
    nextCode = explicitCode;
  } else if (nextName && (prev.generated || driverNameKey(nextName) !== driverNameKey(prev.name))) {
    nextCode = codeFromName(nextName);
  }

  if (!nextName) {
    return nextCode === prev.code ? prev : { ...prev, code: nextCode };
  }
  if (nextName === prev.name && nextCode === prev.code && !prev.generated) return prev;
  return { ...prev, name: nextName, code: nextCode, generated: false };
}
