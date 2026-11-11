/**
 * What a copy of the game can list. The repository carries only RISE Motordrome and the 2026 prototype car (its
 * body in `public/amr26/` and its sound in `public/cars/f12026/`); every other car and circuit lives on librecorsa.org
 * only, in the librecorsa-assets R2 bucket, which `cloudflare/worker.js` serves from the same paths. So a clone lists
 * just what it has, and the deploy (`.github/workflows/deploy-pages.yml`) sets `NEXT_PUBLIC_HOSTED_CONTENT=1` to list
 * everything. Set it in `.env.local` too if you have the hosted files in `public/` (they are gitignored).
 */
export const HOSTED_CONTENT = process.env.NEXT_PUBLIC_HOSTED_CONTENT === "1";

/** The cars in the repository: both drive the 2026 prototype's body and sound */
export const REPO_CAR_IDS: ReadonlySet<string> = new Set(["vf26"]);

/** The circuits in the repository */
export const REPO_TRACK_IDS: ReadonlySet<string> = new Set(["rwanda_official_short", "rwanda_official"]);

/** Whether this copy lists a car */
export const carListed = (id: string): boolean => HOSTED_CONTENT || REPO_CAR_IDS.has(id);

/** Whether this copy lists a circuit */
export const trackListed = (id: string): boolean => HOSTED_CONTENT || REPO_TRACK_IDS.has(id);
