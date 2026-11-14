"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";
import { HUD_GLASS, HUD_RED, raceState } from "./hud-format";

const LIGHT_COLUMNS = [0, 1, 2, 3, 4];
/** Waving chequer strip outline (520 × 60 viewBox) */
const FLAG_WAVE = "M0 20 C90 0 170 40 260 20 C350 0 430 40 520 20 L520 50 C430 70 350 30 260 50 C170 70 90 30 0 50 Z";

/** One waving chequered strip above or below the flag banner */
const ChequerStrip: React.FC<{ patternId: string; defs?: boolean }> = ({ patternId, defs = false }) => (
  <svg viewBox="0 0 520 60" className="lc-wave h-auto w-[min(520px,82vw)] [animation-duration:2.4s]" aria-hidden="true">
    {defs ? (
      <defs>
        <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
          <rect width="20" height="20" fill="var(--color-lc-chalk)" />
          <rect width="10" height="10" fill="var(--color-lc-void)" />
          <rect x="10" y="10" width="10" height="10" fill="var(--color-lc-void)" />
        </pattern>
      </defs>
    ) : null}
    <path d={FLAG_WAVE} fill={`url(#${patternId})`} />
  </svg>
);

/** Five-light start gantry overlay (the lights are red: identity, not state); "Lights out" when the race starts, "Chequered flag" when the player finishes */
export const StartLights: React.FC<{ race: RaceStatus | undefined }> = ({ race }) => {
  const [starts, setStarts] = useState(0);
  const [flags, setFlags] = useState(0);
  // Which banner has finished fading: it is then removed, so it stops holding space above the delta bar
  const [faded, setFaded] = useState<string | null>(null);
  const fadeEnd = (id: string) => (e: React.AnimationEvent) => {
    if (e.target === e.currentTarget) setFaded(id);
  };
  const prevPhase = useRef(race?.phase);
  const patternId = `lc-chk-${useId().replace(/:/g, "")}`;

  // The banner follows the player's own flag (raceState().finished), not the classification
  const flagged = raceState(race).finished;
  useEffect(() => {
    if (prevPhase.current === "lights" && race?.phase === "racing") setStarts((n) => n + 1);
    if (flagged && prevPhase.current !== "finished") setFlags((n) => n + 1);
    prevPhase.current = race?.phase;
  }, [race?.phase, flagged]);

  if (race?.phase === "lights") {
    const countdown =
      typeof race.countdownS === "number" && race.countdownS > 0 ? Math.ceil(race.countdownS) : null;
    return (
      <div className="flex flex-col items-center gap-3">
        {countdown !== null ? (
          <span className="lc-disp hud-text-shadow text-[26px] text-lc-chalk sm:text-[30px]">
            Race starts in <span className="lc-data not-italic">{countdown}</span>
          </span>
        ) : null}
        <div
          className={`flex gap-2 rounded-full px-3 py-3 sm:gap-3.5 sm:px-5 sm:py-4 short:gap-2 short:py-2 ${HUD_GLASS}`}
          role="img"
          aria-label={`Start lights: ${race.lightsOn} of 5 lit`}
        >
          {LIGHT_COLUMNS.map((i) => {
            const on = i < race.lightsOn;
            return (
              <span
                key={i}
                className="flex flex-col gap-2 rounded-full bg-lc-well p-2 inset-ring inset-ring-lc-titanium sm:gap-2.5 sm:p-2.5 short:gap-1.5 short:p-1.5"
              >
                {[0, 1].map((row) => (
                  <span
                    key={row}
                    className="block size-8 rounded-full transition-colors duration-150 sm:size-10 short:size-7"
                    style={{
                      backgroundColor: on ? HUD_RED : "color-mix(in srgb, var(--color-lc-crimson) 10%, var(--color-lc-void))",
                      boxShadow: on ? `0 0 22px ${HUD_RED}, 0 0 4px ${HUD_RED}` : "inset 0 2px 6px rgb(0 0 0 / 0.9)",
                    }}
                  />
                ))}
              </span>
            );
          })}
        </div>
      </div>
    );
  }
  if (starts > 0 && race?.phase === "racing") {
    if (faded === `go${starts}`) return null;
    return (
      <div key={starts} onAnimationEnd={fadeEnd(`go${starts}`)} className="hud-fade-out relative flex items-center justify-center">
        {/* Ripples leaving the banner */}
        <span className="lc-ripple absolute inset-0 rounded-full border-2 border-lc-chalk/45" aria-hidden="true" />
        <div className="relative flex flex-col items-center gap-3 rounded-full border-2 border-lc-chalk/45 bg-lc-void/84 px-8 py-4 shadow-lc-pop sm:gap-4 sm:px-14 sm:py-6">
          <div className="flex gap-2" aria-hidden="true">
            {LIGHT_COLUMNS.map((i) => (
              <span key={i} className="h-3.5 w-3.5 rounded-full bg-lc-titanium" />
            ))}
          </div>
          <span className="lc-disp text-[44px] whitespace-nowrap text-lc-chalk sm:text-[76px]">
            Lights out
          </span>
        </div>
      </div>
    );
  }
  if (flags > 0 && flagged) {
    if (faded === `flag${flags}`) return null;
    return (
      <div key={flags} onAnimationEnd={fadeEnd(`flag${flags}`)} className="hud-fade-out flex flex-col items-center gap-3.5">
        <ChequerStrip patternId={patternId} defs />
        <div className="rounded-full border-2 border-lc-chalk/45 bg-lc-void/84 px-8 py-4 shadow-lc-pop sm:px-13 sm:py-5.5">
          <span className="lc-disp block text-center text-[36px] whitespace-nowrap text-lc-chalk sm:text-[66px]">
            Chequered flag
          </span>
        </div>
        <ChequerStrip patternId={patternId} />
      </div>
    );
  }
  return null;
};
