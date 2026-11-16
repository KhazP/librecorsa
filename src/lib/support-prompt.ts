import type { SupportLink } from "@/lib/modder-support";

/**
 * The note after a drive: back on the main menu after driving a modder's circuit or car, a small note names who made
 * them and offers their donation link. A gentle nudge, never a nag:
 *  - only after a real drive (MIN_DRIVE_MS on that circuit and car), and only for makers who take donations;
 *  - once per circuit and once per car, ever: shown counts as seen, closing it too;
 *  - at most once a week, whatever was driven;
 *  - never again for a maker the player pressed the donate button for.
 * A drive with nothing left to say spends nothing: the week's chance waits for one that has. The rules take their
 * storage and clock as arguments (scripts/verify-support-prompt.ts runs them on a Map).
 */

export const SUPPORT_PROMPT_KEY = "librecorsa.supportPrompt";
/** The shortest drive the note follows */
export const MIN_DRIVE_MS = 2 * 60 * 1000;
/** The least time between two notes */
export const PROMPT_GAP_MS = 7 * 24 * 3600 * 1000;

export interface PromptItem {
  /** "circuit:<venue>" or "car:<id>": what has been seen */
  key: string;
  kind: "circuit" | "car";
  /** "Circuit de Monaco", "Suzuki Liana 1.6" */
  title: string;
  maker: string;
  /** "Model", "Physics" (a car's credit's own word); "Circuit" */
  role: string;
  support: SupportLink;
}

export interface PromptState {
  lastShownAt: number | null;
  seen: string[];
  /** Makers whose donate button was pressed */
  thanked: string[];
}

export interface PromptStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EMPTY: PromptState = { lastShownAt: null, seen: [], thanked: [] };

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function readPromptState(store: PromptStore | null): PromptState {
  try {
    const raw = store?.getItem(SUPPORT_PROMPT_KEY);
    if (!raw) return EMPTY;
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastShownAt: typeof v.lastShownAt === "number" && Number.isFinite(v.lastShownAt) ? v.lastShownAt : null,
      seen: strings(v.seen),
      thanked: strings(v.thanked),
    };
  } catch {
    return EMPTY;
  }
}

export function writePromptState(store: PromptStore | null, state: PromptState): void {
  try {
    store?.setItem(SUPPORT_PROMPT_KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked: the note may come again next week, which is no harm
  }
}

/**
 * What a note after this drive would name: the drive's circuit and car whose makers take donations, not seen, not
 * thanked. Null: no note (a short drive, inside the week, or nothing left to name).
 */
export function promptFor(candidates: readonly PromptItem[], driveMs: number, state: PromptState, now: number): PromptItem[] | null {
  if (driveMs < MIN_DRIVE_MS) return null;
  if (state.lastShownAt !== null && now - state.lastShownAt < PROMPT_GAP_MS) return null;
  const items = candidates.filter((c) => !state.seen.includes(c.key) && !state.thanked.includes(c.maker));
  return items.length ? items : null;
}

/** The note was shown: its circuit and car are seen, and the week starts */
export const markShown = (state: PromptState, items: readonly PromptItem[], now: number): PromptState => ({
  ...state,
  lastShownAt: now,
  seen: [...new Set([...state.seen, ...items.map((i) => i.key)])],
});

/** The donate button was pressed: that maker is never named again */
export const markThanked = (state: PromptState, maker: string): PromptState => ({
  ...state,
  thanked: state.thanked.includes(maker) ? state.thanked : [...state.thanked, maker],
});
