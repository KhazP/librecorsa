/**
 * The track as every car on it shares it: rubber / marbles / surface temperature (`track-evolution.ts`), the weather
 * and the water on the road (`weather.ts`) and the slipstream / dirty-air wake each car sheds (`aero-wake.ts`).
 *
 * One instance per circuit, owned by the main sim loop so the player's car gets the evolving road and the wake of
 * any car near it in every mode (solo practice, an AI race, multiplayer). An `AiOpponentField` given this instance
 * leaves the update to its owner; without one (headless use) the field runs its own.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import { evaluateAeroWakeDeficit, type WakeEmitterCar } from '@/lib/sim/aero-wake';
import { TrackEvolutionState } from '@/lib/sim/track-evolution';
import { aiLineOffsetM } from '@/lib/sim/speed-profile';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';
import type { TireCompound } from '@/types/f1';
import { DEFAULT_SESSION_CONDITIONS, type SessionConditions, type WeatherContactSample, WeatherState } from '@/lib/sim/weather';
import { recommendedCompound, WET_TYRE_TRAITS, wetGripFactor, wetnessFromWater } from '@/lib/sim/wet-tyres';
import { FULL_REALISM, type SimRealismFlags } from '@/lib/sim/sim-realism';

/** Below this speed a car lays no rubber (m/s) */
const MIN_ROLLING_MS = 1;
/** An AI car changes tyres once the weather has called for another compound this long (s) */
const AI_TYRE_CHANGE_S = 25;
/** Typical cornering speed the AI's wet pace is judged at (m/s) */
const AI_PACE_REF_MS = 40;

export class TrackEnvironment {
  public readonly trackEvolution: TrackEvolutionState;
  /** Sky, temperatures and the water on the road */
  public readonly weather: WeatherState;
  /** Every car's state before any is updated, simulated cars first (reused: no per-frame allocation) */
  private readonly emitters: WakeEmitterCar[] = [];
  /** Per simulated car: its weather sample (reused) and how long its AI has wanted other tyres (s) */
  private readonly weatherSamples = new WeakMap<SimulatorCar, WeatherContactSample>();
  private readonly tyreCallS = new WeakMap<SimulatorCar, number>();
  /** True until the first update of a session: the AI cars start on the right tyres */
  private freshSession = true;
  /** Simulation realism for every car on the track (the player's choice applies to the AI field too) */
  private realism: Readonly<SimRealismFlags> = FULL_REALISM;
  private readonly realismApplied = new WeakMap<SimulatorCar, Readonly<SimRealismFlags>>();

  constructor(
    private readonly track: BuiltTrackData,
    conditions: SessionConditions = DEFAULT_SESSION_CONDITIONS
  ) {
    this.trackEvolution = new TrackEvolutionState(track.totalLengthM);
    this.weather = new WeatherState(track.totalLengthM, conditions);
    this.trackEvolution.baseTrackTempC = this.weather.trackTempC;
    if (conditions.surfacePreset) this.trackEvolution.reset(conditions.surfacePreset);
    if (conditions.surfaceTimeScale !== undefined) this.trackEvolution.timeScale = conditions.surfaceTimeScale;
  }

  /** A fresh session: back to the baseline rubber, no marbles, and the weather back to its start */
  public reset(): void {
    this.weather.reset();
    this.trackEvolution.reset(this.weather.conditions.surfacePreset ?? 'natural');
    this.trackEvolution.timeScale = this.weather.conditions.surfaceTimeScale ?? 1;
    this.trackEvolution.baseTrackTempC = this.weather.trackTempC;
    this.freshSession = true;
  }

  /** Simulation realism (tyre wear, temperature grip, fuel, wet severity): reaches each car on its next update */
  public setSimRealism(flags: Readonly<SimRealismFlags>): void {
    this.realism = flags;
  }

  public get simRealism(): Readonly<SimRealismFlags> {
    return this.realism;
  }

  /** New weather / time of day for the session (restarts the weather) */
  public setConditions(conditions: SessionConditions): void {
    this.weather.reset(conditions);
    this.trackEvolution.reset(this.weather.conditions.surfacePreset ?? 'natural');
    this.trackEvolution.timeScale = this.weather.conditions.surfaceTimeScale ?? 1;
    this.trackEvolution.baseTrackTempC = this.weather.trackTempC;
    this.freshSession = true;
  }

  /**
   * An AI car's tyres (an instant change, standing in for a pit stop): on a dry track it keeps its own slick; rain tyres
   * go on, or come off again, once the weather has called for them for `AI_TYRE_CHANGE_S`. A new session, or a car
   * new to the track, starts on the right tyre at once.
   */
  private aiTyreCall(sim: SimulatorCar, calledFor: TireCompound, fresh: boolean, dt: number): void {
    if (!this.tyreCallS.has(sim)) fresh = true;
    const current = sim.tireCompound;
    const wantsRain = calledFor === 'intermediate' || calledFor === 'wet';
    const onRain = current === 'intermediate' || current === 'wet';
    const target: TireCompound = wantsRain ? calledFor : onRain ? 'medium' : current;
    if (target === current) {
      this.tyreCallS.set(sim, 0);
      return;
    }
    const waited = (this.tyreCallS.get(sim) ?? 0) + dt;
    if (fresh || waited >= AI_TYRE_CHANGE_S) {
      sim.tireCompound = target;
      this.tyreCallS.set(sim, 0);
    } else {
      this.tyreCallS.set(sim, waited);
    }
  }

  /** What the last update found under `sim` (its water, wetness and spray), or null before its first update */
  public weatherSampleFor(sim: SimulatorCar): Readonly<WeatherContactSample> | null {
    return this.weatherSamples.get(sim) ?? null;
  }

  /**
   * Pace multiplier for an AI car in the conditions (1 in the dry on slicks): its tyres' grip on the water of the
   * racing line here relative to dry slicks, with a little extra margin as the road gets wet. Corner speed goes
   * between √μ (mechanical grip) and faster than μ (downforce), so the grip ratio is taken to the power 0.65.
   */
  public weatherPaceScale(sim: SimulatorCar): number {
    const w = this.weather;
    if (!(w.waterMm > 0) && sim.tireCompound !== 'intermediate' && sim.tireCompound !== 'wet') return 1;
    const sample = this.track.getSampleAtDistance(sim.sMeters);
    const water = w.waterAt(sim.sMeters, sim.lateralOffsetM, aiLineOffsetM(sample));
    const traits = WET_TYRE_TRAITS[sim.tireCompound];
    const grip = traits.dryGrip * wetGripFactor(traits, water, AI_PACE_REF_MS, this.realism.wetSeverity);
    // A car planning on its wet grip already corners and brakes for it
    if (sim.aiPlanGrip) return 1 - 0.03 * wetnessFromWater(water);
    return Math.min(1, Math.pow(Math.max(0.1, grip), 0.65) * (1 - 0.03 * wetnessFromWater(water)));
  }

  /**
   * Deposits rubber for and samples the road under each simulated car, then hands each the wake of every other car:
   * the other simulated cars plus `others` (cars driven elsewhere, e.g. remote players, as wake emitters only).
   */
  public update(dt: number, cars: readonly SimulatorCar[], others: readonly WakeEmitterCar[] = []): void {
    const L = this.track.totalLengthM;
    const emitters = this.emitters;
    const n = cars.length + others.length;
    while (emitters.length < n) emitters.push({ sMeters: 0, lateralOffsetM: 0, speedMs: 0 });
    emitters.length = n;
    for (let i = 0; i < cars.length; i++) {
      emitters[i].sMeters = cars[i].sMeters;
      emitters[i].lateralOffsetM = cars[i].lateralOffsetM;
      emitters[i].speedMs = cars[i].vxMs;
    }
    for (let i = 0; i < others.length; i++) {
      const e = emitters[cars.length + i];
      e.sMeters = others[i].sMeters;
      e.lateralOffsetM = others[i].lateralOffsetM;
      e.speedMs = others[i].speedMs;
    }

    // The weather moves on; the track takes its temperature and rain rinses the rubber off the line
    const weather = this.weather;
    weather.step(dt);
    this.trackEvolution.baseTrackTempC = weather.trackTempC;
    this.trackEvolution.weatherWash(weather.rainIntensity, dt);
    const fresh = this.freshSession;
    this.freshSession = false;
    const calledFor = recommendedCompound(weather.lineWaterMm);

    for (let i = 0; i < cars.length; i++) {
      const sim = cars[i];
      const sample = this.track.getSampleAtDistance(sim.sMeters);
      const racingLineLatM = aiLineOffsetM(sample);

      // Water under the car (the cars sweep the racing line dry), the air temperature, and the AI's tyre call
      if (Math.abs(sim.vxMs) > MIN_ROLLING_MS) {
        weather.depositCarPass(sim.sMeters, sim.lateralOffsetM - racingLineLatM, Math.abs(sim.vxMs), dt);
      }
      let ws = this.weatherSamples.get(sim);
      if (!ws) {
        ws = { waterMm: 0, wheelWaterMm: [0, 0, 0, 0], wetness: 0, ambientC: weather.ambientC, rain: 0, sprayIntensity: 0 };
        this.weatherSamples.set(sim, ws);
      }
      ws.waterMm = weather.waterAt(sim.sMeters, sim.lateralOffsetM, racingLineLatM);
      ws.wetness = wetnessFromWater(ws.waterMm);
      ws.ambientC = weather.ambientC;
      ws.rain = weather.rainIntensity;
      ws.humidityPct = weather.humidityPct;
      ws.windVxMs = weather.windVxMs;
      ws.windVzMs = weather.windVzMs;

      // Topographical per-wheel water film depth [FR, FL, RR, RL]
      const bankDeg = (sample.bankingRad ?? 0) * (180 / Math.PI);
      const slopePct = (sample.slopeSin ?? 0) * 100;
      const halfWidthM = (sample.width ?? 15) * 0.5;
      const sFront = (sim.sMeters + 1.65) % L;
      const sRear = (sim.sMeters - 1.65 + L) % L;
      const latR = sim.lateralOffsetM + 0.78;
      const latL = sim.lateralOffsetM - 0.78;
      ws.wheelWaterMm ??= [0, 0, 0, 0];
      ws.wheelWaterMm[0] = weather.waterAtTopography(sFront, latR, racingLineLatM, bankDeg, slopePct, halfWidthM);
      ws.wheelWaterMm[1] = weather.waterAtTopography(sFront, latL, racingLineLatM, bankDeg, slopePct, halfWidthM);
      ws.wheelWaterMm[2] = weather.waterAtTopography(sRear, latR, racingLineLatM, bankDeg, slopePct, halfWidthM);
      ws.wheelWaterMm[3] = weather.waterAtTopography(sRear, latL, racingLineLatM, bankDeg, slopePct, halfWidthM);

      const wake = evaluateAeroWakeDeficit(
        sim.sMeters,
        sim.lateralOffsetM,
        sim.vxMs,
        emitters,
        L,
        sample.curvature,
        i,
        ws.wetness
      );
      ws.sprayIntensity = wake.sprayIntensity ?? 0;

      sim.setWeatherSample?.(ws);
      if (this.realismApplied.get(sim) !== this.realism) {
        sim.setSimRealism?.(this.realism);
        this.realismApplied.set(sim, this.realism);
      }
      if (sim.aiAutoTyres && sim.aiAutopilot) this.aiTyreCall(sim, calledFor, fresh, dt);

      // Instantaneous tyre sliding power (W) from combined slip and vertical load
      let slipPowerW = 0;
      for (let w = 0; w < 4; w++) {
        const wh = sim.wheels[w];
        if (wh) slipPowerW += wh.fzN * wh.combinedSlipNorm * Math.abs(sim.vxMs) * 0.12;
      }
      // Only a rolling car lays rubber (one held on the grid behind the lights does not)
      if (Math.abs(sim.vxMs) > MIN_ROLLING_MS) {
        this.trackEvolution.depositCarPass(sim.sMeters, sim.lateralOffsetM, racingLineLatM, slipPowerW, dt);
      }
      sim.setTrackEvolutionSample?.(
        this.trackEvolution.sample(sim.sMeters, sim.lateralOffsetM, racingLineLatM, ws.wetness, this.realism.wetSeverity)
      );

      sim.setAeroWakeState?.(wake);
    }
  }
}

/**
 * Fills `out` (reused, grown as needed) with the wake emitters of the cars driven elsewhere: remote players and the
 * like, placed on the track from their interpolated pose. The best-lap ghost sheds no air and is left out.
 */
export function peerWakeEmitters(
  track: Pick<BuiltTrackData, 'projectWorldToTrack'>,
  peers: readonly InterpolatedPeerState[],
  out: WakeEmitterCar[]
): WakeEmitterCar[] {
  let n = 0;
  for (const p of peers) {
    if (p.ghost) continue;
    const proj = track.projectWorldToTrack(p.position.x, p.position.z, p.trackS);
    if (!Number.isFinite(proj.s) || !Number.isFinite(proj.lateralOffset)) continue;
    if (n >= out.length) out.push({ sMeters: 0, lateralOffsetM: 0, speedMs: 0 });
    out[n].sMeters = proj.s;
    out[n].lateralOffsetM = proj.lateralOffset;
    out[n].speedMs = p.speedKmh / 3.6;
    n++;
  }
  out.length = n;
  return out;
}
