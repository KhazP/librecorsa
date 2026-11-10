/**
 * Which engine the VF26 model runs on: `F1Physics2026` (what it ships on) or the rigid-body `VehiclePhysics` on the
 * same car data (`createVf26Sim`). The rigid-body one is opt-in while it is being driven and compared:
 * `?vf26engine=rigid` in the address switches it on and `?vf26engine=classic` off, and the choice is kept for the
 * browser. Off the browser (scripts, the race server) it is the shipping engine.
 */
const STORAGE_KEY = "librecorsa.vf26Engine";

export function vf26OnRigidBody(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("vf26engine");
    if (fromUrl === "rigid" || fromUrl === "classic") localStorage.setItem(STORAGE_KEY, fromUrl);
    return localStorage.getItem(STORAGE_KEY) === "rigid";
  } catch {
    return false;
  }
}
