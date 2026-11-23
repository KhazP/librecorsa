/**
 * POST /api/account/delete { removeLaps, confirm: "delete" }: the account, its sign-ins, passkeys, sessions, cloud
 * save and cloud ghosts go. Its names leave it:
 *   removeLaps  their laps (and ghosts), race results (kept as an anonymous "Driver" row, so the other cars' places
 *               still add up) and badges come off the boards, and the names are free for anyone
 *   otherwise   they stay with the driver keys that hold them and lapse after six months without a lap, as any
 *               other name; a name only the account held (its key was removed) goes to this device's key
 * The boards go first, then the accounts database: a failure between them leaves the account in place, and deleting
 * again finishes the job.
 */
import { deleteDriverLaps } from "../board";
import { accountSentinel, missingAccountsSchema } from "../name-proof";
import type { D1PreparedStatement } from "../types";
import { answer, clearCookie, failWith, jsonBody, type Ctx } from "./http";
import type { Session } from "./sessions";

/** A write to a table a later board migration made (race results, awards): without it there is nothing to change */
async function ifTable(write: D1PreparedStatement): Promise<void> {
  try {
    await write.run();
  } catch (err) {
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err)) && !missingAccountsSchema(err)) throw err;
  }
}

export async function deleteAccount(ctx: Ctx, session: Session): Promise<Response> {
  const read = await jsonBody(ctx.request, 1024);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const { removeLaps, confirm } = read.body;
  if (confirm !== "delete" || typeof removeLaps !== "boolean") return failWith(ctx, 'Send confirm: "delete" and removeLaps');
  const { board, db, ghosts } = ctx.deps;
  const accountId = session.accountId;
  const nowMs = ctx.deps.now();

  // The boards
  const names = (await board.prepare("SELECT name_key FROM drivers WHERE account_id = ?").bind(accountId).all<{ name_key: string }>()).results.map((r) => r.name_key);
  let removedLaps = 0;
  if (removeLaps) {
    for (const nameKey of names) removedLaps += await deleteDriverLaps({ db: board, ghosts }, nameKey);
    for (let i = 0; i < names.length; i += 50) {
      const chunk = names.slice(i, i + 50);
      const marks = chunk.map(() => "?").join(",");
      await ifTable(board.prepare(`UPDATE race_cars SET name_key = NULL, name = 'Driver', code = 'DRV' WHERE name_key IN (${marks})`).bind(...chunk));
      await ifTable(board.prepare(`DELETE FROM driver_awards WHERE name_key IN (${marks})`).bind(...chunk));
    }
    await board.batch([
      board.prepare("DELETE FROM drivers WHERE account_id = ?").bind(accountId),
      board.prepare("DELETE FROM account_keys WHERE account_id = ?").bind(accountId),
    ]);
  } else {
    // This device's key, when it is one of the account's, takes the names no key of the account held any more
    const own = session.keyHash
      ? await board.prepare("SELECT key_hash FROM account_keys WHERE key_hash = ? AND account_id = ?").bind(session.keyHash, accountId).first<{ key_hash: string }>()
      : null;
    const writes: D1PreparedStatement[] = [];
    if (own) writes.push(board.prepare("UPDATE drivers SET key_hash = ? WHERE account_id = ? AND key_hash = ?").bind(own.key_hash, accountId, accountSentinel(accountId)));
    writes.push(
      // Off the account they lapse like any name, counted from now: names on an account never lapsed, so their last
      // upload may be long past, and the next claim would otherwise take them (and their laps) at once
      board.prepare("UPDATE drivers SET account_id = NULL, last_seen = MAX(last_seen, ?) WHERE account_id = ?").bind(nowMs, accountId),
      board.prepare("DELETE FROM account_keys WHERE account_id = ?").bind(accountId),
    );
    await board.batch(writes);
  }

  // The accounts database, ghost files first so none is left without a row pointing at it
  const files = await db.prepare("SELECT r2_key FROM cloud_ghosts WHERE account_id = ?").bind(accountId).all<{ r2_key: string }>();
  for (let i = 0; i < files.results.length; i += 50) await ghosts.delete(files.results.slice(i, i + 50).map((r) => r.r2_key));
  await db.batch([
    db.prepare("DELETE FROM cloud_ghosts WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM saves WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM pending_saves WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM link_codes WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM auth_states WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM identities WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM sessions WHERE account_id = ?").bind(accountId),
    db.prepare("DELETE FROM merges_log WHERE into_account_id = ? OR from_account_id = ?").bind(accountId, accountId),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(accountId),
  ]);
  ctx.session = null;
  clearCookie(ctx, "session");
  return answer(ctx, { ok: true, removedLaps });
}
