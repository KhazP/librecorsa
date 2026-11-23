import * as THREE from "three";
import {
  fetchBadges,
  filterBadgesForContext,
  groupBoardsByClass,
  roomNameBadges,
  sortBadges,
  type BadgeContext,
  type BadgeType,
  type DriverBadge,
} from "@/lib/net/awards";
import { VEHICLE_CLASS_META } from "@/lib/cars/vehicle-class";
import { driverNameKey } from "@/lib/net/board-client";
import type { RaceStandingEntry, RaceStatus } from "@/types/f1";

const NAMEPLATE_BADGE_SHORT: Record<BadgeType, string> = {
  weekly_gold: "G",
  weekly_silver: "S",
  weekly_bronze: "B",
  track_record: "FL",
  og: "OG",
  bulb: "IDEA",
  // Never shown: a room's names are unchecked, so the cache below drops the Creator (awards.ts roomNameBadges)
  creator: "DEV",
};

function sameBadgeContext(a: BadgeContext, b: BadgeContext): boolean {
  if (a.scope !== b.scope) return false;
  if (a.scope === "vehicle" && b.scope === "vehicle") return a.vehicle === b.vehicle;
  if (a.scope === "class" && b.scope === "class") return a.classId === b.classId;
  return true;
}

/**
 * Concise uppercase chip codes for overhead nameplates ("G", "G×2", "S", "B", "FL·F1×3", "FL×2", "OG", "IDEA").
 * When `context` narrows to a vehicle or car class, Fastest Lap counts follow that room's car/class.
 */
export function formatNameplateBadges(badges: readonly DriverBadge[], context?: BadgeContext): string[] {
  const visible = filterBadgesForContext(badges, context);
  if (visible.length === 0) return [];
  return sortBadges(visible).map((b) => {
    const short = NAMEPLATE_BADGE_SHORT[b.type];
    if (b.type === "track_record" && (!context || context.scope === "all")) {
      const classes = groupBoardsByClass(b.boards);
      if (classes.length === 1) {
        const tag = `${short}·${VEHICLE_CLASS_META[classes[0].classId].short.toUpperCase()}`;
        return b.count > 1 ? `${tag}×${b.count}` : tag;
      }
    }
    return b.count > 1 ? `${short}×${b.count}` : short;
  });
}

export type NameplateBadgeFetcher = (names: readonly string[]) => Promise<Record<string, DriverBadge[]>>;

/**
 * In-memory cache of formatted overhead nameplate badge codes keyed by `driverNameKey`.
 * Batch-fetches unseen remote player names once per name change (never called inside the render loop)
 * and skips AI peers, ghosts, and offline/empty responses. Re-formats cached badges synchronously when
 * the multiplayer room's vehicle/class context changes.
 */
export class NameplateBadgeCache {
  private readonly rawByNameKey = new Map<string, readonly DriverBadge[]>();
  private readonly byNameKey = new Map<string, readonly string[]>();
  private readonly requestedKeys = new Set<string>();
  private context: BadgeContext = { scope: "all" };
  private disposed = false;

  constructor(private readonly fetcher: NameplateBadgeFetcher = fetchBadges) {}

  /** Read-only view of resolved badge codes by normalized driver name key */
  get map(): ReadonlyMap<string, readonly string[]> {
    return this.byNameKey;
  }

  /** Updates the car/class scope used to format Fastest Lap badges on overhead nameplates */
  setContext(next: BadgeContext): void {
    if (this.disposed || sameBadgeContext(this.context, next)) return;
    this.context = next;
    this.byNameKey.clear();
    for (const [key, list] of this.rawByNameKey) {
      const codes = formatNameplateBadges(list, this.context);
      if (codes.length > 0) this.byNameKey.set(key, codes);
    }
  }

  /** Synchronously returns cached badge codes for a driver name, or undefined if none/unloaded */
  get(name: string | undefined): readonly string[] | undefined {
    if (!name || this.byNameKey.size === 0) return undefined;
    return this.byNameKey.get(driverNameKey(name));
  }

  /**
   * Batch-fetches badges for any unseen non-AI, non-ghost peer names.
   * Returns a promise resolving once the triggered batch completes, or null when nothing needed fetching.
   */
  syncPeers(peers: readonly Pick<NameplatePeerInput, "name" | "isAiPeer" | "ghost">[]): Promise<void> | null {
    if (this.disposed || peers.length === 0) return null;
    const missing: string[] = [];
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      if (p.isAiPeer || p.ghost || !p.name) continue;
      const key = driverNameKey(p.name);
      if (!key || this.requestedKeys.has(key)) continue;
      this.requestedKeys.add(key);
      missing.push(p.name);
    }
    return this.fetchMissing(missing);
  }

  /** Batch-fetches badges for unseen human driver names (e.g. online lobby members) */
  syncNames(names: readonly (string | undefined)[]): Promise<void> | null {
    if (this.disposed || names.length === 0) return null;
    const missing: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!name) continue;
      const key = driverNameKey(name);
      if (!key || this.requestedKeys.has(key)) continue;
      this.requestedKeys.add(key);
      missing.push(name);
    }
    return this.fetchMissing(missing);
  }

  private fetchMissing(missing: string[]): Promise<void> | null {
    if (missing.length === 0) return null;
    return this.fetcher(missing)
      .then((res) => {
        if (this.disposed || !res) return;
        for (const [key, fetched] of Object.entries(res)) {
          const list = roomNameBadges(fetched);
          this.rawByNameKey.set(key, list);
          const codes = formatNameplateBadges(list, this.context);
          if (codes.length > 0) this.byNameKey.set(key, codes);
          else this.byNameKey.delete(key);
        }
      })
      .catch(() => {
        // Offline or network error: badges are an optional garnish
      });
  }

  dispose(): void {
    this.disposed = true;
    this.rawByNameKey.clear();
    this.byNameKey.clear();
    this.requestedKeys.clear();
  }
}

/** Height above the car origin where the overhead nameplate anchors (metres) */
export const NAMEPLATE_ROOF_OFFSET_M = 1.55;
/** Distance where linear opacity fade begins (metres): full opacity up to here */
export const NAMEPLATE_FADE_START_M = 90;
/** Distance where nameplates fade to 0 and are culled (metres) */
export const NAMEPLATE_MAX_DISTANCE_M = 180;
/** Small NDC margin outside [-1, 1] so pills slide off screen edges instead of popping early */
const SCREEN_NDC_MARGIN = 1.2;

export type PodiumTier = 1 | 2 | 3 | null;

/** Minimal peer shape needed for overhead nameplate projection and ranking (compatible with InterpolatedPeerState) */
export interface NameplatePeerInput {
  readonly peerId: string;
  readonly driverCode: string;
  readonly name?: string;
  readonly teamColorHex?: string;
  readonly isAiPeer: boolean;
  readonly ghost?: boolean;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly race?: { readonly best: number | null } | null;
  /** Optional icon/badge slot identifiers (e.g. Weekly Challenge badges) */
  readonly badges?: readonly string[];
}

export interface NameplateRankingContext {
  /** Present during an AI or multiplayer race; absent in practice & qualifying */
  readonly race?: Pick<RaceStatus, "standings"> | null;
  /** Local player's fastest valid lap of the current practice/qualifying session (ms), or null before one */
  readonly localBestLapMs?: number | null;
  /** Optional cached badge codes keyed by `driverNameKey` (skipped for AI peers) */
  readonly badgesByNameKey?: ReadonlyMap<string, readonly string[]> | null;
}

export interface NameplatePeerRanking {
  /** 1-based position in race standings or practice/qualifying lap ranking; null when unranked */
  rank: number | null;
  /** 1 = Gold, 2 = Silver, 3 = Bronze, null = outside top 3 or unranked */
  podium: PodiumTier;
  /** True in race mode when this peer holds the overall fastest lap */
  fastestLap: boolean;
}

export interface OverheadNameplateEntry {
  peerId: string;
  /** Display label: trimmed player nickname when present, else driverCode */
  label: string;
  driverCode: string;
  isAiPeer: boolean;
  /** Screen position in CSS pixels (origin top-left) */
  x: number;
  y: number;
  /** Camera-to-roof distance (metres) */
  distanceM: number;
  /** Distance-faded opacity in (0, 1] */
  opacity: number;
  /** 1 = Gold, 2 = Silver, 3 = Bronze, null = default */
  podium: PodiumTier;
  /** Overall fastest lap pill (race mode) */
  fastestLap: boolean;
  /** 1-based rank when ranked, null when unranked */
  rank: number | null;
  /** Optional badge slots (e.g. Weekly Challenge awards) */
  badges?: string[];
}

/** Imperative DOM overlay target driven directly from the render loop (zero React re-renders per frame) */
export interface OverheadNameplatesSink {
  update(entries: readonly OverheadNameplateEntry[]): void;
  hideAll(): void;
}

export function isValidLapMs(ms: number | null | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0;
}

export function podiumTierForRank(rank: number | null): PodiumTier {
  if (rank === 1 || rank === 2 || rank === 3) return rank;
  return null;
}

/** Linear opacity fade from 1 at <= 90 m to 0 at >= 180 m */
export function nameplateOpacity(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM >= NAMEPLATE_MAX_DISTANCE_M) return 0;
  if (distanceM <= NAMEPLATE_FADE_START_M) return 1;
  return 1 - (distanceM - NAMEPLATE_FADE_START_M) / (NAMEPLATE_MAX_DISTANCE_M - NAMEPLATE_FADE_START_M);
}

export function nameplateLabel(peer: Pick<NameplatePeerInput, "name" | "driverCode">): string {
  const trimmed = peer.name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : peer.driverCode;
}

interface LapContender {
  peerId: string | null;
  bestMs: number;
}

function matchStandingsToPeers(
  peers: readonly NameplatePeerInput[],
  standings: readonly RaceStandingEntry[],
  out: Map<string, NameplatePeerRanking>,
): void {
  let fastestMs: number | null = null;
  for (let i = 0; i < standings.length; i++) {
    const ms = standings[i].bestLapMs;
    if (isValidLapMs(ms) && (fastestMs === null || ms < fastestMs)) fastestMs = ms;
  }

  const used = new Uint8Array(standings.length);
  const matched = new Uint8Array(peers.length);

  const assign = (peerIdx: number, standingIdx: number) => {
    used[standingIdx] = 1;
    matched[peerIdx] = 1;
    const s = standings[standingIdx];
    const rank = standingIdx + 1;
    out.set(peers[peerIdx].peerId, {
      rank,
      podium: podiumTierForRank(rank),
      fastestLap: fastestMs !== null && isValidLapMs(s.bestLapMs) && s.bestLapMs === fastestMs,
    });
  };

  // Pass 1: exact name + driverCode (disambiguates players sharing a default code like "DRV")
  for (let p = 0; p < peers.length; p++) {
    const peer = peers[p];
    if (peer.ghost || matched[p]) continue;
    const pName = peer.name?.trim();
    if (!pName) continue;
    for (let s = 0; s < standings.length; s++) {
      if (used[s] || standings[s].isPlayer) continue;
      if (standings[s].name?.trim() === pName && standings[s].driverCode === peer.driverCode) {
        assign(p, s);
        break;
      }
    }
  }

  // Pass 2: exact name match
  for (let p = 0; p < peers.length; p++) {
    const peer = peers[p];
    if (peer.ghost || matched[p]) continue;
    const pName = peer.name?.trim();
    if (!pName) continue;
    for (let s = 0; s < standings.length; s++) {
      if (used[s] || standings[s].isPlayer) continue;
      if (standings[s].name?.trim() === pName) {
        assign(p, s);
        break;
      }
    }
  }

  // Pass 3: driverCode + teamColorHex (AI peers and remote peers with distinct colours)
  for (let p = 0; p < peers.length; p++) {
    const peer = peers[p];
    if (peer.ghost || matched[p] || !peer.teamColorHex) continue;
    for (let s = 0; s < standings.length; s++) {
      if (used[s] || standings[s].isPlayer) continue;
      if (standings[s].driverCode === peer.driverCode && standings[s].teamColorHex === peer.teamColorHex) {
        assign(p, s);
        break;
      }
    }
  }

  // Pass 4: driverCode fallback
  for (let p = 0; p < peers.length; p++) {
    const peer = peers[p];
    if (peer.ghost || matched[p]) continue;
    for (let s = 0; s < standings.length; s++) {
      if (used[s] || standings[s].isPlayer) continue;
      if (standings[s].driverCode === peer.driverCode) {
        assign(p, s);
        break;
      }
    }
  }

  // Unmatched non-ghost peers stay unranked
  for (let p = 0; p < peers.length; p++) {
    const peer = peers[p];
    if (peer.ghost || matched[p]) continue;
    out.set(peer.peerId, { rank: null, podium: null, fastestLap: false });
  }
}

function rankByBestLap(
  peers: readonly NameplatePeerInput[],
  localBestLapMs: number | null | undefined,
  contenders: LapContender[],
  out: Map<string, NameplatePeerRanking>,
): void {
  contenders.length = 0;
  if (isValidLapMs(localBestLapMs)) {
    contenders.push({ peerId: null, bestMs: localBestLapMs });
  }
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    if (peer.ghost) continue;
    const best = peer.race?.best;
    if (isValidLapMs(best)) {
      contenders.push({ peerId: peer.peerId, bestMs: best });
    } else {
      out.set(peer.peerId, { rank: null, podium: null, fastestLap: false });
    }
  }

  contenders.sort((a, b) => a.bestMs - b.bestMs);

  // Standard competition ranking (1, 1, 3) so exact ties share the same podium tier
  let rank = 1;
  for (let i = 0; i < contenders.length; i++) {
    if (i > 0 && contenders[i].bestMs > contenders[i - 1].bestMs) {
      rank = i + 1;
    }
    const peerId = contenders[i].peerId;
    if (peerId !== null) {
      out.set(peerId, {
        rank,
        podium: podiumTierForRank(rank),
        fastestLap: false,
      });
    }
  }
}

/**
 * Computes podium tiers, ranks, and race fastest-lap markers for all non-ghost peers.
 * - Race (`context.race` present): P1 Gold, P2 Silver, P3 Bronze from `race.standings`, plus overall fastest lap.
 * - Practice & Qualifying (`context.race` absent): ranked by fastest valid lap (`peer.race?.best` + `localBestLapMs`).
 */
export function rankNameplatePeers(
  peers: readonly NameplatePeerInput[],
  context: NameplateRankingContext = {},
): Map<string, NameplatePeerRanking> {
  const out = new Map<string, NameplatePeerRanking>();
  if (context.race) {
    matchStandingsToPeers(peers, context.race.standings, out);
  } else {
    rankByBestLap(peers, context.localBestLapMs, [], out);
  }
  return out;
}

/**
 * Stateful, allocation-lean per-frame projector reused inside the render loop.
 * Scratch vectors, ranking map, and output array are reused across frames.
 */
export class OverheadNameplateProjector {
  private readonly camPos = new THREE.Vector3();
  private readonly camForward = new THREE.Vector3();
  private readonly roof = new THREE.Vector3();
  private readonly toRoof = new THREE.Vector3();
  private readonly ndc = new THREE.Vector3();
  private readonly rankings = new Map<string, NameplatePeerRanking>();
  private readonly contenders: LapContender[] = [];
  private readonly entries: OverheadNameplateEntry[] = [];

  project(
    peers: readonly NameplatePeerInput[],
    camera: THREE.Camera,
    viewportWidth: number,
    viewportHeight: number,
    context: NameplateRankingContext = {},
  ): readonly OverheadNameplateEntry[] {
    this.entries.length = 0;
    if (peers.length === 0 || viewportWidth <= 0 || viewportHeight <= 0) return this.entries;

    camera.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.camForward);

    this.rankings.clear();
    if (context.race) {
      matchStandingsToPeers(peers, context.race.standings, this.rankings);
    } else {
      rankByBestLap(peers, context.localBestLapMs, this.contenders, this.rankings);
    }

    const halfW = viewportWidth * 0.5;
    const halfH = viewportHeight * 0.5;

    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (peer.ghost) continue;

      const pos = peer.position;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue;

      this.roof.set(pos.x, pos.y + NAMEPLATE_ROOF_OFFSET_M, pos.z);
      this.toRoof.subVectors(this.roof, this.camPos);

      const distanceM = this.toRoof.length();
      if (!Number.isFinite(distanceM) || distanceM >= NAMEPLATE_MAX_DISTANCE_M) continue;

      // Behind camera (dot product with camera forward <= 0)
      if (this.toRoof.dot(this.camForward) <= 0) continue;

      this.ndc.copy(this.roof).project(camera);
      if (!Number.isFinite(this.ndc.x) || !Number.isFinite(this.ndc.y) || !Number.isFinite(this.ndc.z)) continue;
      if (this.ndc.z > 1 || this.ndc.z < -1) continue;
      if (
        this.ndc.x < -SCREEN_NDC_MARGIN ||
        this.ndc.x > SCREEN_NDC_MARGIN ||
        this.ndc.y < -SCREEN_NDC_MARGIN ||
        this.ndc.y > SCREEN_NDC_MARGIN
      ) {
        continue;
      }

      const opacity = nameplateOpacity(distanceM);
      if (opacity <= 0) continue;

      const ranking = this.rankings.get(peer.peerId);
      const entry: OverheadNameplateEntry = {
        peerId: peer.peerId,
        label: nameplateLabel(peer),
        driverCode: peer.driverCode,
        isAiPeer: peer.isAiPeer,
        x: (this.ndc.x + 1) * halfW,
        y: (1 - this.ndc.y) * halfH,
        distanceM,
        opacity,
        podium: ranking?.podium ?? null,
        fastestLap: ranking?.fastestLap ?? false,
        rank: ranking?.rank ?? null,
      };
      const peerBadges =
        peer.badges && peer.badges.length > 0
          ? peer.badges
          : !peer.isAiPeer && peer.name && context.badgesByNameKey && context.badgesByNameKey.size > 0
            ? context.badgesByNameKey.get(driverNameKey(peer.name))
            : undefined;
      if (peerBadges && peerBadges.length > 0) {
        entry.badges = [...peerBadges];
      }
      this.entries.push(entry);
    }

    return this.entries;
  }
}

/** Pure helper for projecting and ranking peers in a single call (convenient for tests) */
export function projectNameplates(
  peers: readonly NameplatePeerInput[],
  camera: THREE.Camera,
  viewportWidth: number,
  viewportHeight: number,
  context: NameplateRankingContext = {},
): OverheadNameplateEntry[] {
  const projector = new OverheadNameplateProjector();
  return [...projector.project(peers, camera, viewportWidth, viewportHeight, context)];
}
