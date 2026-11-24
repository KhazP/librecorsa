export interface TeamFounderProgress {
  racesCompleted: number;
  totalDistanceM: number;
}

export function loadFounderProgress(): TeamFounderProgress {
  if (typeof window === "undefined") return { racesCompleted: 0, totalDistanceM: 0 };
  try {
    const raw = window.localStorage.getItem("lc_driver_stats_v1");
    if (raw) {
      const p = JSON.parse(raw) as Partial<TeamFounderProgress>;
      if (Number.isFinite(p.racesCompleted) || Number.isFinite(p.totalDistanceM)) {
        return {
          racesCompleted: Number(p.racesCompleted ?? 0),
          totalDistanceM: Number(p.totalDistanceM ?? 0),
        };
      }
    }
  } catch {
    // ignore storage errors
  }
  return { racesCompleted: 0, totalDistanceM: 0 };
}

export type TeamJoinMode = "open" | "invite";

export const TEAM_CREATE_MIN_RACES = 3;
export const TEAM_CREATE_MIN_DISTANCE_M = 25_000;
export const TEAM_MIN_MEMBERS = 2;
export const TEAM_MAX_MEMBERS = 24;
export const DEFAULT_TEAM_MAX_MEMBERS = 8;

export interface TeamMember {
  code: string;
  name: string;
  role: "owner" | "member";
  joinedAtMs: number;
}

export interface RacingTeam {
  id: string;
  name: string;
  tag: string;
  description: string;
  colorHex: string;
  ownerCode: string;
  joinMode: TeamJoinMode;
  maxMembers: number;
  inviteCode: string;
  members: TeamMember[];
  totalDistanceM: number;
  totalRaces: number;
  createdAtMs: number;
}

const TEAMS_KEY = "lc_teams_v1";

export function generateInviteCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "X");
}

export function clampMaxMembers(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TEAM_MAX_MEMBERS;
  return Math.max(TEAM_MIN_MEMBERS, Math.min(TEAM_MAX_MEMBERS, Math.round(n)));
}

export function canCreateTeam(stats: TeamFounderProgress): {
  eligible: boolean;
  racesRemaining: number;
  kmRemaining: number;
} {
  const racesRemaining = Math.max(0, TEAM_CREATE_MIN_RACES - stats.racesCompleted);
  const kmRemaining = Math.max(0, (TEAM_CREATE_MIN_DISTANCE_M - stats.totalDistanceM) / 1000);
  return {
    eligible: racesRemaining === 0 && kmRemaining <= 0,
    racesRemaining,
    kmRemaining,
  };
}

export function loadTeams(): RacingTeam[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TEAMS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Partial<RacingTeam>[]).map((t) => ({
      id: String(t.id ?? `team_${Date.now().toString(36)}`),
      name: String(t.name ?? "LibreCorsa Racing"),
      tag: String(t.tag ?? "LCR"),
      description: String(t.description ?? ""),
      colorHex: String(t.colorHex ?? "#ccff00"),
      ownerCode: String(t.ownerCode ?? "DRV"),
      joinMode: t.joinMode === "invite" ? "invite" : "open",
      maxMembers: clampMaxMembers(Number(t.maxMembers ?? DEFAULT_TEAM_MAX_MEMBERS)),
      inviteCode: String(t.inviteCode ?? generateInviteCode()),
      members: Array.isArray(t.members) ? t.members : [],
      totalDistanceM: Number(t.totalDistanceM ?? 0),
      totalRaces: Number(t.totalRaces ?? 0),
      createdAtMs: Number(t.createdAtMs ?? Date.now()),
    }));
  } catch {
    return [];
  }
}

export function saveTeams(teams: readonly RacingTeam[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TEAMS_KEY, JSON.stringify(teams));
  } catch {
    // ignore quota errors
  }
}

export function getPlayerTeam(playerCode: string): RacingTeam | null {
  const teams = loadTeams();
  return teams.find((t) => t.members.some((m) => m.code === playerCode)) ?? null;
}

export function recordTeamProgress(playerCode: string, distanceM: number, racesDelta: number): void {
  if (typeof window === "undefined") return;
  if (distanceM <= 0 && racesDelta <= 0) return;
  const teams = loadTeams();
  let changed = false;
  const next = teams.map((t) => {
    if (!t.members.some((m) => m.code === playerCode)) return t;
    changed = true;
    return {
      ...t,
      totalDistanceM: t.totalDistanceM + Math.max(0, distanceM),
      totalRaces: t.totalRaces + Math.max(0, racesDelta),
    };
  });
  if (changed) saveTeams(next);
}

export function createTeam(
  name: string,
  tag: string,
  description: string,
  colorHex: string,
  owner: { code: string; name: string },
  options?: { joinMode?: TeamJoinMode; maxMembers?: number },
): RacingTeam {
  return {
    id: `team_${Date.now().toString(36)}`,
    name: name.trim().slice(0, 32) || "LibreCorsa Racing",
    tag: tag.trim().toUpperCase().slice(0, 4) || "LCR",
    description: description.trim().slice(0, 140),
    colorHex: /^#[0-9a-fA-F]{6}$/.test(colorHex) ? colorHex : "#ccff00",
    ownerCode: owner.code,
    joinMode: options?.joinMode === "invite" ? "invite" : "open",
    maxMembers: clampMaxMembers(options?.maxMembers ?? DEFAULT_TEAM_MAX_MEMBERS),
    inviteCode: generateInviteCode(),
    members: [{ code: owner.code, name: owner.name, role: "owner", joinedAtMs: Date.now() }],
    totalDistanceM: 0,
    totalRaces: 0,
    createdAtMs: Date.now(),
  };
}
