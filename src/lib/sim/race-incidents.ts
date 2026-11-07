/**
 * Race control for an AI race: contacts are investigated and judged, yellow flags are shown where a car is stopped
 * or spinning, and the messages the HUD shows are kept here.
 *
 * A contact is judged on the facts the field reports at the moment of contact (`FieldIncident` 'contact'):
 *  - from behind: the cars roughly in line and the car behind still a good part of a car back: the car behind
 *  - side by side: the car that moved across into the other (its lateral speed toward the other well above the
 *    other's toward it), unless the other moved just as much
 *  - anything else is a racing incident
 * and then on what it did over the next few seconds: a fault that spun, damaged or retired the other car is
 * "causing a collision" (a time penalty, longer when the other car is out); a fault with no consequence is a
 * warning (the player's own) or no further action. An AI driver found at fault races with more caution for a while.
 */
import type { DamageReport } from './car-damage';
import type { FieldIncident } from './ai-opponents';

export type RaceControlMessageKind = 'yellow' | 'green' | 'investigation' | 'penalty' | 'warning' | 'nfa' | 'retired' | 'info';

export interface RaceControlMessage {
  id: number;
  kind: RaceControlMessageKind;
  text: string;
  detail?: string;
  /** Race time it was issued (s) */
  atS: number;
  /** About the player's car */
  player: boolean;
}

type ContactIncident = Extract<FieldIncident, { kind: 'contact' }>;

/** Which car of a contact is at fault (`a` is the car behind), and why */
export function judgeContact(c: ContactIncident, carLengthM = 5, carWidthM = 1.95): { atFault: 'a' | 'b' | null; reason: string } {
  const latGap = c.bLatM - c.aLatM;
  // Toward the other car (m/s): + = closing the lateral gap
  const dir = Math.sign(latGap) || 1;
  const aToward = c.aLatSpeedMs * dir;
  const bToward = -c.bLatSpeedMs * dir;
  // From behind: in line (less than ~2/3 of a car's width apart) and the car behind not yet alongside
  if (Math.abs(latGap) < 0.65 * carWidthM && c.dsM > 0.55 * carLengthM) {
    return { atFault: 'a', reason: 'Hit the car ahead' };
  }
  const MOVE = 0.7;
  if (aToward > MOVE && aToward > 2 * Math.max(0, bToward)) return { atFault: 'a', reason: 'Moved into a car alongside' };
  if (bToward > MOVE && bToward > 2 * Math.max(0, aToward)) return { atFault: 'b', reason: 'Moved into a car alongside' };
  return { atFault: null, reason: 'Racing incident' };
}

/** An open investigation: what the contact did to the car that was hit */
interface Investigation {
  at: string;
  victim: string | null;
  atIsPlayer: boolean;
  victimIsPlayer: boolean;
  carA: string;
  carB: string;
  playerInvolved: boolean;
  reason: string;
  openedS: number;
  impactMs: number;
  victimSpun: boolean;
  victimDamage: number;
  victimRetired: boolean;
}

/** How long after a contact its consequences are looked at (s) */
const INVESTIGATION_S = 3;
/** A pair's contacts within this long are one incident (s) */
const PAIR_DEDUPE_S = 4;
/** Contacts under this closing speed are touches race control lets go (m/s) */
const MIN_IMPACT_MS = 1.5;
export const COLLISION_PENALTY_S = 5;
export const COLLISION_RETIRED_PENALTY_S = 10;
/** An AI driver at fault races with more caution for this long (s) */
export const AT_FAULT_COOLDOWN_S = 20;
/** Messages stay on the feed this long (s) */
const MESSAGE_LIFE_S = 6;

export class RaceIncidents {
  public readonly messages: RaceControlMessage[] = [];
  /** Time penalties per car code (s), served at the flag */
  public readonly penaltiesS = new Map<string, number>();
  /** Race time until which each AI driver races with extra caution after an at-fault contact */
  public readonly cautionUntilS = new Map<string, number>();
  /** Collisions the player caused (penalised) and warnings for contact */
  public playerCollisions = 0;
  public playerContactWarnings = 0;
  private readonly open: Investigation[] = [];
  private readonly pairAt = new Map<string, number>();
  private nextId = 1;
  private yellowShown = false;

  constructor(private readonly playerCode = 'YOU') {}

  public reset(): void {
    this.messages.length = 0;
    this.penaltiesS.clear();
    this.cautionUntilS.clear();
    this.playerCollisions = 0;
    this.playerContactWarnings = 0;
    this.open.length = 0;
    this.pairAt.clear();
    this.yellowShown = false;
  }

  /** Time penalties of a car (s) */
  public penaltyOf(code: string): number {
    return this.penaltiesS.get(code) ?? 0;
  }

  /** Extra overtaking caution (0..1) of an AI driver now */
  public cautionOf(code: string, raceTimeS: number): number {
    const until = this.cautionUntilS.get(code);
    return until !== undefined && raceTimeS < until ? 0.35 : 0;
  }

  /** The messages still on the feed, newest first */
  public live(raceTimeS: number): RaceControlMessage[] {
    return this.messages.filter((m) => raceTimeS - m.atS < MESSAGE_LIFE_S).reverse();
  }

  /**
   * One frame: the field's incidents, and whether the player is approaching a yellow flag (a car stopped or
   * spinning on the road ahead, within the yellow zone)
   */
  public update(raceTimeS: number, incidents: readonly FieldIncident[], playerUnderYellow: boolean): void {
    for (const inc of incidents) {
      switch (inc.kind) {
        case 'contact':
          this.onContact(inc, raceTimeS);
          break;
        case 'damage':
          this.onDamage(inc.code, inc.report);
          break;
        case 'spin':
          for (const o of this.open) if (o.victim === inc.code) o.victimSpun = true;
          break;
        case 'retired':
          for (const o of this.open) if (o.victim === inc.code) o.victimRetired = true;
          this.post(raceTimeS, 'retired', inc.isPlayer ? 'You are out of the race' : `${inc.code} is out of the race`, inc.isPlayer ? 'Damage' : undefined, inc.isPlayer);
          break;
      }
    }
    // Close the investigations whose window has passed
    for (let i = this.open.length - 1; i >= 0; i--) {
      const o = this.open[i];
      if (raceTimeS - o.openedS < INVESTIGATION_S && !o.victimRetired) continue;
      this.open.splice(i, 1);
      this.decide(o, raceTimeS);
    }
    if (playerUnderYellow && !this.yellowShown) this.post(raceTimeS, 'yellow', 'Yellow flag', 'Incident ahead · no overtaking', true);
    if (!playerUnderYellow && this.yellowShown) this.post(raceTimeS, 'green', 'Track clear', undefined, true);
    this.yellowShown = playerUnderYellow;
  }

  private onContact(c: ContactIncident, raceTimeS: number): void {
    if (c.impactMs < MIN_IMPACT_MS) return;
    const key = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    const last = this.pairAt.get(key);
    this.pairAt.set(key, raceTimeS);
    if (last !== undefined && raceTimeS - last < PAIR_DEDUPE_S) {
      const o = this.open.find((x) => (x.carA === c.a && x.carB === c.b) || (x.carA === c.b && x.carB === c.a));
      if (o) o.impactMs = Math.max(o.impactMs, c.impactMs);
      return;
    }
    const verdict = judgeContact(c);
    const at = verdict.atFault === 'a' ? c.a : verdict.atFault === 'b' ? c.b : '';
    const victim = verdict.atFault === 'a' ? c.b : verdict.atFault === 'b' ? c.a : null;
    const playerInvolved = c.aIsPlayer || c.bIsPlayer;
    this.open.push({
      at,
      victim,
      atIsPlayer: at === this.playerCode,
      victimIsPlayer: victim === this.playerCode,
      carA: c.a,
      carB: c.b,
      playerInvolved,
      reason: verdict.reason,
      openedS: raceTimeS,
      impactMs: c.impactMs,
      victimSpun: false,
      victimDamage: 0,
      victimRetired: false,
    });
    if (playerInvolved && c.impactMs > 3) {
      const other = c.aIsPlayer ? c.b : c.a;
      this.post(raceTimeS, 'investigation', `Contact with ${other}`, 'Under investigation', true);
    }
  }

  private onDamage(code: string, report: DamageReport): void {
    for (const o of this.open) if (o.victim === code) o.victimDamage = Math.max(o.victimDamage, report.severity);
  }

  private decide(o: Investigation, raceTimeS: number): void {
    const consequence = o.victimSpun || o.victimRetired || o.victimDamage >= 0.15;
    if (o.at && consequence) {
      const penalty = o.victimRetired ? COLLISION_RETIRED_PENALTY_S : COLLISION_PENALTY_S;
      this.penaltiesS.set(o.at, this.penaltyOf(o.at) + penalty);
      if (o.atIsPlayer) this.playerCollisions++;
      else this.cautionUntilS.set(o.at, raceTimeS + AT_FAULT_COOLDOWN_S);
      this.post(
        raceTimeS,
        'penalty',
        o.atIsPlayer ? `${penalty} s time penalty` : `${o.at} · ${penalty} s penalty`,
        `Causing a collision${o.victim ? ` with ${o.victim}` : ''}`,
        o.atIsPlayer || o.victimIsPlayer
      );
      return;
    }
    if (o.at) {
      if (!o.atIsPlayer) this.cautionUntilS.set(o.at, raceTimeS + AT_FAULT_COOLDOWN_S / 2);
      if (o.atIsPlayer && o.impactMs > 3) {
        this.playerContactWarnings++;
        this.post(raceTimeS, 'warning', 'Warning', `Contact with ${o.victim} · ${o.reason.toLowerCase()}`, true);
      } else if (o.playerInvolved && o.impactMs > 3) {
        this.post(raceTimeS, 'nfa', 'No further action', `${o.at} · ${o.reason.toLowerCase()}`, true);
      }
      return;
    }
    if (o.playerInvolved && (consequence || o.impactMs > 3)) this.post(raceTimeS, 'nfa', 'Racing incident', 'No further action', true);
  }

  private post(atS: number, kind: RaceControlMessageKind, text: string, detail: string | undefined, player: boolean): void {
    this.messages.push({ id: this.nextId++, kind, text, detail, atS, player });
    if (this.messages.length > 40) this.messages.splice(0, this.messages.length - 40);
  }
}
