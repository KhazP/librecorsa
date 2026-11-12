/**
 * What a usage report may say, shared by the game (usage.ts) and the Worker (cloudflare/api/usage.ts). No imports, so
 * the Worker takes nothing of the browser side with it.
 */

/** What kind of driving a stretch was */
export const USAGE_MODES = ["practice", "time_trial", "ai_race", "open_race", "room_race"] as const;
export type UsageMode = (typeof USAGE_MODES)[number];

export const isUsageMode = (value: unknown): value is UsageMode => typeof value === "string" && (USAGE_MODES as readonly string[]).includes(value);

/** Stretches shorter than this are not reported (half a minute) */
export const MIN_USAGE_MINUTES = 0.5;
/** One report counts at most this long */
export const MAX_USAGE_MINUTES = 240;

/**
 * Extra fields a report may carry, each optional (older builds send none). Each one is added up on its own, per day:
 * never crossed with the circuit, the country or another extra, so together they can't single a player out.
 */
export const USAGE_EXTRAS = {
  /** What the car is driven with: the input setting, or touch when the on-screen controls drive a keyboard setting */
  input: ["keyboard", "controller", "wheel", "touch"],
  /** The kind of screen: a fine pointer is a desktop; a coarse one a phone or a tablet by its short side */
  device: ["desktop", "tablet", "phone"],
  /** Water on the racing line when the stretch ended */
  weather: ["dry", "wet"],
  /** The assist preset */
  assists: ["pro", "semi_pro", "assisted"],
} as const;
export type UsageExtraName = keyof typeof USAGE_EXTRAS | "build";
export type UsageExtras = { [K in keyof typeof USAGE_EXTRAS]?: (typeof USAGE_EXTRAS)[K][number] } & {
  /** The deployed build: the first seven hex digits of its commit */
  build?: string;
};

export const USAGE_BUILD_RE = /^[0-9a-f]{7}$/;

/** The extras of a report that are allowed values; anything else is left out, the rest of the report still counts */
export function usageExtrasOf(raw: Record<string, unknown>): UsageExtras {
  const out: Record<string, string> = {};
  for (const [name, allowed] of Object.entries(USAGE_EXTRAS)) {
    const value = raw[name];
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) out[name] = value;
  }
  if (typeof raw.build === "string" && USAGE_BUILD_RE.test(raw.build)) out.build = raw.build;
  return out as UsageExtras;
}
