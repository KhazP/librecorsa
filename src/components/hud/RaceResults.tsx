"use client";

import React, { useEffect, useRef } from "react";
import { useFocusNav } from "@/components/menu/useFocusNav";
import { PromptBar } from "@/components/menu/menu-ui";
import type { RaceResultEntry, RaceStatus } from "@/types/f1";
import { HUD_CYAN, HUD_PURPLE, HUD_RED, HUD_VOLT, HUD_YELLOW, formatLapTime } from "./hud-format";

/** Race time at the flag: m:ss.mmm, or h:mm:ss.mmm past one hour */
function formatRaceTime(totalS: number): string {
  const totalMs = Math.round(totalS * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  const rest = `${sec.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  return hr > 0 ? `${hr}:${min.toString().padStart(2, "0")}:${rest}` : `${min}:${rest}`;
}

/** Time / gap column: winner's total time, "+12.345", "+1 LAP" / "+n LAPS", RUNNING or DNF */
function timeOrGap(r: RaceResultEntry, resultsFinal: boolean): string {
  if (r.dnf) return "DNF";
  if (r.finishTimeS === null) return resultsFinal ? "DNF" : "RUNNING";
  if (r.position === 1) return formatRaceTime(r.finishTimeS);
  if (r.lapsDown > 0) return r.lapsDown === 1 ? "+1 LAP" : `+${r.lapsDown} LAPS`;
  if (r.gapS !== null) return `+${r.gapS.toFixed(3)}`;
  return formatRaceTime(r.finishTimeS);
}

const BUTTON_BASE =
  "rounded border px-3 py-1.5 font-f1-mono text-[12px] font-bold uppercase tracking-wider transition-colors";

/**
 * Final classification of a race (AI or multiplayer). Renders nothing until `race.results` is set.
 * The backdrop only dims the screen; clicks outside the card still reach the sim.
 */
export const RaceResults: React.FC<{
  race: RaceStatus;
  trackName: string;
  onClose: () => void;
  onRestart?: () => void;
  onBackToLobby?: () => void;
}> = ({ race, trackName, onClose, onRestart, onBackToLobby }) => {
  const results = race.results;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A controller closes the card with Ⓑ and reaches its buttons (Esc is handled below)
  useFocusNav(rootRef, { enabled: Boolean(results), onBack: onClose, keyboardBack: false });

  useEffect(() => {
    if (!results) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [results, onClose]);

  if (!results) return null;

  const final = race.resultsFinal === true;
  const ordered = [...results].sort((a, b) => a.position - b.position);
  const fastestMs = ordered.reduce<number | null>(
    (best, r) => (r.bestLapMs !== null && (best === null || r.bestLapMs < best) ? r.bestLapMs : best),
    null,
  );

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Race result"
        className="hud-panel pointer-events-auto flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[#262B3D] bg-[#11131A] px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="h-4 w-1 shrink-0 rounded-full"
              style={{ backgroundColor: final ? HUD_VOLT : HUD_YELLOW }}
            />
            <span className="hud-num truncate text-[18px] italic tracking-wider text-[#F5F7FA]">
              RACE RESULT · {trackName}
            </span>
          </div>
          <span
            className="shrink-0 rounded-sm px-2 py-0.5 font-f1-mono text-[11px] font-black"
            style={
              final
                ? { backgroundColor: HUD_VOLT, color: "#08090D" }
                : { border: `1px solid ${HUD_YELLOW}`, color: HUD_YELLOW }
            }
          >
            {final ? "FINAL" : "PROVISIONAL"}
          </span>
        </div>

        <div className="overflow-y-auto">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-[#11131A]">
              <tr className="hud-label !text-[9px]">
                <th className="px-2 py-1.5 font-normal">Pos</th>
                <th className="w-2 p-0" />
                <th className="px-2 py-1.5 font-normal">Code</th>
                <th className="px-2 py-1.5 font-normal">Name</th>
                <th className="px-2 py-1.5 text-right font-normal">Laps</th>
                <th className="px-2 py-1.5 text-right font-normal">Time / Gap</th>
                <th className="px-2 py-1.5 text-right font-normal">Best lap</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, i) => {
                const text = timeOrGap(r, final);
                const timeColor = r.position === 1
                  ? HUD_VOLT
                  : r.dnf
                    ? HUD_RED
                    : r.finishTimeS === null
                      ? HUD_CYAN
                      : "#F5F7FA";
                const bestIsFastest = r.bestLapMs !== null && r.bestLapMs === fastestMs;
                return (
                  <tr
                    key={`${r.position}-${r.driverCode}-${i}`}
                    className={`h-8 border-t border-[#262B3D]/50 ${
                      r.isPlayer ? "bg-[#CCFF00]/14" : i % 2 ? "bg-white/[0.02]" : ""
                    }`}
                  >
                    <td
                      className={`hud-num border-l-2 px-2 text-[14px] ${
                        r.isPlayer ? "border-l-[#CCFF00] text-[#CCFF00]" : "border-l-transparent text-[#8E96AA]"
                      }`}
                    >
                      {r.position}
                    </td>
                    <td className="p-0">
                      <span
                        className="block h-4 w-1 rounded-full"
                        style={{ backgroundColor: r.isPlayer ? HUD_VOLT : r.teamColorHex }}
                      />
                    </td>
                    <td
                      className={`hud-num px-2 text-[14px] tracking-wider ${
                        r.isPlayer ? "text-[#CCFF00]" : "text-[#F5F7FA]"
                      }`}
                    >
                      {r.driverCode}
                    </td>
                    <td className="px-2 text-[13px] text-[#F5F7FA]/90">
                      <span className="block max-w-[180px] truncate">{r.name}</span>
                    </td>
                    <td className="px-2 text-right font-f1-mono text-[12px] tabular-nums text-[#8E96AA]">
                      {r.lapsCompleted}
                    </td>
                    <td
                      className="hud-num whitespace-nowrap px-2 text-right text-[14px] tabular-nums"
                      style={{ color: timeColor }}
                    >
                      {text}
                    </td>
                    <td
                      className="px-2 text-right font-f1-mono text-[12px] font-bold tabular-nums"
                      style={{ color: bestIsFastest ? HUD_PURPLE : "#F5F7FA" }}
                    >
                      {formatLapTime(r.bestLapMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#262B3D] bg-[#11131A] px-4 py-2.5">
          <PromptBar
            className="mr-auto"
            prompts={[
              { action: "select", label: "Select" },
              { action: "back", label: "Close" },
            ]}
          />
          {onRestart ? (
            <button
              type="button"
              onClick={onRestart}
              className={`${BUTTON_BASE} border-[#CCFF00] bg-[#CCFF00] text-[#08090D] hover:bg-[#99bf00]`}
            >
              Restart race
            </button>
          ) : null}
          {onBackToLobby ? (
            <button
              type="button"
              onClick={onBackToLobby}
              className={`${BUTTON_BASE} border-[#262B3D] bg-[#08090D] text-[#F5F7FA] hover:border-[#CCFF00] hover:text-[#CCFF00]`}
            >
              Back to lobby
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className={`${BUTTON_BASE} border-[#262B3D] bg-[#08090D] text-[#F5F7FA] hover:border-[#CCFF00] hover:text-[#CCFF00]`}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
