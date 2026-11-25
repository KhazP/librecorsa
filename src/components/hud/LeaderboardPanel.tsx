"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { boardChoiceOf, boardChoiceOfLap, boardChoices, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { LapTelemetryAnalysis, type LapTelemetryAnalysisProps } from "./LapTelemetryAnalysis";
import { boardLabel } from "@/lib/net/leaderboard";
import { Button, Card, IconButton, EmptyState, Segmented, Select, SettingRow, Toast } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { OnlineBoard, type BoardCarTag } from "@/components/board/OnlineBoard";
import { LapConditionBadges } from "@/components/board/LapConditionBadges";
import { BoardTable, type BoardRow } from "@/components/board/board-table";
import { formatDelta, formatLapTime } from "./hud-format";

// The board table's parts live with the online board (src/components/board): the weekly challenge reads them from here
export { BoardError, BoardSkeleton, BoardTable, MyPlace, type BoardRow } from "@/components/board/board-table";

/** The button that races a lap's ghost: a round icon button in a row (`label`: what it races, for a screen reader) */
const RaceGhost: React.FC<{ onClick: () => void; label: string; title: string }> = ({ onClick, label, title }) => (
  <IconButton size="sm" variant="secondary" icon={<Icon name="ghost" />} aria-label={label} title={title} onClick={onClick} />
);

export interface LeaderboardPanelProps {
  trackName: string;
  /** The loaded circuit (laps on it can be raced as a ghost) */
  trackId?: string;
  /** A circuit's name, for the circuit switcher */
  trackNameOf?: (id: string) => string;
  /** Every circuit the online board's picker offers, in order (the loaded one is put first) */
  circuits?: readonly { id: string; label: string }[];
  vehicleLabel: (id: string) => string;
  /** A car's short name and class colour, for the rows of the all-cars board */
  carTag?: (vehicle: VehicleModelId) => BoardCarTag;
  /** This car's best laps on this circuit, saved in this browser */
  local: LeaderboardEntry[];
  /**
   * In a drive: the laps the Analysis view compares (this car on this circuit), and whether the panel opens on it (the
   * lap card's Analyse button). Without it the panel shows lap times only
   */
  analysis?: LapTelemetryAnalysisProps & { openOnAnalysis?: boolean };
  /** Every personal best saved in this browser, any circuit and car: lets the panel switch circuit and car */
  loadAllLocal?: () => Promise<LeaderboardEntry[]>;
  /** This site has an online board */
  remoteEnabled: boolean;
  /**
   * Without an online board, why: turned off, not reached (the game keeps asking), or not asked yet (nothing is said
   * until the first answer)
   */
  remoteStatus?: "off" | "unreachable" | "unknown";
  /** Changes when the online board may have changed (a lap went up): it is read again */
  boardVersion?: number;
  /** The car being driven: the online board's "My car" */
  vehicle?: string;
  /** The player's name, to mark their row */
  driverName?: string;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
  /** Applies the car setup saved with a local or online lap */
  onApplySetup?: (entry: LeaderboardEntry) => Promise<void> | void;
  /** Latest feedback banner after applying a setup from a leaderboard row */
  setupNotice?: { text: string; undo?: () => void } | null;
  onDismissSetupNotice?: () => void;
  /** Whether a saved best is on its online board (leaderboard.ts `boardStatusOf`); null for a lap that can't go on one */
  boardStatus?: (entry: LeaderboardEntry) => { posted: true } | { posted: false; error: string | null } | null;
  /** Posts a saved best that isn't on its online board; resolves with the board's answer */
  onPostLap?: (entry: LeaderboardEntry) => Promise<{ ok: boolean; error?: string }>;
  onImportGhost?: (file: File) => void;
  onExportBest?: () => void;
  /** Driver key (claims the name on the online board): export to a file, import from one, and the last result */
  onExportDriverKey?: () => void;
  onImportDriverKey?: (file: File) => void;
  driverKeyNotice?: string | null;
  /** Opens Settings > Profile and data > Account: given only while accounts are on and this device is signed out */
  onSignIn?: () => void;
  /** External jump request (e.g. clicking a Fastest Lap record in Hall of Fame) */
  jumpTarget?: { trackId: string; vehicle: VehicleModelId; seq: number } | null;
}

const ALL_CARS = "all";
const NEUTRAL_TAG = (vehicle: VehicleModelId): BoardCarTag => ({ label: vehicle, color: "slate" });

/**
 * The board of its circuit a saved best is listed under (lap-types.ts `BoardChoice.id`): a best from before every board
 * the picker names (or without its conditions) goes with the oldest
 */
const boardOfLap = (e: LeaderboardEntry): string => {
  const choices = boardChoices(e.trackId);
  return (e.conditions ? boardChoiceOfLap(e.trackId, e.vehicle, e.conditions.physicsVersion) : null) ?? choices[choices.length - 1].id;
};

/**
 * Lap times: the circuit's online board a page at a time (src/components/board/OnlineBoard.tsx), whose circuit picker
 * and board (physics version) the rest follows, then the player's best laps by car on that circuit and board, with
 * sector splits (the fastest of each column marked), the best sectors put together, and a ghost to race. Without an
 * online board, the best laps have their own picker once there are laps of an older board.
 */
export const LeaderboardPanel: React.FC<LeaderboardPanelProps> = ({
  trackName,
  trackId,
  trackNameOf,
  circuits: circuitList,
  vehicleLabel,
  carTag = NEUTRAL_TAG,
  local,
  analysis,
  loadAllLocal,
  remoteEnabled,
  remoteStatus = "off",
  boardVersion = 0,
  vehicle,
  driverName = "",
  onRaceGhost,
  onApplySetup,
  setupNotice = null,
  onDismissSetupNotice,
  boardStatus,
  onPostLap,
  onImportGhost,
  onExportBest,
  onExportDriverKey,
  onImportDriverKey,
  driverKeyNotice = null,
  onSignIn,
  jumpTarget = null,
}) => {
  const tx = useTranslations("hud.leaderboardPanel");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keyFileRef = useRef<HTMLInputElement | null>(null);
  // Laps on their way to the online board from here, by lap. An answer redraws the rows (their state is in storage);
  // a refusal also stays here, for one that never reached storage (the lap no longer saved)
  const [posting, setPosting] = useState<ReadonlySet<string>>(() => new Set());
  const [postErrors, setPostErrors] = useState<Readonly<Record<string, string>>>({});
  const txa = useTranslations("hud.lapAnalysis");
  const [view, setView] = useState<"times" | "analysis">(analysis?.openOnAnalysis ? "analysis" : "times");
  const postLap = (e: LeaderboardEntry, id: string) => {
    if (!onPostLap || posting.has(id)) return;
    setPosting((s) => new Set(s).add(id));
    void onPostLap(e)
      .catch((): { ok: boolean; error?: string } => ({ ok: false, error: tx("postUnreachable") }))
      .then((res) => {
        setPosting((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        setPostErrors((m) => {
          const next = { ...m };
          if (res.ok || !res.error) delete next[id];
          else next[id] = res.error;
          return next;
        });
      });
  };

  // Every saved best, reloaded when this circuit's list changes (a new lap was saved)
  const [allLocal, setAllLocal] = useState<LeaderboardEntry[] | null>(null);
  useEffect(() => {
    if (!loadAllLocal) return;
    let live = true;
    loadAllLocal()
      .then((laps) => {
        if (live) setAllLocal(laps);
      })
      .catch(() => {
        if (live) setAllLocal(null);
      });
    return () => {
      live = false;
    };
  }, [loadAllLocal, local]);

  const here = trackId ?? local[0]?.trackId ?? "";
  const [circuit, setCircuit] = useState(jumpTarget?.trackId ?? here);
  const [car, setCar] = useState<string>(ALL_CARS);
  const [scopeOverride, setScopeOverride] = useState<{ scope: "mine" | "all"; seq: number } | null>(() =>
    jumpTarget ? { scope: jumpTarget.vehicle === vehicle ? "mine" : "all", seq: jumpTarget.seq } : null,
  );
  useEffect(() => {
    if (!jumpTarget) return;
    setCircuit(jumpTarget.trackId);
    setScopeOverride({ scope: jumpTarget.vehicle === vehicle ? "mine" : "all", seq: jumpTarget.seq });
  }, [jumpTarget, vehicle]);
  /**
   * The board the online board and the best laps show (lap-types.ts `BoardChoice`): a physics version, or a circuit's
   * board from before it started again. Picked by id, and found again on each circuit
   */
  const [boardPick, setBoardPick] = useState<string | null>(null);
  const choices = useMemo(() => boardChoices(circuit), [circuit]);
  const choice = boardChoiceOf(circuit, boardPick);
  const older = !choice.current;
  const allPool = allLocal ?? local;
  const nameOf = (id: string) => (id === here ? trackName : (trackNameOf?.(id) ?? id));

  /** Circuits with laps saved here, of any physics version (the picker without an online board) */
  const localCircuits = useMemo(() => {
    const ids = [...new Set(allPool.map((e) => e.trackId))];
    if (here && !ids.includes(here)) ids.push(here);
    return ids
      .map((id) => ({ id, label: id === here ? trackName : (trackNameOf?.(id) ?? id), count: allPool.filter((e) => e.trackId === id).length }))
      .sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : a.label.localeCompare(b.label)));
  }, [allPool, here, trackName, trackNameOf]);
  /** Every circuit, the loaded one first (the online board's picker), and any with laps here this build no longer lists */
  const boardCircuits = useMemo(() => {
    const listed = circuitList ?? [];
    const extra = localCircuits.filter((c) => !listed.some((l) => l.id === c.id)).map(({ id, label }) => ({ id, label }));
    const all = [...listed, ...extra];
    const loaded = all.find((c) => c.id === here);
    return loaded ? [loaded, ...all.filter((c) => c.id !== here)] : all;
  }, [circuitList, localCircuits, here]);

  /** Without an online board, the best laps' own picker shows once a best of an older board is saved on this circuit */
  const localPicker = !remoteEnabled && (older || allPool.some((e) => e.trackId === circuit && boardOfLap(e) !== choices[0].id));
  /** The saved bests on this circuit and board: a lap time is only compared with laps on the same physics and circuit */
  const onCircuit = useMemo(() => allPool.filter((e) => e.trackId === circuit && boardOfLap(e) === choice.id), [allPool, circuit, choice.id]);
  const cars = useMemo(() => {
    const ids: string[] = [...new Set(onCircuit.map((e) => e.vehicle))];
    return [
      { id: ALL_CARS, label: tx("allCars"), count: onCircuit.length },
      ...ids.map((id) => ({ id, label: vehicleLabel(id), count: onCircuit.filter((e) => e.vehicle === id).length })),
    ];
  }, [onCircuit, vehicleLabel, tx]);
  const carShown = cars.some((c) => c.id === car) ? car : ALL_CARS;

  // Fastest first, whatever order the caller passed
  const rows = useMemo(
    () => onCircuit.filter((e) => carShown === ALL_CARS || e.vehicle === carShown).sort((a, b) => a.lapTimeMs - b.lapTimeMs),
    [onCircuit, carShown],
  );
  const bestSector = [0, 1, 2].map((i) => {
    const times = rows.map((r) => r.sectorTimesMs[i]).filter((t) => t > 0);
    return times.length ? Math.min(...times) : 0;
  });
  const theoretical = bestSector.every((t) => t > 0) ? bestSector[0] + bestSector[1] + bestSector[2] : 0;
  const bestLap = rows[0]?.lapTimeMs ?? 0;
  const toFind = theoretical && bestLap ? (theoretical - bestLap) / 1000 : 0;

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear so picking the same file again still fires onChange
    e.target.value = "";
    if (file && onImportGhost) onImportGhost(file);
  };
  const handleKeyFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file && onImportDriverKey) onImportDriverKey(file);
  };

  const localRows: BoardRow[] = rows.map((e, i) => {
    const board = e.conditions ? boardLabel(e.conditions) : null;
    // A best that never made its online board says so, and why its last upload failed, with a button to send it
    const status = remoteEnabled && boardStatus ? boardStatus(e) : null;
    const id = `${e.trackId}|${e.vehicle}|${e.recordedAt}`;
    const unposted = status && !status.posted ? { error: status.error ?? postErrors[id] ?? null } : null;
    const sending = posting.has(id);
    const ghost =
      Boolean(onRaceGhost) && e.trackId === here ? (
        <RaceGhost label={tx("raceGhost", { car: vehicleLabel(e.vehicle) })} title={tx("raceGhostTitle")} onClick={() => onRaceGhost?.(e)} />
      ) : null;
    const setupBtn =
      onApplySetup && (e.hasSetup || e.setup) && (!vehicle || e.vehicle === vehicle) ? (
        <IconButton
          size="sm"
          variant="secondary"
          icon={<Icon name="garage" />}
          aria-label={tx("applySetup", { car: vehicleLabel(e.vehicle) })}
          title={tx("applySetupTitle")}
          onClick={() => void onApplySetup(e)}
        />
      ) : null;
    // Worded where the list has room, an icon in a narrow one (a phone), where the ghost button must still fit
    const post =
      unposted && onPostLap ? (
        <>
          <span className="hidden @lg:inline-flex">
            <Button size="sm" variant="secondary" loading={sending} disabled={sending} onClick={() => postLap(e, id)}>
              {unposted.error ? tx("retry") : tx("post")}
            </Button>
          </span>
          <span className="inline-flex @lg:hidden">
            <IconButton
              size="sm"
              variant="secondary"
              icon={<Icon name={unposted.error ? "refresh" : "online"} />}
              aria-label={unposted.error ? tx("retryAria") : tx("postAria")}
              title={unposted.error ? tx("retryTitle") : tx("postTitle")}
              disabled={sending}
              aria-busy={sending || undefined}
              onClick={() => postLap(e, id)}
            />
          </span>
        </>
      ) : null;
    return {
      key: `${e.trackId}-${e.vehicle}-${e.recordedAt}-${i}`,
      rank: i + 1,
      title: vehicleLabel(e.vehicle),
      meta: e.conditions ? (
        <LapConditionBadges assists={e.conditions.assists} realism={e.conditions.realism} surface={e.conditions.surface} />
      ) : undefined,
      detail: new Date(e.recordedAt).toLocaleDateString(),
      detailTitle: `${board ? `${board} · ` : ""}${new Date(e.recordedAt).toLocaleString()}`,
      lapMs: e.lapTimeMs,
      fastest: i === 0 && rows.length > 1,
      sectorsMs: e.sectorTimesMs,
      bestSectors: e.sectorTimesMs.map((s, k) => s > 0 && s === bestSector[k] && rows.length > 1),
      note: unposted ? (
        unposted.error ? (
          <span className="text-lc-amber">{tx("notPosted", { error: unposted.error })}</span>
        ) : (
          <span className="text-lc-slate">{tx("notPostedYet")}</span>
        )
      ) : undefined,
      action:
        post || setupBtn || ghost ? (
          <span className="inline-flex items-center gap-1.5">
            {post}
            {setupBtn}
            {ghost}
          </span>
        ) : undefined,
    };
  });

  const myCar = vehicle && isVehicleModelId(vehicle) ? { vehicle, label: vehicleLabel(vehicle) } : undefined;
  const driverKey =
    onExportDriverKey || onImportDriverKey ? (
      <div className="flex flex-col gap-2.5 border-t border-lc-line pt-3.5">
        <h4 className="lc-row-label m-0">{tx("driverKey")}</h4>
        <p className="lc-hint m-0 max-w-[62ch]">{tx("driverKeyIntro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {onExportDriverKey ? (
            <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={onExportDriverKey}>
              {tx("exportKey")}
            </Button>
          ) : null}
          {onImportDriverKey ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => keyFileRef.current?.click()}>
                {tx("importKey")}
              </Button>
              <input ref={keyFileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleKeyFile} />
            </>
          ) : null}
          {onSignIn ? (
            <Button size="sm" variant="secondary" icon={<Icon name="profile" />} onClick={onSignIn}>
              {tx("signIn")}
            </Button>
          ) : null}
          {driverKeyNotice ? (
            <span role="status" className="text-[13px] text-lc-chalk">
              {driverKeyNotice}
            </span>
          ) : null}
        </div>
        {/* An account carries the names and best laps to every device, the job the key file does by hand */}
        {onSignIn ? <p className="lc-hint m-0 max-w-[62ch]">{tx("signInHint")}</p> : null}
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-3 text-lc-chalk">
      {analysis ? (
        <Segmented
          aria-label={txa("viewLabel")}
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { id: "times", label: txa("tabTimes") },
            { id: "analysis", label: txa("tabAnalysis") },
          ]}
        />
      ) : null}

      {analysis && view === "analysis" ? (
        <LapTelemetryAnalysis best={analysis.best} latest={analysis.latest} session={analysis.session} turns={analysis.turns} />
      ) : (
        <>
      {/* Toolbar: the sheet around the panel already names it, and the board below names the circuit */}
      {onImportGhost || onExportBest ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onImportGhost ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                {tx("importGhost")}
              </Button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
            </>
          ) : null}
          {onExportBest ? (
            <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={onExportBest}>
              {tx("exportBest")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {setupNotice ? (
        <div role="status">
          <Toast
            tone="neutral"
            className="w-full"
            action={
              <span className="flex items-center gap-1">
                {setupNotice.undo ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setupNotice.undo?.();
                      onDismissSetupNotice?.();
                    }}
                  >
                    {tx("undo")}
                  </Button>
                ) : null}
                {onDismissSetupNotice ? (
                  <IconButton size="sm" variant="ghost" aria-label={tx("dismiss")} icon={<Icon name="close" />} onClick={onDismissSetupNotice} />
                ) : null}
              </span>
            }
          >
            {setupNotice.text}
          </Toast>
        </div>
      ) : null}

      {/* The online board: its circuit picker sets the circuit for the whole panel */}
      {remoteEnabled ? (
        <OnlineBoard
          title={tx("onlineTimes")}
          circuits={boardCircuits}
          circuit={circuit}
          onCircuitChange={setCircuit}
          myCar={myCar}
          carTag={carTag}
          driverName={driverName}
          boardVersion={boardVersion}
          onRaceGhost={onRaceGhost}
          onApplySetup={onApplySetup}
          ghostCircuit={here}
          footer={driverKey}
          boardChoice={choice.id}
          onBoardChoiceChange={setBoardPick}
          scopeOverride={scopeOverride}
        />
      ) : localCircuits.length > 1 ? (
        <SettingRow label={tx("circuit")}>
          <Select
            className="w-64 max-w-full"
            value={circuit}
            onChange={setCircuit}
            options={localCircuits.map((c) => ({ id: c.id, label: c.label, detail: tx("circuitLaps", { count: c.count }) }))}
          />
        </SettingRow>
      ) : null}

      {/* Your laps */}
      <Card
        title={tx("yourBestLaps")}
        description={older ? `${nameOf(circuit)} · ${choice.label}` : nameOf(circuit)}
        action={
          cars.length > 2 || localPicker ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {localPicker ? (
                choices.length <= 2 ? (
                  <Segmented aria-label={tx("physicsVersion")} size="sm" value={choice.id} onChange={setBoardPick} options={choices} />
                ) : (
                  <Select aria-label={tx("physicsVersion")} className="w-56 max-w-full" value={choice.id} onChange={setBoardPick} options={choices} />
                )
              ) : null}
              {cars.length > 2 ? (
                <Select
                  aria-label={tx("car")}
                  className="w-56 max-w-full"
                  value={carShown}
                  onChange={setCar}
                  options={cars.map((c) => ({ id: c.id, label: c.label, detail: tx("carLaps", { count: c.count }) }))}
                />
              ) : null}
            </div>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={<Icon name="lapTimes" />}>
            {older ? tx("noLapsOlder", { circuit: nameOf(circuit), board: choice.label }) : tx("noLaps", { circuit: nameOf(circuit) })}
          </EmptyState>
        ) : (
          <BoardTable
            label={tx("tableLabel", { circuit: nameOf(circuit) })}
            nameHeader={tx("carColumn")}
            rows={localRows}
            footer={
              theoretical && rows.length > 1 ? (
                <div className="mt-1 flex items-center justify-between gap-4 rounded-lc-row bg-white/3 px-2 py-2.5">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[14px] font-semibold text-lc-chalk">{tx("theoreticalBest")}</span>
                    <span className="lc-hint">{toFind < 0 ? tx("potential", { delta: formatDelta(toFind) }) : tx("allBestSectors")}</span>
                  </span>
                  <span className="lc-mono text-[15px] font-bold text-lc-fog">{formatLapTime(theoretical)}</span>
                </div>
              ) : null
            }
          />
        )}
      </Card>

      {remoteEnabled || remoteStatus === "unknown" ? null : (
        <p className="lc-hint m-0 px-1">
          {remoteStatus === "unreachable" ? tx("offline") : tx("disabled")}
        </p>
      )}
        </>
      )}
    </div>
  );
};
