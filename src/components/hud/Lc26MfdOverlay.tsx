"use client";

/**
 * Sleek High-Contrast Motorsport React HUD Widget for the VeloSoft LC-26 (`lc26-f1`).
 *
 * Displays:
 *  - Engine RPM + 15-segment FIA 2026 shift LED bar (`1..5` green, `6..10` red, `11..15` blue/violet,
 *    shift flash, pit-limiter blink, overtake strobe)
 *  - Gear (`R` / `N` / `1..8`) & speed (`km/h`)
 *  - Live 2026 operating mode pill (`CM` / `SM` / `WET SM` / `SUPER CLIP` / `OVERTAKE READY` / `OVERTAKE` / `BOOST`)
 *  - Battery `SoC %` + Lap Harvest (`8.5 / 9.0 MJ`) & Lap Deploy (`4.0 / 4.5 MJ`) bars
 *  - Static Brake Bias `%` + BBW Dynamic Migration `%` (and live effective front bias `%`)
 *  - Sustainable race fuel strictly in `kg` + FIA C5.4.3 energy flow (`MJ/h`)
 *  - 4-corner (`FL`, `FR`, `RL`, `RR`) 18" Pirelli tyre temperatures (`°C`) & pressures (`psi`)
 *  - Interactive 5-page steering-wheel MFD sub-panel (`race-main`, `ers-active-aero`, `tyres-thermals`,
 *    `brakes-diff`, `fuel-plank`).
 */

import React, { useMemo, useState } from "react";
import type { CarTelemetry } from "@/types/f1";
import {
  fromCarTelemetryToLc26Mfd,
  LC26_LED_COLORS,
  LC26_MFD_PAGES,
  nextLc26MfdPage,
  prevLc26MfdPage,
  type Lc26MfdPageId,
  type Lc26MfdTelemetryInput,
  type Lc26MfdViewModel,
} from "@/lib/cars/lc26/mfd";
import { LC26_DISPLAY_NAME, LC26_SHORT_NAME } from "@/lib/cars/lc26/contract-types";
import { HUD_GLASS, HUD_LBL, HUD_WELL } from "./hud-format";

export interface Lc26MfdOverlayProps {
  /** Pre-computed LC-26 MFD view-model (preferred when LC-26 physics subsystems are wired directly) */
  readonly viewModel?: Lc26MfdViewModel;
  /** Standard LibreCorsa `CarTelemetry` (automatically adapted when `viewModel` is omitted) */
  readonly telemetry?: CarTelemetry;
  /** Optional LC-26 subsystem overrides layered onto `telemetry` */
  readonly lc26Overrides?: Partial<Lc26MfdTelemetryInput>;
  /** Controlled active MFD page (falls back to internal state `'race-main'`) */
  readonly activePage?: Lc26MfdPageId;
  readonly onPageChange?: (page: Lc26MfdPageId) => void;
  readonly onToggleStraightMode?: () => void;
  readonly onToggleOvertake?: () => void;
  readonly className?: string;
}

const EnergyBarRow: React.FC<{
  label: string;
  readout: string;
  ratio01: number;
  barColor: string;
}> = ({ label, readout, ratio01, barColor }) => {
  const pct = Math.max(0, Math.min(100, ratio01 * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={HUD_LBL}>{label}</span>
        <span className="lc-data text-[11px] leading-none tabular-nums text-[#F5F7FA]">
          {readout}
        </span>
      </div>
      <div className="relative h-[7px] w-full overflow-hidden rounded-full bg-[#141824]">
        <div
          className="h-full rounded-full transition-[width] duration-75"
          style={{
            width: `${pct}%`,
            backgroundColor: barColor,
            boxShadow: pct > 2 ? `0 0 8px ${barColor}66` : "none",
          }}
        />
      </div>
    </div>
  );
};

export const Lc26MfdOverlay: React.FC<Lc26MfdOverlayProps> = ({
  viewModel,
  telemetry,
  lc26Overrides,
  activePage: controlledPage,
  onPageChange,
  onToggleStraightMode,
  onToggleOvertake,
  className = "",
}) => {
  const [internalPage, setInternalPage] = useState<Lc26MfdPageId>("race-main");
  const currentPage = controlledPage ?? viewModel?.activePage ?? internalPage;

  const setPage = (next: Lc26MfdPageId) => {
    setInternalPage(next);
    onPageChange?.(next);
  };

  const state: Lc26MfdViewModel | null = useMemo(() => {
    if (viewModel) {
      return controlledPage && controlledPage !== viewModel.activePage
        ? { ...viewModel, activePage: controlledPage }
        : viewModel;
    }
    if (!telemetry) return null;
    return fromCarTelemetryToLc26Mfd(telemetry, {
      ...lc26Overrides,
      activePage: currentPage,
    });
  }, [viewModel, telemetry, lc26Overrides, controlledPage, currentPage]);

  if (!state) return null;

  const socTone =
    state.socPct <= 12
      ? "#ef4444"
      : state.socPct <= 22
        ? "#f59e0b"
        : state.liveMode.mode === "OVERTAKE" || state.liveMode.mode === "BOOST"
          ? "#a855f7"
          : "#ccff00";

  const mgukSign = state.mgukPowerKw > 0 ? "+" : "";
  const mgukTone =
    state.mgukPowerKw < -5 ? "#22c55e" : state.mgukPowerKw > 5 ? "#a855f7" : "#94a3b8";

  return (
    <section
      aria-label={`${LC26_DISPLAY_NAME} Cockpit MFD`}
      className={`w-[368px] select-none rounded-[22px] p-3.5 text-[#F5F7FA] ${HUD_GLASS} ${className}`}
    >
      {/* 1. Top Header: Car Tag, Live Mode Pill, Aero Sub-Chip & RPM */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="lc-data rounded-full bg-[#CCFF00] px-2 py-0.5 text-[9px] font-black tracking-wider text-[#08090D]">
            {LC26_SHORT_NAME}
          </span>
          <button
            type="button"
            onClick={onToggleOvertake ?? onToggleStraightMode}
            title={state.liveMode.description}
            className="lc-data pointer-events-auto cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] font-extrabold tracking-wider transition-colors"
            style={{
              backgroundColor: state.liveMode.bgHex,
              color: state.liveMode.fgHex,
              borderColor: state.liveMode.borderHex,
              boxShadow:
                state.liveMode.mode !== "CM"
                  ? `0 0 12px ${state.liveMode.bgHex}55`
                  : "none",
            }}
          >
            {state.liveMode.mode}
          </button>
          {state.liveMode.mode !== state.liveMode.aeroBadge ? (
            <button
              type="button"
              onClick={onToggleStraightMode}
              className="lc-data pointer-events-auto cursor-pointer rounded-full border border-[#2A3248] bg-[#0E121B] px-2 py-0.5 text-[9px] text-[#7DD3FC]"
              title="Active Aero Flap State"
            >
              {state.liveMode.aeroBadge}
            </button>
          ) : null}
        </div>

        <div className="flex items-baseline gap-1">
          <span className="lc-data text-[13px] tabular-nums text-[#F5F7FA]">
            {state.rpm.toLocaleString()}
          </span>
          <span className={HUD_LBL}>RPM</span>
        </div>
      </div>

      {/* 2. 15-LED Steering-Wheel Shift Strip (`1..5` green, `6..10` red, `11..15` blue/violet) */}
      <div
        className="my-2.5 flex gap-[3px] rounded-full bg-[#05060A] px-2 py-1.5"
        aria-label={`Shift lights: ${state.shiftLeds.litCount} of 15`}
      >
        {state.shiftLeds.colorsHex.map((hex, idx) => {
          const lit = hex.toLowerCase() !== LC26_LED_COLORS.off;
          return (
            <span
              key={idx}
              className="h-2 flex-1 rounded-full transition-colors duration-75"
              style={{
                backgroundColor: hex,
                boxShadow: lit ? `0 0 7px ${hex}` : "none",
              }}
            />
          );
        })}
      </div>

      {/* 3. Primary Driver Cluster: Pedals | Speed + MGU-K | Gear | SoC + Lap Harvest & Deploy */}
      <div className="grid grid-cols-[1fr_76px_1.15fr] items-stretch gap-2.5">
        {/* Speed, MGU-K live kW, Fuel in kg */}
        <div className={`flex flex-col justify-between rounded-[16px] px-2.5 py-2 ${HUD_WELL}`}>
          <div className="flex items-baseline justify-between">
            <span className="lc-data text-[38px] leading-[0.9] tracking-[-0.02em] tabular-nums text-[#F5F7FA]">
              {state.speedKmh}
            </span>
            <span className={HUD_LBL}>KM/H</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px]">
            <span className={HUD_LBL}>MGU-K</span>
            <span className="lc-data tabular-nums" style={{ color: mgukTone }}>
              {mgukSign}
              {state.mgukPowerKw} kW
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between border-t border-[#1B1F2B] pt-1 text-[10px]">
            <span className={HUD_LBL}>FUEL</span>
            <span className="lc-data tabular-nums text-[#38BDF8]">
              {state.fuelKg.toFixed(1)} kg
            </span>
          </div>
        </div>

        {/* Central Gear Pod (`R` / `N` / `1..8`) */}
        <div
          className="flex flex-col items-center justify-center rounded-[18px] border-2 bg-[#050608] transition-colors"
          style={{
            borderColor: state.shiftLeds.shiftFlashActive
              ? "#ef4444"
              : state.liveMode.borderHex,
            boxShadow: state.shiftLeds.shiftFlashActive
              ? "0 0 16px rgba(239,68,68,0.45)"
              : "none",
          }}
          aria-label={`Gear ${state.gearLabel}`}
        >
          <span className={HUD_LBL}>GEAR</span>
          <span className="lc-data text-[46px] leading-none text-[#F5F7FA]">
            {state.gearLabel}
          </span>
          <span className="font-f1-mono text-[9px] font-bold text-[#94A3B8]">
            {state.ersDeployMode}
          </span>
        </div>

        {/* Hybrid Energy: SoC % + Harvest (8.5/9.0 MJ) + Deploy (4.0/4.5 MJ) */}
        <div className={`flex flex-col justify-between gap-1.5 rounded-[16px] px-2.5 py-2 ${HUD_WELL}`}>
          <div className="flex items-baseline justify-between">
            <span className={HUD_LBL}>SOC</span>
            <span
              className="lc-data text-[18px] leading-none tabular-nums"
              style={{ color: socTone }}
            >
              {state.socPct.toFixed(0)}%
            </span>
          </div>
          <EnergyBarRow
            label="HARVEST"
            readout={`${state.lapHarvestMj.toFixed(1)}/${state.lapHarvestCapMj.toFixed(1)} MJ`}
            ratio01={state.lapHarvestRatio01}
            barColor="#22c55e"
          />
          <EnergyBarRow
            label="DEPLOY"
            readout={`${state.lapDeployMj.toFixed(1)}/${state.lapDeployCapMj.toFixed(1)} MJ`}
            ratio01={state.lapDeployRatio01}
            barColor="#a855f7"
          />
        </div>
      </div>

      {/* 4. Always-Visible Brake Bias + BBW Migration Strip & 4-Corner Tyre Temps/Pressures */}
      <div className="mt-2.5 grid grid-cols-[1.05fr_1.35fr] gap-2">
        {/* Brake Bias % + BBW Migration % + Fuel Flow */}
        <div className={`flex flex-col justify-between rounded-[14px] px-2.5 py-2 ${HUD_WELL}`}>
          <div className="flex items-center justify-between">
            <span className={HUD_LBL}>BBW BIAS</span>
            <span className="lc-data text-[13px] tabular-nums text-[#F5F7FA]">
              {state.brakeBiasFrontPct.toFixed(1)}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className={HUD_LBL}>MIGRATION</span>
            <span className="lc-data text-[12px] tabular-nums text-[#00E5FF]">
              +{state.brakeMigrationPct.toFixed(1)}%
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-[#1B1F2B] pt-1">
            <span className={HUD_LBL}>LIVE EFF</span>
            <span className="lc-data text-[11px] tabular-nums text-[#CCFF00]">
              {state.effectiveFrontBiasPct.toFixed(1)}% F
            </span>
          </div>
        </div>

        {/* 4-Corner 18" Pirelli Tyre Temps (°C) & Pressures (psi) */}
        <div className={` rounded-[14px] p-1.5 ${HUD_WELL}`}>
          <div className="mb-1 flex items-center justify-between px-1">
            <span className={HUD_LBL}>TYRES ({state.pirelliCode})</span>
            <span className="font-f1-mono text-[8px] font-bold text-[#94A3B8]">
              TEMP °C · PSI
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {state.corners.map((c) => (
              <div
                key={c.corner}
                className="flex items-center justify-between rounded-[8px] border px-1.5 py-1"
                style={{
                  borderColor: `${c.tempColorHex}88`,
                  backgroundColor: `${c.tempColorHex}14`,
                }}
              >
                <span
                  className="font-f1-mono text-[9px] font-black"
                  style={{ color: c.tempColorHex }}
                >
                  {c.corner}
                </span>
                <span className="lc-data text-[11px] tabular-nums text-[#F5F7FA]">
                  {Math.round(c.surfaceTempC)}°C
                </span>
                <span className="font-f1-mono text-[9px] font-bold tabular-nums text-[#CBD5E1]">
                  {c.pressurePsi.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 5. Multi-Page MFD Sub-Panel & Tab Switcher */}
      <div className="mt-2.5 border-t border-[#22283A] pt-2">
        <div className="mb-1.5 flex items-center justify-between gap-1">
          <button
            type="button"
            onClick={() => setPage(prevLc26MfdPage(state.activePage))}
            className="pointer-events-auto cursor-pointer rounded-[6px] bg-[#141824] px-1.5 py-0.5 font-f1-mono text-[9px] font-bold text-[#94A3B8] hover:text-[#F5F7FA]"
            aria-label="Previous MFD page"
          >
            ◀
          </button>
          <div className="flex flex-1 justify-center gap-1">
            {LC26_MFD_PAGES.map((p) => {
              const selected = p.id === state.activePage;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPage(p.id)}
                  className={`pointer-events-auto cursor-pointer rounded-[6px] px-1.5 py-0.5 font-f1-mono text-[8.5px] font-extrabold tracking-wider transition-colors ${
                    selected
                      ? "bg-[#CCFF00] text-[#08090D]"
                      : "bg-[#121622] text-[#8E96AA] hover:text-[#F5F7FA]"
                  }`}
                >
                  {p.tag}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setPage(nextLc26MfdPage(state.activePage))}
            className="pointer-events-auto cursor-pointer rounded-[6px] bg-[#141824] px-1.5 py-0.5 font-f1-mono text-[9px] font-bold text-[#94A3B8] hover:text-[#F5F7FA]"
            aria-label="Next MFD page"
          >
            ▶
          </button>
        </div>

        {/* Active Page Contextual Telemetry Row */}
        <div className={`rounded-[12px] px-2.5 py-1.5 font-f1-mono text-[10px] tabular-nums ${HUD_WELL}`}>
          {state.activePage === "race-main" && (
            <div className="flex items-center justify-between text-[#CBD5E1]">
              <span>LAP {state.currentLapTimeFormatted}</span>
              <span
                style={{
                  color:
                    state.deltaSeconds === null
                      ? "#94A3B8"
                      : state.deltaSeconds <= 0
                        ? "#22C55E"
                        : "#EF4444",
                }}
              >
                Δ {state.deltaFormatted}
              </span>
              <span>ICE {state.icePowerKw} kW</span>
            </div>
          )}

          {state.activePage === "ers-active-aero" && (
            <div className="flex items-center justify-between text-[#CBD5E1]">
              <span>CAP {state.speedDerateCapKw} kW</span>
              <span className="text-[#00E5FF]">
                FW {state.flapsDeg.fwFlap3}° / RW {state.flapsDeg.rwFlap3}°
              </span>
              <span>
                DF {state.downforceKgf} kgf ({state.aeroBalanceFrontPct}%F)
              </span>
            </div>
          )}

          {state.activePage === "tyres-thermals" && (
            <div className="flex items-center justify-between text-[#CBD5E1]">
              <span>
                CORE {Math.round(state.corners[0].coreTempC)}°/{Math.round(state.corners[2].coreTempC)}°C
              </span>
              <span>
                LIFE {Math.round(state.corners[0].remainingLifePct)}%/{Math.round(state.corners[2].remainingLifePct)}%
              </span>
              <span>GILLS L{state.coolingGillLevel}</span>
            </div>
          )}

          {state.activePage === "brakes-diff" && (
            <div className="flex items-center justify-between text-[#CBD5E1]">
              <span>
                DIFF E{state.diffEntryLockPct}% · M{state.diffMidCoastLockPct}% · {state.diffHighSpeedPreloadNm}Nm
              </span>
              <span>EB {state.engineBrakingLevel}/10</span>
            </div>
          )}

          {state.activePage === "fuel-plank" && (
            <div className="flex items-center justify-between text-[#CBD5E1]">
              <span className="text-[#38BDF8]">
                FLOW {state.fuelEnergyFlowMjH}/3000 MJ/h
              </span>
              <span
                style={{ color: state.plank.legal ? "#22C55E" : "#EF4444" }}
              >
                PLANK {state.plank.frontSplitterMm.toFixed(1)}/{state.plank.midFloorMm.toFixed(1)}/
                {state.plank.rearTeaTrayMm.toFixed(1)} mm
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

export default Lc26MfdOverlay;
