/**
 * Multiplayer car-to-car contact gating & safety guards.
 *
 * Collisions are ON by default across multiplayer (both races and lobby practice/qualifying), with targeted
 * ghosting only when physical contact would be unfair or unstable:
 *  - Explicit Ghost-mode lobby (`collisions: 'off'`)
 *  - Spawn / reset / teleport protection (held until the timer expires AND the car is clear of other cars)
 *  - Pitlane driving (local or remote car on `pitlane` surface)
 *  - Paused / in-menu / AFK stationary cars
 *  - Heavy lag / packet loss / desync (`stale`, `desync`, or `!contactReady`)
 *  - Race grid hold, post-finish cooldown, optional `ghost_lap1`, and open-race `protected` launch / `ContactGuard`
 *
 * No three.js and no DOM: imported by `drive-session.ts`, `race-session.ts`, `multiplayer-sync.ts`, and headless tests.
 */
import type { CollisionMode } from "@/lib/net/wire";

/** Local spawn / reset / teleport protection duration (ms) */
export const MP_SPAWN_GHOST_MS = 3000;
/** Brief launch spawn-protection window after lights out in open (`protected`) races (s) */
export const MP_PROTECTED_LAUNCH_GHOST_S = 3.0;
/** Stationary with no driver input for this long -> AFK ghost (s) */
export const MP_AFK_GHOST_S = 8.0;
/** Speed below which a car with no inputs counts toward AFK ghosting (m/s, ~5.4 km/h) */
export const MP_AFK_SPEED_MS = 1.5;
/** Minimum center-to-center distance required to end spawn-overlap hold (m) */
export const MP_CLEAR_SEPARATION_M = 6.0;
/** Packet loss (%) above which a remote peer is treated as desynced and ghosted */
export const MP_HEAVY_LOSS_PCT = 25;
/** Arrival jitter (ms) above which a remote peer is treated as heavily lagging and ghosted */
export const MP_HEAVY_JITTER_MS = 150;

export type LocalGhostReason = "spawn" | "pitlane" | "paused" | "afk" | null;

export interface LocalSafetyInput {
  nowMs: number;
  dtS: number;
  paused: boolean;
  inMenu: boolean;
  inPitlane: boolean;
  speedMs: number;
  hasInput: boolean;
  /** True while held stationary on the starting grid before lights out */
  gridHeld: boolean;
  /** Distance (m) to the nearest same-track remote human car (Infinity if none) */
  nearestPeerDistM: number;
}

export interface LocalSafetyState {
  ghost: boolean;
  reason: LocalGhostReason;
}

/**
 * Tracks whether the local player's car should be ghosted for safety (spawn protection, pitlane, paused/in-menu,
 * or AFK). When `ghost` is true, the local car takes no remote car contact AND sets `hz: true` on its outbound
 * packets so remote peers pass cleanly through it too.
 */
export class LocalContactSafety {
  private spawnUntilMs = -Infinity;
  private spawnOverlapHold = false;
  private afkS = 0;

  /** Arms spawn protection (e.g. on initial spawn, track reset, teleport, or car swap) */
  armSpawnProtection(nowMs: number, durationMs = MP_SPAWN_GHOST_MS): void {
    const until = nowMs + Math.max(0, durationMs);
    if (until > this.spawnUntilMs) this.spawnUntilMs = until;
    this.spawnOverlapHold = true;
    this.afkS = 0;
  }

  /** Clears spawn protection immediately (e.g. when lining up on a spaced starting grid) */
  clearSpawnProtection(): void {
    this.spawnUntilMs = -Infinity;
    this.spawnOverlapHold = false;
  }

  update(input: LocalSafetyInput): LocalSafetyState {
    const dtS = Number.isFinite(input.dtS) && input.dtS > 0 ? input.dtS : 0;

    // Update AFK timer only when actively driving and not held on the grid
    if (input.paused || input.inMenu || input.gridHeld) {
      this.afkS = 0;
    } else if (!input.hasInput && input.speedMs < MP_AFK_SPEED_MS) {
      this.afkS += dtS;
    } else {
      this.afkS = 0;
    }

    // Release spawn-overlap latch only after the timer expires AND no remote car is overlapping
    const inSpawnWindow = input.nowMs < this.spawnUntilMs;
    if (!inSpawnWindow && this.spawnOverlapHold && input.nearestPeerDistM > MP_CLEAR_SEPARATION_M) {
      this.spawnOverlapHold = false;
    }

    if (input.paused || input.inMenu) return { ghost: true, reason: "paused" };
    if (input.inPitlane) return { ghost: true, reason: "pitlane" };
    if (inSpawnWindow || this.spawnOverlapHold) return { ghost: true, reason: "spawn" };
    if (this.afkS >= MP_AFK_GHOST_S) return { ghost: true, reason: "afk" };
    return { ghost: false, reason: null };
  }
}

export interface PeerContactSnapshot {
  isAiPeer: boolean;
  contactReady?: boolean;
  stale?: boolean;
  desync?: boolean;
  hazard?: boolean;
  ghost?: boolean;
  inPitlane?: boolean;
}

export interface RaceContactSnapshot {
  sameRace: boolean;
  phase: "countdown" | "lights" | "racing";
  collisionsActiveWithPeer: boolean;
  finished: boolean;
  guardBlocked: boolean;
  guardRammed: boolean;
}

export interface PeerContactVerdict {
  /** True when `resolvePlayerVsRemoteCar` should resolve physical collision this frame */
  solid: boolean;
  /** True when the remote car should be rendered translucent (passing through) */
  passThrough: boolean;
  reason:
    | "ai"
    | "ghost_mode"
    | "other_race"
    | "grid"
    | "finished"
    | "launch_or_lap1"
    | "local_safety"
    | "remote_safety"
    | "contact_guard"
    | null;
}

/**
 * Evaluates physical contact and visual pass-through state between the local player and one remote multiplayer car.
 * Works uniformly for BOTH active multiplayer races (`race !== null`) AND multiplayer lobby practice/qualifying
 * (`race === null`).
 */
export function evaluatePeerContact(args: {
  collisionMode: CollisionMode;
  localSafetyGhost: boolean;
  peer: PeerContactSnapshot;
  race: RaceContactSnapshot | null;
}): PeerContactVerdict {
  const { collisionMode, localSafetyGhost, peer, race } = args;
  if (peer.isAiPeer) return { solid: false, passThrough: false, reason: "ai" };

  // Explicit ghost-mode lobby (private room Ghost toggle ON)
  if (collisionMode === "off") return { solid: false, passThrough: true, reason: "ghost_mode" };

  if (race) {
    if (!race.sameRace) return { solid: false, passThrough: true, reason: "other_race" };
    if (race.phase !== "racing") return { solid: false, passThrough: false, reason: "grid" };
    if (race.finished) return { solid: false, passThrough: true, reason: "finished" };
    if (!race.collisionsActiveWithPeer) return { solid: false, passThrough: true, reason: "launch_or_lap1" };
  }

  if (localSafetyGhost) return { solid: false, passThrough: true, reason: "local_safety" };

  if (peer.ghost || peer.stale || peer.desync || peer.hazard || peer.inPitlane || peer.contactReady === false) {
    return { solid: false, passThrough: true, reason: "remote_safety" };
  }

  if (race?.guardBlocked) {
    return { solid: false, passThrough: Boolean(peer.hazard || race.guardRammed), reason: "contact_guard" };
  }

  return { solid: true, passThrough: false, reason: null };
}
