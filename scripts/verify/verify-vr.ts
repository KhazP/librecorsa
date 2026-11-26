/**
 * The headset (src/lib/vr): in an emulated Quest 3 the view was black, as a Quest player reported (Reddit, 25 Nov 2026),
 * partly because three's headset views kept the standard depth range under the game's reversed depth buffer. This
 * checks the conversion against three's
 * own reversed projection (finite and infinite far planes, off-centre eyes) and that culling still keeps what is in
 * front; the hand controllers laid out as a standard pad; the headset's own pause / resume / recentre / leave buttons;
 * the headset detection that gives a Quest the phone graphics; and the HUD's start lights and lap text.
 *
 *   npx tsx scripts/verify/verify-vr.ts
 */
import * as THREE from "three";
import { toReversedDepth } from "../../src/lib/vr/reversed-depth";
import { HeadsetButtons, PAUSE_HOLD_MS, XR_PAD_ID, XrPadMapper, headsetTookPress, type XrHandSource } from "../../src/lib/vr/xr-pad";
import { isStandaloneHeadset } from "../../src/lib/vr/headset";
import { driveModel, formatLapTime, headsetPanel } from "../../src/lib/vr/vr-hud";
import type { CarTelemetry, RaceStatus } from "../../src/types/f1";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(86)} ${detail}`);
  if (!ok) failed++;
}

const maxDiff = (a: THREE.Matrix4, b: THREE.Matrix4) => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])));

// --- Reversed depth -----------------------------------------------------------------------------------------------
{
  // An off-centre eye (Quest-like: wider outward), near 0.05 m, far 5500 m
  const [l, r, t, b, n, f] = [-0.06, 0.045, 0.05, -0.055, 0.05, 5500];
  const standard = new THREE.Matrix4().makePerspective(l, r, t, b, n, f, THREE.WebGLCoordinateSystem, false);
  const reversed = new THREE.Matrix4().makePerspective(l, r, t, b, n, f, THREE.WebGLCoordinateSystem, true);
  const converted = toReversedDepth(standard.clone());
  const d = maxDiff(converted, reversed);
  check("finite off-centre eye: converted = three's own reversed projection", d < 1e-9, `max diff ${d.toExponential(2)}`);

  // The same eye with an infinite far plane (C = -1, D = -2n), kept at the scene's 5500 m
  const infinite = standard.clone();
  infinite.elements[10] = -1;
  infinite.elements[14] = -2 * n;
  const capped = toReversedDepth(infinite, f);
  const d2 = maxDiff(capped, reversed);
  check("infinite far plane: capped at the scene's far plane", d2 < 1e-9, `max diff ${d2.toExponential(2)}`);

  // Depth 1 at the near plane, 0 at the far plane, falling in between
  const depthAt = (m: THREE.Matrix4, dist: number) => new THREE.Vector3(0, 0, -dist).applyMatrix4(m).z;
  const dn = depthAt(converted, n);
  const df = depthAt(converted, f);
  const dm = [1, 10, 100, 1000].map((x) => depthAt(converted, x));
  check("depth 1 at near, 0 at far", Math.abs(dn - 1) < 1e-9 && Math.abs(df) < 1e-9, `near ${dn.toFixed(6)} far ${df.toExponential(2)}`);
  check("depth falls with distance", dm.every((v, i) => i === 0 || v < dm[i - 1]) && dm.every((v) => v > 0 && v < 1), dm.map((v) => v.toExponential(2)).join(" "));

  // Culling with the converted eye keeps what is ahead and drops what is behind
  const frustum = new THREE.Frustum().setFromProjectionMatrix(capped, THREE.WebGLCoordinateSystem, true);
  const ahead = [1, 50, 2000].every((z) => frustum.containsPoint(new THREE.Vector3(0, 0, -z)));
  const behind = frustum.containsPoint(new THREE.Vector3(0, 0, 3));
  const tooFar = frustum.containsPoint(new THREE.Vector3(0, 0, -6000));
  check("culling keeps 1 m, 50 m and 2 km ahead", ahead);
  check("culling drops behind the eye and past the far plane", !behind && !tooFar);
  const planesOk = frustum.planes.every((p) => Number.isFinite(p.constant) && p.normal.lengthSq() > 0.5);
  check("every frustum plane is a real plane (the infinite far plane culled everything)", planesOk);
}

// --- Hand controllers as a standard pad ---------------------------------------------------------------------------
{
  const btn = (value = 0) => ({ value, pressed: value > 0.5, touched: value > 0 });
  const hand = (handedness: string, trigger: number, lower: number, upper: number, stickPress: number, sx: number, sy: number): XrHandSource => ({
    handedness,
    gamepad: { buttons: [btn(trigger), btn(0), btn(0), btn(stickPress), btn(lower), btn(upper)], axes: [0, 0, sx, sy] },
  });
  const mapper = new XrPadMapper();
  check("no controllers: no pad", mapper.read([]) === null && mapper.read([{ handedness: "left", gamepad: null }]) === null);
  const pad = mapper.read([hand("left", 0.4, 1, 0, 1, -0.6, 0.1), hand("right", 0.9, 0, 1, 0, 0, 0)])!;
  check("standard mapping, its own id", pad.mapping === "standard" && pad.id === XR_PAD_ID);
  check("right trigger = RT (throttle), left trigger = LT (brake)", pad.buttons[7].value === 0.9 && pad.buttons[6].value === 0.4);
  check("left stick steers (axes 0/1)", pad.axes[0] === -0.6 && pad.axes[1] === 0.1);
  check("X (left lower) = X, B (right upper) = B, A and Y released", pad.buttons[2].pressed && pad.buttons[1].pressed && !pad.buttons[0].pressed && !pad.buttons[3].pressed);
  check("left stick press = L3, grips and Menu unmapped", pad.buttons[10].pressed && !pad.buttons[4].pressed && !pad.buttons[5].pressed && !pad.buttons[9].pressed);
  const dpad = (x: number, y: number) => mapper.read([hand("right", 0, 0, 0, 0, x, y)])!.buttons.slice(12, 16).map((b) => b.pressed);
  check("right stick flick up = D-pad up", dpad(0, -0.8)[0]);
  check("D-pad holds above the release threshold", dpad(0, -0.5)[0]);
  check("D-pad lets go below it", !dpad(0, -0.3)[0]);
  check("a small push is no press", !dpad(0.6, 0)[3]);
}

// --- Headset buttons: pause, resume, recentre, leave --------------------------------------------------------------
{
  const pad = (pressed: number[]) => ({ id: "x", index: 0, mapping: "standard", axes: [], buttons: Array.from({ length: 17 }, (_, i) => ({ value: pressed.includes(i) ? 1 : 0, pressed: pressed.includes(i) })) });
  const b = new HeadsetButtons();
  let t = 0;
  let paused = false;
  let paused1 = false;
  for (; t < PAUSE_HOLD_MS - 50; t += 16) if (b.read(pad([1]), t, paused).pause) paused1 = true;
  check("B held under the hold time does not pause", !paused1);
  let fired = 0;
  for (; t < PAUSE_HOLD_MS + 400; t += 16) if (b.read(pad([1]), t, paused).pause) fired++;
  check("B held past the hold time pauses once", fired === 1, `fired ${fired}`);
  paused = true;
  const stillHeld = b.read(pad([1]), t, paused);
  check("the B that paused, still held, does not leave", !stillHeld.leave);
  b.read(pad([]), (t += 16), paused);
  check("a new B press while paused leaves VR", b.read(pad([1]), (t += 16), paused).leave);
  b.read(pad([]), (t += 16), paused);
  check("Y while paused recentres", b.read(pad([3]), (t += 16), paused).recenter);
  b.read(pad([]), (t += 16), paused);
  const resumed = b.read(pad([0]), (t += 16), paused);
  check("A while paused resumes", resumed.resume);
  // The drive is handed back in the same frame: that A (Gear up on the default layout) is the headset's, not a shift
  check("the press that resumes is the headset's, not the drive's", headsetTookPress(resumed));
  b.read(pad([7]), (t += 16), paused);
  check("a trigger held over does not resume again", !b.read(pad([7]), (t += 16), paused).resume);
  check("no pad: nothing", Object.values(b.read(null, (t += 16), false)).every((v) => v === false));
  check("a frame the headset did nothing in leaves the drive its presses", !headsetTookPress(b.read(pad([0]), (t += 16), false)));
}

// --- Standalone headset detection ---------------------------------------------------------------------------------
{
  const quest3 =
    "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/39.2.0.0.56.754450099 Chrome/136.0.7103.177 VR Safari/537.36";
  const quest2 = "Mozilla/5.0 (X11; Linux x86_64; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/23.0.0.6.47 SamsungBrowser/4.0 Chrome/104.0.5112.111 VR Safari/537.36";
  const pico = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) PicoBrowser/3.3.38 Chrome/105.0.5195.68 VR Safari/537.36";
  const wolvic = "Mozilla/5.0 (Android 10; Mobile VR; rv:105.0) Gecko/105.0 Firefox/105.0 Wolvic/1.5";
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36";
  check("Quest 3, Quest 2, Pico and Wolvic are standalone headsets", [quest3, quest2, pico, wolvic].every((ua) => isStandaloneHeadset(ua)));
  check("a Mac, a Windows PC and an Android phone are not", ![desktop, windows, android].some((ua) => isStandaloneHeadset(ua)));
}

// --- HUD text -----------------------------------------------------------------------------------------------------
{
  const race = (over: Partial<RaceStatus>): RaceStatus => ({ phase: "racing", lightsOn: 0, position: 3, fieldSize: 12, lap: 2, standings: [], totalLaps: 10, ...over });
  const tel = (over: Partial<CarTelemetry>) =>
    ({ speedKmh: 187.4, gear: 4, lapCount: 1, currentLapTimeMs: 61_234, lastLapTimeMs: 92_104, bestLapTimeMs: null, ...over }) as CarTelemetry;
  // The lap under way, as the page's lap counter shows it (TimingPanels.tsx): the telemetry counts from 1. The plate
  // read one lap ahead of the page (Lap 2 on the first timed lap)
  const lapOf = (m: ReturnType<typeof driveModel>) => (m.kind === "drive" ? m.lap : "");
  const practice = driveModel(tel({}), "kmh");
  check("practice: no position, the lap under way as the page counts it", practice.kind === "drive" && practice.position === null && lapOf(practice) === "Lap 1", lapOf(practice));
  check("practice: lap 3 under way reads Lap 3", lapOf(driveModel(tel({ lapCount: 3 }), "kmh")) === "Lap 3", lapOf(driveModel(tel({ lapCount: 3 }), "kmh")));
  check("practice: a count of 0 still reads Lap 1", lapOf(driveModel(tel({ lapCount: 0 }), "kmh")) === "Lap 1");
  check("the out-lap reads Out lap", lapOf(driveModel(tel({ outLap: true }), "kmh")) === "Out lap", lapOf(driveModel(tel({ outLap: true }), "kmh")));
  check("a point-to-point course counts runs", lapOf(driveModel(tel({ lapCount: 2 }), "kmh", null, true)) === "Run 2", lapOf(driveModel(tel({ lapCount: 2 }), "kmh", null, true)));
  const racing = driveModel(tel({ race: race({}) }), "mph");
  check("race: position and lap of the total, speed in mph", racing.kind === "drive" && racing.position === "P3/12" && racing.lap === "Lap 2/10" && racing.speed === 116 && racing.speedUnit === "mph");
  const lights = driveModel(tel({ race: race({ phase: "lights", lightsOn: 3 }) }), "kmh");
  check("start lights: three lit", lights.kind === "drive" && lights.lights === 3 && lights.countdown === null);
  const countdown = driveModel(tel({ race: race({ phase: "lights", lightsOn: 0, countdownS: 2.2 }) }), "kmh");
  check("countdown before the lights: whole seconds up", countdown.kind === "drive" && countdown.lights === null && countdown.countdown === 3);
  const reverse = driveModel(tel({ gear: -1 }), "kmh");
  check("reverse and neutral read R and N", reverse.kind === "drive" && reverse.gear === "R" && (driveModel(tel({ gear: 0 }), "kmh") as { gear: string }).gear === "N");
  check("lap times read m:ss.mmm, none as dashes", formatLapTime(92_104) === "1:32.104" && formatLapTime(null) === "-:--.---");
}

// --- Which panel the headset shows ---------------------------------------------------------------------------------
{
  const at = (inMenu: boolean, paused: boolean, seatPanel: boolean) => headsetPanel({ inMenu, paused, seatPanel });
  check("driving: the drive's plates", at(false, false, false) === "drive");
  check("paused: the paused panel", at(false, true, false) === "paused");
  check("the seat panel (the car held, its rows on the page only): the paused panel", at(false, false, true) === "paused");
  check("the menus: the menus panel", at(true, false, false) === "menu" && at(true, true, true) === "menu");
}

console.log(failed === 0 ? "\nAll VR checks pass" : `\n${failed} VR check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
