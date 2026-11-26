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
  buildF1LiveryShaders,
  f1ProjectToPanel,
  projectF1Point,
  type F1PanelId,
} from "../../src/lib/render/livery-projection";
import { atlasCacheKey, LIVERY_FINISH_PROFILES } from "../../src/lib/render/f1-livery-painter";
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

  await check("generated F1 livery templates, overlays, and doc previews exist with exact dimensions", async () => {
    const root = process.cwd();
    for (const carId of ["lc26", "lc25"] as const) {
      const dir = join(root, "docs/livery-templates", carId);
      const templatePath = join(dir, `${carId}-template.png`);
      const overlayPath = join(dir, `${carId}-overlay.png`);
      const previewPath = join(dir, `${carId}-preview.webp`);

      for (const p of [templatePath, overlayPath, previewPath]) {
        assert.ok(existsSync(p), `missing generated template file: ${p}`);
      }

      const tmplMeta = await sharp(readFileSync(templatePath)).metadata();
      assert.equal(tmplMeta.format, "png");
      assert.equal(tmplMeta.width, F1_PROJECTION.atlasSize);
      assert.equal(tmplMeta.height, F1_PROJECTION.atlasSize);

      const ovMeta = await sharp(readFileSync(overlayPath)).metadata();
      assert.equal(ovMeta.format, "png");
      assert.equal(ovMeta.width, F1_PROJECTION.atlasSize);
      assert.equal(ovMeta.height, F1_PROJECTION.atlasSize);
      assert.equal(ovMeta.hasAlpha, true, `${carId}-overlay.png must have an alpha channel`);

      const prevMeta = await sharp(readFileSync(previewPath)).metadata();
      assert.equal(prevMeta.format, "webp");
      assert.equal(prevMeta.width, 640);
      assert.equal(prevMeta.height, 640);
    }
  });

  console.log(`\n${passed} checks passed`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
