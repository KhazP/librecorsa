/**
 * Verifies the #154 race performance & AI smoothing guarantees:
 *   1. `FieldPeers` damped error smoothing absorbs late worker packets without backward-snap stuttering,
 *      decays cleanly to the true pose, and still snaps immediately on teleports (> 6 m).
 *   2. `createAiPeerCar()` enables AI-lite physics ONLY on AI cars (never the player car) while keeping
 *      stability and pace parity on graded GLB colliders.
 *   3. `autopilotEdges` probing on Circuit de la Sarthe 1982 (13.6 km) runs without a multi-hundred-ms freeze.
 *
 *   npx tsx scripts/verify-ai-perf-smooth.ts
 */
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { FIELD_POSE_STRIDE, FieldPeers } from "../src/lib/sim/runtime/field-frame";
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from "../src/lib/track-data";
import { loadGlbGeometry } from "./lib/glb-geometry";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

// ---- 1. FieldPeers jitter damping & teleport snap
{
  const roster = [{ peerId: "ai-1", driverCode: "VER", teamColorHex: "#3671C6", vehicle: "f12026-car" as const }];
  const peers = new FieldPeers(roster, null);
  const pack = (x: number, z: number, vx: number, vz: number) => {
    const a = new Float64Array(FIELD_POSE_STRIDE);
    a[0] = x;
    a[1] = 0.3;
    a[2] = z;
    a[6] = 1; // identity quat w
    a[7] = vx;
    a[9] = vz;
    a[19] = Math.hypot(vx, vz) * 3.6;
    return a;
  };

  // Lockstep (dtS = 0): exact worker pose
  peers.apply(pack(0, 100, 0, 60));
  const exact = peers.shownAt(0, 0)[0];
  check("FieldPeers lockstep reports exact worker position", Math.abs(exact.position.z - 100) < 1e-9, `z=${exact.position.z.toFixed(6)}`);

  // Steady 60 Hz stream: zero prediction error -> zero lag
  let zSteady = 100;
  let steadyErr = 0;
  for (let i = 0; i < 10; i++) {
    zSteady += 60 * (1 / 60);
    peers.apply(pack(0, zSteady, 0, 60));
    steadyErr = Math.abs(peers.shownAt(0, 1 / 60)[0].position.z - zSteady);
  }
  check("FieldPeers introduces zero lag on steady 60 Hz updates", steadyErr < 1e-6, `err=${(steadyErr * 1000).toFixed(3)} mm`);

  // Simulate normal 60 Hz frame after extrapolating +30 ms ahead
  const extrapolated = peers.shownAt(0.03, 1 / 60)[0].position.z;
  // Next worker packet arrives slightly late/behind extrapolated pose (0.6 m behind drawn)
  const lateZ = extrapolated - 0.6;
  peers.apply(pack(0, lateZ, 0, 60));
  // First rendered frame after late packet: must NOT jump backward!
  const afterLate = peers.shownAt(0.008, 1 / 60)[0].position.z;
  const backwardDrop = extrapolated - afterLate;
  check(
    "FieldPeers absorbs late worker packet without backward snap",
    backwardDrop < 0.05,
    `prev=${extrapolated.toFixed(3)} m -> next=${afterLate.toFixed(3)} m (drop ${backwardDrop.toFixed(3)} m)`
  );

  // Over ~300 ms of steady updates, visual error decays below 20 mm
  let zTrue = lateZ + 60 * 0.008;
  let lastShown = afterLate;
  for (let i = 0; i < 20; i++) {
    zTrue += 60 * (1 / 60);
    peers.apply(pack(0, zTrue, 0, 60));
    lastShown = peers.shownAt(0, 1 / 60)[0].position.z;
  }
  const residual = Math.abs(lastShown - zTrue);
  check("FieldPeers residual smoothing error decays cleanly", residual < 0.02, `residual=${(residual * 1000).toFixed(1)} mm`);

  // Large teleport (> 6 m, e.g. grid reset / flashback) must snap immediately
  peers.apply(pack(0, 500, 0, 0));
  const snapped = peers.shownAt(0, 1 / 60)[0].position.z;
  check("FieldPeers snaps immediately on teleports (> 6 m)", Math.abs(snapped - 500) < 1e-3, `z=${snapped.toFixed(3)} m`);

  // Collision / sudden velocity step (> 3 m/s, e.g. wall impact) must snap with 0 m clipping into the barrier
  peers.apply(pack(0, 100, 0, 60));
  peers.shownAt(0, 1 / 60);
  // Wall stop at z = 100.2 (velocity drops 60 -> 0 m/s): smoothing must NOT carry the car ~1 m past the wall
  peers.apply(pack(0, 100.2, 0, 0));
  const afterHit = peers.shownAt(0, 1 / 60)[0].position.z;
  check(
    "FieldPeers skips smoothing on sudden collision velocity step (no wall penetration)",
    Math.abs(afterHit - 100.2) < 1e-3,
    `z=${afterHit.toFixed(3)} m (wall at 100.200 m)`
  );
}

// ---- 2. AI-lite physics isolation, stability, and pace parity on graded GLB colliders
{
  const trackId = "rwanda_official_short";
  const dataPath = `public/tracks/${trackId}/track_data.json`;
  if (existsSync(dataPath)) {
    setActiveTrack(trackId, JSON.parse(readFileSync(dataPath, "utf8")) as RawTrackJson);
    const track = getActiveTrackData(1200);
    const root = loadGlbGeometry(`public${track.meshUrl}`);

    const player = new F12026CarSim(track, root);
    const peer = player.createAiPeerCar() as F12026CarSim;
    const playerLite = player.vehicle.aiLitePhysics;
    const peerLite = peer.vehicle.aiLitePhysics;
    check("Player car keeps full 2 kHz / 5-point physics (aiLitePhysics=false)", playerLite === false);
    check("AI peer car enables AI-lite physics (aiLitePhysics=true)", peerLite === true);

    player.aiAutopilot = true;
    peer.aiAutopilot = true;
    player.resetToStartGrid(false);
    peer.resetToStartGrid(false);

    let offTrack = 0;
    let maxSpeedPeer = 0;
    const steps = 10 * 125; // 10 s at 125 Hz (8 ms race steps)
    for (let i = 0; i < steps; i++) {
      player.step(1 / 125, {});
      peer.step(1 / 125, {});
      if (peer.telemetry.offTrack) offTrack++;
      const spd = peer.telemetry.speedKmh;
      if (spd > maxSpeedPeer) maxSpeedPeer = spd;
    }
    const deltaS = Math.abs(player.sMeters - peer.sMeters);
    check("AI-lite peer stays cleanly on track over 10 s on Rwanda grades", offTrack === 0 && maxSpeedPeer > 200, `offTrack=${offTrack}, vMax=${maxSpeedPeer.toFixed(1)} km/h`);
    check("AI-lite peer matches full-physics pace parity within 12 m over 10 s", deltaS < 12.0, `player=${player.sMeters.toFixed(1)} m, peer=${peer.sMeters.toFixed(1)} m, Δs=${deltaS.toFixed(2)} m`);
  } else {
    console.log(`SKIP  AI-lite physics parity (${dataPath} missing)`);
  }
}

// ---- 3. Fast autopilotEdges probing on Sarthe 1982 (13.6 km)
{
  const dataPath = "public/tracks/le_mans_82/track_data.json";
  if (existsSync(dataPath)) {
    setActiveTrack("le_mans_82", JSON.parse(readFileSync(dataPath, "utf8")) as RawTrackJson);
    const track = getActiveTrackData(1200);
    const root = loadGlbGeometry(`public${track.meshUrl}`);
    const car = new F12026CarSim(track, root);
    car.aiAutopilot = true;
    const t0 = performance.now();
    // First autopilot step triggers lazy autopilotEdges() + kerbLimits() probe
    car.step(1 / 125, {});
    const ms = performance.now() - t0;
    // Also ensure position stays valid (no NaN)
    const p = new THREE.Vector3();
    p.copy(car.worldPosition);
    check(
      "Sarthe 1982 first autopilot step (edge+kerb probe) avoids long freeze",
      ms < 150 && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
      `${ms.toFixed(1)} ms`
    );
  } else {
    console.log(`SKIP  Sarthe 1982 autopilot probe (${dataPath} not present in clean checkout)`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll AI perf & smoothing checks passed.");
