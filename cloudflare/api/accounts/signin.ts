/**
 * What a proven sign-in does, the same for Discord, Google and Steam (oauth.ts):
 *   signin  an existing sign-in signs this browser in to its account ("signed-in"); a new one makes an account with
 *           it as the only way in ("created")
 *   link    (signed in, the same account as when it started) a free sign-in joins this account ("linked"); one on
 *           this account changes nothing ("already-linked"); one on another account folds that account into this
 *           one ("merged")
 */
import type { AuthResult, SignInIntent, SignInProvider } from "../../../src/lib/account/api-types";
import type { Ctx } from "./http";
import { mergeAccounts } from "./merge";
import { readSession, signInBrowser } from "./sessions";
import { identityAccount, insertAccount, newAccount } from "./store";

/** True when `err` is a write refused because the row is there already (two tries at once) */
const alreadyThere = (err: unknown): boolean => /UNIQUE|PRIMARY KEY|constraint/i.test(err instanceof Error ? err.message : String(err));

export async function useIdentity(ctx: Ctx, provider: SignInProvider, subject: string, intent: SignInIntent, startedFor: string | null): Promise<AuthResult> {
  const { db, now } = ctx.deps;
  const nowMs = now();
  const owner = await identityAccount(ctx.deps, provider, subject);

  if (intent === "link") {
    const session = await readSession(ctx);
    if (!session || !startedFor || session.accountId !== startedFor) return "failed";
    if (owner === session.accountId) return "already-linked";
    if (owner) {
      await mergeAccounts(ctx.deps, session.accountId, owner);
      await touchIdentity(ctx, provider, subject, nowMs);
      return "merged";
    }
    try {
      await db
        .prepare("INSERT INTO identities (provider, subject, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)")
        .bind(provider, subject, session.accountId, nowMs, nowMs)
        .run();
    } catch (err) {
      // Linked from another tab a moment ago: whichever account has it now, this browser proved both, so fold
      if (!alreadyThere(err)) throw err;
      const now2 = await identityAccount(ctx.deps, provider, subject);
      if (!now2) throw err;
      if (now2 === session.accountId) return "already-linked";
      await mergeAccounts(ctx.deps, session.accountId, now2);
      return "merged";
    }
    return "linked";
  }

  if (owner) {
    await touchIdentity(ctx, provider, subject, nowMs);
    await signInBrowser(ctx, owner);
    return "signed-in";
  }
  const account = newAccount(ctx.deps);
  try {
    await db.batch([
      insertAccount(ctx.deps, account, nowMs),
      db.prepare("INSERT INTO identities (provider, subject, account_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)").bind(provider, subject, account.id, nowMs, nowMs),
    ]);
  } catch (err) {
    // The same new sign-in finished in another tab first: sign in to the account it made
    if (!alreadyThere(err)) throw err;
    const made = await identityAccount(ctx.deps, provider, subject);
    if (!made) throw err;
    await signInBrowser(ctx, made);
    return "signed-in";
  }
  await signInBrowser(ctx, account.id);
  return "created";
}

async function touchIdentity(ctx: Ctx, provider: SignInProvider, subject: string, nowMs: number): Promise<void> {
  await ctx.deps.db.prepare("UPDATE identities SET last_used_at = ? WHERE provider = ? AND subject = ?").bind(nowMs, provider, subject).run();
}
