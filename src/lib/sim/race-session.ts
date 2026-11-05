/**
 * Race timing shared by the AI field and multiplayer races: distance-bucket gaps, lap times, the chequered flag and
 * the final classification. A multiplayer race also runs its start procedure here, on the host's clock, so every
 * client shows the same lights and has the same lights-out instant.
 */
import type { RaceResultEntry, RaceSplits, RaceStandingEntry, RaceStatus, TireCompound } from "@/types/f1";
import type { InterpolatedPeerState, PeerRaceProgress, RaceStartInfo } from "@/lib/sim/multiplayer-sync";

/** Gap timing resolution: the race time at which the first car reached each bucket of race distance */
const GAP_BUCKET_M = 25;
const LIGHT_INTERVAL_MS = 1000;
/** After the winner finishes, the classification closes once everyone is in or after this long */
const CLASSIFICATION_CLOSE_S = 90;
/** A multiplayer car that has sent nothing for this race for this long (never started, or dropped): DNF */
const NO_SHOW_DNF_S = 30;

const wrapHalf = (d: number, L: number) => ((((d + L / 2) % L) + L) % L) - L / 2;

/** One car in the classification */
export interface RacerProgress {
  id: string;
  code: string;
  name: string;
  color: string;
  isPlayer: boolean;
  /** Race distance from the start line (m), laps included; negative on the grid behind the line */
  distM: number;
  /** Speed for the in-bucket gap correction (m/s) */
  speedMs: number;
  finishTimeS: number | null;
  bestLapMs: number | null;
  /** Last completed lap (ms) */
  lastLapMs?: number | null;
  /** Time penalties to add at the flag (s) */
  penaltyS?: number;
  compound?: TireCompound;
  /**
   * Laps completed when the car took the flag. After the winner finishes, every car finishes on its next line
   * crossing, so a lapped car finishes a lap (or more) short; absent on a finisher = the full race distance
   */
  finishLaps?: number;
  /** Grid slot (0 = pole), the last tie-break; absent = behind everyone with one */
  grid?: number;
  /** Retired (a multiplayer car whose peer dropped before the flag): classified DNF, behind every runner */
  dnf?: boolean;
}

/** Race time at the flag with the time penalties added (s); null while running */
export const classifiedTimeS = (r: Pick<RacerProgress, "finishTimeS" | "penaltyS">): number | null =>
  r.finishTimeS === null ? null : r.finishTimeS + (r.penaltyS ?? 0);

/** Lap distance (m) of a race distance */
export const lapPositionM = (distM: number, lapLengthM: number) => ((distM % lapLengthM) + lapLengthM) % lapLengthM;

/** Interval timing from race distances: the time since the leader passed the same point */
export class GapTimer {
  private bucketTimes = new Map<number, number>();

  reset(): void {
    this.bucketTimes.clear();
  }

  /** Call every frame with every car's distance */
  record(raceTimeS: number, distances: Iterable<number>): void {
    for (const d of distances) {
      const bucket = Math.floor(d / GAP_BUCKET_M);
      if (!this.bucketTimes.has(bucket)) this.bucketTimes.set(bucket, raceTimeS);
    }
    if (this.bucketTimes.size > 4000) {
      let min = Infinity;
      for (const k of this.bucketTimes.keys()) min = Math.min(min, k);
      this.bucketTimes.delete(min);
    }
  }

  gapS(raceTimeS: number, distM: number, speedMs: number): number {
    const bucket = Math.floor(distM / GAP_BUCKET_M);
    const t = this.bucketTimes.get(bucket);
    if (t === undefined) return 0;
    const inBucketS = (distM - bucket * GAP_BUCKET_M) / Math.max(5, speedMs);
    return Math.max(0, raceTimeS - t - inBucketS);
  }
}

/**
 * Split timing (Speed Dreams' "split differences to nearby opponents"): every car's race time at fixed points of race
 * distance, so a gap is a time measured at the same point of the track (when the car ahead was where I am now, when I
 * was where the car behind is now), not a distance divided by a speed.
 */
export class SplitTimer {
  private readonly cars = new Map<string, { times: Map<number, number>; maxD: number; lastT: number }>();

  constructor(
    private readonly stepM = 10,
    /** History kept behind each car (m) */
    private readonly keepM = 15_000
  ) {}

  reset(): void {
    this.cars.clear();
  }

  /** Call every frame (racing) with a car's race distance; crossing times are interpolated between frames */
  record(id: string, raceTimeS: number, distM: number): void {
    const step = this.stepM;
    let c = this.cars.get(id);
    if (!c) {
      c = { times: new Map(), maxD: distM, lastT: raceTimeS };
      this.cars.set(id, c);
      return;
    }
    if (distM > c.maxD) {
      const k0 = Math.floor(c.maxD / step) + 1;
      const k1 = Math.floor(distM / step);
      for (let k = k0; k <= k1; k++) {
        const u = (k * step - c.maxD) / (distM - c.maxD);
        c.times.set(k, c.lastT + (raceTimeS - c.lastT) * u);
      }
      c.maxD = distM;
      if (c.times.size * step > this.keepM * 1.2) {
        const floor = Math.floor((distM - this.keepM) / step);
        for (const k of c.times.keys()) if (k < floor) c.times.delete(k);
      }
    }
    c.lastT = raceTimeS;
  }

  /** Race time at which a car passed a race distance; null when it has not (or it is no longer kept) */
  timeAt(id: string, distM: number): number | null {
    const c = this.cars.get(id);
    if (!c || distM > c.maxD) return null;
    const step = this.stepM;
    const k = Math.floor(distM / step);
    const t0 = c.times.get(k);
    const t1 = c.times.get(k + 1);
    if (t0 === undefined) return t1 ?? null;
    if (t1 === undefined) {
      // Between the last checkpoint and the car's current distance
      const u = (distM - k * step) / Math.max(1e-6, c.maxD - k * step);
      return t0 + (c.lastT - t0) * Math.min(1, u);
    }
    return t0 + (t1 - t0) * ((distM - k * step) / step);
  }

  /** Time (s) since car `aheadId` passed the point where car `behindId` is now; null without timing there */
  gapS(raceTimeS: number, aheadId: string, behindDistM: number): number | null {
    const t = this.timeAt(aheadId, behindDistM);
    return t === null ? null : Math.max(0, raceTimeS - t);
  }
}

/**
 * The split gaps from the player to the cars directly ahead and behind in the running order, with how each gap moved
 * over the last few seconds
 */
export class PlayerSplits {
  private history: { t: number; ahead: string | null; aheadS: number | null; behind: string | null; behindS: number | null }[] = [];

  reset(): void {
    this.history = [];
  }

  compute(
    timer: SplitTimer,
    raceTimeS: number,
    ordered: readonly Pick<RacerProgress, "id" | "code" | "color" | "isPlayer" | "distM" | "speedMs" | "finishTimeS">[]
  ): RaceSplits | undefined {
    const i = ordered.findIndex((r) => r.isPlayer);
    if (i < 0) return undefined;
    const me = ordered[i];
    if (me.finishTimeS !== null) return undefined;
    const a = i > 0 ? ordered[i - 1] : null;
    const b = i + 1 < ordered.length ? ordered[i + 1] : null;
    // The fallbacks (no timing at that point yet, e.g. off the grid) use the distance over the chasing car's speed
    const aheadS = a ? (timer.gapS(raceTimeS, a.id, me.distM) ?? (a.distM - me.distM) / Math.max(5, me.speedMs)) : null;
    const behindS = b && b.finishTimeS === null ? (timer.gapS(raceTimeS, me.id, b.distM) ?? (me.distM - b.distM) / Math.max(5, b.speedMs)) : null;
    this.history.push({ t: raceTimeS, ahead: a?.id ?? null, aheadS, behind: b?.id ?? null, behindS });
    while (this.history.length > 2 && this.history[1].t < raceTimeS - SPLIT_TREND_S) this.history.shift();
    const old = this.history[0];
    const trend = (now: number | null, then: number | null, same: boolean) =>
      now !== null && then !== null && same && raceTimeS - old.t > 1 ? now - then : undefined;
    return {
      ahead:
        a && aheadS !== null
          ? { driverCode: a.code, teamColorHex: a.color, gapS: aheadS, changeS: trend(aheadS, old.aheadS, old.ahead === a.id) }
          : undefined,
      behind:
        b && behindS !== null
          ? { driverCode: b.code, teamColorHex: b.color, gapS: behindS, changeS: trend(behindS, old.behindS, old.behind === b.id) }
          : undefined,
    };
  }
}

/** How far back the split trend looks (s) */
const SPLIT_TREND_S = 4;

const gridOf = (r: RacerProgress) => r.grid ?? Number.MAX_SAFE_INTEGER;
/** Laps a finisher is classified on */
const lapsAtFlag = (r: RacerProgress, totalLaps: number) => r.finishLaps ?? totalLaps;

/**
 * Running order, as a timing screen classifies it: finishers on laps completed, then race time (penalties included);
 * a car still running sits where its distance puts it against the line each finisher crossed (so a lead-lap car on
 * its last lap is ahead of a lapped finisher); retired cars last. Ties go to whoever got there first (the earlier
 * line crossing for finishers), then the grid. Without the lap length, finishers simply lead the runners.
 */
export function raceOrder(racers: readonly RacerProgress[], lapLengthM?: number): RacerProgress[] {
  return [...racers].sort((a, b) => {
    if (!!a.dnf !== !!b.dnf) return a.dnf ? 1 : -1;
    const aFin = a.finishTimeS !== null && !a.dnf;
    const bFin = b.finishTimeS !== null && !b.dnf;
    if (aFin && bFin) {
      // A finisher without a lap count ran the full distance: at least as many laps as any lapped finisher
      const la = a.finishLaps ?? Infinity;
      const lb = b.finishLaps ?? Infinity;
      if (la !== lb) return lb - la;
      return (
        (classifiedTimeS(a) as number) - (classifiedTimeS(b) as number) ||
        (a.finishTimeS as number) - (b.finishTimeS as number) ||
        gridOf(a) - gridOf(b)
      );
    }
    if (aFin !== bFin) {
      if (lapLengthM === undefined) return aFin ? -1 : 1;
      const fin = aFin ? a : b;
      const run = aFin ? b : a;
      // A full-distance finisher (no lap count) is at the line no runner can pass without finishing
      const line = fin.finishLaps === undefined ? Infinity : fin.finishLaps * lapLengthM;
      const runnerAhead = run.distM > line;
      return runnerAhead === aFin ? 1 : -1;
    }
    return b.distM - a.distM || gridOf(a) - gridOf(b);
  });
}

/** Final classification of an ordered field (`raceOrder`) */
export function classify(
  ordered: readonly RacerProgress[],
  lapLengthM: number,
  totalLaps: number,
  final: boolean
): RaceResultEntry[] {
  const winner = ordered[0];
  const winnerTime = winner ? classifiedTimeS(winner) : null;
  const winnerLaps = winner && winner.finishTimeS !== null && !winner.dnf ? lapsAtFlag(winner, totalLaps) : null;
  return ordered.map((r, i) => {
    const time = classifiedTimeS(r);
    const finished = r.finishTimeS !== null && !r.dnf;
    const lapsCompleted = finished
      ? Math.min(totalLaps, lapsAtFlag(r, totalLaps))
      : Math.max(0, Math.min(totalLaps, Math.floor(r.distM / lapLengthM)));
    // Laps behind the winner: a finisher by laps completed; a car still running by the line it has yet to reach
    const lapsDown =
      winnerLaps === null || i === 0
        ? 0
        : finished
          ? Math.max(0, winnerLaps - lapsCompleted)
          : Math.max(0, Math.floor((winnerLaps * lapLengthM - r.distM) / lapLengthM));
    return {
      position: i + 1,
      driverCode: r.code,
      name: r.name,
      teamColorHex: r.color,
      isPlayer: r.isPlayer,
      finishTimeS: finished ? time : null,
      gapS: i > 0 && finished && lapsDown === 0 && time !== null && winnerTime !== null ? time - winnerTime : null,
      lapsDown,
      lapsCompleted,
      bestLapMs: r.bestLapMs,
      dnf: !!r.dnf || (final && !finished),
      penaltyS: r.penaltyS ? r.penaltyS : undefined,
    };
  });
}

/** True once everyone has finished or retired, or the winner finished long enough ago */
export function classificationClosed(ordered: readonly RacerProgress[], raceTimeS: number): boolean {
  const winner = ordered[0];
  if (!winner || winner.finishTimeS === null || winner.dnf) return false;
  return ordered.every((r) => r.finishTimeS !== null || r.dnf) || raceTimeS - winner.finishTimeS > CLASSIFICATION_CLOSE_S;
}

/** Lap counting from the race distance of one car (the player's own) */
export class LapClock {
  distM = 0;
  finishTimeS: number | null = null;
  /** Laps completed when the car took the flag; null while running */
  finishLaps: number | null = null;
  bestLapMs: number | null = null;
  lastLapMs: number | null = null;
  private prevS = 0;
  private lapsDone = 0;
  private lapStartS = 0;

  constructor(private readonly lapLengthM: number) {}

  /** Starts from the grid: a car behind the line has a negative distance */
  reset(sMeters: number): void {
    const L = this.lapLengthM;
    this.prevS = sMeters;
    this.distM = sMeters > L / 2 ? sMeters - L : sMeters;
    this.finishTimeS = null;
    this.finishLaps = null;
    this.bestLapMs = null;
    this.lastLapMs = null;
    this.lapsDone = 0;
    this.lapStartS = 0;
  }

  /**
   * Call every frame once the race runs; returns true on the frame the car takes the flag: at the race distance, or
   * on its first line crossing once the chequered flag is out (`flagOut`: someone has finished), as a lapped car does
   */
  update(sMeters: number, raceTimeS: number, totalLaps: number, flagOut = false): boolean {
    const L = this.lapLengthM;
    this.distM += wrapHalf(sMeters - this.prevS, L);
    this.prevS = sMeters;
    const laps = Math.floor(this.distM / L);
    if (laps > this.lapsDone && this.finishTimeS === null) {
      const lapMs = (raceTimeS - this.lapStartS) * 1000;
      // The first lap starts from the grid: still a lap, as on a timing screen
      if (lapMs > 1000 && (this.bestLapMs === null || lapMs < this.bestLapMs)) this.bestLapMs = Math.round(lapMs);
      if (lapMs > 1000) this.lastLapMs = Math.round(lapMs);
      this.lapsDone = laps;
      this.lapStartS = raceTimeS;
      if (laps >= totalLaps || flagOut) {
        this.finishTimeS = raceTimeS;
        this.finishLaps = Math.min(laps, totalLaps);
        return true;
      }
    }
    return false;
  }
}

export interface MultiplayerRaceFrame {
  phase: "countdown" | "lights" | "racing";
  lightsOn: number;
  /** Seconds until the first light (countdown only) */
  countdownS: number;
  raceTimeS: number;
}

/** A multiplayer race as this client sees it: the shared start, its own lap clock and everyone's reported progress */
export class MultiplayerRace {
  readonly lapClock: LapClock;
  private readonly gaps = new GapTimer();
  private readonly splitTimer = new SplitTimer();
  private readonly playerSplits = new PlayerSplits();
  private readonly lightsOutHostMs: number;
  /** Last known progress of every remote racer (kept when they disconnect) */
  private remote = new Map<string, RacerProgress>();
  /** Race time each remote racer last reported progress for this race (s) */
  private lastSeenS = new Map<string, number>();
  /** The player's own time penalties (s) and tyres, reported to everyone */
  penaltyS = 0;
  compound: TireCompound = "soft";

  constructor(
    readonly start: RaceStartInfo,
    private readonly lapLengthM: number,
    readonly localPeerId: string,
    private readonly identity: { name: string; code: string; color: string },
    roster: readonly { peerId: string; name: string; code: string; color: string }[]
  ) {
    this.lapClock = new LapClock(lapLengthM);
    this.lightsOutHostMs = start.lightsStartHostMs + 5 * LIGHT_INTERVAL_MS + start.holdMs;
    for (const p of roster) {
      if (p.peerId === localPeerId || !start.grid.includes(p.peerId)) continue;
      this.remote.set(p.peerId, {
        id: p.peerId,
        code: p.code,
        name: p.name,
        color: p.color,
        isPlayer: false,
        distM: -start.grid.indexOf(p.peerId) * 8,
        speedMs: 0,
        finishTimeS: null,
        bestLapMs: null,
        grid: start.grid.indexOf(p.peerId),
      });
    }
  }

  /** The player's grid slot (0 = pole); a player missing from the grid starts at the back, not on pole */
  get gridSlot(): number {
    const slot = this.start.grid.indexOf(this.localPeerId);
    return slot >= 0 ? slot : this.start.grid.length;
  }

  /** Someone has taken the chequered flag: every car still running finishes on its next line crossing */
  get flagOut(): boolean {
    if (this.lapClock.finishTimeS !== null) return true;
    for (const r of this.remote.values()) if (r.finishTimeS !== null && !r.dnf) return true;
    return false;
  }

  frame(hostNowMs: number): MultiplayerRaceFrame {
    const sinceLights = hostNowMs - this.start.lightsStartHostMs;
    if (sinceLights < 0) return { phase: "countdown", lightsOn: 0, countdownS: -sinceLights / 1000, raceTimeS: 0 };
    if (hostNowMs < this.lightsOutHostMs) {
      return {
        phase: "lights",
        lightsOn: Math.min(5, 1 + Math.floor(sinceLights / LIGHT_INTERVAL_MS)),
        countdownS: 0,
        raceTimeS: 0,
      };
    }
    return { phase: "racing", lightsOn: 0, countdownS: 0, raceTimeS: (hostNowMs - this.lightsOutHostMs) / 1000 };
  }

  /** Contact with other players this frame (never on the grid; optionally not on the opening lap) */
  collisionsActive(frame: MultiplayerRaceFrame): boolean {
    if (frame.phase !== "racing" || this.start.collisions === "off") return false;
    if (this.start.collisions === "ghost_lap1") return this.lapClock.distM >= this.lapLengthM;
    return true;
  }

  /** What this client reports with its state packets */
  progress(): PeerRaceProgress {
    return {
      id: this.start.id,
      dist: Math.round(this.lapClock.distM * 10) / 10,
      fin: this.lapClock.finishTimeS,
      laps: this.lapClock.finishLaps ?? undefined,
      best: this.lapClock.bestLapMs,
      last: this.lapClock.lastLapMs,
      pen: this.penaltyS || undefined,
      cmp: this.compound,
    };
  }

  /** Takes the remote racers' latest reported progress (only for this race) at race time `raceTimeS` */
  ingestPeers(peers: readonly InterpolatedPeerState[], raceTimeS = 0): void {
    for (const p of peers) {
      if (!p.race || p.race.id !== this.start.id) continue;
      const existing = this.remote.get(p.peerId);
      this.lastSeenS.set(p.peerId, raceTimeS);
      this.remote.set(p.peerId, {
        id: p.peerId,
        code: p.driverCode,
        name: p.name ?? existing?.name ?? p.driverCode,
        color: p.teamColorHex,
        isPlayer: false,
        distM: p.race.dist,
        speedMs: p.speedKmh / 3.6,
        finishTimeS: p.race.fin,
        finishLaps: p.race.fin !== null ? p.race.laps : undefined,
        grid: existing?.grid ?? this.start.grid.indexOf(p.peerId),
        bestLapMs: p.race.best,
        lastLapMs: p.race.last ?? null,
        penaltyS: p.race.pen ?? 0,
        compound: p.race.cmp,
      });
    }
  }

  status(frame: MultiplayerRaceFrame, playerSpeedMs: number): RaceStatus {
    const me: RacerProgress = {
      id: this.localPeerId,
      code: this.identity.code,
      name: this.identity.name,
      color: this.identity.color,
      isPlayer: true,
      distM: this.lapClock.distM,
      speedMs: playerSpeedMs,
      finishTimeS: this.lapClock.finishTimeS,
      bestLapMs: this.lapClock.bestLapMs,
      lastLapMs: this.lapClock.lastLapMs,
      penaltyS: this.penaltyS,
      compound: this.compound,
      finishLaps: this.lapClock.finishLaps ?? undefined,
      grid: this.gridSlot,
    };
    // A remote car that has sent nothing for this race for a while (it never started, or its player dropped) is out
    // unless it already finished; it comes back if its packets do
    const remote = [...this.remote.values()].map((r) =>
      frame.phase === "racing" && r.finishTimeS === null && frame.raceTimeS - (this.lastSeenS.get(r.id) ?? 0) > NO_SHOW_DNF_S
        ? { ...r, dnf: true }
        : r
    );
    const field = [me, ...remote];
    const L = this.lapLengthM;
    if (frame.phase === "racing") {
      this.gaps.record(frame.raceTimeS, field.map((r) => r.distM));
      for (const r of field) this.splitTimer.record(r.id, frame.raceTimeS, r.distM);
    }
    const ordered = raceOrder(field, L);
    const winner = ordered[0];
    let gapFloor = 0;
    let prevGap = 0;
    const standings: RaceStandingEntry[] = ordered.map((r, i) => {
      let gap = 0;
      if (frame.phase === "racing") {
        const rt = classifiedTimeS(r);
        const wt = classifiedTimeS(winner);
        gap = rt !== null && wt !== null ? rt - wt : this.gaps.gapS(frame.raceTimeS, r.distM, r.speedMs);
        gapFloor = Math.max(gapFloor, gap);
      }
      const intervalS = i > 0 ? gapFloor - prevGap : undefined;
      prevGap = gapFloor;
      return {
        driverCode: r.code,
        teamColorHex: r.color,
        isPlayer: r.isPlayer,
        lap: Math.max(1, Math.min(this.start.laps, Math.floor(r.distM / L) + 1)),
        gapToLeaderS: gapFloor,
        intervalS,
        name: r.name,
        finished: r.finishTimeS !== null,
        bestLapMs: r.bestLapMs,
        lastLapMs: r.lastLapMs ?? null,
        trackS: lapPositionM(r.distM, L),
        raceDistM: r.distM,
        compound: r.compound,
        penaltyS: r.penaltyS || undefined,
      };
    });
    const playerFinished = me.finishTimeS !== null;
    const final = playerFinished && classificationClosed(ordered, frame.raceTimeS);
    return {
      phase: frame.phase === "racing" ? (playerFinished ? "finished" : "racing") : "lights",
      lightsOn: frame.lightsOn,
      countdownS: frame.phase === "countdown" ? frame.countdownS : undefined,
      position: ordered.indexOf(me) + 1,
      fieldSize: ordered.length,
      lap: Math.max(1, Math.min(this.start.laps, Math.floor(me.distM / L) + 1)),
      totalLaps: this.start.laps,
      standings,
      results: playerFinished ? classify(ordered, L, this.start.laps, final) : undefined,
      resultsFinal: final,
      multiplayer: true,
      splits: frame.phase === "racing" ? this.playerSplits.compute(this.splitTimer, frame.raceTimeS, ordered) : undefined,
    };
  }
}
