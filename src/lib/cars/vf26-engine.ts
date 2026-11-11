/**
 * Which engine the VF26 model runs on: the rigid-body `VehiclePhysics` every other car drives on (what it ships on:
 * `createVf26Sim`, the car of `Vf26Tune.ts`), or `F1Physics2026`, the engine the car was first built on, kept to
 * compare the two: `?vf26engine=classic` in the address switches to it and `?vf26engine=rigid` back, and the choice
 * is kept for the browser. Off the browser (the scripts) it is the shipping engine.
 */
const STORAGE_KEY = "librecorsa.vf26Engine";

/** The page's choice, handed to a place that cannot read it (the simulation worker has no address bar or storage) */
let handedOver: boolean | null = null;
export function setVf26OnRigidBody(rigid: boolean): void {
  handedOver = rigid;
}

export function vf26OnRigidBody(): boolean {
  if (handedOver !== null) return handedOver;
  if (typeof window === "undefined") return true;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("vf26engine");
    if (fromUrl === "rigid" || fromUrl === "classic") localStorage.setItem(STORAGE_KEY, fromUrl);
    return localStorage.getItem(STORAGE_KEY) !== "classic";
  } catch {
    return true;
  }
}
