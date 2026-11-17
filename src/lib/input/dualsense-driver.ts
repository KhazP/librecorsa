import type { CarTelemetry } from "@/types/f1";
import type { DualSenseSettings } from "@/lib/settings/player-settings";
import { DualSenseFeedback } from "@/lib/sim/dualsense-feedback";
import { dualSenseAudioHaptics } from "./dualsense-audio-haptics";
import { dualSenseHid } from "./webhid-dualsense";

/** How often a wanted but stopped HD haptics synth is tried again without a prompt (ms) */
const HAPTICS_RETRY_MS = 5000;

export interface DualSenseDriveOptions {
  driving: boolean;
  rumbleOn: boolean;
  settings: DualSenseSettings;
  triggerSlipAlwaysOn: boolean;
  /** False with stick pedals: the triggers shift gears and stay free */
  triggerPedals?: boolean;
  driverColor: string;
  vehicle?: string;
}

/**
 * Drives a paired DualSense from the frame loop: the triggers, rumble and lights over WebHID, and the HD haptics synth
 * over USB audio when the player turned it on. Does nothing while no DualSense is paired.
 */
export class DualSenseDriver {
  private readonly feedback = new DualSenseFeedback();
  private retryAtMs = 0;
  /** A start failed with a reason: no silent retries (they would wipe the message) until the setting goes off again */
  private gaveUp = false;
  /** HD haptics were wanted last frame (the setting on, the pad on USB) */
  private wanted = false;
  /** Counts the driver's silent tries; going unwanted bumps it too, so a try that answers after that is ignored */
  private startGen = 0;
  /** Haptics went unwanted while a start was in flight: once that start ends, the next one counts as just back on */
  private cycledDuringStart = false;

  update(telemetry: CarTelemetry, dtS: number, options: DualSenseDriveOptions): void {
    const usb = dualSenseHid.transportNow() === "usb";
    const wantHaptics = options.settings.hdHaptics && usb;
    const state = dualSenseAudioHaptics.getStatus().state;
    if (!wantHaptics) {
      this.gaveUp = false;
      this.wanted = false;
      this.startGen++;
      if (state === "starting") this.cycledDuringStart = true;
      if (state === "on") void dualSenseAudioHaptics.stop();
    } else if (!dualSenseAudioHaptics.running() && state !== "starting") {
      // Just back on (the setting, or the pad on USB again), also when that happened while a start was still in
      // flight: one try straight away, even over an old error
      const fresh = !this.wanted || this.cycledDuringStart;
      this.cycledDuringStart = false;
      this.wanted = true;
      if (fresh) this.retryAtMs = 0;
      // An error left by a start the player asked for (in Settings) keeps its message: no silent try over it
      else if (state === "error") this.gaveUp = true;
      // Granted on an earlier visit: the browser lists the pad again without asking
      const now = Date.now();
      if (!this.gaveUp && now >= this.retryAtMs) {
        this.retryAtMs = now + HAPTICS_RETRY_MS;
        // A silent try that fails with a reason (not just "pad not listed yet") stops the tries, read from its own result,
        // unless haptics went unwanted while it was in flight (its failure belongs to the earlier wish)
        const gen = ++this.startGen;
        void dualSenseAudioHaptics.start(false).then((ok) => {
          if (gen === this.startGen && !ok && dualSenseAudioHaptics.getStatus().state === "error") this.gaveUp = true;
        });
      }
    } else {
      this.wanted = true;
      // Running: the start in flight through the cycle answered, so nothing is owed a fresh try any more
      if (state !== "starting") this.cycledDuringStart = false;
    }
    if (!dualSenseHid.connected()) return;
    const hdHaptics = wantHaptics && dualSenseAudioHaptics.running();
    const frame = this.feedback.frame({ telemetry, dtS, hdHaptics, ...options });
    dualSenseHid.setOutput(frame.output);
    if (hdHaptics) {
      dualSenseAudioHaptics.update(frame.haptics);
      if (frame.shift) dualSenseAudioHaptics.pulse("both", 0.035, 110, 0.5 * options.settings.hapticStrength);
    }
  }

  /** Motors and haptics still, triggers free (pause, the menus, leaving the page) */
  stop(): void {
    this.feedback.reset();
    dualSenseHid.quiet();
    dualSenseAudioHaptics.silence();
  }
}
