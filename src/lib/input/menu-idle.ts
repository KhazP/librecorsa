import type { PadLike } from "./device-input";

/** How far a pad axis has to move from where it last rested to count as input (wheels and pedals drift a little) */
const AXIS_MOVE = 0.3;

/**
 * How long the player has left the controls alone: a key, a click or tap, the scroll wheel, or a controller or wheel
 * button or axis. Moving the mouse does not count. The pads are read on edges only, so a button held down, a pedal
 * resting at the end of its travel or a drifting stick is not input.
 */
export class MenuIdleWatch {
  private lastInputMs = 0;
  private inputSeen = false;
  private started = false;
  private readonly pads = new Map<string, { buttons: boolean[]; axes: number[] }>();
  private readonly onInput = () => {
    this.inputSeen = true;
  };

  constructor(private readonly target: Pick<Window, "addEventListener" | "removeEventListener"> | null) {
    target?.addEventListener("keydown", this.onInput, { capture: true, passive: true });
    target?.addEventListener("pointerdown", this.onInput, { capture: true, passive: true });
    target?.addEventListener("wheel", this.onInput, { capture: true, passive: true });
  }

  /** Starts the clock over (entering the screen) */
  reset(nowMs: number): void {
    this.lastInputMs = nowMs;
    this.inputSeen = false;
    this.started = true;
  }

  /** Reads the pads (once a frame) and returns how long it has been since the last input, in ms */
  idleMs(nowMs: number, pads: readonly PadLike[]): number {
    if (!this.started) this.reset(nowMs);
    for (const p of pads) {
      // Keyed by slot and name: two of the same pad must not share one record
      const key = `${p.index}:${p.id}`;
      const was = this.pads.get(key);
      const buttons = p.buttons.map((b) => b.pressed);
      if (!was) {
        // A pad that just connected (or was first seen) sets where its axes rest. A browser shows a pad only once one
        // of its buttons is pressed, so a button already down on it is that press
        if (buttons.some(Boolean)) this.inputSeen = true;
        this.pads.set(key, { buttons, axes: [...p.axes] });
        continue;
      }
      for (let i = 0; i < buttons.length; i++) if (buttons[i] && !was.buttons[i]) this.inputSeen = true;
      was.buttons = buttons;
      for (let i = 0; i < p.axes.length; i++) {
        const rest = was.axes[i];
        if (rest === undefined || Math.abs(p.axes[i] - rest) > AXIS_MOVE) {
          if (rest !== undefined) this.inputSeen = true;
          was.axes[i] = p.axes[i];
        }
      }
    }
    if (this.inputSeen) {
      this.inputSeen = false;
      this.lastInputMs = nowMs;
    }
    return nowMs - this.lastInputMs;
  }

  dispose(): void {
    this.target?.removeEventListener("keydown", this.onInput, { capture: true });
    this.target?.removeEventListener("pointerdown", this.onInput, { capture: true });
    this.target?.removeEventListener("wheel", this.onInput, { capture: true });
  }
}
