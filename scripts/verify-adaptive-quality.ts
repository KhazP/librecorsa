/**
 * Automatic quality (src/lib/render/adaptive-quality.ts): the ladder each preset steps down (and its floor, the
 * player's Lowest resolution: respected, 100% never lowering the resolution, the default as before), when a
 * second counts as slow (the 90th percentile over 1.3 x the budget, i.e. more than one frame in ten missing a 60 Hz
 * vsync), three slow seconds per step, the grace periods, the frame budget under the 30 fps cap and iOS Low Power Mode,
 * and the hysteresis: never back up within a session, one rung better at the next.
 *
 *   npx tsx scripts/verify-adaptive-quality.ts
 */
import {
  carriedLevel,
  DisplayRate,
  frameBudgetMs,
  ladderFor,
  loweredSummary,
  percentile,
  pixelRatioCap,
  planAt,
  presetPlan,
  QualityGovernor,
  rememberLevel,
  RENDER_SCALE_FLOOR,
  sharpLowStepAllowed,
  STEP_DOWN,
  type GovernorEvent,
  type GraphicsQuality,
  type PlanOptions,
} from "../src/lib/render/adaptive-quality";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(86)} ${detail}`);
  if (!ok) failed++;
}

const HZ60 = 1000 / 60;

/**
 * Drives a governor with drawn frames for `seconds`: `interval(i)` gives each frame's interval (ms). Returns the events
 * with the time they came (s from the start)
 */
function drive(
  gov: QualityGovernor,
  seconds: number,
  interval: (i: number, tMs: number) => number,
  budgetMs = HZ60,
  startMs = 0
): { atS: number; event: GovernorEvent }[] {
  const out: { atS: number; event: GovernorEvent }[] = [];
  let t = startMs;
  for (let i = 0; t < startMs + seconds * 1000; i++) {
    const dt = interval(i, t - startMs);
    t += dt;
    const event = gov.frame(t, dt, budgetMs);
    if (event) out.push({ atS: (t - startMs) / 1000, event });
  }
  return out;
}

/** A frame pattern where `slowOf60` of every 60 frames miss a vsync (33.3 ms instead of 16.7) */
const mixed = (slowOf60: number) => (i: number) => ((i % 60) < slowOf60 ? 2 * HZ60 : HZ60);

// --- The ladder ---
const ids = (q: GraphicsQuality, s: number) => ladderFor(q, s).map((r) => r.id).join(",");
check("Medium at 100%: resolution twice, reflections, MSAA, then lighter shadows", ids("medium", 1) === "res85,res70,reflections,msaa,shadows", ids("medium", 1));
check("High has the same five rungs", ids("high", 1) === "res85,res70,reflections,msaa,shadows", ids("high", 1));
check("Low has only the resolution rungs (no reflections, MSAA or shadows to take)", ids("low", 1) === "res85,res70", ids("low", 1));
check("At 60% render scale already, the resolution rungs are not on the ladder", ids("medium", 0.6) === "reflections,msaa,shadows", ids("medium", 0.6));
check("At 70%, one resolution rung is left (down to the 60% floor)", ids("medium", 0.7) === "res85,reflections,msaa,shadows", ids("medium", 0.7));
check("At 50% (the player's own, under the floor) nothing scales further", ids("low", 0.5) === "", ids("low", 0.5));

const floorPlan = planAt("medium", 1, 99);
check(
  "Medium's floor: 70% resolution, no reflections, no MSAA, half-resolution shadows",
  floorPlan.quality === "medium" && Math.abs(floorPlan.renderScale - 0.7) < 1e-9 && !floorPlan.reflections && !floorPlan.msaa && floorPlan.shadows === "half",
  JSON.stringify(floorPlan)
);
check("The preset never changes on the way down (no sky swap, no scenery rebuild)", (["low", "medium", "high"] as const).every((q) => planAt(q, 1, 99).quality === q));
check(
  "Shadows never go off on the way down (that would recompile every lit material mid-race)",
  (["medium", "high"] as const).every((q) => [0, 1, 2, 3, 4, 5, 6].every((l) => planAt(q, 1, l).shadows !== "off"))
);
check(
  "The render scale never goes under the floor, or under the player's own when theirs is lower",
  [0.5, 0.6, 0.7, 0.8, 1, 1.25, 1.5].every((s) => planAt("medium", s, 99).renderScale >= Math.min(s, RENDER_SCALE_FLOOR) - 1e-9)
);
check("High at 150% (supersampling) steps to 127.5% and 105%", Math.abs(planAt("high", 1.5, 1).renderScale - 1.275) < 1e-9 && Math.abs(planAt("high", 1.5, 2).renderScale - 1.05) < 1e-9);
check("Level 0 is the preset as chosen", JSON.stringify(planAt("medium", 0.9, 0)) === JSON.stringify(presetPlan("medium", 0.9)));
check("Each level turns down one more thing than the last", [1, 2, 3, 4, 5].every((l) => JSON.stringify(planAt("medium", 1, l)) !== JSON.stringify(planAt("medium", 1, l - 1))));
check("The summary names what is down, the second resolution rung replacing the first", loweredSummary("medium", 1, 3) === "resolution 70%, car reflections off", loweredSummary("medium", 1, 3));
check(
  "Touch Medium ladder drops effects before resolution (reflections, shadows, res85, res70)",
  ladderFor("medium", 1, { touch: true }).map((r) => r.id).join(",") === "reflections,shadows,res85,res70",
  ladderFor("medium", 1, { touch: true }).map((r) => r.id).join(",")
);
check(
  "Touch High keeps bloom on with MSAA off, and its second rung turns bloom off",
  presetPlan("high", 1, { touch: true }).msaa === false &&
    presetPlan("high", 1, { touch: true }).bloom === true &&
    loweredSummary("high", 1, 2, { touch: true }) === "car reflections off, bloom off",
  loweredSummary("high", 1, 2, { touch: true })
);
check(
  "Sharp Low adds a final rung to drop back to Low's 1x DPR cap",
  ladderFor("low", 1, { sharpLow: true }).map((r) => r.id).join(",") === "res85,res70,sharp" &&
    planAt("low", 1, 3, { sharpLow: true }).sharpLow === false,
  ladderFor("low", 1, { sharpLow: true }).map((r) => r.id).join(",")
);

// --- The player's Lowest resolution (PlanOptions.minScale) ---
{
  const QUALITIES = ["low", "medium", "high"] as const;
  const SCALES = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05);
  const FLOORS = [0.6, 0.7, 0.8, 0.9, 1];
  const BASES: PlanOptions[] = [{}, { touch: true }, { sharpLow: true }, { touch: true, sharpLow: true }, { sharpen: true }];
  type Case = { q: GraphicsQuality; s: number; opts: PlanOptions };
  const cases = (floors: readonly (number | undefined)[]): Case[] =>
    QUALITIES.flatMap((q) => SCALES.flatMap((s) => BASES.flatMap((b) => floors.map((minScale) => ({ q, s, opts: minScale === undefined ? b : { ...b, minScale } })))));
  const idsOf = (c: Case) => ladderFor(c.q, c.s, c.opts).map((r) => r.id).join(",");
  /** The image's resolution in Render resolution units: the render scale times the change of the pixel-ratio cap */
  const shown = (c: Case, level: number) => {
    const p = planAt(c.q, c.s, level, c.opts);
    return (p.renderScale * pixelRatioCap(p)) / pixelRatioCap(presetPlan(c.q, c.s, c.opts));
  };

  check("The default Lowest resolution is the old fixed floor (60%)", RENDER_SCALE_FLOOR === 0.6);
  const defaults = cases([undefined]);
  check(
    "Default unchanged: no Lowest resolution given = 60%, every preset, scale, touch and Sharp Low (ladders, plans, summaries)",
    defaults.every((c) => {
      const explicit: Case = { ...c, opts: { ...c.opts, minScale: 0.6 } };
      return (
        idsOf(c) === idsOf(explicit) &&
        [0, 1, 2, 3, 4, 5, 6].every(
          (l) =>
            JSON.stringify(planAt(c.q, c.s, l, c.opts)) === JSON.stringify(planAt(c.q, c.s, l, explicit.opts)) &&
            loweredSummary(c.q, c.s, l, c.opts) === loweredSummary(c.q, c.s, l, explicit.opts)
        )
      );
    }),
    `${defaults.length} cases`
  );
  const all = cases(FLOORS);
  check(
    "Floor respected: no level takes the render scale under the Lowest resolution (or the player's own, when lower)",
    all.every((c) => [0, 1, 2, 3, 4, 5, 6, 99].every((l) => planAt(c.q, c.s, l, c.opts).renderScale >= Math.min(c.s, c.opts.minScale!) - 1e-9)),
    `${all.length} cases`
  );
  check(
    "From 70% up the floor holds for the image too (Sharp Low off, a two-thirds drop, is not taken under it)",
    all
      .filter((c) => c.opts.minScale! >= 0.7)
      .every((c) => [0, 1, 2, 3, 4, 5, 6, 99].every((l) => shown(c, l) >= Math.min(c.s, c.opts.minScale!) - 1e-9))
  );
  const atFull = all.filter((c) => c.opts.minScale === 1 && c.s <= 1 + 1e-9);
  check(
    "100% never lowers the resolution: no resolution or Sharp Low rung, the image as chosen at every level",
    atFull.every((c) => !/res85|res70|sharp/.test(idsOf(c)) && [1, 2, 3, 4, 5, 6, 99].every((l) => Math.abs(shown(c, l) - c.s) < 1e-9)),
    `${atFull.length} cases`
  );
  check(
    "...and only drops effects: Medium/High keep reflections, MSAA (or bloom on touch) and shadows",
    ladderFor("medium", 1, { minScale: 1 }).map((r) => r.id).join(",") === "reflections,msaa,shadows" &&
      ladderFor("high", 1, { minScale: 1 }).map((r) => r.id).join(",") === "reflections,msaa,shadows" &&
      ladderFor("medium", 1, { touch: true, minScale: 1 }).map((r) => r.id).join(",") === "reflections,shadows" &&
      ladderFor("high", 1, { touch: true, minScale: 1 }).map((r) => r.id).join(",") === "reflections,msaa,shadows" &&
      loweredSummary("medium", 1, 3, { touch: true, minScale: 1 }) === "car reflections off, lighter shadows",
    ladderFor("medium", 1, { touch: true, minScale: 1 }).map((r) => r.id).join(",")
  );
  check(
    "100% on Low (with or without Sharp Low) has nothing to step: an empty ladder",
    ladderFor("low", 1, { minScale: 1 }).length === 0 && ladderFor("low", 1, { minScale: 1, sharpLow: true, touch: true }).length === 0
  );
  check(
    "100% with supersampling (High at 150%) still steps down toward 100%, never under it",
    Math.abs(planAt("high", 1.5, 1, { minScale: 1 }).renderScale - 1.275) < 1e-9 && Math.abs(planAt("high", 1.5, 99, { minScale: 1 }).renderScale - 1.05) < 1e-9
  );
  check(
    "80%: the second resolution rung stops at 80%, and the summary says 80%",
    ids("medium", 1) === ladderFor("medium", 1, { minScale: 0.8 }).map((r) => r.id).join(",") &&
      Math.abs(planAt("medium", 1, 2, { minScale: 0.8 }).renderScale - 0.8) < 1e-9 &&
      loweredSummary("medium", 1, 3, { minScale: 0.8 }) === "resolution 80%, car reflections off",
    loweredSummary("medium", 1, 3, { minScale: 0.8 })
  );
  check(
    "90%: one resolution rung (to 90%), then the effects",
    ladderFor("medium", 1, { minScale: 0.9 }).map((r) => r.id).join(",") === "res85,reflections,msaa,shadows" &&
      loweredSummary("medium", 1, 1, { minScale: 0.9 }) === "resolution 90%",
    ladderFor("medium", 1, { minScale: 0.9 }).map((r) => r.id).join(",")
  );
  check(
    "The touch ladder keeps its order under a floor: effects first, then resolution down to it",
    ladderFor("medium", 1, { touch: true, minScale: 0.8 }).map((r) => r.id).join(",") === "reflections,shadows,res85,res70" &&
      Math.abs(planAt("medium", 1, 99, { touch: true, minScale: 0.8 }).renderScale - 0.8) < 1e-9
  );
  check(
    "Sharp Low off stays the last resort at 60% and is left off from 70% up",
    ladderFor("low", 1, { sharpLow: true, minScale: 0.6 }).map((r) => r.id).join(",") === "res85,res70,sharp" &&
      ladderFor("low", 1, { sharpLow: true, minScale: 0.7 }).map((r) => r.id).join(",") === "res85,res70" &&
      ladderFor("low", 1, { sharpLow: true, minScale: 0.9 }).map((r) => r.id).join(",") === "res85" &&
      sharpLowStepAllowed(0.6) &&
      !sharpLowStepAllowed(0.7),
    ladderFor("low", 1, { sharpLow: true, minScale: 0.7 }).map((r) => r.id).join(",")
  );
  check(
    "The summary's resolution is the render scale the steps ended on (clamped by a floor too)",
    all.every((c) =>
      [1, 2, 3, 4, 5, 6].every((l) => {
        const m = /resolution (\d+)%/.exec(loweredSummary(c.q, c.s, l, c.opts));
        return !m || Number(m[1]) === Math.round(planAt(c.q, c.s, l, c.opts).renderScale * 100);
      })
    ) && loweredSummary("medium", 0.8, 2) === "resolution 60%",
    loweredSummary("medium", 0.8, 2)
  );
  check(
    "The manual Render resolution is the start of every ladder (level 0 is the preset as chosen, whatever the floor)",
    all.every((c) => JSON.stringify(planAt(c.q, c.s, 0, c.opts)) === JSON.stringify(presetPlan(c.q, c.s, c.opts)))
  );
  {
    const g = new QualityGovernor(ladderFor("low", 1, { minScale: 1 }).length);
    const events = drive(g, 200, () => 2 * HZ60 + 5);
    check(
      "Nothing left to step (Low at 100%): slow frames say \"floor\" once, with no step",
      g.floor === 0 && events.filter((e) => e.event.kind === "step").length === 0 && events.filter((e) => e.event.kind === "floor").length === 1
    );
    const m = new QualityGovernor(ladderFor("medium", 1, { minScale: 1 }).length);
    const mEvents = drive(m, 200, () => 2 * HZ60 + 5);
    check(
      "Medium at 100%: three effect steps, then \"floor\" once",
      mEvents.filter((e) => e.event.kind === "step").length === 3 && mEvents.filter((e) => e.event.kind === "floor").length === 1 && m.level === 3
    );
  }
}

// --- Percentile and budget ---
check("Nearest-rank percentile", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) === 9 && percentile([5], 0.9) === 5 && percentile([], 0.5) === 0);
check("Budget: 60 fps on a 60 Hz screen", Math.abs(frameBudgetMs(0, HZ60) - HZ60) < 1e-9);
check("Budget: still 60 fps on a 120 Hz screen (no chasing 120)", Math.abs(frameBudgetMs(0, 1000 / 120) - HZ60) < 1e-9);
check("Budget: 33.3 ms under the 30 fps cap", Math.abs(frameBudgetMs(30, HZ60) - 1000 / 30) < 1e-9);
check("Budget: the system's 30 Hz (iOS Low Power Mode) when it holds every page there", Math.abs(frameBudgetMs(0, 1000 / 30) - 1000 / 30) < 1e-9);

// --- The display rate ---
{
  const rate = new DisplayRate();
  for (let i = 0; i < 600; i++) rate.add(HZ60 + (i % 3) * 0.3);
  check("A 60 Hz screen reads 16.7 ms", Math.abs(rate.intervalMs - HZ60) < 0.5, rate.intervalMs.toFixed(2));
  const lpm = new DisplayRate();
  for (let i = 0; i < 600; i++) lpm.add(1000 / 30 + (i % 3) * 0.3);
  check("Low Power Mode (every frame 33.3 ms) reads 33.3 ms", Math.abs(lpm.intervalMs - 1000 / 30) < 0.6, lpm.intervalMs.toFixed(2));
  const struggling = new DisplayRate();
  for (let i = 0; i < 600; i++) struggling.add(mixed(45)(i));
  check("A phone dropping 3 of 4 frames still hits the screen's rate on the rest: 16.7 ms", Math.abs(struggling.intervalMs - HZ60) < 0.5, struggling.intervalMs.toFixed(2));
  const stalls = new DisplayRate();
  for (let i = 0; i < 600; i++) stalls.add(i % 10 === 0 ? 2000 : HZ60);
  check("Stalls over 250 ms are not taken for the screen's rate", Math.abs(stalls.intervalMs - HZ60) < 0.5);
  const heat = new DisplayRate();
  for (let i = 0; i < 600; i++) heat.add(HZ60);
  for (let i = 0; i < 5000; i++) heat.add(1000 / 30);
  check("At 60, then a steady 30 for minutes (a hot phone): still reads 16.7, so the 30 is stepped down", Math.abs(heat.intervalMs - HZ60) < 0.5, heat.intervalMs.toFixed(2));
  check("Before two seconds of frames: 16.7", new DisplayRate().intervalMs === HZ60);
}
{
  // The whole chain on a phone that heats up: 60 for a minute, then every frame misses its vsync (a steady 30)
  const rate = new DisplayRate();
  const g = new QualityGovernor(5);
  let t = 0;
  let firstStepS = -1;
  for (let i = 0; t < 120_000; i++) {
    const dt = t < 60_000 ? HZ60 : 2 * HZ60;
    t += dt;
    rate.add(dt);
    const e = g.frame(t, dt, frameBudgetMs(0, rate.intervalMs));
    if (e && firstStepS < 0) firstStepS = t / 1000;
  }
  check("A phone at 60 that drops to a steady 30 from the heat: steps down within 5 s", firstStepS >= 60 && firstStepS < 65, `${firstStepS.toFixed(1)} s`);
}

// --- When it steps ---
{
  const g = new QualityGovernor(5);
  const events = drive(g, 300, () => HZ60);
  check("Steady 60 fps for 5 minutes: no step", events.length === 0 && g.level === 0);
}
{
  const g = new QualityGovernor(5);
  const events = drive(g, 300, (i) => (i % 60 === 0 ? 100 : HZ60));
  check("One 100 ms hitch a second (a garbage collection): no step", events.length === 0);
}
{
  const g = new QualityGovernor(5);
  const events = drive(g, 120, (i) => (i % 12 === 0 ? 2 * HZ60 : HZ60));
  check("One frame in twelve missing its vsync (under one in ten): no step", events.length === 0);
}
{
  const g = new QualityGovernor(5);
  const events = drive(g, 60, (i) => (i % 8 === 0 ? 2 * HZ60 : HZ60));
  const first = events[0];
  check("One in eight missing it (over one in ten): steps down", first?.event.kind === "step");
  check(
    "...but not before the 20 s start grace and three slow seconds after it",
    first !== undefined && first.atS >= STEP_DOWN.startGraceMs / 1000 + STEP_DOWN.slowWindows && first.atS < STEP_DOWN.startGraceMs / 1000 + STEP_DOWN.slowWindows + 2,
    first ? `${first.atS.toFixed(1)} s` : "none"
  );
  const gaps = events.slice(1).map((e, i) => e.atS - events[i].atS);
  check(
    "Steps are at least the 5 s step grace plus three slow seconds apart",
    gaps.every((s) => s >= (STEP_DOWN.stepGraceMs / 1000 + STEP_DOWN.slowWindows) - 0.05),
    gaps.map((s) => s.toFixed(1)).join(", ")
  );
}
{
  const g = new QualityGovernor(5);
  const events = drive(g, 19.5, () => 50);
  check("Even 20 fps in the first 20 s on track (warm-up): no step", events.length === 0);
}
{
  // A slow second, then two good ones, over and over: at most two judged seconds touch each slow one
  const g = new QualityGovernor(5);
  const events = drive(g, 120, (_i, t) => (Math.floor(t / 1000) % 3 === 0 ? 2 * HZ60 : HZ60));
  check("A slow second every third second: no step (three slow seconds in a row needed)", events.length === 0);
}
{
  const g = new QualityGovernor(3);
  const events = drive(g, 200, () => 2 * HZ60 + 5);
  const steps = events.filter((e) => e.event.kind === "step");
  const floors = events.filter((e) => e.event.kind === "floor");
  check("Slow for good: it steps to the floor and no further", steps.length === 3 && g.level === 3, `${steps.length} steps, level ${g.level}`);
  check("At the floor, still slow: said once (for the 30 fps hint), not every 3 s", floors.length === 1);
}
{
  // Slow until the first step, then smooth: it stays there (no step back up within the session)
  const g = new QualityGovernor(5);
  let stepped = false;
  const events = drive(g, 300, (_i, t) => (stepped || t < 25_000 ? (stepped ? HZ60 : 2 * HZ60) : HZ60));
  stepped = events.length > 0;
  const after = drive(g, 600, () => HZ60, HZ60, 400_000);
  check("Smooth again after a step: one step, and it stays down for the rest of the session", events.length === 1 && after.length === 0 && g.level === 1);
}
{
  // Paused (interrupt) in the middle of slow frames: the 3 s resume grace before judging again
  const g = new QualityGovernor(5);
  drive(g, 21.5, () => 2 * HZ60);
  g.interrupt();
  const events = drive(g, 5.5, () => 2 * HZ60, HZ60, 100_000);
  check("Back from a pause: no step inside the 3 s resume grace plus three slow seconds", events.length === 0 && g.level === 0);
  const later = drive(g, 3, () => 2 * HZ60, HZ60, 105_600);
  check("...then it judges again", later.length === 1, later.map((e) => e.atS.toFixed(1)).join(","));
}
{
  // A second with fewer than 5 drawn frames (a stall): not judged
  const g = new QualityGovernor(5);
  const events = drive(g, 60, () => 300);
  check("Seconds with under 5 drawn frames (3 fps stalls) are not judged", events.length === 0);
}
{
  // The 30 fps cap: drawn every other vsync is on budget; dropping under 30 is not
  const g = new QualityGovernor(5);
  const fine = drive(g, 120, () => 2 * HZ60, 1000 / 30);
  check("Under the 30 fps cap, 33.3 ms frames are on budget: no step", fine.length === 0);
  const g2 = new QualityGovernor(5);
  const slow = drive(g2, 40, (i) => (i % 30 < 6 ? 3 * HZ60 : 2 * HZ60), 1000 / 30);
  check("Under the cap, 6 of 30 frames at 50 ms (under 30 fps): steps", slow.length >= 1);
  // A 120 Hz screen under the cap: a frame one of its vsyncs late is 41.7 ms (1.25 x 33.3), a slip too small to see
  const g3 = new QualityGovernor(5);
  const slip = drive(g3, 120, (i) => (i % 30 < 6 ? 5 * (1000 / 120) + 0.4 : 1000 / 30), 1000 / 30);
  check("Under the cap on 120 Hz, 6 of 30 frames one 120 Hz vsync late (41.7 ms): no step", slip.length === 0);
}
{
  // iOS Low Power Mode: the system holds rAF at 30 Hz, every frame 33.3 ms; the budget follows it
  const rate = new DisplayRate();
  const g = new QualityGovernor(5);
  let t = 0;
  let steps = 0;
  for (let i = 0; i < 300 * 30; i++) {
    const dt = 1000 / 30 + ((i * 7) % 5) * 0.1;
    t += dt;
    rate.add(dt);
    if (g.frame(t, dt, frameBudgetMs(0, rate.intervalMs))) steps++;
  }
  check("iOS Low Power Mode's steady 30 fps for 5 minutes: no step (not taken for a hot phone)", steps === 0);
}
{
  // A 120 Hz screen running between 60 and 120 fps
  const g = new QualityGovernor(5);
  const events = drive(g, 120, (i) => (i % 2 ? 1000 / 120 : 12));
  check("A 120 Hz screen at 70-120 fps: no step (the budget is 60 fps)", events.length === 0);
}
{
  const g = new QualityGovernor(5);
  drive(g, 40, () => 2 * HZ60);
  const before = g.level;
  g.reset(2);
  check("The player picks other graphics: back to their settings, on the new ladder", before > 0 && g.level === 0 && g.floor === 2);
}

// --- The next session ---
{
  rememberLevel("medium", 1, 3, 1000);
  check("A session starting a minute after the last stepped to 3 starts at 2", carriedLevel("medium", 1, 61_000) === 2);
  check("...after 10 minutes, on the player's own settings", carriedLevel("medium", 1, 1000 + STEP_DOWN.carryMs + 1) === 0);
  check("...with other graphics chosen since, on those as they are", carriedLevel("high", 1, 61_000) === 0 && carriedLevel("medium", 0.9, 61_000) === 0);
  rememberLevel("medium", 1, 1, 2000);
  check("One rung down last time: the next starts at the top", carriedLevel("medium", 1, 3000) === 0);
  rememberLevel("medium", 1, 0, 3000);
  check("Graphics changed by hand (level 0): nothing carried", carriedLevel("medium", 1, 4000) === 0);
  rememberLevel("medium", 1, 3, 5000, { minScale: 0.8 });
  check(
    "A level is carried only to the same Lowest resolution (another floor is another ladder)",
    carriedLevel("medium", 1, 6000, { minScale: 0.8 }) === 2 && carriedLevel("medium", 1, 6000, { minScale: 1 }) === 0 && carriedLevel("medium", 1, 6000) === 0
  );
  rememberLevel("medium", 1, 3, 7000);
  check("No Lowest resolution given and an explicit 60% are the same choice", carriedLevel("medium", 1, 8000, { minScale: 0.6 }) === 2);
  const g = new QualityGovernor(5, 7);
  check("A carried level is clamped to the ladder", g.level === 5);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll automatic quality checks passed.");
