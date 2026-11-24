/**
 * The GPU the game draws with, and the WebGL context losses it has had (issue #123: a laptop's Intel UHD 620 on Linux
 * lost the context while the circuit loaded, and the page stayed blank).
 *
 * What is kept
 *   - The renderer string, read from the session's own context when it starts (`noteRenderer`). The bug form shows it:
 *     after a loss the browser may refuse new contexts, so a fresh probe then only says "no WebGL".
 *   - A context loss the player saw (`recordContextLoss`): the next start goes easy on the GPU for LOSS_MEMORY_MS. A
 *     loss while the page is hidden is not kept: phones and laptops drop background contexts on their own, and that
 *     says nothing about the driver.
 *
 * What a remembered loss does (`safeStartPlan`)
 *   - `gentle` (also on a software renderer or an older Intel HD / UHD chip): no physical sky, and the loading
 *     warm-up draws what the camera sees rather than the whole circuit at once.
 *   - `switchToLow` once per loss: the saved preset goes to Low at the next start unless the player already chose on
 *     the notice (Try again keeps their settings, Switch to Low sets it). Never again for the same loss, so one bad
 *     night does not hold anyone on Low.
 *
 * Storage goes through a small get / set / remove interface so scripts/verify/verify-gpu-health.ts can run it on a Map.
 */

export type GpuClass = "software" | "weak" | "ok" | "unknown";

/** How long a context loss keeps the gentle start (ms) */
export const LOSS_MEMORY_MS = 14 * 24 * 3600 * 1000;

export const GPU_NAME_KEY = "bugesera.gpu";
export const GPU_LOSS_KEY = "bugesera.gpuLoss";

/** localStorage, or a stand-in */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The page's localStorage, or null where it is blocked (private windows, storage turned off) */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const tryGet = (store: KeyValueStore | null, key: string): string | null => {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const trySet = (store: KeyValueStore | null, key: string, value: string | null): void => {
  try {
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // Storage full or blocked: the game runs without the memory
  }
};

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

/** The renderer string, unmasked where the browser allows, without ANGLE's "ANGLE (…)" wrapper; null if unreadable */
export function rendererName(gl: WebGLRenderingContext | WebGL2RenderingContext | null): string | null {
  if (!gl || gl.isContextLost()) return null;
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    const name = typeof raw === "string" ? raw.trim() : "";
    return name ? name.replace(/^ANGLE \((.*)\)$/, "$1").slice(0, 160) : null;
  } catch {
    return null;
  }
}

/** Renderer strings that name no GPU (masked by the browser) */
const MASKED = /^(webkit webgl|mozilla|apple gpu|generic renderer)$/i;
/** CPU rasterisers */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software (rasterizer|renderer)|microsoft basic render/i;
/**
 * Older Intel integrated graphics: HD / UHD Graphics (Gen 7 to 9.5 and the small Gen 11-12 parts), the Iris 5xx / 6xx
 * of the same years, GMA, and Mesa's codename strings for them. Iris Xe, Arc and the newer "Intel(R) Graphics" are not
 * in it.
 */
const WEAK_INTEL =
  /intel.*\b(u?hd graphics|hd \d{3,4}\b|gma\b|iris(\((r|tm)\))?\s*(pro|plus)|iris(\((r|tm)\))?\s*graphics\s*[56]\d\d)|mesa dri intel|\b(ivybridge|haswell|broadwell|skylake|kabylake|(kbl|skl|cfl|whl|cml|bxt|glk|apl) gt\d?)\b/i;
/** Windows ARM GPUs (Snapdragon X / 8cx Adreno over D3D11 ANGLE); Android phones are left out so PhysicalSky stays on */
const WEAK_WINDOWS_ARM = /qualcomm.*adreno.*direct3d11|adreno\(tm\)\s*(x1|8cx)/i;

/** What a renderer string says about the GPU: a CPU rasteriser, an older Intel or Windows ARM chip, anything else, or nothing */
export function classifyRenderer(name: string | null | undefined): GpuClass {
  const n = (name ?? "").trim();
  if (!n || MASKED.test(n)) return "unknown";
  if (SOFTWARE.test(n)) return "software";
  if (WEAK_INTEL.test(n) || WEAK_WINDOWS_ARM.test(n)) return "weak";
  return "ok";
}

/** The renderer this page's session drew with, and whether its context was lost since the page loaded */
let pageRenderer: string | null = null;
let lostThisPage = false;

/** The session's renderer string, kept for the bug form (also across a reload, as a loss may leave no WebGL) */
export function noteRenderer(name: string | null, store: KeyValueStore | null = browserStore()): void {
  if (!name) return;
  pageRenderer = name;
  if (tryGet(store, GPU_NAME_KEY) !== name) trySet(store, GPU_NAME_KEY, name);
}

/**
 * The renderer of this page's running session while its context is alive, or null. The bug form then needs no probe:
 * a fresh context while the game draws costs the GPU a second context, the very thing #123's driver could not take.
 */
export function liveSessionRenderer(): string | null {
  return lostThisPage ? null : pageRenderer;
}

/** The bug form's GPU field: the renderer recorded at start (or probed now), and what became of WebGL since */
export function gpuReportLine(probe: () => string | null, store: KeyValueStore | null = browserStore()): string {
  const known = pageRenderer ?? tryGet(store, GPU_NAME_KEY);
  let live: string | null = null;
  try {
    live = probe();
  } catch {
    live = null;
  }
  const name = known ?? live ?? "no WebGL";
  const notes: string[] = [];
  if (lostThisPage) notes.push("WebGL context lost");
  else if (hasRecentLoss(store)) notes.push("WebGL context lost earlier");
  if (known && live === null) notes.push("no WebGL now");
  return [name, ...notes].join(" · ");
}

/** A fresh context's renderer string, or null where the browser refuses WebGL (the canvas is let go at once) */
export function probeRenderer(): string | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGL2RenderingContext | WebGLRenderingContext | null;
  if (!gl) return null;
  const name = rendererName(gl) ?? "unknown GPU";
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return name;
}

// ---------------------------------------------------------------------------------------------
// Context losses
// ---------------------------------------------------------------------------------------------

export interface GpuLossMemory {
  /** When the last loss came (wall clock, ms) */
  atMs: number;
  /** Losses since the memory started (each within LOSS_MEMORY_MS of the one before) */
  count: number;
  /** The preset question for this loss is settled: switched to Low at a start, or the player chose on the notice */
  settled: boolean;
}

function parseLoss(raw: string | null): GpuLossMemory | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GpuLossMemory>;
    if (typeof v.atMs !== "number" || !Number.isFinite(v.atMs)) return null;
    return {
      atMs: v.atMs,
      count: typeof v.count === "number" && v.count >= 1 ? Math.floor(v.count) : 1,
      settled: v.settled === true,
    };
  } catch {
    return null;
  }
}

/** The last context loss, if it came within LOSS_MEMORY_MS (an older one is forgotten here) */
export function readLossMemory(store: KeyValueStore | null, nowMs: number): GpuLossMemory | null {
  const loss = parseLoss(tryGet(store, GPU_LOSS_KEY));
  if (!loss) return null;
  // Older than the memory, or stamped in the future (a clock set back): forgotten
  if (nowMs - loss.atMs > LOSS_MEMORY_MS || loss.atMs - nowMs > 60_000) {
    trySet(store, GPU_LOSS_KEY, null);
    return null;
  }
  return loss;
}

function hasRecentLoss(store: KeyValueStore | null): boolean {
  return readLossMemory(store, Date.now()) !== null;
}

/**
 * The context was lost. A loss while the page is hidden is noted for the bug form but not remembered. Returns the
 * memory as it now stands (null when not remembered).
 */
export function recordContextLoss(store: KeyValueStore | null, nowMs: number, pageHidden: boolean): GpuLossMemory | null {
  lostThisPage = true;
  if (pageHidden) return readLossMemory(store, nowMs);
  const prev = readLossMemory(store, nowMs);
  const next: GpuLossMemory = { atMs: nowMs, count: (prev?.count ?? 0) + 1, settled: false };
  trySet(store, GPU_LOSS_KEY, JSON.stringify(next));
  return next;
}

/** The player chose on the notice (Try again or Switch to Low): no Low switch at the next start for this loss */
export function settleLoss(store: KeyValueStore | null, nowMs: number): void {
  const loss = readLossMemory(store, nowMs);
  if (loss && !loss.settled) trySet(store, GPU_LOSS_KEY, JSON.stringify({ ...loss, settled: true }));
}

export interface SafeStart {
  /** No physical sky, and a warm-up of what the camera sees */
  gentle: boolean;
  /** Put the saved preset on Low at this start (once per loss) */
  switchToLow: boolean;
}

/** How a session starts, from the remembered loss and the GPU (`gpu` unknown before a context exists) */
export function safeStartPlan(loss: GpuLossMemory | null, gpu: GpuClass): SafeStart {
  return {
    gentle: loss !== null || gpu === "software" || gpu === "weak",
    switchToLow: loss !== null && !loss.settled,
  };
}

/**
 * At a start: whether this start switches the preset to Low for a remembered loss, settling it either way so it
 * happens once. The caller saves the preset and says so.
 */
export function takeSafeStart(store: KeyValueStore | null, nowMs: number): SafeStart {
  const loss = readLossMemory(store, nowMs);
  const plan = safeStartPlan(loss, "unknown");
  if (plan.switchToLow) settleLoss(store, nowMs);
  return plan;
}

/** A context was lost on this page, or a loss is remembered: a refused context then likely comes from that reset */
export function lostRecently(store: KeyValueStore | null = browserStore()): boolean {
  return lostThisPage || hasRecentLoss(store);
}

/** Test hook: forget this page's renderer and loss */
export function resetGpuPageState(): void {
  pageRenderer = null;
  lostThisPage = false;
}
