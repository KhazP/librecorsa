/**
 * Verification checks for F1 livery projection single-source-of-truth, image atlas loading & caching,
 * mod package atlas skins, and generated livery templates (`lc26`, `lc25`).
 *
 *   node scripts/verify/run-verify.mjs livery-atlas
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  F1_LIVERY_SHADERS,
  F1_PANEL_IDS,
  F1_PROJECTION,
  GT3_LIVERY_SHADERS,
  PORTED_LIVERY_SHADERS,
  PORTED_PANEL_IDS,
  PORTED_PROJECTION,
  buildF1LiveryShaders,
  buildGt3LiveryShaders,
  buildPortedLiveryShaders,
  f1ProjectToPanel,
  portedProjectToPanel,
  projectF1Point,
  projectPortedPoint,
  type F1PanelId,
  type PortedPanelId,
  type PortedProjectionProfile,
} from "../../src/lib/render/livery-projection";
import { atlasCacheKey, LIVERY_FINISH_PROFILES } from "../../src/lib/render/f1-livery-painter";
import { isProceduralPaintMesh, PROCEDURAL_BODY_PROFILES } from "../../src/lib/render/ported-procedural-livery";
import { carById, carSkinThumbUrl, portedSkinFor } from "../../src/lib/cars/car-registry";
import {
  LIVERIES,
  liveriesForCar,
  liveryAppliesToCar,
  modF1Liveries,
  registerModF1Liveries,
  resolveLivery,
} from "../../src/lib/track-data";
import { manifestFiles, validateModManifest } from "../../src/lib/mods/mod-manifest";
import { modDefinitions, registerModContent } from "../../src/lib/mods/mod-content";
import { sanitizePacket } from "../../src/lib/net/wire";
import { checkPackage, readImageDimensions } from "../mods/lib/package-check";
import {
  assertLabelsOffPaintedGeometry,
  buildF1VectorLayers,
  buildPortedVectorLayers,
  CLAMP_EDGE_STRIP_PX,
  LIVERY_TEMPLATE_TARGETS,
  loadPaintGeometry,
  rasterizeTemplateMasks,
} from "../cars/build-livery-templates";
import type { LiveryConfig } from "../../src/types/f1";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// Exact pre-refactor snapshot of the 5 F1 GLSL shader strings from src/lib/render/f1-livery-painter.ts
const SNAPSHOT_F1_SHADERS = {
  vertexPatch: `#include <common>
uniform mat4 uLiveryFrame;
varying vec3 vLivPos;
varying vec3 vLivNrm;`,
  vertexBody: `#include <begin_vertex>
vLivPos = ( uLiveryFrame * vec4( position, 1.0 ) ).xyz;
vLivNrm = normalize( mat3( uLiveryFrame ) * normal );`,
  fragmentPatch: `#include <common>
uniform sampler2D uLiveryAtlas;
uniform float uLiveryEnabled;
uniform float uLiveryCarbonStrength;
varying vec3 vLivPos;
varying vec3 vLivNrm;

vec2 f1AtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
\tvec2 pad = vec2( 2.0 / 2048.0 );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float f1CarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`,
  fragmentMap: `#include <map_fragment>
float f1CarbonMask = 0.0;
if ( uLiveryEnabled > 0.5 ) {
\tvec3 lp = vLivPos;
\tvec3 ln = normalize( vLivNrm );

\t// 1) TOP panel: rect (0, 0, 1, 768/2048)
\tvec2 uvTop = vec2( ( lp.z - (-2.75) ) / 5.60, (0.95 - lp.x) / 1.90 );
\tvec3 colTop = texture2D( uLiveryAtlas, f1AtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.375 ) ) ).rgb;

\t// 2) SIDE panel: Left (+X), Right (-X), or dedicated Front Wing Endplates (|x|>0.55 & z>1.75)
\tvec3 colSide;
\tbool isLeftSide = ln.x >= 0.0;
\tif ( lp.z > 1.75 && abs( lp.x ) > 0.55 ) {
\t\tfloat fwU = isLeftSide ? ( 2.75 - lp.z ) / 0.95 : ( lp.z - 1.80 ) / 0.95;
\t\tfloat fwV = ( 0.46 - lp.y ) / 0.38;
\t\tfloat fwY0 = isLeftSide ? 0.84375 : 0.921875;
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( vec2( fwU, fwV ), vec2( 0.75, fwY0 ), vec2( 0.25, 0.078125 ) ) ).rgb;
\t} else if ( isLeftSide ) {
\t\tvec2 uvL = vec2( (2.85 - lp.z) / 5.60, (1.15 - lp.y) / 1.15 );
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvL, vec2( 0.0, 0.375 ), vec2( 1.0, 0.234375 ) ) ).rgb;
\t} else {
\t\tvec2 uvR = vec2( ( lp.z - (-2.75) ) / 5.60, (1.15 - lp.y) / 1.15 );
\t\tcolSide = texture2D( uLiveryAtlas, f1AtlasClamp( uvR, vec2( 0.0, 0.609375 ), vec2( 1.0, 0.234375 ) ) ).rgb;
\t}

\t// The halo's inner faces (above the cockpit rim, facing the car's centre line) would take the far side's panel and
\t// its halo sponsor, squeezed onto the curved tube: they take the top view's colour, like the rest of the hoop
\tif ( lp.y > 0.80 && lp.z > -0.06 && lp.z < 0.70 && abs( lp.x ) < 0.36 && ln.x * lp.x < 0.0 ) {
\t\tcolSide = colTop;
\t}

\t// 3) REAR / FRONT face panel
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( 0.65 - lp.x ) / 1.30, ( 1.00 - lp.y ) / 0.65 );
\t\tcolEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
\t\t// The rear panel's upper part is the rear wing's face (its title banner spans y 0.71..0.91): projected along Z it
\t\t// also landed on every rear-facing surface ahead of the gearbox at that height, the halo's front arc above all,
\t\t// where the banner showed as smeared letter slices across the hoop. Those take the top view's colour; lower down
\t\t// the panel is plain carbon and stays
\t\tfloat midCar = smoothstep( -1.40, -1.30, lp.z ) * smoothstep( 0.60, 0.64, lp.y );
\t\tcolEnd = mix( colEnd, colTop, midCar );
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - (-0.95) ) / 1.90, ( 0.65 - lp.y ) / 0.57 );
\t\tcolEnd = texture2D( uLiveryAtlas, f1AtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.25, 0.15625 ) ) ).rgb;
\t}

\t// Sharp tri-orthographic weights so top/side/rear text stays crisp without ghosting
\tfloat wx = pow( abs( ln.x ), 4.0 );
\tfloat wy = pow( max( ln.y, 0.0 ) + 0.35 * max( -ln.y, 0.0 ), 4.0 );
\tfloat wz = pow( abs( ln.z ), 6.0 );
\t// Ensure the angled rear wing mainplane & DRS flap face shows the crisp chase-cam rear banner
\tif ( lp.z < -2.02 && lp.y > 0.58 && abs( lp.x ) < 0.52 && ln.z < -0.22 ) {
\t\twz = max( wz, 4.0 );
\t}
\tvec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );
\tdiffuseColor.rgb = livCol;

\t// Detect exposed dark carbon regions (linear max channel < 0.028) for subtle 2x2 twill sheen modulation
\tfloat maxC = max( livCol.r, max( livCol.g, livCol.b ) );
\tf1CarbonMask = ( 1.0 - smoothstep( 0.016, 0.032, maxC ) ) * uLiveryCarbonStrength;
}`,
  fragmentRoughness: `#include <roughnessmap_fragment>
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
}`,
} as const;

// Exact pre-refactor snapshot of the 5 ported procedural GLSL shader strings from src/lib/render/ported-procedural-livery.ts
const SNAPSHOT_PORTED_SHADERS = {
  vertexPatch: `#include <common>
uniform mat4 uProcFrame;
varying vec3 vProcPos;
varying vec3 vProcNrm;`,
  vertexBody: `#include <begin_vertex>
vProcPos = ( uProcFrame * vec4( position, 1.0 ) ).xyz;
vProcNrm = normalize( mat3( uProcFrame ) * normal );`,
  fragmentPatch: `#include <common>
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
uniform float uProcFlipBackfacing;
varying vec3 vProcPos;
varying vec3 vProcNrm;

vec2 procAtlasClamp( vec2 uv, vec2 rectOrigin, vec2 rectSize ) {
\tvec2 pad = vec2( 2.0 / 2048.0 );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float procCarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`,
  fragmentMap: `#include <map_fragment>
float procCarbonMask = 0.0;
if ( uProcEnabled > 0.5 ) {
\tvec3 lp = vProcPos;
\tvec3 ln = normalize( vProcNrm );
\tif ( uProcFlipBackfacing > 0.5 && !gl_FrontFacing ) {
\t\tln = -ln;
\t}
\tvec3 span = max( uProcMax - uProcMin, vec3( 0.001 ) );

\t// 1) TOP panel: rect (0, 0, 1.0, 832/2048 = 0.40625)
\tvec2 uvTop = vec2( ( lp.z - uProcMin.z ) / span.z, ( uProcMax.x - lp.x ) / span.x );
\tvec3 colTop = texture2D( uProcAtlas, procAtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.40625 ) ) ).rgb;

\t// 2) LEFT (+X) and RIGHT (-X) SIDE panels
\tvec3 colSide;
\tfloat sideV = ( uProcMax.y - lp.y ) / span.y;
\tif ( ln.x >= 0.0 ) {
\t\tfloat leftU = ( uProcMax.z - lp.z ) / span.z;
\t\tcolSide = texture2D( uProcAtlas, procAtlasClamp( vec2( leftU, sideV ), vec2( 0.0, 0.40625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
\t} else {
\t\tfloat rightU = ( lp.z - uProcMin.z ) / span.z;
\t\tcolSide = texture2D( uProcAtlas, procAtlasClamp( vec2( rightU, sideV ), vec2( 0.0, 0.625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
\t}

\t// 3) REAR (-Z) and FRONT (+Z) panels
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( uProcMax.x - lp.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uProcAtlas, procAtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - uProcMin.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uProcAtlas, procAtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
\t}

\tfloat wx = pow( abs( ln.x ), 4.0 );
\tfloat wy = pow( max( ln.y, 0.0 ) + 0.30 * max( -ln.y, 0.0 ), 4.0 );
\tfloat wz = pow( abs( ln.z ), 5.0 );

\t// Keep sloped hoods / prototype noses sharp on the TOP projection
\tif ( lp.z > uProcHoodStartZ && lp.y > uProcHoodMinY && ln.y > 0.42 ) {
\t\twy *= 2.6;
\t}
\t// Rear wing mainplane top/rear crispness & wing endplate side crispness
\tif ( lp.z < uProcWingRearZ && lp.y > uProcWingMinY ) {
\t\tif ( abs( lp.x ) < 0.86 ) {
\t\t\tif ( ln.z < -0.35 ) wz = max( wz, 3.5 );
\t\t\telse wy = max( wy, 3.5 );
\t\t} else {
\t\t\twx = max( wx, 4.0 );
\t\t}
\t}

\tvec3 livCol = ( colTop * wy + colSide * wx + colEnd * wz ) / max( wx + wy + wz, 1e-4 );

\t// Keep the protruding AMG GT3 Evo front aero splitter tray exposed dark carbon fiber
\tif ( uProcSplitterMaxY > 0.0 && lp.y < uProcSplitterMaxY && lp.z > uProcSplitterMinZ ) {
\t\tlivCol = vec3( 0.011, 0.012, 0.015 );
\t}

\tdiffuseColor.rgb = livCol;

\tfloat maxC = max( livCol.r, max( livCol.g, livCol.b ) );
\tprocCarbonMask = ( 1.0 - smoothstep( 0.014, 0.028, maxC ) ) * uProcCarbonStrength;
}`,
  fragmentRoughness: `#include <roughnessmap_fragment>
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
}`,
} as const;

// Exact pre-refactor snapshot of the 5 GT3 GLSL shader strings from src/lib/render/gt3-livery-painter.ts
const SNAPSHOT_GT3_SHADERS = {
  vertexPatch: `#include <common>
uniform mat4 uGt3Frame;
varying vec3 vGt3Pos;
varying vec3 vGt3Nrm;`,
  vertexBody: `#include <begin_vertex>
vGt3Pos = ( uGt3Frame * vec4( position, 1.0 ) ).xyz;
vGt3Nrm = normalize( mat3( uGt3Frame ) * normal );`,
  fragmentPatch: `#include <common>
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
\tvec2 pad = vec2( 2.0 / 2048.0 );
\tvec2 clamped = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );
\treturn rectOrigin + pad + clamped * max( rectSize - pad * 2.0, vec2( 0.0001 ) );
}

float gt3CarbonTwill( vec2 p ) {
\tvec2 c = floor( p );
\tfloat warp = step( mod( c.x + c.y, 4.0 ), 1.5 );
\treturn 2.0 * warp - 1.0;
}`,
  fragmentMap: `#include <map_fragment>
float gt3CarbonMask = 0.0;
if ( uGt3Enabled > 0.5 ) {
\tvec3 lp = vGt3Pos;
\tvec3 ln = normalize( vGt3Nrm );
\tvec3 span = max( uGt3Max - uGt3Min, vec3( 0.001 ) );

\t// 1) TOP panel: rect (0, 0, 1.0, 832/2048 = 0.40625)
\tvec2 uvTop = vec2( ( lp.z - uGt3Min.z ) / span.z, ( uGt3Max.x - lp.x ) / span.x );
\tvec3 colTop = texture2D( uGt3Atlas, gt3AtlasClamp( uvTop, vec2( 0.0, 0.0 ), vec2( 1.0, 0.40625 ) ) ).rgb;

\t// 2) LEFT (+X) and RIGHT (-X) SIDE panels: rects (0, 0.40625, 1.0, 0.21875) and (0, 0.625, 1.0, 0.21875)
\tvec3 colSide;
\tfloat sideV = ( uGt3Max.y - lp.y ) / span.y;
\tif ( ln.x >= 0.0 ) {
\t\tfloat leftU = ( uGt3Max.z - lp.z ) / span.z;
\t\tcolSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( leftU, sideV ), vec2( 0.0, 0.40625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
\t} else {
\t\tfloat rightU = ( lp.z - uGt3Min.z ) / span.z;
\t\tcolSide = texture2D( uGt3Atlas, gt3AtlasClamp( vec2( rightU, sideV ), vec2( 0.0, 0.625 ), vec2( 1.0, 0.21875 ) ) ).rgb;
\t}

\t// 3) REAR (-Z) and FRONT (+Z) panels: rects (0, 0.84375, 0.5, 0.15625) and (0.5, 0.84375, 0.5, 0.15625)
\tvec3 colEnd;
\tif ( ln.z < 0.0 ) {
\t\tvec2 uvRear = vec2( ( uGt3Max.x - lp.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvRear, vec2( 0.0, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
\t} else {
\t\tvec2 uvFront = vec2( ( lp.x - uGt3Min.x ) / span.x, sideV );
\t\tcolEnd = texture2D( uGt3Atlas, gt3AtlasClamp( uvFront, vec2( 0.5, 0.84375 ), vec2( 0.5, 0.15625 ) ) ).rgb;
\t}

\t// Sharp tri-orthographic weights so hood/door/rear graphics stay crisp with zero ghosting
\tfloat wx = pow( abs( ln.x ), 4.0 );
\tfloat wy = pow( max( ln.y, 0.0 ) + 0.30 * max( -ln.y, 0.0 ), 4.0 );
\tfloat wz = pow( abs( ln.z ), 5.0 );

\t// Keep gently sloped GT3 hoods sharp on the TOP projection
\tif ( lp.z > uGt3HoodStartZ && lp.y > 0.50 && ln.y > 0.42 ) {
\t\twy *= 2.4;
\t}
\t// Rear wing mainplane top/rear crispness & wing endplate side crispness
\tif ( lp.z < uGt3WingRearZ && lp.y > 1.00 ) {
\t\tif ( abs( lp.x ) < 0.86 ) {
\t\t\tif ( ln.z < -0.35 ) wz = max( wz, 3.5 );
\t\t\telse wy = max( wy, 3.5 );
\t\t} else {
\t\t\twx = max( wx, 4.0 );
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
\tgt3CarbonMask = ( 1.0 - smoothstep( 0.014, 0.028, maxC ) ) * uGt3CarbonStrength;
}`,
  fragmentRoughness: `#include <roughnessmap_fragment>
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
}`,
} as const;

/** Independent literal port of the ported procedural GLSL shader math to cross-check `projectPortedPoint` */
function evalGlslPorted(
  lp: readonly [number, number, number],
  rawNrm: readonly [number, number, number],
  profile: PortedProjectionProfile,
  sampleAtlas: (u: number, v: number) => [number, number, number],
  frontFacing = true
): { rgb: [number, number, number]; forcedCarbon: boolean } {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const procAtlasClamp = (u: number, v: number, ox: number, oy: number, sx: number, sy: number): [number, number] => {
    const pad = 2.0 / 2048.0;
    const cu = clamp(u, 0, 1);
    const cv = clamp(v, 0, 1);
    return [ox + pad + cu * Math.max(sx - pad * 2, 0.0001), oy + pad + cv * Math.max(sy - pad * 2, 0.0001)];
  };
  const len = Math.hypot(rawNrm[0], rawNrm[1], rawNrm[2]);
  const sign = profile.flipBackfacing && !frontFacing ? -1 : 1;
  const ln: [number, number, number] = [(rawNrm[0] / len) * sign, (rawNrm[1] / len) * sign, (rawNrm[2] / len) * sign];
  const spanX = Math.max(profile.max[0] - profile.min[0], 0.001);
  const spanY = Math.max(profile.max[1] - profile.min[1], 0.001);
  const spanZ = Math.max(profile.max[2] - profile.min[2], 0.001);

  const uvTop = procAtlasClamp((lp[2] - profile.min[2]) / spanZ, (profile.max[0] - lp[0]) / spanX, 0.0, 0.0, 1.0, 0.40625);
  const colTop = sampleAtlas(uvTop[0], uvTop[1]);

  const sideV = (profile.max[1] - lp[1]) / spanY;
  const colSide =
    ln[0] >= 0
      ? sampleAtlas(...procAtlasClamp((profile.max[2] - lp[2]) / spanZ, sideV, 0.0, 0.40625, 1.0, 0.21875))
      : sampleAtlas(...procAtlasClamp((lp[2] - profile.min[2]) / spanZ, sideV, 0.0, 0.625, 1.0, 0.21875));

  const colEnd =
    ln[2] < 0
      ? sampleAtlas(...procAtlasClamp((profile.max[0] - lp[0]) / spanX, sideV, 0.0, 0.84375, 0.5, 0.15625))
      : sampleAtlas(...procAtlasClamp((lp[0] - profile.min[0]) / spanX, sideV, 0.5, 0.84375, 0.5, 0.15625));

  let wx = Math.pow(Math.abs(ln[0]), 4.0);
  let wy = Math.pow(Math.max(ln[1], 0) + 0.3 * Math.max(-ln[1], 0), 4.0);
  let wz = Math.pow(Math.abs(ln[2]), 5.0);

  if (lp[2] > profile.hoodStartZ && lp[1] > profile.hoodMinY && ln[1] > 0.42) wy *= 2.6;
  if (lp[2] < profile.wingRearZ && lp[1] > profile.wingMinY) {
    if (Math.abs(lp[0]) < 0.86) {
      if (ln[2] < -0.35) wz = Math.max(wz, 3.5);
      else wy = Math.max(wy, 3.5);
    } else {
      wx = Math.max(wx, 4.0);
    }
  }

  const denom = Math.max(wx + wy + wz, 1e-4);
  const forcedCarbon = profile.splitterMaxY > 0 && lp[1] < profile.splitterMaxY && lp[2] > profile.splitterMinZ;
  return {
    rgb: forcedCarbon
      ? [0.011, 0.012, 0.015]
      : [
          (colTop[0] * wy + colSide[0] * wx + colEnd[0] * wz) / denom,
          (colTop[1] * wy + colSide[1] * wx + colEnd[1] * wz) / denom,
          (colTop[2] * wy + colSide[2] * wx + colEnd[2] * wz) / denom,
        ],
    forcedCarbon,
  };
}

/** Independent literal port of the GLSL shader math to cross-check `projectF1Point` */
function evalGlslF1(
  lp: readonly [number, number, number],
  rawNrm: readonly [number, number, number],
  sampleAtlas: (u: number, v: number) => [number, number, number]
): [number, number, number] {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const f1AtlasClamp = (u: number, v: number, ox: number, oy: number, sx: number, sy: number): [number, number] => {
    const pad = 2.0 / 2048.0;
    const cu = clamp(u, 0, 1);
    const cv = clamp(v, 0, 1);
    return [ox + pad + cu * Math.max(sx - pad * 2, 0.0001), oy + pad + cv * Math.max(sy - pad * 2, 0.0001)];
  };
  const len = Math.hypot(rawNrm[0], rawNrm[1], rawNrm[2]);
  const ln: [number, number, number] = [rawNrm[0] / len, rawNrm[1] / len, rawNrm[2] / len];

  const uvTop = f1AtlasClamp((lp[2] - -2.75) / 5.6, (0.95 - lp[0]) / 1.9, 0.0, 0.0, 1.0, 0.375);
  const colTop = sampleAtlas(uvTop[0], uvTop[1]);

  let colSide: [number, number, number];
  const isLeftSide = ln[0] >= 0;
  if (lp[2] > 1.75 && Math.abs(lp[0]) > 0.55) {
    const fwU = isLeftSide ? (2.75 - lp[2]) / 0.95 : (lp[2] - 1.8) / 0.95;
    const fwV = (0.46 - lp[1]) / 0.38;
    const fwY0 = isLeftSide ? 0.84375 : 0.921875;
    const uvFw = f1AtlasClamp(fwU, fwV, 0.75, fwY0, 0.25, 0.078125);
    colSide = sampleAtlas(uvFw[0], uvFw[1]);
  } else if (isLeftSide) {
    const uvL = f1AtlasClamp((2.85 - lp[2]) / 5.6, (1.15 - lp[1]) / 1.15, 0.0, 0.375, 1.0, 0.234375);
    colSide = sampleAtlas(uvL[0], uvL[1]);
  } else {
    const uvR = f1AtlasClamp((lp[2] - -2.75) / 5.6, (1.15 - lp[1]) / 1.15, 0.0, 0.609375, 1.0, 0.234375);
    colSide = sampleAtlas(uvR[0], uvR[1]);
  }
  if (lp[1] > 0.8 && lp[2] > -0.06 && lp[2] < 0.7 && Math.abs(lp[0]) < 0.36 && ln[0] * lp[0] < 0) {
    colSide = colTop;
  }

  let colEnd: [number, number, number];
  if (ln[2] < 0) {
    const uvRear = f1AtlasClamp((0.65 - lp[0]) / 1.3, (1.0 - lp[1]) / 0.65, 0.0, 0.84375, 0.5, 0.15625);
    colEnd = sampleAtlas(uvRear[0], uvRear[1]);
    const midCar = smoothstep(-1.4, -1.3, lp[2]) * smoothstep(0.6, 0.64, lp[1]);
    colEnd = [
      colEnd[0] + (colTop[0] - colEnd[0]) * midCar,
      colEnd[1] + (colTop[1] - colEnd[1]) * midCar,
      colEnd[2] + (colTop[2] - colEnd[2]) * midCar,
    ];
  } else {
    const uvFront = f1AtlasClamp((lp[0] - -0.95) / 1.9, (0.65 - lp[1]) / 0.57, 0.5, 0.84375, 0.25, 0.15625);
    colEnd = sampleAtlas(uvFront[0], uvFront[1]);
  }

  const wx = Math.pow(Math.abs(ln[0]), 4.0);
  const wy = Math.pow(Math.max(ln[1], 0) + 0.35 * Math.max(-ln[1], 0), 4.0);
  let wz = Math.pow(Math.abs(ln[2]), 6.0);
  if (lp[2] < -2.02 && lp[1] > 0.58 && Math.abs(lp[0]) < 0.52 && ln[2] < -0.22) {
    wz = Math.max(wz, 4.0);
  }
  const denom = Math.max(wx + wy + wz, 1e-4);
  return [
    (colTop[0] * wy + colSide[0] * wx + colEnd[0] * wz) / denom,
    (colTop[1] * wy + colSide[1] * wx + colEnd[1] * wz) / denom,
    (colTop[2] * wy + colSide[2] * wx + colEnd[2] * wz) / denom,
  ];
}

async function main(): Promise<void> {
  console.log("F1 livery atlas projection, mods & templates");

  await check("generated F1 GLSL shader strings are character-for-character identical to pre-refactor snapshot", () => {
    const built = buildF1LiveryShaders();
    assert.equal(built.vertexPatch, SNAPSHOT_F1_SHADERS.vertexPatch, "vertexPatch mismatch");
    assert.equal(built.vertexBody, SNAPSHOT_F1_SHADERS.vertexBody, "vertexBody mismatch");
    assert.equal(built.fragmentPatch, SNAPSHOT_F1_SHADERS.fragmentPatch, "fragmentPatch mismatch");
    assert.equal(built.fragmentMap, SNAPSHOT_F1_SHADERS.fragmentMap, "fragmentMap mismatch");
    assert.equal(built.fragmentRoughness, SNAPSHOT_F1_SHADERS.fragmentRoughness, "fragmentRoughness mismatch");
    assert.deepEqual(F1_LIVERY_SHADERS, SNAPSHOT_F1_SHADERS);
  });

  await check("TS projection math matches literal GLSL shader evaluation across all panels and special regions", () => {
    // Encode continuous atlas coordinates + panel-index hash into RGB so any UV or weight drift fails immediately
    const syntheticAtlas = (u: number, v: number): [number, number, number] => [u, v, u * 0.7 + v * 0.3];

    const samples: { name: string; pos: [number, number, number]; nrm: [number, number, number]; expectDominant: F1PanelId }[] = [
      { name: "top nose deck", pos: [0.0, 0.45, 1.32], nrm: [0.0, 0.96, 0.28], expectDominant: "top" },
      { name: "left sidepod", pos: [0.62, 0.42, -0.34], nrm: [0.95, 0.3, 0.05], expectDominant: "left" },
      { name: "right sidepod", pos: [-0.62, 0.42, -0.34], nrm: [-0.95, 0.3, 0.05], expectDominant: "right" },
      { name: "front wing endplate left", pos: [0.85, 0.3, 2.3], nrm: [1.0, 0.0, 0.0], expectDominant: "fwEndplateLeft" },
      { name: "front wing endplate right", pos: [-0.85, 0.3, 2.3], nrm: [-1.0, 0.0, 0.0], expectDominant: "fwEndplateRight" },
      { name: "halo inner face override", pos: [0.22, 0.88, 0.2], nrm: [-0.98, 0.15, 0.1], expectDominant: "top" },
      { name: "rear wing mainplane chase face", pos: [0.0, 0.81, -2.32], nrm: [0.0, 0.55, -0.83], expectDominant: "rear" },
      { name: "mid-car rear-facing halo arc", pos: [0.0, 0.86, 0.4], nrm: [0.0, 0.1, -0.99], expectDominant: "top" },
      { name: "mid-car low rear face keeps rear panel", pos: [0.0, 0.42, -0.8], nrm: [0.0, 0.0, -1.0], expectDominant: "rear" },
      { name: "front nose tip", pos: [0.0, 0.32, 2.7], nrm: [0.0, 0.1, 0.99], expectDominant: "front" },
      { name: "lc25 clamped front wing tip left", pos: [1.049, 0.2, 2.5], nrm: [0.0, 1.0, 0.0], expectDominant: "top" },
      { name: "lc25 clamped rear tail", pos: [0.0, 0.7, -2.768], nrm: [-1.0, 0.0, 0.0], expectDominant: "right" },
    ];

    for (const s of samples) {
      const ts = projectF1Point(s.pos, s.nrm);
      assert.equal(ts.dominantPanel, s.expectDominant, `${s.name}: expected ${s.expectDominant}, got ${ts.dominantPanel}`);

      // Blend synthetic atlas using TS panelWeights + f1ProjectToPanel
      const tsRgb: [number, number, number] = [0, 0, 0];
      let wTotal = 0;
      for (const pid of F1_PANEL_IDS) {
        const w = ts.panelWeights[pid] ?? 0;
        if (w <= 0) continue;
        wTotal += w;
        const sample = f1ProjectToPanel(pid, s.pos[0], s.pos[1], s.pos[2]);
        const c = syntheticAtlas(sample.u, sample.v);
        tsRgb[0] += c[0] * w;
        tsRgb[1] += c[1] * w;
        tsRgb[2] += c[2] * w;
      }
      assert.ok(Math.abs(wTotal - 1) < 1e-6, `${s.name}: panelWeights sum ${wTotal} != 1`);

      const glslRgb = evalGlslF1(s.pos, s.nrm, syntheticAtlas);
      for (let c = 0; c < 3; c++) {
        assert.ok(
          Math.abs(tsRgb[c] - glslRgb[c]) < 1e-6,
          `${s.name} channel ${c}: TS=${tsRgb[c]} vs GLSL=${glslRgb[c]}`
        );
      }
    }

    // Verify left side runs Z reversed relative to right side
    const leftNose = f1ProjectToPanel("left", 0.5, 0.5, 2.0);
    const leftRear = f1ProjectToPanel("left", 0.5, 0.5, -2.0);
    const rightNose = f1ProjectToPanel("right", -0.5, 0.5, 2.0);
    const rightRear = f1ProjectToPanel("right", -0.5, 0.5, -2.0);
    assert.ok(leftNose.px < leftRear.px, "left side nose (+Z) must map left of rear (-Z)");
    assert.ok(rightNose.px > rightRear.px, "right side nose (+Z) must map right of rear (-Z)");
  });

  await check("atlasCacheKey includes image URL and car eligibility hides single-body image liveries from the other car", () => {
    const base: LiveryConfig = {
      id: "mod:acme.f1/alpha",
      name: "Alpha Painted",
      team: "Acme",
      primary: "#112233",
      secondary: "#445566",
      accent: "#ff0044",
      number: "",
      category: "mod",
      atlas: { lc26: "/mods/acme.f1/skins/alpha/atlas-a.png" },
      finish: "gloss",
    };
    const otherUrl: LiveryConfig = { ...base, atlas: { lc26: "/mods/acme.f1/skins/alpha/atlas-b.png" } };
    assert.notEqual(atlasCacheKey(base, "lc26"), atlasCacheKey(otherUrl, "lc26"), "cache key must change with image URL");
    assert.equal(liveryAppliesToCar(base, "lc26"), true);
    assert.equal(liveryAppliesToCar(base, "lc25"), false);

    // With procedural visual fallback, the livery applies to both bodies
    const hybrid: LiveryConfig = { ...base, visual: LIVERIES[0].visual };
    assert.equal(liveryAppliesToCar(hybrid, "lc26"), true);
    assert.equal(liveryAppliesToCar(hybrid, "lc25"), true);

    registerModF1Liveries([base]);
    try {
      assert.ok(liveriesForCar("lc26").some((l) => l.id === base.id), "lc26 picker must include lc26 atlas livery");
      assert.ok(!liveriesForCar("lc25").some((l) => l.id === base.id), "lc25 picker must exclude lc26-only atlas livery");
      assert.equal(resolveLivery(base.id, null, "lc26").id, base.id);
      assert.equal(resolveLivery(base.id, null, "lc25").id, LIVERIES[0].id);
      assert.equal(LIVERIES.length, 20, "built-in LIVERIES array must remain untouched");
    } finally {
      registerModF1Liveries([]);
    }

    // Multiplayer wire sanitizer drops mod: liveryIds so mod liveries stay strictly local
    const pkt = sanitizePacket({
      peerId: "p1",
      driverCode: "TST",
      teamColorHex: "#ffffff",
      liveryId: "mod:acme.f1/alpha",
      timestampMs: 1000,
      pos: [0, 0, 0],
      quat: [0, 0, 0, 1],
      linVel: [0, 0, 0],
      angVel: [0, 0, 0],
      steerAngle: 0,
      wheelRPMs: [0, 0, 0, 0],
      throttle: 0,
      brake: 0,
      trackS: 0,
      speedKmh: 0,
    });
    assert.ok(pkt && pkt.liveryId === undefined, "wire sanitizer must drop mod: liveryId");
  });

  await check("mod manifest validates F1 atlas skins, rejects invalid ones, and registers them cleanly", () => {
    const known = modDefinitions();
    assert.ok(known.atlasCars.has("lc26") && known.atlasCars.has("lc25"), "atlasCars must include lc26 and lc25");

    const makeManifest = (skins: unknown[]) => ({
      format: 1,
      id: "jdoe.f1-pack",
      name: "F1 Painted Pack",
      version: "1.0.0",
      credit: { author: "J. Doe", license: "CC BY 4.0" },
      skins,
    });

    const ok = validateModManifest(
      makeManifest([
        { car: "lc26", id: "teal", name: "Teal Works", swatch: ["#00a896", "#111827", "#f0f3bd"], atlas: "atlas.png", finish: "metallic" },
        { car: "lc25", id: "crimson", name: "Crimson 25", swatch: ["#b91c1c", "#111827"], dir: "custom/crimson", atlas: "body.webp" },
      ]),
      known
    );
    assert.equal(ok.ok, true, ok.ok ? "" : ok.errors.join("; "));
    if (ok.ok) {
      const files = manifestFiles(ok.manifest);
      assert.ok(files.includes("skins/teal/atlas.png"), "default skin dir + atlas file must be in manifestFiles");
      assert.ok(files.includes("custom/crimson/body.webp"), "custom skin dir + atlas file must be in manifestFiles");

      const origin = { packageId: ok.manifest.id, packageName: ok.manifest.name, version: ok.manifest.version };
      registerModContent([{ manifest: ok.manifest, origin }]);
      try {
        const mods = modF1Liveries();
        assert.equal(mods.length, 2);
        assert.equal(mods[0].id, "mod:jdoe.f1-pack/teal");
        assert.equal(mods[0].atlas?.lc26, "/mods/jdoe.f1-pack/skins/teal/atlas.png");
        assert.equal(mods[0].finish, "metallic");
        assert.equal(mods[0].thumbUrl, "/mods/jdoe.f1-pack/skins/teal/thumb.webp");
        assert.equal(mods[1].atlas?.lc25, "/mods/jdoe.f1-pack/custom/crimson/body.webp");
        assert.equal(mods[1].finish, "gloss", "default finish for atlas livery must be gloss");
        assert.ok(mods[1].finish! in LIVERY_FINISH_PROFILES);
      } finally {
        registerModContent([]);
      }
      assert.equal(modF1Liveries().length, 0, "registerModContent([]) must clear mod F1 liveries");
    }

    // Rejections
    const mustFail = (skins: unknown[], pattern: RegExp, label: string) => {
      const r = validateModManifest(makeManifest(skins), known);
      assert.equal(r.ok, false, `${label}: expected failure`);
      assert.ok(r.errors.some((e) => pattern.test(e)), `${label}: expected ${pattern}, got ${r.errors.join("; ")}`);
    };
    mustFail([{ car: "lc26", id: "x", name: "X", swatch: ["#111111", "#ffffff"] }], /skins\[0\]\.car.*atlas/i, "lc26 without atlas");
    mustFail([{ car: "lc25", id: "x", name: "X", swatch: ["#111111", "#ffffff"] }], /skins\[0\]\.car.*atlas/i, "lc25 without atlas");
    mustFail([{ car: "lc26", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "atlas.gif" }], /skins\[0\]\.atlas/, "unsupported gif");
    mustFail([{ car: "lc26", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "../atlas.png" }], /skins\[0\]\.atlas/, "path traversal");
    mustFail([{ car: "lc26", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "atlas.png", files: ["a.png"] }], /skins\[0\]\.files/, "atlas + files together");
    mustFail([{ car: "mtr-496r", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "atlas.png" }], /skins\[0\]\.car.*lc26/, "atlas on non-atlas car");
    mustFail([{ car: "lc26", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "atlas.png", finish: "sparkle" }], /skins\[0\]\.finish/, "invalid finish");
  });

  await check("mod check validates atlas image dimensions (1024..4096 square, warns if not 2048)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "livery-atlas-check-"));
    try {
      const makePkg = async (name: string, width: number, height: number, ext: "png" | "webp" | "jpg" = "png") => {
        const dir = join(tmp, name);
        mkdirSync(join(dir, "skins", "a"), { recursive: true });
        writeFileSync(
          join(dir, "mod.json"),
          JSON.stringify({
            format: 1,
            id: "jdoe.atlas-test",
            name: "Atlas Test",
            version: "1.0.0",
            credit: { author: "J. Doe", license: "CC BY 4.0" },
            skins: [{ car: "lc26", id: "a", name: "A", swatch: ["#112233", "#eeeeee"], atlas: `atlas.${ext}` }],
          })
        );
        const img = sharp({ create: { width, height, channels: 3, background: { r: 20, g: 40, b: 80 } } });
        const buf =
          ext === "png"
            ? await img.png().toBuffer()
            : ext === "webp"
              ? await img.webp().toBuffer()
              : await img.jpeg().toBuffer();
        assert.deepEqual(readImageDimensions(buf), { width, height }, `readImageDimensions ${ext} ${width}x${height}`);
        writeFileSync(join(dir, "skins", "a", `atlas.${ext}`), buf);
        return checkPackage(dir);
      };

      const ok2048 = await makePkg("ok2048", 2048, 2048, "png");
      assert.equal(ok2048.ok, true, ok2048.problems.join("; "));
      assert.equal(ok2048.warnings?.length ?? 0, 0, "2048x2048 should have no warnings");

      const okWebp = await makePkg("okWebp", 2048, 2048, "webp");
      assert.equal(okWebp.ok, true, okWebp.problems.join("; "));

      const okJpg = await makePkg("okJpg", 2048, 2048, "jpg");
      assert.equal(okJpg.ok, true, okJpg.problems.join("; "));

      const warn1024 = await makePkg("warn1024", 1024, 1024, "png");
      assert.equal(warn1024.ok, true, warn1024.problems.join("; "));
      assert.ok(warn1024.warnings?.some((w) => /2048x2048/.test(w)), "1024x1024 should warn recommending 2048x2048");

      const warn4096 = await makePkg("warn4096", 4096, 4096, "png");
      assert.equal(warn4096.ok, true, warn4096.problems.join("; "));
      assert.ok(warn4096.warnings?.some((w) => /2048x2048/.test(w)), "4096x4096 should warn recommending 2048x2048");

      const badRect = await makePkg("badRect", 2048, 1024, "png");
      assert.equal(badRect.ok, false);
      assert.ok(badRect.problems.some((p) => /square/.test(p)));

      const badSmall = await makePkg("badSmall", 512, 512, "png");
      assert.equal(badSmall.ok, false);
      assert.ok(badSmall.problems.some((p) => /1024\.\.4096/.test(p)));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  await check("generated ported & GT3 GLSL shader strings are character-for-character identical to pre-refactor snapshots", () => {
    const ported = buildPortedLiveryShaders();
    assert.equal(ported.vertexPatch, SNAPSHOT_PORTED_SHADERS.vertexPatch, "ported vertexPatch mismatch");
    assert.equal(ported.vertexBody, SNAPSHOT_PORTED_SHADERS.vertexBody, "ported vertexBody mismatch");
    assert.equal(ported.fragmentPatch, SNAPSHOT_PORTED_SHADERS.fragmentPatch, "ported fragmentPatch mismatch");
    assert.equal(ported.fragmentMap, SNAPSHOT_PORTED_SHADERS.fragmentMap, "ported fragmentMap mismatch");
    assert.equal(ported.fragmentRoughness, SNAPSHOT_PORTED_SHADERS.fragmentRoughness, "ported fragmentRoughness mismatch");
    assert.deepEqual(PORTED_LIVERY_SHADERS, SNAPSHOT_PORTED_SHADERS);

    const gt3 = buildGt3LiveryShaders();
    assert.equal(gt3.vertexPatch, SNAPSHOT_GT3_SHADERS.vertexPatch, "gt3 vertexPatch mismatch");
    assert.equal(gt3.vertexBody, SNAPSHOT_GT3_SHADERS.vertexBody, "gt3 vertexBody mismatch");
    assert.equal(gt3.fragmentPatch, SNAPSHOT_GT3_SHADERS.fragmentPatch, "gt3 fragmentPatch mismatch");
    assert.equal(gt3.fragmentMap, SNAPSHOT_GT3_SHADERS.fragmentMap, "gt3 fragmentMap mismatch");
    assert.equal(gt3.fragmentRoughness, SNAPSHOT_GT3_SHADERS.fragmentRoughness, "gt3 fragmentRoughness mismatch");
    assert.deepEqual(GT3_LIVERY_SHADERS, SNAPSHOT_GT3_SHADERS);
  });

  await check("TS ported projection math matches literal GLSL shader evaluation across amg-gt3, bmw-m4-gt3, lc-lmdh", () => {
    const syntheticAtlas = (u: number, v: number): [number, number, number] => [u, v, u * 0.6 + v * 0.4];
    const samples: {
      name: string;
      car: "amg-gt3" | "bmw-m4-gt3" | "lc-lmdh";
      pos: [number, number, number];
      nrm: [number, number, number];
      frontFacing?: boolean;
      expectDominant: PortedPanelId;
      expectCarbon?: boolean;
    }[] = [
      { name: "amg hood boost", car: "amg-gt3", pos: [0.0, 0.72, 1.55], nrm: [0.0, 0.65, 0.76], expectDominant: "top" },
      { name: "amg left door", car: "amg-gt3", pos: [0.95, 0.58, 0.05], nrm: [0.97, 0.24, 0.0], expectDominant: "left" },
      { name: "amg right door", car: "amg-gt3", pos: [-0.95, 0.58, 0.05], nrm: [-0.97, 0.24, 0.0], expectDominant: "right" },
      { name: "amg ignores backfacing flip", car: "amg-gt3", pos: [-0.95, 0.58, 0.05], nrm: [0.97, 0.0, 0.0], frontFacing: false, expectDominant: "left" },
      { name: "amg rear wing chase face", car: "amg-gt3", pos: [0.0, 1.15, -2.05], nrm: [0.0, 0.6, -0.8], expectDominant: "rear" },
      { name: "amg rear wing top face", car: "amg-gt3", pos: [0.0, 1.15, -2.05], nrm: [0.0, 0.96, -0.28], expectDominant: "top" },
      { name: "amg rear wing endplate", car: "amg-gt3", pos: [0.92, 1.12, -2.05], nrm: [0.85, 0.5, 0.15], expectDominant: "left" },
      { name: "amg forced-carbon front splitter", car: "amg-gt3", pos: [0.0, 0.10, 2.20], nrm: [0.0, 1.0, 0.0], expectDominant: "top", expectCarbon: true },
      { name: "bmw front bumper", car: "bmw-m4-gt3", pos: [0.0, 0.48, 2.40], nrm: [0.0, 0.15, 0.98], expectDominant: "front" },
      { name: "lmdh nose top boost", car: "lc-lmdh", pos: [0.0, 0.55, 1.90], nrm: [0.0, 0.65, 0.76], expectDominant: "top" },
      { name: "lmdh rear wing chase face", car: "lc-lmdh", pos: [0.0, 1.00, -2.25], nrm: [0.0, 0.5, -0.86], expectDominant: "rear" },
      { name: "lmdh inverted right sidepod flips to right panel", car: "lc-lmdh", pos: [-0.99, 0.50, -0.95], nrm: [0.99, 0.0, 0.0], frontFacing: false, expectDominant: "right" },
      { name: "lmdh inverted right nose flips to front panel", car: "lc-lmdh", pos: [-0.45, 0.44, 2.50], nrm: [0.0, 0.0, -0.99], frontFacing: false, expectDominant: "front" },
    ];

    for (const s of samples) {
      const prof = PROCEDURAL_BODY_PROFILES[s.car];
      const ff = s.frontFacing ?? true;
      const ts = projectPortedPoint(s.pos, s.nrm, prof, ff);
      assert.equal(ts.dominantPanel, s.expectDominant, `${s.name}: expected ${s.expectDominant}, got ${ts.dominantPanel}`);
      assert.equal(ts.splitterCarbonOverride, Boolean(s.expectCarbon), `${s.name}: splitterCarbonOverride mismatch`);

      const glsl = evalGlslPorted(s.pos, s.nrm, prof, syntheticAtlas, ff);
      assert.equal(glsl.forcedCarbon, ts.splitterCarbonOverride, `${s.name}: GLSL forcedCarbon mismatch`);

      if (!s.expectCarbon) {
        const tsRgb: [number, number, number] = [0, 0, 0];
        let wTotal = 0;
        for (const pid of PORTED_PANEL_IDS) {
          const w = ts.panelWeights[pid] ?? 0;
          if (w <= 0) continue;
          wTotal += w;
          const sample = portedProjectToPanel(pid, s.pos[0], s.pos[1], s.pos[2], prof);
          const c = syntheticAtlas(sample.u, sample.v);
          tsRgb[0] += c[0] * w;
          tsRgb[1] += c[1] * w;
          tsRgb[2] += c[2] * w;
        }
        assert.ok(Math.abs(wTotal - 1) < 1e-6, `${s.name}: panelWeights sum ${wTotal} != 1`);
        for (let c = 0; c < 3; c++) {
          assert.ok(Math.abs(tsRgb[c] - glsl.rgb[c]) < 1e-6, `${s.name} channel ${c}: TS=${tsRgb[c]} vs GLSL=${glsl.rgb[c]}`);
        }
      }
    }

    // Verify left side runs Z reversed relative to right side on ported cars too
    const prof = PROCEDURAL_BODY_PROFILES["amg-gt3"];
    const leftFront = portedProjectToPanel("left", 0.9, 0.6, 1.8, prof);
    const leftRear = portedProjectToPanel("left", 0.9, 0.6, -1.8, prof);
    const rightFront = portedProjectToPanel("right", -0.9, 0.6, 1.8, prof);
    const rightRear = portedProjectToPanel("right", -0.9, 0.6, -1.8, prof);
    assert.ok(leftFront.px < leftRear.px, "ported left side front (+Z) must map left of rear (-Z)");
    assert.ok(rightFront.px > rightRear.px, "ported right side front (+Z) must map right of rear (-Z)");

    // BMW M4 GT3 roll cage & interior tub nodes stay out of procedural/atlas paint (both raw glTF and Three.js sanitized names)
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMW:D_Body_14_BMW:MAT_GT3_EVO_car_paint1_0"), false);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMWD_Body_10_BMWMAT_GT3_EVO_car_paint1_0"), false);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMW:SM_Interior_0000_001_BMW:MAT_GT3_EVO_car_paint1_0"), false);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMWSM_Interior_0000_001"), false);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMWSM_Root_M4_GT3_EVO_001"), false);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMW:SM_RearKit_0000_001"), true);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMWSM_FrontKit_0000_001"), true);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMW:SM_Hood_0000_001"), true);
    assert.equal(isProceduralPaintMesh("bmw-m4-gt3", "BMWANC_Door_L_09"), true);
    assert.equal(isProceduralPaintMesh("amg-gt3", "BMW:D_Body_14"), true);
  });

  await check("CarSkin.atlas resolves through portedSkinFor and mod manifest accepts/registers GT3 and LMDh atlas skins", () => {
    const known = modDefinitions();
    for (const id of ["lc26", "lc25", "amg-gt3", "bmw-m4-gt3", "lc-lmdh"] as const) {
      assert.ok(known.atlasCars.has(id), `atlasCars must include ${id}`);
    }
    assert.ok(!known.atlasCars.has("liana"), "liana must not be in atlasCars");

    const res = validateModManifest(
      {
        format: 1,
        id: "jdoe.gt-pack",
        name: "GT & Proto Painted Pack",
        version: "1.0.0",
        credit: { author: "J. Doe", license: "CC BY 4.0" },
        skins: [
          { car: "amg-gt3", id: "amg-works", name: "AMG Works", swatch: ["#111827", "#00d4aa", "#ffffff"], atlas: "atlas.png", finish: "satin" },
          { car: "bmw-m4-gt3", id: "m4-art", name: "M4 Art Car", swatch: ["#1d4ed8", "#ef4444"], atlas: "m4.webp" },
          { car: "lc-lmdh", id: "lmdh-night", name: "LMDh Night", swatch: ["#090d16", "#f59e0b"], dir: "liveries/night", atlas: "body.jpg", finish: "metallic" },
          // Existing file-based skin entries on amg-gt3 stay accepted for backwards compatibility
          { car: "amg-gt3", id: "legacy-file", name: "Legacy File", swatch: ["#222222", "#cccccc"], files: ["paint.png"] },
        ],
      },
      known
    );
    assert.equal(res.ok, true, res.ok ? "" : res.errors.join("; "));
    if (res.ok) {
      const files = manifestFiles(res.manifest);
      assert.ok(files.includes("skins/amg-works/atlas.png"));
      assert.ok(files.includes("skins/m4-art/m4.webp"));
      assert.ok(files.includes("liveries/night/body.jpg"));

      const origin = { packageId: res.manifest.id, packageName: res.manifest.name, version: res.manifest.version };
      registerModContent([{ manifest: res.manifest, origin }]);
      try {
        const amgSkin = carById("amg-gt3").skins?.find((s) => s.id === "mod:jdoe.gt-pack/amg-works");
        assert.ok(amgSkin, "amg-gt3 mod atlas skin must register on carById");
        assert.equal(amgSkin.atlas, "/mods/jdoe.gt-pack/skins/amg-works/atlas.png");
        assert.equal(amgSkin.finish, "satin");
        assert.equal(carSkinThumbUrl("amg-gt3", amgSkin.id), "/mods/jdoe.gt-pack/skins/amg-works/thumb.webp");
        const resolvedAmg = portedSkinFor("amg-gt3", amgSkin);
        assert.deepEqual(resolvedAmg, {
          baseUrl: "",
          atlas: "/mods/jdoe.gt-pack/skins/amg-works/atlas.png",
          finish: "satin",
          variant: undefined,
        });

        const bmwSkin = carById("bmw-m4-gt3").skins?.find((s) => s.id === "mod:jdoe.gt-pack/m4-art");
        assert.ok(bmwSkin && bmwSkin.finish === "gloss", "default finish for ported atlas skin must be gloss");
        assert.equal(portedSkinFor("bmw-m4-gt3", bmwSkin)?.atlas, "/mods/jdoe.gt-pack/skins/m4-art/m4.webp");

        const lmdhSkin = carById("lc-lmdh").skins?.find((s) => s.id === "mod:jdoe.gt-pack/lmdh-night");
        assert.ok(lmdhSkin && lmdhSkin.finish === "metallic");
        assert.equal(carSkinThumbUrl("lc-lmdh", lmdhSkin.id), "/mods/jdoe.gt-pack/liveries/night/thumb.webp");
      } finally {
        registerModContent([]);
      }
    }

    // Liana must refuse atlas skins
    const lianaAtlas = validateModManifest(
      {
        format: 1,
        id: "jdoe.bad-liana",
        name: "Bad Liana",
        version: "1.0.0",
        credit: { author: "J. Doe", license: "CC BY 4.0" },
        skins: [{ car: "liana", id: "x", name: "X", swatch: ["#111111", "#ffffff"], atlas: "atlas.png" }],
      },
      known
    );
    assert.equal(lianaAtlas.ok, false, "liana must not accept atlas skins");
  });

  await check("generated livery templates, overlays, and doc previews exist with exact dimensions for all 5 cars", async () => {
    const root = process.cwd();
    for (const carId of ["lc26", "lc25", "amg-gt3", "bmw-m4-gt3", "lc-lmdh"] as const) {
      const dir = join(root, "docs/livery-templates", carId);
      const templatePath = join(dir, `${carId}-template.png`);
      const overlayPath = join(dir, `${carId}-overlay.png`);
      const previewPath = join(dir, `${carId}-preview.webp`);

      for (const p of [templatePath, overlayPath, previewPath]) {
        assert.ok(existsSync(p), `missing generated template file: ${p}`);
      }

      const expectedSize = carId === "lc26" || carId === "lc25" ? F1_PROJECTION.atlasSize : PORTED_PROJECTION.atlasSize;
      const tmplMeta = await sharp(readFileSync(templatePath)).metadata();
      assert.equal(tmplMeta.format, "png");
      assert.equal(tmplMeta.width, expectedSize);
      assert.equal(tmplMeta.height, expectedSize);

      const ovMeta = await sharp(readFileSync(overlayPath)).metadata();
      assert.equal(ovMeta.format, "png");
      assert.equal(ovMeta.width, expectedSize);
      assert.equal(ovMeta.height, expectedSize);
      assert.equal(ovMeta.hasAlpha, true, `${carId}-overlay.png must have an alpha channel`);

      const prevMeta = await sharp(readFileSync(previewPath)).metadata();
      assert.equal(prevMeta.format, "webp");
      assert.equal(prevMeta.width, 640);
      assert.equal(prevMeta.height, 640);
    }
  });

  await check("template label/pill pixels never overlap painted bodywork and use plain words without engine jargon", async () => {
    const root = process.cwd();
    const SIZE = F1_PROJECTION.atlasSize;
    const JARGON_RE = /\([+-][XYZ]\)|\bX\s*=\s*0\b|\|X\|\s*>/;

    // 1. Exact GLB-mask pixel check for every target whose GLB exists locally (always lc26 & lc25, plus hosted if present)
    const localModelsDir = join(root, "public/cars");
    let glbChecked = 0;
    for (const target of LIVERY_TEMPLATE_TARGETS) {
      const glbPath = join(localModelsDir, target.glbRelPath);
      if (!existsSync(glbPath)) continue;
      glbChecked++;
      const { triangles, frontAxleZ, rearAxleZ, clamping, splitterVerts } = await loadPaintGeometry(target, glbPath);
      const panelIds = target.kind === "f1" ? F1_PANEL_IDS : PORTED_PANEL_IDS;
      const panelRectOf = (pid: string) =>
        target.kind === "f1"
          ? F1_PROJECTION.panels[pid as F1PanelId]
          : PORTED_PROJECTION.panels[pid as PortedPanelId];
      const { clampedEdgeHatch, labelBlockedMask, stampSurface, clampedEdgePixels, carbonHatchPixels } =
        rasterizeTemplateMasks(target, triangles, splitterVerts);

      // Clamped-edge hatching must stay strictly within the narrow edge strip of every panel (zero interior pixels)
      const panelRects = panelIds.map((pid) => [pid, panelRectOf(pid)] as const);
      for (const [pid, r] of panelRects) {
        for (let y = r.y; y < r.y + r.h; y++) {
          const row = y * SIZE;
          const nearV = y - r.y < CLAMP_EDGE_STRIP_PX || r.y + r.h - 1 - y < CLAMP_EDGE_STRIP_PX;
          for (let x = r.x; x < r.x + r.w; x++) {
            if (!clampedEdgeHatch[row + x]) continue;
            const nearH = x - r.x < CLAMP_EDGE_STRIP_PX || r.x + r.w - 1 - x < CLAMP_EDGE_STRIP_PX;
            assert.ok(nearH || nearV, `${target.id} ${pid}: clamped hatch pixel at (${x},${y}) sits in panel interior`);
          }
        }
      }

      for (const overlayOnly of [false, true]) {
        const layers =
          target.kind === "f1"
            ? buildF1VectorLayers(target, frontAxleZ, rearAxleZ, clamping, labelBlockedMask, overlayOnly, clampedEdgePixels > 0, stampSurface)
            : buildPortedVectorLayers(target, frontAxleZ, rearAxleZ, carbonHatchPixels > 0, labelBlockedMask, overlayOnly, stampSurface);
        assert.ok(!JARGON_RE.test(layers.labelsSvg), `${target.id} (${overlayOnly ? "overlay" : "template"}) labels must not contain engine jargon`);
        if (overlayOnly) {
          const lCount = (layers.labelsSvg.match(/>L<\/text>/g) ?? []).length;
          const rCount = (layers.labelsSvg.match(/>R<\/text>/g) ?? []).length;
          assert.equal(lCount, 3, `${target.id} overlay must have 3 L markers (TOP, REAR, FRONT), got ${lCount}`);
          assert.equal(rCount, 3, `${target.id} overlay must have 3 R markers (TOP, REAR, FRONT), got ${rCount}`);
        } else {
          assert.ok(layers.placedStamps.length > 0, `${target.id}: expected at least one placed in-body stamp`);
          for (const st of layers.placedStamps) {
            assert.ok(st.coverage >= 0.88, `${target.id} ${st.pid} stamp "${st.text}" has low flat coverage ${st.coverage.toFixed(2)}`);
          }
          assert.ok(/SEEN FROM/.test(layers.labelsSvg) && /THE FRONT/.test(layers.labelsSvg), `${target.id}: front panel pill must include full FRONT (SEEN FROM THE FRONT) wording`);
        }
        await assertLabelsOffPaintedGeometry(
          target.id,
          overlayOnly ? "overlay" : "template",
          Buffer.from(layers.labelsSvg),
          labelBlockedMask,
          panelRects
        );
      }
    }
    assert.ok(glbChecked >= 2, `expected at least lc26 and lc25 GLBs locally, checked ${glbChecked}`);

    // 2. Pixel check across all 5 committed template PNGs: find every filled dark pill (#0f172a box) and verify the
    //    perimeter 4 px outside its white border sits in unpainted background (#cbd5e1), never on painted bodywork
    //    fill (#f4f7fb / #e2e8f0, which has r in [222..250] and cool blue tint b - r >= 4).
    for (const carId of ["lc26", "lc25", "amg-gt3", "bmw-m4-gt3", "lc-lmdh"] as const) {
      const templatePath = join(root, "docs/livery-templates", carId, `${carId}-template.png`);
      const { data, info } = await sharp(readFileSync(templatePath)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const w = info.width;
      const h = info.height;
      const isDarkPillPx = (x: number, y: number): boolean => {
        const o = (y * w + x) * 3;
        return data[o] < 30 && data[o + 1] < 40 && data[o + 2] < 65;
      };
      const isPaintFillPx = (x: number, y: number): boolean => {
        const o = (y * w + x) * 3;
        const rr = data[o], gg = data[o + 1], bb = data[o + 2];
        return rr >= 220 && rr <= 250 && gg >= 226 && bb >= 236 && bb - rr >= 4;
      };
      const isPillInteriorPx = (x: number, y: number): boolean => {
        // Inside a pill: either dark navy fill (#0f172a) or white text (#ffffff) or grey antialiased text
        const o = (y * w + x) * 3;
        const rr = data[o], gg = data[o + 1], bb = data[o + 2];
        // Exclude background slate (#cbd5e1: r~203,g~213,b~225) and paint fill (#e2e8f0 / #f4f7fb)
        if (rr >= 195 && rr <= 250 && bb - rr >= 4) return false;
        return isDarkPillPx(x, y) || (rr > 248 && gg > 248 && bb > 248);
      };
      const panels = carId === "lc26" || carId === "lc25" ? Object.entries(F1_PROJECTION.panels) : Object.entries(PORTED_PROJECTION.panels);
      for (const [pid, r] of panels) {
        const visited = new Uint8Array(r.w * r.h);
        for (let y = r.y + 6; y < r.y + r.h - 14; y += 4) {
          for (let x = r.x + 6; x < r.x + r.w - 20; x += 4) {
            if (visited[(y - r.y) * r.w + (x - r.x)] || !isDarkPillPx(x, y)) continue;
            // Seed only on a solid 24x8 dark navy bar (the solid interior of a pill, never thin mesh edges)
            let solid = true;
            for (let dy = 0; dy < 8 && solid; dy += 2) {
              for (let dx = 0; dx < 24; dx += 3) {
                if (!isDarkPillPx(x + dx, y + dy)) {
                  solid = false;
                  break;
                }
              }
            }
            if (!solid) continue;
            // Flood-fill the pill's dark interior + white lettering to get its exact bounding box
            let x0 = x, x1 = x, y0 = y, y1 = y;
            let darkCount = 0;
            const q: number[] = [x, y];
            visited[(y - r.y) * r.w + (x - r.x)] = 1;
            let count = 0;
            while (q.length > 0 && count < 60000) {
              const cy = q.pop()!;
              const cx = q.pop()!;
              count++;
              if (isDarkPillPx(cx, cy)) darkCount++;
              if (cx < x0) x0 = cx;
              if (cx > x1) x1 = cx;
              if (cy < y0) y0 = cy;
              if (cy > y1) y1 = cy;
              for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx <= r.x + 3 || nx >= r.x + r.w - 3 || ny <= r.y + 3 || ny >= r.y + r.h - 3) continue;
                const li = (ny - r.y) * r.w + (nx - r.x);
                if (visited[li] || !isPillInteriorPx(nx, ny)) continue;
                visited[li] = 1;
                q.push(nx, ny);
              }
            }
            const bw = x1 - x0 + 1;
            const bh = y1 - y0 + 1;
            if (bw < 28 || bh < 14 || bh > 96 || darkCount / (bw * bh) < 0.45) continue;
            // Check 4px outside the pill's outer edge (past its 2px white border) for any painted bodywork fill
            let paintHits = 0;
            for (let px = Math.max(r.x + 4, x0 - 4); px <= Math.min(r.x + r.w - 5, x1 + 4); px += 2) {
              for (const py of [y0 - 4, y1 + 4]) {
                if (py > r.y + 4 && py < r.y + r.h - 4 && isPaintFillPx(px, py)) paintHits++;
              }
            }
            for (let py = Math.max(r.y + 4, y0 - 4); py <= Math.min(r.y + r.h - 5, y1 + 4); py += 2) {
              for (const px of [x0 - 4, x1 + 4]) {
                if (px > r.x + 4 && px < r.x + r.w - 4 && isPaintFillPx(px, py)) paintHits++;
              }
            }
            assert.equal(
              paintHits,
              0,
              `${carId} ${pid}: dark pill [${x0}..${x1}, ${y0}..${y1}] touches painted bodywork (${paintHits} border hits)`
            );
          }
        }
      }
    }
  });

  console.log(`\n${passed} checks passed`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
