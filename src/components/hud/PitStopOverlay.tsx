"use client";

import React, { useEffect, useRef, useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { HUD_GLASS } from "./hud-format";

const COMPOUNDS: readonly { id: TireCompound; letter: string; label: string; color: string }[] = [
  { id: "soft", letter: "S", label: "Soft", color: "#ef4444" },
  { id: "medium", letter: "M", label: "Medium", color: "#eab308" },
  { id: "hard", letter: "H", label: "Hard", color: "#f8fafc" },
  { id: "intermediate", letter: "I", label: "Inter", color: "#22c55e" },
  { id: "wet", letter: "W", label: "Wet", color: "#38bdf8" },
];

const PIT_DURATION_MS = 2400;

export interface PitStopOverlayProps {
  telemetry: CarTelemetry;
  currentCompound: TireCompound;
  onServicePitStop?: (compound: TireCompound) => void;
}

export const PitStopOverlay: React.FC<PitStopOverlayProps> = ({
  telemetry,
  currentCompound,
  onServicePitStop,
}) => {
  const [nextCompound, setNextCompound] = useState<TireCompound>(currentCompound);
  const [boxRequested, setBoxRequested] = useState(false);
  const [servicing, setServicing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [releasedBanner, setReleasedBanner] = useState(false);
  const hasLeftGrid = useRef(false);
  const lastStopLap = useRef<number>(-1);

  const racePhase = telemetry.race?.phase;
  const speedKmh = Math.abs(telemetry.speedKmh || 0);
  const trackProg = telemetry.trackProgress ?? 0;
  // Pit lane / start-finish pit box window (final 4% of lap or first 5% of lap)
  const inPitZone = trackProg >= 0.96 || trackProg <= 0.05;

  // Track once the player has driven away from the starting grid so standing on the grid at race start doesn't trigger a pit stop
  useEffect(() => {
    if (racePhase === "lights") {
      hasLeftGrid.current = false;
      lastStopLap.current = -1;
      setServicing(false);
      setReleasedBanner(false);
    } else if (trackProg > 0.08 && trackProg < 0.92 && speedKmh > 30) {
      hasLeftGrid.current = true;
    }
  }, [racePhase, trackProg, speedKmh]);

  // Keyboard shortcuts: P toggles Pit Request / Box panel, 1..5 selects next tyre compound while pit panel is open
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "KeyP") {
        setBoxRequested((b) => !b);
      } else if (boxRequested || (hasLeftGrid.current && inPitZone && speedKmh < 95)) {
        const idx = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].indexOf(e.code);
        if (idx >= 0 && COMPOUNDS[idx]) {
          setNextCompound(COMPOUNDS[idx].id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [boxRequested, inPitZone, speedKmh]);

  const canEnterPitBox =
    Boolean(onServicePitStop) &&
    racePhase !== "lights" &&
    racePhase !== "finished" &&
    hasLeftGrid.current &&
    inPitZone &&
    lastStopLap.current !== telemetry.lapCount;

  // Automatically start the 2.4 s pit crew service when the car stops (< 6 km/h) inside the pit box window
  useEffect(() => {
    if (!servicing && canEnterPitBox && speedKmh < 6) {
      setServicing(true);
      setProgress(0);
    }
  }, [servicing, canEnterPitBox, speedKmh]);

  const startManualService = () => {
    if (servicing || !onServicePitStop) return;
    setServicing(true);
    setProgress(0);
  };

  useEffect(() => {
    if (!servicing) return;
    const startMs = performance.now();
    const id = window.setInterval(() => {
      const elapsed = performance.now() - startMs;
      const frac = Math.min(1, elapsed / PIT_DURATION_MS);
      setProgress(frac);
      if (frac >= 1) {
        window.clearInterval(id);
        onServicePitStop?.(nextCompound);
        lastStopLap.current = telemetry.lapCount;
        setServicing(false);
        setBoxRequested(false);
        setReleasedBanner(true);
      }
    }, 40);
    return () => window.clearInterval(id);
  }, [servicing, nextCompound, onServicePitStop, telemetry.lapCount]);

  useEffect(() => {
    if (!releasedBanner) return;
    const id = window.setTimeout(() => setReleasedBanner(false), 2600);
    return () => window.clearTimeout(id);
  }, [releasedBanner]);

  if (!onServicePitStop || racePhase === "lights" || racePhase === "finished") return null;

  const maxWear = Math.round(Math.max(...(telemetry.tireWearPct ?? [0, 0, 0, 0])));
  const showApproach = canEnterPitBox && speedKmh < 100;

  if (releasedBanner) {
    const chosen = COMPOUNDS.find((c) => c.id === nextCompound) ?? COMPOUNDS[0];
    return (
      <div className="pointer-events-none fixed top-24 left-1/2 z-40 -translate-x-1/2">
        <div className={`flex items-center gap-3 rounded-lc-tile border-2 border-lc-gain bg-lc-void/95 px-6 py-3 shadow-lc-pop`}>
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-lc-gain text-[12px] font-black text-lc-void">
            GO
          </span>
          <div className="flex flex-col">
            <span className="lc-disp text-[20px] leading-none text-lc-gain uppercase">
              Green light · Pit stop complete (2.4 s)
            </span>
            <span className="text-[11px] font-bold text-lc-chalk">
              Fresh <span style={{ color: chosen.color }}>{chosen.label}</span> tyres fitted · Damage repaired · Fuel topped up
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (servicing) {
    const chosen = COMPOUNDS.find((c) => c.id === nextCompound) ?? COMPOUNDS[0];
    const remS = Math.max(0, ((1 - progress) * PIT_DURATION_MS) / 1000).toFixed(1);
    return (
      <div className="pointer-events-auto fixed top-24 left-1/2 z-40 w-[340px] -translate-x-1/2">
        <div className={`flex flex-col gap-2.5 rounded-lc-tile border-2 border-lc-volt bg-lc-void/95 p-4 shadow-lc-pop`}>
          <div className="flex items-center justify-between">
            <span className="lc-title text-[14px] font-black tracking-wider text-lc-volt uppercase">
              Pit Box · Servicing Car
            </span>
            <span className="lc-data text-[16px] font-black text-lc-chalk">{remS} s</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-lc-volt transition-[width] duration-75"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-semibold text-lc-fog">
            <span>
              Fitting <strong style={{ color: chosen.color }}>{chosen.label}</strong> (0% wear)
            </span>
            <span>Repair &amp; Refuel</span>
          </div>
        </div>
      </div>
    );
  }

  if (!showApproach && !boxRequested) {
    // Subtle pit request hint when tyre wear >= 35% or damage exists
    if (maxWear < 35) return null;
    return (
      <div className="pointer-events-auto fixed top-20 left-1/2 z-30 -translate-x-1/2">
        <button
          type="button"
          onClick={() => setBoxRequested(true)}
          className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1 text-[11px] font-bold text-lc-caution hover:border-lc-volt ${HUD_GLASS}`}
        >
          <span>Tyre wear {maxWear}% · Press P to request Pit Box</span>
        </button>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto fixed top-20 left-1/2 z-40 w-[356px] -translate-x-1/2">
      <div className={`flex flex-col gap-2.5 rounded-lc-tile p-3.5 ${HUD_GLASS}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="rounded bg-lc-volt px-1.5 py-0.5 text-[10px] font-black text-lc-void uppercase">
              {showApproach ? "PIT LANE" : "BOX THIS LAP"}
            </span>
            <span className="lc-title text-[12px] font-bold text-lc-chalk">
              {showApproach ? "Stop in Pit Box (< 6 km/h)" : "Pit Stop Strategy (P)"}
            </span>
          </div>
          {boxRequested && !showApproach ? (
            <button
              type="button"
              onClick={() => setBoxRequested(false)}
              className="text-[11px] font-bold text-lc-slate hover:text-lc-chalk"
            >
              Close
            </button>
          ) : null}
        </div>

        {/* Compound selector (1..5 or click) */}
        <div className="flex items-center justify-between gap-1.5">
          {COMPOUNDS.map((c, i) => {
            const active = nextCompound === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setNextCompound(c.id)}
                className={`flex flex-1 flex-col items-center gap-0.5 rounded-md border py-1.5 text-[11px] font-bold transition-colors ${
                  active
                    ? "border-lc-volt bg-lc-volt/15 text-lc-chalk"
                    : "border-white/10 bg-white/5 text-lc-slate hover:border-white/25 hover:text-lc-chalk"
                }`}
              >
                <span className="text-[13px] font-black" style={{ color: c.color }}>
                  {c.letter}
                </span>
                <span className="text-[9px]">{i + 1} · {c.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between text-[11px] text-lc-fog">
          <span>
            Current wear: <strong className="lc-data text-lc-chalk">{maxWear}%</strong>
          </span>
          {showApproach || (hasLeftGrid.current && inPitZone) ? (
            <button
              type="button"
              onClick={startManualService}
              className="rounded bg-lc-volt px-2.5 py-1 text-[11px] font-black text-lc-void hover:brightness-110"
            >
              Service Now (2.4 s)
            </button>
          ) : (
            <span className="text-[10px] text-lc-slate">Slow below 80 km/h on start/finish pit lane</span>
          )}
        </div>
      </div>
    </div>
  );
};
