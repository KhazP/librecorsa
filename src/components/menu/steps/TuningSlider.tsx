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
  <label className="block rounded px-1.5 py-1.5 hover:bg-white/5">
    <span className="flex items-center justify-between gap-3">
      <span className="font-f1-italic text-[15px] text-[#F5F7FA] uppercase">{label}</span>
      <span className="font-f1-mono text-sm font-bold text-[#CCFF00] tabular-nums">{format(value)}</span>
    </span>
    {hint ? <span className="block font-f1-mono text-[11px] text-[#8E96AA]">{hint}</span> : null}
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(Number(e.target.value).toFixed(3)))}
      className="mt-1 w-full cursor-pointer accent-[#CCFF00]"
    />
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
    <div className="rounded border border-[#262B3D] bg-[#08090D] p-2">
      <div className="mb-1 font-f1-mono text-[10px] font-bold text-[#8E96AA] uppercase">Stick response</div>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label="Stick response curve">
        <rect x="10" y="10" width="140" height="80" fill="none" stroke="#262B3D" strokeWidth="1" />
        <line x1="80" y1="10" x2="80" y2="90" stroke="#262B3D" strokeWidth="1" />
        <line x1="10" y1="50" x2="150" y2="50" stroke="#262B3D" strokeWidth="1" />
        <line x1="10" y1="90" x2="150" y2="10" stroke="#8E96AA" strokeWidth="0.75" strokeDasharray="3 3" opacity="0.5" />
        <path d={points.join(" ")} fill="none" stroke="#CCFF00" strokeWidth="1.75" strokeLinejoin="round" />
        <circle ref={dotRef} r="3.5" fill="#00E5FF" opacity="0" />
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
    <div>
      <div className="mb-1 flex items-center justify-between font-f1-mono text-[10px] font-bold text-[#8E96AA] uppercase">
        <span>{label}</span>
        <span ref={readout} className="text-[#F5F7FA] tabular-nums">
          0% → 0%
        </span>
      </div>
      <span className="mb-1 block h-1.5 overflow-hidden rounded border border-[#262B3D] bg-[#08090D]">
        <span ref={rawBar} className="block h-full bg-[#8E96AA]" style={{ width: "0%" }} />
      </span>
      <span className="block h-1.5 overflow-hidden rounded border border-[#262B3D] bg-[#08090D]">
        <span ref={shapedBar} className="block h-full" style={{ width: "0%", background: color }} />
      </span>
    </div>
  );
};

/** Live RT / LT readout with the throttle and brake curves applied (grey = raw travel, colour = shaped) */
export const TriggerBars: React.FC<{ throttleGamma: number; brakeGamma: number }> = ({ throttleGamma, brakeGamma }) => (
  <div className="flex flex-col gap-2 rounded border border-[#262B3D] bg-[#08090D] p-2">
    <TriggerRow label="RT · throttle" button={PAD_THROTTLE_BUTTON} gamma={throttleGamma} color="#CCFF00" />
    <TriggerRow label="LT · brake" button={PAD_BRAKE_BUTTON} gamma={brakeGamma} color="#FF2A3C" />
  </div>
);
