/**
 * Passkeys (WebAuthn, through @simplewebauthn/server):
 *   POST /api/auth/passkey/options { mode, displayName? } -> { ok, challengeId, options }
 *   POST /api/auth/passkey/verify  { challengeId, response } -> { ok, result }
 * The relying party is the site's host name, and the answer must come from the site's own origin (or one of
 * DEV_ORIGINS). Passkeys are discoverable (resident keys), so signing in needs no name first: the browser offers the
 * passkeys it has for the site, and the credential id says whose account it is. Each challenge lives in `auth_states`,
 * one use and 10 minutes, and goes back to the browser only as the options; the server compares against its own copy.
 *
 * What the server keeps of a passkey: its credential id, its public key, its signature counter and its transports.
 * `displayName` is written to the authenticator only (so the player can tell their passkeys apart there), never stored.
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AuthResult, PasskeyMode } from "../../../src/lib/account/api-types";
import { base64url, dayText, fromBase64url, randomToken } from "./deps";
import { answer, cleanLabel, failWith, jsonBody, overLimit, signedOut, type Ctx } from "./http";
import { mergeAccounts } from "./merge";
import { AUTH_STATE_TTL_MS, readSession, signInBrowser, sweep } from "./sessions";
import { insertAccount, newAccount } from "./store";

const MODES: readonly PasskeyMode[] = ["signin", "create", "add", "link"];
/** What the authenticator is told the site is called */
const RP_NAME = "LibreCorsa";
/** A browser's answer with its attestation; a packed one with certificates is a few kB */
const MAX_VERIFY_BYTES = 64 * 1024;
const CHALLENGE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

const rpIdOf = (ctx: Ctx): string => ctx.url.hostname;
const originsOf = (ctx: Ctx): string[] => [ctx.url.origin, ...ctx.deps.devOrigins];

interface PasskeyRow {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string;
}

const transportsOf = (raw: string): string[] => {
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

export async function passkeyOptions(ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  if (await overLimit(deps.authLimit, ctx.request)) return failWith(ctx, "Too many tries, wait a minute", 429);
  const read = await jsonBody(ctx.request, 4096);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const mode = read.body.mode as PasskeyMode;
  if (!MODES.includes(mode)) return failWith(ctx, "Unknown passkey mode");
  const session = await readSession(ctx);
  if ((mode === "add" || mode === "link") && !session) return signedOut(ctx);
  if (mode === "create" && session) return failWith(ctx, "Sign out before making a new account", 409);
  await sweep(deps);

  const rpID = rpIdOf(ctx);
  const displayName = cleanLabel(read.body.displayName) || "LibreCorsa driver";
  let options: unknown;
  let challenge: string;
  let userHandle: string | null = null;
  if (mode === "create" || mode === "add") {
    let excludeCredentials: { id: string; transports?: string[] }[] = [];
    if (mode === "add" && session) {
      const account = await deps.db.prepare("SELECT webauthn_user_id FROM accounts WHERE id = ?").bind(session.accountId).first<{ webauthn_user_id: string }>();
      if (!account) return signedOut(ctx);
      userHandle = account.webauthn_user_id;
      const have = await deps.db.prepare("SELECT id, transports FROM passkeys WHERE account_id = ?").bind(session.accountId).all<{ id: string; transports: string }>();
      excludeCredentials = have.results.map((p) => ({ id: p.id, transports: transportsOf(p.transports) }));
    } else {
      userHandle = randomToken(deps, 32);
    }
    const created = await deps.webauthn.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: displayName,
      userDisplayName: displayName,
      userID: fromBase64url(userHandle) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    options = created;
    challenge = created.challenge;
  } else {
    const asked = await deps.webauthn.generateAuthenticationOptions({ rpID, userVerification: "preferred", allowCredentials: [] });
    options = asked;
    challenge = asked.challenge;
  }

  const challengeId = randomToken(deps, 24);
  await deps.db
    .prepare(
      "INSERT INTO auth_states (id, kind, provider, intent, account_id, return_to, verifier, challenge, nonce, created_at) VALUES (?, 'webauthn', 'passkey', ?, ?, '', NULL, ?, ?, ?)",
    )
    .bind(challengeId, mode, mode === "add" || mode === "link" ? session!.accountId : null, challenge, mode === "create" ? userHandle : null, deps.now())
    .run();
  return answer(ctx, { ok: true, challengeId, options });
}

interface ChallengeRow {
  intent: string;
  account_id: string | null;
  challenge: string;
  nonce: string | null;
  created_at: number;
}

const COULD_NOT_CHECK = "The passkey could not be checked. Try again";

export async function passkeyVerify(ctx: Ctx): Promise<Response> {
  const { deps } = ctx;
  const read = await jsonBody(ctx.request, MAX_VERIFY_BYTES);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const { challengeId, response } = read.body;
  if (typeof challengeId !== "string" || !CHALLENGE_ID_RE.test(challengeId)) return failWith(ctx, "Unknown challenge");
  if (typeof response !== "object" || response === null || typeof (response as { id?: unknown }).id !== "string") return failWith(ctx, COULD_NOT_CHECK);
  // Used once: taken out as it is read, whatever the answer turns out to be
  const row = await deps.db.prepare("DELETE FROM auth_states WHERE id = ? AND kind = 'webauthn' RETURNING *").bind(challengeId).first<ChallengeRow>();
  if (!row || deps.now() - row.created_at > AUTH_STATE_TTL_MS) return failWith(ctx, "That took too long. Try again", 410);
  const mode = row.intent as PasskeyMode;
  const session = await readSession(ctx);
  if ((mode === "add" || mode === "link") && (!session || session.accountId !== row.account_id)) return signedOut(ctx);
  const nowMs = deps.now();

  if (mode === "create" || mode === "add") {
    let verified;
    try {
      verified = await deps.webauthn.verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: row.challenge,
        expectedOrigin: originsOf(ctx),
        expectedRPID: rpIdOf(ctx),
        requireUserVerification: false,
      });
    } catch {
      return failWith(ctx, COULD_NOT_CHECK);
    }
    if (!verified.verified || !verified.registrationInfo) return failWith(ctx, COULD_NOT_CHECK);
    const credential = verified.registrationInfo.credential;
    if (await deps.db.prepare("SELECT 1 AS one FROM passkeys WHERE id = ?").bind(credential.id).first()) return failWith(ctx, "This passkey is on an account already", 409);
    const insertPasskey = (accountId: string) =>
      deps.db
        .prepare("INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(credential.id, accountId, base64url(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), `Passkey added ${dayText(nowMs)}`, nowMs, nowMs);
    if (mode === "add") {
      await insertPasskey(row.account_id!).run();
      return answer(ctx, { ok: true, result: "linked" satisfies AuthResult });
    }
    const account = newAccount(deps, row.nonce ?? undefined);
    await deps.db.batch([insertAccount(deps, account, nowMs), insertPasskey(account.id)]);
    await signInBrowser(ctx, account.id);
    return answer(ctx, { ok: true, result: "created" satisfies AuthResult });
  }

  // signin, link: a passkey the server knows, whose signature checks out
  const credentialId = (response as { id: string }).id;
  const passkey = credentialId.length <= 1024 ? await deps.db.prepare("SELECT * FROM passkeys WHERE id = ?").bind(credentialId).first<PasskeyRow>() : null;
  const publicKey = passkey ? fromBase64url(passkey.public_key) : null;
  if (!passkey || !publicKey) return failWith(ctx, "This passkey isn't on any account here. Sign in another way, or make an account with it", 404);
  let verified;
  try {
    verified = await deps.webauthn.verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: row.challenge,
      expectedOrigin: originsOf(ctx),
      expectedRPID: rpIdOf(ctx),
      credential: { id: passkey.id, publicKey: publicKey as Uint8Array<ArrayBuffer>, counter: passkey.counter, transports: transportsOf(passkey.transports) },
      requireUserVerification: false,
    });
  } catch {
    return failWith(ctx, COULD_NOT_CHECK);
  }
  if (!verified.verified) return failWith(ctx, COULD_NOT_CHECK);
  await deps.db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").bind(verified.authenticationInfo.newCounter, nowMs, passkey.id).run();

  if (mode === "link") {
    if (passkey.account_id === row.account_id) return answer(ctx, { ok: true, result: "already-linked" satisfies AuthResult });
    await mergeAccounts(deps, row.account_id!, passkey.account_id);
    return answer(ctx, { ok: true, result: "merged" satisfies AuthResult });
  }
  await signInBrowser(ctx, passkey.account_id);
  return answer(ctx, { ok: true, result: "signed-in" satisfies AuthResult });
}
