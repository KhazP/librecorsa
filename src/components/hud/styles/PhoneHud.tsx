"use client";

import React, { useSyncExternalStore } from "react";
import { Zap } from "lucide-react";
import { formatDelta, formatLapTime, HUD_RED } from "../hud-format";
import { anchor, deltaColor, gearLabel, HUD_GLASS, HUD_LBL, MiniMap, type HudDesignProps } from "./hud-style-parts";

/** A phone in either orientation: narrow, or a landscape screen this short */
const PHONE_QUERY = "(max-width: 639px), (max-height: 479px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True on a phone-sized screen, where the Phone HUD replaces the chosen style */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/** Rev lights in the speed pod */
const LEDS = 12;
const ledColor = (i: number) => (i < 5 ? "#00E676" : i < 9 ? HUD_RED : "#2F8BE5");

/** Edge inset that clears a notch */
const inset = (side: "top" | "left" | "right", px: number) => `calc(env(safe-area-inset-${side}, 0px) + ${px}px)`;

/**
 * Phone: one HUD for small screens, after the mobile racers (Real Racing 3, GRID). Everything lives
 * along the top edge so the thumbs on the steering pad and pedals never cover it: speed and gear
 * top-centre, position, lap and delta top-right, a small map top-left under the touch Menu / Cam.
 * In portrait the speed pod drops under the top row and the map steps aside.
 */
export const PhoneHud: React.FC<HudDesignProps> = ({ t, deltaS, map, revRange, scale, touch, lapInvalid = t.offTrack }) => {
  const race = t.race;
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = t.rpm >= revFull;
  const hasErs = t.f12026?.hasErs ?? true;

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top-left: map, under the touch Menu / Cam when they are up */}
      <div
        className="absolute hidden landscape:block"
        style={{ top: inset("top", touch ? 64 : 12), left: inset("left", 12), ...anchor(scale, "top left") }}
      >
        <div className={`h-[92px] w-[92px] rounded-[20px] p-2 ${HUD_GLASS}`}>
          <MiniMap map={map} t={t} sectors className="block h-full w-full" stroke={30} />
        </div>
      </div>

      {/* Speed pod: top-centre in landscape, under the top row in portrait */}
      <div
        className="absolute left-1/2 -translate-x-1/2 portrait:top-[calc(env(safe-area-inset-top,0px)+124px)] landscape:top-[calc(env(safe-area-inset-top,0px)+12px)]"
        style={anchor(scale, "top center")}
      >
        <div className={`flex items-center gap-2.5 rounded-[22px] p-1.5 pr-3.5 ${HUD_GLASS}`}>
          <span
            className={`flex h-[60px] w-[56px] shrink-0 items-center justify-center rounded-[16px] transition-colors duration-75 ${
              shift ? "bg-[#2F8BE5] text-[#F5F7FA]" : "bg-[#CCFF00] text-[#08090D]"
            }`}
          >
            <span className="lc-disp text-[40px] leading-none">{gearLabel(t.gear)}</span>
          </span>
          <div className="flex w-[112px] flex-col gap-1.5">
            <div className="flex gap-[3px]" aria-hidden>
              {Array.from({ length: LEDS }, (_, i) => (
                <span
                  key={i}
                  className="h-1 flex-1 rounded-full"
                  style={{ backgroundColor: shift ? "#2F8BE5" : i < lit ? ledColor(i) : "#1B1F2B" }}
                />
              ))}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="lc-data text-[30px] leading-none tracking-[-0.02em] text-[#F5F7FA] tabular-nums">{Math.round(t.speedKmh)}</span>
              <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.16em] text-[#8E96AA]">KM/H</span>
            </div>
            {hasErs ? (
              <div className="flex items-center gap-1.5">
                <Zap aria-hidden className="h-2.5 w-2.5 shrink-0 text-[#00E5FF]" fill={t.mgukPowerKw > 0 ? "#00E5FF" : "none"} />
                <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-[#00E5FF]" style={{ width: `${t.ersBatteryPercent}%` }} />
                </span>
                {t.activeAeroMode === "X_MODE" ? (
                  <span className="rounded-full bg-[#CCFF00] px-1.5 font-f1-mono text-[8px] leading-[14px] font-extrabold text-[#08090D]">X</span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Top-right: position (race) or lap, the running lap and the delta */}
      <div
        className="absolute w-[176px] landscape:w-[196px]"
        style={{ top: inset("top", 12), right: inset("right", 12), ...anchor(scale, "top right") }}
      >
        <section aria-label="Timing" className={`flex flex-col gap-1.5 rounded-[20px] px-3 pt-2 pb-2.5 ${HUD_GLASS}`}>
          <div className="flex items-baseline justify-between gap-2">
            {race ? (
              <span className="lc-disp text-[26px] leading-none text-[#F5F7FA]">
                P{race.position}
                <span className="text-[16px] text-[#8E96AA]">/{race.standings.length}</span>
              </span>
            ) : (
              <span className="lc-disp text-[22px] leading-none text-[#F5F7FA]">Lap {Math.max(1, t.lapCount)}</span>
            )}
            {race ? (
              <span className={HUD_LBL}>
                Lap {race.lap}
                {race.totalLaps ? `/${race.totalLaps}` : ""}
              </span>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`lc-data text-[17px] leading-none tabular-nums ${lapInvalid ? "text-[#FF2A3C]" : "text-[#F5F7FA]"}`}>
              {formatLapTime(t.currentLapTimeMs)}
            </span>
            <span
              className="lc-data inline-flex h-[22px] w-[66px] shrink-0 items-center justify-center rounded-full text-[11px] whitespace-nowrap text-[#08090D] tabular-nums"
              style={{ backgroundColor: deltaS === null ? "#1B1F2B" : deltaColor(deltaS), color: deltaS === null ? "#8E96AA" : "#08090D" }}
            >
              {deltaS === null ? "--.---" : formatDelta(Math.max(-9.999, Math.min(9.999, deltaS)))}
            </span>
          </div>
          <span className={`${HUD_LBL} flex justify-between`}>
            Best <span className="text-[#B845FF] tabular-nums">{formatLapTime(t.bestLapTimeMs)}</span>
          </span>
        </section>
      </div>
    </div>
  );
};
