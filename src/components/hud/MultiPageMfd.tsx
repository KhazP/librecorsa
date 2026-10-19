"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CarTelemetry, LiveTunerPatch, TireCompound } from "@/types/f1";
import type { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { formatLapTime, formatSectorTime, HUD_CYAN, HUD_GREEN, HUD_PURPLE, HUD_SLATE, HUD_VOLT, HUD_YELLOW, tyreHeatColor } from "./hud-format";
import { MfdStatusChips, TunerMfdPanel } from "./TunerMfdPanel";
import { BrakeBar, cornerData, psiDeltaColor, TyreGlyph } from "./TyreBrakeWidget";
import { computeRelatives, fuelStrategy, useLapHistory, type LapRecord, type RelativeRow } from "./mfd-data";
import { COMPOUND_COLORS } from "./styles/hud-style-parts";

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
/** A car this many laps up shows orange (let it by), down blue (you are lapping it) */
const LAP_UP = "#FF8A3D";
const LAP_DOWN = "#5AA9FF";

const LBL = "font-f1-mono text-[9px] font-extrabold tracking-[0.16em] text-[#8E96AA] uppercase";

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
  c ? (
    <span
      className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[2px] font-f1-mono text-[8px] leading-none font-extrabold text-[#F5F7FA]"
      style={{ borderColor: COMPOUND_COLORS[c] }}
      aria-label={`${c} tyres`}
    >
      {c[0].toUpperCase()}
    </span>
  ) : (
    <span className="w-[15px] shrink-0" />
  );

const PenaltyChip: React.FC<{ s?: number }> = ({ s }) =>
  s && s > 0 ? (
    <span className="rounded-[4px] bg-[#FF2A3C] px-1 font-f1-mono text-[8px] leading-[14px] font-extrabold text-[#F5F7FA]">+{s.toFixed(0)}s</span>
  ) : null;

/* ── Pages ─────────────────────────────────────────────────────────────── */

const RelativePage: React.FC<{ rows: RelativeRow[]; racing: boolean }> = ({ rows, racing }) => {
  if (rows.length <= 1) {
    return <Empty text="No cars on track" />;
  }
  return (
    <ol className="flex flex-col gap-[3px]" aria-label="Relative">
      {rows.map((r) => {
        const tone = r.isPlayer ? HUD_VOLT : r.lapDiff > 0 ? LAP_UP : r.lapDiff < 0 ? LAP_DOWN : "#F5F7FA";
        return (
          <li
            key={r.key}
            className={`flex h-[24px] items-center gap-2 rounded-[8px] px-2 font-f1-mono text-[11px] font-extrabold tabular-nums ${
              r.isPlayer ? "bg-[#CCFF00]/[0.12] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.35)]" : "bg-white/[0.03]"
            }`}
          >
            <span className="w-[18px] text-right text-[10px] text-[#8E96AA]">{racing && r.position ? r.position : ""}</span>
            <span className="h-3 w-[3px] shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
            <span className="w-[34px] tracking-[0.06em]" style={{ color: tone }}>
              {r.code}
            </span>
            <CompoundBadge c={r.compound} />
            <span className="w-[26px] text-[9px]" style={{ color: tone }}>
              {r.lapDiff !== 0 ? `${r.lapDiff > 0 ? "+" : "−"}${Math.abs(r.lapDiff)}L` : ""}
            </span>
            <PenaltyChip s={r.penaltyS} />
            <span className="ml-auto flex items-center gap-1" style={{ color: r.isPlayer ? HUD_VOLT : tone }}>
              {r.isPlayer ? (
                "—"
              ) : (
                <>
                  <span className="text-[8px]" style={{ color: r.gapS > 0 ? HUD_CYAN : HUD_YELLOW }} aria-hidden>
                    {r.gapS > 0 ? "▲" : "▼"}
                  </span>
                  {Math.abs(r.gapS).toFixed(Math.abs(r.gapS) < 10 ? 2 : 1)}
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const Stat: React.FC<{ label: string; value: string; sub?: string; tone?: string; big?: boolean }> = ({ label, value, sub, tone = "#F5F7FA", big }) => (
  <div className="flex min-w-0 flex-col justify-center gap-1 rounded-[12px] bg-white/[0.03] px-2.5 py-2">
    <span className={LBL}>{label}</span>
    <span className={`lc-data leading-none tabular-nums ${big ? "text-[24px]" : "text-[16px]"}`} style={{ color: tone }}>
      {value}
    </span>
    {sub ? <span className="font-f1-mono text-[10px] font-extrabold text-[#8E96AA] tabular-nums">{sub}</span> : null}
  </div>
);

const FuelPage: React.FC<{ t: CarTelemetry; laps: LapRecord[]; L: number }> = ({ t, laps, L }) => {
  const f = fuelStrategy(t, laps, L);
  const ers = f.avgErsPct;
  const energy = [
    <Stat key="b" label="Battery" value={`${Math.round(t.ersBatteryPercent)}%`} tone={HUD_CYAN} big={!f.hasFuel} />,
    <Stat
      key="e"
      label="ERS / lap"
      value={ers === null ? "—" : `${ers > 0 ? "−" : "+"}${Math.abs(ers).toFixed(1)}%`}
      tone={ers === null ? HUD_SLATE : ers > 2 ? HUD_YELLOW : HUD_GREEN}
      big={!f.hasFuel}
    />,
    <Stat key="w" label="Tread / lap" value={f.avgWearPct === null ? "—" : `${f.avgWearPct.toFixed(1)}%`} big={!f.hasFuel} />,
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
          value={f.avgFuelKg !== null ? f.avgFuelKg.toFixed(2) : "—"}
          sub={f.targetKg !== null ? `target ${f.targetKg.toFixed(2)}` : "kg"}
          big
        />
      </div>
      {f.raceLapsLeft !== null && f.avgFuelKg !== null ? (
        f.saveKg !== null ? (
          <div className="flex h-[30px] items-center justify-between rounded-[12px] bg-[#FFB300] px-2.5 font-f1-mono text-[11px] font-extrabold text-[#08090D] tabular-nums">
            <span className="tracking-[0.12em]">LIFT · SAVE {f.saveKg.toFixed(2)}</span>
            <span>≈{(f.liftS ?? 0).toFixed(1)}s</span>
          </div>
        ) : (
          <div className="flex h-[30px] items-center justify-between rounded-[12px] bg-[#00E676]/[0.14] px-2.5 font-f1-mono text-[11px] font-extrabold text-[#00E676] tabular-nums">
            <span className="tracking-[0.12em]">FUEL OK</span>
            <span>+{(f.marginKg ?? 0).toFixed(1)} kg</span>
          </div>
        )
      ) : null}
      <div className="grid grid-cols-3 gap-1.5">{energy}</div>
    </div>
  );
};

/** One corner on the MFD's tyre page: tread bands, brake glow, temperature, pressure against its optimum, life */
const TyreCorner: React.FC<{ t: CarTelemetry; i: number }> = ({ t, i }) => {
  const c = cornerData(t, i);
  const w = t.tireOptimalTempC;
  const right = i % 2 === 1;
  const worst = c.conditions.reduce<(typeof c.conditions)[number] | null>((a, k) => (!a || k.level > a.level ? k : a), null);
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-[14px] border border-[#1B1F2B] bg-[#050608] px-2 ${right ? "flex-row-reverse" : ""}`}>
      <TyreGlyph c={c} window={w} className="h-[56px] w-[30px]" />
      <BrakeBar c={c} className="h-[56px] w-[6px]" />
      <span className={`flex min-w-0 flex-1 flex-col gap-[3px] ${right ? "items-end" : "items-start"}`}>
        <span className="lc-data text-[20px] leading-none" style={{ color: tyreHeatColor(c.temp, w) }}>
          {Math.round(c.temp)}°
        </span>
        <span className="lc-data text-[11px] leading-none tabular-nums" style={{ color: psiDeltaColor(c.psiDelta) }}>
          {c.psi !== null ? c.psi.toFixed(1) : "—"}
        </span>
        <span className="lc-data text-[11px] leading-none text-[#8E96AA] tabular-nums">{Math.round(c.life)}%</span>
        <span className="h-[12px]">
          {worst ? (
            <span
              title={worst.title}
              className="rounded-full px-[5px] py-px font-f1-mono text-[8px] font-extrabold tracking-[0.06em] text-[#08090D]"
              style={{ backgroundColor: worst.color }}
            >
              {worst.label}
            </span>
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
  <p className="flex h-full items-center justify-center font-f1-mono text-[11px] font-extrabold tracking-[0.14em] text-[#5B6275] uppercase">{text}</p>
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
      <table className="w-full font-f1-mono text-[11px] font-extrabold tabular-nums" aria-label="Standings">
        <tbody>
          {shown.map((s, k) => {
            const pos = from + k + 1;
            const purple = fastest !== null && s.bestLapMs === fastest;
            return (
              <tr key={`${s.driverCode}-${pos}`} className={`h-[23px] ${s.isPlayer ? "bg-[#CCFF00]/[0.12] text-[#CCFF00]" : "text-[#F5F7FA]"}`}>
                <td className="w-6 pr-2 text-right text-[#8E96AA]">{pos}</td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-[3px] rounded-full" style={{ backgroundColor: s.teamColorHex }} />
                    {s.driverCode}
                    <PenaltyChip s={s.penaltyS} />
                  </span>
                </td>
                <td className="text-right" style={purple ? { color: HUD_PURPLE } : { color: "#C5CBD8" }}>
                  {s.bestLapMs ? formatLapTime(s.bestLapMs) : "—"}
                </td>
                <td className="w-[52px] pr-1 text-right">{pos === 1 ? "LEAD" : `+${(s.intervalS ?? s.gapToLeaderS).toFixed(1)}`}</td>
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
    <table className="w-full font-f1-mono text-[11px] font-extrabold tabular-nums" aria-label="Lap times">
      <tbody>
        {laps
          .slice(-9)
          .reverse()
          .map((l) => (
            <tr key={l.lap} className={`h-[23px] ${l.valid ? "text-[#F5F7FA]" : "text-[#FF2A3C]/80 line-through"}`}>
              <td className="w-6 pr-2 text-right text-[#8E96AA]">{l.lap}</td>
              <td style={l.valid && l.timeMs === best ? { color: HUD_PURPLE } : undefined}>{formatLapTime(l.timeMs)}</td>
              {l.sectorsMs.map((ms, i) => (
                <td key={i} className="text-right" style={l.valid && ms > 0 && ms === bestS[i] ? { color: HUD_PURPLE } : { color: "#8E96AA" }}>
                  {ms > 0 ? formatSectorTime(ms) : "—"}
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
  // Opened by the D-pad (not by the driver asking for the MFD): the auto-fold timer applies
  const padOpened = useRef(false);
  const foldTimer = useRef<number | null>(null);

  const clearFold = () => {
    if (foldTimer.current !== null) window.clearTimeout(foldTimer.current);
    foldTimer.current = null;
  };
  useEffect(() => clearFold, []);

  const choose = useCallback((p: MfdPageId) => {
    setPage(p);
    try {
      window.localStorage.setItem(PAGE_KEY, p);
    } catch {
      // Not remembered across sessions
    }
  }, []);

  const armAutoFold = useCallback(() => {
    if (padOpened.current && autoFold) {
      clearFold();
      foldTimer.current = window.setTimeout(() => {
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
      setPage((cur) => {
        const idx = PAGES.findIndex((x) => x.id === cur);
        const p = PAGES[(idx + delta + PAGES.length) % PAGES.length].id;
        try {
          window.localStorage.setItem(PAGE_KEY, p);
        } catch {
          // Not remembered
        }
        return p;
      });
      armAutoFold();
    },
    [armAutoFold]
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
    const toggle = () => {
      clearFold();
      padOpened.current = false;
      setFolded((f) => !f);
    };
    const next = () => {
      clearFold();
      padOpened.current = false;
      if (foldedRef.current) {
        setFolded(false);
        return;
      }
      setPage((cur) => {
        const p = PAGES[(PAGES.findIndex((x) => x.id === cur) + 1) % PAGES.length].id;
        try {
          window.localStorage.setItem(PAGE_KEY, p);
        } catch {
          // Not remembered
        }
        return p;
      });
    };
    window.addEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
    window.addEventListener(HUD_TOGGLE_EVENT.mfdPage, next);
    return () => {
      window.removeEventListener(HUD_TOGGLE_EVENT.mfd, toggle);
      window.removeEventListener(HUD_TOGGLE_EVENT.mfdPage, next);
    };
  }, []);

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
        <span className="flex items-center gap-2 font-f1-mono text-[10px] font-extrabold tabular-nums">
          {ahead ? <span className="text-[#00E5FF]">▲ {ahead.code} {ahead.gapS.toFixed(1)}</span> : null}
          {behind ? <span className="text-[#FFB300]">▼ {behind.code} {Math.abs(behind.gapS).toFixed(1)}</span> : null}
          {!ahead && !behind ? <span className="text-[#5B6275]">CLEAR</span> : null}
        </span>
      );
    }
    if (page === "tyre") {
      const hot = Math.max(...t.tireTempsC);
      return (
        <span className="font-f1-mono text-[10px] font-extrabold text-[#F5F7FA] tabular-nums">
          {Math.round(Math.min(...t.tireTempsC))}–{Math.round(hot)}°C · {Math.round(100 - Math.max(...t.tireWearPct))}%
        </span>
      );
    }
    if (page === "fuel") {
      return (
        <span className="font-f1-mono text-[10px] font-extrabold text-[#F5F7FA] tabular-nums">
          {t.fuelKg > 0.01 ? `${t.fuelKg.toFixed(1)} kg · ` : ""}
          <span className="text-[#00E5FF]">{Math.round(t.ersBatteryPercent)}%</span>
        </span>
      );
    }
    return (
      <span className="font-f1-mono text-[10px] font-extrabold text-[#F5F7FA] tabular-nums">
        {t.race ? `P${t.race.position}/${t.race.fieldSize}` : `${laps.length} laps`}
      </span>
    );
  };

  return (
    <div
      className={`pointer-events-auto select-none overflow-hidden border border-white/[0.08] bg-[#0A0B10]/92 shadow-[0_20px_50px_rgba(0,0,0,0.55)] backdrop-blur-md w-[300px] ${
        folded ? "rounded-full p-1.5" : "flex flex-col gap-2 rounded-[24px] p-2.5"
      }`}
      aria-label={`MFD · ${meta.title}`}
    >
      {folded ? (
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-[#CCFF00] px-2 py-[3px] font-f1-mono text-[9px] font-extrabold tracking-[0.14em] text-[#08090D]">{meta.tag}</span>
          <span className="flex min-w-0 flex-1 overflow-hidden">{pillSummary()}</span>
          <button
            type="button"
            onClick={() => {
              clearFold();
              padOpened.current = false;
              setFolded(false);
            }}
            className="flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E96AA] transition-colors hover:bg-white/10 hover:text-[#CCFF00]"
            title="Open the MFD"
            aria-label="Open the MFD"
          >
            <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.6} />
          </button>
        </div>
      ) : (
        <>
          {/* Page strip */}
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label="MFD pages" title="D-pad ◀ ▶ or Ins: next page">
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
                  className={`h-[26px] flex-1 cursor-pointer rounded-full font-f1-mono text-[10px] font-extrabold tracking-[0.1em] transition-colors ${
                    p.id === page ? "bg-[#CCFF00] text-[#08090D]" : "bg-[#1B1F2B] text-[#8E96AA] hover:text-[#F5F7FA]"
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
              className="flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full text-[#8E96AA] transition-colors hover:bg-white/10 hover:text-[#CCFF00]"
              title="Fold the MFD"
              aria-label="Fold the MFD"
            >
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.6} />
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
        <div className="h-[212px] overflow-hidden">
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
