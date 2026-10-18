"use client";

import React, { useEffect, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";
import { HUD_RED, HUD_VOLT } from "./hud-format";

/** Black / white chequer tile for the flag strips */
const CHEQUER_BG = "repeating-conic-gradient(#F5F7FA 0% 25%, #08090D 0% 50%) 0 0 / 6px 6px";

/** Five-light LibreCorsa start gantry overlay; "LIGHTS OUT" flashes in Corsa Volt when the race starts, "CHEQUERED FLAG" when the player finishes */
export const StartLights: React.FC<{ race: RaceStatus | undefined }> = ({ race }) => {
  const [starts, setStarts] = useState(0);
  const [flags, setFlags] = useState(0);
  const prevPhase = useRef(race?.phase);

  useEffect(() => {
    if (prevPhase.current === "lights" && race?.phase === "racing") setStarts((n) => n + 1);
    if (race?.phase === "finished" && prevPhase.current !== "finished") setFlags((n) => n + 1);
    prevPhase.current = race?.phase;
  }, [race?.phase]);

  if (race?.phase === "lights") {
    const countdown =
      typeof race.countdownS === "number" && race.countdownS > 0 ? Math.ceil(race.countdownS) : null;
    return (
      <div className="flex flex-col items-center gap-2">
        {countdown !== null ? (
          <span
            className="hud-num text-[30px] italic tracking-wider"
            style={{ color: HUD_VOLT, textShadow: `0 0 18px ${HUD_VOLT}66` }}
          >
            RACE STARTS IN {countdown}
          </span>
        ) : null}
        <div className="hud-panel flex gap-2.5 rounded-lg border-[#262B3D] px-4 py-3">
          {[0, 1, 2, 3, 4].map((i) => {
            const on = i < race.lightsOn;
            return (
              <div
                key={i}
                className="flex flex-col gap-2 rounded-md border border-[#262B3D] bg-[#08090D] p-2"
              >
                {[0, 1].map((row) => (
                  <span
                    key={row}
                    className="block h-8 w-8 rounded-full transition-all duration-150"
                    style={{
                      backgroundColor: on ? HUD_RED : "#1E1014",
                      boxShadow: on ? `0 0 18px ${HUD_RED}` : "inset 0 2px 4px rgba(0,0,0,0.8)",
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  if (starts > 0 && race?.phase === "racing") {
    return (
      <div
        key={starts}
        className="hud-fade-out hud-slant border border-[#CCFF00] bg-[#08090D]/90 px-6 py-2 shadow-2xl"
      >
        <span
          className="hud-num text-[38px] italic tracking-wider"
          style={{ color: HUD_VOLT, textShadow: `0 0 18px ${HUD_VOLT}66` }}
        >
          LIGHTS OUT
        </span>
      </div>
    );
  }
  if (flags > 0 && race?.phase === "finished") {
    return (
      <div
        key={flags}
        className="hud-fade-out hud-slant border border-[#F5F7FA]/40 bg-[#08090D]/90 px-6 py-2 shadow-2xl"
      >
        <div className="mx-auto mb-2 h-2.5 w-48" style={{ background: CHEQUER_BG }} />
        <span
          className="hud-num block text-center text-[38px] italic tracking-wider text-[#F5F7FA]"
          style={{ textShadow: "0 0 18px rgba(245,247,250,0.4)" }}
        >
          CHEQUERED FLAG
        </span>
        <div className="mx-auto mt-2 h-2.5 w-48" style={{ background: CHEQUER_BG }} />
      </div>
    );
  }
  return null;
};
