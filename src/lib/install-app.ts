import { isTouchDevice } from "@/lib/input/touch-input";

/**
 * Installing the game on a phone or tablet. In a browser tab the address bar and tab strip take a good part of a
 * landscape screen; opened from the Home Screen the game runs full screen (the manifest asks for fullscreen,
 * landscape). Safari has no install prompt, so iPhone and iPad players are told the steps; Android Chrome offers its
 * prompt once per page load (`beforeinstallprompt`), which is kept here for the title screen's Install app button.
 */

/** Chrome's install prompt event, not in the DOM types */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface InstallState {
  /** The browser offered its install prompt and it has not been shown yet */
  canPrompt: boolean;
  /** The game was installed during this visit */
  installed: boolean;
}

// One object per state: useSyncExternalStore compares snapshots by identity
const SERVER_STATE: InstallState = { canPrompt: false, installed: false };
let state: InstallState = SERVER_STATE;
let kept: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function update(next: Partial<InstallState>): void {
  const merged = { ...state, ...next };
  if (merged.canPrompt === state.canPrompt && merged.installed === state.installed) return;
  state = merged;
  for (const fn of listeners) fn();
}

// At import: the prompt event fires once per page load, often before any menu is drawn
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // A desktop browser keeps its own install button in the address bar; only phones and tablets get ours
    if (!isTouchDevice()) return;
    e.preventDefault();
    kept = e as BeforeInstallPromptEvent;
    update({ canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    kept = null;
    update({ canPrompt: false, installed: true });
  });
}

/** The install state for `useSyncExternalStore` */
export const installStore = {
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: (): InstallState => state,
  getServerSnapshot: (): InstallState => SERVER_STATE,
};

/**
 * Shows the browser's own install prompt; true when the player accepts. Call it inside the tap's handler, before
 * anything is awaited: the prompt needs that tap's user activation. A kept prompt shows once only.
 */
export async function promptInstall(): Promise<boolean> {
  const e = kept;
  if (!e) return false;
  kept = null;
  update({ canPrompt: false });
  try {
    await e.prompt();
    return (await e.userChoice).outcome === "accepted";
  } catch {
    return false;
  }
}

/** What the page can tell about how it was opened */
export interface DisplayFacts {
  /** Safari's `navigator.standalone`: opened from the Home Screen */
  standalone?: boolean;
  /** Whether `(display-mode: <mode>)` matches */
  displayMode: (mode: "standalone" | "minimal-ui" | "fullscreen") => boolean;
  /** The Fullscreen API has an element full screen (`document.fullscreenElement`) */
  elementFullscreen: boolean;
}

/**
 * Opened as an installed app. Chrome also reports `display-mode: fullscreen` for a tab the Fullscreen API made full
 * screen (the loading screen does that on touch screens), so fullscreen counts only without a fullscreen element.
 * A desktop browser in F11 reads as installed too; the callers ask only on touch screens.
 */
export function installedFrom(facts: DisplayFacts): boolean {
  if (facts.standalone === true) return true;
  if (facts.displayMode("standalone") || facts.displayMode("minimal-ui")) return true;
  return facts.displayMode("fullscreen") && !facts.elementFullscreen;
}

export function isInstalledApp(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return installedFrom({
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayMode: (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    elementFullscreen: Boolean(document.fullscreenElement),
  });
}

/** An iPhone, iPad or iPod. iPadOS Safari asks for the desktop site with a Mac user agent; touch points give it away */
export function isAppleTouchAgent(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function isAppleTouch(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAppleTouchAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/**
 * Takes a phone or tablet tab full screen and holds it in landscape, to be called inside a tap. Android browsers and
 * iPad Safari do it; iPhone Safari has no element fullscreen, and without the tap's user activation (a controller
 * press) the browser refuses. Either way the game carries on in the tab, so every failure is swallowed.
 */
export function enterFullscreenOnTouch(): void {
  try {
    if (typeof document === "undefined" || !document.fullscreenEnabled || document.fullscreenElement) return;
    if (!isTouchDevice() || isInstalledApp()) return;
    void Promise.resolve(document.documentElement.requestFullscreen({ navigationUI: "hide" }))
      .then(() => {
        // Not in the DOM types: only Chrome on Android has it, and only while full screen
        const orientation = screen.orientation as (ScreenOrientation & { lock?: (o: "landscape") => Promise<void> }) | undefined;
        return orientation?.lock?.("landscape");
      })
      .catch(() => {
        // Refused or not supported: the tab stays as it is
      });
  } catch {
    // An older browser without the promise form: the tab stays as it is
  }
}
