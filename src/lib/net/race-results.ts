/**
 * The open races' results, from the site's API (cloudflare/api/results.ts): a week's latest races and its standings
 * of drivers whose name is proven with their driver key, and one driver's all-time record. Answers are validated
 * before use; null when races are off or the answer could not be read.
 */
import { getOnlineConfig, onlineUrl } from "./online-config";

const REQUEST_TIMEOUT_MS = 8000;
const MAX_TEXT = 64;

export interface RacePodiumPlace {
  position: number;
  name: string;
  code: string;
  /** Race time with penalties (s); null for a DNF */
  timeS: number | null;
  dnf: boolean;
}

export interface WeekRace {
  id: string;
  finishedMs: number;
  trackId: string;
  vehicle: string;
  laps: number;
  podium: RacePodiumPlace[];
}

export interface WeekStanding {
  name: string;
  starts: number;
  wins: number;
  podiums: number;
}

export interface WeekRaceResults {
  week: string;
  /** Newest first */
  races: WeekRace[];
  /** By wins, then podiums */
  standings: WeekStanding[];
}

export interface DriverRecord {
  name: string;
  starts: number;
  wins: number;
  podiums: number;
  /** Best finishing place; null without a finish */
  bestFinish: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e6 ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, MAX_TEXT) : null);

async function getJson(path: string, query: Record<string, string>): Promise<unknown> {
  const base = onlineUrl(path);
  if (!base || typeof fetch === "undefined" || !(await getOnlineConfig()).races) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}?${new URLSearchParams(query).toString()}`, { signal: controller.signal, credentials: "omit", cache: "no-store" });
    return res.ok ? await res.json().catch(() => null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parsePlace(v: unknown): RacePodiumPlace | null {
  if (!isRecord(v)) return null;
  const position = count(v.position);
  const name = text(v.name);
  if (position === null || position < 1 || name === null) return null;
  const timeS = typeof v.timeS === "number" && Number.isFinite(v.timeS) && v.timeS > 0 ? v.timeS : null;
  return { position, name, code: text(v.code) ?? "DRV", timeS, dnf: v.dnf === true };
}

/** An answer of GET /api/races/results, validated; null when it is not one */
export function parseWeekRaceResults(body: unknown): WeekRaceResults | null {
  if (!isRecord(body) || typeof body.week !== "string" || !Array.isArray(body.races) || !Array.isArray(body.standings)) return null;
  const races = body.races.slice(0, 20).flatMap((r): WeekRace[] => {
    if (!isRecord(r)) return [];
    const id = text(r.id);
    const laps = count(r.laps);
    if (id === null || laps === null || typeof r.finishedMs !== "number" || !Number.isFinite(r.finishedMs)) return [];
    const podium = Array.isArray(r.podium) ? r.podium.slice(0, 3).map(parsePlace).filter((p): p is RacePodiumPlace => p !== null) : [];
    return [{ id, finishedMs: r.finishedMs, trackId: text(r.trackId) ?? "", vehicle: text(r.vehicle) ?? "", laps, podium }];
  });
  const standings = body.standings.slice(0, 50).flatMap((s): WeekStanding[] => {
    if (!isRecord(s)) return [];
    const name = text(s.name);
    const starts = count(s.starts);
    const wins = count(s.wins);
    const podiums = count(s.podiums);
    return name === null || starts === null || wins === null || podiums === null ? [] : [{ name, starts, wins, podiums }];
  });
  return { week: body.week.slice(0, 16), races, standings };
}

/** An answer of GET /api/drivers/record, validated; null when it is not one */
export function parseDriverRecord(body: unknown): DriverRecord | null {
  if (!isRecord(body)) return null;
  const starts = count(body.starts);
  const wins = count(body.wins);
  const podiums = count(body.podiums);
  if (starts === null || wins === null || podiums === null) return null;
  const best = count(body.bestFinish);
  return { name: text(body.name) ?? "", starts, wins, podiums, bestFinish: best !== null && best >= 1 ? best : null };
}

/** A weekly challenge's races ("2026-W46"): its latest races and its standings */
export async function fetchWeekRaceResults(week: string): Promise<WeekRaceResults | null> {
  return parseWeekRaceResults(await getJson("/races/results", { week }));
}

/** A driver's record in the open races, by the name they race under */
export async function fetchDriverRecord(name: string): Promise<DriverRecord | null> {
  const trimmed = name.trim().slice(0, MAX_TEXT);
  if (!trimmed) return null;
  return parseDriverRecord(await getJson("/drivers/record", { name: trimmed }));
}
