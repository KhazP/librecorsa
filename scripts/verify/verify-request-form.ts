/**
 * The car and track request form's link, creator, permission, and low-effort rules
 * (`src/components/menu/RequestPanel.tsx`, `src/lib/feedback/request-rules.ts`):
 *   - Sketchfab ids, ripped/AC tags, and OverTake detection;
 *   - piracy / reupload sites, direct file hosts, commercial 3D storefronts, and commercial-game creators blocked;
 *   - license + permission + proof combinations enforced (blocking blank license + "The license allows it" and
 *     CC0 + "Not asked yet");
 *   - low-effort bug descriptions/steps rejected and Ideas routed to GitHub Discussions.
 *
 *   npx tsx scripts/verify/verify-request-form.ts
 */
import { feedbackIssueUrl, isOvertake, isRippedTag, sketchfabModelId, type FeedbackForm } from "../../src/components/menu/RequestPanel";
import {
  blockedCreatorMatch,
  classifyModelLink,
  evaluateContentPermission,
  isLowEffortText,
  REQUEST_LIMITS,
} from "../../src/lib/feedback/request-rules";

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

// Tags from ripped / Assetto Corsa models
const rippedTags = ["Ripped", "ripped-model", "asseto-corsa", "asseto-corsa-3d-model", "assetto-corsa", "assettocorsa", "Assetto Corsa", "rip"];
const cleanTags = ["me", "MERCEDES", "amg", "GT3", "mercedes-amg", "racetrack", "stripped-down", "trip", "corsa", "racetracks"];
check("Ripped and Assetto Corsa tags are caught", rippedTags.every(isRippedTag), rippedTags.filter((t) => !isRippedTag(t)).join(", "));
check("Other tags are not", !cleanTags.some(isRippedTag), cleanTags.filter(isRippedTag).join(", "));

check("OverTake and RaceDepartment mod pages are OverTake", isOvertake("https://www.overtake.gg/downloads/automotodrom-grobnik.4835/") && isOvertake("https://www.racedepartment.com/downloads/spielberg.6437/"));
check("Other sites are not", !isOvertake("https://sketchfab.com/3d-models/x") && !isOvertake("https://notovertake.gg.example.com/"));

// Piracy / reupload, direct file host, and commercial store blocking
const piracyUrls = [
  "https://www.assettoworld.com/track/bathurst-mount-panorama",
  "https://assettolab.ru/car/genesis-gmr-001-lmh-2/",
  "https://assettocorsa.club/mods/tracks/marina-bay-street-circuit.html",
  "https://sub.modland.net/assetto-corsa-mods/cars/foo",
  "https://kemono.su/patreon/user/123",
];
check("Piracy and reupload domains are blocked", piracyUrls.every((u) => classifyModelLink(u).kind === "piracy"));
check("Direct file hosts are blocked", ["https://mega.nz/file/abc", "https://drive.google.com/file/d/123", "https://sharemods.com/xyz/car.zip.html"].every((u) => classifyModelLink(u).kind === "file-host"));
check("Commercial 3D stores are blocked", ["https://www.turbosquid.com/3d-models/car-1", "https://www.cgtrader.com/3d-models/car/racing/gt3"].every((u) => classifyModelLink(u).kind === "commercial-store"));
check("Original creator pages pass link classification", ["https://www.overtake.gg/downloads/x.1/", `https://sketchfab.com/3d-models/x-${ID}`, "https://github.com/author/track"].every((u) => classifyModelLink(u).kind === "ok"));

// Blocked commercial game / placeholder creators
check("Commercial games and placeholders blocked as creator", ["ACC", "Assetto Corsa", "iRacing", "Forza Motorsport", "GT7", "idk", "unknown", "N/A"].every((c) => blockedCreatorMatch(c) !== null));
check("Real modder names allowed as creator", ["Pfalzdriver", "Fat-Alfie", "Vencialo", "LilSki"].every((c) => blockedCreatorMatch(c) === null));

// Permission & license matrix (regressions from #243 and #256)
check("Blank license + 'The license allows it' is blocked (#256)", !evaluateContentPermission("", "The license allows it", "").ok);
check("Other license + 'The license allows it' is blocked", !evaluateContentPermission("Other license", "The license allows it", "").ok);
check("CC0 + 'Not asked yet' is blocked (#243)", !evaluateContentPermission("CC0 / public domain", "Not asked yet", "").ok);
check("CC BY + 'Don't know' is blocked", !evaluateContentPermission("CC BY / CC BY-SA", "Don't know", "").ok);
check("CC BY + 'The license allows it' is allowed", evaluateContentPermission("CC BY / CC BY-SA", "The license allows it", "").ok);
check("Written permission without proof note is blocked", !evaluateContentPermission("Other license", "The creator gave written permission", "").ok);
check("Written permission with proof link/note is allowed", evaluateContentPermission("Other license", "The creator gave written permission", "Modder agreed on OverTake: https://overtake.gg/threads/123").ok);

// Low-effort bug text checks
check("Short or filler bug steps are rejected", ["i dont knwo", "idk", "Afd hands", "none", "aaaaaaaaaaaaaaa"].every((s) => isLowEffortText(s, REQUEST_LIMITS.bugStepsMin)));
check("Steps copied verbatim from description are rejected (#226)", isLowEffortText("All lap times are missing from all tracks", REQUEST_LIMITS.bugStepsMin, "All lap times are missing from all tracks"));
check("Concrete reproduction steps pass", !isLowEffortText("Load Chang GP in the LC25 and drive straight into the pit lane at 60 km/h", REQUEST_LIMITS.bugStepsMin, "Car falls through the pit floor"));

// URL generation
const form = (second: string, extra: Partial<FeedbackForm> = {}): FeedbackForm => ({
  kind: "Track",
  main: "Grobnik",
  second,
  third: "ModderName",
  license: "CC BY / CC BY-SA",
  permission: "The license allows it",
  askedModders: false,
  modderSaidYes: false,
  notes: "",
  ...extra,
});
const modders = (f: FeedbackForm) => new URL(feedbackIssueUrl(f, undefined, null)).searchParams.get("modders");
check("An OverTake request says the modder said yes", modders(form("https://www.overtake.gg/downloads/x.1/", { modderSaidYes: true })) === "Yes, the modder said yes");
check("A Sketchfab request says the sim modders said no", modders(form(`https://sketchfab.com/3d-models/x-${ID}`, { askedModders: true })) === "Yes, they said no");
check("Another link says neither", modders(form("https://example.com/model", { askedModders: true, modderSaidYes: true })) === null);

const ideaUrl = new URL(
  feedbackIssueUrl(
    { kind: "Idea", main: "Allow custom camera shake in open wheelers", second: "Increases cockpit immersion", third: "Camera", license: "", permission: "", askedModders: false, modderSaidYes: false, notes: "" },
    undefined,
    null
  )
);
check("Ideas route to GitHub Discussions (category=ideas)", ideaUrl.pathname.endsWith("/discussions/new") && ideaUrl.searchParams.get("category") === "ideas" && (ideaUrl.searchParams.get("body") ?? "").includes("Increases cockpit immersion"));

console.log(failed ? `\n${failed} request form check(s) failed.` : "\nAll request form checks passed.");
if (failed) process.exit(1);
