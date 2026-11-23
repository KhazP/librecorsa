"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, LiveTunerPatch, TireCompound } from "@/types/f1";
import type { LapDeltaTracker } from "@/lib/sim/lap-delta";
import { HUD_TOGGLE_EVENT } from "@/lib/input/bindings";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
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
import { SkinButton, skinCss, SkinPanel, SkinTag, type SkinTone, useHudSkin } from "./styles/third-party-skin";
import { useHudModeRef } from "./hud-mode";

export type MfdPageId = "elec" | "rel" | "tyre" | "fuel" | "stnd";

const PAGES: { id: MfdPageId }[] = [{ id: "elec" }, { id: "rel" }, { id: "tyre" }, { id: "fuel" }, { id: "stnd" }];

/** D-pad quiet time after which an MFD opened via D-pad folds back to its compact status pill */
const AUTO_FOLD_MS = 3500;
const PAGE_KEY = "lc.mfdPage";
/** A car laps up shows tangerine (let it by), laps down azure (you are lapping it); "+1L" / "−1L" says it too */
const LAP_UP = "var(--color-lc-tangerine)";
const LAP_DOWN = "var(--color-lc-azure)";
/** No value yet */
const NONE = "--";

const LBL = HUD_LBL;

/** The MFD's fixed words in the current language, resolved once per language: the MFD redraws with every telemetry tick */
function useMfdText() {
  const tx = useTranslations("hud.multiPageMfd");
  return useMemo(
    () => ({
      pages: {
        elec: { tag: tx("pages.elecTag"), title: tx("pages.elecTitle") },
        rel: { tag: tx("pages.relTag"), title: tx("pages.relTitle") },
        tyre: { tag: tx("pages.tyreTag"), title: tx("pages.tyreTitle") },
        fuel: { tag: tx("pages.fuelTag"), title: tx("pages.fuelTitle") },
        stnd: { tag: tx("pages.stndTag"), title: tx("pages.stndTitle") },
      } satisfies Record<MfdPageId, { tag: string; title: string }>,
      pagesLabel: tx("pagesLabel"),
      pagesHint: tx("pagesHint"),
      open: tx("open"),
      fold: tx("fold"),
      relative: tx("relative.label"),
      noCars: tx("relative.noCars"),
      ahead: tx("relative.ahead"),
      behind: tx("relative.behind"),
      clear: tx("relative.clear"),
      you: tx("relative.you"),
      battery: tx("fuel.battery"),
      ersPerLap: tx("fuel.ersPerLap"),
      treadPerLap: tx("fuel.treadPerLap"),
      fuel: tx("fuel.fuel"),
      perLap: tx("fuel.perLap"),
      fuelOk: tx("fuel.fuelOk"),
      tyres: tx("tyres.label"),
      standings: tx("standings.label"),
      fastestLap: tx("standings.fastestLap"),
      fastestLapShort: tx("standings.fastestLapShort"),
      lead: tx("standings.lead"),
      noLaps: tx("standings.noLaps"),
      lapTimes: tx("standings.lapTimes"),
      tx,
    }),
    [tx],
  );
}

/** A car's laps up (+) or down (−) on the player, as the relative shows it: "+1L" */
const lapDiffText = (text: ReturnType<typeof useMfdText>, lapDiff: number) =>
  lapDiff > 0 ? text.tx("relative.lapsUp", { count: lapDiff }) : text.tx("relative.lapsDown", { count: Math.abs(lapDiff) });

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

const PenaltyChip: React.FC<{ s?: number; skinned?: boolean }> = ({ s, skinned = false }) => {
  if (!s || s <= 0) return null;
  if (skinned) {
    return (
      <SkinTag tone="loss" filled className="px-1 py-0 text-[9px] font-bold">
        +{Math.round(s)}s
      </SkinTag>
    );
  }
  return <PenaltyBadge penalty={{ kind: "time", seconds: Math.round(s) }} size="hud" variant="solid" />;
};

function skinToneOf(tone: BadgeTone): SkinTone {
  switch (tone) {
    case "good":
      return "gain";
    case "warn":
      return "caution";
    case "bad":
      return "loss";
    case "info":
      return "info";
    case "best":
      return "best";
    default:
      return "default";
  }
}

/* ── Pages ─────────────────────────────────────────────────────────────── */

const RelativePage: React.FC<{ rows: RelativeRow[]; racing: boolean }> = ({ rows, racing }) => {
  const skin = useHudSkin();
  const text = useMfdText();
  if (rows.length <= 1) {
    return <Empty text={text.noCars} />;
  }
  if (skin !== null) {
    return (
      <ol className="flex flex-col gap-0.75" aria-label={text.relative}>
        {rows.map((r) => {
          const lapColor = r.isPlayer ? undefined : r.lapDiff > 0 ? LAP_UP : r.lapDiff < 0 ? LAP_DOWN : undefined;
          return (
            <li
              key={r.key}
              className={`lc-data flex h-6 items-center gap-2 px-2 text-[11px] ${skinCss.row} ${
                r.isPlayer ? `${skinCss.playerRow} font-bold` : ""
              }`}
            >
              <span className={`w-4.5 text-end text-[10px] ${skinCss.pos} ${r.isPlayer ? "" : skinCss.inkDim}`}>
                {racing && r.position ? r.position : ""}
              </span>
              <span
                className="h-3 w-0.75 shrink-0 rounded-full"
                style={{ backgroundColor: r.isPlayer ? "currentColor" : r.color }}
              />
              <span className={`w-8.5 tracking-[0.06em] ${!r.isPlayer && !lapColor ? skinCss.ink : ""}`} style={lapColor ? { color: lapColor } : undefined}>
                {r.code}
              </span>
              <CompoundBadge c={r.compound} />
              <span className="w-6.5 text-[9px]" style={lapColor ? { color: lapColor } : undefined}>
                {r.lapDiff !== 0 ? lapDiffText(text, r.lapDiff) : ""}
              </span>
              <PenaltyChip s={r.penaltyS} skinned />
              {r.isPlayer ? null : (
                <span className={`ms-auto flex items-center gap-1 ${!lapColor ? skinCss.ink : ""}`} style={lapColor ? { color: lapColor } : undefined}>
                  <span className={`inline-flex ${skinCss.inkDim}`}>
                    <Trend direction={r.gapS > 0 ? "up" : "down"} size={8} label={r.gapS > 0 ? text.ahead : text.behind} />
                  </span>
                  {formatGap(r.gapS, true)}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <ol className="flex flex-col gap-0.75" aria-label={text.relative}>
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
            <span className={`w-4.5 text-end text-[10px] ${r.isPlayer ? "" : "text-lc-slate"}`}>{racing && r.position ? r.position : ""}</span>
            <span className="h-3 w-0.75 shrink-0 rounded-full" style={{ backgroundColor: r.isPlayer ? "var(--color-lc-void)" : r.color }} />
            <span className="w-8.5 tracking-[0.06em]" style={{ color: tone }}>
              {r.code}
            </span>
            <CompoundBadge c={r.compound} />
            <span className="w-6.5 text-[9px]" style={{ color: tone }}>
              {r.lapDiff !== 0 ? lapDiffText(text, r.lapDiff) : ""}
            </span>
            <PenaltyChip s={r.penaltyS} />
            {r.isPlayer ? null : (
              <span className="ms-auto flex items-center gap-1" style={{ color: tone }}>
                {/* Ahead or behind on the road: the arrow shows which way, the number how far */}
                <span className="inline-flex text-lc-slate">
                  <Trend direction={r.gapS > 0 ? "up" : "down"} size={8} label={r.gapS > 0 ? text.ahead : text.behind} />
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

const Stat: React.FC<{ label: string; value: string; sub?: string; tone?: string; toneClass?: string; big?: boolean }> = ({
  label,
  value,
  sub,
  tone = "var(--color-lc-chalk)",
  toneClass,
  big,
}) => {
  const skin = useHudSkin();
  if (skin !== null) {
    return (
      <div className={`flex min-w-0 flex-col justify-center gap-1.5 px-2.5 py-2 ${skinCss.deepBox}`}>
        <span className={skinCss.label}>{label}</span>
        <span className={`lc-data leading-none ${skinCss.readout} ${big ? "text-[24px]" : "text-[16px]"} ${toneClass ?? skinCss.ink}`}>{value}</span>
        {sub ? <span className={`lc-data text-[10px] ${skinCss.inkDim}`}>{sub}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col justify-center gap-1 rounded-lc-nub bg-white/3 px-2.5 py-2">
      <span className={`${LBL} tracking-[0.08em] whitespace-nowrap`}>{label}</span>
      <span className={`lc-data leading-none ${big ? "text-[24px]" : "text-[16px]"}`} style={{ color: tone }}>
        {value}
      </span>
      {sub ? <span className="lc-data text-[10px] text-lc-slate">{sub}</span> : null}
    </div>
  );
};

const FuelPage: React.FC<{ t: CarTelemetry; laps: LapRecord[]; L: number }> = ({ t, laps, L }) => {
  const skin = useHudSkin();
  const text = useMfdText();
  const f = fuelStrategy(t, laps, L);
  const ers = f.avgErsPct;
  const energy = [
    <Stat key="b" label={text.battery} value={`${Math.round(t.ersBatteryPercent)}%`} tone={HUD_INFO} toneClass={skinCss.inkInfo} big={!f.hasFuel} />,
    <Stat
      key="e"
      label={text.ersPerLap}
      value={ers === null ? NONE : `${ers > 0 ? "\u2212" : "+"}${Math.abs(ers).toFixed(1)}%`}
      tone={ers === null ? HUD_SLATE : ers > 2 ? HUD_CAUTION : undefined}
      toneClass={ers === null ? skinCss.inkDim : ers > 2 ? skinCss.inkCaution : skinCss.ink}
      big={!f.hasFuel}
    />,
    <Stat key="w" label={text.treadPerLap} value={f.avgWearPct === null ? NONE : `${f.avgWearPct.toFixed(1)}%`} big={!f.hasFuel} />,
  ];
  if (!f.hasFuel) {
    return <div className="grid h-full grid-cols-3 gap-1.5">{energy}</div>;
  }
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="grid flex-1 grid-cols-2 gap-1.5">
        <Stat
          label={text.fuel}
          value={f.fuelKg.toFixed(1)}
          sub={f.lapsOfFuel !== null ? text.tx("fuel.lapsOfFuel", { laps: f.lapsOfFuel.toFixed(1) }) : "kg"}
          big
        />
        <Stat
          label={text.perLap}
          value={f.avgFuelKg !== null ? f.avgFuelKg.toFixed(2) : NONE}
          sub={f.targetKg !== null ? text.tx("fuel.target", { kg: f.targetKg.toFixed(2) }) : "kg"}
          big
        />
      </div>
      {f.raceLapsLeft !== null && f.avgFuelKg !== null ? (
        skin !== null ? (
          f.saveKg !== null ? (
            <SkinTag tone="caution" filled className="w-full justify-between px-2 py-1 text-[11px] font-bold">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="fuel" size="xs" />
                {text.tx("fuel.lift", { kg: f.saveKg.toFixed(2) })}
              </span>
              <span className="lc-mono">≈{(f.liftS ?? 0).toFixed(1)} s</span>
            </SkinTag>
          ) : (
            <SkinTag tone="gain" className="w-full justify-between px-2 py-1 text-[11px] font-bold">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="success" size="xs" />
                {text.fuelOk}
              </span>
              <span className="lc-mono">+{(f.marginKg ?? 0).toFixed(1)} kg</span>
            </SkinTag>
          )
        ) : f.saveKg !== null ? (
          <Badge tone="warn" variant="solid" size="lg" icon="fuel" className="w-full">
            <span className="flex flex-1 justify-between">
              <span>{text.tx("fuel.lift", { kg: f.saveKg.toFixed(2) })}</span>
              <span className="lc-mono">≈{(f.liftS ?? 0).toFixed(1)} s</span>
            </span>
          </Badge>
        ) : (
          <Badge tone="good" size="lg" icon="success" className="w-full">
            <span className="flex flex-1 justify-between">
              <span>{text.fuelOk}</span>
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
  const skin = useHudSkin();
  const c = cornerData(t, i);
  const units = useUnits();
  const w = t.tireOptimalTempC;
  const right = i % 2 === 1;
  const worst = c.conditions.reduce<(typeof c.conditions)[number] | null>((a, k) => (!a || k.level > a.level ? k : a), null);
  return (
    <div
      className={`flex min-w-0 items-center gap-2 px-2 ${right ? "flex-row-reverse" : ""} ${
        skin !== null ? skinCss.deepBox : "rounded-lc-row border border-lc-titanium bg-lc-well"
      }`}
    >
      <TyreGlyph c={c} window={w} className="h-14 w-7.5" />
      <BrakeBar c={c} className="h-14 w-1.5" />
      <span className={`flex min-w-0 flex-1 flex-col gap-0.75 ${right ? "items-end" : "items-start"}`}>
        <span className={`lc-data text-[20px] leading-none ${skin !== null ? skinCss.readout : ""}`} style={{ color: tyreHeatColor(c.temp, w) }}>
          {formatTemp(c.temp, units)}
        </span>
        {/* Pressure, and against its optimum with the sign (never the colour alone) */}
        <span className={`lc-data text-[11px] leading-none whitespace-nowrap ${skin !== null ? skinCss.inkSoft : "text-lc-fog"}`}>
          {c.psi !== null ? formatPressurePsi(c.psi, units) : NONE}
          {c.psiDelta !== null ? (
            <span className="ms-1 text-[10px]" style={{ color: psiDeltaColor(c.psiDelta) }}>
              {formatPressureDeltaPsi(c.psiDelta, units)}
            </span>
          ) : null}
        </span>
        <span className={`lc-data text-[11px] leading-none ${skin !== null ? skinCss.inkDim : "text-lc-slate"}`}>{Math.round(c.life)}%</span>
        <span className="h-4">
          {worst ? (
            skin !== null ? (
              <SkinTag tone={skinToneOf(worst.tone)} filled className="px-1.5 py-0.5 text-[9px] font-bold uppercase" title={worst.title}>
                {worst.label}
              </SkinTag>
            ) : (
              <Badge tone={worst.tone} variant="solid" size="hud" title={worst.title}>
                {worst.label}
              </Badge>
            )
          ) : null}
        </span>
      </span>
    </div>
  );
};

const TyrePage: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const text = useMfdText();
  return (
    <div className="grid h-full grid-cols-2 grid-rows-2 gap-1.5" aria-label={text.tyres}>
      {[0, 1, 2, 3].map((i) => (
        <TyreCorner key={i} t={t} i={i} />
      ))}
    </div>
  );
};

const Empty: React.FC<{ text: string }> = ({ text }) => {
  const skin = useHudSkin();
  return (
    <p className={`flex h-full items-center justify-center ${skin !== null ? `text-[11px] ${skinCss.inkDim}` : "lc-hint"}`}>{text}</p>
  );
};

const StandingsPage: React.FC<{ t: CarTelemetry; laps: LapRecord[] }> = ({ t, laps }) => {
  const skin = useHudSkin();
  const text = useMfdText();
  const standings = t.race?.standings;
  if (standings && standings.length > 0) {
    const fastest = standings.reduce<number | null>((m, s) => (s.bestLapMs && (m === null || s.bestLapMs < m) ? s.bestLapMs : m), null);
    const meIdx = Math.max(0, standings.findIndex((s) => s.isPlayer));
    // Nine lines around the player
    const from = Math.max(0, Math.min(standings.length - 9, meIdx - 4));
    const shown = standings.slice(from, from + 9);
    return (
      <table className="lc-data w-full text-[11px]" aria-label={text.standings}>
        <tbody>
          {shown.map((s, k) => {
            const pos = from + k + 1;
            const purple = fastest !== null && s.bestLapMs === fastest;
            if (skin !== null) {
              return (
                <tr key={`${s.driverCode}-${pos}`} className={`h-5.75 ${skinCss.row} ${s.isPlayer ? `${skinCss.playerRow} font-bold` : skinCss.ink}`}>
                  <td className={`w-6 pe-2 text-end ${skinCss.pos} ${s.isPlayer ? "" : skinCss.inkDim}`}>{pos}</td>
                  <td className="w-1.5" />
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-3 w-0.75 rounded-full"
                        style={{ backgroundColor: s.isPlayer ? "currentColor" : s.teamColorHex }}
                      />
                      {s.driverCode}
                      <PenaltyChip s={s.penaltyS} skinned />
                    </span>
                  </td>
                  <td
                    className={`text-end ${s.isPlayer || purple ? "" : skinCss.inkSoft}`}
                    style={!s.isPlayer && purple ? { color: HUD_BEST } : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {purple ? (
                        <SkinTag tone="best" filled className="px-1 py-0 text-[9px] font-bold" aria-label={text.fastestLap}>
                          {text.fastestLapShort}
                        </SkinTag>
                      ) : null}
                      {formatLapTime(s.bestLapMs)}
                    </span>
                  </td>
                  <td className="w-13 pe-1 text-end">{pos === 1 ? text.lead : `+${formatGap(s.intervalS ?? s.gapToLeaderS)}`}</td>
                </tr>
              );
            }
            return (
              // The player's row is volt with void ink; the fill sits on the cells so the row's ends can round
              <tr key={`${s.driverCode}-${pos}`} className={`h-5.75 ${s.isPlayer ? "text-lc-void [&>td]:bg-lc-volt" : "text-lc-chalk"}`}>
                <td className={`w-6 rounded-s-lc-nub pe-2 text-end ${s.isPlayer ? "" : "text-lc-slate"}`}>{pos}</td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-3 w-0.75 rounded-full" style={{ backgroundColor: s.isPlayer ? "var(--color-lc-void)" : s.teamColorHex }} />
                    {s.driverCode}
                    <PenaltyChip s={s.penaltyS} />
                  </span>
                </td>
                <td className="text-end" style={s.isPlayer ? undefined : { color: purple ? HUD_BEST : "var(--color-lc-fog)" }}>
                  <span className="inline-flex items-center gap-1">
                    {purple ? <Badge tone="best" variant="solid" size="hud" aria-label={text.fastestLap}>{text.fastestLapShort}</Badge> : null}
                    {formatLapTime(s.bestLapMs)}
                  </span>
                </td>
                <td className="w-13 rounded-e-lc-nub pe-1 text-end">{pos === 1 ? text.lead : `+${formatGap(s.intervalS ?? s.gapToLeaderS)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  // Practice: the driver's own laps
  if (laps.length === 0) return <Empty text={text.noLaps} />;
  const valid = laps.filter((l) => l.valid);
  const best = valid.reduce<number | null>((m, l) => (m === null || l.timeMs < m ? l.timeMs : m), null);
  const bestS = [0, 1, 2].map((i) =>
    valid.reduce<number | null>((m, l) => (l.sectorsMs[i] > 0 && (m === null || l.sectorsMs[i] < m) ? l.sectorsMs[i] : m), null)
  );
  return (
    <table className="lc-data w-full text-[11px]" aria-label={text.lapTimes}>
      <tbody>
        {laps
          .slice(-9)
          .reverse()
          .map((l) => {
            if (skin !== null) {
              return (
                <tr key={l.lap} className={`h-5.75 ${skinCss.row} ${l.valid ? skinCss.ink : `${skinCss.inkLoss} opacity-80 line-through`}`}>
                  <td className={`w-6 pe-2 text-end ${skinCss.pos} ${skinCss.inkDim}`}>{l.lap}</td>
                  <td className="w-1.5" />
                  <td style={l.valid && l.timeMs === best ? { color: HUD_BEST } : undefined}>
                    <span className="inline-flex items-center gap-1">
                      {formatLapTime(l.timeMs)}
                      {l.valid && l.timeMs === best ? <LapMarkGlyph mark="best" /> : null}
                    </span>
                  </td>
                  {l.sectorsMs.map((ms, i) => {
                    const secBest = l.valid && ms > 0 && ms === bestS[i];
                    return (
                      <td
                        key={i}
                        className={`text-end ${secBest ? "underline decoration-2 underline-offset-2" : skinCss.inkDim}`}
                        style={secBest ? { color: HUD_BEST } : undefined}
                      >
                        {ms > 0 ? formatSectorTime(ms) : NONE}
                      </td>
                    );
                  })}
                </tr>
              );
            }
            return (
              // An invalid lap is struck through as well as in the loss colour; the session best wears the best colour and its arrow
              <tr key={l.lap} className={`h-5.75 ${l.valid ? "text-lc-chalk" : "text-lc-loss/80 line-through"}`}>
                <td className="w-6 pe-2 text-end text-lc-slate">{l.lap}</td>
                <td style={l.valid && l.timeMs === best ? { color: HUD_BEST } : undefined}>
                  <span className="inline-flex items-center gap-1">
                    {formatLapTime(l.timeMs)}
                    {l.valid && l.timeMs === best ? <LapMarkGlyph mark="best" /> : null}
                  </span>
                </td>
                {l.sectorsMs.map((ms, i) => (
                  <td
                    key={i}
                    className={`text-end ${l.valid && ms > 0 && ms === bestS[i] ? "underline decoration-2 underline-offset-2" : ""}`}
                    style={l.valid && ms > 0 && ms === bestS[i] ? { color: HUD_BEST } : { color: "var(--color-lc-slate)" }}
                  >
                    {ms > 0 ? formatSectorTime(ms) : NONE}
                  </td>
                ))}
              </tr>
            );
          })}
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
  /** The player's driver code, for the relative page outside a race (a race's standing carries its own) */
  playerCode?: string;
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
  playerCode,
  defaultFolded = false,
  autoFold = true,
}) => {
  const skin = useHudSkin();
  const text = useMfdText();
  const code = playerCode ?? text.you;
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
    () => (page === "rel" ? computeRelatives(t, tracker, trackLengthM, compound, code) : []),
    [page, t, tracker, trackLengthM, compound, code],
  );
  const meta = text.pages[page] ?? text.pages.elec;

  const pillSummary = (skinned = false): React.ReactNode => {
    const inkCls = skinned ? skinCss.ink : "text-lc-chalk";
    const dimCls = skinned ? skinCss.inkDim : "text-lc-slate";
    const infoCls = skinned ? skinCss.inkInfo : "text-lc-info";
    if (page === "elec") return <MfdStatusChips telemetry={t} />;
    if (page === "rel") {
      const i = rows.findIndex((r) => r.isPlayer);
      const ahead = rows[i - 1];
      const behind = rows[i + 1];
      return (
        <span className={`lc-data flex items-center gap-2 text-[10px] ${inkCls}`}>
          {ahead ? (
            <span className="inline-flex items-center gap-1">
              <Trend direction="up" size={8} label={text.ahead} />
              {ahead.code} {formatGap(ahead.gapS)}
            </span>
          ) : null}
          {behind ? (
            <span className="inline-flex items-center gap-1">
              <Trend direction="down" size={8} label={text.behind} />
              {behind.code} {formatGap(behind.gapS)}
            </span>
          ) : null}
          {!ahead && !behind ? <span className={dimCls}>{text.clear}</span> : null}
        </span>
      );
    }
    if (page === "tyre") {
      const hot = Math.max(...t.tireTempsC);
      return (
        <span className={`lc-data text-[10px] ${inkCls}`}>
          {formatTemp(Math.min(...t.tireTempsC), units)}–{formatTemp(hot, units, true)} · {Math.round(100 - Math.max(...t.tireWearPct))}%
        </span>
      );
    }
    if (page === "fuel") {
      return (
        <span className={`lc-data text-[10px] ${inkCls}`}>
          {t.fuelKg > 0.01 ? `${t.fuelKg.toFixed(1)} kg · ` : ""}
          <span className={infoCls}>{Math.round(t.ersBatteryPercent)}%</span>
        </span>
      );
    }
    return (
      <span className={`lc-data text-[10px] ${inkCls}`}>
        {t.race
          ? text.tx("pill.position", { position: t.race.position, fieldSize: t.race.fieldSize })
          : text.tx("pill.laps", { count: laps.length })}
      </span>
    );
  };

  const bodyContent = (
    <>
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
    </>
  );

  if (skin !== null) {
    return (
      <SkinPanel
        cut={folded ? "sm" : "md"}
        className={`pointer-events-auto select-none ${folded ? `w-max min-w-[300px] ${skinCss.pill}` : "w-[300px]"}`}
        innerClassName={folded ? "flex items-center gap-2 px-2 py-1.5" : "flex flex-col gap-2 p-2.5"}
        aria-label={text.tx("panel", { page: meta.title })}
      >
        {folded ? (
          <div className="flex w-full items-center gap-2">
            <SkinTag tone="accent" filled className="px-1.5 py-0.5 text-[10px] font-bold uppercase">
              {meta.tag}
            </SkinTag>
            <span className="flex min-w-0 flex-1 overflow-hidden">{pillSummary(true)}</span>
            <SkinButton
              onClick={() => {
                clearFold();
                padOpened.current = false;
                setFolded(false);
              }}
              className="size-6.5 shrink-0"
              title={text.open}
              aria-label={text.open}
            >
              <Icon name="collapse" size="xs" />
            </SkinButton>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <div className={`flex min-w-0 flex-1 gap-1 ${skinCss.tablist}`} role="tablist" aria-label={text.pagesLabel} title={text.pagesHint}>
              {PAGES.map((p) => (
                <SkinButton
                  key={p.id}
                  role="tab"
                  aria-selected={p.id === page}
                  active={p.id === page}
                  onClick={() => {
                    clearFold();
                    padOpened.current = false;
                    choose(p.id);
                  }}
                  className="h-6.5 flex-1 text-[10px] font-bold tracking-[0.06em] uppercase"
                  title={text.pages[p.id].title}
                >
                  {text.pages[p.id].tag}
                </SkinButton>
              ))}
            </div>
            <SkinButton
              onClick={() => {
                clearFold();
                padOpened.current = false;
                setFolded(true);
              }}
              className="size-6.5 shrink-0"
              title={text.fold}
              aria-label={text.fold}
            >
              <Icon name="expand" size="xs" />
            </SkinButton>
          </div>
        )}
        {bodyContent}
      </SkinPanel>
    );
  }

  return (
    <div
      className={`pointer-events-auto select-none overflow-hidden ${HUD_GLASS} ${
        // Folded, the pill takes its summary's width (Geist Mono chips run past 300 px), never narrower than the panel
        folded ? "w-max min-w-[300px] rounded-full p-1.5" : "flex w-[300px] flex-col gap-2 rounded-lc-card p-2.5"
      }`}
      aria-label={text.tx("panel", { page: meta.title })}
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
            title={text.open}
            aria-label={text.open}
          >
            <Icon name="collapse" size="xs" />
          </button>
        </div>
      ) : (
        <>
          {/* Page strip */}
          <div className="flex items-center gap-1">
            <div className="flex min-w-0 flex-1 gap-1" role="tablist" aria-label={text.pagesLabel} title={text.pagesHint}>
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
                  title={text.pages[p.id].title}
                >
                  {text.pages[p.id].tag}
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
              title={text.fold}
              aria-label={text.fold}
            >
              <Icon name="expand" size="xs" />
            </button>
          </div>
        </>
      )}

      {bodyContent}
    </div>
  );
};
