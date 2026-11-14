"use client";

import React from "react";
import { deviceAssistTuning, selfSteerDeg, type DeviceAssistTuning, type SteeringDevice } from "@/lib/sim/steering-assist";
import { StatusDot } from "@/components/ui/Badge";

/** Setup building blocks the Settings screen and first-run setup share: status lines, hints, live meters, the assist curve */

/** The status line under a binding list ("Press a key · Esc cancels"): a status dot, live while it listens, and the words */
export const StatusPill: React.FC<{ children: React.ReactNode; tone?: "live" | "info" | "idle" }> = ({
  children,
  tone = "idle",
}) => (
  <p
    role="status"
    className={`m-0 flex items-center gap-2.5 rounded-full bg-lc-void px-3.5 py-2.5 lc-mono text-[12px] font-bold ${
      tone === "idle" ? "text-lc-slate" : "text-lc-fog"
    }`}
  >
    <StatusDot tone={tone === "live" ? "info" : "neutral"} live={tone === "live"} />
    <span className="min-w-0">{children}</span>
  </p>
);

/** Body copy under a control */
export const Hint: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <p className={`m-0 text-[12px] leading-[1.45] text-lc-slate ${className}`}>{children}</p>
);

/**
 * Live input bar on a dark 10 px track: 0..1 from the left, or −1..1 from the centre (steering).
 * `labelWidth` / `valueWidth` keep the label and readout columns aligned in a stack of meters.
 */
export const TrackMeter: React.FC<{
  label: string;
  value: number;
  color?: string;
  detail?: string;
  centered?: boolean;
  compact?: boolean;
}> = ({ label, value, color = "var(--lc-sem-throttle)", detail, centered, compact }) => {
  const v = centered ? Math.max(-1, Math.min(1, value)) : Math.max(0, Math.min(1, value));
  const idle = Math.abs(v) < 0.005;
  return (
    <div
      className={`grid items-center gap-3 ${
        compact ? "grid-cols-[64px_minmax(0,1fr)_56px]" : "grid-cols-[72px_minmax(0,1fr)_64px] sm:grid-cols-[84px_minmax(0,1fr)_74px] sm:gap-3.5"
      }`}
    >
      <span className="lc-lbl">{label}</span>
      <span className="relative h-2.5 overflow-hidden rounded-full bg-lc-void inset-ring inset-ring-lc-line">
        {centered ? (
          <>
            <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-lc-chalk/50" />
            <span
              className={`absolute inset-y-0 ${v >= 0 ? "rounded-r-full" : "rounded-l-full"}`}
              style={{
                background: color,
                ...(v >= 0 ? { left: "50%", width: `${v * 50}%` } : { right: "50%", width: `${-v * 50}%` }),
              }}
            />
          </>
        ) : (
          <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
        )}
      </span>
      <span
        className="text-right lc-mono text-[12px] font-extrabold tabular-nums"
        style={{ color: idle ? "var(--color-lc-slate)" : centered ? color : "var(--color-lc-chalk)" }}
      >
        {detail ??
          (centered ? `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v * 100))}` : `${Math.round(v * 100)}%`)}
      </span>
    </div>
  );
};

/**
 * Self-steer curve preview: the road-wheel angle the assist countersteers to (up to the car's lock, `lockDeg`) against
 * the rear's slide angle (0..45°), drawn from the curve the assist steers by (`selfSteerDeg`, before yaw damping), with
 * the countersteer cap and the grip target.
 */
export const AssistCurve: React.FC<{ tuning: DeviceAssistTuning; device: SteeringDevice; lockDeg: number }> = ({
  tuning,
  device,
  lockDeg,
}) => {
  const maxRearDeg = 45;
  const x0 = 12;
  const x1 = 148;
  const y0 = 86;
  const y1 = 14;
  const toX = (rearDeg: number) => x0 + (rearDeg / maxRearDeg) * (x1 - x0);
  const toY = (steerDeg: number) => y0 - (Math.min(lockDeg, Math.max(0, steerDeg)) / lockDeg) * (y0 - y1);

  const resolved = deviceAssistTuning(tuning, device);
  const points: string[] = [];
  for (let rearDeg = 0; rearDeg <= maxRearDeg; rearDeg++) {
    const steerDeg = selfSteerDeg(rearDeg, resolved, lockDeg);
    points.push(`${rearDeg === 0 ? "M" : "L"}${toX(rearDeg).toFixed(1)} ${toY(steerDeg).toFixed(1)}`);
  }

  const capDeg = Math.min(lockDeg, resolved.maxSelfSteerAngleDeg);
  const capY = toY(capDeg);
  const capLabel = capDeg >= lockDeg - 0.5 ? "full lock" : `${Math.round(capDeg)}° cap`;

  return (
    <div className="flex flex-col gap-2 rounded-lc-tile border border-lc-line bg-lc-void p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="lc-field-label">Self-steer curve</span>
        <span className="lc-mono text-[11px] font-bold text-lc-fog">
          {Math.round(resolved.targetSlip * 100)}% grip · {capLabel}
        </span>
      </div>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label="Self-steer response curve">
        <rect x="6" y="6" width="148" height="88" rx="10" fill="none" stroke="var(--color-lc-line)" strokeWidth="1" />
        {/* Steering that matches the rear's slide one to one, up to full lock */}
        <line
          x1={toX(0).toFixed(1)}
          y1={toY(0).toFixed(1)}
          x2={toX(Math.min(maxRearDeg, lockDeg)).toFixed(1)}
          y2={toY(lockDeg).toFixed(1)}
          stroke="var(--color-lc-dim)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <line
          x1={x0}
          y1={capY.toFixed(1)}
          x2={x1}
          y2={capY.toFixed(1)}
          stroke="var(--color-lc-info)"
          strokeOpacity="0.45"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
        <path
          d={points.join(" ")}
          fill="none"
          stroke="var(--color-lc-chalk)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text x="14" y="91" fill="var(--color-lc-slate)" fontSize="8" fontFamily="monospace">
          0° slide
        </text>
        <text x="146" y="91" fill="var(--color-lc-slate)" fontSize="8" fontFamily="monospace" textAnchor="end">
          45° slide
        </text>
      </svg>
    </div>
  );
};
