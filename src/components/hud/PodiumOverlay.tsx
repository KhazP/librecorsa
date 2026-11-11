"use client";

import React from "react";
import type { PodiumRow } from "@/lib/render/podium-shot";
import { HUD_VOLT } from "./hud-format";

const PLACE = ["", "1st", "2nd", "3rd"];

/**
 * Names and places over the podium shot, in the order the cars stand (P2, P1, P3). A tap anywhere skips to the table;
 * keys and pad buttons skip it in the drive itself.
 */
export const PodiumOverlay: React.FC<{ rows: readonly PodiumRow[]; trackName: string; onSkip: () => void }> = ({ rows, trackName, onSkip }) => {
  const byPlace = (p: number) => rows.find((r) => r.position === p);
  const order = [byPlace(2), byPlace(1), byPlace(3)];
  return (
    <div
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-50 flex cursor-pointer flex-col justify-between bg-[linear-gradient(180deg,rgba(8,9,13,0.55)_0%,rgba(8,9,13,0)_22%,rgba(8,9,13,0)_62%,rgba(8,9,13,0.75)_100%)] pt-[max(1.25rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] text-[#F5F7FA] select-none"
      role="dialog"
      aria-label="Podium"
      // On the click, not the press: the table must not appear under a finger still down and take the tap
      onClick={onSkip}
    >
      <div className="lc-panel-in flex flex-col items-center gap-1 text-center">
        <span className="lc-lbl !text-[10px] !tracking-[0.22em]">Podium</span>
        <h1 className="lc-disp m-0 text-[26px] sm:text-[34px]">{trackName}</h1>
      </div>
      <div className="flex flex-col items-center gap-4">
        <div className="grid w-full max-w-[760px] grid-cols-3 items-end gap-2 sm:gap-4">
          {order.map((r, i) =>
            r ? (
              <div
                key={`${r.position}-${r.driverCode}`}
                className="lc-rise flex min-w-0 flex-col items-center gap-1 text-center"
                style={{ animationDelay: `${r.position === 1 ? 150 : r.position === 2 ? 400 : 650}ms` }}
              >
                <span
                  className={`lc-disp ${r.position === 1 ? "text-[44px] sm:text-[64px]" : "text-[32px] sm:text-[46px]"}`}
                  style={{ color: r.isPlayer ? HUD_VOLT : "#F5F7FA" }}
                >
                  {PLACE[r.position]}
                </span>
                <span className="inline-flex max-w-full items-center gap-2">
                  <span aria-hidden className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: r.isPlayer ? HUD_VOLT : r.teamColorHex }} />
                  <span className={`truncate font-bold ${r.position === 1 ? "text-[17px] sm:text-[22px]" : "text-[15px] sm:text-[18px]"}`}>{r.name}</span>
                </span>
                <span className="lc-data text-[11px] tracking-[0.14em]" style={{ color: r.isPlayer ? HUD_VOLT : "#8E96AA" }}>
                  {r.isPlayer ? "YOU" : r.driverCode}
                </span>
              </div>
            ) : (
              <span key={`empty-${i}`} aria-hidden />
            )
          )}
        </div>
        <span className="lc-lbl !text-[9px] opacity-80">Tap or press any key to skip</span>
      </div>
    </div>
  );
};
