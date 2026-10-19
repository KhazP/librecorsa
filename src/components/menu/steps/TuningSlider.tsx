"use client";

import React, { useEffect, useRef } from "react";
import { PAD_BRAKE_BUTTON, PAD_THROTTLE_BUTTON } from "@/lib/input/bindings";
import { connectedPads } from "@/lib/input/device-input";

/** Labelled slider in the setup screens' look: volt thumb, mono readout, optional one-line hint */
export const TuningSlider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  hint?: string;
}> = ({ label, value, min, max, step, format, onChange, hint }) => (
  <label className="flex flex-col gap-2 rounded-[14px] p-1.5 transition-colors duration-200 hover:bg-white/[0.03]">
    <span className="flex items-center justify-between gap-2">
      <span className="text-[15px] leading-tight font-bold text-[#F5F7FA]">{label}</span>
      <span className="shrink-0 font-f1-mono text-[13px] font-extrabold text-[#CCFF00] tabular-nums">{format(value)}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(Number(e.target.value).toFixed(3)))}
      className="lc-range"
      style={{ "--lc-fill": `${((value - min) / (max - min || 1)) * 100}%` } as React.CSSProperties}
    />
    {hint ? <span className="text-[12px] leading-[1.4] text-[#8E96AA]">{hint}</span> : null}
  </label>
);

/**
 * Controller stick response: input −1..1 (+ = right) to output −1..1.
 * Inside the inner dead zone the output is 0; the outer dead zone reads full deflection a little before the stop;
 * linearity 1 is linear, above 1 finer near centre.
 */
export function shapeStick(x: number, deadzone: number, outer: number, linearity: number): number {
  const a = Math.abs(x);
  if (a <= deadzone) return 0;
  const u = Math.min(1, (a - deadzone) / Math.max(0.01, 1 - deadzone - outer));
  return Math.sign(x) * Math.pow(u, linearity);
}

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
    <div className="flex flex-col gap-2 rounded-[18px] border border-[#262B3D] bg-[#08090D] p-3.5">
      <span className="lc-lbl text-[10px]!">Stick response</span>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label="Stick response curve">
        <rect x="6" y="6" width="148" height="88" rx="10" fill="none" stroke="#262B3D" strokeWidth="1" />
        <line x1="80" y1="6" x2="80" y2="94" stroke="#262B3D" strokeWidth="1" />
        <line x1="6" y1="50" x2="154" y2="50" stroke="#262B3D" strokeWidth="1" />
        <line x1="10" y1="90" x2="150" y2="10" stroke="#5B6275" strokeWidth="1" strokeDasharray="3 3" />
        <path d={points.join(" ")} fill="none" stroke="#CCFF00" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle ref={dotRef} r="4.5" fill="#00E5FF" opacity="0" style={{ filter: "drop-shadow(0 0 4px #00E5FF)" }} />
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
      if (readout.current) readout.current.textContent = `${Math.round(raw * 100)}% → ${Math.round(shaped * 100)}%`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [button]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="lc-lbl text-[10px]!">{label}</span>
        <span ref={readout} className="font-f1-mono text-[11px] font-extrabold text-[#F5F7FA] tabular-nums">
          0% → 0%
        </span>
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-[#1B1F2B]">
        <span ref={rawBar} className="block h-full rounded-full bg-[#5B6275]" style={{ width: "0%" }} />
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-[#1B1F2B]">
        <span ref={shapedBar} className="block h-full rounded-full" style={{ width: "0%", background: color }} />
      </span>
    </div>
  );
};

/** Live RT / LT readout with the throttle and brake curves applied (grey = raw travel, colour = shaped) */
export const TriggerBars: React.FC<{ throttleGamma: number; brakeGamma: number }> = ({ throttleGamma, brakeGamma }) => (
  <div className="flex flex-col gap-3 rounded-[18px] border border-[#262B3D] bg-[#08090D] p-3.5">
    <TriggerRow label="RT · throttle" button={PAD_THROTTLE_BUTTON} gamma={throttleGamma} color="#00E676" />
    <TriggerRow label="LT · brake" button={PAD_BRAKE_BUTTON} gamma={brakeGamma} color="#FF2A3C" />
  </div>
);
