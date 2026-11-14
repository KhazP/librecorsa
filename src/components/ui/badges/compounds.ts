import type { PaletteColor } from "../Badge";

/** Tyre compounds (the same five strings as the sim's own `TireCompound`) */
export type Compound = "soft" | "medium" | "hard" | "intermediate" | "wet";

/**
 * The one compound table: soft red, medium yellow, hard white, intermediate green, wet blue, the plain convention
 * drawn in the project's own tokens. Class strings are written out so Tailwind finds them.
 */
export const COMPOUNDS: Record<
  Compound,
  { name: string; letter: "S" | "M" | "H" | "I" | "W"; color: PaletteColor; ring: string }
> = {
  soft: { name: "Soft", letter: "S", color: "crimson", ring: "stroke-lc-crimson" },
  medium: { name: "Medium", letter: "M", color: "amber", ring: "stroke-lc-amber" },
  hard: { name: "Hard", letter: "H", color: "chalk", ring: "stroke-lc-chalk" },
  intermediate: { name: "Intermediate", letter: "I", color: "green", ring: "stroke-lc-green" },
  wet: { name: "Wet", letter: "W", color: "cyan", ring: "stroke-lc-cyan" },
};

/** Compound letters drawn as strokes on the 24 grid, inside the ring, so they never depend on a font */
export const COMPOUND_LETTER: Record<Compound, string> = {
  soft: "M14.6 8.6A3 2.25 0 0 0 12 7.5 3 2.25 0 0 0 9 9.75 3 2.25 0 0 0 12 12a3 2.25 0 0 1 3 2.25 3 2.25 0 0 1-3 2.25 3 2.25 0 0 1-2.6-1.1",
  medium: "M8.5 16.5v-9l3.5 5.5 3.5-5.5v9",
  hard: "M8.75 7.5v9M15.25 7.5v9M8.75 12h6.5",
  intermediate: "M12 7.5v9M9.75 7.5h4.5M9.75 16.5h4.5",
  wet: "M7.75 7.5l1.75 9 2.5-6 2.5 6 1.75-9",
};

/** The compounds in the order a picker lists them */
export const COMPOUND_ORDER: readonly Compound[] = ["soft", "medium", "hard", "intermediate", "wet"];

const SHORT_LABEL: Record<Compound, string> = { soft: "Soft", medium: "Med", hard: "Hard", intermediate: "Inter", wet: "Wet" };
const LONG_NAME: Record<Compound, string> = {
  soft: "Soft tyres",
  medium: "Medium tyres",
  hard: "Hard tyres",
  intermediate: "Intermediate tyres (wet track)",
  wet: "Full wet tyres (standing water)",
};

/**
 * The compounds as a picker's options: a short label, the spoken name, and the sidewall ring's colour as a CSS
 * colour (from the table above, so there is one colour per compound)
 */
export const COMPOUND_CHOICES: readonly { id: Compound; label: string; name: string; ring: string }[] = COMPOUND_ORDER.map(
  (id) => ({ id, label: SHORT_LABEL[id], name: LONG_NAME[id], ring: `var(--color-lc-${COMPOUNDS[id].color})` }),
);
