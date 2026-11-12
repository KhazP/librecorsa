import * as THREE from "three";

/**
 * Suspension arms of a car body whose porter cut them free (`ARM_xx_n` nodes with `arm` extras, see
 * `scripts/cars/port_qvist_f1.mjs`). The body they hang on is sprung and the wheels are not, so every frame each arm
 * turns about its root on the chassis to keep its outer end where the wheel's drum has it:
 *
 * - `link`: one root. It points at its outer end and stretches by the little the two move apart.
 * - `wishbone`: two roots. It swings about the line through them, as one piece.
 * - `trackrod`: a link whose outer end also turns with the steered wheel; it keeps its length and slides across the
 *   car, as the rack moves it.
 *
 * Links and wishbones do not follow the steering: a steered drum turns about their ends, and they pass through its
 * face.
 */
export type ArmKind = "link" | "wishbone" | "trackrod";

export interface ArmHub {
  /** The corner's steer pivot (a child of the rig's root): rises and falls with the wheel, turns with the steering */
  steer: THREE.Object3D;
  /** The wheel's centre in the model's frame, where the pivot sits at rest */
  centre: THREE.Vector3;
}

interface Arm {
  obj: THREE.Object3D;
  kind: ArmKind;
  steer: THREE.Object3D;
  /** The outer end from the wheel's centre, in the car's axes */
  tipFromHub: THREE.Vector3;
  /** At rest, in the frame of the arms' parent: the root, the arm's attitude, root to outer end (and its length) */
  pivot: THREE.Vector3;
  rest: THREE.Quaternion;
  reach: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  /** A wishbone's hinge line and its rest reach across that line */
  hinge: THREE.Vector3;
  across: THREE.Vector3;
}

export interface SuspensionArms {
  /** After the wheels and the chassis have their pose for the frame */
  update: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);
const _toBody = new THREE.Matrix4();
const _target = new THREE.Vector3();
const _reach = new THREE.Vector3();
const _across = new THREE.Vector3();
const _cross = new THREE.Vector3();

/**
 * `body`: the node the arms are children of, already in the rig under `root` (the steer pivots' parent).
 * `modelToBody`: the model's frame (the one `arm.tip` and the wheel centres are in) to `body`'s.
 * `hubs`: by corner as in the node names (LF, RF, LR, RR).
 */
export function createSuspensionArms(
  body: THREE.Object3D,
  root: THREE.Object3D,
  hubs: ReadonlyMap<string, ArmHub>,
  modelToBody: THREE.Matrix4
): SuspensionArms | null {
  const arms: Arm[] = [];
  for (const obj of body.children) {
    const data = (obj.userData as { arm?: { kind?: ArmKind; tip?: [number, number, number] } }).arm;
    const hub = hubs.get(obj.name.split("_")[1] ?? "");
    if (!data?.tip || !hub) continue;
    const tip = new THREE.Vector3().fromArray(data.tip);
    const pivot = obj.position.clone();
    const reach = tip.clone().applyMatrix4(modelToBody).sub(pivot);
    const hinge = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.quaternion);
    arms.push({
      obj,
      kind: data.kind ?? "link",
      steer: hub.steer,
      tipFromHub: tip.clone().sub(hub.centre),
      pivot,
      rest: obj.quaternion.clone(),
      reach,
      dir: reach.clone().normalize(),
      length: reach.length(),
      hinge,
      across: reach.clone().addScaledVector(hinge, -reach.dot(hinge)),
    });
  }
  if (!arms.length) return null;

  const update = () => {
    // The rig's root frame (the steer pivots') to the arms' parent, whatever the chassis' heave, pitch and roll
    _toBody.identity();
    for (let o: THREE.Object3D | null = body; o && o !== root; o = o.parent) {
      o.updateMatrix();
      _toBody.premultiply(o.matrix);
    }
    _toBody.invert();
    for (const a of arms) {
      _target.copy(a.tipFromHub);
      if (a.kind === "trackrod") _target.applyAxisAngle(UP, a.steer.rotation.y);
      _target.add(a.steer.position).applyMatrix4(_toBody);
      _reach.subVectors(_target, a.pivot);
      if (a.kind === "wishbone") {
        _across.copy(_reach).addScaledVector(a.hinge, -_reach.dot(a.hinge));
        const angle = Math.atan2(_cross.crossVectors(a.across, _across).dot(a.hinge), a.across.dot(_across));
        a.obj.quaternion.setFromAxisAngle(a.hinge, angle).multiply(a.rest);
        continue;
      }
      let length = _reach.length();
      if (a.kind === "trackrod") {
        // The rack: the root moves across the car by what keeps the rod its own length
        const span = a.length * a.length - _reach.y * _reach.y - _reach.z * _reach.z;
        if (span > 0) {
          const shift = _reach.x - Math.sign(a.reach.x) * Math.sqrt(span);
          a.obj.position.set(a.pivot.x + shift, a.pivot.y, a.pivot.z);
          _reach.x -= shift;
          length = a.length;
        } else {
          a.obj.position.copy(a.pivot);
        }
      }
      if (length < 1e-6) continue;
      a.obj.quaternion.setFromUnitVectors(a.dir, _reach.divideScalar(length)).multiply(a.rest);
      a.obj.scale.z = length / a.length;
    }
  };
  return { update };
}
