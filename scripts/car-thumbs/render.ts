/**
 * Browser half of `npm run car-thumbs` (scripts/render-car-thumbs.ts bundles and serves it). Builds one car exactly as
 * the drive session does (drive-session.ts `createCarRig`: a ported car's GLB, the GT3 rig, or the 2026 prototype),
 * lights it in a neutral studio, frames a front three-quarter view and leaves the picture in `window.__thumb`.
 *
 *   /__thumbs/?car=<CarId>
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { carById, type CarId } from "@/lib/cars/car-registry";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import { createF1Car2026, type SimCarRig } from "@/lib/car-builder-2026";
import { createGt3CarRig, gt3RigCameraAnchors } from "@/lib/gt3-car-model";
import { createPortedCarRig } from "@/lib/ported-car-model";
import { staticFloorOf } from "@/lib/render/body-floor";
import { LIVERIES } from "@/lib/track-data";

declare global {
  interface Window {
    __thumb?: string;
    __thumbError?: string;
  }
}

const WIDTH = 960;
const HEIGHT = 540;
/** How long a model may take to load before the car is given up on */
const LOAD_TIMEOUT_MS = 90_000;

function buildRig(id: CarId): SimCarRig {
  const def = carById(id);
  const model = vehicleModelSpec(def.physics);
  const livery = LIVERIES[0];
  const rig = def.modelUrl
    ? createPortedCarRig({
        url: def.modelUrl,
        chassis: model.rigConfig.chassis,
        steerLockDeg: 15,
        floor: staticFloorOf(model.rigConfig),
        cameraAnchors: model.gt3Cockpit ? gt3RigCameraAnchors : undefined,
        pirelliSidewall: def.classId === "f1" && def.year >= 2018,
      })
    : model.gt3Cockpit
      ? createGt3CarRig()
      : createF1Car2026(livery, "soft");
  rig.setLivery(livery);
  rig.setTireCompound("soft");
  return rig;
}

/** The car's model has replaced its placeholder: the 2026 body, or a loaded GLB (which brings its camera anchors) */
const loaded = (rig: SimCarRig) => Boolean(rig.getLc26Body() || rig.getCameraAnchors());

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get("car") as CarId | null;
  if (!id) throw new Error("no ?car=");

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-4, 7, 5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xcfe8ff, 1.1);
  rim.position.set(5, 3, -6);
  scene.add(rim);

  const rig = buildRig(id);
  scene.add(rig.root);

  const started = performance.now();
  while (!loaded(rig)) {
    if (performance.now() - started > LOAD_TIMEOUT_MS) throw new Error(`${id}: model did not load`);
    await new Promise((r) => setTimeout(r, 200));
  }
  // Textures decode after the model lands: give them a moment, rendering so uploads happen
  for (let i = 0; i < 90; i++) {
    renderer.render(scene, new THREE.PerspectiveCamera());
    await new Promise((r) => requestAnimationFrame(r));
  }

  // Frame the car from its front three-quarter: the nose points toward +Z on every rig (the sharp trim crops the margin)
  rig.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(rig.root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) * 0.5;
  const camera = new THREE.PerspectiveCamera(28, WIDTH / HEIGHT, 0.05, 200);
  const view = new THREE.Vector3(-0.66, 0.32, 0.68).normalize();
  const fit = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * 0.8;
  camera.position.copy(centre).addScaledVector(view, fit);
  camera.lookAt(centre.x, centre.y - size.y * 0.08, centre.z);
  renderer.render(scene, camera);
  window.__thumb = renderer.domElement.toDataURL("image/png");
}

main().catch((err: unknown) => {
  window.__thumbError = err instanceof Error ? err.message : String(err);
});
