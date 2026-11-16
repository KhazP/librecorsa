import { CARS, carById, type CarId } from "@/lib/cars/car-registry";
import { supportOf, type SupportLink } from "@/lib/modder-support";
import { getTrackInfo, LISTED_TRACKS } from "@/lib/track-registry";

/**
 * Who made what, from the car and circuit credits and the support map (modder-support.ts): one list for the Credits
 * panel and the home page's About, and one line each for the circuit and car being driven (the loading screen, the
 * note after a drive). The credits stay the one source: a modder's name here is exactly as credited.
 */

export interface ModderWork {
  name: string;
  /** Their own page, else the page of their first work */
  url: string;
  /** What of theirs is in the game: circuit names, car titles */
  works: string[];
  support?: SupportLink;
}

/** The modder of one circuit or car, as a line says it: "Circuit by", "Model by", "Physics by" */
export interface MakerLine {
  /** "Circuit", "Model", "Physics" */
  role: string;
  name: string;
  support?: SupportLink;
}

/** Every modder whose work is listed, those with a support page first, then by name */
export function moddersList(): ModderWork[] {
  const byName = new Map<string, ModderWork>();
  const add = (name: string, url: string, work: string) => {
    const m = byName.get(name) ?? { name, url, works: [], support: supportOf(name) };
    if (!m.works.includes(work)) m.works.push(work);
    byName.set(name, m);
  };
  for (const t of LISTED_TRACKS) if (t.credit) add(t.credit.author, t.credit.authorUrl ?? t.credit.url, t.name);
  for (const c of CARS) {
    add(c.credit.author, c.credit.authorUrl ?? c.credit.url, c.credit.label === "Physics by" ? `${c.title} (physics)` : c.title);
    if (c.tyreCredit) add(c.tyreCredit.author, c.tyreCredit.url, `${c.title} (tyres)`);
  }
  return [...byName.values()].sort((a, b) => Number(Boolean(b.support)) - Number(Boolean(a.support)) || a.name.localeCompare(b.name));
}

/** The circuit's modder; null for one of LibreCorsa's own (RISE Motordrome) */
export function circuitMaker(trackId: string): MakerLine | null {
  const credit = getTrackInfo(trackId).credit;
  return credit ? { role: "Circuit", name: credit.author, support: supportOf(credit.author) } : null;
}

/** The car's credited modder, in the credit's own words ("Physics by alekabul" for the Liana) */
export function carMaker(carId: CarId): MakerLine {
  const credit = carById(carId).credit;
  const role = (credit.label ?? "Model by").replace(/ by$/, "");
  return { role, name: credit.author, support: supportOf(credit.author) };
}

/** The game itself, as the site names its maker */
export const GAME_MAKER: MakerLine = { role: "Game", name: "Alp Yalay" };
