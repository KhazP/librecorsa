/**
 * Flashback: a car put back at a recorded pose lands there (position, height and heading), keeps its tyres' heat
 * and wear, and drives on from it on the road, not under it. Every car model, on the Rwanda circuit (with elevation).
 */
import * as THREE from "three";
import { evaluateSampleLateralHeightM, getRwandaTrackData } from "../src/lib/track-data";
import type { SimulatorCar } from "../src/lib/sim/simulator-car";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { createAmgGt3Sim } from "../src/lib/sim/gt3/AmgGt3Sim";
import { F1Physics2026 } from "../src/lib/f1-physics-2026";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${msg}`);
  if (!ok) failures++;
};

const track = getRwandaTrackData();
const fwd = new THREE.Vector3();
const yawOf = (q: THREE.Quaternion) => {
  fwd.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(fwd.x, fwd.z);
};
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
/** Road height under the car's origin (camber included), from the track data */
const roadY = (car: SimulatorCar) => {
  const p = track.projectWorldToTrack(car.worldPosition.x, car.worldPosition.z, car.sMeters);
  return evaluateSampleLateralHeightM(track.getSampleAtDistance(p.s), p.lateralOffset);
};

const cars: [string, () => SimulatorCar][] = [
  ["vf26", () => new F1Physics2026(track)],
  ["f12026-car", () => new F12026CarSim(track)],
  ["amg-gt3", () => createAmgGt3Sim(track)],
];

for (const [name, make] of cars) {
  console.log(`\n${name}`);
  const car = make();
  car.resetToStartGrid(true);
  car.aiAutopilot = true;
  const dt = 1 / 60;
  for (let t = 0; t < 20; t += dt) car.step(dt, {});

  // The pose a replay frame holds
  const rec = {
    x: car.worldPosition.x,
    y: car.worldPosition.y,
    z: car.worldPosition.z,
    yawRad: yawOf(car.worldQuaternion),
    speedMs: car.telemetry.speedKmh / 3.6,
    s: car.sMeters,
  };
  // The same measure while driving normally, as the reference for "on the road"
  let lowestLive = Infinity;
  for (let t = 0; t < 12; t += dt) {
    car.step(dt, {});
    lowestLive = Math.min(lowestLive, car.worldPosition.y - roadY(car));
  }
  const tyreBefore = [...car.telemetry.tireTempsC];
  const wearBefore = [...car.telemetry.tireWearPct];

  check(typeof car.restorePose === "function", "has restorePose");
  car.restorePose?.(rec);

  const dXZ = Math.hypot(car.worldPosition.x - rec.x, car.worldPosition.z - rec.z);
  const dY = car.worldPosition.y - rec.y;
  check(dXZ < 0.3, `lands at the recorded spot (${dXZ.toFixed(2)} m off)`);
  check(Math.abs(dY) < 0.15, `at the recorded height (${dY >= 0 ? "+" : ""}${dY.toFixed(3)} m)`);
  check(angleDiff(yawOf(car.worldQuaternion), rec.yawRad) < 0.02, "facing the recorded heading");
  check(Math.abs(car.telemetry.speedKmh / 3.6 - rec.speedMs) < 2, `rolling at the recorded speed (${car.telemetry.speedKmh.toFixed(0)} km/h vs ${(rec.speedMs * 3.6).toFixed(0)})`);
  const tyreDrop = Math.max(...car.telemetry.tireTempsC.map((v, i) => tyreBefore[i] - v));
  check(tyreDrop < 5, `tyres keep their heat (largest drop ${tyreDrop.toFixed(1)} °C)`);
  const wearDrop = Math.max(...car.telemetry.tireWearPct.map((v, i) => wearBefore[i] - v));
  check(wearDrop < 0.01, "tyres keep their wear");

  // Drives on from there, on the road
  let lowest = Infinity;
  for (let t = 0; t < 5; t += dt) {
    car.step(dt, {});
    lowest = Math.min(lowest, car.worldPosition.y - roadY(car));
  }
  check(
    lowest > Math.min(-0.1, lowestLive - 0.1),
    `stays on the road after the flashback (lowest ${lowest.toFixed(2)} m vs the road; ${lowestLive.toFixed(2)} m while driving before)`
  );
  check(car.telemetry.speedKmh > 40, `drives on (${car.telemetry.speedKmh.toFixed(0)} km/h after 5 s)`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nAll flashback checks passed.");
if (failures) process.exit(1);
