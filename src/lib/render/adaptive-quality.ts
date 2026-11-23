/**
 * Automatic quality (Settings > Display > Graphics): when the frames stay slow while driving, the graphics step down,
 * one knob at a time, on top of what the player chose. A phone that heats up after a few minutes (the iPhone 11 report:
 * smooth, then stuttering after 4-5 minutes) slows its chip down; this gives the frames back their time.
 *
 * Nothing here touches the simulation: only the renderer's settings change, so physics timing, lap validity and the
 * online sync are as they were. The saved settings are never written either: the steps are an overlay, gone when the
 * player picks other graphics or the session ends.
 *
 * The ladder, cheapest to see first, each rung chosen from the costs measured on 14 Nov 2026 (Medium on an M4 Max
 * emulating a phone): sun shadows 2.6-5 ms, MSAA 2.3-4.9 ms, the reflection probe's prefilter dropping a frame every
 * few frames. None of the rungs recompiles a shader (switching the shadows off would, for every lit material, so the
 * ladder stops short of it): a step costs at most a frame or two.
 *  1-2. Render resolution 85 %, then 70 % of the player's (pixels: -28 %, -51 %), never under the player's Lowest
 *       resolution (see `scaled` below)
 *  3.   Live car reflections off (the cars keep the sky's; the probe's spike frames go)
 *  4.   MSAA and bloom off
 *  5.   Sun shadow maps at half resolution per side (a quarter of the texels; the shadows stay)
 *  6.   Sharp Low off (Low's 1x pixel-ratio cap again), when the Lowest resolution allows it
 * A rung that would change nothing for the chosen preset (Low has no reflections or MSAA), or that the Lowest
 * resolution rules out, is not on its ladder: the governor's "floor" (every rung on) is then reached sooner.
 *
 * When: once a second the frames drawn in that second are judged against the frame budget (16.7 ms, or 33.3 ms with
 * the 30 fps cap, or the screen's own rate when the system holds it lower). A second is slow when its 90th percentile
 * is over 1.3 x the budget: on a 60 Hz screen, where a late frame waits for the next vsync, that is more than one frame
 * in ten missing its vsync (the stutter players see), while one hitch a second (a garbage collection) is not. Not 1.25:
 * under the 30 fps cap a 120 Hz screen puts a frame that is one of its vsyncs late at 41.7 ms, exactly 1.25 x 33.3. An
 * 8 ms slip barely shows, and in a throttled headless run all five steps for it bought 29 fps against 27.5. Three slow
 * seconds in a row step down once. Nothing is judged in the first 20 s on track (shader and texture warm-up), for 5 s
 * after a step (it may hitch itself) or 3 s after a pause, a menu, a hidden tab or a replay.
 *
 * Hysteresis: within a session the steps only go down, never back up on their own, races or not. A phone that
 * cooled while running lighter would heat up again at full quality and stutter again: a step back up every few
 * minutes is exactly the oscillation to avoid, and a mid-race change of look is a distraction. The next session (a new
 * circuit, a reload) starts on the player's own settings again, or one rung better than the last one ended when
 * that was less than 10 minutes ago (the phone is likely still warm). Changing the graphics by hand starts over too.
 */

export type GraphicsQuality = "low" | "medium" | "high";

/** How the renderer is set up: the preset, and the knobs the step-down turns down on top of it */
export interface RenderPlan {
  quality: GraphicsQuality;
  /** Multiplies the device pixel ratio after the preset's own cap */
  renderScale: number;
  /** The live car reflections (the probe); off on Low */
  reflections: boolean;
  /** Hardware MSAA samples (off on Low and on touch devices) */
  msaa: boolean;
  /** Bloom post-processing (High only; stays on even when MSAA is disabled on touch screens) */
  bloom: boolean;
  /** The sun's cascaded shadow maps: full resolution, half per side, or none (Low) */
  shadows: "full" | "half" | "off";
  /** Keep the 1.5x pixel-ratio cap on Low instead of dropping to 1x ("Sharp Low") */
  sharpLow?: boolean;
  /** Contrast-adaptive sharpening in the final post-processing pass */
  sharpen?: boolean;
}

export interface PlanOptions {
  /** Touch device (phones / tablets): disables MSAA in presets and puts resolution rungs last */
  touch?: boolean;
  /** Keep the 1.5x pixel-ratio cap on Low instead of dropping to 1x ("Sharp Low") */
  sharpLow?: boolean;
  /** Contrast-adaptive sharpening in the final post-processing pass */
  sharpen?: boolean;
  /**
   * The lowest render scale the resolution rungs may take the plan to (the player's "Lowest resolution", 0.6..1);
   * RENDER_SCALE_FLOOR when not given
   */
  minScale?: number;
}

/** The base plan of a preset at the player's render scale */
export function presetPlan(quality: GraphicsQuality, renderScale: number, opts?: PlanOptions): RenderPlan {
  const touch = opts?.touch ?? false;
  return {
    quality,
    renderScale,
    reflections: quality !== "low",
    msaa: !touch && quality !== "low",
    bloom: quality === "high",
    shadows: quality === "low" ? "off" : "full",
    sharpLow: opts?.sharpLow ?? false,
    sharpen: opts?.sharpen ?? false,
  };
}

/** The preset's cap on the device pixel ratio, before the render scale multiplies it: 1x on Low, 1.5x otherwise and on Sharp Low */
export function pixelRatioCap(plan: Pick<RenderPlan, "quality" | "sharpLow">): number {
  return plan.quality === "low" && !plan.sharpLow ? 1 : 1.5;
}

/**
 * The lowest render scale the resolution rungs take the plan to by default (the "Lowest resolution" setting's default),
 * or the player's own scale when that is lower.
 *
 * The floor, the default one or the player's, is in the units of Render resolution: it bounds `renderScale`, the
 * multiplier on the preset's pixel-ratio cap (pixelRatioCap), not a share of the screen's native resolution. So the
 * scale the player sees in Settings and in the "Scaled down" hint never goes under it, while the pixels it stands for
 * depend on the cap: on a 3x phone, Medium at a 70% floor is 1.5 x 0.7 = 1.05 pixels per CSS pixel, 35% of native
 * per axis. The floor never touches the cap itself, except through the Sharp Low rung (SHARP_LOW_OFF_SCALE).
 */
export const RENDER_SCALE_FLOOR = 0.6;

/**
 * Sharp Low off moves Low's cap from 1.5x back to 1x: on any screen at 1.5x or more (every phone) the image drops to
 * two thirds per axis, as Render resolution 67% would, with the render scale itself unchanged. That rung is on the
 * ladder only while the Lowest resolution allows a two-thirds drop on its own: at the default 60% it stays the last
 * resort it was before the setting (after 70%, it ends at 47% of the chosen resolution); from 70% up it is left off.
 */
export const SHARP_LOW_OFF_SCALE = 1 / 1.5;

/** The rungs' context: the player's own render scale and the lowest the resolution rungs may go */
interface LadderContext {
  chosenScale: number;
  minScale: number;
}

export type RungId = "res85" | "res70" | "reflections" | "msaa" | "shadows" | "sharp";

export interface Rung {
  id: RungId;
  /** What the step did, for the report */
  label: string;
  /**
   * Context-aware label from the plans before and after the step (the resolution the rung ended on, which the floor may
   * have clamped; "bloom off" when MSAA was already off on touch)
   */
  labelFor?: (before: RenderPlan, after: RenderPlan) => string;
  /** The plan with this rung on; the same plan when it changes nothing */
  apply(plan: RenderPlan, ctx: LadderContext): RenderPlan;
}

/** A resolution rung's scale: `f` of the player's, but not under the floor (or the player's own, when that is lower) */
const scaled = (ctx: LadderContext, f: number) => Math.max(ctx.chosenScale * f, Math.min(ctx.chosenScale, ctx.minScale));

const resolutionLabel = (_before: RenderPlan, after: RenderPlan) => `resolution ${Math.round(after.renderScale * 100)}%`;

const RUNG_BY_ID: Record<RungId, Rung> = {
  res85: {
    id: "res85",
    label: "resolution 85%",
    labelFor: resolutionLabel,
    apply: (p, c) => ({ ...p, renderScale: Math.min(p.renderScale, scaled(c, 0.85)) }),
  },
  res70: {
    id: "res70",
    label: "resolution 70%",
    labelFor: resolutionLabel,
    apply: (p, c) => ({ ...p, renderScale: Math.min(p.renderScale, scaled(c, 0.7)) }),
  },
  reflections: { id: "reflections", label: "car reflections off", apply: (p) => (p.reflections ? { ...p, reflections: false } : p) },
  msaa: {
    id: "msaa",
    label: "anti-aliasing off",
    labelFor: (p) => (p.msaa ? "anti-aliasing off" : "bloom off"),
    apply: (p) => (p.msaa || p.bloom ? { ...p, msaa: false, bloom: false } : p),
  },
  shadows: { id: "shadows", label: "lighter shadows", apply: (p) => (p.shadows === "full" ? { ...p, shadows: "half" } : p) },
  sharp: {
    id: "sharp",
    label: "Sharp Low off",
    apply: (p, c) => (p.quality === "low" && p.sharpLow && sharpLowStepAllowed(c.minScale) ? { ...p, sharpLow: false } : p),
  },
};

/** The lowest resolution the player allows, as the ladder reads it (RENDER_SCALE_FLOOR when not given) */
const minScaleOf = (opts?: PlanOptions) => opts?.minScale ?? RENDER_SCALE_FLOOR;

/** Whether automatic quality may turn Sharp Low off under this Lowest resolution (see SHARP_LOW_OFF_SCALE) */
export function sharpLowStepAllowed(minScale: number): boolean {
  return SHARP_LOW_OFF_SCALE >= minScale - 1e-9;
}

const DESKTOP_ORDER: readonly RungId[] = ["res85", "res70", "reflections", "msaa", "shadows", "sharp"];
// On touch screens, cut costly effects before dropping render resolution so the image stays sharp until needed
const TOUCH_ORDER: readonly RungId[] = ["reflections", "msaa", "shadows", "res85", "res70", "sharp"];

const samePlan = (a: RenderPlan, b: RenderPlan) =>
  a.quality === b.quality &&
  Math.abs(a.renderScale - b.renderScale) < 1e-6 &&
  a.reflections === b.reflections &&
  a.msaa === b.msaa &&
  a.bloom === b.bloom &&
  a.shadows === b.shadows &&
  Boolean(a.sharpLow) === Boolean(b.sharpLow) &&
  Boolean(a.sharpen) === Boolean(b.sharpen);

/** The rungs that change something for this preset and render scale, in order: level n has the first n on */
export function ladderFor(quality: GraphicsQuality, renderScale: number, opts?: PlanOptions): readonly Rung[] {
  const order = opts?.touch ? TOUCH_ORDER : DESKTOP_ORDER;
  const ctx: LadderContext = { chosenScale: renderScale, minScale: minScaleOf(opts) };
  const out: Rung[] = [];
  let plan = presetPlan(quality, renderScale, opts);
  for (const id of order) {
    const rung = RUNG_BY_ID[id];
    const next = rung.apply(plan, ctx);
    if (samePlan(next, plan)) continue;
    out.push(rung);
    plan = next;
  }
  return out;
}

/** The plan at `level` steps down from the player's choice (clamped to the ladder) */
export function planAt(quality: GraphicsQuality, renderScale: number, level: number, opts?: PlanOptions): RenderPlan {
  const ladder = ladderFor(quality, renderScale, opts);
  const ctx: LadderContext = { chosenScale: renderScale, minScale: minScaleOf(opts) };
  let plan = presetPlan(quality, renderScale, opts);
  for (let i = 0; i < Math.min(level, ladder.length); i++) plan = ladder[i].apply(plan, ctx);
  return plan;
}

/**
 * What is lowered at `level`, for the Settings hint and the report ("resolution 70%, car reflections off"). The
 * resolution is the Render resolution the steps ended on, in the same units as the setting and the Lowest resolution.
 */
export function loweredSummary(quality: GraphicsQuality, renderScale: number, level: number, opts?: PlanOptions): string {
  const ladder = ladderFor(quality, renderScale, opts).slice(0, level);
  const ctx: LadderContext = { chosenScale: renderScale, minScale: minScaleOf(opts) };
  let plan = presetPlan(quality, renderScale, opts);
  const labels: string[] = [];
  ladder.forEach((r, i) => {
    const next = r.apply(plan, ctx);
    // The second scale rung replaces the first in the summary
    if (!(r.id === "res85" && ladder[i + 1]?.id === "res70")) labels.push(r.labelFor?.(plan, next) ?? r.label);
    plan = next;
  });
  return labels.join(", ");
}

// ---------------------------------------------------------------------------
// When to step
// ---------------------------------------------------------------------------

export const STEP_DOWN = {
  /** One judgement per this much time (ms) */
  windowMs: 1000,
  /** A window is slow when this percentile of its drawn frames' intervals... */
  percentile: 0.9,
  /** ...is over the budget times this */
  overBudget: 1.3,
  /** Slow windows in a row that step down once */
  slowWindows: 3,
  /** A window with fewer drawn frames is not judged (a stall, the tab hidden) */
  minFrames: 5,
  /** Nothing is judged this long after driving first starts in a session (ms): shaders and textures still warming */
  startGraceMs: 20_000,
  /** ...after a step (ms): the step's own hitch, and time for the frames to settle */
  stepGraceMs: 5_000,
  /** ...after a pause, a menu, a replay or a hidden tab (ms) */
  resumeGraceMs: 3_000,
  /** A session starting this soon after the last one stepped down (ms) starts one rung better than it ended */
  carryMs: 10 * 60_000,
} as const;

/** The frame budget (ms): 60 fps, or the cap, or the screen's own rate when the system holds the frames lower */
export function frameBudgetMs(capFps: number, displayIntervalMs: number): number {
  const target = capFps > 0 ? 1000 / capFps : 1000 / 60;
  return Math.max(target, displayIntervalMs);
}

/** The value at fraction `q` of the sorted samples (nearest rank) */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * The fastest the screen and the system have let the page run this session (ms): the lowest 10th percentile of two
 * seconds' animation frame intervals seen so far, fed from the loading screen on (which draws nothing, so it runs at
 * the screen's own rate). A 60 Hz screen reads 16.7, 120 Hz 8.3. iOS in Low Power Mode holds every page at 30 fps from
 * the start and reads 33.3, so its steady 30 is not taken for a hot phone (and stepped down to the floor for nothing).
 * A phone that slows down later keeps the 16.7 it showed before: its steady 30 is the heat, and is stepped down.
 * Low Power Mode switched on mid-session reads as heat too (the graphics step down; it saves battery as well).
 */
export class DisplayRate {
  private readonly samples: number[];
  private next = 0;
  private count = 0;
  private lowestMs = Infinity;
  private sinceSort = 0;

  constructor(private readonly size = 120) {
    this.samples = new Array<number>(size).fill(0);
  }

  /** An animation frame's interval (ms); stalls over 250 ms are not the screen's rate and are left out */
  add(intervalMs: number): void {
    if (!(intervalMs > 0) || intervalMs > 250) return;
    this.samples[this.next] = intervalMs;
    this.next = (this.next + 1) % this.size;
    this.count = Math.min(this.count + 1, this.size);
    if (++this.sinceSort >= 30 && this.count === this.size) this.refresh();
  }

  private refresh(): void {
    this.sinceSort = 0;
    const sorted = this.samples.slice().sort((a, b) => a - b);
    this.lowestMs = Math.min(this.lowestMs, percentile(sorted, 0.1));
  }

  /** 16.7 until two seconds of frames have been seen */
  get intervalMs(): number {
    return Number.isFinite(this.lowestMs) ? this.lowestMs : 1000 / 60;
  }
}

/**
 * A decision: "step" takes the next rung (`level` is the level now, 1 = the first rung on); "floor" says the frames
 * stayed slow with every rung already on (once per ladder). `p90Ms` and `budgetMs`: the last slow second's 90th
 * percentile and the budget it was judged against.
 */
export type GovernorEvent = { kind: "step"; level: number; p90Ms: number; budgetMs: number } | { kind: "floor"; p90Ms: number; budgetMs: number };

/** The step-down's decisions: fed the frames drawn while driving, it says when to take the next rung */
export class QualityGovernor {
  private levelNow: number;
  private maxLevel: number;
  private windowStartMs = -1;
  private intervals: number[] = [];
  private slowRun = 0;
  /** Nothing is judged before this time (ms); -1: the next frame sets it */
  private graceUntilMs = -1;
  private started = false;
  private floorSaid = false;

  constructor(maxLevel: number, startLevel = 0) {
    this.maxLevel = maxLevel;
    this.levelNow = Math.min(startLevel, maxLevel);
  }

  get level(): number {
    return this.levelNow;
  }

  /** The level with every rung on */
  get floor(): number {
    return this.maxLevel;
  }

  /** The player chose other graphics: their ladder, from `level` (their own settings at 0) */
  reset(maxLevel: number, level = 0): void {
    this.maxLevel = maxLevel;
    this.levelNow = Math.min(level, maxLevel);
    this.floorSaid = false;
    this.clearWindow();
    // A change of graphics may hitch: judged again a grace period after the next frame
    if (this.started) this.graceUntilMs = -1;
  }

  /** Driving stopped (pause, the menus, a replay, a hidden tab): judging resumes a grace period after the next frame */
  interrupt(): void {
    this.clearWindow();
    this.graceUntilMs = -1;
  }

  private clearWindow(): void {
    this.windowStartMs = -1;
    this.intervals = [];
    this.slowRun = 0;
  }

  /** A frame drawn while driving, `intervalMs` after the previous drawn one, against `budgetMs`: what to do now */
  frame(nowMs: number, intervalMs: number, budgetMs: number): GovernorEvent | null {
    if (this.graceUntilMs < 0) {
      this.graceUntilMs = nowMs + (this.started ? STEP_DOWN.resumeGraceMs : STEP_DOWN.startGraceMs);
      this.started = true;
      return null;
    }
    if (nowMs < this.graceUntilMs) return null;
    if (this.windowStartMs < 0) {
      this.windowStartMs = nowMs;
      return null;
    }
    // A stall (a hidden tab, a debugger) is not the frame rate
    if (intervalMs > 0 && intervalMs < 1000) this.intervals.push(intervalMs);
    if (nowMs - this.windowStartMs < STEP_DOWN.windowMs) return null;
    this.windowStartMs = nowMs;
    const frames = this.intervals;
    this.intervals = [];
    if (frames.length < STEP_DOWN.minFrames) {
      this.slowRun = 0;
      return null;
    }
    const p90Ms = percentile(frames.sort((a, b) => a - b), STEP_DOWN.percentile);
    if (p90Ms <= budgetMs * STEP_DOWN.overBudget) {
      this.slowRun = 0;
      return null;
    }
    if (++this.slowRun < STEP_DOWN.slowWindows) return null;
    this.slowRun = 0;
    if (this.levelNow >= this.maxLevel) {
      if (this.floorSaid) return null;
      this.floorSaid = true;
      return { kind: "floor", p90Ms, budgetMs };
    }
    this.levelNow++;
    this.graceUntilMs = nowMs + STEP_DOWN.stepGraceMs;
    this.windowStartMs = -1;
    return { kind: "step", level: this.levelNow, p90Ms, budgetMs };
  }
}

/**
 * What the last session ended on, for the next one in this page (a circuit switch remounts the drive): the player's
 * graphics it was for, the level, and when it last stepped down (ms, performance.now())
 */
let lastSession: { key: string; level: number; atMs: number } | null = null;

// The Lowest resolution is part of it: a level from another floor's ladder would name another rung
const choiceKey = (quality: GraphicsQuality, renderScale: number, opts?: PlanOptions) =>
  `${quality}@${renderScale.toFixed(2)}${opts?.touch ? ":t" : ""}${opts?.sharpLow ? ":s" : ""}>${minScaleOf(opts).toFixed(2)}`;

/** Where a new session starts: one rung better than the last ended, when that was recent and on the same graphics */
export function carriedLevel(quality: GraphicsQuality, renderScale: number, nowMs: number, opts?: PlanOptions): number {
  const last = lastSession;
  if (!last || last.key !== choiceKey(quality, renderScale, opts) || nowMs - last.atMs > STEP_DOWN.carryMs) return 0;
  return Math.max(0, last.level - 1);
}

/** Remembers a session's level for the next (on every step, so a session that ends any way is remembered) */
export function rememberLevel(quality: GraphicsQuality, renderScale: number, level: number, nowMs: number, opts?: PlanOptions): void {
  lastSession = level > 0 ? { key: choiceKey(quality, renderScale, opts), level, atMs: nowMs } : null;
}
