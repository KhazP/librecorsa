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
import sharp, { type OverlayOptions } from "sharp";
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
  isProceduralPaintMesh,
  PROCEDURAL_BODY_PROFILES,
  PROCEDURAL_PROFILE_BY_MATERIAL,
} from "../../src/lib/render/ported-procedural-livery";

const ROOT = process.cwd();
const OUT_ROOT = join(ROOT, "docs/livery-templates");
const SIZE = F1_PROJECTION.atlasSize;
const F1_PAINT_MATERIALS = new Set(["EXT_PAINT_PRIMARY", "EXT_PAINT_SECONDARY", "EXT_PAINT_ACCENT"]);
const LABEL_PAINT_MARGIN_PX = 8;
const CLAMP_EDGE_EPS = 1e-3;
const CLAMP_EDGE_STRIP_PX = 12;

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
  n0: Vec3;
  n1: Vec3;
  n2: Vec3;
  faceNrm: Vec3;
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

/**
 * For double-sided GLBs with mirrored right-half winding inversions (such as `lc-lmdh.glb`, where the
 * runtime shader flips `!gl_FrontFacing` fragments to match exterior viewing direction), orient any
 * right-half (`x < 0`) triangle whose normal is inverted relative to its mirrored left-half (`x > 0`) twin.
 * This ensures the offline template matches the exterior shading and removes asymmetric inverted-nose/tail
 * artefacts from the REAR and FRONT panels.
 */
function orientInvertedMirroredTriangles(triangles: PaintTri[]): number {
  const CELL = 0.025; // 2.5 cm spatial voxel grid for left-half twin lookup
  const cellKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;
  const leftBuckets = new Map<string, { c: Vec3; n: Vec3 }[]>();

  for (const tri of triangles) {
    const cx = (tri.v0[0] + tri.v1[0] + tri.v2[0]) / 3;
    if (cx <= 0.01) continue;
    const cy = (tri.v0[1] + tri.v1[1] + tri.v2[1]) / 3;
    const cz = (tri.v0[2] + tri.v1[2] + tri.v2[2]) / 3;
    const key = cellKey(Math.round(cx / CELL), Math.round(cy / CELL), Math.round(cz / CELL));
    let bucket = leftBuckets.get(key);
    if (!bucket) {
      bucket = [];
      leftBuckets.set(key, bucket);
    }
    bucket.push({ c: [cx, cy, cz], n: tri.faceNrm });
  }

  let flipped = 0;
  for (const tri of triangles) {
    const cx = (tri.v0[0] + tri.v1[0] + tri.v2[0]) / 3;
    if (cx >= -0.01) continue;
    const cy = (tri.v0[1] + tri.v1[1] + tri.v2[1]) / 3;
    const cz = (tri.v0[2] + tri.v1[2] + tri.v2[2]) / 3;
    const mx = -cx;
    const bx = Math.round(mx / CELL);
    const by = Math.round(cy / CELL);
    const bz = Math.round(cz / CELL);

    let bestDistSq = 0.04 * 0.04;
    let bestTwin: Vec3 | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = leftBuckets.get(cellKey(bx + dx, by + dy, bz + dz));
          if (!bucket) continue;
          for (const cand of bucket) {
            const ddx = cand.c[0] - mx;
            const ddy = cand.c[1] - cy;
            const ddz = cand.c[2] - cz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < bestDistSq) {
              bestDistSq = d2;
              bestTwin = cand.n;
            }
          }
        }
      }
    }
    if (!bestTwin) continue;
    const expected: Vec3 = [-bestTwin[0], bestTwin[1], bestTwin[2]];
    if (dot3(tri.faceNrm, expected) < -0.45) {
      tri.n0 = [-tri.n0[0], -tri.n0[1], -tri.n0[2]];
      tri.n1 = [-tri.n1[0], -tri.n1[1], -tri.n1[2]];
      tri.n2 = [-tri.n2[0], -tri.n2[1], -tri.n2[2]];
      tri.faceNrm = [-tri.faceNrm[0], -tri.faceNrm[1], -tri.faceNrm[2]];
      flipped++;
    }
  }
  return flipped;
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
  excludedNodes: number;
  flippedMirroredTris: number;
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
  let excludedNodes = 0;

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

    if (target.kind === "ported" && !isProceduralPaintMesh(target.id, node.getName())) {
      excludedNodes++;
      continue;
    }

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
          n0: nrmAcc ? [...norms[i0]] : [...faceNrm],
          n1: nrmAcc ? [...norms[i1]] : [...faceNrm],
          n2: nrmAcc ? [...norms[i2]] : [...faceNrm],
          faceNrm,
          material: matName,
        });
      }
    }
  }

  let flippedMirroredTris = 0;
  if (target.kind === "ported" && target.profile.flipBackfacing) {
    flippedMirroredTris = orientInvertedMirroredTriangles(triangles);
  }

  return {
    triangles,
    frontAxleZ,
    rearAxleZ,
    clamping,
    bounds: { min, max },
    splitterVerts,
    excludedNodes,
    flippedMirroredTris,
  };
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

function clipPolygonHalfPlane(
  poly: readonly (readonly [number, number])[],
  evalFn: (p: readonly [number, number]) => number
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = evalFn(a);
    const db = evalFn(b);
    if (da >= 0) out.push([a[0], a[1]]);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/**
 * Marks a narrow hatched strip (`stripPx` px wide) strictly inside the edges of `rect`
 * where a triangle in unclamped panel-local `(rawU, rawV)` space crosses outside `[0, 1] x [0, 1]`.
 * Never marks pixels in the interior of the panel.
 */
function markClampedTriangleEdges(
  outMask: Uint8Array,
  rect: AtlasPanelRect,
  raw0: readonly [number, number],
  raw1: readonly [number, number],
  raw2: readonly [number, number],
  stripPx = CLAMP_EDGE_STRIP_PX
): void {
  const minU = Math.min(raw0[0], raw1[0], raw2[0]);
  const maxU = Math.max(raw0[0], raw1[0], raw2[0]);
  const minV = Math.min(raw0[1], raw1[1], raw2[1]);
  const maxV = Math.max(raw0[1], raw1[1], raw2[1]);
  if (
    minU >= -CLAMP_EDGE_EPS &&
    maxU <= 1 + CLAMP_EDGE_EPS &&
    minV >= -CLAMP_EDGE_EPS &&
    maxV <= 1 + CLAMP_EDGE_EPS
  ) {
    return;
  }

  const tri: readonly (readonly [number, number])[] = [raw0, raw1, raw2];
  const pad = F1_PROJECTION.padPx;
  const uToX = (u: number) => rect.x + pad + Math.max(0, Math.min(1, u)) * Math.max(rect.w - pad * 2, 1);
  const vToY = (v: number) => rect.y + pad + Math.max(0, Math.min(1, v)) * Math.max(rect.h - pad * 2, 1);

  const fillStrip = (x0: number, y0: number, x1: number, y1: number) => {
    const rx0 = Math.max(rect.x, Math.floor(x0));
    const rx1 = Math.min(rect.x + rect.w - 1, Math.ceil(x1));
    const ry0 = Math.max(rect.y, Math.floor(y0));
    const ry1 = Math.min(rect.y + rect.h - 1, Math.ceil(y1));
    for (let y = ry0; y <= ry1; y++) {
      const row = y * SIZE;
      for (let x = rx0; x <= rx1; x++) outMask[row + x] = 1;
    }
  };

  if (minU < -CLAMP_EDGE_EPS) {
    const clipped = clipPolygonHalfPlane(tri, (p) => -p[0]);
    if (clipped.length > 0) {
      let vLo = 1;
      let vHi = 0;
      for (const p of clipped) {
        const cv = Math.max(0, Math.min(1, p[1]));
        if (cv < vLo) vLo = cv;
        if (cv > vHi) vHi = cv;
      }
      fillStrip(rect.x, vToY(vLo), rect.x + stripPx - 1, vToY(vHi));
    }
  }
  if (maxU > 1 + CLAMP_EDGE_EPS) {
    const clipped = clipPolygonHalfPlane(tri, (p) => p[0] - 1);
    if (clipped.length > 0) {
      let vLo = 1;
      let vHi = 0;
      for (const p of clipped) {
        const cv = Math.max(0, Math.min(1, p[1]));
        if (cv < vLo) vLo = cv;
        if (cv > vHi) vHi = cv;
      }
      fillStrip(rect.x + rect.w - stripPx, vToY(vLo), rect.x + rect.w - 1, vToY(vHi));
    }
  }
  if (minV < -CLAMP_EDGE_EPS) {
    const clipped = clipPolygonHalfPlane(tri, (p) => -p[1]);
    if (clipped.length > 0) {
      let uLo = 1;
      let uHi = 0;
      for (const p of clipped) {
        const cu = Math.max(0, Math.min(1, p[0]));
        if (cu < uLo) uLo = cu;
        if (cu > uHi) uHi = cu;
      }
      fillStrip(uToX(uLo), rect.y, uToX(uHi), rect.y + stripPx - 1);
    }
  }
  if (maxV > 1 + CLAMP_EDGE_EPS) {
    const clipped = clipPolygonHalfPlane(tri, (p) => p[1] - 1);
    if (clipped.length > 0) {
      let uLo = 1;
      let uHi = 0;
      for (const p of clipped) {
        const cu = Math.max(0, Math.min(1, p[0]));
        if (cu < uLo) uLo = cu;
        if (cu > uHi) uHi = cu;
      }
      fillStrip(uToX(uLo), rect.y + rect.h - stripPx, uToX(uHi), rect.y + rect.h - 1);
    }
  }
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
// Collision-free label placement using the rasterised paint-coverage mask
// ---------------------------------------------------------------------------

/** Conservative pixel width estimate for bold sans-serif SVG text (with letter-spacing) */
function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    if (ch === " " || ch === "·" || ch === "|" || ch === "I" || ch === "i" || ch === "l" || ch === "!" || ch === ".") {
      units += 0.36;
    } else if (ch === "W" || ch === "M" || ch === "←" || ch === "→") {
      units += 0.96;
    } else if (ch === "(" || ch === ")" || ch === ":" || ch === "-") {
      units += 0.44;
    } else {
      units += 0.72;
    }
  }
  return Math.ceil(units * fontSize + text.length * 0.8);
}

interface RectBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface PanelMaskIndex {
  readonly rect: AtlasPanelRect;
  /** 2D prefix sum of paint-blocked pixels (fillMask dilated by LABEL_PAINT_MARGIN_PX) inside `rect` */
  readonly marginSum: Int32Array;
  /** 2D prefix sum of raw fillMask pixels (zero margin) inside `rect` */
  readonly paintSum: Int32Array;
  /** Placed label boxes (in full atlas coordinates) to keep labels from overlapping each other */
  readonly placed: RectBox[];
}

function buildPrefixSum(mask: Uint8Array, rect: AtlasPanelRect): Int32Array {
  const stride = rect.w + 1;
  const sum = new Int32Array((rect.h + 1) * stride);
  for (let ly = 0; ly < rect.h; ly++) {
    const srcRow = (rect.y + ly) * SIZE + rect.x;
    const row = (ly + 1) * stride;
    const prev = ly * stride;
    let run = 0;
    for (let lx = 0; lx < rect.w; lx++) {
      if (mask[srcRow + lx]) run++;
      sum[row + lx + 1] = sum[prev + lx + 1] + run;
    }
  }
  return sum;
}

function queryPrefixSum(sum: Int32Array, rect: AtlasPanelRect, x: number, y: number, w: number, h: number): number {
  const lx0 = Math.max(0, Math.floor(x - rect.x));
  const ly0 = Math.max(0, Math.floor(y - rect.y));
  const lx1 = Math.min(rect.w, Math.ceil(x + w - rect.x));
  const ly1 = Math.min(rect.h, Math.ceil(y + h - rect.y));
  if (lx1 <= lx0 || ly1 <= ly0) return 0;
  const stride = rect.w + 1;
  return sum[ly1 * stride + lx1] - sum[ly0 * stride + lx1] - sum[ly1 * stride + lx0] + sum[ly0 * stride + lx0];
}

function boxesOverlap(a: RectBox, b: RectBox, pad = 6): boolean {
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

class PanelLabelPlacer {
  private readonly panels = new Map<AnyPanelId, PanelMaskIndex>();

  constructor(fillMask: Uint8Array, panelRects: ReadonlyArray<readonly [AnyPanelId, AtlasPanelRect]>) {
    for (const [pid, rect] of panelRects) {
      const dilated = dilateMaskInPanel(fillMask, rect, LABEL_PAINT_MARGIN_PX);
      this.panels.set(pid, {
        rect,
        marginSum: buildPrefixSum(dilated, rect),
        paintSum: buildPrefixSum(fillMask, rect),
        placed: [],
      });
    }
  }

  /**
   * Finds a non-overlapping box of size `(w, h)` inside `pid`, preferring positions closest to `targets`
   * (tried in priority order). Enforces `LABEL_PAINT_MARGIN_PX` clearance from painted pixels when `strictMargin`
   * is true, or zero overlap with `fillMask` when `strictMargin` is false.
   */
  findBox(
    pid: AnyPanelId,
    w: number,
    h: number,
    targets: readonly [number, number][],
    opts?: { strictMargin?: boolean; xRange?: readonly [number, number]; yRange?: readonly [number, number]; borderPad?: number }
  ): RectBox | null {
    const idx = this.panels.get(pid);
    if (!idx) return null;
    const r = idx.rect;
    const border = opts?.borderPad ?? 6;
    const minX = Math.max(r.x + border, opts?.xRange ? Math.ceil(opts.xRange[0]) : r.x + border);
    const maxX = Math.min(r.x + r.w - border - w, opts?.xRange ? Math.floor(opts.xRange[1] - w) : r.x + r.w - border - w);
    const minY = Math.max(r.y + border, opts?.yRange ? Math.ceil(opts.yRange[0]) : r.y + border);
    const maxY = Math.min(r.y + r.h - border - h, opts?.yRange ? Math.floor(opts.yRange[1] - h) : r.y + r.h - border - h);
    if (minX > maxX || minY > maxY) return null;

    const sum = opts?.strictMargin === false ? idx.paintSum : idx.marginSum;
    const fits = (x: number, y: number): boolean => {
      if (queryPrefixSum(sum, r, x, y, w, h) > 0) return false;
      const cand: RectBox = { x, y, w, h };
      for (const prev of idx.placed) {
        if (boxesOverlap(cand, prev, 6)) return false;
      }
      return true;
    };

    // Fast path: try clamped target points directly in priority order
    for (const [tx, ty] of targets) {
      const cx = Math.max(minX, Math.min(maxX, Math.round(tx)));
      const cy = Math.max(minY, Math.min(maxY, Math.round(ty)));
      if (fits(cx, cy)) return { x: cx, y: cy, w, h };
    }

    // Full-panel grid search picking the free box closest to the first preferred target
    const [prefX, prefY] = targets[0] ?? [minX, minY];
    let best: RectBox | null = null;
    let bestDistSq = Infinity;
    const step = 4;
    for (let y = minY; y <= maxY; y += step) {
      for (let x = minX; x <= maxX; x += step) {
        const dx = x - prefX;
        const dy = y - prefY;
        const d2 = dx * dx + dy * dy;
        if (d2 >= bestDistSq) continue;
        if (fits(x, y)) {
          bestDistSq = d2;
          best = { x, y, w, h };
        }
      }
    }
    return best;
  }

  reserve(pid: AnyPanelId, box: RectBox): void {
    this.panels.get(pid)?.placed.push(box);
  }
}

// ---------------------------------------------------------------------------
// SVG vector builders (chrome, in-body stamps, collision-free panel labels)
// ---------------------------------------------------------------------------

function svgHeader(): string[] {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><style>`,
    `  .hdr { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 0.4px; }`,
    `  .stamp { font-family: Arial, Helvetica, sans-serif; font-weight: 700; letter-spacing: 1px; }`,
    `  .ref { font-family: Arial, Helvetica, sans-serif; font-weight: 700; }`,
    `</style></defs>`,
  ];
}

function createLabelEmitter(labelParts: string[], placer: PanelLabelPlacer, panelRectOf: (pid: AnyPanelId) => AtlasPanelRect) {
  /**
   * Places a dark rounded pill (or multi-line stacked pill) in unpainted space with >= 8 px margin from painted
   * pixels. Shrinks font size and tries compact fallback lines if needed; falls back to outlined text without
   * background only if no strict-margin pill fits anywhere in the panel.
   */
  const placePill = (
    pid: AnyPanelId,
    linesOrVariants: readonly (string | readonly string[])[],
    preferredCorners: readonly ("tl" | "tr" | "bl" | "br" | "tc" | "bc")[],
    startFontSize = 28,
    minFontSize = 15
  ): boolean => {
    const r = panelRectOf(pid);
    const toTargets = (w: number, h: number): [number, number][] =>
      preferredCorners.map((c) => {
        switch (c) {
          case "tl": return [r.x + 12, r.y + 10];
          case "tr": return [r.x + r.w - w - 12, r.y + 10];
          case "bl": return [r.x + 12, r.y + r.h - h - 10];
          case "br": return [r.x + r.w - w - 12, r.y + r.h - h - 10];
          case "tc": return [r.x + Math.round((r.w - w) / 2), r.y + 10];
          case "bc": return [r.x + Math.round((r.w - w) / 2), r.y + r.h - h - 10];
        }
      });

    const variants: (readonly string[])[] = linesOrVariants.map((v) => (typeof v === "string" ? [v] : v));

    // Try with strict 8px margin across variants & descending font sizes
    for (const strictMargin of [true, false]) {
      for (const lines of variants) {
        for (let fs = startFontSize; fs >= minFontSize; fs -= 2) {
          const padX = Math.max(10, Math.round(fs * 0.45));
          const padY = Math.max(5, Math.round(fs * 0.24));
          const lineH = Math.round(fs * 1.18);
          const textW = Math.max(...lines.map((l) => estimateTextWidth(l, fs)));
          const w = textW + padX * 2 + 4;
          const h = lines.length * lineH + padY * 2 + 2;
          const box = placer.findBox(pid, w, h, toTargets(w, h), { strictMargin });
          if (!box) continue;
          placer.reserve(pid, box);
          const cx = box.x + box.w / 2;
          if (strictMargin) {
            labelParts.push(
              `<rect x="${box.x + 1}" y="${box.y + 1}" width="${box.w - 2}" height="${box.h - 2}" rx="6" fill="#0f172a" stroke="#ffffff" stroke-width="2" />`
            );
            for (let i = 0; i < lines.length; i++) {
              const ty = box.y + padY + i * lineH + Math.round(fs * 0.88);
              labelParts.push(
                `<text x="${cx.toFixed(1)}" y="${ty}" text-anchor="middle" font-size="${fs}" fill="#ffffff" class="hdr">${escXml(lines[i])}</text>`
              );
            }
          } else {
            // Tight-space fallback: outlined text with no filled background
            for (let i = 0; i < lines.length; i++) {
              const ty = box.y + padY + i * lineH + Math.round(fs * 0.88);
              labelParts.push(
                `<text x="${cx.toFixed(1)}" y="${ty}" text-anchor="middle" font-size="${fs}" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="hdr">${escXml(lines[i])}</text>`
              );
            }
          }
          return true;
        }
      }
    }
    return false;
  };

  /** Places a directional FRONT arrow + label in unpainted space with >= 8 px margin */
  const placeArrow = (
    pid: AnyPanelId,
    dir: 1 | -1,
    label: string,
    preferred: readonly [number, number][]
  ): boolean => {
    const widths = [230, 180, 140];
    for (const w of widths) {
      const fs = w >= 180 ? 24 : 20;
      const h = fs + 28;
      const box = placer.findBox(pid, w, h, preferred, { strictMargin: true });
      if (!box) continue;
      placer.reserve(pid, box);
      const y = box.y + h - 13;
      const x1 = dir > 0 ? box.x + 10 : box.x + box.w - 10;
      const x2 = dir > 0 ? box.x + box.w - 10 : box.x + 10;
      const head = 15;
      const lineEnd = x2 - dir * 10;
      const midX = (x1 + x2) / 2;
      labelParts.push(
        `<line x1="${x1}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="#ffffff" stroke-width="8" stroke-linecap="round" />`
      );
      labelParts.push(
        `<polygon points="${x2},${y} ${x2 - dir * head},${y - 9} ${x2 - dir * head},${y + 9}" fill="#ffffff" stroke="#ffffff" stroke-width="4" stroke-linejoin="round" />`
      );
      labelParts.push(
        `<line x1="${x1}" y1="${y}" x2="${lineEnd}" y2="${y}" stroke="#0f172a" stroke-width="4.5" stroke-linecap="round" />`
      );
      labelParts.push(
        `<polygon points="${x2},${y} ${x2 - dir * head},${y - 8} ${x2 - dir * head},${y + 8}" fill="#0f172a" />`
      );
      labelParts.push(
        `<text x="${midX.toFixed(1)}" y="${y - 12}" text-anchor="middle" font-size="${fs}" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="hdr">${escXml(label)}</text>`
      );
      return true;
    }
    return false;
  };

  /** Places an outlined reference label (axle, centre line, or overlay tag) strictly off painted pixels */
  const placeRefText = (
    pid: AnyPanelId,
    text: string,
    targets: readonly [number, number][],
    opts?: { startFontSize?: number; minFontSize?: number; xRange?: readonly [number, number]; yRange?: readonly [number, number]; cls?: "ref" | "hdr" }
  ): boolean => {
    const startFs = opts?.startFontSize ?? 20;
    const minFs = opts?.minFontSize ?? 14;
    const cls = opts?.cls ?? "ref";
    for (const strictMargin of [true, false]) {
      for (let fs = startFs; fs >= minFs; fs -= 2) {
        const w = estimateTextWidth(text, fs) + 12;
        const h = Math.round(fs * 1.25) + 8;
        const box = placer.findBox(pid, w, h, targets, {
          strictMargin,
          xRange: opts?.xRange,
          yRange: opts?.yRange,
        });
        if (!box) continue;
        placer.reserve(pid, box);
        const cx = box.x + box.w / 2;
        const ty = box.y + Math.round(fs * 0.96) + 3;
        labelParts.push(
          `<text x="${cx.toFixed(1)}" y="${ty}" text-anchor="middle" font-size="${fs}" fill="#0f172a" stroke="#ffffff" stroke-width="4" paint-order="stroke" class="${cls}">${escXml(text)}</text>`
        );
        return true;
      }
    }
    return false;
  };

  /** Places an axle label beside its vertical dashed line `axleX`, searching along the line first */
  const placeAxleLabel = (pid: AnyPanelId, text: string, axleX: number, preferSide: "left" | "right"): void => {
    const r = panelRectOf(pid);
    const estW = estimateTextWidth(text, 20) + 12;
    const xLeft = axleX - estW - 8;
    const xRight = axleX + 8;
    const primaryX = preferSide === "left" ? xLeft : xRight;
    const altX = preferSide === "left" ? xRight : xLeft;
    const yBottom = r.y + r.h - 36;
    const yTop = r.y + 10;
    const yMid = r.y + Math.round(r.h / 2) - 14;

    // First try within a vertical band beside the axle line so the label stays visibly attached to its line
    const bandMinX = Math.max(r.x + 6, axleX - estW - 24);
    const bandMaxX = Math.min(r.x + r.w - 6, axleX + estW + 24);
    const placedNearLine = placeRefText(
      pid,
      text,
      [
        [primaryX, yBottom],
        [altX, yBottom],
        [primaryX, yTop],
        [altX, yTop],
        [primaryX, yMid],
        [altX, yMid],
      ],
      { startFontSize: 20, minFontSize: 14, xRange: [bandMinX, bandMaxX] }
    );
    if (!placedNearLine) {
      // Fallback: search wider band (still staying near axleX)
      placeRefText(pid, text, [[primaryX, yBottom], [primaryX, yTop]], { startFontSize: 18, minFontSize: 14 });
    }
  };

  return { placePill, placeArrow, placeRefText, placeAxleLabel };
}

function pushBodyStamp(
  parts: string[],
  x: number,
  y: number,
  text: string,
  fontSize = 36,
  reserve?: { placer: PanelLabelPlacer; pid: AnyPanelId }
): void {
  parts.push(
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" fill="#0f172a" stroke="#ffffff" stroke-width="6" paint-order="stroke" class="stamp">${escXml(text)}</text>`
  );
  if (reserve) {
    const w = estimateTextWidth(text, fontSize) + 16;
    const h = Math.round(fontSize * 1.25) + 12;
    reserve.placer.reserve(reserve.pid, { x: Math.round(x - w / 2), y: Math.round(y - h / 2), w, h });
  }
}

interface VectorLayers {
  readonly chromeSvg: string;
  readonly stampsSvg: string | null;
  readonly labelsSvg: string;
}

function buildF1VectorLayers(
  target: F1TemplateTarget,
  frontAxleZ: number,
  rearAxleZ: number,
  clamping: ClampingStats<AnyPanelId>,
  fillMask: Uint8Array,
  overlayOnly: boolean,
  hasClampedEdges = clamping.dominantClampedTotal > 0
): VectorLayers {
  const p = F1_PROJECTION.panels;
  const pt = (panel: F1PanelId, x: number, y: number, z: number): [number, number] => {
    const s = f1ProjectToPanel(panel, x, y, z);
    return [s.px, s.py];
  };

  const chromeParts = svgHeader();
  const stampParts = overlayOnly ? null : svgHeader();
  const labelParts = svgHeader();

  const placer = new PanelLabelPlacer(
    fillMask,
    F1_PANEL_IDS.map((pid) => [pid, p[pid]] as const)
  );
  const { placePill, placeArrow, placeRefText, placeAxleLabel } = createLabelEmitter(
    labelParts,
    placer,
    (pid) => p[pid as F1PanelId]
  );

  const dashColor = overlayOnly ? "#0f172a" : "#334155";
  const dashOpacity = overlayOnly ? "0.75" : "0.7";

  const topCentreY = pt("top", 0, 0, 0)[1];
  const rearCentreX = pt("rear", 0, 0.7, -2.3)[0];
  const frontCentreX = pt("front", 0, 0.3, 2.3)[0];
  chromeParts.push(
    `<line x1="${p.top.x + 2}" y1="${topCentreY.toFixed(1)}" x2="${p.top.x + p.top.w - 2}" y2="${topCentreY.toFixed(1)}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="14 10" />`
  );
  chromeParts.push(
    `<line x1="${rearCentreX.toFixed(1)}" y1="${p.rear.y + 2}" x2="${rearCentreX.toFixed(1)}" y2="${p.rear.y + p.rear.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );
  chromeParts.push(
    `<line x1="${frontCentreX.toFixed(1)}" y1="${p.front.y + 2}" x2="${frontCentreX.toFixed(1)}" y2="${p.front.y + p.front.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );

  const axleCoords = new Map<"top" | "left" | "right", { fx: number; rx: number }>();
  for (const pid of ["top", "left", "right"] as const) {
    const r = p[pid];
    const fx = pt(pid, 0, 0.5, frontAxleZ)[0];
    const rx = pt(pid, 0, 0.5, rearAxleZ)[0];
    axleCoords.set(pid, { fx, rx });
    chromeParts.push(
      `<line x1="${fx.toFixed(1)}" y1="${r.y + 2}" x2="${fx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
    chromeParts.push(
      `<line x1="${rx.toFixed(1)}" y1="${r.y + 2}" x2="${rx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
  }

  for (const pid of F1_PANEL_IDS) {
    const r = p[pid];
    chromeParts.push(`<rect x="${r.x + 1}" y="${r.y + 1}" width="${r.w - 2}" height="${r.h - 2}" fill="none" stroke="#0f172a" stroke-width="3" />`);
  }

  if (overlayOnly) {
    placeRefText("top", `${target.id.toUpperCase()} — TOP (FRONT →)`, [[p.top.x + 12, p.top.y + 10]], { startFontSize: 24, cls: "hdr" });
    placeRefText("left", "LEFT SIDE (← FRONT)", [[p.left.x + 12, p.left.y + 10]], { startFontSize: 24, cls: "hdr" });
    placeRefText("right", "RIGHT SIDE (FRONT →)", [[p.right.x + p.right.w - 300, p.right.y + 10], [p.right.x + 12, p.right.y + 10]], { startFontSize: 24, cls: "hdr" });
    placeRefText("rear", "REAR", [[p.rear.x + 12, p.rear.y + 10]], { startFontSize: 22, cls: "hdr" });
    placeRefText("front", "FRONT", [[p.front.x + 12, p.front.y + 10]], { startFontSize: 22, cls: "hdr" });
    placeRefText("fwEndplateLeft", "FW ENDPLATE L (←)", [[p.fwEndplateLeft.x + 10, p.fwEndplateLeft.y + 10]], { startFontSize: 18, minFontSize: 14, cls: "hdr" });
    placeRefText("fwEndplateRight", "FW ENDPLATE R (→)", [[p.fwEndplateRight.x + p.fwEndplateRight.w - 210, p.fwEndplateRight.y + 10]], { startFontSize: 18, minFontSize: 14, cls: "hdr" });
  } else {
    // 0. Emit & reserve in-body orientation stamps first so pills never touch stamp text either
    const [topSideLX, topSideLY] = pt("top", 0.48, 0.5, -0.3);
    const [topSideRX, topSideRY] = pt("top", -0.48, 0.5, -0.3);
    const [topNoseX, topNoseY] = pt("top", 0, 0.4, 1.45);
    pushBodyStamp(stampParts!, topSideLX, topSideLY, "TOP L  →", 32, { placer, pid: "top" });
    pushBodyStamp(stampParts!, topSideRX, topSideRY, "TOP R  →", 32, { placer, pid: "top" });
    pushBodyStamp(stampParts!, topNoseX, topNoseY, "TOP →", 32, { placer, pid: "top" });

    const [leftPodX, leftPodY] = pt("left", 0.5, 0.44, -0.3);
    pushBodyStamp(stampParts!, leftPodX, leftPodY, "← FRONT · LEFT SIDE", 42, { placer, pid: "left" });

    const [rightPodX, rightPodY] = pt("right", -0.5, 0.44, -0.3);
    pushBodyStamp(stampParts!, rightPodX, rightPodY, "RIGHT SIDE · FRONT →", 42, { placer, pid: "right" });

    const [rearWingX, rearWingY] = pt("rear", 0, 0.81, -2.35);
    pushBodyStamp(stampParts!, rearWingX, rearWingY, "REAR WING", 48, { placer, pid: "rear" });

    const [frontNoseX, frontNoseY] = pt("front", 0, 0.3, 2.5);
    pushBodyStamp(stampParts!, frontNoseX, frontNoseY, "FRONT", 34, { placer, pid: "front" });

    // 1. Place primary panel pills and legends in unpainted space so reference labels yield cleanly to them
    placePill("top", [`${target.id.toUpperCase()} · TOP VIEW`], ["tl", "bl", "tr", "br"], 30, 18);
    placeArrow("top", 1, "FRONT", [[p.top.x + 1260, p.top.y + 12], [p.top.x + 1260, p.top.y + p.top.h - 68]]);

    if (hasClampedEdges) {
      placePill(
        "top",
        [
          "HATCHED EDGE: THE COLOUR HERE STRETCHES ONTO PARTS BEYOND IT",
          ["HATCHED EDGE: THE COLOUR HERE", "STRETCHES ONTO PARTS BEYOND IT"],
        ],
        ["bl", "tl", "bc"],
        22,
        15
      );
    }

    placePill("left", ["LEFT SIDE"], ["tl", "bl", "tr"], 28, 18);
    placeArrow("left", -1, "FRONT", [[p.left.x + 280, p.left.y + 10], [p.left.x + 100, p.left.y + 10]]);

    placePill("right", ["RIGHT SIDE"], ["tr", "tl", "br"], 28, 18);
    placeArrow("right", 1, "FRONT", [[p.right.x + p.right.w - 490, p.right.y + 10], [p.right.x + p.right.w - 280, p.right.y + 10]]);

    placePill("rear", ["REAR (SEEN FROM BEHIND)", "REAR"], ["bl", "tl", "br", "tr"], 24, 16);
    placePill("rear", ["L ←  |  → R", "L ← | → R"], ["br", "tr", "bl", "tl"], 24, 16);

    placePill("front", ["FRONT (SEEN FROM THE FRONT)", ["FRONT", "(SEEN FROM FRONT)"], "FRONT"], ["tl", "tr", "bl", "br"], 22, 14);
    placePill("front", ["R ← | → L"], ["tr", "tl", "br", "bl"], 20, 14);

    // Front wing endplates: left panel is empty on the left half; right panel is empty on the right half
    placePill("fwEndplateLeft", [["FW ENDPLATE L", "← FRONT"], "FW ENDPLATE L ←"], ["tl", "bl"], 20, 14);
    placePill("fwEndplateRight", [["FW ENDPLATE R", "FRONT →"], "FW ENDPLATE R →"], ["tr", "br"], 20, 14);

    // 2. Place axle labels and centre-line label cleanly off painted pixels
    for (const pid of ["top", "left", "right"] as const) {
      const { fx, rx } = axleCoords.get(pid)!;
      placeAxleLabel(pid, "FRONT AXLE", fx, pid === "left" ? "right" : "left");
      placeAxleLabel(pid, "REAR AXLE", rx, pid === "left" ? "left" : "right");
    }

    // Centre line label placed beside topCentreY where nothing is painted (cockpit opening, wing gap, or nose tip gap)
    const placedCentre = placeRefText(
      "top",
      "CENTRE LINE",
      [
        [p.top.x + 920, topCentreY - 14],
        [p.top.x + 190, topCentreY - 34],
        [p.top.x + 190, topCentreY + 12],
        [p.top.x + 1900, topCentreY - 34],
      ],
      { startFontSize: 20, minFontSize: 14, yRange: [topCentreY - 80, topCentreY + 80] }
    );
    if (!placedCentre) {
      placeRefText("top", "CENTRE LINE", [[p.top.x + 190, topCentreY - 100], [p.top.x + 190, topCentreY + 80]], {
        startFontSize: 18,
        minFontSize: 14,
      });
    }
  }

  chromeParts.push(`</svg>`);
  stampParts?.push(`</svg>`);
  labelParts.push(`</svg>`);
  return {
    chromeSvg: chromeParts.join("\n"),
    stampsSvg: stampParts ? stampParts.join("\n") : null,
    labelsSvg: labelParts.join("\n"),
  };
}

function buildPortedVectorLayers(
  target: PortedTemplateTarget,
  frontAxleZ: number,
  rearAxleZ: number,
  hasCarbonHatch: boolean,
  fillMask: Uint8Array,
  overlayOnly: boolean
): VectorLayers {
  const p = PORTED_PROJECTION.panels;
  const prof = target.profile;
  const pt = (panel: PortedPanelId, x: number, y: number, z: number): [number, number] => {
    const s = portedProjectToPanel(panel, x, y, z, prof);
    return [s.px, s.py];
  };

  const chromeParts = svgHeader();
  const stampParts = overlayOnly ? null : svgHeader();
  const labelParts = svgHeader();

  const placer = new PanelLabelPlacer(
    fillMask,
    PORTED_PANEL_IDS.map((pid) => [pid, p[pid]] as const)
  );
  const { placePill, placeArrow, placeRefText, placeAxleLabel } = createLabelEmitter(
    labelParts,
    placer,
    (pid) => p[pid as PortedPanelId]
  );

  const dashColor = overlayOnly ? "#0f172a" : "#334155";
  const dashOpacity = overlayOnly ? "0.75" : "0.7";

  const topCentreY = pt("top", 0, 0.6, 0)[1];
  const rearCentreX = pt("rear", 0, 0.7, prof.min[2])[0];
  const frontCentreX = pt("front", 0, 0.5, prof.max[2])[0];
  chromeParts.push(
    `<line x1="${p.top.x + 2}" y1="${topCentreY.toFixed(1)}" x2="${p.top.x + p.top.w - 2}" y2="${topCentreY.toFixed(1)}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="14 10" />`
  );
  chromeParts.push(
    `<line x1="${rearCentreX.toFixed(1)}" y1="${p.rear.y + 2}" x2="${rearCentreX.toFixed(1)}" y2="${p.rear.y + p.rear.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );
  chromeParts.push(
    `<line x1="${frontCentreX.toFixed(1)}" y1="${p.front.y + 2}" x2="${frontCentreX.toFixed(1)}" y2="${p.front.y + p.front.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="10 8" />`
  );

  const axleCoords = new Map<"top" | "left" | "right", { fx: number; rx: number }>();
  for (const pid of ["top", "left", "right"] as const) {
    const r = p[pid];
    const fx = pt(pid, 0, 0.6, frontAxleZ)[0];
    const rx = pt(pid, 0, 0.6, rearAxleZ)[0];
    axleCoords.set(pid, { fx, rx });
    chromeParts.push(
      `<line x1="${fx.toFixed(1)}" y1="${r.y + 2}" x2="${fx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
    chromeParts.push(
      `<line x1="${rx.toFixed(1)}" y1="${r.y + 2}" x2="${rx.toFixed(1)}" y2="${r.y + r.h - 2}" stroke="${dashColor}" stroke-opacity="${dashOpacity}" stroke-width="2" stroke-dasharray="8 8" />`
    );
  }

  for (const pid of PORTED_PANEL_IDS) {
    const r = p[pid];
    chromeParts.push(`<rect x="${r.x + 1}" y="${r.y + 1}" width="${r.w - 2}" height="${r.h - 2}" fill="none" stroke="#0f172a" stroke-width="3" />`);
  }

  if (overlayOnly) {
    placeRefText("top", `${target.id.toUpperCase()} — TOP (FRONT →)`, [[p.top.x + 400, p.top.y + 140], [p.top.x + 12, p.top.y + 10]], { startFontSize: 22, minFontSize: 14, cls: "hdr" });
    placeRefText("left", "LEFT SIDE (← FRONT)", [[p.left.x + 12, p.left.y + 10]], { startFontSize: 24, cls: "hdr" });
    placeRefText("right", "RIGHT SIDE (FRONT →)", [[p.right.x + p.right.w - 320, p.right.y + 10]], { startFontSize: 24, cls: "hdr" });
    placeRefText("rear", "REAR", [[p.rear.x + 440, p.rear.y + 40], [p.rear.x + 12, p.rear.y + 10]], { startFontSize: 22, cls: "hdr" });
    placeRefText("front", "FRONT", [[p.front.x + 440, p.front.y + 40], [p.front.x + 12, p.front.y + 10]], { startFontSize: 22, cls: "hdr" });
  } else {
    // 0. Emit & reserve in-body orientation stamps first so pills never touch stamp text
    if (target.id === "lc-lmdh") {
      const [noseX, noseY] = pt("top", 0, 0.55, 1.80);
      const [roofX, roofY] = pt("top", 0, 1.05, 0.10);
      const [sideLX, sideLY] = pt("top", 0.65, 0.72, -0.55);
      const [sideRX, sideRY] = pt("top", -0.65, 0.72, -0.55);
      pushBodyStamp(stampParts!, noseX, noseY, "NOSE · TOP →", 36, { placer, pid: "top" });
      pushBodyStamp(stampParts!, roofX, roofY, "ROOF →", 34, { placer, pid: "top" });
      pushBodyStamp(stampParts!, sideLX, sideLY, "TOP L →", 32, { placer, pid: "top" });
      pushBodyStamp(stampParts!, sideRX, sideRY, "TOP R →", 32, { placer, pid: "top" });

      const [leftFlankX, leftFlankY] = pt("left", 0.9, 0.54, -0.10);
      const [rightFlankX, rightFlankY] = pt("right", -0.9, 0.54, -0.10);
      pushBodyStamp(stampParts!, leftFlankX, leftFlankY, "← FRONT · LEFT SIDE", 44, { placer, pid: "left" });
      pushBodyStamp(stampParts!, rightFlankX, rightFlankY, "RIGHT SIDE · FRONT →", 44, { placer, pid: "right" });

      const [rearDeckX, rearDeckY] = pt("rear", 0, 0.72, -2.35);
      const [rearWingX, rearWingY] = pt("rear", 0, 1.02, -2.30);
      pushBodyStamp(stampParts!, rearDeckX, rearDeckY, "REAR", 38, { placer, pid: "rear" });
      pushBodyStamp(stampParts!, rearWingX, rearWingY, "REAR WING", 34, { placer, pid: "rear" });

      const [frontNoseX, frontNoseY] = pt("front", 0, 0.44, 2.65);
      pushBodyStamp(stampParts!, frontNoseX, frontNoseY, "FRONT", 42, { placer, pid: "front" });
    } else {
      // GT3 coupes (`amg-gt3`, `bmw-m4-gt3`)
      const hoodZ = target.id === "amg-gt3" ? 1.15 : 1.50;
      const roofZ = target.id === "amg-gt3" ? -0.30 : -0.25;
      const wingZ = target.id === "amg-gt3" ? -2.14 : prof.wingRearZ - 0.15;
      const sideX = target.id === "amg-gt3" ? 0.76 : 0.78;
      const sideZ = target.id === "amg-gt3" ? -1.52 : -1.48;
      const [hoodX, hoodY] = pt("top", 0, 0.85, hoodZ);
      const [roofX, roofY] = pt("top", 0, 1.20, roofZ);
      const [rearWingTopX, rearWingTopY] = pt("top", 0, 1.15, wingZ);
      const [topSideLX, topSideLY] = pt("top", sideX, 0.90, sideZ);
      const [topSideRX, topSideRY] = pt("top", -sideX, 0.90, sideZ);
      pushBodyStamp(stampParts!, hoodX, hoodY, "HOOD · TOP →", 38, { placer, pid: "top" });
      pushBodyStamp(stampParts!, roofX, roofY, "ROOF · TOP →", 38, { placer, pid: "top" });
      pushBodyStamp(stampParts!, topSideLX, topSideLY, "TOP L →", 30, { placer, pid: "top" });
      pushBodyStamp(stampParts!, topSideRX, topSideRY, "TOP R →", 30, { placer, pid: "top" });
      pushBodyStamp(stampParts!, rearWingTopX, rearWingTopY, "WING", 30, { placer, pid: "top" });

      const doorY = target.id === "amg-gt3" ? 0.58 : 0.62;
      const [leftDoorX, leftDoorY] = pt("left", 0.95, doorY, 0.05);
      const [rightDoorX, rightDoorY] = pt("right", -0.95, doorY, 0.05);
      pushBodyStamp(stampParts!, leftDoorX, leftDoorY, "← FRONT · LEFT SIDE", 44, { placer, pid: "left" });
      pushBodyStamp(stampParts!, rightDoorX, rightDoorY, "RIGHT SIDE · FRONT →", 44, { placer, pid: "right" });

      const [rearBumperX, rearBumperY] = pt("rear", 0, 0.66, prof.min[2]);
      const [rearWingX, rearWingY] = pt("rear", 0, 1.12, prof.min[2]);
      pushBodyStamp(stampParts!, rearBumperX, rearBumperY, "REAR", 42, { placer, pid: "rear" });
      pushBodyStamp(stampParts!, rearWingX, rearWingY, "REAR WING", 34, { placer, pid: "rear" });

      const [frontBumperX, frontBumperY] = pt("front", 0, 0.48, prof.max[2]);
      pushBodyStamp(stampParts!, frontBumperX, frontBumperY, "FRONT", 44, { placer, pid: "front" });
    }

    // 1. Primary panel header pills & FRONT arrows (strictly in unpainted space)
    placePill(
      "top",
      [`${target.id.toUpperCase()} · TOP VIEW`, [`${target.id.toUpperCase()}`, "TOP VIEW"]],
      ["tl", "tc", "bl", "tr"],
      28,
      16
    );
    placeArrow("top", 1, "FRONT", [
      [p.top.x + 1460, p.top.y + 60],
      [p.top.x + 1060, p.top.y + 200],
      [p.top.x + 340, p.top.y + 380],
    ]);

    placePill("left", ["LEFT SIDE"], ["tl", "bl", "tr"], 28, 18);
    placeArrow("left", -1, "FRONT", [[p.left.x + 320, p.left.y + 10], [p.left.x + 600, p.left.y + 10]]);

    // Right side: front nose is on the right half so the top-right sky is wide open (avoiding rear wing/fin at top-left)
    placePill("right", ["RIGHT SIDE"], ["tr", "br", "tl"], 28, 18);
    placeArrow("right", 1, "FRONT", [[p.right.x + p.right.w - 520, p.right.y + 10], [p.right.x + p.right.w - 280, p.right.y + 10]]);

    placePill("rear", ["REAR (SEEN FROM BEHIND)", "REAR"], ["tc", "bc", "tl", "bl"], 24, 15);
    placePill("rear", ["L ←  |  → R", "L ← | → R"], ["bc", "tr", "br", "tc"], 22, 15);

    placePill("front", ["FRONT (SEEN FROM THE FRONT)", "FRONT"], ["tc", "bc", "tl", "bl"], 24, 15);
    placePill("front", ["R ←  |  → L", "R ← | → L"], ["bc", "tr", "br", "tc"], 22, 15);

    if (hasCarbonHatch) {
      // Place AMG bare-carbon legend on a panel with generous unpainted space (front windshield or side sky)
      const placedOnFront = placePill("front", ["HATCHED = ALWAYS BARE CARBON"], ["tc", "bc", "bl", "tl"], 20, 15);
      if (!placedOnFront) {
        placePill("left", ["HATCHED = ALWAYS BARE CARBON"], ["tr", "tl", "bl"], 22, 16);
      }
    }

    // 2. Axle & centre-line reference labels (strictly in unpainted space)
    for (const pid of ["top", "left", "right"] as const) {
      const { fx, rx } = axleCoords.get(pid)!;
      placeAxleLabel(pid, "FRONT AXLE", fx, pid === "left" ? "right" : "left");
      placeAxleLabel(pid, "REAR AXLE", rx, pid === "left" ? "left" : "right");
    }

    placeRefText(
      "top",
      "CENTRE LINE",
      [
        [p.top.x + 300, topCentreY - 34],
        [p.top.x + 1120, topCentreY - 34],
        [p.top.x + 300, topCentreY + 12],
      ],
      { startFontSize: 20, minFontSize: 14, yRange: [topCentreY - 70, topCentreY + 70] }
    );
  }

  chromeParts.push(`</svg>`);
  stampParts?.push(`</svg>`);
  labelParts.push(`</svg>`);
  return {
    chromeSvg: chromeParts.join("\n"),
    stampsSvg: stampParts ? stampParts.join("\n") : null,
    labelsSvg: labelParts.join("\n"),
  };
}

/**
 * Rasterises a label-only SVG layer to 2048x2048 RGBA and asserts that zero rendered label/pill pixels
 * overlap any painted car geometry pixel in `fillMask`.
 */
async function assertLabelsOffPaintedGeometry(
  carId: string,
  layerName: string,
  labelsSvg: Buffer,
  fillMask: Uint8Array,
  panelRects: ReadonlyArray<readonly [AnyPanelId, AtlasPanelRect]>
): Promise<void> {
  const { data } = await sharp(labelsSvg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const problems: string[] = [];
  for (const [pid, r] of panelRects) {
    let overlapCount = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * SIZE;
      for (let x = r.x; x < r.x + r.w; x++) {
        const idx = row + x;
        if (!fillMask[idx]) continue;
        const alpha = data[idx * 4 + 3];
        if (alpha > 16) {
          overlapCount++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (overlapCount > 0) {
      problems.push(`${pid}: ${overlapCount} px overlapping painted geometry at [${minX}..${maxX}, ${minY}..${maxY}]`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${carId} (${layerName}): label/pill pixels overlap painted bodywork — ${problems.join("; ")}`);
  }
}

async function generateTemplateForCar(target: CarTemplateTarget, modelsDir: string): Promise<void> {
  const glbPath = join(modelsDir, target.glbRelPath);
  if (!existsSync(glbPath)) {
    throw new Error(`${target.id}: GLB not found at ${glbPath} (pass --models <dir> if models live elsewhere)`);
  }

  const {
    triangles,
    frontAxleZ,
    rearAxleZ,
    clamping,
    bounds,
    splitterVerts,
    excludedNodes,
    flippedMirroredTris,
  } = await loadPaintGeometry(target, glbPath);
  const panelIds: readonly AnyPanelId[] = target.kind === "f1" ? F1_PANEL_IDS : PORTED_PANEL_IDS;
  const panelRectOf = (pid: AnyPanelId): AtlasPanelRect =>
    target.kind === "f1"
      ? F1_PROJECTION.panels[pid as F1PanelId]
      : PORTED_PROJECTION.panels[pid as PortedPanelId];
  const panelRects = panelIds.map((pid) => [pid, panelRectOf(pid)] as const);

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
  const paintableFillMask = new Uint8Array(SIZE * SIZE); // non-splitter painted triangles (for exact splitter-only hatching)
  const carbonHatchRaw = new Uint8Array(SIZE * SIZE); // unpaintable forced-carbon splitter (amg-gt3)
  const clampedEdgeHatch = new Uint8Array(SIZE * SIZE); // narrow strip strictly along panel edges where geometry clamps
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

    const isForcedCarbonTri =
      target.kind === "ported" &&
      target.profile.splitterMaxY > 0 &&
      isSplitterPoint(tri.v0, target.profile) &&
      isSplitterPoint(tri.v1, target.profile) &&
      isSplitterPoint(tri.v2, target.profile);

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

      if (isForcedCarbonTri) {
        rasterizeTriangle(carbonHatchRaw, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, 1);
      } else {
        rasterizeTriangle(paintableFillMask, rect, s0.px, s0.py, s1.px, s1.py, s2.px, s2.py, 1);
      }

      // Mark only a narrow strip inside each panel edge where geometry crosses out of [0, 1] bounds
      markClampedTriangleEdges(
        clampedEdgeHatch,
        rect,
        [s0.rawU, s0.rawV],
        [s1.rawU, s1.rawV],
        [s2.rawU, s2.rawV]
      );

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

  // Combine narrow clamped-edge strips with exclusively forced-carbon splitter pixels (never shared with paintable corners)
  const hatchBand = new Uint8Array(SIZE * SIZE);
  let clampedEdgePixels = 0;
  let carbonHatchPixels = 0;
  for (let i = 0; i < hatchBand.length; i++) {
    if (clampedEdgeHatch[i]) {
      hatchBand[i] = 1;
      clampedEdgePixels++;
    } else if (splitterVerts > 0 && carbonHatchRaw[i] && !paintableFillMask[i]) {
      hatchBand[i] = 1;
      carbonHatchPixels++;
    }
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

  const labelBlockedMask = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < labelBlockedMask.length; i++) {
    if (fillMask[i] || clampedEdgeHatch[i]) labelBlockedMask[i] = 1;
  }

  const templateLayers =
    target.kind === "f1"
      ? buildF1VectorLayers(target, frontAxleZ, rearAxleZ, clamping, labelBlockedMask, false, clampedEdgePixels > 0)
      : buildPortedVectorLayers(target, frontAxleZ, rearAxleZ, carbonHatchPixels > 0, labelBlockedMask, false);
  const overlayLayers =
    target.kind === "f1"
      ? buildF1VectorLayers(target, frontAxleZ, rearAxleZ, clamping, labelBlockedMask, true, clampedEdgePixels > 0)
      : buildPortedVectorLayers(target, frontAxleZ, rearAxleZ, carbonHatchPixels > 0, labelBlockedMask, true);

  const templateLabelsBuf = Buffer.from(templateLayers.labelsSvg);
  const overlayLabelsBuf = Buffer.from(overlayLayers.labelsSvg);

  // Assert zero overlap between panel labels/pills/arrows/legends and painted geometry or clamped edge strips
  await assertLabelsOffPaintedGeometry(target.id, "template", templateLabelsBuf, labelBlockedMask, panelRects);
  await assertLabelsOffPaintedGeometry(target.id, "overlay", overlayLabelsBuf, labelBlockedMask, panelRects);

  const outDir = join(OUT_ROOT, target.id);
  mkdirSync(outDir, { recursive: true });
  const templatePath = join(outDir, `${target.id}-template.png`);
  const overlayPath = join(outDir, `${target.id}-overlay.png`);
  const previewPath = join(outDir, `${target.id}-preview.webp`);

  const templateComposites: OverlayOptions[] = [
    { input: Buffer.from(templateLayers.chromeSvg), top: 0, left: 0 },
  ];
  if (templateLayers.stampsSvg) {
    templateComposites.push({ input: Buffer.from(templateLayers.stampsSvg), top: 0, left: 0 });
  }
  templateComposites.push({ input: templateLabelsBuf, top: 0, left: 0 });

  const templatePng = await sharp(templateRgba, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .composite(templateComposites)
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
    .composite([
      { input: Buffer.from(overlayLayers.chromeSvg), top: 0, left: 0 },
      { input: overlayLabelsBuf, top: 0, left: 0 },
    ])
    .png({ palette: true, compressionLevel: 9, effort: 10, colors: 32 })
    .toBuffer();
  writeFileSync(overlayPath, overlayPng);

  const fmtKb = (p: string) => `${(statSync(p).size / 1024).toFixed(1)} KB (${statSync(p).size} B)`;
  console.log(`\n=== ${target.id} (${target.title}) ===`);
  console.log(
    `  paint tris: ${triangles.length}, verts: ${clamping.totalVerts}, bounds: x[${bounds.min[0].toFixed(3)}..${bounds.max[0].toFixed(3)}] y[${bounds.min[1].toFixed(3)}..${bounds.max[1].toFixed(3)}] z[${bounds.min[2].toFixed(3)}..${bounds.max[2].toFixed(3)}]`
  );
  if (excludedNodes > 0) console.log(`  excluded interior/roll-cage nodes: ${excludedNodes}`);
  if (flippedMirroredTris > 0) console.log(`  oriented inverted mirrored triangles: ${flippedMirroredTris}`);
  console.log(`  axles: front z=${frontAxleZ.toFixed(4)} m, rear z=${rearAxleZ.toFixed(4)} m`);
  console.log(`  dominant-panel clamped verts: ${clamping.dominantClampedTotal}`);
  for (const pid of panelIds) {
    const c = clamping.byPanel[pid];
    if (c.count > 0) {
      console.log(`    ${pid}: ${c.count} (u<0:${c.uLo}, u>1:${c.uHi}, v<0:${c.vLo}, v>1:${c.vHi})`);
    }
  }
  if (clampedEdgePixels > 0) console.log(`  clamped-edge hatch px (<= ${CLAMP_EDGE_STRIP_PX}px strip): ${clampedEdgePixels}`);
  if (splitterVerts > 0) console.log(`  forced-carbon front splitter verts: ${splitterVerts}, exclusive carbon hatch px: ${carbonHatchPixels}`);
  console.log(`  label overlap check: 0 px overlapping painted bodywork (template + overlay)`);
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

export {
  assertLabelsOffPaintedGeometry,
  buildF1VectorLayers,
  buildPortedVectorLayers,
  CLAMP_EDGE_STRIP_PX,
  loadPaintGeometry,
  markClampedTriangleEdges,
  rasterizeTriangle,
  TARGETS as LIVERY_TEMPLATE_TARGETS,
};

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && entry.endsWith("build-livery-templates.ts"));
}

if (isDirectRun()) {
  void main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
