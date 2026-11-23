/**
 * Sign-in through a provider's own page:
 *   GET /api/auth/start/<provider>?intent=signin|link&return=<path>   302 to the provider
 *   GET /api/auth/callback/<provider>?...                             302 to <return>#lc-account=<AuthResult>
 *
 * A start keeps the sign-in in `auth_states` (one use, 10 minutes) under the SHA-256 of a random `state`, and puts the
 * same `state` in a short cookie on this browser. The callback needs both: a provider's answer that reaches another
 * browser (a link someone was sent to sign them in to the sender's account) finds no cookie there and goes nowhere.
 * Discord and Google also get a PKCE verifier, and Google a nonce, kept with the state and never sent to the browser.
 */
import { AUTH_RESULT_PARAM, type AuthResult, type SignInIntent, type SignInProvider } from "../../../src/lib/account/api-types";
import { randomToken, sameSecret, sha256Hex, type AccountsDeps } from "./deps";
import { clearCookie, overLimit, readCookie, redirect, setCookie, type Ctx } from "./http";
import { discordAuthorizeUrl, discordSubject, googleAuthorizeUrl, googleSubject, pkceChallenge, steamLoginUrl, steamReturnTo, steamSubject } from "./providers";
import { AUTH_STATE_TTL_MS, readSession, sweep } from "./sessions";
import { useIdentity } from "./signin";

/** A sign-in the server can offer now: Steam always, Discord and Google once both of their secrets are set */
export function providerOffered(deps: AccountsDeps, provider: SignInProvider): boolean {
  if (provider === "steam") return true;
  return (provider === "discord" ? deps.discord : deps.google) !== null;
}

const RETURN_RE = /^\/[A-Za-z0-9/_-]*$/;

/** A path on this site to come back to ("/play", "/account"); anything else is "/play" */
export function safeReturn(raw: string | null): string {
  return raw !== null && RETURN_RE.test(raw) && !raw.startsWith("//") ? raw : "/play";
}

/**
 * The origin to come back to: this site (a path alone), or in development the game's own origin when it is one of
 * DEV_ORIGINS and the start came from it (its Referer)
 */
function returnOrigin(ctx: Ctx): string {
  const referer = ctx.request.headers.get("Referer");
  if (!referer) return "";
  try {
    const origin = new URL(referer).origin;
    return origin !== ctx.url.origin && ctx.deps.devOrigins.includes(origin) ? origin : "";
  } catch {
    return "";
  }
}

const landing = (returnTo: string, result: AuthResult): string => `${returnTo}#${AUTH_RESULT_PARAM}=${result}`;

export const callbackUrl = (ctx: Ctx, provider: SignInProvider): string => `${ctx.url.origin}/api/auth/callback/${provider}`;

export async function startSignIn(ctx: Ctx, provider: SignInProvider): Promise<Response> {
  const { deps, url } = ctx;
  const intent: SignInIntent = url.searchParams.get("intent") === "link" ? "link" : "signin";
  const returnTo = returnOrigin(ctx) + safeReturn(url.searchParams.get("return"));
  const back = (result: AuthResult) => redirect(ctx, landing(returnTo, result));
  if (!providerOffered(deps, provider)) return back("failed");
  if (await overLimit(deps.authLimit, ctx.request)) return back("failed");
  let accountId: string | null = null;
  if (intent === "link") {
    const session = await readSession(ctx);
    if (!session) return back("failed");
    accountId = session.accountId;
  }
  await sweep(deps);

  const state = randomToken(deps, 32);
  const verifier = provider === "steam" ? null : randomToken(deps, 32);
  const nonce = provider === "google" ? randomToken(deps, 16) : null;
  await deps.db
    .prepare(
      "INSERT INTO auth_states (id, kind, provider, intent, account_id, return_to, verifier, challenge, nonce, created_at) VALUES (?, 'oauth', ?, ?, ?, ?, ?, NULL, ?, ?)",
    )
    .bind(await sha256Hex(state), provider, intent, accountId, returnTo, verifier, nonce, deps.now())
    .run();
  setCookie(ctx, "auth", state, AUTH_STATE_TTL_MS / 1000);

  const callback = callbackUrl(ctx, provider);
  if (provider === "steam") return redirect(ctx, steamLoginUrl(url.origin, steamReturnTo(callback, state)));
  const challenge = await pkceChallenge(verifier as string);
  if (provider === "discord") return redirect(ctx, discordAuthorizeUrl(deps.discord!, callback, state, challenge));
  return redirect(ctx, googleAuthorizeUrl(deps.google!, callback, state, challenge, nonce as string));
}

interface AuthStateRow {
  id: string;
  kind: string;
  provider: string;
  intent: string;
  account_id: string | null;
  return_to: string;
  verifier: string | null;
  nonce: string | null;
  created_at: number;
}

export async function finishSignIn(ctx: Ctx, provider: SignInProvider): Promise<Response> {
  const { deps, url } = ctx;
  // The binding cookie has done its job, whatever comes next
  clearCookie(ctx, "auth");
  const state = url.searchParams.get("state") ?? "";
  const bound = readCookie(ctx, "auth");
  const nowhere = () => redirect(ctx, landing("/play", "failed"));
  if (!state || state.length > 128 || !bound || !(await sameSecret(state, bound))) return nowhere();
  // Used once: taken out as it is read
  const row = await deps.db.prepare("DELETE FROM auth_states WHERE id = ? AND kind = 'oauth' RETURNING *").bind(await sha256Hex(state)).first<AuthStateRow>();
  if (!row || row.provider !== provider) return nowhere();
  const back = (result: AuthResult) => redirect(ctx, landing(row.return_to, result));
  if (deps.now() - row.created_at > AUTH_STATE_TTL_MS) return back("failed");

  let subject: string | null;
  try {
    if (provider === "steam") {
      const seen = await steamSubject(deps, url.searchParams, steamReturnTo(callbackUrl(ctx, provider), state));
      if (seen === "cancelled") return back("cancelled");
      subject = seen;
    } else {
      const error = url.searchParams.get("error");
      if (error !== null) return back(error === "access_denied" ? "cancelled" : "failed");
      const code = url.searchParams.get("code") ?? "";
      const client = provider === "discord" ? deps.discord : deps.google;
      if (!code || code.length > 2048 || !row.verifier || !client) return back("failed");
      subject =
        provider === "discord"
          ? await discordSubject(deps, client, code, callbackUrl(ctx, provider), row.verifier)
          : await googleSubject(deps, client, code, callbackUrl(ctx, provider), row.verifier, row.nonce ?? "");
    }
  } catch (err) {
    // The provider out of reach: its message only, never the request
    console.warn(JSON.stringify({ event: "sign_in_failed", provider, step: "fetch", message: err instanceof Error ? err.message : "error" }));
    return back("failed");
  }
  if (!subject) return back("failed");
  return back(await useIdentity(ctx, provider, subject, row.intent === "link" ? "link" : "signin", row.account_id));
}
