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
import { evaluateAeroWakeDeficit, type WakeEmitterCar } from '@/lib/sim/aero-wake';
import { RealRoadState, resolveCarToCarObbCollision, type RigidBodyCollisionCar } from '@/lib/sim/real-road';
import { aiLineOffsetM } from '@/lib/sim/speed-profile';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';
import type { RaceStatus } from '@/types/f1';
import { classificationClosed, classify, raceOrder, type RacerProgress } from '@/lib/sim/race-session';

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
  /** Race time at the chequered flag (s); null while running */
  finishTimeS: number | null;
  bestLapMs: number | null;
  lapsDone: number;
  lapStartS: number;
}

const wrapHalf = (d: number, L: number) => ((((d + L / 2) % L) + L) % L) - L / 2;

/** Contact mass properties (an F1 car with driver and fuel) and the per-frame limits on what a contact may do */
const CONTACT_MASS_KG = 778;
const CONTACT_YAW_INERTIA_KGM2 = 1120;
const CONTACT_MAX_POS_M = 0.25;
const CONTACT_MAX_DV_MS = 6;
// A touch lasts tens of ms, and over that the still-gripping tyres (≈30 kN·m of yaw moment on an F1 car) resist about
// as much yaw as the contact gives, which the free-body impulse leaves out: a 2 m/s rear-quarter tap at 260 km/h
// otherwise kicks ~1 rad/s and spins the car
const CONTACT_MAX_DYAW_RADS = 0.25;

const _obbA: RigidBodyCollisionCar = {
  x: 0, y: 0, z: 0, fwdX: 0, fwdZ: 1, vx: 0, vz: 0, yawRateRadS: 0,
  massKg: CONTACT_MASS_KG, yawInertiaKgM2: CONTACT_YAW_INERTIA_KGM2, halfLengthM: 0, halfWidthM: 0,
};
const _obbB: RigidBodyCollisionCar = { ..._obbA };

/** The car's contact box in the Three.js world (X, Z), heading from its quaternion's forward axis */
function fillObb(sim: SimulatorCar, out: RigidBodyCollisionCar): void {
  const q = sim.worldQuaternion;
  // Model +Z (forward) rotated by q, projected on the ground; left is (fz, −fx) (model +X)
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  out.x = sim.worldPosition.x;
  out.y = sim.worldPosition.y;
  out.z = sim.worldPosition.z;
  out.fwdX = fx;
  out.fwdZ = fz;
  // Body velocity (vx forward, vy + left) to world
  out.vx = sim.vxMs * fx + sim.vyMs * fz;
  out.vz = sim.vxMs * fz - sim.vyMs * fx;
  // OBB yaw rate is + counter-clockwise (turning left), the car's + turning right
  out.yawRateRadS = -sim.yawRateRadS;
  out.halfLengthM = CAR_LEN_M * 0.5;
  out.halfWidthM = CAR_WID_M * 0.5;
  out.massKg = sim.contactMassKg ?? CONTACT_MASS_KG;
  out.yawInertiaKgM2 = sim.contactYawInertiaKgM2 ?? CONTACT_YAW_INERTIA_KGM2;
}

/** Hands the solver's deltas to the car, clamped per frame so a deep overlap can never launch it */
function applyObbDeltas(sim: SimulatorCar, pos: readonly [number, number], vel: readonly [number, number], yaw: number): void {
  if (!sim.applyRigidBodyCollision) return;
  const pl = Math.hypot(pos[0], pos[1]);
  const ps = pl > CONTACT_MAX_POS_M ? CONTACT_MAX_POS_M / pl : 1;
  const vl = Math.hypot(vel[0], vel[1]);
  const vs = vl > CONTACT_MAX_DV_MS ? CONTACT_MAX_DV_MS / vl : 1;
  sim.applyRigidBodyCollision(
    pos[0] * ps,
    pos[1] * ps,
    vel[0] * vs,
    vel[1] * vs,
    THREE.MathUtils.clamp(yaw, -CONTACT_MAX_DYAW_RADS, CONTACT_MAX_DYAW_RADS)
  );
}

/**
 * Contact between the player and another human's car (multiplayer). Each client resolves only its own car against
 * the other's interpolated state; both sides do the same, so the pair separates and exchanges momentum roughly as
 * the field's contacts do. Returns true when the cars touched.
 */
export function resolvePlayerVsRemoteCar(player: SimulatorCar, remote: InterpolatedPeerState): boolean {
  if (!player.applyRigidBodyCollision) return false;
  const dx = remote.position.x - player.worldPosition.x;
  const dz = remote.position.z - player.worldPosition.z;
  const dy = remote.position.y - player.worldPosition.y;
  if (dx * dx + dz * dz > CAR_LEN_M * CAR_LEN_M || Math.abs(dy) > 2) return false;
  fillObb(player, _obbA);
  const q = remote.quaternion;
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  _obbB.x = remote.position.x;
  _obbB.y = remote.position.y;
  _obbB.z = remote.position.z;
  _obbB.fwdX = fx;
  _obbB.fwdZ = fz;
  _obbB.vx = remote.linearVelocity.x;
  _obbB.vz = remote.linearVelocity.z;
  _obbB.yawRateRadS = 0;
  _obbB.halfLengthM = CAR_LEN_M * 0.5;
  _obbB.halfWidthM = CAR_WID_M * 0.5;
  _obbB.massKg = CONTACT_MASS_KG;
  _obbB.yawInertiaKgM2 = CONTACT_YAW_INERTIA_KGM2;
  const hit = resolveCarToCarObbCollision(_obbA, _obbB);
  if (!hit.collided) return false;
  applyObbDeltas(player, hit.posDeltaA, hit.velDeltaA, hit.yawDeltaA);
  return true;
}

export class AiOpponentField {
  public phase: RaceStatus['phase'] = 'racing';
  /** Race length; the player's flag ends their race (the AI cars finish their own lap and keep circulating) */
  public raceLaps = 5;
  public lightsOn = 0;
  public readonly realRoad: RealRoadState;
  private readonly cars: FieldCar[] = [];
  private readonly wakeEmitters: WakeEmitterCar[] = [];
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
    this.realRoad = new RealRoadState(track.totalLengthM);
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
      finishTimeS: null,
      bestLapMs: null,
      lapsDone: 0,
      lapStartS: 0,
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
    return this.phase === 'lights';
  }

  /**
   * Lines the field up: AI cars in grid order, the player behind them. A standing start runs the
   * light sequence (five reds one second apart, then a random 0.2–3 s hold); a rolling start
   * queues the cars on the main straight and races at once.
   */
  public startRace(standing: boolean): void {
    const L = this.track.totalLengthM;
    this.realRoad.reset();
    this.cars.forEach((car, slot) => {
      car.sim.resetToStartGrid(!standing, slot);
      if (car.ai) {
        car.ai.aiLineBiasM = 0;
        car.ai.aiSpeedCapMs = Infinity;
      }
      car.biasM = 0;
      car.stuckS = 0;
      car.finishTimeS = null;
      car.bestLapMs = null;
      car.lapsDone = 0;
      car.lapStartS = 0;
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
    this.updateAeroWakeAndRealRoad(dt);
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

  /**
   * Computes multi-car aerodynamic slipstream + vortex wake (P5) and deposits/queries
   * RealRoad dynamic rubber, marbles, and track evolution (P7) for every car in the field.
   */
  private updateAeroWakeAndRealRoad(dt: number): void {
    const L = this.track.totalLengthM;
    // Every car's state before any is updated (reused: no per-frame allocation)
    const emitters = this.wakeEmitters;
    while (emitters.length < this.cars.length) emitters.push({ sMeters: 0, lateralOffsetM: 0, speedMs: 0 });
    emitters.length = this.cars.length;
    for (let i = 0; i < this.cars.length; i++) {
      const sim = this.cars[i].sim;
      emitters[i].sMeters = sim.sMeters;
      emitters[i].lateralOffsetM = sim.lateralOffsetM;
      emitters[i].speedMs = sim.vxMs;
    }

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const sample = this.track.getSampleAtDistance(car.sim.sMeters);
      const racingLineLatM = aiLineOffsetM(sample);

      // Estimate instantaneous tire sliding power (W) from combined slip and vertical load
      let slipPowerW = 0;
      for (let w = 0; w < 4; w++) {
        const wh = car.sim.wheels[w];
        if (wh) {
          slipPowerW += wh.fzN * wh.combinedSlipNorm * Math.abs(car.sim.vxMs) * 0.12;
        }
      }
      this.realRoad.depositCarPass(car.sim.sMeters, car.sim.lateralOffsetM, racingLineLatM, slipPowerW, dt);

      const rr = this.realRoad.sample(car.sim.sMeters, car.sim.lateralOffsetM, racingLineLatM);
      car.sim.setRealRoadSample?.(rr);

      const wake = evaluateAeroWakeDeficit(
        car.sim.sMeters,
        car.sim.lateralOffsetM,
        car.sim.vxMs,
        emitters,
        L,
        sample.curvature,
        i
      );
      car.sim.setAeroWakeState?.(wake);
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
      // Off-line and in dirty air the corner is tighter than planned: give a little speed away for it
      const wakeFrontMult = me.telemetry.aeroWakeDownforceMult ?? 1;
      const dirtyAirPenalty = 1 - 0.12 * Math.max(0, 1 - wakeFrontMult);
      me.aiPaceScale = car.pace * (1 - 0.012 * Math.abs(car.biasM)) * dirtyAirPenalty;
      me.aiSpeedCapMs = speedCap;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Contact: 3D OBB SAT rigid-body collision impulse (P7), with the rectangles in track coordinates as the fallback
  // (side-by-side overlap pushes the cars apart laterally; a nose-to-tail hit exchanges speed, restitution 0.2)
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

        // 3D OBB SAT contact with the off-centre yaw moment and energy loss; it separates and exchanges momentum on its
        // own, so the track-coordinate push below is only the fallback for an overlap the boxes do not see
        fillObb(A, _obbA);
        fillObb(B, _obbB);
        const hit = resolveCarToCarObbCollision(_obbA, _obbB);
        if (hit.collided && A.applyRigidBodyCollision && B.applyRigidBodyCollision) {
          applyObbDeltas(A, hit.posDeltaA, hit.velDeltaA, hit.yawDeltaA);
          applyObbDeltas(B, hit.posDeltaB, hit.velDeltaB, hit.yawDeltaB);
          continue;
        }

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
    const laps = Math.floor(car.distM / L);
    if (laps > car.lapsDone && car.finishTimeS === null) {
      const lapMs = (this.raceTimeS - car.lapStartS) * 1000;
      if (lapMs > 1000 && (car.bestLapMs === null || lapMs < car.bestLapMs)) car.bestLapMs = Math.round(lapMs);
      car.lapsDone = laps;
      car.lapStartS = this.raceTimeS;
      if (laps >= this.raceLaps) {
        car.finishTimeS = this.raceTimeS;
        if (car.isPlayer) this.phase = 'finished';
      }
    }
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
    const progress = new Map<FieldCar, RacerProgress>();
    for (const c of this.cars) {
      progress.set(c, {
        id: c.id,
        code: c.code,
        name: c.code,
        color: c.teamColorHex,
        isPlayer: c.isPlayer,
        distM: c.distM,
        speedMs: c.sim.vxMs,
        finishTimeS: c.finishTimeS,
        bestLapMs: c.bestLapMs,
      });
    }
    const orderedProgress = raceOrder([...progress.values()]);
    const byId = new Map(this.cars.map((c) => [c.id, c]));
    const order = orderedProgress.map((p) => byId.get(p.id) as FieldCar);
    // Prune gap buckets nobody can still need
    const minDist = Math.min(...this.cars.map((c) => c.distM));
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
    const leader = order[0];
    let gapFloor = 0;
    const playerIdx = order.findIndex((c) => c.isPlayer);
    const player = order[playerIdx];
    const playerFinished = player.finishTimeS !== null;
    const final = playerFinished && classificationClosed(orderedProgress, this.raceTimeS);
    return {
      phase: this.phase,
      lightsOn: this.lightsOn,
      position: playerIdx + 1,
      fieldSize: order.length,
      lap: Math.max(1, Math.min(this.raceLaps, Math.floor(player.distM / L) + 1)),
      totalLaps: this.raceLaps,
      standings: order.map((c) => {
        // Keep the gaps ordered like the positions (bucket timing is coarse at launch speeds)
        if (this.phase !== 'lights') {
          const gap =
            c.finishTimeS !== null && leader.finishTimeS !== null ? c.finishTimeS - leader.finishTimeS : gapTo(c);
          gapFloor = Math.max(gapFloor, gap);
        }
        return {
          driverCode: c.code,
          teamColorHex: c.teamColorHex,
          isPlayer: c.isPlayer,
          lap: Math.max(1, Math.min(this.raceLaps, Math.floor(c.distM / L) + 1)),
          gapToLeaderS: gapFloor,
          finished: c.finishTimeS !== null,
        };
      }),
      results: playerFinished ? classify(orderedProgress, L, this.raceLaps, final) : undefined,
      resultsFinal: final,
    };
  }
}
