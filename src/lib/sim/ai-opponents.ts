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
import { resolveCarToCarObbCollision, type RigidBodyCollisionCar } from '@/lib/sim/track-evolution';
import { TrackEnvironment } from '@/lib/sim/track-environment';
import { aiLineOffsetM, computeSpeedProfile, createVf26ProfileCarModel, withPlanningGrip } from '@/lib/sim/speed-profile';
import { RacingLineDriver } from '@/lib/sim/ai-mpc';
import {
  AI_SKILL_DEFAULT,
  AiTrackTuning,
  aiSkillModifiers,
  buildTargetSpeedProfile,
  cornerSections,
  decelEnvelope,
  gaussian,
  hashString,
  inSection,
  resolveAiTuning,
  seededRng,
  type AiClassId,
  type AiSkillModifiers,
  type AiTuningLibrary,
  type TrackSection,
} from '@/lib/sim/ai-tuning';
import { AI_TUNING_LIBRARY } from '@/lib/sim/ai-tuning-data';
import { AiSectionLearner, loadLearnedCorners, saveLearnedCorners, type LearnedCorner } from '@/lib/sim/ai-learning';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';
import type { RaceStatus, VehicleModelId } from '@/types/f1';
import { F12026_CAR_CONFIG } from '@/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '@/lib/sim/gt3/AmgGt3Config';
import {
  classificationClosed,
  classifiedTimeS,
  classify,
  lapPositionM,
  PlayerSplits,
  raceOrder,
  SplitTimer,
  type RacerProgress,
} from '@/lib/sim/race-session';

export interface AiDriverDef {
  code: string;
  teamColorHex: string;
  /** Fraction of the car's limit the driver runs at (at the default skill level) */
  pace: number;
  /** Racecraft temperament: -1 waits for a clear gap and rarely defends ... +1 late lunges and covers every inside */
  aggression?: number;
  /** Lap-to-lap repeatability against the field's `consistency` (-0.1 ... +0.1) */
  consistencyBias?: number;
}

/** Field in grid order (pole first); the player lines up behind them */
export const AI_DRIVERS: AiDriverDef[] = [
  { code: 'KIG', teamColorHex: '#ff8000', pace: 0.975, aggression: 0.2, consistencyBias: 0.05 },
  { code: 'MUS', teamColorHex: '#e8002d', pace: 0.968, aggression: 0.5, consistencyBias: -0.05 },
  { code: 'NYA', teamColorHex: '#27f4d2', pace: 0.961, aggression: -0.3, consistencyBias: 0.08 },
  { code: 'RUB', teamColorHex: '#3671c6', pace: 0.954, aggression: 0.3, consistencyBias: -0.03 },
  { code: 'HUY', teamColorHex: '#b6babd', pace: 0.947, aggression: -0.5, consistencyBias: 0 },
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
/** The overtake caution the passing rules below were written for (the shipped default): no change at this value */
const BASE_CAUTION = 0.3;
/** Speed scale of a "too hot into the corner" mistake */
const MISTAKE_APEX_SCALE = 1.06;

/** What a headless race reports per car */
export interface AiCarStats {
  offTracks: number;
  wallHits: number;
  stuckRecoveries: number;
  contacts: number;
  mistakes: number;
  lapTimesMs: number[];
  /** Running position at each completed lap (1 = leading) */
  lapPositions: number[];
}

/** How the field sets a car's target speed and steering gain (null: a car without an AI tuning hook) */
interface AiDriveHooks {
  base: ArrayLike<number>;
  env: Float32Array;
  setTarget(v: Float64Array | null): void;
  setSteerGain(g: number): void;
  /** Swaps `base` / `env` for the car's current planning grip (rain); true when they changed */
  refresh?(): boolean;
}

const vf26Bases = new WeakMap<BuiltTrackData, Map<string, { base: Float64Array; env: Float32Array }>>();

function driveHooksFor(sim: SimulatorCar, track: BuiltTrackData): AiDriveHooks | null {
  const L = track.totalLengthM;
  if (typeof sim.aiBaseSpeedProfile === 'function') {
    const base = sim.aiBaseSpeedProfile();
    return {
      base,
      env: decelEnvelope(base, L),
      setTarget: (v) => (sim.aiTargetSpeedMs = v),
      setSteerGain: (g) => (sim.aiSteerGain = g),
    };
  }
  // The VF26 drives on a RacingLineDriver over the profile it builds from this planning model; f1-physics-2026.ts has
  // no tuning setters of its own, so the tuning goes straight to its driver
  const driver = (sim as unknown as { aiDriver?: unknown }).aiDriver;
  if (driver instanceof RacingLineDriver) {
    let perTrack = vf26Bases.get(track);
    if (!perTrack) vf26Bases.set(track, (perTrack = new Map()));
    const cache = perTrack;
    // The limit profile on the tyres' grip on this road (the dry one unless it rains)
    const entryFor = (grip: number) => {
      const key = `${sim.aeroPreset}@${grip}`;
      let entry = cache.get(key);
      if (!entry) {
        const base = computeSpeedProfile(track.samples, withPlanningGrip(createVf26ProfileCarModel(sim.aeroPreset), grip)).speedMs;
        entry = { base, env: decelEnvelope(base, L) };
        cache.set(key, entry);
      }
      return entry;
    };
    let grip = sim.aiPlanGrip?.() ?? 1;
    const entry = entryFor(grip);
    const hooks: AiDriveHooks = {
      base: entry.base,
      env: entry.env,
      setTarget: (v) => (driver.targetSpeedMs = v),
      setSteerGain: (g) => (driver.steerGain = g),
      refresh: () => {
        const now = sim.aiPlanGrip?.() ?? 1;
        if (now === grip) return false;
        grip = now;
        const next = entryFor(grip);
        hooks.base = next.base;
        hooks.env = next.env;
        return true;
      },
    };
    return hooks;
  }
  return null;
}

/** Tuning class of a car: GT3 by its racing line or model, otherwise the 2026 open-wheelers */
const classOf = (sim: SimulatorCar): AiClassId => (sim.vehicleId === 'amg-gt3' || sim.racingLineId === 'gt3' ? 'gt3' : 'f1-2026');

export interface AiFieldOptions {
  /** AI skill 0-100 (`AI_SKILL_DEFAULT`, Pro: the field as it always drove) */
  skill?: number;
  /** Circuit id for the per-track tuning files (default: the track data's id) */
  trackId?: string;
  /** Tuning class (default: from the player's car) */
  classId?: AiClassId;
  /** Race seed (lap-to-lap errors, mistakes, the start hold): a seed replays the same race in the headless runner */
  seed?: number;
  /** Each car learns per corner, lap to lap (default true) */
  learning?: boolean;
  /** Keep what was learnt per circuit, class and driver in localStorage (default false: every session starts fresh) */
  persistLearning?: boolean;
  /** No player in the field (headless races): `player` is only the car the AI cars are built like */
  spectate?: boolean;
  /** Tuning files (default: public/ai) */
  library?: AiTuningLibrary;
}

interface FieldCar {
  id: string;
  code: string;
  teamColorHex: string;
  isPlayer: boolean;
  sim: SimulatorCar;
  /** The AI car's physics (null for the player) */
  ai: SimulatorCar | null;
  /** The driver's pace as written (default skill) */
  defPace: number;
  /** Pace before this lap's inconsistency: driver x skill x tuning */
  basePace: number;
  /** This lap's pace */
  pace: number;
  aggression: number;
  consistencyBias: number;
  hooks: AiDriveHooks | null;
  learner: AiSectionLearner | null;
  rng: () => number;
  /** This lap's braking-point error per corner (share of braking held back), and the corner of a mistake (-1: none) */
  cornerBrakeErr: Float32Array;
  mistakeCorner: number;
  stats: AiCarStats;
  wasOff: boolean;
  lastWallMs: number;
  prevVx: number;
  /** Decelerating like a wall hit last frame (the VF26's impacts are counted from this) */
  inWallHit: boolean;
  /** Touched another car this frame */
  contact: boolean;
  /** Covering the inside against a car behind */
  defending: boolean;
  /** Race distance covered (m); negative on the grid behind the line */
  distM: number;
  prevS: number;
  biasM: number;
  stuckS: number;
  peer: InterpolatedPeerState;
  /** Race time at the chequered flag (s); null while running */
  finishTimeS: number | null;
  bestLapMs: number | null;
  lastLapMs: number | null;
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
const _sep: [number, number] = [0, 0];

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
 * Another player's car: its pose is a prediction a few cm out, so the contact is soft. Overlap is worked out at most
 * this fast (m/s) beyond a small slop, the closing speed is taken out by the impulse, with little bounce.
 */
const REMOTE_SEP_RATE_MS = 1.5;
const REMOTE_SLOP_M = 0.02;
const REMOTE_RESTITUTION = 0.1;

/** Contact mass and yaw inertia of another player's car, from the model it drives */
function remoteContactMass(vehicle: VehicleModelId | undefined): [number, number] {
  if (vehicle === 'amg-gt3') return [AMG_GT3_CONFIG.chassis.totalMassKg, AMG_GT3_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'f12026-car') return [F12026_CAR_CONFIG.chassis.totalMassKg, F12026_CAR_CONFIG.chassis.inertia.yaw];
  return [CONTACT_MASS_KG, CONTACT_YAW_INERTIA_KGM2];
}

/**
 * Contact between the player and another human's car (multiplayer). Each client resolves only its own car against
 * the other's state predicted to the present (`MultiplayerSyncManager.predictPeer`); both sides do the same, so the
 * pair separates and exchanges momentum as the field's contacts do. `dt` is the frame time (s), which paces the
 * position correction. Returns true when the cars touched.
 */
export function resolvePlayerVsRemoteCar(player: SimulatorCar, remote: InterpolatedPeerState, dt = 1 / 60): boolean {
  if (!player.applyRigidBodyCollision || remote.contactReady === false) return false;
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
  // + counter-clockwise for the solver, + turning right on the wire
  _obbB.yawRateRadS = -(remote.yawRateRadS ?? 0);
  _obbB.halfLengthM = CAR_LEN_M * 0.5;
  _obbB.halfWidthM = CAR_WID_M * 0.5;
  [_obbB.massKg, _obbB.yawInertiaKgM2] = remoteContactMass(remote.vehicle);
  const hit = resolveCarToCarObbCollision(_obbA, _obbB, REMOTE_RESTITUTION);
  if (!hit.collided) return false;
  // This car's half of the overlap, paced so a few frames of it never snap the car sideways
  const sep = Math.min(Math.max(0, 0.5 * hit.penetrationM - REMOTE_SLOP_M), REMOTE_SEP_RATE_MS * Math.max(0, dt));
  _sep[0] = -hit.nx * sep;
  _sep[1] = -hit.nz * sep;
  applyObbDeltas(player, _sep, hit.velDeltaA, hit.yawDeltaA);
  return true;
}

const emptyStats = (): AiCarStats => ({
  offTracks: 0,
  wallHits: 0,
  stuckRecoveries: 0,
  contacts: 0,
  mistakes: 0,
  lapTimesMs: [],
  lapPositions: [],
});

export interface AiFieldReport {
  seed: number;
  skill: number;
  tuningSources: string[];
  cars: {
    code: string;
    isPlayer: boolean;
    gridPos: number;
    position: number;
    pace: number;
    distM: number;
    finishTimeS: number | null;
    bestLapMs: number | null;
    stats: AiCarStats;
    learnt: LearnedCorner[];
  }[];
}

export class AiOpponentField {
  public phase: RaceStatus['phase'] = 'racing';
  /** Race length; the player's flag ends their race (the AI cars finish their own lap and keep circulating) */
  public raceLaps = 5;
  public lightsOn = 0;
  /** Track evolution and aero wake shared by every car on the track */
  public readonly environment: TrackEnvironment;
  /** True when the field updates `environment` itself (none was given); otherwise its owner does, every car included */
  private readonly ownsEnvironment: boolean;
  private readonly cars: FieldCar[] = [];
  /** Every car's physics, AI cars in grid order then the player */
  private readonly allSims: SimulatorCar[] = [];
  private lightsTimerS = 0;
  private holdS = 0;
  private raceTimeS = 0;
  /** Race time at which the first car reached each distance bucket (gap timing) */
  private bucketTimes = new Map<number, number>();
  /** Every car's time at points of race distance (split gaps to the player's neighbours, DRS gaps) */
  private readonly splitTimer = new SplitTimer();
  private readonly playerSplits = new PlayerSplits();

  // ---- AI tuning, skill and learning
  public readonly classId: AiClassId;
  public readonly trackId: string;
  public readonly tuning: AiTrackTuning;
  /** The corners each car learns (each turn with its braking straight) */
  public readonly corners: readonly TrackSection[];
  private readonly cornerAt: Int16Array;
  private skillLevel: number;
  private mods: AiSkillModifiers;
  private readonly seed: number;
  private readonly learning: boolean;
  private readonly persistLearning: boolean;
  private readonly spectate: boolean;
  /** Last contact time per car pair (a touch is counted once) */
  private readonly contactAt = new Map<string, number>();
  private readonly rng: () => number;

  constructor(
    private readonly track: BuiltTrackData,
    private readonly player: SimulatorCar,
    drivers: AiDriverDef[] = AI_DRIVERS,
    environment?: TrackEnvironment,
    options: AiFieldOptions = {}
  ) {
    this.environment = environment ?? new TrackEnvironment(track);
    this.ownsEnvironment = !environment;
    this.spectate = options.spectate ?? false;
    this.classId = options.classId ?? classOf(player);
    this.trackId = options.trackId ?? track.id ?? 'rwanda';
    this.skillLevel = THREE.MathUtils.clamp(options.skill ?? AI_SKILL_DEFAULT, 0, 100);
    this.mods = aiSkillModifiers(this.skillLevel);
    this.seed = (options.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.rng = seededRng(this.seed);
    this.learning = options.learning ?? true;
    this.persistLearning = options.persistLearning ?? false;
    this.corners = cornerSections(track);
    const library = options.library ?? AI_TUNING_LIBRARY;
    let tuning: AiTrackTuning | null = null;
    for (const d of drivers) {
      const sim = player.createAiPeerCar ? player.createAiPeerCar() : new F1Physics2026(track);
      sim.assistPreset = 'pro';
      sim.aiAutopilot = true;
      sim.aiPaceScale = d.pace;
      tuning ??= new AiTrackTuning(track, resolveAiTuning({ classId: this.classId, vehicleId: sim.vehicleId, trackId: this.trackId }, library));
      const car = this.makeCar(`ai_${d.code}`, d.code, d.teamColorHex, sim, sim, d.pace);
      car.aggression = THREE.MathUtils.clamp(d.aggression ?? 0, -1, 1);
      car.consistencyBias = THREE.MathUtils.clamp(d.consistencyBias ?? 0, -0.2, 0.2);
      car.hooks = driveHooksFor(sim, track);
      this.cars.push(car);
    }
    this.tuning = tuning ?? new AiTrackTuning(track, resolveAiTuning({ classId: this.classId, trackId: this.trackId }, library));
    this.cornerAt = new Int16Array(this.tuning.n);
    for (let i = 0; i < this.tuning.n; i++) {
      const s = (i * track.totalLengthM) / this.tuning.n;
      this.cornerAt[i] = this.corners.findIndex((c) => inSection(s, c.fromM, c.toM, track.totalLengthM));
    }
    if (!this.spectate) this.cars.push(this.makeCar('player', PLAYER_CODE, '#E10600', player, null, 1));
    for (const car of this.cars) this.allSims.push(car.sim);
    this.applySkill();
  }

  /** AI skill 0-100 */
  get skill(): number {
    return this.skillLevel;
  }

  /** Changes the AI level mid-session: pace at once, braking points and corner speeds from a rebuilt target */
  public setSkill(skill: number): void {
    this.skillLevel = THREE.MathUtils.clamp(skill, 0, 100);
    this.mods = aiSkillModifiers(this.skillLevel);
    this.applySkill();
    for (const car of this.cars) if (car.ai) this.rebuildTarget(car);
  }

  private applySkill(): void {
    for (const car of this.cars) {
      if (!car.ai) continue;
      car.basePace = Math.min(0.999, car.defPace * this.mods.paceMult * this.tuning.params.pace);
      car.pace = car.basePace;
    }
  }

  private cornerIndex(s: number): number {
    const L = this.track.totalLengthM;
    const n = this.cornerAt.length;
    return this.cornerAt[Math.floor(((((s % L) + L) % L) / L) * n) % n];
  }

  /** A new lap for an AI car: this lap's inconsistency (pace, braking points, maybe a mistake), then its target speed */
  private newLap(car: FieldCar): void {
    const spread = 1 - THREE.MathUtils.clamp(this.tuning.params.consistency + car.consistencyBias, 0, 1);
    const m = this.mods;
    car.pace = car.basePace * (1 + THREE.MathUtils.clamp(gaussian(car.rng) * m.lapPaceSigma * spread, -0.03, 0.03));
    for (let k = 0; k < car.cornerBrakeErr.length; k++) {
      car.cornerBrakeErr[k] = Math.max(0, gaussian(car.rng) * m.cornerBrakeSigma * spread);
    }
    // A proper mistake (into one corner too hot); its chance is rated at the default consistency 0.85
    const mistake = car.rng() < m.mistakesPerLap * (spread / 0.15);
    car.mistakeCorner = mistake && this.corners.length ? Math.floor(car.rng() * this.corners.length) : -1;
    if (car.mistakeCorner >= 0) car.stats.mistakes++;
    this.rebuildTarget(car);
  }

  /** An AI car's target speed: its limit profile with the tuning, the skill, what it learnt and this lap's errors */
  private rebuildTarget(car: FieldCar): void {
    const hooks = car.hooks;
    if (!hooks) return;
    const T = this.tuning;
    const m = this.mods;
    const learner = car.learner;
    const target = buildTargetSpeedProfile(
      hooks.base,
      this.track,
      (s) => {
        const k = this.cornerIndex(s);
        const learnt = learner ? learner.offsetsAt(s) : null;
        const err = k >= 0 ? car.cornerBrakeErr[k] : 0;
        const hot = k >= 0 && k === car.mistakeCorner ? MISTAKE_APEX_SCALE : 1;
        return {
          brakeMargin: T.at('brakeMargin', s) + m.brakeMarginAdd + (learnt?.brakeMargin ?? 0) + err,
          apexScale: T.at('apexSpeedScale', s) * m.apexMult * (1 + (learnt?.apex ?? 0)) * hot,
          bumpCaution: T.at('bumpCaution', s),
        };
      },
      hooks.env
    );
    hooks.setTarget(target);
  }

  public attachTrackRoot(root: THREE.Object3D): void {
    for (const car of this.cars) {
      car.ai?.attachTrackRoot?.(root);
    }
  }

  private makeCar(
    id: string,
    code: string,
    teamColorHex: string,
    sim: SimulatorCar,
    ai: SimulatorCar | null,
    pace: number
  ): FieldCar {
    return {
      id,
      code,
      teamColorHex,
      isPlayer: ai === null,
      sim,
      ai,
      defPace: pace,
      basePace: pace,
      pace,
      aggression: 0,
      consistencyBias: 0,
      hooks: null,
      learner: null,
      rng: Math.random,
      cornerBrakeErr: new Float32Array(0),
      mistakeCorner: -1,
      stats: emptyStats(),
      wasOff: false,
      lastWallMs: 0,
      prevVx: 0,
      inWallHit: false,
      contact: false,
      defending: false,
      distM: 0,
      prevS: 0,
      biasM: 0,
      stuckS: 0,
      finishTimeS: null,
      bestLapMs: null,
      lastLapMs: null,
      lapsDone: 0,
      lapStartS: 0,
      peer: {
        peerId: id,
        driverCode: code,
        teamColorHex,
        vehicle: sim.vehicleId ?? this.player.vehicleId,
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
    this.environment.reset();
    this.cars.forEach((car, slot) => {
      car.sim.resetToStartGrid(!standing, slot);
      if (car.ai) {
        car.ai.aiLineBiasM = 0;
        car.ai.aiSpeedCapMs = Infinity;
        car.rng = seededRng(this.seed ^ hashString(car.code));
        car.cornerBrakeErr = new Float32Array(this.corners.length);
        car.mistakeCorner = -1;
        car.stats = emptyStats();
        car.wasOff = false;
        car.lastWallMs = car.ai.telemetry.f12026?.wallImpact?.atMs ?? 0;
        car.prevVx = 0;
        car.contact = false;
        car.defending = false;
        car.learner = this.learning
          ? new AiSectionLearner(
              this.corners,
              L,
              this.persistLearning ? loadLearnedCorners(this.trackId, this.classId, car.code, this.corners.length) : undefined
            )
          : null;
        this.newLap(car);
      }
      car.biasM = 0;
      car.stuckS = 0;
      car.finishTimeS = null;
      car.bestLapMs = null;
      car.lastLapMs = null;
      car.lapsDone = 0;
      car.lapStartS = 0;
      car.prevS = car.sim.sMeters;
      car.distM = car.sim.sMeters > L / 2 ? car.sim.sMeters - L : car.sim.sMeters;
      this.syncPeer(car);
    });
    this.player.aiAutopilot = false;
    this.playerPenaltyS = 0;
    this.raceTimeS = 0;
    this.bucketTimes.clear();
    this.splitTimer.reset();
    this.playerSplits.reset();
    this.contactAt.clear();
    this.phase = standing ? 'lights' : 'racing';
    this.lightsOn = 0;
    this.lightsTimerS = 0;
    this.holdS = 0.2 + this.rng() * 2.8;
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
    if (this.ownsEnvironment) this.environment.update(dt, this.allSims);
    this.planTraffic(dt);
    for (const car of this.cars) {
      car.contact = false;
      car.ai?.step(dt, {});
    }
    this.resolveContacts();
    this.recoverStuckCars(dt);
    for (const car of this.cars) {
      if (car.ai) this.observe(car, dt);
      this.trackDistance(car);
      this.syncPeer(car);
    }
  }

  /** Incidents for the report, and what the car's learning sees this frame */
  private observe(car: FieldCar, dt: number): void {
    const sim = car.ai as SimulatorCar;
    const t = sim.telemetry;
    const off = t.offTrack;
    if (off && !car.wasOff) car.stats.offTracks++;
    car.wasOff = off;
    // A wall hit: the rigid-body cars report their impacts; on the VF26 it is a deceleration no brake can give
    const wall = t.f12026?.wallImpact;
    if (t.f12026) {
      if (wall && wall.atMs !== car.lastWallMs && wall.speedMs > 2) car.stats.wallHits++;
      car.lastWallMs = wall?.atMs ?? car.lastWallMs;
    } else {
      // One impact lasts several frames: count it once
      const hit = !car.contact && (sim.vxMs - car.prevVx) / dt < -75;
      if (hit && !car.inWallHit) car.stats.wallHits++;
      car.inWallHit = hit;
    }
    car.prevVx = sim.vxMs;
    // A jump along the track this frame is the car's own stuck recovery
    if (Math.abs(wrapHalf(sim.sMeters - car.prevS, this.track.totalLengthM)) > Math.max(15, Math.abs(sim.vxMs) * dt * 3 + 5)) {
      car.stats.stuckRecoveries++;
      car.learner?.interrupt();
    }
    const learner = car.learner;
    if (!learner) return;
    const sample = this.track.getSampleAtDistance(sim.sMeters);
    let maxSlip = 0;
    for (const w of sim.wheels) maxSlip = Math.max(maxSlip, w.combinedSlipNorm);
    const sr = t.wheelSlipRatios;
    learner.observe({
      s: sim.sMeters,
      offTrack: off,
      lineErrorM: Math.abs(sim.lateralOffsetM - aiLineOffsetM(sample, sim.racingLineId) - car.biasM),
      maxSlip,
      lockup: t.brake > 0.2 && Math.min(sr[0], sr[1], sr[2], sr[3]) < -0.2,
      trafficBiasM: car.biasM,
      contact: car.contact,
    });
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
      const line = aiLineOffsetM(sample, me.racingLineId);
      const half = sample.width / 2 - 1.2;
      let targetLat: number | null = null;
      let speedCap = Infinity;
      // Racecraft here: the tuning (with its section overrides), the skill level and the driver's temperament.
      // At the shipped caution the passing rules are exactly the ones this field always raced with.
      const T = this.tuning;
      const caution = THREE.MathUtils.clamp(T.at('overtakeCaution', me.sMeters) + this.mods.cautionAdd - 0.25 * car.aggression, 0, 1);
      const dc = caution - BASE_CAUTION;
      const passSpacing = PASS_SPACING_M * (1 + 0.5 * dc);
      const minClosing = -1 + 3 * dc;
      const followGap = 12 + 10 * dc;
      const defend = THREE.MathUtils.clamp(T.params.defend * this.mods.defendMult + 0.2 * car.aggression, 0, 1);

      let ahead: FieldCar | null = null;
      let aheadGap = Infinity;
      let attacker: FieldCar | null = null;
      let attackerGap = Infinity;
      let alongsideAhead: FieldCar | null = null;
      let squeezedBy: FieldCar | null = null;
      for (const other of this.cars) {
        if (other === car) continue;
        const ds = wrapHalf(other.sim.sMeters - me.sMeters, L);
        const dLat = other.sim.lateralOffsetM - me.lateralOffsetM;
        // Alongside: keep a car's width of room
        if (Math.abs(ds) < CAR_LEN_M + 1.5 && Math.abs(dLat) < PASS_SPACING_M) {
          const away = me.lateralOffsetM >= other.sim.lateralOffsetM ? 1 : -1;
          targetLat = other.sim.lateralOffsetM + away * PASS_SPACING_M;
          // Squeezed against the edge with no room left on that side and not clearly ahead: back out of it
          if (Math.abs(targetLat) > half && ds > -0.5 * CAR_LEN_M) squeezedBy = other;
        }
        // Side by side with its nose behind the other car's: the one that yields if a corner comes
        if (ds > 0.5 && ds < CAR_LEN_M + 1.5 && Math.abs(dLat) < PASS_SPACING_M + 0.6) alongsideAhead = other;
        if (ds > 0 && ds < 90 && Math.abs(dLat) < CAR_WID_M + 0.4 && ds < aheadGap) {
          ahead = other;
          aheadGap = ds;
        }
        // Closing in from behind, not yet alongside
        if (ds < -CAR_LEN_M && ds > -30 && other.sim.vxMs - me.vxMs > 1 && -ds < attackerGap) {
          attacker = other;
          attackerGap = -ds;
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
          if (Math.max(roomLeft, roomRight) >= passSpacing && closing > minClosing) {
            targetLat = aLat + side * passSpacing;
          } else {
            // No room: sit in the tow and wait
            speedCap = ahead.sim.vxMs + Math.max(-4, (aheadGap - followGap) * 0.5);
          }
        }
      }

      // Tight corners leave little room to run off-line, so look as far ahead as the car needs to
      // brake: a pass started on the straight must not reach the hairpin off-line
      let kAbs = Math.abs(sample.curvature);
      let kNext = sample.curvature;
      const lookM = 30 + (me.vxMs * me.vxMs) / 60;
      for (let d = 10; d <= lookM; d += 10) {
        const k = this.track.getSampleAtDistance((me.sMeters + d) % L).curvature;
        if (Math.abs(k) > kAbs) {
          kAbs = Math.abs(k);
          kNext = k;
        }
      }
      const maxBias = kAbs > 0.012 ? 1.2 : kAbs > 0.006 ? 2.5 : 6;
      // Two cars can't take one corner side by side: still behind on the way in, give the place up and tuck in behind
      if (alongsideAhead && kAbs > 0.006) speedCap = Math.min(speedCap, alongsideAhead.sim.vxMs - 1.5);
      if (squeezedBy) speedCap = Math.min(speedCap, squeezedBy.sim.vxMs - 2);
      // Defending: a quicker car closing from behind and a real corner coming: cover the inside, the move made while
      // still on the throttle (never started under braking, never while a pass of our own is on), held through the
      // braking zone and given up once the car is in the corner itself, where it rejoins its own line to make the turn
      const inCorner = Math.abs(sample.curvature) > 0.004;
      car.defending =
        targetLat === null && attacker !== null && defend > 0 && kAbs > 0.006 && !inCorner && (car.defending || me.telemetry.brake < 0.05);
      if (car.defending) {
        const inside = Math.sign(kNext);
        targetLat = line + inside * Math.max(0, Math.min(half - inside * line, 2.2 * defend));
      }
      let pos = targetLat === null ? null : THREE.MathUtils.clamp(targetLat, -half, half);
      // Corner margins from the tuning: keep the car's centre this far inside the inside / outside edge
      const intM = T.at('intMarginM', me.sMeters);
      const extM = T.at('extMarginM', me.sMeters);
      if (intM > 0 || extM > 0) {
        const k = this.track.getSampleAtDistance((me.sMeters + Math.max(5, me.vxMs * 0.4)) % L).curvature;
        if (Math.abs(k) > 0.002) {
          const edge = sample.width / 2;
          // + curvature is a right-hander: its inside is the + (right) side
          const rightM = k > 0 ? intM : extM;
          const leftM = k > 0 ? extM : intM;
          const hi = rightM > 0 ? Math.max(0, edge - rightM) : Infinity;
          const lo = leftM > 0 ? -Math.max(0, edge - leftM) : -Infinity;
          const want = pos ?? line;
          const kept = THREE.MathUtils.clamp(want, lo, hi);
          if (Math.abs(kept - want) > 1e-3) pos = kept;
        }
      }
      const biasTarget = pos === null ? 0 : THREE.MathUtils.clamp(pos - line, -maxBias, maxBias);
      car.biasM += THREE.MathUtils.clamp(biasTarget - car.biasM, -BIAS_RATE_MS * dt, BIAS_RATE_MS * dt);
      me.aiLineBiasM = car.biasM;
      // Off-line and in dirty air the corner is tighter than planned: give a little speed away for it
      const wakeFrontMult = me.telemetry.aeroWakeDownforceMult ?? 1;
      const dirtyAirPenalty = 1 - 0.12 * Math.max(0, 1 - wakeFrontMult);
      // Rain: the pace the tyres' grip on this much water allows (weather.ts / track-environment.ts)
      const weatherPace = this.environment.weatherPaceScale(me);
      me.aiPaceScale = car.pace * (1 - 0.012 * Math.abs(car.biasM)) * dirtyAirPenalty * weatherPace;
      me.aiSpeedCapMs = speedCap;
      car.hooks?.setSteerGain(T.at('steerGain', me.sMeters));
      // Rain changed the grip the car plans on: new corner speeds and braking points
      if (car.hooks?.refresh?.()) this.rebuildTarget(car);
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
        this.noteContact(this.cars[a], this.cars[b]);
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

  /** Counts a touch between two cars once (a new one after 1 s apart) */
  private noteContact(a: FieldCar, b: FieldCar): void {
    a.contact = b.contact = true;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const last = this.contactAt.get(key);
    if (last === undefined || this.raceTimeS - last > 1) {
      a.stats.contacts++;
      b.stats.contacts++;
    }
    this.contactAt.set(key, this.raceTimeS);
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
        const lineLat = aiLineOffsetM(sample, sim.racingLineId);
        sim.teleportToDistance(sim.sMeters, Math.min(25, sample.optimalSpeedKmh / 3.6), lineLat);
        sim.lateralOffsetM = lineLat;
        car.biasM = 0;
        car.stats.stuckRecoveries++;
        car.learner?.interrupt();
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
      if (lapMs > 1000) car.lastLapMs = Math.round(lapMs);
      car.lapsDone = laps;
      car.lapStartS = this.raceTimeS;
      if (car.ai) {
        car.stats.lapTimesMs.push(Math.round(lapMs));
        car.stats.lapPositions.push(this.positionOf(car));
      }
      if (laps >= this.raceLaps) {
        car.finishTimeS = this.raceTimeS;
        if (car.isPlayer) this.phase = 'finished';
        if (car.ai && this.persistLearning && car.learner) saveLearnedCorners(this.trackId, this.classId, car.code, car.learner.snapshot());
        if (this.spectate && this.cars.every((c) => c.finishTimeS !== null)) this.phase = 'finished';
      }
      if (car.ai) this.newLap(car);
    }
    this.splitTimer.record(car.id, this.raceTimeS, car.distM);
    const bucket = Math.floor(car.distM / GAP_BUCKET_M);
    if (!this.bucketTimes.has(bucket)) this.bucketTimes.set(bucket, this.raceTimeS);
  }

  /** Running position of a car now (1 = leading) */
  private positionOf(car: FieldCar): number {
    const ordered = raceOrder(this.cars.map((c) => this.progressOf(c)));
    return ordered.findIndex((p) => p.id === car.id) + 1;
  }

  private progressOf(c: FieldCar): RacerProgress {
    return {
      id: c.id,
      code: c.code,
      name: c.code,
      color: c.teamColorHex,
      isPlayer: c.isPlayer,
      distM: c.distM,
      speedMs: c.sim.vxMs,
      finishTimeS: c.finishTimeS,
      bestLapMs: c.bestLapMs,
      lastLapMs: c.lastLapMs,
      penaltyS: c.isPlayer ? this.playerPenaltyS : 0,
      compound: c.sim.tireCompound,
    };
  }

  /** Race time since the lights went out (s) */
  get timeS(): number {
    return this.raceTimeS;
  }

  /** Everything a headless race reports: running order, laps, incidents and what each car learnt (grid order) */
  public report(): AiFieldReport {
    const ordered = raceOrder(this.cars.map((c) => this.progressOf(c)));
    return {
      seed: this.seed,
      skill: this.skillLevel,
      tuningSources: this.tuning.resolved.sources,
      cars: this.cars.map((c, i) => ({
        code: c.code,
        isPlayer: c.isPlayer,
        gridPos: i + 1,
        position: ordered.findIndex((p) => p.id === c.id) + 1,
        pace: c.basePace,
        distM: c.distM,
        finishTimeS: c.finishTimeS,
        bestLapMs: c.bestLapMs,
        stats: c.stats,
        learnt: c.learner?.snapshot() ?? [],
      })),
    };
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

  /** Physics of every car in the field, AI cars in grid order then the player (for the shared track environment) */
  public sims(): readonly SimulatorCar[] {
    return this.allSims;
  }

  /** Physics of the AI cars, in grid order */
  public aiSims(): SimulatorCar[] {
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
    let ahead: FieldCar | null = null;
    for (const c of this.cars) {
      if (c !== me && c.distM > me.distM && c.distM - me.distM < gapM) {
        gapM = c.distM - me.distM;
        ahead = c;
      }
    }
    if (!ahead) return null;
    // The time since that car passed this point (distance over speed only before there is timing there)
    return this.splitTimer.gapS(this.raceTimeS, ahead.id, me.distM) ?? gapM / Math.max(5, me.sim.vxMs);
  }

  /** Render / HUD states of the AI cars (the player is drawn by the caller) */
  public peers(): InterpolatedPeerState[] {
    return this.cars.filter((c) => !c.isPlayer).map((c) => c.peer);
  }

  /** Time penalties the player serves at the flag (track limits), in seconds */
  public playerPenaltyS = 0;

  public status(): RaceStatus {
    const L = this.track.totalLengthM;
    const progress = new Map<FieldCar, RacerProgress>();
    for (const c of this.cars) progress.set(c, this.progressOf(c));
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
    let prevGap = 0;
    const playerIdx = order.findIndex((c) => c.isPlayer);
    // A spectated (headless) field has no player: report on its leader
    const player = order[playerIdx] ?? leader;
    const playerFinished = player.finishTimeS !== null;
    const final = playerFinished && classificationClosed(orderedProgress, this.raceTimeS);
    return {
      phase: this.phase,
      lightsOn: this.lightsOn,
      position: playerIdx + 1,
      fieldSize: order.length,
      lap: Math.max(1, Math.min(this.raceLaps, Math.floor(player.distM / L) + 1)),
      totalLaps: this.raceLaps,
      standings: order.map((c, i) => {
        const p = progress.get(c) as RacerProgress;
        // Keep the gaps ordered like the positions (bucket timing is coarse at launch speeds)
        if (this.phase !== 'lights') {
          const ct = classifiedTimeS(p);
          const lt = classifiedTimeS(progress.get(leader) as RacerProgress);
          const gap = ct !== null && lt !== null ? ct - lt : gapTo(c);
          gapFloor = Math.max(gapFloor, gap);
        }
        const intervalS = i > 0 ? gapFloor - prevGap : undefined;
        prevGap = gapFloor;
        return {
          driverCode: c.code,
          teamColorHex: c.teamColorHex,
          isPlayer: c.isPlayer,
          lap: Math.max(1, Math.min(this.raceLaps, Math.floor(c.distM / L) + 1)),
          gapToLeaderS: gapFloor,
          intervalS,
          finished: c.finishTimeS !== null,
          bestLapMs: c.bestLapMs,
          lastLapMs: c.lastLapMs,
          trackS: lapPositionM(c.distM, L),
          raceDistM: c.distM,
          compound: c.sim.tireCompound,
          penaltyS: p.penaltyS || undefined,
        };
      }),
      results: playerFinished ? classify(orderedProgress, L, this.raceLaps, final) : undefined,
      resultsFinal: final,
      splits: this.phase === 'racing' ? this.playerSplits.compute(this.splitTimer, this.raceTimeS, orderedProgress) : undefined,
    };
  }
}
