/**
 * Folding one account into another: the player proved both in one browser (a sign-in or passkey of account B while
 * signed in to A, intent "link"). Everything of B's moves to A: its sign-ins, passkeys, sessions, names, driver keys
 * and cloud ghosts. B's save is not combined here: it waits in `pending_saves` for the next device of A that syncs,
 * which combines it with the game's own rules (src/lib/account/save-model.ts). Then B goes.
 *
 * The boards' database and the accounts database are separate, so the two halves can't be one transaction. The
 * boards go first: a failure after them leaves B's names and keys on A while B still exists, and trying again
 * finishes the job (every step below is safe to repeat).
 */
import { accountSentinel } from "../name-proof";
import type { AccountsDeps } from "./deps";

export async function mergeAccounts(deps: AccountsDeps, intoId: string, fromId: string): Promise<void> {
  if (intoId === fromId) return;
  const nowMs = deps.now();
  const { db, board } = deps;

  await board.batch([
    // Names B's removed keys left to B alone now belong to A's keys
    board.prepare("UPDATE drivers SET key_hash = ? WHERE account_id = ? AND key_hash = ?").bind(accountSentinel(intoId), fromId, accountSentinel(fromId)),
    board.prepare("UPDATE drivers SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
    board.prepare("UPDATE account_keys SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
  ]);

  // A ghost both accounts have is kept once: B's copy of it goes from the bucket once its row is gone
  const twins = await db
    .prepare("SELECT b.r2_key AS r2_key FROM cloud_ghosts b JOIN cloud_ghosts a ON a.account_id = ? AND a.sha256 = b.sha256 WHERE b.account_id = ?")
    .bind(intoId, fromId)
    .all<{ r2_key: string }>();

  await db.batch([
    db.prepare("UPDATE identities SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
    db.prepare("UPDATE passkeys SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
    db.prepare("UPDATE sessions SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
    db
      .prepare("INSERT OR IGNORE INTO cloud_ghosts (account_id, sha256, r2_key, bytes, created_at) SELECT ?, sha256, r2_key, bytes, created_at FROM cloud_ghosts WHERE account_id = ?")
      .bind(intoId, fromId),
    db.prepare("DELETE FROM cloud_ghosts WHERE account_id = ?").bind(fromId),
    // B's save, and saves of accounts folded into B before, wait for a device of A to combine them
    db.prepare("INSERT INTO pending_saves (account_id, from_account_id, doc, created_at) SELECT ?, account_id, doc, ? FROM saves WHERE account_id = ?").bind(intoId, nowMs, fromId),
    db.prepare("DELETE FROM saves WHERE account_id = ?").bind(fromId),
    db.prepare("UPDATE pending_saves SET account_id = ? WHERE account_id = ?").bind(intoId, fromId),
    db.prepare("DELETE FROM link_codes WHERE account_id = ?").bind(fromId),
    db.prepare("DELETE FROM auth_states WHERE account_id = ?").bind(fromId),
    db.prepare("INSERT INTO merges_log (into_account_id, from_account_id, merged_at) SELECT ?, id, ? FROM accounts WHERE id = ?").bind(intoId, nowMs, fromId),
    db.prepare("DELETE FROM accounts WHERE id = ?").bind(fromId),
  ]);

  // Only A's rows could have taken one of B's files over
  await deleteUnlistedGhosts(deps, intoId, twins.results.map((r) => r.r2_key));
}

/** Removes these ghost files from the bucket, except any of `accountId`'s cloud_ghosts rows still points at */
export async function deleteUnlistedGhosts(deps: AccountsDeps, accountId: string, r2Keys: readonly string[]): Promise<void> {
  for (let i = 0; i < r2Keys.length; i += 50) {
    const chunk = r2Keys.slice(i, i + 50);
    const listed = await deps.db
      .prepare(`SELECT r2_key FROM cloud_ghosts WHERE account_id = ? AND r2_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(accountId, ...chunk)
      .all<{ r2_key: string }>();
    const keep = new Set(listed.results.map((r) => r.r2_key));
    const gone = chunk.filter((k) => !keep.has(k));
    if (gone.length > 0) await deps.ghosts.delete(gone);
  }
}
