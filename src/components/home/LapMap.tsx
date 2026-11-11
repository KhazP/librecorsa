"use client";

import React, { useEffect, useRef } from "react";
import { paceAt, type LapOutline } from "@/lib/home/lap-outline";

/** How much faster than real time the dot laps: a 90 s lap takes about 22 s */
export const LAP_SPEED_UP = 4;
/** The dot's trail, in thousandths of the lap */
const TAIL = 42;
const PAD = 70;
/** Below this the dot would crawl through a hairpin (and stop on a circuit whose pace has a gap) */
const MIN_KMH = 45;
/** The speed readout changes at most this often (ms), so its digits stay readable */
const READOUT_MS = 90;

/**
 * A circuit's outline with a dot lapping it at the racing line's pace: slow through the corners, flat out on the
 * straights. The dot and its trail are volt, the player's colour on every map in the game. The speed goes to
 * `speedRef` as text, so the page puts the readout where it likes; nothing here re-renders while it runs.
 */
export const LapMap: React.FC<{
  outline: LapOutline;
  label: string;
  className?: string;
  speedRef?: React.RefObject<HTMLElement | null>;
}> = ({ outline: o, label, className, speedRef }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const lineRef = useRef<SVGPathElement | null>(null);
  const tailRef = useRef<SVGPathElement | null>(null);
  const dotRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const line = lineRef.current;
    const tail = tailRef.current;
    const dot = dotRef.current;
    if (!svg || !line || !tail || !dot) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const total = line.getTotalLength();
    let frac = 0;
    let last = 0;
    let shownAt = 0;
    let raf = 0;
    let inView = true;

    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            inView = entries.some((e) => e.isIntersecting);
          });
    io?.observe(svg);

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // A tab coming back from the background must not jump the dot half a lap
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!inView) return;
      const kmh = paceAt(o, frac) || 200;
      frac = (frac + ((Math.max(kmh, MIN_KMH) / 3.6) * dt * LAP_SPEED_UP) / o.lengthM) % 1;
      const p = line.getPointAtLength(frac * total);
      dot.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      tail.style.strokeDashoffset = String(TAIL - frac * 1000);
      if (speedRef?.current && now - shownAt > READOUT_MS) {
        shownAt = now;
        speedRef.current.textContent = String(Math.round(kmh));
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [o, speedRef]);

  const [sx, sy, deg] = o.start;
  return (
    <svg
      ref={svgRef}
      viewBox={`${-PAD} ${-PAD} ${o.w + PAD * 2} ${o.h + PAD * 2}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role="img"
      aria-label={label}
    >
      <path d={o.d} fill="none" stroke="#1B1F2B" strokeWidth={36} strokeLinejoin="round" />
      <path ref={lineRef} d={o.d} fill="none" stroke="#C5CBD8" strokeWidth={6} strokeLinejoin="round" />
      <rect x={-4} y={-27} width={8} height={54} rx={3} fill="#F5F7FA" transform={`translate(${sx} ${sy}) rotate(${deg})`} />
      <path
        ref={tailRef}
        d={o.d}
        pathLength={1000}
        fill="none"
        stroke="#CCFF00"
        strokeWidth={9}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={`${TAIL} ${1000 - TAIL}`}
        strokeDashoffset={TAIL}
      />
      <g ref={dotRef} transform={`translate(${sx} ${sy})`}>
        <circle r={34} fill="#CCFF00" opacity={0.16} />
        <circle r={15} fill="#CCFF00" />
      </g>
    </svg>
  );
};
