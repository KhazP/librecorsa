"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { formatMegabytes, useAssetProgress, type AssetTask } from "@/lib/loading/asset-progress";
import { connectedPads } from "@/lib/input/device-input";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

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

/** Row colour: volt ready, amber fallback, cyan in flight, slate queued */
function taskColor(t: AssetTask): string {
  if (t.status === "done") return "#CCFF00";
  if (t.status === "failed") return "#FFB300";
  if (t.status === "loading") return "#00E5FF";
  return "#8E96AA";
}

/** Fill of the row's progress hairline (0..1); null = in flight without a byte count */
function taskFill(t: AssetTask): number | null {
  if (t.status === "done" || t.status === "failed") return 1;
  if (t.status === "pending") return 0;
  return t.totalBytes > 0 ? Math.min(1, t.loadedBytes / t.totalBytes) : null;
}

/** Shown once loaded; touch screens are told to tap */
const ContinuePrompt: React.FC = () => (
  <div className="flex flex-col gap-2">
    <span className="lc-disp lc-breathe text-[24px] text-[#CCFF00] sm:text-[30px]">
      <span className="pointer-coarse:hidden">Press any key to enter track</span>
      <span className="hidden pointer-coarse:inline">Tap to enter track</span>
    </span>
    <span className="lc-lbl">
      <span className="pointer-coarse:hidden">Key · click · Ⓐ or any wheel button</span>
      <span className="hidden pointer-coarse:inline">Tap · key · Ⓐ or any wheel button</span>
    </span>
  </div>
);

/** One start-light column (two lamps) inside the pill */
const LightColumn: React.FC<{ lit: boolean; ready: boolean }> = ({ lit, ready }) => {
  const lamp = `h-[18px] w-[18px] rounded-full transition-all duration-300 sm:h-[22px] sm:w-[22px] ${
    ready
      ? "bg-[#CCFF00] shadow-[0_0_16px_#CCFF00]"
      : lit
        ? "bg-[#FF2A3C] shadow-[0_0_18px_#FF2A3C]"
        : "bg-[#1B1F2B] shadow-[inset_0_1px_3px_rgba(0,0,0,0.8)]"
  }`;
  return (
    <span className="flex flex-col gap-1.5 rounded-full bg-[#08090D] p-1.5">
      <span className={lamp} />
      <span className={lamp} />
    </span>
  );
};

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

  const circuit = useMemo(() => {
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
    const pts = samples
      .filter((_, i) => i % 3 === 0)
      .map((s) => [((s.position.x - minX + ox) / size) * 100, ((s.position.z - minZ + oz) / size) * 100] as const);
    const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
    return { d: `${d} Z`, pts };
  }, [track]);
  const outline = circuit.d;
  // Start / finish marker across the first segment, and the comet at the drawing's leading edge
  const sf = useMemo(() => {
    const [a, b] = [circuit.pts[0], circuit.pts[1] ?? circuit.pts[0]];
    if (!a) return null;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    // Label on the side of the line that faces away from the circuit's centre
    const out = (a[0] - 50) * nx + (a[1] - 50) * ny >= 0 ? 1 : -1;
    return { x: a[0], y: a[1], nx, ny, out };
  }, [circuit]);
  const comet = circuit.pts.length
    ? circuit.pts[Math.min(circuit.pts.length - 1, Math.floor(shown * circuit.pts.length))]
    : null;

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
  const isRwanda = (track.id ?? "rwanda") === "rwanda";

  return (
    <div
      className={`pointer-events-auto fixed inset-0 z-50 flex flex-col overflow-y-auto bg-[#08090D] text-[#F5F7FA] transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Volt glow and the circuit's own outline echoed in faint contour rings behind the drawing */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0"
        style={{ background: "radial-gradient(560px circle at 74% 50%, rgba(204,255,0,0.07), rgba(8,9,13,0) 100%)" }}
      />
      <svg
        aria-hidden
        viewBox="-60 -60 220 220"
        className="pointer-events-none fixed top-1/2 left-1/2 h-[170vmax] w-[170vmax] -translate-x-1/2 -translate-y-1/2 lg:left-[74%] lg:h-[150vmin] lg:w-[150vmin]"
      >
        <g fill="none" stroke="#141822" strokeWidth="1">
          {[
            { k: 1.05, r: 8 },
            { k: 1.3, r: 4 },
            { k: 1.6, r: 0 },
          ].map(({ k, r }) => (
            <path
              key={k}
              d={outline}
              vectorEffect="non-scaling-stroke"
              transform={`translate(50 50) scale(${k}) rotate(${r}) translate(-50 -50)`}
            />
          ))}
        </g>
      </svg>

      <div className="relative mx-auto flex w-full max-w-[1440px] flex-1 flex-col px-5 pt-[clamp(28px,4.4vh,48px)] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-10 lg:px-16">
        <div className="grid flex-1 grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-10">
          <div className="order-2 flex max-w-[560px] flex-col gap-[clamp(20px,3.6vh,36px)] lg:order-1">
            <LibreCorsaLogo variant="full" size="lg" />

            {/* Percentage and the start lights as the progress indicator */}
            <div className="flex flex-wrap items-end gap-x-7 gap-y-4">
              <div className="flex flex-col gap-2">
                <span
                  className="lc-disp text-[clamp(72px,12vw,168px)] tracking-[-0.02em] tabular-nums short:text-[64px]"
                  style={{ color: ready ? "#CCFF00" : "#F5F7FA" }}
                >
                  {Math.round(shown * 100)}%
                </span>
                <span className="lc-lbl" style={{ color: ready ? "#CCFF00" : "#8E96AA" }}>
                  {ready ? "Green track · ready" : "Loading telemetry & mesh"}
                </span>
              </div>
              <div
                role="img"
                aria-label={ready ? "Start lights out: ready" : `Start lights: ${litLights} of ${LIGHTS}`}
                className="mb-2 flex gap-2 rounded-full border border-[#262B3D] bg-[#0D0F15] px-3 py-2.5 sm:mb-[30px] short:mb-2"
              >
                {Array.from({ length: LIGHTS }, (_, i) => (
                  <LightColumn key={i} lit={i < litLights} ready={ready} />
                ))}
              </div>
            </div>

            {/* What is still arriving */}
            <div className="flex flex-col border-t border-[#262B3D]">
              {progress.tasks.map((t) => {
                const color = taskColor(t);
                const fill = taskFill(t);
                return (
                  <div
                    key={t.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 border-b border-[#262B3D] py-3 short:py-2"
                  >
                    <span className="lc-title text-[17px]">{t.label}</span>
                    <span
                      className="font-f1-mono text-[12px] font-extrabold tracking-[0.06em] tabular-nums"
                      style={{ color }}
                    >
                      {statusText(t)}
                    </span>
                    <span className="relative col-span-2 h-[3px] overflow-hidden rounded-full bg-[#1B1F2B]">
                      <span
                        className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${
                          fill === null ? "lc-breathe" : ""
                        }`}
                        style={{ width: `${Math.round((fill ?? 1) * 100)}%`, background: color }}
                      />
                    </span>
                  </div>
                );
              })}
              {progress.anyFailed ? (
                <p className="pt-2.5 font-f1-mono text-[11px] font-bold text-[#FFB300]">
                  Some assets did not load; using the built-in geometry instead.
                </p>
              ) : null}
            </div>

            <div className={`min-h-[60px] ${ready ? "compact:hidden" : ""}`}>
              {ready ? (
                <ContinuePrompt />
              ) : (
                <p key={tip} className="m-0 flex items-start gap-3 text-[15px] leading-normal text-[#C5CBD8] sm:text-base">
                  <span className="mt-0.5 shrink-0 rounded-full bg-[#CCFF00] px-[9px] py-[3px] font-f1-mono text-[10px] font-extrabold tracking-[0.1em] text-[#08090D]">
                    TIP
                  </span>
                  {TIPS[tip]}
                </p>
              )}
            </div>
          </div>

          {/* The circuit drawing itself in Corsa Volt */}
          <div className="order-1 mx-auto flex w-full max-w-[min(280px,32vh)] items-center justify-center lg:order-2 lg:max-w-[min(640px,100%,calc(100vh_-_12rem))]">
            <svg
              viewBox="-8 -8 116 116"
              className="h-auto w-full overflow-visible"
              role="img"
              aria-label={`${trackInfo.name} drawing itself as it loads`}
            >
              <path d={outline} fill="none" stroke="#141822" strokeWidth="5.6" strokeLinejoin="round" />
              <path d={outline} fill="none" stroke="#1B1F2B" strokeWidth="1.6" strokeLinejoin="round" />
              <path
                d={outline}
                pathLength={1}
                fill="none"
                stroke="#CCFF00"
                strokeWidth="1.6"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray="1 1"
                strokeDashoffset={1 - shown}
                style={{
                  transition: "stroke-dashoffset 300ms ease-out",
                  filter: "drop-shadow(0 0 1.4px rgba(204,255,0,0.6))",
                }}
              />
              {!ready && comet ? (
                <circle
                  cx={comet[0]}
                  cy={comet[1]}
                  r="1.6"
                  fill="#F5F7FA"
                  className="lc-breathe"
                  style={{ filter: "drop-shadow(0 0 1.8px #CCFF00)" }}
                />
              ) : null}
              {sf ? (
                <>
                  <line
                    x1={sf.x - sf.nx * 3.4}
                    y1={sf.y - sf.ny * 3.4}
                    x2={sf.x + sf.nx * 3.4}
                    y2={sf.y + sf.ny * 3.4}
                    stroke="#F5F7FA"
                    strokeWidth="1.1"
                    strokeLinecap="round"
                  />
                  <text
                    x={sf.x + sf.nx * 7.4 * sf.out}
                    y={sf.y + sf.ny * 7.4 * sf.out}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="#8E96AA"
                    className="font-f1-mono"
                    style={{ fontSize: 2.8, fontWeight: 700, letterSpacing: "0.2em" }}
                  >
                    S/F
                  </text>
                </>
              ) : null}
            </svg>
          </div>
        </div>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2.5 border-t border-[#262B3D] pt-3.5 font-f1-mono text-[11px] font-bold tracking-[0.12em] text-[#8E96AA]">
          <span>
            {trackInfo.name.toUpperCase()} · {(track.totalLengthM / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
            {isRwanda ? " · 1,400 M ALTITUDE" : ""}
          </span>
          <span className="text-[#CCFF00]/80">LIBRECORSA · 500HZ VEHICLE DYNAMICS</span>
        </footer>
      </div>

      {/* Compact screens: the prompt stays pinned to the bottom instead of falling below the fold */}
      {ready ? (
        <div className="sticky bottom-0 hidden border-t border-[#262B3D] bg-[#08090D]/92 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-md compact:block sm:px-10">
          <div className="mx-auto max-w-[1440px]">
            <ContinuePrompt />
          </div>
        </div>
      ) : null}
    </div>
  );
};
