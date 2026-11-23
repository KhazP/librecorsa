/**
 * The three sign-in providers, by hand (no auth framework). Each answers with the provider's id of the player and
 * nothing else: no email, user name or avatar is asked for or kept.
 *   Discord  OAuth 2.0 code flow with PKCE, scope `identify`; the id from GET /users/@me
 *   Google   OpenID Connect code flow with PKCE, scope `openid` only, with a nonce; the id is the ID token's `sub`.
 *            The token comes straight from Google's token endpoint over TLS, so its claims are checked (issuer,
 *            audience, expiry, nonce) without checking its signature (OpenID Connect Core 3.1.3.7)
 *   Steam    OpenID 2.0, which needs no key: the answer is checked back with Steam (check_authentication), and the
 *            id is the SteamID64 at the end of the claimed id
 * Every outbound call goes through `deps.fetch`, and a failure is logged with its provider and status only: never a
 * code, a token or the player's id.
 */
import { base64url, sameSecret, sha256Bytes, type AccountsDeps, type OAuthClient } from "./deps";

export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
export const DISCORD_ME = "https://discord.com/api/users/@me";
export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const STEAM_LOGIN = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const STEAM_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const DISCORD_ID_RE = /^\d{5,25}$/;
const GOOGLE_SUB_RE = /^[A-Za-z0-9_-]{1,255}$/;
/** A provider's answer is read up to this size: theirs are a few hundred bytes */
const MAX_PROVIDER_BYTES = 64 * 1024;

/** The PKCE challenge of a verifier (S256) */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256Bytes(verifier));
}

export function discordAuthorizeUrl(client: OAuthClient, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    scope: "identify",
    state,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${DISCORD_AUTHORIZE}?${q}`;
}

export function googleAuthorizeUrl(client: OAuthClient, redirectUri: string, state: string, challenge: string, nonce: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    scope: "openid",
    state,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTHORIZE}?${q}`;
}

/** Where Steam sends the player back: the callback with the state, which Steam signs into its answer */
export const steamReturnTo = (callbackUrl: string, state: string): string => `${callbackUrl}?state=${encodeURIComponent(state)}`;

export function steamLoginUrl(realm: string, returnTo: string): string {
  const q = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    "openid.identity": IDENTIFIER_SELECT,
    "openid.claimed_id": IDENTIFIER_SELECT,
  });
  return `${STEAM_LOGIN}?${q}`;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text().catch(() => "");
  if (text.length > MAX_PROVIDER_BYTES) return null;
  try {
    const body = JSON.parse(text) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const logFail = (provider: string, step: string, status?: number) =>
  console.warn(JSON.stringify({ event: "sign_in_failed", provider, step, ...(status !== undefined ? { status } : {}) }));

/** The Discord user id behind an authorization code; null when Discord says no */
export async function discordSubject(deps: AccountsDeps, client: OAuthClient, code: string, redirectUri: string, verifier: string): Promise<string | null> {
  const token = await deps.fetch(DISCORD_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).toString(),
  });
  const tokenBody = await readJson(token);
  const access = tokenBody?.access_token;
  if (!token.ok || typeof access !== "string" || !access) {
    logFail("discord", "token", token.status);
    return null;
  }
  const me = await deps.fetch(DISCORD_ME, { headers: { Authorization: `Bearer ${access}`, Accept: "application/json" } });
  const user = await readJson(me);
  const id = user?.id;
  if (!me.ok || typeof id !== "string" || !DISCORD_ID_RE.test(id)) {
    logFail("discord", "user", me.status);
    return null;
  }
  return id;
}

/** The claims of a JWT, unchecked; null when it isn't one */
export function jwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof claims === "object" && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Google's `sub` behind an authorization code, once the ID token's claims check out; null otherwise */
export async function googleSubject(
  deps: AccountsDeps,
  client: OAuthClient,
  code: string,
  redirectUri: string,
  verifier: string,
  nonce: string,
): Promise<string | null> {
  const res = await deps.fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).toString(),
  });
  const body = await readJson(res);
  const idToken = body?.id_token;
  if (!res.ok || typeof idToken !== "string") {
    logFail("google", "token", res.status);
    return null;
  }
  const claims = jwtClaims(idToken);
  if (!claims) {
    logFail("google", "id_token");
    return null;
  }
  const aud = claims.aud;
  const audOk = aud === client.clientId || (Array.isArray(aud) && aud.includes(client.clientId) && claims.azp === client.clientId);
  const exp = claims.exp;
  const fresh = typeof exp === "number" && exp * 1000 > deps.now();
  const nonceOk = typeof claims.nonce === "string" && (await sameSecret(claims.nonce, nonce));
  const sub = claims.sub;
  if (!GOOGLE_ISSUERS.includes(String(claims.iss)) || !audOk || !fresh || !nonceOk || typeof sub !== "string" || !GOOGLE_SUB_RE.test(sub)) {
    logFail("google", "claims");
    return null;
  }
  return sub;
}

/** The fields of Steam's answer it must have signed for the ones read here to be trusted */
const STEAM_SIGNED = ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce"];

/**
 * The SteamID64 behind Steam's answer (the callback's query), once Steam confirms it signed it; "cancelled" when the
 * player backed out; null otherwise. `returnTo` is what was sent: the answer must name the same.
 */
export async function steamSubject(deps: AccountsDeps, query: URLSearchParams, returnTo: string): Promise<string | "cancelled" | null> {
  const mode = query.get("openid.mode");
  if (mode === "cancel") return "cancelled";
  const claimed = query.get("openid.claimed_id") ?? "";
  const id = STEAM_ID_RE.exec(claimed);
  const signed = new Set((query.get("openid.signed") ?? "").split(","));
  if (
    mode !== "id_res" ||
    query.get("openid.ns") !== OPENID_NS ||
    query.get("openid.op_endpoint") !== STEAM_LOGIN ||
    query.get("openid.return_to") !== returnTo ||
    query.get("openid.identity") !== claimed ||
    !id ||
    !STEAM_SIGNED.every((f) => signed.has(f))
  ) {
    logFail("steam", "answer");
    return null;
  }
  // Steam checks its own signature: every openid.* field as received, with the mode changed
  const check = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith("openid.")) check.append(k, k === "openid.mode" ? "check_authentication" : v);
  const res = await deps.fetch(STEAM_LOGIN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: check.toString(),
  });
  const text = await res.text().catch(() => "");
  const valid = res.ok && text.length < MAX_PROVIDER_BYTES && text.split("\n").some((line) => line.trim() === "is_valid:true");
  if (!valid) {
    logFail("steam", "check_authentication", res.status);
    return null;
  }
  return id[1];
}
