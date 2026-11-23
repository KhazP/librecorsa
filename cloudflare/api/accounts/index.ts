/**
 * Player accounts: optional sign-in (Discord, Google, Steam, passkeys), names kept on the account, and a save the
 * account's devices share. The wire format is src/lib/account/api-types.ts; the routes, all under /api/auth and
 * /api/account:
 *   GET  /api/auth/start/<provider>, /api/auth/callback/<provider>    oauth.ts
 *   POST /api/auth/passkey/options, /api/auth/passkey/verify          passkeys.ts
 *   POST /api/auth/link-code/preview, /api/auth/link-code/redeem      link-codes.ts
 *   POST /api/auth/signout
 *   GET  /api/account                                                 the account page
 *   POST /api/account/device, link-code, sessions|keys|passkeys|identities/remove, delete   devices.ts, delete.ts
 *   GET/PUT /api/account/save, POST /api/account/ghosts/missing, GET/PUT /api/account/ghosts/<sha>   saves.ts
 *
 * With ONLINE_ACCOUNTS off (or a binding missing) every one of them answers 404 "Accounts are off". Every request that
 * changes something must carry an Origin header the API allows (the site's own, or DEV_ORIGINS): a form or a link on
 * another site can't sign anyone in or out, and a request with none is refused too. Every answer says no-store.
 */
import { ACCOUNT_PROVIDERS, SHA256_HEX_RE, type AccountProvider, type SignInProvider } from "../../../src/lib/account/api-types";
import type { Env } from "../types";
import { accountsDeps, type AccountsDeps } from "./deps";
import { deleteAccount } from "./delete";
import { joinDevice, removeIdentity, removeKey, removePasskey, removeSession } from "./devices";
import { answer, contextOf, failWith, overLimit, preflightHeaders, redirect, signedOut, type Ctx } from "./http";
import { createLinkCode, previewLinkCode, redeemLinkCode } from "./link-codes";
import { finishSignIn, providerOffered, startSignIn } from "./oauth";
import { passkeyOptions, passkeyVerify } from "./passkeys";
import { getGhost, getSave, missingGhosts, putGhost, putSave } from "./saves";
import { endSession, readSession, type Session } from "./sessions";
import { accountInfo } from "./store";

export type { AccountsDeps } from "./deps";

const on = (value: string | undefined): boolean => value === "on";

/** Accounts are switched on and have what they run on */
export const accountsOn = (env: Env): boolean => on(env.ONLINE_ACCOUNTS) && Boolean(env.ACCOUNTS_DB && env.BOARD_DB && env.GHOSTS);

/** The ways in this server offers now: Discord and Google once their secrets are set, Steam and passkeys always */
export function accountProviders(env: Env): AccountProvider[] {
  const deps = accountsOn(env) ? accountsDeps(env) : null;
  if (!deps) return [];
  return ACCOUNT_PROVIDERS.filter((p) => p === "passkey" || providerOffered(deps, p));
}

/** True for a path the account routes own */
export const isAccountsPath = (path: string): boolean =>
  path === "/api/auth" || path.startsWith("/api/auth/") || path === "/api/account" || path.startsWith("/api/account/");

const PROVIDER_RE = /^\/api\/auth\/(start|callback)\/(discord|google|steam)$/;
const GHOST_RE = /^\/api\/account\/ghosts\/([^/]+)$/;

/**
 * The answer to a request under /api/auth or /api/account; null for a path there that isn't a route (the API's plain
 * 404). `origin` is the request's allowed Origin (index.ts), null when it sent none.
 */
export async function handleAccounts(request: Request, env: Env, url: URL, path: string, origin: string | null, inject: Partial<AccountsDeps> = {}): Promise<Response | null> {
  const deps = accountsOn(env) ? accountsDeps(env, inject) : null;
  if (!deps) {
    return new Response(JSON.stringify({ ok: false, error: "Accounts are off" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Origin" },
    });
  }
  const ctx = contextOf(deps, request, url, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: preflightHeaders(ctx) });

  const provider = PROVIDER_RE.exec(path);
  if (provider && request.method === "GET") {
    try {
      return provider[1] === "start" ? await startSignIn(ctx, provider[2] as SignInProvider) : await finishSignIn(ctx, provider[2] as SignInProvider);
    } catch (err) {
      // The message only: never the request, which carries the provider's code
      console.error("sign-in failed:", err instanceof Error ? err.message : "error");
      return redirect(ctx, "/play#lc-account=failed");
    }
  }

  // Anything that changes something comes from the site itself (or a development origin), never from nowhere
  if (request.method !== "GET" && request.method !== "HEAD" && origin === null) return failWith(ctx, "Origin not allowed", 403);

  try {
    return await route(ctx, path);
  } catch (err) {
    // The message only: never a request, a cookie or a token
    console.error("accounts failed:", err instanceof Error ? err.message : "error");
    return failWith(ctx, "The account server had a problem. Try again in a moment", 500);
  }
}

async function route(ctx: Ctx, path: string): Promise<Response | null> {
  const method = ctx.request.method;
  const post = method === "POST";

  // Signed out or in
  if (path === "/api/auth/passkey/options" && post) return passkeyOptions(ctx);
  if (path === "/api/auth/passkey/verify" && post) return passkeyVerify(ctx);
  if (path === "/api/auth/link-code/preview" && post) return previewLinkCode(ctx);
  if (path === "/api/auth/link-code/redeem" && post) return redeemLinkCode(ctx);
  if (path === "/api/auth/signout" && post) {
    const session = await readSession(ctx);
    if (session) await endSession(ctx, session);
    return answer(ctx, { ok: true });
  }

  // Signed in
  const routes: Record<string, (ctx: Ctx, session: Session) => Promise<Response>> = {
    "GET /api/account": accountAnswer,
    "POST /api/account/device": joinDevice,
    "POST /api/account/link-code": createLinkCode,
    "POST /api/account/sessions/remove": removeSession,
    "POST /api/account/keys/remove": removeKey,
    "POST /api/account/passkeys/remove": removePasskey,
    "POST /api/account/identities/remove": removeIdentity,
    "POST /api/account/delete": deleteAccount,
  };
  const handler = routes[`${method} ${path}`];
  if (handler) {
    const session = await readSession(ctx);
    return session ? handler(ctx, session) : signedOut(ctx);
  }

  // The cloud save: its own limit per address, and another of the same size for the ghosts, so a first sync's many
  // ghosts don't hold the save itself up
  if (path === "/api/account/save" && (method === "GET" || method === "PUT")) {
    const session = await readSession(ctx);
    if (!session) return signedOut(ctx);
    if (await overLimit(ctx.deps.saveLimit, ctx.request)) return failWith(ctx, "Too many syncs, wait a minute", 429);
    return method === "GET" ? getSave(ctx, session) : putSave(ctx, session);
  }
  const ghost = GHOST_RE.exec(path);
  if ((path === "/api/account/ghosts/missing" && post) || (ghost && ghost[1] !== "missing" && (method === "GET" || method === "PUT"))) {
    const session = await readSession(ctx);
    if (!session) return signedOut(ctx);
    if (await overLimit(ctx.deps.saveLimit, ctx.request, "ghosts:")) return failWith(ctx, "Too many syncs, wait a minute", 429);
    if (!ghost || ghost[1] === "missing") return missingGhosts(ctx, session);
    if (!SHA256_HEX_RE.test(ghost[1])) return failWith(ctx, "Not found", 404);
    return method === "GET" ? getGhost(ctx, session, ghost[1]) : putGhost(ctx, session, ghost[1]);
  }
  return null;
}

async function accountAnswer(ctx: Ctx, session: Session): Promise<Response> {
  const account = await accountInfo(ctx.deps, session);
  if (!account) return signedOut(ctx);
  return answer(ctx, { ok: true, account, thisDevice: { joined: session.keyHash !== null } });
}
