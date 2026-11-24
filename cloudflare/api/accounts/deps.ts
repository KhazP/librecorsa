/**
 * What the account routes run on, gathered in one object so the checks (scripts/verify/verify-accounts.ts) can stand in for
 * the providers, the clock and the randomness: the two databases, the ghost bucket, the outbound fetch, the OAuth
 * clients and the passkey library. `accountsDeps` builds the real one from the Worker's bindings.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { D1Database, Env, R2Bucket, RateLimit } from "../types";

/** An outbound request (to Discord, Google or Steam) */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The four calls of @simplewebauthn/server the passkey routes make */
export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export interface AccountsDeps {
  /** librecorsa-accounts: sign-ins, sessions, passkeys, saves */
  db: D1Database;
  /** librecorsa-board: names (drivers.account_id) and the accounts' driver keys (account_keys) */
  board: D1Database;
  /** librecorsa-ghosts: the board's ghosts, and the accounts' cloud ghosts under accounts/ghosts/ */
  ghosts: R2Bucket;
  fetch: Fetcher;
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  /** The OAuth clients: null until both of their secrets are set */
  discord: OAuthClient | null;
  google: OAuthClient | null;
  /** Origins besides the site's own that may call the API (DEV_ORIGINS) */
  devOrigins: readonly string[];
  /** Sign-in ceremonies and link codes per address; cloud save reads and writes per address */
  authLimit?: RateLimit;
  saveLimit?: RateLimit;
  webauthn: WebAuthnLib;
}

export const realWebAuthn: WebAuthnLib = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

const clientOf = (id: string | undefined, secret: string | undefined): OAuthClient | null =>
  id && secret ? { clientId: id.trim(), clientSecret: secret.trim() } : null;

export const devOriginsOf = (env: Env): string[] =>
  (env.DEV_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

/** The real dependencies, from the Worker's bindings; null when one the accounts need is missing */
export function accountsDeps(env: Env, inject: Partial<AccountsDeps> = {}): AccountsDeps | null {
  if (!env.ACCOUNTS_DB || !env.BOARD_DB || !env.GHOSTS) return null;
  return {
    db: env.ACCOUNTS_DB,
    board: env.BOARD_DB,
    ghosts: env.GHOSTS,
    // Called as a plain function: the runtime's fetch refuses to run as another object's method
    fetch: (input, init) => fetch(input, init),
    now: Date.now,
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    discord: clientOf(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET),
    google: clientOf(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    devOrigins: devOriginsOf(env),
    authLimit: env.AUTH_LIMIT,
    saveLimit: env.SAVE_LIMIT,
    webauthn: realWebAuthn,
    ...inject,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Bytes, hashes and comparisons (no Node Buffer: the Worker runs without nodejs_compat)

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null when `text` isn't base64url */
export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export const randomToken = (deps: AccountsDeps, bytes: number): string => base64url(deps.randomBytes(bytes));

export async function sha256Bytes(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return Array.from(await sha256Bytes(data), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True when two secrets are the same. Both are hashed first, so the comparison runs over 32 bytes whatever either
 * length, and every byte is compared: its time says nothing about either value.
 */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** "23 Nov 2026" in UTC */
export function dayText(ms: number): string {
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
