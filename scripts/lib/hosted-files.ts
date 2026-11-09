/**
 * Hosted-only cars and circuits (src/lib/hosted-content.ts) live on librecorsa.org, not in the repository. A suite that
 * reads one of their files skips that part, with a note, when the file isn't there, so `npm run verify` passes in a
 * clone and in CI and still checks everything on a machine that has the hosted files in public/. Paths are relative to
 * the repository root, the working directory the suites run in.
 */
import { existsSync } from "node:fs";
import { REPO_CAR_IDS, REPO_TRACK_IDS } from "../../src/lib/hosted-content";

export { REPO_CAR_IDS, REPO_TRACK_IDS };

/** Whether this copy has a file under the repository root */
export const hasFile = (rel: string): boolean => existsSync(rel);

/** Prints why a check was skipped */
export function noteSkip(what: string, missing: string): void {
  console.log(`  SKIP  ${what}: hosted on librecorsa.org only, not in this copy (${missing})`);
}

/** Ends the suite as passed, with a note, when any of these files is missing */
export function skipSuiteWithout(...files: string[]): void {
  const missing = files.filter((f) => !existsSync(f));
  if (!missing.length) return;
  console.log(`SKIP: this suite needs hosted files this copy doesn't have (${missing.join(", ")})`);
  process.exit(0);
}
