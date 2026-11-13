/**
 * Which circuits are point-to-point courses (hill climbs: one run from a start line to a finish line somewhere else),
 * from `type` in public/tracks/index.json. No three.js and no DOM: the Worker's lap checks import this file.
 */
import trackIndex from "../../public/tracks/index.json";

const POINT_TO_POINT_IDS: ReadonlySet<string> = new Set(
  (trackIndex as { id: string; type?: string }[]).filter((t) => t.type === "hillclimb").map((t) => t.id)
);

/** Whether the circuit `trackId` is a point-to-point course, whose timed laps end somewhere else than they start */
export const isPointToPointTrack = (trackId: string): boolean => POINT_TO_POINT_IDS.has(trackId);
