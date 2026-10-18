"use client";

import React, { useEffect, useRef } from "react";
import { HUD_CYAN, HUD_GREEN, HUD_RED } from "./hud-format";

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
}

/** Scrolling throttle / brake / steering trace (newest at the right) with current-value gauges */
export const InputTrace: React.FC<InputTraceProps> = ({ sample, seconds = 5 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef<Ring>({ buf: new Array<Point | undefined>(CAPACITY), head: 0, count: 0 });
  const { throttle, brake, steering } = sample;

  // Record a point whenever an input changes; between changes the trace holds the last value
  useEffect(() => {
    const ring = ringRef.current;
    ring.buf[ring.head] = { t: performance.now(), throttle, brake, steering };
    ring.head = (ring.head + 1) % CAPACITY;
    ring.count = Math.min(CAPACITY, ring.count + 1);
  }, [throttle, brake, steering]);

  // Redraw every frame while mounted
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const windowMs = seconds * 1000;
    const traceW = WIDTH - GAUGE_W;
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
    ) => {
      if (pts.length === 0) return;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = xOf(p.t);
        const y = yOf(p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();
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
      strokeSeries(HUD_GREEN, pts, xOf, (p) => yPedal(p.throttle));
      strokeSeries(HUD_RED, pts, xOf, (p) => yPedal(p.brake));
      strokeSeries(HUD_CYAN, pts, xOf, (p) => ySteer(p.steering));

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
      drawPedalBar(WIDTH - 18, cur.throttle, HUD_GREEN);
      drawPedalBar(WIDTH - 11, cur.brake, HUD_RED);

      // Steering: horizontal bar from centre
      const barX0 = WIDTH - 20;
      const barW = 18;
      const barCx = barX0 + barW / 2;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(barX0, steerMid - 2, barW, 4);
      const s = Math.max(-1, Math.min(1, cur.steering));
      ctx.fillStyle = HUD_CYAN;
      ctx.fillRect(Math.min(barCx, barCx + s * (barW / 2)), steerMid - 2, Math.abs(s) * (barW / 2), 4);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [seconds]);

  return (
    <div className="hud-panel inline-flex flex-col gap-1 rounded-md px-2 pb-1.5 pt-1">
      <div className="flex items-center justify-between">
        <span className="hud-label !text-[9px] !text-[#F5F7FA]">INPUTS</span>
        <span className="flex items-center gap-2 font-f1-mono text-[9px] font-bold">
          <span style={{ color: HUD_GREEN }}>THR</span>
          <span style={{ color: HUD_RED }}>BRK</span>
          <span style={{ color: HUD_CYAN }}>STR</span>
        </span>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Throttle, brake and steering trace"
        className="block"
        style={{ width: WIDTH, height: HEIGHT }}
      />
    </div>
  );
};
