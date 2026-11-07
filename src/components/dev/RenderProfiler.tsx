"use client";

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

/*
 * Measures what React costs per second while driving, so the HUD's render cost can be weighed against three.js
 * and the physics before any rework. Off unless the page is opened with ?profile (dev builds only: a production
 * build never calls onRender). Every 5 s it logs commits per second and their durations, then starts over.
 * Dev React is slower than production, so the numbers are an upper bound.
 */

const WINDOW_MS = 5000;
const enabled =
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("profile");

let windowStart = 0;
let durations: number[] = [];

const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration, _baseDuration, _startTime, commitTime) => {
  if (!enabled) return;
  if (windowStart === 0) windowStart = commitTime;
  durations.push(actualDuration);
  const elapsed = commitTime - windowStart;
  if (elapsed < WINDOW_MS) return;

  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, d) => sum + d, 0);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const seconds = elapsed / 1000;
  console.info(
    `[profile:${id}] ${(sorted.length / seconds).toFixed(1)} commits/s, ` +
      `avg ${(total / sorted.length).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, ` +
      `max ${sorted[sorted.length - 1].toFixed(2)} ms, ${(total / seconds).toFixed(1)} ms of React per s`,
  );
  windowStart = commitTime;
  durations = [];
};

export function RenderProfiler({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
