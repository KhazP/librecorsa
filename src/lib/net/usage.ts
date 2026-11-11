/**
 * The anonymous usage counter: when a stretch of driving ends, one line (circuit, car, mode, minutes) goes to the
 * online side (POST <api>/usage, cloudflare/api/usage.ts), which only adds it to the day's totals. No player id, no
 * cookie, nothing kept in the browser that ties one stretch to another.
 */

/** What kind of driving a stretch was */
export const USAGE_MODES = ["practice", "time_trial", "ai_race", "open_race", "room_race"] as const;
export type UsageMode = (typeof USAGE_MODES)[number];

export const isUsageMode = (value: unknown): value is UsageMode => typeof value === "string" && (USAGE_MODES as readonly string[]).includes(value);

/** Stretches shorter than this are not reported (half a minute) */
export const MIN_USAGE_MINUTES = 0.5;
/** One report counts at most this long */
export const MAX_USAGE_MINUTES = 240;
