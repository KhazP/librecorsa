import { defaultPlayerSettings, type PlayerSettings } from "@/lib/settings/player-settings";

/**
 * Everything the game keeps in this browser, for Settings > Profile and data. Keys are listed by what they hold; the
 * clear also sweeps any other key under the game's three prefixes, so a key added later is not left behind.
 */
export const STORAGE_PREFIXES = ["bugesera.", "librecorsa.", "lc."] as const;

/** Under a game prefix but not the player's game data: the admin page's key for this tab (`src/app/admin`) */
const NOT_GAME_DATA: readonly string[] = ["librecorsa.adminKey"];

/** The IndexedDB database of lap history and ghosts (`src/lib/sim/ghost-store.ts`) */
export const LAP_DATABASE = "bugesera-laps";

export const STORAGE_KEYS: readonly { key: string; holds: string }[] = [
  { key: "bugesera.settings.v1", holds: "every setting" },
  { key: "bugesera.ffb_polarity_v2", holds: "force feedback direction migration flag" },
  { key: "bugesera.onboarded", holds: "first-run setup done" },
  { key: "bugesera.rumble", holds: "controller vibration" },
  { key: "bugesera.vehicle", holds: "the car last chosen" },
  { key: "bugesera.track", holds: "the circuit last chosen" },
  { key: "bugesera.tyreSetup.<car>", holds: "tyre setup per car" },
  { key: "bugesera.turn", holds: "own relay server for multiplayer" },
  { key: "bugesera.driverKey", holds: "the driver key that signs online laps" },
  { key: "lc.garage.chassis.<car>", holds: "car setup per car" },
  { key: "lc.garage.presets.<car>", holds: "saved setups per car" },
  { key: "lc.mfdPage", holds: "the MFD page last open" },
  { key: "lc.seatHintCars", holds: "cars whose seat hint has shown" },
  { key: "lc.boardBest", holds: "best online lap per board" },
  { key: "lc.challengeBest", holds: "best weekly challenge lap" },
  { key: "librecorsa.carSkins", holds: "livery per car" },
  { key: "librecorsa.f1ModPhysics", holds: "physics model of the ported cars" },
  { key: "librecorsa.raceHistory", holds: "race history" },
  { key: "librecorsa.ai-learn.v1.<circuit>.<class>.<driver>", holds: "what the AI learnt per corner" },
  { key: "librecorsa.simMode", holds: "simulation thread (URL flag)" },
  { key: "librecorsa.lc26Engine", holds: "engine model (URL flag)" },
  { key: "librecorsa.vf26Engine", holds: "older engine model key, read once" },
];

/**
 * Settings > Reset all settings: every setting on the Settings screen back to its default. Who the player is (name,
 * code, colour), favourites, the race and conditions choices and the livery stay.
 */
export function resetAllSettings(prev: PlayerSettings): PlayerSettings {
  // This device's defaults: Quality goes back to Medium on a touch screen
  const d = structuredClone(defaultPlayerSettings());
  return {
    ...d,
    profile: prev.profile,
    library: prev.library,
    race: prev.race,
    aiSkill: prev.aiSkill,
    conditions: prev.conditions,
    liveryId: prev.liveryId,
    // The detail level the player is looking at stays, so the screen does not change under them
    ui: { ...d.ui, detail: prev.ui.detail },
  };
}

/** Removes everything the game saved in this browser, then reloads the page as a first visit */
export async function clearSavedData(): Promise<void> {
  // The database first (it is asynchronous); the keys go right before the reload, so nothing can save them back
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(LAP_DATABASE);
      req.onsuccess = req.onerror = () => resolve();
      // Another tab holding the database open: the delete waits for it, the page should not
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
  try {
    for (const store of [localStorage, sessionStorage]) {
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && !NOT_GAME_DATA.includes(k) && STORAGE_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
      }
      for (const k of doomed) store.removeItem(k);
    }
  } catch {
    // Storage unavailable: nothing was saved there
  }
  window.location.reload();
}
