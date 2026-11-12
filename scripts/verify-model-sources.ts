/**
 * The Source chip's data (`src/lib/model-source.ts`): every listed car and circuit says where its 3D model comes from,
 * with a title, an author, a link and a licence or permission, and the converted models name the game they come from.
 *
 *   npx tsx scripts/verify-model-sources.ts
 */
import { CARS, carById } from "../src/lib/cars/car-registry";
import { carModelSource, trackModelSource } from "../src/lib/model-source";
import { TRACKS } from "../src/lib/track-registry";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
}

const complete = (s: { title: string; author: string; url: string; license: string } | null) =>
  !!s && [s.title, s.author, s.license].every((v) => v.trim().length > 0) && /^https?:\/\//.test(s.url);

for (const car of CARS) {
  const s = carModelSource(car);
  check(`${car.id}: model source is complete`, complete(s), `"${s.title}" by ${s.author} · ${s.license}`);
}
for (const t of TRACKS) {
  const s = trackModelSource(t);
  check(`${t.id}: model source is complete`, complete(s), s ? `"${s.title}" by ${s.author} · ${s.license}` : "none");
}

const liana = carModelSource(carById("liana"));
check("The Liana's model source is Forza Motorsport 4's, not its modder", /Forza Motorsport 4/.test(liana.author) && carById("liana").credit.author === "alekabul");
check("The GT3's model source is Vecarz's", carModelSource(carById("amg-gt3")).author === "Vecarz");
const dunsfold = TRACKS.find((t) => t.id === "dunsfold");
check("Dunsfold's source says it is a Forza Motorsport 4 conversion", !dunsfold || /Forza Motorsport 4/.test(trackModelSource(dunsfold)?.note ?? ""));

console.log(failed ? `\n${failed} model source check(s) failed.` : "\nAll model source checks passed.");
if (failed) process.exit(1);
