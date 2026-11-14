import type { CarTelemetry, RaceStatus, TireCompound } from "@/types/f1";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { formatDelta as kitFormatDelta } from "@/components/ui/badges/DeltaBadge";
import { tokenColor, type ColorToken } from "@/components/ui/token-color";
import { currentUnits } from "@/lib/settings/ui-prefs";
import type { UnitSettings } from "@/lib/settings/player-settings";
import {
  PRESSURE_LABEL,
  SPEED_LABEL,
  TEMPERATURE_LABEL,
  pressureDecimals,
  pressureIn,
  speedIn,
  temperatureDeltaIn,
  temperatureIn,
} from "@/lib/settings/units";

/**
 * Shared formatting and colour rules of the in-race HUD. Colours are CSS variables, so they work in `style` and in
 * SVG attributes and follow the colour-blind palette (palette.css); canvas drawing uses `tokenColor()` instead.
 * A colour that says how something is going (gain, loss, best, caution, cold / ideal / hot) takes a semantic one;
 * the raw hues are for identity (a compound, a flag, a rev light band, the player's volt).
 */

/* Raw hues: identity, not state */
export const HUD_VOLT = "var(--color-lc-volt)";
export const HUD_RED = "var(--color-lc-crimson)";
export const HUD_GREEN = "var(--color-lc-green)";
export const HUD_PURPLE = "var(--color-lc-purple)";
export const HUD_YELLOW = "var(--color-lc-amber)";
export const HUD_CYAN = "var(--color-lc-cyan)";
/** The road-car class colour (`CLASS_COLORS`) */
export const HUD_ROAD = "var(--color-lc-amber)";
/** The prototype class colour (`CLASS_COLORS`) */
export const HUD_PROTO = "var(--color-lc-purple)";
export const HUD_VOID = "var(--color-lc-void)";
export const HUD_CARBON = "var(--color-lc-carbon)";
export const HUD_TITANIUM = "var(--color-lc-titanium)";
export const HUD_BORDER = "var(--color-lc-line)";
export const HUD_SLATE = "var(--color-lc-slate)";
export const HUD_WHITE = "var(--color-lc-chalk)";
/** Sector 3 on the circuit map (sector 1 cyan, sector 2 volt) */
export const HUD_PINK = "var(--color-lc-pink)";
/** The shift point: every style lights its rev lights and gear this colour from `atShiftPoint` (the SHIFT badge too) */
export const HUD_SHIFT = "var(--color-lc-cyan)";

/* Semantic: what the colour means (palette.css swaps these for colour-blind players) */
export const HUD_GAIN = "var(--color-lc-gain)";
export const HUD_LOSS = "var(--color-lc-loss)";
export const HUD_BEST = "var(--color-lc-best)";
export const HUD_CAUTION = "var(--color-lc-caution)";
export const HUD_INFO = "var(--color-lc-info)";
export const HUD_COLD = "var(--color-lc-cold)";
export const HUD_IDEAL = "var(--color-lc-ideal)";
export const HUD_HOT = "var(--color-lc-hot)";
export const HUD_THROTTLE = "var(--lc-sem-throttle)";
export const HUD_BRAKE = "var(--lc-sem-brake)";

/** HUD glass (UI standard §3): void at 74 %, a white/7 hairline, blur 14; each panel adds its radius and padding */
export const HUD_GLASS = "border border-white/7 bg-lc-void/74 shadow-lc-pop backdrop-blur-[14px]";
/** Inset well inside a HUD sheet (tyre cards, light pods, elevation box) */
export const HUD_WELL = "border border-lc-titanium bg-lc-well";
/** The HUD's field label (`lc-hud-lbl`: mono 700, 9 px, 0.18em, caps, slate) */
export const HUD_LBL = "lc-hud-lbl";

/** m:ss.mmm (h:mm:ss.mmm from an hour on), or dashes when there is no time yet (or it is not a finite number) */
export function formatLapTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "-:--.---";
  const whole = Math.floor(ms);
  const totalSec = Math.floor(whole / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const hours = Math.floor(totalMin / 60);
  const secs = totalSec % 60;
  const millis = whole % 1000;
  const rest = `${secs.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
  return hours > 0 ? `${hours}:${(totalMin % 60).toString().padStart(2, "0")}:${rest}` : `${totalMin}:${rest}`;
}

/** ss.mmm for sector times */
export function formatSectorTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "--.---";
  return (ms / 1000).toFixed(3);
}

/** The placeholder of a time that does not exist yet (no reference lap, no gap) */
export const NO_TIME = "--.---";

/** Signed delta in seconds, the kit's one spelling: "−0.234" / "+1.020" / "±0.000" */
export function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return NO_TIME;
  return kitFormatDelta(seconds);
}

/**
 * A gap between two cars in seconds, one rule for the tower, the MFD tables and the dash: one decimal, or three
 * (`precise`) under ten seconds where a tenth hides the fight; 99+ past a hundred. No sign: the column says which way.
 */
export function formatGap(seconds: number, precise = false): string {
  const s = Math.abs(seconds);
  if (!Number.isFinite(s)) return NO_TIME;
  if (s >= 100) return "99+";
  return s.toFixed(precise && s < 10 ? 3 : 1);
}

/* Units: every speed, temperature and pressure the HUD prints goes through these (stored values stay metric) */

/** A speed in km/h as a whole number in the player's unit */
export const formatSpeed = (kmh: number, u: UnitSettings = currentUnits()): string => String(Math.round(speedIn(kmh, u.speed)));
/** "km/h" or "mph" */
export const speedUnit = (u: UnitSettings = currentUnits()): string => SPEED_LABEL[u.speed];
/** A temperature in °C as "92°", or "92°C" / "198°F" with `unit` */
export const formatTemp = (celsius: number, u: UnitSettings = currentUnits(), unit = false): string =>
  `${Math.round(temperatureIn(celsius, u.temperature))}${unit ? TEMPERATURE_LABEL[u.temperature] : "°"}`;
/** A temperature difference in °C, signed ("+4°") */
export const formatTempDelta = (celsius: number, u: UnitSettings = currentUnits()): string => {
  const v = Math.round(temperatureDeltaIn(celsius, u.temperature));
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}°`;
};
const PSI_PER_BAR = 14.5037738;
/** A tyre pressure from the telemetry (psi gauge) in the player's unit, without the unit */
export const formatPressurePsi = (psi: number, u: UnitSettings = currentUnits()): string =>
  pressureIn(psi / PSI_PER_BAR, u.pressure).toFixed(pressureDecimals(u.pressure));
/** A pressure difference (psi) in the player's unit, signed */
export const formatPressureDeltaPsi = (psi: number, u: UnitSettings = currentUnits()): string => {
  const text = Math.abs(pressureIn(psi / PSI_PER_BAR, u.pressure)).toFixed(pressureDecimals(u.pressure));
  if (Number(text) === 0) return text;
  return `${psi > 0 ? "+" : "−"}${text}`;
};
/** "bar" or "psi" */
export const pressureUnit = (u: UnitSettings = currentUnits()): string => PRESSURE_LABEL[u.pressure];

/**
 * How a completed sector (or lap) went: `best` the session's best (purple), `pb` a personal best that is not the
 * session's (green), `slower` (amber). On your own the session is yours, so a personal best is the session best;
 * in a race nobody else's sector times are known, so a sector at your best is a personal best.
 */
export type LapMark = "best" | "pb" | "slower";

export function lapMark(ms: number, best: number | null | undefined, solo = true): LapMark {
  if (best && ms > best + 0.5) return "slower";
  return solo ? "best" : "pb";
}

/** The colour of each `LapMark` */
export const LAP_MARK_COLOR: Record<LapMark, string> = { best: HUD_BEST, pb: HUD_GAIN, slower: HUD_CAUTION };
/** The word of each `LapMark`, for the spoken name and the tooltip */
export const LAP_MARK_WORD: Record<LapMark, string> = { best: "Best", pb: "Personal best", slower: "Slower" };

/** Colour of a completed sector (or lap) time against the best (see `lapMark`) */
export function sectorTimeColor(ms: number, best: number | null | undefined, solo = true): string {
  return LAP_MARK_COLOR[lapMark(ms, best, solo)];
}

export { revRangeFor } from "@/lib/sim/rev-range";

/** At or past the shift point (the top of `revRangeFor`): every style lights its rev lights and gear from here */
export const atShiftPoint = (rpm: number, revFull: number): boolean => rpm >= revFull;

/**
 * Driver aids intervening right now, one reading for every panel: the live tuner cutting more than 2 % of the pedal,
 * or the car's own aid flag (the 6-DOF car reports both, and they agree)
 */
export function aidsActive(t: Pick<CarTelemetry, "liveTuner" | "f12026">): { tc: boolean; abs: boolean } {
  const tuner = t.liveTuner;
  return {
    tc: (tuner?.tcCutFraction ?? 0) > 0.02 || Boolean(t.f12026?.tcActive),
    abs: (tuner?.absCutPerWheel ?? []).some((c) => c > 0.02) || Boolean(t.f12026?.absActive),
  };
}

/**
 * Where a race stands, one reading for every panel:
 * - `finished`: the player has taken the chequered flag (phase "finished"). The start lights' flag banner and the
 *   fuel-to-the-flag maths follow this: the player's own race is over, even while others are still running.
 * - `classified`: the classification is out (results present, provisional until `resultsFinal`). The results card
 *   follows this, since it needs the rows to show.
 */
export function raceState(race: RaceStatus | undefined): { finished: boolean; classified: boolean } {
  return { finished: race?.phase === "finished", classified: Boolean(race?.results) };
}

/** A tyre condition (graining, blistering, flat spot, dirt) is flagged on the HUD from this level (0..1) */
export const TYRE_CONDITION_SHOW = 0.12;

/** Tyre compound colours (the kit's one compound table, `COMPOUNDS`), for the parts that are not a `CompoundGlyph` */
export const COMPOUND_COLORS: Record<TireCompound, string> = {
  soft: `var(--color-lc-${COMPOUNDS.soft.color})`,
  medium: `var(--color-lc-${COMPOUNDS.medium.color})`,
  hard: `var(--color-lc-${COMPOUNDS.hard.color})`,
  intermediate: `var(--color-lc-${COMPOUNDS.intermediate.color})`,
  wet: `var(--color-lc-${COMPOUNDS.wet.color})`,
};

type Rgb = [number, number, number];
const rgbCache = new Map<string, Rgb>();
/** A token as RGB, read where it is drawn so the palette is followed (tokenColor is cached; so is the parse) */
const rgbOf = (token: ColorToken): Rgb => {
  const hex = tokenColor(token);
  let rgb = rgbCache.get(hex);
  if (!rgb) {
    const n = Number.parseInt(hex.slice(1), 16);
    rgb = [n >> 16, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, rgb);
  }
  return rgb;
};
const scaleRgb = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];
const mixRgb = (a: Rgb, b: Rgb, u: number) => {
  const k = Math.max(0, Math.min(1, u));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)}, ${Math.round(a[1] + (b[1] - a[1]) * k)}, ${Math.round(a[2] + (b[2] - a[2]) * k)})`;
};

/**
 * Continuous tread colour against the compound's working window: cold well below it, blending to ideal across the
 * last 25 °C, ideal inside it, caution 10 °C over and hot 20 °C over (85–105 °C → hot past 115 °C by default).
 * The semantic cold / ideal / caution / hot tokens, so the colour-blind palette applies.
 */
export function tyreHeatColor(tempC: number, window: readonly [number, number] = [85, 105]): string {
  const [lo, hi] = window;
  const cold = rgbOf("cold");
  const ideal = rgbOf("ideal");
  if (tempC < lo - 25) return mixRgb(scaleRgb(cold, 0.55), cold, (tempC - (lo - 45)) / 20);
  if (tempC < lo) return mixRgb(cold, ideal, (tempC - (lo - 25)) / 25);
  if (tempC <= hi) return mixRgb(ideal, ideal, 0);
  const caution = rgbOf("caution");
  if (tempC <= hi + 10) return mixRgb(ideal, caution, (tempC - hi) / 10);
  return mixRgb(caution, rgbOf("hot"), (tempC - hi - 10) / 10);
}

/** Brake disc temperature: dim cold below 200 °C, cold to ideal up to 450, ideal to 850, then on to hot */
export function brakeGlowColor(tempC: number): string {
  const cold = rgbOf("cold");
  const ideal = rgbOf("ideal");
  if (tempC < 200) return mixRgb(scaleRgb(cold, 0.3), scaleRgb(cold, 0.6), tempC / 200);
  if (tempC < 450) return mixRgb(scaleRgb(cold, 0.6), ideal, (tempC - 200) / 250);
  if (tempC < 850) return mixRgb(ideal, ideal, 0);
  return mixRgb(ideal, rgbOf("hot"), (tempC - 850) / 150);
}
