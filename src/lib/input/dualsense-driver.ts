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

  update(telemetry: CarTelemetry, dtS: number, options: DualSenseDriveOptions): void {
    const usb = dualSenseHid.transportNow() === "usb";
    const wantHaptics = options.settings.hdHaptics && usb;
    const state = dualSenseAudioHaptics.getStatus().state;
    if (!wantHaptics) {
      this.gaveUp = false;
      this.wanted = false;
      if (state === "on") void dualSenseAudioHaptics.stop();
    } else if (!dualSenseAudioHaptics.running() && state !== "starting") {
      // Just back on (the setting, or the pad on USB again): one try straight away, even over an old error
      const fresh = !this.wanted;
      this.wanted = true;
      if (fresh) this.retryAtMs = 0;
      // An error left by a start the player asked for (in Settings) keeps its message: no silent try over it
      else if (state === "error") this.gaveUp = true;
      // Granted on an earlier visit: the browser lists the pad again without asking
      const now = Date.now();
      if (!this.gaveUp && now >= this.retryAtMs) {
        this.retryAtMs = now + HAPTICS_RETRY_MS;
        // A silent try that fails with a reason (not just "pad not listed yet") stops the tries, read from its own result
        void dualSenseAudioHaptics.start(false).then((ok) => {
          if (!ok && dualSenseAudioHaptics.getStatus().state === "error") this.gaveUp = true;
        });
      }
    } else {
      this.wanted = true;
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
