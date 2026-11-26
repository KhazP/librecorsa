/** Where a bottom corner panel last went beside Blade's bar, and the width it had when that was decided */
export interface CornerBeside {
  on: boolean;
  width: number;
}

export const CORNER_BESIDE_START: CornerBeside = { on: true, width: 0 };

/**
 * Whether a bottom corner panel (Blade's MFD, its inputs) sits beside the bar or above it. `spare` is the room left
 * between the bar and the panel at its `width` (px; below 0 they overlap, which the bar's slanted end allows down to
 * −8). 8 px either way of the limit keeps a panel whose width breathes (the MFD's status line) from hopping up and
 * down; a bigger change of width (the fonts arriving, a page's longer summary) decides afresh, so where the panel ends
 * up never depends on a width it had for a moment.
 */
export function cornerBeside(was: CornerBeside, width: number, spare: number): CornerBeside {
  const fresh = Math.abs(width - was.width) > 16;
  const on = spare >= (fresh || was.on ? -8 : 8);
  return { on, width: fresh ? width : was.width };
}
