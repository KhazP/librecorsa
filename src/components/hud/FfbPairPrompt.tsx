"use client";

import { useState, useSyncExternalStore } from "react";
import { webHidFfb } from "@/lib/input/wheel-ffb";
import { Button } from "@/components/ui";

/**
 * Asks once for the click browser force feedback needs. Wheel auto-setup switches it on, but the browser only lets a
 * page open a wheel from inside a click, so without this the wheel stays silent and nothing says why. Shown while
 * browser force feedback is wanted, a wheel is bound and none is paired.
 */
export function FfbPairPrompt({ wanted }: { wanted: boolean }) {
  const status = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const [dismissed, setDismissed] = useState(false);
  if (!wanted || dismissed || status.state !== "idle") return null;
  return (
    <div
      role="dialog"
      aria-label="Force feedback"
      className="lc-ui-zoom pointer-events-auto fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-(--z-lc-menu) mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-3 rounded-full border border-white/7 bg-lc-carbon py-2 pr-2 pl-5 text-lc-chalk shadow-lc-pop"
    >
      <span className="lc-body min-w-0 text-lc-chalk">Force feedback needs the wheel picked once in the browser</span>
      {/* requestDevice needs this click's user activation, so it runs inside the handler */}
      <Button size="sm" variant="primary" onClick={() => void webHidFfb.connect()}>
        Connect wheel
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        Not now
      </Button>
    </div>
  );
}
