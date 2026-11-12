/**
 * The anonymous usage counter: when a stretch of driving ends, one line (circuit, car, mode, minutes, and what it was
 * driven with: input, kind of screen, weather, assists, build) goes to the online side (POST <api>/usage, cloudflare/api/usage.ts), which only adds it to the day's totals. No player id, no
 * cookie, nothing kept in the browser that ties one stretch to another.
 */
import type { VehicleModelId } from "../../types/f1";
import { onlineUrl } from "./online-config";
import { MAX_USAGE_MINUTES, MIN_USAGE_MINUTES, type UsageExtras, type UsageMode } from "./usage-modes";

export { isUsageMode, MAX_USAGE_MINUTES, MIN_USAGE_MINUTES, USAGE_EXTRAS, USAGE_MODES, type UsageExtras, type UsageMode } from "./usage-modes";

/** One stretch of driving: where, in what, how */
export interface UsageStretch {
  trackId: string;
  vehicle: VehicleModelId;
  mode: UsageMode;
}
/** The line sent when a stretch ends; the extras (input, device, weather, assists, build) are as they were at its end */
export type UsageLine = UsageStretch & { minutes: number } & UsageExtras;

/**
 * Times stretches of driving. `set` says what is driven now (null: nothing) and whether the clock runs (not while
 * paused); a change of circuit, car, mode or `part` ends the stretch, and one of half a minute or more is reported.
 */
export class UsageClock {
  private current: { key: string; stretch: UsageStretch; ms: number; since: number | null } | null = null;

  constructor(
    private readonly report: (line: UsageLine) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  set(stretch: UsageStretch | null, running: boolean, part = ""): void {
    const key = stretch ? `${stretch.trackId}|${stretch.vehicle}|${stretch.mode}|${part}` : null;
    if (this.current && this.current.key !== key) this.end();
    if (!stretch || key === null) return;
    const t = this.now();
    this.current ??= { key, stretch, ms: 0, since: null };
    if (running && this.current.since === null) this.current.since = t;
    if (!running && this.current.since !== null) {
      this.current.ms += t - this.current.since;
      this.current.since = null;
    }
  }

  /** Ends the stretch under way, reporting it when long enough */
  end(): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    const minutes = Math.min((c.ms + (c.since !== null ? this.now() - c.since : 0)) / 60_000, MAX_USAGE_MINUTES);
    if (minutes >= MIN_USAGE_MINUTES) this.report({ ...c.stretch, minutes: Math.round(minutes * 10) / 10 });
  }
}

/**
 * Sends one line in a request that outlives the page (a stretch often ends as it closes): no cookies, a plain-text
 * body so the browser needs no preflight, and nothing kept here.
 */
export function sendUsage(line: UsageLine, url = onlineUrl("/usage")): void {
  if (!url) return;
  const body = JSON.stringify(line);
  try {
    void fetch(url, { method: "POST", body, keepalive: true, credentials: "omit", cache: "no-store" }).catch(() => {});
  } catch {
    // No fetch with keepalive here: a beacon also survives the page closing
    try {
      navigator.sendBeacon?.(url, body);
    } catch {
      // Not counted, and nothing to tell the player
    }
  }
}
