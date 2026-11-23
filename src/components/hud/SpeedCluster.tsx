"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  aidsActive,
  atShiftPoint,
  formatSpeed,
  revRangeFor,
  speedUnit,
  HUD_BRAKE,
  PROTO_CAR_IDS,
  CLASSIC_CAR_IDS,
  ROAD_CAR_IDS,
  HUD_GLASS,
  HUD_GREEN,
  HUD_INFO,
  HUD_LBL,
  HUD_LOSS,
  HUD_RED,
  HUD_SHIFT,
  HUD_THROTTLE,
  HUD_VOLT,
  HUD_WHITE,
  HUD_YELLOW,
} from "./hud-format";
import { AidLamp } from "./F12026ChannelsPanel";
import { aeroReadout } from "./aero-label";
import { revLedBand, type RevLedBand } from "@/lib/sim/rev-range";
import { AeroBadge } from "./styles/hud-style-parts";
import { ersButtons } from "./ers-buttons";

/** Rev lights: 15 LEDs over the top end of the rev range (green, amber, red; all in the shift colour at the shift point) */
const REV_LEDS = 15;
const LED_INDEXES = Array.from({ length: REV_LEDS }, (_, i) => i);

/** The HUD's colour for each band; the car's own wheel lights the same LED in the same band (`revLedBand`) */
const LED_BAND_COLOR: Record<RevLedBand, string> = { green: HUD_GREEN, yellow: HUD_YELLOW, red: HUD_RED, shift: HUD_SHIFT };
const ledColor = (i: number) => LED_BAND_COLOR[revLedBand(i, REV_LEDS)];

interface SpeedClusterProps {
  telemetry: CarTelemetry;
  /** The player's boost latch. The button shows what the physics reports (`manualOverrideActive`), not the request */
  boostLatch: boolean;
  onToggleBoostLatch: () => void;
  /** Use the Overtake earned in a race, or stop using it (a 2026 F1 car) */
  onOvertake?: () => void;
  onToggleXMode: () => void;
  /** Minimal HUD: a speed and gear pill under a slim status strip */
  variant?: "full" | "minimal";
}

/** Vertical input bar (brake / throttle / force) with its letter under it */
const InputBar: React.FC<{ label: string; pct: number; color: string; labelColor?: string; title: string; h: string }> = ({
  label,
  pct,
  color,
  labelColor,
  title,
  h,
}) => (
  <span className="flex flex-col items-center gap-[3px]" title={title}>
    <span className={`relative w-1.75 overflow-hidden rounded-full bg-lc-titanium ${h}`}>
      <span className="absolute inset-0 origin-bottom" style={{ transform: `scaleY(${pct / 100})`, backgroundColor: color }} />
    </span>
    <span className={HUD_LBL} style={labelColor ? { color: labelColor } : undefined}>
      {label}
    </span>
  </span>
);

/** Bottom-right LibreCorsa MoTeC-style digital dash pod: rev lights, gear, speed, pedals/FFB, ERS and aero state */
export const SpeedCluster: React.FC<SpeedClusterProps> = ({
  telemetry,
  onToggleBoostLatch,
  onOvertake,
  onToggleXMode,
  variant = "full",
}) => {
  const channels = telemetry.f12026;
  const isGt3 = channels?.carId === "amg-gt3";
  const isRoad = ROAD_CAR_IDS.has(channels?.carId ?? "");
  const isProto = PROTO_CAR_IDS.has(channels?.carId ?? "");
  const isClassic = CLASSIC_CAR_IDS.has(channels?.carId ?? "");
  const [revStart, revFull] = revRangeFor(channels?.carId);
  const hasErs = channels?.hasErs ?? true;
  const lit = Math.round(((telemetry.rpm - revStart) / (revFull - revStart)) * REV_LEDS);
  const flash = atShiftPoint(telemetry.rpm, revFull);
  const gear = telemetry.gear === 0 ? "N" : telemetry.gear < 0 ? "R" : String(telemetry.gear);
  // The flaps as every panel names them (era from the car's overtaking rules, "armed" from its DRS channel)
  const aero = aeroReadout(telemetry);
  const xMode = aero.open;
  // A 2026 car opens both flaps in every zone (X-mode) and earns Overtake; an older one has the rear-flap DRS
  const straightMode = telemetry.overtakingRules === "straight-mode-2026";
  const hasAero = !channels || channels.hasDrs;
  const aids = aidsActive(telemetry);
  // The cluster re-renders every frame: its words are resolved once per language (the live ones once per value)
  const tx = useTranslations("hud.speedCluster");
  const L = useMemo(
    () => ({
      region: tx("region"),
      minimalRegion: tx("minimalRegion"),
      gear: tx("gear"),
      shift: tx("shift"),
      drsTitle: tx("drsTitle", { key: "X" }),
      straightModeTitle: tx("straightModeTitle", { key: "X" }),
      overtakeLockedTitle: tx("overtakeLockedTitle", { keys: "Space / B" }),
      overtakeTitle: tx("overtakeTitle", { keys: "Space / B" }),
      boostTitle: tx("boostTitle", { keys: "Space / B" }),
      boost2026Title: tx("boost2026Title", { keys: "Space / B" }),
      boostLowGripTitle: tx("boostLowGripTitle", { keys: "Space / B" }),
      overtake2026Title: tx("overtake2026Title", { key: "Z" }),
      overtake2026LockedTitle: tx("overtake2026LockedTitle", { key: "Z" }),
      overtake2026AutoTitle: tx("overtake2026AutoTitle", { key: "Z" }),
      overtakeLowGripTitle: tx("overtakeLowGripTitle"),
      overtakeAuto: tx("overtakeAuto"),
      lowGrip: tx("lowGrip"),
      overtake: tx("overtake"),
      boost: tx("boost"),
      harvest: tx("harvest"),
      deploy: tx("deploy"),
      ersSoc: tx("ersSoc"),
      lonG: tx("lonG"),
      inputs: tx("inputs"),
      brakeLetter: tx("brakeLetter"),
      brakeTitle: tx("brakeTitle"),
      throttleLetter: tx("throttleLetter"),
      throttleTitle: tx("throttleTitle"),
      forceLetter: tx("forceLetter"),
      clip: tx("clip"),
      forceTitle: tx("forceTitle"),
      ersBattery: tx("ersBattery"),
      rpmBand: tx("rpmBand"),
    }),
    [tx]
  );
  const aeroToggle = useMemo(() => tx("aeroToggle", { label: aero.label }), [tx, aero.label]);
  const gearLabel = useMemo(() => tx("gearLabel", { gear }), [tx, gear]);
  const litShown = Math.max(0, Math.min(REV_LEDS, lit));
  const shiftLights = useMemo(() => tx("shiftLights", { lit: litShown, total: REV_LEDS }), [tx, litShown]);

  // What the physics reports, with locked first: a latch the physics refuses never lights the button. Under the 2026
  // rules the Boost and Overtake are two controls (`ers-buttons.ts`)
  const ersCtl = ersButtons(telemetry);
  const overtakeLocked = ersCtl.boostLocked;
  const boost = ersCtl.boostOn;
  const rules2026 = telemetry.ersBoostActive !== undefined;
  const overtakeOff = ersCtl.overtake === "locked" || ersCtl.overtake === "lowGrip";
  const ers = Math.max(0, Math.min(100, telemetry.ersBatteryPercent));
  const deploying = telemetry.mgukPowerKw > 5;
  const harvesting = telemetry.mgukPowerKw < -5;
  const ffbPct = Math.min(100, Math.abs(telemetry.ffbTorqueNorm ?? 0) * 100);
  const units = useUnits();
  const speed = formatSpeed(telemetry.speedKmh, units);
  const latG = Math.abs(telemetry.lateralG).toFixed(1);
  const latGText = useMemo(() => tx("latG", { g: latG }), [tx, latG]);

  // Energy going out (deploy, boost) is information; harvesting and the plain charge are chalk
  const ersColor = boost || deploying ? HUD_INFO : HUD_WHITE;
  const ersLabel = harvesting ? L.harvest : deploying ? L.deploy : L.ersSoc;

  const leds = (cls: string) =>
    LED_INDEXES.map((i) => {
      const active = flash || i < lit;
      return (
        <span
          key={i}
          className={`flex-1 rounded-full bg-white/7 ${cls}`}
          style={active ? { backgroundColor: flash ? HUD_SHIFT : ledColor(i) } : undefined}
        />
      );
    });

  /** Aero / aids, boost and battery (or longitudinal G) controls shared by both layouts */
  const controls = (
    <>
      {channels && !hasAero ? (
        <>
          <AidLamp label="TC" active={aids.tc} />
          <AidLamp label="ABS" active={aids.abs} />
        </>
      ) : (
        <button
          type="button"
          onClick={onToggleXMode}
          className="pointer-events-auto cursor-pointer rounded-full outline-none focus-visible:shadow-lc-focus pointer-coarse:py-2.5"
          aria-label={aeroToggle}
          title={telemetry.overtakingRules === "drs-rear" ? L.drsTitle : L.straightModeTitle}
        >
          <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} size="md" />
        </button>
      )}
      {hasErs ? (
        <button
          type="button"
          onClick={onToggleBoostLatch}
          className={`pointer-events-auto cursor-pointer rounded-full outline-none focus-visible:shadow-lc-focus pointer-coarse:py-2.5 ${
            overtakeLocked ? "opacity-40" : ""
          }`}
          aria-pressed={boost}
          title={
            rules2026
              ? ersCtl.lowGrip
                ? L.boostLowGripTitle
                : L.boost2026Title
              : straightMode
                ? overtakeLocked
                  ? L.overtakeLockedTitle
                  : L.overtakeTitle
                : L.boostTitle
          }
        >
          <Badge tone={boost ? "info" : "neutral"} variant={boost ? "solid" : "soft"} size="md" icon="overtake">
            {straightMode && !rules2026 ? L.overtake : L.boost}
          </Badge>
        </button>
      ) : null}
      {hasErs && ersCtl.overtake !== null ? (
        <button
          type="button"
          onClick={onOvertake}
          disabled={overtakeOff}
          className={`pointer-events-auto cursor-pointer rounded-full outline-none focus-visible:shadow-lc-focus disabled:cursor-default pointer-coarse:py-2.5 ${
            overtakeOff ? "opacity-40" : ""
          }`}
          aria-pressed={ersCtl.overtake === "on" || ersCtl.overtake === "auto"}
          title={
            ersCtl.overtake === "lowGrip"
              ? L.overtakeLowGripTitle
              : ersCtl.overtake === "locked"
                ? L.overtake2026LockedTitle
                : ersCtl.overtake === "auto"
                  ? L.overtake2026AutoTitle
                  : L.overtake2026Title
          }
        >
          <Badge tone={overtakeOff ? "neutral" : "info"} variant={ersCtl.overtake === "on" ? "solid" : "soft"} size="md">
            {ersCtl.overtake === "lowGrip" ? L.lowGrip : ersCtl.overtake === "auto" ? L.overtakeAuto : L.overtake}
          </Badge>
        </button>
      ) : null}
    </>
  );

  const readout = hasErs ? (
    <span className="flex items-baseline gap-1.5">
      <span className={HUD_LBL}>{ersLabel}</span>
      <span className="lc-data text-[17px] leading-none" style={{ color: ersColor }}>
        {ers.toFixed(0)}%
      </span>
    </span>
  ) : (
    <span className="flex items-baseline gap-1.5">
      <span className={HUD_LBL}>{L.lonG}</span>
      <span className="lc-data text-[16px] leading-none text-lc-chalk">
        {telemetry.longitudinalG >= 0 ? "+" : "\u2212"}
        {Math.abs(telemetry.longitudinalG).toFixed(1)} g
      </span>
    </span>
  );

  const inputBars = (h: string) => (
    <div className="flex items-end gap-[5px]" aria-label={L.inputs}>
      <InputBar label={L.brakeLetter} pct={telemetry.brake * 100} color={HUD_BRAKE} title={L.brakeTitle} h={h} />
      <InputBar label={L.throttleLetter} pct={telemetry.throttle * 100} color={HUD_THROTTLE} title={L.throttleTitle} h={h} />
      <InputBar
        label={telemetry.ffbClipping ? L.clip : L.forceLetter}
        pct={ffbPct}
        color={telemetry.ffbClipping ? HUD_LOSS : HUD_INFO}
        labelColor={telemetry.ffbClipping ? HUD_LOSS : undefined}
        title={L.forceTitle}
        h={h}
      />
    </div>
  );

  const gearRing = flash ? HUD_SHIFT : xMode ? HUD_INFO : HUD_VOLT;

  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {/* Slim status strip: rev lights, rpm, aero / boost and battery */}
        <div className={`flex items-center gap-2 rounded-lc-row py-1.5 pe-3 ps-2 ${HUD_GLASS}`}>
          {controls}
          <span className="flex w-22.5 gap-0.5 rounded-lc-nub bg-lc-well p-1" aria-label={shiftLights}>
            {leds("h-1.5")}
          </span>
          {readout}
        </div>
        <section aria-label={L.minimalRegion} className={`flex items-center gap-4 rounded-lc-tile py-2 pe-2 ps-4.5 ${HUD_GLASS}`}>
          {inputBars("h-13")}
          <div className="flex flex-col items-end">
            <span className="lc-data text-[52px] leading-[0.9] tracking-[-0.02em] text-lc-chalk">{speed}</span>
            <span className={HUD_LBL}>
              {speedUnit(units)} · {Math.round(telemetry.rpm)} rpm · {latG} g
            </span>
          </div>
          <span
            className="flex size-18 items-center justify-center rounded-lc-row text-lc-void"
            style={{ backgroundColor: gearRing }}
            aria-label={gearLabel}
          >
            <span className="lc-disp text-[52px] leading-none">{gear}</span>
          </span>
        </section>
      </div>
    );
  }

  return (
    <section aria-label={L.region} className={`w-[320px] rounded-lc-card px-3.5 py-3 ${HUD_GLASS}`}>
      {/* Car badge, shift call and rpm */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <ClassTag carClass={isGt3 ? "gt3" : isRoad ? "road" : isProto ? "proto" : isClassic ? "classic" : "openWheel"} variant="solid" size="hud" />
          {flash ? (
            <Badge tone={{ color: "cyan" }} variant="solid" size="hud" icon="shiftUp">
              {L.shift}
            </Badge>
          ) : null}
        </div>
        <span className="lc-data text-[13px] text-lc-chalk">
          {Math.round(telemetry.rpm)} <span className={HUD_LBL}>rpm</span>
        </span>
      </div>

      {/* 15-LED shift lights */}
      <div
        className="my-2.5 flex gap-1 rounded-lc-nub bg-lc-well px-2 py-1.5"
        aria-label={shiftLights}
      >
        {leds("h-2")}
      </div>

      {/* Inputs | speed | gear | battery */}
      <div className="flex items-center gap-3.5">
        {inputBars("h-16")}

        <div className="flex min-w-0 flex-1 flex-col items-end">
          <span className="lc-data text-[58px] leading-[0.9] tracking-[-0.02em] text-lc-chalk">{speed}</span>
          <span className={HUD_LBL}>
            <span className="text-lc-chalk">{speedUnit(units)}</span> · {latGText}
          </span>
        </div>

        <div
          className="flex h-20 w-17.5 flex-none flex-col items-center justify-center rounded-lc-card border-2 bg-lc-well"
          style={{ borderColor: gearRing }}
        >
          <span className={HUD_LBL}>{L.gear}</span>
          <span className="lc-data text-[48px] leading-none text-lc-chalk">{gear}</span>
        </div>

        {hasErs ? (
          <span
            className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-lc-titanium"
            title={L.ersBattery}
          >
            {/* Scales from the bottom (transform only, so the bar never re-lays out) */}
            <span
              className="absolute inset-0 origin-bottom bg-lc-info transition-transform duration-100 ease-linear"
              style={{ transform: `scaleY(${ers / 100})` }}
            />
          </span>
        ) : (
          <span className="relative h-20 w-2.5 flex-none overflow-hidden rounded-full bg-lc-titanium" title={L.rpmBand}>
            <span
              className="absolute inset-0 origin-bottom"
              style={{
                transform: `scaleY(${Math.min(1, telemetry.rpm / revFull)})`,
                backgroundColor: flash ? HUD_SHIFT : HUD_INFO,
              }}
            />
          </span>
        )}
      </div>

      {/* Aero / aids, boost and battery */}
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-lc-line pt-2.5">
        <span className="flex items-center gap-1.5">{controls}</span>
        {readout}
      </div>
    </section>
  );
};
