/**
 * Synthetic flat, straight, very wide test track for controlled vehicle-dynamics tests
 * (skidpad, straight-line acceleration, braking) without walls or real-track geometry.
 *
 * The centreline runs along +Z from the origin. The surface is the plane y = 0, so every
 * lateral offset is asphalt up to ±halfWidth.
 */
import * as THREE from 'three';
import type { BuiltTrackData } from '../../src/lib/track-data';
import type { TrackSamplePoint } from '../../src/types/f1';

export function createFlatTestTrack(lengthM = 20_000, widthM = 600, numSamples = 4000): BuiltTrackData {
  const ds = lengthM / numSamples;
  const tangent = new THREE.Vector3(0, 0, 1);
  const normal = new THREE.Vector3(0, 1, 0);
  // Right-hand side of a car heading +Z is −X (see F1Physics2026 basis)
  const binormal = new THREE.Vector3(-1, 0, 0);

  const makeSample = (index: number, s: number): TrackSamplePoint => ({
    index,
    s,
    t: s / lengthM,
    position: new THREE.Vector3(0, 0, s),
    racingLinePos: new THREE.Vector3(0, 0, s),
    tangent: tangent.clone(),
    normal: normal.clone(),
    binormal: binormal.clone(),
    bankingRad: 0,
    width: widthM,
    curvature: 0,
    verticalCurvature: 0,
    slopeSin: 0,
    sector: 1,
    turnNumber: 0,
    turnName: 'Flat test pad',
    runoffStyle: 'main_straight',
    kerbLeft: false,
    kerbRight: false,
    drsZone: false,
    racingLineOffset: 0,
    optimalSpeedKmh: 350,
    brakingZone: 0,
    gripMultiplier: 1,
  });

  const samples: TrackSamplePoint[] = [];
  for (let i = 0; i < numSamples; i++) samples.push(makeSample(i, i * ds));

  const wrap = (s: number) => ((s % lengthM) + lengthM) % lengthM;
  const getSampleAtDistance = (s: number) => {
    const w = wrap(s);
    return makeSample(Math.floor(w / ds) % numSamples, w);
  };
  const locateWorldPoint = (worldX: number, worldZ: number) => {
    const s = wrap(worldZ);
    const i0 = Math.floor(s / ds) % numSamples;
    return { i0, i1: (i0 + 1) % numSamples, t: s / ds - Math.floor(s / ds), s, lateralH: -worldX };
  };

  return {
    samples,
    totalLengthM: lengthM,
    totalLength: lengthM,
    spline: new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, lengthM)]),
    getSampleAtDistance,
    projectWorldToTrack: (worldX: number, worldZ: number) => {
      const loc = locateWorldPoint(worldX, worldZ);
      return { sample: getSampleAtDistance(loc.s), s: loc.s, lateralOffset: loc.lateralH, distSq: worldX * worldX };
    },
    locateWorldPoint,
    // No exported grid: the sims fall back to a slot just behind the line
    spawnGrid: [],
  };
}
