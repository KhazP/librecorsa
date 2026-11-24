/**
 * People whose code is in the game, from their merged pull requests, as the About section (HomeHub), the README and
 * CREDITS.md credit them. The modders, who made the cars' and circuits' models, are credited with their work instead
 * (src/lib/modders.ts).
 *
 * Add someone when their pull request merges, or when their work goes in with them as a co-author. Their GitHub
 * profile is the link: no other sites (see the HUD credit for adamikoo's AvgSpots, which stays there).
 */
export interface CodeContributor {
  /** As GitHub shows them */
  name: string;
  /** Their GitHub profile */
  url: string;
  /** The pull requests their code came in through, oldest first */
  pulls: readonly number[];
}

export const CODE_CONTRIBUTORS: readonly CodeContributor[] = [
  // Absolute pressure in the tyre gas law
  { name: "dardalo-si", url: "https://github.com/dardalo-si", pulls: [17] },
  // The verify runner: suites run several at once and every failure is reported
  { name: "Ravi Giri", url: "https://github.com/Ravigiri2022", pulls: [130] },
  // The Grand Prix HUD layout, the live HUD layout editor and start reaction timer, and frame-loop scratches + Windows ARM GPU detection
  { name: "adamikoo", url: "https://github.com/adamikoo", pulls: [162, 182, 192] },
];
