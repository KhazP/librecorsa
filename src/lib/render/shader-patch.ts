/** One shader edit: the exact text to find (usually an unresolved `#include <...>` line) and what replaces it */
export type ShaderPatch = readonly [anchor: string, replacement: string];

/**
 * Replaces each anchor exactly once. A missing or duplicated anchor (a three.js update renamed a chunk) is reported
 * and that patch skipped, so the material falls back to its stock look instead of silently losing the effect or
 * failing to compile.
 */
export function patchShader(source: string, patches: readonly ShaderPatch[], label: string): string {
  let out = source;
  for (const [anchor, replacement] of patches) {
    const parts = out.split(anchor);
    if (parts.length !== 2) {
      console.warn(`[shader-patch] ${label}: anchor "${anchor}" found ${parts.length - 1} times, skipped`);
      continue;
    }
    out = parts[0] + replacement + parts[1];
  }
  return out;
}
