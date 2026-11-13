/**
 * Placement and blow-up recovery checks for the f12026-car vehicle model (f12026-car, AMG GT3) on the Rwanda colliders.
 *
 * Every rejoin goes through `VehiclePhysics.reset`: a car put back at a pose, the autopilot's stuck rejoin, the AI's rejoin, and the
 * recovery of a car whose state blew up. On Rwanda's 10–14 % hills a car placed level, rolling at speed, used to be
 * pitched over by its own springs and driven tyres before it was released (issue #21: "the car just starts flying"),
 * and a car whose state had gone non-finite could never be put back, so it stayed NaN for the rest of the session.
 */
import * as THREE from 'three';
import type { BuiltTrackData } from '../../src/lib/track-data';
import type { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';

type Check = (name: string, ok: boolean, detail: string) => void;

const _up = new THREE.Vector3();

/** Body up · road normal under the car (1 = seated on the road) */
function seated(sim: F12026CarSim): number {
  const v = sim.vehicle;
  _up.set(0, 1, 0).applyQuaternion(v.quaternion);
  const n = v.wheels.reduce((acc, w) => acc.add(_n.set(w.ground.nx, w.ground.ny, w.ground.nz)), new THREE.Vector3()).normalize();
  return _up.dot(n);
}
const _n = new THREE.Vector3();

export function checkPlacementAndRecovery(check: Check, label: string, track: BuiltTrackData, makeSim: () => F12026CarSim) {
  const sim = makeSim();
  sim.assistPreset = 'semi_pro';
  const v = sim.vehicle;
  const L = track.totalLengthM;
  const fps = 60;

  // Rolling placements round the lap, and the steepest grades (Rwanda climbs at up to ≈14 %)
  const steep = [...track.samples].sort((a, b) => Math.abs(b.tangent.y) - Math.abs(a.tangent.y)).slice(0, 12).map((s) => s.s);
  const spots = [...Array.from({ length: Math.floor(L / 100) }, (_, i) => i * 100), ...steep];
  let worstSeat = 1;
  let worstSeatAt = '';
  let worstSpin = 0;
  let worstDrive = 1;
  let worstDriveAt = '';
  for (const kmh of [0, 260]) {
    for (const s of spots) {
      sim.teleportToDistance(s, kmh / 3.6, 0);
      const seat = seated(sim);
      if (seat < worstSeat) {
        worstSeat = seat;
        worstSeatAt = `s ${s.toFixed(0)} m at ${kmh} km/h`;
      }
      worstSpin = Math.max(worstSpin, v.angularVelocity.length());
      if (kmh === 0) continue;
      // The first half second after a rolling release: straight on, on the throttle, still on its wheels
      for (let i = 0; i < fps / 2; i++) {
        sim.step(1 / fps, { throttle: 1, analogSteer: 0 });
        const seatNow = seated(sim);
        if (seatNow < worstDrive) {
          worstDrive = seatNow;
          worstDriveAt = `s ${s.toFixed(0)} m`;
        }
      }
    }
  }
  check(`${label}: placed seated on the road (grade, camber)`, worstSeat > 0.995 && worstSpin < 0.3,
    `worst up·normal ${worstSeat.toFixed(4)} at ${worstSeatAt}, spin ${worstSpin.toFixed(2)} rad/s, ${spots.length} spots × 0 / 260 km/h`);
  check(`${label}: rolling release at 260 km/h stays on its wheels`, worstDrive > 0.97,
    `worst up·normal ${worstDrive.toFixed(3)} in the first 0.5 s, at ${worstDriveAt}`);

  // A blown-up integration (non-finite body state mid-run) is put back on the track and drives on
  sim.teleportToDistance(500, 50, 0);
  for (let i = 0; i < fps; i++) sim.step(1 / fps, { throttle: 1 });
  v.angularVelocity.set(Number.NaN, Number.NaN, Number.NaN);
  sim.step(1 / fps, { throttle: 1 });
  const placedFinite = v.stateIsSane() && Number.isFinite(sim.telemetry.speedKmh) && Number.isFinite(sim.sMeters);
  for (let i = 0; i < 3 * fps; i++) sim.step(1 / fps, { throttle: 1 });
  const kmhAfter = sim.telemetry.speedKmh;
  check(`${label}: recovers from a blown-up state`, placedFinite && v.stateIsSane() && kmhAfter > 60,
    `${placedFinite ? 'back on the track' : 'still non-finite'}, ${Number.isFinite(kmhAfter) ? kmhAfter.toFixed(0) : 'NaN'} km/h after 3 s on the throttle`);

  // An impossible (finite) state counts as blown up too: 300 m/s straight up
  sim.teleportToDistance(800, 50, 0);
  sim.step(1 / fps, { throttle: 1 });
  v.velocity.y = 300;
  sim.step(1 / fps, { throttle: 1 });
  check(`${label}: an impossible speed is recovered as a blow-up`, v.stateIsSane() && Math.abs(v.velocity.y) < 20,
    `vertical speed ${v.velocity.y.toFixed(1)} m/s after the recovery`);
}
