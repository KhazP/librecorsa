import { accountActions, getAccountState } from "@/lib/account/account-store";
import { defaultPlayerSettings, type PlayerSettings } from "@/lib/settings/player-settings";

/**
 * Everything the game keeps in this browser, for Settings > Profile and data. Keys are listed by what they hold; the
 * clear also sweeps any other key under the game's three prefixes, so a key added later is not left behind.
 */
export const STORAGE_PREFIXES = ["bugesera.", "librecorsa.", "lc."] as const;

/**
 * Under a game prefix but not the player's game data: the key older builds of the admin page kept for their tab
 * (`src/app/admin` now keeps it in memory only; a tab opened before that may still hold it until it closes)
 */
const NOT_GAME_DATA: readonly string[] = ["librecorsa.adminKey"];

/** The IndexedDB database of lap history and ghosts (`src/lib/sim/ghost-store.ts`) */
export const LAP_DATABASE = "bugesera-laps";
/** The IndexedDB database of the last lap finished per circuit and car, for the lap board's Analysis view (ghost-store.ts) */
export const LATEST_LAP_DATABASE = "librecorsa-latest-laps";

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
  { key: "librecorsa.boardFilters", holds: "online leaderboard filter toggles" },
  { key: "librecorsa.f1ModPhysics", holds: "physics model of the ported cars" },
  { key: "librecorsa.raceHistory", holds: "race history" },
  { key: "librecorsa.supportPrompt", holds: "the note after a drive: when it last showed and what it named" },
  { key: "librecorsa.signInHintShown", holds: "the lap card's sign-in note has shown" },
  { key: "librecorsa.ai-learn.v1.<circuit>.<class>.<driver>", holds: "what the AI learnt per corner" },
  { key: "librecorsa.simMode", holds: "simulation thread (URL flag)" },
  { key: "librecorsa.lc26Engine", holds: "engine model (URL flag)" },
  { key: "librecorsa.vf26Engine", holds: "older engine model key, read once" },
  { key: "librecorsa.syncState", holds: "when each synced value last changed, and the last account sync" },
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
    timeOfDayChosen: prev.timeOfDayChosen,
    liveryId: prev.liveryId,
    customLivery: prev.customLivery,
    // The detail level the player is looking at stays, so the screen does not change under them
    ui: { ...d.ui, detail: prev.ui.detail },
  };
}

/** Removes everything the game saved in this browser, then reloads the page as a first visit */
export async function clearSavedData(): Promise<void> {
  // Signed in: this device leaves the account first, or the next start would bring the cloud save straight back.
  // A server out of reach doesn't hold the clear up for long
  if (getAccountState().phase === "signed-in") {
    await Promise.race([accountActions.signOut(), new Promise<void>((resolve) => setTimeout(resolve, 4000))]);
  }
  // The databases first (they are asynchronous); the keys go right before the reload, so nothing can save them back
  for (const name of [LAP_DATABASE, LATEST_LAP_DATABASE]) {
    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = () => resolve();
        // Another tab holding the database open: the delete waits for it, the page should not
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }
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
