/**
 * Every in-race HUD layout the player can pick: the game's own and the third-party ones recreated from other
 * open-source HUD projects (THIRD_PARTY_NOTICES.md). The one list the settings parser, the pickers, the title menu,
 * the About page's credits and the verify suite read, so a layout has one id, one name and one credit everywhere.
 *
 * Ids are saved in players' settings for good: never rename one, and keep game and product names out of them.
 */
import { text as t } from "@/lib/text";

/** Credit for a layout recreated from another project: shown in the pickers and on the About page */
export interface HudLayoutCredit {
  /** The project's GitHub user, shown as "by <author>" */
  author: string;
  /** The project's source repository */
  repoUrl: string;
  /** SPDX id of the project's licence */
  license: "MIT" | "GPL-3.0";
  /** The author's own site, shown after their name as "<author> · <name>" */
  site?: { name: string; url: string };
}

/** Where each licence a credited layout comes under can be read */
export const HUD_LICENSE_URL: Record<HudLayoutCredit["license"], string> = {
  MIT: "https://opensource.org/license/mit",
  "GPL-3.0": "https://www.gnu.org/licenses/gpl-3.0.html",
};

export interface HudLayoutInfo<Id extends string = string> {
  id: Id;
  /** Player-facing name */
  label: string;
  /** One line under the name */
  detail: string;
  /** A third-party layout's source; absent on the game's own layouts */
  credit?: HudLayoutCredit;
}

/** The game's own layouts, in picker order (Broadcast first: the default) */
export const BUILT_IN_HUD_LAYOUTS = [
  { id: "broadcast", get label() { return t("game.hudLayouts.broadcast"); }, get detail() { return t("game.hudLayouts.broadcastDetail"); } },
  { id: "dash", get label() { return t("game.hudLayouts.dash"); }, get detail() { return t("game.hudLayouts.dashDetail"); } },
  { id: "telemetry", get label() { return t("game.hudLayouts.telemetry"); }, get detail() { return t("game.hudLayouts.telemetryDetail"); } },
  { id: "classic", get label() { return t("game.hudLayouts.classic"); }, get detail() { return t("game.hudLayouts.classicDetail"); } },
  { id: "minimal", get label() { return t("game.hudLayouts.minimal"); }, get detail() { return t("game.hudLayouts.minimalDetail"); } },
  // Laid out the way a road-racing game and a Formula game lay out their race screens, drawn in the game's own look
  { id: "touring", get label() { return t("game.hudLayouts.touring"); }, get detail() { return t("game.hudLayouts.touringDetail"); } },
  { id: "formula", get label() { return t("game.hudLayouts.formula"); }, get detail() { return t("game.hudLayouts.formulaDetail"); } },
] as const satisfies readonly HudLayoutInfo[];

/** Layouts recreated from other open-source HUD projects, credited to their authors */
export const THIRD_PARTY_HUD_LAYOUTS = [
  {
    id: "irdashies",
    label: "irDashies",
    get detail() { return t("game.hudLayouts.irdashiesDetail"); },
    credit: { author: "tariknz", repoUrl: "https://github.com/tariknz/irdashies", license: "MIT" },
  },
  {
    id: "racevision",
    label: "RaceVision",
    get detail() { return t("game.hudLayouts.racevisionDetail"); },
    credit: { author: "mpavich2", repoUrl: "https://github.com/mpavich2/RaceVision", license: "MIT" },
  },
  {
    id: "h2h",
    label: "Head to Head",
    get detail() { return t("game.hudLayouts.h2hDetail"); },
    credit: { author: "emilioSp", repoUrl: "https://github.com/emilioSp/h2h-iracing", license: "MIT" },
  },
  {
    id: "retro",
    label: "Retro UI",
    get detail() { return t("game.hudLayouts.retroDetail"); },
    credit: { author: "toastbuilds", repoUrl: "https://github.com/toastbuilds/assetto-corsa-retro-engineering-hud", license: "MIT" },
  },
  {
    id: "blocks",
    label: "Blocks",
    get detail() { return t("game.hudLayouts.blocksDetail"); },
    credit: { author: "C1XTZ", repoUrl: "https://github.com/C1XTZ/ac-rennsporthud", license: "GPL-3.0" },
  },
  {
    id: "grand-prix",
    label: "Grand Prix",
    get detail() { return t("game.hudLayouts.grandPrixDetail"); },
    credit: {
      author: "adamikoo",
      repoUrl: "https://github.com/adamikoo",
      license: "MIT",
      site: { name: "AvgSpots", url: "https://avgspots.com" },
    },
  },
] as const satisfies readonly HudLayoutInfo[];

export type HudPreset = (typeof BUILT_IN_HUD_LAYOUTS)[number]["id"] | (typeof THIRD_PARTY_HUD_LAYOUTS)[number]["id"];

/** Every layout: the game's own first, then the credited third-party ones */
export const HUD_LAYOUTS: readonly HudLayoutInfo<HudPreset>[] = [...BUILT_IN_HUD_LAYOUTS, ...THIRD_PARTY_HUD_LAYOUTS];

export const HUD_PRESETS: readonly HudPreset[] = HUD_LAYOUTS.map((l) => l.id);

/** The layout a new player starts on, and the one a save falls back to */
export const DEFAULT_HUD_PRESET: HudPreset = "broadcast";

/** A layout's entry; an id this build doesn't know gets the default's */
export function hudLayout(id: string): HudLayoutInfo<HudPreset> {
  return HUD_LAYOUTS.find((l) => l.id === id) ?? HUD_LAYOUTS.find((l) => l.id === DEFAULT_HUD_PRESET)!;
}

/**
 * Whether the HUD draws the Phone HUD instead of the chosen layout. A phone-sized screen always does. With the touch
 * controls up (their pads take both bottom corners and the top-left), the game's own layouts give way to it at any
 * size, while a third-party layout keeps its look on a tablet and steps out of the pads' way itself.
 */
export function showsPhoneHud(preset: HudPreset, screen: { phone: boolean; touchControls: boolean }): boolean {
  return screen.phone || (screen.touchControls && !hudLayout(preset).credit);
}

/** A layout id this build has */
export const isHudPreset = (value: unknown): value is HudPreset => HUD_PRESETS.includes(value as HudPreset);

/**
 * A saved layout id as this build reads it: a known id is kept, "engineer" (renamed) moves to Telemetry, and
 * anything else (an older or newer build's layout, a hand-edited save) falls back to Broadcast
 */
export function parseHudPreset(value: unknown): HudPreset {
  if (value === "engineer") return "telemetry";
  return isHudPreset(value) ? value : DEFAULT_HUD_PRESET;
}
