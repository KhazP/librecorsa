"use client";

/*
 * Grand Prix:
 * - Mode A (open-wheel car in tv_pod camera): broadcast-style timing tower top-left, curved Halo-mounted
 *   speed/boost/ERS/brake/throttle/aero/gears cluster, and compact driver timing card bottom-left.
 * - Mode B (all other cameras or non-open-wheel cars): session & standings top-left, sector & delta
 *   card top-right, sector-colored circuit map bottom-left, twin-circle battery/gear/speed cluster bottom-centre,
 *   and MFD/setup readout bottom-right.
 */

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import { upper } from "@/i18n/runtime";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import { TEMPERATURE_LABEL, temperatureIn } from "@/lib/settings/units";
import {
  CLASSIC_CAR_IDS,
  HUD_GAIN,
  HUD_LOSS,
  HUD_SHIFT,
  HUD_SLATE,
  NO_TIME,
  PROTO_CAR_IDS,
  ROAD_CAR_IDS,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  lapClockMs,
  formatSpeed,
  sectorDone,
  sectorTimeColor,
  speedUnit,
  sessionWord,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { ProximityRadar } from "../ProximityRadar";
import { anchor, formatOnce, gearLabel, MiniMap, type HudDesignProps } from "./hud-style-parts";
import palette from "./grand-prix.module.css";
import { HaloCluster } from "./grand-prix-halo";

const EDGE = "clamp(14px,2.2vw,24px)";
const TOUCH_TOP = 68;


/** The Grand Prix layout's words in the current language, resolved once per language */
function useGrandPrixWords() {
  const tx = useTranslations("hudStyles.grandPrix");
  return useMemo(
    () => ({
      sessionFinished: tx("sessionFinished"),
      sessionRace: tx("sessionRace"),
      sessionQualifying: tx("sessionQualifying"),
      sessionOutLap: tx("sessionOutLap"),
      turn: tx("turn"),
      straight: tx("straight"),
      recharge: tx("recharge"),
      brake: tx("brake"),
      boost: tx("boost"),
      drsOpen: tx("drsOpen"),
      overtake: tx("overtake"),
      deploy: tx("deploy"),
      throttle: tx("throttle"),
      activeAero: tx("activeAero"),
      aeroOpen: tx("aeroOpen"),
      aeroClosed: tx("aeroClosed"),
      gears: tx("gears"),
      battery: tx("battery"),
      fuel: tx("fuel"),
      tyreWear: tx("tyreWear"),
      ersOvertake: tx("ersOvertake"),
      ersDeploy: tx("ersDeploy"),
      youCode: tx("youCode"),
      youName: tx("youName"),
      towerLap: formatOnce((lap: number, total: number) =>
        total ? tx("towerLapOfTotal", { lap: String(lap), total: String(total) }) : tx("towerLap", { lap: String(lap) }),
      ),
      towerOut: tx("towerOut"),
      towerLast: tx("towerLast"),
      fastestLap: tx("fastestLap"),
      finished: tx("finished"),
      bestRef: formatOnce((time: string) => tx("bestRef", { time })),
      noRef: tx("noRef"),
      stripLap: formatOnce((lap: number, total: number) =>
        total ? tx("stripLapOfTotal", { lap: String(lap), total: String(total) }) : tx("stripLap", { lap: String(lap) }),
      ),
      standingsOut: tx("standingsOut"),
      lastLap: tx("lastLap"),
      delta: tx("delta"),
      brakeBias: tx("brakeBias"),
    }),
    [tx],
  );
}
type GrandPrixWords = ReturnType<typeof useGrandPrixWords>;

function tyreTempColor(tempC: number): string {
  if (tempC < 65) return "#38bdf8";
  if (tempC <= 108) return "#22c55e";
  return "#ef4444";
}

function tyreWearColor(wearPct: number): string {
  if (wearPct < 35) return "#22c55e";
  if (wearPct < 65) return "#eab308";
  return "#ef4444";
}

function carClassOf(carId: string | undefined): "openWheel" | "gt3" | "road" | "proto" | "classic" {
  if (!carId) return "openWheel";
  if (carId.includes("gt3")) return "gt3";
  if (ROAD_CAR_IDS.has(carId)) return "road";
  if (PROTO_CAR_IDS.has(carId)) return "proto";
  if (CLASSIC_CAR_IDS.has(carId)) return "classic";
  return "openWheel";
}

function sessionLabel(t: CarTelemetry, w: GrandPrixWords): string {
  if (t.race) return t.race.phase === "finished" ? w.sessionFinished : w.sessionRace;
  if (t.qualifying) return w.sessionQualifying;
  if (t.outLap) return w.sessionOutLap;
  return upper(sessionWord(t));
}

function compoundMeta(compound: TireCompound | undefined): { letter: string; color: string } {
  switch (compound) {
    case "soft":
      return { letter: "S", color: "#ef4444" };
    case "medium":
      return { letter: "M", color: "#eab308" };
    case "hard":
      return { letter: "H", color: "#f8fafc" };
    case "intermediate":
      return { letter: "I", color: "#22c55e" };
    case "wet":
      return { letter: "W", color: "#38bdf8" };
    default:
      return { letter: "S", color: "#ef4444" };
  }
}

/**
 * The standard mode's six standings rows: the top six, or the top three and the player with the cars around them once
 * the player runs seventh or lower, so the player's own row never drops off. Each keeps its real position
 */
function compactStandings<E extends { isPlayer?: boolean }>(st: readonly E[]): { e: E; i: number }[] {
  const p = st.findIndex((e) => e.isPlayer);
  if (p < 6) return st.slice(0, 6).map((e, i) => ({ e, i }));
  const around = p + 1 < st.length ? [p - 1, p, p + 1] : [p - 2, p - 1, p];
  return [0, 1, 2, ...around].map((i) => ({ e: st[i], i }));
}

/**
 * A sector pip's colour, as the other layouts mark sectors (`sectorDone`, `sectorTimeColor`): a sector of this lap
 * that is done is best, personal best or slower against the best; the sector the car is in is lit; the rest wait.
 * Never the out-lap's or the last lap's times
 */
function sectorPipColor(t: CarTelemetry, index: number): string {
  if (sectorDone(t, index)) return sectorTimeColor(t.sectorTimesMs[index], t.bestSectorTimesMs[index], !t.race);
  if (t.currentSector === index + 1) return "#38bdf8";
  return "rgba(255,255,255,0.12)";
}

/* ============================================================================
 * MODE B: STANDARD CLUSTER (sculpted dual-ring cluster)
 * ============================================================================ */

const SculptedCluster: React.FC<{
  hasErs: boolean;
  ers: number;
  fuelKg: number;
  gear: string;
  atShift: boolean;
  speedLbl: string;
  speed: string;
  rpm: number;
  maxRpm: number;
  revFrac: number;
  overtakeActive: boolean;
  aeroOpen: boolean;
  tireTempsC: [number, number, number, number];
  units: ReturnType<typeof useUnits>;
}> = ({ hasErs, ers, fuelKg, gear, atShift, speedLbl, speed, rpm, maxRpm, revFrac, overtakeActive, aeroOpen, tireTempsC, units }) => {
  const w = useGrandPrixWords();
  const tempLbl = TEMPERATURE_LABEL[units.temperature];
  const temp = (c: number) => Math.round(temperatureIn(c, units.temperature));
  const leftFrac = hasErs ? ers / 100 : Math.min(1, fuelKg / 100);
  const leftColor = hasErs ? (ers > 35 ? "#d9f99d" : ers > 15 ? "#fde047" : "#ef4444") : "#fbbf24";
  const r = 36;
  const circ = 2 * Math.PI * r;
  const arcSpan = circ * 0.72;
  const leftArc = Math.max(0, Math.min(1, leftFrac)) * arcSpan;
  const rpmSweep = Math.max(0, Math.min(1, rpm / Math.max(1, maxRpm)));
  const rpmArc = rpmSweep * arcSpan;
  const litLeds = Math.round(Math.max(0, Math.min(1, revFrac)) * 15);
  const activeAccent = overtakeActive || aeroOpen ? "#22d3ee" : "#a3e635";

  return (
    <div className="relative h-[108px] w-[396px] select-none drop-shadow-[0_10px_26px_rgba(0,0,0,0.65)]" aria-hidden>
      <svg viewBox="-40 0 396 108" className="size-full overflow-visible">
        <defs>
          <linearGradient id="gp-std-rpm" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#e2e8f0" />
            <stop offset="70%" stopColor="#ffffff" />
            <stop offset="88%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
          <filter id="gp-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Side tyre-temp wings, in the player's temperature unit */}
        <g transform="translate(-14, 54)">
          <rect
            x="-17"
            y="-25"
            width="34"
            height="48"
            rx="6"
            fill="rgba(10, 12, 16, 0.8)"
            stroke="rgba(255, 255, 255, 0.18)"
            strokeWidth="0.9"
          />
          <text x="0" y="-14" fill="#e2e8f0" fontSize="7" fontWeight="800" textAnchor="middle" letterSpacing="0.8">
            {tempLbl}
          </text>
          <text x="0" y="-1" fill={tyreTempColor(tireTempsC[0])} fontSize="11" fontWeight="900" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
            {temp(tireTempsC[0])}
          </text>
          <text x="0" y="15" fill={tyreTempColor(tireTempsC[2])} fontSize="11" fontWeight="900" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
            {temp(tireTempsC[2])}
          </text>
        </g>
        <g transform="translate(330, 54)">
          <rect
            x="-17"
            y="-25"
            width="34"
            height="48"
            rx="6"
            fill="rgba(10, 12, 16, 0.8)"
            stroke="rgba(255, 255, 255, 0.18)"
            strokeWidth="0.9"
          />
          <text x="0" y="-14" fill="#e2e8f0" fontSize="7" fontWeight="800" textAnchor="middle" letterSpacing="0.8">
            {tempLbl}
          </text>
          <text x="0" y="-1" fill={tyreTempColor(tireTempsC[1])} fontSize="11" fontWeight="900" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
            {temp(tireTempsC[1])}
          </text>
          <text x="0" y="15" fill={tyreTempColor(tireTempsC[3])} fontSize="11" fontWeight="900" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
            {temp(tireTempsC[3])}
          </text>
        </g>

        {/* Translucent dark glass sculpted housing with subtle silver-white hairline */}
        <path
          d="M 54 12 A 42 42 0 1 0 88 78 L 106 78 L 116 92 L 200 92 L 210 78 L 228 78 A 42 42 0 1 0 262 12 A 42 42 0 0 0 226 32 L 202 32 L 192 22 L 124 22 L 114 32 L 90 32 A 42 42 0 0 0 54 12 Z"
          fill="rgba(10, 12, 16, 0.62)"
          stroke="rgba(255, 255, 255, 0.24)"
          strokeWidth="1"
          strokeLinejoin="round"
        />

        {/* Top bridge: 15 rev-light LED dots contained inside x=128..188 */}
        {Array.from({ length: 15 }, (_, i) => {
          const lx = 128 + i * 4.28;
          const lit = i < litLeds;
          const ledColor = i < 5 ? "#22c55e" : i < 10 ? "#ef4444" : "#38bdf8";
          return (
            <circle
              key={i}
              cx={lx}
              cy="28.5"
              r="1.15"
              fill={lit ? ledColor : "rgba(255, 255, 255, 0.16)"}
            />
          );
        })}

        {/* Left gauge: BATT / FUEL arc sitting directly on the outer rim */}
        <g transform="translate(54, 54)">
          <circle
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.12)"
            strokeWidth="5"
            strokeDasharray={`${arcSpan} ${circ}`}
            strokeLinecap="round"
            transform="rotate(140)"
          />
          <circle
            r={r}
            fill="none"
            stroke={leftColor}
            strokeWidth="5.5"
            strokeDasharray={`${leftArc} ${circ}`}
            strokeLinecap="round"
            transform="rotate(140)"
            filter="url(#gp-glow)"
          />
          <text y="-10" fill="#cbd5e1" fontSize="8" fontWeight="700" textAnchor="middle" letterSpacing="1">
            {hasErs ? w.battery : w.fuel}
          </text>
          <text y="10" fill={leftColor} fontSize="20" fontWeight="900" textAnchor="middle">
            {hasErs ? `${Math.round(ers)}%` : `${fuelKg.toFixed(0)}`}
          </text>
          {/* Small target/ERS node at bottom of left ring */}
          <circle cy="39" r="5" fill="rgba(10, 12, 16, 0.9)" stroke={leftColor} strokeWidth="1" />
          <circle cy="39" r="1.8" fill={leftColor} />
        </g>

        {/* Center bridge: upright bold Gear + bottom accent bar */}
        <text
          x="158"
          y="67"
          fill={atShift ? HUD_SHIFT : "#ffffff"}
          fontSize="38"
          fontWeight="900"
          textAnchor="middle"
        >
          {gear}
        </text>
        <rect x="118" y="85" width="80" height="2.5" rx="1.2" fill="rgba(255,255,255,0.12)" />
        <rect
          x="158"
          y="85"
          width={overtakeActive || aeroOpen ? 40 : 32}
          height="2.5"
          rx="1.2"
          fill={activeAccent}
        />

        {/* Right gauge: crisp KPH / Speed / RPM / Value */}
        <g transform="translate(262, 54)">
          <circle
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.16)"
            strokeWidth="2"
            strokeDasharray={`${arcSpan} ${circ}`}
            strokeLinecap="round"
            transform="rotate(140)"
          />
          <circle
            r={r}
            fill="none"
            stroke="url(#gp-std-rpm)"
            strokeWidth="2.5"
            strokeDasharray={`${rpmArc} ${circ}`}
            strokeLinecap="round"
            transform="rotate(140)"
          />
          <text y="-15" fill="#94a3b8" fontSize="7.5" fontWeight="700" textAnchor="middle" letterSpacing="1">
            {speedLbl === "KM/H" ? "KPH" : speedLbl}
          </text>
          <text y="3" fill="#ffffff" fontSize="21" fontWeight="900" textAnchor="middle">
            {speed}
          </text>
          <text y="13" fill="#94a3b8" fontSize="6.5" fontWeight="700" textAnchor="middle" letterSpacing="1">
            RPM
          </text>
          <text y="24" fill="#e2e8f0" fontSize="11" fontWeight="800" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
            {Math.round(rpm)}
          </text>
        </g>
      </svg>
    </div>
  );
};

/* ============================================================================
 * MODE B: TYRE WEAR & CAR DIAGRAM CARD
 * ============================================================================ */

const TyreWearCard: React.FC<{
  tireWearPct: [number, number, number, number];
  ers: number;
  /** The DEPLOY / ERS line is left out on a car without ERS */
  hasErs: boolean;
  boostOn: boolean;
  overtakeOn: boolean;
}> = ({ tireWearPct, ers, hasErs, boostOn, overtakeOn }) => {
  const w = useGrandPrixWords();
  const corners = [
    { label: "FL", wear: Math.round(tireWearPct[0]), x: 34, y: 24 },
    { label: "FR", wear: Math.round(tireWearPct[1]), x: 162, y: 24 },
    { label: "RL", wear: Math.round(tireWearPct[2]), x: 34, y: 74 },
    { label: "RR", wear: Math.round(tireWearPct[3]), x: 162, y: 74 },
  ];
  return (
    <div className={`${palette.plate} w-[210px] overflow-hidden rounded-[4px] border-t-2 border-t-[#e10600]`}>
      <svg viewBox="0 0 196 98" className="block w-full bg-[rgb(7_9_14/0.9)]" aria-hidden>
        {/* Top-down simplified open-wheel car silhouette */}
        <path
          d="M 86 14 L 110 14 L 112 22 L 104 24 L 106 44 L 116 54 L 114 78 L 106 86 L 90 86 L 82 78 L 80 54 L 90 44 L 92 24 L 84 22 Z"
          fill="rgba(255,255,255,0.06)"
          stroke="rgba(255,255,255,0.28)"
          strokeWidth="1"
        />
        {/* Four tyres on the chassis */}
        <rect x="75" y="21" width="7" height="14" rx="1.5" fill={tyreWearColor(tireWearPct[0])} opacity="0.85" />
        <rect x="114" y="21" width="7" height="14" rx="1.5" fill={tyreWearColor(tireWearPct[1])} opacity="0.85" />
        <rect x="74" y="65" width="8" height="16" rx="1.5" fill={tyreWearColor(tireWearPct[2])} opacity="0.85" />
        <rect x="114" y="65" width="8" height="16" rx="1.5" fill={tyreWearColor(tireWearPct[3])} opacity="0.85" />

        {/* 4 corner wear rings */}
        {corners.map((c) => {
          const col = tyreWearColor(c.wear);
          const r = 15;
          const circ = 2 * Math.PI * r;
          const life = Math.max(0, Math.min(1, (100 - c.wear) / 100));
          return (
            <g key={c.label} transform={`translate(${c.x}, ${c.y})`}>
              <circle r={r} fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.12)" strokeWidth="2.5" />
              <circle
                r={r}
                fill="none"
                stroke={col}
                strokeWidth="2.5"
                strokeDasharray={`${life * circ} ${circ}`}
                transform="rotate(-90)"
              />
              <text y="3.5" fill="#f8fafc" fontSize="9.5" fontWeight="800" textAnchor="middle" fontFamily="var(--font-geist-mono), monospace">
                {c.wear}%
              </text>
            </g>
          );
        })}
        <text x="34" y="51" fill="#94a3b8" fontSize="6" fontWeight="800" textAnchor="middle" letterSpacing="0.8">
          {w.tyreWear}
        </text>
        <text x="162" y="51" fill="#94a3b8" fontSize="6" fontWeight="800" textAnchor="middle" letterSpacing="0.8">
          {w.tyreWear}
        </text>
      </svg>
      {hasErs ? (
        <div className="flex items-center justify-between border-t border-white/10 bg-[rgb(16_20_28/0.95)] px-2.5 py-1 text-[10px] font-extrabold tracking-[0.08em]">
          <span className={overtakeOn || boostOn ? "text-[#facc15]" : "text-slate-400"}>
            {overtakeOn ? w.ersOvertake : boostOn ? w.boost : w.ersDeploy}
          </span>
          <span className={palette.mono}>ERS {Math.round(ers)}%</span>
        </div>
      ) : null}
    </div>
  );
};

/* ============================================================================
 * MAIN COMPONENT
 * ============================================================================ */

export const GrandPrixHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  revRange,
  scale,
  mfd,
  touch,
  lapInvalid,
  towerGaps = "interval",
  compound,
  leftExtra,
  rightExtra,
  showRadar,
  cameraMode,
}) => {
  const units = useUnits();
  const w = useGrandPrixWords();
  const race = t.race;
  const channels = t.f12026;
  const isFormulaCar = carClassOf(channels?.carId) === "openWheel";
  const isHaloMode = cameraMode === "tv_pod" && isFormulaCar;

  const lap = Math.max(1, t.lapCount);
  const totalLaps = race?.totalLaps;
  const me = race?.standings.find((e) => e.isPlayer);
  const myPos = race?.position ?? 1;
  const driverCode = me?.driverCode ?? w.youCode;
  const driverName = me?.name?.trim() || w.youName;
  const teamColor = me?.teamColorHex ?? "#22d3ee";
  const comp = compoundMeta(me?.compound ?? compound);
  const sess = sessionLabel(t, w);
  const aero = aeroReadout(t);

  const hasErs = channels?.hasErs ?? t.liveTuner?.hasErs ?? false;
  const ersCtl = ersButtons(t);
  const boostOn = hasErs && ersCtl.boostOn;
  const overtakeOn = hasErs && (ersCtl.overtake === "on" || ersCtl.overtake === "auto");
  const ers = Math.max(0, Math.min(100, t.ersBatteryPercent));
  const speed = formatSpeed(t.speedKmh, units);
  const speedLbl = speedUnit(units).toUpperCase();
  const gear = gearLabel(t.gear);
  const revFrac = Math.max(0, Math.min(1, (t.rpm - revRange[0]) / Math.max(1, revRange[1] - revRange[0])));
  const atShift = t.rpm >= revRange[1] * 0.96;

  // --------------------------------------------------------------------------
  // MODE A: open-wheel car + TV pod camera -> Halo HUD
  // --------------------------------------------------------------------------
  if (isHaloMode) {
    const standings = race?.standings ?? [];
    const fastestMs = standings.reduce<number | null>(
      (m, e) => (e.bestLapMs && (m === null || e.bestLapMs < m) ? e.bestLapMs : m),
      null,
    );
    const hasFastestLap = Boolean(fastestMs && me?.bestLapMs === fastestMs);

    return (
      <div className={`pointer-events-none absolute inset-0 select-none ${palette.palette}`}>
        {/* Top-left: timing tower */}
        <div
          data-hud-avoid
          className="absolute flex flex-col items-start gap-2"
          style={{ top: touch ? TOUCH_TOP : EDGE, left: EDGE, ...anchor(scale, "top left") }}
        >
          <div className={`${palette.plate} ${palette.tvTower}`}>
            <div className={palette.tvTowerHead}>
              <div className={palette.tvBrandRow}>
                <span className={palette.tvBrandMark}>
                  <span className={palette.tvBrandSlash} />
                  GP
                </span>
                <span className="text-[10px] font-bold tracking-[0.12em] text-slate-400">
                  {w.towerLap(lap, totalLaps ?? 0)}
                </span>
              </div>
              <div className={palette.tvSessionBar}>{sess}</div>
            </div>
            <ol className={palette.tvRows}>
              {standings.length > 0 ? (
                standings.slice(0, 20).map((e, i) => {
                  const gap =
                    i === 0
                      ? formatLapTime(e.bestLapMs || e.lastLapMs)
                      : towerGaps === "leader"
                        ? `+${formatGap(e.gapToLeaderS, true)}`
                        : `+${formatGap(e.intervalS ?? e.gapToLeaderS - standings[i - 1].gapToLeaderS, true)}`;
                  const cMeta = compoundMeta(e.compound);
                  return (
                    <li
                      key={`${i}-${e.driverCode}`}
                      className={`${palette.tvRow} ${e.isPlayer ? palette.tvRowPlayer : ""}`}
                    >
                      <span className={`${palette.tvPos} ${i === 0 ? palette.tvPosLead : ""}`}>{i + 1}</span>
                      <span className="h-3.5 rounded-full" style={{ backgroundColor: e.teamColorHex }} />
                      <span className={palette.tvCode}>{e.driverCode}</span>
                      <span className={palette.tvGap}>{e.retired ? w.towerOut : gap}</span>
                      <span className={palette.tvTyre} style={{ color: cMeta.color }}>
                        {cMeta.letter}
                      </span>
                    </li>
                  );
                })
              ) : (
                <>
                  <li className={`${palette.tvRow} ${palette.tvRowPlayer}`}>
                    <span className={`${palette.tvPos} ${palette.tvPosLead}`}>1</span>
                    <span className="h-3.5 rounded-full" style={{ backgroundColor: teamColor }} />
                    <span className={palette.tvCode}>{driverCode}</span>
                    <span className={palette.tvGap}>{formatLapTime(t.bestLapTimeMs)}</span>
                    <span className={palette.tvTyre} style={{ color: comp.color }}>
                      {comp.letter}
                    </span>
                  </li>
                  {t.lastLapTimeMs ? (
                    <li className={palette.tvRow}>
                      <span className={palette.tvPos}>L</span>
                      <span className="h-3.5 rounded-full bg-slate-600" />
                      <span className={palette.tvCode}>{w.towerLast}</span>
                      <span className={palette.tvGap}>{formatLapTime(t.lastLapTimeMs)}</span>
                      <span className={palette.tvTyre} />
                    </li>
                  ) : null}
                </>
              )}
            </ol>
          </div>
          {leftExtra}
        </div>

        {/* Halo-mounted curved cluster */}
        <HaloCluster t={t} deltaS={deltaS} hasErs={hasErs} revRange={revRange} scale={scale} />

        {/* Bottom-left: Compact Driver Timing Card */}
        <div
          data-hud-avoid
          className="absolute flex flex-col items-start gap-2"
          style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}
        >
          <div className={`${palette.plate} ${palette.driverCard}`}>
            <div className={palette.driverCardHead}>
              <span className={palette.driverCardPos}>{myPos}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={palette.driverCardName}>{driverName}</span>
                {hasFastestLap ? (
                  <span className="rounded-[2px] bg-[#a855f7] px-1 text-[9px] font-black tracking-wider text-white">
                    {w.fastestLap}
                  </span>
                ) : null}
                {me?.penaltyS ? (
                  <span className="rounded-[2px] bg-[#eab308] px-1 text-[9px] font-black text-black">
                    +{Math.round(me.penaltyS)}s
                  </span>
                ) : null}
                {me?.finished ? (
                  <span className="rounded-[2px] bg-white/90 px-1 text-[9px] font-black text-black">
                    {w.finished}
                  </span>
                ) : null}
              </span>
              <span className="text-[12px] font-black" style={{ color: comp.color }}>
                {comp.letter}
              </span>
            </div>
            <div className={palette.driverCardAccent} style={{ backgroundColor: teamColor }} />
            <div className={palette.driverCardBody}>
              <span
                className={palette.driverCardPrimary}
                style={{
                  color: lapInvalid ? HUD_LOSS : deltaS === null ? "#f8fafc" : deltaS <= 0 ? HUD_GAIN : HUD_LOSS,
                }}
              >
                {deltaS !== null ? formatDeltaFit(deltaS) : (lapClockMs(t) / 1000).toFixed(1)}
              </span>
              <div className={palette.driverCardRef}>
                <span className={palette.driverCardRefTime} style={{ color: lapInvalid ? HUD_LOSS : "#f8fafc" }}>
                  {formatLapClock(t)}
                </span>
                <span className={palette.driverCardRefLabel}>
                  {t.bestLapTimeMs ? w.bestRef(formatLapTime(t.bestLapTimeMs)) : w.noRef}
                </span>
              </div>
            </div>
            <div className={palette.driverCardSectors}>
              {[0, 1, 2].map((idx) => (
                <div key={idx} className={palette.sectorPip}>
                  <div
                    className={palette.sectorPipBar}
                    style={{
                      backgroundColor: sectorPipColor(t, idx),
                    }}
                  />
                  <span>S{idx + 1}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Top-right: Larger track layout (always top-right) + weather/extra if present */}
        <div className="absolute flex flex-col items-end gap-2" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
          <div className="h-[156px] w-[206px]">
            <MiniMap map={map} t={t} sectors stroke={24} className="size-full drop-shadow-[0_4px_14px_rgba(0,0,0,0.85)]" />
          </div>
          {rightExtra}
        </div>

        {/* Bottom-right: MFD (accessible in Halo cam too) */}
        {!touch && mfd ? (
          <div
            data-hud-avoid
            className="pointer-events-auto absolute flex flex-col items-end gap-2"
            style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}
          >
            {mfd}
          </div>
        ) : null}

        {showRadar !== false && t.radar?.length ? (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
            <ProximityRadar blips={t.radar} />
          </div>
        ) : null}
      </div>
    );
  }

  // --------------------------------------------------------------------------
  // MODE B: Standard HUD (other cameras or non-open-wheel cars)
  // --------------------------------------------------------------------------
  const deltaFillPct = deltaS === null ? 0 : Math.min(100, Math.abs(deltaS) * 35);
  const deltaColor = deltaS === null ? HUD_SLATE : deltaS <= 0 ? HUD_GAIN : HUD_LOSS;

  return (
    <div className={`pointer-events-none absolute inset-0 select-none ${palette.palette}`}>
      {/* Top-left: Session & Lap / Standings Card */}
      <div
        data-hud-avoid
        className="absolute flex flex-col items-start gap-2"
        style={{ top: touch ? TOUCH_TOP : EDGE, left: EDGE, ...anchor(scale, "top left") }}
      >
        <div className={`${palette.plate} ${palette.stdSessionCard}`}>
          <div className={palette.stdSessionHead}>
            <span className={palette.tvBrandMark}>
              <span className={palette.tvBrandSlash} />
              GP
            </span>
            <span className={palette.stdSessionTitle}>{sess}</span>
          </div>
          <div className={palette.stdLapStrip}>
            <span>{w.stripLap(lap, totalLaps ?? 0)}</span>
            <span className="text-slate-400">{race ? `P${myPos}` : ""}</span>
          </div>
          <div>
            {race?.standings.length ? (
              compactStandings(race.standings).map(({ e, i }) => {
                const cMeta = compoundMeta(e.compound);
                const st = race.standings;
                const gap =
                  i === 0
                    ? formatLapTime(e.bestLapMs || e.lastLapMs)
                    : towerGaps === "leader"
                      ? `+${formatGap(e.gapToLeaderS, true)}`
                      : `+${formatGap(e.intervalS ?? e.gapToLeaderS - st[i - 1].gapToLeaderS, true)}`;
                return (
                  <div key={`${i}-${e.driverCode}`} className={`${palette.stdRow} ${e.isPlayer ? palette.tvRowPlayer : ""}`}>
                    <span className="text-slate-400">{i + 1}</span>
                    <span className="truncate">{e.driverCode}</span>
                    <span className="font-black" style={{ color: cMeta.color }}>
                      {cMeta.letter}
                    </span>
                    <span className={palette.mono}>{e.retired ? w.standingsOut : gap}</span>
                  </div>
                );
              })
            ) : (
              <>
                <div className={`${palette.stdRow} ${palette.tvRowPlayer}`}>
                  <span className="text-slate-400">1</span>
                  <span className="truncate">{driverName}</span>
                  <span className="font-black" style={{ color: comp.color }}>
                    {comp.letter}
                  </span>
                  <span className={palette.mono}>{formatLapTime(t.bestLapTimeMs)}</span>
                </div>
                <div className={palette.stdRow}>
                  <span className="text-slate-400">2</span>
                  <span className="truncate text-slate-300">{w.lastLap}</span>
                  <span className="font-black" style={{ color: comp.color }}>
                    {comp.letter}
                  </span>
                  <span className={palette.mono}>{formatLapTime(t.lastLapTimeMs)}</span>
                </div>
              </>
            )}
          </div>
        </div>
        {leftExtra}
      </div>

      {/* Top-right: Larger Track Layout (always top-right) + rightExtra */}
      <div
        data-hud-avoid
        className="absolute flex flex-col items-end gap-2"
        style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}
      >
        <div className="h-[156px] w-[206px]">
          <MiniMap map={map} t={t} sectors stroke={24} className="size-full drop-shadow-[0_4px_14px_rgba(0,0,0,0.85)]" />
        </div>
        {rightExtra}
      </div>

      {/* Bottom-left: Lap Time, Sectors & Delta Bar (always bottom-left) */}
      {!touch ? (
        <div
          data-hud-avoid
          className="absolute"
          style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}
        >
          <div className={`${palette.plate} ${palette.stdDeltaCard}`}>
            <div className={palette.stdSectorBars}>
              {[0, 1, 2].map((idx) => (
                <div
                  key={idx}
                  className={palette.stdSectorSeg}
                  style={{
                    backgroundColor: sectorPipColor(t, idx),
                  }}
                >
                  S{idx + 1}
                </div>
              ))}
            </div>
            <div className={palette.stdTimeRow}>
              <span className={palette.stdPosCounter}>{totalLaps ? `${lap}/${totalLaps}` : `L${lap}`}</span>
              <span className={palette.stdLapClock} style={{ color: lapInvalid ? HUD_LOSS : "#f8fafc" }}>
                {formatLapClock(t)}
              </span>
            </div>
            <div className={palette.stdDeltaBar}>
              <div
                className={palette.stdDeltaFill}
                style={{
                  width: `${deltaFillPct}%`,
                  background: deltaS !== null && deltaS <= 0 ? HUD_GAIN : HUD_LOSS,
                  left: 0,
                }}
              />
              <span className="relative z-10 text-slate-300">{w.delta}</span>
              <span className={`${palette.mono} relative z-10`} style={{ color: deltaColor }}>
                {deltaS === null ? NO_TIME : formatDeltaFit(deltaS)}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* Bottom-center: Sculpted Dual-Ring Battery/Gear/Speed Cluster */}
      <div
        data-hud-avoid
        className="absolute left-1/2 -translate-x-1/2"
        style={{ bottom: touch ? 88 : EDGE, ...anchor(scale, "bottom center") }}
      >
        <SculptedCluster
          hasErs={hasErs}
          ers={ers}
          fuelKg={t.fuelKg}
          gear={gear}
          atShift={atShift}
          speedLbl={speedLbl}
          speed={speed}
          rpm={t.rpm}
          maxRpm={revRange[1]}
          revFrac={revFrac}
          overtakeActive={boostOn || overtakeOn}
          aeroOpen={aero.open}
          tireTempsC={t.tireTempsC}
          units={units}
        />
      </div>

      {/* Bottom-right: tyre wear diagram + MFD */}
      {!touch ? (
        <div
          data-hud-avoid
          className="pointer-events-auto absolute flex flex-col items-end gap-2"
          style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}
        >
          <TyreWearCard tireWearPct={t.tireWearPct} ers={ers} hasErs={hasErs} boostOn={boostOn} overtakeOn={overtakeOn} />
          {mfd ?? (
            <div className={`${palette.plate} ${palette.stdAidCard}`}>
              <div className={palette.stdAidRow}>
                <span className="text-slate-400">{w.brakeBias}</span>
                <span className={palette.mono}>{(t.liveTuner?.brakeBiasPct ?? 56).toFixed(0)}%</span>
              </div>
              <div className={palette.stdAidRow}>
                <span className="text-slate-400">TC / ABS</span>
                <span className={palette.mono}>
                  {t.liveTuner?.tcLevel ?? 0} / {t.liveTuner?.absLevel ?? 0}
                </span>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {showRadar !== false && t.radar?.length ? (
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2">
          <ProximityRadar blips={t.radar} />
        </div>
      ) : null}
    </div>
  );
};
