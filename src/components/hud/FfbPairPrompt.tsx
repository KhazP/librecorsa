"use client";

import { useState, useSyncExternalStore } from "react";
import { webHidFfb } from "@/lib/input/wheel-ffb";

/**
 * Asks once for the click WebHID pairing needs. Wheel auto-setup switches browser force feedback on, but the
 * browser only lets a page open a HID device from inside a click, so without this the wheel stays silent and
 * nothing says why. Shown while force feedback over WebHID is wanted, a wheel is bound and none is paired.
 */
export function FfbPairPrompt({ wanted }: { wanted: boolean }) {
  const status = useSyncExternalStore(webHidFfb.subscribe, webHidFfb.getStatus, webHidFfb.getStatus);
  const [dismissed, setDismissed] = useState(false);
  if (!wanted || dismissed || status.state !== "idle") return null;
  return (
    <div
      role="dialog"
      aria-label="Force feedback"
      className="lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-50 flex w-fit items-center gap-3 rounded-full border border-[#262B3D] bg-[#0E1016]/95 py-2 pr-2 pl-5 text-[13px] text-[#F5F7FA] shadow-[0_10px_30px_rgba(0,0,0,0.45)]"
    >
      <span className="min-w-0">
        <b className="font-bold text-[#CCFF00]">Force feedback</b> needs your wheel picked once in the browser
      </span>
      <button
        type="button"
        // requestDevice needs this click's user activation, so it runs inside the handler
        onClick={() => void webHidFfb.connect()}
        className="shrink-0 cursor-pointer rounded-full border-0 bg-[#CCFF00] px-4 py-2 font-bold text-[#08090D]"
      >
        Connect wheel
      </button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-3 py-2 text-[#8E96AA] hover:text-[#F5F7FA]"
      >
        Not now
      </button>
    </div>
  );
}
