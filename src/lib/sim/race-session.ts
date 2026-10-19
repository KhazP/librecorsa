/**
 * Race timing shared by the AI field and multiplayer races: distance-bucket gaps, lap times, the chequered flag and
 * the final classification. A multiplayer race also runs its start procedure here, on the host's clock, so every
 * client shows the same lights and has the same lights-out instant.
 */
import type { RaceResultEntry, RaceStandingEntry, RaceStatus, TireCompound } from "@/types/f1";
import type { InterpolatedPeerState, PeerRaceProgress, RaceStartInfo } from "@/lib/sim/multiplayer-sync";

/** Gap timing resolution: the race time at which the first car reached each bucket of race distance */
const GAP_BUCKET_M = 25;
const LIGHT_INTERVAL_MS = 1000;
/** After the winner finishes, the classification closes once everyone is in or after this long */
const CLASSIFICATION_CLOSE_S = 90;

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

/** Running order: finishers by time (penalties included) first, then everyone else by distance */
export function raceOrder(racers: readonly RacerProgress[]): RacerProgress[] {
  return [...racers].sort((a, b) => {
    if (a.finishTimeS !== null && b.finishTimeS !== null) return (classifiedTimeS(a) ?? 0) - (classifiedTimeS(b) ?? 0);
    if (a.finishTimeS !== null) return -1;
    if (b.finishTimeS !== null) return 1;
    return b.distM - a.distM;
  });
}

/** Final classification of an ordered field */
export function classify(
  ordered: readonly RacerProgress[],
  lapLengthM: number,
  totalLaps: number,
  final: boolean
): RaceResultEntry[] {
  const winner = ordered[0];
  const winnerTime = winner ? classifiedTimeS(winner) : null;
  return ordered.map((r, i) => {
    const time = classifiedTimeS(r);
    const lapsCompleted = Math.max(0, Math.min(totalLaps, Math.floor(r.distM / lapLengthM)));
    const lapsDown = r.finishTimeS === null && winner ? Math.max(0, Math.floor((winner.distM - r.distM) / lapLengthM)) : 0;
    return {
      position: i + 1,
      driverCode: r.code,
      name: r.name,
      teamColorHex: r.color,
      isPlayer: r.isPlayer,
      finishTimeS: time,
      gapS: i > 0 && time !== null && winnerTime !== null ? time - winnerTime : null,
      lapsDown,
      lapsCompleted,
      bestLapMs: r.bestLapMs,
      dnf: final && r.finishTimeS === null,
      penaltyS: r.penaltyS ? r.penaltyS : undefined,
    };
  });
}

/** True once everyone has finished, or the winner finished long enough ago */
export function classificationClosed(ordered: readonly RacerProgress[], raceTimeS: number): boolean {
  const winner = ordered[0];
  if (!winner || winner.finishTimeS === null) return false;
  return ordered.every((r) => r.finishTimeS !== null) || raceTimeS - winner.finishTimeS > CLASSIFICATION_CLOSE_S;
}

/** Lap counting from the race distance of one car (the player's own) */
export class LapClock {
  distM = 0;
  finishTimeS: number | null = null;
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
    this.bestLapMs = null;
    this.lastLapMs = null;
    this.lapsDone = 0;
    this.lapStartS = 0;
  }

  /** Call every frame once the race runs; returns true on the frame the car takes the flag */
  update(sMeters: number, raceTimeS: number, totalLaps: number): boolean {
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
      if (laps >= totalLaps) {
        this.finishTimeS = raceTimeS;
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
  private readonly lightsOutHostMs: number;
  /** Last known progress of every remote racer (kept when they disconnect) */
  private remote = new Map<string, RacerProgress>();
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
      });
    }
  }

  /** The player's grid slot (0 = pole) */
  get gridSlot(): number {
    return Math.max(0, this.start.grid.indexOf(this.localPeerId));
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
      best: this.lapClock.bestLapMs,
      last: this.lapClock.lastLapMs,
      pen: this.penaltyS || undefined,
      cmp: this.compound,
    };
  }

  /** Takes the remote racers' latest reported progress (only for this race) */
  ingestPeers(peers: readonly InterpolatedPeerState[]): void {
    for (const p of peers) {
      if (!p.race || p.race.id !== this.start.id) continue;
      const existing = this.remote.get(p.peerId);
      this.remote.set(p.peerId, {
        id: p.peerId,
        code: p.driverCode,
        name: p.name ?? existing?.name ?? p.driverCode,
        color: p.teamColorHex,
        isPlayer: false,
        distM: p.race.dist,
        speedMs: p.speedKmh / 3.6,
        finishTimeS: p.race.fin,
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
    };
    const field = [me, ...this.remote.values()];
    const L = this.lapLengthM;
    if (frame.phase === "racing") this.gaps.record(frame.raceTimeS, field.map((r) => r.distM));
    const ordered = raceOrder(field);
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
    };
  }
}
