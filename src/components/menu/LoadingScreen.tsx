"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { formatMegabytes, useAssetProgress, type AssetTask } from "@/lib/loading/asset-progress";
import { connectedPads } from "@/lib/input/device-input";
import { GameTitle } from "./menu-ui";

const TIPS = [
  "Bugesera sits 1,400 m above sea level: thinner air means less downforce and less drag than you expect.",
  "Esc opens the garage & telemetry menu at any time: car setup, corner practice, AI races and multiplayer.",
  "Brake in a straight line, then trail off the pedal as you turn into the apex.",
  "Press C to cycle cameras: cockpit, T-cam, chase and trackside TV.",
  "The racing line turns Monza Rosso where you need to brake. Press R to hide it once you know the track.",
  "On a controller, the slip-angle steering assist keeps the front tyres at their grip limit.",
  "Hold OVR Boost on the straights; the hybrid battery recharges under braking.",
  "Switch between FA-26 Formula prototypes and the Mercedes-AMG GT3 from the Garage menu.",
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
  <div className="animate-pulse font-f1-italic text-xl tracking-wider text-[#CCFF00] uppercase sm:text-2xl">
    <span className="pointer-coarse:hidden">Press any key to enter track</span>
    <span className="hidden pointer-coarse:inline">Tap to enter track</span>
    <div className="mt-1 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA] not-italic">
      <span className="pointer-coarse:hidden">KEY · CLICK · Ⓐ OR ANY WHEEL BUTTON</span>
      <span className="hidden pointer-coarse:inline">TAP · KEY · Ⓐ OR ANY WHEEL BUTTON</span>
    </div>
  </div>
);

/**
 * Full-screen LibreCorsa loading screen: the circuit draws itself in Corsa Volt as the assets arrive and the
 * five start lights fill; once everything is ready the lights go out and any key / click / controller button continues.
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
  const trackInfo = getTrackInfo(track.id ?? "rwanda");

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
    const onPointer = (e: PointerEvent) => {
      if ((e.type === "pointerdown") === (e.pointerType === "mouse")) start();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("pointerup", onPointer);
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
      className={`pointer-events-auto fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#08090D] text-[#F5F7FA] transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Carbon weave and Corsa Volt / Slipstream Cyan ambient glow behind the circuit */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.035]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(45deg, #fff 0 2px, transparent 2px 8px), repeating-linear-gradient(-45deg, #fff 0 2px, transparent 2px 8px)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -right-40 top-1/2 h-[720px] w-[720px] -translate-y-1/2 rounded-full bg-[#CCFF00]/8 blur-3xl"
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pt-7 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:px-10">
        <GameTitle
          kicker={`${trackInfo.name} · ${trackInfo.country} · ${(track.totalLengthM / 1000).toFixed(2)} KM`}
        />

        <div className="mt-6 grid flex-1 grid-cols-1 items-center gap-8 lg:grid-cols-[1fr_minmax(320px,460px)]">
          <div className="order-2 flex flex-col gap-6 lg:order-1">
            {/* Start lights as the progress indicator */}
            <div className="flex items-center gap-4">
              <div className="flex gap-2 rounded-lg border border-[#262B3D] bg-[#11131A] px-3.5 py-2.5">
                {Array.from({ length: LIGHTS }, (_, i) => {
                  const isLit = i < litLights;
                  return (
                    <span key={i} className="flex flex-col gap-1.5 rounded bg-[#08090D] p-1.5 border border-[#262B3D]/60">
                      <span
                        className={`h-5 w-5 rounded-full transition-all duration-300 sm:h-6 sm:w-6 ${
                          ready
                            ? "bg-[#CCFF00] shadow-[0_0_14px_#CCFF00]"
                            : isLit
                              ? "bg-[#FF2A3C] shadow-[0_0_16px_#FF2A3C]"
                              : "bg-[#1B1F2B]"
                        }`}
                      />
                      <span
                        className={`h-5 w-5 rounded-full transition-all duration-300 sm:h-6 sm:w-6 ${
                          ready
                            ? "bg-[#CCFF00] shadow-[0_0_14px_#CCFF00]"
                            : isLit
                              ? "bg-[#FF2A3C] shadow-[0_0_16px_#FF2A3C]"
                              : "bg-[#1B1F2B]"
                        }`}
                      />
                    </span>
                  );
                })}
              </div>
              <div className="font-f1-mono">
                <div className="text-3xl font-black text-[#F5F7FA] tabular-nums sm:text-4xl">
                  {Math.round(shown * 100)}%
                </div>
                <div
                  className="text-[11px] font-bold tracking-[0.16em]"
                  style={{ color: ready ? "#CCFF00" : "#8E96AA" }}
                >
                  {ready ? "GREEN TRACK · READY" : "LOADING TELEMETRY & MESH"}
                </div>
              </div>
            </div>

            <div className="f1-panel f1-corner-tr max-w-md rounded-lg border border-[#262B3D] bg-[#11131A] p-4">
              {progress.tasks.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-3 border-b border-[#262B3D]/60 py-1.5 last:border-0"
                >
                  <span className="font-f1-italic text-sm text-[#F5F7FA] uppercase">{t.label}</span>
                  <span
                    className={`font-f1-mono text-[11px] font-bold tabular-nums ${
                      t.status === "done"
                        ? "text-[#CCFF00]"
                        : t.status === "failed"
                          ? "text-[#FFB300]"
                          : "text-[#00E5FF]"
                    }`}
                  >
                    {statusText(t)}
                  </span>
                </div>
              ))}
              {progress.anyFailed ? (
                <p className="mt-2 font-f1-mono text-[11px] text-[#FFB300]">
                  Some assets did not load; using the built-in geometry instead.
                </p>
              ) : null}
            </div>

            <div className={`min-h-[3.5rem] max-w-md ${ready ? "compact:hidden" : ""}`}>
              {ready ? (
                <ContinuePrompt />
              ) : (
                <p key={tip} className="font-f1-mono text-[13px] leading-relaxed text-[#F5F7FA]/90">
                  <span className="mr-2 rounded-sm bg-[#CCFF00] px-1.5 py-0.5 text-[10px] font-black text-[#08090D]">
                    TIP
                  </span>
                  {TIPS[tip]}
                </p>
              )}
            </div>
          </div>

          {/* The circuit drawing itself in Corsa Volt */}
          <div className="order-1 mx-auto w-full max-w-[min(280px,32vh)] lg:order-2 lg:max-w-[min(100%,calc(100vh_-_18rem))]">
            <svg viewBox="-6 -6 112 112" className="h-auto w-full">
              <path d={outline} fill="none" stroke="#1B1F2B" strokeWidth="3.6" strokeLinejoin="round" />
              <path
                d={outline}
                pathLength={1}
                fill="none"
                stroke="#CCFF00"
                strokeWidth="2.0"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="1 1"
                strokeDashoffset={1 - shown}
                style={{
                  transition: "stroke-dashoffset 300ms ease-out",
                  filter: "drop-shadow(0 0 5px rgba(204,255,0,0.65))",
                }}
              />
            </svg>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-[#262B3D] pt-3 font-f1-mono text-[11px] font-bold tracking-wide text-[#8E96AA]">
          <span>
            {trackInfo.name.toUpperCase()} · {(track.totalLengthM / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
            {(track.id ?? "rwanda") === "rwanda" ? " · 1,400 M ALTITUDE" : ""}
          </span>
          <span className="text-[#CCFF00]/80">LIBRECORSA · 500HZ VEHICLE DYNAMICS</span>
        </div>
      </div>

      {/* Compact screens: the prompt stays pinned to the bottom instead of falling below the fold */}
      {ready ? (
        <div className="sticky bottom-0 hidden border-t border-[#262B3D] bg-[#08090D]/92 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md compact:block sm:px-10">
          <div className="mx-auto max-w-6xl">
            <ContinuePrompt />
          </div>
        </div>
      ) : null}
    </div>
  );
};
