/**
 * One headless AI race with a stand-in for the player: a car in the player's slot that drives its own line on the
 * autopilot, blind to the AI around it (it never yields, tucks in or leaves room; it only keeps the "never closer than
 * it could stop" follow cap; `autopilotRacecraft` is pinned off for it, and the AI cars give it a player's room). Every other racecraft check races AI against AI,
 * and every AI car keeps the same rules, so a rule that only works when the other car cooperates never shows there.
 *
 * Stand-in profiles (what a human does that an AI car does not):
 *  - `line`: its line at a steady pace
 *  - `slow`: its line, well off the pace (a newcomer on a keyboard)
 *  - `early`: full speed on the straights, then brakes early and goes slowly through the corners (GT Sophy's lesson:
 *    an agent trained only against itself rear-ended humans who braked early)
 *  - `weave`: off its line, drifting across the road to a new offset every few seconds
 *  - `autopilot`: the game's own autopilot (P) as a player gets it, at the car's own autopilot pace, with the field's
 *    racecraft as the arm's `autopilotRacecraft` says (#187)
 *
 * Contacts are judged by race control's own judge (`judgeContact`) at the moment they happen, and counted once per
 * pair per second, as the field counts them.
 *
 * The race steps as the simulation worker steps one (`sim-runtime.ts` advance): the road under every car, then the
 * player's car (held on the grid in the lights), then the field.
 */
import { readFileSync } from 'node:fs';
import { getActiveTrackData, setActiveTrack, type BuiltTrackData, type RawTrackJson } from '../../../src/lib/track-data';
import { vehicleModelSpec } from '../../../src/lib/cars/vehicle-models';
import type { VehicleModelId } from '../../../src/types/f1';
import { F12026CarSim } from '../../../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../../../src/lib/sim/gt3/AmgGt3Sim';
import { AiOpponentField, aiDriversFor, type FieldIncident, type RacecraftParams } from '../../../src/lib/sim/ai-opponents';
import { judgeContact } from '../../../src/lib/sim/race-incidents';
import type { SimulatorCar } from '../../../src/lib/sim/simulator-car';
import { TrackEnvironment } from '../../../src/lib/sim/track-environment';
import { DEFAULT_SESSION_CONDITIONS, type WeatherPresetId } from '../../../src/lib/sim/weather';
import { loadGlbGeometry } from '../../lib/glb-geometry';

export const STAND_IN_PROFILES = ['none', 'line', 'slow', 'early', 'weave', 'autopilot'] as const;
export type StandInProfile = (typeof STAND_IN_PROFILES)[number];

export interface StandInRaceOptions {
  trackId: string;
  /** Car id: 'lc26' (the 2026 Prototype), 'f12026-car', 'amg-gt3' or any vehicle model id */
  car: string;
  seed: number;
  laps: number;
  /** AI cars in the field */
  aiCars: number;
  skill?: number;
  racecraft?: Partial<RacecraftParams>;
  standIn: StandInProfile;
  /** The stand-in's grid slot (default 'middle': cars to race on both sides of it) */
  playerGrid?: 'back' | 'middle' | 'front' | 'random';
  localPlanner?: boolean;
  /** The session's weather (default clear) */
  weather?: WeatherPresetId;
}

/** One kind of contact, counted once per pair per second */
export interface ContactTally {
  events: number;
  /** Judged at fault: the AI car (or the car behind / the one that moved, AI v AI) */
  aiAtFault: number;
  /** ... the stand-in */
  standInAtFault: number;
  racingIncident: number;
  /** From behind / moved into a car alongside, whoever was at fault */
  rearEnd: number;
  sideswipe: number;
  /** Sum of impact speeds (m/s) */
  impactSum: number;
}

export interface StandInRaceResult {
  trackId: string;
  car: string;
  seed: number;
  standIn: StandInProfile;
  finished: boolean;
  simS: number;
  /** AI against the stand-in */
  vsStandIn: ContactTally;
  /** AI against AI */
  aiVsAi: ContactTally;
  /**
   * Where and when ([lap distance m, race s]) each contact with the stand-in happened, who race control blamed, its
   * reason, and whether the stand-in was the car behind
   */
  vsStandInAt: [number, number, 'ai' | 'standIn' | 'none', string, boolean][];
  /** Penalty seconds race control gave the stand-in */
  standInPenaltiesS: number;
  /** Seconds the stand-in spent touching an AI car */
  standInTouchS: number;
  /** Places the stand-in lost to AI cars on the road, and won back */
  standInPlacesLost: number;
  standInPlacesWon: number;
  standInDamage: number;
  standInMeanLapS: number;
  aiSpins: number;
  aiOffs: number;
  aiWalls: number;
  aiDnf: number;
  aiPasses: number;
  aiMeanLapS: number;
  aiPenaltiesS: number;
  /** Where and when (lap m, race s) each AI v AI contact, AI spin and AI off-track happened */
  aiVsAiAt: [number, number][];
  spinsAt: [number, number][];
  offsAt: [number, number][];
  /** Where and when AI cars hit a barrier ([lap distance m, race time s]) */
  wallsAt: [number, number][];
}

const emptyTally = (): ContactTally => ({ events: 0, aiAtFault: 0, standInAtFault: 0, racingIncident: 0, rearEnd: 0, sideswipe: 0, impactSum: 0 });

function makeTemplate(car: string, track: BuiltTrackData): SimulatorCar {
  const root = loadGlbGeometry(`public${track.meshUrl}`);
  if (car === 'amg-gt3') return createAmgGt3Sim(track, root);
  if (car === 'f12026-car') return new F12026CarSim(track, root);
  return vehicleModelSpec(car as VehicleModelId).createSim(track, root);
}

/** A seeded uniform random number generator (mulberry32) */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Drives the stand-in for its profile: pace, line offset and an early-braking cap, before each of its steps */
class StandInDriver {
  private readonly rand: () => number;
  private targetBias = 0;
  private nextMoveS = 3;
  private bias = 0;

  constructor(
    private readonly profile: StandInProfile,
    private readonly sim: SimulatorCar,
    private readonly track: BuiltTrackData,
    seed: number
  ) {
    this.rand = rng32(seed * 7919 + 13);
  }

  /** Before the stand-in's step: `fieldCap` is the follow cap the field just gave it */
  drive(dt: number, timeS: number): void {
    const sim = this.sim;
    sim.aiAutopilot = true;
    const L = this.track.totalLengthM;
    const smp = this.track.getSampleAtDistance(sim.sMeters);
    switch (this.profile) {
      case 'line':
        sim.aiPaceScale = 0.91;
        break;
      case 'slow':
        sim.aiPaceScale = 0.84;
        break;
      case 'early': {
        // Full speed until a corner's speed shows within the stopping distance, then a slow corner: brakes well before
        // the AI's braking point and carries less speed through it
        let vMin = Infinity;
        const v = Math.max(0, sim.vxMs);
        const look = 40 + (v * v) / 30;
        for (let d = 0; d <= look; d += 10) vMin = Math.min(vMin, this.track.getSampleAtDistance((sim.sMeters + d) % L).optimalSpeedKmh / 3.6);
        const braking = vMin < v - 3 || smp.optimalSpeedKmh / 3.6 < v + 2;
        sim.aiPaceScale = braking ? 0.84 : 0.98;
        break;
      }
      case 'weave': {
        sim.aiPaceScale = 0.9;
        if (timeS >= this.nextMoveS) {
          const half = smp.width / 2 - 1.6;
          this.targetBias = (this.rand() * 2 - 1) * Math.max(0, Math.min(3.5, half));
          this.nextMoveS = timeS + 2 + this.rand() * 4;
        }
        this.bias += Math.max(-1.5 * dt, Math.min(1.5 * dt, this.targetBias - this.bias));
        sim.aiLineBiasM = this.bias;
        break;
      }
      case 'autopilot':
        // The car's own autopilot pace, as the game leaves it (the LC26's 0.8)
        break;
      case 'none':
        break;
    }
  }
}

export function runStandInRace(o: StandInRaceOptions): StandInRaceResult {
  setActiveTrack(o.trackId, JSON.parse(readFileSync(`public/tracks/${o.trackId}/track_data.json`, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  const L = track.totalLengthM;
  const player = makeTemplate(o.car, track);
  const spectate = o.standIn === 'none';
  const env = new TrackEnvironment(track, { ...DEFAULT_SESSION_CONDITIONS, weather: o.weather ?? 'clear' });
  const field = new AiOpponentField(track, player, aiDriversFor(o.aiCars), env, {
    skill: o.skill,
    seed: o.seed,
    learning: false,
    spectate,
    trackId: o.trackId,
    gridOrder: 'qualifying',
    playerGrid: o.playerGrid ?? 'middle',
    // (the other profiles stand in for a human, who keeps none of the field's rules: their autopilot stays blind whatever
    // the arm says; only `autopilot` races as the game's autopilot does, by the arm's knobs)
    racecraft: o.standIn === 'autopilot' ? o.racecraft : { ...o.racecraft, autopilotRacecraft: 0 },
    localPlanner: o.localPlanner,
  });
  field.raceLaps = o.laps;
  field.startRace(true);
  const aiCodes = field.report().cars.filter((c) => !c.isPlayer).map((c) => c.code);
  const driver = spectate ? null : new StandInDriver(o.standIn, player, track, o.seed);

  const DT = 1 / 120;
  const limitS = 60 + o.laps * 200;
  const vsStandIn = emptyTally();
  const aiVsAi = emptyTally();
  const lastPairS = new Map<string, number>();
  let t = 0;
  let touchS = 0;
  let lost = 0;
  let won = 0;
  let lastPos = -1;
  let posTimerS = 0;
  const standInLaps: number[] = [];
  let lapStartS = 0;
  let prevS = player.sMeters;
  let standInDist = 0;

  const aiVsAiAt: [number, number][] = [];
  const vsStandInAt: StandInRaceResult['vsStandInAt'] = [];
  const spinsAt: [number, number][] = [];
  const offsAt: [number, number][] = [];
  const wallsAt: [number, number][] = [];
  const wallSeen = new Map<string, number>();
  const offSeen = new Map<string, number>();
  let offTimerS = 0;
  const tally = (c: Extract<FieldIncident, { kind: 'contact' }>) => {
    const key = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    const last = lastPairS.get(key);
    lastPairS.set(key, t);
    if (last !== undefined && t - last < 1) return;
    const withStandIn = c.aIsPlayer || c.bIsPlayer;
    const k = withStandIn ? vsStandIn : aiVsAi;
    if (!withStandIn) {
      const sim = field.carInfo(c.a)?.sim;
      if (sim) aiVsAiAt.push([Math.round(sim.sMeters), Math.round(t * 10) / 10]);
    }
    const j = judgeContact(c);
    k.events++;
    k.impactSum += c.impactMs;
    if (withStandIn) {
      const blame = j.atFault === null ? 'none' : (j.atFault === 'a' ? c.aIsPlayer : c.bIsPlayer) ? 'standIn' : 'ai';
      vsStandInAt.push([Math.round(player.sMeters), Math.round(t * 10) / 10, blame, j.reason, c.aIsPlayer]);
    }
    if (j.atFault === null) k.racingIncident++;
    else {
      const faultIsPlayer = j.atFault === 'a' ? c.aIsPlayer : c.bIsPlayer;
      if (withStandIn && faultIsPlayer) k.standInAtFault++;
      else k.aiAtFault++;
      if (j.reason.startsWith('Hit')) k.rearEnd++;
      else k.sideswipe++;
    }
  };

  while (field.phase !== 'finished' && t < limitS) {
    env.update(DT, field.sims());
    if (driver && !field.playerFrozen) {
      driver.drive(DT, t);
      player.step(DT, {});
    }
    field.update(DT);
    t += DT;
    for (const inc of field.incidents) {
      if (inc.kind === 'contact') tally(inc);
      else if (inc.kind === 'spin') spinsAt.push([Math.round(inc.s), Math.round(t * 10) / 10]);
    }
    // Off-track moments, from each AI car's own count a few times a second
    offTimerS += DT;
    if (offTimerS >= 0.25) {
      offTimerS = 0;
      for (const code of aiCodes) {
        const info = field.carInfo(code);
        if (!info) continue;
        const was = offSeen.get(code) ?? 0;
        if (info.stats.offTracks > was) offsAt.push([Math.round(info.sim.sMeters), Math.round(t * 10) / 10]);
        offSeen.set(code, info.stats.offTracks);
        if (info.stats.wallHits > (wallSeen.get(code) ?? 0)) wallsAt.push([Math.round(info.sim.sMeters), Math.round(t * 10) / 10]);
        wallSeen.set(code, info.stats.wallHits);
      }
    }
    if (!driver) continue;
    // The stand-in's own laps (the field keeps no lap clock for the player's car here)
    const ds = player.sMeters - prevS;
    standInDist += ds < -L / 2 ? ds + L : ds > L / 2 ? ds - L : ds;
    prevS = player.sMeters;
    if (standInDist >= (standInLaps.length + 1) * L && field.phase === 'racing') {
      standInLaps.push(t - lapStartS);
      lapStartS = t;
    }
    if (field.phase !== 'racing') continue;
    posTimerS += DT;
    if (posTimerS >= 0.25) {
      posTimerS = 0;
      const pos = field.status().position;
      if (lastPos > 0 && pos > lastPos) lost += pos - lastPos;
      if (lastPos > 0 && pos < lastPos) won += lastPos - pos;
      lastPos = pos;
    }
    // Touching: the stand-in's footprint against each AI car's, along and across the road
    for (const o of field.aiSims()) {
      const dsO = Math.abs(((o.sMeters - player.sMeters + 1.5 * L) % L) - L / 2);
      if (dsO < 5 && Math.abs(o.lateralOffsetM - player.lateralOffsetM) < 2.0) {
        touchS += DT;
        break;
      }
    }
  }

  const r = field.report();
  const ai = r.cars.filter((c) => !c.isPlayer);
  const sum = (k: 'spins' | 'offTracks' | 'wallHits' | 'passes') => ai.reduce((a, c) => a + c.stats[k], 0);
  const flying = ai.flatMap((c) => c.stats.lapTimesMs.slice(1)).filter((x) => x > 0);
  const me = r.cars.find((c) => c.isPlayer);
  return {
    trackId: o.trackId,
    car: o.car,
    seed: o.seed,
    standIn: o.standIn,
    finished: field.phase === 'finished',
    simS: t,
    vsStandIn,
    aiVsAi,
    vsStandInAt,
    standInPenaltiesS: me ? me.penaltyS : 0,
    standInTouchS: touchS,
    standInPlacesLost: lost,
    standInPlacesWon: won,
    standInDamage: me ? me.damage : 0,
    standInMeanLapS: standInLaps.length > 1 ? standInLaps.slice(1).reduce((a, b) => a + b, 0) / (standInLaps.length - 1) : NaN,
    aiSpins: sum('spins'),
    aiOffs: sum('offTracks'),
    aiWalls: sum('wallHits'),
    aiDnf: ai.filter((c) => c.retired).length,
    aiPasses: sum('passes'),
    aiMeanLapS: flying.length ? flying.reduce((a, b) => a + b, 0) / flying.length / 1000 : NaN,
    aiPenaltiesS: ai.reduce((a, c) => a + c.penaltyS, 0),
    aiVsAiAt,
    spinsAt,
    offsAt,
    wallsAt,
  };
}
