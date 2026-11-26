/**
 * Screens around the driver: one screen, or three side by side with the outer two turned in toward the eye.
 *
 * With three screens each one shows its own view, drawn for where that screen really is: a camera turned as far as the
 * screen is turned, with an off-centre ("off-axis") frustum through the screen's four corners as the eye sees them. One
 * wide camera stretched across the three can't do it: its picture is right only on a flat wall of screens, and on
 * angled side screens it stretches toward the outer edges and breaks straight lines at the seams.
 *
 * The geometry is in metres in the eye's own frame (three's camera axes: +X right, +Y up, looking down -Z). The centre
 * screen's picture is a W x H rectangle square to the view, its middle `distance` ahead. Each screen has a frame of
 * `bezel` round its picture: a side screen is hinged at the outer edge of the centre screen's frame and turned in by the
 * side angle, so between the two pictures lie the centre screen's frame (in the centre screen's plane) and the side
 * screen's frame (in the side screen's plane). The world behind the frames is not drawn, as a window frame hides what
 * is behind it. A negative bezel is for the strips that hide the frames by bending the picture over them.
 *
 * The frustum of each screen is the generalized perspective projection: from the screen's lower-left, lower-right and
 * upper-left corners (pa, pb, pc) and the eye pe, with vr and vu the screen's right and up directions and vn its normal
 * toward the eye, d = -(pa - pe)·vn is the eye's distance to the screen's plane and the near-plane window at unit
 * distance is left = vr·(pa - pe)/d, right = vr·(pb - pe)/d, bottom = vu·(pa - pe)/d, top = vu·(pc - pe)/d.
 *
 * Nothing here needs three.js or a browser, so the settings screen and the verify suite use it as it is.
 */

export type ScreenMode = "single" | "triple";
/** The side screens' render resolution as a share of the centre's */
export type SideScreenScale = 0.5 | 0.75 | 1;
export const SIDE_SCREEN_SCALES: readonly SideScreenScale[] = [0.5, 0.75, 1];

export interface ScreenSettings {
  mode: ScreenMode;
  /** Diagonal of one screen's picture (inches, as monitors are sold) */
  diagonalIn: number;
  /**
   * One screen's frame beside its picture (mm). Each gap between two pictures is two frames, one from each screen;
   * negative for the strips that hide the frames
   */
  bezelMm: number;
  /** From the eye to the centre screen's picture, square to it (cm) */
  distanceCm: number;
  /** How far each side screen turns in from the centre screen's plane (degrees, 0 = flat); null = facing the eye */
  sideAngleDeg: number | null;
  /** The eye above (+) or below (-) the middle of the screens (cm) */
  eyeHeightCm: number;
  /** With three screens, the driver's-eye views show what the screens frame at this distance (the true field of view) */
  physicalFov: boolean;
  /** The side screens' render resolution as a share of the centre's */
  sideScale: SideScreenScale;
}

export const SCREEN_LIMITS = {
  diagonalIn: { min: 13, max: 65 },
  bezelMm: { min: -20, max: 50 },
  distanceCm: { min: 30, max: 200 },
  sideAngleDeg: { min: 0, max: 90 },
  eyeHeightCm: { min: -30, max: 30 },
} as const;

export const DEFAULT_SCREEN_SETTINGS: Readonly<ScreenSettings> = {
  mode: "single",
  diagonalIn: 27,
  bezelMm: 8,
  distanceCm: 70,
  sideAngleDeg: null,
  eyeHeightCm: 0,
  physicalFov: true,
  sideScale: 1,
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clampNum = (v: unknown, lim: { min: number; max: number }, fallback: number, step: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(lim.max, Math.max(lim.min, v)) / step) * step : fallback;

/** A saved screen setup, checked and held to its limits (anything missing or broken takes the default) */
export function parseScreenSettings(v: unknown): ScreenSettings {
  const d = DEFAULT_SCREEN_SETTINGS;
  if (!isObj(v)) return { ...d };
  return {
    mode: v.mode === "triple" ? "triple" : "single",
    diagonalIn: clampNum(v.diagonalIn, SCREEN_LIMITS.diagonalIn, d.diagonalIn, 0.5),
    bezelMm: clampNum(v.bezelMm, SCREEN_LIMITS.bezelMm, d.bezelMm, 1),
    distanceCm: clampNum(v.distanceCm, SCREEN_LIMITS.distanceCm, d.distanceCm, 1),
    // No angle (or a broken one): facing the eye
    sideAngleDeg:
      typeof v.sideAngleDeg === "number" && Number.isFinite(v.sideAngleDeg)
        ? clampNum(v.sideAngleDeg, SCREEN_LIMITS.sideAngleDeg, 0, 0.5)
        : null,
    eyeHeightCm: clampNum(v.eyeHeightCm, SCREEN_LIMITS.eyeHeightCm, d.eyeHeightCm, 0.5),
    physicalFov: typeof v.physicalFov === "boolean" ? v.physicalFov : d.physicalFov,
    sideScale: SIDE_SCREEN_SCALES.includes(v.sideScale as SideScreenScale) ? (v.sideScale as SideScreenScale) : d.sideScale,
  };
}

const DEG = Math.PI / 180;
const INCH_M = 0.0254;

/** The physical layout, in metres and radians */
export interface ScreenRig {
  /** One screen's picture */
  w: number;
  h: number;
  /** One screen's frame beside its picture (negative: hidden by strips) */
  bezel: number;
  /** Eye to the centre screen's picture */
  distance: number;
  /** Side screens' turn toward the eye */
  angle: number;
  /** Eye above the middle of the screens */
  eyeHeight: number;
}

/** One screen's picture (metres) from its diagonal and its pixel aspect (width / height, square pixels) */
export function pictureSize(diagonalIn: number, aspect: number): { w: number; h: number } {
  const a = Math.max(0.1, aspect);
  const diag = diagonalIn * INCH_M;
  const h = diag / Math.sqrt(a * a + 1);
  return { w: h * a, h };
}

/**
 * The side angle at which each side screen's picture faces the eye straight on: the line from the eye through the
 * middle of the side picture is square to it (what setup guides recommend: the eye is the same distance from every
 * screen's middle). Without frames it is 2·atan(W / 2D); the frames push it out a little.
 */
export function facingAngleRad(w: number, bezel: number, distance: number): number {
  // In the horizontal plane (x across, z toward the eye at the origin): the side picture's middle M, and the side of the
  // screen's normal the eye is on. As the angle grows from 0 to 90° the eye moves from the normal's outer side to its
  // inner side once, so bisect on the sign
  const err = (a: number) => {
    const ux = Math.cos(a);
    const uz = Math.sin(a);
    const mx = w / 2 + bezel + (bezel + w / 2) * ux;
    const mz = -distance + (bezel + w / 2) * uz;
    // The normal toward the eye (-sin a, cos a) crossed with the line from M to the eye (-mx, -mz), negated: positive
    // while the screen needs to turn further in
    const nx = -Math.sin(a);
    const nz = Math.cos(a);
    return mx * nz - mz * nx;
  };
  let lo = 0;
  let hi = Math.PI / 2;
  if (err(lo) <= 0) return 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (err(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The physical layout for these settings, a screen's pixel aspect (width / height) giving its picture's shape */
export function screenRig(s: ScreenSettings, screenAspect: number): ScreenRig {
  const { w, h } = pictureSize(s.diagonalIn, screenAspect);
  const bezel = s.bezelMm / 1000;
  const distance = s.distanceCm / 100;
  const angle = s.sideAngleDeg === null ? facingAngleRad(w, bezel, distance) : s.sideAngleDeg * DEG;
  return { w, h, bezel, distance, angle, eyeHeight: s.eyeHeightCm / 100 };
}

/** The vertical field of view (degrees) the centre screen spans at the real distance: the "true" field of view */
export function physicalVerticalFovDeg(rig: Pick<ScreenRig, "h" | "distance">): number {
  return (2 * Math.atan(rig.h / 2 / rig.distance)) / DEG;
}

/** A view's window: the near-plane rectangle at unit distance in its own camera's frame (tangents) */
export interface ViewWindow {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/** One screen's view: its camera's turn from the centre camera (radians, + to the left as three yaws) and its window */
export interface ScreenView extends ViewWindow {
  yaw: number;
}

/** The eye in the rig's frame: across and up from the middle of the centre screen, and its distance from that screen */
export interface Eye {
  x: number;
  y: number;
  distance: number;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Tangents beyond this (about 87°) would be a degenerate frustum: held there */
const MAX_TAN = 20;
const clampTan = (t: number) => Math.max(-MAX_TAN, Math.min(MAX_TAN, t));

/** The window of a screen given its lower-left / lower-right / upper-left corners, seen from the eye */
function offAxisWindow(pa: V3, pb: V3, pc: V3, pe: V3, vr: V3, vu: V3, vn: V3): ViewWindow {
  const va = sub(pa, pe);
  const vb = sub(pb, pe);
  const vc = sub(pc, pe);
  // The eye's distance to the screen's plane; a screen turned so far that the eye is (nearly) in its plane is held a
  // millimetre in front of it rather than flipping the frustum
  const d = Math.max(1e-3, -dot(va, vn));
  return {
    left: clampTan(dot(vr, va) / d),
    right: clampTan(dot(vr, vb) / d),
    bottom: clampTan(dot(vu, va) / d),
    top: clampTan(dot(vu, vc) / d),
  };
}

/**
 * The three views (left, centre, right) for the screens of `rig` seen from `eye`. The rig's own distance and eye
 * height are not used: the eye given is where the views are drawn from (see eyeForWindow).
 */
export function tripleViews(rig: Pick<ScreenRig, "w" | "h" | "bezel" | "angle">, eye: Eye): [ScreenView, ScreenView, ScreenView] {
  const { w, h, bezel } = rig;
  const a = Math.min(Math.PI / 2, Math.max(0, rig.angle));
  const D = eye.distance;
  const pe: V3 = [eye.x, eye.y, 0];
  const yLo = -h / 2;
  const yHi = h / 2;
  const up: V3 = [0, 1, 0];

  const centre: ScreenView = {
    yaw: 0,
    ...offAxisWindow([-w / 2, yLo, -D], [w / 2, yLo, -D], [-w / 2, yHi, -D], pe, [1, 0, 0], up, [0, 0, 1]),
  };

  // Right screen: hinged at the centre screen's right frame edge, its picture starting one frame further on
  const c = Math.cos(a);
  const s = Math.sin(a);
  const hingeR: V3 = [w / 2 + bezel, 0, -D];
  const uR: V3 = [c, 0, s];
  const nR: V3 = [-s, 0, c];
  const inR: V3 = [hingeR[0] + bezel * c, 0, hingeR[2] + bezel * s];
  const outR: V3 = [hingeR[0] + (bezel + w) * c, 0, hingeR[2] + (bezel + w) * s];
  const right: ScreenView = {
    // three yaws positive to the left (about +Y): the right camera turns by -a
    yaw: -a,
    ...offAxisWindow([inR[0], yLo, inR[2]], [outR[0], yLo, outR[2]], [inR[0], yHi, inR[2]], pe, uR, up, nR),
  };

  // Left screen: the mirror image; its picture runs from its outer end (left) to its inner end (right)
  const uL: V3 = [c, 0, -s];
  const nL: V3 = [s, 0, c];
  const hingeL: V3 = [-w / 2 - bezel, 0, -D];
  const inL: V3 = [hingeL[0] - bezel * c, 0, hingeL[2] + bezel * s];
  const outL: V3 = [hingeL[0] - (bezel + w) * c, 0, hingeL[2] + (bezel + w) * s];
  const left: ScreenView = {
    yaw: a,
    ...offAxisWindow([outL[0], yLo, outL[2]], [inL[0], yLo, inL[2]], [outL[0], yHi, outL[2]], pe, uL, up, nL),
  };
  return [left, centre, right];
}

/**
 * The eye that sees the centre screen exactly as `window`: the views follow the game's camera (its field of view, and
 * the title menu's off-centre framing) and the side screens add what lies beyond the centre one. `eyeHeight` lifts the
 * eye on top of that (the horizon sits lower on every screen when the eye is above their middle).
 */
export function eyeForWindow(rig: Pick<ScreenRig, "w" | "h">, window: ViewWindow, eyeHeight = 0): Eye {
  const span = Math.max(1e-6, window.right - window.left);
  const distance = rig.w / span;
  return {
    x: -rig.w / 2 - window.left * distance,
    y: -rig.h / 2 - window.bottom * distance + eyeHeight,
    distance,
  };
}

/** The horizontal field of view (degrees) the three views cover together, outer edge to outer edge */
export function totalHorizontalFovDeg(views: readonly [ScreenView, ScreenView, ScreenView]): number {
  const [l, , r] = views;
  // A view turned by yaw (positive left) sees from yaw - atan(right) on its right to yaw - atan(left) on its left
  const leftmost = l.yaw - Math.atan(l.left);
  const rightmost = r.yaw - Math.atan(r.right);
  return (leftmost - rightmost) / DEG;
}

/** A symmetric window of vertical field of view `vFovDeg` and aspect `aspect` (width / height) */
export function symmetricWindow(vFovDeg: number, aspect: number): ViewWindow {
  const t = Math.tan((vFovDeg * DEG) / 2);
  return { left: -t * aspect, right: t * aspect, bottom: -t, top: t };
}

// ---------------------------------------------------------------------------
// The canvas split
// ---------------------------------------------------------------------------

/** A rectangle in CSS pixels from the canvas' left and top */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The three screens' rectangles on a canvas `width` x `height` (CSS px) drawn at `pixelRatio`: equal thirds, split on
 * whole device pixels so neighbouring views neither overlap nor leave a gap.
 */
export function tripleRects(width: number, height: number, pixelRatio = 1): [ScreenRect, ScreenRect, ScreenRect] {
  const devW = Math.floor(width * pixelRatio);
  const cuts = [0, Math.round(devW / 3), Math.round((devW * 2) / 3), devW];
  const rect = (i: number): ScreenRect => ({
    x: cuts[i] / pixelRatio,
    y: 0,
    w: (cuts[i + 1] - cuts[i]) / pixelRatio,
    h: height,
  });
  return [rect(0), rect(1), rect(2)];
}

/** A canvas this wide for its height looks like three screens side by side (3 x 16:10 is 4.8; one 32:9 screen is 3.6) */
export const TRIPLE_ASPECT_MIN = 4.2;
export const looksLikeTriple = (width: number, height: number) => height > 0 && width / height >= TRIPLE_ASPECT_MIN;
/**
 * The narrowest canvas three screens are drawn on: three square screens (three 5:4 screens are 3.75, three 4:3 ones
 * 4). Narrower, with Three chosen, it is one screen's window: one view, and Settings says why
 */
export const TRIPLE_FIT_ASPECT_MIN = 3;
export const tripleFits = (width: number, height: number) => height > 0 && width / height >= TRIPLE_FIT_ASPECT_MIN;

/** Each of three screens' pixel aspect (width / height) on a canvas of this size */
export const tripleScreenAspect = (width: number, height: number) => width / 3 / Math.max(1, height);
