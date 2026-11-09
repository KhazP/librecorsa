/**
 * The physical sky (src/lib/render/physical-sky.ts, Medium and High graphics): the scene sits on the globe with up, north and
 * east where the weather model puts them, so the sky's sun stands where the scene's sun light comes from; the shader
 * edits still land on the libraries' current sources; and the clouds' blue noise is our own and well formed.
 *
 *   npx tsx scripts/verify-physical-sky.ts
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SkyMaterial } from '@takram/three-atmosphere';
import { CloudsEffect } from '@takram/three-clouds';
import { Ellipsoid, Geodetic } from '@takram/three-geospatial';
import {
  CLOUDS_COMPOSITE_PATCHES,
  CLOUDS_REVERSED_DEPTH_PATCHES,
  createSpatiotemporalNoise,
  sceneToECEFMatrix,
  SKY_FRAGMENT_PATCHES,
  SKY_VERTEX_REVERSED_DEPTH_PATCHES,
} from '../src/lib/render/physical-sky';
import { AZIMUTH_OFFSET_DEG, LATITUDE_DEG, sunPosition, TIME_OF_DAY_HOURS } from '../src/lib/sim/weather';

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

console.log(`\nverify-physical-sky: ${passed} checks passed`);
