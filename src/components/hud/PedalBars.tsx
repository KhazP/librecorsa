"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import { HUD_BRAKE, HUD_CAUTION, HUD_INFO, HUD_LBL, HUD_LOSS, HUD_THROTTLE, aidsActive } from "./hud-format";

/** What an aid cuts is a caution on its own bar (ABS on the brake, TC on the throttle); the label under it lights too */
const ABS_COLOR = HUD_CAUTION;
const TC_COLOR = HUD_CAUTION;
/** The clutch is identity, not state */
const CLUTCH_COLOR = "var(--color-lc-azure)";

/** What the pedals asked for and what the electronics let through (0..1 each) */
export function pedalLayers(t: CarTelemetry) {
  const tuner = t.liveTuner;
  const tcCut = Math.max(0, Math.min(1, tuner?.tcCutFraction ?? 0));
  const absPerWheel: [number, number, number, number] = tuner?.absCutPerWheel ?? [0, 0, 0, 0];
  const absCut = Math.max(0, Math.min(1, Math.max(...absPerWheel)));
  const throttle = Math.max(0, Math.min(1, t.throttle));
  const brake = Math.max(0, Math.min(1, t.brake));
  const aids = aidsActive(t);
  return {
    throttle,
    throttleOut: throttle * (1 - tcCut),
    tcActive: aids.tc,
    brake,
    brakeOut: brake * (1 - absCut),
    absActive: aids.abs,
    absPerWheel,
    clutch: Math.max(0, Math.min(1, 1 - t.clutch)),
    ffb: Math.min(1, Math.abs(t.ffbTorqueNorm ?? 0)),
    ffbClip: Boolean(t.ffbClipping),
    steer: Math.max(-1, Math.min(1, t.steering)),
  };
}

/**
 * One vertical bar: the electronics' output filled solid from the bottom, the part the driver asked for but the
 * electronics cut drawn on top in the intervention colour (striped and pulsing while it acts).
 */
const Bar: React.FC<{
  label: string;
  demand: number;
  output?: number;
  color: string;
  cutColor?: string;
  active?: boolean;
  clip?: boolean;
  h: number;
  w: number;
  showLabel: boolean;
}> = ({ label, demand, output = demand, color, cutColor, active = false, clip = false, h, w, showLabel }) => {
  const cut = Math.max(0, demand - output);
  return (
    <span className="flex flex-col items-center gap-1">
      <span
        className="relative overflow-hidden rounded-sm bg-white/7 inset-ring inset-ring-white/5"
        style={{ height: h, width: w }}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(output * 100)}
      >
        <span className="absolute inset-x-0 bottom-0" style={{ height: `${output * 100}%`, backgroundColor: color }} />
        {cut > 0.005 && cutColor ? (
          <span
            className={`absolute inset-x-0 ${active ? "lc-cut" : ""}`}
            style={{
              bottom: `${output * 100}%`,
              height: `${cut * 100}%`,
              background: `repeating-linear-gradient(135deg, ${cutColor} 0 3px, color-mix(in srgb, ${cutColor} 60%, transparent) 3px 6px)`,
            }}
          />
        ) : null}
        {clip ? <span className="absolute inset-x-0 top-0 h-1 bg-lc-loss" /> : null}
      </span>
      {showLabel ? (
        <span className={`${HUD_LBL} tracking-[0.06em]`} style={active ? { color: cutColor } : clip ? { color: HUD_LOSS } : undefined}>
          {clip ? "Clip" : label}
        </span>
      ) : null}
    </span>
  );
};

/**
 * Dual-layer vertical pedal gauges: Clutch | Brake | Throttle | FFB. The throttle shows the torque TC cuts
 * in amber at the top of the bar, the brake shows the pressure ABS releases in magenta, FFB shows clipping in red,
 * and a bidirectional steering bar runs underneath.
 */
export const PedalBars: React.FC<{
  t: CarTelemetry;
  size?: "compact" | "full";
  showFfb?: boolean;
  showClutch?: boolean;
  className?: string;
}> = ({ t, size = "full", showFfb = true, showClutch = true, className = "" }) => {
  const p = pedalLayers(t);
  const full = size === "full";
  const h = full ? 64 : 34;
  const w = full ? 12 : 7;
  const hasFfb = showFfb && t.ffbTorqueNorm !== undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`} aria-label="Pedals and electronics">
      <div className={`flex items-end ${full ? "gap-2" : "gap-1.25"}`}>
        {showClutch ? <Bar label="CLU" demand={p.clutch} color={CLUTCH_COLOR} h={h} w={w} showLabel={full} /> : null}
        <Bar label="ABS" demand={p.brake} output={p.brakeOut} color={HUD_BRAKE} cutColor={ABS_COLOR} active={p.absActive} h={h} w={w} showLabel={full} />
        <Bar label="TC" demand={p.throttle} output={p.throttleOut} color={HUD_THROTTLE} cutColor={TC_COLOR} active={p.tcActive} h={h} w={w} showLabel={full} />
        {hasFfb ? (
          <Bar label="FFB" demand={p.ffb} color={p.ffbClip ? HUD_LOSS : "var(--color-lc-fog)"} clip={p.ffbClip} h={h} w={w} showLabel={full} />
        ) : null}
      </div>
      {full ? (
        <span className="relative h-1.25 w-full overflow-hidden rounded-full bg-white/7" aria-label="Steering">
          <span className="absolute inset-y-0 left-1/2 w-px bg-lc-chalk/40" />
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${50 + Math.min(0, p.steer) * 50}%`,
              width: `${Math.abs(p.steer) * 50}%`,
              backgroundColor: HUD_INFO,
            }}
          />
        </span>
      ) : null}
    </div>
  );
};

