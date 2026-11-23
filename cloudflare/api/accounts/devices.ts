/**
 * The account's devices and ways in (signed in):
 *   POST /api/account/device { driverKey, label }    this device's driver key joins the account, with its names
 *   POST /api/account/sessions/remove   { id }       signs that device out
 *   POST /api/account/keys/remove       { id }       that driver key no longer posts under the account's names
 *   POST /api/account/passkeys/remove   { id }
 *   POST /api/account/identities/remove { provider }
 * The last way in (sign-ins plus passkeys) can't be removed.
 */
import { SIGN_IN_PROVIDERS, type SignInProvider } from "../../../src/lib/account/api-types";
import { accountSentinel } from "../name-proof";
import { sha256Hex } from "./deps";
import { answer, cleanLabel, failWith, jsonBody, type Ctx } from "./http";
import { endSession, type Session } from "./sessions";
import { displayNames, KEY_ID_RE } from "./store";

/** As board.ts takes them */
const DRIVER_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LAST_WAY_IN = "This is the last way into your account. Add another first, or delete the account";

export async function joinDevice(ctx: Ctx, session: Session): Promise<Response> {
  const read = await jsonBody(ctx.request, 2048);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const { driverKey } = read.body;
  if (typeof driverKey !== "string" || !DRIVER_KEY_RE.test(driverKey)) return failWith(ctx, "Missing driver key. Reload the game and try again");
  const label = cleanLabel(read.body.label);
  const { board, db, now } = ctx.deps;
  const nowMs = now();
  const keyHash = await sha256Hex(driverKey);
  const accountId = session.accountId;

  // One account per key: a key already on another account stays there, and its names with it
  await board
    .prepare(
      "INSERT INTO account_keys (key_hash, account_id, label, added_at, last_used_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT (key_hash) DO UPDATE SET label = excluded.label WHERE account_keys.account_id = excluded.account_id",
    )
    .bind(keyHash, accountId, label, nowMs)
    .run();
  const keyOwner = await board.prepare("SELECT account_id FROM account_keys WHERE key_hash = ?").bind(keyHash).first<{ account_id: string }>();
  const keyElsewhere = keyOwner !== null && keyOwner.account_id !== accountId;

  const attached: string[] = [];
  const elsewhere: string[] = [];
  const held = await board.prepare("SELECT name_key, account_id FROM drivers WHERE key_hash = ? ORDER BY last_seen DESC, name_key").bind(keyHash).all<{ name_key: string; account_id: string | null }>();
  for (const name of held.results) {
    if (!keyElsewhere && name.account_id === null) {
      const done = await board.prepare("UPDATE drivers SET account_id = ? WHERE name_key = ? AND key_hash = ? AND account_id IS NULL").bind(accountId, name.name_key, keyHash).run();
      if ((done.meta.changes ?? 0) === 1) {
        attached.push(name.name_key);
        continue;
      }
      const now2 = await board.prepare("SELECT account_id FROM drivers WHERE name_key = ?").bind(name.name_key).first<{ account_id: string | null }>();
      if (now2?.account_id === accountId) attached.push(name.name_key);
      else if (now2?.account_id) elsewhere.push(name.name_key);
    } else if (name.account_id === accountId) {
      attached.push(name.name_key);
    } else if (name.account_id !== null) {
      elsewhere.push(name.name_key);
    }
  }

  await db.prepare("UPDATE sessions SET key_hash = ?, label = ? WHERE id = ?").bind(keyHash, label, session.id).run();
  session.keyHash = keyHash;
  session.label = label;
  const [attachedNames, elsewhereNames] = await Promise.all([displayNames(ctx.deps, attached), displayNames(ctx.deps, elsewhere)]);
  return answer(ctx, { ok: true, attached: attachedNames, elsewhere: elsewhereNames, keyElsewhere });
}

async function idOf(ctx: Ctx, field: string, max: number): Promise<string | Response> {
  const read = await jsonBody(ctx.request, 1024);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const value = read.body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) return failWith(ctx, `Missing ${field}`);
  return value;
}

/**
 * A driver key leaves the account: the names it held stay on the account, for the account's other keys only, and a
 * device signed in with it is no longer joined (the game asks again before anything of it goes up)
 */
async function dropKey(ctx: Ctx, accountId: string, keyHash: string): Promise<void> {
  const { board, db } = ctx.deps;
  await board.batch([
    board.prepare("UPDATE drivers SET key_hash = ? WHERE account_id = ? AND key_hash = ?").bind(accountSentinel(accountId), accountId, keyHash),
    board.prepare("DELETE FROM account_keys WHERE key_hash = ? AND account_id = ?").bind(keyHash, accountId),
  ]);
  await db.prepare("UPDATE sessions SET key_hash = NULL WHERE account_id = ? AND key_hash = ?").bind(accountId, keyHash).run();
}

/**
 * Ends a session (signing out, or signing a device out from another) and takes its driver key off the account with
 * it, unless another session of the account still holds that key: a player who signs in on someone else's computer
 * and signs out again leaves no way for the next person there to race under their names
 */
export async function signOutSession(ctx: Ctx, accountId: string, target: { id: string; keyHash: string | null }, current: Session | null): Promise<void> {
  if (current && current.id === target.id) await endSession(ctx, current);
  else await ctx.deps.db.prepare("DELETE FROM sessions WHERE id = ? AND account_id = ?").bind(target.id, accountId).run();
  if (!target.keyHash) return;
  const still = await ctx.deps.db.prepare("SELECT 1 AS one FROM sessions WHERE account_id = ? AND key_hash = ? LIMIT 1").bind(accountId, target.keyHash).first();
  if (!still) await dropKey(ctx, accountId, target.keyHash);
}

export async function removeSession(ctx: Ctx, session: Session): Promise<Response> {
  const id = await idOf(ctx, "id", 64);
  if (typeof id !== "string") return id;
  const target = await ctx.deps.db
    .prepare("SELECT id, key_hash FROM sessions WHERE public_id = ? AND account_id = ?")
    .bind(id, session.accountId)
    .first<{ id: string; key_hash: string | null }>();
  if (!target) return failWith(ctx, "That device is signed out already", 404);
  await signOutSession(ctx, session.accountId, { id: target.id, keyHash: target.key_hash }, session);
  return answer(ctx, { ok: true });
}

export async function removeKey(ctx: Ctx, session: Session): Promise<Response> {
  const id = await idOf(ctx, "id", 12);
  if (typeof id !== "string") return id;
  if (!KEY_ID_RE.test(id)) return failWith(ctx, "That driver key isn't on this account", 404);
  const { board } = ctx.deps;
  const keys = await board.prepare("SELECT key_hash FROM account_keys WHERE account_id = ? AND substr(key_hash, 1, 12) = ?").bind(session.accountId, id).all<{ key_hash: string }>();
  if (keys.results.length !== 1) return failWith(ctx, "That driver key isn't on this account", 404);
  const keyHash = keys.results[0].key_hash;
  await dropKey(ctx, session.accountId, keyHash);
  if (session.keyHash === keyHash) session.keyHash = null;
  return answer(ctx, { ok: true });
}

/** Ways in left besides the ones a removal takes: the passkeys and sign-ins that are not `minus` */
const OTHERS_LEFT = "(SELECT COUNT(*) FROM passkeys WHERE account_id = ?1 AND id != ?2) + (SELECT COUNT(*) FROM identities WHERE account_id = ?1 AND provider != ?3)";

export async function removePasskey(ctx: Ctx, session: Session): Promise<Response> {
  const id = await idOf(ctx, "id", 1024);
  if (typeof id !== "string") return id;
  const { db } = ctx.deps;
  // Counted and removed in one statement, so two removals at once can't both pass the count
  const done = await db.prepare(`DELETE FROM passkeys WHERE id = ?2 AND account_id = ?1 AND (${OTHERS_LEFT}) > 0`).bind(session.accountId, id, "").run();
  if ((done.meta.changes ?? 0) === 1) return answer(ctx, { ok: true });
  const there = await db.prepare("SELECT 1 AS one FROM passkeys WHERE id = ? AND account_id = ?").bind(id, session.accountId).first();
  return there ? failWith(ctx, LAST_WAY_IN, 409) : failWith(ctx, "That passkey isn't on this account", 404);
}

export async function removeIdentity(ctx: Ctx, session: Session): Promise<Response> {
  const provider = await idOf(ctx, "provider", 16);
  if (typeof provider !== "string") return provider;
  if (!SIGN_IN_PROVIDERS.includes(provider as SignInProvider)) return failWith(ctx, "Unknown sign-in");
  const { db } = ctx.deps;
  const done = await db.prepare(`DELETE FROM identities WHERE account_id = ?1 AND provider = ?3 AND (${OTHERS_LEFT}) > 0`).bind(session.accountId, "", provider).run();
  if ((done.meta.changes ?? 0) > 0) return answer(ctx, { ok: true });
  const there = await db.prepare("SELECT 1 AS one FROM identities WHERE account_id = ? AND provider = ?").bind(session.accountId, provider).first();
  return there ? failWith(ctx, LAST_WAY_IN, 409) : failWith(ctx, "That sign-in isn't on this account", 404);
}
