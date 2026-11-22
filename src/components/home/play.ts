import { withBasePath } from "@/lib/base-path";
import { loadPlayerSettings, savePlayerSettings } from "@/lib/settings/player-settings";
import type { CustomLiveryColors } from "@/types/f1";

/**
 * Starting the game from the home page. The game reads its circuit, car and liveries from the browser's storage
 * (track-registry.ts, player-settings.ts, car-skins.ts), so picks made here are written there before Drive opens /play.
 */
const TRACK_KEY = "bugesera.track";
const CAR_KEY = "bugesera.vehicle";
const CAR_SKINS_KEY = "librecorsa.carSkins";

export const PLAY_HREF = withBasePath("/play");

const isId = (v: unknown, max: number): v is string => typeof v === "string" && new RegExp(`^[\\w-]{1,${max}}$`).test(v);

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

function readCarSkins(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(CAR_SKINS_KEY) ?? "{}") as unknown;
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [car, skin] of Object.entries(raw)) if (isId(car, 40) && isId(skin, 60)) out[car] = skin;
    }
    return out;
  } catch {
    return {};
  }
}

export interface StoredPicks {
  trackId: string | null;
  carId: string | null;
  f1LiveryId: string | null;
  customLivery: CustomLiveryColors | null;
  carSkins: Record<string, string>;
}

/** The circuit, car and liveries the game would open on: the player's last picks, when there are any */
export const storedPicks = (): StoredPicks => {
  const carId = read(CAR_KEY);
  let f1LiveryId: string | null = null;
  let customLivery: CustomLiveryColors | null = null;
  try {
    const settings = loadPlayerSettings();
    f1LiveryId = settings.liveryId;
    customLivery = settings.customLivery;
  } catch {
    // Storage unavailable: defaults apply
  }
  return {
    trackId: read(TRACK_KEY),
    carId: carId === "vf26" ? "lc26" : carId, // keep-old-id: a pick saved before the rename
    f1LiveryId,
    customLivery,
    carSkins: readCarSkins(),
  };
};

/** Persists the chosen F1 procedural livery in player settings so /play opens wearing it */
export const rememberF1Livery = (liveryId: string): void => {
  try {
    const settings = loadPlayerSettings();
    if (settings.liveryId === liveryId) return;
    savePlayerSettings({ ...settings, liveryId });
  } catch {
    // Storage unavailable
  }
};

/** Persists a ported car's chosen skin in `librecorsa.carSkins` so /play opens wearing it */
export const rememberCarSkin = (carId: string, skinId: string): void => {
  try {
    const skins = readCarSkins();
    if (skins[carId] === skinId) return;
    localStorage.setItem(CAR_SKINS_KEY, JSON.stringify({ ...skins, [carId]: skinId }));
  } catch {
    // Storage unavailable
  }
};

/** For a Drive link's onClick: remember what was picked, then let the link go */
export const rememberPicks = (picks: { trackId?: string; carId?: string }): void => {
  write(TRACK_KEY, picks.trackId);
  write(CAR_KEY, picks.carId);
};
