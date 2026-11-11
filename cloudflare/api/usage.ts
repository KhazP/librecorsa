/**
 * The anonymous usage counter: POST /api/usage adds one stretch of driving (circuit, car, mode, minutes) to the day's
 * totals (migrations/0003_usage.sql). Anyone can call it, so every field is checked and the minutes are capped; the
 * address only feeds the rate limit (USAGE_LIMIT) and is never stored, and nothing ties one report to another.
 */
import { isVehicleModelId } from "../../src/types/f1";
import { MAX_USAGE_MINUTES, MIN_USAGE_MINUTES, isUsageMode } from "../../src/lib/net/usage-modes";
import { TRACK_ID_RE } from "./lap-check";
import type { D1Database } from "./types";

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** A report is four short fields: anything longer is not one */
const MAX_BODY_BYTES = 1024;

export interface UsageDeps {
  db: D1Database;
  now: () => number;
}

/** The UTC day of `ms`, "2026-11-11" */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The two-letter country Cloudflare puts on the request, "XX" when it has none */
export function requestCountry(request: Request): string {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "XX";
}

export async function recordUsage(deps: UsageDeps, request: Request): Promise<Answer> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return fail("Too large", 413);
  // Sent as plain text so the browser needs no preflight; read as JSON whatever its type says
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return fail("Too large", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("Not JSON");
  }
  if (typeof raw !== "object" || raw === null) return fail("Not an object");
  const { trackId, vehicle, mode, minutes } = raw as Record<string, unknown>;
  if (typeof trackId !== "string" || !TRACK_ID_RE.test(trackId)) return fail("Invalid trackId");
  if (!isVehicleModelId(vehicle)) return fail("Invalid vehicle");
  if (!isUsageMode(mode)) return fail("Invalid mode");
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < MIN_USAGE_MINUTES) return fail("Invalid minutes");
  const counted = Math.round(Math.min(minutes, MAX_USAGE_MINUTES) * 10) / 10;

  await deps.db
    .prepare(
      "INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (day, track_id, vehicle, mode, country) DO UPDATE SET sessions = sessions + 1, minutes = minutes + excluded.minutes",
    )
    .bind(utcDay(deps.now()), trackId, vehicle, mode, requestCountry(request), counted)
    .run();
  return { status: 200, body: { ok: true } };
}
