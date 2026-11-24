/**
 * The interface settings: units, scale, palette, settings detail and language. Apart from player-settings.ts (which
 * re-exports all of this) so the language provider every page mounts (src/i18n/I18nProvider.tsx) reads them without
 * the rest of the game's settings and what those import.
 */

/** Where the player's settings are kept (player-settings.ts reads and writes the whole record) */
export const SETTINGS_STORAGE_KEY = "bugesera.settings.v1";

export type SpeedUnit = "kmh" | "mph";
export type TemperatureUnit = "c" | "f";
export type PressureUnit = "bar" | "psi";

export interface UnitSettings {
  speed: SpeedUnit;
  temperature: TemperatureUnit;
  pressure: PressureUnit;
}

/**
 * Which colours carry gain / loss, cold / hot and the like. "standard" is the palette of docs/DESIGN.md; the others
 * swap the pairs that the named colour-vision type confuses. The volt cursor never changes.
 */
export type ColorPalette = "standard" | "protan" | "deutan" | "tritan";
export const COLOR_PALETTES: readonly ColorPalette[] = ["standard", "protan", "deutan", "tritan"];

/** Simple shows the short list of settings; Advanced shows every row */
export type SettingsDetail = "simple" | "advanced";

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.5;

export interface InterfaceSettings {
  units: UnitSettings;
  /** Multiplies the automatic big-screen scale (src/lib/ui-zoom.ts); 1 = as the screen size decides */
  scale: number;
  palette: ColorPalette;
  detail: SettingsDetail;
  /** The language the game shows: "auto" follows the browser, else a language code (src/i18n/catalogs.ts) */
  language: string;
}

export const DEFAULT_INTERFACE_SETTINGS: InterfaceSettings = {
  units: { speed: "kmh", temperature: "c", pressure: "bar" },
  scale: 1,
  palette: "standard",
  detail: "simple",
  language: "auto",
};

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const num = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

export function parseInterface(v: unknown): InterfaceSettings {
  const d = DEFAULT_INTERFACE_SETTINGS;
  if (!isObj(v)) return structuredClone(d);
  const units = isObj(v.units) ? v.units : {};
  return {
    units: {
      speed: oneOf(units.speed, ["kmh", "mph"] as const, d.units.speed),
      temperature: oneOf(units.temperature, ["c", "f"] as const, d.units.temperature),
      pressure: oneOf(units.pressure, ["bar", "psi"] as const, d.units.pressure),
    },
    scale: num(v.scale, UI_SCALE_MIN, UI_SCALE_MAX, d.scale),
    palette: oneOf(v.palette, COLOR_PALETTES, d.palette),
    detail: oneOf(v.detail, ["simple", "advanced"] as const, d.detail),
    // Any well-formed code is kept: a language added later, or one a newer build has, still resolves (resolveLocale)
    language: isStr(v.language) && (v.language === "auto" || /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(v.language)) ? v.language : d.language,
  };
}
