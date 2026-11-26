/**
 * Generates 2048x2048 livery painting templates, transparent line overlays, and 640px doc previews
 * for atlas-projected cars (`lc26`, `lc25`, `amg-gt3`, `bmw-m4-gt3`, `lc-lmdh`) using the exact
 * shared projection math from `src/lib/render/livery-projection.ts`.
 *
 * Usage:
 *   npx tsx scripts/cars/build-livery-templates.ts
 *   npx tsx scripts/cars/build-livery-templates.ts lc26 lc25
 *   npx tsx scripts/cars/build-livery-templates.ts --models /path/to/public/cars amg-gt3 bmw-m4-gt3 lc-lmdh
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";
import * as THREE from "three";
import {
  F1_PANEL_IDS,
  F1_PROJECTION,
  PORTED_PANEL_IDS,
  PORTED_PROJECTION,
  f1ProjectToPanel,
  portedProjectToPanel,
  projectF1Point,
  projectPortedPoint,
  type AtlasPanelRect,
  type F1PanelId,
  type PortedPanelId,
  type PortedProjectionProfile,
} from "../../src/lib/render/livery-projection";
import {
  PROCEDURAL_BODY_PROFILES,
  PROCEDURAL_PROFILE_BY_MATERIAL,
} from "../../src/lib/render/ported-procedural-livery";

const ROOT = process.cwd();
const OUT_ROOT = join(ROOT, "docs/livery-templates");
const SIZE = F1_PROJECTION.atlasSize;
const F1_PAINT_MATERIALS = new Set(["EXT_PAINT_PRIMARY", "EXT_PAINT_SECONDARY", "EXT_PAINT_ACCENT"]);

type TemplateCarId = "lc26" | "lc25" | "amg-gt3" | "bmw-m4-gt3" | "lc-lmdh";
type AnyPanelId = F1PanelId | PortedPanelId;

interface BaseTarget {
  readonly id: TemplateCarId;
  readonly title: string;
  readonly glbRelPath: string;
}

interface F1TemplateTarget extends BaseTarget {
  readonly kind: "f1";
  readonly id: "lc26" | "lc25";
  /** Whether geometry outside the main F1 projection bounds (top/side/fwEndplate) is expected and hatched */
  readonly allowMainBoundsClamping: boolean;
}

interface PortedTemplateTarget extends BaseTarget {
  readonly kind: "ported";
  readonly id: "amg-gt3" | "bmw-m4-gt3" | "lc-lmdh";
  readonly profile: PortedProjectionProfile;
}

type CarTemplateTarget = F1TemplateTarget | PortedTemplateTarget;

const TARGETS: readonly CarTemplateTarget[] = [
  {
    kind: "f1",
    id: "lc26",
    title: "LC26 Prototype",
    glbRelPath: "f12026/model/f12026.glb",
    allowMainBoundsClamping: false,
  },
  {
    kind: "f1",
    id: "lc25",
    title: "LC25 Prototype",
    glbRelPath: "lc25/model/lc25.glb",
    allowMainBoundsClamping: true,
  },
  {
    kind: "ported",
    id: "amg-gt3",
    title: "Mercedes-AMG GT3 Evo",
    glbRelPath: "amg-gt3-evo/model/amg-gt3-evo.glb",
    profile: PROCEDURAL_BODY_PROFILES["amg-gt3"],
  },
  {
    kind: "ported",
    id: "bmw-m4-gt3",
    title: "BMW M4 GT3 Evo",
    glbRelPath: "bmw-m4-gt3/model/bmw-m4-gt3.glb",
    profile: PROCEDURAL_BODY_PROFILES["bmw-m4-gt3"],
  },
  {
    kind: "ported",
    id: "lc-lmdh",
    title: "LC-LMDH Hypercar",
    glbRelPath: "lc-lmdh/model/lc-lmdh.glb",
    profile: PROCEDURAL_BODY_PROFILES["lc-lmdh"],
  },
];

const F1_MAIN_BOUND_PANELS = new Set<F1PanelId>(["top", "left", "right", "fwEndplateLeft", "fwEndplateRight"]);

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

interface ClampingStats<P extends string> {
  totalVerts: number;
  dominantClampedTotal: number;
  byPanel: Record<P, { count: number; uLo: number; uHi: number; vLo: number; vHi: number }>;
}

function emptyClampingStats<P extends string>(panelIds: readonly P[]): ClampingStats<P> {
  const byPanel = {} as ClampingStats<P>["byPanel"];
  for (const p of panelIds) byPanel[p] = { count: 0, uLo: 0, uHi: 0, vLo: 0, vHi: 0 };
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

function isSplitterPoint(p: Vec3, profile: PortedProjectionProfile): boolean {
  return profile.splitterMaxY > 0 && p[1] < profile.splitterMaxY && p[2] > profile.splitterMinZ;
}

/** Loads all paint-zone triangles and axle positions from an F1 or ported car GLB */
async function loadPaintGeometry(
  target: CarTemplateTarget,
  glbPath: string
): Promise<{
  triangles: PaintTri[];
  frontAxleZ: number;
  rearAxleZ: number;
  clamping: ClampingStats<AnyPanelId>;
  bounds: { min: Vec3; max: Vec3 };
  splitterVerts: number;
}> {
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc = await io.read(glbPath);

  const panelIds: readonly AnyPanelId[] = target.kind === "f1" ? F1_PANEL_IDS : PORTED_PANEL_IDS;
  let frontAxleZ = 1.5045;
  let rearAxleZ = -1.8955;
  const triangles: PaintTri[] = [];
  const clamping = emptyClampingStats(panelIds);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let splitterVerts = 0;

  // For ported cars, ported-car-model.ts transforms every mesh under BODY by relativeMatrix(mesh, body)
  const bodyNode = target.kind === "ported"
    ? doc.getRoot().listNodes().find((n) => n.getName() === "BODY") ?? null
    : null;
  const bodyInv = new THREE.Matrix4();
  if (bodyNode) bodyInv.fromArray(bodyNode.getWorldMatrix()).invert();
  const tmpMat = new THREE.Matrix4();

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

    let frameMatrix: readonly number[];
    if (target.kind === "f1") {
      // Match lc26-car-model.ts `flapNodeFor`: walk up for `aeroClosed`, otherwise use world matrix (BODY is identity)
      let aeroMatrix: number[] | null = null;
      for (let cur = node as typeof node | null; cur; cur = cur.getParentNode()) {
        const ex = cur.getExtras() as { aeroClosed?: number[] } | undefined;
        if (Array.isArray(ex?.aeroClosed) && ex.aeroClosed.length === 16) {
          aeroMatrix = ex.aeroClosed;
          break;
        }
      }
      frameMatrix = aeroMatrix ?? node.getWorldMatrix();
    } else {
      // Match ported-car-model.ts: traverse BODY and compute relativeMatrix(mesh, body)
      if (bodyNode) {
        let underBody = false;
        for (let cur = node as typeof node | null; cur; cur = cur.getParentNode()) {
          if (cur === bodyNode) {
            underBody = true;
            break;
          }
        }
        if (!underBody) continue;
      }
      tmpMat.fromArray(node.getWorldMatrix());
      frameMatrix = bodyInv.clone().multiply(tmpMat).elements.slice();
    }

    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? "";
      if (target.kind === "f1") {
        if (!F1_PAINT_MATERIALS.has(matName)) continue;
      } else {
        const matProf = PROCEDURAL_PROFILE_BY_MATERIAL[matName];
        if (!matProf || matProf.car !== target.id) continue;
      }

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
        let dom: AnyPanelId;
        let sample: ReturnType<typeof f1ProjectToPanel>;
        let rect: AtlasPanelRect;
        if (target.kind === "f1") {
          const proj = projectF1Point(p, norms[i]);
          dom = proj.dominantPanel;
          sample = f1ProjectToPanel(dom, p[0], p[1], p[2]);
          rect = F1_PROJECTION.panels[dom];
        } else {
          if (isSplitterPoint(p, target.profile)) splitterVerts++;
          const proj = projectPortedPoint(p, norms[i], target.profile);
          dom = proj.dominantPanel;
          sample = portedProjectToPanel(dom, p[0], p[1], p[2], target.profile);
          rect = PORTED_PROJECTION.panels[dom];
        }

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

  return { triangles, frontAxleZ, rearAxleZ, clamping, bounds: { min, max }, splitterVerts };
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

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// SVG vector overlays (F1 7-panel & Ported 5-panel)
// ---------------------------------------------------------------------------

function pushSvgHelpers(parts: string[]): {
  pill: (x: number, y: number, text: string, fontSize?: number, align?: "start" | "end" | "middle") => void;
  arrow: (x1: number, y: number, x2: number, label: string) => void;
  bodyStamp: (x: number, y: number, text: string, fontSize?: number) => void;
  tag: (x: number, y: number, text: string) => void;
} {
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

  const bodyStamp = (x: number, y: number, text: string, fontSize = 36) => {
    parts.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="#0f172a" stroke="#ffffff" stroke-width="6" paint-order="stroke" class="stamp">${escXml(text)}</text>`
    );
  };

  const tag = (x: number, y: number, text: string) => {
    parts.push(
      `<text x="${x}" y="${y}" font-size="28" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="hdr">${escXml(text)}</text>`
    );
  };

  return { pill, arrow, bodyStamp, tag };
}

function buildF1VectorSvg(
  target: F1TemplateTarget,
  frontAxleZ: number,
  rearAxleZ: number,
  clamping: ClampingStats<AnyPanelId>,
  overlayOnly: boolean
): string {
  const p = F1_PROJECTION.panels;
  const pt = (panel: F1PanelId, x: number, y: number, z: number): [number, number] => {
    const s = f1ProjectToPanel(panel, x, y, z);
    return [s.px, s.py];
  };

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><style>`,
    `  .hdr { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 0.5px; }`,
    `  .stamp { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 1px; }`,
    `  .ref { font-family: Arial, Helvetica, sans-serif; font-weight: 700; }`,
    `</style></defs>`,
  ];
  const { pill, arrow, bodyStamp, tag } = pushSvgHelpers(parts);

  const dashColor = overlayOnly ? "#0f172a" : "#334155";
  const dashOpacity = overlayOnly ? "0.75" : "0.7";

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

  for (const pid of ["top", "left", "right"] as const) {
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

  if (!overlayOnly) {
    parts.push(
      `<text x="${p.top.x + 18}" y="${(topCentreY - 12).toFixed(1)}" font-size="22" fill="#0f172a" stroke="#ffffff" stroke-width="5" paint-order="stroke" class="ref">CENTRE LINE (X = 0)</text>`
    );
  }

  for (const pid of F1_PANEL_IDS) {
    const r = p[pid];
    parts.push(`<rect x="${r.x + 1}" y="${r.y + 1}" width="${r.w - 2}" height="${r.h - 2}" fill="none" stroke="#0f172a" stroke-width="3" />`);
  }

  if (overlayOnly) {
    tag(p.top.x + 14, p.top.y + 34, `${target.id.toUpperCase()} — TOP (FRONT →)`);
    tag(p.left.x + 14, p.left.y + 34, `LEFT SIDE (← FRONT)`);
    tag(p.right.x + 14, p.right.y + 34, `RIGHT SIDE (FRONT →)`);
    tag(p.rear.x + 14, p.rear.y + 34, `REAR`);
    tag(p.front.x + 14, p.front.y + 34, `FRONT`);
    tag(p.fwEndplateLeft.x + 12, p.fwEndplateLeft.y + 30, `FW ENDPLATE L (←)`);
    tag(p.fwEndplateRight.x + 12, p.fwEndplateRight.y + 30, `FW ENDPLATE R (→)`);
  } else {
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

    const [topSideLX, topSideLY] = pt("top", 0.48, 0.5, -0.3);
    const [topSideRX, topSideRY] = pt("top", -0.48, 0.5, -0.3);
    const [topNoseX, topNoseY] = pt("top", 0, 0.4, 1.45);
    bodyStamp(topSideLX, topSideLY, "TOP L  →", 32);
    bodyStamp(topSideRX, topSideRY, "TOP R  →", 32);
    bodyStamp(topNoseX, topNoseY, "TOP →", 32);

    const [leftPodX, leftPodY] = pt("left", 0.5, 0.44, -0.3);
    bodyStamp(leftPodX, leftPodY, "← FRONT · LEFT SIDE", 42);

    const [rightPodX, rightPodY] = pt("right", -0.5, 0.44, -0.3);
    bodyStamp(rightPodX, rightPodY, "RIGHT SIDE · FRONT →", 42);

    const [rearWingX, rearWingY] = pt("rear", 0, 0.81, -2.35);
    bodyStamp(rearWingX, rearWingY, "REAR WING", 48);

    const [frontNoseX, frontNoseY] = pt("front", 0, 0.3, 2.5);
    bodyStamp(frontNoseX, frontNoseY, "FRONT", 34);

    if (target.allowMainBoundsClamping && clamping.byPanel.top.count > 0) {
      pill(p.top.x + 16, p.top.y + p.top.h - 56, "HATCHED = CLAMPED EDGE (|X| > 0.95m)", 28, "start");
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

function buildPortedVectorSvg(
  target: PortedTemplateTarget,
  frontAxleZ: number,
  rearAxleZ: number,
  splitterVerts: number,
  overlayOnly: boolean
): string {
  const p = PORTED_PROJECTION.panels;
  const prof = target.profile;
  const pt = (panel: PortedPanelId, x: number, y: number, z: number): [number, number] => {
    const s = portedProjectToPanel(panel, x, y, z, prof);
    return [s.px, s.py];
  };

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><style>`,
    `  .hdr { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 0.5px; }`,
    `  .stamp { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 1px; }`,
    `  .ref { font-family: Arial, Helvetica, sans-serif; font-weight: 700; }`,
    `</style></defs>`,
  ];
  const { pill, arrow, bodyStamp, tag } = pushSvgHelpers(parts);

  const dashColor = overlayOnly ? "#0f172a" : "#334155";
  const dashOpacity = overlayOnly ? "0.75" : "0.7";

  const topCentreY = pt("top", 0, 0.6, 0)[1];
  const rearCentreX = pt("rear", 0, 0.7, prof.min[2])[0];
  const frontCentreX = pt("front", 0, 0.5, prof.max[2])[0];
  parts.push(
    `<line x1="${p.top.x + 2}" y1="${topCentreY.toFixed(1)}" x2="${p.top.x + p.top.w - 2}" y2="${topCentreY.toFixed(1)}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="14 10" />`
  );
  parts.push(
    `<line x1="${rearCentreX.toFixed(1)}" y1="${p.rear.y + 2}" x2="${rearCentreX.toFixed(1)}" y2="${p.rear.y + p.rear.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );
  parts.push(
    `<line x1="${frontCentreX.toFixed(1)}" y1="${p.front.y + 2}" x2="${frontCentreX.toFixed(1)}" y2="${p.front.y + p.front.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );

  for (const pid of ["top", "left", "right"] as const) {
    const r = p[pid];
    const fx = pt(pid, 0, 0.6, frontAxleZ)[0];
    const rx = pt(pid, 0, 0.6, rearAxleZ)[0];
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

  if (!overlayOnly) {
    const centreLabelX = target.id === "lc-lmdh" ? p.top.x + 18 : p.top.x + 265;
    parts.push(
      `<text x="${centreLabelX}" y="${(topCentreY - 12).toFixed(1)}" font-size="22" fill="#0f172a" stroke="#ffffff" stroke-width="5" paint-order="stroke" class="ref">CENTRE LINE (X = 0)</text>`
    );
  }

  for (const pid of PORTED_PANEL_IDS) {
    const r = p[pid];
    parts.push(`<rect x="${r.x + 1}" y="${r.y + 1}" width="${r.w - 2}" height="${r.h - 2}" fill="none" stroke="#0f172a" stroke-width="3" />`);
  }

  if (overlayOnly) {
    tag(p.top.x + 14, p.top.y + 34, `${target.id.toUpperCase()} — TOP (FRONT →)`);
    tag(p.left.x + 14, p.left.y + 34, `LEFT SIDE (← FRONT)`);
    tag(p.right.x + 14, p.right.y + 34, `RIGHT SIDE (FRONT →)`);
    tag(p.rear.x + 14, p.rear.y + 34, `REAR`);
    tag(p.front.x + 14, p.front.y + 34, `FRONT`);
  } else {
    pill(p.top.x + 16, p.top.y + 14, `${target.id.toUpperCase()} · TOP VIEW`, 32, "start");
    arrow(p.top.x + 1500, p.top.y + 52, p.top.x + 1780, "FRONT");

    pill(p.left.x + 16, p.left.y + 14, "LEFT SIDE (+X)", 30, "start");
    arrow(p.left.x + 580, p.left.y + 50, p.left.x + 330, "FRONT");

    pill(p.right.x + 16, p.right.y + 14, "RIGHT SIDE (-X)", 30, "start");
    arrow(p.right.x + p.right.w - 280, p.right.y + 50, p.right.x + p.right.w - 30, "FRONT");

    pill(p.rear.x + 16, p.rear.y + 12, "REAR (-Z)", 28, "start");
    pill(p.rear.x + p.rear.w - 16, p.rear.y + 12, "L ←  |  → R", 28, "end");

    pill(p.front.x + 16, p.front.y + 12, "FRONT (+Z)", 28, "start");
    pill(p.front.x + p.front.w - 16, p.front.y + 12, "R ←  |  → L", 28, "end");

    // In-body orientation stamps on clean bodywork zones (prove alignment & non-mirroring in 3D renders)
    if (target.id === "lc-lmdh") {
      const [noseX, noseY] = pt("top", 0, 0.55, 1.80);
      const [roofX, roofY] = pt("top", 0, 1.05, 0.10);
      const [sideLX, sideLY] = pt("top", 0.65, 0.72, -0.55);
      const [sideRX, sideRY] = pt("top", -0.65, 0.72, -0.55);
      bodyStamp(noseX, noseY, "NOSE · TOP →", 36);
      bodyStamp(roofX, roofY, "ROOF →", 34);
      bodyStamp(sideLX, sideLY, "TOP L →", 32);
      bodyStamp(sideRX, sideRY, "TOP R →", 32);

      const [leftFlankX, leftFlankY] = pt("left", 0.9, 0.54, -0.10);
      const [rightFlankX, rightFlankY] = pt("right", -0.9, 0.54, -0.10);
      bodyStamp(leftFlankX, leftFlankY, "← FRONT · LEFT SIDE", 44);
      bodyStamp(rightFlankX, rightFlankY, "RIGHT SIDE · FRONT →", 44);

      const [rearDeckX, rearDeckY] = pt("rear", 0, 0.72, -2.35);
      const [rearWingX, rearWingY] = pt("rear", 0, 1.02, -2.30);
      bodyStamp(rearDeckX, rearDeckY, "REAR", 38);
      bodyStamp(rearWingX, rearWingY, "REAR WING", 34);

      const [frontNoseX, frontNoseY] = pt("front", 0, 0.44, 2.65);
      bodyStamp(frontNoseX, frontNoseY, "FRONT", 42);
    } else {
      // GT3 coupes (`amg-gt3`, `bmw-m4-gt3`)
      const hoodZ = target.id === "amg-gt3" ? 1.45 : 1.50;
      const roofZ = target.id === "amg-gt3" ? -0.30 : -0.25;
      const [hoodX, hoodY] = pt("top", 0, 0.85, hoodZ);
      const [roofX, roofY] = pt("top", 0, 1.20, roofZ);
      const [rearWingTopX, rearWingTopY] = pt("top", 0, 1.15, prof.wingRearZ - 0.15);
      bodyStamp(hoodX, hoodY, "HOOD · TOP →", 40);
      bodyStamp(roofX, roofY, "ROOF · TOP →", 38);
      bodyStamp(rearWingTopX, rearWingTopY, "WING", 30);

      const doorY = target.id === "amg-gt3" ? 0.58 : 0.62;
      const [leftDoorX, leftDoorY] = pt("left", 0.95, doorY, 0.05);
      const [rightDoorX, rightDoorY] = pt("right", -0.95, doorY, 0.05);
      bodyStamp(leftDoorX, leftDoorY, "← FRONT · LEFT SIDE", 44);
      bodyStamp(rightDoorX, rightDoorY, "RIGHT SIDE · FRONT →", 44);

      const [rearBumperX, rearBumperY] = pt("rear", 0, 0.66, prof.min[2]);
      const [rearWingX, rearWingY] = pt("rear", 0, 1.12, prof.min[2]);
      bodyStamp(rearBumperX, rearBumperY, "REAR", 42);
      bodyStamp(rearWingX, rearWingY, "REAR WING", 34);

      const [frontBumperX, frontBumperY] = pt("front", 0, 0.48, prof.max[2]);
      bodyStamp(frontBumperX, frontBumperY, "FRONT", 44);
    }

    if (splitterVerts > 0) {
      pill(p.front.x + 16, p.front.y + p.front.h - 54, "HATCHED = CARBON SPLITTER (UNPAINTABLE)", 26, "start");
    }
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

async function generateTemplateForCar(target: CarTemplateTarget, modelsDir: string): Promise<void> {
  const glbPath = join(modelsDir, target.glbRelPath);
  if (!existsSync(glbPath)) {
    throw new Error(`${target.id}: GLB not found at ${glbPath} (pass --models <dir> if models live elsewhere)`);
  }

  const { triangles, frontAxleZ, rearAxleZ, clamping, bounds, splitterVerts } = await loadPaintGeometry(target, glbPath);
  const panelIds: readonly AnyPanelId[] = target.kind === "f1" ? F1_PANEL_IDS : PORTED_PANEL_IDS;
  const panelRectOf = (pid: AnyPanelId): AtlasPanelRect =>
    target.kind === "f1"
      ? F1_PROJECTION.panels[pid as F1PanelId]
      : PORTED_PROJECTION.panels[pid as PortedPanelId];

  // Fail loudly if a car that shouldn't clamp main bounds has any clamped vertices on top/side/fwEndplate
  if (target.kind === "f1" && !target.allowMainBoundsClamping) {
    const unexpected: string[] = [];
    for (const pid of F1_MAIN_BOUND_PANELS) {
      if (clamping.byPanel[pid].count > 0) unexpected.push(`${pid}=${clamping.byPanel[pid].count}`);
    }
    if (unexpected.length > 0) {
      throw new Error(`${target.id}: unexpected clamped vertices on main panels: ${unexpected.join(", ")}`);
    }
  }

  const fillMask = new Uint8Array(SIZE * SIZE);
  const hatchRaw = new Uint8Array(SIZE * SIZE); // clamped edge (lc25) or unpaintable carbon splitter (amg-gt3)
  const meshEdges = new Uint8Array(SIZE * SIZE);
  const featureEdges = new Uint8Array(SIZE * SIZE);

  interface EdgeRef {
    tri: PaintTri;
    a2d: [number, number];
    b2d: [number, number];
  }

  const panelEdges = new Map<AnyPanelId, Map<string, EdgeRef[]>>();
  for (const pid of panelIds) panelEdges.set(pid, new Map());

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

    const p0 = target.kind === "f1"
      ? projectF1Point(tri.v0, tri.n0)
      : projectPortedPoint(tri.v0, tri.n0, target.profile);
    const p1 = target.kind === "f1"
      ? projectF1Point(tri.v1, tri.n1)
      : projectPortedPoint(tri.v1, tri.n1, target.profile);
    const p2 = target.kind === "f1"
      ? projectF1Point(tri.v2, tri.n2)
      : projectPortedPoint(tri.v2, tri.n2, target.profile);
    const pc = target.kind === "f1"
      ? projectF1Point([cx, cy, cz], [cnx, cny, cnz])
      : projectPortedPoint([cx, cy, cz], [cnx, cny, cnz], target.profile);

    const k0 = quantKey(tri.v0);
    const k1 = quantKey(tri.v1);
    const k2 = quantKey(tri.v2);

    const wOf = (proj: typeof p0, pid: AnyPanelId): number =>
      (proj.panelWeights as Partial<Record<AnyPanelId, number>>)[pid] ?? 0;

    for (const pid of panelIds) {
      const wMax = Math.max(wOf(p0, pid), wOf(p1, pid), wOf(p2, pid), wOf(pc, pid));
      if (wMax < WEIGHT_MIN && pc.dominantPanel !== pid) continue;

      const s0 = target.kind === "f1"
        ? f1ProjectToPanel(pid as F1PanelId, tri.v0[0], tri.v0[1], tri.v0[2])
        : portedProjectToPanel(pid as PortedPanelId, tri.v0[0], tri.v0[1], tri.v0[2], target.profile);
      const s1 = target.kind === "f1"
        ? f1ProjectToPanel(pid as F1PanelId, tri.v1[0], tri.v1[1], tri.v1[2])
        : portedProjectToPanel(pid as PortedPanelId, tri.v1[0], tri.v1[1], tri.v1[2], target.profile);
      const s2 = target.kind === "f1"
        ? f1ProjectToPanel(pid as F1PanelId, tri.v2[0], tri.v2[1], tri.v2[2])
        : portedProjectToPanel(pid as PortedPanelId, tri.v2[0], tri.v2[1], tri.v2[2], target.profile);
      const rect = panelRectOf(pid);

      const fillVal = wMax >= WEIGHT_STRONG ? 2 : 1;
      rasterizeTriangle(fillMask, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, fillVal);

      // Hatch clamped edges on lc25
      if (target.kind === "f1" && target.allowMainBoundsClamping) {
        const isMain = F1_MAIN_BOUND_PANELS.has(pid as F1PanelId);
        const markClamped = (s: typeof s0) => {
          if (!s.clamped || (!isMain && !s.clampedU)) return;
          const ix = Math.max(rect.x, Math.min(rect.x + rect.w - 1, Math.round(s.px)));
          const iy = Math.max(rect.y, Math.min(rect.y + rect.h - 1, Math.round(s.py)));
          hatchRaw[iy * SIZE + ix] = 1;
        };
        markClamped(s0);
        markClamped(s1);
        markClamped(s2);
        if (
          (s0.clamped && (isMain || s0.clampedU)) ||
          (s1.clamped && (isMain || s1.clampedU)) ||
          (s2.clamped && (isMain || s2.clampedU))
        ) {
          rasterizeTriangle(hatchRaw, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, 1);
        }
      }

      // Hatch forced-carbon front splitter tray on AMG GT3 Evo
      if (target.kind === "ported" && target.profile.splitterMaxY > 0) {
        if (
          isSplitterPoint(tri.v0, target.profile) &&
          isSplitterPoint(tri.v1, target.profile) &&
          isSplitterPoint(tri.v2, target.profile)
        ) {
          rasterizeTriangle(hatchRaw, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, 1);
        }
      }

      const edges = panelEdges.get(pid)!;
      const addEdge = (ka: string, kb: string, a2d: [number, number], b2d: [number, number]) => {
        const key = edgeKey(ka, kb);
        let list = edges.get(key);
        if (!list) {
          list = [];
          edges.set(key, list);
        }
        list.push({ tri, a2d, b2d });
      };
      addEdge(k0, k1, [s0.px, s0.py], [s1.px, s1.py]);
      addEdge(k1, k2, [s1.px, s1.py], [s2.px, s2.py]);
      addEdge(k2, k0, [s2.px, s2.py], [s0.px, s0.py]);
    }
  }

  for (const pid of panelIds) {
    const rect = panelRectOf(pid);
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

  // Expand clamped edge markers inward on lc25; keep exact splitter footprint on amg-gt3
  const hatchBand = new Uint8Array(SIZE * SIZE);
  if (target.kind === "f1" && target.allowMainBoundsClamping) {
    for (const pid of panelIds) {
      const rect = panelRectOf(pid);
      const dilated = dilateMaskInPanel(hatchRaw, rect, 14);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const row = y * SIZE;
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          if (dilated[row + x]) hatchBand[row + x] = 1;
        }
      }
    }
  } else if (splitterVerts > 0) {
    hatchBand.set(hatchRaw);
  }

  const silhouette = new Uint8Array(SIZE * SIZE);
  for (const pid of panelIds) {
    const r = panelRectOf(pid);
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

  const templateRgba = Buffer.alloc(SIZE * SIZE * 4);
  const overlayRgba = Buffer.alloc(SIZE * SIZE * 4);

  for (let y = 0; y < SIZE; y++) {
    const row = y * SIZE;
    for (let x = 0; x < SIZE; x++) {
      const idx = row + x;
      const o = idx * 4;
      const fill = fillMask[idx];
      const hatched = hatchBand[idx];
      const feat = featureEdges[idx];
      const sil = silhouette[idx];
      const mesh = meshEdges[idx];

      let r = 203, g = 213, b = 225;
      if (fill === 1) {
        r = 226; g = 232; b = 240;
      } else if (fill === 2) {
        r = 244; g = 247; b = 251;
      }

      if (hatched) {
        const stripe = ((x + y) % 14) < 6;
        if (stripe) {
          r = 30; g = 41; b = 59;
        } else {
          r = 245; g = 208; b = 88;
        }
      }

      if (mesh && !hatched) {
        r = Math.round(r * 0.84 + 100 * 0.16);
        g = Math.round(g * 0.84 + 116 * 0.16);
        b = Math.round(b * 0.84 + 139 * 0.16);
      }
      if (feat === 1) {
        r = 51; g = 65; b = 85;
      } else if (feat === 2) {
        r = 15; g = 23; b = 42;
      }
      if (sil) {
        r = 15; g = 23; b = 42;
      }

      templateRgba[o] = r;
      templateRgba[o + 1] = g;
      templateRgba[o + 2] = b;
      templateRgba[o + 3] = 255;

      if (sil || feat === 2) {
        overlayRgba[o] = 15; overlayRgba[o + 1] = 23; overlayRgba[o + 2] = 42; overlayRgba[o + 3] = 230;
      } else if (feat === 1) {
        overlayRgba[o] = 30; overlayRgba[o + 1] = 41; overlayRgba[o + 2] = 59; overlayRgba[o + 3] = 150;
      } else if (hatched && ((x + y) % 14) < 5) {
        overlayRgba[o] = 15; overlayRgba[o + 1] = 23; overlayRgba[o + 2] = 42; overlayRgba[o + 3] = 180;
      } else if (mesh) {
        overlayRgba[o] = 71; overlayRgba[o + 1] = 85; overlayRgba[o + 2] = 105; overlayRgba[o + 3] = 55;
      }
    }
  }

  const templateSvg = Buffer.from(
    target.kind === "f1"
      ? buildF1VectorSvg(target, frontAxleZ, rearAxleZ, clamping, false)
      : buildPortedVectorSvg(target, frontAxleZ, rearAxleZ, splitterVerts, false)
  );
  const overlaySvg = Buffer.from(
    target.kind === "f1"
      ? buildF1VectorSvg(target, frontAxleZ, rearAxleZ, clamping, true)
      : buildPortedVectorSvg(target, frontAxleZ, rearAxleZ, splitterVerts, true)
  );

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

  const fmtKb = (p: string) => `${(statSync(p).size / 1024).toFixed(1)} KB (${statSync(p).size} B)`;
  console.log(`\n=== ${target.id} (${target.title}) ===`);
  console.log(
    `  paint tris: ${triangles.length}, verts: ${clamping.totalVerts}, bounds: x[${bounds.min[0].toFixed(3)}..${bounds.max[0].toFixed(3)}] y[${bounds.min[1].toFixed(3)}..${bounds.max[1].toFixed(3)}] z[${bounds.min[2].toFixed(3)}..${bounds.max[2].toFixed(3)}]`
  );
  console.log(`  axles: front z=${frontAxleZ.toFixed(4)} m, rear z=${rearAxleZ.toFixed(4)} m`);
  console.log(`  dominant-panel clamped verts: ${clamping.dominantClampedTotal}`);
  for (const pid of panelIds) {
    const c = clamping.byPanel[pid];
    if (c.count > 0) {
      console.log(`    ${pid}: ${c.count} (u<0:${c.uLo}, u>1:${c.uHi}, v<0:${c.vLo}, v>1:${c.vHi})`);
    }
  }
  if (splitterVerts > 0) console.log(`  forced-carbon front splitter verts: ${splitterVerts}`);
  console.log(`  wrote ${templatePath} — ${fmtKb(templatePath)}`);
  console.log(`  wrote ${overlayPath} — ${fmtKb(overlayPath)}`);
  console.log(`  wrote ${previewPath} — ${fmtKb(previewPath)}`);
}

function parseCliArgs(argv: readonly string[]): { modelsDir: string; only: string[] } {
  let modelsDir = join(ROOT, "public/cars");
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--models") {
      const next = argv[++i];
      if (!next) throw new Error("--models requires a directory path");
      modelsDir = resolve(next);
    } else if (a.startsWith("--models=")) {
      modelsDir = resolve(a.slice("--models=".length));
    } else if (!a.startsWith("-")) {
      only.push(a);
    }
  }
  return { modelsDir, only };
}

async function main(): Promise<void> {
  const { modelsDir, only } = parseCliArgs(process.argv.slice(2));
  const selected = only.length
    ? TARGETS.filter((t) => only.includes(t.id))
    : TARGETS.filter((t) => existsSync(join(modelsDir, t.glbRelPath)));

  if (only.length > 0 && selected.length !== only.length) {
    const known = new Set(TARGETS.map((t) => t.id));
    const unknown = only.filter((id) => !known.has(id as TemplateCarId));
    if (unknown.length > 0) {
      console.error(`Unknown car target(s): ${unknown.join(", ")}. Available: ${TARGETS.map((t) => t.id).join(", ")}`);
      process.exit(1);
    }
  }
  if (selected.length === 0) {
    console.error(`No car GLBs found under ${modelsDir}`);
    process.exit(1);
  }
  if (only.length === 0) {
    const skipped = TARGETS.filter((t) => !selected.includes(t));
    if (skipped.length > 0) {
      console.log(`Skipping cars without local GLB in ${modelsDir}: ${skipped.map((t) => t.id).join(", ")} (pass --models <dir> to include them)`);
    }
  }
  for (const target of selected) {
    await generateTemplateForCar(target, modelsDir);
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
