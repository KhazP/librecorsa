/**
 * Verification suite for the ported GT3 cars (`amg-gt3-evo` and `bmw-m4-gt3`).
 *
 * Run with: npx tsx scripts/verify-ported-gt3.ts
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { CARS, carById, carsInClass, isCarId, type CarId } from "../src/lib/cars/car-registry";
import { AMG_GT3_SOUND } from "../src/lib/sim/gt3/AmgGt3Sim";
import { loadGlbGeometry } from "./lib/glb-geometry";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const PORTED_GT3_SPEC: ReadonlyArray<{
  id: CarId;
  title: string;
  expectedWheelbaseM: number;
  creditTitle: string;
  creditAuthor: string;
  creditUrl: string;
}> = [
  {
    id: "amg-gt3-evo",
    title: "Mercedes-AMG GT3 Evo",
    expectedWheelbaseM: 2.63,
    creditTitle: "Mercedes-AMG GT3 Red Bull Racing",
    creditAuthor: "VTX",
    creditUrl: "https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba",
  },
  {
    id: "bmw-m4-gt3",
    title: "BMW M4 GT3 Evo",
    expectedWheelbaseM: 2.92,
    creditTitle: "2025 BMW M4 GT3 EVO G82",
    creditAuthor: "Ddiaz Design",
    creditUrl: "https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5",
  },
];

const CORNERS = ["RF", "LF", "RR", "LR"] as const;
const CAMERA_KEYS = ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"] as const;
const MAX_GLB_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 1. Car registry & UI naming checks
// ---------------------------------------------------------------------------
console.log("\n=== 1. Car Registry & Credits ===");
{
  const gt3Cars = carsInClass("gt3");
  check(
    "GT3 class starts with amg-gt3 followed by amg-gt3-evo and bmw-m4-gt3",
    gt3Cars.length >= 3 &&
      gt3Cars[0].id === "amg-gt3" &&
      gt3Cars[1].id === "amg-gt3-evo" &&
      gt3Cars[2].id === "bmw-m4-gt3",
    gt3Cars.map((c) => c.id).join(", ")
  );

  const credits = readFileSync(resolve(process.cwd(), "CREDITS.md"), "utf8");

  for (const spec of PORTED_GT3_SPEC) {
    check(`${spec.id} is a valid CarId`, isCarId(spec.id));
    const def = carById(spec.id);
    check(`${spec.id} title is "${spec.title}"`, def.title === spec.title, def.title);
    check(
      `${spec.id} UI text contains no team/sponsor "Red Bull"`,
      !/red\s*bull/i.test(`${def.title} ${def.sub} ${def.badge}`)
    );
    check(
      `${spec.id} uses amg-gt3 physics and AMG_GT3_SOUND`,
      def.classId === "gt3" && def.physics === "amg-gt3" && def.sound === AMG_GT3_SOUND
    );
    const expectedUrl = `/cars/${spec.id}/model/${spec.id}.glb`;
    check(`${spec.id} modelUrl is ${expectedUrl}`, def.modelUrl === expectedUrl, def.modelUrl);

    check(
      `CREDITS.md quotes "${spec.creditTitle}" by ${spec.creditAuthor}`,
      credits.includes(`"${spec.creditTitle}"`) &&
        credits.includes(spec.creditAuthor) &&
        credits.includes(spec.creditUrl) &&
        credits.includes("http://creativecommons.org/licenses/by-nc-sa/4.0/")
    );
  }

  for (const c of CARS) {
    check(`Car ${c.id} has no "Red Bull" in UI strings`, !/red\s*bull/i.test(`${c.title} ${c.sub} ${c.badge}`));
  }
}

// ---------------------------------------------------------------------------
// 2. Ported GLB node layout, geometry & extras checks
// ---------------------------------------------------------------------------
for (const spec of PORTED_GT3_SPEC) {
  console.log(`\n=== 2. Ported GLB: ${spec.id} (${spec.title}) ===`);
  const glbPath = resolve(process.cwd(), `public/cars/${spec.id}/model/${spec.id}.glb`);
  check(`${spec.id} GLB exists at public/cars/${spec.id}/model/${spec.id}.glb`, existsSync(glbPath));
  if (!existsSync(glbPath)) continue;

  const sizeBytes = statSync(glbPath).size;
  const sizeMb = sizeBytes / (1024 * 1024);
  check(
    `${spec.id} GLB size <= 15 MiB`,
    sizeBytes <= MAX_GLB_BYTES,
    `${sizeMb.toFixed(2)} MiB (${(sizeBytes / 1e6).toFixed(2)} MB)`
  );

  const scene = loadGlbGeometry(glbPath);
  const car = scene.getObjectByName("CAR");
  check(`${spec.id} has CAR root node`, Boolean(car));
  if (!car) continue;

  const body = car.getObjectByName("BODY");
  const steer = car.getObjectByName("STEER");
  let bodyMeshCount = 0;
  body?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) bodyMeshCount++;
  });
  let steerMeshCount = 0;
  steer?.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) steerMeshCount++;
  });

  check(`${spec.id} has BODY node with meshes`, Boolean(body) && bodyMeshCount > 10, `${bodyMeshCount} meshes`);
  check(`${spec.id} has STEER node with meshes`, Boolean(steer) && steerMeshCount >= 1, `${steerMeshCount} meshes`);

  if (steer) {
    check(
      `${spec.id} STEER pivot is positioned on LHD driver side`,
      steer.position.x > 0.25 && steer.position.x < 0.5 && steer.position.y > 0.6 && steer.position.y < 0.9,
      `pos=(${steer.position.x.toFixed(3)}, ${steer.position.y.toFixed(3)}, ${steer.position.z.toFixed(3)})`
    );
  }

  const extras = car.userData as {
    wheelCentres?: Record<string, [number, number, number]>;
    tyreRadius?: Record<string, number>;
    tyreHalfWidth?: Record<string, number>;
    cameras?: Record<string, { pos: [number, number, number]; pitchDeg: number; fov: number }>;
  };

  check(`${spec.id} CAR.extras has wheelCentres, tyreRadius, tyreHalfWidth, cameras`, Boolean(
    extras.wheelCentres && extras.tyreRadius && extras.tyreHalfWidth && extras.cameras
  ));

  for (const c of CORNERS) {
    const wName = `WHEEL_${c}`;
    const wheelNode = car.getObjectByName(wName);
    const rimNode = car.getObjectByName(`${wName}_RIM`) as THREE.Mesh | undefined;
    const tyreNode = car.getObjectByName(`${wName}_TYRE`) as THREE.Mesh | undefined;
    check(
      `${spec.id} ${wName} has _RIM and _TYRE mesh children`,
      Boolean(wheelNode && rimNode?.isMesh && tyreNode?.isMesh)
    );

    const wc = extras.wheelCentres?.[wName];
    const r = extras.tyreRadius?.[c];
    const hw = extras.tyreHalfWidth?.[c];
    check(
      `${spec.id} ${wName} extras (centre, radius, halfWidth) are valid`,
      Array.isArray(wc) &&
        wc.length === 3 &&
        typeof r === "number" &&
        r > 0.31 &&
        r < 0.38 &&
        typeof hw === "number" &&
        hw > 0.12 &&
        hw < 0.22,
      `c=${JSON.stringify(wc?.map((v) => Number(v.toFixed(3))) )}, r=${r?.toFixed(3)}, hw=${hw?.toFixed(3)}`
    );

    if (wheelNode && wc) {
      const dist = wheelNode.position.distanceTo(new THREE.Vector3(...wc));
      check(`${spec.id} ${wName} node position matches extras.wheelCentres`, dist < 1e-4, `dist=${dist.toFixed(6)}`);
    }

    if (tyreNode?.isMesh && r && hw) {
      tyreNode.geometry.computeBoundingBox();
      const bb = tyreNode.geometry.boundingBox!;
      const center = bb.getCenter(new THREE.Vector3());
      const size = bb.getSize(new THREE.Vector3());
      check(
        `${spec.id} ${wName}_TYRE geometry is centred on hub pivot`,
        center.length() < 0.01 && Math.abs(0.5 * size.y - r) < 0.015 && Math.abs(0.5 * size.x - hw) < 0.01,
        `center=(${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)}), size=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)})`
      );
    }
  }

  const wc = extras.wheelCentres!;
  const lf = wc.WHEEL_LF;
  const rf = wc.WHEEL_RF;
  const lr = wc.WHEEL_LR;
  const rr = wc.WHEEL_RR;
  if (lf && rf && lr && rr) {
    const symFrontX = Math.abs(lf[0] + rf[0]);
    const symRearX = Math.abs(lr[0] + rr[0]);
    const symFrontZ = Math.abs(lf[2] - rf[2]);
    const symRearZ = Math.abs(lr[2] - rr[2]);
    check(
      `${spec.id} wheel centres are left/right symmetric`,
      symFrontX < 0.005 && symRearX < 0.005 && symFrontZ < 0.005 && symRearZ < 0.005 && lf[0] > 0.7 && rf[0] < -0.7,
      `dFx=${symFrontX.toFixed(4)}, dRx=${symRearX.toFixed(4)}, dFz=${symFrontZ.toFixed(4)}, dRz=${symRearZ.toFixed(4)}`
    );

    const wheelbase = lf[2] - lr[2];
    const trackFront = lf[0] - rf[0];
    const trackRear = lr[0] - rr[0];
    check(
      `${spec.id} wheelbase is close to ${spec.expectedWheelbaseM} m`,
      Math.abs(wheelbase - spec.expectedWheelbaseM) < 0.03,
      `wheelbase=${wheelbase.toFixed(4)} m (expected ~${spec.expectedWheelbaseM} m)`
    );
    check(
      `${spec.id} front and rear track widths are in [1.60, 1.80] m`,
      trackFront > 1.6 && trackFront < 1.8 && trackRear > 1.6 && trackRear < 1.8,
      `front=${trackFront.toFixed(4)} m, rear=${trackRear.toFixed(4)} m`
    );
  }

  for (const key of CAMERA_KEYS) {
    const cam = extras.cameras?.[key];
    check(
      `${spec.id} camera "${key}" is present and valid`,
      Boolean(
        cam &&
          Array.isArray(cam.pos) &&
          cam.pos.length === 3 &&
          typeof cam.pitchDeg === "number" &&
          typeof cam.fov === "number" &&
          cam.fov >= 40 &&
          cam.fov <= 80
      ),
      cam ? `pos=${JSON.stringify(cam.pos)}, pitch=${cam.pitchDeg}, fov=${cam.fov}` : "missing"
    );
  }
  check(
    `${spec.id} cockpit camera is on LHD side (+X)`,
    (extras.cameras?.cockpit?.pos?.[0] ?? 0) > 0.25,
    `x=${extras.cameras?.cockpit?.pos?.[0]}`
  );

  // Full car bounding box & floor at y = 0
  const carBox = new THREE.Box3().setFromObject(car);
  const carSize = carBox.getSize(new THREE.Vector3());
  check(
    `${spec.id} floor sits at y = 0`,
    Math.abs(carBox.min.y) < 0.005,
    `min.y=${carBox.min.y.toFixed(5)} m`
  );
  check(
    `${spec.id} overall dimensions are real-world GT3 scale`,
    carSize.x > 1.85 &&
      carSize.x < 2.2 &&
      carSize.y > 1.15 &&
      carSize.y < 1.55 &&
      carSize.z > 4.5 &&
      carSize.z < 5.2,
    `W=${carSize.x.toFixed(3)} m, H=${carSize.y.toFixed(3)} m, L=${carSize.z.toFixed(3)} m`
  );
}

console.log(`\n========================================`);
console.log(`Ported GT3 verification: ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}
