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
