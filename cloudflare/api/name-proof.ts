/**
 * Who may speak for a driver name on the boards. A name is claimed by a driver key (board.ts); with player accounts
 * (migration 0011) a name can also belong to an account, and then every driver key on that account proves it too.
 * The four places that prove a name use this: uploads and renames (board.ts), race results (results.ts provenNameKeys)
 * and the Creator badge (awards.ts).
 *
 * Every read here works on a database without migration 0011 as well: the account side is then left out and a name is
 * proven by its own key alone, as before.
 */
import type { D1Database } from "./types";

/** True when `err` is a read of migration 0011's table or column on a database that doesn't have it yet */
export function missingAccountsSchema(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such (table|column)/i.test(message) && /account/i.test(message);
}

/** The key hash a name gets when the key that held it leaves its account: no key hashes to it, so only the account's keys prove it */
export const accountSentinel = (accountId: string): string => `account:${accountId}`;

/** A driver key's account, and when the key last posted; null when it is on none */
export interface KeyAccount {
  accountId: string;
  lastUsedAt: number | null;
}

/** The account a driver key (its SHA-256) is on: null when on none, undefined on a database without accounts */
export async function accountOfKey(db: D1Database, keyHash: string): Promise<KeyAccount | null | undefined> {
  try {
    const row = await db.prepare("SELECT account_id, last_used_at FROM account_keys WHERE key_hash = ?").bind(keyHash).first<{ account_id: string; last_used_at: number | null }>();
    return row ? { accountId: row.account_id, lastUsedAt: row.last_used_at } : null;
  } catch (err) {
    if (missingAccountsSchema(err)) return undefined;
    throw err;
  }
}

/** The accounts of these driver keys (SHA-256), by key; undefined on a database without accounts */
export async function accountsOfKeys(db: D1Database, keyHashes: readonly string[]): Promise<Map<string, string> | undefined> {
  const out = new Map<string, string>();
  const unique = [...new Set(keyHashes)];
  try {
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const rows = await db
        .prepare(`SELECT key_hash, account_id FROM account_keys WHERE key_hash IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ key_hash: string; account_id: string }>();
      for (const r of rows.results) out.set(r.key_hash, r.account_id);
    }
    return out;
  } catch (err) {
    if (missingAccountsSchema(err)) return undefined;
    throw err;
  }
}

/** A name's claim: the key hash that holds it, and its account if it has one */
export interface NameOwner {
  key_hash: string;
  account_id?: string | null;
}

/** True when a driver key (its SHA-256, and its account if any) proves the name `owner` holds */
export function keyProvesName(owner: NameOwner | null | undefined, keyHash: string, keyAccountId: string | null | undefined): boolean {
  if (!owner) return false;
  if (owner.key_hash === keyHash) return true;
  return typeof owner.account_id === "string" && owner.account_id !== "" && owner.account_id === keyAccountId;
}

/** How long a key's last use stands before an upload writes it again: the account page shows the day, not the minute */
export const KEY_USE_REFRESH_MS = 3_600_000;
