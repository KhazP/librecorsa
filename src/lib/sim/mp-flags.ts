/**
 * Yellow flags in a race between people (an open race or a room). In an AI race race control sees every car
 * (race-incidents.ts); here each client judges the cars on the road ahead of its own from what their packets say, and
 * shows the player the same flag messages. No penalties: a flag only warns.
 *
 * A car is an incident when, before its flag (and off the start, once past its first 150 m), it is
 *  - stopped or crawling (under the speed at which the fair-play rule calls a car standing, contact-guard.ts)
 *  - going the wrong way along the track
 *  - off the track by the road, about to rejoin (far out in a run-off it is in nobody's way)
 *  - flagged by its own packets as a hazard (`hz`, an open race's fair-play rule: the others pass through it) while
 *    not at racing speed (the flag stays up a little after the car is clear again)
 * The player is under yellow while such a car is on the road up to 300 m ahead (or just passed). Rooms send no `hz`, so
 * the first three are judged here from the car's pose. Both ends have a little hysteresis so the flag doesn't flicker.
 *
 * No three.js, no DOM.
 */
import type { RaceControlFeedMessage, RaceStatus } from '@/types/f1';
import type { InterpolatedPeerState } from './multiplayer-sync';
import { SLOW_MS, WRONG_WAY_MS } from './contact-guard';

/** Yellow zone: from this far before the incident to this far past it (m) */
export const YELLOW_AHEAD_M = 300;
export const YELLOW_PAST_M = 40;
/** Under this speed a car is stopped rather than slow (m/s) */
export const STOPPED_MS = 2;
/** Further off the track than this (beyond the edge, m) a car is off; further than this it is in nobody's way */
export const OFF_TRACK_M = 1;
export const NEAR_ROAD_M = 8;
/** A car flagged by its own packets counts only under this speed (m/s, ~90 km/h) */
export const HAZARD_RACING_MS = 25;
/** A car is an incident once its cause has lasted this long, and stops being one this long after it cleared (s) */
export const CAR_ON_S = 0.5;
export const CAR_OFF_S = 1;
/** The player's flag comes down this long after the last incident left the zone (s) */
export const YELLOW_HOLD_S = 1;
/**
 * Off the start everyone is slow: no flags in the first seconds, nor for a car in its first metres until the field
 * is long gone (then a car still on the grid is a car stopped on the track)
 */
export const START_QUIET_S = 10;
export const START_QUIET_M = 150;
export const START_GRACE_S = 30;
/** Messages stay on the feed this long (s) */
const MESSAGE_LIFE_S = 6;

export type YellowCause = 'stopped' | 'slow' | 'wrong_way' | 'off_track' | 'hazard';

const DETAIL: Record<YellowCause, string> = {
  stopped: 'Car stopped ahead',
  slow: 'Slow car ahead',
  wrong_way: 'Car going the wrong way',
  off_track: 'Car off the track ahead',
  hazard: 'Incident ahead',
};

/** One other car, as this client sees it */
export interface FlagCar {
  id: string;
  /** Lap position (m) */
  s: number;
  /** Signed distance from the centreline (m) and the road's half width there (m) */
  latM: number;
  halfWidthM: number;
  speedMs: number;
  /** Speed along the track (m/s; negative: the wrong way) */
  alongMs: number;
  /** The car's packets say it is a hazard */
  hazard: boolean;
  /** Racing in this race: not yet flagged */
  racing: boolean;
  /** Distance covered since the start (m) */
  distM: number;
}

/** Why a car is an incident right now, or null */
export function causeOf(c: FlagCar): YellowCause | null {
  if (!c.racing) return null;
  const beyondEdge = Math.abs(c.latM) - c.halfWidthM;
  if (beyondEdge > NEAR_ROAD_M) return null;
  if (c.alongMs < -WRONG_WAY_MS) return 'wrong_way';
  if (c.speedMs < STOPPED_MS) return 'stopped';
  if (c.speedMs < SLOW_MS) return 'slow';
  if (beyondEdge > OFF_TRACK_M) return 'off_track';
  if (c.hazard && c.speedMs < HAZARD_RACING_MS) return 'hazard';
  return null;
}

/** Distance from `s` forward to `at` around a lap of length `L`, in (-L/2, L/2] */
function aheadM(s: number, at: number, L: number): number {
  return ((((at - s) % L) + L * 1.5) % L) - L / 2;
}

/** One car's incident state, debounced */
interface CarFlag {
  causeS: number;
  clearS: number;
  on: boolean;
  cause: YellowCause | null;
}

/** The player's yellow flag in one race between people, and race control's messages about it */
export class MultiplayerFlags {
  /** The player is under yellow */
  yellow = false;
  /** What the flag is for while it is up */
  cause: YellowCause | null = null;
  private readonly cars = new Map<string, CarFlag>();
  private readonly messages: (RaceControlFeedMessage & { atS: number })[] = [];
  private nextId = 1;
  private holdS = 0;

  /**
   * One frame. `active`: the player is racing (lights out, not yet flagged); otherwise the flag is down and nothing
   * is posted.
   */
  update(dtS: number, raceTimeS: number, playerS: number, lapLengthM: number, cars: readonly FlagCar[], active = true): void {
    const quiet = !active || raceTimeS < START_QUIET_S || !(lapLengthM > 0);
    const seen = new Set<string>();
    let nearest: { d: number; cause: YellowCause } | null = null;
    for (const c of cars) {
      seen.add(c.id);
      let f = this.cars.get(c.id);
      if (!f) {
        f = { causeS: 0, clearS: 0, on: false, cause: null };
        this.cars.set(c.id, f);
      }
      const offTheStart = c.distM < START_QUIET_M && raceTimeS < START_GRACE_S;
      const cause = quiet || offTheStart ? null : causeOf(c);
      if (cause) {
        f.causeS += dtS;
        f.clearS = 0;
        f.cause = cause;
        if (f.causeS >= CAR_ON_S) f.on = true;
      } else {
        f.clearS += dtS;
        f.causeS = 0;
        if (f.clearS >= CAR_OFF_S || !c.racing) f.on = false;
      }
      if (!f.on || quiet || !f.cause) continue;
      const d = aheadM(playerS, c.s, lapLengthM);
      if (d > YELLOW_AHEAD_M || d < -YELLOW_PAST_M) continue;
      if (!nearest || Math.abs(d) < Math.abs(nearest.d)) nearest = { d, cause: f.cause };
    }
    // A car gone from the race (its packets stopped) takes its flag with it
    for (const id of this.cars.keys()) if (!seen.has(id)) this.cars.delete(id);

    if (quiet) {
      this.yellow = false;
      this.cause = null;
      this.holdS = 0;
      return;
    }
    if (nearest) {
      this.holdS = 0;
      if (!this.yellow) this.post(raceTimeS, 'yellow', 'Yellow flag', DETAIL[nearest.cause]);
      this.yellow = true;
      this.cause = nearest.cause;
    } else if (this.yellow) {
      this.holdS += dtS;
      if (this.holdS >= YELLOW_HOLD_S) {
        this.yellow = false;
        this.cause = null;
        this.post(raceTimeS, 'green', 'Track clear');
      }
    }
  }

  /** The messages still on the feed, newest first (at most two, as the HUD shows) */
  feed(raceTimeS: number): RaceControlFeedMessage[] | undefined {
    const live = this.messages.filter((m) => raceTimeS - m.atS < MESSAGE_LIFE_S && m.atS <= raceTimeS + 1e-6).reverse();
    return live.length ? live.slice(0, 2).map(({ id, kind, text, detail }) => ({ id, kind, text, detail })) : undefined;
  }

  private post(atS: number, kind: RaceControlFeedMessage['kind'], text: string, detail?: string): void {
    this.messages.push({ id: this.nextId++, kind, text, detail, atS });
    if (this.messages.length > 20) this.messages.splice(0, this.messages.length - 20);
  }
}

/** What of the circuit the remote cars are placed on */
export interface FlagTrack {
  totalLengthM: number;
  projectWorldToTrack: (
    x: number,
    z: number,
    hintS?: number
  ) => { s: number; lateralOffset: number; sample: { width: number; tangent: { x: number; z: number } } };
}

/**
 * The other players' cars in race `raceId`, placed on the track from their drawn pose. The along-track speed comes
 * from the velocity, not from `trackS`, which steps once per packet.
 */
export function flagCarsOf(track: FlagTrack, peers: readonly InterpolatedPeerState[], raceId: string): FlagCar[] {
  const out: FlagCar[] = [];
  for (const p of peers) {
    if (p.ghost || p.isAiPeer || !p.race || p.race.id !== raceId) continue;
    const proj = track.projectWorldToTrack(p.position.x, p.position.z, p.trackS);
    if (!Number.isFinite(proj.s) || !Number.isFinite(proj.lateralOffset)) continue;
    const t = proj.sample.tangent;
    const tLen = Math.hypot(t.x, t.z) || 1;
    out.push({
      id: p.peerId,
      s: proj.s,
      latM: proj.lateralOffset,
      halfWidthM: proj.sample.width / 2,
      speedMs: p.speedKmh / 3.6,
      alongMs: (p.linearVelocity.x * t.x + p.linearVelocity.z * t.z) / tLen,
      hazard: p.hazard === true,
      racing: p.race.fin === null,
      distM: p.race.dist,
    });
  }
  return out;
}

const byRace = new WeakMap<object, MultiplayerFlags>();

/**
 * One frame of a race between people: judges the cars ahead and puts the flag and its messages on the race's status
 * (`yellow`, `raceControl`), where the HUD shows an AI race's. The state is kept per race object.
 */
export function flagMultiplayerRace(
  race: { start: { id: string } },
  status: RaceStatus,
  track: FlagTrack,
  peers: readonly InterpolatedPeerState[],
  dtS: number,
  raceTimeS: number,
  playerS: number
): void {
  let flags = byRace.get(race);
  if (!flags) {
    flags = new MultiplayerFlags();
    byRace.set(race, flags);
  }
  flags.update(dtS, raceTimeS, playerS, track.totalLengthM, flagCarsOf(track, peers, race.start.id), status.phase === 'racing');
  status.yellow = flags.yellow || undefined;
  const feed = flags.feed(raceTimeS);
  if (feed) status.raceControl = [...feed, ...(status.raceControl ?? [])].slice(0, 2);
}
