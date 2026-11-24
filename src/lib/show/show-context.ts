/**
 * What the career tells the pre-race show about a round (useCareerDrive.ts arms the show with it): the series and the
 * round, the race's terms, the field by the codes the race shows, and the championship as it stands. Language-free:
 * the overlay names the series and writes the labels in the player's language.
 */
import type { TimeOfDayId, WeatherPresetId } from "@/lib/sim/weather";

export interface ShowDriver {
  code: string;
  first: string;
  last: string;
  /** Race number (none for the player without one) */
  number: number | null;
  /** The car's colour, as the race draws it */
  color: string;
  isPlayer: boolean;
}

export interface ShowStanding {
  position: number;
  /** The code the race shows for this driver */
  code: string;
  points: number;
  isPlayer: boolean;
}

export interface ShowContext {
  /** ladder.ts series id: the overlay names it */
  seriesId: string;
  /** 0-based round, and the season's count */
  roundIndex: number;
  rounds: number;
  laps: number;
  pitStops: number;
  /** Qualifying length (min); 0: the race lines up by pace */
  qualifyingMin: number;
  /** The field by race code, the player included */
  drivers: Readonly<Record<string, ShowDriver>>;
  /** The championship before this round, in order (empty before the first round) */
  standings: readonly ShowStanding[];
  /** The round's conditions, as the career set them */
  weather: WeatherPresetId;
  timeOfDay: TimeOfDayId;
}

/** The code's driver, or a stand-in built from the code alone (a car the career did not name) */
export function showDriver(ctx: ShowContext | null, code: string, color: string, isPlayer: boolean): ShowDriver {
  const d = ctx?.drivers[code];
  if (d) return d;
  return { code, first: "", last: code, number: null, color, isPlayer };
}

/** The first round has no championship yet: nothing to show */
export const hasStandings = (ctx: ShowContext | null): boolean =>
  Boolean(ctx && ctx.roundIndex > 0 && ctx.standings.some((s) => s.points > 0));
