/**
 * Which engine the LC26 model runs on: the rigid-body `VehiclePhysics` every other car drives on (what it ships on:
 * `createLc26Sim`, the car of `Lc26Tune.ts`), or `F1Physics2026`, the engine the car was first built on, kept to
 * compare the two: `?lc26engine=classic` in the address switches to it and `?lc26engine=rigid` back, and the choice
 * is kept for the browser. Off the browser (the scripts) it is the shipping engine.
 */
const STORAGE_KEY = "librecorsa.lc26Engine";

/** The page's choice, handed to a place that cannot read it (the simulation worker has no address bar or storage) */
let handedOver: boolean | null = null;
export function setLc26OnRigidBody(rigid: boolean): void {
  handedOver = rigid;
}

export function lc26OnRigidBody(): boolean {
  if (handedOver !== null) return handedOver;
  if (typeof window === "undefined") return true;
  try {
    const params = new URLSearchParams(window.location.search);
    // The parameter and the saved choice under the car's old name still count
    const fromUrl = params.get("lc26engine") ?? params.get("vf26engine"); // keep-old-id
    if (fromUrl === "rigid" || fromUrl === "classic") localStorage.setItem(STORAGE_KEY, fromUrl);
    return (localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem("librecorsa.vf26Engine")) !== "classic"; // keep-old-id
  } catch {
    return true;
  }
}
