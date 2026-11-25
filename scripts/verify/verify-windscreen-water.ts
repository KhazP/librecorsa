/**
 * Rain water on the windscreen and visor (src/lib/render/windscreen-water.ts): the drop simulation, the wiper, the
 * fine-bead wetness grid, finding a car model's windscreen glass, and the wiper timing in rain-fx.ts.
 *
 *   node scripts/verify/run-verify.mjs windscreen-water
 */
import * as THREE from "three";
import {
  DropletField,
  findWindscreenGlass,
  mirrorWiper,
  WetnessGrid,
  WINDSCREEN_DROP_BUDGET,
  wiperBladeDeg,
  wiperSpecFor,
  type DropForces,
  type WiperSweep,
} from "../../src/lib/render/windscreen-water";
import { stepWindscreenWipers, type WindscreenWetState } from "../../src/lib/render/rain-fx";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

/** Gravity along a windscreen raked about 58° back, at a standstill: down the glass */
const STILL: DropForces = { ax: 0, ay: -5.2, airMs: 0 };
const volume = (f: DropletField) => {
  let v = 0;
  for (let i = 0; i < f.count; i++) v += f.r[i] ** 3;
  return v;
};

console.log("\n== Drops");
{
  const f = new DropletField(2000, 1.4, 0.8);
  for (let i = 0; i < 60; i++) f.step(1 / 60, 3, 1, STILL, null);
  let inside = true;
  for (let i = 0; i < f.count; i++) inside &&= f.x[i] >= 0 && f.x[i] <= f.width && f.y[i] >= 0 && f.y[i] <= f.height && f.r[i] > 0;
  check("rain lands and beads on the glass", f.count > 100 && inside, `${f.count} drops after 1 s`);

  const m = new DropletField(10, 1, 1);
  m.add(0.5, 0.5, 0.002);
  m.step(1 / 60, 0, 1, { ax: 0, ay: 0, airMs: 0 }, null);
  m.add(0.5005, 0.5, 0.0015);
  const merged = m.count === 1 && Math.abs(m.r[0] ** 3 - (0.002 ** 3 + 0.0015 ** 3)) < 1e-12;
  check("a drop landing on another merges with it (volumes add)", merged, `count ${m.count}, r ${(m.r[0] * 1000).toFixed(3)} mm`);

  const g = new DropletField(400, 1, 1);
  g.add(0.3, 0.8, 0.0035);
  g.add(0.7, 0.8, 0.001);
  const big0 = { x: g.x[0], y: g.y[0] };
  for (let i = 0; i < 90; i++) g.step(1 / 60, 0, 1, STILL, null);
  // Find the drops again by size
  let big = -1;
  let small = -1;
  for (let i = 0; i < g.count; i++) {
    if (g.r[i] > 0.0025 && (big < 0 || g.y[i] < g.y[big])) big = i;
    if (Math.abs(g.x[i] - 0.7) < 0.002 && Math.abs(g.y[i] - 0.8) < 0.002) small = i;
  }
  const ranDown = big >= 0 && g.y[big] < big0.y - 0.02;
  const trail = g.count > 2;
  check(
    "standing still, a heavy drop runs down the glass leaving a trail; a small one stays",
    ranDown && trail && small >= 0,
    `big ran ${big >= 0 ? ((big0.y - g.y[big]) * 1000).toFixed(0) : "?"} mm, ${g.count - 2} trail beads`
  );

  const a = new DropletField(50, 1, 1);
  a.add(0.5, 0.3, 0.0015);
  const y0 = a.y[0];
  for (let i = 0; i < 30; i++) a.step(1 / 60, 0, 1, { ...STILL, airMs: 50 }, null);
  let up = -Infinity;
  for (let i = 0; i < a.count; i++) up = Math.max(up, a.y[i]);
  const blownOff = a.count === 0 || up > y0 + 0.05;
  check("at 180 km/h the air drives a 1.5 mm drop up the glass", blownOff, `moved ${a.count ? ((up - y0) * 1000).toFixed(0) : "off the glass"} mm`);

  const full = new DropletField(50, 1, 1);
  for (let i = 0; i < 200; i++) full.add(Math.random(), Math.random(), 0.001);
  check("a full field drops further impacts instead of growing past its budget", full.count <= 50, `${full.count}/50`);
}

console.log("\n== Wiper");
{
  const spec = wiperSpecFor("amg-gt3")!;
  const twin = wiperSpecFor("liana")!;
  check(
    "open cars have no wipers; GT3s one blade, road cars two",
    wiperSpecFor("lc26") === null && wiperSpecFor("lc25") === null && spec.pivots.length === 1 && twin.pivots.length === 2
  );
  const m = mirrorWiper(spec);
  check(
    "the blade parks at phase 0, reaches the far end at 0.5, and mirrors for the other side",
    Math.abs(wiperBladeDeg(spec, 0) - spec.parkDeg) < 1e-9 &&
      Math.abs(wiperBladeDeg(spec, 0.5) - (spec.parkDeg + spec.sweepDeg)) < 1e-9 &&
      Math.abs(wiperBladeDeg(m, 0.25) - (180 - wiperBladeDeg(spec, 0.25))) < 1e-9
  );

  // A wet windscreen 1.4 × 0.8 m, one blade from the bottom middle sweeping 150° from the right
  const W = 1.4;
  const H = 0.8;
  const f = new DropletField(3000, W, H);
  for (let i = 0; i < 2500; i++) f.add(Math.random() * W, Math.random() * H, 0.0007 + Math.random() * 0.0008);
  const v0 = volume(f);
  const pivot: readonly [number, number] = [W / 2, -0.02];
  const sweep = (from: number, to: number): WiperSweep => ({ pivots: [pivot], inner: 0.15, outer: 0.78, fromDeg: from, toDeg: to });
  const steps = 40;
  for (let s = 0; s < steps; s++) f.step(1 / 60, 0, 1, { ax: 0, ay: 0, airMs: 0 }, sweep(10 + (150 * s) / steps, 10 + (150 * (s + 1)) / steps));
  let inBand = 0;
  let beyond = 0;
  let beyondBig = 0;
  for (let i = 0; i < f.count; i++) {
    const dx = f.x[i] - pivot[0];
    const dy = f.y[i] - pivot[1];
    const rho = Math.hypot(dx, dy);
    const deg = THREE.MathUtils.radToDeg(Math.atan2(dy, dx));
    // The blade's fine traces (under half a millimetre) are left behind on purpose
    if (rho > 0.2 && rho < 0.74 && deg > 20 && deg < 150 && f.r[i] > 0.0005) inBand++;
    if (rho > 0.2 && rho < 0.74 && deg >= 160 && deg < 175) {
      beyond++;
      if (f.r[i] > 0.0016) beyondBig++;
    }
  }
  check(
    "one stroke clears the arc it swept and piles the water at its end",
    inBand < 25 && beyond > 10 && beyondBig > 3,
    `${inBand} drops left in the arc, ${beyond} at the end (${beyondBig} grown beads)`
  );
  check("the blade moves water, it does not make it (volume never grows)", volume(f) <= v0 * 1.0001, `${((volume(f) / v0) * 100).toFixed(1)}% kept`);
}

console.log("\n== Fine-bead wetness");
{
  const g = new WetnessGrid(1.4, 0.8);
  for (let i = 0; i < 60; i++) g.step(1 / 60, 0.45, 0, null);
  g.upload();
  const filled = g.maxWet > 0.4 && g.maxWet < 0.5;
  g.step(1 / 60, 0, 0, { pivots: [[0.7, -0.02]], inner: 0.15, outer: 0.78, fromDeg: 10, toDeg: 170 });
  const cols = g.cols;
  // A cell straight up from the pivot, half way out: wiped; a top corner beyond the blade's reach: still wet
  const at = (x: number, y: number) => g.wet[Math.floor(y / (0.8 / g.rows)) * cols + Math.floor(x / (1.4 / cols))];
  const wiped = at(0.7, 0.4) === 0;
  const corner = at(0.02, 0.78) > 0.4;
  const dry = new WetnessGrid(1.4, 0.8);
  for (let i = 0; i < 600; i++) dry.step(1 / 60, 0.45, 3, null);
  dry.upload();
  check(
    "rain wets the glass, the blade wipes its arc dry, the corners stay wet, the air thins it",
    filled && wiped && corner && dry.maxWet < 0.2,
    `1 s: ${g.maxWet.toFixed(2)}, wiped ${wiped}, corner ${corner}, at speed ${dry.maxWet.toFixed(2)}`
  );
}

console.log("\n== Finding the windscreen");
{
  const chassis = new THREE.Group();
  const eye = new THREE.Vector3(0.35, 0.95, -0.5);
  const glassMat = new THREE.MeshStandardMaterial({ name: "window_glass", transparent: true, opacity: 0.3 });
  // A windscreen 1.3 m wide, raked back about 58°, ahead of the eye
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.8), glassMat);
  screen.position.set(0, 1.0, 0.3);
  screen.rotation.x = -THREE.MathUtils.degToRad(58);
  // A side window and a headlight lens: neither is the windscreen
  const side = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.4), glassMat);
  side.position.set(0.8, 1.0, -0.5);
  side.rotation.y = Math.PI / 2;
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.15), new THREE.MeshStandardMaterial({ name: "lamp_glass", transparent: true, opacity: 0.2 }));
  lens.position.set(0.6, 0.6, 2.1);
  chassis.add(screen, side, lens);
  const found = findWindscreenGlass(chassis, eye);
  const ok =
    found !== null &&
    found.meshes.length === 1 &&
    found.meshes[0] === screen &&
    found.axisN.z > 0.3 &&
    found.axisN.y > 0.5 &&
    Math.abs(found.uMax - found.uMin - 1.3) < 0.01 &&
    Math.abs(found.vMax - found.vMin - 0.8) < 0.01;
  check(
    "the raked glass ahead of the eye is the windscreen; side window and lamp left out",
    ok,
    found ? `n (${found.axisN.y.toFixed(2)}, ${found.axisN.z.toFixed(2)}), ${(found.uMax - found.uMin).toFixed(2)} × ${(found.vMax - found.vMin).toFixed(2)} m` : "none"
  );
  const open = new THREE.Group();
  open.add(lens.clone());
  check("a car with no windscreen glass has none", findWindscreenGlass(open, eye) === null);
}

console.log("\n== Wiper timing");
{
  const st: WindscreenWetState = { dropletDensity: 0, wiperPhase: 0, wiperMode: "intermittent" };
  const phases: number[] = [];
  for (let i = 0; i < 600; i++) {
    stepWindscreenWipers(st, 1 / 60, 0.15, 0, 0, false);
    phases.push(st.wiperPhase);
  }
  // A stroke takes 1 / 0.8 s; then the blade rests at park for a couple of seconds
  let strokes = 0;
  let restFrames = 0;
  for (let i = 1; i < phases.length; i++) {
    if (phases[i] === 0 && phases[i - 1] > 0) strokes++;
    if (phases[i] === 0) restFrames++;
  }
  check("intermittent wipers make full-speed strokes with a rest at park", strokes >= 2 && strokes <= 4 && restFrames > 250, `${strokes} strokes in 10 s, ${restFrames} frames parked`);
  const fast: WindscreenWetState = { dropletDensity: 0, wiperPhase: 0, wiperMode: "high" };
  let parked = 0;
  for (let i = 0; i < 300; i++) {
    stepWindscreenWipers(fast, 1 / 60, 0.9, 0.5, 40, false);
    if (fast.wiperPhase === 0) parked++;
  }
  check("fast wipers never rest", parked <= 1, `${parked} frames parked`);
}

console.log("\n== Cost");
{
  const W = 1.6;
  const H = 1.05;
  const f = new DropletField(WINDSCREEN_DROP_BUDGET.high, W, H);
  const g = new WetnessGrid(W, H);
  const pivot: readonly [number, number] = [W / 2, -0.03];
  for (let i = 0; i < 200; i++) f.step(1 / 60, 8, 1, STILL, null);
  const t0 = performance.now();
  const N = 600;
  for (let i = 0; i < N; i++) {
    const deg = 10 + 150 * (0.5 - 0.5 * Math.cos((i / 40) * Math.PI));
    const prev = 10 + 150 * (0.5 - 0.5 * Math.cos(((i - 1) / 40) * Math.PI));
    const sweep: WiperSweep = { pivots: [pivot], inner: 0.18, outer: 1.0, fromDeg: prev, toDeg: deg };
    f.step(1 / 60, 6, 1, { ax: 0, ay: 9, airMs: 45 }, sweep);
    g.step(1 / 60, 1.4, 1.2, sweep);
    g.upload();
  }
  const ms = (performance.now() - t0) / N;
  check("a frame of High's drops, blade and wetness costs well under a millisecond", ms < 0.6, `${ms.toFixed(3)} ms per frame, ${f.count} drops`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(", ")}` : "\nAll windscreen water checks passed.");
if (failures.length) process.exit(1);
