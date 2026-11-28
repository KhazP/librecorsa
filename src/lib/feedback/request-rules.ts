import rules from "./request-rules.json";

export const REQUEST_LIMITS = rules.limits;

export const OPEN_LICENSES = [
  "CC BY / CC BY-SA",
  "CC0 / public domain",
  "CC BY-NC / CC BY-NC-SA",
] as const;

export const PERMISSION_LICENSE = "The license allows it";
export const PERMISSION_WRITTEN = "The creator gave written permission";

export type ModelLinkKind = "ok" | "invalid" | "piracy" | "file-host" | "commercial-store";

export interface ModelLinkVerdict {
  kind: ModelLinkKind;
  host: string;
}

const matchesDomain = (host: string, list: readonly string[]): boolean =>
  list.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Classifies a content-request model URL against the shared reupload/piracy, direct file-host, and commercial 3D
 * storefront blocklists (`request-rules.json`).
 */
export function classifyModelLink(raw: string): ModelLinkVerdict {
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(trimmed)) return { kind: "invalid", host: "" };
  let host = "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { kind: "invalid", host: "" };
    host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return { kind: "invalid", host: "" };
  }
  if (!host.includes(".")) return { kind: "invalid", host: "" };
  if (matchesDomain(host, rules.piracyDomains)) return { kind: "piracy", host };
  if (matchesDomain(host, rules.fileHostDomains)) return { kind: "file-host", host };
  if (matchesDomain(host, rules.commercialStoreDomains)) return { kind: "commercial-store", host };
  return { kind: "ok", host };
}

const normalizePhrase = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, " ")
    .replace(/^[.,!?;:\-–—"'()[\]]+|[.,!?;:\-–—"'()[\]]+$/g, "")
    .trim();

const BLOCKED_CREATOR_SET = new Set(rules.blockedCreators.map(normalizePhrase));
const LOW_EFFORT_SET = new Set(rules.lowEffortExact.map(normalizePhrase));

/** Returns the normalized blocked creator name if `raw` names a commercial game/studio or placeholder, else null */
export function blockedCreatorMatch(raw: string): string | null {
  const norm = normalizePhrase(raw);
  if (!norm) return null;
  return BLOCKED_CREATOR_SET.has(norm) ? norm : null;
}

/** True when a bug description or reproduction step is too short, a placeholder, or copied verbatim from `compareTo` */
export function isLowEffortText(raw: string, minChars: number, compareTo?: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < minChars) return true;
  const norm = normalizePhrase(trimmed);
  if (!norm || LOW_EFFORT_SET.has(norm)) return true;
  // Reject repeated single-character filler like "aaaaaaaaaaaaaaa"
  if (/^(.)\1+$/.test(norm.replace(/\s+/g, ""))) return true;
  if (compareTo && normalizePhrase(compareTo) === norm) return true;
  return false;
}

/** True when a content request with written permission includes a link or note explaining the creator's permission */
export function hasPermissionProof(notes: string): boolean {
  const trimmed = notes.trim();
  if (trimmed.length < rules.limits.proofMin) return false;
  return !LOW_EFFORT_SET.has(normalizePhrase(trimmed));
}

export type PermissionProblem = "license" | "permission" | "proof";

/**
 * Checks whether a car/track request's license, permission choice, and proof note actually allow redistribution.
 * - "The license allows it" requires one of the open CC licenses to be explicitly selected (never blank / "Other" / "Don't know").
 * - "The creator gave written permission" requires a link or note in `notes` documenting the creator's reply.
 * - "Not asked yet", "Don't know", or empty permission is always rejected, even if an open license was picked.
 */
export function evaluateContentPermission(
  license: string,
  permission: string,
  notes: string
): { ok: true } | { ok: false; problem: PermissionProblem } {
  const openLicense = (OPEN_LICENSES as readonly string[]).includes(license);
  if (permission === PERMISSION_WRITTEN) {
    if (!hasPermissionProof(notes)) return { ok: false, problem: "proof" };
    return { ok: true };
  }
  if (permission === PERMISSION_LICENSE) {
    if (!openLicense) return { ok: false, problem: "license" };
    return { ok: true };
  }
  return { ok: false, problem: "permission" };
}
