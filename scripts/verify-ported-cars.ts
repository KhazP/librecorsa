/**
 * Ported F1 cars (`public/cars/<id>/model/<id>.glb`, `src/lib/cars/car-registry.ts`, `src/lib/ported-car-model.ts`):
 * checks registry entries, UI naming rules, CREDITS.md attribution, GLB byte budgets, node hierarchy,
 * single-primitive tyre meshes, wheel symmetry, floor level, and camera extras for all seven ported F1 cars.
 *
 *   npx tsx scripts/verify-ported-cars.ts
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { carById, CARS, isCarId, type CarId } from "../src/lib/cars/car-registry";
import { carPhysics, carTakesPhysicsSwitch } from "../src/lib/cars/f1-mod-physics";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ""}`);
}

interface ExpectedCar {
  id: CarId;
  title: string;
  sketchfabTitle: string;
  url: string;
  minWb: number;
  maxWb: number;
}

const EXPECTED_CARS: readonly ExpectedCar[] = [
  {
    id: "sf26",
    title: "SF-26",
    sketchfabTitle: "2026 Ferrari SF-26",
    url: "https://sketchfab.com/3d-models/2026-ferrari-sf-26-e5ca6cecdc42449283f4bed27360f2a7",
    minWb: 3.35,
    maxWb: 3.6,
  },
  {
    id: "w17",
    title: "W17",
    sketchfabTitle: "2026 Mercedes W17",
    url: "https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b",
    minWb: 3.35,
    maxWb: 3.5,
  },
  {
    id: "rb22",
    title: "RB22",
    sketchfabTitle: "2026 Redbull RB22",
    url: "https://sketchfab.com/3d-models/2026-redbull-rb22-0a3d24a58e0549d591a5a48c22eec383",
    minWb: 3.35,
    maxWb: 3.5,
  },
  {
    id: "sf71h",
    title: "SF71H",
    sketchfabTitle: "2018 Ferrari SF71H",
    url: "https://sketchfab.com/3d-models/2018-ferrari-sf71h-e54b896bd21f478f8309eecf3726700e",
    minWb: 3.55,
    maxWb: 3.75,
  },
  {
    id: "rb8",
    title: "RB8",
    sketchfabTitle: "2012 Red Bull RB8",
    url: "https://sketchfab.com/3d-models/2012-red-bull-rb8-b74446dcd93a49879546d756e3093b3f",
    minWb: 3.35,
    maxWb: 3.55,
  },
  {
    id: "r25",
    title: "R25",
    sketchfabTitle: "2005 Renault R25",
    url: "https://sketchfab.com/3d-models/2005-renault-r25-0d58fe125f5b41a2b8482576723120c4",
    minWb: 3.0,
    maxWb: 3.2,
  },
  {
    id: "f2004",
    title: "F2004",
    sketchfabTitle: "2004 Ferrari F2004",
    url: "https://sketchfab.com/3d-models/2004-ferrari-f2004-bedade52e6f4415e90e656817c5701f8",
    minWb: 3.0,
    maxWb: 3.15,
  },
];

const FORBIDDEN_TEAM_RE = /ferrari|mercedes|red\s*bull|renault/i;
const CORNERS = ["RF", "LF", "RR", "LR"] as const;
const CAMERA_KEYS = ["cockpit", "tcam", "dash", "bumper", "nearChase", "farChase"] as const;

interface GlbJson {
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    mesh?: number;
    translation?: [number, number, number];
    children?: number[];
    extras?: Record<string, unknown>;
  }[];
  meshes?: {
    name?: string;
    primitives: {
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
    }[];
  }[];
  accessors?: {
    count: number;
    min?: number[];
    max?: number[];
  }[];
}

function readGlbJson(path: string): { json: GlbJson; sizeBytes: number } {
  const buf = readFileSync(path);
  const magic = buf.toString("ascii", 0, 4);
  const version = buf.readUInt32LE(4);
  const total = buf.readUInt32LE(8);
  check(`${path}: valid GLB header`, magic === "glTF" && version === 2 && total === buf.length);
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.toString("ascii", 16, 20);
  check(`${path}: first chunk is JSON`, jsonType === "JSON" && jsonLen > 0);
  const jsonStr = buf.toString("utf8", 20, 20 + jsonLen);
  return { json: JSON.parse(jsonStr) as GlbJson, sizeBytes: statSync(path).size };
}

console.log("Registry & CREDITS.md checks");
const creditsMd = readFileSync("CREDITS.md", "utf8");
check("CREDITS.md credits Dave Love SketchFab under CC BY 4.0", creditsMd.includes("Dave Love SketchFab") && creditsMd.includes("http://creativecommons.org/licenses/by/4.0/"));

const f1Cars = CARS.filter((c) => c.classId === "f1-2026");
for (const native of ["vf26", "f12026-car", "amg-gt3", "amg-gt3-evo", "bmw-m4-gt3"] as const) {
  check(
    `${native}: physics switch leaves it on its own model`,
    !carTakesPhysicsSwitch(native) && carPhysics(native, "vf26") === carById(native).physics && carPhysics(native, "f12026-car") === carById(native).physics
  );
}
check("f1-2026 class has 2 native + 7 ported cars", f1Cars.length === 9, `${f1Cars.length} cars`);

for (const exp of EXPECTED_CARS) {
  check(`${exp.id}: isCarId`, isCarId(exp.id));
  const def = carById(exp.id);
  check(`${exp.id}: registered with f12026-car physics and modelUrl`, def.id === exp.id && def.classId === "f1-2026" && def.physics === "f12026-car" && def.modelUrl === `/cars/${exp.id}/model/${exp.id}.glb`);
  check(
    `${exp.id}: physics switch picks rigid-body by default and FA-26 on request`,
    carTakesPhysicsSwitch(exp.id) && carPhysics(exp.id) === "f12026-car" && carPhysics(exp.id, "vf26") === "vf26"
  );
  check(`${exp.id}: exact model title "${exp.title}"`, def.title === exp.title, def.title);
  check(
    `${exp.id}: no team names in UI text (title/sub/badge)`,
    !FORBIDDEN_TEAM_RE.test(def.title) && !FORBIDDEN_TEAM_RE.test(def.sub) && !FORBIDDEN_TEAM_RE.test(def.badge),
    `${def.title} | ${def.sub} | ${def.badge}`,
  );
  check(
    `${exp.id}: CREDITS.md quotes exact Sketchfab title and URL`,
    creditsMd.includes(`"${exp.sketchfabTitle}"`) && creditsMd.includes(exp.url),
  );
}

console.log("\nPorted GLB hierarchy, extras & geometry checks");
for (const exp of EXPECTED_CARS) {
  const relPath = join("public", "cars", exp.id, "model", `${exp.id}.glb`);
  check(`${exp.id}: GLB exists at ${relPath}`, existsSync(relPath));
  const { json, sizeBytes } = readGlbJson(relPath);
  const mb = sizeBytes / (1024 * 1024);
  check(`${exp.id}: GLB size <= 15 MB`, mb <= 15.0, `${mb.toFixed(2)} MB`);

  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];
  const accessors = json.accessors ?? [];
  const byName = new Map(nodes.map((n, idx) => [n.name ?? "", { node: n, idx }]));

  const carEntry = byName.get("CAR");
  check(`${exp.id}: root CAR node exists`, !!carEntry && (json.scenes?.[0]?.nodes ?? []).includes(carEntry.idx));
  const carChildren = new Set(carEntry!.node.children ?? []);

  const bodyEntry = byName.get("BODY");
  check(
    `${exp.id}: BODY node is a child of CAR with mesh children`,
    !!bodyEntry && carChildren.has(bodyEntry.idx) && (bodyEntry.node.children?.length ?? 0) >= 5,
    `${bodyEntry?.node.children?.length ?? 0} meshes`,
  );

  const steerEntry = byName.get("STEER");
  check(
    `${exp.id}: STEER pivot is a child of CAR with centered X translation and mesh children`,
    !!steerEntry &&
      carChildren.has(steerEntry.idx) &&
      (steerEntry.node.children?.length ?? 0) >= 1 &&
      Math.abs(steerEntry.node.translation?.[0] ?? 99) < 1e-3 &&
      (steerEntry.node.translation?.[1] ?? 0) > 0.45 &&
      (steerEntry.node.translation?.[2] ?? 0) > 0.25,
    `translation=${JSON.stringify(steerEntry?.node.translation)}`,
  );

  const extras = (carEntry!.node.extras ?? {}) as {
    wheelCentres?: Record<string, [number, number, number]>;
    tyreRadius?: Record<string, number>;
    tyreHalfWidth?: Record<string, number>;
    wheelbaseM?: number;
    cameras?: Record<string, { pos?: [number, number, number]; pitchDeg?: number; fov?: number }>;
  };

  const wc = extras.wheelCentres ?? {};
  const tr = extras.tyreRadius ?? {};
  const thw = extras.tyreHalfWidth ?? {};
  const cams = extras.cameras ?? {};

  for (const c of CORNERS) {
    const wName = `WHEEL_${c}`;
    const wEntry = byName.get(wName);
    const rimEntry = byName.get(`${wName}_RIM`);
    const tyreEntry = byName.get(`${wName}_TYRE`);
    check(
      `${exp.id}: ${wName} hub has _RIM and _TYRE children`,
      !!wEntry &&
        carChildren.has(wEntry.idx) &&
        !!rimEntry &&
        !!tyreEntry &&
        (wEntry.node.children ?? []).includes(rimEntry.idx) &&
        (wEntry.node.children ?? []).includes(tyreEntry.idx),
    );

    const tyreMesh = meshes[tyreEntry!.node.mesh ?? -1];
    const rimMesh = meshes[rimEntry!.node.mesh ?? -1];
    check(
      `${exp.id}: ${wName}_TYRE is a single-primitive mesh (required for installTyreDeformation)`,
      !!tyreMesh && tyreMesh.primitives.length === 1 && !!rimMesh && rimMesh.primitives.length >= 1,
    );

    const posAcc = accessors[tyreMesh.primitives[0].attributes.POSITION];
    const r = tr[c] ?? 0;
    const hw = thw[c] ?? 0;
    const centre = wc[wName];
    check(
      `${exp.id}: ${wName} extras & floor contact (y = 0)`,
      Array.isArray(centre) &&
        centre.length === 3 &&
        r > 0.31 &&
        r < 0.37 &&
        hw > 0.14 &&
        hw < 0.25 &&
        Math.abs(centre[1] - r) < 1e-4 &&
        !!posAcc?.min &&
        Math.abs(centre[1] + posAcc.min[1]) < 1e-3,
      `centre=${JSON.stringify(centre)} r=${r.toFixed(4)} hw=${hw.toFixed(4)}`,
    );
  }

  // Symmetry & wheelbase checks
  const rf = wc.WHEEL_RF;
  const lf = wc.WHEEL_LF;
  const rr = wc.WHEEL_RR;
  const lr = wc.WHEEL_LR;
  const wb = lf[2] - lr[2];
  check(
    `${exp.id}: X symmetry and +Z forward orientation`,
    rf[0] < -0.65 &&
      lf[0] > 0.65 &&
      Math.abs(rf[0] + lf[0]) < 1e-4 &&
      Math.abs(rr[0] + lr[0]) < 1e-4 &&
      Math.abs(rf[2] - lf[2]) < 1e-4 &&
      Math.abs(rr[2] - lr[2]) < 1e-4 &&
      lf[2] > 1.0 &&
      lr[2] < -1.0,
    `trackF=${(lf[0] - rf[0]).toFixed(3)}m trackR=${(lr[0] - rr[0]).toFixed(3)}m`,
  );
  check(
    `${exp.id}: wheelbase in expected range [${exp.minWb}, ${exp.maxWb}] m`,
    wb >= exp.minWb && wb <= exp.maxWb && Math.abs(wb - (extras.wheelbaseM ?? 0)) < 1e-3,
    `wb=${wb.toFixed(3)}m`,
  );

  // Camera extras check
  const allCamsOk = CAMERA_KEYS.every((k) => {
    const cam = cams[k];
    return (
      !!cam &&
      Array.isArray(cam.pos) &&
      cam.pos.length === 3 &&
      cam.pos.every((v) => typeof v === "number" && Number.isFinite(v)) &&
      typeof cam.pitchDeg === "number" &&
      typeof cam.fov === "number"
    );
  });
  check(`${exp.id}: all 6 camera presets populated`, allCamsOk);
}

console.log(`\nPorted F1 cars: all ${passed} checks passed.`);
