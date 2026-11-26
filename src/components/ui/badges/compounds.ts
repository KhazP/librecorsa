import { t } from "@/i18n/runtime";
import type { MessageKey } from "@/i18n/types";
import type { TireCompound } from "@/types/f1";
import type { PaletteColor } from "../Badge";

/** Tyre compounds (the sim's own `TireCompound`) */
export type Compound = TireCompound;

/**
 * The one compound table: soft red, medium yellow, hard white, intermediate green, wet blue, the plain convention
 * drawn in the project's own tokens, and the super soft (only on a car whose data has one) purple, the colour the
 * softest slicks wear past the soft's red. Class strings are written out so Tailwind finds them. The name is read in
 * the current language each time it is shown.
 */
export const COMPOUNDS: Record<
  Compound,
  { readonly name: string; letter: "SS" | "S" | "M" | "H" | "I" | "W"; color: PaletteColor; ring: string }
> = {
  supersoft: { get name() { return t("common.compounds.name.supersoft"); }, letter: "SS", color: "purple", ring: "stroke-lc-purple" },
  soft: { get name() { return t("common.compounds.name.soft"); }, letter: "S", color: "crimson", ring: "stroke-lc-crimson" },
  medium: { get name() { return t("common.compounds.name.medium"); }, letter: "M", color: "amber", ring: "stroke-lc-amber" },
  hard: { get name() { return t("common.compounds.name.hard"); }, letter: "H", color: "chalk", ring: "stroke-lc-chalk" },
  intermediate: { get name() { return t("common.compounds.name.intermediate"); }, letter: "I", color: "green", ring: "stroke-lc-green" },
  wet: { get name() { return t("common.compounds.name.wet"); }, letter: "W", color: "cyan", ring: "stroke-lc-cyan" },
};

/** Compound letters drawn as strokes on the 24 grid, inside the ring, so they never depend on a font */
export const COMPOUND_LETTER: Record<Compound, string> = {
  supersoft:
    "M10.85 8.6A1.85 2.25 0 0 0 9.25 7.5 1.85 2.25 0 0 0 7.4 9.75 1.85 2.25 0 0 0 9.25 12a1.85 2.25 0 0 1 1.85 2.25 1.85 2.25 0 0 1-1.85 2.25 1.85 2.25 0 0 1-1.6-1.1M16.35 8.6A1.85 2.25 0 0 0 14.75 7.5 1.85 2.25 0 0 0 12.9 9.75 1.85 2.25 0 0 0 14.75 12a1.85 2.25 0 0 1 1.85 2.25 1.85 2.25 0 0 1-1.85 2.25 1.85 2.25 0 0 1-1.6-1.1",
  soft: "M14.6 8.6A3 2.25 0 0 0 12 7.5 3 2.25 0 0 0 9 9.75 3 2.25 0 0 0 12 12a3 2.25 0 0 1 3 2.25 3 2.25 0 0 1-3 2.25 3 2.25 0 0 1-2.6-1.1",
  medium: "M8.5 16.5v-9l3.5 5.5 3.5-5.5v9",
  hard: "M8.75 7.5v9M15.25 7.5v9M8.75 12h6.5",
  intermediate: "M12 7.5v9M9.75 7.5h4.5M9.75 16.5h4.5",
  wet: "M7.75 7.5l1.75 9 2.5-6 2.5 6 1.75-9",
};

/** Every compound in the order a picker lists them (a picker shows only the ones the car has: `carTyreCompounds`) */
export const COMPOUND_ORDER: readonly Compound[] = ["supersoft", "soft", "medium", "hard", "intermediate", "wet"];

const SHORT_LABEL: Record<Compound, MessageKey> = {
  supersoft: "common.compounds.short.supersoft",
  soft: "common.compounds.short.soft",
  medium: "common.compounds.short.medium",
  hard: "common.compounds.short.hard",
  intermediate: "common.compounds.short.intermediate",
  wet: "common.compounds.short.wet",
};
const LONG_NAME: Record<Compound, MessageKey> = {
  supersoft: "common.compounds.long.supersoft",
  soft: "common.compounds.long.soft",
  medium: "common.compounds.long.medium",
  hard: "common.compounds.long.hard",
  intermediate: "common.compounds.long.intermediate",
  wet: "common.compounds.long.wet",
};

/**
 * The compounds as a picker's options: a short label, the spoken name (both read in the current language when shown),
 * and the sidewall ring's colour as a CSS colour (from the table above, so there is one colour per compound)
 */
export const COMPOUND_CHOICES: readonly { id: Compound; readonly label: string; readonly name: string; ring: string }[] = COMPOUND_ORDER.map(
  (id) => ({
    id,
    get label() {
      return t(SHORT_LABEL[id]);
    },
    get name() {
      return t(LONG_NAME[id]);
    },
    ring: `var(--color-lc-${COMPOUNDS[id].color})`,
  }),
);
