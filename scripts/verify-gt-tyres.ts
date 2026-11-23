/**
 * GT tyre sidewall packs (`src/lib/render/gt-tyre-sidewall.ts`) and sagatron918 credits:
 * verifies all 6 brands are registered and mapped to real non-F1 cars, shader injection & uniform setup
 * work cleanly without colliding with `pirelli-sidewall.ts`, generated WebPs (when present) are valid lossless
 * RIFF/VP8L images, and credits gate the PayPal donation link behind `useStoreBuild()`.
 *
 *   npx tsx scripts/verify-gt-tyres.ts
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  canLoadGtTyreSidewall,
  createGtTyreSidewall,
  DEFAULT_CAR_GT_TYRE_BRAND,
  defaultGtTyreBrand,
  GT_SIDEWALL_TEX_RIM,
  GT_SIDEWALL_TEX_SHOULDER,
  GT_TYRE_BRANDS,
  GT_TYRE_PACKS,
  resolveGtTyreBrand,
  type GtTyreBrand,
} from "../src/lib/render/gt-tyre-sidewall";
import { installTyreDeformation } from "../src/lib/render/tyre-deformation";
import { collectSkinSlots } from "../src/lib/ported-car-model";
import { opponentGtTyreBrand } from "../src/lib/sim/visual-fx";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
}

const EXPECTED_BRANDS: readonly GtTyreBrand[] = [
  "pirelli",
  "michelin",
  "goodyear",
  "bridgestone",
  "yokohama",
  "falken",
];

check(
  "All 6 GT tyre brands registered",
  GT_TYRE_BRANDS.length === 6 && EXPECTED_BRANDS.every((b) => GT_TYRE_BRANDS.includes(b) && GT_TYRE_PACKS[b].brand === b),
  GT_TYRE_BRANDS.join(", ")
);

// Every brand must be mapped to at least one real car so all 6 packs are genuinely used
const usedBrands = new Set(Object.values(DEFAULT_CAR_GT_TYRE_BRAND));
check(
  "All 6 brands mapped onto default non-F1 cars",
  EXPECTED_BRANDS.every((b) => usedBrands.has(b)),
  Object.entries(DEFAULT_CAR_GT_TYRE_BRAND)
    .map(([c, b]) => `${c}=${b}`)
    .join(", ")
);

check("F1 car gets null GT tyre brand", defaultGtTyreBrand("lc26", "f1") === null);
check("Road cars get null GT tyre brand", defaultGtTyreBrand("liana", "road") === null && defaultGtTyreBrand("vw-scirocco-gtx", "road") === null);
check("Fallback by class maps gt3/proto/classic", defaultGtTyreBrand("future-gt3", "gt3") === "pirelli" && defaultGtTyreBrand("future-proto", "proto") === "michelin" && defaultGtTyreBrand("future-classic", "classic") === "goodyear");
check(
  "resolveGtTyreBrand parses valid brands and rejects junk",
  resolveGtTyreBrand("  Yokohama ") === "yokohama" && resolveGtTyreBrand("FALKEN") === "falken" && resolveGtTyreBrand("unknown") === null && resolveGtTyreBrand(null) === null
);
check("canLoadGtTyreSidewall is false in Node/SSR", canLoadGtTyreSidewall() === false);

// Synthetic tyre geometry: cylinder-like ring with axle along X, bead=0.24m, shoulder=0.33m
const geo = new THREE.BufferGeometry();
const verts: number[] = [];
const norms: number[] = [];
for (let i = 0; i < 32; i++) {
  const a = (i / 32) * Math.PI * 2;
  const cy = Math.cos(a);
  const cz = Math.sin(a);
  for (const side of [-1, 1]) {
    verts.push(side * 0.16, 0.24 * cy, 0.24 * cz, side * 0.16, 0.33 * cy, 0.33 * cz);
    norms.push(side, 0, 0, side, 0, 0);
  }
}
geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
geo.setAttribute("normal", new THREE.Float32BufferAttribute(norms, 3));

const patch = createGtTyreSidewall(geo, "goodyear", "medium");
const fit = patch.uniforms.uGtSwFit.value as THREE.Vector3;
const expectedTexPerM = Math.max(
  (GT_SIDEWALL_TEX_SHOULDER - GT_SIDEWALL_TEX_RIM) / (0.33 - 0.24),
  GT_SIDEWALL_TEX_SHOULDER / 0.33
);
check(
  "Sidewall fit matches mesh bead/shoulder radii",
  Math.abs(fit.x - 0.33) < 1e-4 && Math.abs(fit.y - GT_SIDEWALL_TEX_SHOULDER) < 1e-4 && Math.abs(fit.z - expectedTexPerM) < 1e-4,
  `shoulder=${fit.x.toFixed(3)}, texShoulder=${fit.y.toFixed(2)}, dt/dr=${fit.z.toFixed(3)}`
);

const mockShader = {
  uniforms: {} as Record<string, THREE.IUniform>,
  vertexShader: "#include <common>\nvoid main() {\n#include <begin_vertex>\n}",
  fragmentShader: "#include <common>\nvoid main() {\n#include <color_fragment>\n}",
} as unknown as THREE.WebGLProgramParametersWithUniforms;
patch.patch(mockShader);
check(
  "Shader patch injects GT sidewall vertex + fragment GLSL",
  mockShader.vertexShader.includes("vGtSwRest = position;") &&
    mockShader.fragmentShader.includes("texture2D(uGtSwMap, gtSwUv)") &&
    "uGtSwMap" in mockShader.uniforms &&
    "uGtSwReady" in mockShader.uniforms
);

// Compound & brand transitions + dispose should never throw
let transitionsOk = true;
try {
  patch.setCompound("wet");
  patch.setCompound("intermediate");
  patch.setCompound("soft");
  patch.setBrand("falken");
  patch.setCompound("wet");
  patch.dispose();
} catch {
  transitionsOk = false;
}
check("Compound/brand switches and dispose run cleanly", transitionsOk);
// Regression (#13): collectSkinSlots preserves tyre deformation + GT sidewall shader hooks when a car's skinMaps
// also repaints the tyre material (bmw-m1-procar.glb maps tyre_008 -> tyre_d_2.jpg)
{
  const wheelGeo = geo.clone();
  const baseMat = new THREE.MeshStandardMaterial({ name: "tyre_008" });
  const bodyMat = new THREE.MeshStandardMaterial({ name: "body_paint" });
  const tyreMesh = new THREE.Mesh(wheelGeo, baseMat);
  const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), bodyMat);
  const root = new THREE.Group();
  root.add(bodyMesh, tyreMesh);
  const handle = installTyreDeformation(tyreMesh, {
    unloadedRadiusM: 0.33,
    halfWidthM: 0.16,
    gtSidewall: { brand: "goodyear", compound: "medium" },
  });
  const deformedMat = tyreMesh.material as THREE.MeshStandardMaterial;
  const origOnBeforeCompile = deformedMat.onBeforeCompile;
  const origCacheKey = deformedMat.customProgramCacheKey();
  const slots = collectSkinSlots(
    [root],
    { tyre_008: "tyre_d_2.jpg", body_paint: "body.png" },
    new Set([deformedMat])
  );
  const tyreSlot = slots.find((s) => s.file === "tyre_d_2.jpg");
  const bodySlot = slots.find((s) => s.file === "body.png");
  check(
    "collectSkinSlots keeps deformed tyre material & shader hooks intact",
    tyreMesh.material === deformedMat &&
      tyreSlot?.mat === deformedMat &&
      tyreSlot?.ownedBySkin === false &&
      deformedMat.onBeforeCompile === origOnBeforeCompile &&
      deformedMat.customProgramCacheKey() === origCacheKey &&
      origCacheKey.includes("-gt-sidewall") &&
      bodySlot?.ownedBySkin === true &&
      bodyMesh.material === bodySlot.mat &&
      bodyMesh.material !== bodyMat
  );
  // Regression (issue #161): tyre deformation shader uses downward outward contact normal, safe normalize, and single-return profile
  const deformShader = {
    uniforms: {},
    vertexShader: "#include <common>\nvoid main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\n}",
    fragmentShader: "#include <common>\nvoid main() {\n#include <color_fragment>\n}",
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  deformedMat.onBeforeCompile(deformShader, null as unknown as THREE.WebGLRenderer);
  const deformVert = deformShader.vertexShader;
  check(
    "tyre deformation vertex shader uses safe normalize, downward contact normal, and single-return road profile",
    deformVert.includes("vec3 tyreSafeNormalize(") &&
      deformVert.includes("vec3(across.y, 0.0, along.y) - roadN") &&
      !deformVert.includes("normalize(mix(n, surfN") &&
      deformVert.includes("vec2 res = vec2(0.0);")
  );
  handle.dispose();
  for (const s of slots) if (s.ownedBySkin) s.mat.dispose();
  baseMat.dispose();
  bodyMat.dispose();
  bodyMesh.geometry.dispose();
  wheelGeo.dispose();
}

// Regression (#14): opponent rigs for amg-gt3 and mtr-496r resolve their default GT tyre brands
check(
  "opponentGtTyreBrand maps amg-gt3/mtr-496r/classic and returns null for road/f1",
  opponentGtTyreBrand("amg-gt3") === "pirelli" &&
    opponentGtTyreBrand("mtr-496r") === "michelin" &&
    opponentGtTyreBrand("lc-lmdh") === "michelin" &&
    opponentGtTyreBrand("bmw-m1-procar") === "goodyear" &&
    opponentGtTyreBrand("liana") === null &&
    opponentGtTyreBrand("lc26") === null &&
    opponentGtTyreBrand(undefined) === null,
  `amg-gt3=${opponentGtTyreBrand("amg-gt3")}, mtr-496r=${opponentGtTyreBrand("mtr-496r")}`
);

geo.dispose();

// Verify local ported lossless WebPs if generated in public/cars/shared/tyres/gt/
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gtDir = path.join(root, "public/cars/shared/tyres/gt");
if (existsSync(gtDir)) {
  const urls = GT_TYRE_BRANDS.flatMap((b) => {
    const p = GT_TYRE_PACKS[b];
    return p.wetUrl ? [p.url, p.wetUrl] : [p.url];
  });
  for (const url of urls) {
    const filePath = path.join(root, "public", url);
    const exists = existsSync(filePath);
    let lossless = false;
    let kb = 0;
    if (exists) {
      const buf = readFileSync(filePath);
      kb = statSync(filePath).size / 1024;
      lossless =
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WEBP" &&
        buf.subarray(12, 16).toString("ascii") === "VP8L";
    }
    check(`Ported WebP valid lossless: ${path.basename(filePath)}`, exists && lossless && kb > 10, `${kb.toFixed(1)} KiB`);
  }
} else {
  console.log("SKIP  public/cars/shared/tyres/gt not present in this checkout (R2-hosted)");
}

// Verify credits & store-build PayPal gating
const creditsMd = readFileSync(path.join(root, "CREDITS.md"), "utf8");
const titleMenu = readFileSync(path.join(root, "src/components/menu/TitleMenu.tsx"), "utf8");
const allBrandNames = ["Pirelli", "Michelin", "Goodyear", "Bridgestone", "Yokohama", "Falken"];
check(
  "CREDITS.md credits sagatron918, all 6 brands, and PayPal link",
  creditsMd.includes("sagatron918") &&
    creditsMd.includes("https://www.paypal.me/SagarNaikB") &&
    allBrandNames.every((n) => creditsMd.includes(n))
);
check(
  "TitleMenu.tsx credits sagatron918 and gates PayPal via useStoreBuild()",
  titleMenu.includes("sagatron918") &&
    titleMenu.includes("https://www.paypal.me/SagarNaikB") &&
    /SagatronDonateLink[\s\S]{0,120}useStoreBuild\(\)\s*\?\s*null/.test(titleMenu)
);

console.log(failed ? `\n${failed} GT tyre check(s) failed.` : "\nAll GT tyre checks passed.");
if (failed) process.exit(1);
