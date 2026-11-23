"use client";

/*
 * Retro UI: a recreation, for LibreCorsa's own telemetry, of the look and layout of "Retro UI" by toastbuilds
 * (https://github.com/toastbuilds/assetto-corsa-retro-engineering-hud), MIT licence, Copyright (c) 2026 Kevin. The
 * project's own notices also credit "CMRT Retro Delta Bar contributors" (the delta bar recreated here) and "Kevin /
 * yukkine0704 (Retro Engineering Leaderboard)" (the relative / leaderboard panel recreated here). The full notices are
 * in THIRD_PARTY_NOTICES.md. Players see it only as "Retro UI by toastbuilds".
 *
 * No code, art, font or sound is copied: the instruments are drawn here in SVG and CSS from the project's screenshots
 * and its dark theme's colours (retro.module.css), in the kit's Geist Mono.
 *
 * Kept: the digital dial (rev arc, speed, gear, rpm, pedal side bars, the cells row: TC, ABS, ERS or fuel, the flaps
 * or the brake balance), the delta bar (live delta, sector, lap, running lap, best, session best), the relative panel
 * (best laps, position / driver / gap by road position, the sector boxes), the laps instrument in practice (timer,
 * lap progress, lap history), the car condition panel (tyre life and heat) and a map.
 * Dropped: the analog and other dial variants, the console-style dials, race notices and radar, the lights and pit
 * cells, the telemetry traces, the weather row (the HUD's own weather panel sits under the map) and track records
 * (there is no record source here: that cell is the player's own best). Car numbers become the team colour.
 */

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  aidsActive,
  cornerLabel,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  HUD_BEST,
  HUD_CAUTION,
  HUD_GAIN,
  HUD_INFO,
  HUD_LOSS,
  HUD_SHIFT,
  LAP_MARK_COLOR,
  lapMark,
  NO_TIME,
  sectorDone,
  speedUnit,
  tyreHeatColor,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { damageColor, worstPart } from "../DamageWidget";
import { pedalLayers } from "../PedalBars";
import { type WeatherHudState } from "../WeatherBadge";
import { anchor, deltaColor, formatOnce, gearLabel, liveMessage, MiniMap, type HudDesignProps, type HudMap } from "./hud-style-parts";
import {
  dayClock,
  driverLabel,
  evaluateRadar,
  HEADLIGHT_WORD,
  headlightState,
  RADAR_CAR_L,
  RADAR_CAR_W,
  RADAR_VIEW_RANGE_M,
  radarSideArcPath,
  relativeCars,
  sessionBestLapMs,
  SURFACE_WORD,
  trackSurfaceState,
} from "../third-party-data";
import { revLights, useLapHistory } from "./third-party-parts";
import css from "./retro.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** The Retro UI layout's words in the current language, resolved once per language */
function useRetroWords() {
  const tx = useTranslations("hudStyles.retro");
  return useMemo(
    () => ({
      aidOff: tx("aidOff"),
      fuel: tx("fuel"),
      aero: tx("aero"),
      open: tx("open"),
      armed: tx("armed"),
      shut: tx("shut"),
      brakeBias: tx("brakeBias"),
      dial: liveMessage(["speed", "unit", "gear", "rpm"], (marks) => tx("dial", marks)),
      liveDelta: tx("liveDelta"),
      current: tx("current"),
      invalid: tx("invalid"),
      lapNumber: formatOnce((lap: string) => tx("lapNumber", { lap })),
      personalBest: tx("personalBest"),
      sessionBestShort: tx("sessionBestShort"),
      sessionBest: tx("sessionBest"),
      yourBest: tx("yourBest"),
      headPos: tx("headPos"),
      headDriver: tx("headDriver"),
      headGap: tx("headGap"),
      lapsInvalid: tx("lapsInvalid"),
      noLaps: tx("noLaps"),
      lapBest: tx("lapBest"),
      lapCut: tx("lapCut"),
      puncture: tx("puncture"),
      terminal: tx("terminal"),
      sectorTitle: formatOnce((sector: number, corner: string) => tx("sectorTitle", { sector: String(sector), corner })),
      straight: tx("straight"),
      air: tx("air"),
      track: tx("track"),
      surface: tx("surface"),
      rain: tx("rain"),
      clock: tx("clock"),
      clockFixed: tx("clockFixed"),
      lights: tx("lights"),
      radar: tx("radar"),
    }),
    [tx],
  );
}
type RetroWords = ReturnType<typeof useRetroWords>;

/** The corner groups' distance from the screen's edges, as the game's own layouts */
const EDGE = "clamp(14px,2.2vw,24px)";

type Edge = "outline" | "soft" | "dim" | "cream" | "metal";
type Face = "panel" | "void" | "raised" | "surface" | "row";
const EDGES: Record<Edge, string | undefined> = { outline: undefined, soft: css.edgeSoft, dim: css.edgeDim, cream: css.edgeCream, metal: css.edgeMetal };
const FACES: Record<Face, string | undefined> = { panel: undefined, void: css.faceVoid, raised: css.faceRaised, surface: css.faceSurface, row: css.faceRow };

/** The cut-corner frame every instrument sits in: a 1 px rule in the edge colour round the face */
const Frame: React.FC<{
  edge?: Edge;
  face?: Face;
  size?: "small" | "medium" | "large";
  className?: string;
  faceClassName?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ edge = "outline", face = "panel", size = "medium", className, faceClassName, style, children }) => (
  <div className={cx(css.frame, EDGES[edge], FACES[face], size === "small" ? css.small : size === "large" ? css.large : undefined, className)} style={style}>
    <div className={cx(css.face, faceClassName)}>{children}</div>
  </div>
);

/** The instruments' small value label: secondary bronze, caps */
const LBL = "text-[9px] leading-none tracking-[0.08em] uppercase text-(--tp-secondary)";

/* ---------------------------------------------------------------- Digital dial */

/** The dial's box (SVG units) and its centre */
const DIAL = 260;
const C = DIAL / 2;
/** The rev arc: from 0 rpm at the lower left, clockwise over the top, to the scale's top at the lower right */
const ARC_FROM = -130;
const ARC_SPAN = 260;
const SEGMENTS = 44;
const polar = (r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
const pt = ([x, y]: [number, number]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
/** Each arc segment's outline, built once: a short block between two radii */
const SEGMENT_PATHS = Array.from({ length: SEGMENTS }, (_, i) => {
  const step = ARC_SPAN / SEGMENTS;
  const a0 = ARC_FROM + i * step + 0.8;
  const a1 = ARC_FROM + (i + 1) * step - 0.8;
  return `M${pt(polar(116, a0))}L${pt(polar(116, a1))}L${pt(polar(103, a1))}L${pt(polar(103, a0))}Z`;
});
/** A cut-corner rectangle as an SVG path */
const cutRect = (x: number, y: number, w: number, h: number, c: number) =>
  `M${x + c} ${y}H${x + w - c}L${x + w} ${y + c}V${y + h - c}L${x + w - c} ${y + h}H${x + c}L${x} ${y + h - c}V${y + c}Z`;
/** The parts of the dial that never move: bezel, face, screen frame, side bar frames, the cells' plate */
const DIAL_STATIC = (
  <>
    <circle cx={C} cy={C} r={128} fill="var(--tp-void)" stroke="var(--tp-metal)" strokeWidth={2.5} />
    <circle cx={C} cy={C} r={123.5} fill="var(--tp-surface)" stroke="var(--tp-outline-dim)" strokeWidth={1} />
    <circle cx={C} cy={C} r={119.5} fill="none" stroke="var(--tp-outline-soft)" strokeWidth={0.8} />
    {/* The screen round the gear: a bronze outer frame and the cyan inner rule */}
    <path d={cutRect(83, 93, 94, 86, 10)} fill="var(--tp-panel)" stroke="var(--tp-outline-soft)" strokeWidth={1} />
    <path d={cutRect(89, 99, 82, 74, 8)} fill="var(--tp-void)" stroke="var(--tp-cyan-dim)" strokeWidth={1} />
    {/* Side bars: brake on the left, throttle on the right */}
    <path d={cutRect(59, 103, 18, 68, 4)} fill="var(--tp-panel)" stroke="var(--tp-outline-soft)" strokeWidth={1} />
    <path d={cutRect(183, 103, 18, 68, 4)} fill="var(--tp-panel)" stroke="var(--tp-outline-soft)" strokeWidth={1} />
    {/* The cells' plate */}
    <path d={cutRect(63, 190, 134, 41, 8)} fill="var(--tp-panel)" stroke="var(--tp-outline-dim)" strokeWidth={1} />
  </>
);
/**
 * The dial's smallest text (SVG units): it is drawn as small as 200 px wide (between a tablet's touch pads), and 12 of
 * its 260 units keep every label at 9 px or more there
 */
const LABEL = 12;
/** Segments in each side bar */
const BAR_STEPS = 10;
const BAR_CELLS = Array.from({ length: BAR_STEPS }, (_, i) => 165 - i * 6.2);

/** A cell under the dial's screen: a label and a short value */
interface DialCell {
  id: string;
  label: string;
  value: string;
  /** Lit: an aid acting, the flaps open, the battery deploying */
  tone?: string;
}

/** The cells the car has: TC and ABS with the live tuner, ERS or fuel, the flaps or the brake balance */
function dialCells(t: CarTelemetry, w: RetroWords): DialCell[] {
  const cells: DialCell[] = [];
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  if (tuner) {
    cells.push({ id: "tc", label: "TC", value: tuner.tcLevel > 0 ? String(tuner.tcLevel) : w.aidOff, tone: aids.tc ? HUD_CAUTION : undefined });
    cells.push({ id: "abs", label: "ABS", value: tuner.absLevel > 0 ? String(tuner.absLevel) : w.aidOff, tone: aids.abs ? HUD_CAUTION : undefined });
  }
  const hasErs = t.f12026?.hasErs ?? t.liveTuner?.hasErs ?? false;
  if (hasErs) {
    cells.push({ id: "ers", label: "ERS", value: String(Math.round(t.ersBatteryPercent)), tone: t.mgukPowerKw > 0 ? HUD_INFO : undefined });
  } else if (t.fuelKg > 0) {
    cells.push({ id: "fuel", label: w.fuel, value: t.fuelKg >= 10 ? t.fuelKg.toFixed(0) : t.fuelKg.toFixed(1) });
  }
  const aero = aeroReadout(t);
  if (hasErs && t.overtakingRules !== "none") {
    // 2026: X (both flaps open) or Z; older cars: the rear flap
    const value = aero.straightMode ? (aero.open ? "X" : "Z") : aero.open ? w.open : aero.armed ? w.armed : w.shut;
    cells.push({ id: "aero", label: aero.straightMode ? w.aero : "DRS", value, tone: aero.open || aero.armed ? HUD_INFO : undefined });
  } else if (tuner && tuner.brakeBiasPct > 0) {
    cells.push({ id: "bb", label: w.brakeBias, value: tuner.brakeBiasPct.toFixed(1) });
  }
  return cells.slice(0, 4);
}

/**
 * The digital dial: an arc of rev segments round speed, the gear on its screen and the rpm, brake and throttle on the
 * side bars, and the car's cells underneath. The scale runs to just past the car's shift point.
 */
const RetroDial: React.FC<{ t: CarTelemetry; revRange: [number, number]; className?: string }> = ({ t, revRange, className }) => {
  const units = useUnits();
  const revFull = revRange[1];
  const maxRpm = Math.max(4000, Math.ceil((revFull * 1.1) / 1000) * 1000);
  // Numerals every 1000 rpm, every 2000 on a high-revving engine; the ones past the shift point in red
  const numerals = useMemo(() => {
    const k = maxRpm / 1000;
    const step = k > 10 ? 2 : 1;
    return Array.from({ length: Math.floor(k / step) + 1 }, (_, i) => {
      const n = i * step;
      const [x, y] = polar(93, ARC_FROM + (ARC_SPAN * n * 1000) / maxRpm);
      return { n, x, y, red: n * 1000 >= revFull };
    });
  }, [maxRpm, revFull]);
  const redFrom = Math.floor((revFull / maxRpm) * SEGMENTS);
  const lit = Math.max(0, Math.min(SEGMENTS, Math.round((t.rpm / maxRpm) * SEGMENTS)));
  // The shift point, by the one rule the HUD, the wheel and the pad share
  const { atShift } = revLights(t.rpm, revRange, SEGMENTS);
  const p = pedalLayers(t);
  const brakeLit = Math.round(p.brakeOut * BAR_STEPS);
  const throttleLit = Math.round(p.throttleOut * BAR_STEPS);
  const steer = Math.max(-1, Math.min(1, t.steering));
  const w = useRetroWords();
  const cells = dialCells(t, w);
  const cellW = 30;
  const cellX0 = C - (cells.length * cellW + (cells.length - 1) * 2.5) / 2;

  return (
    <svg viewBox={`0 0 ${DIAL} ${DIAL}`} className={className} role="img" aria-label={w.dial({ speed: formatSpeed(t.speedKmh, units), unit: speedUnit(units), gear: gearLabel(t.gear), rpm: String(Math.round(t.rpm)) })}>
      {DIAL_STATIC}
      {SEGMENT_PATHS.map((d, i) => {
        const red = i >= redFrom;
        const on = i < lit;
        const fill = on ? (atShift ? HUD_SHIFT : red ? "var(--tp-red)" : "var(--tp-primary)") : red ? "var(--tp-red-dim)" : "var(--tp-inactive)";
        return <path key={i} d={d} fill={fill} />;
      })}
      {numerals.map((m) => (
        <text key={m.n} x={m.x} y={m.y + 4.5} textAnchor="middle" fontSize={13} fill={m.red ? "var(--tp-red)" : "var(--tp-primary)"}>
          {m.n}
        </text>
      ))}
      {/* Speed and its unit across the top */}
      <text x={C} y={70} textAnchor="middle" fontSize={26} fill="var(--tp-primary)">
        {formatSpeed(t.speedKmh, units)}
      </text>
      <text x={C} y={82} textAnchor="middle" fontSize={LABEL} fill="var(--tp-secondary)">
        {speedUnit(units)}
      </text>
      {/* Steering: a slider over the screen */}
      <line x1={104} x2={156} y1={88.5} y2={88.5} stroke="var(--tp-outline-soft)" strokeWidth={1.5} />
      <line x1={C} x2={C} y1={86} y2={91} stroke="var(--tp-outline)" strokeWidth={1} />
      <circle cx={C + steer * 26} cy={88.5} r={2.6} fill="var(--tp-primary)" />
      {/* Gear and rpm on the screen */}
      <text x={C} y={153} textAnchor="middle" fontSize={58} fill={atShift ? HUD_SHIFT : "var(--tp-primary)"}>
        {gearLabel(t.gear)}
      </text>
      <text x={C} y={169} textAnchor="middle" fontSize={15} fill="var(--tp-primary)">
        {Math.round(t.rpm)}
      </text>
      <text x={C} y={187} textAnchor="middle" fontSize={LABEL} fill="var(--tp-secondary)">
        RPM
      </text>
      {/* Brake (left) and throttle (right), filled from the bottom */}
      {BAR_CELLS.map((y, i) => (
        <React.Fragment key={i}>
          <rect x={63} y={y} width={10} height={4.6} fill={i < brakeLit ? "var(--tp-red)" : "var(--tp-inactive)"} />
          <rect x={187} y={y} width={10} height={4.6} fill={i < throttleLit ? "var(--tp-cyan)" : "var(--tp-inactive)"} />
        </React.Fragment>
      ))}
      {/* The cells row */}
      {cells.map((c, i) => {
        const x = cellX0 + i * (cellW + 2.5);
        return (
          <g key={c.id}>
            <path d={cutRect(x, 193, cellW, 33, 5)} fill="var(--tp-void)" stroke={c.tone ?? "var(--tp-outline-soft)"} strokeWidth={1} />
            <text x={x + cellW / 2} y={205} textAnchor="middle" fontSize={LABEL} fill={c.tone ?? "var(--tp-secondary)"}>
              {c.label}
            </text>
            <text x={x + cellW / 2} y={220.5} textAnchor="middle" fontSize={c.value.length > 3 ? LABEL : 14} fill={c.tone ?? "var(--tp-primary)"}>
              {c.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/* ---------------------------------------------------------------- Delta bar */

/** The bar reads ±1 s from its centre: time lost to the left, gained to the right */
const DELTA_RANGE_S = 1;
const DELTA_TICKS = Array.from({ length: 17 }, (_, i) => i);

/**
 * The delta bar: a ticked bar with the live delta's marker, the big live delta, and the sector, lap, running lap, best
 * and session best beside it. On a narrow screen only the bar and the big number.
 */
const RetroDeltaBar: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean }> = ({ t, deltaS, lapInvalid }) => {
  const d = deltaS === null ? null : Math.max(-DELTA_RANGE_S, Math.min(DELTA_RANGE_S, deltaS));
  // Lost time to the left of the centre line, gained time to the right
  const at = d === null ? 50 : 50 - (d / DELTA_RANGE_S) * 50;
  const tone = deltaColor(deltaS);
  const lap = t.race ? t.race.lap : Math.max(1, t.lapCount);
  const sessionBest = sessionBestLapMs(t);
  const w = useRetroWords();
  return (
    <Frame size="large" className="w-[460px] max-xl:w-[224px]" faceClassName="flex flex-col gap-1.5 p-1.5">
      <Frame edge="soft" face="void" size="small" className="h-5.5" faceClassName="relative overflow-hidden">
        {DELTA_TICKS.map((i) => (
          <span
            key={i}
            aria-hidden
            className={cx("absolute bottom-1 w-px bg-(--tp-outline-soft)", i % 4 === 0 ? "h-2.5" : "h-1.5")}
            style={{ left: `${(i / 16) * 100}%` }}
          />
        ))}
        {d !== null ? (
          <>
            <span
              aria-hidden
              className="absolute inset-y-1 opacity-45"
              style={{ left: `${Math.min(at, 50)}%`, width: `${Math.abs(at - 50)}%`, backgroundColor: tone }}
            />
            <span aria-hidden className="absolute inset-y-0.5 w-1 -translate-x-1/2" style={{ left: `${at}%`, backgroundColor: tone }} />
          </>
        ) : null}
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-(--tp-primary)" />
      </Frame>
      <div className="flex gap-1.5">
        <Frame edge="outline" face="raised" className="h-14 w-[180px] shrink-0 max-xl:w-full" faceClassName="flex flex-col items-center justify-center gap-1">
          <span className="text-[26px] leading-none" style={{ color: tone }}>
            {/* The kit's delta spelling at the source's two decimals, one fewer past 10 s so it keeps its width */}
            {deltaS === null ? NO_TIME : formatDeltaFit(deltaS, 2)}
          </span>
          <span className={LBL}>{w.liveDelta}</span>
        </Frame>
        <Frame edge="dim" face="panel" className="min-w-0 flex-1 max-xl:hidden" faceClassName="grid grid-cols-[0.8fr_1.1fr_1.1fr] content-center gap-x-2 gap-y-2 px-2.5 text-[11px] leading-none whitespace-nowrap">
          <span className="text-(--tp-amber)">
            S{String(t.currentSector).padStart(2, "0")} / 03
          </span>
          <span>
            <span className="text-(--tp-primary)">{w.current}</span>{" "}
            <span style={{ color: lapInvalid ? HUD_LOSS : undefined }}>{formatLapClock(t)}</span>
          </span>
          <span style={{ color: HUD_LOSS }}>{lapInvalid ? w.invalid : ""}</span>
          <span className="text-(--tp-cyan)">{w.lapNumber(String(lap).padStart(2, "0"))}</span>
          <span>
            <span className="text-(--tp-cyan)">{w.personalBest}</span> <span className="text-(--tp-cyan)">{formatLapTime(t.bestLapTimeMs)}</span>
          </span>
          <span>
            <span className="text-(--tp-green)">{w.sessionBestShort}</span> <span style={{ color: sessionBest ? HUD_BEST : undefined }}>{formatLapTime(sessionBest)}</span>
          </span>
        </Frame>
      </div>
    </Frame>
  );
};

/* ---------------------------------------------------------------- Sectors */

/** S1 / S2 / S3: done sectors tinted by how they went, the current one outlined with a dot */
const SectorBoxes: React.FC<{ t: CarTelemetry }> = ({ t }) => (
  <div className="grid grid-cols-3 gap-1">
    {[0, 1, 2].map((i) => {
      const current = i + 1 === t.currentSector;
      const ms = t.sectorTimesMs[i];
      // This lap's timed sectors only (none on the out-lap from the grid, which starts in sector 3)
      const mark = sectorDone(t, i) ? lapMark(ms, t.bestSectorTimesMs[i], !t.race) : null;
      const color = mark ? LAP_MARK_COLOR[mark] : undefined;
      return (
        <Frame key={i} edge={current ? "cream" : "dim"} face="void" size="small" className="h-6.5" faceClassName="relative flex items-center justify-center gap-1.5 text-[10px]">
          <span className={current ? "text-(--tp-primary)" : "text-(--tp-secondary)"}>S{i + 1}</span>
          {current ? <span aria-hidden className="size-1 rounded-full bg-(--tp-primary)" /> : null}
          {mark ? <span style={{ color }}>{formatSectorTime(ms)}</span> : null}
          {mark ? <span aria-hidden className="absolute inset-x-1 bottom-0.5 h-0.5" style={{ backgroundColor: color }} /> : null}
        </Frame>
      );
    })}
  </div>
);

/* ---------------------------------------------------------------- Relative (race) */

/** A best-lap cell: a colour bar, the label and the time */
const RecordCell: React.FC<{ label: string; ms: number | null; color: string }> = ({ label, ms, color }) => (
  <Frame edge="soft" face="void" size="small" className="min-w-0 flex-1" faceClassName="flex flex-col gap-1 px-2 py-1.5">
    <span className={LBL}>{label}</span>
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="h-4 w-0.75 shrink-0" style={{ backgroundColor: color }} />
      <span className="text-[17px] leading-none">{formatLapTime(ms)}</span>
    </span>
  </Frame>
);

/**
 * The relative panel: the session's best and the player's, the cars nearest on the road (position, driver, gap; the
 * player's row amber), and the sector boxes
 */
const RelativePanel: React.FC<{ t: CarTelemetry; map: HudMap }> = ({ t, map }) => {
  const standings = t.race?.standings ?? [];
  const rows = relativeCars(t, map.lengthM, 3);
  const me = rows.findIndex((r) => r.entry.isPlayer);
  const w = useRetroWords();
  return (
    <Frame size="large" edge="metal" face="panel" faceClassName="flex flex-col gap-2 p-2">
      <div className="flex gap-1.5 max-md:hidden">
        <RecordCell label={w.sessionBest} ms={sessionBestLapMs(t)} color={HUD_BEST} />
        <RecordCell label={w.yourBest} ms={t.bestLapTimeMs} color={HUD_GAIN} />
      </div>
      <div className="flex flex-col">
        <div className="grid grid-cols-[34px_1fr_auto] px-2 pb-1 text-[11px] text-(--tp-secondary)">
          <span>{w.headPos}</span>
          <span>{w.headDriver}</span>
          <span className="text-right">{w.headGap}</span>
        </div>
        {rows.map((r, i) => {
          const k = Math.abs(i - me);
          const pos = standings.indexOf(r.entry) + 1;
          const player = r.entry.isPlayer;
          const gap = player ? "0.0" : `${r.gapS > 0 ? "−" : "+"}${formatGap(Math.abs(r.gapS))}`;
          return (
            <div
              key={r.entry.driverCode + (r.entry.name ?? "")}
              className={cx(
                "relative grid h-5.5 grid-cols-[34px_1fr_auto] items-center pr-2 pl-2 text-[14px] leading-none",
                player && "bg-(--tp-amber-dim)",
                k === 3 && "compact:hidden",
              )}
            >
              <span aria-hidden className="absolute inset-y-0.5 left-0 w-0.75" style={{ backgroundColor: r.entry.teamColorHex }} />
              <span>{pos > 0 ? pos : "-"}</span>
              <span
                className={cx(
                  "truncate uppercase",
                  !player && r.lapsAhead > 0 && "text-(--tp-cyan)",
                  !player && r.lapsAhead < 0 && "text-(--tp-secondary)",
                )}
              >
                {driverLabel(r.entry)}
              </span>
              <span className="text-right">{gap}</span>
            </div>
          );
        })}
      </div>
      <SectorBoxes t={t} />
    </Frame>
  );
};

/* ---------------------------------------------------------------- Laps (practice) */

const LAP_PROGRESS_STEPS = 16;

/** The laps instrument: the running lap's timer, its number and progress round the lap, and the laps completed */
const LapsPanel: React.FC<{ t: CarTelemetry; lapInvalid: boolean }> = ({ t, lapInvalid }) => {
  const laps = useLapHistory(6);
  const bestMs = t.bestLapTimeMs;
  const done = Math.floor(Math.max(0, Math.min(1, t.trackProgress)) * LAP_PROGRESS_STEPS);
  const box = "flex h-full w-10 items-center justify-center text-[15px]";
  const w = useRetroWords();
  return (
    <div className="flex flex-col gap-1.5">
      <Frame edge="outline" face="raised" size="large" className="h-15" faceClassName="flex items-center justify-center gap-3">
        <span className="text-[32px] leading-none" style={{ color: lapInvalid ? HUD_LOSS : undefined }}>
          {formatLapClock(t)}
        </span>
        {lapInvalid ? (
          <span className="text-[11px] leading-none" style={{ color: HUD_LOSS }}>
            {w.lapsInvalid}
          </span>
        ) : null}
      </Frame>
      <div className="flex h-8 gap-1.5">
        <Frame edge="soft" face="void" size="small" faceClassName={box}>
          {String(Math.max(1, t.lapCount)).padStart(2, "0")}
        </Frame>
        <Frame edge="dim" face="void" size="small" className="flex-1" faceClassName="flex h-full items-stretch gap-0.5 p-1">
          {Array.from({ length: LAP_PROGRESS_STEPS }, (_, i) => (
            <span key={i} aria-hidden className={cx("flex-1", i < done ? "bg-(--tp-cyan-dim)" : "bg-(--tp-inactive)")} />
          ))}
        </Frame>
      </div>
      {laps.length === 0 ? (
        <Frame edge="dim" face="row" size="small" className="h-8" faceClassName="flex items-center px-3 text-[12px] text-(--tp-secondary)">
          {w.noLaps}
        </Frame>
      ) : (
        laps.map((l, i) => {
          const best = bestMs !== null && l.valid && Math.abs(l.ms - bestMs) < 0.5;
          return (
            <div key={l.lap} className={cx("flex h-8 gap-1.5", i >= 3 && "compact:hidden")}>
              <Frame edge="soft" face="void" size="small" faceClassName={box}>
                {String(l.lap).padStart(2, "0")}
              </Frame>
              <Frame edge="dim" face="row" size="small" className="flex-1" faceClassName="flex items-center gap-2.5 px-2.5">
                <span aria-hidden className="h-4 w-0.75" style={{ backgroundColor: best ? HUD_BEST : "var(--tp-amber)" }} />
                <span className={cx("text-[16px] leading-none", !l.valid && "text-(--tp-secondary) line-through")}>{formatLapTime(l.ms)}</span>
                <span className="ml-auto text-[10px] leading-none" style={{ color: best ? HUD_BEST : l.valid ? undefined : HUD_LOSS }}>
                  {best ? w.lapBest : l.valid ? "" : w.lapCut}
                </span>
              </Frame>
            </div>
          );
        })
      )}
    </div>
  );
};

/* ---------------------------------------------------------------- Car condition */

const CORNER_NAMES = ["FL", "FR", "RL", "RR"] as const;

/** One tyre: its life as a bar coloured by the tread's heat, the life in %, the temperature under it */
const TyreLife: React.FC<{ t: CarTelemetry; i: number; mirror: boolean }> = ({ t, i, mirror }) => {
  const units = useUnits();
  const life = Math.max(0, Math.min(100, 100 - (t.tireWearPct[i] ?? 0)));
  const heat = tyreHeatColor(t.tireTempsC[i] ?? 0, t.tireOptimalTempC);
  return (
    <div className={cx("flex items-end gap-2", mirror && "flex-row-reverse")}>
      {/* Fixed width, so the bars line up whatever the number */}
      <div className={cx("flex w-[48px] flex-col gap-0.5", mirror ? "items-start" : "items-end")}>
        <span className="text-[20px] leading-none">
          {Math.round(life)}
          <span className="text-[10px] text-(--tp-secondary)">%</span>
        </span>
        <span className="text-[10px] leading-none text-(--tp-secondary)">{formatTemp(t.tireTempsC[i] ?? 0, units)}</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <span className="text-[10px] leading-none">{CORNER_NAMES[i]}</span>
        <Frame edge="soft" face="void" size="small" className="h-11 w-3.5" faceClassName="relative">
          <span aria-hidden className="absolute inset-x-0.5 bottom-0.5" style={{ height: `calc(${life}% - 4px)`, backgroundColor: heat }} />
        </Frame>
      </div>
    </div>
  );
};

/** The car condition panel: four tyres round the car's outline, plus chassis damage bands when damaged */
const ConditionPanel: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const dmg = t.race?.damage ?? t.practiceDamage;
  const wheels = dmg
    ? [
        { x: 4, y: 26, i: 1 },
        { x: 33, y: 26, i: 0 },
        { x: 4, y: 74, i: 3 },
        { x: 33, y: 74, i: 2 },
      ]
    : [];
  const hasDamage = Boolean(dmg && (dmg.overall >= 0.01 || dmg.terminal || dmg.punctured.some(Boolean)));
  const w = useRetroWords();
  return (
    <Frame size="large" faceClassName="grid grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-3 px-3 py-2.5">
      <TyreLife t={t} i={0} mirror={false} />
      <svg viewBox="0 0 40 100" className="row-span-2 h-[104px] w-[42px]" aria-hidden>
        <path d="M20 2 L24 9 L16 9 Z" fill={dmg && dmg.front >= 0.05 ? damageColor(dmg.front) : "var(--tp-outline)"} />
        <path d="M13 14 L27 14 L33 26 L33 80 L28 96 L12 96 L7 80 L7 26 Z" fill="var(--tp-surface)" stroke="var(--tp-metal)" strokeWidth={1.2} />
        <path d={cutRect(13, 34, 14, 22, 3)} fill="none" stroke="var(--tp-outline-dim)" strokeWidth={1} />
        <path d={cutRect(14, 62, 12, 22, 3)} fill="none" stroke="var(--tp-outline-dim)" strokeWidth={1} />
        {dmg ? (
          <>
            <rect x="11" y="13" width="18" height="3.5" fill={damageColor(dmg.front)} />
            <rect x="7.5" y="34" width="2.5" height="32" fill={damageColor(dmg.left)} />
            <rect x="30" y="34" width="2.5" height="32" fill={damageColor(dmg.right)} />
            <rect x="12" y="90" width="16" height="4" fill={damageColor(dmg.rear)} />
            {wheels.map((w) => (
              <rect
                key={w.i}
                x={w.x}
                y={w.y}
                width="3"
                height="9"
                fill={dmg.punctured[w.i] ? HUD_LOSS : damageColor(dmg.suspension[w.i])}
              />
            ))}
          </>
        ) : null}
      </svg>
      <TyreLife t={t} i={1} mirror />
      <TyreLife t={t} i={2} mirror={false} />
      <TyreLife t={t} i={3} mirror />
      {hasDamage && dmg ? (
        <div className="col-span-3 flex items-center justify-between gap-2 border-t border-(--tp-outline-dim) pt-1.5 text-[10px] leading-none uppercase">
          <span className="text-(--tp-secondary)">{dmg.punctured.some(Boolean) ? w.puncture : worstPart(dmg)}</span>
          <span style={{ color: dmg.terminal ? HUD_LOSS : damageColor(Math.max(0.05, dmg.overall)) }}>
            {dmg.terminal ? w.terminal : `${Math.round(dmg.overall * 100)}%`}
          </span>
        </div>
      ) : null}
    </Frame>
  );
};

/* ---------------------------------------------------------------- Map */

const MapPanel: React.FC<Pick<HudDesignProps, "t" | "map" | "mapMode">> = ({ t, map, mapMode = "full" }) => {
  const corner = cornerLabel(t.currentTurnNumber, t.currentTurnName);
  const w = useRetroWords();
  return (
    <Frame size="large" faceClassName="flex flex-col gap-1.5 px-2.5 pt-2 pb-2">
      <MiniMap
        map={map}
        t={t}
        outline="var(--tp-primary)"
        local={mapMode === "local"}
        className={cx("block w-full", mapMode === "local" ? "h-[150px]" : "h-[118px]")}
        stroke={16}
      />
      {/* The sector and the corner's number, the corner's own name in full under them; two lines kept either way, so
          the panel does not grow and shrink at every corner */}
      <div className="flex min-h-6 flex-col gap-1 text-[10px] leading-none" title={w.sectorTitle(t.currentSector, corner ? corner.full : w.straight)}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-(--tp-amber)">S{String(t.currentSector).padStart(2, "0")}</span>
          <span className="text-(--tp-secondary)">{corner ? corner.short : w.straight}</span>
        </div>
        {corner?.name ? <span className="text-(--tp-secondary)">{corner.name}</span> : null}
      </div>
    </Frame>
  );
};

/* ---------------------------------------------------------------- Weather & Radar */

const WeatherPanel: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const units = useUnits();
  const surface = trackSurfaceState(weather.waterMm);
  const lights = headlightState(weather);
  const w = useRetroWords();
  return (
    <Frame size="medium" faceClassName="grid grid-cols-2 gap-x-2 gap-y-1.5 px-2.5 py-2">
      <div className="flex flex-col gap-0.5">
        <span className={LBL}>{w.air}</span>
        <span className="text-[13px] leading-none">{formatTemp(weather.airC, units)}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className={LBL}>{w.track}</span>
        <span className="text-[13px] leading-none">{formatTemp(weather.trackC, units)}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className={LBL}>{w.surface}</span>
        <span
          className="text-[11px] leading-none uppercase"
          style={{ color: surface === "dry" ? undefined : surface === "damp" ? "var(--tp-amber)" : HUD_INFO }}
        >
          {SURFACE_WORD[surface]}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className={LBL}>{weather.rain > 0.05 ? w.rain : w.clock}</span>
        <span className="text-[11px] leading-none">
          {weather.rain > 0.05 ? `${Math.round(weather.rain * 100)}%` : weather.timeMoving ? dayClock(weather.clockH) : w.clockFixed}
        </span>
      </div>
      {lights ? (
        <div className="flex flex-col gap-0.5">
          <span className={LBL}>{w.lights}</span>
          <span
            className="text-[11px] leading-none uppercase"
            style={{ color: lights === "flash" ? "var(--tp-amber)" : lights === "off" ? "rgba(255,255,255,0.45)" : undefined }}
          >
            {HEADLIGHT_WORD[lights]}
          </span>
        </div>
      ) : null}
    </Frame>
  );
};

const RetroRadar: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const w = useRetroWords();
  const { blips, leftCar, rightCar, opacity } = evaluateRadar(t.radar ?? []);
  if (opacity <= 0.01) return null;
  const range = RADAR_VIEW_RANGE_M;
  const maxOverlap = Math.max(leftCar?.overlapLevel ?? 0, rightCar?.overlapLevel ?? 0);
  const edgeStyle = maxOverlap === 2 ? { backgroundColor: HUD_LOSS } : maxOverlap === 1 ? { backgroundColor: "var(--tp-amber)" } : undefined;
  return (
    <div
      className="pointer-events-none absolute top-[53%] left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ease-out"
      style={{ width: 152, height: 152, opacity }}
    >
      <Frame size="large" face="void" className="size-full" style={edgeStyle} faceClassName="size-full">
        <svg viewBox={`${-range} ${-range} ${range * 2} ${range * 2}`} className="block size-full" role="img" aria-label={w.radar}>
          <circle r={8} fill="none" stroke="var(--tp-outline-dim)" strokeWidth={0.35} />
          <circle r={16} fill="none" stroke="var(--tp-outline-dim)" strokeWidth={0.35} />
          <line x1={0} y1={-range} x2={0} y2={range} stroke="var(--tp-outline-dim)" strokeWidth={0.25} />
          <line x1={-range} y1={0} x2={range} y2={0} stroke="var(--tp-outline-dim)" strokeWidth={0.25} />
          {leftCar ? (
            <path
              d={radarSideArcPath(-1, leftCar)}
              fill="none"
              stroke={leftCar.overlapLevel === 2 ? HUD_LOSS : HUD_CAUTION}
              strokeOpacity={Math.max(0.65, leftCar.opacity)}
              strokeWidth={leftCar.overlapLevel === 2 ? 2.1 : 1.5}
              strokeLinecap="round"
            />
          ) : null}
          {rightCar ? (
            <path
              d={radarSideArcPath(1, rightCar)}
              fill="none"
              stroke={rightCar.overlapLevel === 2 ? HUD_LOSS : HUD_CAUTION}
              strokeOpacity={Math.max(0.65, rightCar.opacity)}
              strokeWidth={rightCar.overlapLevel === 2 ? 2.1 : 1.5}
              strokeLinecap="round"
            />
          ) : null}
          {blips.map(({ blip: b, opacity: carOp, overlapLevel }, i) => (
            <rect
              key={i}
              x={-RADAR_CAR_W / 2}
              y={-RADAR_CAR_L / 2}
              width={RADAR_CAR_W}
              height={RADAR_CAR_L}
              fill={overlapLevel === 2 ? HUD_LOSS : overlapLevel === 1 ? HUD_CAUTION : b.color}
              fillOpacity={Math.max(0.35, carOp)}
              stroke="var(--tp-void)"
              strokeWidth={0.35}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          ))}
          <rect
            x={-RADAR_CAR_W / 2}
            y={-RADAR_CAR_L / 2}
            width={RADAR_CAR_W}
            height={RADAR_CAR_L}
            fill="var(--tp-amber)"
            stroke="var(--tp-void)"
            strokeWidth={0.35}
          />
        </svg>
      </Frame>
    </div>
  );
};

/* ---------------------------------------------------------------- Layout */

/**
 * Retro UI: warm graphite instruments with cream mono text and bronze cut-corner rules. The relative panel (a race)
 * or the laps instrument (practice) top-left, the delta bar top-centre, the map top-right, the car condition
 * bottom-left and the digital dial bottom-centre. With the touch controls up (a tablet) the bottom corners are the
 * pads': the condition panel steps aside and the dial gets smaller between them.
 */
export const RetroHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  revRange,
  scale,
  mfd,
  lapInvalid,
  mapMode,
  leftExtra,
  rightExtra,
  touch,
  topInset,
  weather,
  showDeltaBar,
  showRadar,
}) => (
  <div className={cx("pointer-events-none absolute inset-0 select-none", css.palette)}>
    <div
      className="absolute flex w-[300px] flex-col gap-2 max-lg:w-[256px] max-md:w-[220px]"
      style={{ top: touch ? 68 : EDGE, left: EDGE, ...anchor(scale, "top left") }}
    >
      {t.race ? <RelativePanel t={t} map={map} /> : <LapsPanel t={t} lapInvalid={lapInvalid} />}
      {leftExtra}
    </div>

    {showDeltaBar !== false ? (
      <div className="absolute left-1/2 hidden -translate-x-1/2 md:block" style={{ top: topInset ?? EDGE, ...anchor(scale, "top center") }}>
        <RetroDeltaBar t={t} deltaS={deltaS} lapInvalid={lapInvalid} />
      </div>
    ) : null}

    <div className="absolute hidden w-[204px] md:block" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
      <MapPanel t={t} map={map} mapMode={mapMode} />
      {weather ? (
        <div className="mt-2">
          <WeatherPanel weather={weather} />
        </div>
      ) : null}
      {rightExtra ? <div className="mt-2">{rightExtra}</div> : null}
    </div>

    {showRadar !== false ? <RetroRadar t={t} /> : null}

    {touch ? null : (
      <div data-hud-floor data-hud-avoid className="absolute w-[218px] compact:hidden" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
        <ConditionPanel t={t} />
      </div>
    )}

    {mfd ? (
      <div data-hud-avoid className="absolute hidden lg:block" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
        {mfd}
      </div>
    ) : null}

    <div data-hud-avoid className="absolute left-1/2 -translate-x-1/2" style={{ bottom: EDGE, ...anchor(scale, "bottom center") }}>
      <RetroDial t={t} revRange={revRange} className={cx("block h-auto", touch ? "w-[200px] xl:w-[260px]" : "w-[260px] compact:w-[220px]")} />
    </div>
  </div>
);
