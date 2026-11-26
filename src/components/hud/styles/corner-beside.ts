/**
 * Whether a bottom corner panel (Blade's MFD, its inputs) sits beside the bar or above it. `spare` is the room left
 * between the bar and the panel (px; below 0 they overlap, which the bar's slanted end allows down to −8). 8 px either
 * way of the limit keeps a panel whose width breathes (the MFD's status line, its diff phase) from hopping up and
 * down. Until the fonts have loaded the panel's width is a fallback font's (wider): the decision is drawn but not
 * kept, so where the panel settles never depends on that width.
 */
export function cornerBeside(wasBeside: boolean, spare: number, fontsLoaded: boolean): { beside: boolean; keep: boolean } {
  const beside = spare >= (wasBeside ? -8 : 8);
  return { beside, keep: fontsLoaded ? beside : wasBeside };
}
