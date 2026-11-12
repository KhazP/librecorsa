import * as THREE from "three";
import { createGltfLoader } from "@/lib/render/gltf-loader";
import { sharpenCarMaps } from "@/lib/render/ported-car-materials";
import { assetProgress, type AssetTaskId } from "@/lib/loading/asset-progress";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { withBasePath } from "@/lib/base-path";
import { VF26_CHASSIS } from "@/lib/sim/vf26-data";
import type { CarTelemetry, LiveryConfig, TireCompound } from "@/types/f1";
import {
  installTyreDeformation,
  setTyreDeformationMap,
  type TyreDeformationHandle,
} from "@/lib/render/tyre-deformation";
import { applyRearRainLight } from "@/lib/render/golden-hour-environment";
import { PAINT_ZONE_MATERIALS, setVf26LiveryColours, upgradeVf26Materials } from "@/lib/render/car-materials";
import { installVertexOcclusion } from "@/lib/render/vertex-occlusion";
import { createDriverFigure } from "@/lib/render/driver-figure";
import { createDriverHelmet } from "@/lib/render/driver-helmet";
import { installLiveryDecals } from "@/lib/render/livery-decals";
import { moveToDriverHeadLayer } from "@/lib/render/layers";
import {
  relativeMatrix,
  updateCorners,
  WHEEL_NODES,
  WHEEL_SIDES,
  type RigCorner,
  type WheelSeating,
} from "@/lib/render/corner-rig";
import { singlePassTransparency } from "@/lib/render/static-scene";
import { createSuspensionArms, type ArmHub } from "@/lib/render/suspension-arms";

/**
 * The 2026 Prototype's body (`public/cars/f12026/model/f12026.glb`): Qvist Designs' 2026 concept, ported by
 * `scripts/cars/port_qvist_f1.mjs`. On builds without the GLB `loadVf26Template()` resolves to null and the procedural
 * car stays in place.
 *
 * Model space: +X left, +Y up, +Z forward, tyres on y = 0 — the same axes as the rig, so only a translation is needed.
 *
 * Paint: the body's zone materials (`PAINT_ZONE_MATERIALS`) take the selected LiveryConfig's primary, secondary and
 * accent, per car. A GLB with a livery mask (root extras `liveryMask`) mixes them in the shader instead. Moving parts:
 * wheels, the brake drums on them (`SUSP_xx`), the suspension arms (`ARM_xx_n`, `render/suspension-arms.ts`), steering
 * wheel, the wing flaps (extras `aeroClosed` / `aeroOpen`) and, where the GLB has one, a skinned driver; a body
 * without one gets a helmet at its extras' `helmet.pos`.
 */
export const VF26_MODEL_URL = "/cars/f12026/model/f12026.glb";

export interface Vf26CameraAnchor {
  /** Rig-local position (m): +X left, +Y up, +Z forward */
  pos: THREE.Vector3;
  pitchRad: number;
  fovDeg: number;
}

export interface Vf26ModelInstance {
  bodyGroup: THREE.Group;
  cameraAnchors: Record<
    "cockpit" | "shoulder" | "tcam" | "dash" | "bumper" | "nearChase" | "farChase",
    Vf26CameraAnchor
  >;
  /** `wheels` drives the contact-patch / sidewall deformation and seats the wheels on the road; omitted = undeformed */
  update: (telemetry: CarTelemetry, wheelRotationRad: number, dtSeconds: number, wheels?: WheelSeating) => void;
  /** Swap the tyre sidewall texture per compound */
  setTireCompound: (compound: TireCompound) => void;
  /** Livery colours for the masked paint */
  setLivery: (livery: LiveryConfig) => void;
  dispose: () => void;
}

interface TemplateAssets {
  tyreMaps: Partial<Record<TireCompound, THREE.Texture>>;
  animations: THREE.AnimationClip[];
}

const templatePromises = new Map<string, Promise<THREE.Group | null>>();
// Kept out of userData: Object3D.clone() JSON-serialises userData, which would encode every texture per car
const templateAssets = new WeakMap<THREE.Object3D, TemplateAssets>();

/** `task`: the loading-screen task its download counts toward (the player's car, or the opponents' when it differs) */
export function loadVf26Template(modelUrl: string = VF26_MODEL_URL, task: AssetTaskId = "car"): Promise<THREE.Group | null> {
  let promise = templatePromises.get(modelUrl);
  if (!promise) {
    promise = (async () => {
      if (typeof window === "undefined") return null;
      const url = withBasePath(modelUrl);
      assetProgress.begin(task);
      try {
        const gltf = await createGltfLoader().loadAsync(url, (event) => assetProgress.progress(task, event));
        const scene = gltf.scene;
        // Per-compound tyre maps are stored as extra textures (index list in the root node extras)
        const tyreIdx = (scene.getObjectByName("VF26")?.userData?.tyreMaps ?? {}) as Record<string, number>;
        const tyreMaps: Partial<Record<TireCompound, THREE.Texture>> = {};
        for (const [compound, idx] of Object.entries(tyreIdx)) {
          const tex = (await gltf.parser.getDependency("texture", idx)) as THREE.Texture;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tyreMaps[compound as TireCompound] = tex;
        }
        templateAssets.set(scene, { tyreMaps, animations: gltf.animations });
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          // bounds of skinned meshes come from the standing bind pose, not the seated one
          if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial;
            sharpenCarMaps(m);
            if (std.transparent) std.depthWrite = false;
            singlePassTransparency(std);
          }
        });
        scene.updateMatrixWorld(true);
        assetProgress.done(task);
        return scene;
      } catch (err) {
        console.warn("VF26 model not loaded, using the procedural car", err);
        assetProgress.fail(task);
        return null;
      }
    })();
    templatePromises.set(modelUrl, promise);
  }
  return promise;
}

const WHEELS = WHEEL_NODES;
const SIDE = WHEEL_SIDES;
/** Index into a CarTelemetry [FL, FR, RL, RR] array for each physics wheel (FR, FL, RR, RL) */
const PHYSICS_TO_TELEMETRY = [1, 0, 3, 2] as const;


function setFromMatrix(obj: THREE.Object3D, m: THREE.Matrix4): void {
  m.decompose(obj.position, obj.quaternion, obj.scale);
}

/**
 * Fractional frame of the driver's steer clip for a steering-wheel angle. `table[i]` is the wheel angle (deg,
 * + = right) that frame i was measured to represent; it is monotonic, flat where the hands stop moving.
 */
function steerFrame(table: number[], deg: number): number {
  let lo = 0;
  let hi = table.length - 1;
  if (deg <= table[lo]) return lo;
  if (deg >= table[hi]) {
    while (hi > 0 && table[hi - 1] >= table[hi]) hi--;
    return hi;
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= deg) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  return lo + (span > 1e-6 ? (deg - table[lo]) / span : 0);
}

/**
 * Attach a clone of the VF26 template to an existing car rig.
 * - body + cockpit go into `chassisGroup` (sprung: pitch / roll / heave)
 * - wheels, uprights and discs go into per-corner pivots under `root` (unsprung), steered and spun here
 */
export function attachVf26Model(
  template: THREE.Group,
  root: THREE.Group,
  chassisGroup: THREE.Group,
  options: { opponent?: boolean } = {}
): Vf26ModelInstance {
  const assets = templateAssets.get(template) ?? { tyreMaps: {}, animations: [] };
  const model = cloneSkinned(template) as THREE.Group;
  model.updateMatrixWorld(true);
  const vf = model.getObjectByName("VF26") ?? model;
  const extras = (vf.userData ?? {}) as {
    wheelCentres?: Record<string, [number, number, number]>;
    cameras?: Record<string, { pos: [number, number, number]; pitchDeg: number; fov: number }>;
    driver?: { steerClip: string; fps: number; steerAngleDeg: number[] };
    helmet?: { pos: [number, number, number] };
    liveryMask?: boolean;
  };
  const find = (name: string) => model.getObjectByName(name);

  // Align the model's front axle with the physics front axle (the rig origin is the CG projected on the
  // ground) and sit the tyres on the ground.
  const cgToFront = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
  const lf = extras.wheelCentres?.WHEEL_LF ?? [0.731, 0.26, 1.521];
  const tyre = find("WHEEL_LF_TYRE") as THREE.Mesh | undefined;
  tyre?.geometry.computeBoundingBox();
  const tyreRadius = tyre?.geometry.boundingBox ? tyre.geometry.boundingBox.max.y : 0.349;
  const offset = new THREE.Vector3(0, tyreRadius - lf[1], cgToFront - lf[2]);

  const bodyGroup = new THREE.Group();
  bodyGroup.name = "VF26_BODY";
  bodyGroup.position.copy(offset);

  // Per-corner pivots. Built before re-parenting so the bind matrices can be read from the clone.
  interface Corner extends RigCorner {
    discMat: THREE.MeshStandardMaterial | null;
  }
  const corners: Corner[] = [];
  const hubs = new Map<string, ArmHub>();
  // The arms' frame against the model's, read before anything is re-parented
  const bodyNode = find("BODY");
  const modelToBody = bodyNode ? relativeMatrix(bodyNode, vf).invert() : null;
  WHEELS.forEach((wheelName, i) => {
    const wheel = find(wheelName);
    if (!wheel) return;
    const wheelBind = relativeMatrix(wheel, vf);
    const centre = new THREE.Vector3().setFromMatrixPosition(wheelBind);
    const steer = new THREE.Group();
    steer.name = `VF26_STEER_${SIDE[i]}`;
    steer.position.copy(centre).add(offset);
    const pivotBind = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z);
    const pivotInv = pivotBind.clone().invert();

    // Upright / hub carrier: steers with the wheel, does not spin
    const upright = find(`SUSP_${SIDE[i]}`);
    if (upright) {
      const m = pivotInv.clone().multiply(relativeMatrix(upright, vf));
      steer.add(upright);
      setFromMatrix(upright, m);
    }
    // Wheel node keeps its camber rotation; rim, tyre and disc spin about its local X axis (the axle)
    const wheelLocal = pivotInv.clone().multiply(wheelBind);
    const wheelInv = wheelBind.clone().invert();
    const spin = new THREE.Group();
    spin.name = `VF26_SPIN_${SIDE[i]}`;
    for (const child of [...wheel.children]) spin.add(child);
    const disc = find(`DISC_${SIDE[i]}`);
    let discMat: THREE.MeshStandardMaterial | null = null;
    if (disc) {
      const m = wheelInv.clone().multiply(relativeMatrix(disc, vf));
      spin.add(disc);
      setFromMatrix(disc, m);
      const dm = disc as THREE.Mesh;
      if (dm.isMesh) {
        discMat = (dm.material as THREE.MeshStandardMaterial).clone();
        discMat.emissive = new THREE.Color(0xff3a0a);
        discMat.emissiveIntensity = 0;
        dm.material = discMat;
      }
    }
    wheel.add(spin);
    steer.add(wheel);
    setFromMatrix(wheel, wheelLocal);
    root.add(steer);
    hubs.set(SIDE[i], { steer, centre });
    corners.push({
      steer,
      spin,
      isFront: i < 2,
      isLeft: i % 2 === 1,
      discMat,
      restY: steer.position.y,
      tyre: null,
    });
  });

  // Belts buckled with a driver in the seat; lying open on the seat otherwise
  const driver = find("DRIVER");
  for (const name of ["BODY", "COCKPIT", "DRIVER", driver ? "HARNESS_ON" : "HARNESS_OFF"]) {
    const part = find(name);
    if (part) bodyGroup.add(part);
  }
  find(driver ? "HARNESS_OFF" : "HARNESS_ON")?.removeFromParent();
  chassisGroup.add(bodyGroup);
  // Suspension arms: each keeps its outer end on its wheel's drum
  const arms = bodyNode && modelToBody ? createSuspensionArms(bodyNode, root, hubs, modelToBody) : null;

  // Driver arms follow the wheel through the mod's driver_steer clip (time set from the wheel angle)
  const helmet = driver?.getObjectByName("HELMET") ?? null;
  // The cockpit camera leaves this layer out (the eye point sits inside the helmet); the sun's shadow camera
  // keeps it, so the head still shadows the cockpit
  if (helmet) moveToDriverHeadLayer(helmet);
  const steerTable = extras.driver?.steerAngleDeg ?? [];
  const steerClip = assets.animations.find((a) => a.name === (extras.driver?.steerClip ?? "steer"));
  let driverMixer: THREE.AnimationMixer | null = null;
  let steerAction: THREE.AnimationAction | null = null;
  if (driver && steerClip && steerTable.length > 1) {
    driverMixer = new THREE.AnimationMixer(driver);
    steerAction = driverMixer.clipAction(steerClip);
    steerAction.play();
    steerAction.paused = true;
  }
  const driverFps = extras.driver?.fps ?? 30;

  // Active aero (X-mode) flap poses baked from the mod's DRS animation
  interface AeroPart {
    obj: THREE.Object3D;
    p0: THREE.Vector3;
    q0: THREE.Quaternion;
    p1: THREE.Vector3;
    q1: THREE.Quaternion;
  }
  const aero: AeroPart[] = [];
  bodyGroup.traverse((obj) => {
    const ud = obj.userData as { aeroClosed?: number[]; aeroOpen?: number[] };
    if (!ud.aeroClosed || !ud.aeroOpen) return;
    const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), p1 = new THREE.Vector3(), q1 = new THREE.Quaternion();
    const s = new THREE.Vector3();
    new THREE.Matrix4().fromArray(ud.aeroClosed).decompose(p0, q0, s);
    new THREE.Matrix4().fromArray(ud.aeroOpen).decompose(p1, q1, s);
    aero.push({ obj, p0, q0, p1, q1 });
  });
  let aeroBlend = 0;

  // Steering wheel (STEER_BASE, bind rotation = identity): +rotation.z turns the rim clockwise as seen by
  // the driver (top of the rim moves to the right, -X), i.e. a right turn.
  const steerBase = bodyGroup.getObjectByName("STEER_BASE");
  const lockRad = VF26_CHASSIS.steering.lockDeg * THREE.MathUtils.DEG2RAD;
  const maxRoadWheelRad = lockRad / VF26_CHASSIS.steering.ratio;

  // Shift lights on the wheel rim
  const ledMats: THREE.MeshStandardMaterial[] = [];
  bodyGroup.getObjectByName("LED_RPM_0")?.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    mesh.material = mat;
    ledMats.push(mat);
  });

  // Tyres: each corner gets its own deforming clone of the tyre material (one shared shader program), so
  // the contact patch flattens, the sidewalls bulge and the carcass shears under the physics loads
  const tyreMaps = assets.tyreMaps;
  const tyreHandles: (TyreDeformationHandle | null)[] = corners.map((c) => {
    let tyreMesh: THREE.Mesh | null = null;
    c.spin.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.name.endsWith("_TYRE")) tyreMesh = mesh;
    });
    if (!tyreMesh) return null;
    const mesh = tyreMesh as THREE.Mesh;
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox!;
    // The wheel node's baked camber needs no telling: the rig gives the shader the road in the wheel node's own frame
    return installTyreDeformation(mesh, {
      unloadedRadiusM: box.max.y,
      halfWidthM: box.max.x,
      // A 2026 car: the 2026 Pirelli sidewall over the model's own (recoloured by setTireCompound)
      pirelliSidewall: "medium",
    });
  });
  corners.forEach((c, i) => (c.tyre = tyreHandles[i]));
  const liveTyreHandles = tyreHandles.filter((h): h is TyreDeformationHandle => h !== null);
  const setTireCompound = (compound: TireCompound) => {
    const map = tyreMaps[compound];
    if (map) setTyreDeformationMap(liveTyreHandles, map);
    for (const h of liveTyreHandles) h.setCompound(compound);
  };

  // Clearcoat paint, carbon weave (body, wings, uprights) and the rear FIA rain / ERS light, bright enough to bloom
  const liveryMask = extras.liveryMask === true;
  upgradeVf26Materials(bodyGroup, { liveryMask });
  for (const c of corners) upgradeVf26Materials(c.steer, { liveryMask });
  applyRearRainLight(bodyGroup);

  // Each car its own paint zone materials (the upgraded ones are shared by every clone of the template); the body's
  // carry the livery decals, the flaps' (in their own node space) do not
  const zoneMats = new Map<string, THREE.MeshStandardMaterial[]>();
  const ownZone = new Map<string, THREE.MeshStandardMaterial>();
  const decalMats: THREE.Material[] = [];
  const onFlap = (obj: THREE.Object3D) => {
    for (let o: THREE.Object3D | null = obj; o && o !== bodyGroup; o = o.parent) if (o.userData.aeroClosed) return true;
    return false;
  };
  bodyGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const flap = onFlap(mesh);
    const own = (m: THREE.Material): THREE.Material => {
      if (!PAINT_ZONE_MATERIALS.includes(m.name)) return m;
      const key = `${m.uuid}:${flap}`;
      let c = ownZone.get(key);
      if (!c) {
        c = (m as THREE.MeshStandardMaterial).clone();
        ownZone.set(key, c);
        zoneMats.set(m.name, [...(zoneMats.get(m.name) ?? []), c]);
        if (!flap) decalMats.push(c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
  });
  const decals = decalMats.length ? installLiveryDecals(decalMats) : null;

  // A body without a driver of its own gets one: a helmet in the cockpit and, with a steering wheel to hold, the
  // figure under it
  const driverHelmet = !driver && extras.helmet ? createDriverHelmet() : null;
  if (driverHelmet && extras.helmet) {
    driverHelmet.group.position.fromArray(extras.helmet.pos);
    bodyGroup.add(driverHelmet.group);
  }
  const driverFigure =
    driverHelmet && steerBase
      ? createDriverFigure({ helmet: driverHelmet.group.position, wheel: steerBase, frame: bodyGroup, coarse: options.opponent })
      : null;
  if (driverFigure) bodyGroup.add(driverFigure.group);

  // The body's baked shading, where its porter made it
  installVertexOcclusion([bodyGroup, ...corners.map((c) => c.steer)]);

  const cameraAnchors = {} as Vf26ModelInstance["cameraAnchors"];
  const cams = extras.cameras ?? {};
  for (const key of ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"] as const) {
    const c = cams[key] ?? { pos: [0, 0.74, 0], pitchDeg: -5, fov: 55 };
    cameraAnchors[key] = {
      pos: new THREE.Vector3(c.pos[0], c.pos[1], c.pos[2]).add(offset),
      pitchRad: c.pitchDeg * THREE.MathUtils.DEG2RAD,
      fovDeg: c.fov,
    };
  }
  // Over the left cockpit rim, behind the eye point, for the sim's shoulder view
  cameraAnchors.shoulder = {
    pos: cameraAnchors.cockpit.pos.clone().add(new THREE.Vector3(0.2, 0.2, -0.22)),
    pitchRad: -9 * THREE.MathUtils.DEG2RAD,
    fovDeg: 58,
  };

  const update = (
    t: CarTelemetry,
    wheelRotationRad: number,
    dtSeconds: number,
    wheels?: WheelSeating
  ) => {
    // Front wheels: telemetry.steering = road-wheel angle / max angle, + = right. rotation.y + = left.
    const roadWheel = -t.steering * maxRoadWheelRad;
    updateCorners(corners, roadWheel, wheelRotationRad, wheels);
    arms?.update();
    if (steerBase) steerBase.rotation.z = t.steering * lockRad;
    driverFigure?.update(t.steering * lockRad, dtSeconds);
    if (driverMixer && steerAction) {
      steerAction.time = steerFrame(steerTable, t.steering * VF26_CHASSIS.steering.lockDeg) / driverFps;
      driverMixer.update(0);
    }

    const target = t.activeAeroMode === "X_MODE" ? 1 : 0;
    aeroBlend += (target - aeroBlend) * Math.min(1, dtSeconds * 6);
    for (const a of aero) {
      a.obj.position.lerpVectors(a.p0, a.p1, aeroBlend);
      a.obj.quaternion.slerpQuaternions(a.q0, a.q1, aeroBlend);
    }

    corners.forEach((c, i) => {
      if (!c.discMat) return;
      // `corners` follow the physics wheel order (FR, FL, RR, RL); telemetry arrays are [FL, FR, RL, RR]
      const temp = t.brakeTempsC?.[PHYSICS_TO_TELEMETRY[i]] ?? 300;
      c.discMat.emissiveIntensity = THREE.MathUtils.clamp((temp - 520) / 480, 0, 1) * 3.5;
    });
    if (ledMats.length) {
      const rpmFrac = THREE.MathUtils.clamp((t.rpm - 8800) / (12850 - 8800), 0, 1);
      for (const m of ledMats) m.emissiveIntensity = 0.15 + rpmFrac * 3;
    }
  };

  const setLivery = (livery: LiveryConfig) => {
    if (liveryMask) setVf26LiveryColours(livery.primary, livery.secondary, livery.accent);
    const colours: Record<string, string> = {
      EXT_PAINT_PRIMARY: livery.primary,
      EXT_PAINT_SECONDARY: livery.secondary,
      EXT_PAINT_ACCENT: livery.accent,
    };
    for (const [name, mats] of zoneMats) for (const m of mats) m.color.set(colours[name]);
    decals?.set(livery.decals);
    driverHelmet?.setColours(livery.primary, livery.secondary, livery.accent);
    driverFigure?.setColours(livery.primary, livery.secondary, livery.accent);
  };

  const dispose = () => {
    driverMixer?.stopAllAction();
    driverHelmet?.dispose();
    driverFigure?.dispose();
    for (const m of ownZone.values()) m.dispose();
    for (const h of liveTyreHandles) h.dispose();
    bodyGroup.removeFromParent();
    for (const c of corners) c.steer.removeFromParent();
  };

  return { bodyGroup, cameraAnchors, update, setTireCompound, setLivery, dispose };
}
