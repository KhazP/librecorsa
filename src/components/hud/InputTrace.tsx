"use client";

import React, { useEffect, useRef } from "react";
import { HUD_CYAN, HUD_GLASS, HUD_GREEN, HUD_RED } from "./hud-format";

/** Canvas size in CSS pixels */
const WIDTH = 260;
const HEIGHT = 64;
/** Right-hand strip holding the current-value gauges */
const GAUGE_W = 22;
/** Top band (throttle / brake); the rest is the steering band with its centre line */
const PEDAL_H = 40;
/** Ring buffer capacity: 30 changes/s over the window with headroom */
const CAPACITY = 512;

interface InputSample {
  throttle: number;
  brake: number;
  steering: number;
  throttleOut?: number;
  brakeOut?: number;
  ffbClip?: boolean;
}

interface Point extends InputSample {
  t: number;
}

interface Ring {
  buf: (Point | undefined)[];
  head: number;
  count: number;
}

interface InputTraceProps {
  sample: InputSample;
  /** Trace window in seconds */
  seconds?: number;
  /** Canvas width in CSS pixels */
  width?: number;
  /** Live gauges beside the trace (the dual-layer pedal bars); replaces the built-in current-value strip */
  aside?: React.ReactNode;
}

/** Scrolling throttle / brake / steering trace (newest at the right) with current-value gauges */
export const InputTrace: React.FC<InputTraceProps> = ({ sample, seconds = 5, width = WIDTH, aside }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef<Ring>({ buf: new Array<Point | undefined>(CAPACITY), head: 0, count: 0 });
  const { throttle, brake, steering, throttleOut, brakeOut, ffbClip } = sample;
  const hasAside = aside !== undefined && aside !== null;

  // Record a point whenever an input changes; between changes the trace holds the last value
  useEffect(() => {
    const ring = ringRef.current;
    ring.buf[ring.head] = { t: performance.now(), throttle, brake, steering, throttleOut, brakeOut, ffbClip };
    ring.head = (ring.head + 1) % CAPACITY;
    ring.count = Math.min(CAPACITY, ring.count + 1);
  }, [throttle, brake, steering, throttleOut, brakeOut, ffbClip]);

  // Redraw every frame while mounted
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const windowMs = seconds * 1000;
    const WIDTH = width;
    const gauges = !hasAside;
    const traceW = gauges ? WIDTH - GAUGE_W : WIDTH;
    const steerTop = PEDAL_H + 2;
    const steerBottom = HEIGHT - 2;
    const steerMid = (steerTop + steerBottom) / 2;
    const steerHalf = (steerBottom - steerTop) / 2 - 1;

    const yPedal = (v: number) => PEDAL_H - 2 - Math.max(0, Math.min(1, v)) * (PEDAL_H - 4);
    const ySteer = (v: number) => steerMid - Math.max(-1, Math.min(1, v)) * steerHalf;

    /** Strokes one channel: x from the time axis, y from the channel's own mapping */
    const strokeSeries = (
      color: string,
      pts: Point[],
      xOf: (t: number) => number,
      yOf: (p: Point) => number,
      dashed = false,
    ) => {
      if (pts.length === 0) return;
      ctx.save();
      if (dashed) ctx.setLineDash([3, 2]);
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = dashed ? 1.1 : 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    };

    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.round(WIDTH * dpr);
      const pxH = Math.round(HEIGHT * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      // Background guides: pedal band divider and steering centre line
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, traceW, HEIGHT);
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, PEDAL_H + 0.5);
      ctx.lineTo(traceW, PEDAL_H + 0.5);
      ctx.moveTo(0, steerMid + 0.5);
      ctx.lineTo(traceW, steerMid + 0.5);
      ctx.stroke();

      const now = performance.now();
      const cutoff = now - windowMs;
      const ring = ringRef.current;

      // Oldest-to-newest points inside the window, plus the last value carried in from before it
      let carry: Point | undefined;
      const inWindow: Point[] = [];
      for (let i = 0; i < ring.count; i++) {
        const p = ring.buf[(ring.head - ring.count + i + CAPACITY) % CAPACITY];
        if (!p) continue;
        if (p.t < cutoff) carry = p;
        else inWindow.push(p);
      }
      const pts: Point[] = carry ? [carry, ...inWindow] : inWindow;
      const latest = ring.count > 0 ? ring.buf[(ring.head - 1 + CAPACITY) % CAPACITY] : undefined;
      // Extend the current value up to now
      if (latest) pts.push({ ...latest, t: now });

      // Time axis: window start at x = 0, now at the trace's right edge
      const xOf = (t: number) => Math.max(0, ((t - cutoff) / windowMs) * traceW);
      const anyTcCut = pts.some((p) => p.throttleOut !== undefined && p.throttle - p.throttleOut > 0.01);
      const anyAbsCut = pts.some((p) => p.brakeOut !== undefined && p.brake - p.brakeOut > 0.01);
      if (anyTcCut) {
        strokeSeries("rgba(255, 179, 0, 0.55)", pts, xOf, (p) => yPedal(p.throttle), true);
      }
      if (anyAbsCut) {
        strokeSeries("rgba(255, 61, 203, 0.55)", pts, xOf, (p) => yPedal(p.brake), true);
      }
      strokeSeries(HUD_GREEN, pts, xOf, (p) => yPedal(p.throttleOut ?? p.throttle));
      strokeSeries(HUD_RED, pts, xOf, (p) => yPedal(p.brakeOut ?? p.brake));
      strokeSeries(HUD_CYAN, pts, xOf, (p) => ySteer(p.steering));

      // FFB clipping top-edge indicator ticks
      ctx.fillStyle = HUD_RED;
      for (let i = 0; i < pts.length; i++) {
        if (!pts[i].ffbClip) continue;
        const x0 = xOf(pts[i].t);
        const x1 = i + 1 < pts.length ? xOf(pts[i + 1].t) : traceW;
        ctx.fillRect(x0, 0, Math.max(1.5, x1 - x0), 2);
      }

      raf = requestAnimationFrame(draw);
      if (!gauges) return;

      // Current-value gauges
      const cur = latest ?? { t: now, throttle: 0, brake: 0, steering: 0 };
      const pedalTrackTop = 2;
      const pedalTrackH = PEDAL_H - 4;
      const drawPedalBar = (x: number, value: number, color: string) => {
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fillRect(x, pedalTrackTop, 4, pedalTrackH);
        const h = Math.max(0, Math.min(1, value)) * pedalTrackH;
        ctx.fillStyle = color;
        ctx.fillRect(x, pedalTrackTop + pedalTrackH - h, 4, h);
      };
      drawPedalBar(WIDTH - 18, cur.throttleOut ?? cur.throttle, HUD_GREEN);
      drawPedalBar(WIDTH - 11, cur.brakeOut ?? cur.brake, HUD_RED);

      // Steering: horizontal bar from centre
      const barX0 = WIDTH - 20;
      const barW = 18;
      const barCx = barX0 + barW / 2;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(barX0, steerMid - 2, barW, 4);
      const s = Math.max(-1, Math.min(1, cur.steering));
      ctx.fillStyle = HUD_CYAN;
      ctx.fillRect(Math.min(barCx, barCx + s * (barW / 2)), steerMid - 2, Math.abs(s) * (barW / 2), 4);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [seconds, width, hasAside]);

  return (
    <section aria-label="Inputs" className={`inline-flex flex-col gap-1.5 rounded-[18px] px-3 pt-2 pb-2.5 ${HUD_GLASS}`}>
      <div className="flex items-center justify-between">
        <span className="lc-data inline-flex items-center gap-2 text-[10px] tracking-[0.12em] text-[#F5F7FA]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#CCFF00]" />
          INPUTS
        </span>
        <span className="flex items-center gap-2 font-f1-mono text-[9px] font-extrabold tracking-[0.12em]">
          <span style={{ color: HUD_GREEN }}>THR</span>
          <span style={{ color: HUD_RED }}>BRK</span>
          <span style={{ color: HUD_CYAN }}>STR</span>
        </span>
      </div>
      <div className="flex items-end gap-2.5">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Throttle, brake and steering trace"
          className="block rounded-[8px]"
          style={{ width, height: HEIGHT }}
        />
        {aside}
      </div>
    </section>
  );
};
