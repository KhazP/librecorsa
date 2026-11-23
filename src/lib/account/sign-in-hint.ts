/**
 * The lap card's one note that an account carries best laps and driver names to every device: shown on the first lap
 * that goes up to an online board while signed out, then never again on this device.
 */

/** Set once the note has shown (a device's own one-time prompt, not part of the cloud save) */
export const SIGN_IN_HINT_KEY = "librecorsa.signInHintShown";

/**
 * True the first time it is asked on this device, and false from then on. False too where storage can't be written,
 * so a note that couldn't be marked as shown never comes back on every lap.
 */
export function claimSignInHint(): boolean {
  try {
    if (localStorage.getItem(SIGN_IN_HINT_KEY) !== null) return false;
    localStorage.setItem(SIGN_IN_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
