import type * as THREE from "three";

/**
 * `?perf=1`: a second-by-second report of the first 30 s on track, for stalls that only show on some browsers (the
 * Sketchfab circuits stutter for 10-15 s on Firefox / Windows but not on Chrome). Per second: frames, the worst frame,
 * frames over 50 ms, where the time went (simulation, reflection probe, render, the TV cameras' raycasts) and what the
 * GPU side gained: new shader programs, textures and geometries. A late program or texture next to a long frame is
 * something the loading screen's warm-up missed; long raycasts next to one are the camera placement still running. Printed with console.table at the end and kept on `window.__lcStartupReport`.
 */

/** "idle": the TV cameras' sight-line raycasts on the scan, which run in idle time after the track loads */
type Section = "sim" | "probe" | "render" | "idle";

interface Bucket {
  frames: number;
  maxFrameMs: number;
  over50: number;
  simMs: number;
  probeMs: number;
  renderMs: number;
  maxRenderMs: number;
  idleMs: number;
  maxIdleMs: number;
  programs: number;
  textures: number;
  geometries: number;
}

const DURATION_S = 30;

export class StartupMonitor {
  private t0 = -1;
  private last = 0;
  private readonly buckets: Bucket[] = [];
  private sectionStart = 0;
  private prev = { programs: 0, textures: 0, geometries: 0 };
  private done = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  /** Whether the page asked for the report (`?perf=1`) */
  static requested(): boolean {
    return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("perf") === "1";
  }

  private bucket(nowMs: number): Bucket | null {
    if (this.done || this.t0 < 0) return null;
    const s = Math.floor((nowMs - this.t0) / 1000);
    if (s >= DURATION_S) {
      this.finish();
      return null;
    }
    while (this.buckets.length <= s) {
      this.buckets.push({ frames: 0, maxFrameMs: 0, over50: 0, simMs: 0, probeMs: 0, renderMs: 0, maxRenderMs: 0, idleMs: 0, maxIdleMs: 0, programs: 0, textures: 0, geometries: 0 });
    }
    return this.buckets[s];
  }

  /** Start of a frame while driving (the report starts on the first one) */
  frame(nowMs: number): void {
    if (this.done) return;
    if (this.t0 < 0) {
      this.t0 = nowMs;
      this.last = nowMs;
      this.prev = this.counts();
      return;
    }
    const b = this.bucket(nowMs);
    if (!b) return;
    const dt = nowMs - this.last;
    this.last = nowMs;
    b.frames++;
    b.maxFrameMs = Math.max(b.maxFrameMs, dt);
    if (dt > 50) b.over50++;
    const c = this.counts();
    b.programs += c.programs - this.prev.programs;
    b.textures += c.textures - this.prev.textures;
    b.geometries += c.geometries - this.prev.geometries;
    this.prev = c;
  }

  begin(): void {
    if (this.t0 >= 0 && !this.done) this.sectionStart = performance.now();
  }

  end(section: Section): void {
    if (this.t0 < 0 || this.done) return;
    const now = performance.now();
    const b = this.bucket(now);
    if (!b) return;
    const ms = now - this.sectionStart;
    if (section === "sim") b.simMs += ms;
    else if (section === "probe") b.probeMs += ms;
    else if (section === "idle") {
      b.idleMs += ms;
      b.maxIdleMs = Math.max(b.maxIdleMs, ms);
    } else {
      b.renderMs += ms;
      b.maxRenderMs = Math.max(b.maxRenderMs, ms);
    }
  }

  private counts() {
    const info = this.renderer.info;
    return { programs: info.programs?.length ?? 0, textures: info.memory.textures, geometries: info.memory.geometries };
  }

  private finish(): void {
    this.done = true;
    const round = (v: number) => Math.round(v);
    const rows = this.buckets.map((b, s) => ({
      second: s,
      fps: b.frames,
      worstFrameMs: round(b.maxFrameMs),
      over50ms: b.over50,
      simMs: round(b.simMs),
      probeMs: round(b.probeMs),
      renderMs: round(b.renderMs),
      worstRenderMs: round(b.maxRenderMs),
      tvRaycastMs: round(b.idleMs),
      worstTvRaycastMs: round(b.maxIdleMs),
      newPrograms: b.programs,
      newTextures: b.textures,
      newGeometries: b.geometries,
    }));
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const report = {
      userAgent: navigator.userAgent,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      parallelShaderCompile: !!gl.getExtension("KHR_parallel_shader_compile"),
      rows,
    };
    (window as unknown as { __lcStartupReport: unknown }).__lcStartupReport = report;
    console.info(`[perf] first ${DURATION_S} s on track · ${report.gpu} · parallel shader compile: ${report.parallelShaderCompile}`);
    console.table(rows);
    console.info("[perf] copy this:", JSON.stringify(report));
  }
}
