/**
 * The HTTP side of the account routes: one request's context, its cookies, and the answers. Every answer says
 * no-store, and a development origin (DEV_ORIGINS) may send credentials: the game on localhost:3000 talks to
 * `wrangler dev` on another port of the same host, so its cookies go along.
 */
import type { Fail } from "../../../src/lib/account/api-types";
import type { AccountsDeps } from "./deps";
import type { Session } from "./sessions";

export interface Ctx {
  deps: AccountsDeps;
  request: Request;
  url: URL;
  /** The request's Origin when it may call the API (the site's own or DEV_ORIGINS); null when it sent none */
  origin: string | null;
  /** On https the cookies are `__Host-` and Secure; plain http is local development */
  secure: boolean;
  cookies: Map<string, string>;
  /** Set-Cookie headers for the answer */
  setCookies: string[];
  /** The session, once read (sessions.ts readSession); undefined before */
  session?: Session | null;
}

export function contextOf(deps: AccountsDeps, request: Request, url: URL, origin: string | null): Ctx {
  return { deps, request, url, origin, secure: url.protocol === "https:", cookies: parseCookies(request.headers.get("Cookie")), setCookies: [] };
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    // The first wins: a browser sends the most specific cookie of a name first
    if (name && !out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** The session cookie and the short one that binds a provider sign-in to the browser that started it */
export type CookieKind = "session" | "auth";
const COOKIE_NAMES: Record<CookieKind, { secure: string; plain: string }> = {
  session: { secure: "__Host-lc_session", plain: "lc_session" },
  auth: { secure: "__Host-lc_auth", plain: "lc_auth" },
};

export const cookieName = (ctx: Ctx, kind: CookieKind): string => (ctx.secure ? COOKIE_NAMES[kind].secure : COOKIE_NAMES[kind].plain);

export const readCookie = (ctx: Ctx, kind: CookieKind): string | null => ctx.cookies.get(cookieName(ctx, kind)) ?? null;

/** Sets (or with `maxAgeS` 0, clears) a cookie on the answer: HttpOnly, SameSite=Lax, the whole site */
export function setCookie(ctx: Ctx, kind: CookieKind, value: string, maxAgeS: number): void {
  const name = cookieName(ctx, kind);
  // One header per cookie name: a later set in the same request replaces an earlier one
  ctx.setCookies = ctx.setCookies.filter((c) => !c.startsWith(`${name}=`));
  ctx.setCookies.push(`${name}=${value}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeS))}; HttpOnly; SameSite=Lax${ctx.secure ? "; Secure" : ""}`);
}

export const clearCookie = (ctx: Ctx, kind: CookieKind): void => setCookie(ctx, kind, "", 0);

function headersOf(ctx: Ctx): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  if (ctx.origin) {
    headers.set("Access-Control-Allow-Origin", ctx.origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "86400");
    if (ctx.origin !== ctx.url.origin) headers.set("Access-Control-Allow-Credentials", "true");
  }
  for (const c of ctx.setCookies) headers.append("Set-Cookie", c);
  return headers;
}

/** The headers a preflight of an account route gets */
export const preflightHeaders = (ctx: Ctx): Headers => headersOf(ctx);

export function answer(ctx: Ctx, body: unknown, status = 200): Response {
  const headers = headersOf(ctx);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export const failWith = (ctx: Ctx, error: string, status = 400, extra: Partial<Fail> & Record<string, unknown> = {}): Response =>
  answer(ctx, { ok: false, error, ...extra }, status);

export const signedOut = (ctx: Ctx): Response => failWith(ctx, "Sign in first", 401, { signedOut: true });

export function text(ctx: Ctx, body: string, contentType: string): Response {
  const headers = headersOf(ctx);
  headers.set("Content-Type", contentType);
  return new Response(body, { status: 200, headers });
}

export function redirect(ctx: Ctx, location: string): Response {
  const headers = headersOf(ctx);
  headers.set("Location", location);
  // A referrer from the provider's page back to ours would carry nothing useful, and from ours to theirs the path only
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 302, headers });
}

/** A request body of at most `maxBytes`; null when it is larger */
export async function bodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxBytes) return null;
  // A body sent without a length (chunked) is measured once read
  const buffer = await request.arrayBuffer();
  return buffer.byteLength > maxBytes ? null : new Uint8Array(buffer);
}

/** A request body of at most `maxBytes`, as text; null when it is larger */
export async function bodyText(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await bodyBytes(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false; error: string; status: number };

/** A JSON object body of at most `maxBytes`, or what is wrong with it */
export async function jsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  const raw = await bodyText(request, maxBytes);
  if (raw === null) return { ok: false, error: "Body is too large", status: 413 };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    // Falls through to the same answer as a body that isn't an object
  }
  return { ok: false, error: "Body is not valid JSON", status: 400 };
}

/** True when this address is past `limit` (a Workers rate-limit binding); without the binding nothing is limited */
export async function overLimit(limit: AccountsDeps["authLimit"], request: Request, bucket = ""): Promise<boolean> {
  if (!limit) return false;
  const { success } = await limit.limit({ key: `${bucket}${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
  return !success;
}

/** A short label a device gave itself: printable, single spaces, at most 64 characters */
export function cleanLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .trim();
}
