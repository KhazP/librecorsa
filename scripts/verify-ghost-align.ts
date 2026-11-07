/**
 * Headless checks for ghosts across circuit versions and their fade (`src/lib/sim/ghost-align.ts`): the geometry
 * fingerprint, the best-fit ground transform, re-seating a ghost from a moved / re-scaled scan, leaving a ghost from
 * this geometry alone, the fingerprint surviving validation, and the fade near the player's car.
 *
 *   npx tsx scripts/verify-ghost-align.ts
 */
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import {
  alignGhostToTrack,
  applyGroundTransform,
  fitGroundTransform,
  GHOST_OPACITY,
  ghostFade,
  offRoadShare,
  trackGeometryKey,
} from '../src/lib/sim/ghost-align';
import { LAP_SAMPLE_STRIDE, type LapRecording } from '../src/lib/sim/lap-types';
import { validateLapRecording } from '../src/lib/sim/lap-recorder';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);

const track = getActiveTrackData();
const L = track.totalLengthM;
const key = trackGeometryKey(track);

/** A 90 s "lap" along the racing line, one sample every 0.1 s, optionally moved in the ground plane */
function lapOnLine(move?: (x: number, z: number) => { x: number; z: number }, yawTurn = 0): LapRecording {
  const n = 900;
  const data: number[] = [];
  const q = new THREE.Quaternion();
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawTurn);
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * L * 0.999;
    const smp = track.getSampleAtDistance(s);
    const p = smp.racingLinePos ?? smp.position;
    const m = move ? move(p.x, p.z) : { x: p.x, z: p.z };
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(smp.tangent.x, smp.tangent.z)).premultiply(turn);
    data.push(i * 0.1, s, m.x, p.y, m.z, q.x, q.y, q.z, q.w, 200, 1, 0, 0, 6);
  }
  return {
    version: 1,
    trackId: 'rwanda',
    vehicle: 'f12026-car',
    driverName: 'Test',
    driverCode: 'TST',
    lapTimeMs: (n - 1) * 100,
    sectorTimesMs: [30000, 30000, (n - 1) * 100 - 60000],
    recordedAt: 0,
    sampleHz: 10,
    data,
  };
}

/** Mean distance of a recording's path from the racing line at the same track distance (m) */
function meanLineError(rec: LapRecording): number {
  const n = rec.data.length / LAP_SAMPLE_STRIDE;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i * LAP_SAMPLE_STRIDE;
    const smp = track.getSampleAtDistance(rec.data[o + 1]);
    const p = smp.racingLinePos ?? smp.position;
    sum += Math.hypot(rec.data[o + 2] - p.x, rec.data[o + 4] - p.z);
  }
  return sum / n;
}

// ---------------------------------------------------------------------------
console.log('== Geometry fingerprint');
check('Stable for the same circuit', trackGeometryKey(track) === key && /^[0-9a-f]{8}$/.test(key), key);
const moved = {
  totalLengthM: L * 1.02,
  samples: track.samples,
  getSampleAtDistance: (s: number) => {
    const smp = track.getSampleAtDistance(s / 1.02);
    return { ...smp, position: smp.position.clone().multiplyScalar(1.02) };
  },
};
check('Changes with a re-scaled scan', trackGeometryKey(moved) !== key, trackGeometryKey(moved));

// ---------------------------------------------------------------------------
console.log('\n== Ground transform fit');
{
  const truth = { theta: 0.3, scale: 1.07, ax: 0, az: 0, bx: 25, bz: -40 };
  const A = Array.from({ length: 50 }, (_, i) => ({ x: Math.cos(i) * 300 + i, z: Math.sin(i * 1.7) * 200 }));
  const B = A.map((p) => applyGroundTransform(truth, p.x, p.z));
  const T = fitGroundTransform(A, B);
  const err = Math.max(...A.map((p, i) => { const q = applyGroundTransform(T, p.x, p.z); return Math.hypot(q.x - B[i].x, q.z - B[i].z); }));
  check('Recovers rotation, scale and offset exactly', Math.abs(T.theta - 0.3) < 1e-9 && Math.abs(T.scale - 1.07) < 1e-9 && err < 1e-6, `θ ${fmt(T.theta, 4)} s ${fmt(T.scale, 4)} err ${err.toExponential(1)}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Re-seating a ghost');
{
  const onLine = lapOnLine();
  check('Ghost on this circuit lies on the road', offRoadShare(onLine, track) === 0, `line error ${fmt(meanLineError(onLine), 3)} m`);
  const stamped = { ...onLine, trackGeometry: key, trackLengthM: L };
  check('Same fingerprint: left as it is', alignGhostToTrack(stamped, track).recording === stamped);
  check('No fingerprint, on the road: left as it is', alignGhostToTrack(onLine, track).recording === onLine);

  // An older version of the scan: turned 8°, 3 % bigger and shifted 40 m
  const old = { theta: (8 * Math.PI) / 180, scale: 1.03, ax: 0, az: 0, bx: 40, bz: 25 };
  const ghostOld = lapOnLine((x, z) => applyGroundTransform(old, x, z), -old.theta);
  const before = meanLineError(ghostOld);
  const keyed = alignGhostToTrack({ ...ghostOld, trackGeometry: 'deadbeef', trackLengthM: L }, track);
  const afterKeyed = meanLineError(keyed.recording);
  check('Other fingerprint: moved onto this circuit', keyed.aligned && afterKeyed < 1, `line error ${fmt(before, 1)} m → ${fmt(afterKeyed, 2)} m`);
  check('Re-seated ghost is stamped with this circuit', keyed.recording.trackGeometry === key && keyed.recording.trackLengthM === L);
  const unkeyed = alignGhostToTrack(ghostOld, track);
  check('No fingerprint but off the road: moved too', unkeyed.aligned && meanLineError(unkeyed.recording) < 1, `off-road share ${fmt(offRoadShare(ghostOld, track), 2)}, aligned ${unkeyed.aligned}, line error ${fmt(meanLineError(unkeyed.recording), 2)} m`);
  // The heading turns with the path: the re-seated car points along the road again
  const o = 300 * LAP_SAMPLE_STRIDE;
  const d = keyed.recording.data;
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(d[o + 5], d[o + 6], d[o + 7], d[o + 8]));
  const tan = track.getSampleAtDistance(d[o + 1]).tangent;
  const headingErrDeg = (Math.acos(THREE.MathUtils.clamp(fwd.x * tan.x + fwd.z * tan.z, -1, 1) / Math.hypot(fwd.x, fwd.z) / Math.hypot(tan.x, tan.z)) * 180) / Math.PI;
  check('Heading turned back with the path', headingErrDeg < 1, `${fmt(headingErrDeg, 2)}°`);
}

// ---------------------------------------------------------------------------
console.log('\n== Fingerprint kept through validation');
{
  const rec = { ...lapOnLine(), trackGeometry: key, trackLengthM: L };
  const v = validateLapRecording(JSON.parse(JSON.stringify(rec)));
  check('trackGeometry / trackLengthM survive', v?.trackGeometry === key && v?.trackLengthM === L);
  const bad = validateLapRecording(JSON.parse(JSON.stringify({ ...rec, trackGeometry: '<script>', trackLengthM: -5 })));
  check('Malformed values dropped, lap kept', bad !== null && bad.trackGeometry === undefined && bad.trackLengthM === undefined);
}

// ---------------------------------------------------------------------------
console.log('\n== Ghost fade near the player');
check('Gone within 4 m', ghostFade(0) === 0 && ghostFade(4) === 0);
check('Full beyond 12 m', ghostFade(12) === 1 && ghostFade(50) === 1);
check('Smooth in between', Math.abs(ghostFade(8) - 0.5) < 1e-9 && ghostFade(6) < ghostFade(10), `fade(6) ${fmt(ghostFade(6), 3)} fade(10) ${fmt(ghostFade(10), 3)}`);
check('Base opacity unchanged', GHOST_OPACITY === 0.3);

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll ghost-align checks passed.');
process.exit(failures.length ? 1 : 0);
