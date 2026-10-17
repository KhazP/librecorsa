"use client";

import React, { useEffect, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";

/** Five-light start gantry overlay; "LIGHTS OUT" fades out over two seconds when the race starts */
export const StartLights: React.FC<{ race: RaceStatus | undefined }> = ({ race }) => {
  const [starts, setStarts] = useState(0);
  const prevPhase = useRef(race?.phase);

  useEffect(() => {
    if (prevPhase.current === "lights" && race?.phase === "racing") setStarts((n) => n + 1);
    prevPhase.current = race?.phase;
  }, [race?.phase]);

  if (race?.phase === "lights") {
    return (
      <div className="hud-panel flex gap-3 rounded-lg px-5 py-3">
        {[0, 1, 2, 3, 4].map((i) => {
          const on = i < race.lightsOn;
          return (
            <div key={i} className="flex flex-col gap-2 rounded-md bg-black/70 p-2">
              {[0, 1].map((row) => (
                <span
                  key={row}
                  className="block h-9 w-9 rounded-full"
                  style={{
                    backgroundColor: on ? "#FF1A0A" : "#2a0d0d",
                    boxShadow: on ? "0 0 18px #FF1A0A" : "none",
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  if (starts > 0 && race?.phase === "racing") {
    return (
      <div key={starts} className="hud-fade-out hud-num hud-text-shadow text-[44px] italic tracking-wide text-white">
        LIGHTS OUT
      </div>
    );
  }
  return null;
};
