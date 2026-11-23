/**
 * Sessions: a signed-in browser holds a random token in an HttpOnly cookie (`__Host-lc_session`, or `lc_session` on
 * plain http in development); the database keeps only the token's SHA-256, so a copy of the table signs nobody in.
 * A session slides: each use pushes its end out again (its last use is written at most once an hour, and the cookie
 * set again then), and one left unused for a year ends.
 */
import { randomToken, sha256Hex, type AccountsDeps } from "./deps";
import { clearCookie, readCookie, setCookie, type Ctx } from "./http";

export interface Session {
  /** SHA-256 (hex) of the token */
  id: string;
  publicId: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  label: string;
  /** SHA-256 of the driver key this device registered; null before it joined */
  keyHash: string | null;
}

interface SessionRow {
  id: string;
  public_id: string;
  account_id: string;
  created_at: number;
  last_seen_at: number;
  label: string;
  key_hash: string | null;
}

/** The cookie lives as long as browsers allow (400 days); the session itself ends after a year unused */
export const SESSION_COOKIE_S = 400 * 86_400;
export const SESSION_IDLE_MS = 365 * 86_400_000;
/** A session's last use (and its cookie) is written again at most this often */
export const SESSION_TOUCH_MS = 3_600_000;
/** A sign-in under way (auth_states) is good for this long */
export const AUTH_STATE_TTL_MS = 10 * 60_000;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sessionOf = (r: SessionRow): Session => ({
  id: r.id,
  publicId: r.public_id,
  accountId: r.account_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  label: r.label,
  keyHash: r.key_hash,
});

/**
 * The session this request's cookie holds, or null. A cookie with no live session behind it (signed out elsewhere,
 * idle for a year, its account deleted) is cleared on the answer.
 */
export async function readSession(ctx: Ctx): Promise<Session | null> {
  if (ctx.session !== undefined) return ctx.session;
  ctx.session = null;
  const token = readCookie(ctx, "session");
  if (token === null) return null;
  if (!TOKEN_RE.test(token)) {
    clearCookie(ctx, "session");
    return null;
  }
  const { db, now } = ctx.deps;
  const id = await sha256Hex(token);
  const row = await db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  const nowMs = now();
  if (!row || nowMs - row.last_seen_at > SESSION_IDLE_MS) {
    if (row) await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
    clearCookie(ctx, "session");
    return null;
  }
  const session = sessionOf(row);
  if (nowMs - row.last_seen_at >= SESSION_TOUCH_MS) {
    await db.batch([
      db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(nowMs, id),
      db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").bind(nowMs, row.account_id),
    ]);
    session.lastSeenAt = nowMs;
    setCookie(ctx, "session", token, SESSION_COOKIE_S);
  }
  ctx.session = session;
  return session;
}

/** Ends a session and, when it is this browser's, clears its cookie */
export async function endSession(ctx: Ctx, session: Session): Promise<void> {
  await ctx.deps.db.prepare("DELETE FROM sessions WHERE id = ?").bind(session.id).run();
  if (ctx.session?.id === session.id) {
    ctx.session = null;
    clearCookie(ctx, "session");
  }
}

/**
 * Signs this browser in to `accountId`. A session it already has on that account stays (with the device it joined
 * as); one on another account ends, and a new one starts.
 */
export async function signInBrowser(ctx: Ctx, accountId: string): Promise<Session> {
  const current = await readSession(ctx);
  if (current && current.accountId === accountId) return current;
  if (current) await endSession(ctx, current);
  return startSession(ctx, accountId);
}

async function startSession(ctx: Ctx, accountId: string): Promise<Session> {
  const { db, now } = ctx.deps;
  const nowMs = now();
  const token = randomToken(ctx.deps, 32);
  const session: Session = {
    id: await sha256Hex(token),
    publicId: randomToken(ctx.deps, 9),
    accountId,
    createdAt: nowMs,
    lastSeenAt: nowMs,
    label: "",
    keyHash: null,
  };
  await db.batch([
    db
      .prepare("INSERT INTO sessions (id, public_id, account_id, created_at, last_seen_at, label, key_hash) VALUES (?, ?, ?, ?, ?, '', NULL)")
      .bind(session.id, session.publicId, accountId, nowMs, nowMs),
    db.prepare("UPDATE accounts SET last_seen_at = ? WHERE id = ?").bind(nowMs, accountId),
  ]);
  setCookie(ctx, "session", token, SESSION_COOKIE_S);
  ctx.session = session;
  return session;
}

/**
 * Clears out what has run out: sign-ins under way past their 10 minutes, link codes past their end, sessions unused
 * for a year. Run when a sign-in starts, so the tables stay small without a schedule of their own.
 */
export async function sweep(deps: AccountsDeps): Promise<void> {
  const nowMs = deps.now();
  await deps.db.batch([
    deps.db.prepare("DELETE FROM auth_states WHERE created_at < ?").bind(nowMs - AUTH_STATE_TTL_MS),
    deps.db.prepare("DELETE FROM link_codes WHERE expires_at < ?").bind(nowMs),
    deps.db.prepare("DELETE FROM sessions WHERE last_seen_at < ?").bind(nowMs - SESSION_IDLE_MS),
  ]);
}
