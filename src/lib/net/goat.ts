/**
 * The Hall of Fame's Most decorated order and its GOAT badge (issue #181), in one place for both sides so they never
 * disagree: the Worker (cloudflare/api/awards.ts) ranks the Most decorated list and gives the badge with it, and the
 * Hall of Fame card (src/components/board/HallOfFame.tsx) marks the same drivers on that list. No imports: the Worker
 * loads this file.
 */

/** A driver's weekly challenge medals, finished weeks only */
export interface MedalTally {
  nameKey: string;
  gold: number;
  silver: number;
  bronze: number;
}

/** The Most decorated order before the name: most golds first, then silvers, then bronzes */
export const compareMedals = (a: MedalTally, b: MedalTally): number => b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze;

/**
 * The name keys of the GOAT: the drivers at the top of the Most decorated order. Every driver tied with the leader on
 * golds, silvers and bronzes shares it (the list's name order is no tiebreak here), and it takes at least one gold, so
 * medals without a win make nobody the GOAT. The tallies may come in any order.
 */
export function goatKeys(tallies: readonly MedalTally[]): Set<string> {
  let top: MedalTally | null = null;
  for (const d of tallies) if (top === null || compareMedals(d, top) < 0) top = d;
  const leader = top;
  if (leader === null || leader.gold < 1) return new Set();
  return new Set(tallies.filter((d) => compareMedals(d, leader) === 0).map((d) => d.nameKey));
}
