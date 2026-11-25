/**
 * The broadcast's battle strip in an offline AI race: two cars in a row within a second of each other, the place they
 * fight for, the gap, and a forecast from how that gap moved over the last laps.
 *
 * - The gap between a car and the one ahead of it is taken at each lap line while the two stay together (a new car
 *   ahead, a stop, a rewind start it over). Two laps of it make a forecast: "attacking" within ATTACK_GAP_S, else the
 *   gap closing (by how much a lap, and the laps to catch the car ahead when that is within the race), opening
 *   ("pulling away"), or stable. Before that only the gap shows.
 * - Which battle: the player's own (with the car ahead or behind) first, else the closest in the top ten. A pair shows
 *   once it has run within BATTLE_GAP_S for a few seconds, from the second lap on; on for BATTLE_ON_MS, then off for
 *   BATTLE_OFF_MS, and another battle after that (it ends early when the two part, pit or stop).
 *
 * Pure, no three.js or DOM.
 */
import type { RaceStandingEntry, RaceStatus } from "@/types/f1";

/** Two cars this close (s) are in a battle */
export const BATTLE_GAP_S = 1;
/** Closer than this (s) the car behind is attacking */
export const ATTACK_GAP_S = 0.3;
/** A gap moving less than this a lap (s) is stable */
export const STABLE_RATE_S = 0.05;
/** Laps of gap history a forecast needs */
export const FORECAST_LAPS = 2;
/** The last this many laps make the trend */
const TREND_LAPS = 3;
/** On screen, then off before the next (ms) */
export const BATTLE_ON_MS = 15000;
export const BATTLE_OFF_MS = 25000;
/** Within the gap this long before it shows (ms) */
export const BATTLE_SETTLE_MS = 3000;
/** Apart by more than this (s) the battle is over */
const BATTLE_BREAK_S = 1.6;
/** The closest battle is looked for down to this place */
const TOP_PLACES = 10;

export type BattleForecast =
  | { kind: "attacking" }
  | { kind: "closing"; rateS: number; catchLaps: number | null }
  | { kind: "pullingAway"; rateS: number }
  | { kind: "stable" };

/**
 * The forecast from the gap at the last lap lines (oldest first) and the gap now: null until FORECAST_LAPS laps of
 * history. `lapsLeft`: laps still to race for the car behind, its current one included (a catch beyond them is not
 * promised)
 */
export function battleForecast(lapGaps: readonly number[], gapNowS: number, lapsLeft: number): BattleForecast | null {
  if (lapGaps.length < FORECAST_LAPS + 1) return null;
  if (gapNowS <= ATTACK_GAP_S) return { kind: "attacking" };
  // The trend: the least-squares slope of the gap per lap over the last laps (+ = opening)
  const ys = lapGaps.slice(-(TREND_LAPS + 1));
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) * (i - mx);
  }
  const slope = den > 0 ? num / den : 0;
  if (slope <= -STABLE_RATE_S) {
    const rateS = -slope;
    const laps = Math.max(1, Math.ceil((gapNowS - ATTACK_GAP_S) / rateS));
    return { kind: "closing", rateS, catchLaps: laps <= lapsLeft ? laps : null };
  }
  if (slope >= STABLE_RATE_S) return { kind: "pullingAway", rateS: slope };
  return { kind: "stable" };
}

export interface BattleView {
  /** The place fought for (the car ahead's) */
  position: number;
  ahead: RaceStandingEntry;
  behind: RaceStandingEntry;
  gapS: number;
  forecast: BattleForecast | null;
  /** Counts the battles shown: the strip's animations start over on a new one */
  id: number;
}

interface PairHistory {
  ahead: string;
  /** The car behind's lap at the last sample */
  lap: number;
  gaps: number[];
}

const running = (e: RaceStandingEntry) => !e.retired && !e.finished && !e.inPit && !e.pitBox;
const gapOf = (st: readonly RaceStandingEntry[], i: number) =>
  st[i].intervalS ?? st[i].gapToLeaderS - st[i - 1].gapToLeaderS;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class BattleTracker {
  /** Gap history by the car behind */
  private readonly history = new Map<string, PairHistory>();
  /** Since when each pair (either order) has run within the gap */
  private readonly closeSince = new Map<string, number>();
  private shown: { key: string; a: string; b: string; sinceMs: number } | null = null;
  private lastKey: string | null = null;
  private offUntilMs = 0;
  private count = 0;

  reset(): void {
    this.history.clear();
    this.closeSince.clear();
    this.shown = null;
    this.lastKey = null;
    this.offUntilMs = 0;
  }

  /** The battle to show now, or null */
  update(race: RaceStatus, nowMs: number): BattleView | null {
    const st = race.standings;
    if (race.phase === "lights" || st.length < 2) {
      this.reset();
      return null;
    }
    const total = race.totalLaps ?? 0;

    // Gap history at each lap line, while the car ahead stays the same
    for (let i = 0; i < st.length; i++) {
      const e = st[i];
      if (i === 0 || !running(e) || !running(st[i - 1])) {
        this.history.delete(e.driverCode);
        continue;
      }
      const ahead = st[i - 1].driverCode;
      const h = this.history.get(e.driverCode);
      if (!h || h.ahead !== ahead || e.lap < h.lap) {
        this.history.set(e.driverCode, { ahead, lap: e.lap, gaps: [] });
      } else if (e.lap > h.lap) {
        h.lap = e.lap;
        h.gaps.push(gapOf(st, i));
        if (h.gaps.length > TREND_LAPS + 2) h.gaps.shift();
      }
    }

    // Pairs within the gap now, and since when (from the second lap: the start is everyone's battle)
    const close = new Set<string>();
    if (st[0].lap >= 2) {
      for (let i = 1; i < st.length; i++) {
        if (!running(st[i]) || !running(st[i - 1]) || gapOf(st, i) > BATTLE_GAP_S) continue;
        const key = pairKey(st[i - 1].driverCode, st[i].driverCode);
        close.add(key);
        if (!this.closeSince.has(key)) this.closeSince.set(key, nowMs);
      }
    }
    for (const key of [...this.closeSince.keys()]) if (!close.has(key)) this.closeSince.delete(key);

    // The battle on screen: still on while the two run together, in either order
    if (this.shown) {
      const s = this.shown;
      const i = st.findIndex((e) => e.driverCode === s.a || e.driverCode === s.b);
      const together =
        i >= 0 &&
        i + 1 < st.length &&
        pairKey(st[i].driverCode, st[i + 1].driverCode) === s.key &&
        running(st[i]) &&
        running(st[i + 1]) &&
        gapOf(st, i + 1) <= BATTLE_BREAK_S;
      if (!together || nowMs - s.sinceMs >= BATTLE_ON_MS) {
        this.shown = null;
        this.offUntilMs = nowMs + BATTLE_OFF_MS;
        return null;
      }
      return this.view(st, i, total);
    }
    if (nowMs < this.offUntilMs) return null;

    // A new one: the player's own, else the closest in the top ten, another than the last when there is one
    let pick = -1;
    let pickPlayer = false;
    let pickGap = Infinity;
    let pickIsLast = true;
    for (let i = 1; i < st.length; i++) {
      const key = pairKey(st[i - 1].driverCode, st[i].driverCode);
      const since = this.closeSince.get(key);
      if (since === undefined || nowMs - since < BATTLE_SETTLE_MS) continue;
      const player = st[i].isPlayer || st[i - 1].isPlayer;
      if (!player && i + 1 > TOP_PLACES) continue;
      const isLast = key === this.lastKey;
      const gap = gapOf(st, i);
      const better =
        pick < 0 ||
        (player !== pickPlayer ? player : isLast !== pickIsLast ? !isLast : gap < pickGap);
      if (better) {
        pick = i;
        pickPlayer = player;
        pickGap = gap;
        pickIsLast = isLast;
      }
    }
    if (pick < 0) return null;
    const key = pairKey(st[pick - 1].driverCode, st[pick].driverCode);
    this.shown = { key, a: st[pick - 1].driverCode, b: st[pick].driverCode, sinceMs: nowMs };
    this.lastKey = key;
    this.count++;
    return this.view(st, pick - 1, total);
  }

  /** The strip for the pair at `i` (ahead) and `i + 1` */
  private view(st: readonly RaceStandingEntry[], i: number, total: number): BattleView {
    const ahead = st[i];
    const behind = st[i + 1];
    const gapS = gapOf(st, i + 1);
    const h = this.history.get(behind.driverCode);
    const gaps = h && h.ahead === ahead.driverCode ? h.gaps : [];
    return {
      position: i + 1,
      ahead,
      behind,
      gapS,
      forecast: battleForecast(gaps, gapS, Math.max(0, total - behind.lap + 1)),
      id: this.count,
    };
  }
}
