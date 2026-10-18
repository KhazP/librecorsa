/**
 * Smooths unnatural banking bumps, camel-back corner camber dips, clipping creases,
 * kerb lip steps, and pit-exit transitions in `public/tracks/rwanda/rwanda_2026.glb`
 * and `public/tracks/rwanda/track_data.json`.
 *
 * Fully idempotent: baseline centerline, width, curvature, and kerb profiles are
 * computed deterministically from the horizontal plan geometry.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GLB_PATH = resolve(process.cwd(), 'public/tracks/rwanda/rwanda_2026.glb');
const JSON_PATH = resolve(process.cwd(), 'public/tracks/rwanda/track_data.json');

const KERB_HINGE_M = 1.5;
const RUNOFF_BANK_MAX = (2.0 * Math.PI) / 180;
/** Designer-given corner banking as [s_m, cross slope %] knots (T2, Wurz: 12 % easing to 6 % and 4 %) */
const BANK_PROFILES: [number, number][][] = [
  [[560, 0], [625, 12.5], [690, 12.5], [722, 6], [752, 4], [795, 0]],
];
const KERB_PROF_Z = [0.0, 0.018, 0.032, 0.026, 0.0];

function ss(e0: number, e1: number, v: number): number {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function circSmooth(a: Float64Array, win: number): Float64Array {
  const n = a.length;
  const w = win | 1;
  if (w <= 1) return Float64Array.from(a);
  const h = w >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -h; k <= h; k++) sum += a[(i + k + n) % n];
    out[i] = sum / w;
  }
  return out;
}

function gaussClosed(a: Float64Array, sigmaM: number, ds: number): Float64Array {
  const n = a.length;
  const sigma = sigmaM / ds;
  const rad = Math.min(n >> 1, Math.ceil(sigma * 4.5));
  const weights = new Float64Array(2 * rad + 1);
  let wSum = 0;
  for (let k = -rad; k <= rad; k++) {
    const w = Math.exp(-0.5 * (k / sigma) ** 2);
    weights[k + rad] = w;
    wSum += w;
  }
  for (let k = 0; k < weights.length; k++) weights[k] /= wSum;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -rad; k <= rad; k++) {
      acc += a[(i + k + n) % n] * weights[k + rad];
    }
    out[i] = acc;
  }
  return out;
}

function slopeLimitClosed(a: Float64Array, kPerM: number, ds: number): Float64Array {
  const n = a.length;
  const out = Float64Array.from(a);
  const step = kPerM * ds;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= 2 * n; i++) {
      const cur = i % n;
      const prev = (i - 1) % n;
      if (out[cur] > out[prev] + step) out[cur] = out[prev] + step;
    }
    for (let i = 2 * n; i >= 1; i--) {
      const cur = i % n;
      const next = (i + 1) % n;
      if (out[cur] > out[next] + step) out[cur] = out[next] + step;
    }
  }
  return out;
}

function distanceToMaskClosed(mask: Uint8Array, ds: number): Float64Array {
  const n = mask.length;
  const dist = new Float64Array(n);
  dist.fill(1e9);
  for (let i = 0; i < n; i++) {
    if (mask[i]) dist[i] = 0;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= 2 * n; i++) {
      const cur = i % n;
      const prev = (i - 1) % n;
      if (dist[prev] + ds < dist[cur]) dist[cur] = dist[prev] + ds;
    }
    for (let i = 2 * n; i >= 1; i--) {
      const cur = i % n;
      const next = (i + 1) % n;
      if (dist[next] + ds < dist[cur]) dist[cur] = dist[next] + ds;
    }
  }
  return dist;
}

function crossZ(bankRad: number, widthM: number, lat: number): number {
  const hw = widthM * 0.5 + KERB_HINGE_M;
  const tb = Math.tan(bankRad);
  const tr = Math.tan(RUNOFF_BANK_MAX * Math.tanh(bankRad / RUNOFF_BANK_MAX));
  const u = Math.max(0, Math.abs(lat) - hw);
  const ramp = u - 4.0 * (1 - Math.exp(-u / 4.0));
  const signLat = lat > 0 ? 1 : lat < 0 ? -1 : 0;
  return -tb * lat + (tb - tr) * signLat * ramp;
}

interface GltfJson {
  scenes: { nodes: number[] }[];
  nodes: {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    extras?: Record<string, unknown>;
  }[];
  meshes: {
    primitives: {
      attributes: { POSITION: number; NORMAL?: number };
      indices?: number;
    }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

function main() {
  const buf = Buffer.from(readFileSync(GLB_PATH));
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as GltfJson;
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);

  const getAccessorOffset = (idx: number) => {
    const acc = gltf.accessors[idx];
    const view = gltf.bufferViews[acc.bufferView];
    const comps = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
    const elemSize = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 ? 2 : 1;
    const stride = view.byteStride ?? comps * elemSize;
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    return { acc, stride, base, comps, elemSize };
  };

  const readVec3 = (accIdx: number, i: number): [number, number, number] => {
    const { stride, base } = getAccessorOffset(accIdx);
    const o = base + i * stride;
    return [bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)];
  };

  const writeVec3 = (accIdx: number, i: number, x: number, y: number, z: number) => {
    const { stride, base } = getAccessorOffset(accIdx);
    const o = base + i * stride;
    bin.writeFloatLE(x, o);
    bin.writeFloatLE(y, o + 4);
    bin.writeFloatLE(z, o + 8);
  };

  const readIndex = (accIdx: number, i: number): number => {
    const { acc, stride, base } = getAccessorOffset(accIdx);
    const o = base + i * stride;
    if (acc.componentType === 5125) return bin.readUInt32LE(o);
    if (acc.componentType === 5123) return bin.readUInt16LE(o);
    return bin.readUInt8(o);
  };

  // 1. Extract the 2-metre baseline grid from Track_Collider_Road (2649 rows x 5 cols)
  const colliderNode = gltf.nodes.find((n) => n.name === 'Track_Collider_Road');
  if (!colliderNode || colliderNode.mesh === undefined) {
    throw new Error('Track_Collider_Road not found in GLB');
  }
  const colliderPosAcc = gltf.meshes[colliderNode.mesh].primitives[0].attributes.POSITION;
  const totalVerts = gltf.accessors[colliderPosAcc].count;
  const n2 = totalVerts / 5; // 2649
  const trackJson = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  const totalLengthM: number = trackJson.metadata.lengthMeters;
  const ds2 = totalLengthM / n2;

  const px = new Float64Array(n2);
  const py = new Float64Array(n2);
  const pz = new Float64Array(n2);
  const rx = new Float64Array(n2);
  const rz = new Float64Array(n2);
  const tx = new Float64Array(n2);
  const tz = new Float64Array(n2);
  const width2 = new Float64Array(n2);
  const bankOld = new Float64Array(n2);

  for (let i = 0; i < n2; i++) {
    const pL = readVec3(colliderPosAcc, 5 * i + 1);
    const pC = readVec3(colliderPosAcc, 5 * i + 2);
    const pR = readVec3(colliderPosAcc, 5 * i + 3);
    px[i] = pC[0];
    py[i] = pC[1];
    pz[i] = pC[2];
    const dx = pR[0] - pL[0];
    const dz = pR[2] - pL[2];
    const w = Math.hypot(dx, dz);
    width2[i] = w;
    rx[i] = dx / w;
    rz[i] = dz / w;
    tx[i] = rz[i];
    tz[i] = -rx[i];
    const tanB = (pL[1] - pR[1]) / w;
    bankOld[i] = Math.atan(tanB);
  }

  // 2. Compute curvature kappa(s) on the 2m grid (+ = right-hand turn)
  const th = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    th[i] = Math.atan2(-tz[i], tx[i]);
  }
  const dth = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    const diff = th[(i + 1) % n2] - th[(i - 1 + n2) % n2];
    dth[i] = Math.atan2(Math.sin(diff), Math.cos(diff)) / (2 * ds2);
  }
  const kappa2 = circSmooth(dth, Math.floor(15 / ds2) | 1);
  for (let i = 0; i < n2; i++) kappa2[i] = -kappa2[i];

  // Also mark where the 5m JSON curvature check in verify-sim.ts considers a sample a right/left corner
  const posCornerMask = new Uint8Array(n2);
  const negCornerMask = new Uint8Array(n2);
  for (let i = 0; i < n2; i++) {
    const s = i * ds2;
    const onMainStraight = s <= 165 || s >= 4945;
    if (onMainStraight) {
      posCornerMask[i] = 1;
      negCornerMask[i] = 1;
    } else {
      if (kappa2[i] > 1 / 460) posCornerMask[i] = 1;
      if (kappa2[i] < -1 / 460) negCornerMask[i] = 1;
    }
  }
  const distToNeg = gaussClosed(distanceToMaskClosed(negCornerMask, ds2), 4.0, ds2);
  const distToPos = gaussClosed(distanceToMaskClosed(posCornerMask, ds2), 4.0, ds2);

  // 3. Construct monotonic, C2-smooth banking profile:
  //    Using the local minimum radius R_min within ±75 m of each sample (instead of instantaneous R(s))
  //    prevents slow corners from spiking to 4.0 deg at entry/exit before dropping to 1.5 deg at the apex,
  //    while keeping Turn 1 and fast sweepers at their full 4.0 deg camber.
  const instR = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    instR[i] = 1 / Math.max(1e-6, Math.abs(kappa2[i]));
  }
  const winHalf = Math.round(75 / ds2);
  const localRMin = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    let m = 1e9;
    const sg = Math.sign(kappa2[i]);
    for (let k = -winHalf; k <= winHalf; k++) {
      const j = (i + k + n2) % n2;
      if (Math.sign(kappa2[j]) === sg && instR[j] < m) m = instR[j];
    }
    localRMin[i] = m;
  }
  const smoothRMin = gaussClosed(localRMin, 18.0, ds2);

  const bankRaw = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    const s = i * ds2;
    // Eliminate artificial S-bend banking bumps on the main straight around S/F
    const wAfterSf = ss(150, 190, s);
    const wBeforeSf = 1 - ss(4910, 4955, s);
    const wStraight = s < 2600 ? wAfterSf : wBeforeSf;
    const R = instR[i];
    const turn = ss(900, 400, R) * wStraight;
    const magDeg = 1.5 + 2.5 * ss(55, 120, smoothRMin[i]);
    const magRad = (magDeg * Math.PI) / 180;
    const sg = kappa2[i] > 0 ? 1 : kappa2[i] < 0 ? -1 : 0;
    bankRaw[i] = magRad * turn * sg;
  }
  // Designer-given corner banking raises the generic camber inside its window (same sign as the corner's
  // tightest point); mirrors BANK_PROFILES in scripts/rwanda-2026/build_track.py
  for (const prof of BANK_PROFILES) {
    const s0 = prof[0][0];
    const s1 = prof[prof.length - 1][0];
    let iMax = -1;
    for (let i = 0; i < n2; i++) {
      const s = i * ds2;
      if (s >= s0 && s <= s1 && (iMax < 0 || Math.abs(kappa2[i]) > Math.abs(kappa2[iMax]))) iMax = i;
    }
    const sg = Math.sign(kappa2[iMax]);
    for (let i = 0; i < n2; i++) {
      const s = i * ds2;
      if (s < s0 || s > s1) continue;
      let k = 1;
      while (prof[k][0] < s) k++;
      const f = (s - prof[k - 1][0]) / (prof[k][0] - prof[k - 1][0]);
      const pct = prof[k - 1][1] + (prof[k][1] - prof[k - 1][1]) * f;
      bankRaw[i] = sg * Math.max(bankRaw[i] * sg, Math.atan(pct / 100));
    }
  }

  let bankNew = gaussClosed(bankRaw, 14.0, ds2);
  const maxTwistRadPerM = (0.095 * Math.PI) / 180;
  const posPart = new Float64Array(n2);
  const negPart = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    posPart[i] = Math.max(0, bankNew[i]);
    negPart[i] = Math.max(0, -bankNew[i]);
  }
  const limPos = slopeLimitClosed(posPart, maxTwistRadPerM, ds2);
  const limNeg = slopeLimitClosed(negPart, maxTwistRadPerM, ds2);
  const bPos = new Float64Array(n2);
  const bNeg = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    bPos[i] = limPos[i] * ss(2.0, 26.0, distToNeg[i]);
    bNeg[i] = limNeg[i] * ss(2.0, 26.0, distToPos[i]);
    bankNew[i] = bPos[i] - bNeg[i];
  }
  bankNew = gaussClosed(bankNew, 6.0, ds2);
  for (let i = 0; i < n2; i++) {
    if (negCornerMask[i] && bankNew[i] > 0) bankNew[i] = 0;
    if (posCornerMask[i] && bankNew[i] < 0) bankNew[i] = 0;
  }

  const findSampleAndLat = (x: number, z: number): { i: number; lat: number; distSq: number } => {
    let bestI = 0;
    let bestLong = 1e9;
    let bestDistSq = 1e18;
    for (let i = 0; i < n2; i++) {
      const dx = x - px[i];
      const dz = z - pz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 > 6400) continue;
      const longErr = Math.abs(dx * tx[i] + dz * tz[i]);
      if (longErr < bestLong || (Math.abs(longErr - bestLong) < 1e-4 && d2 < bestDistSq)) {
        bestLong = longErr;
        bestDistSq = d2;
        bestI = i;
      }
    }
    if (bestDistSq === 1e18) {
      for (let i = 0; i < n2; i++) {
        const dx = x - px[i];
        const dz = z - pz[i];
        const d2 = dx * dx + dz * dz;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestI = i;
        }
      }
    }
    const dx = x - px[bestI];
    const dz = z - pz[bestI];
    const lat = dx * rx[bestI] + dz * rz[bestI];
    return { i: bestI, lat, distSq: bestDistSq };
  };

  // 4. Update all track surface and collider meshes in the GLB
  const TRACK_MESH_NAMES = new Set([
    'Track_Asphalt_Road',
    'Track_Collider_Road',
    'Track_Markings',
    'Track_Kerbs',
    'Track_Kerbs_Sausage',
    'Track_Runoff_Paint',
    'Track_Runoff_Decals',
    'Track_Barriers',
    'Track_Fences',
    'Track_Pitlane',
    'Track_Pit_Markings',
    'Track_PitWall',
    'Track_PitOuterWall',
    'Track_Collider_Wall_Left',
    'Track_Collider_Wall_Right',
    'Track_Collider_Wall_Pit',
    'Track_Collider_Wall_PitOuter',
  ]);

  for (const node of gltf.nodes) {
    if (!node.name || !TRACK_MESH_NAMES.has(node.name) || node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];

    for (const prim of mesh.primitives) {
      const posAccIdx = prim.attributes.POSITION;
      const vCount = gltf.accessors[posAccIdx].count;

      if (node.name === 'Track_Kerbs' && vCount % 5 === 0) {
        // Idempotent kerb height profile: flush inner/outer lips and 14m longitudinal ramp
        const rows = vCount / 5;
        const rowI = new Int32Array(rows);
        const rowS = new Float64Array(rows);
        for (let r = 0; r < rows; r++) {
          const [xC, , zC] = readVec3(posAccIdx, r * 5 + 2);
          const { i } = findSampleAndLat(xC, zC);
          rowI[r] = i;
          rowS[r] = i * ds2;
        }
        let runStart = 0;
        for (let r = 1; r <= rows; r++) {
          const isBreak =
            r === rows ||
            (Math.abs(rowS[r] - rowS[r - 1]) > 5.0 &&
              Math.abs(Math.abs(rowS[r] - rowS[r - 1]) - totalLengthM) > 5.0);
          if (isBreak) {
            const len = r - runStart;
            for (let k = 0; k < len; k++) {
              const rIdx = runStart + k;
              const dEnd = Math.min(k, len - 1 - k) * ds2;
              const env = ss(0, 14.0, dEnd);
              for (let c = 0; c < 5; c++) {
                const vIdx = rIdx * 5 + c;
                const [x, , z] = readVec3(posAccIdx, vIdx);
                const { i, lat } = findSampleAndLat(x, z);
                const yBase = py[i] + crossZ(bankNew[i], width2[i], lat);
                const dz = KERB_PROF_Z[c] * env;
                writeVec3(posAccIdx, vIdx, x, yBase + dz, z);
              }
            }
            runStart = r;
          }
        }
      } else {
        for (let v = 0; v < vCount; v++) {
          const [x, yOld, z] = readVec3(posAccIdx, v);
          const { i, lat } = findSampleAndLat(x, z);
          const w = width2[i];
          const czOld = crossZ(bankOld[i], w, lat);
          const czNew = crossZ(bankNew[i], w, lat);
          let dy = czNew - czOld;

          if (node.name === 'Track_Runoff_Paint') {
            const s = i * ds2;
            const dzOld = yOld - (py[i] + czOld);
            if ((s >= 225 && s <= 260) || (s >= 4770 && s <= 4800)) {
              if (lat > w * 0.5 && dzOld > -0.06 && dzOld < -0.002) {
                const dzNew = -0.002;
                dy += dzNew - dzOld;
              }
            }
          } else if (node.name === 'Track_Pitlane') {
            const s = i * ds2;
            const dzOld = yOld - (py[i] + czOld);
            if (s >= 220 && s <= 255) {
              const fade = 1 - ss(225, 250, s);
              const dzNew = -0.004 * fade;
              dy += dzNew - dzOld;
            } else if (s >= 4775 && s <= 4810) {
              const fade = ss(4782, 4805, s);
              const dzNew = -0.004 * fade;
              dy += dzNew - dzOld;
            }
          }

          writeVec3(posAccIdx, v, x, yOld + dy, z);
        }
      }

      // Update accessor min/max for POSITION
      const posAcc = gltf.accessors[posAccIdx];
      if (posAcc.min && posAcc.max) {
        let minX = Infinity,
          minY = Infinity,
          minZ = Infinity;
        let maxX = -Infinity,
          maxY = -Infinity,
          maxZ = -Infinity;
        for (let v = 0; v < vCount; v++) {
          const [x, y, z] = readVec3(posAccIdx, v);
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (z < minZ) minZ = z;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          if (z > maxZ) maxZ = z;
        }
        posAcc.min = [minX, minY, minZ];
        posAcc.max = [maxX, maxY, maxZ];
      }

      // Recompute smooth vertex normals if NORMAL attribute is present
      if (
        prim.attributes.NORMAL !== undefined &&
        prim.indices !== undefined &&
        ['Track_Asphalt_Road', 'Track_Collider_Road', 'Track_Runoff_Paint', 'Track_Kerbs', 'Track_Pitlane'].includes(
          node.name
        )
      ) {
        const normAccIdx = prim.attributes.NORMAL;
        const idxAccIdx = prim.indices;
        const iCount = gltf.accessors[idxAccIdx].count;
        const nx = new Float64Array(vCount);
        const ny = new Float64Array(vCount);
        const nz = new Float64Array(vCount);
        for (let t = 0; t + 2 < iCount; t += 3) {
          const i0 = readIndex(idxAccIdx, t);
          const i1 = readIndex(idxAccIdx, t + 1);
          const i2 = readIndex(idxAccIdx, t + 2);
          const a = readVec3(posAccIdx, i0);
          const b = readVec3(posAccIdx, i1);
          const c = readVec3(posAccIdx, i2);
          const e1x = b[0] - a[0],
            e1y = b[1] - a[1],
            e1z = b[2] - a[2];
          const e2x = c[0] - a[0],
            e2y = c[1] - a[1],
            e2z = c[2] - a[2];
          let fnx = e1y * e2z - e1z * e2y;
          let fny = e1z * e2x - e1x * e2z;
          let fnz = e1x * e2y - e1y * e2x;
          if (fny < 0) {
            fnx = -fnx;
            fny = -fny;
            fnz = -fnz;
          }
          nx[i0] += fnx;
          ny[i0] += fny;
          nz[i0] += fnz;
          nx[i1] += fnx;
          ny[i1] += fny;
          nz[i1] += fnz;
          nx[i2] += fnx;
          ny[i2] += fny;
          nz[i2] += fnz;
        }
        for (let v = 0; v < vCount; v++) {
          const l = Math.hypot(nx[v], ny[v], nz[v]) || 1;
          writeVec3(normAccIdx, v, nx[v] / l, ny[v] / l, nz[v] / l);
        }
      }
    }
  }

  const newJsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const pad = (4 - (newJsonBytes.length % 4)) % 4;
  const paddedJson = Buffer.concat([newJsonBytes, Buffer.alloc(pad, 0x20)]);
  const binChunkHeader = buf.subarray(20 + jsonLen, 20 + jsonLen + 8);
  const outGlb = Buffer.alloc(20 + paddedJson.length + 8 + bin.length);
  outGlb.write('glTF', 0, 4, 'ascii');
  outGlb.writeUInt32LE(2, 4);
  outGlb.writeUInt32LE(outGlb.length, 8);
  outGlb.writeUInt32LE(paddedJson.length, 12);
  outGlb.write('JSON', 16, 4, 'ascii');
  paddedJson.copy(outGlb, 20);
  binChunkHeader.copy(outGlb, 20 + paddedJson.length);
  bin.copy(outGlb, 20 + paddedJson.length + 8);
  writeFileSync(GLB_PATH, outGlb);

  // 5. Update track_data.json
  const samples = trackJson.samples as {
    s: number;
    p: [number, number, number];
    r: [number, number, number];
    t: [number, number, number];
    yProf: number[];
    ro: number;
    w: number;
    b: number;
  }[];
  const nJson = samples.length;
  const dsJson = totalLengthM / nJson;
  const latOffsets: number[] = trackJson.metadata.latProfileOffsets ?? [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12];

  const sampleBank = (s: number): number => {
    const u = (((s % totalLengthM) + totalLengthM) % totalLengthM) / ds2;
    const i0 = Math.floor(u) % n2;
    const i1 = (i0 + 1) % n2;
    const f = u - Math.floor(u);
    return bankNew[i0] * (1 - f) + bankNew[i1] * f;
  };

  for (let i = 0; i < nJson; i++) {
    const smp = samples[i];
    let bVal = sampleBank(smp.s);
    const iPrev2 = (i - 2 + nJson) % nJson;
    const iNext2 = (i + 2) % nJson;
    const hPrev = Math.atan2(-samples[iPrev2].t[2], samples[iPrev2].t[0]);
    const hNext = Math.atan2(-samples[iNext2].t[2], samples[iNext2].t[0]);
    let dh = hNext - hPrev;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const kappa5 = -dh / (4 * dsJson);
    if (Math.abs(kappa5) > 1 / 400 && bVal * Math.sign(kappa5) < 0) {
      bVal = 0;
    }
    smp.b = Number(bVal.toFixed(4));
    const pySmp = smp.p[1];
    smp.r[1] = Number((pySmp - Math.tan(smp.b) * smp.ro).toFixed(3));
    smp.yProf = latOffsets.map((lat) => Number((pySmp + crossZ(smp.b, smp.w, lat)).toFixed(3)));
  }

  if (Array.isArray(trackJson.turns)) {
    for (const turn of trackJson.turns) {
      if (typeof turn.sApprox === 'number') {
        const bRad = sampleBank(turn.sApprox);
        turn.bankingDeg = Number(Math.abs((bRad * 180) / Math.PI).toFixed(1));
      }
    }
  }

  if (Array.isArray(trackJson.spawnGrid)) {
    for (const slot of trackJson.spawnGrid) {
      const idx = Math.round((slot.s % totalLengthM) / dsJson) % nJson;
      const smp = samples[idx];
      slot.position[1] = Number((smp.p[1] - Math.tan(smp.b) * slot.lateral).toFixed(3));
    }
  }

  writeFileSync(JSON_PATH, JSON.stringify(trackJson));
  console.log(`Smoothed ${GLB_PATH} (${n2} cross-sections) and ${JSON_PATH} (${nJson} samples).`);
}

main();
