/**
 * The account endpoints (cloudflare/api/accounts), one typed call each, as api-types.ts describes them. Every call
 * sends the session cookie (`credentials: "include"`), gives up after 8 s like the other online calls (a ghost, up to
 * 2 MB, gets longer), and never throws: a network failure or an answer that isn't the API's own reads as a `Fail`
 * with a sentence for the player. A 401 always carries `signedOut: true`.
 */
import type {
  AccountAnswer,
  DeleteAnswer,
  DeleteRequest,
  DeviceJoinAnswer,
  DeviceJoinRequest,
  Fail,
  LinkCodeAnswer,
  LinkCodePreviewAnswer,
  MissingGhostsAnswer,
  OkAnswer,
  PasskeyOptionsAnswer,
  PasskeyOptionsRequest,
  PasskeyVerifyRequest,
  PutSaveAnswer,
  PutSaveRequest,
  SaveAnswer,
  SignInAnswer,
  SignInIntent,
  SignInProvider,
  SignOutAnswer,
} from "./api-types";

/** One call gives up after this long (ms): as long as every other read of the API is given */
export const ACCOUNT_TIMEOUT_MS = 8000;
/** A ghost going up or down (up to MAX_GHOST_BYTES) on a slow connection needs longer */
export const GHOST_TIMEOUT_MS = 30_000;
/** Browsers refuse a keepalive request whose body is over 64 KB: a larger save goes up as a plain request */
const KEEPALIVE_MAX_BYTES = 60_000;

export const UNREACHABLE = "The server could not be reached. Check the connection and try again.";
export const SIGNED_OUT = "You are signed out on this device.";
const SERVER_PROBLEM = "The server had a problem. Try again in a moment.";
const TOO_MANY = "Too many tries. Wait a minute and try again.";
const UNAVAILABLE = "Accounts are not available right now.";

export interface AccountApiEnv {
  /** The API's base: "/api", or a full URL in development */
  base: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export interface AccountApi {
  /** Where the browser goes to sign in with a provider (the server sends it on to the provider and back) */
  signInUrl(provider: SignInProvider, intent: SignInIntent, returnTo: string): string;
  account(): Promise<AccountAnswer>;
  joinDevice(req: DeviceJoinRequest): Promise<DeviceJoinAnswer>;
  signOut(): Promise<SignOutAnswer>;
  passkeyOptions(req: PasskeyOptionsRequest): Promise<PasskeyOptionsAnswer>;
  passkeyVerify(req: PasskeyVerifyRequest): Promise<SignInAnswer>;
  createLinkCode(): Promise<LinkCodeAnswer>;
  previewLinkCode(code: string): Promise<LinkCodePreviewAnswer>;
  redeemLinkCode(code: string): Promise<SignInAnswer>;
  removeSession(id: string): Promise<OkAnswer>;
  removeKey(id: string): Promise<OkAnswer>;
  removePasskey(id: string): Promise<OkAnswer>;
  removeIdentity(provider: SignInProvider): Promise<OkAnswer>;
  deleteAccount(req: DeleteRequest): Promise<DeleteAnswer>;
  getSave(): Promise<SaveAnswer>;
  /** `keepalive`: the page is going away, the request should outlive it (best effort) */
  putSave(req: PutSaveRequest, opts?: { keepalive?: boolean }): Promise<PutSaveAnswer>;
  missingGhosts(shas: string[]): Promise<MissingGhostsAnswer>;
  putGhost(sha: string, text: string): Promise<GhostPutAnswer>;
  /** The ghost's JSON text, or the status it couldn't be read with (404: the cloud doesn't have it) */
  getGhost(sha: string): Promise<GhostGetAnswer>;
}

/**
 * A ghost's transfer, with the HTTP status of a failure (0: no answer, a timeout), so the sync can tell one worth
 * trying again (429, a timeout, a server problem) from one that never will be (too big, the account's limit)
 */
export type GhostPutAnswer = { ok: true } | (Fail & { status: number });
export type GhostGetAnswer = { ok: true; text: string } | { ok: false; status: number };

const isAnswer = (v: unknown): v is { ok: boolean } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { ok?: unknown }).ok === "boolean";

/** A `Fail` for an answer that isn't the API's own JSON: by its status */
function failFor(status: number): Fail {
  if (status === 401) return { ok: false, error: SIGNED_OUT, signedOut: true };
  if (status === 404) return { ok: false, error: UNAVAILABLE };
  if (status === 429) return { ok: false, error: TOO_MANY };
  return { ok: false, error: SERVER_PROBLEM };
}

export function createAccountApi(env: AccountApiEnv): AccountApi {
  const url = (path: string) => `${env.base}${path}`;

  /**
   * fetch() and the read of its answer, both within the timeout; null on a network error or a timeout. The answer is
   * read inside the window too: a body that stalls halfway is a timeout like any other
   */
  async function send<T>(path: string, init: RequestInit, readBody: (res: Response) => Promise<T>, timeoutMs = ACCOUNT_TIMEOUT_MS): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await env.fetch(url(path), { ...init, credentials: "include", cache: "no-store", signal: controller.signal });
      return await readBody(res);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The status and the JSON answer (null when the body isn't JSON) */
  const readJson = async (res: Response) => ({ status: res.status, json: (await res.json().catch(() => null)) as unknown });

  /** The API's answer as it said it, or a `Fail` by the status when it isn't one of its answers */
  function answerOf<T extends { ok: boolean }>(got: { status: number; json: unknown } | null): T | Fail {
    if (!got) return { ok: false, error: UNREACHABLE };
    const { status, json } = got;
    if (!isAnswer(json)) return failFor(status);
    if (json.ok) return json as T;
    const fail = json as Fail;
    const error = typeof fail.error === "string" && fail.error ? fail.error : failFor(status).error;
    return status === 401 || fail.signedOut ? { ...fail, error, signedOut: true } : { ...fail, error };
  }

  async function call<T extends { ok: boolean }>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    opts: { keepalive?: boolean } = {}
  ): Promise<T | Fail> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const keepalive = opts.keepalive === true && (text?.length ?? 0) <= KEEPALIVE_MAX_BYTES;
    const init: RequestInit = {
      method,
      ...(text === undefined ? {} : { body: text, headers: { "content-type": "application/json" } }),
      ...(keepalive ? { keepalive: true } : {}),
    };
    return answerOf<T>(await send(path, init, readJson));
  }

  const post = <T extends { ok: boolean }>(path: string, body: unknown = {}) => call<T>("POST", path, body);

  return {
    signInUrl(provider, intent, returnTo) {
      const query = new URLSearchParams({ intent, return: returnTo });
      return url(`/auth/start/${provider}?${query.toString()}`);
    },
    account: () => call<AccountAnswer>("GET", "/account"),
    joinDevice: (req) => post<DeviceJoinAnswer>("/account/device", req),
    signOut: () => post<SignOutAnswer>("/auth/signout"),
    passkeyOptions: (req) => post<PasskeyOptionsAnswer>("/auth/passkey/options", req),
    passkeyVerify: (req) => post<SignInAnswer>("/auth/passkey/verify", req),
    createLinkCode: () => post<LinkCodeAnswer>("/account/link-code"),
    previewLinkCode: (code) => post<LinkCodePreviewAnswer>("/auth/link-code/preview", { code }),
    redeemLinkCode: (code) => post<SignInAnswer>("/auth/link-code/redeem", { code }),
    removeSession: (id) => post<OkAnswer>("/account/sessions/remove", { id }),
    removeKey: (id) => post<OkAnswer>("/account/keys/remove", { id }),
    removePasskey: (id) => post<OkAnswer>("/account/passkeys/remove", { id }),
    removeIdentity: (provider) => post<OkAnswer>("/account/identities/remove", { provider }),
    deleteAccount: (req) => post<DeleteAnswer>("/account/delete", req),
    getSave: () => call<SaveAnswer>("GET", "/account/save"),
    putSave: (req, opts) => call<PutSaveAnswer>("PUT", "/account/save", req, opts),
    missingGhosts: (shas) => post<MissingGhostsAnswer>("/account/ghosts/missing", { shas }),
    async putGhost(sha, text) {
      const init: RequestInit = { method: "PUT", body: text, headers: { "content-type": "application/json" } };
      const got = await send(`/account/ghosts/${sha}`, init, readJson, GHOST_TIMEOUT_MS);
      const ans = answerOf<{ ok: true }>(got);
      return ans.ok ? ans : { ...ans, status: got?.status ?? 0 };
    },
    async getGhost(sha) {
      const got = await send(`/account/ghosts/${sha}`, { method: "GET" }, async (res) => ({ status: res.status, text: res.ok ? await res.text() : null }), GHOST_TIMEOUT_MS);
      return got && got.text !== null ? { ok: true, text: got.text } : { ok: false, status: got?.status ?? 0 };
    },
  };
}
