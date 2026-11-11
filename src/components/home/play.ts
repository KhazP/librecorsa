import { withBasePath } from "@/lib/base-path";

/**
 * Starting the game from the home page. The game reads its circuit and car from the browser's storage
 * (track-registry.ts, player-settings.ts), so a pick made here is written there just before the link is followed.
 */
const TRACK_KEY = "bugesera.track";
const CAR_KEY = "bugesera.vehicle";

export const PLAY_HREF = withBasePath("/play");

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | undefined): void => {
  if (!value) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the game opens on its own last choice
  }
};

/** The circuit and car the game would open on: the player's last picks, when there are any */
export const storedPicks = (): { trackId: string | null; carId: string | null } => ({ trackId: read(TRACK_KEY), carId: read(CAR_KEY) });

/** For a Drive link's onClick: remember what was picked, then let the link go */
export const rememberPicks = (picks: { trackId?: string; carId?: string }): void => {
  write(TRACK_KEY, picks.trackId);
  write(CAR_KEY, picks.carId);
};
