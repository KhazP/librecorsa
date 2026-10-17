/**
 * AI opponents: full-physics VF26 cars driven by the racing-line AI, with a standing start behind
 * the five start lights, traffic awareness (follow or pass on the free side, give room alongside),
 * simple car-to-car contact and live race standings.
 *
 * The player's car (the VF26 or the f12026-car) is passed in so that it takes part in the start
 * procedure, contact and order; it is stepped by the caller (the field only steps its AI cars).
 */
import * as THREE from 'three';
import { F1Physics2026 } from '@/lib/f1-physics-2026';
import type { BuiltTrackData } from '@/lib/track-data';
import { aiLineOffsetM } from '@/lib/sim/speed-profile';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';
import type { RaceStatus } from '@/types/f1';

export interface AiDriverDef {
  code: string;
  teamColorHex: string;
  /** Fraction of the car's limit the driver runs at */
  pace: number;
}

/** Field in grid order (pole first); the player lines up behind them */
export const AI_DRIVERS: AiDriverDef[] = [
  { code: 'KIG', teamColorHex: '#ff8000', pace: 0.975 },
  { code: 'MUS', teamColorHex: '#e8002d', pace: 0.968 },
  { code: 'NYA', teamColorHex: '#27f4d2', pace: 0.961 },
  { code: 'RUB', teamColorHex: '#3671c6', pace: 0.954 },
  { code: 'HUY', teamColorHex: '#b6babd', pace: 0.947 },
];

const PLAYER_CODE = 'YOU';
/** Car footprint used for contact (m): length, width */
const CAR_LEN_M = 5.0;
const CAR_WID_M = 1.95;
/** Lateral spacing a passing car keeps from the car it passes (m) */
const PASS_SPACING_M = 2.5;
/** Rate at which an AI moves off / back onto its line (m/s) */
const BIAS_RATE_MS = 2.2;
const LIGHT_INTERVAL_S = 1.0;
const GAP_BUCKET_M = 10;

interface FieldCar {
  id: string;
  code: string;
  teamColorHex: string;
  isPlayer: boolean;
  sim: SimulatorCar;
  /** The AI car's physics (null for the player) */
  ai: F1Physics2026 | null;
  pace: number;
  /** Race distance covered (m); negative on the grid behind the line */
  distM: number;
  prevS: number;
  biasM: number;
  stuckS: number;
  peer: InterpolatedPeerState;
}

const wrapHalf = (d: number, L: number) => ((((d + L / 2) % L) + L) % L) - L / 2;

export class AiOpponentField {
  public phase: RaceStatus['phase'] = 'racing';
  public lightsOn = 0;
  private readonly cars: FieldCar[] = [];
  private lightsTimerS = 0;
  private holdS = 0;
  private raceTimeS = 0;
  /** Race time at which the first car reached each distance bucket (gap timing) */
  private bucketTimes = new Map<number, number>();

  constructor(
    private readonly track: BuiltTrackData,
    private readonly player: SimulatorCar,
    drivers: AiDriverDef[] = AI_DRIVERS
  ) {
    for (const d of drivers) {
      const sim = new F1Physics2026(track);
      sim.setAssistPreset('pro');
      sim.aiAutopilot = true;
      sim.aiPaceScale = d.pace;
      this.cars.push(this.makeCar(`ai_${d.code}`, d.code, d.teamColorHex, sim, sim, d.pace));
    }
    this.cars.push(this.makeCar('player', PLAYER_CODE, '#E10600', player, null, 1));
  }

  private makeCar(
    id: string,
    code: string,
    teamColorHex: string,
    sim: SimulatorCar,
    ai: F1Physics2026 | null,
    pace: number
  ): FieldCar {
    return {
      id,
      code,
      teamColorHex,
      isPlayer: ai === null,
      sim,
      ai,
      pace,
      distM: 0,
      prevS: 0,
      biasM: 0,
      stuckS: 0,
      peer: {
        peerId: id,
        driverCode: code,
        teamColorHex,
        position: sim.worldPosition.clone(),
        quaternion: sim.worldQuaternion.clone(),
        linearVelocity: new THREE.Vector3(),
        steerAngle: 0,
        wheelRPMs: [0, 0, 0, 0],
        throttle: 0,
        brake: 0,
        trackS: sim.sMeters,
        speedKmh: 0,
        isAiPeer: true,
      },
    };
  }

  /** The player is held on the grid until the lights go out */
  get playerFrozen(): boolean {
    return this.phase !== 'racing';
  }

  /**
   * Lines the field up: AI cars in grid order, the player behind them. A standing start runs the
   * light sequence (five reds one second apart, then a random 0.2–3 s hold); a rolling start
   * queues the cars on the main straight and races at once.
   */
  public startRace(standing: boolean): void {
    const L = this.track.totalLengthM;
    this.cars.forEach((car, slot) => {
      car.sim.resetToStartGrid(!standing, slot);
      if (car.ai) {
        car.ai.aiLineBiasM = 0;
        car.ai.aiSpeedCapMs = Infinity;
      }
      car.biasM = 0;
      car.stuckS = 0;
      car.prevS = car.sim.sMeters;
      car.distM = car.sim.sMeters > L / 2 ? car.sim.sMeters - L : car.sim.sMeters;
      this.syncPeer(car);
    });
    this.player.aiAutopilot = false;
    this.raceTimeS = 0;
    this.bucketTimes.clear();
    this.phase = standing ? 'lights' : 'racing';
    this.lightsOn = 0;
    this.lightsTimerS = 0;
    this.holdS = 0.2 + Math.random() * 2.8;
  }

  /** Advances the start procedure and steps the AI cars. Call after the player's physics step. */
  public update(dt: number): void {
    if (!(dt > 0)) return;
    if (this.phase === 'lights') {
      this.lightsTimerS += dt;
      this.lightsOn = Math.min(5, 1 + Math.floor(this.lightsTimerS / LIGHT_INTERVAL_S));
      if (this.lightsTimerS >= 4 * LIGHT_INTERVAL_S + LIGHT_INTERVAL_S + this.holdS) {
        this.phase = 'racing';
        this.lightsOn = 0;
      }
      for (const car of this.cars) this.syncPeer(car);
      return;
    }

    this.raceTimeS += dt;
    this.planTraffic(dt);
    for (const car of this.cars) {
      car.ai?.step(dt, {});
    }
    this.resolveContacts();
    this.recoverStuckCars(dt);
    for (const car of this.cars) {
      this.trackDistance(car);
      this.syncPeer(car);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Traffic: give room to cars alongside, pass a slower car ahead on the side with more room, or
  // follow it when there is no room
  // ---------------------------------------------------------------------------------------------
  private planTraffic(dt: number): void {
    const L = this.track.totalLengthM;
    for (const car of this.cars) {
      const me = car.ai;
      if (!me) continue;
      const sample = this.track.getSampleAtDistance(me.sMeters);
      const line = aiLineOffsetM(sample);
      const half = sample.width / 2 - 1.2;
      let targetLat: number | null = null;
      let speedCap = Infinity;

      let ahead: FieldCar | null = null;
      let aheadGap = Infinity;
      for (const other of this.cars) {
        if (other === car) continue;
        const ds = wrapHalf(other.sim.sMeters - me.sMeters, L);
        const dLat = other.sim.lateralOffsetM - me.lateralOffsetM;
        // Alongside: keep a car's width of room
        if (Math.abs(ds) < CAR_LEN_M + 1.5 && Math.abs(dLat) < PASS_SPACING_M) {
          const away = me.lateralOffsetM >= other.sim.lateralOffsetM ? 1 : -1;
          targetLat = other.sim.lateralOffsetM + away * PASS_SPACING_M;
        }
        if (ds > 0 && ds < 90 && Math.abs(dLat) < CAR_WID_M + 0.4 && ds < aheadGap) {
          ahead = other;
          aheadGap = ds;
        }
      }

      if (ahead && targetLat === null) {
        const closing = me.vxMs - ahead.sim.vxMs;
        const reactGap = 8 + Math.max(0, closing) * 2.2 + me.vxMs * 0.2;
        if (aheadGap < reactGap) {
          const aLat = ahead.sim.lateralOffsetM;
          const roomRight = half - aLat;
          const roomLeft = aLat + half;
          const side = roomRight >= roomLeft ? 1 : -1;
          if (Math.max(roomLeft, roomRight) >= PASS_SPACING_M && closing > -1) {
            targetLat = aLat + side * PASS_SPACING_M;
          } else {
            // No room: sit in the tow and wait
            speedCap = ahead.sim.vxMs + Math.max(-4, (aheadGap - 12) * 0.5);
          }
        }
      }

      // Tight corners leave little room to run off-line, so look as far ahead as the car needs to
      // brake: a pass started on the straight must not reach the hairpin off-line
      let kAbs = Math.abs(sample.curvature);
      const lookM = 30 + (me.vxMs * me.vxMs) / 60;
      for (let d = 10; d <= lookM; d += 10) {
        kAbs = Math.max(kAbs, Math.abs(this.track.getSampleAtDistance((me.sMeters + d) % L).curvature));
      }
      const maxBias = kAbs > 0.012 ? 1.2 : kAbs > 0.006 ? 2.5 : 6;
      const biasTarget =
        targetLat === null
          ? 0
          : THREE.MathUtils.clamp(THREE.MathUtils.clamp(targetLat, -half, half) - line, -maxBias, maxBias);
      car.biasM += THREE.MathUtils.clamp(biasTarget - car.biasM, -BIAS_RATE_MS * dt, BIAS_RATE_MS * dt);
      me.aiLineBiasM = car.biasM;
      // Off-line the corner is tighter than planned: give a little speed away for it
      me.aiPaceScale = car.pace * (1 - 0.012 * Math.abs(car.biasM));
      me.aiSpeedCapMs = speedCap;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Contact: rectangles in track coordinates. Side-by-side overlap pushes the cars apart
  // laterally; a nose-to-tail hit exchanges speed (equal masses, restitution 0.2)
  // ---------------------------------------------------------------------------------------------
  private resolveContacts(): void {
    const L = this.track.totalLengthM;
    for (let a = 0; a < this.cars.length; a++) {
      for (let b = a + 1; b < this.cars.length; b++) {
        const A = this.cars[a].sim;
        const B = this.cars[b].sim;
        const ds = wrapHalf(B.sMeters - A.sMeters, L);
        const dLat = B.lateralOffsetM - A.lateralOffsetM;
        const overLong = CAR_LEN_M - Math.abs(ds);
        const overLat = CAR_WID_M - Math.abs(dLat);
        if (overLong <= 0 || overLat <= 0) continue;
        if (overLat < overLong * 0.55) {
          const push = (overLat / 2 + 0.02) * (dLat >= 0 ? 1 : -1);
          A.lateralOffsetM -= push;
          B.lateralOffsetM += push;
          A.vxMs *= 0.995;
          B.vxMs *= 0.995;
        } else {
          const [back, front] = ds >= 0 ? [A, B] : [B, A];
          const closing = back.vxMs - front.vxMs;
          if (closing > 0) {
            const e = 0.2;
            back.vxMs -= (closing * (1 + e)) / 2;
            front.vxMs += (closing * (1 + e)) / 2;
          }
          back.sMeters = (((back.sMeters - overLong - 0.02) % L) + L) % L;
        }
      }
    }
  }

  /** An AI car that has stopped (spun into the gravel, stalled against a wall) rejoins on its line */
  private recoverStuckCars(dt: number): void {
    for (const car of this.cars) {
      const sim = car.ai;
      if (!sim) continue;
      car.stuckS = sim.vxMs < 2 || sim.telemetry.offTrack ? car.stuckS + dt : 0;
      if (car.stuckS > 4) {
        car.stuckS = 0;
        const sample = this.track.getSampleAtDistance(sim.sMeters);
        sim.teleportToDistance(sim.sMeters, Math.min(25, sample.optimalSpeedKmh / 3.6));
        sim.lateralOffsetM = aiLineOffsetM(sample);
        car.biasM = 0;
      }
    }
  }

  private trackDistance(car: FieldCar): void {
    const L = this.track.totalLengthM;
    const s = car.sim.sMeters;
    car.distM += wrapHalf(s - car.prevS, L);
    car.prevS = s;
    const bucket = Math.floor(car.distM / GAP_BUCKET_M);
    if (!this.bucketTimes.has(bucket)) this.bucketTimes.set(bucket, this.raceTimeS);
  }

  private syncPeer(car: FieldCar): void {
    const sim = car.sim;
    const p = car.peer;
    p.position.copy(sim.worldPosition);
    p.quaternion.copy(sim.worldQuaternion);
    p.linearVelocity.set(sim.vyMs, 0, sim.vxMs).applyQuaternion(sim.worldQuaternion);
    p.steerAngle = sim.steerAngleNorm * 0.36;
    for (let i = 0; i < 4; i++) p.wheelRPMs[i] = sim.wheels[i].spinVel * 9.549296;
    p.throttle = sim.telemetry.throttle;
    p.brake = sim.telemetry.brake;
    p.trackS = sim.sMeters;
    p.speedKmh = sim.telemetry.speedKmh;
  }

  /** Physics of the AI cars, in grid order */
  public aiSims(): F1Physics2026[] {
    return this.cars.flatMap((c) => (c.ai ? [c.ai] : []));
  }

  /**
   * Time to the car directly ahead of the player on the road (s), from the race distances and the
   * player's speed; null before the start or when the player leads.
   */
  public playerGapAheadS(): number | null {
    if (this.phase !== 'racing') return null;
    const me = this.cars.find((c) => c.isPlayer);
    if (!me) return null;
    let gapM = Infinity;
    for (const c of this.cars) {
      if (c !== me && c.distM > me.distM) gapM = Math.min(gapM, c.distM - me.distM);
    }
    return Number.isFinite(gapM) ? gapM / Math.max(5, me.sim.vxMs) : null;
  }

  /** Render / HUD states of the AI cars (the player is drawn by the caller) */
  public peers(): InterpolatedPeerState[] {
    return this.cars.filter((c) => !c.isPlayer).map((c) => c.peer);
  }

  public status(): RaceStatus {
    const L = this.track.totalLengthM;
    const order = [...this.cars].sort((a, b) => b.distM - a.distM);
    // Prune gap buckets nobody can still need
    const minDist = order[order.length - 1].distM;
    if (this.bucketTimes.size > 4000) {
      for (const k of this.bucketTimes.keys()) if (k * GAP_BUCKET_M < minDist - 100) this.bucketTimes.delete(k);
    }
    // Time since the first car reached this car's distance (bucket entry time, minus the time this
    // car has spent inside the bucket)
    const gapTo = (car: FieldCar) => {
      const bucket = Math.floor(car.distM / GAP_BUCKET_M);
      const t = this.bucketTimes.get(bucket);
      if (t === undefined) return 0;
      const inBucketS = (car.distM - bucket * GAP_BUCKET_M) / Math.max(5, car.sim.vxMs);
      return Math.max(0, this.raceTimeS - t - inBucketS);
    };
    let gapFloor = 0;
    const playerIdx = order.findIndex((c) => c.isPlayer);
    const player = order[playerIdx];
    return {
      phase: this.phase,
      lightsOn: this.lightsOn,
      position: playerIdx + 1,
      fieldSize: order.length,
      lap: Math.max(1, Math.floor(player.distM / L) + 1),
      standings: order.map((c) => {
        // Keep the gaps ordered like the positions (bucket timing is coarse at launch speeds)
        if (this.phase === 'racing') gapFloor = Math.max(gapFloor, gapTo(c));
        return {
          driverCode: c.code,
          teamColorHex: c.teamColorHex,
          isPlayer: c.isPlayer,
          lap: Math.max(1, Math.floor(c.distM / L) + 1),
          gapToLeaderS: gapFloor,
        };
      }),
    };
  }
}
