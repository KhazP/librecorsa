/**
 * The cloud save and its ghosts (signed in):
 *   GET  /api/account/save                         -> { rev, updatedAt, doc, pending }
 *   PUT  /api/account/save { baseRev, doc, combinedPending } written only over `baseRev`; otherwise 409 with what is there
 *   POST /api/account/ghosts/missing { shas }      which of these the cloud lacks
 *   PUT  /api/account/ghosts/<sha>  body: the JSON text, stored when its SHA-256 is <sha>
 *   GET  /api/account/ghosts/<sha>                 the JSON text, or 404
 * The save is one JSON document per account (src/lib/account/api-types.ts SaveDoc). The server checks its shape and
 * size, never its contents: combining two saves is the game's job (src/lib/account/save-model.ts). Ghosts are stored
 * once per account and recording, in the ghost bucket under accounts/ghosts/; one no save points at any more goes
 * after the next save that is an hour or more younger than it.
 */
import {
  ghostsOf,
  MAX_GHOST_BYTES,
  MAX_GHOSTS_PER_ACCOUNT,
  MAX_SAVE_BYTES,
  SAVE_DOC_VERSION,
  SHA256_HEX_RE,
  type SaveDoc,
} from "../../../src/lib/account/api-types";
import { sha256Hex } from "./deps";
import { answer, bodyBytes, failWith, jsonBody, text, type Ctx } from "./http";
import type { Session } from "./sessions";

/** A ghost uploaded this recently is kept even when no save points at it yet: its save is on the way */
export const GHOST_GRACE_MS = 3_600_000;
/** The save PUT carries the document and a little more */
const MAX_PUT_BYTES = MAX_SAVE_BYTES + 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Null when `doc` has the SaveDoc shape (not its contents); else what is wrong */
export function saveDocProblem(doc: unknown): string | null {
  if (!isRecord(doc)) return "The save is not an object";
  if (doc.v !== SAVE_DOC_VERSION) return "Unknown save version";
  if (typeof doc.savedAt !== "number" || !Number.isFinite(doc.savedAt) || typeof doc.savedBy !== "string") return "The save is missing when and where it was written";
  for (const part of ["keys", "settings", "bestLaps", "removed"] as const) if (!isRecord(doc[part])) return `The save's ${part} is not an object`;
  for (const lap of Object.values(doc.bestLaps as Record<string, unknown>)) {
    if (!isRecord(lap) || typeof lap.ghost !== "string" || !SHA256_HEX_RE.test(lap.ghost)) return "A best lap in the save has no ghost";
  }
  return null;
}

const parseDoc = (raw: string): SaveDoc | null => {
  try {
    const doc = JSON.parse(raw) as unknown;
    return saveDocProblem(doc) === null ? (doc as SaveDoc) : null;
  } catch {
    return null;
  }
};

interface SaveRow {
  rev: number;
  doc: string;
  updated_at: number;
}

export async function getSave(ctx: Ctx, session: Session): Promise<Response> {
  const { db } = ctx.deps;
  const [save, pending] = await db.batch([
    db.prepare("SELECT rev, doc, updated_at FROM saves WHERE account_id = ?").bind(session.accountId),
    db.prepare("SELECT id, doc FROM pending_saves WHERE account_id = ? ORDER BY id").bind(session.accountId),
  ]);
  const row = save.results[0] as unknown as SaveRow | undefined;
  return answer(ctx, {
    ok: true,
    rev: row?.rev ?? 0,
    updatedAt: row?.updated_at ?? null,
    doc: row ? parseDoc(row.doc) : null,
    pending: (pending.results as { id: number; doc: string }[]).flatMap((p) => {
      const doc = parseDoc(p.doc);
      return doc ? [{ id: p.id, doc }] : [];
    }),
  });
}

export async function putSave(ctx: Ctx, session: Session): Promise<Response> {
  const { db, now } = ctx.deps;
  const read = await jsonBody(ctx.request, MAX_PUT_BYTES);
  if (!read.ok) return failWith(ctx, read.status === 413 ? "The save is larger than 1 MB" : read.error, read.status);
  const { baseRev, doc, combinedPending } = read.body;
  if (typeof baseRev !== "number" || !Number.isInteger(baseRev) || baseRev < 0) return failWith(ctx, "baseRev is required");
  const problem = saveDocProblem(doc);
  if (problem) return failWith(ctx, problem);
  const combined = Array.isArray(combinedPending) ? combinedPending.filter((id): id is number => Number.isInteger(id) && id > 0).slice(0, 99) : [];  // with the account id, D1's 100 bound values
  const docText = JSON.stringify(doc);
  const bytes = new TextEncoder().encode(docText).byteLength;
  if (bytes > MAX_SAVE_BYTES) return failWith(ctx, "The save is larger than 1 MB", 413);

  const nowMs = now();
  const accountId = session.accountId;
  const written =
    baseRev === 0
      ? await db
          .prepare("INSERT INTO saves (account_id, rev, doc, bytes, updated_at) VALUES (?, 1, ?, ?, ?) ON CONFLICT (account_id) DO NOTHING")
          .bind(accountId, docText, bytes, nowMs)
          .run()
      : await db
          .prepare("UPDATE saves SET rev = rev + 1, doc = ?, bytes = ?, updated_at = ? WHERE account_id = ? AND rev = ?")
          .bind(docText, bytes, nowMs, accountId, baseRev)
          .run();
  if ((written.meta.changes ?? 0) !== 1) {
    // Another device wrote first: here is what it wrote, to combine with and send again
    const current = await db.prepare("SELECT rev, doc FROM saves WHERE account_id = ?").bind(accountId).first<{ rev: number; doc: string }>();
    return failWith(ctx, "The cloud save changed on another device", 409, { conflict: true, rev: current?.rev ?? 0, doc: current ? parseDoc(current.doc) : null });
  }
  // The saves of folded accounts this one took in are done with
  if (combined.length > 0) {
    await db
      .prepare(`DELETE FROM pending_saves WHERE account_id = ? AND id IN (${combined.map(() => "?").join(",")})`)
      .bind(accountId, ...combined)
      .run();
  }
  await dropUnusedGhosts(ctx, accountId, doc as SaveDoc, nowMs);
  return answer(ctx, { ok: true, rev: baseRev + 1, updatedAt: nowMs });
}

/** Removes the account's ghosts that neither this save nor a pending one points at, once they are an hour old */
async function dropUnusedGhosts(ctx: Ctx, accountId: string, doc: SaveDoc, nowMs: number): Promise<void> {
  const { db, ghosts } = ctx.deps;
  const [old, pending] = await db.batch([
    db.prepare("SELECT sha256, r2_key FROM cloud_ghosts WHERE account_id = ? AND created_at < ?").bind(accountId, nowMs - GHOST_GRACE_MS),
    db.prepare("SELECT doc FROM pending_saves WHERE account_id = ?").bind(accountId),
  ]);
  const candidates = old.results as { sha256: string; r2_key: string }[];
  if (candidates.length === 0) return;
  const used = new Set(ghostsOf(doc));
  for (const p of pending.results as { doc: string }[]) {
    const pendingDoc = parseDoc(p.doc);
    if (pendingDoc) for (const sha of ghostsOf(pendingDoc)) used.add(sha);
  }
  const unused = candidates.filter((g) => !used.has(g.sha256));
  for (let i = 0; i < unused.length; i += 50) {
    const chunk = unused.slice(i, i + 50);
    await db
      .prepare(`DELETE FROM cloud_ghosts WHERE account_id = ? AND sha256 IN (${chunk.map(() => "?").join(",")})`)
      .bind(accountId, ...chunk.map((g) => g.sha256))
      .run();
    await ghosts.delete(chunk.map((g) => g.r2_key));
  }
}

export async function missingGhosts(ctx: Ctx, session: Session): Promise<Response> {
  const read = await jsonBody(ctx.request, 64 * 1024);
  if (!read.ok) return failWith(ctx, read.error, read.status);
  const { shas } = read.body;
  if (!Array.isArray(shas) || shas.length > MAX_GHOSTS_PER_ACCOUNT || !shas.every((s) => typeof s === "string" && SHA256_HEX_RE.test(s))) {
    return failWith(ctx, `shas: up to ${MAX_GHOSTS_PER_ACCOUNT} SHA-256 hashes`);
  }
  const asked = [...new Set(shas as string[])];
  const have = new Set<string>();
  for (let i = 0; i < asked.length; i += 50) {
    const chunk = asked.slice(i, i + 50);
    const rows = await ctx.deps.db
      .prepare(`SELECT sha256 FROM cloud_ghosts WHERE account_id = ? AND sha256 IN (${chunk.map(() => "?").join(",")})`)
      .bind(session.accountId, ...chunk)
      .all<{ sha256: string }>();
    for (const r of rows.results) have.add(r.sha256);
  }
  return answer(ctx, { ok: true, missing: asked.filter((s) => !have.has(s)) });
}

export async function putGhost(ctx: Ctx, session: Session, sha: string): Promise<Response> {
  const { db, ghosts, now } = ctx.deps;
  const raw = await bodyBytes(ctx.request, MAX_GHOST_BYTES);
  if (raw === null) return failWith(ctx, "The recording is larger than 2 MB", 413);
  // The hash of the bytes as sent, which is the hash of the text the game hashed
  if ((await sha256Hex(raw)) !== sha) return failWith(ctx, "The recording doesn't match its hash");
  const body = new TextDecoder().decode(raw);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) throw new Error("not an object");
  } catch {
    return failWith(ctx, "The recording is not valid JSON");
  }
  const accountId = session.accountId;
  const [there, count] = await db.batch([
    db.prepare("SELECT 1 AS one FROM cloud_ghosts WHERE account_id = ? AND sha256 = ?").bind(accountId, sha),
    db.prepare("SELECT COUNT(*) AS n FROM cloud_ghosts WHERE account_id = ?").bind(accountId),
  ]);
  if (there.results.length > 0) return answer(ctx, { ok: true });
  if (((count.results[0] as { n: number } | undefined)?.n ?? 0) >= MAX_GHOSTS_PER_ACCOUNT) {
    return failWith(ctx, `The cloud holds up to ${MAX_GHOSTS_PER_ACCOUNT} best laps`, 409);
  }
  const r2Key = `accounts/ghosts/${crypto.randomUUID()}.json`;
  // The file before the row that points at it
  await ghosts.put(r2Key, body, { httpMetadata: { contentType: "application/json" } });
  const stored = await db
    .prepare("INSERT INTO cloud_ghosts (account_id, sha256, r2_key, bytes, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, sha256) DO NOTHING")
    .bind(accountId, sha, r2Key, raw.byteLength, now())
    .run();
  // The same recording went up from another device a moment ago: this copy isn't needed
  if ((stored.meta.changes ?? 0) !== 1) await ghosts.delete(r2Key);
  return answer(ctx, { ok: true });
}

export async function getGhost(ctx: Ctx, session: Session, sha: string): Promise<Response> {
  const row = await ctx.deps.db.prepare("SELECT r2_key FROM cloud_ghosts WHERE account_id = ? AND sha256 = ?").bind(session.accountId, sha).first<{ r2_key: string }>();
  const object = row ? await ctx.deps.ghosts.get(row.r2_key) : null;
  if (!object) return failWith(ctx, "Not found", 404);
  return text(ctx, await object.text(), "application/json; charset=utf-8");
}
