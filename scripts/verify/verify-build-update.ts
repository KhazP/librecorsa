/**
 * The open game's update check (src/lib/build-update.ts) and the file it reads (src/app/build.json/route.ts): which
 * answers count as a newer build, when the game may reload by itself (only where nothing is lost, once per build),
 * and that the check asks the server past every cache and not too often.
 *
 *   npx tsx scripts/verify/verify-build-update.ts
 */
import { PROTOCOL_VERSION } from "../../src/lib/net/state-codec";
import {
  autoReloadNow,
  checkForUpdate,
  compareBuild,
  parseBuildInfo,
  STALE_PAGE_MS,
  UPDATE_MIN_GAP_MS,
  updateStore,
  type AutoReloadInput,
} from "../../src/lib/build-update";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failed++;
}

async function main() {
  // --- /build.json ---
  process.env.NEXT_PUBLIC_BUILD = "c31ac202e4890100241b86616a25e163b8a02328";
  const { GET } = await import("../../src/app/build.json/route");
  const served = await GET().json();
  check("/build.json carries the build's first seven digits", served.build === "c31ac20", JSON.stringify(served));
  check("/build.json carries the online protocol", served.protocol === PROTOCOL_VERSION);
  delete process.env.NEXT_PUBLIC_BUILD;
  check("A local build's /build.json has no build id", (await GET().json()).build === "");

  // --- What counts as an update ---
  check("A build answer is read", JSON.stringify(parseBuildInfo({ build: "abc1234", protocol: 2 })) === '{"build":"abc1234","protocol":2}');
  check("No protocol reads as unknown", parseBuildInfo({ build: "abc1234" })?.protocol === null);
  check("Junk is no answer", [null, "abc", 7, {}, { build: 7 }, { build: "x".repeat(65) }].every((raw) => parseBuildInfo(raw) === null));

  const p = PROTOCOL_VERSION;
  check("The same build is no update", !compareBuild("abc1234", p, { build: "abc1234", protocol: p }).ready);
  const newer = compareBuild("abc1234", p, { build: "def5678", protocol: p });
  check("Another build is an update", newer.ready && newer.latest === "def5678" && !newer.protocolChanged);
  check("An older build (a rollback) is one too", compareBuild("def5678", p, { build: "abc1234", protocol: p }).ready);
  check("A new online protocol is marked", compareBuild("abc1234", p, { build: "def5678", protocol: p + 1 }).protocolChanged);
  check("An unknown protocol is not taken as a change", !compareBuild("abc1234", p, { build: "def5678", protocol: null }).protocolChanged);
  check("A page without a build id never updates", !compareBuild("", p, { build: "def5678", protocol: p }).ready);
  check("A server without one offers none", !compareBuild("abc1234", p, { build: "", protocol: p }).ready);

  // --- When the game reloads by itself ---
  const ready = compareBuild("abc1234", p, { build: "def5678", protocol: p });
  const base: AutoReloadInput = { moment: "idle", update: ready, boot: false, pageAgeMs: 0, hidden: true, typing: false, triedFor: null };
  const at = (patch: Partial<AutoReloadInput>) => autoReloadNow({ ...base, ...patch });
  check("First loading screen: reloads at once", at({ moment: "loading", boot: true, hidden: false }));
  check("A circuit loading later (a room may have moved it): never", !at({ moment: "loading", boot: false, hidden: true, pageAgeMs: STALE_PAGE_MS }));
  check("Idle title, out of view, page under a day old: no (the menus offer it)", !at({ pageAgeMs: STALE_PAGE_MS - 1 }));
  check("Idle title, out of view, page a day old: reloads", at({ pageAgeMs: STALE_PAGE_MS }));
  check("Idle title, out of view, new online protocol: reloads", at({ update: compareBuild("abc1234", p, { build: "def5678", protocol: p + 1 }) }));
  check("Idle title in view: never under the player", !at({ hidden: false, pageAgeMs: 10 * STALE_PAGE_MS }));
  check("A half-typed request: never", !at({ typing: true, pageAgeMs: STALE_PAGE_MS }));
  check("Driving, paused, a lobby or Settings: never", !at({ moment: "busy", pageAgeMs: 10 * STALE_PAGE_MS, update: compareBuild("abc1234", p, { build: "def5678", protocol: p + 1 }) }));
  check("Once per build: a reload that came back old is not repeated", !at({ pageAgeMs: STALE_PAGE_MS, triedFor: "def5678" }));
  check("A newer build than the one tried is tried", at({ pageAgeMs: STALE_PAGE_MS, triedFor: "0ld0000" }));
  check("No update, no reload", !at({ update: compareBuild("abc1234", p, { build: "abc1234", protocol: p }), boot: true, moment: "loading" }));

  // --- The check against a server ---
  const asked: { url: string; cache?: RequestCache }[] = [];
  let serverBuild = "abc1234";
  (globalThis as { document?: unknown }).document = {
    querySelector: (sel: string) => (sel === 'meta[name="lc-build"]' ? { getAttribute: () => "abc1234" } : null),
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, cache: init?.cache });
    return new Response(JSON.stringify({ build: serverBuild, protocol: PROTOCOL_VERSION }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  let seen = 0;
  const unsubscribe = updateStore.subscribe(() => seen++);
  await checkForUpdate(true);
  check("Asks /build.json past the browser's cache", asked.length === 1 && asked[0].url === "/build.json" && asked[0].cache === "no-store", JSON.stringify(asked));
  check("The same build: nothing ready, nobody told", !updateStore.getSnapshot().ready && seen === 0);
  serverBuild = "def5678";
  await checkForUpdate();
  check(`Asks at most once per ${UPDATE_MIN_GAP_MS / 1000} s`, asked.length === 1 && !updateStore.getSnapshot().ready);
  const both = await Promise.all([checkForUpdate(true), checkForUpdate(true)]);
  check("Two asks at once share one request", asked.length === 2 && both[0] === both[1]);
  check("A new build on the server: ready, and the menus are told", updateStore.getSnapshot().ready && updateStore.getSnapshot().latest === "def5678" && seen === 1);
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await checkForUpdate(true);
  check("Offline: the update already seen stays", updateStore.getSnapshot().ready);
  unsubscribe();

  console.log(failed === 0 ? "\nAll update-check checks passed." : `\n${failed} check(s) failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
