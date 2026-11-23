/**
 * Player accounts: the wire format between the game (src/lib/account) and the Worker (cloudflare/api/accounts).
 * Both sides import this file, so a change here is a change to both.
 *
 * Accounts are optional. Playing and posting laps without one works as before: each device's driver key
 * (src/lib/net/driver-key.ts) claims its names. An account gathers the names of every device key that joins it, so any
 * of them may post under any of the account's names, and keeps one save that the devices share.
 *
 * Sign-in is Discord (`identify`), Google (`openid` only), Steam (OpenID 2.0) or a passkey. The server keeps the
 * provider's account id and nothing else: no email, no user name, no avatar.
 *
 * Every JSON answer is `{ ok: true, ... }` or `{ ok: false, error }` (`Fail`), where `error` is a sentence for the
 * player. A request that needs a session and has none answers 401 with `signedOut: true`.
 */

/** Sign-ins that go through the provider's own page (a redirect there and back) */
export type SignInProvider = "discord" | "google" | "steam";
export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ["discord", "google", "steam"];
/** Every way into an account */
export type AccountProvider = SignInProvider | "passkey";
export const ACCOUNT_PROVIDERS: readonly AccountProvider[] = ["discord", "google", "steam", "passkey"];

export const PROVIDER_LABELS: Record<AccountProvider, string> = {
  discord: "Discord",
  google: "Google",
  steam: "Steam",
  passkey: "Passkey",
};

export interface Fail {
  ok: false;
  error: string;
  /** No session, or it ended: the device is signed out */
  signedOut?: true;
}

// ---------------------------------------------------------------------------------------------------------------
// Sign-in

/**
 * GET /api/auth/start/<provider>?intent=signin|link&return=<path>
 *   302 to the provider. `intent=link` (signed in) adds that sign-in to this account; if the sign-in already holds
 *   another account, that account is folded into this one (both were proven in this browser). `return` is a path on
 *   this site ("/play", "/account"); anything else is taken as "/play".
 * GET /api/auth/callback/<provider>?...
 *   302 back to `return` with `#lc-account=<AuthResult>` (AUTH_RESULT_PARAM). On a sign-in it sets the session cookie.
 */
export type SignInIntent = "signin" | "link";
export const AUTH_RESULT_PARAM = "lc-account";
export type AuthResult =
  /** Signed in to an account that already existed */
  | "signed-in"
  /** Signed in to a new account made just now */
  | "created"
  /** The sign-in (or passkey) was added to the signed-in account */
  | "linked"
  /** The sign-in held another account: that account was folded into the signed-in one */
  | "merged"
  /** The sign-in was on this account already */
  | "already-linked"
  /** The player backed out on the provider's page */
  | "cancelled"
  /** Anything else: the try took too long, the provider said no, the server had a problem */
  | "failed";
export const AUTH_RESULTS: readonly AuthResult[] = ["signed-in", "created", "linked", "merged", "already-linked", "cancelled", "failed"];

/** Answer of every call that signs this browser in or changes its sign-ins without a redirect */
export type SignInAnswer = { ok: true; result: AuthResult } | Fail;

/** POST /api/auth/signout -> { ok: true } (the session ends and its cookie is cleared) */
export type SignOutAnswer = { ok: true } | Fail;

/**
 * Passkeys (WebAuthn, rpID = the site's host name):
 *   POST /api/auth/passkey/options { mode, displayName? } -> PasskeyOptionsAnswer
 *   POST /api/auth/passkey/verify  { challengeId, response } -> SignInAnswer
 * `mode`:
 *   signin  sign in with a passkey (a discoverable credential; switches account when signed in to another)
 *   create  make a new account with a passkey as its only sign-in (signed out)
 *   add     add a passkey to the signed-in account
 *   link    prove a passkey of another account while signed in: that account folds into this one
 * `displayName` is only written to the authenticator (what the passkey is called on the device), never stored.
 * `options` is PublicKeyCredentialCreationOptionsJSON (create, add) or PublicKeyCredentialRequestOptionsJSON (signin,
 * link), and `response` the browser's RegistrationResponseJSON / AuthenticationResponseJSON (@simplewebauthn).
 */
export type PasskeyMode = "signin" | "create" | "add" | "link";
export interface PasskeyOptionsRequest {
  mode: PasskeyMode;
  displayName?: string;
}
export type PasskeyOptionsAnswer = { ok: true; challengeId: string; options: unknown } | Fail;
export interface PasskeyVerifyRequest {
  challengeId: string;
  response: unknown;
}

/**
 * Link codes: a signed-in device shows a code, another device types it and is signed in to the same account. This is
 * also how the desktop app and an iPhone home-screen app sign in. Codes are 8 letters and digits (no 0/O/1/I/L),
 * shown as "ABCD-EFGH"; dashes, spaces and case are ignored. One use, 10 minutes.
 *   POST /api/account/link-code -> LinkCodeAnswer (signed in)
 *   POST /api/auth/link-code/preview { code } -> LinkCodePreviewAnswer (whose account it joins; the code stays valid)
 *   POST /api/auth/link-code/redeem  { code } -> SignInAnswer (signs this browser in; the code is used up)
 */
export const LINK_CODE_TTL_MS = 10 * 60_000;
export const LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export type LinkCodeAnswer = { ok: true; code: string; expiresAt: number } | Fail;
export type LinkCodePreviewAnswer = { ok: true; driverName: string | null; providers: AccountProvider[] } | Fail;
export interface LinkCodeRequest {
  code: string;
}

/** "abcd efgh" / "ABCD-EFGH" -> "ABCDEFGH"; null when it can't be a code */
export function normaliseLinkCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (code.length !== 8) return null;
  for (const ch of code) if (!LINK_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** "ABCDEFGH" -> "ABCD-EFGH" */
export const formatLinkCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

// ---------------------------------------------------------------------------------------------------------------
// The account

/** A driver name the account holds */
export interface AccountName {
  /** The name's claim key (lower case, single spaces: board.ts driverNameKey) */
  nameKey: string;
  /** As last written on a board lap; the claim key when it has no laps */
  displayName: string;
  /** Last upload under it (ms) */
  lastSeen: number;
}

export interface AccountIdentity {
  provider: SignInProvider;
  linkedAt: number;
  lastUsedAt: number | null;
}

export interface AccountPasskey {
  /** Its credential id (base64url) */
  id: string;
  /** "Passkey added 23 Nov 2026" unless renamed; never anything from the authenticator */
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** A signed-in browser or app */
export interface AccountSession {
  /** Short public id (not the token) */
  id: string;
  /** What the device said it was when it joined ("Chrome on macOS", "LibreCorsa app on Windows") */
  label: string;
  createdAt: number;
  lastSeenAt: number;
  /** The session making this request */
  current: boolean;
}

/** A driver key on the account: any of them may post under any of the account's names */
export interface AccountKey {
  /** The first 12 hex digits of the key's SHA-256 */
  id: string;
  label: string;
  addedAt: number;
  lastUsedAt: number | null;
  /** The key of the session making this request */
  current: boolean;
}

export interface AccountInfo {
  id: string;
  createdAt: number;
  /** The name shown for the account: the most recently used driver name on it; null before it has any */
  driverName: string | null;
  names: AccountName[];
  identities: AccountIdentity[];
  passkeys: AccountPasskey[];
  sessions: AccountSession[];
  keys: AccountKey[];
  /** The cloud save, if one was ever written */
  save: { rev: number; updatedAt: number; bytes: number } | null;
  /** Saves of accounts folded into this one, waiting for a device to combine them (GET /api/account/save `pending`) */
  pendingMerges: number;
}

/**
 * GET /api/account -> AccountAnswer (401 signedOut when not signed in).
 * `thisDevice.joined`: this session has registered its driver key (POST /api/account/device). Until it has, the game
 * asks "Join the account of <driverName>?" before anything of this device's goes up.
 */
export type AccountAnswer = { ok: true; account: AccountInfo; thisDevice: { joined: boolean } } | Fail;

/**
 * POST /api/account/device { driverKey, label } -> DeviceJoinAnswer
 * Registers this device's driver key with the account and attaches every name that key holds. A name already on
 * another account stays there (`elsewhere`); signing in to that account here with intent=link folds the two together.
 * `keyElsewhere`: the key itself is on another account, so it stays there and its names with it.
 */
export interface DeviceJoinRequest {
  driverKey: string;
  label: string;
}
export type DeviceJoinAnswer = { ok: true; attached: string[]; elsewhere: string[]; keyElsewhere: boolean } | Fail;

/**
 * Removing things (signed in), each -> { ok: true } | Fail:
 *   POST /api/account/sessions/remove   { id }        signs that device out
 *   POST /api/account/keys/remove       { id }        that driver key no longer posts under the account's names
 *   POST /api/account/passkeys/remove   { id }
 *   POST /api/account/identities/remove { provider }
 * The last way into an account (sign-ins plus passkeys) can't be removed: delete the account instead.
 */
export type OkAnswer = { ok: true } | Fail;

/**
 * POST /api/account/delete { removeLaps, confirm: "delete" } -> DeleteAnswer
 * Deletes the account, its sign-ins, passkeys, sessions and cloud save. Its names leave the account: with removeLaps,
 * their laps, race results and badges come off the boards and the names are free; without it they stay as names of
 * this device's driver key, and lapse after six months without a lap as any other.
 */
export interface DeleteRequest {
  removeLaps: boolean;
  confirm: "delete";
}
export type DeleteAnswer = { ok: true; removedLaps: number } | Fail;

// ---------------------------------------------------------------------------------------------------------------
// The cloud save

/** A value and when it last changed (ms since the epoch, by the device that changed it); 0 = not known */
export interface Stamped<T> {
  value: T;
  t: number;
}

/** A personal best in the cloud: its times here, the recording (LapRecording JSON) stored apart by its SHA-256 */
export interface CloudBestLap {
  trackId: string;
  vehicle: string;
  lapTimeMs: number;
  recordedAt: number;
  /** SHA-256 (hex) of the recording's JSON text, as PUT to /api/account/ghosts/<sha> */
  ghost: string;
}

export const SAVE_DOC_VERSION = 1;

/**
 * Everything of a player's that follows them between devices (src/lib/account/save-model.ts decides what goes in).
 * Controls, graphics, field of view, HUD, volumes and the driver key stay on each device.
 */
export interface SaveDoc {
  v: typeof SAVE_DOC_VERSION;
  /** When it was written, by the writing device's clock */
  savedAt: number;
  /** Which device wrote it (its session label) */
  savedBy: string;
  /** Synced localStorage entries: the raw stored string by key */
  keys: Record<string, Stamped<string>>;
  /** The account's share of PlayerSettings, by top-level field ("audio" and "ui" hold only their synced members) */
  settings: Record<string, Stamped<unknown>>;
  /** Personal bests by their IndexedDB key ("<track>|<car>|<board>") */
  bestLaps: Record<string, CloudBestLap>;
  /** Synced keys removed on some device, and when, so a removal isn't undone by an older copy */
  removed: Record<string, number>;
}

/** Limits the server holds a save to */
export const MAX_SAVE_BYTES = 1_000_000;
export const MAX_GHOST_BYTES = 2 * 1024 * 1024;
export const MAX_GHOSTS_PER_ACCOUNT = 400;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Every ghost a save points at */
export const ghostsOf = (doc: SaveDoc): string[] => [...new Set(Object.values(doc.bestLaps ?? {}).map((b) => b.ghost))];

/**
 * GET /api/account/save -> SaveAnswer
 * `rev` counts the writes (0 = never written, `doc` null). `pending`: saves of accounts folded into this one; the
 * next device to sync combines them in and names their ids in `combinedPending`.
 */
export type SaveAnswer =
  | { ok: true; rev: number; updatedAt: number | null; doc: SaveDoc | null; pending: { id: number; doc: SaveDoc }[] }
  | Fail;

/**
 * PUT /api/account/save { baseRev, doc, combinedPending } -> PutSaveAnswer
 * Written only if the cloud is still at `baseRev`; otherwise 409 with what is there now, to combine and send again.
 * Ghosts no save points at any more are removed by the server an hour later.
 */
export interface PutSaveRequest {
  baseRev: number;
  doc: SaveDoc;
  combinedPending: number[];
}
export type PutSaveAnswer =
  | { ok: true; rev: number; updatedAt: number }
  | (Fail & { conflict?: true; rev?: number; doc?: SaveDoc | null });

/**
 * Ghosts (the recordings of personal bests), by the SHA-256 of their JSON text:
 *   POST /api/account/ghosts/missing { shas } -> { ok: true, missing: string[] }  which of these the cloud lacks
 *   PUT  /api/account/ghosts/<sha>   body: the JSON text                -> { ok: true } (400 if the hash doesn't match)
 *   GET  /api/account/ghosts/<sha>   -> the JSON text, or 404
 */
export type MissingGhostsAnswer = { ok: true; missing: string[] } | Fail;

// ---------------------------------------------------------------------------------------------------------------
// GET /api/config gains `accounts` (the feature is on) and `accountProviders` (the ways in this server offers: Discord
// and Google only once their secrets are set)

export interface AccountsConfig {
  accounts: boolean;
  accountProviders: AccountProvider[];
}
