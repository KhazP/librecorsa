/**
 * The AI tuning files (`public/ai/*.json`), bundled like `public/tracks/index.json`: the static export has no
 * server to list a folder, and the headless tools read the same modules in Node. A new file needs a line here.
 *
 *   <class>.json          class defaults (+ `vehicles.<vehicleId>` blocks)
 *   <class>.<track>.json  per-track overrides and `sections` (by distance or by turn numbers)
 */
import f1Class from "../../../public/ai/f1-2026.json";
import gt3Class from "../../../public/ai/gt3.json";
import { sanitizeTuningFile, type AiTuningFile, type AiTuningLibrary } from "./ai-tuning";

const RAW: Record<string, unknown> = {
  "f1-2026": f1Class,
  gt3: gt3Class,
};

export const AI_TUNING_LIBRARY: AiTuningLibrary = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, sanitizeTuningFile(v)] as [string, AiTuningFile])
);
