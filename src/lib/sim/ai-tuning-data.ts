/**
 * The AI tuning files (`public/ai/*.json`), bundled like `public/tracks/index.json`: the static export has no
 * server to list a folder, and the headless tools read the same modules in Node. A new file needs a line here.
 *
 *   <class>.json          class defaults (+ `vehicles.<vehicleId>` blocks)
 *   <class>.<track>.json  per-track overrides and `sections` (by distance or by turn numbers)
 */
import f1Class from "../../../public/ai/f1-2026.json";
import f1MarinaBay from "../../../public/ai/f1-2026.marina_bay.json";
import f1Monza from "../../../public/ai/f1-2026.monza.json";
import f1Silverstone from "../../../public/ai/f1-2026.silverstone.json";
import f1Spa from "../../../public/ai/f1-2026.spa.json";
import f1Suzuka from "../../../public/ai/f1-2026.suzuka.json";
import f1YasMarina from "../../../public/ai/f1-2026.yas_marina.json";
import gt3Class from "../../../public/ai/gt3.json";
import gt3MarinaBay from "../../../public/ai/gt3.marina_bay.json";
import gt3Monza from "../../../public/ai/gt3.monza.json";
import gt3Silverstone from "../../../public/ai/gt3.silverstone.json";
import gt3Spa from "../../../public/ai/gt3.spa.json";
import gt3Suzuka from "../../../public/ai/gt3.suzuka.json";
import gt3YasMarina from "../../../public/ai/gt3.yas_marina.json";
import { sanitizeTuningFile, type AiTuningFile, type AiTuningLibrary } from "./ai-tuning";

const RAW: Record<string, unknown> = {
  "f1-2026": f1Class,
  "f1-2026.marina_bay": f1MarinaBay,
  "f1-2026.monza": f1Monza,
  "f1-2026.silverstone": f1Silverstone,
  "f1-2026.spa": f1Spa,
  "f1-2026.suzuka": f1Suzuka,
  "f1-2026.yas_marina": f1YasMarina,
  gt3: gt3Class,
  "gt3.marina_bay": gt3MarinaBay,
  "gt3.monza": gt3Monza,
  "gt3.silverstone": gt3Silverstone,
  "gt3.spa": gt3Spa,
  "gt3.suzuka": gt3Suzuka,
  "gt3.yas_marina": gt3YasMarina,
};

export const AI_TUNING_LIBRARY: AiTuningLibrary = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, sanitizeTuningFile(v)] as [string, AiTuningFile])
);
