/**
 * The player's pit stop on their own line of the race's standing. The field counts and times the AI cars' stops
 * itself; the player's are the page's pit crew's (`PitStopManager`, `CarTelemetry.pit`), so the towers' pit clock and
 * the pit stop's card read them from here, in an AI race on the page and in the worker alike.
 *
 * Pure, no three.js or DOM.
 */
import type { PitTelemetry, RaceStatus } from "@/types/f1";

/** `race` with the player's stops, the crew's clock while it works, and (just released) the tyres it fitted */
export function withPlayerPit(race: RaceStatus | undefined, pit: PitTelemetry | undefined): RaceStatus | undefined {
  if (!race || !pit || race.multiplayer) return race;
  const servicing = pit.phase === "servicing";
  if (!servicing && pit.stopsMade === 0) return race;
  const i = race.standings.findIndex((e) => e.isPlayer);
  if (i < 0) return race;
  const me = race.standings[i];
  const standings = race.standings.slice();
  standings[i] = {
    ...me,
    pitStops: pit.stopsMade || undefined,
    pitBox: servicing
      ? { elapsedS: Math.round((pit.serviceTotalS - pit.serviceLeftS) * 100) / 100, totalS: pit.serviceTotalS }
      : undefined,
    // The fitted set before the car's own compound catches up with it (the worker's car, a frame or two later)
    compound: pit.phase === "released" ? pit.strategy.nextCompound : me.compound,
  };
  return { ...race, standings };
}
