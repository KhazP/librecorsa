"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";
import { formatMegabytes, useAssetProgress, type AssetTask } from "@/lib/loading/asset-progress";
import { connectedPads } from "@/lib/input/device-input";
import { GameTitle } from "./menu-ui";

const TIPS = [
  "Bugesera sits 1,400 m above sea level: thinner air means less downforce and less drag than you expect.",
  "Esc opens the menu at any time: car setup, corner practice, AI races and multiplayer.",
  "Brake in a straight line, then trail off the pedal as you turn in.",
  "Press C to cycle cameras: cockpit, T-cam, chase and trackside TV.",
  "The racing line turns red where you need to brake. Press R to hide it once you know the track.",
  "On a controller, the steering assist keeps the front tyres at their grip limit.",
  "Hold boost on the straights; the battery recharges under braking.",
  "Practise any of the 14 corners from the pause menu or by clicking the circuit map.",
];

const LIGHTS = 5;

function statusText(t: AssetTask): string {
  if (t.status === "done") return "READY";
  if (t.status === "failed") return t.id === "shaders" ? "SKIPPED" : "FALLBACK";
  if (t.id === "shaders") return t.status === "loading" ? "COMPILING" : "WAITING";
  if (t.status === "pending") return "QUEUED";
  return `${formatMegabytes(t.loadedBytes)} / ${formatMegabytes(t.totalBytes)} MB`;
}

/** Shown once loaded; touch screens are told to tap */
const ContinuePrompt: React.FC = () => (
  <div className="animate-pulse font-f1-italic text-xl uppercase tracking-wider sm:text-2xl">
    <span className="pointer-coarse:hidden">Press any key to continue</span>
    <span className="hidden pointer-coarse:inline">Tap to continue</span>
    <div className="mt-1 font-f1-mono text-[11px] font-bold not-italic tracking-[0.16em] text-zinc-400">
      <span className="pointer-coarse:hidden">KEY · CLICK · Ⓐ OR ANY WHEEL BUTTON</span>
      <span className="hidden pointer-coarse:inline">TAP · KEY · Ⓐ OR ANY WHEEL BUTTON</span>
    </div>
  </div>
);

/**
 * Full-screen loading: the circuit draws itself as the assets arrive and the five start lights fill;
 * once everything is ready the lights go out and any key / click / controller button continues.
 * That gesture is also what unlocks the browser's audio.
 */
export const LoadingScreen: React.FC<{
  track: BuiltTrackData;
  ready: boolean;
  /** Called synchronously inside the user gesture (audio unlock) */
  onStart: () => void;
  /** Called once the fade-out has finished */
  onDone: () => void;
}> = ({ track, ready, onStart, onDone }) => {
  const progress = useAssetProgress();
  const [tip, setTip] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const shown = ready ? 1 : progress.progress;

  const outline = useMemo(() => {
    const samples = track.samples;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const s of samples) {
      minX = Math.min(minX, s.position.x);
      maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z);
      maxZ = Math.max(maxZ, s.position.z);
    }
    const size = Math.max(maxX - minX, maxZ - minZ);
    const ox = (size - (maxX - minX)) / 2;
    const oz = (size - (maxZ - minZ)) / 2;
    const pts = samples.filter((_, i) => i % 3 === 0);
    const d = pts
      .map((s, i) => {
        const x = ((s.position.x - minX + ox) / size) * 100;
        const y = ((s.position.z - minZ + oz) / size) * 100;
        return `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
    return `${d} Z`;
  }, [track]);

  useEffect(() => {
    // Random first tip after mount (the prerendered HTML always shows the first)
    setTip(Math.floor(Math.random() * TIPS.length));
    const id = window.setInterval(() => setTip((t) => (t + 1) % TIPS.length), 5200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const start = () => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      onStart();
      setLeaving(true);
      window.setTimeout(onDone, 520);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      e.preventDefault();
      start();
    };
    // A mouse click counts on press; a tap only becomes a user gesture (audio unlock) on release
    const onPointer = (e: PointerEvent) => {
      if ((e.type === "pointerdown") === (e.pointerType === "mouse")) start();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("pointerup", onPointer);
    // Any controller / wheel button, edge-triggered
    let raf = 0;
    let prev: string | null = null;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const down = connectedPads()
        .map((p) => p.buttons.some((b) => b.pressed))
        .join();
      if (prev !== null && down !== prev && down.includes("true")) start();
      prev = down;
    };
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("pointerup", onPointer);
      cancelAnimationFrame(raf);
    };
  }, [ready, onStart, onDone]);

  const litLights = ready ? 0 : Math.min(LIGHTS, Math.floor(shown * LIGHTS + 0.001));

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#07070c] text-white transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Carbon weave and a red glow behind the circuit (fixed: they stay put when a short screen scrolls) */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, #fff 0 2px, transparent 2px 8px), repeating-linear-gradient(-45deg, #fff 0 2px, transparent 2px 8px)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -right-40 top-1/2 h-[720px] w-[720px] -translate-y-1/2 rounded-full bg-[#E10600]/10 blur-3xl"
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-10">
        <GameTitle kicker="Bugesera · 2026 · Fan project" />

        <div className="mt-6 grid flex-1 grid-cols-1 items-center gap-8 lg:grid-cols-[1fr_minmax(320px,460px)]">
          <div className="order-2 flex flex-col gap-6 lg:order-1">
            {/* Start lights as the progress indicator */}
            <div className="flex items-center gap-3">
              <div className="flex gap-2 rounded-md bg-[#14141c] px-3 py-2.5">
                {Array.from({ length: LIGHTS }, (_, i) => (
                  <span key={i} className="flex flex-col gap-1.5">
                    <span
                      className={`h-6 w-6 rounded-full transition-all duration-300 sm:h-7 sm:w-7 ${
                        i < litLights ? "bg-[#E10600] shadow-[0_0_16px_#E10600]" : "bg-zinc-800"
                      }`}
                    />
                    <span
                      className={`h-6 w-6 rounded-full transition-all duration-300 sm:h-7 sm:w-7 ${
                        i < litLights ? "bg-[#E10600] shadow-[0_0_16px_#E10600]" : "bg-zinc-800"
                      }`}
                    />
                  </span>
                ))}
              </div>
              <div className="font-f1-mono">
                <div className="text-3xl font-black tabular-nums sm:text-4xl">{Math.round(shown * 100)}%</div>
                <div className="text-[11px] font-bold tracking-[0.16em] text-zinc-500">
                  {ready ? "LIGHTS OUT" : "LOADING"}
                </div>
              </div>
            </div>

            <div className="max-w-md rounded-md bg-[#14141c] p-4">
              {progress.tasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 border-b border-white/5 py-1.5 last:border-0">
                  <span className="font-f1-italic text-sm uppercase">{t.label}</span>
                  <span
                    className={`font-f1-mono text-[11px] font-bold tabular-nums ${
                      t.status === "done" ? "text-[#00D26A]" : t.status === "failed" ? "text-[#FFD700]" : "text-zinc-400"
                    }`}
                  >
                    {statusText(t)}
                  </span>
                </div>
              ))}
              {progress.anyFailed ? (
                <p className="mt-2 font-f1-mono text-[11px] text-[#FFD700]">
                  Some assets did not load; using the built-in geometry instead.
                </p>
              ) : null}
            </div>

            <div className={`min-h-[3.5rem] max-w-md ${ready ? "compact:hidden" : ""}`}>
              {ready ? (
                <ContinuePrompt />
              ) : (
                <p key={tip} className="font-f1-mono text-[13px] leading-relaxed text-zinc-300">
                  <span className="mr-2 font-bold text-[#E10600]">TIP</span>
                  {TIPS[tip]}
                </p>
              )}
            </div>
          </div>

          {/* The circuit drawing itself */}
          <div className="order-1 mx-auto w-full max-w-[min(280px,32vh)] lg:order-2 lg:max-w-[min(100%,calc(100vh_-_18rem))]">
            <svg viewBox="-6 -6 112 112" className="h-auto w-full">
              <path d={outline} fill="none" stroke="#1c1c26" strokeWidth="3.4" strokeLinejoin="round" />
              <path
                d={outline}
                pathLength={1}
                fill="none"
                stroke="#E10600"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="1 1"
                strokeDashoffset={1 - shown}
                style={{ transition: "stroke-dashoffset 300ms ease-out", filter: "drop-shadow(0 0 3px #E10600)" }}
              />
            </svg>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 font-f1-mono text-[11px] font-bold tracking-wide text-zinc-500">
          <span>
            RWANDA INTERNATIONAL CIRCUIT · {(track.totalLengthM / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS · 1,400 M
          </span>
          <span>BEST WITH A CONTROLLER OR WHEEL</span>
        </div>
      </div>

      {/* Compact screens: the prompt stays pinned to the bottom instead of falling below the fold */}
      {ready ? (
        <div className="sticky bottom-0 hidden border-t border-white/10 bg-[#07070c]/90 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md compact:block sm:px-10">
          <div className="mx-auto max-w-6xl">
            <ContinuePrompt />
          </div>
        </div>
      ) : null}
    </div>
  );
};
