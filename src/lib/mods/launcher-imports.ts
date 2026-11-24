/**
 * The offline launcher's import folder (launcher/api.go): circuits and cars a player copied there from another game,
 * converted into mod packages by the converter that comes with the launcher. Only the launcher answers these, on
 * 127.0.0.1; the game served anywhere else never asks.
 *
 * Every call carries the launcher's header, which a page of another site can't send without a preflight the launcher
 * never answers, and the session cookie the launcher gave the window it opened (launcher/session.go), which the
 * browser sends by itself: the launcher refuses a call without either.
 */

const HEADER = { "X-LibreCorsa-Launcher": "1" } as const;

/** The importers a folder can be recognised for (scripts/mods/importers/<kind>.ts), and what isn't one */
export type ImportKind = "ac-track" | "ac-car" | "sd-track" | "sd-car" | "blender-track" | "unknown" | "archive" | "file" | "link";

export interface ImportFolder {
  name: string;
  kind: ImportKind;
  /** What the importer is given, relative to the import folder */
  source?: string;
  /** Whether the launcher's converter has the importer for the kind */
  available: boolean;
}

export interface PinnedDownload {
  name: string;
  version: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface LauncherToolchain {
  state: "ready" | "missing" | "unsupported";
  /** Where the tools go, beside the browser profile */
  dir: string;
  /** What the first conversion downloads (the launcher pins each one's address and SHA-256) */
  downloads?: PinnedDownload[];
  /** What uv fetches after them, roughly: Python and the converters' packages */
  pythonApproxBytes?: number;
  python?: string;
}

export interface LauncherCredit {
  author?: string;
  license?: string;
  licenseUrl?: string;
  url?: string;
  note?: string;
}

export interface ConvertedPackage {
  id: string;
  name: string;
  version?: string;
  credit?: LauncherCredit;
  content?: { type: "circuit" | "car"; id: string; name: string; credit?: LauncherCredit }[];
}

export interface LauncherJob {
  id: number;
  type: "toolchain" | "convert";
  state: "running" | "done" | "failed" | "cancelled";
  folder?: string;
  kind?: ImportKind;
  /** "uv", "node" (downloading), "python" (uv fetching Python and the packages), "convert", "check" */
  step?: string;
  done?: number;
  total?: number;
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** The tail of the programs' output, and how many lines there have been */
  log: string[];
  logLines: number;
  packages?: ConvertedPackage[];
  /** The package check's problems */
  problems?: string[];
  /** What the importer said about the source's licence */
  notes?: string[];
}

export interface LauncherImports {
  importDir: string;
  modsDir: string;
  converter: { available: boolean; version?: string; importers?: string[] };
  toolchain: LauncherToolchain;
  folders: ImportFolder[];
  job: LauncherJob | null;
}

/** A call the launcher refused, with its reason's code ("busy", "not-ready", "bad-folder", "no-importer", "link", …) */
export class LauncherError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The launcher listens on 127.0.0.1 only (launcher/main.go), and serves a production build: anywhere else, and on a
 * clone's dev server, there is nothing to ask
 */
const onLoopback = (): boolean =>
  typeof window !== "undefined" && process.env.NODE_ENV === "production" && /^(127\.0\.0\.1|localhost)$/.test(window.location.hostname);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "POST" ? { ...HEADER, "Content-Type": "application/json" } : HEADER,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => null)) as (T & { code?: string; error?: string }) | null;
  if (!res.ok || !data) throw new LauncherError(data?.code ?? String(res.status), data?.error ?? res.statusText);
  return data;
}

/**
 * Whether the game runs under a launcher that has the import folder (`GET /__launcher`): "none" when it doesn't (or
 * isn't a launcher), "session" in the window the launcher opened, "no-session" in any other, which may not convert
 */
export type LauncherPresence = "none" | "session" | "no-session";

/** Asked once per page: the answer can't change while it is open, and a dev server would log a 404 at each ask */
let presence: Promise<LauncherPresence> | null = null;

export function launcherPresence(): Promise<LauncherPresence> {
  presence ??= askLauncher();
  return presence;
}

async function askLauncher(): Promise<LauncherPresence> {
  if (!onLoopback()) return "none";
  try {
    const res = await fetch("/__launcher", { cache: "no-store" });
    if (!res.ok) return "none";
    const id = (await res.json()) as { app?: string; imports?: boolean; session?: boolean };
    if (id.app !== "librecorsa-launcher" || id.imports !== true) return "none";
    return id.session === true ? "session" : "no-session";
  } catch {
    return "none";
  }
}

export const readImports = (): Promise<LauncherImports> => call("GET", "/__launcher/imports");

export const readJob = (): Promise<{ job: LauncherJob | null; toolchain: LauncherToolchain }> => call("GET", "/__launcher/convert");

export const startConvert = async (folder: string): Promise<LauncherJob> => (await call<{ job: LauncherJob }>("POST", "/__launcher/convert", { folder })).job;

export const startToolchain = async (): Promise<LauncherJob> => (await call<{ job: LauncherJob }>("POST", "/__launcher/toolchain")).job;

export const cancelJob = async (): Promise<void> => {
  await call("POST", "/__launcher/convert/cancel");
};

/** The player's folders the launcher opens in Finder, Explorer or the file manager (launcher/appapi.go) */
export type LauncherFolder = "mods" | "import";

export const openLauncherFolder = async (folder: LauncherFolder): Promise<void> => {
  await call("POST", "/__launcher/open-folder", { folder });
};

/** The launcher's own update (launcher/update.go), as GET /__launcher/update answers */
export interface LauncherUpdate {
  /** The running launcher's version; `run` changes with each start, so a page waiting through a restart sees it */
  version: string;
  run: string;
  /**
   * "ready": a newer release is downloaded, to install with a restart; "available": one is out that this launcher
   * can't install itself (downloaded by hand from `releaseUrl`); "failed": the newer one couldn't be installed
   */
  state: "none" | "downloading" | "ready" | "available" | "failed";
  latest?: string;
  selfUpdate: boolean;
  reason?: string;
  error?: string;
  releaseUrl: string;
}

export const readLauncherUpdate = (): Promise<LauncherUpdate> => call("GET", "/__launcher/update");

/** Installs the downloaded update: the launcher stops, a new one takes the game's window over (`run` changes) */
export const restartLauncherForUpdate = async (): Promise<void> => {
  await call("POST", "/__launcher/update/restart");
};

/** How often an open page of the game tells the launcher so (it quits 2 minutes after the last; launcher/lifetime.go) */
const HEARTBEAT_MS = 30_000;

const pageId = (): string => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `page-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * Tells the launcher, while the game runs under it, that this page is open: at once and every 30 s, and that it
 * goes when it closes or reloads (pagehide). The launcher quits once no page of the game is left, when it has no
 * browser window of its own to watch. Returns the stop.
 */
export function startLauncherHeartbeat(): () => void {
  if (!onLoopback()) return () => {};
  const page = pageId();
  let timer: number | undefined;
  let stopped = false;
  const beat = (closing: boolean): void => {
    void fetch("/__launcher/alive", {
      method: "POST",
      headers: { ...HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ page, closing }),
      cache: "no-store",
      credentials: "same-origin",
      // A page that is going still gets its last word out
      keepalive: closing,
    }).catch(() => {});
  };
  const onHide = (): void => beat(true);
  const onShow = (e: PageTransitionEvent): void => {
    // Back from the browser's page cache: open again
    if (e.persisted) beat(false);
  };
  void launcherPresence().then((p) => {
    if (stopped || p === "none") return;
    beat(false);
    timer = window.setInterval(() => beat(false), HEARTBEAT_MS);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
  });
  return () => {
    stopped = true;
    window.clearInterval(timer);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
}
