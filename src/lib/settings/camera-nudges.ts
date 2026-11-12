/**
 * The player's own seat: how far the cockpit and dash views sit from where the car puts them, and how much wider or
 * narrower they look, per car (keyed by car id) and per view. Saved with the settings; a car or view without one is
 * where the car puts it, at the car's field of view (shifted by the base FOV every car shares).
 */

/** The views the player can move */
export type NudgeView = "cockpit" | "dash";

export const NUDGE_VIEWS: readonly NudgeView[] = ["cockpit", "dash"];

export const isNudgeView = (value: unknown): value is NudgeView => value === "cockpit" || value === "dash";

/** Metres along the car (forward), up, and to the driver's right; degrees of tilt (+ looks up) and of vertical FOV */
export interface CameraNudge {
  fwd: number;
  up: number;
  right: number;
  tiltDeg: number;
  fovDeg: number;
}

export type CameraNudges = Readonly<Record<string, Partial<Record<NudgeView, CameraNudge>>>>;

export const NUDGE_LIMIT_M = 0.3;
export const NUDGE_TILT_LIMIT_DEG = 20;
export const NUDGE_FOV_LIMIT_DEG = 30;
/** One press: a centimetre, half a degree of tilt, a degree of FOV */
export const NUDGE_STEP_M = 0.01;
export const NUDGE_TILT_STEP_DEG = 0.5;
export const NUDGE_FOV_STEP_DEG = 1;

export const NO_NUDGE: CameraNudge = { fwd: 0, up: 0, right: 0, tiltDeg: 0, fovDeg: 0 };
const ZERO = NO_NUDGE;

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
/** Millimetres and tenths of a degree, so repeated steps don't gather float noise */
const roundM = (v: number) => Math.round(v * 1000) / 1000;
const roundDeg = (v: number) => Math.round(v * 10) / 10;

export const isZeroNudge = (n: CameraNudge) => n.fwd === 0 && n.up === 0 && n.right === 0 && n.tiltDeg === 0 && n.fovDeg === 0;
const isZero = isZeroNudge;

function parseNudge(raw: unknown): CameraNudge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, limit: number, round: (v: number) => number) =>
    typeof v === "number" && Number.isFinite(v) ? round(clamp(v, limit)) : 0;
  const n: CameraNudge = {
    fwd: num(r.fwd, NUDGE_LIMIT_M, roundM),
    up: num(r.up, NUDGE_LIMIT_M, roundM),
    right: num(r.right, NUDGE_LIMIT_M, roundM),
    tiltDeg: num(r.tiltDeg, NUDGE_TILT_LIMIT_DEG, roundDeg),
    fovDeg: num(r.fovDeg, NUDGE_FOV_LIMIT_DEG, roundDeg),
  };
  return isZero(n) ? null : n;
}

/** A save's nudges, clamped; anything malformed is dropped */
export function parseCameraNudges(raw: unknown): CameraNudges {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, Partial<Record<NudgeView, CameraNudge>>> = {};
  for (const [car, views] of Object.entries(raw as Record<string, unknown>)) {
    if (!views || typeof views !== "object") continue;
    const kept: Partial<Record<NudgeView, CameraNudge>> = {};
    for (const view of NUDGE_VIEWS) {
      const n = parseNudge((views as Record<string, unknown>)[view]);
      if (n) kept[view] = n;
    }
    if (Object.keys(kept).length) out[car] = kept;
  }
  return out;
}

export function nudgeOf(nudges: CameraNudges | undefined, car: string, view: NudgeView): CameraNudge {
  return nudges?.[car]?.[view] ?? ZERO;
}

/** `nudges` with one view of one car moved by `step` (null: put back where the car puts it) */
export function stepNudge(
  nudges: CameraNudges | undefined,
  car: string,
  view: NudgeView,
  step: Partial<CameraNudge> | null
): CameraNudges {
  const was = nudgeOf(nudges, car, view);
  const next: CameraNudge = step
    ? {
        fwd: roundM(clamp(was.fwd + (step.fwd ?? 0), NUDGE_LIMIT_M)),
        up: roundM(clamp(was.up + (step.up ?? 0), NUDGE_LIMIT_M)),
        right: roundM(clamp(was.right + (step.right ?? 0), NUDGE_LIMIT_M)),
        tiltDeg: roundDeg(clamp(was.tiltDeg + (step.tiltDeg ?? 0), NUDGE_TILT_LIMIT_DEG)),
        fovDeg: roundDeg(clamp(was.fovDeg + (step.fovDeg ?? 0), NUDGE_FOV_LIMIT_DEG)),
      }
    : ZERO;
  const views: Partial<Record<NudgeView, CameraNudge>> = { ...(nudges?.[car] ?? {}) };
  if (isZero(next)) delete views[view];
  else views[view] = next;
  const out: Record<string, Partial<Record<NudgeView, CameraNudge>>> = { ...(nudges ?? {}) };
  if (Object.keys(views).length) out[car] = views;
  else delete out[car];
  return out;
}

/** The step a key moves the camera with Alt held (arrows, − / =, Page Up / Down, [ / ]); null for Alt+0's reset */
export function nudgeStepForKey(code: string): Partial<CameraNudge> | null | undefined {
  switch (code) {
    case "ArrowUp":
      return { fwd: NUDGE_STEP_M };
    case "ArrowDown":
      return { fwd: -NUDGE_STEP_M };
    case "ArrowRight":
      return { right: NUDGE_STEP_M };
    case "ArrowLeft":
      return { right: -NUDGE_STEP_M };
    case "Equal":
    case "NumpadAdd":
    case "PageUp":
      return { up: NUDGE_STEP_M };
    case "Minus":
    case "NumpadSubtract":
    case "PageDown":
      return { up: -NUDGE_STEP_M };
    case "BracketRight":
      return { tiltDeg: NUDGE_TILT_STEP_DEG };
    case "BracketLeft":
      return { tiltDeg: -NUDGE_TILT_STEP_DEG };
    case "Digit0":
    case "Numpad0":
      return null;
    default:
      return undefined;
  }
}

const SEAT_HINT_KEY = "lc.seatHintCars";

function seatHintCars(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SEAT_HINT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** Whether the launch hint has already named the seat panel in this car (it does so on a car's first drive only) */
export function seatHintSeen(car: string): boolean {
  if (typeof window === "undefined") return true;
  return seatHintCars().includes(car);
}

export function markSeatHintSeen(car: string): void {
  try {
    const cars = seatHintCars();
    if (!cars.includes(car)) window.localStorage.setItem(SEAT_HINT_KEY, JSON.stringify([...cars, car]));
  } catch {
    // Storage blocked: the hint comes back next drive
  }
}
