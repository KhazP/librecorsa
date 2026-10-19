"use client";

import React from "react";
import type { CarTelemetry } from "@/types/f1";
import { HUD_CYAN, HUD_GREEN, HUD_LBL, HUD_RED, HUD_YELLOW } from "./hud-format";

/** ABS release shows in magenta so it never reads as the throttle's amber TC cut */
const ABS_COLOR = "#FF3DCB";
const TC_COLOR = HUD_YELLOW;
const CLUTCH_COLOR = "#5AA9FF";

/** What the pedals asked for and what the electronics let through (0..1 each) */
export function pedalLayers(t: CarTelemetry) {
  const tuner = t.liveTuner;
  const tcCut = Math.max(0, Math.min(1, tuner?.tcCutFraction ?? 0));
  const absPerWheel: [number, number, number, number] = tuner?.absCutPerWheel ?? [0, 0, 0, 0];
  const absCut = Math.max(0, Math.min(1, Math.max(...absPerWheel)));
  const throttle = Math.max(0, Math.min(1, t.throttle));
  const brake = Math.max(0, Math.min(1, t.brake));
  return {
    throttle,
    throttleOut: throttle * (1 - tcCut),
    tcActive: tcCut > 0.02 || Boolean(t.f12026?.tcActive),
    brake,
    brakeOut: brake * (1 - absCut),
    absActive: absCut > 0.02 || Boolean(t.f12026?.absActive),
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
        className="relative overflow-hidden rounded-[5px] bg-white/[0.07] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
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
              background: `repeating-linear-gradient(135deg, ${cutColor} 0 3px, ${cutColor}99 3px 6px)`,
              boxShadow: `0 0 8px ${cutColor}`,
            }}
          />
        ) : null}
        {clip ? <span className="absolute inset-x-0 top-0 h-[4px] bg-[#FF2A3C] shadow-[0_0_6px_#FF2A3C]" /> : null}
      </span>
      {showLabel ? (
        <span className={`${HUD_LBL} !text-[8px] !tracking-[0.1em]`} style={active ? { color: cutColor } : undefined}>
          {label}
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
      <div className={`flex items-end ${full ? "gap-2" : "gap-[5px]"}`}>
        {showClutch ? <Bar label="CLU" demand={p.clutch} color={CLUTCH_COLOR} h={h} w={w} showLabel={full} /> : null}
        <Bar label="ABS" demand={p.brake} output={p.brakeOut} color={HUD_RED} cutColor={ABS_COLOR} active={p.absActive} h={h} w={w} showLabel={full} />
        <Bar label="TC" demand={p.throttle} output={p.throttleOut} color={HUD_GREEN} cutColor={TC_COLOR} active={p.tcActive} h={h} w={w} showLabel={full} />
        {hasFfb ? <Bar label="FFB" demand={p.ffb} color={p.ffbClip ? HUD_RED : "#C5CBD8"} clip={p.ffbClip} h={h} w={w} showLabel={full} /> : null}
      </div>
      {full ? (
        <span className="relative h-[5px] w-full overflow-hidden rounded-full bg-white/[0.07]" aria-label="Steering">
          <span className="absolute inset-y-0 left-1/2 w-px bg-[#F5F7FA]/40" />
          <span
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${50 + Math.min(0, p.steer) * 50}%`,
              width: `${Math.abs(p.steer) * 50}%`,
              backgroundColor: HUD_CYAN,
            }}
          />
        </span>
      ) : null}
    </div>
  );
};

/** Card around the full pedal bars with live TC / 4-channel ABS / FFB clipping readouts */
export const PedalCard: React.FC<{ t: CarTelemetry; className?: string }> = ({ t, className = "" }) => {
  const p = pedalLayers(t);
  const tcPct = Math.round((p.throttle - p.throttleOut) * 100);
  const absPct = Math.round((p.brake - p.brakeOut) * 100);
  const [fl, fr, rl, rr] = p.absPerWheel;
  return (
    <section aria-label="Pedals" className={`flex items-center gap-3 ${className}`}>
      <PedalBars t={t} size="full" />
      <div className="flex min-w-[68px] flex-col gap-1 font-f1-mono text-[10px] font-extrabold tabular-nums">
        <span className="flex justify-between gap-2" style={{ color: p.tcActive ? TC_COLOR : "#5B6275" }}>
          <span>TC</span>
          <span>−{tcPct}%</span>
        </span>
        <span className="flex items-center justify-between gap-1.5" style={{ color: p.absActive ? ABS_COLOR : "#5B6275" }}>
          <span className="inline-flex items-center gap-1">
            <span>ABS</span>
            <span className="grid grid-cols-2 gap-[2px]" aria-label="4-channel ABS wheel activity">
              {[fl, fr, rl, rr].map((cut, idx) => (
                <span
                  key={idx}
                  className="h-[4px] w-[4px] rounded-[1px]"
                  style={{
                    backgroundColor: cut > 0.02 ? ABS_COLOR : "rgba(255,255,255,0.14)",
                    boxShadow: cut > 0.15 ? `0 0 4px ${ABS_COLOR}` : undefined,
                  }}
                />
              ))}
            </span>
          </span>
          <span>−{absPct}%</span>
        </span>
        <span className="flex justify-between gap-2" style={{ color: p.ffbClip ? HUD_RED : "#5B6275" }}>
          <span>CLIP</span>
          <span>{p.ffbClip ? "ON" : "—"}</span>
        </span>
      </div>
    </section>
  );
};

