"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";
import { HUD_GLASS, HUD_RED, HUD_VOLT } from "./hud-format";

const LIGHT_COLUMNS = [0, 1, 2, 3, 4];
/** Waving chequer strip outline (520 × 60 viewBox) */
const FLAG_WAVE = "M0 20 C90 0 170 40 260 20 C350 0 430 40 520 20 L520 50 C430 70 350 30 260 50 C170 70 90 30 0 50 Z";

/** One waving chequered strip above or below the flag banner */
const ChequerStrip: React.FC<{ patternId: string; defs?: boolean }> = ({ patternId, defs = false }) => (
  <svg viewBox="0 0 520 60" className="lc-wave h-auto w-[min(520px,82vw)] [animation-duration:2.4s]" aria-hidden="true">
    {defs ? (
      <defs>
        <pattern id={patternId} width="20" height="20" patternUnits="userSpaceOnUse">
          <rect width="20" height="20" fill="#F5F7FA" />
          <rect width="10" height="10" fill="#08090D" />
          <rect x="10" y="10" width="10" height="10" fill="#08090D" />
        </pattern>
      </defs>
    ) : null}
    <path d={FLAG_WAVE} fill={`url(#${patternId})`} />
  </svg>
);

/** Five-light LibreCorsa start gantry overlay; "LIGHTS OUT" flashes in Corsa Volt when the race starts, "CHEQUERED FLAG" when the player finishes */
export const StartLights: React.FC<{ race: RaceStatus | undefined }> = ({ race }) => {
  const [starts, setStarts] = useState(0);
  const [flags, setFlags] = useState(0);
  const prevPhase = useRef(race?.phase);
  const patternId = `lc-chk-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (prevPhase.current === "lights" && race?.phase === "racing") setStarts((n) => n + 1);
    if (race?.phase === "finished" && prevPhase.current !== "finished") setFlags((n) => n + 1);
    prevPhase.current = race?.phase;
  }, [race?.phase]);

  if (race?.phase === "lights") {
    const countdown =
      typeof race.countdownS === "number" && race.countdownS > 0 ? Math.ceil(race.countdownS) : null;
    return (
      <div className="flex flex-col items-center gap-3">
        {countdown !== null ? (
          <span
            className="lc-disp text-[26px] sm:text-[30px]"
            style={{ color: HUD_VOLT, textShadow: `0 0 18px ${HUD_VOLT}66` }}
          >
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
                className="flex flex-col gap-2 rounded-full bg-[#050608] p-2 shadow-[inset_0_0_0_1px_#1B1F2B] sm:gap-2.5 sm:p-2.5 short:gap-1.5 short:p-1.5"
              >
                {[0, 1].map((row) => (
                  <span
                    key={row}
                    className="block h-8 w-8 rounded-full transition-all duration-150 sm:h-10 sm:w-10 short:h-7 short:w-7"
                    style={{
                      backgroundColor: on ? HUD_RED : "#1E1014",
                      boxShadow: on ? `0 0 22px ${HUD_RED}, 0 0 4px ${HUD_RED}` : "inset 0 2px 6px rgba(0,0,0,0.9)",
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
    return (
      <div key={starts} className="hud-fade-out relative flex items-center justify-center">
        {/* Ripples leaving the banner */}
        <span className="lc-ripple absolute inset-0 rounded-full border-2 border-[#CCFF00]/60" aria-hidden="true" />
        <div className="relative flex flex-col items-center gap-3 rounded-full border-2 border-[#CCFF00] bg-[#08090D]/[0.82] px-8 py-4 shadow-[0_0_60px_rgba(204,255,0,0.35)] sm:gap-4 sm:px-14 sm:py-6">
          <div className="flex gap-2" aria-hidden="true">
            {LIGHT_COLUMNS.map((i) => (
              <span key={i} className="h-3.5 w-3.5 rounded-full bg-[#1B1F2B]" />
            ))}
          </div>
          <span
            className="lc-disp text-[44px] whitespace-nowrap sm:text-[76px]"
            style={{ color: HUD_VOLT, textShadow: "0 0 30px rgba(204,255,0,0.6)" }}
          >
            Lights out
          </span>
        </div>
      </div>
    );
  }
  if (flags > 0 && race?.phase === "finished") {
    return (
      <div key={flags} className="hud-fade-out flex flex-col items-center gap-3.5">
        <ChequerStrip patternId={patternId} defs />
        <div className="rounded-full border-2 border-[#F5F7FA]/45 bg-[#08090D]/[0.84] px-8 py-4 sm:px-[52px] sm:py-[22px]">
          <span className="lc-disp block text-center text-[36px] whitespace-nowrap text-[#F5F7FA] sm:text-[66px]">
            Chequered flag
          </span>
        </div>
        <ChequerStrip patternId={patternId} />
      </div>
    );
  }
  return null;
};
