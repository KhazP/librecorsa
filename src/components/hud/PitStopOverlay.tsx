"use client";

/**
 * The pit stop on the HUD, top centre under the race-control banner (after PR #183 by adamikoo): the call to box on the
 * way in, the limiter and the way to the box in the lane, the crew's countdown in the box, and the green light out. The
 * choices themselves (tyres, repairs, the box call) are on the MFD's Pit page. Outside the lane only a manual limiter
 * shows.
 */
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { HUD_GLASS } from "./hud-format";

export const PitStopOverlay: React.FC<{ telemetry: CarTelemetry; limiterKey?: string }> = ({ telemetry, limiterKey }) => {
  const tx = useTranslations("hud.pit");
  const L = useMemo(
    () => ({
      boxBox: tx("boxBox"),
      limiter: tx("limiter"),
      stop: tx("stop"),
      go: tx("go"),
      crew: tx("crew"),
    }),
    [tx]
  );
  const pit = telemetry.pit;
  if (!pit || telemetry.race?.phase === "finished") return null;
  const speedKmh = Math.round(Math.abs(telemetry.speedKmh || 0));
  const limiterBadge = (
    <Badge tone={pit.overLimit ? "bad" : "info"} variant="solid" size="sm" icon="pitLane">
      {L.limiter} {pit.limitKmh}
    </Badge>
  );
  const pill = (ring: string, children: React.ReactNode, role: "status" | "alert" = "status") => (
    <div
      role={role}
      className={`mt-1 flex min-w-60 items-center gap-3 rounded-lc-row px-2.5 py-1.5 text-lc-chalk inset-ring ${ring} ${HUD_GLASS}`}
    >
      {children}
    </div>
  );

  if (pit.phase === "servicing") {
    const done = pit.serviceTotalS > 0 ? Math.max(0, Math.min(1, 1 - pit.serviceLeftS / pit.serviceTotalS)) : 1;
    const c = pit.strategy.nextCompound;
    return (
      <div
        role="status"
        className={`mt-1 flex min-w-64 flex-col gap-1.5 rounded-lc-row px-2.5 pt-1.5 pb-2 text-lc-chalk inset-ring inset-ring-lc-loss/60 ${HUD_GLASS}`}
      >
        <div className="flex items-center gap-3">
          <Badge tone="bad" variant="solid" size="sm" icon="pitLane">
            {L.crew}
          </Badge>
          <span className="lc-disp flex flex-1 items-center gap-1.5 text-[15px] leading-none whitespace-nowrap">
            <CompoundGlyph compound={c} size={15} decorative />
            {pit.repairS > 0 && pit.strategy.repairDamage ? tx("fittingRepairing", { compound: COMPOUNDS[c].name }) : tx("fitting", { compound: COMPOUNDS[c].name })}
          </span>
          <span className="lc-data text-[12px]">{pit.serviceLeftS.toFixed(1)} s</span>
        </div>
        <span className="relative h-1 w-full overflow-hidden rounded-full bg-lc-titanium">
          <span
            className="absolute inset-0 origin-left rounded-full bg-lc-loss transition-transform duration-100 ease-linear"
            style={{ transform: `scaleX(${done})` }}
          />
        </span>
      </div>
    );
  }
  if (pit.phase === "released") {
    return pill(
      "inset-ring-lc-gain/70",
      <>
        <Badge tone="good" variant="solid" size="sm" icon="success">
          {L.go}
        </Badge>
        <span className="lc-disp text-[15px] leading-none whitespace-nowrap">{tx("stopTime", { seconds: pit.serviceTotalS.toFixed(1) })}</span>
      </>
    );
  }
  if (pit.phase === "box") {
    return pill(
      "inset-ring-lc-gain/70",
      <>
        <Badge tone="good" variant="solid" size="sm" icon="pitLane">
          {L.stop}
        </Badge>
        <span className="lc-disp text-[15px] leading-none whitespace-nowrap">{tx("inBox", { box: pit.boxIndex + 1 })}</span>
      </>
    );
  }
  if (pit.phase === "lane") {
    const to = pit.toBoxM;
    return pill(
      pit.overLimit ? "inset-ring-lc-loss/70" : "inset-ring-lc-info/60",
      <>
        {limiterBadge}
        <span className="lc-disp flex-1 text-[15px] leading-none whitespace-nowrap">
          {to === null
            ? tx("lane")
            : to > 0
              ? tx("boxIn", { box: pit.boxIndex + 1, metres: Math.round(to) })
              : tx("boxPassed", { box: pit.boxIndex + 1 })}
        </span>
        <span className={`lc-data text-[12px] ${pit.overLimit ? "text-lc-loss" : ""}`}>{speedKmh}</span>
      </>,
      pit.overLimit ? "alert" : "status"
    );
  }
  if (pit.phase === "approach") {
    return pill(
      "inset-ring-lc-caution/60",
      <>
        <Badge tone="warn" variant="solid" size="sm" icon="pitLane">
          {L.boxBox}
        </Badge>
        <span className="lc-disp flex-1 text-[15px] leading-none whitespace-nowrap">{tx("approach", { limit: pit.limitKmh })}</span>
        {limiterKey ? <span className="lc-data text-[11px] text-lc-fog">{tx("limiterKey", { key: limiterKey })}</span> : null}
      </>
    );
  }
  if (pit.limiterOn) {
    return pill("inset-ring-lc-info/60", <>{limiterBadge}</>);
  }
  if (pit.stopsRequired > pit.stopsMade) {
    const remaining = pit.stopsRequired - pit.stopsMade;
    const totalLaps = telemetry.race?.totalLaps;
    const lap = telemetry.race?.lap;
    const urgent = Boolean(totalLaps && lap && totalLaps - lap <= 1);
    if (urgent) {
      return (
        <div
          role="alert"
          className={`mt-1 inline-flex items-center gap-2 rounded-lc-row px-2.5 py-1.5 text-lc-chalk inset-ring inset-ring-lc-caution/70 ${HUD_GLASS}`}
        >
          <Badge tone="warn" variant="solid" size="sm" icon="pitLane">
            {tx("stopsPill", { made: pit.stopsMade, required: pit.stopsRequired })}
          </Badge>
          <span className="lc-disp text-[13px] leading-none whitespace-nowrap text-lc-caution">
            {tx("stopRequired", { remaining })}
          </span>
        </div>
      );
    }
    return (
      <div
        role="status"
        className={`mt-1 inline-flex items-center gap-1.5 rounded-lc-row px-2 py-1 text-lc-chalk inset-ring inset-ring-white/10 ${HUD_GLASS}`}
      >
        <Badge tone="neutral" variant="soft" size="hud" icon="pitLane">
          {tx("stopsPill", { made: pit.stopsMade, required: pit.stopsRequired })}
        </Badge>
      </div>
    );
  }
  return null;
};
