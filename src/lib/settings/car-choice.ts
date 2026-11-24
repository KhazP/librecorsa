import { resolveCarId, type CarId } from "@/lib/cars/car-registry";

/**
 * The car the player drives, kept in the browser. Apart from player-settings.ts, which every page loads (the language
 * provider reads it): the car registry brings the cars' physics and sounds with it, which only the game needs.
 */
const CAR_STORAGE_KEY = "bugesera.vehicle";

/** The car to drive: `?car=` in the URL, else the last choice, else the LC26 */
export function loadCarChoice(): CarId {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("car");
    const linked = resolveCarId(fromUrl);
    if (linked) return linked;
    return resolveCarId(localStorage.getItem(CAR_STORAGE_KEY)) ?? "lc26";
  } catch {
    return "lc26";
  }
}

export function saveCarChoice(car: CarId) {
  try {
    localStorage.setItem(CAR_STORAGE_KEY, car);
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}
