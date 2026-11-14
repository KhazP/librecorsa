"use client";

import React, { useEffect, useRef } from "react";
import { PAD_BRAKE_BUTTON, PAD_THROTTLE_BUTTON } from "@/lib/input/bindings";
import { shapeStick } from "@/lib/input/stick-shape";
import { connectedPads } from "@/lib/input/device-input";

// Plot geometry (viewBox 0 0 160 100): input x maps to 10..150, output y to 90..10
const toX = (x: number) => 80 + x * 70;
const toY = (y: number) => 50 - y * 40;

/** Stick curve preview with a live dot at the stick's position (read every frame, no re-render) */
export const StickCurve: React.FC<{ deadzone: number; outerDeadzone: number; linearity: number }> = ({
  deadzone,
  outerDeadzone,
  linearity,
}) => {
  const dotRef = useRef<SVGCircleElement>(null);
  const shape = useRef({ deadzone, outerDeadzone, linearity });
  shape.current = { deadzone, outerDeadzone, linearity };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const dot = dotRef.current;
      if (!dot) return;
      const pad = connectedPads().find((p) => p.mapping === "standard");
      if (!pad) {
        dot.setAttribute("opacity", "0");
        return;
      }
      const s = shape.current;
      const x = pad.axes[0] ?? 0;
      const y = shapeStick(x, s.deadzone, s.outerDeadzone, s.linearity);
      dot.setAttribute("cx", String(toX(x)));
      dot.setAttribute("cy", String(toY(y)));
      dot.setAttribute("opacity", "1");
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const points: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = -1 + i / 20;
    points.push(`${i === 0 ? "M" : "L"}${toX(x).toFixed(1)} ${toY(shapeStick(x, deadzone, outerDeadzone, linearity)).toFixed(1)}`);
  }

  return (
    <div className="flex flex-col gap-2 rounded-lc-tile border border-lc-line bg-lc-void p-3.5">
      <span className="lc-field-label">Stick response</span>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label="Stick response curve">
        <rect x="6" y="6" width="148" height="88" rx="10" fill="none" stroke="var(--color-lc-line)" strokeWidth="1" />
        <line x1="80" y1="6" x2="80" y2="94" stroke="var(--color-lc-line)" strokeWidth="1" />
        <line x1="6" y1="50" x2="154" y2="50" stroke="var(--color-lc-line)" strokeWidth="1" />
        <line x1="10" y1="90" x2="150" y2="10" stroke="var(--color-lc-dim)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={points.join(" ")} fill="none" stroke="var(--color-lc-chalk)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle ref={dotRef} r="4.5" fill="var(--color-lc-info)" opacity="0"  />
      </svg>
    </div>
  );
};

/** One trigger: raw travel bar and the shaped (raw^gamma) bar, live from the standard mapping */
const TriggerRow: React.FC<{ label: string; button: number; gamma: number; color: string }> = ({
  label,
  button,
  gamma,
  color,
}) => {
  const gammaRef = useRef(gamma);
  gammaRef.current = gamma;
  const rawBar = useRef<HTMLSpanElement>(null);
  const shapedBar = useRef<HTMLSpanElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pad = connectedPads().find((p) => p.mapping === "standard");
      const raw = Math.min(1, Math.max(0, pad?.buttons[button]?.value ?? 0));
      const shaped = raw <= 0 ? 0 : Math.pow(raw, gammaRef.current);
      if (rawBar.current) rawBar.current.style.width = `${(raw * 100).toFixed(1)}%`;
      if (shapedBar.current) shapedBar.current.style.width = `${(shaped * 100).toFixed(1)}%`;
      if (readout.current) readout.current.textContent = `${Math.round(raw * 100)}% in, ${Math.round(shaped * 100)}% out`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [button]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="lc-field-label">{label}</span>
        <span ref={readout} className="lc-mono text-[11px] font-extrabold text-lc-chalk tabular-nums">
          0% in, 0% out
        </span>
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-lc-titanium">
        <span ref={rawBar} className="block h-full rounded-full bg-lc-dim" style={{ width: "0%" }} />
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-lc-titanium">
        <span ref={shapedBar} className="block h-full rounded-full" style={{ width: "0%", background: color }} />
      </span>
    </div>
  );
};

/** Live RT / LT readout with the throttle and brake curves applied (grey = raw travel, colour = shaped) */
export const TriggerBars: React.FC<{ throttleGamma: number; brakeGamma: number }> = ({ throttleGamma, brakeGamma }) => (
  <div className="flex flex-col gap-3 rounded-lc-tile border border-lc-line bg-lc-void p-3.5">
    <TriggerRow label="Throttle trigger" button={PAD_THROTTLE_BUTTON} gamma={throttleGamma} color="var(--lc-sem-throttle)" />
    <TriggerRow label="Brake trigger" button={PAD_BRAKE_BUTTON} gamma={brakeGamma} color="var(--lc-sem-brake)" />
  </div>
);
