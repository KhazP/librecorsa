/**
 * Where a ported car's wheels meet the road while it drives: the GLB's wheels put on a rig the way
 * `src/lib/ported-car-model.ts` does (axle midpoint on the vehicle model's, tyre bottoms on the car frame's origin
 * plane), driven by the real `updateCorners` and tyre deformation from a rigid-body sim on the autopilot, and the
 * flattened tyre bottom of each corner compared with the track collider under it.
 *
 * `bodyFrameMm` is the same corner left on the car frame's origin plane (the wheels carried by the sprung body), for
 * comparison: on the rigid-body model that plane heaves, pitches and rolls with the body.
 */
import * as THREE from 'three';
import { cornerRoadHeight, updateCorners, WHEEL_NODES, WHEEL_SIDES, type RigCorner } from '../../src/lib/render/corner-rig';
import { installTyreDeformation } from '../../src/lib/render/tyre-deformation';
import { createGroundHit } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import type { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';

/**
 * How far a loaded tyre's flattened bottom may sit from the collider under it (mm). What is left is the tyre's own
 * contact model (it climbs a sharp rise along its contact arc) and the model's corners standing a few cm from the
 * vehicle model's; wheels carried by the body sank 40-46 mm at speed and under braking.
 */
export const WHEEL_ON_ROAD_TOLERANCE_MM = 15;

/** Autopilot time from the grid: the run to the first braking zone and through the opening corners at > 250 km/h */
export const WHEEL_CONTACT_RUN_S = 60;

export interface PortedWheelExtras {
  wheelCentres: Record<string, [number, number, number]>;
  tyreRadius: Record<string, number>;
  tyreHalfWidth?: Record<string, number>;
}

export interface WheelContactRange {
  /** Flattened tyre bottom − road (mm) over the loaded samples: lowest, highest */
  minMm: number;
  maxMm: number;
  /** The same with the wheels left on the car frame's origin plane */
  bodyFrameMinMm: number;
  bodyFrameMaxMm: number;
  samples: number;
  /** Highest speed reached (km/h) */
  topSpeedKmh: number;
}

/** The rig's model → car-frame translation (`createPortedCarRig`): axle midpoints matched, front tyre bottom at y = 0 */
export function portedModelOffset(
  extras: PortedWheelExtras,
  chassis: { wheelbase: number; frontWeightFraction: number }
): THREE.Vector3 {
  const lf = extras.wheelCentres.WHEEL_LF;
  const lr = extras.wheelCentres.WHEEL_LR;
  const physicsMidZ = chassis.wheelbase * (0.5 - chassis.frontWeightFraction);
  return new THREE.Vector3(0, (extras.tyreRadius.LF ?? lf[1]) - lf[1], physicsMidZ - 0.5 * (lf[2] + lr[2]));
}

interface ModelRig {
  corners: RigCorner[];
  radius: number[];
}

function buildRig(extras: PortedWheelExtras, chassis: { wheelbase: number; frontWeightFraction: number }): ModelRig {
  const offset = portedModelOffset(extras, chassis);
  const corners: RigCorner[] = [];
  const radius: number[] = [];
  WHEEL_NODES.forEach((name, i) => {
    const side = WHEEL_SIDES[i];
    const steer = new THREE.Group();
    steer.position.fromArray(extras.wheelCentres[name]).add(offset);
    const spin = new THREE.Group();
    steer.add(spin);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    spin.add(mesh);
    const r = extras.tyreRadius[side];
    const tyre = installTyreDeformation(mesh, { unloadedRadiusM: r, halfWidthM: extras.tyreHalfWidth?.[side] ?? 0.16 });
    corners.push({ steer, spin, isFront: i < 2, isLeft: i % 2 === 1, restY: steer.position.y, tyre });
    radius.push(r);
  });
  return { corners, radius };
}

/**
 * Drives `sim` on its autopilot from the grid for `seconds` and returns, per car, the range of tyre bottom − road
 * over the corners whose tyre is loaded (a wheel off the ground may float). `sim` must have its track colliders.
 */
export function measurePortedWheelContact(
  sim: F12026CarSim,
  ground: { query(x: number, z: number, probeY: number, out: ReturnType<typeof createGroundHit>): boolean },
  cars: Record<string, PortedWheelExtras>,
  chassis: { wheelbase: number; frontWeightFraction: number },
  seconds: number
): Record<string, WheelContactRange> {
  const rigs = Object.fromEntries(Object.entries(cars).map(([id, extras]) => [id, buildRig(extras, chassis)]));
  const out: Record<string, WheelContactRange> = {};
  for (const id of Object.keys(cars)) {
    out[id] = { minMm: Infinity, maxMm: -Infinity, bodyFrameMinMm: Infinity, bodyFrameMaxMm: -Infinity, samples: 0, topSpeedKmh: 0 };
  }
  sim.resetToStartGrid(false);
  sim.aiAutopilot = true;
  const hit = createGroundHit();
  const p = new THREE.Vector3();
  const dt = 1 / 120;
  const settleS = 1;
  for (let i = 0; i * dt < seconds; i++) {
    sim.step(dt, {});
    if (i * dt < settleS) continue;
    const tyres = sim.tyreVisuals;
    const roadWheel = -sim.telemetry.steering * sim.maxSteerAngleRad;
    const speedKmh = Math.abs(sim.vxMs) * 3.6;
    for (const [id, rig] of Object.entries(rigs)) {
      updateCorners(rig.corners, roadWheel, sim.wheelRotationRad, tyres);
      const range = out[id];
      range.topSpeedKmh = Math.max(range.topSpeedKmh, speedKmh);
      rig.corners.forEach((c, k) => {
        if (!(tyres[k].verticalDeflectionM > 0)) return;
        const squash = c.tyre?.axleDropM ?? 0;
        // The flattened patch: the steer pivot less the squashed radius (its x, z stay put under steering)
        p.set(c.steer.position.x, c.steer.position.y - (rig.radius[k] - squash), c.steer.position.z);
        const roadInCar = cornerRoadHeight(c, tyres);
        p.applyQuaternion(sim.worldQuaternion).add(sim.worldPosition);
        if (!ground.query(p.x, p.z, p.y + 0.6, hit)) return;
        const errMm = (p.y - hit.height) * 1000;
        // The same corner on the car frame's origin plane (the bottom of a tyre carried by the body)
        p.set(c.steer.position.x, c.steer.position.y - roadInCar - (rig.radius[k] - squash), c.steer.position.z);
        p.applyQuaternion(sim.worldQuaternion).add(sim.worldPosition);
        const bodyMm = (p.y - hit.height) * 1000;
        range.minMm = Math.min(range.minMm, errMm);
        range.maxMm = Math.max(range.maxMm, errMm);
        range.bodyFrameMinMm = Math.min(range.bodyFrameMinMm, bodyMm);
        range.bodyFrameMaxMm = Math.max(range.bodyFrameMaxMm, bodyMm);
        range.samples++;
      });
    }
  }
  for (const rig of Object.values(rigs)) for (const c of rig.corners) c.tyre?.dispose();
  return out;
}
