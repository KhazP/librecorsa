/**
 * The Source chip's data (`src/lib/model-source.ts`): every listed car and circuit says where its 3D model comes from,
 * with a title, an author, a link and a licence or permission, and the converted models name the game they come from.
 *
 *   npx tsx scripts/verify-model-sources.ts
 */
import { CARS, carById } from "../src/lib/cars/car-registry";
import { carModelSource, trackModelSource } from "../src/lib/model-source";
import { TRACKS } from "../src/lib/track-registry";
import { MODDER_SUPPORT } from "../src/lib/modder-support";
import { moddersList } from "../src/lib/modders";

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
check(
  "The Liana's source is alekabul's physics, linked to his profile",
  liana.author === "alekabul" && liana.authorUrl === "https://www.overtake.gg/members/alekabul.294399/" && liana.model === undefined
);
const r33 = carModelSource(carById("nissan-r33-jgtc"));
check(
  "gregsediting: Patreon first, his name to his profile, the title to the mod",
  r33.support?.url === "https://www.patreon.com/cw/gregsediting" && r33.authorUrl?.includes("gtplanet.net/forum/members/") === true && r33.url.includes("gtplanet.net/forum/downloads/")
);
check("The BMW's modder has PayPal first", carModelSource(carById("bmw-m4-gt3")).support?.via === "PayPal");
check("A modder without a support page gets none", carModelSource(carById("amg-gt3")).support === undefined);
for (const [id, modder] of [["monaco", "Mitja Bonca"], ["norisring", "gunnar333"], ["watkins_glen", "LilSki"]] as const) {
  const t = TRACKS.find((x) => x.id === id);
  check(`${modder}'s ${id} has their support page first`, !t || trackModelSource(t)?.support?.via === "PayPal");
}
check("The GT3's model source is Vecarz's", carModelSource(carById("amg-gt3")).author === "Vecarz");
const dunsfold = TRACKS.find((t) => t.id === "dunsfold");
check("Dunsfold's source says it is a Forza Motorsport 4 conversion", !dunsfold || /Forza Motorsport 4/.test(trackModelSource(dunsfold)?.note ?? ""));

// Every donation link belongs to a credited name: a spelling that differs from the credits just shows no button
const credited = new Set([...TRACKS.flatMap((t) => (t.credit ? [t.credit.author] : [])), ...CARS.flatMap((c) => [c.credit.author, ...(c.tyreCredit ? [c.tyreCredit.author] : [])])]);
const strays = Object.keys(MODDER_SUPPORT).filter((name) => !credited.has(name));
check("Every donation link matches a credited modder", strays.length === 0, strays.join(", "));
const list = moddersList();
check("The modders list puts those with a link first", list.findIndex((m) => !m.support) === -1 || list.slice(list.findIndex((m) => !m.support)).every((m) => !m.support));

console.log(failed ? `\n${failed} model source check(s) failed.` : "\nAll model source checks passed.");
if (failed) process.exit(1);
