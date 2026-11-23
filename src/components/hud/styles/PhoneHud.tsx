"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { DeltaBadge } from "@/components/ui/badges/DeltaBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { atShiftPoint, deltaDigits, formatLapClock, formatLapTime, formatSpeed, HUD_BEST, HUD_GAIN, HUD_GREEN, HUD_RED, HUD_SHIFT, speedUnit } from "../hud-format";
import { aeroReadout } from "../aero-label";
import { anchor, formatOnce, gearLabel, HUD_LBL, InvalidTag, MiniMap, type HudDesignProps } from "./hud-style-parts";

/** A phone in either orientation: narrow, or a landscape screen this short */
const PHONE_QUERY = "(max-width: 639px), (max-height: 479px)";

function subscribePhone(onChange: () => void) {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** True on a phone-sized screen, where the Phone HUD replaces the chosen style */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/** The Phone HUD's words in the current language, resolved once per language */
function usePhoneWords() {
  const tx = useTranslations("hudStyles.phone");
  return useMemo(
    () => ({
      timing: tx("timing"),
      outLap: tx("outLap"),
      best: tx("best"),
      /** "Lap 3" on a circuit, "Run 3" on a hill climb */
      lapOrRun: formatOnce((kind: "lap" | "run", lap: number) => tx("lapOrRun", { kind, lap: String(lap) })),
      raceLap: formatOnce((lap: number, total: number) =>
        total ? tx("raceLapOfTotal", { lap: String(lap), total: String(total) }) : tx("raceLap", { lap: String(lap) }),
      ),
    }),
    [tx],
  );
}

/** Rev lights in the speed pod */
const LEDS = 12;
const ledColor = (i: number) => (i < 5 ? HUD_GREEN : i < 9 ? HUD_RED : HUD_SHIFT);

/**
 * The HUD glass without its backdrop blur: on a phone each blurred panel re-blurs the moving 3D view every frame,
 * and at 74 % void the blur barely shows
 */
const PHONE_GLASS = "border border-white/7 bg-lc-void/74 shadow-lc-pop";

/**
 * Phone: one HUD for small screens, after the mobile racers. Everything lives
 * along the top edge so the thumbs on the steering pad and pedals never cover it: speed and gear
 * top-centre, position, lap and delta top-right, a small map on the same glass top-left under the touch pause / camera buttons.
 * The delta and best lap wait until there is a lap to compare with.
 * In portrait the speed pod drops under the top row and the map steps aside. It sits in the HUD's
 * safe frame, so its offsets start where a notch or the Dynamic Island ends.
 */
export const PhoneHud: React.FC<HudDesignProps> = ({ t, deltaS, map, revRange, scale, touch, lapInvalid }) => {
  const race = t.race;
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = atShiftPoint(t.rpm, revFull);
  const hasErs = t.f12026?.hasErs ?? true;
  const units = useUnits();
  const aero = aeroReadout(t);
  const w = usePhoneWords();

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top-left: map, under the touch pause / camera buttons when they are up, on the same glass as the other
          panels so it never floats over the scenery */}
      <div
        className={`absolute hidden rounded-lc-tile p-1.5 landscape:block phone:rounded-lc-row phone:p-1 ${PHONE_GLASS}`}
        style={{ top: touch ? 64 : 12, left: touch ? 16 : 12, ...anchor(scale, "top left") }}
      >
        <MiniMap map={map} t={t} sectors className="block h-[92px] w-[92px] phone:h-[76px] phone:w-[76px]" stroke={34} />
      </div>

      {/* Speed pod: top-centre in landscape, under the top row in portrait */}
      <div
        className="absolute left-1/2 -translate-x-1/2 portrait:top-[124px] landscape:top-3"
        style={anchor(scale, "top center")}
      >
        <div className={`flex items-center gap-2.5 rounded-lc-card p-1.5 pr-3.5 phone:gap-2 phone:rounded-lc-tile phone:p-1 phone:pr-3 ${PHONE_GLASS}`}>
          <span
            className={`flex h-[60px] w-[56px] shrink-0 items-center justify-center rounded-lc-row transition-colors duration-75 phone:h-[46px] phone:w-[44px] phone:rounded-lc-row ${
              shift ? "bg-lc-cyan text-lc-void" : "bg-lc-volt text-lc-void"
            }`}
          >
            <span className="lc-disp text-[40px] leading-none phone:text-[30px]">{gearLabel(t.gear)}</span>
          </span>
          <div className="flex w-[112px] flex-col gap-1.5 phone:w-[96px] phone:gap-1">
            <div className="flex gap-0.75" aria-hidden>
              {Array.from({ length: LEDS }, (_, i) => (
                <span
                  key={i}
                  className="h-1 flex-1 rounded-full"
                  style={{ backgroundColor: shift ? HUD_SHIFT : i < lit ? ledColor(i) : "var(--color-lc-titanium)" }}
                />
              ))}
            </div>
            <div className="flex items-baseline justify-between">
              <span className="lc-data text-[30px] leading-none tracking-[-0.02em] text-lc-chalk phone:text-[23px]">{formatSpeed(t.speedKmh, units)}</span>
              <span className={HUD_LBL}>{speedUnit(units)}</span>
            </div>
            {hasErs ? (
              <div className="flex items-center gap-1.5">
                <Icon name="ers" size="xs" className={`size-3 ${t.mgukPowerKw > 0 ? "text-lc-info" : "text-lc-slate"}`} />
                <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-lc-info" style={{ width: `${t.ersBatteryPercent}%` }} />
                </span>
                {aero.open ? <Badge tone="info" variant="solid" size="hud" icon="drsOpen" aria-label={aero.label} /> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Top-right: position (race) or lap, the running lap and the delta */}
      <div
        className="absolute w-[176px] landscape:w-[196px] phone:w-[160px]"
        style={{ top: 12, right: 12, ...anchor(scale, "top right") }}
      >
        <section aria-label={w.timing} className={`flex flex-col gap-1.5 rounded-lc-tile px-3 pt-2 pb-2.5 phone:gap-1 phone:rounded-lc-row phone:px-2.5 phone:pt-1.5 phone:pb-2 ${PHONE_GLASS}`}>
          <div className="flex items-baseline justify-between gap-2">
            {race ? (
              <span className="lc-disp text-[26px] leading-none text-lc-chalk phone:text-[21px]">
                P{race.position}
                <span className="text-[16px] text-lc-slate phone:text-[13px]">/{race.standings.length}</span>
              </span>
            ) : (
              <span className="lc-disp text-[22px] leading-none text-lc-chalk phone:text-[18px]">
                {t.outLap ? w.outLap : w.lapOrRun(getActivePointToPoint() ? "run" : "lap", Math.max(1, t.lapCount))}
              </span>
            )}
            {race ? (
              <span className={HUD_LBL}>{w.raceLap(race.lap, race.totalLaps ?? 0)}</span>
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className={`lc-data text-[17px] leading-none phone:text-[15px] ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>
              {formatLapClock(t)}
            </span>
            {deltaS === null ? null : (
              // As wide as an ordinary delta however far off the lap is ("+41.84", "+123.4"): fewer decimals, never a held 9.999
              <DeltaBadge
                seconds={Math.max(-999.9, Math.min(999.9, deltaS))}
                digits={deltaDigits(deltaS)}
                size="sm"
                variant="solid"
                className="w-17 justify-center phone:w-15"
              />
            )}
          </div>
          {/* The best lap once there is one; an invalid lap says so either way */}
          {t.bestLapTimeMs || lapInvalid ? (
            <span className="flex items-center justify-between">
              {lapInvalid ? <InvalidTag /> : <span className={HUD_LBL}>{w.best}</span>}
              {t.bestLapTimeMs ? (
                <span className="lc-data text-[11px]" style={{ color: race ? HUD_GAIN : HUD_BEST }}>
                  {formatLapTime(t.bestLapTimeMs)}
                </span>
              ) : null}
            </span>
          ) : null}
        </section>
      </div>
    </div>
  );
};
