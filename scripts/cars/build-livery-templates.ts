/**
 * Generates 2048x2048 livery painting templates, transparent line overlays, and 640px doc previews
 * for the F1 cars (`lc26`, `lc25`) using the exact shared projection math from `src/lib/render/livery-projection.ts`.
 *
 * Usage:
 *   npx tsx scripts/cars/build-livery-templates.ts
 *   npx tsx scripts/cars/build-livery-templates.ts lc26
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";
import {
  F1_PANEL_IDS,
  F1_PROJECTION,
  f1ProjectToPanel,
  projectF1Point,
  type AtlasPanelRect,
  type F1PanelId,
} from "../../src/lib/render/livery-projection";

const ROOT = process.cwd();
const OUT_ROOT = join(ROOT, "docs/livery-templates");
const SIZE = F1_PROJECTION.atlasSize;
const PAINT_ZONE_MATERIALS = new Set(["EXT_PAINT_PRIMARY", "EXT_PAINT_SECONDARY", "EXT_PAINT_ACCENT"]);

interface CarTemplateTarget {
  readonly id: "lc26" | "lc25";
  readonly title: string;
  readonly glbPath: string;
  /** Whether geometry outside the main F1 projection bounds (top/side/fwEndplate) is expected and hatched */
  readonly allowMainBoundsClamping: boolean;
}

const TARGETS: readonly CarTemplateTarget[] = [
  {
    id: "lc26",
    title: "LC26 Prototype",
    glbPath: join(ROOT, "public/cars/f12026/model/f12026.glb"),
    allowMainBoundsClamping: false,
  },
  {
    id: "lc25",
    title: "LC25 Prototype",
    glbPath: join(ROOT, "public/cars/lc25/model/lc25.glb"),
    allowMainBoundsClamping: true,
  },
];

const MAIN_BOUND_PANELS = new Set<F1PanelId>(["top", "left", "right", "fwEndplateLeft", "fwEndplateRight"]);

type Vec3 = [number, number, number];

interface PaintTri {
  readonly v0: Vec3;
  readonly v1: Vec3;
  readonly v2: Vec3;
  readonly n0: Vec3;
  readonly n1: Vec3;
  readonly n2: Vec3;
  readonly faceNrm: Vec3;
  readonly material: string;
}

interface ClampingStats {
  totalVerts: number;
  dominantClampedTotal: number;
  byPanel: Record<F1PanelId, { count: number; uLo: number; uHi: number; vLo: number; vHi: number }>;
}

function emptyClampingStats(): ClampingStats {
  const byPanel = {} as ClampingStats["byPanel"];
  for (const p of F1_PANEL_IDS) byPanel[p] = { count: 0, uLo: 0, uHi: 0, vLo: 0, vHi: 0 };
  return { totalVerts: 0, dominantClampedTotal: 0, byPanel };
}

function transformPoint(m: readonly number[], p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function transformNormal(m: readonly number[], n: Vec3): Vec3 {
  const x = m[0] * n[0] + m[4] * n[1] + m[8] * n[2];
  const y = m[1] * n[0] + m[5] * n[1] + m[9] * n[2];
  const z = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
  const len = Math.hypot(x, y, z);
  return len > 1e-12 ? [x / len, y / len, z / len] : [0, 1, 0];
}

function computeFaceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-12 ? [nx / len, ny / len, nz / len] : [0, 1, 0];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Loads all paint-zone triangles and axle positions from a car GLB (flaps placed by their `aeroClosed` frame) */
async function loadPaintGeometry(glbPath: string): Promise<{
  triangles: PaintTri[];
  frontAxleZ: number;
  rearAxleZ: number;
  clamping: ClampingStats;
  bounds: { min: Vec3; max: Vec3 };
}> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc = await io.read(glbPath);

  let frontAxleZ = 1.5045;
  let rearAxleZ = -1.8955;
  const triangles: PaintTri[] = [];
  const clamping = emptyClampingStats();
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (const node of doc.getRoot().listNodes()) {
    const extras = node.getExtras() as {
      wheelCentres?: Record<string, [number, number, number]>;
      aeroClosed?: number[];
    };
    if (extras?.wheelCentres) {
      const lf = extras.wheelCentres.WHEEL_LF;
      const lr = extras.wheelCentres.WHEEL_LR;
      if (Array.isArray(lf) && lf.length === 3) frontAxleZ = lf[2];
      if (Array.isArray(lr) && lr.length === 3) rearAxleZ = lr[2];
    }

    const mesh = node.getMesh();
    if (!mesh) continue;

    // Match lc26-car-model.ts `flapNodeFor`: walk up for `aeroClosed`, otherwise use world matrix (BODY is identity)
    let aeroMatrix: number[] | null = null;
    for (let cur = node as typeof node | null; cur; cur = cur.getParentNode()) {
      const ex = cur.getExtras() as { aeroClosed?: number[] } | undefined;
      if (Array.isArray(ex?.aeroClosed) && ex.aeroClosed.length === 16) {
        aeroMatrix = ex.aeroClosed;
        break;
      }
    }
    const frameMatrix = aeroMatrix ?? node.getWorldMatrix();

    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? "";
      if (!PAINT_ZONE_MATERIALS.has(matName)) continue;

      const posAcc = prim.getAttribute("POSITION");
      if (!posAcc) continue;
      const nrmAcc = prim.getAttribute("NORMAL");
      const idxAcc = prim.getIndices();
      const vCount = posAcc.getCount();

      const verts: Vec3[] = new Array(vCount);
      const norms: Vec3[] = new Array(vCount);
      const tmp: Vec3 = [0, 0, 0];

      for (let i = 0; i < vCount; i++) {
        posAcc.getElement(i, tmp);
        const p = transformPoint(frameMatrix, tmp);
        verts[i] = p;
        for (let k = 0; k < 3; k++) {
          if (p[k] < min[k]) min[k] = p[k];
          if (p[k] > max[k]) max[k] = p[k];
        }
        if (nrmAcc) {
          nrmAcc.getElement(i, tmp);
          norms[i] = transformNormal(frameMatrix, tmp);
        } else {
          norms[i] = [0, 1, 0];
        }

        // Validate every painted vertex against the shared projection math
        clamping.totalVerts++;
        const proj = projectF1Point(p, norms[i]);
        const dom = proj.dominantPanel;
        const sample = f1ProjectToPanel(dom, p[0], p[1], p[2]);
        const rect = F1_PROJECTION.panels[dom];
        if (
          !Number.isFinite(sample.px) ||
          !Number.isFinite(sample.py) ||
          sample.px < rect.x ||
          sample.px > rect.x + rect.w ||
          sample.py < rect.y ||
          sample.py > rect.y + rect.h
        ) {
          throw new Error(
            `${glbPath}: vertex ${i} (${p.map((v) => v.toFixed(3)).join(",")}) mapped outside panel ${dom} rect`
          );
        }
        if (sample.clamped) {
          clamping.dominantClampedTotal++;
          const c = clamping.byPanel[dom];
          c.count++;
          if (sample.rawU < 0) c.uLo++;
          if (sample.rawU > 1) c.uHi++;
          if (sample.rawV < 0) c.vLo++;
          if (sample.rawV > 1) c.vHi++;
        }
      }

      const triCount = idxAcc ? Math.floor(idxAcc.getCount() / 3) : Math.floor(vCount / 3);
      for (let t = 0; t < triCount; t++) {
        const i0 = idxAcc ? idxAcc.getScalar(t * 3) : t * 3;
        const i1 = idxAcc ? idxAcc.getScalar(t * 3 + 1) : t * 3 + 1;
        const i2 = idxAcc ? idxAcc.getScalar(t * 3 + 2) : t * 3 + 2;
        const v0 = verts[i0], v1 = verts[i1], v2 = verts[i2];
        const faceNrm = computeFaceNormal(v0, v1, v2);
        triangles.push({
          v0,
          v1,
          v2,
          n0: nrmAcc ? norms[i0] : faceNrm,
          n1: nrmAcc ? norms[i1] : faceNrm,
          n2: nrmAcc ? norms[i2] : faceNrm,
          faceNrm,
          material: matName,
        });
      }
    }
  }

  return { triangles, frontAxleZ, rearAxleZ, clamping, bounds: { min, max } };
}

// ---------------------------------------------------------------------------
// Rasterisation helpers (2048x2048 pixel buffers)
// ---------------------------------------------------------------------------

function rasterizeTriangle(
  mask: Uint8Array,
  rect: AtlasPanelRect,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  value: number
): void {
  const minX = Math.max(rect.x, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(rect.x + rect.w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(rect.y, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(rect.y + rect.h - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;

  const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
  if (Math.abs(area) < 1e-4) return;
  const sign = area > 0 ? 1 : -1;

  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    const row = y * SIZE;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const e0 = ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) * sign;
      if (e0 < -1e-4) continue;
      const e1 = ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * sign;
      if (e1 < -1e-4) continue;
      const e2 = ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)) * sign;
      if (e2 < -1e-4) continue;
      const idx = row + x;
      if (value > mask[idx]) mask[idx] = value;
    }
  }
}

function drawLine(
  buf: Uint8Array,
  rect: AtlasPanelRect,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
  thick = false
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  const rx0 = rect.x;
  const ry0 = rect.y;
  const rx1 = rect.x + rect.w - 1;
  const ry1 = rect.y + rect.h - 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const ix = Math.round(x0 + dx * t);
    const iy = Math.round(y0 + dy * t);
    if (ix >= rx0 && ix <= rx1 && iy >= ry0 && iy <= ry1) {
      const idx = iy * SIZE + ix;
      if (value > buf[idx]) buf[idx] = value;
      if (thick) {
        if (ix + 1 <= rx1 && value > buf[idx + 1]) buf[idx + 1] = value;
        if (iy + 1 <= ry1 && value > buf[idx + SIZE]) buf[idx + SIZE] = value;
      }
    }
  }
}

function dilateMaskInPanel(src: Uint8Array, rect: AtlasPanelRect, radius: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const rx0 = rect.x, ry0 = rect.y, rx1 = rect.x + rect.w - 1, ry1 = rect.y + rect.h - 1;
  for (let y = ry0; y <= ry1; y++) {
    const row = y * SIZE;
    for (let x = rx0; x <= rx1; x++) {
      if (!src[row + x]) continue;
      const yLo = Math.max(ry0, y - radius);
      const yHi = Math.min(ry1, y + radius);
      const xLo = Math.max(rx0, x - radius);
      const xHi = Math.min(rx1, x + radius);
      for (let yy = yLo; yy <= yHi; yy++) {
        const oRow = yy * SIZE;
        for (let xx = xLo; xx <= xHi; xx++) out[oRow + xx] = 1;
      }
    }
  }
  return out;
}

function quantKey(v: Vec3): string {
  return `${Math.round(v[0] * 2000)},${Math.round(v[1] * 2000)},${Math.round(v[2] * 2000)}`;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Projects a car-space point into a panel's exact SVG/pixel coordinate (clamped) */
function pt(panel: F1PanelId, x: number, y: number, z: number): [number, number] {
  const s = f1ProjectToPanel(panel, x, y, z);
  return [s.px, s.py];
}

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Builds the crisp 2048x2048 SVG vector overlay (frames, centre/axle lines, arrows, accessible labels) */
function buildVectorSvg(
  target: CarTemplateTarget,
  frontAxleZ: number,
  rearAxleZ: number,
  clamping: ClampingStats,
  overlayOnly: boolean
): string {
  const p = F1_PROJECTION.panels;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`);
  parts.push(`<defs>`);
  parts.push(`  <style>`);
  parts.push(`    .hdr { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 0.5px; }`);
  parts.push(`    .stamp { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 1px; }`);
  parts.push(`    .ref { font-family: Arial, Helvetica, sans-serif; font-weight: 700; }`);
  parts.push(`  </style>`);
  parts.push(`</defs>`);

  const dashColor = overlayOnly ? "#0f172a" : "#334155";
  const dashOpacity = overlayOnly ? "0.75" : "0.7";

  // 1) Centre line (X = 0) on TOP, REAR, FRONT
  const topCentreY = pt("top", 0, 0, 0)[1];
  const rearCentreX = pt("rear", 0, 0.7, -2.3)[0];
  const frontCentreX = pt("front", 0, 0.3, 2.3)[0];
  parts.push(
    `<line x1="${p.top.x + 2}" y1="${topCentreY.toFixed(1)}" x2="${p.top.x + p.top.w - 2}" y2="${topCentreY.toFixed(1)}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="14 10" />`
  );
  parts.push(
    `<line x1="${rearCentreX.toFixed(1)}" y1="${p.rear.y + 2}" x2="${rearCentreX.toFixed(1)}" y2="${p.rear.y + p.rear.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );
  parts.push(
    `<line x1="${frontCentreX.toFixed(1)}" y1="${p.front.y + 2}" x2="${frontCentreX.toFixed(1)}" y2="${p.front.y + p.front.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );

  // 2) Front and rear axle lines on TOP, LEFT SIDE, RIGHT SIDE
  const axlePanels: readonly F1PanelId[] = ["top", "left", "right"];
  for (const pid of axlePanels) {
    const r = p[pid];
    const fx = pt(pid, 0, 0.5, frontAxleZ)[0];
    const rx = pt(pid, 0, 0.5, rearAxleZ)[0];
    parts.push(
      `<line x1="${fx.toFixed(1)}" y1="${r.y + 2}" x2="${fx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
    parts.push(
      `<line x1="${rx.toFixed(1)}" y1="${r.y + 2}" x2="${rx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
    if (!overlayOnly) {
      const labelY = r.y + r.h - 14;
      const fxAnchor = pid === "left" ? "start" : "end";
      const fxDx = fxAnchor === "end" ? -10 : 10;
      const rxAnchor = pid === "left" ? "end" : "start";
      const rxDx = rxAnchor === "start" ? 10 : -10;
      parts.push(
        `<text x="${(fx + fxDx).toFixed(1)}" y="${labelY}" text-anchor="${fxAnchor}" font-size="22" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="ref">FRONT AXLE</text>`
      );
      parts.push(
        `<text x="${(rx + rxDx).toFixed(1)}" y="${labelY}" text-anchor="${rxAnchor}" font-size="22" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="ref">REAR AXLE</text>`
      );
    }
  }

  // Centre line label on TOP panel
  if (!overlayOnly) {
    parts.push(
      `<text x="${p.top.x + 18}" y="${(topCentreY - 12).toFixed(1)}" font-size="22" fill="#0f172a" stroke="#ffffff" stroke-width="5" paint-order="stroke" class="ref">CENTRE LINE (X = 0)</text>`
    );
  }

  // 3) Panel frames (solid 3px outer border + faint 2px clamp-pad border)
  for (const pid of F1_PANEL_IDS) {
    const r = p[pid];
    parts.push(
      `<rect x="${r.x + 1}" y="${r.y + 1}" width="${r.w - 2}" height="${r.h - 2}" fill="none" stroke="#0f172a" stroke-width="3" />`
    );
  }

  // Helper to draw a high-contrast pill badge (>= 28px text, dark bg, white text, crisp white halo)
  const pill = (x: number, y: number, text: string, fontSize = 30, align: "start" | "end" | "middle" = "start") => {
    const padX = 14;
    const h = Math.round(fontSize * 1.42);
    const estW = Math.round(text.length * fontSize * 0.62) + padX * 2;
    const bx = align === "start" ? x : align === "end" ? x - estW : x - estW / 2;
    const tx = bx + estW / 2;
    const ty = y + Math.round(h * 0.72);
    parts.push(
      `<rect x="${bx}" y="${y}" width="${estW}" height="${h}" rx="6" fill="#0f172a" stroke="#ffffff" stroke-width="2" />`
    );
    parts.push(
      `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff" class="hdr">${escXml(text)}</text>`
    );
  };

  // Helper to draw a crisp bold directional arrow (colour-blind safe: high contrast black with white stroke)
  const arrow = (x1: number, y: number, x2: number, label: string) => {
    const dir = x2 > x1 ? 1 : -1;
    const head = 18;
    const tipX = x2;
    const lineEnd = x2 - dir * 12;
    const midX = (x1 + x2) / 2;
    parts.push(
      `<line x1="${x1}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="#ffffff" stroke-width="9" stroke-linecap="round" />`
    );
    parts.push(
      `<polygon points="${tipX},${y} ${tipX - dir * head},${y - 11} ${tipX - dir * head},${y + 11}" fill="#ffffff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round" />`
    );
    parts.push(
      `<line x1="${x1}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="#0f172a" stroke-width="5" stroke-linecap="round" />`
    );
    parts.push(
      `<polygon points="${tipX},${y} ${tipX - dir * head},${y - 10} ${tipX - dir * head},${y + 10}" fill="#0f172a" />`
    );
    parts.push(
      `<text x="${midX}" y="${y - 14}" text-anchor="middle" font-size="28" fill="#0f172a" stroke="#ffffff" stroke-width="5" paint-order="stroke" class="hdr">${escXml(label)}</text>`
    );
  };

  if (overlayOnly) {
    // Minimal unobtrusive corner tags in the transparent overlay
    const tag = (x: number, y: number, text: string) => {
      parts.push(
        `<text x="${x}" y="${y}" font-size="28" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="hdr">${escXml(text)}</text>`
      );
    };
    tag(p.top.x + 14, p.top.y + 34, `${target.id.toUpperCase()} — TOP (FRONT →)`);
    tag(p.left.x + 14, p.left.y + 34, `LEFT SIDE (← FRONT)`);
    tag(p.right.x + 14, p.right.y + 34, `RIGHT SIDE (FRONT →)`);
    tag(p.rear.x + 14, p.rear.y + 34, `REAR`);
    tag(p.front.x + 14, p.front.y + 34, `FRONT`);
    tag(p.fwEndplateLeft.x + 12, p.fwEndplateLeft.y + 30, `FW ENDPLATE L (←)`);
    tag(p.fwEndplateRight.x + 12, p.fwEndplateRight.y + 30, `FW ENDPLATE R (→)`);
  } else {
    // Full high-contrast panel headers + front-direction arrows + in-body alignment stamps
    pill(p.top.x + 16, p.top.y + 14, `${target.id.toUpperCase()} · TOP VIEW`, 32, "start");
    arrow(p.top.x + 1260, p.top.y + 52, p.top.x + 1520, "FRONT");

    pill(p.left.x + 16, p.left.y + 14, "LEFT SIDE (+X)", 30, "start");
    arrow(p.left.x + 560, p.left.y + 50, p.left.x + 310, "FRONT");

    pill(p.right.x + 16, p.right.y + 14, "RIGHT SIDE (-X)", 30, "start");
    arrow(p.right.x + p.right.w - 280, p.right.y + 50, p.right.x + p.right.w - 30, "FRONT");

    pill(p.rear.x + 16, p.rear.y + 12, "REAR (-Z)", 28, "start");
    pill(p.rear.x + p.rear.w - 16, p.rear.y + 12, "L ←  |  → R", 28, "end");

    pill(p.front.x + 14, p.front.y + 12, "FRONT (+Z)", 28, "start");
    pill(p.front.x + p.front.w - 14, p.front.y + 12, "R ← | → L", 28, "end");

    pill(p.fwEndplateLeft.x + 12, p.fwEndplateLeft.y + 20, "FW ENDPLATE L  ← FRONT", 28, "start");
    pill(p.fwEndplateRight.x + 12, p.fwEndplateRight.y + 20, "FW ENDPLATE R  FRONT →", 28, "start");

    // In-body orientation stamps so the 3D render proves alignment & non-mirroring directly on the bodywork
    const bodyStamp = (x: number, y: number, text: string, fontSize = 36) => {
      parts.push(
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="#0f172a" stroke="#ffffff" stroke-width="6" paint-order="stroke" class="stamp">${escXml(text)}</text>`
      );
    };

    // TOP: nose / cockpit forward & rear engine cover
    const [topSideLX, topSideLY] = pt("top", 0.48, 0.5, -0.3);
    const [topSideRX, topSideRY] = pt("top", -0.48, 0.5, -0.3);
    const [topNoseX, topNoseY] = pt("top", 0, 0.4, 1.45);
    bodyStamp(topSideLX, topSideLY, "TOP L  →", 32);
    bodyStamp(topSideRX, topSideRY, "TOP R  →", 32);
    bodyStamp(topNoseX, topNoseY, "TOP →", 32);

    // LEFT SIDE: main sidepod flank (z = -0.30, y = 0.44) — reads upright left-to-right on the car's left side!
    const [leftPodX, leftPodY] = pt("left", 0.5, 0.44, -0.3);
    bodyStamp(leftPodX, leftPodY, "← FRONT · LEFT SIDE", 42);

    // RIGHT SIDE: main sidepod flank (z = -0.30, y = 0.44) — reads upright left-to-right on the car's right side!
    const [rightPodX, rightPodY] = pt("right", -0.5, 0.44, -0.3);
    bodyStamp(rightPodX, rightPodY, "RIGHT SIDE · FRONT →", 42);

    // REAR: rear wing mainplane banner (x = 0, y = 0.81)
    const [rearWingX, rearWingY] = pt("rear", 0, 0.81, -2.35);
    bodyStamp(rearWingX, rearWingY, "REAR WING", 48);

    // FRONT: nose front face (x = 0, y = 0.30)
    const [frontNoseX, frontNoseY] = pt("front", 0, 0.3, 2.5);
    bodyStamp(frontNoseX, frontNoseY, "FRONT", 34);

    // Clamped edge callouts when the car has geometry exceeding the shared F1 projection bounds (lc25)
    if (target.allowMainBoundsClamping && clamping.byPanel.top.count > 0) {
      pill(p.top.x + 16, p.top.y + p.top.h - 56, "HATCHED = CLAMPED EDGE (|X| > 0.95m)", 28, "start");
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

async function generateTemplateForCar(target: CarTemplateTarget): Promise<void> {
  const { triangles, frontAxleZ, rearAxleZ, clamping, bounds } = await loadPaintGeometry(target.glbPath);

  // Fail loudly if a car that shouldn't clamp main bounds has any clamped vertices on top/side/fwEndplate
  if (!target.allowMainBoundsClamping) {
    const unexpected: string[] = [];
    for (const pid of MAIN_BOUND_PANELS) {
      if (clamping.byPanel[pid].count > 0) unexpected.push(`${pid}=${clamping.byPanel[pid].count}`);
    }
    if (unexpected.length > 0) {
      throw new Error(`${target.id}: unexpected clamped vertices on main panels: ${unexpected.join(", ")}`);
    }
  }

  // Per-panel occupancy mask, clamped-region mask, and edge buffers
  const fillMask = new Uint8Array(SIZE * SIZE); // 0 = empty, 1 = subtle blend, 2 = strong coverage
  const clampedRaw = new Uint8Array(SIZE * SIZE); // 1 where a clamped triangle touches a panel edge
  const meshEdges = new Uint8Array(SIZE * SIZE); // faint wireframe
  const featureEdges = new Uint8Array(SIZE * SIZE); // crisp creases, paint-zone splits & open boundaries

  // Collect per-panel triangles and adjacency for crease / boundary detection
  interface EdgeRef {
    tri: PaintTri;
    a2d: [number, number];
    b2d: [number, number];
    clamped: boolean;
  }

  const panelEdges = new Map<F1PanelId, Map<string, EdgeRef[]>>();
  for (const pid of F1_PANEL_IDS) panelEdges.set(pid, new Map());

  const WEIGHT_MIN = 0.18;
  const WEIGHT_STRONG = 0.45;
  const CREASE_COS = Math.cos((24 * Math.PI) / 180);

  for (const tri of triangles) {
    const cx = (tri.v0[0] + tri.v1[0] + tri.v2[0]) / 3;
    const cy = (tri.v0[1] + tri.v1[1] + tri.v2[1]) / 3;
    const cz = (tri.v0[2] + tri.v1[2] + tri.v2[2]) / 3;
    const cnx = tri.n0[0] + tri.n1[0] + tri.n2[0];
    const cny = tri.n0[1] + tri.n1[1] + tri.n2[1];
    const cnz = tri.n0[2] + tri.n1[2] + tri.n2[2];

    const p0 = projectF1Point(tri.v0, tri.n0);
    const p1 = projectF1Point(tri.v1, tri.n1);
    const p2 = projectF1Point(tri.v2, tri.n2);
    const pc = projectF1Point([cx, cy, cz], [cnx, cny, cnz]);

    const k0 = quantKey(tri.v0);
    const k1 = quantKey(tri.v1);
    const k2 = quantKey(tri.v2);

    for (const pid of F1_PANEL_IDS) {
      const wMax = Math.max(
        p0.panelWeights[pid] ?? 0,
        p1.panelWeights[pid] ?? 0,
        p2.panelWeights[pid] ?? 0,
        pc.panelWeights[pid] ?? 0
      );
      if (wMax < WEIGHT_MIN && pc.dominantPanel !== pid) continue;

      const s0 = f1ProjectToPanel(pid, tri.v0[0], tri.v0[1], tri.v0[2]);
      const s1 = f1ProjectToPanel(pid, tri.v1[0], tri.v1[1], tri.v1[2]);
      const s2 = f1ProjectToPanel(pid, tri.v2[0], tri.v2[1], tri.v2[2]);
      const rect = F1_PROJECTION.panels[pid];

      const fillVal = wMax >= WEIGHT_STRONG ? 2 : 1;
      rasterizeTriangle(fillMask, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, fillVal);

      // Mark clamped geometry on main panels (or outer X clamping on front/rear) so the hatch pattern highlights it
      if (target.allowMainBoundsClamping) {
        const markClamped = (s: typeof s0) => {
          if (!s.clamped) return;
          // On rear/front panels, lower-Y/upper-Y clamping is intentional on both cars; only hatch X/main clamping
          const relevant = MAIN_BOUND_PANELS.has(pid) || s.clampedU;
          if (!relevant) return;
          const ix = Math.max(rect.x, Math.min(rect.x + rect.w - 1, Math.round(s.px)));
          const iy = Math.max(rect.y, Math.min(rect.y + rect.h - 1, Math.round(s.py)));
          clampedRaw[iy * SIZE + ix] = 1;
        };
        markClamped(s0);
        markClamped(s1);
        markClamped(s2);
        if ((s0.clamped && (MAIN_BOUND_PANELS.has(pid) || s0.clampedU)) ||
            (s1.clamped && (MAIN_BOUND_PANELS.has(pid) || s1.clampedU)) ||
            (s2.clamped && (MAIN_BOUND_PANELS.has(pid) || s2.clampedU))) {
          rasterizeTriangle(clampedRaw, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, 1);
        }
      }

      const edges = panelEdges.get(pid)!;
      const addEdge = (ka: string, kb: string, a2d: [number, number], b2d: [number, number], clamped: boolean) => {
        const key = edgeKey(ka, kb);
        let list = edges.get(key);
        if (!list) {
          list = [];
          edges.set(key, list);
        }
        list.push({ tri, a2d, b2d, clamped });
      };
      addEdge(k0, k1, [s0.px, s0.py], [s1.px, s1.py], s0.clamped || s1.clamped);
      addEdge(k1, k2, [s1.px, s1.py], [s2.px, s2.py], s1.clamped || s2.clamped);
      addEdge(k2, k0, [s2.px, s2.py], [s0.px, s0.py], s2.clamped || s0.clamped);
    }
  }

  // Draw crease edges, paint-zone boundaries, open boundaries, and faint wireframe per panel
  for (const pid of F1_PANEL_IDS) {
    const rect = F1_PROJECTION.panels[pid];
    const edges = panelEdges.get(pid)!;
    for (const refs of edges.values()) {
      const r0 = refs[0];
      if (refs.length === 1) {
        drawLine(featureEdges, rect, r0.a2d[0], r0.a2d[1], r0.b2d[0], r0.b2d[1], 2, false);
      } else {
        const r1 = refs[1];
        const sharp = dot3(r0.tri.faceNrm, r1.tri.faceNrm) < CREASE_COS;
        const zoneSplit = r0.tri.material !== r1.tri.material;
        if (sharp || zoneSplit) {
          drawLine(featureEdges, rect, r0.a2d[0], r0.a2d[1], r0.b2d[0], r0.b2d[1], zoneSplit ? 2 : 1, false);
        } else {
          drawLine(meshEdges, rect, r0.a2d[0], r0.a2d[1], r0.b2d[0], r0.b2d[1], 1, false);
        }
      }
    }
  }

  // Expand clamped regions by 14 px inward inside each panel so clamped strips are unmistakably hatched
  const clampedBand = new Uint8Array(SIZE * SIZE);
  if (target.allowMainBoundsClamping) {
    for (const pid of F1_PANEL_IDS) {
      const rect = F1_PROJECTION.panels[pid];
      const dilated = dilateMaskInPanel(clampedRaw, rect, 14);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const row = y * SIZE;
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          if (dilated[row + x]) clampedBand[row + x] = 1;
        }
      }
    }
  }

  // Outer silhouette contour (2px dark outline around each panel's filled region)
  const silhouette = new Uint8Array(SIZE * SIZE);
  for (const pid of F1_PANEL_IDS) {
    const r = F1_PROJECTION.panels[pid];
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * SIZE;
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!fillMask[row + x]) continue;
        let isEdge = false;
        for (let dy = -1; dy <= 1 && !isEdge; dy++) {
          const yy = y + dy;
          if (yy < r.y || yy >= r.y + r.h) {
            isEdge = true;
            break;
          }
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < r.x || xx >= r.x + r.w || !fillMask[yy * SIZE + xx]) {
              isEdge = true;
              break;
            }
          }
        }
        if (isEdge) silhouette[row + x] = 1;
      }
    }
  }

  // Compose opaque template RGBA and transparent overlay RGBA buffers
  const templateRgba = Buffer.alloc(SIZE * SIZE * 4);
  const overlayRgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    const row = y * SIZE;
    for (let x = 0; x < SIZE; x++) {
      const idx = row + x;
      const o = idx * 4;
      const fill = fillMask[idx];
      const clamped = clampedBand[idx];
      const feat = featureEdges[idx];
      const sil = silhouette[idx];
      const mesh = meshEdges[idx];

      // Opaque template pixel
      let r = 203, g = 213, b = 225; // neutral #cbd5e1 outside car
      if (fill === 1) {
        r = 226; g = 232; b = 240; // soft transition zone #e2e8f0
      } else if (fill === 2) {
        r = 244; g = 247; b = 251; // primary paintable car surface #f4f7fb
      }

      // Clamped-edge diagonal hatch pattern (high-contrast 45° dark/light stripes, colour-blind safe)
      if (clamped) {
        const stripe = ((x + y) % 14) < 6;
        if (stripe) {
          r = 30; g = 41; b = 59; // #1e293b
        } else {
          r = 245; g = 208; b = 88; // warm light amber #f5d058 (high contrast in both colour & grayscale)
        }
      }

      if (mesh && !clamped) {
        // Subtle 18% blend for topology wireframe
        r = Math.round(r * 0.84 + 100 * 0.16);
        g = Math.round(g * 0.84 + 116 * 0.16);
        b = Math.round(b * 0.84 + 139 * 0.16);
      }
      if (feat === 1) {
        r = 51; g = 65; b = 85; // #334155 crease
      } else if (feat === 2) {
        r = 15; g = 23; b = 42; // #0f172a paint-zone / boundary
      }
      if (sil) {
        r = 15; g = 23; b = 42; // #0f172a silhouette contour
      }

      templateRgba[o] = r;
      templateRgba[o + 1] = g;
      templateRgba[o + 2] = b;
      templateRgba[o + 3] = 255;

      // Transparent overlay pixel: outlines & clamped edge hatch only
      if (sil || feat === 2) {
        overlayRgba[o] = 15;
        overlayRgba[o + 1] = 23;
        overlayRgba[o + 2] = 42;
        overlayRgba[o + 3] = 230;
      } else if (feat === 1) {
        overlayRgba[o] = 30;
        overlayRgba[o + 1] = 41;
        overlayRgba[o + 2] = 59;
        overlayRgba[o + 3] = 150;
      } else if (clamped && ((x + y) % 14) < 5) {
        overlayRgba[o] = 15;
        overlayRgba[o + 1] = 23;
        overlayRgba[o + 2] = 42;
        overlayRgba[o + 3] = 180;
      } else if (mesh) {
        overlayRgba[o] = 71;
        overlayRgba[o + 1] = 85;
        overlayRgba[o + 2] = 105;
        overlayRgba[o + 3] = 55;
      }
    }
  }

  const templateSvg = Buffer.from(buildVectorSvg(target, frontAxleZ, rearAxleZ, clamping, false));
  const overlaySvg = Buffer.from(buildVectorSvg(target, frontAxleZ, rearAxleZ, clamping, true));

  const outDir = join(OUT_ROOT, target.id);
  mkdirSync(outDir, { recursive: true });
  const templatePath = join(outDir, `${target.id}-template.png`);
  const overlayPath = join(outDir, `${target.id}-overlay.png`);
  const previewPath = join(outDir, `${target.id}-preview.webp`);

  const templateComposite = sharp(templateRgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .composite([{ input: templateSvg, top: 0, left: 0 }]);

  const templatePng = await templateComposite
    .clone()
    .flatten({ background: { r: 203, g: 213, b: 225 } })
    .png({ palette: true, compressionLevel: 9, effort: 10, colors: 64 })
    .toBuffer();
  writeFileSync(templatePath, templatePng);

  const previewWebp = await sharp(templatePng)
    .resize(640, 640, { kernel: "lanczos3" })
    .webp({ quality: 84 })
    .toBuffer();
  writeFileSync(previewPath, previewWebp);

  const overlayPng = await sharp(overlayRgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .composite([{ input: overlaySvg, top: 0, left: 0 }])
    .png({ palette: true, compressionLevel: 9, effort: 10, colors: 32 })
    .toBuffer();
  writeFileSync(overlayPath, overlayPng);

  // Report bounds, clamping counts, and file sizes
  const fmtKb = (p: string) => `${(statSync(p).size / 1024).toFixed(1)} KB (${statSync(p).size} B)`;
  console.log(`\n=== ${target.id} (${target.title}) ===`);
  console.log(
    `  paint tris: ${triangles.length}, verts: ${clamping.totalVerts}, bounds: x[${bounds.min[0].toFixed(3)}..${bounds.max[0].toFixed(3)}] y[${bounds.min[1].toFixed(3)}..${bounds.max[1].toFixed(3)}] z[${bounds.min[2].toFixed(3)}..${bounds.max[2].toFixed(3)}]`
  );
  console.log(`  axles: front z=${frontAxleZ.toFixed(4)} m, rear z=${rearAxleZ.toFixed(4)} m`);
  console.log(`  dominant-panel clamped verts: ${clamping.dominantClampedTotal}`);
  for (const pid of F1_PANEL_IDS) {
    const c = clamping.byPanel[pid];
    if (c.count > 0) {
      console.log(`    ${pid}: ${c.count} (u<0:${c.uLo}, u>1:${c.uHi}, v<0:${c.vLo}, v>1:${c.vHi})`);
    }
  }
  console.log(`  wrote ${templatePath} — ${fmtKb(templatePath)}`);
  console.log(`  wrote ${overlayPath} — ${fmtKb(overlayPath)}`);
  console.log(`  wrote ${previewPath} — ${fmtKb(previewPath)}`);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const selected = only.length ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;
  if (selected.length === 0) {
    console.error(`Unknown car target(s): ${only.join(", ")}. Available: ${TARGETS.map((t) => t.id).join(", ")}`);
    process.exit(1);
  }
  for (const target of selected) {
    await generateTemplateForCar(target);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
