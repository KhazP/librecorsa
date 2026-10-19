"use client";

import React, { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";
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

/** Colour of the time / gap value */
function timeColor(r: RaceResultEntry): string {
  if (r.position === 1) return HUD_VOLT;
  if (r.dnf) return HUD_RED;
  if (r.finishTimeS === null) return HUD_CYAN;
  if (r.lapsDown > 0) return "#C5CBD8";
  return "#F5F7FA";
}

/** "+3s" pill: time penalties already added to the race time */
const PenaltyBadge: React.FC<{ seconds: number; className?: string }> = ({ seconds, className = "mr-2" }) => (
  <span
    title={`${seconds.toFixed(1)} s of time penalties (track limits), included in the time`}
    className={`inline-flex h-[18px] items-center rounded-full px-1.5 align-[1px] font-f1-mono text-[9px] font-extrabold tracking-[0.06em] ${className}`}
    style={{ backgroundColor: HUD_RED, color: "#F5F7FA" }}
  >
    +{seconds % 1 === 0 ? seconds.toFixed(0) : seconds.toFixed(1)}s PEN
  </span>
);

const BUTTON_BASE =
  "inline-flex h-[46px] cursor-pointer items-center gap-2 rounded-full px-5 text-[14px] font-bold transition-colors short:h-10";

const TH = "px-2.5 pb-2 font-f1-mono text-[9px] font-extrabold tracking-[0.16em] text-[#8E96AA] uppercase";

/** One podium step: P1 in the middle and tallest, the player in volt */
const PodiumStep: React.FC<{
  r: RaceResultEntry;
  text: string;
  fastest: boolean;
}> = ({ r, text, fastest }) => {
  const p1 = r.position === 1;
  const look = r.isPlayer
    ? {
        background: "linear-gradient(180deg, rgba(204,255,0,0.16), rgba(204,255,0,0.05))",
        border: "1.5px solid #CCFF00",
        num: HUD_VOLT,
      }
    : p1
      ? {
          background: "linear-gradient(180deg, rgba(245,247,250,0.1), rgba(245,247,250,0.03))",
          border: "1px solid rgba(245,247,250,0.25)",
          num: "#F5F7FA",
        }
      : { background: "rgba(255,255,255,0.03)", border: "1px solid #262B3D", num: "#8E96AA" };
  const height = p1 ? "h-[186px]" : r.position === 2 ? "h-[150px]" : "h-[128px]";
  return (
    <div
      className={`lc-rise relative flex min-w-0 flex-col justify-end gap-1.5 rounded-t-[24px] rounded-b-[14px] p-4 ${height} compact:h-auto compact:min-h-[112px]`}
      // P1 rises first, then P2, then P3
      style={{ background: look.background, border: look.border, animationDelay: `${p1 ? 0 : r.position === 2 ? 100 : 200}ms` }}
    >
      <span
        className={`lc-disp absolute top-3 right-4 ${p1 ? "text-[60px]" : r.position === 2 ? "text-[44px]" : "text-[40px]"} compact:text-[36px]`}
        style={{ color: look.num }}
      >
        {r.position}
      </span>
      <span
        className="lc-data inline-flex items-center gap-2 text-[13px] tracking-[0.12em]"
        style={{ color: r.isPlayer ? HUD_VOLT : "#F5F7FA" }}
      >
        <span
          aria-hidden
          className="h-4 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: r.isPlayer ? HUD_VOLT : r.teamColorHex }}
        />
        {r.driverCode}
      </span>
      <span className={`truncate font-bold ${p1 ? "text-[19px]" : "text-[17px]"}`}>
        {r.name}
        {r.isPlayer ? <span className="text-[12px] text-[#CCFF00]"> · you</span> : null}
      </span>
      <span className={`lc-data ${p1 ? "text-[18px]" : "text-[15px]"}`} style={{ color: timeColor(r) }}>
        {text}
      </span>
      <span className="lc-data text-[11px] text-[#8E96AA]">
        BEST <span style={{ color: fastest ? HUD_PURPLE : undefined }}>{formatLapTime(r.bestLapMs)}</span>
        {r.penaltyS ? <PenaltyBadge seconds={r.penaltyS} className="ml-2" /> : null}
      </span>
    </div>
  );
};

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
  /** The player's track-limits strikes this race */
  trackLimitStrikes?: number;
}> = ({ race, trackName, onClose, onRestart, onBackToLobby, trackLimitStrikes = 0 }) => {
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
  const isFastest = (r: RaceResultEntry) => r.bestLapMs !== null && r.bestLapMs === fastestMs;
  // Podium order on screen: P2, P1, P3
  const podium = [ordered[1], ordered[0], ordered[2]];

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[#08090D]/55 p-4">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Race result"
        className="pointer-events-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-[760px] flex-col gap-[18px] overflow-hidden rounded-[30px] border border-white/8 bg-[#0A0B10]/92 px-[26px] pt-6 pb-[22px] text-[#F5F7FA] shadow-[0_40px_100px_rgba(0,0,0,0.65)] backdrop-blur-[20px] short:gap-3 short:px-4 short:pt-4 short:pb-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="h-[34px] w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: final ? HUD_VOLT : HUD_YELLOW }}
            />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="lc-lbl !text-[9px] !font-extrabold !tracking-[0.18em]">
                Race result{race.totalLaps ? ` · ${race.totalLaps} laps` : ""}
              </span>
              <h1 className="lc-disp m-0 truncate text-[24px] sm:text-[30px]">{trackName}</h1>
            </div>
          </div>
          <span className="flex shrink-0 items-center gap-2">
          {trackLimitStrikes > 0 ? (
            <span
              className="lc-data inline-flex h-7 items-center rounded-full px-3 text-[11px] tracking-[0.1em]"
              style={{ boxShadow: `inset 0 0 0 1px ${HUD_YELLOW}`, color: HUD_YELLOW }}
              title="Track-limits strikes: every third is a time penalty"
            >
              TRACK LIMITS ×{trackLimitStrikes}
            </span>
          ) : null}
          <span
            className="lc-data inline-flex h-7 shrink-0 items-center rounded-full px-3.5 text-[11px] tracking-[0.12em]"
            style={
              final
                ? { backgroundColor: HUD_VOLT, color: "#08090D" }
                : { boxShadow: `inset 0 0 0 1px ${HUD_YELLOW}`, color: HUD_YELLOW }
            }
          >
            {final ? "FINAL" : "PROVISIONAL"}
          </span>
          </span>
        </div>

        <div className="-mx-1 flex min-h-0 flex-col gap-[18px] overflow-y-auto px-1">
          {/* Podium */}
          <div className="grid grid-cols-[1fr_1.15fr_1fr] items-end gap-2.5 short:hidden">
            {podium.map((r, i) =>
              r ? (
                <PodiumStep key={`${r.position}-${r.driverCode}`} r={r} text={timeOrGap(r, final)} fastest={isFastest(r)} />
              ) : (
                <span key={`empty-${i}`} aria-hidden />
              ),
            )}
          </div>

          <table className="w-full border-collapse text-left" aria-label="Full classification">
            <thead className="sticky top-0 z-[1] bg-[#0A0B10]">
              <tr>
                <th className={`${TH} w-10`}>Pos</th>
                <th className="w-2 p-0" />
                <th className={TH}>Code</th>
                <th className={TH}>Name</th>
                <th className={`${TH} text-right`}>Laps</th>
                <th className={`${TH} text-right`}>Time / gap</th>
                <th className={`${TH} text-right`}>Best lap</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, i) => (
                <tr
                  key={`${r.position}-${r.driverCode}-${i}`}
                  className={`h-10 font-f1-mono text-[13px] font-extrabold tabular-nums short:h-8 ${
                    r.isPlayer ? "bg-[#CCFF00]/10 shadow-[inset_3px_0_0_#CCFF00]" : i % 2 ? "bg-white/[0.02]" : ""
                  }`}
                >
                  <td className="px-2.5" style={{ color: r.isPlayer ? HUD_VOLT : "#8E96AA" }}>
                    {r.position}
                  </td>
                  <td className="p-0">
                    <span
                      className="block h-4 w-1 rounded-full"
                      style={{ backgroundColor: r.isPlayer ? HUD_VOLT : r.teamColorHex }}
                    />
                  </td>
                  <td className="px-2.5 tracking-[0.1em]" style={{ color: r.isPlayer ? HUD_VOLT : "#F5F7FA" }}>
                    {r.driverCode}
                  </td>
                  <td
                    className="px-2.5 text-[14px] font-semibold tracking-normal"
                    style={{ fontFamily: "var(--font-titillium), sans-serif" }}
                  >
                    <span className="block max-w-[180px] truncate">{r.name}</span>
                  </td>
                  <td className="px-2.5 text-right text-[#C5CBD8]">{r.lapsCompleted}</td>
                  <td className="px-2.5 text-right whitespace-nowrap" style={{ color: timeColor(r) }}>
                    {r.penaltyS ? <PenaltyBadge seconds={r.penaltyS} /> : null}
                    {timeOrGap(r, final)}
                  </td>
                  <td className="px-2.5 text-right" style={{ color: isFastest(r) ? HUD_PURPLE : "#F5F7FA" }}>
                    {formatLapTime(r.bestLapMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[#262B3D] pt-3.5">
          <PromptBar
            className="mr-auto"
            prompts={[
              { action: "select", label: "Select" },
              { action: "back", label: "Close" },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {onRestart ? (
              <button
                type="button"
                onClick={onRestart}
                className={`${BUTTON_BASE} border-0 bg-[#CCFF00] text-[#08090D] hover:bg-[#d9ff33]`}
              >
                <RotateCcw className="h-4 w-4" strokeWidth={2.6} aria-hidden />
                Restart race
              </button>
            ) : null}
            {onBackToLobby ? (
              <button
                type="button"
                onClick={onBackToLobby}
                className={`${BUTTON_BASE} border border-[#00E5FF]/50 bg-[#00E5FF]/8 text-[#00E5FF] hover:bg-[#00E5FF]/15`}
              >
                Back to lobby
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className={`${BUTTON_BASE} border border-[#262B3D] bg-[#1B1F2B] text-[#F5F7FA] hover:border-[#3A4157] hover:bg-[#262B3D]`}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
