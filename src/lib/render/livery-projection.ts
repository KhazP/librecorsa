/**
 * Single source of truth for object-space tri-orthographic livery projection bounds, atlas panel rects,
 * special-region overrides, blend weights, and the GLSL shader strings generated from them.
 *
 * Used by both the runtime projection shaders (`f1-livery-painter.ts`) and the offline template generator
 * (`scripts/cars/build-livery-templates.ts`) so painted templates align pixel-for-pixel with the renderer.
 */

export interface AtlasPanelRect {
  /** Left edge in logical atlas pixels (flipY = false, x increases right) */
  readonly x: number;
  /** Top edge in logical atlas pixels (flipY = false, y increases down) */
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ClampedAtlasSample {
  /** Clamped normalized texture coordinate [0..1] inside the full atlas */
  readonly u: number;
  readonly v: number;
  /** Clamped pixel coordinate inside the logical atlas */
  readonly px: number;
  readonly py: number;
  /** Unclamped panel-local UV before clamping to [0..1] */
  readonly rawU: number;
  readonly rawV: number;
  readonly clampedU: boolean;
  readonly clampedV: boolean;
  readonly clamped: boolean;
}

export type F1PanelId =
  | "top"
  | "left"
  | "right"
  | "rear"
  | "front"
  | "fwEndplateLeft"
  | "fwEndplateRight";

export const F1_PANEL_IDS: readonly F1PanelId[] = [
  "top",
  "left",
  "right",
  "rear",
  "front",
  "fwEndplateLeft",
  "fwEndplateRight",
];

/**
 * F1 atlas layout and car-space projection parameters (metres: +X left, +Y up, +Z forward).
 * Calibrated for `f12026.glb`; `lc25.glb` uses the exact same projection shader.
 */
export const F1_PROJECTION = {
  atlasSize: 2048,
  padPx: 2,
  bounds: {
    zMin: -2.75,
    zMax: 2.85,
    zSpan: 5.6,
    xMin: -0.95,
    xMax: 0.95,
    xSpan: 1.9,
    yMin: 0.0,
    yMax: 1.15,
    ySpan: 1.15,
  },
  panels: {
    top: { x: 0, y: 0, w: 2048, h: 768 },
    left: { x: 0, y: 768, w: 2048, h: 480 },
    right: { x: 0, y: 1248, w: 2048, h: 480 },
    rear: { x: 0, y: 1728, w: 1024, h: 320 },
    front: { x: 1024, y: 1728, w: 512, h: 320 },
    fwEndplateLeft: { x: 1536, y: 1728, w: 512, h: 160 },
    fwEndplateRight: { x: 1536, y: 1888, w: 512, h: 160 },
  } satisfies Record<F1PanelId, AtlasPanelRect>,
  fwEndplate: {
    zMinTrigger: 1.75,
    absXMinTrigger: 0.55,
    zMin: 1.8,
    zMax: 2.75,
    zSpan: 0.95,
    yMax: 0.46,
    ySpan: 0.38,
  },
  haloInner: {
    yMin: 0.8,
    zMin: -0.06,
    zMax: 0.7,
    absXMax: 0.36,
  },
  rearFace: {
    xMax: 0.65,
    xSpan: 1.3,
    yMax: 1.0,
    ySpan: 0.65,
    midCarZFrom: -1.4,
    midCarZTo: -1.3,
    midCarYFrom: 0.6,
    midCarYTo: 0.64,
  },
  frontFace: {
    yMax: 0.65,
    ySpan: 0.57,
  },
  weights: {
    xPower: 4.0,
    yPower: 4.0,
    yNegScale: 0.35,
    zPower: 6.0,
    rearWingZMax: -2.02,
    rearWingYMin: 0.58,
    rearWingAbsXMax: 0.52,
    rearWingNzMax: -0.22,
    rearWingWzMin: 4.0,
  },
  carbon: {
    smoothFrom: 0.016,
    smoothTo: 0.032,
  },
} as const;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Clamps a panel-local UV into its padded atlas rect, matching `f1AtlasClamp` / `procAtlasClamp` in GLSL */
export function clampToAtlasPanel(
  rawU: number,
  rawV: number,
  rect: AtlasPanelRect,
  atlasSize = F1_PROJECTION.atlasSize,
  padPx = F1_PROJECTION.padPx
): ClampedAtlasSample {
  const pad = padPx / atlasSize;
  const originU = rect.x / atlasSize;
  const originV = rect.y / atlasSize;
  const sizeU = rect.w / atlasSize;
  const sizeV = rect.h / atlasSize;
  const cu = clamp01(rawU);
  const cv = clamp01(rawV);
  const u = originU + pad + cu * Math.max(sizeU - pad * 2, 0.0001);
  const v = originV + pad + cv * Math.max(sizeV - pad * 2, 0.0001);
  const clampedU = rawU < 0 || rawU > 1;
  const clampedV = rawV < 0 || rawV > 1;
  return {
    u,
    v,
    px: u * atlasSize,
    py: v * atlasSize,
    rawU,
    rawV,
    clampedU,
    clampedV,
    clamped: clampedU || clampedV,
  };
}

/** Computes raw (unclamped) panel-local UV [u, v] for a car-space point `(x, y, z)` in an F1 atlas panel */
export function f1PanelRawUv(panel: F1PanelId, x: number, y: number, z: number): [number, number] {
  const b = F1_PROJECTION.bounds;
  switch (panel) {
    case "top":
      return [(z - b.zMin) / b.zSpan, (b.xMax - x) / b.xSpan];
    case "left":
      return [(b.zMax - z) / b.zSpan, (b.yMax - y) / b.ySpan];
    case "right":
      return [(z - b.zMin) / b.zSpan, (b.yMax - y) / b.ySpan];
    case "rear": {
      const r = F1_PROJECTION.rearFace;
      return [(r.xMax - x) / r.xSpan, (r.yMax - y) / r.ySpan];
    }
    case "front": {
      const f = F1_PROJECTION.frontFace;
      return [(x - b.xMin) / b.xSpan, (f.yMax - y) / f.ySpan];
    }
    case "fwEndplateLeft": {
      const fw = F1_PROJECTION.fwEndplate;
      return [(fw.zMax - z) / fw.zSpan, (fw.yMax - y) / fw.ySpan];
    }
    case "fwEndplateRight": {
      const fw = F1_PROJECTION.fwEndplate;
      return [(z - fw.zMin) / fw.zSpan, (fw.yMax - y) / fw.ySpan];
    }
  }
}

/** Projects a car-space point `(x, y, z)` into a specific F1 atlas panel (including the 2 px clamp pad) */
export function f1ProjectToPanel(panel: F1PanelId, x: number, y: number, z: number): ClampedAtlasSample {
  const [rawU, rawV] = f1PanelRawUv(panel, x, y, z);
  return clampToAtlasPanel(rawU, rawV, F1_PROJECTION.panels[panel], F1_PROJECTION.atlasSize, F1_PROJECTION.padPx);
}

export interface F1SlotProjection {
  readonly panel: F1PanelId;
  readonly sample: ClampedAtlasSample;
}

export interface F1PointProjection {
  readonly top: F1SlotProjection;
  readonly side: F1SlotProjection;
  readonly end: F1SlotProjection;
  readonly haloInnerOverride: boolean;
  readonly midCarRearFade: number;
  readonly weights: {
    readonly wx: number;
    readonly wy: number;
    readonly wz: number;
    readonly wTop: number;
    readonly wSide: number;
    readonly wEnd: number;
  };
  /** Final effective blend weight contributed by each atlas panel (sums to 1) */
  readonly panelWeights: Partial<Record<F1PanelId, number>>;
  readonly dominantPanel: F1PanelId;
}

/**
 * Evaluates the exact F1 tri-orthographic projection math for a car-space point and normal,
 * matching `LIV_FRAGMENT_MAP` in `f1-livery-painter.ts`.
 */
export function projectF1Point(
  pos: readonly [number, number, number],
  nrm: readonly [number, number, number]
): F1PointProjection {
  const [lx, ly, lz] = pos;
  const nLen = Math.hypot(nrm[0], nrm[1], nrm[2]);
  const nx = nLen > 1e-12 ? nrm[0] / nLen : 0;
  const ny = nLen > 1e-12 ? nrm[1] / nLen : 1;
  const nz = nLen > 1e-12 ? nrm[2] / nLen : 0;

  const topSample = f1ProjectToPanel("top", lx, ly, lz);

  const fw = F1_PROJECTION.fwEndplate;
  const isLeftSide = nx >= 0;
  const isFwEndplate = lz > fw.zMinTrigger && Math.abs(lx) > fw.absXMinTrigger;
  const sidePanel: F1PanelId = isFwEndplate
    ? isLeftSide
      ? "fwEndplateLeft"
      : "fwEndplateRight"
    : isLeftSide
      ? "left"
      : "right";
  const sideSample = f1ProjectToPanel(sidePanel, lx, ly, lz);

  const halo = F1_PROJECTION.haloInner;
  const haloInnerOverride =
    ly > halo.yMin && lz > halo.zMin && lz < halo.zMax && Math.abs(lx) < halo.absXMax && nx * lx < 0;

  const isRear = nz < 0;
  const endPanel: F1PanelId = isRear ? "rear" : "front";
  const endSample = f1ProjectToPanel(endPanel, lx, ly, lz);

  const rf = F1_PROJECTION.rearFace;
  const midCarRearFade = isRear
    ? smoothstep(rf.midCarZFrom, rf.midCarZTo, lz) * smoothstep(rf.midCarYFrom, rf.midCarYTo, ly)
    : 0;

  const wp = F1_PROJECTION.weights;
  const wx = Math.pow(Math.abs(nx), wp.xPower);
  const wy = Math.pow(Math.max(ny, 0) + wp.yNegScale * Math.max(-ny, 0), wp.yPower);
  let wz = Math.pow(Math.abs(nz), wp.zPower);
  if (
    lz < wp.rearWingZMax &&
    ly > wp.rearWingYMin &&
    Math.abs(lx) < wp.rearWingAbsXMax &&
    nz < wp.rearWingNzMax
  ) {
    wz = Math.max(wz, wp.rearWingWzMin);
  }
  const wSum = Math.max(wx + wy + wz, 1e-4);
  const wTop = wy / wSum;
  const wSide = wx / wSum;
  const wEnd = wz / wSum;

  const panelWeights: Partial<Record<F1PanelId, number>> = {};
  const addWeight = (panel: F1PanelId, w: number) => {
    if (w <= 0) return;
    panelWeights[panel] = (panelWeights[panel] ?? 0) + w;
  };
  addWeight("top", wTop);
  addWeight(haloInnerOverride ? "top" : sidePanel, wSide);
  if (isRear) {
    addWeight("rear", wEnd * (1 - midCarRearFade));
    addWeight("top", wEnd * midCarRearFade);
  } else {
    addWeight("front", wEnd);
  }

  let dominantPanel: F1PanelId = "top";
  let bestWeight = -1;
  for (const [panel, w] of Object.entries(panelWeights) as [F1PanelId, number][]) {
    if (w > bestWeight) {
      bestWeight = w;
      dominantPanel = panel;
    }
  }

  return {
    top: { panel: "top", sample: topSample },
    side: { panel: sidePanel, sample: sideSample },
    end: { panel: endPanel, sample: endSample },
    haloInnerOverride,
    midCarRearFade,
    weights: { wx, wy, wz, wTop, wSide, wEnd },
    panelWeights,
    dominantPanel,
  };
}

// ---------------------------------------------------------------------------
// GLSL generation from F1_PROJECTION constants
// ---------------------------------------------------------------------------

function glslNum(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function glslFixed2(n: number): string {
  return n.toFixed(2);
}

function glslFixed3(n: number): string {
  return n.toFixed(3);
}

export interface F1LiveryShaderChunks {
  readonly vertexPatch: string;
  readonly vertexBody: string;
  readonly fragmentPatch: string;
  readonly fragmentMap: string;
  readonly fragmentRoughness: string;
}

/** Builds the F1 tri-orthographic GLSL shader chunks directly from `F1_PROJECTION` */
export function buildF1LiveryShaders(): F1LiveryShaderChunks {
  const p = F1_PROJECTION;
  const b = p.bounds;
  const s = p.atlasSize;
  const fw = p.fwEndplate;
  const halo = p.haloInner;
  const rf = p.rearFace;
  const ff = p.frontFace;
  const w = p.weights;
  const c = p.carbon;

  const topRect = p.panels.top;
  const leftRect = p.panels.left;
  const rightRect = p.panels.right;
  const rearRect = p.panels.rear;
  const frontRect = p.panels.front;
  const fwLRect = p.panels.fwEndplateLeft;
  const fwRRect = p.panels.fwEndplateRight;

  const vertexPatch = /* glsl */ `#include <common>
uniform mat4 uLiveryFrame;
varying vec3 vLivPos;
varying vec3 vLivNrm;`;

  const vertexBody = /* glsl */ `#include <begin_vertex>
vLivPos = ( uLiveryFrame * vec4( position, 1.0 ) ).xyz;
vLivNrm = normalize( mat3( uLiveryFrame ) * normal );`;

  const fragmentPatch = /* glsl */ `#include <common>
uniform sampler2D uLiveryAtlas;
uniform float uLiveryEnabled;
uniform float uLiveryCarbonStrength;
varying vec3 vLivPos;
varying vec3 vLivNrm;

vec2 f1AtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
\tvec2 pad = vec2( ${glslNum(p.padPx)} / ${glslNum(s)} );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float f1CarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`;

  const fragmentMap = /* glsl */ `#include <map_fragment>
float f1CarbonMask = 0.0;
if ( uLiveryEnabled > 0.5 ) {
\tvec3 lp = vLivPos;
\tvec3 ln = normalize( vLivNrm );

\t// 1) TOP panel: rect (0, 0, 1, ${topRect.h}/${s})
\tvec2 uvTop = vec2( ( lp.z - (${glslFixed2(b.zMin)}) ) / ${glslFixed2(b.zSpan)}, (${glslFixed2(b.xMax)} - lp.x) / ${glslFixed2(b.xSpan)} );
\tvec3 colTop = texture2D( uLiveryAtlas, f1AtlasClamp( uvTop, vec2( ${glslNum(topRect.x / s)}, ${glslNum(topRect.y / s)} ), vec2( ${glslNum(topRect.w / s)}, ${glslNum(topRect.h / s)} ) ) ).rgb;

\t// 2) SIDE panel: Left (+X), Right (-X), or dedicated Front Wing Endplates (|x|>${glslFixed2(fw.absXMinTrigger)} & z>${glslFixed2(fw.zMinTrigger)})
\tvec3 colSide;
\tbool isLeftSide = ln.x >= 0.0;
\tif ( lp.z > ${glslFixed2(fw.zMinTrigger)} && abs( lp.x ) > ${glslFixed2(fw.absXMinTrigger)} ) {
\t\tfloat fwU = isLeftSide ? ( ${glslFixed2(fw.zMax)} - lp.z ) / ${glslFixed2(fw.zSpan)} : ( lp.z - ${glslFixed2(fw.zMin)} ) / ${glslFixed2(fw.zSpan)};
\t\tfloat fwV = ( ${glslFixed2(fw.yMax)} - lp.y ) / ${glslFixed2(fw.ySpan)};
\t\tfloat fwY0 = isLeftSide ? ${glslNum(fwLRect.y / s)} : ${glslNum(fwRRect.y / s)};
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( vec2( fwU, fwV ), vec2( ${glslNum(fwLRect.x / s)}, fwY0 ), vec2( ${glslNum(fwLRect.w / s)}, ${glslNum(fwLRect.h / s)} ) ) ).rgb;
\t} else if ( isLeftSide ) {
\t\tvec2 uvL = vec2( (${glslFixed2(b.zMax)} - lp.z) / ${glslFixed2(b.zSpan)}, (${glslFixed2(b.yMax)} - lp.y) / ${glslFixed2(b.ySpan)} );
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvL, vec2( ${glslNum(leftRect.x / s)}, ${glslNum(leftRect.y / s)} ), vec2( ${glslNum(leftRect.w / s)}, ${glslNum(leftRect.h / s)} ) ) ).rgb;
\t} else {
\t\tvec2 uvR = vec2( ( lp.z - (${glslFixed2(b.zMin)}) ) / ${glslFixed2(b.zSpan)}, (${glslFixed2(b.yMax)} - lp.y) / ${glslFixed2(b.ySpan)} );
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvR, vec2( ${glslNum(rightRect.x / s)}, ${glslNum(rightRect.y / s)} ), vec2( ${glslNum(rightRect.w / s)}, ${glslNum(rightRect.h / s)} ) ) ).rgb;
\t}

\t// The halo's inner faces (above the cockpit rim, facing the car's centre line) would take the far side's panel and
\t// its halo sponsor, squeezed onto the curved tube: they take the top view's colour, like the rest of the hoop
\tif ( lp.y > ${glslFixed2(halo.yMin)} && lp.z > ${glslFixed2(halo.zMin)} && lp.z < ${glslFixed2(halo.zMax)} && abs( lp.x ) < ${glslFixed2(halo.absXMax)} && ln.x * lp.x < 0.0 ) {
\t\tcolSide = colTop;
\t}

\t// 3) REAR / FRONT face panel
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( ${glslFixed2(rf.xMax)} - lp.x ) / ${glslFixed2(rf.xSpan)}, ( ${glslFixed2(rf.yMax)} - lp.y ) / ${glslFixed2(rf.ySpan)} );
\t\tcolEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvRear, vec2( ${glslNum(rearRect.x / s)}, ${glslNum(rearRect.y / s)} ), vec2( ${glslNum(rearRect.w / s)}, ${glslNum(rearRect.h / s)} ) ) ).rgb;
\t\t// The rear panel's upper part is the rear wing's face (its title banner spans y 0.71..0.91): projected along Z it
\t\t// also landed on every rear-facing surface ahead of the gearbox at that height, the halo's front arc above all,
\t\t// where the banner showed as smeared letter slices across the hoop. Those take the top view's colour; lower down
\t\t// the panel is plain carbon and stays
\t\tfloat midCar = smoothstep( ${glslFixed2(rf.midCarZFrom)}, ${glslFixed2(rf.midCarZTo)}, lp.z ) * smoothstep( ${glslFixed2(rf.midCarYFrom)}, ${glslFixed2(rf.midCarYTo)}, lp.y );
\t\tcolEnd = mix( colEnd, colTop, midCar );
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - (${glslFixed2(b.xMin)}) ) / ${glslFixed2(b.xSpan)}, ( ${glslFixed2(ff.yMax)} - lp.y ) / ${glslFixed2(ff.ySpan)} );
\t\tcolEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvFront, vec2( ${glslNum(frontRect.x / s)}, ${glslNum(frontRect.y / s)} ), vec2( ${glslNum(frontRect.w / s)}, ${glslNum(frontRect.h / s)} ) ) ).rgb;
\t}

\t// Sharp tri-orthographic weights so top/side/rear text stays crisp without ghosting
\tfloat wx = pow( abs( ln.x ), ${glslNum(w.xPower)} );
\tfloat wy = pow( max( ln.y, 0.0 ) + ${glslFixed2(w.yNegScale)} * max( -ln.y, 0.0 ), ${glslNum(w.yPower)} );
\tfloat wz = pow( abs( ln.z ), ${glslNum(w.zPower)} );
\t// Ensure the angled rear wing mainplane & DRS flap face shows the crisp chase-cam rear banner
\tif ( lp.z < ${glslFixed2(w.rearWingZMax)} && lp.y > ${glslFixed2(w.rearWingYMin)} && abs( lp.x ) < ${glslFixed2(w.rearWingAbsXMax)} && ln.z < ${glslFixed2(w.rearWingNzMax)} ) {
\t\twz = max( wz, ${glslNum(w.rearWingWzMin)} );
\t}
\tvec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );
\tdiffuseColor.rgb = livCol;

\t// Detect exposed dark carbon regions (linear max channel < 0.028) for subtle 2x2 twill sheen modulation
\tfloat maxC = max( livCol.r, max( livCol.g, livCol.b ) );
\tf1CarbonMask = ( 1.0 - smoothstep( ${glslFixed3(c.smoothFrom)}, ${glslFixed3(c.smoothTo)}, maxC ) ) * uLiveryCarbonStrength;
}`;

  const fragmentRoughness = /* glsl */ `#include <roughnessmap_fragment>
if ( f1CarbonMask > 0.01 ) {
\tvec3 cn = abs( normalize( vLivNrm ) );
\tvec2 cp = cn.y > 0.6 ? vLivPos.xz : ( cn.x > 0.6 ? vLivPos.zy : vLivPos.xy );
\tfloat invPitch = 190.0;
\tvec3 dP = fwidth( vLivPos );
\tfloat towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
\tfloat fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
\tfloat twill = f1CarbonTwill( cp * invPitch ) * fade * f1CarbonMask;
\troughnessFactor = mix( roughnessFactor, 0.36, f1CarbonMask * 0.7 ) + 0.055 * twill;
\tdiffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

  return { vertexPatch, vertexBody, fragmentPatch, fragmentMap, fragmentRoughness };
}

export const F1_LIVERY_SHADERS: F1LiveryShaderChunks = buildF1LiveryShaders();

// ---------------------------------------------------------------------------
// Ported 5-Panel Projection (amg-gt3, bmw-m4-gt3, lc-lmdh)
// ---------------------------------------------------------------------------

export type PortedPanelId = "top" | "left" | "right" | "rear" | "front";

export const PORTED_PANEL_IDS: readonly PortedPanelId[] = ["top", "left", "right", "rear", "front"];

export interface PortedProjectionProfile {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly wingRearZ: number;
  readonly wingMinY: number;
  readonly hoodStartZ: number;
  readonly hoodMinY: number;
  readonly splitterMaxY: number;
  readonly splitterMinZ: number;
}

/** Shared 2048x2048 5-panel atlas layout and blend parameters for ported GT3 and LMDh bodywork */
export const PORTED_PROJECTION = {
  atlasSize: 2048,
  padPx: 2,
  panels: {
    top: { x: 0, y: 0, w: 2048, h: 832 },
    left: { x: 0, y: 832, w: 2048, h: 448 },
    right: { x: 0, y: 1280, w: 2048, h: 448 },
    rear: { x: 0, y: 1728, w: 1024, h: 320 },
    front: { x: 1024, y: 1728, w: 1024, h: 320 },
  } satisfies Record<PortedPanelId, AtlasPanelRect>,
  weights: {
    xPower: 4.0,
    yPower: 4.0,
    yNegScale: 0.3,
    zPower: 5.0,
    hoodNyMin: 0.42,
    hoodWyMul: 2.6,
    gt3HoodWyMul: 2.4,
    wingAbsXMax: 0.86,
    wingRearNzMax: -0.35,
    wingMainMinWeight: 3.5,
    wingEndplateWxMin: 4.0,
  },
  carbon: {
    smoothFrom: 0.014,
    smoothTo: 0.028,
  },
} as const;

/** Computes raw (unclamped) panel-local UV [u, v] for a car-space point in a ported 5-panel atlas */
export function portedPanelRawUv(
  panel: PortedPanelId,
  x: number,
  y: number,
  z: number,
  profile: Pick<PortedProjectionProfile, "min" | "max">
): [number, number] {
  const spanX = Math.max(profile.max[0] - profile.min[0], 0.001);
  const spanY = Math.max(profile.max[1] - profile.min[1], 0.001);
  const spanZ = Math.max(profile.max[2] - profile.min[2], 0.001);
  const sideV = (profile.max[1] - y) / spanY;
  switch (panel) {
    case "top":
      return [(z - profile.min[2]) / spanZ, (profile.max[0] - x) / spanX];
    case "left":
      return [(profile.max[2] - z) / spanZ, sideV];
    case "right":
      return [(z - profile.min[2]) / spanZ, sideV];
    case "rear":
      return [(profile.max[0] - x) / spanX, sideV];
    case "front":
      return [(x - profile.min[0]) / spanX, sideV];
  }
}

/** Projects a car-space point into a specific ported 5-panel atlas rect (including the 2 px clamp pad) */
export function portedProjectToPanel(
  panel: PortedPanelId,
  x: number,
  y: number,
  z: number,
  profile: Pick<PortedProjectionProfile, "min" | "max">
): ClampedAtlasSample {
  const [rawU, rawV] = portedPanelRawUv(panel, x, y, z, profile);
  return clampToAtlasPanel(rawU, rawV, PORTED_PROJECTION.panels[panel], PORTED_PROJECTION.atlasSize, PORTED_PROJECTION.padPx);
}

export interface PortedSlotProjection {
  readonly panel: PortedPanelId;
  readonly sample: ClampedAtlasSample;
}

export interface PortedPointProjection {
  readonly top: PortedSlotProjection;
  readonly side: PortedSlotProjection;
  readonly end: PortedSlotProjection;
  readonly splitterCarbonOverride: boolean;
  readonly weights: {
    readonly wx: number;
    readonly wy: number;
    readonly wz: number;
    readonly wTop: number;
    readonly wSide: number;
    readonly wEnd: number;
  };
  readonly panelWeights: Partial<Record<PortedPanelId, number>>;
  readonly dominantPanel: PortedPanelId;
}

/**
 * Evaluates the exact ported tri-orthographic projection math for a car-space point and normal,
 * matching `PORTED_FRAGMENT_MAP` in `ported-procedural-livery.ts`.
 */
export function projectPortedPoint(
  pos: readonly [number, number, number],
  nrm: readonly [number, number, number],
  profile: PortedProjectionProfile
): PortedPointProjection {
  const [lx, ly, lz] = pos;
  const nLen = Math.hypot(nrm[0], nrm[1], nrm[2]);
  const nx = nLen > 1e-12 ? nrm[0] / nLen : 0;
  const ny = nLen > 1e-12 ? nrm[1] / nLen : 1;
  const nz = nLen > 1e-12 ? nrm[2] / nLen : 0;

  const topSample = portedProjectToPanel("top", lx, ly, lz, profile);
  const sidePanel: PortedPanelId = nx >= 0 ? "left" : "right";
  const sideSample = portedProjectToPanel(sidePanel, lx, ly, lz, profile);
  const endPanel: PortedPanelId = nz < 0 ? "rear" : "front";
  const endSample = portedProjectToPanel(endPanel, lx, ly, lz, profile);

  const wp = PORTED_PROJECTION.weights;
  let wx = Math.pow(Math.abs(nx), wp.xPower);
  let wy = Math.pow(Math.max(ny, 0) + wp.yNegScale * Math.max(-ny, 0), wp.yPower);
  let wz = Math.pow(Math.abs(nz), wp.zPower);

  if (lz > profile.hoodStartZ && ly > profile.hoodMinY && ny > wp.hoodNyMin) {
    wy *= wp.hoodWyMul;
  }
  if (lz < profile.wingRearZ && ly > profile.wingMinY) {
    if (Math.abs(lx) < wp.wingAbsXMax) {
      if (nz < wp.wingRearNzMax) wz = Math.max(wz, wp.wingMainMinWeight);
      else wy = Math.max(wy, wp.wingMainMinWeight);
    } else {
      wx = Math.max(wx, wp.wingEndplateWxMin);
    }
  }

  const wSum = Math.max(wx + wy + wz, 1e-4);
  const wTop = wy / wSum;
  const wSide = wx / wSum;
  const wEnd = wz / wSum;

  const panelWeights: Partial<Record<PortedPanelId, number>> = {};
  if (wTop > 0) panelWeights.top = wTop;
  if (wSide > 0) panelWeights[sidePanel] = wSide;
  if (wEnd > 0) panelWeights[endPanel] = wEnd;

  let dominantPanel: PortedPanelId = "top";
  let bestWeight = -1;
  for (const [panel, w] of Object.entries(panelWeights) as [PortedPanelId, number][]) {
    if (w > bestWeight) {
      bestWeight = w;
      dominantPanel = panel;
    }
  }

  const splitterCarbonOverride =
    profile.splitterMaxY > 0 && ly < profile.splitterMaxY && lz > profile.splitterMinZ;

  return {
    top: { panel: "top", sample: topSample },
    side: { panel: sidePanel, sample: sideSample },
    end: { panel: endPanel, sample: endSample },
    splitterCarbonOverride,
    weights: { wx, wy, wz, wTop, wSide, wEnd },
    panelWeights,
    dominantPanel,
  };
}

/** Builds the unified ported procedural/image-atlas shader chunks from `PORTED_PROJECTION` */
export function buildPortedLiveryShaders(): F1LiveryShaderChunks {
  const p = PORTED_PROJECTION;
  const s = p.atlasSize;
  const w = p.weights;
  const c = p.carbon;
  const topRect = p.panels.top;
  const leftRect = p.panels.left;
  const rightRect = p.panels.right;
  const rearRect = p.panels.rear;
  const frontRect = p.panels.front;

  const vertexPatch = /* glsl */ `#include <common>
uniform mat4 uProcFrame;
varying vec3 vProcPos;
varying vec3 vProcNrm;`;

  const vertexBody = /* glsl */ `#include <begin_vertex>
vProcPos = ( uProcFrame * vec4( position, 1.0 ) ).xyz;
vProcNrm = normalize( mat3( uProcFrame ) * normal );`;

  const fragmentPatch = /* glsl */ `#include <common>
uniform sampler2D uProcAtlas;
uniform float uProcEnabled;
uniform float uProcCarbonStrength;
uniform vec3 uProcMin;
uniform vec3 uProcMax;
uniform float uProcWingRearZ;
uniform float uProcWingMinY;
uniform float uProcHoodStartZ;
uniform float uProcHoodMinY;
uniform float uProcSplitterMaxY;
uniform float uProcSplitterMinZ;
varying vec3 vProcPos;
varying vec3 vProcNrm;

vec2 procAtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
\tvec2 pad = vec2( ${glslNum(p.padPx)} / ${glslNum(s)} );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float procCarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`;

  const fragmentMap = /* glsl */ `#include <map_fragment>
float procCarbonMask = 0.0;
if ( uProcEnabled > 0.5 ) {
\tvec3 lp = vProcPos;
\tvec3 ln = normalize( vProcNrm );
\tvec3 span = max( uProcMax - uProcMin, vec3( 0.001 ) );

\t// 1) TOP panel: rect (0, 0, 1.0, ${topRect.h}/${s} = ${glslNum(topRect.h / s)})
\tvec2 uvTop = vec2( ( lp.z - uProcMin.z ) / span.z, ( uProcMax.x - lp.x ) / span.x );
\tvec3 colTop = texture2D( uProcAtlas, procAtlasClamp( uvTop, vec2( ${glslNum(topRect.x / s)}, ${glslNum(topRect.y / s)} ), vec2( ${glslNum(topRect.w / s)}, ${glslNum(topRect.h / s)} ) ) ).rgb;

\t// 2) LEFT (+X) and RIGHT (-X) SIDE panels
\tvec3 colSide;
\tfloat sideV = ( uProcMax.y - lp.y ) / span.y;
\tif ( ln.x >= 0.0 ) {
\t\tfloat leftU = ( uProcMax.z - lp.z ) / span.z;
\t\tcolSide = texture2D( uProcAtlas, procAtlasClamp( vec2( leftU, sideV ), vec2( ${glslNum(leftRect.x / s)}, ${glslNum(leftRect.y / s)} ), vec2( ${glslNum(leftRect.w / s)}, ${glslNum(leftRect.h / s)} ) ) ).rgb;
\t} else {
\t\tfloat rightU = ( lp.z - uProcMin.z ) / span.z;
\t\tcolSide = texture2D( uProcAtlas, procAtlasClamp( vec2( rightU, sideV ), vec2( ${glslNum(rightRect.x / s)}, ${glslNum(rightRect.y / s)} ), vec2( ${glslNum(rightRect.w / s)}, ${glslNum(rightRect.h / s)} ) ) ).rgb;
\t}

\t// 3) REAR (-Z) and FRONT (+Z) panels
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( uProcMax.x - lp.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uProcAtlas, procAtlasClamp( uvRear, vec2( ${glslNum(rearRect.x / s)}, ${glslNum(rearRect.y / s)} ), vec2( ${glslNum(rearRect.w / s)}, ${glslNum(rearRect.h / s)} ) ) ).rgb;
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - uProcMin.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uProcAtlas, procAtlasClamp( uvFront, vec2( ${glslNum(frontRect.x / s)}, ${glslNum(frontRect.y / s)} ), vec2( ${glslNum(frontRect.w / s)}, ${glslNum(frontRect.h / s)} ) ) ).rgb;
\t}

\tfloat wx = pow( abs( ln.x ), ${glslNum(w.xPower)} );
\tfloat wy = pow( max( ln.y, 0.0 ) + ${glslFixed2(w.yNegScale)} * max( -ln.y, 0.0 ), ${glslNum(w.yPower)} );
\tfloat wz = pow( abs( ln.z ), ${glslNum(w.zPower)} );

\t// Keep sloped hoods / prototype noses sharp on the TOP projection
\tif ( lp.z > uProcHoodStartZ && lp.y > uProcHoodMinY && ln.y > ${glslFixed2(w.hoodNyMin)} ) {
\t\twy *= ${glslNum(w.hoodWyMul)};
\t}
\t// Rear wing mainplane top/rear crispness & wing endplate side crispness
\tif ( lp.z < uProcWingRearZ && lp.y > uProcWingMinY ) {
\t\tif ( abs( lp.x ) < ${glslFixed2(w.wingAbsXMax)} ) {
\t\t\tif ( ln.z < ${glslFixed2(w.wingRearNzMax)} ) wz = max( wz, ${glslNum(w.wingMainMinWeight)} );
\t\t\telse wy = max( wy, ${glslNum(w.wingMainMinWeight)} );
\t\t} else {
\t\t\twx = max( wx, ${glslNum(w.wingEndplateWxMin)} );
\t\t}
\t}

\tvec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );

\t// Keep the protruding AMG GT3 Evo front aero splitter tray exposed dark carbon fiber
\tif ( uProcSplitterMaxY > 0.0 && lp.y < uProcSplitterMaxY && lp.z > uProcSplitterMinZ ) {
\t\tlivCol = vec3( 0.011, 0.012, 0.015 );
\t}

\tdiffuseColor.rgb = livCol;

\tfloat maxC = max( livCol.r, max( livCol.g, livCol.b ) );
\tprocCarbonMask = ( 1.0 - smoothstep( ${glslFixed3(c.smoothFrom)}, ${glslFixed3(c.smoothTo)}, maxC ) ) * uProcCarbonStrength;
}`;

  const fragmentRoughness = /* glsl */ `#include <roughnessmap_fragment>
if ( procCarbonMask > 0.01 ) {
\tvec3 cn = abs( normalize( vProcNrm ) );
\tvec2 cp = cn.y > 0.6 ? vProcPos.xz : ( cn.x > 0.6 ? vProcPos.zy : vProcPos.xy );
\tfloat invPitch = 190.0;
\tvec3 dP = fwidth( vProcPos );
\tfloat towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
\tfloat fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
\tfloat twill = procCarbonTwill( cp * invPitch ) * fade * procCarbonMask;
\troughnessFactor = mix( roughnessFactor, 0.36, procCarbonMask * 0.72 ) + 0.055 * twill;
\tdiffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

  return { vertexPatch, vertexBody, fragmentPatch, fragmentMap, fragmentRoughness };
}

/** Builds the legacy GT3 shader chunks (`gt3-livery-painter.ts`) directly from `PORTED_PROJECTION` */
export function buildGt3LiveryShaders(): F1LiveryShaderChunks {
  const p = PORTED_PROJECTION;
  const s = p.atlasSize;
  const w = p.weights;
  const c = p.carbon;
  const topRect = p.panels.top;
  const leftRect = p.panels.left;
  const rightRect = p.panels.right;
  const rearRect = p.panels.rear;
  const frontRect = p.panels.front;

  const vertexPatch = /* glsl */ `#include <common>
uniform mat4 uGt3Frame;
varying vec3 vGt3Pos;
varying vec3 vGt3Nrm;`;

  const vertexBody = /* glsl */ `#include <begin_vertex>
vGt3Pos = ( uGt3Frame * vec4( position, 1.0 ) ).xyz;
vGt3Nrm = normalize( mat3( uGt3Frame ) * normal );`;

  const fragmentPatch = /* glsl */ `#include <common>
uniform sampler2D uGt3Atlas;
uniform float uGt3Enabled;
uniform float uGt3CarbonStrength;
uniform vec3 uGt3Min;
uniform vec3 uGt3Max;
uniform float uGt3WingRearZ;
uniform float uGt3HoodStartZ;
uniform float uGt3SplitterMaxY;
uniform float uGt3SplitterMinZ;
varying vec3 vGt3Pos;
varying vec3 vGt3Nrm;

vec2 gt3AtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
\tvec2 pad = vec2( ${glslNum(p.padPx)} / ${glslNum(s)} );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float gt3CarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`;

  const fragmentMap = /* glsl */ `#include <map_fragment>
float gt3CarbonMask = 0.0;
if ( uGt3Enabled > 0.5 ) {
\tvec3 lp = vGt3Pos;
\tvec3 ln = normalize( vGt3Nrm );
\tvec3 span = max( uGt3Max - uGt3Min, vec3( 0.001 ) );

\t// 1) TOP panel: rect (0, 0, 1.0, ${topRect.h}/${s} = ${glslNum(topRect.h / s)})
\tvec2 uvTop = vec2( ( lp.z - uGt3Min.z ) / span.z, ( uGt3Max.x - lp.x ) / span.x );
\tvec3 colTop = texture2D( uGt3Atlas, gt3AtlasClamp( uvTop, vec2( ${glslNum(topRect.x / s)}, ${glslNum(topRect.y / s)} ), vec2( ${glslNum(topRect.w / s)}, ${glslNum(topRect.h / s)} ) ) ).rgb;

\t// 2) LEFT (+X) and RIGHT (-X) SIDE panels: rects (0, ${glslNum(leftRect.y / s)}, 1.0, ${glslNum(leftRect.h / s)}) and (0, ${glslNum(rightRect.y / s)}, 1.0, ${glslNum(rightRect.h / s)})
\tvec3 colSide;
\tfloat sideV = ( uGt3Max.y - lp.y ) / span.y;
\tif ( ln.x >= 0.0 ) {
\t\tfloat leftU = ( uGt3Max.z - lp.z ) / span.z;
\t\tcolSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( leftU, sideV ), vec2( ${glslNum(leftRect.x / s)}, ${glslNum(leftRect.y / s)} ), vec2( ${glslNum(leftRect.w / s)}, ${glslNum(leftRect.h / s)} ) ) ).rgb;
\t} else {
\t\tfloat rightU = ( lp.z - uGt3Min.z ) / span.z;
\t\tcolSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( rightU, sideV ), vec2( ${glslNum(rightRect.x / s)}, ${glslNum(rightRect.y / s)} ), vec2( ${glslNum(rightRect.w / s)}, ${glslNum(rightRect.h / s)} ) ) ).rgb;
\t}

\t// 3) REAR (-Z) and FRONT (+Z) panels: rects (0, ${glslNum(rearRect.y / s)}, ${glslNum(rearRect.w / s)}, ${glslNum(rearRect.h / s)}) and (${glslNum(frontRect.x / s)}, ${glslNum(frontRect.y / s)}, ${glslNum(frontRect.w / s)}, ${glslNum(frontRect.h / s)})
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( uGt3Max.x - lp.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvRear, vec2( ${glslNum(rearRect.x / s)}, ${glslNum(rearRect.y / s)} ), vec2( ${glslNum(rearRect.w / s)}, ${glslNum(rearRect.h / s)} ) ) ).rgb;
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - uGt3Min.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvFront, vec2( ${glslNum(frontRect.x / s)}, ${glslNum(frontRect.y / s)} ), vec2( ${glslNum(frontRect.w / s)}, ${glslNum(frontRect.h / s)} ) ) ).rgb;
\t}

\t// Sharp tri-orthographic weights so hood/door/rear graphics stay crisp with zero ghosting
\tfloat wx = pow( abs( ln.x ), ${glslNum(w.xPower)} );
\tfloat wy = pow( max( ln.y, 0.0 ) + ${glslFixed2(w.yNegScale)} * max( -ln.y, 0.0 ), ${glslNum(w.yPower)} );
\tfloat wz = pow( abs( ln.z ), ${glslNum(w.zPower)} );

\t// Keep gently sloped GT3 hoods sharp on the TOP projection
\tif ( lp.z > uGt3HoodStartZ && lp.y > 0.50 && ln.y > ${glslFixed2(w.hoodNyMin)} ) {
\t\twy *= ${glslNum(w.gt3HoodWyMul)};
\t}
\t// Rear wing mainplane top/rear crispness & wing endplate side crispness
\tif ( lp.z < uGt3WingRearZ && lp.y > 1.00 ) {
\t\tif ( abs( lp.x ) < ${glslFixed2(w.wingAbsXMax)} ) {
\t\t\tif ( ln.z < ${glslFixed2(w.wingRearNzMax)} ) wz = max( wz, ${glslNum(w.wingMainMinWeight)} );
\t\t\telse wy = max( wy, ${glslNum(w.wingMainMinWeight)} );
\t\t} else {
\t\t\twx = max( wx, ${glslNum(w.wingEndplateWxMin)} );
\t\t}
\t}

\tvec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );

\t// Keep the protruding AMG GT3 Evo front aero splitter tray exposed dark carbon fiber
\tif ( uGt3SplitterMaxY > 0.0 && lp.y < uGt3SplitterMaxY && lp.z > uGt3SplitterMinZ ) {
\t\tlivCol = vec3( 0.011, 0.012, 0.015 );
\t}

\tdiffuseColor.rgb = livCol;

\t// Detect exposed dark carbon regions (linear max channel < 0.025) for 2x2 twill weave roughness sheen
\tfloat maxC = max( livCol.r, max( livCol.g, livCol.b ) );
\tgt3CarbonMask = ( 1.0 - smoothstep( ${glslFixed3(c.smoothFrom)}, ${glslFixed3(c.smoothTo)}, maxC ) ) * uGt3CarbonStrength;
}`;

  const fragmentRoughness = /* glsl */ `#include <roughnessmap_fragment>
if ( gt3CarbonMask > 0.01 ) {
\tvec3 cn = abs( normalize( vGt3Nrm ) );
\tvec2 cp = cn.y > 0.6 ? vGt3Pos.xz : ( cn.x > 0.6 ? vGt3Pos.zy : vGt3Pos.xy );
\tfloat invPitch = 190.0;
\tvec3 dP = fwidth( vGt3Pos );
\tfloat towsPerPx = max( dP.x, max( dP.y, dP.z ) ) * invPitch;
\tfloat fade = ( 1.0 - smoothstep( 0.15, 0.32, towsPerPx ) ) * ( 1.0 - smoothstep( 8.0, 24.0, length( vViewPosition ) ) );
\tfloat twill = gt3CarbonTwill( cp * invPitch ) * fade * gt3CarbonMask;
\troughnessFactor = mix( roughnessFactor, 0.36, gt3CarbonMask * 0.72 ) + 0.055 * twill;
\tdiffuseColor.rgb *= 1.0 + 0.14 * twill;
}`;

  return { vertexPatch, vertexBody, fragmentPatch, fragmentMap, fragmentRoughness };
}

export const PORTED_LIVERY_SHADERS: F1LiveryShaderChunks = buildPortedLiveryShaders();
export const GT3_LIVERY_SHADERS: F1LiveryShaderChunks = buildGt3LiveryShaders();
