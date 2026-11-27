/**
 * Verifies HUD lap-counter synchronization (`displayLapNumber`) and race-control banner localization
 * (`localizeRaceControlMessage`) across all 12 locales.
 *
 *   npx tsx scripts/verify/verify-hud-lap-and-banners.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTranslator } from "use-intl";
import { displayLapNumber } from "../../src/components/hud/hud-format";
import { localizeRaceControlMessage, type RaceControlMessageKey, type RaceControlTranslate } from "../../src/components/hud/race-control-i18n";
import type { RaceStatus } from "../../src/types/f1";

const ROOT = resolve(import.meta.dirname, "../..");
const LOCALES = ["en", "ar", "de", "es", "fr", "id", "it", "ko", "pt-BR", "tr", "vi", "zh-Hant"] as const;

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

// 1. HUD lap-counter sync checks
const stubRace = (lap: number, totalLaps = 5): RaceStatus => ({
  phase: "racing",
  lightsOn: 0,
  lap,
  totalLaps,
  position: 1,
  fieldSize: 8,
  standings: [],
});

check("AI race after 3 practice laps uses race.lap (1, not 4)", displayLapNumber({ lapCount: 4, race: stubRace(1, 5) }) === 1);
check("Multiplayer race with lapCount drift uses race.lap (4, not 5)", displayLapNumber({ lapCount: 5, race: stubRace(4, 7) }) === 4);
check("Race lap 0 during lights clamps to 1", displayLapNumber({ lapCount: 4, race: stubRace(0, 5) }) === 1);
check("Solo practice uses lapCount with baseline 0", displayLapNumber({ lapCount: 3, race: undefined }, 0) === 3);
check("Fresh solo session after 3 prior laps starts at Lap 1", displayLapNumber({ lapCount: 4, race: undefined }, 3) === 1);
check("Fresh solo session advances to Lap 2 after completing a lap", displayLapNumber({ lapCount: 5, race: undefined }, 3) === 2);
check("Solo session clamps to at least 1 even if lapCount drops", displayLapNumber({ lapCount: 1, race: undefined }, 3) === 1);

// 2. Race-control banner translation checks across all 12 locales
const SAMPLES: ReadonlyArray<{ text: string; detail?: string; expectDiffFromEn?: boolean }> = [
  { text: "Virtual Safety Car", detail: "Maintain positive delta · no overtaking" },
  { text: "VSC ending", detail: "Hold positive delta · prepare for green" },
  { text: "Green flag", detail: "Track clear · racing resumes" },
  { text: "Yellow flag", detail: "Incident ahead · no overtaking" },
  { text: "Double yellow", detail: "Car stopped ahead · slow down, no overtaking" },
  { text: "Track clear" },
  { text: "Racing incident", detail: "No further action" },
  { text: "Position handed back", detail: "No further action" },
  { text: "Overtake under yellow", detail: "Give the place back to VER" },
  { text: "Overtake under double yellow", detail: "Give the place back to HAM" },
  { text: "Overtake under VSC", detail: "Give the place back to LEC" },
  { text: "Blue flag warning", detail: "Let NOR through" },
  { text: "Contact with PIA", detail: "Under investigation" },
  { text: "Warning", detail: "Contact with RUS · hit the car ahead" },
  { text: "No further action", detail: "SAI · moved into a car alongside" },
  { text: "5 s time penalty", detail: "Causing a collision with ALO" },
  { text: "VER · 5 s penalty", detail: "Causing a collision" },
  { text: "5 s time penalty", detail: "VSC delta infringement" },
  { text: "5 s time penalty", detail: "VSC delta negative at green flag" },
  { text: "5 s time penalty", detail: "Overtaking under yellow · VER" },
  { text: "5 s time penalty", detail: "Ignoring blue flag · HAM" },
  { text: "You are out of the race", detail: "Damage" },
  { text: "LEC is out of the race" },
  { text: "YOU disqualified", detail: "Track limits" },
  { text: "30 s time penalty", detail: "Required pit stop not made" },
  { text: "60 s time penalty", detail: "2 required pit stops not made" },
  { text: "5 s time penalty", detail: "Pit lane speeding (over 80 km/h)" },
  { text: "5 s time penalty", detail: "Jump start" },
  { text: "10 s time penalty", detail: "Jump start · well off the grid spot" },
];

function makeTranslator(locale: string): RaceControlTranslate {
  const hud = JSON.parse(readFileSync(join(ROOT, "src/i18n/messages", locale, "hud.json"), "utf8")) as {
    raceIncidentFeed: { messages: Record<RaceControlMessageKey, string> };
  };
  const tr = createTranslator({ locale, messages: { messages: hud.raceIncidentFeed.messages }, namespace: "messages" });
  return (key, values) => (values ? tr(key, values) : tr(key));
}

for (const locale of LOCALES) {
  const translate = makeTranslator(locale);

  let allTranslated = true;
  let sampleFail = "";
  for (const s of SAMPLES) {
    const out = localizeRaceControlMessage(s, translate);
    if (!out.text || out.text.includes("{") || (out.detail && out.detail.includes("{"))) {
      allTranslated = false;
      sampleFail = `${s.text} -> ${out.text} / ${out.detail ?? ""}`;
      break;
    }
    if (locale !== "en") {
      // Every non-English locale must translate banner copy (allowing "Virtual Safety Car" or "Jump start" where glossary keeps it)
      const sameText = out.text === s.text && s.text !== "Virtual Safety Car";
      const sameDetail = Boolean(s.detail && out.detail === s.detail && s.detail !== "Jump start");
      if (sameText || sameDetail) {
        allTranslated = false;
        sampleFail = `untranslated in ${locale}: "${s.text}" / "${s.detail ?? ""}"`;
        break;
      }
    }
  }
  check(`${locale}: all ${SAMPLES.length} race-control banners localize cleanly`, allTranslated, sampleFail);
}

// 3. Explicit pt-BR regression checks matching reported untranslated banners
{
  const t = makeTranslator("pt-BR");
  const gf = localizeRaceControlMessage({ text: "Green flag", detail: "Track clear · racing resumes" }, t);
  check("pt-BR Green flag / Track clear translated", gf.text === "Bandeira verde" && gf.detail === "Pista livre · corrida retomada", `${gf.text} / ${gf.detail}`);
  const dy = localizeRaceControlMessage({ text: "Double yellow", detail: "Car stopped ahead · slow down, no overtaking" }, t);
  check("pt-BR Double yellow translated", dy.text === "Amarela dupla" && dy.detail?.includes("sem ultrapassagem") === true, `${dy.text} / ${dy.detail}`);
  const ri = localizeRaceControlMessage({ text: "Racing incident", detail: "No further action" }, t);
  check("pt-BR Racing incident / NFA translated", ri.text === "Incidente de corrida" && ri.detail === "Nenhuma ação adicional", `${ri.text} / ${ri.detail}`);
  const vscEnd = localizeRaceControlMessage({ text: "VSC ending", detail: "Hold positive delta · prepare for green" }, t);
  check("pt-BR VSC ending translated", vscEnd.text === "Fim do VSC" && vscEnd.detail?.includes("verde") === true, `${vscEnd.text} / ${vscEnd.detail}`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nAll HUD lap-counter and race-control banner checks passed.");
