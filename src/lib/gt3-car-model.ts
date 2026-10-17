import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { assetProgress } from "@/lib/loading/asset-progress";
import { withBasePath } from "@/lib/base-path";
import { AMG_GT3_CONFIG } from "@/lib/sim/gt3/AmgGt3Config";
import type { CarTelemetry } from "@/types/f1";
import type { TyreVisualState } from "@/lib/sim/simulator-car";
import type { SimCarRig } from "@/lib/car-builder-2026";
import type { Vf26CameraAnchor, Vf26ModelInstance } from "@/lib/vf26-car-model";
import { installTyreDeformation, type TyreDeformationHandle } from "@/lib/render/tyre-deformation";

/**
 * Mercedes-AMG GT3 3D model (`public/gt3/model/amg_gt3.glb`) and cockpit (`public/gt3/model/amg_gt3_cockpit.glb`).
 * Without the exterior file the rig shows a plain placeholder body; when the cockpit file loads, its CABIN,
 * STEER pivot, shift lights and TC / ABS indicators replace the exterior model's static interior meshes.
 *
 * Model space: +X left, +Y up, +Z forward, floor at y = 0 (the rig's axes). Node layout:
 *   GT3 (extras: wheelCentres, tyreRadius, tyreHalfWidth)
 *     BODY        body, interior, glass and lights (sprung)
 *     WHEEL_xx    hub pivot with the authored camber; children WHEEL_xx_RIM / WHEEL_xx_TYRE
 *     SUSP_xx     brake callipers (steer with the wheel, do not spin)
 */
const MODEL_URL = "/gt3/model/amg_gt3.glb";
const COCKPIT_URL = "/gt3/model/amg_gt3_cockpit.glb";
/**
 * Source-model meshes replaced by the ported cockpit (steering wheel, seat, belts, roll cage, dash, centre console).
 * GLTFLoader sanitises node names, so these are matched after the same sanitising ("amg:Interior_Geo" loads as
 * "amgInterior_Geo").
 */
const SOURCE_INTERIOR = ["amg:Interior_Geo", "amg:SeatBelt_Geo", "amg:Carbon1Details_Geo", "uv2:Carbon1Details_Geo"].map(
  (name) => THREE.PropertyBinding.sanitizeNodeName(name)
);

interface CockpitExtras {
  leds?: { name: string; rpm: number; emissive: [number, number, number] }[];
  ledBlinkRpm?: number;
  steerLockDeg?: number;
}

const WHEELS = ["WHEEL_RF", "WHEEL_LF", "WHEEL_RR", "WHEEL_LR"] as const; // physics wheel order 0..3
const SIDE = ["RF", "LF", "RR", "LR"] as const;

interface Gt3Extras {
  wheelCentres?: Record<string, [number, number, number]>;
  tyreRadius?: Record<string, number>;
  tyreHalfWidth?: Record<string, number>;
}

let templatePromise: Promise<THREE.Group | null> | null = null;
let cockpitPromise: Promise<THREE.Group | null> | null = null;

/** The ported cockpit (null when the file is absent: the source model's interior stays) */
export function loadGt3Cockpit(): Promise<THREE.Group | null> {
  if (!cockpitPromise) {
    cockpitPromise = (async () => {
      if (typeof window === "undefined") return null;
      const url = withBasePath(COCKPIT_URL);
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (!head.ok) return null;
        const scene = (await new GLTFLoader().loadAsync(url)).scene;
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const std = mesh.material as THREE.MeshStandardMaterial;
          if (std.map) std.map.anisotropy = 8;
          if (std.transparent) std.depthWrite = false;
        });
        scene.updateMatrixWorld(true);
        return scene;
      } catch (err) {
        console.warn("GT3 cockpit not loaded, keeping the model's own interior", err);
        return null;
      }
    })();
  }
  return cockpitPromise;
}

/**
 * Re-bases each wheel so its node origin is the tread centre and its axes are unmirrored (the source model's
 * right wheels are the left ones turned 180° about Y). The tyre deformation shader expects that frame: tread
 * centred on x = 0, spinning about +X. Done once on the template; the rim and tyre share one vertex buffer.
 */
function rebaseWheels(scene: THREE.Group, extras: Gt3Extras): void {
  const done = new Set<THREE.BufferAttribute | THREE.InterleavedBufferAttribute>();
  const normalMatrix = new THREE.Matrix3();
  for (const side of SIDE) {
    const wheel = scene.getObjectByName(`WHEEL_${side}`);
    const centre = extras.wheelCentres?.[`WHEEL_${side}`];
    if (!wheel || !centre) continue;
    wheel.updateMatrix();
    const local = wheel.matrix.clone();
    // Tread centre in the wheel's own frame (the parent GT3 node is unrotated)
    const mid = new THREE.Vector3(...centre).applyMatrix4(local.clone().invert());
    const flipped = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(local)).x < 0;
    // G maps the authored wheel frame to the re-based one; the node absorbs its inverse
    const G = new THREE.Matrix4().makeTranslation(-mid.x, -mid.y, -mid.z);
    if (flipped) G.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
    normalMatrix.getNormalMatrix(G);
    for (const child of wheel.children) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const geo = mesh.geometry;
      const pos = geo.getAttribute("position");
      if (!done.has(pos)) {
        done.add(pos);
        pos.applyMatrix4(G);
        pos.needsUpdate = true;
      }
      const nrm = geo.getAttribute("normal");
      if (nrm && !done.has(nrm)) {
        done.add(nrm);
        nrm.applyNormalMatrix(normalMatrix);
        nrm.needsUpdate = true;
      }
      const tan = geo.getAttribute("tangent");
      if (tan && !done.has(tan)) {
        done.add(tan);
        tan.transformDirection(G);
        tan.needsUpdate = true;
      }
    }
    local.multiply(G.clone().invert());
    local.decompose(wheel.position, wheel.quaternion, wheel.scale);
  }
  // Bounds after the rewrite (shared buffers: every geometry re-reads the moved vertices)
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.name.startsWith("WHEEL_")) return;
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  });
}

export function loadGt3Template(): Promise<THREE.Group | null> {
  if (!templatePromise) {
    templatePromise = (async () => {
      if (typeof window === "undefined") return null;
      const url = withBasePath(MODEL_URL);
      assetProgress.begin("car");
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (!head.ok) {
          assetProgress.fail("car");
          return null;
        }
        const gltf = await new GLTFLoader().loadAsync(url, (event) => assetProgress.progress("car", event));
        const scene = gltf.scene;
        const extras = (scene.getObjectByName("GT3")?.userData ?? {}) as Gt3Extras;
        rebaseWheels(scene, extras);
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial;
            if (std.map) std.map.anisotropy = 8;
            if (std.transparent) std.depthWrite = false;
          }
        });
        scene.updateMatrixWorld(true);
        assetProgress.done("car");
        return scene;
      } catch (err) {
        console.warn("GT3 model not loaded, using the placeholder body", err);
        assetProgress.fail("car");
        return null;
      }
    })();
  }
  return templatePromise;
}

/** Matrix of `obj` relative to `ancestor` (both inside the same, already updated, hierarchy). */
function relativeMatrix(obj: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
}

const anchor = (pos: [number, number, number], pitchDeg: number, fovDeg: number): Vf26CameraAnchor => ({
  pos: new THREE.Vector3(...pos),
  pitchRad: pitchDeg * THREE.MathUtils.DEG2RAD,
  fovDeg,
});

/**
 * Onboard cameras in model space, aligned with the left-hand driver seat and roof/bonnet mounts.
 */
const CAMERAS: Vf26ModelInstance["cameraAnchors"] = {
  cockpit: anchor([0.403, 0.955, -0.58], -4.17, 60),
  // Behind and inboard of the driver's head, under the roof
  shoulder: anchor([0.12, 1.05, -0.95], -6, 62),
  // Roof pod above the windscreen header
  tcam: anchor([0, 1.42, -0.35], -7, 58),
  dash: anchor([0.38, 0.86, -0.15], -3, 58),
  // On the bonnet, ahead of the windscreen
  bumper: anchor([0, 0.98, 0.95], -3, 60),
  nearChase: anchor([0, 1.9, -5.5], -10, 60),
  farChase: anchor([0, 2.4, -7.5], -10, 60),
};

/** A box the size of the car, shown while (or instead of, when the GLB is missing) the model loads */
function placeholderBody(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.95, 0.9, 4.6),
    new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 })
  );
  mesh.position.y = 0.6;
  mesh.castShadow = true;
  return mesh;
}

/**
 * The GT3's car rig: model body in `chassisGroup` (sprung), wheels and callipers on per-corner steer pivots under
 * `root` (unsprung), aligned so the model's axles sit on the physics axles.
 */
export function createGt3CarRig(): SimCarRig {
  const root = new THREE.Group();
  root.name = "GT3_RIG";
  const chassisGroup = new THREE.Group();
  root.add(chassisGroup);
  const placeholder = placeholderBody();
  chassisGroup.add(placeholder);

  const chassis = AMG_GT3_CONFIG.chassis;
  const maxRoadWheelRad = chassis.maxRoadWheelDeg * THREE.MathUtils.DEG2RAD;
  let cameraAnchors: Vf26ModelInstance["cameraAnchors"] | null = null;

  interface Corner {
    steer: THREE.Group;
    spin: THREE.Group;
    isFront: boolean;
    isLeft: boolean;
    restY: number;
    tyre: TyreDeformationHandle | null;
  }
  const corners: Corner[] = [];
  let disposed = false;

  // Cockpit parts driven from the telemetry (set once the cockpit model is attached)
  let steerPivot: THREE.Object3D | null = null;
  const steerRest = new THREE.Quaternion();
  let steerLockRad = 0;
  interface Led {
    material: THREE.MeshStandardMaterial;
    rpm: number;
  }
  const leds: Led[] = [];
  let ledBlinkRpm = Infinity;
  const indicators: Partial<Record<"abs" | "tc" | "tcLed" | "limiter", THREE.Object3D>> = {};

  void Promise.all([loadGt3Template(), loadGt3Cockpit()]).then(([template, cockpitTemplate]) => {
    if (!template || disposed) return;
    const model = template.clone(true);
    model.updateMatrixWorld(true);
    const gt3 = model.getObjectByName("GT3") ?? model;
    const extras = (gt3.userData ?? {}) as Gt3Extras;
    const find = (name: string) => model.getObjectByName(name);

    // Axle midpoint on the physics' (rig origin = CG on the ground), tyres on the ground
    const lf = extras.wheelCentres?.WHEEL_LF ?? [0.863, 0.342, 1.4];
    const lr = extras.wheelCentres?.WHEEL_LR ?? [0.866, 0.356, -1.229];
    const wb = chassis.wheelbase;
    const physicsMidZ = wb * (0.5 - chassis.frontWeightFraction);
    const offset = new THREE.Vector3(0, (extras.tyreRadius?.LF ?? 0.34) - lf[1], physicsMidZ - 0.5 * (lf[2] + lr[2]));

    const bodyGroup = new THREE.Group();
    bodyGroup.name = "GT3_BODY";
    bodyGroup.position.copy(offset);

    WHEELS.forEach((wheelName, i) => {
      const wheel = find(wheelName);
      if (!wheel) return;
      const wheelBind = relativeMatrix(wheel, gt3);
      const centre = new THREE.Vector3().setFromMatrixPosition(wheelBind);
      const steer = new THREE.Group();
      steer.name = `GT3_STEER_${SIDE[i]}`;
      steer.position.copy(centre).add(offset);
      const pivotInv = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);

      const calliper = find(`SUSP_${SIDE[i]}`);
      if (calliper) {
        pivotInv.clone().multiply(relativeMatrix(calliper, gt3)).decompose(calliper.position, calliper.quaternion, calliper.scale);
        steer.add(calliper);
      }
      // Wheel node keeps its camber; rim and tyre spin about its local X (the axle)
      const spin = new THREE.Group();
      spin.name = `GT3_SPIN_${SIDE[i]}`;
      for (const child of [...wheel.children]) spin.add(child);
      wheel.add(spin);
      pivotInv.clone().multiply(wheelBind).decompose(wheel.position, wheel.quaternion, wheel.scale);
      steer.add(wheel);
      root.add(steer);

      const isLeft = i % 2 === 1;
      // A rotation a about the forward (Z) axis moves the top of the wheel toward -X for a > 0
      const bakedCamberRad = -new THREE.Euler().setFromQuaternion(wheel.quaternion, "ZYX").z;
      const tyreMesh = spin.getObjectByName(`${wheelName}_TYRE`) as THREE.Mesh | undefined;
      const tyre = tyreMesh?.isMesh
        ? installTyreDeformation(tyreMesh, {
            unloadedRadiusM: extras.tyreRadius?.[SIDE[i]] ?? 0.34,
            halfWidthM: extras.tyreHalfWidth?.[SIDE[i]] ?? 0.163,
            bakedCamberRad,
          })
        : null;
      corners.push({ steer, spin, isFront: i < 2, isLeft, restY: steer.position.y, tyre });
    });

    const body = find("BODY");
    if (body) bodyGroup.add(body);

    if (cockpitTemplate) {
      const cockpit = cockpitTemplate.clone(true);
      const cx = (cockpit.getObjectByName("COCKPIT")?.userData ?? {}) as CockpitExtras;
      body?.traverse((obj) => {
        if (SOURCE_INTERIOR.some((prefix) => obj.name.startsWith(prefix))) obj.visible = false;
      });
      bodyGroup.add(cockpit);
      steerPivot = cockpit.getObjectByName("STEER") ?? null;
      if (steerPivot) steerRest.copy(steerPivot.quaternion);
      steerLockRad = (cx.steerLockDeg ?? 320) * THREE.MathUtils.DEG2RAD;
      // Shift lights: a material per LED so each lights on its own, at the mod's rpm switch and colour
      for (const led of cx.leds ?? []) {
        const mesh = cockpit.getObjectByName(led.name) as THREE.Mesh | undefined;
        if (!mesh?.isMesh) continue;
        const material = (mesh.material as THREE.MeshStandardMaterial).clone();
        const [r, g, b] = led.emissive;
        material.emissive.setRGB(r, g, b).multiplyScalar(1 / Math.max(r, g, b, 1e-6));
        material.emissiveIntensity = 0;
        mesh.material = material;
        leds.push({ material, rpm: led.rpm });
      }
      ledBlinkRpm = cx.ledBlinkRpm ?? Infinity;
      indicators.abs = cockpit.getObjectByName("DISPLAY_ABS");
      indicators.tc = cockpit.getObjectByName("DISPLAY_TC");
      indicators.limiter = cockpit.getObjectByName("LED_RPM_LIMITER");
      const tcLed = cockpit.getObjectByName("LED_RPM_TC") as THREE.Mesh | undefined;
      if (tcLed?.isMesh) {
        const material = (tcLed.material as THREE.MeshStandardMaterial).clone();
        material.emissive.setRGB(1, 0.75, 0);
        material.emissiveIntensity = 3;
        tcLed.material = material;
        indicators.tcLed = tcLed;
      }
      for (const key of ["abs", "tc", "tcLed", "limiter"] as const) {
        const obj = indicators[key];
        if (obj) obj.visible = false;
      }
      if (indicators.limiter) {
        const lim = indicators.limiter as THREE.Mesh;
        const material = (lim.material as THREE.MeshStandardMaterial).clone();
        material.emissive.setRGB(0.2, 0.4, 1);
        material.emissiveIntensity = 4;
        lim.material = material;
      }
    }
    placeholder.removeFromParent();
    placeholder.geometry.dispose();
    (placeholder.material as THREE.Material).dispose();
    chassisGroup.add(bodyGroup);

    const anchors = {} as Vf26ModelInstance["cameraAnchors"];
    for (const [key, c] of Object.entries(CAMERAS) as [keyof typeof CAMERAS, Vf26CameraAnchor][]) {
      anchors[key] = { pos: c.pos.clone().add(offset), pitchRad: c.pitchRad, fovDeg: c.fovDeg };
    }
    cameraAnchors = anchors;
  });

  const updateFromTelemetry = (
    t: CarTelemetry,
    _pitchRad: number,
    _rollRad: number,
    wheelRotationRad: number,
    _dtSeconds?: number,
    tyres?: readonly TyreVisualState[]
  ) => {
    // telemetry.steering = road-wheel angle / max angle, + = right; rotation.y + = left
    const roadWheel = -t.steering * maxRoadWheelRad;
    if (steerPivot) {
      // The wheel turns about its column (the pivot's local Z, pointing forward up the column): a positive angle
      // takes the top of the rim to -X, i.e. right
      steerPivot.quaternion.copy(steerRest);
      steerPivot.rotateZ(t.steering * steerLockRad);
    }
    if (leds.length) {
      const blinkOff = t.rpm >= ledBlinkRpm && Math.floor(performance.now() / 90) % 2 === 1;
      for (const led of leds) led.material.emissiveIntensity = t.rpm >= led.rpm && !blinkOff ? 4 : 0;
    }
    const aids = t.f12026;
    if (indicators.abs) indicators.abs.visible = aids?.absActive ?? false;
    if (indicators.tc) indicators.tc.visible = aids?.tcActive ?? false;
    if (indicators.tcLed) indicators.tcLed.visible = aids?.tcActive ?? false;
    if (indicators.limiter) indicators.limiter.visible = t.rpm >= ledBlinkRpm;
    corners.forEach((c, i) => {
      if (c.isFront) {
        // Ackermann: the inside wheel turns a little more
        const inside = (roadWheel > 0) === c.isLeft;
        c.steer.rotation.y = roadWheel * (inside ? 1.06 : 0.94);
      }
      c.spin.rotation.x = wheelRotationRad;
      const state = tyres?.[i];
      if (c.tyre && state) {
        c.tyre.update(state, wheelRotationRad, c.isLeft);
        c.steer.position.y = c.restY - c.tyre.axleDropM;
      }
    });
  };

  return {
    root,
    chassisGroup,
    helmetGroup: new THREE.Group(),
    // The model keeps its own paint and tyres
    setLivery: () => {},
    setTireCompound: () => {},
    getCameraAnchors: () => cameraAnchors,
    getVf26Body: () => null,
    setCockpitView: () => {},
    updateFromTelemetry,
    dispose: () => {
      disposed = true;
      for (const c of corners) c.tyre?.dispose();
      root.removeFromParent();
    },
  };
}
