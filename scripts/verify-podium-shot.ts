/**
 * Checks the podium shot after a race (`src/lib/render/podium-shot.ts`): when it plays (the top three known, once per
 * race, skippable, straight to the table when something is missing), where the cars park on the start/finish straight,
 * that the camera keeps all three in frame on a wide and a narrow screen, and which cars are drawn where. Then the
 * full-screen podium after it: when it follows the shot, how long it stays, what closes it, and its aerial camera.
 * Run: npx tsx scripts/verify-podium-shot.ts
 */
import * as THREE from "three";
import { getActiveTrackData } from "../src/lib/track-data";
import type { RaceResultEntry, RaceStatus } from "../src/types/f1";
import type { InterpolatedPeerState } from "../src/lib/sim/multiplayer-sync";
import type { ShowContext } from "../src/lib/show/show-context";
import {
  PODIUM_BOARD_S,
  PODIUM_SHOT_S,
  PODIUM_WAIT_S,
  PodiumDirector,
  PodiumFlow,
  podiumCameraAt,
  podiumCue,
  podiumPeerFor,
  podiumSet,
  type PodiumRow,
} from "../src/lib/render/podium-shot";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}

const row = (position: number, code: string, extra: Partial<RaceResultEntry> = {}): RaceResultEntry => ({
  position,
  driverCode: code,
  name: code,
  teamColorHex: "#fff",
  isPlayer: code === "YOU",
  finishTimeS: 300 + position,
  gapS: null,
  lapsDown: 0,
  lapsCompleted: 2,
  bestLapMs: null,
  dnf: false,
  ...extra,
});
const status = (results: RaceResultEntry[] | undefined, resultsFinal = false): RaceStatus =>
  ({ phase: "finished", lightsOn: 0, position: 1, fieldSize: 4, lap: 2, standings: [], results, resultsFinal }) as RaceStatus;

console.log("When the top three are known");
{
  const running = row(3, "C", { finishTimeS: null });
  check("no result yet: no cue", podiumCue(status(undefined)) === null);
  check("P3 still running: wait", podiumCue(status([row(1, "YOU"), row(2, "B"), running, row(4, "D", { finishTimeS: null })])) === null);
  const cue = podiumCue(status([row(2, "B"), row(1, "YOU"), row(3, "C"), row(4, "D", { finishTimeS: null })]));
  check("all three in: P1, P2, P3", cue?.map((r) => r.driverCode).join() === "YOU,B,C", JSON.stringify(cue));
  const final = podiumCue(status([row(1, "A"), row(2, "YOU"), row(3, "C", { finishTimeS: null, dnf: true })], true));
  check("a final classification: whoever finished in the top three", final?.map((r) => r.driverCode).join() === "A,YOU");
}

console.log("The flow");
{
  const three = [row(1, "A"), row(2, "YOU"), row(3, "C")];
  const f = new PodiumFlow();
  const yes = () => true;
  f.step(status(undefined), 0.1, true, yes);
  check("racing: idle", f.stage === "idle");
  f.step(status([row(1, "YOU"), row(2, "B", { finishTimeS: null }), row(3, "C", { finishTimeS: null })]), 0.1, true, yes);
  check("the player's flag: waiting for the top three", f.stage === "waiting");
  f.step(status(three), 0.1, true, yes);
  check("the top three in: the shot plays", f.stage === "playing" && f.rows.length === 3);
  for (let t = 0; t < PODIUM_SHOT_S - 0.5; t += 0.1) f.step(status(three), 0.1, true, yes);
  check("for about six seconds", f.stage === "playing");
  for (let t = 0; t < 1; t += 0.1) f.step(status(three), 0.1, true, yes);
  check("then the table", f.stage === "done" && f.rows.length === 0);
  f.step(status(three, true), 0.1, true, yes);
  check("once per race (a final classification does not play it again)", f.stage === "done");
  f.step(status(undefined), 0.1, true, yes);
  check("a restart (no result any more) starts it over", f.stage === "idle");

  const s = new PodiumFlow();
  s.step(status(three), 0.1, true, yes);
  check("a key or tap skips to the table", s.skip() && s.stage === "done" && !s.skip());

  const missing = new PodiumFlow();
  missing.step(status(three), 0.1, true, () => false);
  check("anything missing (a car, the place to park): straight to the table", missing.stage === "done");
  const vr = new PodiumFlow();
  vr.step(status(three), 0.1, false, yes);
  check("not allowed (VR, a replay): straight to the table", vr.stage === "done");
  const slow = new PodiumFlow();
  const behind = status([row(1, "YOU"), row(2, "B", { finishTimeS: null }), row(3, "C", { finishTimeS: null })]);
  for (let t = 0; t < PODIUM_WAIT_S + 1; t += 0.5) slow.step(behind, 0.5, true, yes);
  check("the top three too long coming: the table without the shot", slow.stage === "done");
  const out = new PodiumFlow();
  out.step(status([row(1, "A", { finishTimeS: null }), row(2, "YOU", { finishTimeS: null, dnf: true })]), 0.1, true, yes);
  check("the player out of the race: the table at once", out.stage === "done");
}

console.log("Parked on the start/finish straight, in frame");
{
  const track = getActiveTrackData();
  const set = podiumSet(track, null);
  check("the circuit gives three places", set !== null && set.slots.length === 3);
  if (set) {
    const [p1, p2, p3] = set.slots.map((s) => s.position);
    const side = (p: THREE.Vector3) => p.clone().sub(p1).dot(set.left);
    check("P1 in the middle, P2 and P3 either side, side by side", side(p2) < -2.6 && side(p3) > 2.6 && Math.abs(p2.clone().sub(p1).dot(set.forward)) < 0.01);
    const sample = track.getSampleAtDistance(track.projectWorldToTrack(p1.x, p1.z).s);
    check("on the road", set.slots.every((s) => Math.abs(track.projectWorldToTrack(s.position.x, s.position.z).lateralOffset) < sample.width / 2 - 1));
    check("facing down the straight", set.slots.every((s) => new THREE.Vector3(0, 0, 1).applyQuaternion(s.quaternion).dot(set.forward) > 0.999));
    const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.12, 5500);
    const pos = new THREE.Vector3();
    const look = new THREE.Vector3();
    const inFrame = (aspect: number) => {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
      for (const u of [0, 0.5, 1]) {
        podiumCameraAt(set, u, aspect, pos, look);
        cam.position.copy(pos);
        cam.lookAt(look);
        cam.updateMatrixWorld();
        for (const s of set.slots) {
          for (const dx of [-1, 1]) {
            const p = s.position.clone().addScaledVector(set.left, dx).project(cam);
            if (!(Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1)) return false;
          }
        }
      }
      return true;
    };
    check("all three in frame through the move, wide screen", inFrame(16 / 9));
    check("and on a phone held upright", inFrame(9 / 19.5));
  }
  const narrow = { ...track, getSampleAtDistance: (s: number) => ({ ...track.getSampleAtDistance(s), width: 7 }) };
  check("a road too narrow for three cars: no shot", podiumSet(narrow, null) === null);
}

console.log("The cars drawn during the shot");
{
  const peer = (id: string, code: string, name?: string): InterpolatedPeerState =>
    ({
      peerId: id,
      driverCode: code,
      name,
      teamColorHex: "#fff",
      position: new THREE.Vector3(100, 2, 100),
      quaternion: new THREE.Quaternion(),
      linearVelocity: new THREE.Vector3(10, 0, 0),
      steerAngle: 0.2,
      wheelRPMs: [900, 900, 900, 900],
      throttle: 0.4,
      brake: 0,
      trackS: 10,
      speedKmh: 140,
      isAiPeer: true,
      passThrough: true,
    }) as InterpolatedPeerState;
  const rows: PodiumRow[] = [
    { position: 1, driverCode: "A", name: "A", teamColorHex: "#fff", isPlayer: false },
    { position: 2, driverCode: "YOU", name: "You", teamColorHex: "#fff", isPlayer: true },
    { position: 3, driverCode: "SAM", name: "Sam B", teamColorHex: "#fff", isPlayer: false },
  ];
  const peers = [peer("a", "A"), peer("s1", "SAM", "Sam A"), peer("s2", "SAM", "Sam B"), peer("x", "X")];
  check("a car found by its code", podiumPeerFor(rows[0], peers)?.peerId === "a");
  check("two cars with one code: told apart by name", podiumPeerFor(rows[2], peers)?.peerId === "s2");
  check("not one car: none", podiumPeerFor({ ...rows[2], name: "Sam C" }, peers) === null);

  const track = getActiveTrackData();
  let ended = 0;
  const d = new PodiumDirector(track, () => ended++);
  const three = status([row(1, "A"), row(2, "YOU"), row(3, "SAM", { name: "Sam B" })]);
  d.update({ race: three, dt: 0.1, allowed: true, peers, ground: null });
  check("the overlay sees the shot and its three", d.getSnapshot().stage === "playing" && d.getSnapshot().rows.length === 3);
  const drawn = d.drawPeers(peers);
  const a = drawn.find((p) => p.peerId === "a");
  const x = drawn.find((p) => p.peerId === "x");
  check("every car keeps its own rig (same ids)", drawn.map((p) => p.peerId).join() === peers.map((p) => p.peerId).join());
  check("a podium car parked still and solid", !!a && a.speedKmh === 0 && a.passThrough === false && a.position.distanceTo(new THREE.Vector3(100, 2, 100)) > 1);
  check("the others out of sight", !!x && x.position.y < -900);
  check("the race cars themselves untouched", peers[0].position.x === 100 && peers[0].speedKmh === 140);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  check("the shot has the camera", d.placeCamera(cam) && cam.fov === 38);
  d.update({ race: three, dt: 0.1, allowed: true, peers: peers.filter((p) => p.peerId !== "a"), ground: null });
  check("a podium car gone from the race ends the shot", d.getSnapshot().stage === "done" && ended === 1);
  check("then the cars are drawn where they are", d.drawPeers(peers) === peers && !d.placeCamera(cam));

  const k = new PodiumDirector(track, () => ended++);
  k.update({ race: three, dt: 0.1, allowed: true, peers, ground: null });
  k.skip();
  check("skipped: the table, the cameras start over", k.getSnapshot().stage === "done" && ended === 2);
  const lost = new PodiumDirector(track, () => ended++);
  lost.update({ race: three, dt: 0.1, allowed: true, peers: [peer("x", "X")], ground: null });
  check("a top-three car not on track: straight to the table", lost.getSnapshot().stage === "done" && ended === 2);
}

console.log("The full-screen podium after the shot");
{
  const three = [row(1, "A"), row(2, "YOU"), row(3, "C")];
  const yes = () => true;
  const f = new PodiumFlow();
  f.step(status(three), 0.1, true, yes, true);
  check("the shot first", f.stage === "playing");
  for (let t = 0; t < PODIUM_SHOT_S + 0.2; t += 0.1) f.step(status(three), 0.1, true, yes, true);
  check("then the full-screen podium, the top three kept", f.stage === "board" && f.rows.length === 3);
  for (let t = 0; t < PODIUM_BOARD_S - 1; t += 0.5) f.step(status(three), 0.5, true, yes, true);
  check("up to half a minute", f.stage === "board" && f.boardElapsedS > PODIUM_BOARD_S - 2);
  for (let t = 0; t < 2; t += 0.5) f.step(status(three), 0.5, true, yes, true);
  check("then the table", f.stage === "done" && f.rows.length === 0);
  f.step(status(three, true), 0.1, true, yes, true);
  check("once per race", f.stage === "done");
  f.step(status(undefined), 0.1, true, yes, true);
  check("a restart starts it over", f.stage === "idle" && f.boardElapsedS === 0);

  const held = new PodiumFlow();
  held.step(status(three), 0.1, true, () => false, true);
  for (let t = 0; t < 60; t += 1) held.step(status(three), 0, true, yes, true);
  check("the pause menu (no time passing) holds it up", held.stage === "board" && held.boardElapsedS === 0);

  const k = new PodiumFlow();
  k.step(status(three), 0.1, true, yes, true);
  check("a key in the shot: on to the full-screen podium", k.skip() && k.stage === "board" && k.rows.length === 3);
  check("a key on it: the table", k.skip() && k.stage === "done" && k.rows.length === 0 && !k.skip());

  const noShot = new PodiumFlow();
  noShot.step(status(three), 0.1, true, () => false, true);
  check("a shot that cannot be set up: straight to the full-screen podium", noShot.stage === "board");

  const online = new PodiumFlow();
  online.step(status(three), 0.1, true, yes, false);
  for (let t = 0; t < PODIUM_SHOT_S + 0.2; t += 0.1) online.step(status(three), 0.1, true, yes, false);
  check("not to be had (online, the setting off): the table after the shot", online.stage === "done");

  const vr = new PodiumFlow();
  vr.step(status(three), 0.1, true, () => false, true);
  vr.step(status(three), 0.1, false, yes, true);
  check("not allowed any more (VR, a replay): the table", vr.stage === "done");
  const turnedOff = new PodiumFlow();
  turnedOff.step(status(three), 0.1, true, () => false, true);
  turnedOff.step(status(three), 0.1, true, yes, false);
  check("switched off while up: the table", turnedOff.stage === "done");

  const out = new PodiumFlow();
  out.step(status([row(1, "A"), row(2, "B"), row(3, "C"), row(4, "YOU", { finishTimeS: null, dnf: true })]), 0.1, true, yes, true);
  check("the player out of the race: the table at once", out.stage === "done");
  const slow = new PodiumFlow();
  const behind = status([row(1, "YOU"), row(2, "B", { finishTimeS: null }), row(3, "C", { finishTimeS: null })]);
  for (let t = 0; t < PODIUM_WAIT_S + 1; t += 0.5) slow.step(behind, 0.5, true, yes, true);
  check("no top three in time: the table, no full-screen podium", slow.stage === "done");
  const stopped = new PodiumFlow();
  stopped.step(status(three), 0.1, true, () => false, true);
  check("stopped (an error): the table", stopped.stop() && stopped.stage === "done" && !stopped.stop());
}

console.log("The full-screen podium on the drive's scene");
{
  const track = getActiveTrackData();
  const peer = (id: string, code: string): InterpolatedPeerState =>
    ({
      peerId: id,
      driverCode: code,
      teamColorHex: "#fff",
      position: new THREE.Vector3(100, 2, 100),
      quaternion: new THREE.Quaternion(),
      linearVelocity: new THREE.Vector3(10, 0, 0),
      wheelRPMs: [900, 900, 900, 900],
      speedKmh: 140,
      isAiPeer: true,
    }) as InterpolatedPeerState;
  const peers = [peer("a", "A"), peer("c", "C"), peer("x", "X")];
  const three = status([row(1, "A"), row(2, "YOU"), row(3, "C")]);
  const ctx = { seriesId: "s", roundIndex: 2, rounds: 6, drivers: {}, standings: [] } as unknown as ShowContext;
  let ended = 0;
  const d = new PodiumDirector(track, () => ended++);
  const frame = (dt: number) => ({ race: three, dt, allowed: true, board: true, context: ctx, peers, ground: null });
  d.update(frame(0.1));
  check("the shot plays first", d.playing && d.getSnapshot().stage === "playing");
  check("the overlay is told the career round", d.getSnapshot().context === ctx);
  d.skip();
  check("a key: the full-screen podium, the screen still the podium's", d.playing && d.getSnapshot().stage === "board" && ended === 0);
  check("the cars drawn where they are again", d.drawPeers(peers) === peers);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  check("without a view the drive's cameras keep it", !d.placeCamera(cam));
  const view = { fogDensity: 0.00035, still: false };
  check("the aerial has the camera", d.placeCamera(cam, view) && cam.fov === 40);
  const roadY = track.getSampleAtDistance(track.spawnGrid[0]?.s ?? 0).position.y;
  check("high over the circuit", cam.position.y > roadY + 60, `${cam.position.y} vs ${roadY}`);
  check("what follows the camera looks where it looks", d.focus !== null);
  const first = cam.position.clone();
  for (let i = 0; i < 20; i++) d.update(frame(0.1));
  d.placeCamera(cam, view);
  check("and flies on", cam.position.distanceTo(first) > 5 && d.boardTimeS() > 1.9);
  const still = cam.position.clone();
  d.update(frame(1));
  d.placeCamera(cam, { ...view, still: true });
  const held = cam.position.clone();
  d.update(frame(1));
  d.placeCamera(cam, { ...view, still: true });
  check("reduced motion: one held frame", cam.position.distanceTo(held) < 1e-6 && held.distanceTo(still) > 0);
  const portrait = new THREE.PerspectiveCamera(60, 9 / 19.5, 0.1, 5000);
  check("a phone upright gets a wider view", d.placeCamera(portrait, view) && portrait.fov === 55);
  d.skip();
  check("closed: the table, the cameras start over", d.getSnapshot().stage === "done" && ended === 1 && !d.playing && !d.placeCamera(cam, view) && d.focus === null);

  const timed = new PodiumDirector(track, () => ended++);
  timed.update({ ...frame(0.1), peers: [] });
  check("no shot to be had: straight to the full-screen podium", timed.getSnapshot().stage === "board");
  for (let t = 0; t < PODIUM_BOARD_S + 1; t += 0.5) timed.update({ ...frame(0.5), peers: [] });
  check("half a minute later: the table", timed.getSnapshot().stage === "done" && ended === 2);
}

console.log(`\n${passed} checks passed`);
