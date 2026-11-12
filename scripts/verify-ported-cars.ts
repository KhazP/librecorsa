/**
 * The car registry's rules (`src/lib/cars/car-registry.ts`, `src/lib/cars/f1-mod-physics.ts`): the cars with their own
 * vehicle model stay on it whatever the F1 physics switch says, no car takes the switch while there is no ported F1
 * car, each class's year groups hold its cars once, and no class is named after a car. The ported GT3s' GLBs are
 * checked by `scripts/verify-ported-gt3.ts`.
 *
 *   npx tsx scripts/verify-ported-cars.ts
 */
import { CAR_CLASSES, carById, CARS, carsByYear, carsInClass } from "../src/lib/cars/car-registry";
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

console.log("Registry checks");
for (const native of ["vf26", "amg-gt3", "amg-gt3-evo", "bmw-m4-gt3", "mtr-496r"] as const) {
  check(
    `${native}: physics switch leaves it on its own model`,
    !carTakesPhysicsSwitch(native) && carPhysics(native, "vf26") === carById(native).physics && carPhysics(native, "f12026-car") === carById(native).physics
  );
}
const switched = CARS.filter((c) => carTakesPhysicsSwitch(c.id)).map((c) => c.id);
check("No car takes the F1 physics switch (no ported F1 car is listed)", switched.length === 0, switched.join(", "));

const f1Cars = carsInClass("f1").map((c) => c.id);
check("F1 class has the 2026 Prototype only", f1Cars.join(",") === "vf26", f1Cars.join(", "));

// The menus group each class by year, newest first; no heading may be a single car's name
check(
  "Year groups hold every car of their class once, newest first",
  CAR_CLASSES.every((k) => {
    const groups = carsByYear(k.id);
    const grouped = groups.flatMap((g) => g.cars.map((c) => c.id));
    const own = carsInClass(k.id).map((c) => c.id);
    const newestFirst = groups.every((g, i) => i === 0 || groups[i - 1].year > g.year);
    return newestFirst && grouped.length === own.length && own.every((id) => grouped.includes(id));
  })
);
check(
  "No class is named after a car",
  CAR_CLASSES.every((k) => {
    const name = k.title.toLowerCase();
    return !name.includes("liana") && !CARS.some((c) => c.title.toLowerCase() === name || c.badge.toLowerCase() === name);
  }),
  CAR_CLASSES.map((k) => k.title).join(", ")
);

console.log(`\nCar registry: all ${passed} checks passed.`);
