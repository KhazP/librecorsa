/**
 * The car and track request form's link rules (`src/components/menu/RequestPanel.tsx`): a Sketchfab model's id is
 * read from its full link (a short skfb.ly link can't be followed from the browser), tags marking a model as ripped or
 * taken from Assetto Corsa are caught, OverTake mod pages are recognised, and the issue says which modders question
 * was answered.
 *
 *   npx tsx scripts/verify-request-form.ts
 */
import { feedbackIssueUrl, isOvertake, isRippedTag, sketchfabModelId, type FeedbackForm } from "../src/components/menu/RequestPanel";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failed++;
}

const ID = "0b1085d93dfa4e81aab2c83c26bf185b";
check("Model page link gives its id", sketchfabModelId(`https://sketchfab.com/3d-models/suzuka-circuit-2001-layout-${ID}`) === ID);
check("Old /models/ and embed links give their id", sketchfabModelId(`https://sketchfab.com/models/${ID}/embed?autostart=1`) === ID);
check("A link with a query or hash still gives its id", sketchfabModelId(`https://www.sketchfab.com/3d-models/x-${ID}?utm=1`) === ID);
check("A short skfb.ly link gives none", sketchfabModelId("https://skfb.ly/pLorW") === null);
check("A profile or another site gives none", sketchfabModelId("https://sketchfab.com/Tyler_Dave") === null && sketchfabModelId(`https://example.com/${ID}`) === null);

// Tags from Dave Love SketchFab's circuits, and from Vecarz's Mercedes-AMG GT3
const rippedTags = ["Ripped", "ripped-model", "asseto-corsa", "asseto-corsa-3d-model", "assetto-corsa", "assettocorsa", "Assetto Corsa", "rip"];
const cleanTags = ["me", "MERCEDES", "amg", "GT3", "mercedes-amg", "racetrack", "stripped-down", "trip", "corsa", "racetracks"];
check("Ripped and Assetto Corsa tags are caught", rippedTags.every(isRippedTag), rippedTags.filter((t) => !isRippedTag(t)).join(", "));
check("Other tags are not", !cleanTags.some(isRippedTag), cleanTags.filter(isRippedTag).join(", "));

check("OverTake and RaceDepartment mod pages are OverTake", isOvertake("https://www.overtake.gg/downloads/automotodrom-grobnik.4835/") && isOvertake("https://www.racedepartment.com/downloads/spielberg.6437/"));
check("Other sites are not", !isOvertake("https://sketchfab.com/3d-models/x") && !isOvertake("https://notovertake.gg.example.com/"));

const form = (second: string, extra: Partial<FeedbackForm> = {}): FeedbackForm => ({
  kind: "Track",
  main: "Grobnik",
  second,
  third: "",
  license: "",
  permission: "The creator gave written permission",
  askedModders: false,
  modderSaidYes: false,
  notes: "",
  ...extra,
});
const modders = (f: FeedbackForm) => new URL(feedbackIssueUrl(f, undefined, null)).searchParams.get("modders");
check("An OverTake request says the modder said yes", modders(form("https://www.overtake.gg/downloads/x.1/", { modderSaidYes: true })) === "Yes, the modder said yes");
check("A Sketchfab request says the sim modders said no", modders(form(`https://sketchfab.com/3d-models/x-${ID}`, { askedModders: true })) === "Yes, they said no");
check("Another link says neither", modders(form("https://example.com/model", { askedModders: true, modderSaidYes: true })) === null);

console.log(failed ? `\n${failed} request form check(s) failed.` : "\nAll request form checks passed.");
if (failed) process.exit(1);
