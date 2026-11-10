/**
 * Messages between the page and the simulation worker (`sim-worker.ts`). Plain data only: everything here crosses
 * `postMessage`, so no class instances, functions or three.js objects.
 */

/** Page → worker */
export type SimCommand = { type: "ping"; id: number };

/** Worker → page */
export type SimEvent = { type: "pong"; id: number };
