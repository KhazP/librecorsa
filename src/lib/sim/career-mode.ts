import type { DamageLevel } from "@/lib/sim/car-damage";
import type { QualifyingMinutes } from "@/lib/sim/qualifying";
import type { RaceAggression } from "@/lib/sim/race-setup";
import type { DriverProfile } from "@/lib/settings/player-settings";
import { circuitType, getTrackInfo, LISTED_TRACKS, venueKeyOf, type TrackInfo } from "@/lib/track-registry";
import type { RaceResultEntry } from "@/types/f1";

const CAREER_AI_SKILL_MIN = 20;
const CAREER_AI_SKILL_MAX = 100;

export type CareerTierId = "rookie" | "pro" | "champion";
export type CareerDistancePreset = "sprint" | "standard" | "feature" | "endurance";
export type CareerFacilityId = "aero" | "powertrain" | "tyres" | "chassis" | "pitCrew";
export type CareerSponsorObjectiveKind =
  | "top_8"
  | "top_5"
  | "podium"
  | "win"
  | "clean_race"
  | "fastest_lap"
  | "beat_teammate";

export interface CareerTier {
  id: CareerTierId;
  title: string;
  subtitle: string;
  aiSkill: number;
  opponents: number;
  laps: number;
  defaultRounds: number;
  qualifyingMinutes: QualifyingMinutes;
  aggression: RaceAggression;
  damage: DamageLevel;
  purseMultiplier: number;
}

export const CAREER_TIERS: readonly CareerTier[] = [
  {
    id: "rookie",
    title: "Club Cup",
    subtitle: "5 rivals · 65% AI · 5 min Quali · 4-lap races",
    aiSkill: 65,
    opponents: 5,
    laps: 4,
    defaultRounds: 5,
    qualifyingMinutes: 5,
    aggression: "normal",
    damage: "reduced",
    purseMultiplier: 1.0,
  },
  {
    id: "pro",
    title: "Pro Series",
    subtitle: "7 rivals · 82% AI · 5 min Quali · 6-lap races",
    aiSkill: 82,
    opponents: 7,
    laps: 6,
    defaultRounds: 7,
    qualifyingMinutes: 5,
    aggression: "normal",
    damage: "reduced",
    purseMultiplier: 1.45,
  },
  {
    id: "champion",
    title: "World Championship",
    subtitle: "11 rivals · 96% AI · 10 min Quali · 10-lap Grands Prix",
    aiSkill: 96,
    opponents: 11,
    laps: 10,
    defaultRounds: 10,
    qualifyingMinutes: 10,
    aggression: "hard",
    damage: "full",
    purseMultiplier: 2.0,
  },
];

export const CAREER_DISTANCE_PRESETS: readonly {
  id: CareerDistancePreset;
  label: string;
  scale: number;
  detail: string;
}[] = [
  { id: "sprint", label: "Sprint", scale: 0.7, detail: "Short intense heats (0.7× laps)" },
  { id: "standard", label: "Standard", scale: 1.0, detail: "Balanced championship distance (1.0× laps)" },
  { id: "feature", label: "Feature GP", scale: 1.6, detail: "Longer races with real tyre wear & pit stops (1.6× laps)" },
  { id: "endurance", label: "Long GP", scale: 2.4, detail: "Full strategy & pit-window endurance races (2.4× laps)" },
];

export interface CareerTeamDef {
  id: string;
  name: string;
  shortName: string;
  liveryId: string;
  primary: string;
  accent: string;
  tierLabel: string;
  teammateCode: string;
  teammateName: string;
  signingFee: number;
  salaryPerRound: number;
  podiumBonus: number;
  winBonus: number;
  carPerfDelta: number;
}

export const CAREER_TEAMS: readonly CareerTeamDef[] = [
  {
    id: "librecorsa",
    name: "LibreCorsa Factory",
    shortName: "LibreCorsa",
    liveryId: "librecorsa",
    primary: "#ccff00",
    accent: "#ff2a3c",
    tierLabel: "Works Entry",
    teammateCode: "VAN",
    teammateName: "K. Vance",
    signingFee: 0,
    salaryPerRound: 1200,
    podiumBonus: 800,
    winBonus: 1800,
    carPerfDelta: 0,
  },
  {
    id: "veridian",
    name: "Veridian Motorsport",
    shortName: "Veridian",
    liveryId: "grid26_emerald",
    primary: "#00594f",
    accent: "#cedc00",
    tierLabel: "Midfield Challenger",
    teammateCode: "ALO",
    teammateName: "F. Alonso-Rios",
    signingFee: 900,
    salaryPerRound: 1350,
    podiumBonus: 950,
    winBonus: 2000,
    carPerfDelta: 1,
  },
  {
    id: "azur",
    name: "Azur Motorsport",
    shortName: "Azur",
    liveryId: "grid26_bleu",
    primary: "#0074c8",
    accent: "#ff5fa2",
    tierLabel: "Works Challenger",
    teammateCode: "GAS",
    teammateName: "P. Gaslyne",
    signingFee: 1100,
    salaryPerRound: 1450,
    podiumBonus: 1000,
    winBonus: 2100,
    carPerfDelta: 1,
  },
  {
    id: "apex",
    name: "Apex Racing",
    shortName: "Apex",
    liveryId: "grid26_cobalt",
    primary: "#3c46c2",
    accent: "#ffd200",
    tierLabel: "Title Contender",
    teammateCode: "VER",
    teammateName: "M. Vermeer",
    signingFee: 1800,
    salaryPerRound: 1650,
    podiumBonus: 1150,
    winBonus: 2400,
    carPerfDelta: 2,
  },
  {
    id: "aether",
    name: "Aether Works",
    shortName: "Aether",
    liveryId: "grid26_silver",
    primary: "#c8d0d8",
    accent: "#00d2be",
    tierLabel: "Factory Contender",
    teammateCode: "RUS",
    teammateName: "G. Russell-Hill",
    signingFee: 2200,
    salaryPerRound: 1750,
    podiumBonus: 1250,
    winBonus: 2550,
    carPerfDelta: 2,
  },
  {
    id: "solaris",
    name: "Solaris GP",
    shortName: "Solaris",
    liveryId: "grid26_papaya",
    primary: "#ff7a00",
    accent: "#00b7ff",
    tierLabel: "Frontrunner",
    teammateCode: "NOR",
    teammateName: "L. Norton",
    signingFee: 2600,
    salaryPerRound: 1900,
    podiumBonus: 1350,
    winBonus: 2700,
    carPerfDelta: 3,
  },
  {
    id: "corsa",
    name: "Corsa Italiana",
    shortName: "Corsa",
    liveryId: "grid26_rosso",
    primary: "#dc0000",
    accent: "#ffd200",
    tierLabel: "Scuderia Giant",
    teammateCode: "LEC",
    teammateName: "C. Leclercq",
    signingFee: 3200,
    salaryPerRound: 2100,
    podiumBonus: 1500,
    winBonus: 3000,
    carPerfDelta: 3,
  },
  {
    id: "sovereign",
    name: "Sovereign Racing",
    shortName: "Sovereign",
    liveryId: "grid26_royal",
    primary: "#168be8",
    accent: "#f5a623",
    tierLabel: "Independent",
    teammateCode: "ALB",
    teammateName: "A. Albono",
    signingFee: 0,
    salaryPerRound: 1100,
    podiumBonus: 850,
    winBonus: 1850,
    carPerfDelta: 0,
  },
];

export interface CareerSponsorDef {
  id: string;
  name: string;
  tagline: string;
  signingBonus: number;
  payoutPerRound: number;
  objectiveKind: CareerSponsorObjectiveKind;
  objectiveLabel: string;
}

export const CAREER_SPONSORS: readonly CareerSponsorDef[] = [
  {
    id: "velox",
    name: "VELOX ENERGY",
    tagline: "Reliable points-finish partner",
    signingBonus: 600,
    payoutPerRound: 750,
    objectiveKind: "top_8",
    objectiveLabel: "Classify P8 or higher",
  },
  {
    id: "kronos",
    name: "KRONOS TIMING",
    tagline: "Precision driving & zero steward penalties",
    signingBonus: 700,
    payoutPerRound: 950,
    objectiveKind: "clean_race",
    objectiveLabel: "Finish with 0s time penalties",
  },
  {
    id: "apex_labs",
    name: "APEX LABS",
    tagline: "Performance engineering backing",
    signingBonus: 850,
    payoutPerRound: 1200,
    objectiveKind: "top_5",
    objectiveLabel: "Classify P5 or higher",
  },
  {
    id: "nova_cloud",
    name: "NOVA CLOUD",
    tagline: "Teammate & telemetry benchmark",
    signingBonus: 950,
    payoutPerRound: 1350,
    objectiveKind: "beat_teammate",
    objectiveLabel: "Beat your teammate to the flag",
  },
  {
    id: "monolith",
    name: "MONOLITH CAPITAL",
    tagline: "High-stakes podium & victory contract",
    signingBonus: 1300,
    payoutPerRound: 2100,
    objectiveKind: "podium",
    objectiveLabel: "Finish on the podium (P1–P3)",
  },
];

export interface CareerFacilityDef {
  id: CareerFacilityId;
  name: string;
  summary: string;
  maxLevel: number;
  costs: readonly number[];
  effectPerLevel: string;
}

export const CAREER_FACILITIES: readonly CareerFacilityDef[] = [
  {
    id: "aero",
    name: "CFD & Aero Lab",
    summary: "Refines wing efficiency and high-speed downforce balance.",
    maxLevel: 4,
    costs: [1400, 2400, 3800, 5600],
    effectPerLevel: "+1.0 car pace advantage vs field per level",
  },
  {
    id: "powertrain",
    name: "Powertrain Dyno",
    summary: "Improves ICE calibration and hybrid deployment harvesting.",
    maxLevel: 4,
    costs: [1500, 2600, 4000, 6000],
    effectPerLevel: "+1.0 car pace advantage vs field per level",
  },
  {
    id: "tyres",
    name: "Tyre Performance Lab",
    summary: "Optimizes thermal blankets & stint degradation models.",
    maxLevel: 4,
    costs: [1200, 2100, 3400, 5000],
    effectPerLevel: "+4% qualifying & stint racecraft edge per level",
  },
  {
    id: "chassis",
    name: "Chassis & Carbon Shop",
    summary: "Reinforces bodywork and speeds post-race component repairs.",
    maxLevel: 4,
    costs: [1100, 1900, 3000, 4500],
    effectPerLevel: "-18% post-race repair costs per level",
  },
  {
    id: "pitCrew",
    name: "Pit Crew Academy",
    summary: "Drills wheel-gun operators and jack crews for faster stops.",
    maxLevel: 4,
    costs: [1250, 2200, 3500, 5200],
    effectPerLevel: "+8% pit tyre change speed (down toward 1.8s)",
  },
];

export const F1_POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;

export interface CareerSettings {
  roundCount: number;
  distancePreset: CareerDistancePreset;
  qualifyingMinutes: QualifyingMinutes;
  aiSkill: number;
  aiAggression: RaceAggression;
  damage: DamageLevel;
  opponents: number;
}

export interface CareerRound {
  roundNumber: number;
  trackId: string;
  laps: number;
  completed: boolean;
  winnerCode: string | null;
  playerPosition: number | null;
  playerPointsEarned: number | null;
  qualifyingPosition?: number | null;
  qualifyingBestMs?: number | null;
}

export interface CareerDriverStanding {
  code: string;
  name: string;
  color: string;
  teamId: string;
  isPlayer: boolean;
  points: number;
  wins: number;
  podiums: number;
  fastestLaps: number;
  poles: number;
}

export interface CareerConstructorStanding {
  teamId: string;
  name: string;
  color: string;
  isPlayerTeam: boolean;
  points: number;
  wins: number;
  podiums: number;
}

export interface CareerRaceReport {
  roundNumber: number;
  trackId: string;
  position: number | null;
  gridPosition: number | null;
  pointsEarned: number;
  fastestLap: boolean;
  polePosition: boolean;
  cleanRace: boolean;
  prizeCredits: number;
  teamPayout: number;
  sponsorName: string | null;
  sponsorMet: boolean;
  sponsorPayout: number;
  repairCost: number;
  netCredits: number;
}

export interface CareerState {
  version: 2;
  tierId: CareerTierId;
  seasonNumber: number;
  currentRoundIndex: number;
  seasonCompleted: boolean;
  credits: number;
  reputation: number;
  teamId: string;
  sponsorId: string | null;
  claimedSponsorIds: string[];
  upgrades: Record<CareerFacilityId, number>;
  settings: CareerSettings;
  rounds: CareerRound[];
  standings: CareerDriverStanding[];
  lastRaceReport: CareerRaceReport | null;
}

export interface CareerModifiers {
  effectiveAiSkill: number;
  pitCrewBonusPct: number;
  repairDiscountPct: number;
  totalFacilityLevels: number;
}

const CAREER_STORAGE_KEY_V2 = "librecorsa_career_v2";
const CAREER_STORAGE_KEY_V1 = "librecorsa_career_v1";

const CAREER_AI_ROSTER: readonly {
  code: string;
  name: string;
  color: string;
  teamId: string;
}[] = [
  { code: "VER", name: "M. Vermeer", color: "#3c46c2", teamId: "apex" },
  { code: "NOR", name: "L. Norton", color: "#ff7a00", teamId: "solaris" },
  { code: "LEC", name: "C. Leclercq", color: "#dc0000", teamId: "corsa" },
  { code: "RUS", name: "G. Russell-Hill", color: "#00d2be", teamId: "aether" },
  { code: "PIA", name: "O. Piastra", color: "#ff9f43", teamId: "solaris" },
  { code: "SAI", name: "C. Sainz-Vega", color: "#c81e30", teamId: "corsa" },
  { code: "ALO", name: "F. Alonso-Rios", color: "#00594f", teamId: "veridian" },
  { code: "GAS", name: "P. Gaslyne", color: "#0074c8", teamId: "azur" },
  { code: "ALB", name: "A. Albono", color: "#168be8", teamId: "sovereign" },
  { code: "VAN", name: "K. Vance", color: "#ccff00", teamId: "librecorsa" },
  { code: "HAM", name: "L. Hamilstone", color: "#14161c", teamId: "aether" },
  { code: "ANT", name: "K. Antonelli", color: "#e8002d", teamId: "apex" },
];

const INITIAL_CREDITS = 2500;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function getCareerTier(tierId: CareerTierId): CareerTier {
  return CAREER_TIERS.find((t) => t.id === tierId) ?? CAREER_TIERS[0];
}

export function getCareerTeam(teamId: string): CareerTeamDef {
  return CAREER_TEAMS.find((t) => t.id === teamId) ?? CAREER_TEAMS[0];
}

export function getCareerSponsor(sponsorId: string | null): CareerSponsorDef | null {
  if (!sponsorId) return null;
  return CAREER_SPONSORS.find((s) => s.id === sponsorId) ?? null;
}

export function defaultCareerSettingsForTier(tier: CareerTier): CareerSettings {
  return {
    roundCount: tier.defaultRounds,
    distancePreset: "standard",
    qualifyingMinutes: tier.qualifyingMinutes,
    aiSkill: tier.aiSkill,
    aiAggression: tier.aggression,
    damage: tier.damage,
    opponents: tier.opponents,
  };
}

export function getCareerModifiers(state: CareerState): CareerModifiers {
  const team = getCareerTeam(state.teamId);
  const aero = clamp(state.upgrades.aero ?? 0, 0, 4);
  const power = clamp(state.upgrades.powertrain ?? 0, 0, 4);
  const tyres = clamp(state.upgrades.tyres ?? 0, 0, 4);
  const chassis = clamp(state.upgrades.chassis ?? 0, 0, 4);
  const pitCrew = clamp(state.upgrades.pitCrew ?? 0, 0, 4);

  const devOffset = Math.round(aero * 1.0 + power * 1.0 + tyres * 0.5 + team.carPerfDelta);
  const effectiveAiSkill = clamp(state.settings.aiSkill - devOffset, CAREER_AI_SKILL_MIN, CAREER_AI_SKILL_MAX);
  const pitCrewBonusPct = Math.round(pitCrew * 0.08 * 100) / 100; // up to 0.32 (32% faster stop delta)
  const repairDiscountPct = Math.round(chassis * 0.18 * 100) / 100; // up to 0.72 (72% discount)

  return {
    effectiveAiSkill,
    pitCrewBonusPct,
    repairDiscountPct,
    totalFacilityLevels: aero + power + tyres + chassis + pitCrew,
  };
}

export function scaleCareerLaps(
  baseLaps: number,
  trackLengthM: number,
  preset: CareerDistancePreset
): number {
  const presetDef =
    CAREER_DISTANCE_PRESETS.find((p) => p.id === preset) ?? CAREER_DISTANCE_PRESETS[1];
  const refLenM = 4600;
  const lengthRatio = clamp(Math.sqrt(refLenM / Math.max(1500, trackLengthM)), 0.62, 1.38);
  const scaled = Math.round(baseLaps * presetDef.scale * lengthRatio);
  return clamp(scaled, 2, 35);
}

/**
 * Returns one primary circuit per unique physical venue (excluding hill climbs),
 * prioritizing distinct international venues so Career rounds never repeat the same track.
 */
export function getCareerEligibleTracks(): TrackInfo[] {
  const seenVenues = new Set<string>();
  const unique: TrackInfo[] = [];
  for (const t of LISTED_TRACKS) {
    if (circuitType(t) === "hillclimb") continue;
    const key = venueKeyOf(t);
    if (seenVenues.has(key)) continue;
    seenVenues.add(key);
    unique.push(t);
  }
  // Prefer GP layout of RISE Motordrome first when available
  const rwandaGpIdx = unique.findIndex((t) => t.id === "rwanda_official");
  if (rwandaGpIdx > 0) {
    const [rwanda] = unique.splice(rwandaGpIdx, 1);
    unique.unshift(rwanda);
  }
  return unique.length > 0 ? unique : LISTED_TRACKS.slice();
}

export function buildCalendarRounds(
  tier: CareerTier,
  settings: CareerSettings,
  existingRounds?: readonly CareerRound[]
): CareerRound[] {
  const pool = getCareerEligibleTracks();
  const count = clamp(Math.round(settings.roundCount), 4, 12);
  const rounds: CareerRound[] = [];

  for (let i = 0; i < count; i++) {
    const prev = existingRounds?.[i];
    if (prev && prev.completed) {
      rounds.push({ ...prev, roundNumber: i + 1 });
      continue;
    }
    const preferredTrackId = prev?.trackId;
    const matched = preferredTrackId ? getTrackInfo(preferredTrackId) : null;
    const track =
      matched && matched.id === preferredTrackId && circuitType(matched) !== "hillclimb"
        ? matched
        : pool[i % pool.length];
    rounds.push({
      roundNumber: i + 1,
      trackId: track.id,
      laps: scaleCareerLaps(tier.laps, track.lengthM, settings.distancePreset),
      completed: false,
      winnerCode: null,
      playerPosition: null,
      playerPointsEarned: null,
      qualifyingPosition: null,
      qualifyingBestMs: null,
    });
  }

  return rounds;
}

function buildDriverStandings(
  profile: Pick<DriverProfile, "code" | "name" | "color">,
  teamId: string,
  opponents: number
): CareerDriverStanding[] {
  const team = getCareerTeam(teamId);
  const player: CareerDriverStanding = {
    code: profile.code,
    name: profile.name,
    color: profile.color,
    teamId: team.id,
    isPlayer: true,
    points: 0,
    wins: 0,
    podiums: 0,
    fastestLaps: 0,
    poles: 0,
  };

  // Pick rivals without duplicating player's code; ensure teammate is represented if space allows
  const desiredCount = clamp(Math.round(opponents), 3, 11);
  const pool = CAREER_AI_ROSTER.filter((d) => d.code !== profile.code);
  const teammate = pool.find((d) => d.teamId === team.id);
  const ordered = teammate
    ? [teammate, ...pool.filter((d) => d !== teammate)]
    : pool;
  const rivals: CareerDriverStanding[] = ordered.slice(0, desiredCount).map((d) => ({
    code: d.code,
    name: d.name,
    color: d.color,
    teamId: d.teamId,
    isPlayer: false,
    points: 0,
    wins: 0,
    podiums: 0,
    fastestLaps: 0,
    poles: 0,
  }));

  return [player, ...rivals];
}

export function createInitialCareerState(
  tierId: CareerTierId,
  profile: DriverProfile,
  seasonNumber = 1,
  carryover?: Pick<CareerState, "credits" | "reputation" | "teamId" | "upgrades">
): CareerState {
  const tier = getCareerTier(tierId);
  const teamId = carryover?.teamId ?? CAREER_TEAMS[0].id;
  const settings = defaultCareerSettingsForTier(tier);
  return {
    version: 2,
    tierId: tier.id,
    seasonNumber,
    currentRoundIndex: 0,
    seasonCompleted: false,
    credits: carryover?.credits ?? INITIAL_CREDITS,
    reputation: carryover?.reputation ?? 100,
    teamId,
    sponsorId: "velox",
    claimedSponsorIds: ["velox"],
    upgrades: carryover?.upgrades
      ? { ...carryover.upgrades }
      : { aero: 0, powertrain: 0, tyres: 0, chassis: 0, pitCrew: 0 },
    settings,
    rounds: buildCalendarRounds(tier, settings),
    standings: buildDriverStandings(profile, teamId, settings.opponents),
    lastRaceReport: null,
  };
}

export function sortedCareerStandings(career: CareerState): CareerDriverStanding[] {
  return [...career.standings].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.podiums !== a.podiums) return b.podiums - a.podiums;
    if (a.isPlayer !== b.isPlayer) return a.isPlayer ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function sortedConstructorStandings(career: CareerState): CareerConstructorStanding[] {
  const map = new Map<string, CareerConstructorStanding>();
  for (const s of career.standings) {
    const team = getCareerTeam(s.teamId);
    const cur = map.get(team.id) ?? {
      teamId: team.id,
      name: team.name,
      color: team.primary,
      isPlayerTeam: team.id === career.teamId,
      points: 0,
      wins: 0,
      podiums: 0,
    };
    cur.points += s.points;
    cur.wins += s.wins;
    cur.podiums += s.podiums;
    if (s.isPlayer) cur.isPlayerTeam = true;
    map.set(team.id, cur);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.podiums !== a.podiums) return b.podiums - a.podiums;
    if (a.isPlayerTeam !== b.isPlayerTeam) return a.isPlayerTeam ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function syncPlayerIntoCareer(state: CareerState, profile: DriverProfile): CareerState {
  const idx = state.standings.findIndex((s) => s.isPlayer);
  if (idx < 0) return state;
  const cur = state.standings[idx];
  if (
    cur.code === profile.code &&
    cur.name === profile.name &&
    cur.color === profile.color &&
    cur.teamId === state.teamId
  ) {
    return state;
  }
  const nextStandings = [...state.standings];
  nextStandings[idx] = {
    ...cur,
    code: profile.code,
    name: profile.name,
    color: profile.color,
    teamId: state.teamId,
  };
  return { ...state, standings: nextStandings };
}

export function updateCareerSettings(
  state: CareerState,
  patch: Partial<CareerSettings>,
  profile?: DriverProfile
): CareerState {
  const tier = getCareerTier(state.tierId);
  const nextSettings: CareerSettings = {
    ...state.settings,
    ...patch,
    roundCount: clamp(Math.round(patch.roundCount ?? state.settings.roundCount), 4, 12),
    aiSkill: clamp(Math.round(patch.aiSkill ?? state.settings.aiSkill), 20, CAREER_AI_SKILL_MAX),
    opponents: clamp(Math.round(patch.opponents ?? state.settings.opponents), 3, 11),
  };

  let rounds = state.rounds;
  if (
    patch.roundCount !== undefined ||
    patch.distancePreset !== undefined
  ) {
    rounds = buildCalendarRounds(tier, nextSettings, state.rounds);
  }

  let standings = state.standings;
  if (patch.opponents !== undefined) {
    const existingByCode = new Map(standings.map((s) => [s.code, s]));
    const playerStanding = standings.find((s) => s.isPlayer);
    const activeProfile: Pick<DriverProfile, "code" | "name" | "color"> = profile ?? {
      code: playerStanding?.code ?? "DRV",
      name: playerStanding?.name ?? "Driver",
      color: playerStanding?.color ?? "#ccff00",
    };
    standings = buildDriverStandings(activeProfile, state.teamId, nextSettings.opponents).map((row) => {
      const prev = row.isPlayer ? playerStanding : existingByCode.get(row.code);
      return prev
        ? {
            ...row,
            points: prev.points,
            wins: prev.wins,
            podiums: prev.podiums,
            fastestLaps: prev.fastestLaps,
            poles: prev.poles,
          }
        : row;
    });
  }

  const nextIdx = Math.min(state.currentRoundIndex, Math.max(0, rounds.length - 1));
  const allDone = rounds.length > 0 && rounds.every((r) => r.completed);
  const next: CareerState = {
    ...state,
    settings: nextSettings,
    rounds,
    standings,
    currentRoundIndex: nextIdx,
    seasonCompleted: allDone,
  };
  saveCareerState(next);
  return next;
}

export function setCareerRoundTrack(
  state: CareerState,
  roundIndex: number,
  trackId: string
): CareerState {
  const round = state.rounds[roundIndex];
  if (!round || round.completed) return state;
  const info = getTrackInfo(trackId);
  if (info.id !== trackId || circuitType(info) === "hillclimb") return state;
  const tier = getCareerTier(state.tierId);
  const nextRounds = state.rounds.map((r, idx) =>
    idx === roundIndex
      ? {
          ...r,
          trackId: info.id,
          laps: scaleCareerLaps(tier.laps, info.lengthM, state.settings.distancePreset),
        }
      : r
  );
  const next: CareerState = { ...state, rounds: nextRounds };
  saveCareerState(next);
  return next;
}

export function signCareerTeam(state: CareerState, teamId: string): CareerState {
  if (state.teamId === teamId) return state;
  const team = getCareerTeam(teamId);
  if (state.credits < team.signingFee) return state;
  const nextStandings = state.standings.map((s) =>
    s.isPlayer ? { ...s, teamId: team.id } : s
  );
  const next: CareerState = {
    ...state,
    teamId: team.id,
    credits: state.credits - team.signingFee,
    standings: nextStandings,
  };
  saveCareerState(next);
  return next;
}

export function signCareerSponsor(state: CareerState, sponsorId: string): CareerState {
  const sponsor = getCareerSponsor(sponsorId);
  if (!sponsor || state.sponsorId === sponsorId) return state;
  const alreadyClaimed = state.claimedSponsorIds.includes(sponsor.id);
  const bonus = alreadyClaimed ? 0 : sponsor.signingBonus;
  const next: CareerState = {
    ...state,
    sponsorId: sponsor.id,
    credits: state.credits + bonus,
    claimedSponsorIds: alreadyClaimed
      ? state.claimedSponsorIds
      : [...state.claimedSponsorIds, sponsor.id],
  };
  saveCareerState(next);
  return next;
}

export function upgradeCareerFacility(state: CareerState, facilityId: CareerFacilityId): CareerState {
  const def = CAREER_FACILITIES.find((f) => f.id === facilityId);
  if (!def) return state;
  const currentLvl = state.upgrades[facilityId] ?? 0;
  if (currentLvl >= def.maxLevel) return state;
  const cost = def.costs[currentLvl];
  if (state.credits < cost) return state;
  const next: CareerState = {
    ...state,
    credits: state.credits - cost,
    reputation: state.reputation + 15,
    upgrades: {
      ...state.upgrades,
      [facilityId]: currentLvl + 1,
    },
  };
  saveCareerState(next);
  return next;
}

export function saveCareerState(state: CareerState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAREER_STORAGE_KEY_V2, JSON.stringify(state));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export function loadCareerState(profile: DriverProfile): CareerState {
  if (typeof window === "undefined") {
    return createInitialCareerState("rookie", profile);
  }
  try {
    const rawV2 = window.localStorage.getItem(CAREER_STORAGE_KEY_V2);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as Partial<CareerState>;
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(parsed.rounds) &&
        Array.isArray(parsed.standings) &&
        parsed.rounds.length > 0
      ) {
        const tierId: CareerTierId =
          parsed.tierId === "rookie" || parsed.tierId === "pro" || parsed.tierId === "champion"
            ? parsed.tierId
            : "rookie";
        const tier = getCareerTier(tierId);
        const defaults = defaultCareerSettingsForTier(tier);
        const teamId = getCareerTeam(parsed.teamId ?? "librecorsa").id;
        const hydrated: CareerState = {
          version: 2,
          tierId,
          seasonNumber: typeof parsed.seasonNumber === "number" && parsed.seasonNumber >= 1 ? parsed.seasonNumber : 1,
          currentRoundIndex:
            typeof parsed.currentRoundIndex === "number" && parsed.currentRoundIndex >= 0
              ? Math.min(parsed.currentRoundIndex, parsed.rounds.length - 1)
              : 0,
          seasonCompleted: Boolean(parsed.seasonCompleted),
          credits: typeof parsed.credits === "number" && Number.isFinite(parsed.credits) ? Math.max(0, Math.round(parsed.credits)) : INITIAL_CREDITS,
          reputation: typeof parsed.reputation === "number" && Number.isFinite(parsed.reputation) ? Math.max(0, Math.round(parsed.reputation)) : 100,
          teamId,
          sponsorId: typeof parsed.sponsorId === "string" ? parsed.sponsorId : null,
          claimedSponsorIds: Array.isArray(parsed.claimedSponsorIds) ? parsed.claimedSponsorIds : [],
          upgrades: {
            aero: clamp(parsed.upgrades?.aero ?? 0, 0, 4),
            powertrain: clamp(parsed.upgrades?.powertrain ?? 0, 0, 4),
            tyres: clamp(parsed.upgrades?.tyres ?? 0, 0, 4),
            chassis: clamp(parsed.upgrades?.chassis ?? 0, 0, 4),
            pitCrew: clamp(parsed.upgrades?.pitCrew ?? 0, 0, 4),
          },
          settings: {
            ...defaults,
            ...(parsed.settings ?? {}),
            roundCount: clamp(parsed.settings?.roundCount ?? parsed.rounds.length, 4, 12),
            aiSkill: clamp(parsed.settings?.aiSkill ?? defaults.aiSkill, 20, CAREER_AI_SKILL_MAX),
            opponents: clamp(parsed.settings?.opponents ?? defaults.opponents, 3, 11),
          },
          rounds: parsed.rounds,
          standings: parsed.standings.map((s) => ({
            ...s,
            teamId: s.teamId ?? (s.isPlayer ? teamId : "apex"),
            poles: s.poles ?? 0,
          })),
          lastRaceReport: parsed.lastRaceReport ?? null,
        };
        return syncPlayerIntoCareer(hydrated, profile);
      }
    }

    // Migrate legacy v1 state seamlessly onto multi-venue v2
    const rawV1 = window.localStorage.getItem(CAREER_STORAGE_KEY_V1);
    if (rawV1) {
      const legacy = JSON.parse(rawV1) as { tierId?: CareerTierId; seasonNumber?: number };
      const tierId: CareerTierId =
        legacy?.tierId === "rookie" || legacy?.tierId === "pro" || legacy?.tierId === "champion"
          ? legacy.tierId
          : "rookie";
      const fresh = createInitialCareerState(tierId, profile, legacy?.seasonNumber ?? 1);
      saveCareerState(fresh);
      return fresh;
    }
    return createInitialCareerState("rookie", profile);
  } catch {
    return createInitialCareerState("rookie", profile);
  }
}

export function recordCareerRoundResult(state: CareerState, results: readonly RaceResultEntry[]): CareerState {
  if (state.seasonCompleted || state.rounds.length === 0) return state;
  const roundIdx = Math.min(Math.max(0, state.currentRoundIndex), state.rounds.length - 1);
  const currentRound = state.rounds[roundIdx];
  if (!currentRound || currentRound.completed) return state;

  const tier = getCareerTier(state.tierId);
  const team = getCareerTeam(state.teamId);
  const sponsor = getCareerSponsor(state.sponsorId);
  const mods = getCareerModifiers(state);

  const classified = [...results].sort((a, b) => a.position - b.position);

  let fastestKey: string | null = null;
  let fastestMs = Infinity;
  for (const r of classified) {
    if (!r.dnf && !r.dq && r.bestLapMs !== null && r.bestLapMs > 0 && r.bestLapMs < fastestMs) {
      fastestMs = r.bestLapMs;
      fastestKey = r.isPlayer ? "__PLAYER__" : r.driverCode;
    }
  }

  const standings = state.standings.map((s) => ({ ...s }));
  const playerRow = classified.find((r) => r.isPlayer);
  let playerPointsEarned = 0;

  const aiStandings = standings.filter((s) => !s.isPlayer);
  const aiResults = classified.filter((r) => !r.isPlayer);

  const awardEntry = (standing: CareerDriverStanding, entry: RaceResultEntry, isFastest: boolean) => {
    if (entry.gridPosition === 1) standing.poles += 1;
    if (entry.dnf || entry.dq) return 0;
    const basePts = entry.position >= 1 && entry.position <= F1_POINTS_TABLE.length ? F1_POINTS_TABLE[entry.position - 1] : 0;
    const flBonus = isFastest && entry.position <= 10 ? 1 : 0;
    const pts = basePts + flBonus;
    standing.points += pts;
    if (entry.position === 1) standing.wins += 1;
    if (entry.position <= 3) standing.podiums += 1;
    if (isFastest) standing.fastestLaps += 1;
    return pts;
  };

  const playerIsFastest = fastestKey === "__PLAYER__";
  if (playerRow) {
    const playerStanding = standings.find((s) => s.isPlayer);
    if (playerStanding) {
      playerPointsEarned = awardEntry(playerStanding, playerRow, playerIsFastest);
    }
  }

  for (let i = 0; i < aiStandings.length && i < aiResults.length; i++) {
    const r = aiResults[i];
    const target = aiStandings.find((s) => s.code === r.driverCode) ?? aiStandings[i];
    awardEntry(target, r, fastestKey === r.driverCode);
  }

  // Economy & sponsorship payouts
  const classifiedPos = playerRow && !playerRow.dnf && !playerRow.dq ? playerRow.position : null;
  const polePosition = playerRow?.gridPosition === 1;
  const cleanRace = Boolean(playerRow && !playerRow.dnf && !playerRow.dq && (playerRow.penaltyS ?? 0) <= 0);

  const basePrize =
    classifiedPos !== null
      ? Math.round(Math.max(180, (12 - classifiedPos) * 145) * tier.purseMultiplier)
      : 100;
  const poleBonus = polePosition ? 250 : 0;
  const flCash = playerIsFastest ? 200 : 0;
  const prizeCredits = basePrize + poleBonus + flCash;

  const teamPayout =
    team.salaryPerRound +
    (classifiedPos === 1 ? team.winBonus : classifiedPos !== null && classifiedPos <= 3 ? team.podiumBonus : 0);

  const teammateResult = aiResults.find((r) => r.driverCode === team.teammateCode);
  let sponsorMet = false;
  if (sponsor && classifiedPos !== null) {
    switch (sponsor.objectiveKind) {
      case "top_8":
        sponsorMet = classifiedPos <= 8;
        break;
      case "top_5":
        sponsorMet = classifiedPos <= 5;
        break;
      case "podium":
        sponsorMet = classifiedPos <= 3;
        break;
      case "win":
        sponsorMet = classifiedPos === 1;
        break;
      case "clean_race":
        sponsorMet = cleanRace;
        break;
      case "fastest_lap":
        sponsorMet = playerIsFastest;
        break;
      case "beat_teammate":
        sponsorMet = !teammateResult || teammateResult.dnf || classifiedPos < teammateResult.position;
        break;
    }
  }
  const sponsorPayout = sponsor && sponsorMet ? sponsor.payoutPerRound : 0;

  const rawRepair = playerRow?.dnf ? 450 : (playerRow?.penaltyS ?? 0) > 0 ? 120 : 60;
  const repairCost = Math.round(rawRepair * (1 - mods.repairDiscountPct));
  const netCredits = prizeCredits + teamPayout + sponsorPayout - repairCost;

  const repDelta =
    (classifiedPos === 1 ? 35 : classifiedPos !== null && classifiedPos <= 3 ? 22 : classifiedPos !== null && classifiedPos <= 6 ? 12 : 4) +
    (sponsorMet ? 10 : 0) +
    (cleanRace ? 5 : -4);

  const winner = classified.find((r) => !r.dnf && !r.dq) ?? classified[0];
  const nextRounds = state.rounds.map((r, idx) =>
    idx === roundIdx
      ? {
          ...r,
          completed: true,
          winnerCode: winner ? (winner.isPlayer ? standings.find((s) => s.isPlayer)?.code ?? winner.driverCode : winner.driverCode) : null,
          playerPosition: classifiedPos,
          playerPointsEarned,
          qualifyingPosition: playerRow?.gridPosition ?? null,
        }
      : r
  );

  const isLastRound = roundIdx >= nextRounds.length - 1;
  const nextState: CareerState = {
    ...state,
    credits: Math.max(0, state.credits + netCredits),
    reputation: Math.max(0, state.reputation + repDelta),
    standings,
    rounds: nextRounds,
    currentRoundIndex: isLastRound ? roundIdx : roundIdx + 1,
    seasonCompleted: isLastRound,
    lastRaceReport: {
      roundNumber: currentRound.roundNumber,
      trackId: currentRound.trackId,
      position: classifiedPos,
      gridPosition: playerRow?.gridPosition ?? null,
      pointsEarned: playerPointsEarned,
      fastestLap: playerIsFastest,
      polePosition,
      cleanRace,
      prizeCredits,
      teamPayout,
      sponsorName: sponsor?.name ?? null,
      sponsorMet,
      sponsorPayout,
      repairCost,
      netCredits,
    },
  };
  saveCareerState(nextState);
  return nextState;
}
