"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CarTelemetry, LiveTunerPatch, TireCompound } from "@/types/f1";
import type { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  formatGap,
  formatLapTime,
  formatPressureDeltaPsi,
  formatPressurePsi,
  formatSectorTime,
  formatTemp,
  HUD_BEST,
  HUD_CAUTION,
  HUD_GLASS,
  HUD_INFO,
  HUD_LBL,
  HUD_SLATE,
  tyreHeatColor,
} from "./hud-format";
import { MfdStatusChips, TunerMfdPanel } from "./TunerMfdPanel";
import { BrakeBar, cornerData, psiDeltaColor, TyreGlyph } from "./TyreBrakeWidget";
import { computeRelatives, fuelStrategy, useLapHistory, type LapRecord, type RelativeRow } from "./mfd-data";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE, LapMarkGlyph } from "./styles/hud-style-parts";
import { useHudModeRef } from "./hud-mode";

export type MfdPageId = "elec" | "rel" | "tyre" | "fuel" | "stnd";

const PAGES: { id: MfdPageId; tag: string; title: string }[] = [
  { id: "elec", tag: "ELEC", title: "Electronics" },
  { id: "rel", tag: "REL", title: "Relative" },
  { id: "tyre", tag: "TYRE", title: "Tyres & brakes" },
  { id: "fuel", tag: "FUEL", title: "Fuel & energy" },
  { id: "stnd", tag: "STND", title: "Standings" },
];

/** D-pad quiet time after which an MFD opened via D-pad folds back to its compact status pill */
const AUTO_FOLD_MS = 3500;
const PAGE_KEY = "lc.mfdPage";
/** A car laps up shows tangerine (let it by), laps down azure (you are lapping it); "+1L" / "−1L" says it too */
const LAP_UP = "var(--color-lc-tangerine)";
const LAP_DOWN = "var(--color-lc-azure)";
/** No value yet */
const NONE = "--";

const LBL = HUD_LBL;

function readPage(): MfdPageId {
  try {
    const v = window.localStorage.getItem(PAGE_KEY);
    if (v && PAGES.some((p) => p.id === v)) return v as MfdPageId;
  } catch {
    // Storage blocked: start on the tuner
  }
  return "elec";
}

const CompoundBadge: React.FC<{ c?: TireCompound }> = ({ c }) =>
  c ? <CompoundGlyph compound={c} size={15} /> : <span className="w-3.75 shrink-0" />;

const PenaltyChip: React.FC<{ s?: number }> = ({ s }) =>
  s && s > 0 ? <PenaltyBadge penalty={{ kind: "time", seconds: Math.round(s) }} size="hud" variant="solid" /> : null;

/* ── Pages ─────────────────────────────────────────────────────────────── */

const RelativePage: React.FC<{ rows: RelativeRow[]; racing: boolean }> = ({ rows, racing }) => {
  if (rows.length <= 1) {
    return <Empty text="No cars on track" />;
  }
  return (
    <ol className="flex flex-col gap-0.75" aria-label="Relative">
      {rows.map((r) => {
        // The player's own row is volt with void ink (every table); laps up / down tint the others
        const tone = r.isPlayer ? undefined : r.lapDiff > 0 ? LAP_UP : r.lapDiff < 0 ? LAP_DOWN : "var(--color-lc-chalk)";
        return (
          <li
            key={r.key}
            className={`lc-data flex h-6 items-center gap-2 rounded-lc-nub px-2 text-[11px] ${
              r.isPlayer ? "bg-lc-volt text-lc-void" : "bg-white/3"
            }`}
          >
            <span className={`w-4.5 text-right text-[10px] ${r.isPlayer ? "" : "text-lc-slate"}`}>{racing && r.position ? r.position : ""}</span>
            <span className="h-3 w-0.75 shrink-0 rounded-full" style={{ backgroundColor: r.isPlayer ? "var(--color-lc-void)" : r.color }} />
            <span className="w-8.5 tracking-[0.06em]" style={{ color: tone }}>
              {r.code}
            </span>
            <CompoundBadge c={r.compound} />
            <span className="w-6.5 text-[9px]" style={{ color: tone }}>
              {r.lapDiff !== 0 ? `${r.lapDiff > 0 ? "+" : "\u2212"}${Math.abs(r.lapDiff)}L` : ""}
            </span>
            <PenaltyChip s={r.penaltyS} />
            {r.isPlayer ? null : (
              <span className="ml-auto flex items-center gap-1" style={{ color: tone }}>
                {/* Ahead or behind on the road: the arrow shows which way, the number how far */}
                <span className="inline-flex text-lc-slate">
                  <Trend direction={r.gapS > 0 ? "up" : "down"} size={8} label={r.gapS > 0 ? "Ahead" : "Behind"} />
                </span>
                {formatGap(r.gapS, true)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
};

const Stat: React.FC<{ label: string; value: string; sub?: string; tone?: string; big?: boolean }> = ({
  label,
  value,
  sub,
  tone = "var(--color-lc-chalk)",
  big,
}) => (
  <div className="flex min-w-0 flex-col justify-center gap-1 rounded-lc-nub bg-white/3 px-2.5 py-2">
    <span className={`${LBL} tracking-[0.08em] whitespace-nowrap`}>{label}</span>
    <span className={`lc-data leading-none ${big ? "text-[24px]" : "text-[16px]"}`} style={{ color: tone }}>
      {value}
    </span>
    {sub ? <span className="lc-data text-[10px] text-lc-slate">{sub}</span> : null}
  </div>
);

const FuelPage: React.FC<{ t: CarTelemetry; laps: LapRecord[]; L: number }> = ({ t, laps, L }) => {
  const f = fuelStrategy(t, laps, L);
  const ers = f.avgErsPct;
  const energy = [
    <Stat key="b" label="Battery" value={`${Math.round(t.ersBatteryPercent)}%`} tone={HUD_INFO} big={!f.hasFuel} />,
    <Stat
      key="e"
      label="ERS / lap"
      value={ers === null ? NONE : `${ers > 0 ? "\u2212" : "+"}${Math.abs(ers).toFixed(1)}%`}
      tone={ers === null ? HUD_SLATE : ers > 2 ? HUD_CAUTION : undefined}
      big={!f.hasFuel}
    />,
    <Stat key="w" label="Tread / lap" value={f.avgWearPct === null ? NONE : `${f.avgWearPct.toFixed(1)}%`} big={!f.hasFuel} />,
  ];
  if (!f.hasFuel) {
    return <div className="grid h-full grid-cols-3 gap-1.5">{energy}</div>;
  }
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="grid flex-1 grid-cols-2 gap-1.5">
        <Stat label="Fuel" value={f.fuelKg.toFixed(1)} sub={f.lapsOfFuel !== null ? `${f.lapsOfFuel.toFixed(1)} laps` : "kg"} big />
        <Stat
          label="Per lap"
          value={f.avgFuelKg !== null ? f.avgFuelKg.toFixed(2) : NONE}
          sub={f.targetKg !== null ? `target ${f.targetKg.toFixed(2)}` : "kg"}
          big
        />
      </div>
      {f.raceLapsLeft !== null && f.avgFuelKg !== null ? (
        f.saveKg !== null ? (
          <Badge tone="warn" variant="solid" size="lg" icon="fuel" className="w-full">
            <span className="flex flex-1 justify-between">
              <span>Lift · save {f.saveKg.toFixed(2)} kg</span>
              <span className="lc-mono">≈{(f.liftS ?? 0).toFixed(1)} s</span>
            </span>
          </Badge>
        ) : (
          <Badge tone="good" size="lg" icon="success" className="w-full">
            <span className="flex flex-1 justify-between">
              <span>Fuel ok</span>
              <span className="lc-mono">+{(f.marginKg ?? 0).toFixed(1)} kg</span>
            </span>
          </Badge>
        )
      ) : null}
      <div className="grid grid-cols-3 gap-1.5">{energy}</div>
    </div>
  );
};

/** One corner on the MFD's tyre page: tread bands, brake glow, temperature, pressure against its optimum, life */
const TyreCorner: React.FC<{ t: CarTelemetry; i: number }> = ({ t, i }) => {
  const c = cornerData(t, i);
  const units = useUnits();
  const w = t.tireOptimalTempC;
  const right = i % 2 === 1;
  const worst = c.conditions.reduce<(typeof c.conditions)[number] | null>((a, k) => (!a || k.level > a.level ? k : a), null);
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-lc-row border border-lc-titanium bg-lc-well px-2 ${right ? "flex-row-reverse" : ""}`}>
      <TyreGlyph c={c} window={w} className="h-14 w-7.5" />
      <BrakeBar c={c} className="h-14 w-1.5" />
      <span className={`flex min-w-0 flex-1 flex-col gap-0.75 ${right ? "items-end" : "items-start"}`}>
        <span className="lc-data text-[20px] leading-none" style={{ color: tyreHeatColor(c.temp, w) }}>
          {formatTemp(c.temp, units)}
        </span>
        {/* Pressure, and against its optimum with the sign (never the colour alone) */}
        <span className="lc-data text-[11px] leading-none whitespace-nowrap text-lc-fog">
          {c.psi !== null ? formatPressurePsi(c.psi, units) : NONE}
          {c.psiDelta !== null ? (
            <span className="ml-1 text-[10px]" style={{ color: psiDeltaColor(c.psiDelta) }}>
              {formatPressureDeltaPsi(c.psiDelta, units)}
            </span>
          ) : null}
        </span>
        <span className="lc-data text-[11px] leading-none text-lc-slate">{Math.round(c.life)}%</span>
        <span className="h-4">
          {worst ? (
            <Badge tone={worst.tone} variant="solid" size="hud" title={worst.title}>
              {worst.label}
            </Badge>
          ) : null}
        </span>
      </span>
    </div>
  );
};

const TyrePage: React.FC<{ t: CarTelemetry }> = ({ t }) => (
  <div className="grid h-full grid-cols-2 grid-rows-2 gap-1.5" aria-label="Tyres and brakes">
    {[0, 1, 2, 3].map((i) => (
      <TyreCorner key={i} t={t} i={i} />
    ))}
  </div>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <p className="flex h-full items-center justify-center lc-hint">{text}</p>
);

const StandingsPage: React.FC<{ t: CarTelemetry; laps: LapRecord[] }> = ({ t, laps }) => {
  const standings = t.race?.standings;
  if (standings && standings.length > 0) {
    const fastest = standings.reduce<number | null>((m, s) => (s.bestLapMs && (m === null || s.bestLapMs < m) ? s.bestLapMs : m), null);
    const meIdx = Math.max(0, standings.findIndex((s) => s.isPlayer));
    // Nine lines around the player
    const from = Math.max(0, Math.min(standings.length - 9, meIdx - 4));
    const shown = standings.slice(from, from + 9);
    return (
      <table className="lc-data w-full text-[11px]" aria-label="Standings">
        <tbody>
          {shown.map((s, k) => {
            const pos = from + k + 1;
            const purple = fastest !== null && s.bestLapMs === fastest;
            return (
              // The player's row is volt with void ink; the fill sits on the cells so the row's ends can round
              <tr key={`${s.driverCode}-${pos}`} className={`h-5.75 ${s.isPlayer ? "text-lc-void [&>td]:bg-lc-volt" : "text-lc-chalk"}`}>
                <td className={`w-6 rounded-l-lc-nub pr-2 text-right ${s.isPlayer ? "" : "text-lc-slate"}`}>{pos}</td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-0.75 rounded-full" style={{ backgroundColor: s.isPlayer ? "var(--color-lc-void)" : s.teamColorHex }} />
                    {s.driverCode}
                    <PenaltyChip s={s.penaltyS} />
                  </span>
                </td>
                <td className="text-right" style={s.isPlayer ? undefined : { color: purple ? HUD_BEST : "var(--color-lc-fog)" }}>
                  <span className="inline-flex items-center gap-1">
                    {purple ? <Badge tone="best" variant="solid" size="hud" aria-label="Fastest lap">FL</Badge> : null}
                    {formatLapTime(s.bestLapMs)}
                  </span>
                </td>
                <td className="w-13 rounded-r-lc-nub pr-1 text-right">{pos === 1 ? "Lead" : `+${formatGap(s.intervalS ?? s.gapToLeaderS)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  // Practice: the driver's own laps
  if (laps.length === 0) return <Empty text="No laps yet" />;
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce<number | null>((m, l) => (m === null || l.timeMs < m ? l.timeMs : m), null);
  const bestS = [0, 1, 2].map((i) =>
    valid.reduce<number | null>((m, l) => (l.sectorsMs[i] > 0 && (m === null || l.sectorsMs[i] < m) ? l.sectorsMs[i] : m), null)
  );
  return (
    <table className="lc-data w-full text-[11px]" aria-label="Lap times">
      <tbody>
        {laps
          .slice(-9)
          .reverse()
          .map((l) => (
            // An invalid lap is struck through as well as in the loss colour; the session best wears the best colour and its arrow
            <tr key={l.lap} className={`h-5.75 ${l.valid ? "text-lc-chalk" : "text-lc-loss/80 line-through"}`}>
              <td className="w-6 pr-2 text-right text-lc-slate">{l.lap}</td>
              <td style={l.valid && l.timeMs === best ? { color: HUD_BEST } : undefined}>
                <span className="inline-flex items-center gap-1">
                  {formatLapTime(l.timeMs)}
                  {l.valid && l.timeMs === best ? <LapMarkGlyph mark="best" /> : null}
                </span>
              </td>
              {l.sectorsMs.map((ms, i) => (
                <td
                  key={i}
                  className={`text-right ${l.valid && ms > 0 && ms === bestS[i] ? "underline decoration-2 underline-offset-2" : ""}`}
                  style={l.valid && ms > 0 && ms === bestS[i] ? { color: HUD_BEST } : { color: "var(--color-lc-slate)" }}
                >
                  {ms > 0 ? formatSectorTime(ms) : NONE}
                </td>
              ))}
            </tr>
          ))}
      </tbody>
    </table>
  );
};

/* ── Shell ─────────────────────────────────────────────────────────────── */

export interface MultiPageMfdProps {
  telemetry: CarTelemetry;
  onChangeTuner?: (patch: LiveTunerPatch) => void;
  tracker: LapDeltaTracker | null;
  trackLengthM: number;
  compound: TireCompound;
  /** Start folded to the one-line pill */
  defaultFolded?: boolean;
  /** Fold back to the pill 3.5 s after the last D-pad press when the D-pad opened it */
  autoFold?: boolean;
}

/**
 * The car's multi-function display: one bottom-right panel with five pages (Electronics tuner, Relative, Tyres &
 * brakes, Fuel & energy, Standings). The page button (Insert / pad B) steps through them, the MFD button folds it to
 * a one-line pill, and the D-pad wakes it from folded, cycles pages on non-electronics tabs, or tunes electronics on ELEC.
 */
export const MultiPageMfd: React.FC<MultiPageMfdProps> = ({
  telemetry: t,
  onChangeTuner,
  tracker,
  trackLengthM,
  compound,
  defaultFolded = false,
  autoFold = true,
}) => {
  const [page, setPage] = useState<MfdPageId>(readPage);
  const [folded, setFolded] = useState(defaultFolded);
  const laps = useLapHistory(t);
  const units = useUnits();
  const hudModeRef = useHudModeRef();
  // Opened by the D-pad (not by the driver asking for the MFD): the auto-fold timer applies
  const padOpened = useRef(false);
  const foldTimer = useRef<number | null>(null);

  const clearFold = () => {
    if (foldTimer.current !== null) window.clearTimeout(foldTimer.current);
    foldTimer.current = null;
  };
  useEffect(() => clearFold, []);
  // Switching auto-fold off cancels a fold already on its way
  useEffect(() => {
    if (!autoFold) clearFold();
  }, [autoFold]);

  // Every page change goes through here, and the page is remembered across sessions from this one place
  const pageRef = useRef(page);
  pageRef.current = page;
  const choose = useCallback((p: MfdPageId) => {
    pageRef.current = p;
    setPage(p);
    try {
      window.localStorage.setItem(PAGE_KEY, p);
    } catch {
      // Not remembered across sessions
    }
  }, []);
  const stepPage = useCallback(
    (delta: -1 | 1) => {
      const idx = PAGES.findIndex((x) => x.id === pageRef.current);
      choose(PAGES[(idx + delta + PAGES.length) % PAGES.length].id);
    },
    [choose]
  );

  const armAutoFold = useCallback(() => {
    if (padOpened.current && autoFold) {
      clearFold();
      foldTimer.current = window.setTimeout(() => {
        foldTimer.current = null;
        padOpened.current = false;
        setFolded(true);
      }, AUTO_FOLD_MS);
    }
  }, [autoFold]);

  const foldedRef = useRef(folded);
  foldedRef.current = folded;

  const onWake = useCallback(() => {
    if (foldedRef.current) {
      padOpened.current = true;
      setFolded(false);
    }
    armAutoFold();
  }, [armAutoFold]);

  const onCyclePage = useCallback(
    (delta: -1 | 1) => {
      if (foldedRef.current) {
        padOpened.current = true;
        setFolded(false);
      }
      stepPage(delta);
      armAutoFold();
    },
    [armAutoFold, stepPage]
  );

  const onInteract = useCallback(() => {
    if (foldedRef.current) {
      padOpened.current = true;
      setFolded(false);
    }
    choose("elec");
    armAutoFold();
  }, [armAutoFold, choose]);

  useEffect(() => {
    // The MFD and page buttons do nothing while the HUD is hidden under the pause menu or a replay
    const toggle = () => {
      if (hudModeRef.current === "hidden") return;
      clearFold();
      padOpened.current = false;
      setFolded((f) => !f);
    };
    // Not under the results card either: Ⓑ is the page button and also closes the card, and one press must do one thing
    const next = () => {
      if (hudModeRef.current !== "live") return;
      clearFold();
      padOpened.current = false;
      if (foldedRef.current) {
        setFolded(false);
        return;
      }
      stepPage(1);
    };
    window.addEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
    window.addEventListener(HUD_TOGGLE_EVENT.mfdPage, next);
    return () => {
      window.removeEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
      window.removeEventListener(HUD_TOGGLE_EVENT.mfdPage, next);
    };
  }, [hudModeRef, stepPage]);

  const racing = Boolean(t.race);
  const rows = useMemo(
    () => (page === "rel" || folded ? computeRelatives(t, tracker, trackLengthM, compound) : []),
    [page, folded, t, tracker, trackLengthM, compound],
  );
  const meta = PAGES.find((p) => p.id === page) ?? PAGES[0];

  const pillSummary = (): React.ReactNode => {
    if (page === "elec") return <MfdStatusChips telemetry={t} />;
    if (page === "rel") {
      const i = rows.findIndex((r) => r.isPlayer);
      const ahead = rows[i - 1];
      const behind = rows[i + 1];
      return (
        <span className="lc-data flex items-center gap-2 text-[10px] text-lc-chalk">
          {ahead ? (
            <span className="inline-flex items-center gap-1">
              <Trend direction="up" size={8} label="Ahead" />
              {ahead.code} {formatGap(ahead.gapS)}
            </span>
          ) : null}
          {behind ? (
            <span className="inline-flex items-center gap-1">
              <Trend direction="down" size={8} label="Behind" />
              {behind.code} {formatGap(behind.gapS)}
            </span>
          ) : null}
          {!ahead && !behind ? <span className="text-lc-slate">Clear</span> : null}
        </span>
      );
    }
    if (page === "tyre") {
      const hot = Math.max(...t.tireTempsC);
      return (
        <span className="lc-data text-[10px] text-lc-chalk">
          {formatTemp(Math.min(...t.tireTempsC), units)}–{formatTemp(hot, units, true)} · {Math.round(100 - Math.max(...t.tireWearPct))}%
        </span>
      );
    }
    if (page === "fuel") {
      return (
        <span className="lc-data text-[10px] text-lc-chalk">
          {t.fuelKg > 0.01 ? `${t.fuelKg.toFixed(1)} kg · ` : ""}
          <span className="text-lc-info">{Math.round(t.ersBatteryPercent)}%</span>
        </span>
      );
    }
    return (
      <span className="lc-data text-[10px] text-lc-chalk">
        {t.race ? `P${t.race.position}/${t.race.fieldSize}` : `${laps.length} laps`}
      </span>
    );
  };

  return (
    <div
      className={`pointer-events-auto select-none overflow-hidden ${HUD_GLASS} ${
        // Folded, the pill takes its summary's width (Geist Mono chips run past 300 px), never narrower than the panel
        folded ? "w-max min-w-[300px] rounded-full p-1.5" : "flex w-[300px] flex-col gap-2 rounded-lc-card p-2.5"
      }`}
      aria-label={`MFD · ${meta.title}`}
    >
      {folded ? (
        <div className="flex items-center gap-2">
          <Badge variant="solid" size="sm">
            {meta.tag}
          </Badge>
          <span className="flex min-w-0 flex-1 overflow-hidden">{pillSummary()}</span>
          <button
            type="button"
            onClick={() => {
              clearFold();
              padOpened.current = false;
              setFolded(false);
            }}
            className={`flex size-6.5 shrink-0 items-center justify-center rounded-full ${HUD_IDLE} ${HUD_CONTROL}`}
            title="Open the MFD"
            aria-label="Open the MFD"
          >
            <Icon name="collapse" size="xs" />
          </button>
        </div>
      ) : (
        <>
          {/* Page strip */}
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label="MFD pages" title="D-pad left or right, or Ins: next page">
              {PAGES.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={p.id === page}
                  onClick={() => {
                    clearFold();
                    padOpened.current = false;
                    choose(p.id);
                  }}
                  className={`lc-chip-text h-6.5 flex-1 rounded-full text-[10px] ${HUD_CONTROL} ${
                    // Chosen is chalk on line with a hairline (UI standard §4); volt stays the cursor
                    p.id === page ? HUD_CHOSEN : `bg-lc-titanium ${HUD_IDLE}`
                  }`}
                  title={p.title}
                >
                  {p.tag}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                clearFold();
                padOpened.current = false;
                setFolded(true);
              }}
              className={`flex size-6.5 shrink-0 items-center justify-center rounded-full ${HUD_IDLE} ${HUD_CONTROL}`}
              title="Fold the MFD"
              aria-label="Fold the MFD"
            >
              <Icon name="expand" size="xs" />
            </button>
          </div>
        </>
      )}

      {/* The tuner stays mounted on every page and while folded, so the D-pad always works */}
      <TunerMfdPanel
        telemetry={t}
        onChangeTuner={onChangeTuner}
        embedded
        folded={folded}
        hidden={folded || page !== "elec"}
        onWake={onWake}
        onCyclePage={onCyclePage}
        onInteract={onInteract}
      />
      {/* Every page fills the same box, so the MFD's top edge never moves between tabs */}
      {folded || page === "elec" ? null : (
        <div className="h-53 overflow-hidden">
          {page === "rel" ? (
            <RelativePage rows={rows} racing={racing} />
          ) : page === "tyre" ? (
            <TyrePage t={t} />
          ) : page === "fuel" ? (
            <FuelPage t={t} laps={laps} L={trackLengthM} />
          ) : (
            <StandingsPage t={t} laps={laps} />
          )}
        </div>
      )}
    </div>
  );
};
