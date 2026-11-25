import type * as THREE from "three";
import { percentile } from "./adaptive-quality";

/**
 * `?perf=1`, the whole session: a line every 10 s for as long as the game is open, next to the first-30-s report of
 * startup-monitor.ts. Made for the stutters that only come after minutes (a phone heating up): the frame times, how
 * much of each frame was the page's own work, the simulation worker's, the memory, and what the automatic quality
 * did and when. The pause menu copies it or saves it as a file, so a player on a phone (no console) can send it.
 *
 * Per line: the frames drawn per second, the 50th / 95th percentile and the longest interval between drawn frames,
 * the drawn frames over 50 ms, the page's work per frame (50th / 95th percentile: low work with long frames is the
 * GPU or the system, high work is the page itself), the page's simulation and the worker's per second, the JS heap
 * where the browser tells it (Chrome), the drawing size and the step-down level. Kept on `window.__lcPerfReport`.
 */

/** Seconds per line */
export const ROW_S = 10;
/** Lines kept: 3 hours (older ones go, the first few stay) */
const MAX_ROWS = 1080;
const KEEP_FIRST_ROWS = 6;
/** A drawn frame this long is a dropped frame (missed 36/60Hz budget) */
const DROP_FRAME_MS = 28;
/** A drawn frame this long is a long frame / stutter (ms) */
const LONG_FRAME_MS = 50;
/** Individual stutter/drop events retained */
const MAX_STUTTERS = 500;
const KEEP_FIRST_STUTTERS = 50;
/** Preallocated ring buffer capacity for overall session percentiles (10 min @ 60 Hz) */
const SESSION_INTERVAL_CAP = 36_000;

export type PerfPhase = "drive" | "pause" | "menu" | "replay" | "load";

export interface StutterEvent {
  /** Seconds since session perf started */
  t: number;
  phase: PerfPhase;
  intervalMs: number;
  workMs: number;
  simMs: number;
  renderMs: number;
  heapMb: number | null;
  level: number;
}

export interface PerfRow {
  /** Seconds since the report started, at the end of the line's window */
  t: number;
  /** What the game was doing for most of it */
  phase: PerfPhase;
  fps: number;
  low1Fps: number;
  p50: number;
  p95: number;
  max: number;
  drops: number;
  long: number;
  /** The page's work per drawn frame (ms) */
  work50: number;
  work95: number;
  /** WebGL/PostFX render time per drawn frame (ms) */
  render50: number;
  render95: number;
  /** The page's own simulation (online races, a wheel, an AI race the worker does not run), ms per second */
  simMsPerS: number;
  /** The worker's simulation: share of its time busy (%), and its longest wake (ms); null without one */
  workerPct: number | null;
  workerMaxMs: number | null;
  heapMb: number | null;
  /** The drawing buffer (px) and the step-down level then */
  size: string;
  level: number;
}

export interface PerfNote {
  t: number;
  text: string;
}

export interface PerfRenderState {
  /** "Medium · render 100% · auto quality on · 60 fps" */
  settings: string;
  level: number;
}

export interface PerfSummary {
  totalFrames: number;
  avgFps: number;
  low1Fps: number;
  low01Fps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  dropsOver28ms: number;
  stuttersOver50ms: number;
  severeOver100ms: number;
}

export interface PerfReportData {
  started: string;
  build: string;
  device: string;
  settings: string;
  summary: PerfSummary;
  rows: readonly PerfRow[];
  stutters: readonly StutterEvent[];
  notes: readonly PerfNote[];
  durationS: number;
  startup: unknown;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The report as plain text: a header, one line per 10 s, the step-down's notes, stutters, and the startup report */
export function formatPerfReport(d: PerfReportData): string {
  const s = d.summary;
  const lines = [
    `LibreCorsa performance report · ${d.started} · build ${d.build || "local"} · ${clock(d.durationS)} recorded`,
    `device: ${d.device}`,
    `now: ${d.settings}`,
    `summary: ${s.totalFrames} frames · avg ${r1(s.avgFps)} fps · 1% low ${r1(s.low1Fps)} fps · 0.1% low ${r1(s.low01Fps)} fps · p50 ${r1(s.p50Ms)} ms · p95 ${r1(s.p95Ms)} ms · p99 ${r1(s.p99Ms)} ms · max ${Math.round(s.maxMs)} ms · drops(>28ms) ${s.dropsOver28ms} · stutters(>50ms) ${s.stuttersOver50ms} · severe(>100ms) ${s.severeOver100ms}`,
    "",
    "time   state   fps  1%low p50   p95   max   drop  long  work50 work95 rnd50 rnd95  sim/s  worker      heap   size        step",
  ];
  for (const r of d.rows) {
    const worker = r.workerPct === null ? "-" : `${r1(r.workerPct)}% ${r1(r.workerMaxMs ?? 0)}ms`;
    lines.push(
      [
        clock(r.t).padEnd(6),
        r.phase.padEnd(7),
        String(Math.round(r.fps)).padStart(3),
        String(Math.round(r.low1Fps)).padStart(5),
        String(r1(r.p50)).padStart(5),
        String(r1(r.p95)).padStart(5),
        String(Math.round(r.max)).padStart(5),
        String(r.drops).padStart(5),
        String(r.long).padStart(5),
        String(r1(r.work50)).padStart(6),
        String(r1(r.work95)).padStart(6),
        String(r1(r.render50)).padStart(5),
        String(r1(r.render95)).padStart(5),
        String(Math.round(r.simMsPerS)).padStart(6),
        worker.padStart(11),
        (r.heapMb === null ? "-" : `${Math.round(r.heapMb)}MB`).padStart(6),
        r.size.padStart(11),
        String(r.level).padStart(5),
      ].join(" ")
    );
  }
  if (d.stutters.length) {
    const worst = [...d.stutters].sort((a, b) => b.intervalMs - a.intervalMs).slice(0, 25);
    lines.push("", `top stutters (${d.stutters.length} total recorded):`);
    for (const st of worst) {
      const heap = st.heapMb === null ? "-" : `${Math.round(st.heapMb)}MB`;
      lines.push(
        `${clock(st.t)} [${st.phase}] interval=${r1(st.intervalMs)}ms work=${r1(st.workMs)}ms (sim=${r1(st.simMs)}ms render=${r1(st.renderMs)}ms) heap=${heap} step=${st.level}`
      );
    }
  }
  if (d.notes.length) {
    lines.push("", "events:");
    for (const n of d.notes) lines.push(`${clock(n.t)}  ${n.text}`);
  }
  if (d.startup) lines.push("", "first 30 s on track:", JSON.stringify(d.startup));
  return lines.join("\n");
}

interface Window10 {
  startMs: number;
  intervals: number[];
  work: number[];
  render: number[];
  activeMs: number;
  simMs: number;
  phases: Record<PerfPhase, number>;
  workerSpanMs: number;
  workerBusyMs: number;
  workerMaxMs: number;
}

const freshWindow = (startMs: number): Window10 => ({
  startMs,
  intervals: [],
  work: [],
  render: [],
  activeMs: 0,
  simMs: 0,
  phases: { drive: 0, pause: 0, menu: 0, replay: 0, load: 0 },
  workerSpanMs: 0,
  workerBusyMs: 0,
  workerMaxMs: 0,
});

export class SessionPerfMonitor {
  private readonly startedAt = new Date();
  private t0 = -1;
  private lastFrameMs = -1;
  private lastDrawnMs = -1;
  private win: Window10 = freshWindow(0);
  private readonly rows: PerfRow[] = [];
  private readonly stutters: StutterEvent[] = [];
  private readonly notes: PerfNote[] = [];
  private readonly sessionIntervals = new Float32Array(SESSION_INTERVAL_CAP);
  private sessionIntervalCount = 0;
  private sessionIntervalNext = 0;
  private totalFrames = 0;
  private totalDrops = 0;
  private totalStutters = 0;
  private totalSevere = 0;
  private state: PerfRenderState = { settings: "", level: 0 };
  private hasWorker = false;
  private device = "";

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** Whether the page asked for it (`?perf=1`) */
  static requested(): boolean {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf") === "1";
  }

  private nowS(nowMs: number): number {
    return this.t0 < 0 ? 0 : (nowMs - this.t0) / 1000;
  }

  /**
   * Every animation frame, after its work: `drawn` whether it drew the scene, `workMs` the page's time on it, `simMs`
   * the page's own simulation in it, `renderMs` the WebGL/PostFX render time
   */
  frame(nowMs: number, drawn: boolean, phase: PerfPhase, workMs: number, simMs: number, renderMs = 0): void {
    if (this.t0 < 0) {
      this.t0 = nowMs;
      this.win = freshWindow(nowMs);
      this.lastFrameMs = nowMs;
      this.lastDrawnMs = nowMs;
      return;
    }
    const w = this.win;
    const dt = nowMs - this.lastFrameMs;
    this.lastFrameMs = nowMs;
    // A hidden tab or a debugger: not a frame time
    if (dt > 0 && dt < 1000) {
      w.activeMs += dt;
      w.phases[phase] += dt;
    }
    w.simMs += simMs;
    if (drawn) {
      const interval = nowMs - this.lastDrawnMs;
      this.lastDrawnMs = nowMs;
      if (interval > 0 && interval < 1000) {
        w.intervals.push(interval);
        this.totalFrames++;
        this.sessionIntervals[this.sessionIntervalNext] = interval;
        this.sessionIntervalNext = (this.sessionIntervalNext + 1) % SESSION_INTERVAL_CAP;
        this.sessionIntervalCount = Math.min(this.sessionIntervalCount + 1, SESSION_INTERVAL_CAP);
        if (interval > DROP_FRAME_MS) this.totalDrops++;
        if (interval > LONG_FRAME_MS) this.totalStutters++;
        if (interval > 100) this.totalSevere++;
        if ((phase === "drive" && interval > DROP_FRAME_MS) || interval > LONG_FRAME_MS) {
          const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
          this.stutters.push({
            t: r1(this.nowS(nowMs)),
            phase,
            intervalMs: r1(interval),
            workMs: r1(workMs),
            simMs: r1(simMs),
            renderMs: r1(renderMs),
            heapMb: memory ? r1(memory.usedJSHeapSize / 1048576) : null,
            level: this.state.level,
          });
          if (this.stutters.length > MAX_STUTTERS) this.stutters.splice(KEEP_FIRST_STUTTERS, 1);
        }
      }
      w.work.push(workMs);
      w.render.push(renderMs);
    }
    if (nowMs - w.startMs >= ROW_S * 1000) this.closeRow(nowMs);
  }

  /** The worker's timing report (sim-protocol `perf`) */
  worker(spanMs: number, busyMs: number, maxWakeMs: number): void {
    this.hasWorker = true;
    this.win.workerSpanMs += spanMs;
    this.win.workerBusyMs += busyMs;
    this.win.workerMaxMs = Math.max(this.win.workerMaxMs, maxWakeMs);
  }

  /** What the renderer is set to now (the settings line and the step-down level) */
  setRenderState(state: PerfRenderState): void {
    this.state = state;
  }

  /** Something worth a line of its own: a step down, the cap switched */
  note(nowMs: number, text: string): void {
    this.notes.push({ t: this.nowS(nowMs), text });
    if (this.notes.length > 200) this.notes.splice(0, this.notes.length - 200);
  }

  private closeRow(nowMs: number): void {
    const w = this.win;
    const intervals = w.intervals.sort((a, b) => a - b);
    const work = w.work.sort((a, b) => a - b);
    const render = w.render.sort((a, b) => a - b);
    const activeS = Math.max(w.activeMs, 1) / 1000;
    let phase: PerfPhase = "drive";
    for (const p of Object.keys(w.phases) as PerfPhase[]) if (w.phases[p] > w.phases[phase]) phase = p;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const gl = this.renderer.getContext();
    const p99 = percentile(intervals, 0.99);
    this.rows.push({
      t: this.nowS(nowMs),
      phase,
      fps: intervals.length / activeS,
      low1Fps: p99 > 0 ? 1000 / p99 : 0,
      p50: percentile(intervals, 0.5),
      p95: percentile(intervals, 0.95),
      max: intervals.length ? intervals[intervals.length - 1] : 0,
      drops: intervals.filter((v) => v > DROP_FRAME_MS).length,
      long: intervals.filter((v) => v > LONG_FRAME_MS).length,
      work50: percentile(work, 0.5),
      work95: percentile(work, 0.95),
      render50: percentile(render, 0.5),
      render95: percentile(render, 0.95),
      simMsPerS: w.simMs / activeS,
      workerPct: this.hasWorker && w.workerSpanMs > 0 ? (100 * w.workerBusyMs) / w.workerSpanMs : null,
      workerMaxMs: this.hasWorker && w.workerSpanMs > 0 ? w.workerMaxMs : null,
      heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      size: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      level: this.state.level,
    });
    if (this.rows.length > MAX_ROWS) this.rows.splice(KEEP_FIRST_STUTTERS > 6 ? 6 : KEEP_FIRST_STUTTERS, 1);
    this.win = freshWindow(nowMs);
  }

  private deviceLine(): string {
    if (this.device) return this.device;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const nav = navigator as Navigator & { deviceMemory?: number };
    const parts = [
      navigator.userAgent,
      `GPU ${gpu}`,
      `screen ${window.screen.width}x${window.screen.height} @${window.devicePixelRatio}`,
      `${nav.hardwareConcurrency ?? "?"} cores`,
      ...(nav.deviceMemory ? [`${nav.deviceMemory} GB`] : []),
      window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse",
    ];
    this.device = parts.join(" · ");
    return this.device;
  }

  /** The rows so far (the headless checks read them) */
  get lines(): readonly PerfRow[] {
    return this.rows;
  }

  get events(): readonly PerfNote[] {
    return this.notes;
  }

  get stutterEvents(): readonly StutterEvent[] {
    return this.stutters;
  }

  summary(): PerfSummary {
    const n = this.sessionIntervalCount;
    if (n === 0) {
      return {
        totalFrames: 0,
        avgFps: 0,
        low1Fps: 0,
        low01Fps: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        maxMs: 0,
        dropsOver28ms: 0,
        stuttersOver50ms: 0,
        severeOver100ms: 0,
      };
    }
    const sample = Array.from(this.sessionIntervals.subarray(0, n)).sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sample[i];
    const p50Ms = percentile(sample, 0.5);
    const p95Ms = percentile(sample, 0.95);
    const p99Ms = percentile(sample, 0.99);
    const p999Ms = percentile(sample, 0.999);
    return {
      totalFrames: this.totalFrames,
      avgFps: sum > 0 ? (n * 1000) / sum : 0,
      low1Fps: p99Ms > 0 ? 1000 / p99Ms : 0,
      low01Fps: p999Ms > 0 ? 1000 / p999Ms : 0,
      p50Ms,
      p95Ms,
      p99Ms,
      maxMs: sample[n - 1],
      dropsOver28ms: this.totalDrops,
      stuttersOver50ms: this.totalStutters,
      severeOver100ms: this.totalSevere,
    };
  }

  private buildData(build: string): PerfReportData {
    const started = this.startedAt;
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      started: `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}`,
      build,
      device: this.deviceLine(),
      settings: this.state.settings,
      summary: this.summary(),
      rows: this.rows,
      stutters: this.stutters,
      notes: this.notes,
      durationS: this.lastFrameMs < 0 ? 0 : this.nowS(this.lastFrameMs),
      startup: (window as unknown as { __lcStartupReport?: unknown }).__lcStartupReport ?? null,
    };
  }

  /** The report as text, up to now; `build` the page's build id */
  report(build: string): string {
    return formatPerfReport(this.buildData(build));
  }

  /** Structured JSON debug log for performance analysis */
  jsonReport(build: string): string {
    return JSON.stringify(this.buildData(build), null, 2);
  }
}
