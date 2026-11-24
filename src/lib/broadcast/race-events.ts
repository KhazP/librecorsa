/**
 * The race's broadcast cards (an offline AI race, a career round's included): what happens to any driver, read off the
 * race's standing frame by frame, so it works alike with the page's field and the simulation worker's.
 *
 * - WINNER: the first car over the line at the flag.
 * - NEW LEADER: the lead changes hands after the first lap (held a moment: two cars side by side swap it frame to frame).
 * - FASTEST LAP: a new fastest lap of the race, from a car's second lap on (the first, from the grid, is never one).
 * - PIT STOP: a car's stop done, with its time stationary in the box and the tyres fitted.
 * - RETIRED: a car out of the race (a disqualification is race control's call, not a card).
 *
 * `BroadcastCardQueue` shows them one at a time, the most important first, none on top of another: a new card waits
 * for the one on screen, and for race control's own messages to clear.
 *
 * Pure, no three.js or DOM: the HUD feeds each `RaceStatus` with the page's clock.
 */
import type { RaceStatus, TireCompound } from "@/types/f1";

export type RaceEventKind = "winner" | "retired" | "newLeader" | "fastestLap" | "pitStop";

export interface RaceEvent {
  kind: RaceEventKind;
  /** The car's race code, its colour, and whether it is the player's */
  code: string;
  color: string;
  isPlayer: boolean;
  /** newLeader: the lap they lead */
  lap?: number;
  /** fastestLap: the time (ms) */
  lapMs?: number;
  /** pitStop: stationary in the box (s; absent when the stop was not seen), and the tyres fitted */
  stationaryS?: number;
  compound?: TireCompound;
}

/** The higher, the sooner it shows */
export const EVENT_PRIORITY: Readonly<Record<RaceEventKind, number>> = {
  winner: 5,
  retired: 4,
  newLeader: 3,
  fastestLap: 2,
  pitStop: 1,
};

/** A new leader shows once they have held the lead this long (ms) */
export const LEAD_HOLD_MS = 1500;
/** The field's furthest car going back by more than this is a rewind (a Flashback): the reading starts over (m) */
const REWIND_M = 30;
/** A fastest lap beats the last by more than this (ms) */
const FASTEST_EPS_MS = 0.5;

interface CarSeen {
  retired: boolean;
  pitStops: number;
  /** The stop under way's whole length, as last seen in the box (s) */
  boxS: number | null;
}

export class RaceEventDetector {
  private readonly cars = new Map<string, CarSeen>();
  private primed = false;
  private leader: string | null = null;
  private candidate: { code: string; sinceMs: number } | null = null;
  private bestMs: number | null = null;
  private winnerShown = false;
  private furthestM = -Infinity;

  /** Forget the race: the next frame is read as the first (no cards from it) */
  reset(): void {
    this.cars.clear();
    this.primed = false;
    this.leader = null;
    this.candidate = null;
    this.bestMs = null;
    this.winnerShown = false;
    this.furthestM = -Infinity;
  }

  /** This frame's events (none on the first frame read, at the lights, or after a rewind) */
  update(race: RaceStatus, nowMs: number): RaceEvent[] {
    const st = race.standings;
    if (race.phase === "lights" || st.length === 0) {
      this.reset();
      return [];
    }
    let furthest = -Infinity;
    for (const e of st) if (e.raceDistM !== undefined && e.raceDistM > furthest) furthest = e.raceDistM;
    if (this.primed && furthest < this.furthestM - REWIND_M) this.reset();
    this.furthestM = Math.max(this.furthestM, furthest);

    const out: RaceEvent[] = [];
    const primed = this.primed;
    const of = (e: (typeof st)[number]) => ({ code: e.driverCode, color: e.teamColorHex, isPlayer: e.isPlayer });

    // Each car: out of the race, a stop done
    for (const e of st) {
      const stops = e.pitStops ?? 0;
      const retired = Boolean(e.retired);
      let seen = this.cars.get(e.driverCode);
      if (!seen) {
        seen = { retired, pitStops: stops, boxS: null };
        this.cars.set(e.driverCode, seen);
        if (primed) continue;
      }
      if (e.pitBox) seen.boxS = e.pitBox.totalS;
      if (primed && retired && !seen.retired && !e.dq) out.push({ kind: "retired", ...of(e) });
      if (primed && stops > seen.pitStops) {
        out.push({ kind: "pitStop", ...of(e), stationaryS: seen.boxS ?? undefined, compound: e.compound });
      }
      if (stops !== seen.pitStops) seen.boxS = null;
      seen.retired = retired;
      seen.pitStops = stops;
    }

    // The winner: the first car to take the flag
    const winner = st.find((e) => e.finished);
    if (winner && !this.winnerShown) {
      this.winnerShown = true;
      if (primed) out.push({ kind: "winner", ...of(winner) });
    }

    // The lead: changes on the first lap pass unannounced; after the flag, none
    const lead = st[0];
    if (!primed || this.winnerShown) {
      this.leader = lead.driverCode;
      this.candidate = null;
    } else if (lead.driverCode === this.leader) {
      this.candidate = null;
    } else if (lead.lap < 2 || lead.retired) {
      this.leader = lead.driverCode;
      this.candidate = null;
    } else if (this.candidate?.code !== lead.driverCode) {
      this.candidate = { code: lead.driverCode, sinceMs: nowMs };
    } else if (nowMs - this.candidate.sinceMs >= LEAD_HOLD_MS) {
      this.leader = lead.driverCode;
      this.candidate = null;
      out.push({ kind: "newLeader", ...of(lead), lap: lead.lap });
    }

    // The race's fastest lap: from a car's second lap on (its `lap` is the one it is on)
    let holder: (typeof st)[number] | null = null;
    for (const e of st) if (e.bestLapMs && (!holder || e.bestLapMs < (holder.bestLapMs as number))) holder = e;
    const best = holder?.bestLapMs ?? null;
    if (holder && best !== null && (this.bestMs === null || best < this.bestMs - FASTEST_EPS_MS)) {
      const first = this.bestMs === null;
      this.bestMs = best;
      if (primed && !first && holder.lap >= 3) out.push({ kind: "fastestLap", ...of(holder), lapMs: best });
    }

    this.primed = true;
    return out;
  }
}

/** How long a card stays up, the pause before the next, and how long one may wait before it is old news (ms) */
export const CARD_MS = 5000;
export const CARD_GAP_MS = 600;
export const CARD_STALE_MS = 20000;
/** Cards waiting at most: the least important go first */
const MAX_WAITING = 6;

export interface ShownCard {
  event: RaceEvent;
  /** Counts the cards shown: the card's animations start over on a new one */
  id: number;
  startMs: number;
}

interface Waiting {
  event: RaceEvent;
  atMs: number;
}

/** News of a kind that only the latest of counts: one fastest lap, one new leader */
const LATEST_ONLY: ReadonlySet<RaceEventKind> = new Set(["fastestLap", "newLeader"]);

export class BroadcastCardQueue {
  private waiting: Waiting[] = [];
  private shown: ShownCard | null = null;
  private freeAtMs = 0;
  private count = 0;

  clear(): void {
    this.waiting = [];
    this.shown = null;
    this.freeAtMs = 0;
  }

  get pending(): number {
    return this.waiting.length;
  }

  push(events: readonly RaceEvent[], nowMs: number): void {
    for (const event of events) {
      // A newer one replaces the same news still waiting
      this.waiting = this.waiting.filter(
        (w) => !(w.event.kind === event.kind && (LATEST_ONLY.has(event.kind) || w.event.code === event.code))
      );
      this.waiting.push({ event, atMs: nowMs });
    }
    while (this.waiting.length > MAX_WAITING) {
      let drop = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        if (EVENT_PRIORITY[this.waiting[i].event.kind] < EVENT_PRIORITY[this.waiting[drop].event.kind]) drop = i;
      }
      this.waiting.splice(drop, 1);
    }
  }

  /**
   * The card on screen now, or null. `hold`: no new card may start (race control's messages are up); the one on
   * screen plays out
   */
  current(nowMs: number, hold = false): ShownCard | null {
    if (this.shown && nowMs - this.shown.startMs >= CARD_MS) {
      this.shown = null;
      this.freeAtMs = nowMs + CARD_GAP_MS;
    }
    if (this.shown) return this.shown;
    this.waiting = this.waiting.filter((w) => w.event.kind === "winner" || nowMs - w.atMs < CARD_STALE_MS);
    if (hold || nowMs < this.freeAtMs || this.waiting.length === 0) return null;
    let next = 0;
    for (let i = 1; i < this.waiting.length; i++) {
      if (EVENT_PRIORITY[this.waiting[i].event.kind] > EVENT_PRIORITY[this.waiting[next].event.kind]) next = i;
    }
    const [w] = this.waiting.splice(next, 1);
    this.shown = { event: w.event, id: ++this.count, startMs: nowMs };
    return this.shown;
  }
}
