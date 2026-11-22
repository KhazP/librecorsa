/**
 * The physical sky (src/lib/render/physical-sky.ts, Medium and High graphics): the scene sits on the globe with up, north and
 * east where the weather model puts them, so the sky's sun stands where the scene's sun light comes from; the shader
 * edits still land on the libraries' current sources; the clouds' blue noise is our own and well formed; and each
 * session's cloud recipe (cloud-recipes.ts) is repeatable from its seed, varied across seeds, inside the limits its
 * coverage maths needs and smooth as the weather changes, with the clouds drifting the way the wind blows.
 *
 *   npx tsx scripts/verify-physical-sky.ts
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AerialPerspectiveEffect, SkyMaterial } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { Ellipsoid, Geodetic } from '@takram/three-geospatial';
import {
  AERIAL_PERSPECTIVE_PATCHES,
  AERIAL_PERSPECTIVE_REVERSED_DEPTH_PATCHES,
  cloudDriftVelocity,
  CLOUDS_COMPOSITE_PATCHES,
  CLOUDS_REVERSED_DEPTH_PATCHES,
  createSpatiotemporalNoise,
  cubeSphereUv,
  sceneToECEFMatrix,
  SKY_FRAGMENT_PATCHES,
  SKY_VERTEX_REVERSED_DEPTH_PATCHES,
} from '../src/lib/render/physical-sky';
import { AZIMUTH_OFFSET_DEG, LATITUDE_DEG, sunPosition, TIME_OF_DAY_HOURS } from '../src/lib/sim/weather';
import {
  cloudSkyFor,
  describeClouds,
  MAX_COVERAGE,
  MIN_COVERAGE,
  pickCloudRecipe,
  TEXTURED_MAX_FILTER,
  type CloudLayerSetup,
  type CloudSkySetup,
} from '../src/lib/render/cloud-recipes';

let passed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}
const count = (source: string, anchor: string) => source.split(anchor).length - 1;
const DEG = 180 / Math.PI;

// --- The scene on the globe ---------------------------------------------------------------------------------------
const m = sceneToECEFMatrix();
const origin = new THREE.Vector3().setFromMatrixPosition(m);
const anchor = new Geodetic().setFromECEF(origin);
check('scene origin on the ground at the weather latitude', Math.abs(anchor.latitude * DEG - LATITUDE_DEG) < 1e-6 && Math.abs(anchor.height) < 1e-3,
  `lat ${(anchor.latitude * DEG).toFixed(4)}°, h ${anchor.height.toFixed(4)} m`);

const normal = Ellipsoid.WGS84.getSurfaceNormal(origin, new THREE.Vector3());
const up = new THREE.Vector3(0, 1, 0).transformDirection(m);
check('scene +Y is local up', up.angleTo(normal) < 1e-9, `${(up.angleTo(normal) * DEG).toExponential(2)}°`);

// North in the scene (three.js Sky azimuth AZIMUTH_OFFSET_DEG) must point at the pole along the surface
const th = AZIMUTH_OFFSET_DEG / DEG;
const north = new THREE.Vector3(Math.sin(th), 0, Math.cos(th)).transformDirection(m);
const pole = new THREE.Vector3(0, 0, 1);
const towardPole = pole.clone().sub(normal.clone().multiplyScalar(pole.dot(normal))).normalize();
check('compass north points at the pole', north.angleTo(towardPole) < 1e-9, `${(north.angleTo(towardPole) * DEG).toExponential(2)}°`);
const east = new THREE.Vector3(-Math.cos(th), 0, Math.sin(th)).transformDirection(m);
check('east x north = up (no mirror)', east.clone().cross(north).angleTo(normal) < 1e-9);

// The sun keeps its elevation and compass bearing through the frame change, at every preset time of day
for (const [id, clockH] of Object.entries(TIME_OF_DAY_HOURS)) {
  const s = sunPosition(clockH);
  const phi = (90 - s.elevationDeg) / DEG;
  const scene = new THREE.Vector3().setFromSphericalCoords(1, phi, s.azimuthDeg / DEG);
  const ecef = scene.clone().transformDirection(m);
  const elev = 90 - ecef.angleTo(normal) * DEG;
  const compass = (Math.atan2(ecef.dot(east), ecef.dot(north)) * DEG + 360) % 360;
  const expectedCompass = (((AZIMUTH_OFFSET_DEG - s.azimuthDeg) % 360) + 360) % 360;
  const dCompass = Math.abs(((compass - expectedCompass + 540) % 360) - 180);
  check(`sun at ${id}`, Math.abs(elev - s.elevationDeg) < 1e-6 && dCompass < 1e-6,
    `elevation ${s.elevationDeg.toFixed(2)}°, bearing ${compass.toFixed(1)}°`);
}

// --- Shader edits land on the libraries' current source ------------------------------------------------------------
const sky = new SkyMaterial();
for (const [anchorText] of SKY_FRAGMENT_PATCHES) check(`sky fragment anchor once: ${anchorText.slice(0, 48)}`, count(sky.fragmentShader, anchorText) === 1);
for (const [anchorText] of SKY_VERTEX_REVERSED_DEPTH_PATCHES) check(`sky vertex anchor once: ${anchorText}`, count(sky.vertexShader, anchorText) === 1);
sky.dispose();

const clouds = new CloudsEffect();
const cloudsFragment = clouds.cloudsPass.currentMaterial.fragmentShader;
for (const [anchorText] of CLOUDS_REVERSED_DEPTH_PATCHES) check(`clouds depth anchor once: ${anchorText.slice(0, 48)}`, count(cloudsFragment, anchorText) === 1);
// Only the clouds pass reads scene depth: the shadow pass marches from the sun and the resolve pass reprojects its own
check('clouds pass is the one scene-depth reader', count(cloudsFragment, 'depthBuffer') >= 1 &&
  count(clouds.shadowPass.currentMaterial.fragmentShader, 'depthBuffer') === 0);
const composite = clouds.getFragmentShader();
for (const [anchorText] of CLOUDS_COMPOSITE_PATCHES) check(`clouds composite anchor once: ${anchorText.slice(0, 48)}`, count(composite, anchorText) === 1);
clouds.dispose();

const aerial = new AerialPerspectiveEffect(undefined, { sunLight: false, skyLight: false, sky: false, transmittance: true, inscatter: true });
const aerialFragment = aerial.getFragmentShader();
let patchedAerial = aerialFragment;
for (const [anchorText, replacement] of AERIAL_PERSPECTIVE_PATCHES) {
  check(`aerial perspective anchor once: ${anchorText.replace(/\n/g, ' ').slice(0, 48)}`, count(aerialFragment, anchorText) === 1);
  patchedAerial = patchedAerial.replace(anchorText, replacement);
}
for (const [anchorText, replacement] of AERIAL_PERSPECTIVE_REVERSED_DEPTH_PATCHES) {
  check(`aerial perspective depth anchor once: ${anchorText.slice(0, 48)}`, count(aerialFragment, anchorText) === 1);
  patchedAerial = patchedAerial.replace(anchorText, replacement);
}
// Regression (issue #161): near-camera ECEF cancellation and shadow-texel projection NaN guards
check(
  'aerial perspective skips Bruneton lookup within 10 m and rejects non-finite outputs',
  patchedAerial.includes('!(aerialDistSq >= 1e-4)') &&
    patchedAerial.includes('sqrt(max(discriminant, 0.0))') &&
    patchedAerial.includes('!(projected.w > 1e-4') &&
    patchedAerial.includes('any(isnan(transmittance))') &&
    patchedAerial.includes('isnan(sunTransmittance)')
);
aerial.dispose();

// --- Blue noise ------------------------------------------------------------------------------------------------------
const tile = new Uint8Array(readFileSync(join(__dirname, '..', 'public', 'sky', 'blue-noise-128.bin')));
check('blue-noise tile is 128 x 128 bytes', tile.length === 128 * 128);
const hist = new Uint32Array(256);
for (const v of tile) hist[v]++;
check('blue-noise histogram is flat', hist.every((c) => c === 64));
// Blue noise has almost no low-frequency energy: 8 x 8 block means sit far closer to mid-grey than white noise's (~9.7)
let sq = 0;
let blocks = 0;
for (let y = 0; y < 128; y += 8) {
  for (let x = 0; x < 128; x += 8) {
    let sum = 0;
    for (let j = 0; j < 8; j++) for (let k = 0; k < 8; k++) sum += tile[(y + j) * 128 + x + k];
    sq += (sum / 64 - 127.5) ** 2;
    blocks++;
  }
}
const blockRms = Math.sqrt(sq / blocks);
check('blue-noise tile is blue (8 x 8 block-mean RMS well under white noise)', blockRms < 4, blockRms.toFixed(2));

const volume = createSpatiotemporalNoise(tile);
const { width, height, depth } = volume.image;
check('noise volume is 128 x 128 x 64, one byte per texel', width === 128 && height === 128 && depth === 64 &&
  (volume.image.data as Uint8Array).length === 128 * 128 * 64);
const data = volume.image.data as Uint8Array;
let slicesFlat = true;
for (let z = 0; z < 64 && slicesFlat; z++) {
  const h = new Uint32Array(256);
  for (let i = 0; i < 128 * 128; i++) h[data[z * 16384 + i]]++;
  slicesFlat = h.every((c) => c >= 60 && c <= 68);
}
check('every slice keeps a flat histogram', slicesFlat);
// Over time, one texel's 64 values should cover the range evenly (golden-ratio steps), not repeat
let worstGap = 0;
for (const i of [0, 777, 9001, 16383]) {
  const vals = Array.from({ length: 64 }, (_, z) => data[z * 16384 + i]).sort((a, b) => a - b);
  for (let k = 1; k < 64; k++) worstGap = Math.max(worstGap, vals[k] - vals[k - 1]);
}
check('each texel steps evenly through time', worstGap <= 12, `largest gap ${worstGap}/255`);
volume.dispose();

// --- Cloud recipes ---------------------------------------------------------------------------------------------------
const SEEDS = Array.from({ length: 120 }, (_, i) => 1 + i * 7919);
check('a seed picks the same recipe every time', JSON.stringify(pickCloudRecipe(4242, 0.3, 0)) === JSON.stringify(pickCloudRecipe(4242, 0.3, 0)));
const clearSkies = SEEDS.map((seed) => describeClouds(pickCloudRecipe(seed, 0, 0), 0, 0).join(', '));
const distinctClear = new Set(clearSkies).size;
check('clear days differ between seeds', distinctClear >= 8, `${distinctClear} different skies over ${SEEDS.length} seeds`);
check('some clear days have no clouds at all', clearSkies.some((s) => s === ''));
check('some clear days have mid or high cloud', clearSkies.some((s) => /alto|cirr/.test(s)));
const offsets = SEEDS.map((seed) => pickCloudRecipe(seed, 0, 0).offset);
check('pattern positions spread over the texture', Math.min(...offsets.map((o) => o[0])) < 0.1 && Math.max(...offsets.map((o) => o[0])) > 0.9);

const textured = (i: number) => i < 3;
/** How much a layer shows: its density scale times the share of its texture that passes (the deck: its density) */
function strength(s: CloudSkySetup, i: number): number {
  const l = s.layers[i];
  if (l.height <= 0) return 0;
  if (!textured(i)) return l.densityScale * Math.min(1, s.coverage / l.coverageFilterWidth);
  const threshold = 1 - s.coverage / (1 - l.coverageFilterWidth);
  return l.densityScale * (1 - Math.pow(threshold, 1 / l.weatherExponent));
}
let limitsOk = true;
let limitsDetail = '';
let worstStep = 0;
let worstStepDetail = '';
let orderOk = true;
const keys: (keyof CloudLayerSetup)[] = ['altitude', 'height', 'shapeAmount', 'shapeAlteringBias'];
const sweep = (seed: number, path: Array<[number, number]>) => {
  const r = pickCloudRecipe(seed, path[0][0], path[0][1]);
  let prev: CloudSkySetup | null = null;
  for (const [cloud, rain] of path) {
    const s = cloudSkyFor(r, cloud, rain);
    if (!(s.coverage >= MIN_COVERAGE && s.coverage <= MAX_COVERAGE)) [limitsOk, limitsDetail] = [false, `coverage ${s.coverage}`];
    s.layers.forEach((l, i) => {
      const finite = Object.values(l).every((v) => typeof v === 'boolean' || Number.isFinite(v));
      if (!finite || l.densityScale < 0 || (l.densityScale === 0) !== (l.height === 0)) [limitsOk, limitsDetail] = [false, `seed ${seed} layer ${i}`];
      if (textured(i) && l.height > 0 && (l.coverageFilterWidth > TEXTURED_MAX_FILTER || s.coverage >= 1 - l.coverageFilterWidth)) {
        [limitsOk, limitsDetail] = [false, `seed ${seed} layer ${i} filter ${l.coverageFilterWidth}`];
      }
    });
    const [cu, mid, high] = s.layers;
    if ((mid.height > 0 && cu.height > 0 && mid.altitude < cu.altitude + 500) || (high.height > 0 && mid.height > 0 && high.altitude < mid.altitude + mid.height)) orderOk = false;
    if (prev) {
      for (let i = 0; i < 4; i++) {
        const a = strength(prev, i);
        const b = strength(s, i);
        if (Math.abs(a - b) > worstStep) [worstStep, worstStepDetail] = [Math.abs(a - b), `seed ${seed} layer ${i} at cloud ${cloud.toFixed(3)} rain ${rain.toFixed(3)}`];
        // Heights and shapes may jump only where the layer is invisible on one side of the step
        if (Math.min(a, b) > 0.002) {
          for (const k of keys) {
            const d = Math.abs((prev.layers[i][k] as number) - (s.layers[i][k] as number));
            const lim = k === 'altitude' || k === 'height' ? 100 : 0.02;
            if (d > lim) [worstStep, worstStepDetail] = [Infinity, `seed ${seed} layer ${i} ${k} jumps ${d.toFixed(3)} at cloud ${cloud.toFixed(3)} rain ${rain.toFixed(3)}`];
          }
        }
      }
    }
    prev = s;
  }
};
for (const seed of SEEDS) {
  // Clear to overcast, then into the heaviest rain: the paths the dynamic weather and the forecasts take
  sweep(seed, Array.from({ length: 201 }, (_, i) => [i / 200, 0] as [number, number]));
  sweep(seed, Array.from({ length: 201 }, (_, i) => [0.85 + 0.15 * (i / 200), i / 200] as [number, number]));
}
check('every layer stays inside the limits its coverage maths needs', limitsOk, limitsDetail);
check('cumulus below the mid layer, the mid layer below the high one', orderOk);
check('the clouds change smoothly with the weather (largest step in how much a layer shows)', worstStep < 0.012, `${worstStep.toFixed(4)} ${worstStepDetail}`);
const allRain = SEEDS.map((seed) => cloudSkyFor(pickCloudRecipe(seed, 1, 0.85), 1, 0.85));
check('heavy rain closes the sky with a low, thick, dense deck', allRain.every(({ coverage, layers: [, , , d] }) =>
  d.height > 2000 && d.altitude < 650 && coverage / d.coverageFilterWidth >= 0.9));
check('a clear sky has no deck', SEEDS.every((seed) => cloudSkyFor(pickCloudRecipe(seed, 0, 0), 0, 0).layers[3].height === 0));

// --- Cloud drift ---------------------------------------------------------------------------------------------------
const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
check('weather-texture coordinate is 0.5, 0.5 at every cube face centre',
  faces.every((f) => cubeSphereUv(new THREE.Vector3(...f).multiplyScalar(6.4e6)).distanceTo(new THREE.Vector2(0.5, 0.5)) < 1e-12));
const vx = cloudDriftVelocity(1, 0, 10, m, 100);
const vBack = cloudDriftVelocity(-1, 0, 10, m, 100);
check('drift runs back against a reversed wind', vx.clone().add(vBack).length() < 1e-9 * vx.length() && vx.length() > 0);
// A cloud moves with the wind: a second later the texture coordinate it sits on (uv x repeat + offset, fixed for it) is
// found 10 m downwind. The cube-sphere coordinate is skewed here, so this is checked in metres, along several headings
const upEcef = new THREE.Vector3(0, 1, 0).transformDirection(m);
const atClouds = new THREE.Vector3().setFromMatrixPosition(m).addScaledVector(upEcef, 1500);
let worstDrift = 0;
for (const [dx, dz] of [[1, 0], [0, 1], [0.6, -0.8], [-0.7, -0.7]]) {
  const v = cloudDriftVelocity(dx, dz, 10, m, 100);
  const dir = new THREE.Vector3(dx, 0, dz).normalize().transformDirection(m);
  const moved = cubeSphereUv(atClouds.clone().addScaledVector(dir, 10)).sub(cubeSphereUv(atClouds)).multiplyScalar(100).add(v);
  worstDrift = Math.max(worstDrift, moved.length() / v.length());
}
check('a cloud moves downwind at the wind speed, whichever way it blows', worstDrift < 1e-3, `${worstDrift.toExponential(2)} of a second's drift off`);

console.log(`\nverify-physical-sky: ${passed} checks passed`);
