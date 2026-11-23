"use client";

import React, { useEffect, useRef } from "react";
import { useTranslations } from "use-intl/react";
import { shapeStick } from "@/lib/input/stick-shape";
import { connectedPads, padPedals, type PadPedalTuning } from "@/lib/input/device-input";
import { PAD_BRAKE_BUTTON, PAD_PEDAL_LABELS, PAD_THROTTLE_BUTTON, pedalSourceText, type PadPedal } from "@/lib/input/bindings";

// Plot geometry (viewBox 0 0 160 100): input x maps to 10..150, output y to 90..10
const toX = (x: number) => 80 + x * 70;
const toY = (y: number) => 50 - y * 40;

/** Stick curve preview with a live dot at the stick's position (read every frame, no re-render) */
export const StickCurve: React.FC<{ deadzone: number; outerDeadzone: number; linearity: number }> = ({
  deadzone,
  outerDeadzone,
  linearity,
}) => {
  const tx = useTranslations("setup.tuning");
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
      <span className="lc-field-label">{tx("stickResponse")}</span>
      <svg viewBox="0 0 160 100" className="block h-auto w-full" role="img" aria-label={tx("stickResponseCurve")}>
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

/**
 * One pedal: raw travel bar and the shaped (raw^gamma) bar, live from the standard mapping as the game reads it, named
 * with where it is read ("Throttle trigger", "Brake, right stick down")
 */
export const PedalRow: React.FC<{ pedal: PadPedal; tuning: PadPedalTuning; gamma: number; color: string }> = ({
  pedal,
  tuning,
  gamma,
  color,
}) => {
  const tx = useTranslations("setup.tuning");
  const source = tuning.pedalSources[pedal];
  const onTrigger = source?.kind === "button" && (source.button === PAD_THROTTLE_BUTTON || source.button === PAD_BRAKE_BUTTON);
  const label = onTrigger
    ? tx("pedalTrigger", { pedal: PAD_PEDAL_LABELS[pedal] })
    : tx("pedalSource", { pedal: PAD_PEDAL_LABELS[pedal], source: pedalSourceText(source) });
  const gammaRef = useRef(gamma);
  gammaRef.current = gamma;
  const tuningRef = useRef(tuning);
  tuningRef.current = tuning;
  const rawBar = useRef<HTMLSpanElement>(null);
  const shapedBar = useRef<HTMLSpanElement>(null);
  const readout = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    // The readout's words are formatted only when the rounded numbers change, not every frame
    let shown = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pad = connectedPads().find((p) => p.mapping === "standard");
      const raw = Math.min(1, Math.max(0, pad ? padPedals(pad, tuningRef.current)[pedal] : 0));
      const shaped = raw <= 0 ? 0 : Math.pow(raw, gammaRef.current);
      if (rawBar.current) rawBar.current.style.transform = `translateX(${((raw - 1) * 100).toFixed(1)}%)`;
      if (shapedBar.current) shapedBar.current.style.transform = `translateX(${((shaped - 1) * 100).toFixed(1)}%)`;
      const rawPct = Math.round(raw * 100);
      const shapedPct = Math.round(shaped * 100);
      if (readout.current && `${rawPct} ${shapedPct}` !== shown) {
        shown = `${rawPct} ${shapedPct}`;
        readout.current.textContent = tx("pedalReadout", { raw: rawPct, shaped: shapedPct });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pedal, tx]);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between gap-2">
        <span className="lc-field-label">{label}</span>
        <span ref={readout} className="lc-mono text-[11px] font-extrabold text-lc-chalk tabular-nums">
          {tx("pedalReadout", { raw: 0, shaped: 0 })}
        </span>
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-lc-titanium">
        <span ref={rawBar} className="block h-full w-full rounded-full bg-lc-dim" style={{ transform: "translateX(-100%)" }} />
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-lc-titanium">
        <span ref={shapedBar} className="block h-full w-full rounded-full" style={{ transform: "translateX(-100%)", background: color }} />
      </span>
    </div>
  );
};

/**
 * Live throttle / brake readout with their curves applied (grey = raw travel, colour = shaped), from wherever each
 * pedal is read
 */
export const PedalCurveBars: React.FC<{ tuning: PadPedalTuning; throttleGamma: number; brakeGamma: number }> = ({
  tuning,
  throttleGamma,
  brakeGamma,
}) => (
  <div className="flex flex-col gap-3 rounded-lc-tile border border-lc-line bg-lc-void p-3.5">
    <PedalRow pedal="throttle" tuning={tuning} gamma={throttleGamma} color="var(--lc-sem-throttle)" />
    <PedalRow pedal="brake" tuning={tuning} gamma={brakeGamma} color="var(--lc-sem-brake)" />
  </div>
);
