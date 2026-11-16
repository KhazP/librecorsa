/**
 * The note after a drive (`src/lib/support-prompt.ts`): only after a real drive, only for makers who take donations,
 * once per circuit and once per car, at most once a week, never again for a maker the player donated to, and a drive
 * with nothing to say spends nothing. Storage is a Map, the clock a number.
 *
 *   npx tsx scripts/verify-support-prompt.ts
 */
import {
  markShown,
  markThanked,
  MIN_DRIVE_MS,
  promptFor,
  PROMPT_GAP_MS,
  readPromptState,
  SUPPORT_PROMPT_KEY,
  writePromptState,
  type PromptItem,
  type PromptState,
} from "../src/lib/support-prompt";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failed++;
}

const map = new Map<string, string>();
const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
const paypal = { url: "https://paypal.me/x", via: "PayPal" };
const monaco: PromptItem = { key: "circuit:Circuit de Monaco", kind: "circuit", title: "Circuit de Monaco", maker: "Mitja Bonca", role: "Circuit", support: paypal };
const spielberg: PromptItem = { ...monaco, key: "circuit:Red Bull Ring", title: "Red Bull Ring" };
const r33: PromptItem = { key: "car:nissan-r33-jgtc", kind: "car", title: "Nissan Skyline GT-R R33 JGTC", maker: "gregsediting", role: "Model", support: { url: "https://patreon.com/x", via: "Patreon" } };
const DAY = 24 * 3600 * 1000;
const long = MIN_DRIVE_MS + 1000;

let state: PromptState = readPromptState(store);
check("Nothing stored: an empty state", state.lastShownAt === null && state.seen.length === 0 && state.thanked.length === 0);
check("A short drive gets no note", promptFor([monaco, r33], MIN_DRIVE_MS - 1, state, 0) === null);
check("No maker with a link: no note", promptFor([], long, state, 0) === null);
const first = promptFor([monaco, r33], long, state, 1000);
check("A real drive names the circuit and the car", first?.map((i) => i.key).join(",") === "circuit:Circuit de Monaco,car:nissan-r33-jgtc");
state = markShown(state, first!, 1000);
writePromptState(store, state);
state = readPromptState(store);
check("Shown is stored, with what it named", state.lastShownAt === 1000 && state.seen.length === 2, map.get(SUPPORT_PROMPT_KEY) ?? "");
check("Inside the week: no note, whatever is driven", promptFor([spielberg], long, state, 1000 + PROMPT_GAP_MS - 1) === null);
check("After the week: a new circuit is named", promptFor([spielberg], long, state, 1000 + PROMPT_GAP_MS)?.[0]?.key === "circuit:Red Bull Ring");
check("After the week: a seen circuit and car are not named again", promptFor([monaco, r33], long, state, 1000 + 30 * DAY) === null);
state = markThanked(state, "Mitja Bonca");
check("A maker donated to is never named again, any of their circuits", promptFor([spielberg], long, state, 1000 + 30 * DAY) === null);
check("Donating twice keeps one entry", markThanked(state, "Mitja Bonca").thanked.length === 1);
const before = state.lastShownAt;
check("A drive with nothing to say spends nothing", promptFor([monaco], long, state, 1000 + 30 * DAY) === null && state.lastShownAt === before);
map.set(SUPPORT_PROMPT_KEY, "{not json");
check("Broken storage reads as empty", readPromptState(store).seen.length === 0);
map.set(SUPPORT_PROMPT_KEY, JSON.stringify({ lastShownAt: "x", seen: [1, "car:a"], thanked: null }));
const odd = readPromptState(store);
check("Odd values are dropped, good ones kept", odd.lastShownAt === null && odd.seen.join() === "car:a" && odd.thanked.length === 0);

console.log(failed ? `\n${failed} support note check(s) failed.` : "\nAll support note checks passed.");
process.exit(failed ? 1 : 0);
