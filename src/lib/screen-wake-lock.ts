/**
 * Keeps the device screen awake via the Web Screen Wake Lock API (`navigator.wakeLock`) while actively driving, so
 * tilt steering or gamepad/wheel sessions without touch input never dim or lock the display (including inside the
 * Android TWA, where `LauncherActivity`'s window flags only cover the transient splash trampoline).
 */

export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
  removeEventListener?(type: "release", listener: () => void): void;
}

export interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface WakeLockDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Pure policy: hold the screen wake lock only while actively driving in a visible tab. */
export function shouldHoldWakeLock(state: { driving: boolean; visible: boolean }): boolean {
  return state.driving && state.visible;
}

/** Cooldown between automatic re-acquire attempts after a transient rejection or OS-initiated revocation (ms). */
const RETRY_COOLDOWN_MS = 2000;

export class ScreenWakeLock {
  private readonly api: WakeLockApiLike | null;
  private readonly doc: WakeLockDocumentLike | null;
  private readonly nowMs: () => number;
  private sentinel: WakeLockSentinelLike | null = null;
  private requesting = false;
  private desired = false;
  private disposed = false;
  private nextRetryAtMs = -Infinity;

  private readonly onSentinelRelease = () => {
    this.sentinel = null;
    if (!this.disposed && this.desired) {
      this.nextRetryAtMs = this.nowMs() + RETRY_COOLDOWN_MS;
    }
  };

  private readonly onVisibilityChange = () => {
    if (this.isVisible()) this.nextRetryAtMs = -Infinity;
    this.sync();
  };

  constructor(
    api?: WakeLockApiLike | null,
    doc?: WakeLockDocumentLike | null,
    nowMs: () => number = () => Date.now()
  ) {
    this.api =
      api !== undefined
        ? api
        : typeof navigator !== "undefined" && "wakeLock" in navigator && navigator.wakeLock
          ? (navigator.wakeLock as unknown as WakeLockApiLike)
          : null;
    this.doc =
      doc !== undefined
        ? doc
        : typeof document !== "undefined"
          ? document
          : null;
    this.nowMs = nowMs;
    this.doc?.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /** Whether a wake lock sentinel is currently held. */
  get active(): boolean {
    return this.sentinel !== null && this.sentinel.released !== true;
  }

  /** Update whether the session wants the screen kept awake (true while driving, false in menus/pause/replay). */
  setDesired(driving: boolean): void {
    if (this.disposed) return;
    if (this.desired === driving) {
      // Allow throttled recovery if a previous request rejected or the OS revoked the sentinel while still driving
      if (driving && !this.active && !this.requesting && this.nowMs() >= this.nextRetryAtMs) {
        this.sync();
      }
      return;
    }
    this.desired = driving;
    if (driving) this.nextRetryAtMs = -Infinity;
    this.sync();
  }

  /** Release any held wake lock and detach listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.desired = false;
    this.doc?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.releaseNow();
  }

  private isVisible(): boolean {
    return this.doc ? this.doc.visibilityState === "visible" : true;
  }

  private sync(): void {
    if (this.disposed || !this.api) return;
    const want = shouldHoldWakeLock({ driving: this.desired, visible: this.isVisible() });
    if (want) {
      if (this.active || this.requesting) return;
      this.requesting = true;
      void this.api
        .request("screen")
        .then((s) => {
          this.requesting = false;
          if (this.disposed || !shouldHoldWakeLock({ driving: this.desired, visible: this.isVisible() })) {
            void s.release().catch(() => {});
            return;
          }
          this.sentinel = s;
          s.addEventListener("release", this.onSentinelRelease);
        })
        .catch(() => {
          this.requesting = false;
          this.nextRetryAtMs = this.nowMs() + RETRY_COOLDOWN_MS;
        });
    } else {
      this.releaseNow();
    }
  }

  private releaseNow(): void {
    const current = this.sentinel;
    this.sentinel = null;
    if (!current) return;
    current.removeEventListener?.("release", this.onSentinelRelease);
    void current.release().catch(() => {});
  }
}
