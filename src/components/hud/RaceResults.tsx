"use client";

import React, { useEffect, useRef, useState } from "react";
import { useFocusNav } from "@/components/menu/useFocusNav";
import { useHudModeRef } from "./hud-mode";
import { Button, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PenaltyBadge, PlayerTag, PositionBadge } from "@/components/ui/badges";
import { Icon, Trend } from "@/components/ui/icons";
import { PromptBar } from "@/components/ui/prompts";
import type { RaceResultEntry, RaceStatus } from "@/types/f1";
import { STRIKES_PER_PENALTY } from "@/lib/sim/track-limits";
import { formatLapTime } from "./hud-format";
import { placesGained, type RaceRecord } from "@/lib/sim/race-history";
import { countdownLabel, nextRaceSlot } from "@/lib/net/race-schedule";
import { TRACKS } from "@/lib/track-registry";

const ordinal = (n: number) => (n === 2 ? "second" : n === 3 ? "third" : n === 4 ? "fourth" : `${n}th`);

/** Race time at the flag: m:ss.mmm, or h:mm:ss.mmm past one hour */
const formatRaceTime = (totalS: number): string => formatLapTime(Math.round(totalS * 1000));

/** Time / gap column: winner's total time, "+12.345", "+1 lap" / "+n laps", Running or DNF */
function timeOrGap(r: RaceResultEntry, resultsFinal: boolean): string {
  if (r.dnf) return "DNF";
  if (r.finishTimeS === null) return resultsFinal ? "DNF" : "Running";
  if (r.position === 1) return formatRaceTime(r.finishTimeS);
  if (r.lapsDown > 0) return r.lapsDown === 1 ? "+1 lap" : `+${r.lapsDown} laps`;
  if (r.gapS !== null) return `+${r.gapS.toFixed(3)}`;
  return formatRaceTime(r.finishTimeS);
}

/** Colour of the time / gap value: a retirement is a loss, a car still running is information, the rest is plain */
function timeTone(r: RaceResultEntry, resultsFinal: boolean): string {
  if (r.dnf || (r.finishTimeS === null && resultsFinal)) return "text-lc-loss";
  if (r.finishTimeS === null) return "text-lc-info";
  if (r.lapsDown > 0) return "text-lc-fog";
  return "text-lc-chalk";
}

/** Whole seconds when whole, else one decimal (the kit's penalty badge prints the number as given) */
const penaltySeconds = (s: number) => (s % 1 === 0 ? s : Math.round(s * 10) / 10);

/** The player racing the AI is named "You" already: no tag to repeat it */
const isYou = (name: string) => name.trim().toLowerCase() === "you";

const TH = "lc-lbl px-2 pb-2 text-left font-semibold whitespace-nowrap";

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
  /** What going back leads to: the room's lobby, or (after a scheduled race) the races */
  backLabel?: string;
  /** The player's track-limits strikes this race */
  trackLimitStrikes?: number;
  /** The player's last races, newest first (this one included once saved) */
  history?: readonly RaceRecord[];
  /** An open race: the next one to join */
  nextRace?: NextRaceProps;
}> = ({ race, trackName, onClose, onRestart, onBackToLobby, backLabel = "Back to lobby", trackLimitStrikes = 0, history, nextRace }) => {
  const results = race.results;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A controller closes the card with B and reaches its buttons (Esc is handled below)
  // F1TelemetryHud mounts the card only while the HUD is live; the mode check also keeps Esc from closing it from under
  // another screen (the pause menu) if it is ever shown there
  const hudModeRef = useHudModeRef();
  useFocusNav(rootRef, { enabled: Boolean(results), onBack: onClose, keyboardBack: false });

  useEffect(() => {
    if (!results) return;
    // Capture: ahead of the shell's own Esc (pause) on the same press. After it, React can commit the pause between the
    // two listeners and unmount the card first, so Esc only paused and the card came back on resume
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hudModeRef.current === "hidden") return;
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [results, onClose, hudModeRef]);

  // The key that skipped the podium shot, still held or pressed twice, must not press the button the card opens on
  const open = Boolean(results);
  useEffect(() => {
    if (!open) return;
    const openedMs = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && (e.repeat || performance.now() - openedMs < 400)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Tab stays inside the card while it is open
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (e.key !== "Tab" || !root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next].focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!results) return null;

  const final = race.resultsFinal === true;
  const ordered = [...results].sort((a, b) => a.position - b.position);
  const fastestMs = ordered.reduce<number | null>(
    (best, r) => (r.bestLapMs !== null && (best === null || r.bestLapMs < best) ? r.bestLapMs : best),
    null,
  );
  const isFastest = (r: RaceResultEntry) => r.bestLapMs !== null && r.bestLapMs === fastestMs;
  const me = ordered.find((r) => r.isPlayer);
  const showGrid = ordered.some((r) => r.gridPosition !== undefined);
  // One main action: restart where there is one, else the way on, else closing
  const primary = onRestart ? "restart" : nextRace ? "next" : onBackToLobby ? "back" : "close";

  return (
    <div className="lc-ui-zoom pointer-events-none fixed inset-0 z-(--z-lc-results) flex items-center justify-center bg-lc-void/55 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Race result"
        className="lc-glass pointer-events-auto flex max-h-full w-full max-w-[760px] flex-col gap-4 overflow-hidden rounded-lc-sheet p-5 text-lc-chalk shadow-lc-sheet sm:px-6 short:gap-3 short:p-3.5"
      >
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="lc-h2 min-w-0 truncate" title={trackName}>
            {trackName}
          </h2>
          <span className="flex flex-wrap items-center gap-1.5">
            {race.totalLaps ? (
              <Badge variant="outline">
                {race.totalLaps} {race.totalLaps === 1 ? "lap" : "laps"}
              </Badge>
            ) : null}
            {trackLimitStrikes > 0 ? (
              <Badge tone="warn" icon="trackLimits">
                Track limits {trackLimitStrikes}
              </Badge>
            ) : null}
            {final ? (
              <Badge variant="outline" icon="check">
                Final
              </Badge>
            ) : (
              <Badge tone="warn" dot="live">
                Provisional
              </Badge>
            )}
          </span>
        </div>
        {/* What the badges mean, in words on the sheet (a tooltip reaches no keyboard, pad or finger) */}
        {!final || trackLimitStrikes > 0 ? (
          <p className="lc-hint m-0 -mt-2 short:-mt-1.5">
            {[
              final ? null : "Cars are still running: places can change.",
              trackLimitStrikes > 0 ? `Every ${ordinal(STRIKES_PER_PENALTY)} track-limits strike is a time penalty.` : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}

        {me ? <PlayerSummary me={me} fieldSize={ordered.length} fastest={isFastest(me)} /> : null}

        <div className="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto px-1 short:gap-3">
          <table className="w-full border-collapse" aria-label="Full classification">
            <thead>
              <tr className="border-b border-lc-line">
                <th scope="col" className={`${TH} w-14`}>
                  Pos
                </th>
                {showGrid ? (
                  <th scope="col" className={`${TH} w-12`} title="Places gained or lost from the grid">
                    <span aria-hidden>+/-</span>
                    <span className="sr-only">Places gained</span>
                  </th>
                ) : null}
                <th scope="col" className={`${TH} w-full`}>
                  Driver
                </th>
                <th scope="col" className={`${TH} text-right max-sm:hidden`}>
                  Laps
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Time / gap
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Best lap
                </th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r, i) => {
                const fastest = isFastest(r);
                return (
                  <tr
                    key={`${r.position}-${r.driverCode}-${i}`}
                    aria-current={r.isPlayer ? "true" : undefined}
                    className={`h-11 border-b border-white/5 last:border-b-0 short:h-9 ${
                      r.isPlayer ? "bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""
                    }`}
                  >
                    <td className="px-2">
                      <PositionBadge position={r.position} player={r.isPlayer} size="sm" className="min-w-10" />
                    </td>
                    {showGrid ? (
                      <td className="px-2">
                        <PlacesGained gained={r.dnf ? null : placesGained(r.gridPosition, r.position)} />
                      </td>
                    ) : null}
                    <td className="max-w-0 px-2">
                      <span className="flex min-w-0 items-center gap-2.5">
                        {/* The team's colour: data, the one place it shows */}
                        <span aria-hidden className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: r.teamColorHex }} />
                        {r.name !== r.driverCode ? (
                          <span className="lc-mono w-8 shrink-0 text-[12px] font-bold tracking-[0.08em] text-lc-slate">{r.driverCode}</span>
                        ) : null}
                        <span className="truncate text-[14px] font-semibold">{r.name}</span>
                        {r.isPlayer && !isYou(r.name) ? <PlayerTag size="sm" /> : null}
                      </span>
                    </td>
                    <td className="lc-mono px-2 text-right text-[13px] font-bold text-lc-fog max-sm:hidden">{r.lapsCompleted}</td>
                    <td className="px-2 text-right whitespace-nowrap">
                      <span className="inline-flex items-center justify-end gap-2">
                        {r.penaltyS ? (
                          <span title={`${r.penaltyS.toFixed(1)} s of time penalties, included in the time`}>
                            <PenaltyBadge penalty={{ kind: "time", seconds: penaltySeconds(r.penaltyS) }} size="sm" />
                          </span>
                        ) : null}
                        <span className={`lc-mono text-[13px] font-bold ${timeTone(r, final)}`}>{timeOrGap(r, final)}</span>
                      </span>
                    </td>
                    <td className="px-2 text-right whitespace-nowrap">
                      <BestLap ms={r.bestLapMs} fastest={fastest} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {history && history.length > 0 ? <LastRaces history={history} /> : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2.5 border-t border-lc-line pt-3.5 short:pt-2.5">
          <PromptBar
            rule={false}
            className="mr-auto max-sm:hidden"
            prompts={[
              { action: "select", label: "Select" },
              { action: "back", label: "Close" },
            ]}
          />
          <div className="flex flex-wrap justify-end gap-2">
            {nextRace ? <JoinNextRace {...nextRace} primary={primary === "next"} /> : null}
            {onBackToLobby ? (
              <Button variant={primary === "back" ? "primary" : "secondary"} onClick={onBackToLobby}>
                {backLabel}
              </Button>
            ) : null}
            {onRestart ? (
              <Button variant="primary" icon={<Icon name="restart" />} onClick={onRestart}>
                Restart race
              </Button>
            ) : null}
            <Button variant={primary === "close" ? "primary" : "secondary"} onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** A best lap: the race's fastest in the best colour with the lap-time mark beside it, so colour is not alone */
const BestLap: React.FC<{ ms: number | null; fastest: boolean; large?: boolean }> = ({ ms, fastest, large = false }) => (
  <span
    className={`lc-mono inline-flex items-center gap-1.5 font-bold ${large ? "text-[22px]" : "text-[13px]"} ${
      fastest ? "text-lc-best" : "text-lc-chalk"
    }`}
  >
    {fastest && !large ? <Icon name="lapTimes" size="xs" label="Fastest lap" /> : null}
    {formatLapTime(ms)}
  </span>
);

/** Places gained (green, arrow up) or lost (crimson, arrow down) from the grid; "=" unchanged, a dash when not known */
const PlacesGained: React.FC<{ gained: number | null; large?: boolean }> = ({ gained, large = false }) => {
  const size = large ? "text-[22px]" : "text-[13px]";
  if (gained === null || gained === 0)
    return (
      <span className={`lc-mono font-bold ${size} text-lc-slate`} aria-label={gained === 0 ? "No change" : "Not known"}>
        {gained === 0 ? "=" : "-"}
      </span>
    );
  const n = Math.abs(gained);
  const words = `${n} ${n === 1 ? "place" : "places"} ${gained > 0 ? "gained" : "lost"}`;
  return (
    <span
      className={`lc-mono inline-flex items-center gap-1 font-bold whitespace-nowrap ${size} ${gained > 0 ? "text-lc-gain" : "text-lc-loss"}`}
      title={words}
    >
      <Trend direction={gained > 0 ? "up" : "down"} size="0.75em" />
      <span aria-hidden>{n}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
};

/** The player's own race at a glance: the place, the places gained from the grid, the best lap */
const PlayerSummary: React.FC<{ me: RaceResultEntry; fieldSize: number; fastest: boolean }> = ({ me, fieldSize, fastest }) => {
  const gained = me.dnf ? null : placesGained(me.gridPosition, me.position);
  // Each value says what it is in the words under it, with no label above
  const cell = "flex min-w-0 flex-col gap-0.5 px-4 py-2.5 short:px-3 short:py-1.5";
  const after = "lc-hint truncate";
  return (
    <div className="grid grid-cols-3 gap-2.5 short:hidden" aria-label="Your race">
      <Well className={cell}>
        <span className={`lc-mono text-[22px] leading-tight font-bold ${me.dnf ? "text-lc-loss" : "text-lc-volt"}`}>
          {me.dnf ? "DNF" : `P${me.position}`}
        </span>
        <span className={after}>{me.dnf ? "Out of the race" : `of ${fieldSize}`}</span>
      </Well>
      <Well className={cell}>
        <span className="leading-tight">
          <PlacesGained gained={gained} large />
        </span>
        <span className={after}>
          {me.gridPosition === undefined
            ? "Grid not known"
            : gained === null || gained === 0
              ? `From P${me.gridPosition}`
              : `${Math.abs(gained) === 1 ? "place" : "places"} ${gained > 0 ? "gained" : "lost"} from P${me.gridPosition}`}
        </span>
      </Well>
      <Well className={cell}>
        <span className="leading-tight">
          <BestLap ms={me.bestLapMs} fastest={fastest} large />
        </span>
        <span className={after}>{fastest ? "Fastest lap of the race" : "Your best lap"}</span>
      </Well>
    </div>
  );
};

const circuitName = (id: string) => TRACKS.find((t) => t.id === id)?.name ?? id;
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The player's last few races, kept in this browser */
const LastRaces: React.FC<{ history: readonly RaceRecord[] }> = ({ history }) => (
  <section className="flex flex-col gap-2" aria-labelledby="lc-last-races">
    <h2 id="lc-last-races" className="lc-h3 px-2">
      Your last races
    </h2>
    <table className="w-full border-collapse">
      <thead className="sr-only">
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Circuit</th>
          <th scope="col">Finish</th>
          <th scope="col">Places gained</th>
          <th scope="col">Best lap</th>
        </tr>
      </thead>
      <tbody>
        {history.slice(0, 5).map((r) => (
          <tr key={r.id} className="h-9 border-b border-white/5 last:border-b-0 short:h-8">
            <td className="lc-mono w-20 px-2 text-[12px] font-bold whitespace-nowrap text-lc-slate">{shortDate(r.atMs)}</td>
            <td className="max-w-0 px-2">
              <span className="block truncate text-[13px] font-semibold text-lc-fog">{circuitName(r.trackId)}</span>
            </td>
            <td className="lc-mono w-16 px-2 text-[13px] font-bold whitespace-nowrap">
              <span className={r.finish === null ? "text-lc-loss" : "text-lc-chalk"}>{r.finish === null ? "DNF" : `P${r.finish}`}</span>
              <span className="text-lc-slate">/{r.fieldSize}</span>
            </td>
            <td className="w-12 px-2">
              <PlacesGained gained={placesGained(r.grid, r.finish)} />
            </td>
            <td className="lc-mono w-24 px-2 text-right text-[13px] font-bold text-lc-fog">{formatLapTime(r.bestLapMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);

export interface NextRaceProps {
  /** Seconds between scheduled races */
  slotS: number;
  onJoin: () => void;
}

/** "Join the next race", with the time until its lights counting down */
const JoinNextRace: React.FC<NextRaceProps & { primary: boolean }> = ({ slotS, onJoin, primary }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Worked out every tick: past the join cut-off it rolls on to the race after
  const startsMs = nextRaceSlot(now, slotS).startsMs;
  return (
    <Button variant={primary ? "primary" : "secondary"} onClick={onJoin}>
      Join the next race <span className="lc-mono not-italic tabular-nums opacity-80">{countdownLabel(startsMs, now)}</span>
    </Button>
  );
};
