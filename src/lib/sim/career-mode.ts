import { AI_DRIVERS, AI_RESERVE_DRIVERS, aiRaceCodes } from "@/lib/sim/ai-opponents";
import { LISTED_TRACKS, getTrackInfo } from "@/lib/track-registry";
import type { RaceResultEntry } from "@/types/f1";

export type CareerTierId = "rookie" | "constructors" | "world";

export interface CareerTierDef {
  id: CareerTierId;
  title: string;
  subtitle: string;
  roundsCount: number;
  laps: number;
  opponents: number;
  aiSkill: number;
}

export const CAREER_TIERS: readonly CareerTierDef[] = [
  {
    id: "rookie",
    title: "Rookie Cup",
    subtitle: "3-round sprint series · 3 laps · 5 AI opponents · 62% AI skill",
    roundsCount: 3,
    laps: 3,
    opponents: 5,
    aiSkill: 62,
  },
  {
    id: "constructors",
    title: "Constructors Trophy",
    subtitle: "4-round championship · 5 laps · 7 AI opponents · 76% AI skill",
    roundsCount: 4,
    laps: 5,
    opponents: 7,
    aiSkill: 76,
  },
  {
    id: "world",
    title: "World Championship",
    subtitle: "5-round Grand Prix season · 5 laps · 9 AI opponents · 88% AI skill",
    roundsCount: 5,
    laps: 5,
    opponents: 9,
    aiSkill: 88,
  },
];

/** Standard FIA Formula 1 points table for P1..P10 */
export const F1_POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;

export interface CareerRound {
  roundNumber: number;
  trackId: string;
  laps: number;
  completed: boolean;
  winnerCode: string | null;
  playerPosition: number | null;
  playerPointsEarned: number | null;
  fastestLapCode: string | null;
}

export interface CareerStandingEntry {
  code: string;
  name: string;
  color: string;
  isPlayer: boolean;
  points: number;
  wins: number;
  podiums: number;
  fastestLaps: number;
  racesEntered: number;
  bestFinish: number | null;
}

export interface CareerState {
  version: 1;
  seasonNumber: number;
  tierId: CareerTierId;
  currentRoundIndex: number;
  seasonCompleted: boolean;
  rounds: CareerRound[];
  standings: Record<string, CareerStandingEntry>;
  lastUpdatedMs: number;
}

const STORAGE_KEY = "lc_career_v1";

export function getCareerTier(tierId: CareerTierId): CareerTierDef {
  return CAREER_TIERS.find((t) => t.id === tierId) ?? CAREER_TIERS[0];
}

/** Build a circuit calendar from available non-hillclimb tracks */
function buildCalendar(tier: CareerTierDef): CareerRound[] {
  const circuits = LISTED_TRACKS.filter((t) => t.type !== "hillclimb");
  const pool =
    circuits.length > 0
      ? circuits
      : [getTrackInfo("rwanda_official_short"), getTrackInfo("rwanda_official")];

  const rounds: CareerRound[] = [];
  for (let i = 0; i < tier.roundsCount; i++) {
    const track = pool[i % pool.length];
    rounds.push({
      roundNumber: i + 1,
      trackId: track.id,
      laps: tier.laps,
      completed: false,
      winnerCode: null,
      playerPosition: null,
      playerPointsEarned: null,
      fastestLapCode: null,
    });
  }
  return rounds;
}

export function createInitialCareerState(
  tierId: CareerTierId,
  player: { code: string; name: string; color: string },
  seasonNumber = 1,
): CareerState {
  const tier = getCareerTier(tierId);
  const allAi = [...AI_DRIVERS, ...AI_RESERVE_DRIVERS].slice(0, tier.opponents);
  const pCode = (player.code || "YOU").toUpperCase();
  const codes = aiRaceCodes(
    allAi.map((d) => d.code),
    pCode,
  );

  const standings: Record<string, CareerStandingEntry> = {
    [pCode]: {
      code: pCode,
      name: player.name || pCode,
      color: player.color || "#d4ff00",
      isPlayer: true,
      points: 0,
      wins: 0,
      podiums: 0,
      fastestLaps: 0,
      racesEntered: 0,
      bestFinish: null,
    },
  };

  allAi.forEach((d, idx) => {
    const code = codes[idx];
    standings[code] = {
      code,
      name: code,
      color: d.teamColorHex,
      isPlayer: false,
      points: 0,
      wins: 0,
      podiums: 0,
      fastestLaps: 0,
      racesEntered: 0,
      bestFinish: null,
    };
  });

  return {
    version: 1,
    seasonNumber,
    tierId,
    currentRoundIndex: 0,
    seasonCompleted: false,
    rounds: buildCalendar(tier),
    standings,
    lastUpdatedMs: Date.now(),
  };
}

export function loadCareerState(player: { code: string; name: string; color: string }): CareerState {
  if (typeof window === "undefined") {
    return createInitialCareerState("rookie", player);
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialCareerState("rookie", player);
    const parsed = JSON.parse(raw) as CareerState;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.rounds) || !parsed.standings) {
      return createInitialCareerState("rookie", player);
    }
    return syncPlayerIntoCareer(parsed, player);
  } catch {
    return createInitialCareerState("rookie", player);
  }
}

export function saveCareerState(state: CareerState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota errors
  }
}

/** Keeps the player's current profile name/code/color synced in the standings table */
export function syncPlayerIntoCareer(
  state: CareerState,
  player: { code: string; name: string; color: string },
): CareerState {
  const newCode = (player.code || "YOU").toUpperCase();
  const entries = Object.values(state.standings);
  const existingPlayer = entries.find((e) => e.isPlayer);
  if (!existingPlayer) return state;
  if (
    existingPlayer.code === newCode &&
    existingPlayer.name === (player.name || newCode) &&
    existingPlayer.color === (player.color || existingPlayer.color)
  ) {
    return state;
  }
  const nextStandings = { ...state.standings };
  delete nextStandings[existingPlayer.code];
  nextStandings[newCode] = {
    ...existingPlayer,
    code: newCode,
    name: player.name || newCode,
    color: player.color || existingPlayer.color,
  };
  return { ...state, standings: nextStandings };
}

/** Sort championship standings by Points DESC, Wins DESC, Podiums DESC, Best Finish ASC */
export function sortedCareerStandings(state: CareerState): CareerStandingEntry[] {
  return Object.values(state.standings).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.podiums !== a.podiums) return b.podiums - a.podiums;
    const aBest = a.bestFinish ?? 999;
    const bBest = b.bestFinish ?? 999;
    if (aBest !== bBest) return aBest - bBest;
    if (a.isPlayer !== b.isPlayer) return a.isPlayer ? -1 : 1;
    return a.code.localeCompare(b.code);
  });
}

/** Calculate F1 points for a single result entry */
export function pointsForResult(entry: RaceResultEntry, hasFastestLap: boolean): number {
  if (entry.dnf || entry.dq) return 0;
  const base = F1_POINTS_TABLE[entry.position - 1] ?? 0;
  const flBonus = hasFastestLap && entry.position <= 10 ? 1 : 0;
  return base + flBonus;
}

/** Records the final race classification into the active career round and advances the round counter */
export function recordCareerRoundResult(
  state: CareerState,
  results: readonly RaceResultEntry[],
): CareerState {
  if (state.seasonCompleted || state.currentRoundIndex >= state.rounds.length) {
    return state;
  }
  const currentRound = state.rounds[state.currentRoundIndex];
  if (!currentRound || currentRound.completed) {
    return state;
  }

  const ordered = [...results].sort((a, b) => a.position - b.position);
  const fastestMs = ordered.reduce<number | null>(
    (best, r) =>
      !r.dnf && !r.dq && r.bestLapMs !== null && (best === null || r.bestLapMs < best)
        ? r.bestLapMs
        : best,
    null,
  );
  const fastestEntry =
    fastestMs !== null ? ordered.find((r) => !r.dnf && !r.dq && r.bestLapMs === fastestMs) : undefined;

  const nextStandings: Record<string, CareerStandingEntry> = { ...state.standings };
  let playerPos: number | null = null;
  let playerPts = 0;

  for (const r of ordered) {
    const key = r.isPlayer
      ? (Object.values(nextStandings).find((s) => s.isPlayer)?.code ?? r.driverCode)
      : r.driverCode;
    const prev: CareerStandingEntry = nextStandings[key] ?? {
      code: key,
      name: r.name || key,
      color: r.teamColorHex || "#8892b0",
      isPlayer: r.isPlayer,
      points: 0,
      wins: 0,
      podiums: 0,
      fastestLaps: 0,
      racesEntered: 0,
      bestFinish: null,
    };

    const isFl = fastestEntry?.driverCode === r.driverCode && fastestEntry?.isPlayer === r.isPlayer;
    const pts = pointsForResult(r, isFl);
    const classified = !r.dnf && !r.dq;

    if (r.isPlayer) {
      playerPos = classified ? r.position : null;
      playerPts = pts;
    }

    nextStandings[key] = {
      ...prev,
      name: r.isPlayer ? prev.name : r.name || prev.name,
      color: r.teamColorHex || prev.color,
      points: prev.points + pts,
      wins: prev.wins + (classified && r.position === 1 ? 1 : 0),
      podiums: prev.podiums + (classified && r.position <= 3 ? 1 : 0),
      fastestLaps: prev.fastestLaps + (isFl ? 1 : 0),
      racesEntered: prev.racesEntered + 1,
      bestFinish:
        classified && (prev.bestFinish === null || r.position < prev.bestFinish)
          ? r.position
          : prev.bestFinish,
    };
  }

  const winner = ordered.find((r) => !r.dnf && !r.dq && r.position === 1);
  const nextRounds = state.rounds.map((round, idx) =>
    idx === state.currentRoundIndex
      ? {
          ...round,
          completed: true,
          winnerCode: winner?.driverCode ?? null,
          playerPosition: playerPos,
          playerPointsEarned: playerPts,
          fastestLapCode: fastestEntry?.driverCode ?? null,
        }
      : round,
  );

  const nextIndex = state.currentRoundIndex + 1;
  const seasonCompleted = nextIndex >= nextRounds.length;

  const updated: CareerState = {
    ...state,
    currentRoundIndex: seasonCompleted ? state.currentRoundIndex : nextIndex,
    seasonCompleted,
    rounds: nextRounds,
    standings: nextStandings,
    lastUpdatedMs: Date.now(),
  };

  saveCareerState(updated);
  return updated;
}
