"use client";

import React from "react";
import type { PodiumRow } from "@/lib/render/podium-shot";
import { PlayerTag } from "@/components/ui/badges";

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
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-results) flex cursor-pointer flex-col justify-between bg-linear-to-b from-lc-void/55 via-transparent via-40% to-lc-void/75 pt-[max(1.25rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] text-lc-chalk select-none"
      role="dialog"
      aria-label="Podium"
      // On the click, not the press: the table must not appear under a finger still down and take the tap
      onClick={onSkip}
    >
      <h2 className="lc-panel-in lc-h2 text-center">{trackName}</h2>
      <div className="flex flex-col items-center gap-4">
        <div className="grid w-full max-w-[760px] grid-cols-3 items-end gap-2 sm:gap-4">
          {order.map((r, i) =>
            r ? (
              <div
                key={`${r.position}-${r.driverCode}`}
                className="lc-rise flex min-w-0 flex-col items-center gap-1.5 text-center"
                style={{ animationDelay: `${r.position === 1 ? 150 : r.position === 2 ? 400 : 650}ms` }}
              >
                <span
                  className={`lc-disp ${r.position === 1 ? "text-[44px] sm:text-[64px]" : "text-[32px] sm:text-[46px]"} ${
                    r.isPlayer ? "text-lc-volt" : "text-lc-chalk"
                  }`}
                >
                  {PLACE[r.position]}
                </span>
                <span className="inline-flex max-w-full items-center gap-2">
                  {/* The team's colour: data */}
                  <span aria-hidden className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: r.teamColorHex }} />
                  <span className={`truncate font-bold ${r.position === 1 ? "text-[17px] sm:text-[22px]" : "text-[15px] sm:text-[18px]"}`}>
                    {r.name}
                  </span>
                </span>
                {r.isPlayer && r.name.trim().toLowerCase() !== "you" ? (
                  <PlayerTag size="sm" />
                ) : !r.isPlayer && r.name !== r.driverCode ? (
                  // The code under the name, unless the name is the code (the AI drivers)
                  <span className="lc-mono text-[12px] font-bold tracking-[0.12em] text-lc-slate">{r.driverCode}</span>
                ) : null}
              </div>
            ) : (
              <span key={`empty-${i}`} aria-hidden />
            ),
          )}
        </div>
        <span className="lc-hint text-lc-fog">Tap or press any key to skip</span>
      </div>
    </div>
  );
};
