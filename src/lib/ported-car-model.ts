import * as THREE from "three";
import { createGltfLoader } from "@/lib/render/gltf-loader";
import { assetProgress } from "@/lib/loading/asset-progress";
import { withBasePath } from "@/lib/base-path";
import type { CarTelemetry } from "@/types/f1";
import type { TyreVisualState } from "@/lib/sim/simulator-car";
import type { SimCarRig } from "@/lib/car-builder-2026";
import type { Vf26ModelInstance } from "@/lib/vf26-car-model";
import { installTyreDeformation, type TyreDeformationHandle } from "@/lib/render/tyre-deformation";
import { cleanPortedCarMaterial, sharpenCarMaps } from "@/lib/render/ported-car-materials";

/**
 * Cars ported to one GLB each (a registry car's `modelUrl`), on any vehicle model. Node layout:
 *   CAR (extras: wheelCentres, tyreRadius, tyreHalfWidth, cameras, steer)
 *     BODY      body, driver and fixed interior (sprung)
 *     STEER     steering wheel pivot, column along its local +Z (optional)
 *     WHEEL_xx  hub pivot at the tread centre in the car's axes; children WHEEL_xx_RIM / WHEEL_xx_TYRE
 * Model space: +X left, +Y up, +Z forward, floor at y = 0 (the rig's axes). `chassis` puts the model's axle midpoint
 * on the vehicle model's.
 */
export interface PortedCarOptions {
  url: string;
  chassis: { wheelbase: number; frontWeightFraction: number; maxRoadWheelDeg: number };
  /** Steering wheel rotation each way at full lock (deg) */
  steerLockDeg: number;
  /**
   * Rig-space cameras to use instead of the GLB's own (e.g. the AMG GT3's for every car on the GT3 model), built from
   * where this model's steering wheel and front axle landed in rig space
   */
  cameraAnchors?: (fit: PortedCameraFit) => Vf26ModelInstance["cameraAnchors"];
}

/** A ported model's driver and nose in rig space, once loaded */
export interface PortedCameraFit {
  /** Centre of the steering wheel's meshes (null: no `STEER` node) */
  steerCentre: THREE.Vector3 | null;
  /** Front axle line (z) */
  frontAxleZ: number;
}

interface PortedExtras {
  wheelCentres?: Record<string, [number, number, number]>;
  tyreRadius?: Record<string, number>;
  tyreHalfWidth?: Record<string, number>;
  cameras?: Partial<Record<string, { pos: [number, number, number]; pitchDeg: number; fov: number }>>;
}

const WHEELS = ["WHEEL_RF", "WHEEL_LF", "WHEEL_RR", "WHEEL_LR"] as const; // physics wheel order 0..3
const SIDE = ["RF", "LF", "RR", "LR"] as const;
const CAMERA_KEYS = ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"] as const;

const templates = new Map<string, Promise<THREE.Group | null>>();

function loadTemplate(url: string): Promise<THREE.Group | null> {
  let template = templates.get(url);
  if (!template) {
    template = (async () => {
      if (typeof window === "undefined") return null;
      const full = withBasePath(url);
      assetProgress.begin("car");
      try {
        const scene = (await createGltfLoader().loadAsync(full, (event) => assetProgress.progress("car", event))).scene;
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map(cleanPortedCarMaterial)
            : cleanPortedCarMaterial(mesh.material);
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const std = m as THREE.MeshStandardMaterial;
            sharpenCarMaps(m);
            if (std.transparent) std.depthWrite = false;
          }
        });
        alignWheelAxles(scene);
        scene.updateMatrixWorld(true);
        assetProgress.done("car");
        return scene;
      } catch (err) {
        console.warn(`Car model ${url} not loaded, using the placeholder body`, err);
        assetProgress.fail("car");
        return null;
      }
    })();
    templates.set(url, template);
  }
  return template;
}

/**
 * Re-bases each wheel so it spins about its own axle. Some exports bake 2-3 degrees of toe or camber into the wheel
 * geometry (SF-26 and W17 fronts, all four BMW M4 GT3 wheels), so spinning about the wheel node's X axis wobbled.
 * The axle is the tyre's least-spread direction; the geometry is turned to put it on X and the node takes the
 * inverse turn, so the wheel looks the same at rest and spins true. Done once on the template.
 */
function alignWheelAxles(scene: THREE.Object3D): void {
  for (const name of WHEELS) {
    const wheel = scene.getObjectByName(name);
    if (!wheel) continue;
    wheel.updateMatrixWorld(true);
    const toWheel = wheel.matrixWorld.clone().invert();
    const meshes: THREE.Mesh[] = [];
    wheel.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh && obj !== wheel) meshes.push(obj as THREE.Mesh);
    });
    const tyre = meshes.find((m) => m.name.endsWith("_TYRE"));
    if (!tyre) continue;
    // Tyre vertices in the wheel's frame
    const local = toWheel.clone().multiply(tyre.matrixWorld);
    const pos = tyre.geometry.getAttribute("position");
    const v = new THREE.Vector3();
    const mean = new THREE.Vector3();
    const pts: THREE.Vector3[] = [];
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(local);
      pts.push(v.clone());
      mean.add(v);
    }
    mean.multiplyScalar(1 / pts.length);
    // Covariance and its smallest eigenvector (power iteration on the shifted matrix)
    const c = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
    for (const p of pts) {
      const x = p.x - mean.x, y = p.y - mean.y, z = p.z - mean.z;
      c[0] += x * x; c[1] += x * y; c[2] += x * z; c[3] += y * y; c[4] += y * z; c[5] += z * z;
    }
    const tr = c[0] + c[3] + c[5];
    const m = new THREE.Matrix3().set(tr - c[0], -c[1], -c[2], -c[1], tr - c[3], -c[4], -c[2], -c[4], tr - c[5]);
    const axle = new THREE.Vector3(1, 0, 0);
    for (let k = 0; k < 64; k++) axle.applyMatrix3(m).normalize();
    if (axle.x < 0) axle.negate();
    const tiltDeg = THREE.MathUtils.radToDeg(axle.angleTo(new THREE.Vector3(1, 0, 0)));
    if (tiltDeg < 0.25) continue;
    const align = new THREE.Quaternion().setFromUnitVectors(axle, new THREE.Vector3(1, 0, 0));
    const R = new THREE.Matrix4().makeRotationFromQuaternion(align);
    for (const mesh of meshes) {
      // bake the mesh's own transform relative to the wheel, then turn it onto the axle
      const meshLocal = toWheel.clone().multiply(mesh.matrixWorld);
      mesh.geometry = mesh.geometry.clone();
      mesh.geometry.applyMatrix4(R.clone().multiply(meshLocal));
      mesh.removeFromParent();
      wheel.add(mesh);
      mesh.position.set(0, 0, 0);
      mesh.quaternion.identity();
      mesh.scale.set(1, 1, 1);
    }
    wheel.quaternion.multiply(align.clone().invert());
    wheel.updateMatrixWorld(true);
  }
}

/** Matrix of `obj` relative to `ancestor` (both inside the same, already updated, hierarchy). */
function relativeMatrix(obj: THREE.Object3D, ancestor: THREE.Object3D): THREE.Matrix4 {
  return new THREE.Matrix4().copy(ancestor.matrixWorld).invert().multiply(obj.matrixWorld);
}

/** A box the size of a car, shown while (or instead of, when the GLB is missing) the model loads */
function placeholderBody(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.8, 4.8),
    new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 })
  );
  mesh.position.y = 0.55;
  mesh.castShadow = true;
  return mesh;
}

/**
 * A ported car's rig: model body (and steering wheel) in `chassisGroup` (sprung), wheels on per-corner steer pivots
 * under `root` (unsprung), aligned so the model's axles sit on the physics axles.
 */
export function createPortedCarRig(options: PortedCarOptions): SimCarRig {
  const root = new THREE.Group();
  root.name = "PORTED_CAR_RIG";
  const chassisGroup = new THREE.Group();
  root.add(chassisGroup);
  const placeholder = placeholderBody();
  chassisGroup.add(placeholder);

  const { chassis } = options;
  const maxRoadWheelRad = chassis.maxRoadWheelDeg * THREE.MathUtils.DEG2RAD;
  const steerLockRad = options.steerLockDeg * THREE.MathUtils.DEG2RAD;
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
  let steerPivot: THREE.Object3D | null = null;
  const steerRest = new THREE.Quaternion();
  let disposed = false;

  void loadTemplate(options.url).then((template) => {
    if (!template || disposed) return;
    const model = template.clone(true);
    model.updateMatrixWorld(true);
    const car = model.getObjectByName("CAR") ?? model;
    const extras = (car.userData ?? {}) as PortedExtras;
    const find = (name: string) => model.getObjectByName(name);

    // Axle midpoint on the physics' (rig origin = CG on the ground), tyres on the ground
    if (!extras.wheelCentres?.WHEEL_LF || !extras.wheelCentres?.WHEEL_LR) {
      console.warn("Ported car model has no wheelCentres: axles placed at nominal positions");
    }
    const lf = extras.wheelCentres?.WHEEL_LF ?? [0.8, 0.35, 1.5];
    const lr = extras.wheelCentres?.WHEEL_LR ?? [0.8, 0.35, -1.5];
    const physicsMidZ = chassis.wheelbase * (0.5 - chassis.frontWeightFraction);
    const offset = new THREE.Vector3(0, (extras.tyreRadius?.LF ?? lf[1]) - lf[1], physicsMidZ - 0.5 * (lf[2] + lr[2]));

    const bodyGroup = new THREE.Group();
    bodyGroup.name = "PORTED_BODY";
    bodyGroup.position.copy(offset);

    // The steering wheel's centre in rig space, read before the nodes move (the model is at its bind pose here)
    const steerSource = find("STEER");
    const steerBox = steerSource ? new THREE.Box3().setFromObject(steerSource, true) : null;
    const steerCentre =
      steerBox && !steerBox.isEmpty()
        ? steerBox.getCenter(new THREE.Vector3()).applyMatrix4(car.matrixWorld.clone().invert()).add(offset)
        : null;
    const cameraFit: PortedCameraFit = { steerCentre, frontAxleZ: lf[2] + offset.z };

    WHEELS.forEach((wheelName, i) => {
      const wheel = find(wheelName);
      if (!wheel) return;
      const wheelBind = relativeMatrix(wheel, car);
      const centre = new THREE.Vector3().setFromMatrixPosition(wheelBind);
      const steer = new THREE.Group();
      steer.name = `PORTED_STEER_${SIDE[i]}`;
      steer.position.copy(centre).add(offset);
      // Rim and tyre spin about the wheel node's X (the axle)
      const spin = new THREE.Group();
      spin.name = `PORTED_SPIN_${SIDE[i]}`;
      for (const child of [...wheel.children]) spin.add(child);
      wheel.add(spin);
      new THREE.Matrix4()
        .makeTranslation(-centre.x, -centre.y, -centre.z)
        .multiply(wheelBind)
        .decompose(wheel.position, wheel.quaternion, wheel.scale);
      steer.add(wheel);
      root.add(steer);

      const tyreMesh = spin.getObjectByName(`${wheelName}_TYRE`) as THREE.Mesh | undefined;
      const tyre = tyreMesh?.isMesh
        ? installTyreDeformation(tyreMesh, {
            unloadedRadiusM: extras.tyreRadius?.[SIDE[i]] ?? 0.34,
            halfWidthM: extras.tyreHalfWidth?.[SIDE[i]] ?? 0.16,
            bakedCamberRad: 0,
          })
        : null;
      corners.push({ steer, spin, isFront: i < 2, isLeft: i % 2 === 1, restY: steer.position.y, tyre });
    });

    const body = find("BODY");
    if (body) bodyGroup.add(body);
    const steerNode = find("STEER");
    if (steerNode) {
      bodyGroup.add(steerNode);
      steerPivot = steerNode;
      steerRest.copy(steerNode.quaternion);
    }
    placeholder.removeFromParent();
    placeholder.geometry.dispose();
    (placeholder.material as THREE.Material).dispose();
    chassisGroup.add(bodyGroup);

    const cams = extras.cameras ?? {};
    const anchors = {} as Vf26ModelInstance["cameraAnchors"];
    for (const key of CAMERA_KEYS) {
      const c = cams[key] ?? { pos: [0, 0.9, 0] as [number, number, number], pitchDeg: -5, fov: 58 };
      anchors[key] = {
        pos: new THREE.Vector3(...c.pos).add(offset),
        pitchRad: c.pitchDeg * THREE.MathUtils.DEG2RAD,
        fovDeg: c.fov,
      };
    }
    // Behind and above the eye point, for the sim's shoulder view
    anchors.shoulder = {
      pos: anchors.cockpit.pos.clone().add(new THREE.Vector3(0, 0.18, -0.3)),
      pitchRad: -8 * THREE.MathUtils.DEG2RAD,
      fovDeg: anchors.cockpit.fovDeg + 3,
    };
    cameraAnchors = options.cameraAnchors?.(cameraFit) ?? anchors;
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
      // About the column (local +Z): a positive angle takes the top of the rim to -X, i.e. right
      steerPivot.quaternion.copy(steerRest);
      steerPivot.rotateZ(t.steering * steerLockRad);
    }
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
    updateFromTelemetry,
    dispose: () => {
      disposed = true;
      for (const c of corners) c.tyre?.dispose();
      root.removeFromParent();
    },
  };
}
