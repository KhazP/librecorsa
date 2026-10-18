/**
 * The track as every car on it shares it: RealRoad rubber / marbles / surface temperature (`real-road.ts`) and the
 * slipstream / dirty-air wake each car sheds (`aero-wake.ts`).
 *
 * One instance per circuit, owned by the main sim loop so the player's car gets the evolving road and the wake of
 * any car near it in every mode (solo practice, an AI race, multiplayer). An `AiOpponentField` given this instance
 * leaves the update to its owner; without one (headless use) the field runs its own.
 */
import type { BuiltTrackData } from '@/lib/track-data';
import { evaluateAeroWakeDeficit, type WakeEmitterCar } from '@/lib/sim/aero-wake';
import { RealRoadState } from '@/lib/sim/real-road';
import { aiLineOffsetM } from '@/lib/sim/speed-profile';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';

/** Below this speed a car lays no rubber (m/s) */
const MIN_ROLLING_MS = 1;

export class TrackEnvironment {
  public readonly realRoad: RealRoadState;
  /** Every car's state before any is updated, simulated cars first (reused: no per-frame allocation) */
  private readonly emitters: WakeEmitterCar[] = [];

  constructor(private readonly track: BuiltTrackData) {
    this.realRoad = new RealRoadState(track.totalLengthM);
  }

  /** A fresh session: back to the baseline rubber, no marbles */
  public reset(): void {
    this.realRoad.reset();
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

    for (let i = 0; i < cars.length; i++) {
      const sim = cars[i];
      const sample = this.track.getSampleAtDistance(sim.sMeters);
      const racingLineLatM = aiLineOffsetM(sample);

      // Instantaneous tyre sliding power (W) from combined slip and vertical load
      let slipPowerW = 0;
      for (let w = 0; w < 4; w++) {
        const wh = sim.wheels[w];
        if (wh) slipPowerW += wh.fzN * wh.combinedSlipNorm * Math.abs(sim.vxMs) * 0.12;
      }
      // Only a rolling car lays rubber (one held on the grid behind the lights does not)
      if (Math.abs(sim.vxMs) > MIN_ROLLING_MS) {
        this.realRoad.depositCarPass(sim.sMeters, sim.lateralOffsetM, racingLineLatM, slipPowerW, dt);
      }
      sim.setRealRoadSample?.(this.realRoad.sample(sim.sMeters, sim.lateralOffsetM, racingLineLatM));

      sim.setAeroWakeState?.(
        evaluateAeroWakeDeficit(sim.sMeters, sim.lateralOffsetM, sim.vxMs, emitters, L, sample.curvature, i)
      );
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
