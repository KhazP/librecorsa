/**
 * Accounts, their sign-ins, and what the account page shows. An account's own rows are in the accounts database; its
 * names (drivers.account_id) and driver keys (account_keys) are on the boards' database.
 */
import { ACCOUNT_PROVIDERS, type AccountInfo, type AccountName, type AccountProvider, type SignInProvider } from "../../../src/lib/account/api-types";
import { randomToken, type AccountsDeps } from "./deps";
import type { Session } from "./sessions";

/** A new account with no way in yet: the caller adds one in the same breath */
export function newAccount(deps: AccountsDeps, webauthnUserId?: string): { id: string; webauthnUserId: string } {
  return { id: randomToken(deps, 16), webauthnUserId: webauthnUserId ?? randomToken(deps, 32) };
}

export const insertAccount = (deps: AccountsDeps, account: { id: string; webauthnUserId: string }, nowMs: number) =>
  deps.db.prepare("INSERT INTO accounts (id, created_at, last_seen_at, webauthn_user_id) VALUES (?, ?, ?, ?)").bind(account.id, nowMs, nowMs, account.webauthnUserId);

export async function accountExists(deps: AccountsDeps, accountId: string): Promise<boolean> {
  return (await deps.db.prepare("SELECT 1 AS one FROM accounts WHERE id = ?").bind(accountId).first()) !== null;
}

/** The account a provider's sign-in belongs to, or null */
export async function identityAccount(deps: AccountsDeps, provider: SignInProvider, subject: string): Promise<string | null> {
  const row = await deps.db.prepare("SELECT account_id FROM identities WHERE provider = ? AND subject = ?").bind(provider, subject).first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/** The ways in an account has: what the account page offers to remove, and what link-code previews name */
export async function providersOf(deps: AccountsDeps, accountId: string): Promise<AccountProvider[]> {
  const [ids, keys] = await deps.db.batch([
    deps.db.prepare("SELECT DISTINCT provider FROM identities WHERE account_id = ?").bind(accountId),
    deps.db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?").bind(accountId),
  ]);
  const have = new Set((ids.results as { provider: string }[]).map((r) => r.provider));
  if (((keys.results[0] as { n: number } | undefined)?.n ?? 0) > 0) have.add("passkey");
  return ACCOUNT_PROVIDERS.filter((p) => have.has(p));
}

/** The names on an account, the most recently used first, each as last written on a board lap */
export async function namesOf(deps: AccountsDeps, accountId: string): Promise<AccountName[]> {
  const rows = await deps.board
    .prepare(
      "SELECT d.name_key AS name_key, d.last_seen AS last_seen, (SELECT driver_name FROM laps WHERE laps.name_key = d.name_key ORDER BY created_at DESC LIMIT 1) AS shown FROM drivers d WHERE d.account_id = ? ORDER BY d.last_seen DESC, d.name_key",
    )
    .bind(accountId)
    .all<{ name_key: string; last_seen: number; shown: string | null }>();
  return rows.results.map((r) => ({ nameKey: r.name_key, displayName: r.shown ?? r.name_key, lastSeen: r.last_seen }));
}

/** The name shown for an account: its most recently used driver name; null before it has any */
export async function driverNameOf(deps: AccountsDeps, accountId: string): Promise<string | null> {
  const row = await deps.board
    .prepare(
      "SELECT d.name_key AS name_key, (SELECT driver_name FROM laps WHERE laps.name_key = d.name_key ORDER BY created_at DESC LIMIT 1) AS shown FROM drivers d WHERE d.account_id = ? ORDER BY d.last_seen DESC, d.name_key LIMIT 1",
    )
    .bind(accountId)
    .first<{ name_key: string; shown: string | null }>();
  return row ? (row.shown ?? row.name_key) : null;
}

/** The display names of these claim keys, as last written on a board lap (the key itself without one) */
export async function displayNames(deps: AccountsDeps, nameKeys: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const key of nameKeys) {
    const row = await deps.board.prepare("SELECT driver_name FROM laps WHERE name_key = ? ORDER BY created_at DESC LIMIT 1").bind(key).first<{ driver_name: string }>();
    out.push(row?.driver_name ?? key);
  }
  return out;
}

/** Everything the account page shows (GET /api/account) */
export async function accountInfo(deps: AccountsDeps, session: Session): Promise<AccountInfo | null> {
  const id = session.accountId;
  const [account, identities, passkeys, sessions, save, pending] = await deps.db.batch([
    deps.db.prepare("SELECT id, created_at FROM accounts WHERE id = ?").bind(id),
    deps.db.prepare("SELECT provider, created_at, last_used_at FROM identities WHERE account_id = ? ORDER BY created_at, provider").bind(id),
    deps.db.prepare("SELECT id, label, created_at, last_used_at FROM passkeys WHERE account_id = ? ORDER BY created_at, id").bind(id),
    deps.db.prepare("SELECT id, public_id, label, created_at, last_seen_at FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC, public_id").bind(id),
    deps.db.prepare("SELECT rev, updated_at, bytes FROM saves WHERE account_id = ?").bind(id),
    deps.db.prepare("SELECT COUNT(*) AS n FROM pending_saves WHERE account_id = ?").bind(id),
  ]);
  const row = account.results[0] as { id: string; created_at: number } | undefined;
  if (!row) return null;
  const [names, keys] = await Promise.all([
    namesOf(deps, id),
    deps.board
      .prepare("SELECT key_hash, label, added_at, last_used_at FROM account_keys WHERE account_id = ? ORDER BY added_at, key_hash")
      .bind(id)
      .all<{ key_hash: string; label: string; added_at: number; last_used_at: number | null }>(),
  ]);
  const saveRow = save.results[0] as { rev: number; updated_at: number; bytes: number } | undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    driverName: names[0]?.displayName ?? null,
    names,
    identities: (identities.results as { provider: SignInProvider; created_at: number; last_used_at: number | null }[]).map((r) => ({
      provider: r.provider,
      linkedAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
    passkeys: (passkeys.results as { id: string; label: string; created_at: number; last_used_at: number | null }[]).map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    })),
    sessions: (sessions.results as { id: string; public_id: string; label: string; created_at: number; last_seen_at: number }[]).map((r) => ({
      id: r.public_id,
      label: r.label,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      current: r.id === session.id,
    })),
    keys: keys.results.map((r) => ({
      id: keyIdOf(r.key_hash),
      label: r.label,
      addedAt: r.added_at,
      lastUsedAt: r.last_used_at,
      current: r.key_hash === session.keyHash,
    })),
    save: saveRow ? { rev: saveRow.rev, updatedAt: saveRow.updated_at, bytes: saveRow.bytes } : null,
    pendingMerges: (pending.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

/** The id the account page shows for a driver key: the first 12 hex digits of its SHA-256 */
export const keyIdOf = (keyHash: string): string => keyHash.slice(0, 12);
export const KEY_ID_RE = /^[0-9a-f]{12}$/;
