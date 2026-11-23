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
import { carListed, HOSTED_CONTENT } from "../src/lib/hosted-content";

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

// A copy without the hosted content lists only the repository's own car: carById falls back to it for the others
const hosted = (...ids: string[]) => ids.every((id) => carListed(id));
const liana = carModelSource(carById("liana"));
check(
  "The Liana's source is alekabul's physics, linked to his profile",
  !hosted("liana") || liana.author === "alekabul" && liana.authorUrl === "https://www.overtake.gg/members/alekabul.294399/" && liana.model === undefined
);
const r33 = carModelSource(carById("nissan-r33-jgtc"));
check(
  "gregsediting: Patreon first, his name to his profile, the title to the mod",
  !hosted("nissan-r33-jgtc") || r33.support?.url === "https://www.patreon.com/cw/gregsediting" && r33.authorUrl?.includes("gtplanet.net/forum/members/") === true && r33.url.includes("gtplanet.net/forum/downloads/")
);
check("The BMW's modder has PayPal first", !hosted("bmw-m4-gt3") || carModelSource(carById("bmw-m4-gt3")).support?.via === "PayPal");
check(
  "Pfalzdriver's M1 and Scirocco: his tip page first, his name to his profile, the title to the mod",
  !hosted("bmw-m1-procar", "vw-scirocco-gtx") ||
    (["bmw-m1-procar", "vw-scirocco-gtx"] as const).every((id) => {
      const s = carModelSource(carById(id));
      return s.support?.url === "https://streamlabs.com/pfalzdriver" && s.authorUrl?.includes("gtplanet.net/forum/members/") === true && s.url.includes("gtplanet.net/forum/downloads/");
    })
);
check(
  "Pfalzdriver's 934: his tip page first, his name to his profile, the title to the channel the mod links",
  !hosted("porsche-934-rsr") ||
    ((s) => s.support?.url === "https://streamlabs.com/pfalzdriver" && s.authorUrl?.includes("gtplanet.net/forum/members/") === true && s.url === "https://www.youtube.com/@Pfalzdriver")(
      carModelSource(carById("porsche-934-rsr"))
    )
);
check(
  "NPanic's Chaparrals: the team's PayPal (Pasta's) first, the name to the OverTake profile, the title to the mod, every creator named",
  !hosted("chaparral-2d", "chaparral-2d-67") ||
    (["chaparral-2d", "chaparral-2d-67"] as const).every((id) => {
      const s = carModelSource(carById(id));
      return s.support?.url === "https://www.paypal.com/paypalme/williampasta" && s.authorUrl?.includes("overtake.gg/members/npanic") === true && s.url.includes("overtake.gg/downloads/") &&
        ["Nugget", "Dodge33", "Pasta", "Bazza", "Valentin K", "Felix789"].every((n) => carById(id).credit.note?.includes(n) === true);
    })
);
check("A modder without a support page gets none", !hosted("amg-gt3") || carModelSource(carById("amg-gt3")).support === undefined);
for (const [id, modder] of [["monaco", "Mitja Bonca"], ["norisring", "gunnar333"], ["watkins_glen", "LilSki"], ["vir", "dazzyb2k3"]] as const) {
  const t = TRACKS.find((x) => x.id === id);
  check(`${modder}'s ${id} has their support page first`, !t || trackModelSource(t)?.support?.via === "PayPal");
}
const willow = TRACKS.find((x) => x.id === "willow_springs");
check("Nukedrop's Willow Springs has his Patreon first", !willow || trackModelSource(willow)?.support?.via === "Patreon");
check("The GT3's model source is Vecarz's", !hosted("amg-gt3") || carModelSource(carById("amg-gt3")).author === "Vecarz");
const dunsfold = TRACKS.find((t) => t.id === "dunsfold");
check("Dunsfold's source credits ACU", !dunsfold || trackModelSource(dunsfold)?.author === "ACU");

// Every donation link belongs to a credited name: a spelling that differs from the credits just shows no button.
// Only with the hosted content listed: a copy without it credits only its own car and circuit
const credited = new Set([...TRACKS.flatMap((t) => (t.credit ? [t.credit.author] : [])), ...CARS.flatMap((c) => [c.credit.author, ...(c.tyreCredit ? [c.tyreCredit.author] : [])])]);
const strays = Object.keys(MODDER_SUPPORT).filter((name) => !credited.has(name));
check("Every donation link matches a credited modder", !HOSTED_CONTENT || strays.length === 0, HOSTED_CONTENT ? strays.join(", ") : "skipped without hosted content");
const list = moddersList();
check("The modders list puts those with a link first", list.findIndex((m) => !m.support) === -1 || list.slice(list.findIndex((m) => !m.support)).every((m) => !m.support));
const sagatron = list.find((m) => m.name === "sagatron918");
check(
  "sagatron918 is in the modders list with PayPal support and GT/proto/classic tyre credits",
  !HOSTED_CONTENT || (sagatron?.support?.via === "PayPal" && sagatron.works.length >= 10),
  HOSTED_CONTENT ? `${sagatron?.works.length ?? 0} cars` : "skipped without hosted content"
);

console.log(failed ? `\n${failed} model source check(s) failed.` : "\nAll model source checks passed.");
if (failed) process.exit(1);
