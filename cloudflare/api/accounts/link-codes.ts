/**
 * Link codes: a signed-in device shows a code, another types it and is signed in to the same account. That is how the
 * desktop app and a home-screen web app sign in, since a provider's page can't send them back.
 *   POST /api/account/link-code            (signed in) a new code; the account's older ones stop working
 *   POST /api/auth/link-code/preview {code} whose account it joins; the code stays good
 *   POST /api/auth/link-code/redeem  {code} signs this browser in; the code is used up
 * 8 characters from 31 (no 0/O/1/I/L), about 8.5 * 10^11 codes, good for 10 minutes and once; only their SHA-256 is
 * stored. Typing them counts against AUTH_LIMIT, so trying codes at random gets nowhere.
 */
import { LINK_CODE_ALPHABET, LINK_CODE_TTL_MS, normaliseLinkCode, type AuthResult } from "../../../src/lib/account/api-types";
import { sha256Hex, type AccountsDeps } from "./deps";
import { answer, failWith, jsonBody, overLimit, type Ctx } from "./http";
import { signInBrowser, sweep, type Session } from "./sessions";
import { accountExists, driverNameOf, providersOf } from "./store";

const WRONG_CODE = "That code is wrong or has run out. Show a new one on the other device";

/** 8 characters of LINK_CODE_ALPHABET, each equally likely (bytes past the last whole run of the alphabet are thrown away) */
export function randomLinkCode(deps: AccountsDeps): string {
  const n = LINK_CODE_ALPHABET.length;
  const below = 256 - (256 % n);
  let code = "";
  while (code.length < 8) {
    for (const b of deps.randomBytes(16)) {
      if (b >= below) continue;
      code += LINK_CODE_ALPHABET[b % n];
      if (code.length === 8) break;
    }
  }
  return code;
}

export async function createLinkCode(ctx: Ctx, session: Session): Promise<Response> {
  const { deps } = ctx;
  await sweep(deps);
  const nowMs = deps.now();
  const expiresAt = nowMs + LINK_CODE_TTL_MS;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = randomLinkCode(deps);
    try {
      await deps.db.batch([
        deps.db.prepare("DELETE FROM link_codes WHERE account_id = ?").bind(session.accountId),
        deps.db.prepare("INSERT INTO link_codes (code_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(code), session.accountId, nowMs, expiresAt),
      ]);
      return answer(ctx, { ok: true, code, expiresAt });
    } catch (err) {
      // Another account's live code drew the same characters: draw again
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
  }
  return failWith(ctx, "No code could be made. Try again", 500);
}

/** The account a typed code belongs to, if it is good now; an answer to send instead otherwise */
async function codeOf(ctx: Ctx): Promise<{ code: string } | { refused: Response }> {
  if (await overLimit(ctx.deps.authLimit, ctx.request)) return { refused: failWith(ctx, "Too many tries, wait a minute", 429) };
  const read = await jsonBody(ctx.request, 1024);
  if (!read.ok) return { refused: failWith(ctx, read.error, read.status) };
  const code = typeof read.body.code === "string" ? normaliseLinkCode(read.body.code.slice(0, 64)) : null;
  if (!code) return { refused: failWith(ctx, "A code is 8 letters and digits, like ABCD-EFGH") };
  return { code };
}

export async function previewLinkCode(ctx: Ctx): Promise<Response> {
  const typed = await codeOf(ctx);
  if ("refused" in typed) return typed.refused;
  const { deps } = ctx;
  const row = await deps.db
    .prepare("SELECT account_id FROM link_codes WHERE code_hash = ? AND expires_at > ?")
    .bind(await sha256Hex(typed.code), deps.now())
    .first<{ account_id: string }>();
  if (!row || !(await accountExists(deps, row.account_id))) return failWith(ctx, WRONG_CODE, 404);
  const [driverName, providers] = await Promise.all([driverNameOf(deps, row.account_id), providersOf(deps, row.account_id)]);
  return answer(ctx, { ok: true, driverName, providers });
}

export async function redeemLinkCode(ctx: Ctx): Promise<Response> {
  const typed = await codeOf(ctx);
  if ("refused" in typed) return typed.refused;
  const { deps } = ctx;
  // Used once: taken out as it is read
  const row = await deps.db
    .prepare("DELETE FROM link_codes WHERE code_hash = ? AND expires_at > ? RETURNING account_id")
    .bind(await sha256Hex(typed.code), deps.now())
    .first<{ account_id: string }>();
  if (!row || !(await accountExists(deps, row.account_id))) return failWith(ctx, WRONG_CODE, 404);
  // A browser signed in to another account switches to this one
  await signInBrowser(ctx, row.account_id);
  return answer(ctx, { ok: true, result: "signed-in" satisfies AuthResult });
}
