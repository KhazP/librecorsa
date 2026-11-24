"use client";

import React, { useEffect, useRef } from "react";
import {
  circuitStageModel,
  easeInOut,
  easeOut,
  projectStage,
  STAGE_ROAD_HALF_RATIO,
  STAGE_WALL_RATIO,
  stageSectors,
  stageYaw,
  wallShade,
  type CircuitStageModel,
  type Projected,
  type StageSector,
  type StageView,
} from "@/lib/show/circuit-stage";

/**
 * The F1-style 3D holographic circuit stage (circuit-stage.ts), in LibreCorsa's colours: a projected 3D telemetry
 * grid floor, a real-width elevated 3D track ribbon with tall facing-shaded translucent holographic walls, glowing
 * sector rails (cyan S1 / volt S2 / pink S3), a chequered start/finish gantry strip, S1/S2/S3 callouts, clean
 * anti-overlap turn badges, and a high-speed comet streaking along the deck.
 */
export const CircuitStage: React.FC<{
  samples: Parameters<typeof circuitStageModel>[0];
  totalLengthM: number;
  turns: readonly { number: number; sApprox: number }[];
  closed: boolean;
  /** Localized S1 / S2 / S3 labels */
  sectorLabels: readonly [string, string, string];
  /** Seconds into the show */
  timeS: () => number;
  /** Hold the finished drawing, still (reduced motion) */
  still: boolean;
}> = ({ samples, totalLengthM, turns, closed, sectorLabels, timeS, still }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const model = circuitStageModel(samples, totalLengthM, turns, closed);
    if (!canvas || !model) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const colours: Colours = {
      sectors: [v("--color-lc-cyan", "cyan"), v("--color-lc-volt", "yellow"), v("--color-lc-pink", "pink")],
      chalk: v("--color-lc-chalk", "white"),
      fog: v("--color-lc-fog", "silver"),
      slate: v("--color-lc-slate", "gray"),
      line: v("--color-lc-line", "gray"),
      carbon: v("--color-lc-carbon", "black"),
      void: v("--color-lc-void", "black"),
      volt: v("--color-lc-volt", "yellow"),
    };
    const displayFont = v("--font-lc-display", "system-ui");
    const monoFont = v("--font-lc-mono", "monospace");
    const sectors = stageSectors(model);
    let minY = Infinity;
    for (const p of model.points) if (p.y < minY) minY = p.y;
    const floorY = Number.isFinite(minY) ? minY - model.radius * 0.02 : 0;

    // Precompute smoothed horizontal unit normals along the centreline for the 3D track ribbon edges
    const n = model.points.length;
    const normX = new Float32Array(n);
    const normZ = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const prev = model.points[(i - 1 + n) % n];
      const next = model.points[(i + 1) % n];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      normX[i] = -dz / len;
      normZ[i] = dx / len;
    }

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w < 2 || h < 2) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      paint(ctx, model, normX, normZ, sectors, sectorLabels, floorY, still ? 24 : timeS(), w, h, colours, displayFont, monoFont);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [samples, totalLengthM, turns, closed, sectorLabels, timeS, still]);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 size-full" />;
};

interface Colours {
  sectors: string[];
  chalk: string;
  fog: string;
  slate: string;
  line: string;
  carbon: string;
  void: string;
  volt: string;
}

const gCenter: Projected[] = [];
const tCenter: Projected[] = [];
const gLeft: Projected[] = [];
const gRight: Projected[] = [];
const tLeft: Projected[] = [];
const tRight: Projected[] = [];
const tmpA: Projected = { x: 0, y: 0, depth: 0 };
const tmpB: Projected = { x: 0, y: 0, depth: 0 };

function ensurePool(pool: Projected[], n: number): void {
  while (pool.length < n) pool.push({ x: 0, y: 0, depth: 0 });
}

function paint(
  ctx: CanvasRenderingContext2D,
  model: CircuitStageModel,
  normX: Float32Array,
  normZ: Float32Array,
  sectors: readonly StageSector[],
  sectorLabels: readonly [string, string, string],
  floorY: number,
  t: number,
  w: number,
  h: number,
  c: Colours,
  displayFont: string,
  monoFont: string
): void {
  const portrait = h > w;
  const short = h < 512;
  const view: StageView = {
    yaw: stageYaw(model, t),
    pitch: (portrait ? 54 : 46) * (Math.PI / 180),
    width: w,
    height: h,
    // A short landscape screen (a phone on its side): further right, clear of the facts in the corner
    centreX: w * (portrait ? 0.5 : h < 500 ? 0.62 : 0.55),
    centreY: h * (portrait ? 0.39 : short ? 0.42 : 0.44),
    fill: portrait ? 0.9 : short ? 0.78 : 0.84,
  };
  const pts = model.points;
  const n = pts.length;

  // F1-paced holographic build: laser trace (0.15–3.5s), sector ignition (4.1–6.2s), tall 3D wall extrusion (5.4–8.2s)
  const drawn = easeOut((t - 0.15) / 3.35);
  const coloured = easeOut((t - 4.1) / 2.1);
  const wallT = easeInOut((t - 5.4) / 2.8);
  const wallH = wallT * model.radius * STAGE_WALL_RATIO;
  const halfW = model.radius * STAGE_ROAD_HALF_RATIO;
  const lineW = Math.max(2, Math.min(w, h) / 260);

  ensurePool(gCenter, n);
  ensurePool(tCenter, n);
  ensurePool(gLeft, n);
  ensurePool(gRight, n);
  ensurePool(tLeft, n);
  ensurePool(tRight, n);

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const ox = normX[i] * halfW;
    const oz = normZ[i] * halfW;
    projectStage(model, view, p.x, p.y, p.z, gCenter[i]);
    projectStage(model, view, p.x, p.y + wallH, p.z, tCenter[i]);
    projectStage(model, view, p.x + ox, p.y, p.z + oz, gLeft[i]);
    projectStage(model, view, p.x - ox, p.y, p.z - oz, gRight[i]);
    projectStage(model, view, p.x + ox, p.y + wallH, p.z + oz, tLeft[i]);
    projectStage(model, view, p.x - ox, p.y + wallH, p.z - oz, tRight[i]);
    cx += tCenter[i].x;
    cy += tCenter[i].y;
  }
  cx /= n;
  cy /= n;

  // 1. Projected 3D F1 Broadcast Telemetry Floor Grid + Radar Ring
  const gridAlpha = easeOut(t / 1.2) * 0.28;
  if (gridAlpha > 0.01) {
    ctx.save();
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    const extent = model.radius * 1.25;
    const divs = 6;
    for (let k = -divs; k <= divs; k++) {
      const f = k / divs;
      const distFade = 1 - Math.abs(f) * 0.65;
      ctx.globalAlpha = gridAlpha * distFade * (k === 0 ? 1.15 : 0.72);
      // X-parallel grid line
      projectStage(model, view, -extent, floorY, f * extent, tmpA);
      projectStage(model, view, extent, floorY, f * extent, tmpB);
      ctx.beginPath();
      ctx.moveTo(tmpA.x, tmpA.y);
      ctx.lineTo(tmpB.x, tmpB.y);
      ctx.stroke();
      // Z-parallel grid line
      projectStage(model, view, f * extent, floorY, -extent, tmpA);
      projectStage(model, view, f * extent, floorY, extent, tmpB);
      ctx.beginPath();
      ctx.moveTo(tmpA.x, tmpA.y);
      ctx.lineTo(tmpB.x, tmpB.y);
      ctx.stroke();
    }
    // Outer radar ring on floor
    ctx.globalAlpha = gridAlpha * 0.85;
    ctx.beginPath();
    const ringSteps = 72;
    const rad = model.radius * 1.12;
    for (let i = 0; i <= ringSteps; i++) {
      const a = (i / ringSteps) * Math.PI * 2;
      projectStage(model, view, Math.cos(a) * rad, floorY, Math.sin(a) * rad, tmpA);
      if (i === 0) ctx.moveTo(tmpA.x, tmpA.y);
      else ctx.lineTo(tmpA.x, tmpA.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  const segs = model.closed ? n : n - 1;
  const shown = (i: number) => pts[i].u <= drawn;
  const colourOf = (i: number) => (pts[i].u <= coloured ? c.sectors[pts[i].sector - 1] : c.fog);
  const sectorStarts = new Set(sectors.map((s) => s.start));

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 2. Soft floor ambient glow + dark cast shadow beneath the track footprint
  ctx.lineWidth = lineW * 6.5;
  ctx.globalAlpha = 0.08 + 0.08 * wallT;
  for (let i = 0; i < segs; i++) {
    if (!shown(i)) break;
    const a = gCenter[i];
    const b = gCenter[(i + 1) % n];
    ctx.strokeStyle = colourOf(i);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const shadowOffY = lineW * (1.2 + 1.6 * wallT);
  ctx.strokeStyle = c.void;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = lineW * 4.2;
  ctx.beginPath();
  for (let i = 0; i < segs; i++) {
    if (!shown(i)) break;
    const a = gCenter[i];
    const b = gCenter[(i + 1) % n];
    ctx.moveTo(a.x, a.y + shadowOffY);
    ctx.lineTo(b.x, b.y + shadowOffY);
  }
  ctx.stroke();

  // Base footprint glow line
  if (wallH > 0.01) {
    ctx.lineWidth = lineW * 0.9;
    ctx.globalAlpha = 0.45;
    for (let i = 0; i < segs; i++) {
      if (!shown(i)) break;
      const k = (i + 1) % n;
      ctx.strokeStyle = colourOf(i);
      ctx.beginPath();
      ctx.moveTo(gLeft[i].x, gLeft[i].y);
      ctx.lineTo(gLeft[k].x, gLeft[k].y);
      ctx.moveTo(gRight[i].x, gRight[i].y);
      ctx.lineTo(gRight[k].x, gRight[k].y);
      ctx.stroke();
    }
  }

  // 3. Far-to-near sorted 3D holographic walls + solid top asphalt deck!
  const order: number[] = [];
  for (let i = 0; i < segs; i++) if (shown(i)) order.push(i);
  order.sort((i, j) => {
    const k1 = (i + 1) % n;
    const k2 = (j + 1) % n;
    return gCenter[j].depth + gCenter[k2].depth - (gCenter[i].depth + gCenter[k1].depth);
  });

  for (const i of order) {
    const k = (i + 1) % n;
    const col = colourOf(i);

    if (wallH > 0.01) {
      const shade = wallShade(pts[i], pts[k], view.yaw);
      // Choose outer-facing side wall closest to camera for crisp 3D extrusion
      const leftNearer = gLeft[i].depth + gLeft[k].depth < gRight[i].depth + gRight[k].depth;
      const farBaseA = leftNearer ? gRight[i] : gLeft[i];
      const farBaseB = leftNearer ? gRight[k] : gLeft[k];
      const farTopA = leftNearer ? tRight[i] : tLeft[i];
      const farTopB = leftNearer ? tRight[k] : tLeft[k];
      const nearBaseA = leftNearer ? gLeft[i] : gRight[i];
      const nearBaseB = leftNearer ? gLeft[k] : gRight[k];
      const nearTopA = leftNearer ? tLeft[i] : tRight[i];
      const nearTopB = leftNearer ? tLeft[k] : tRight[k];

      // Inner back wall (subtle depth)
      ctx.beginPath();
      ctx.moveTo(farBaseA.x, farBaseA.y);
      ctx.lineTo(farBaseB.x, farBaseB.y);
      ctx.lineTo(farTopB.x, farTopB.y);
      ctx.lineTo(farTopA.x, farTopA.y);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.14 * wallT;
      ctx.fill();

      // Near outer holographic wall: dark void occlusion core + rich facing-shaded colour
      ctx.beginPath();
      ctx.moveTo(nearBaseA.x, nearBaseA.y);
      ctx.lineTo(nearBaseB.x, nearBaseB.y);
      ctx.lineTo(nearTopB.x, nearTopB.y);
      ctx.lineTo(nearTopA.x, nearTopA.y);
      ctx.closePath();
      ctx.fillStyle = c.void;
      ctx.globalAlpha = 0.68 * wallT;
      ctx.fill();
      ctx.fillStyle = col;
      ctx.globalAlpha = (0.18 + 0.4 * shade) * Math.min(1, wallT * 1.15);
      ctx.fill();

      // Architectural elevation ribs every 14 segments + bright chalk rib at sector boundaries
      if (sectorStarts.has(i) || i % 14 === 0) {
        const isSplit = sectorStarts.has(i);
        ctx.strokeStyle = isSplit ? c.chalk : col;
        ctx.globalAlpha = (isSplit ? 0.78 : 0.3) * wallT;
        ctx.lineWidth = isSplit ? 1.6 : 0.9;
        ctx.beginPath();
        ctx.moveTo(nearBaseA.x, nearBaseA.y);
        ctx.lineTo(nearTopA.x, nearTopA.y);
        ctx.stroke();
      }
    }

    // Solid dark-carbon top track surface deck (only once drawn, gives real track breadth!)
    ctx.beginPath();
    ctx.moveTo(tLeft[i].x, tLeft[i].y);
    ctx.lineTo(tLeft[k].x, tLeft[k].y);
    ctx.lineTo(tRight[k].x, tRight[k].y);
    ctx.lineTo(tRight[i].x, tRight[i].y);
    ctx.closePath();
    ctx.fillStyle = c.carbon;
    ctx.globalAlpha = 0.92;
    ctx.fill();

    // Bright sector-coloured outer kerb rails on both sides of the deck
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = Math.max(1.4, lineW * 0.78);
    ctx.beginPath();
    ctx.moveTo(tLeft[i].x, tLeft[i].y);
    ctx.lineTo(tLeft[k].x, tLeft[k].y);
    ctx.moveTo(tRight[i].x, tRight[i].y);
    ctx.lineTo(tRight[k].x, tRight[k].y);
    ctx.stroke();

    // Crisp sector split bar across the road deck
    if (sectorStarts.has(i) && i > 0 && pts[i].u <= coloured) {
      ctx.strokeStyle = c.chalk;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tLeft[i].x, tLeft[i].y);
      ctx.lineTo(tRight[i].x, tRight[i].y);
      ctx.stroke();
    }
  }

  // 4. Glowing bright centre racing line along the top deck
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = lineW * 2.4;
  for (let i = 0; i < segs; i++) {
    if (!shown(i)) break;
    const k = (i + 1) % n;
    ctx.strokeStyle = colourOf(i);
    ctx.beginPath();
    ctx.moveTo(tCenter[i].x, tCenter[i].y);
    ctx.lineTo(tCenter[k].x, tCenter[k].y);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(0.9, lineW * 0.4);
  ctx.strokeStyle = c.chalk;
  ctx.beginPath();
  for (let i = 0; i < segs; i++) {
    if (!shown(i)) break;
    const k = (i + 1) % n;
    ctx.moveTo(tCenter[i].x, tCenter[i].y);
    ctx.lineTo(tCenter[k].x, tCenter[k].y);
  }
  ctx.stroke();

  // Leading laser spark during initial draw or sector ignition
  const paintSpark = (uPos: number, col: string, strength: number) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(uPos * (n - 1))));
    const p = tCenter[idx];
    const rad = lineW * 7.5;
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
    g.addColorStop(0, c.chalk);
    g.addColorStop(0.32, col);
    g.addColorStop(1, "transparent");
    ctx.globalAlpha = strength;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx.fill();
  };
  if (drawn > 0.01 && drawn < 0.995) {
    paintSpark(drawn, c.volt, 0.95);
  } else if (coloured > 0.01 && coloured < 0.995) {
    const idx = Math.min(n - 1, Math.floor(coloured * (n - 1)));
    paintSpark(coloured, c.sectors[pts[idx].sector - 1], 0.85);
  }

  // 5. Chequered Start/Finish line spanning the track width + glowing gantry posts
  if (t > 3.1) {
    const sfAlpha = easeOut((t - 3.1) / 0.5);
    const a = tCenter[0];
    const b = tCenter[1 % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    const nx = -ty;
    const ny = tx;
    const deckW = Math.hypot(tLeft[0].x - tRight[0].x, tLeft[0].y - tRight[0].y);
    const cols = 6;
    const rows = 2;
    const cell = Math.max(3.2, Math.max(deckW * 1.15, lineW * 8) / cols);

    ctx.save();
    ctx.globalAlpha = sfAlpha;
    if (wallH > 0.01) {
      ctx.strokeStyle = c.chalk;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(gLeft[0].x, gLeft[0].y);
      ctx.lineTo(tLeft[0].x, tLeft[0].y);
      ctx.moveTo(gRight[0].x, gRight[0].y);
      ctx.lineTo(tRight[0].x, tRight[0].y);
      ctx.stroke();
    }
    const pad = 1.4;
    const hw = (cols * cell) / 2 + pad;
    const hh = (rows * cell) / 2 + pad;
    ctx.fillStyle = c.void;
    ctx.beginPath();
    ctx.moveTo(a.x - nx * hw - tx * hh, a.y - ny * hw - ty * hh);
    ctx.lineTo(a.x + nx * hw - tx * hh, a.y + ny * hw - ty * hh);
    ctx.lineTo(a.x + nx * hw + tx * hh, a.y + ny * hw + ty * hh);
    ctx.lineTo(a.x - nx * hw + tx * hh, a.y - ny * hw + ty * hh);
    ctx.closePath();
    ctx.fill();
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (r + col) % 2 === 0 ? c.chalk : c.void;
        const u0 = (col - cols / 2) * cell;
        const u1 = u0 + cell;
        const v0 = (r - rows / 2) * cell;
        const v1 = v0 + cell;
        ctx.beginPath();
        ctx.moveTo(a.x + nx * u0 + tx * v0, a.y + ny * u0 + ty * v0);
        ctx.lineTo(a.x + nx * u1 + tx * v0, a.y + ny * u1 + ty * v0);
        ctx.lineTo(a.x + nx * u1 + tx * v1, a.y + ny * u1 + ty * v1);
        ctx.lineTo(a.x + nx * u0 + tx * v1, a.y + ny * u0 + ty * v1);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 6. Sharp F1-style angled Sector Tags (S1 / S2 / S3) pushed cleanly outward from the centroid
  const badgeFont = Math.max(11, Math.min(w, h) / 60);
  const sectorBoxes: { x: number; y: number; r: number }[] = [];
  ctx.font = `800 ${badgeFont}px ${monoFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  sectors.forEach((sec, idx) => {
    const appear = easeOut((t - 7.1 - idx * 0.25) / 0.42);
    if (appear <= 0) return;
    const p = tCenter[sec.mid];
    if (!p) return;
    let ox = p.x - cx;
    let oy = p.y - cy;
    const olen = Math.hypot(ox, oy) || 1;
    ox /= olen;
    oy /= olen;
    const dist = badgeFont * (portrait ? 2.8 : 3.5);
    const bx = p.x + ox * dist;
    const by = p.y + oy * dist;
    const label = sectorLabels[sec.sector - 1];
    const pw = badgeFont * 2.75;
    const ph = badgeFont * 1.6;
    sectorBoxes.push({ x: bx, y: by, r: Math.max(pw, ph) * 0.62 });
    const secCol = c.sectors[sec.sector - 1];
    ctx.save();
    ctx.globalAlpha = appear * 0.65;
    ctx.strokeStyle = secCol;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(bx - ox * (pw * 0.35), by - oy * (ph * 0.35));
    ctx.stroke();
    ctx.globalAlpha = appear;
    // Chamfered F1 tag
    ctx.fillStyle = c.void;
    chamferBox(ctx, bx - pw / 2, by - ph / 2, pw, ph, 4);
    ctx.fill();
    ctx.strokeStyle = secCol;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // Solid left colour accent stripe inside tag
    ctx.fillStyle = secCol;
    ctx.fillRect(bx - pw / 2, by - ph / 2, 3.5, ph);
    ctx.fillText(label, bx + 1.5, by + 0.5);
    ctx.restore();
  });

  // 7. Corner numbers: slender pins + crisp dark badges, gently repelled from each other and from S1/S2/S3 tags
  const size = Math.max(11, Math.min(w, h) / 58);
  const baseR = size * 0.94;
  const lift = size * 1.85;
  const pins: { x: number; y: number; ax: number; ay: number; r: number; appear: number; num: number; col: string }[] = [];
  model.turns.forEach((turn, k) => {
    const appear = easeOut((t - 7.6 - k * 0.12) / 0.38);
    if (appear <= 0) return;
    const p = tCenter[turn.at];
    if (!p) return;
    pins.push({ x: p.x, y: p.y - lift, ax: p.x, ay: p.y, r: baseR * appear, appear, num: turn.number, col: colourOf(turn.at) });
  });
  const minSep = baseR * 2.35;
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < pins.length; i++) {
      // Repel away from S1/S2/S3 sector tags so turn discs never cover a sector label
      for (const box of sectorBoxes) {
        const dx = pins[i].x - box.x;
        const dy = pins[i].y - box.y;
        const d = Math.hypot(dx, dy) || 0.1;
        const need = baseR + box.r + 3;
        if (d < need) {
          const push = need - d;
          pins[i].x += (dx / d) * push;
          pins[i].y += (dy / d) * push;
        }
      }
      for (let j = i + 1; j < pins.length; j++) {
        const dx = pins[j].x - pins[i].x;
        const dy = pins[j].y - pins[i].y;
        const d = Math.hypot(dx, dy) || 0.1;
        if (d < minSep) {
          const push = (minSep - d) * 0.52;
          const ux = dx / d;
          const uy = dy / d;
          pins[i].x -= ux * push;
          pins[i].y -= uy * push;
          pins[j].x += ux * push;
          pins[j].y += uy * push;
        }
      }
    }
  }
  ctx.font = `700 ${size}px ${displayFont}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const pin of pins) {
    ctx.globalAlpha = pin.appear;
    ctx.strokeStyle = c.slate;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pin.ax, pin.ay);
    ctx.lineTo(pin.x, pin.y);
    ctx.stroke();
    ctx.fillStyle = c.void;
    ctx.beginPath();
    ctx.arc(pin.x, pin.y, pin.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = pin.col;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = c.chalk;
    ctx.fillText(String(pin.num), pin.x, pin.y + 0.5);
  }
  ctx.globalAlpha = 1;

  // 8. High-speed racing comet streaking along the top track deck
  if (t > 9.8) {
    const cometIn = easeOut((t - 9.8) / 0.55);
    const u = ((t - 9.8) / 6.4) % 1;
    const head = Math.min(n - 1, Math.floor(u * n));
    const trailSteps = 22;
    for (let s = trailSteps; s >= 1; s--) {
      const i0 = (head - s + n) % n;
      const i1 = (head - s + 1 + n) % n;
      if (!model.closed && i1 < i0) continue;
      const frac = 1 - s / trailSteps;
      ctx.globalAlpha = cometIn * frac * frac * 0.92;
      ctx.strokeStyle = frac > 0.68 ? c.chalk : c.volt;
      ctx.lineWidth = lineW * (0.7 + 1.8 * frac);
      ctx.beginPath();
      ctx.moveTo(tCenter[i0].x, tCenter[i0].y);
      ctx.lineTo(tCenter[i1].x, tCenter[i1].y);
      ctx.stroke();
    }
    const p = tCenter[head];
    const glowR = lineW * 8.5;
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
    glow.addColorStop(0, c.chalk);
    glow.addColorStop(0.3, c.volt);
    glow.addColorStop(1, "transparent");
    ctx.globalAlpha = cometIn;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function chamferBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cut: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - cut, y);
  ctx.lineTo(x + w, y + cut);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}
