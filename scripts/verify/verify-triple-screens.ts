/**
 * Triple screens (src/lib/display/screen-layout.ts, src/lib/render/triple-views.ts): the side angle that faces the
 * eye; flat screens without frames giving one wide flat picture cut in thirds; the seams continuous (a point on a hinge
 * on the edge of both neighbouring views) at any angle; the world behind the frames hidden; the eye's height moving
 * the horizon on every screen; the centre view following the game camera (its field of view and the title menu's
 * off-centre framing); both depth conventions; the canvas split on whole device pixels; the saved settings held to
 * their limits.
 *
 *   npx tsx scripts/verify/verify-triple-screens.ts
 */
import * as THREE from "three";
import {
  DEFAULT_SCREEN_SETTINGS,
  eyeForWindow,
  facingAngleRad,
  looksLikeTriple,
  parseScreenSettings,
  physicalVerticalFovDeg,
  pictureSize,
  screenRig,
  symmetricWindow,
  totalHorizontalFovDeg,
  tripleFits,
  tripleRects,
  tripleViews,
  type ScreenRig,
} from "../../src/lib/display/screen-layout";
import { OffAxisCamera, TripleViewRig, windowOf } from "../../src/lib/render/triple-views";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(92)} ${detail}`);
  if (!ok) failed++;
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const DEG = Math.PI / 180;

/** NDC of a world point through a camera (x, y in -1..1 when on screen; z > 0 in front for a check of side) */
function ndc(cam: THREE.Camera, p: THREE.Vector3): THREE.Vector3 {
  cam.updateMatrixWorld(true);
  return p.clone().project(cam);
}
const inView = (v: THREE.Vector3, eps = 1e-6) => Math.abs(v.x) <= 1 + eps && Math.abs(v.y) <= 1 + eps;

// A 27" 16:9 rig at 70 cm
const aspect = 16 / 9;
const size = pictureSize(27, aspect);
check("27\" 16:9 picture is 59.8 x 33.6 cm", near(size.w, 0.5977, 5e-4) && near(size.h, 0.3362, 5e-4), `${(size.w * 100).toFixed(1)} x ${(size.h * 100).toFixed(1)} cm`);
const vfov = physicalVerticalFovDeg({ h: size.h, distance: 0.7 });
check("Its true vertical field of view at 70 cm is 2·atan(h / 2d) = 27.0°", near(vfov, 27.0, 0.05), `${vfov.toFixed(2)}°`);

// --- The angle that faces the eye ---
{
  const a0 = facingAngleRad(size.w, 0, 0.7);
  const expected = 2 * Math.atan(size.w / (2 * 0.7));
  check("Without frames the facing angle is 2·atan(W / 2D)", near(a0, expected, 1e-9), `${(a0 / DEG).toFixed(2)}° vs ${(expected / DEG).toFixed(2)}°`);
  const b = 0.012;
  const a = facingAngleRad(size.w, b, 0.7);
  // The side picture's middle and the screen's normal: the line to the eye must run along the normal
  const mx = size.w / 2 + b + (b + size.w / 2) * Math.cos(a);
  const mz = -0.7 + (b + size.w / 2) * Math.sin(a);
  const toEye = new THREE.Vector2(-mx, -mz).normalize();
  const normal = new THREE.Vector2(-Math.sin(a), Math.cos(a));
  check("With 12 mm frames the side picture's middle looks straight at the eye", near(toEye.dot(normal), 1, 1e-9), `${(a / DEG).toFixed(2)}°`);
  check("Frames push the facing angle out", a > a0);
  check("A screen too close to face the eye stops at 90°", near(facingAngleRad(1, 0, 0.1), Math.PI / 2, 1e-6));
}

// --- Flat screens, no frames: one wide flat picture in thirds ---
{
  const rig: ScreenRig = { w: size.w, h: size.h, bezel: 0, distance: 0.7, angle: 0, eyeHeight: 0 };
  const eye = { x: 0, y: 0, distance: 0.7 };
  const [l, c, r] = tripleViews(rig, eye);
  const t = size.w / 2 / 0.7;
  check("Flat: no screen turns", l.yaw === 0 && c.yaw === 0 && r.yaw === 0);
  check("Flat: the centre is the middle third", near(c.left, -t) && near(c.right, t));
  check("Flat: the side windows continue it edge to edge", near(r.left, t) && near(r.right, 3 * t) && near(l.right, -t) && near(l.left, -3 * t));
  check("Flat: every screen has the same height", near(l.top, c.top) && near(r.bottom, c.bottom));
  const total = totalHorizontalFovDeg([l, c, r]);
  check("Flat: together they cover 2·atan(3W / 2D)", near(total, (2 * Math.atan(3 * t)) / DEG, 1e-9), `${total.toFixed(1)}°`);
}

// --- Cameras on a 50° rig: the seams ---
function rigCameras(rig: ScreenRig, fovDeg = physicalVerticalFovDeg(rig)): { tri: TripleViewRig; main: THREE.PerspectiveCamera } {
  const main = new THREE.PerspectiveCamera(fovDeg, rig.w / rig.h, 0.1, 1000);
  main.updateProjectionMatrix();
  const tri = new TripleViewRig();
  tri.update(main, rig);
  return { tri, main };
}
for (const angleDeg of [0, 30, 50, 70]) {
  const rig: ScreenRig = { w: size.w, h: size.h, bezel: 0, distance: 0.7, angle: angleDeg * DEG, eyeHeight: 0 };
  const { tri } = rigCameras(rig);
  const [L, C, R] = tri.cameras;
  // A point far out along the ray from the eye through the right hinge, at the screens' middle height
  const hinge = new THREE.Vector3(size.w / 2, 0, -0.7).multiplyScalar(12);
  const inC = ndc(C, hinge);
  const inR = ndc(R, hinge);
  check(`${angleDeg}°: the right hinge is the centre view's right edge and the right view's left edge`, near(inC.x, 1, 1e-5) && near(inR.x, -1, 1e-5), `C ${inC.x.toFixed(6)}, R ${inR.x.toFixed(6)}`);
  const hingeL = new THREE.Vector3(-size.w / 2, 0.1, -0.7).multiplyScalar(9);
  const lC = ndc(C, hingeL);
  const lL = ndc(L, hingeL);
  check(`${angleDeg}°: the left hinge is on both neighbouring edges, at the same height`, near(lC.x, -1, 1e-5) && near(lL.x, 1, 1e-5) && near(lC.y, lL.y, 1e-5), `y ${lC.y.toFixed(4)} / ${lL.y.toFixed(4)}`);
  // The right screen's own outer top corner is the right view's top right corner
  const a = angleDeg * DEG;
  const outer = new THREE.Vector3(size.w / 2 + size.w * Math.cos(a), size.h / 2, -0.7 + size.w * Math.sin(a));
  const o = ndc(R, outer);
  check(`${angleDeg}°: the right screen's outer top corner is its view's top right corner`, near(o.x, 1, 1e-5) && near(o.y, 1, 1e-5));
  // Straight lines stay straight across a seam: a horizontal line at the screens' plane height crosses at one height
  const lineLeftOfSeam = new THREE.Vector3(size.w / 2 - 0.01, 0.05, -0.7).multiplyScalar(30);
  const lineRightOfSeam = new THREE.Vector3(size.w / 2 + 0.01 * Math.cos(a), 0.05, -0.7 + 0.01 * Math.sin(a)).multiplyScalar(30);
  check(`${angleDeg}°: points just either side of the seam are each on their own screen`, inView(ndc(C, lineLeftOfSeam)) && !inView(ndc(C, lineRightOfSeam), -1e-4) && inView(ndc(R, lineRightOfSeam)));
}

// --- Frames hide what is behind them ---
{
  const b = 0.01;
  const rig: ScreenRig = { w: size.w, h: size.h, bezel: b, distance: 0.7, angle: 45 * DEG, eyeHeight: 0 };
  const { tri } = rigCameras(rig);
  const [, C, R] = tri.cameras;
  // Halfway along the centre screen's own frame, and halfway along the side screen's frame
  const onCentreFrame = new THREE.Vector3(size.w / 2 + b / 2, 0, -0.7).multiplyScalar(20);
  const hingeX = size.w / 2 + b;
  const onSideFrame = new THREE.Vector3(hingeX + (b / 2) * Math.cos(45 * DEG), 0, -0.7 + (b / 2) * Math.sin(45 * DEG)).multiplyScalar(20);
  check("A point behind the centre screen's frame is on no screen", !inView(ndc(C, onCentreFrame)) && !inView(ndc(R, onCentreFrame)));
  check("A point behind the side screen's frame is on no screen", !inView(ndc(C, onSideFrame)) && !inView(ndc(R, onSideFrame)));
  const sidePicture = new THREE.Vector3(hingeX + (b + 0.001) * Math.cos(45 * DEG), 0, -0.7 + (b + 0.001) * Math.sin(45 * DEG)).multiplyScalar(20);
  check("Just past the side frame the right screen's picture begins", inView(ndc(R, sidePicture)));
  // Negative frames (bezel-hiding strips) overlap the pictures: the hinge point is on both
  const strip: ScreenRig = { ...rig, bezel: -0.004 };
  const s = rigCameras(strip).tri.cameras;
  const hinge = new THREE.Vector3(size.w / 2 - 0.004, 0, -0.7).multiplyScalar(20);
  check("Bezel strips (negative frames): the pictures overlap at the seam", inView(ndc(s[1], hinge)));
}

// --- The eye's height ---
{
  const rig: ScreenRig = { w: size.w, h: size.h, bezel: 0.008, distance: 0.7, angle: 50 * DEG, eyeHeight: 0.06 };
  const { tri } = rigCameras(rig);
  const ahead = new THREE.Vector3(0, 0, -50);
  const y = ndc(tri.cameras[1], ahead).y;
  check("Eye 6 cm above the screens' middle: the horizon sits 6 cm up the centre screen", near(y, 0.06 / (size.h / 2), 1e-5), `ndc y ${y.toFixed(4)}`);
  // A point on the seam (no frames) is at one height on both screens, whatever the eye's height
  const flush: ScreenRig = { ...rig, bezel: 0 };
  const t2 = rigCameras(flush).tri.cameras;
  const seam = new THREE.Vector3(size.w / 2, 0.11 - 0.06, -0.7).multiplyScalar(40);
  const yc = ndc(t2[1], seam);
  const yr = ndc(t2[2], seam);
  check("With the eye raised, a point on the seam is at one height on both screens", near(yc.x, 1, 1e-5) && near(yr.x, -1, 1e-5) && near(yc.y, yr.y, 1e-5), `${yc.y.toFixed(4)} / ${yr.y.toFixed(4)}`);
}

// --- The centre view follows the game camera ---
{
  const rig: ScreenRig = { w: size.w, h: size.h, bezel: 0.008, distance: 0.7, angle: 45 * DEG, eyeHeight: 0 };
  // A chase camera's 60°: the virtual eye moves closer, the screens keep their shape
  const { tri, main } = rigCameras(rig, 60);
  const e1 = main.projectionMatrix.elements;
  const e2 = tri.cameras[1].projectionMatrix.elements;
  check("Centre view = the game camera's own projection (60° chase view)", e1.every((v, i) => near(v, e2[i], 1e-9)));
  const eye = eyeForWindow(rig, symmetricWindow(60, rig.w / rig.h));
  check("A 60° view puts the eye at H / 2·tan(30°)", near(eye.distance, rig.h / 2 / Math.tan(30 * DEG), 1e-9) && near(eye.x, 0) && near(eye.y, 0), `${(eye.distance * 100).toFixed(1)} cm`);
  // The title menu's off-centre framing (setViewOffset): the centre view keeps it, the sides follow it
  const menu = new THREE.PerspectiveCamera(32, rig.w / rig.h, 0.1, 1000);
  menu.setViewOffset(1920, 1080, -1920 * 0.16, 0, 1920, 1080);
  const t2 = new TripleViewRig();
  t2.update(menu, rig);
  const m1 = menu.projectionMatrix.elements;
  const m2 = t2.cameras[1].projectionMatrix.elements;
  check("Centre view keeps the title menu's off-centre framing", m1.every((v, i) => near(v, m2[i], 1e-9)));
  const w = windowOf(menu);
  const half = Math.tan(16 * DEG) * (rig.w / rig.h);
  // A negative x offset moves the window left (the car shows right of the menu panel), the width unchanged
  check("windowOf reads the view offset", w.left < -half && w.right < half && near(w.right - w.left, 2 * half, 1e-9));
  // The eye that framing implies sits right of the centre screen's middle (it sees further left); the views still meet at the hinges
  const eyeM = eyeForWindow(rig, w);
  check("Off-centre framing moves the virtual eye sideways, not nearer", eyeM.x > 0 && near(eyeM.distance, rig.w / (2 * half), 1e-9));
  const flush = new TripleViewRig();
  flush.update(menu, { ...rig, bezel: 0 });
  const hingeFromEye = new THREE.Vector3(rig.w / 2 - eyeM.x, -eyeM.y, -eyeM.distance).multiplyScalar(30);
  const a = ndc(flush.cameras[1], hingeFromEye);
  const b = ndc(flush.cameras[2], hingeFromEye);
  check("Off-centre framing: the hinge is still on both neighbouring edges", near(a.x, 1, 1e-5) && near(b.x, -1, 1e-5));
}

// --- Both depth conventions ---
{
  const cam = new OffAxisCamera(50, 1, 0.12, 5500);
  cam.setWindow({ left: -0.3, right: 1.4, bottom: -0.4, top: 0.35 });
  const p = new THREE.Vector3(0.5, 0.1, -10);
  const a = ndc(cam, p);
  (cam as unknown as { _reversedDepth: boolean })._reversedDepth = true;
  cam.updateProjectionMatrix();
  const b = ndc(cam, p);
  check("Reversed depth keeps the window (x, y the same)", near(a.x, b.x, 1e-9) && near(a.y, b.y, 1e-9));
  check("Reversed depth flips depth (near 1, far 0)", b.z > 0 && b.z < 1 && Math.abs(a.z - b.z) > 1e-3, `z ${a.z.toFixed(5)} -> ${b.z.toFixed(5)}`);
  const corner = new THREE.Vector3(1.4, 0.35, -1).multiplyScalar(7);
  const c = ndc(cam, corner);
  check("Its window's top right corner is NDC (1, 1)", near(c.x, 1, 1e-6) && near(c.y, 1, 1e-6));
  check("Its fov / aspect enclose the window", near(cam.aspect, 1.4 / 0.4, 1e-9) && near(cam.fov, (2 * Math.atan(0.4)) / DEG, 1e-9));
}

// --- Wide views stay sane ---
{
  for (const angleDeg of [0, 60, 90]) {
    const rig: ScreenRig = { w: size.w, h: size.h, bezel: 0.02, distance: 0.7, angle: angleDeg * DEG, eyeHeight: 0.2 };
    const views = tripleViews(rig, eyeForWindow(rig, symmetricWindow(90, rig.w / rig.h), rig.eyeHeight));
    const finite = views.every((v) => [v.left, v.right, v.top, v.bottom].every(Number.isFinite) && v.right > v.left && v.top > v.bottom);
    check(`A 90° view with ${angleDeg}° screens gives three proper frustums`, finite, `total ${totalHorizontalFovDeg(views).toFixed(0)}°`);
  }
}

// --- The canvas split ---
for (const [w, pr] of [
  [5760, 1],
  [5760, 1.25],
  [7680, 1.5],
  [1366, 1.5],
  [5761, 1],
] as const) {
  const rects = tripleRects(w, 1080, pr);
  const dev = rects.map((r) => ({ x: r.x * pr, w: r.w * pr }));
  const whole = dev.every((r) => near(r.x, Math.round(r.x), 1e-9) && near(r.w, Math.round(r.w), 1e-9));
  const contiguous = near(dev[0].x, 0) && near(dev[0].x + dev[0].w, dev[1].x, 1e-9) && near(dev[1].x + dev[1].w, dev[2].x, 1e-9) && near(dev[2].x + dev[2].w, Math.floor(w * pr), 1e-9);
  check(`Split ${w} px at ${pr}x: whole device pixels, no gap or overlap`, whole && contiguous, dev.map((r) => r.w).join(" / "));
}
check("5760x1080 looks like three screens", looksLikeTriple(5760, 1080));
check("A 32:9 screen (3840x1080) does not", !looksLikeTriple(3840, 1080));
check("3 x 16:10 (5760x1200) does", looksLikeTriple(5760, 1200));
check("Three 5:4 screens (3840x1024) are still drawn as three when chosen", tripleFits(3840, 1024));
check("A 16:9 window with Three chosen draws one view", !tripleFits(1920, 1080));

// --- Saved settings ---
{
  const d = parseScreenSettings(undefined);
  check("No save: the defaults (one screen)", d.mode === "single" && d.sideAngleDeg === null && d.diagonalIn === DEFAULT_SCREEN_SETTINGS.diagonalIn);
  const p = parseScreenSettings({ mode: "triple", diagonalIn: 200, bezelMm: -90, distanceCm: 10, sideAngleDeg: 47.3, eyeHeightCm: 4.26, physicalFov: false, sideScale: 0.75 });
  check("A save is held to the limits", p.mode === "triple" && p.diagonalIn === 65 && p.bezelMm === -20 && p.distanceCm === 30);
  check("Angles keep half degrees, heights half centimetres", p.sideAngleDeg === 47.5 && p.eyeHeightCm === 4.5);
  check("Toggles and the side resolution are kept", p.physicalFov === false && p.sideScale === 0.75);
  const bad = parseScreenSettings({ mode: "quad", sideAngleDeg: "45", sideScale: 0.6, distanceCm: Number.NaN });
  check("Junk falls back to the defaults", bad.mode === "single" && bad.sideAngleDeg === null && bad.sideScale === 1 && bad.distanceCm === 70);
  const rig = screenRig({ ...DEFAULT_SCREEN_SETTINGS, mode: "triple" }, 16 / 9);
  check("A rig facing the eye by default", near(rig.angle, facingAngleRad(rig.w, rig.bezel, rig.distance), 1e-12), `${(rig.angle / DEG).toFixed(1)}°`);
}

console.log(failed === 0 ? "\nAll triple-screen checks passed." : `\n${failed} triple-screen check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
