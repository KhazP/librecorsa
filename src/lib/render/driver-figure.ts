import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { moveToDriverHeadLayer } from "./layers";

/**
 * The driver under the helmet of a car body that has none of its own (the 2026 Prototype's): a race suit's shoulders
 * and reclined torso, upper arms and forearms, and gloves on the steering wheel's two grips. Plain shapes in matte
 * fabric, to sit with a low-poly body; the legs are down in the tub and are not drawn.
 *
 * The gloves hold the grips and turn with the wheel; each arm is two bones solved from the shoulder to the wrist, the
 * elbow kept down inside the tub. Arms crossed past REGRIP_AT would have to pass through each other, so there the
 * hands let go, go half a turn back round the rim and take the opposite grips (the wheel is the same either way up),
 * which carries them through any steering lock.
 *
 * Everything is placed from two things the car gives: the helmet's centre and the steering wheel's node at its bind
 * pose. The figure is drawn in the body's frame: +X left, +Y up, +Z forward.
 *
 * The neck is on the driver-head layer with the helmet (the driver's-eye camera and a VR headset sit right above
 * it); the rest is on the default layer and single-sided, so an eye that ends up inside the torso sees through it.
 * An arm that a view's near plane would cut open is left out of that view (`skipWhenCut`): the dash view, ahead of
 * the eye, has the top hand's arm come past it at big wheel angles. The driver's-eye view never does.
 */
export interface DriverFigure {
  group: THREE.Group;
  /** `steerRad`: the steering wheel's angle from straight ahead (+ = a right turn, the node's rotation about +Z) */
  update: (steerRad: number, dtSeconds: number) => void;
  /** The livery's colours: the suit, the neck and harness, and the gloves */
  setColours: (primary: string, secondary: string, accent: string) => void;
  dispose: () => void;
}

export interface DriverFigureOptions {
  /** The helmet's centre in `frame` */
  helmet: THREE.Vector3;
  /** The steering wheel's node, straight ahead (its bind pose); it turns about its own +Z */
  wheel: THREE.Object3D;
  /** The frame the figure is drawn in, an ancestor of `wheel`: the car's body */
  frame: THREE.Object3D;
  /**
   * A car that is not the player's: its arms are posed again only once the wheel has turned COARSE_STEP, and the
   * hands change grips at once
   */
  coarse?: boolean;
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------
// Proportions (m)
// ---------------------------------------------------------------------------------------------------------------

/** Left shoulder joint from the helmet's centre; the right mirrors it */
const SHOULDER = new THREE.Vector3(0.185, -0.24, -0.03);
const UPPER_ARM_M = 0.31;
const FOREARM_M = 0.27;
/** Each sleeve's radius at its widest, the joint it starts from */
const UPPER_ARM_R = 0.058;
const FOREARM_R = 0.045;
/** An arm stops short of straight by this share of its length; the shoulder comes forward for the rest */
const REACH = 0.985;
const SHOULDER_GIVE_M = 0.07;

/**
 * Left wrist joint in the wheel's frame (+Z away from the driver): behind the grip, whose centre is at
 * (0.135, 0, -0.04). The right mirrors it.
 */
const WRIST = new THREE.Vector3(0.14, -0.012, -0.112);

/** The elbow's turn about the shoulder-to-wrist line, from straight down toward the outside of the car (rad) */
const SWIVEL_REST = 18 * DEG;
/** ...with the hand down and across under the other arm: out beside the waist, clear of the torso */
const SWIVEL_UNDER = 48 * DEG;
/** The elbow's centre stays this far inside the tub's walls (m from the car's centre line) */
const ELBOW_MAX_X = 0.208;

/** The hands change grips once the wheel is this far round on the grips they hold (rad) */
const REGRIP_AT = 150 * DEG;
/** ...and change back once it has come this far back the other way */
const REGRIP_BACK = 90 * DEG;
/** However fast the wheel spins, a hand is never carried further round than this */
const HAND_MAX = 165 * DEG;
const REGRIP_S = 0.26;
/** How far the hands come off the wheel, toward the driver, on their way to the other grips (m) */
const REGRIP_LIFT_M = 0.03;

/** A coarse figure's arms follow the wheel in steps of this (rad): 5 mm at the grips */
const COARSE_STEP = 2 * DEG;

// ---------------------------------------------------------------------------------------------------------------
// Shapes, shared by every figure
// ---------------------------------------------------------------------------------------------------------------

interface FigureShapes {
  torso: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  gloveL: THREE.BufferGeometry;
  gloveR: THREE.BufferGeometry;
}

let shapes: FigureShapes | null = null;

/** A limb from its joint at the origin along +Z: a ball at the joint and a tapered tube to the next one */
function limb(lengthM: number, jointR: number, startR: number, endR: number): THREE.BufferGeometry {
  const tube = new THREE.CylinderGeometry(endR, startR, lengthM, 14, 1, true);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, 0, lengthM / 2);
  const joint = new THREE.SphereGeometry(jointR, 14, 10);
  const merged = mergeGeometries([joint, tube]);
  joint.dispose();
  tube.dispose();
  return merged;
}

/**
 * A closed surface of ellipses strung along a straight line from `origin`: each ring is [distance along the line,
 * half-width across the car, half-depth toward `front`], and the first and last close it
 */
function loft(
  origin: THREE.Vector3,
  along: THREE.Vector3,
  front: THREE.Vector3,
  rings: readonly THREE.Vector3[],
  segments = 20
): THREE.BufferGeometry {
  const positions: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector3();
  rings.forEach((ring, i) => {
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      p.copy(origin).addScaledVector(along, ring.x).addScaledVector(front, Math.max(0, ring.z) * Math.sin(a));
      positions.push(p.x + Math.max(0, ring.y) * Math.cos(a), p.y, p.z);
      if (i === rings.length - 1) continue;
      const here = i * segments + j;
      const next = i * segments + ((j + 1) % segments);
      index.push(here, next, here + segments, next, next + segments, here + segments);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** `geo` (not indexed) mirrored left to right, its triangles turned back to face outward */
function mirrored(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.clone().scale(-1, 1, 1);
  const count = out.getAttribute("position").count;
  const index = new Uint16Array(count);
  for (let i = 0; i < count; i += 3) {
    index[i] = i;
    index[i + 1] = i + 2;
    index[i + 2] = i + 1;
  }
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

function buildShapes(): FigureShapes {
  // Torso, from the helmet's centre: lying back along the spine from the shoulders to the hips under the wheel,
  // widest across the shoulders, deepest at the chest, drawn in at the waist
  const spine = new THREE.Vector3(0, -0.53, 0.848);
  const chestward = new THREE.Vector3(0, 0.848, 0.53);
  const profile = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-0.058, 0, 0),
      new THREE.Vector3(-0.05, 0.075, 0.04),
      new THREE.Vector3(-0.028, 0.15, 0.07),
      new THREE.Vector3(0, 0.19, 0.088),
      new THREE.Vector3(0.06, 0.192, 0.102),
      new THREE.Vector3(0.17, 0.172, 0.098),
      new THREE.Vector3(0.3, 0.15, 0.086),
      new THREE.Vector3(0.41, 0.158, 0.09),
      new THREE.Vector3(0.465, 0.12, 0.066),
      new THREE.Vector3(0.488, 0, 0),
    ],
    false,
    "centripetal"
  );
  const origin = new THREE.Vector3(0, -0.25, -0.045);
  const rings = profile.getPoints(32);
  const body = loft(origin, spine, chestward, rings);
  /** Point on the chest `x` from the centre line and `s` down the spine, `proud` of the suit */
  const onChest = (s: number, x: number, proud: number, out: THREE.Vector3) => {
    let i = 0;
    while (i < rings.length - 2 && rings[i + 1].x < s) i++;
    const t = THREE.MathUtils.clamp((s - rings[i].x) / Math.max(1e-6, rings[i + 1].x - rings[i].x), 0, 1);
    const halfWidth = THREE.MathUtils.lerp(rings[i].y, rings[i + 1].y, t);
    const halfDepth = THREE.MathUtils.lerp(rings[i].z, rings[i + 1].z, t);
    const rise = halfDepth * Math.sqrt(Math.max(0, 1 - (x / halfWidth) ** 2)) + proud;
    return out.copy(origin).addScaledVector(spine, s).addScaledVector(chestward, rise).setX(x);
  };
  // The harness: a belt over each shoulder, meeting at the buckle
  const BUCKLE_S = 0.34;
  const belt = (side: 1 | -1) => {
    const positions: number[] = [];
    const index: number[] = [];
    const p = new THREE.Vector3();
    const steps = 12;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const s = THREE.MathUtils.lerp(-0.035, BUCKLE_S, t);
      const mid = THREE.MathUtils.lerp(0.09, 0.03, t);
      for (const edge of [-1, 1]) {
        onChest(s, side * (mid + edge * 0.021), 0.004, p);
        positions.push(p.x, p.y, p.z);
      }
      if (k === steps) continue;
      const a = 2 * k;
      if (side > 0) index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    return geo;
  };
  const buckle = new RoundedBoxGeometry(0.075, 0.016, 0.05, 2, 0.006);
  buckle.deleteAttribute("uv");
  buckle.rotateX(Math.atan2(chestward.z, chestward.y));
  const buckleAt = onChest(BUCKLE_S, 0, 0.006, new THREE.Vector3());
  buckle.translate(buckleAt.x, buckleAt.y, buckleAt.z);
  const parts = [body, belt(1), belt(-1)];
  const harness = mergeGeometries([parts[1].toNonIndexed(), parts[2].toNonIndexed(), buckle]);
  // Material groups: 0 the suit, 1 the harness
  const torso = mergeGeometries([body.toNonIndexed(), harness], true);
  for (const g of [...parts, buckle, harness]) g.dispose();

  // Neck, up into the helmet's open base
  const neck = new THREE.CylinderGeometry(0.054, 0.062, 0.115, 14, 1, true);
  neck.translate(0, -0.158, -0.025);

  // Forearm: the sleeve, and the glove's cuff over the end of it (material groups 0 and 1)
  const sleeve = limb(FOREARM_M, FOREARM_R, 0.042, 0.031);
  const cuff = new THREE.CylinderGeometry(0.035, 0.037, 0.046, 14, 1, false);
  cuff.rotateX(Math.PI / 2);
  cuff.translate(0, 0, FOREARM_M - 0.023);
  const forearm = mergeGeometries([sleeve, cuff], true);
  sleeve.dispose();
  cuff.dispose();

  // Left glove from its wrist joint, in the wheel's axes: the wrist, the back of the hand outside the grip, four
  // fingers closed round it, and the thumb lying on the wheel's face
  const wrist = new THREE.SphereGeometry(0.0365, 12, 8);
  const hand = new RoundedBoxGeometry(0.036, 0.088, 0.072, 2, 0.015);
  hand.translate(0.011, 0.012, 0.061);
  const fingers = [0, 1, 2, 3].map((i) => {
    const finger = new RoundedBoxGeometry(0.04, 0.0208, 0.07, 1, 0.009);
    finger.translate(-0.012, 0.012 + (i - 1.5) * 0.0222, 0.072);
    return finger;
  });
  const thumb = new THREE.CapsuleGeometry(0.011, 0.03, 4, 8);
  thumb.rotateZ(42 * DEG);
  thumb.translate(-0.036, 0.034, 0.036);
  const gloveParts = [wrist.toNonIndexed(), hand, ...fingers, thumb.toNonIndexed()];
  const gloveL = mergeGeometries(gloveParts);
  for (const part of [wrist, thumb, ...gloveParts]) part.dispose();

  return {
    torso,
    neck,
    upperArm: limb(UPPER_ARM_M, UPPER_ARM_R, 0.052, 0.043),
    forearm,
    gloveL,
    gloveR: mirrored(gloveL),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------------------------------------------

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, -1, 0);

// Scratch (single-threaded, never escapes a call)
const _shoulder = new THREE.Vector3();
const _wrist = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _along = new THREE.Vector3();
const _down = new THREE.Vector3();
const _out = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _turn = new THREE.Quaternion();

interface Arm {
  /** +1 left, -1 right */
  side: 1 | -1;
  upper: THREE.Mesh;
  fore: THREE.Mesh;
  glove: THREE.Mesh;
}

/** Elbow swivel for a hand `over` rad round the wheel: + up and over its top, - down and under */
function swivelFor(over: number): number {
  if (over >= 0) return SWIVEL_REST * (1 - THREE.MathUtils.smoothstep(over, 0, 70 * DEG));
  return SWIVEL_REST + (SWIVEL_UNDER - SWIVEL_REST) * THREE.MathUtils.smoothstep(-over, 0, 80 * DEG);
}

const _inView = new THREE.Vector3();

/**
 * Whether a view would cut a limb open: its near plane passes through the sleeve inside the frame. A camera ahead of
 * the eye (the dash view) has the top hand's arm come right past it at a big wheel angle.
 */
function cutByNearPlane(camera: THREE.Camera, limb: THREE.Mesh, lengthM: number, radiusM: number): boolean {
  const cam = camera as THREE.PerspectiveCamera;
  if (!cam.isPerspectiveCamera) return false;
  const view = cam.matrixWorldInverse;
  const m = limb.matrixWorld.elements;
  const reach = lengthM + 0.5;
  if (_inView.set(m[12], m[13], m[14]).applyMatrix4(view).lengthSq() > reach * reach) return false;
  const p = cam.projectionMatrix.elements;
  const halfWidth = cam.near / p[0] + radiusM;
  const halfHeight = cam.near / p[5] + radiusM;
  for (let i = 0; i <= 6; i++) {
    _inView.set(0, 0, (lengthM * i) / 6).applyMatrix4(limb.matrixWorld).applyMatrix4(view);
    if (Math.abs(-_inView.z - cam.near) < radiusM && Math.abs(_inView.x) < halfWidth && Math.abs(_inView.y) < halfHeight) {
      return true;
    }
  }
  return false;
}

/** Leaves a limb out of any view that would cut it open (a sliced sleeve shows its inside); its shadow stays */
function skipWhenCut(limb: THREE.Mesh, lengthM: number, radiusM: number): void {
  let skipped = false;
  limb.onBeforeRender = (_renderer, _scene, camera, geometry) => {
    skipped = cutByNearPlane(camera, limb, lengthM, radiusM);
    if (skipped) geometry.setDrawRange(0, 0);
  };
  limb.onAfterRender = (_renderer, _scene, _camera, geometry) => {
    if (skipped) geometry.setDrawRange(0, Infinity);
    skipped = false;
  };
}

export function createDriverFigure(options: DriverFigureOptions): DriverFigure {
  const geo = (shapes ??= buildShapes());
  const coarse = options.coarse === true;

  const group = new THREE.Group();
  group.name = "DRIVER_FIGURE";
  const fabric = (hex: number, roughness: number) => new THREE.MeshStandardMaterial({ color: hex, roughness, metalness: 0 });
  const suit = fabric(0x00a1de, 0.92);
  const trim = fabric(0x0f172a, 0.88);
  const gloves = fabric(0xfad201, 0.8);

  const mesh = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[]) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const torso = mesh("DRIVER_TORSO", geo.torso, [suit, trim]);
  torso.position.copy(options.helmet);
  const neck = mesh("DRIVER_NECK", geo.neck, trim);
  neck.position.copy(options.helmet);
  moveToDriverHeadLayer(neck);

  const arm = (side: 1 | -1): Arm => {
    const tag = side > 0 ? "L" : "R";
    const upper = mesh(`DRIVER_UPPER_ARM_${tag}`, geo.upperArm, suit);
    const fore = mesh(`DRIVER_FOREARM_${tag}`, geo.forearm, [suit, gloves]);
    skipWhenCut(upper, UPPER_ARM_M, UPPER_ARM_R);
    skipWhenCut(fore, FOREARM_M, FOREARM_R);
    return { side, upper, fore, glove: mesh(`DRIVER_GLOVE_${tag}`, side > 0 ? geo.gloveL : geo.gloveR, gloves) };
  };
  const arms = [arm(1), arm(-1)];

  // The wheel's bind pose in the figure's frame
  const wheelPos = new THREE.Vector3();
  const wheelQuat = new THREE.Quaternion();
  {
    const m = new THREE.Matrix4();
    for (let o: THREE.Object3D | null = options.wheel; o && o !== options.frame; o = o.parent) {
      o.updateMatrix();
      m.premultiply(o.matrix);
    }
    m.decompose(wheelPos, wheelQuat, new THREE.Vector3());
  }
  const helmet = options.helmet.clone();

  /** Puts one arm on its grip, `handRad` round from straight ahead and `liftM` off the wheel toward the driver */
  const poseArm = (a: Arm, handRad: number, liftM: number) => {
    const side = a.side;
    const c = Math.cos(handRad);
    const s = Math.sin(handRad);
    const x = side * WRIST.x;
    _wrist.set(x * c - WRIST.y * s, x * s + WRIST.y * c, WRIST.z - liftM).applyQuaternion(wheelQuat).add(wheelPos);
    _shoulder.set(side * SHOULDER.x, SHOULDER.y, SHOULDER.z).add(helmet);

    // The shoulder comes forward for a grip the arm cannot reach
    const full = UPPER_ARM_M + FOREARM_M;
    let reach = _along.subVectors(_wrist, _shoulder).length();
    _along.divideScalar(reach);
    const give = THREE.MathUtils.clamp(reach - REACH * full, 0, SHOULDER_GIVE_M);
    _shoulder.addScaledVector(_along, give);
    reach = Math.min(reach - give, full);

    // The elbow: on the circle both bones allow, turned from straight down toward the outside of the car
    const toElbow = (UPPER_ARM_M * UPPER_ARM_M - FOREARM_M * FOREARM_M + reach * reach) / (2 * reach);
    const radius = Math.sqrt(Math.max(0, UPPER_ARM_M * UPPER_ARM_M - toElbow * toElbow));
    _down.copy(DOWN).addScaledVector(_along, -DOWN.dot(_along)).normalize();
    _out.crossVectors(_along, _down).multiplyScalar(side);
    let swivel = swivelFor(side * handRad);
    // ...and no further out than the tub's wall
    const centreX = side * (_shoulder.x + toElbow * _along.x - helmet.x);
    const downX = radius * side * _down.x;
    const outX = radius * side * _out.x;
    if (centreX + downX * Math.cos(swivel) + outX * Math.sin(swivel) > ELBOW_MAX_X) {
      const span = Math.hypot(downX, outX);
      if (span > 1e-6) {
        swivel = Math.atan2(outX, downX) - Math.acos(THREE.MathUtils.clamp((ELBOW_MAX_X - centreX) / span, -1, 1));
      }
    }
    _elbow
      .copy(_shoulder)
      .addScaledVector(_along, toElbow)
      .addScaledVector(_down, radius * Math.cos(swivel))
      .addScaledVector(_out, radius * Math.sin(swivel));

    a.upper.position.copy(_shoulder);
    a.upper.quaternion.setFromUnitVectors(Z_AXIS, _dir.subVectors(_elbow, _shoulder).normalize());
    a.fore.position.copy(_elbow);
    a.fore.quaternion.setFromUnitVectors(Z_AXIS, _dir.subVectors(_wrist, _elbow).normalize());
    a.glove.position.copy(_wrist);
    a.glove.quaternion.copy(wheelQuat).multiply(_turn.setFromAxisAngle(Z_AXIS, handRad));
  };

  /** Half turns of the wheel the hands have let it make under them: the grips they hold, and where they are between */
  let grips = 0;
  let regrip = 0;
  /** The wheel angle and the `regrip` the arms were last posed for */
  let posedSteer = NaN;
  let posedRegrip = NaN;

  const update = (steerRad: number, dtSeconds: number) => {
    if (!Number.isFinite(steerRad)) return;
    const onGrips = steerRad - Math.PI * grips;
    if (onGrips > REGRIP_AT || (grips < 0 && onGrips > REGRIP_BACK)) grips++;
    else if (onGrips < -REGRIP_AT || (grips > 0 && onGrips < -REGRIP_BACK)) grips--;

    if (coarse) {
      regrip = grips;
      if (regrip === posedRegrip && Math.abs(steerRad - posedSteer) < COARSE_STEP) return;
    } else {
      const step = Math.max(0, dtSeconds) / REGRIP_S;
      regrip += THREE.MathUtils.clamp(grips - regrip, -step, step);
      if (regrip === posedRegrip && steerRad === posedSteer) return;
    }
    posedSteer = steerRad;
    posedRegrip = regrip;

    const held = Math.floor(regrip);
    const t = regrip - held;
    const eased = t * t * (3 - 2 * t);
    // A wheel spun faster than the hands change grips carries them along no further than HAND_MAX
    const handRad = THREE.MathUtils.clamp(steerRad - Math.PI * (held + eased), -HAND_MAX, HAND_MAX);
    const liftM = REGRIP_LIFT_M * 4 * eased * (1 - eased);
    for (const a of arms) poseArm(a, handRad, liftM);
  };
  update(0, 0);

  return {
    group,
    update,
    setColours: (primary, secondary, accent) => {
      suit.color.set(primary);
      trim.color.set(secondary);
      gloves.color.set(accent);
    },
    dispose: () => {
      // The shapes are shared by every figure and stay
      for (const m of [suit, trim, gloves]) m.dispose();
      group.removeFromParent();
    },
  };
}
