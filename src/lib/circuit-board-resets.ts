/**
 * Circuits whose boards started again on their own: a change to one circuit that makes its earlier lap times
 * incomparable (its kerbs, its walls, its track limits, a rebuilt surface) restarts that circuit's boards for every
 * car, without a new physics version and without touching the other circuits. Each restart raises the circuit's
 * revision by one, and lap-types.ts folds it into the revision a lap is ranked under (`lapPhysicsVersion`): ghosts,
 * personal bests, the upload queue and the weekly challenge all go by that revision. The boards from before a restart
 * stay readable, as an older board in the picker.
 *
 * Every layout is a circuit of its own here: a fix to a model two layouts share lists both. An entry is never
 * removed or edited once it has shipped, or the boards it closed can't be found again. Pure data: the Worker imports
 * this file.
 */
export interface CircuitBoardReset {
  /** The PHYSICS_VERSION the restart was made under */
  physics: number;
  /** What the picker calls the board it closed: a few words, "Old kerbs" */
  oldBoard: string;
  /** What changed, for the record */
  why: string;
}

/** Restarts by circuit id, oldest first. Every circuit is at 0 for the Physics V2 reset */
export const CIRCUIT_BOARD_RESETS: Readonly<Record<string, readonly CircuitBoardReset[]>> = {};
