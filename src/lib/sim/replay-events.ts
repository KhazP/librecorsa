import type { ReplayBuffer } from "./replay-buffer";
import type { ReplayEvent, ReplayParticipant } from "./replay-types";

const OVERTAKE_MIN_LEAD_M = 2.5;
const OVERTAKE_HOLD_S = 1.5;
const OVERTAKE_COOLDOWN_S = 4.0;
const COLLISION_DIST_SQ_M = 3.2 * 3.2;
const COLLISION_DROP_KMH = 22;
const COLLISION_COOLDOWN_S = 4.0;

/**
 * Extracts grounded race events from recorded `ReplayBuffer` samples and merges them with
 * session-recorded race-control events (penalties, yellow flags, VSC, DNFs).
 * Never invents events from missing or unreliable fields.
 */
export function extractReplayEvents(
  buffer: ReplayBuffer,
  participants: readonly ReplayParticipant[] = [],
  recordedControlEvents: readonly ReplayEvent[] = []
): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  const count = buffer.frameCount;
  if (count < 2) {
    return [...recordedControlEvents].sort((a, b) => a.timeS - b.timeS);
  }

  const carIds = buffer.carIds();
  const startS = buffer.startS;
  const endS = buffer.endS;
  const stepS = Math.max(0.2, 1 / Math.max(1, buffer.sampleHz));

  // 1. Lap starts, finishes, personal bests, and overall fastest lap per car
  const bestByCar = new Map<string, { lap: number; durationS: number; finishTimeS: number }>();
  let overallBest: { carId: string; lap: number; durationS: number; finishTimeS: number } | null = null;

  for (const carId of carIds) {
    let prevLap: number | undefined;
    let prevOutLap = false;
    let lapStartTimeS: number | null = null;
    let personalBestS = Infinity;

    for (let t = startS; t <= endS + 1e-6; t += stepS) {
      const sample = buffer.carAt(Math.min(t, endS), carId);
      if (!sample || sample.lap === undefined) continue;
      const lap = sample.lap;
      const outLap = Boolean(sample.outLap);

      if (prevLap === undefined) {
        prevLap = lap;
        prevOutLap = outLap;
        if (!outLap && lap >= 1) lapStartTimeS = t;
        continue;
      }

      if (lap !== prevLap || outLap !== prevOutLap) {
        const transitionT = t;
        // Lap finished if we were on a valid timed lap >= 1
        if (!prevOutLap && prevLap >= 1 && lap > prevLap && lapStartTimeS !== null) {
          const durationS = transitionT - lapStartTimeS;
          if (durationS > 5) {
            events.push({
              id: `lap-fin-${carId}-${prevLap}`,
              kind: "lap_finish",
              timeS: transitionT,
              carId,
              lap: prevLap,
              detail: `${durationS.toFixed(3)}s`,
            });
            if (durationS < personalBestS) {
              personalBestS = durationS;
              bestByCar.set(carId, { lap: prevLap, durationS, finishTimeS: transitionT });
              events.push({
                id: `pb-${carId}-${prevLap}`,
                kind: "personal_best",
                timeS: transitionT,
                carId,
                lap: prevLap,
                detail: `${durationS.toFixed(3)}s`,
              });
            }
            if (!overallBest || durationS < overallBest.durationS) {
              overallBest = { carId, lap: prevLap, durationS, finishTimeS: transitionT };
            }
          }
        }
        if (!outLap && lap >= 1 && (lap > prevLap || prevOutLap)) {
          lapStartTimeS = transitionT;
          events.push({
            id: `lap-start-${carId}-${lap}`,
            kind: "lap_start",
            timeS: transitionT,
            carId,
            lap,
          });
        }
        prevLap = lap;
        prevOutLap = outLap;
      }
    }
  }

  if (overallBest) {
    events.push({
      id: `fl-${overallBest.carId}-${overallBest.lap}`,
      kind: "fastest_lap",
      timeS: overallBest.finishTimeS,
      carId: overallBest.carId,
      lap: overallBest.lap,
      detail: `${overallBest.durationS.toFixed(3)}s`,
    });
  }

  // 2. Multi-car overtakes and collisions (0.5 s scan step for speed on 20-min replays)
  if (carIds.length >= 2) {
    const scanStepS = 0.5;
    const prevOrder = new Map<string, number>();
    const lastOvertakeAt = new Map<string, number>();
    const lastCollisionAt = new Map<string, number>();
    const prevSpeed = new Map<string, number>();

    for (let t = startS; t <= endS + 1e-6; t += scanStepS) {
      const tc = Math.min(t, endS);
      const frame = buffer.frameAt(tc);
      if (!frame || frame.cars.length < 2) continue;

      // Check sharp speed drops + proximity for collisions
      for (let i = 0; i < frame.cars.length; i++) {
        const a = frame.cars[i];
        const aPrevSpeed = prevSpeed.get(a.id);
        const aDrop = aPrevSpeed !== undefined ? aPrevSpeed - a.speedKmh : 0;
        prevSpeed.set(a.id, a.speedKmh);

        for (let j = i + 1; j < frame.cars.length; j++) {
          const b = frame.cars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dz = a.z - b.z;
          const distSq = dx * dx + dy * dy + dz * dz;
          const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;

          if (distSq <= COLLISION_DIST_SQ_M) {
            const bPrevSpeed = prevSpeed.get(b.id);
            const bDrop = bPrevSpeed !== undefined ? bPrevSpeed - b.speedKmh : 0;
            const lastCol = lastCollisionAt.get(pairKey) ?? -Infinity;
            if ((aDrop >= COLLISION_DROP_KMH || bDrop >= COLLISION_DROP_KMH) && tc - lastCol >= COLLISION_COOLDOWN_S) {
              lastCollisionAt.set(pairKey, tc);
              events.push({
                id: `col-${pairKey}-${Math.round(tc * 10)}`,
                kind: "collision",
                timeS: tc,
                carId: a.id,
                otherCarId: b.id,
              });
            }
          }

          // Overtake detection grounded in monotonic race distance `distM`
          if (a.distM !== undefined && b.distM !== undefined && Number.isFinite(a.distM) && Number.isFinite(b.distM)) {
            const diff = a.distM - b.distM;
            const prevDiff = prevOrder.get(pairKey);
            if (prevDiff === undefined) {
              if (Math.abs(diff) >= OVERTAKE_MIN_LEAD_M) {
                prevOrder.set(pairKey, Math.sign(diff));
              }
            } else {
              const newSign = diff >= OVERTAKE_MIN_LEAD_M ? 1 : diff <= -OVERTAKE_MIN_LEAD_M ? -1 : 0;
              if (newSign !== 0 && newSign !== prevDiff) {
                // Verify sustained lead after OVERTAKE_HOLD_S
                const future = tc + OVERTAKE_HOLD_S <= endS ? buffer.frameAt(tc + OVERTAKE_HOLD_S) : null;
                const fa = future?.cars.find((c) => c.id === a.id);
                const fb = future?.cars.find((c) => c.id === b.id);
                const sustained =
                  !future ||
                  (fa?.distM !== undefined &&
                    fb?.distM !== undefined &&
                    (newSign > 0 ? fa.distM - fb.distM >= OVERTAKE_MIN_LEAD_M : fb.distM - fa.distM >= OVERTAKE_MIN_LEAD_M));
                const lastOt = lastOvertakeAt.get(pairKey) ?? -Infinity;
                if (sustained && tc - lastOt >= OVERTAKE_COOLDOWN_S) {
                  lastOvertakeAt.set(pairKey, tc);
                  const passer = newSign > 0 ? a : b;
                  const passed = newSign > 0 ? b : a;
                  events.push({
                    id: `ot-${passer.id}-${passed.id}-${Math.round(tc * 10)}`,
                    kind: "overtake",
                    timeS: tc,
                    carId: passer.id,
                    otherCarId: passed.id,
                    ...(passer.lap !== undefined ? { lap: passer.lap } : {}),
                  });
                }
                prevOrder.set(pairKey, newSign);
              }
            }
          }
        }
      }
    }
  }

  // 3. Merge session-recorded race control events (deduped by id)
  const seenIds = new Set(events.map((e) => e.id));
  for (const ev of recordedControlEvents) {
    if (!seenIds.has(ev.id) && Number.isFinite(ev.timeS)) {
      seenIds.add(ev.id);
      events.push(ev);
    }
  }

  // Add DNF markers from participants if not already present in recorded control events
  for (const p of participants) {
    if (p.dnf && !events.some((e) => e.kind === "dnf" && e.carId === p.id)) {
      // Find last valid recorded sample for this participant
      let lastValidT = startS;
      for (let t = endS; t >= startS; t -= 1) {
        if (buffer.carAt(t, p.id)) {
          lastValidT = t;
          break;
        }
      }
      events.push({
        id: `dnf-${p.id}`,
        kind: "dnf",
        timeS: lastValidT,
        carId: p.id,
      });
    }
  }

  events.sort((a, b) => a.timeS - b.timeS);
  return events;
}
