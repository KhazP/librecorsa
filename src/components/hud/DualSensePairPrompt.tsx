"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isDualSensePadId } from "@/lib/input/dualsense-protocol";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { useGamepads } from "@/components/menu/useMenuNav";

const DISMISSED_KEY = "librecorsa.dualsense-prompt";

/**
 * Offers the one click WebHID pairing needs when a DualSense is plugged in and not paired yet: without it the pad only
 * gets the browser's rumble, with no adaptive triggers, haptics or lights. "Not now" is remembered.
 */
export function DualSensePairPrompt({ wanted }: { wanted: boolean }) {
  const status = useSyncExternalStore(dualSenseHid.subscribe, dualSenseHid.getStatus, dualSenseHid.getStatus);
  const pads = useGamepads(wanted);
  const [dismissed, setDismissed] = useState(true);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(dualSenseHid.supported());
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);
  const seen = pads.some((p) => isDualSensePadId(p.id));
  if (!wanted || dismissed || !supported || !seen || status.state === "connected" || status.state === "connecting") return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: asked again next visit
    }
  };
  return (
    <div
      role="dialog"
      aria-label="DualSense"
      className="lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-50 flex w-fit items-center gap-3 rounded-full border border-lc-line bg-lc-carbon/95 py-2 pr-2 pl-5 text-[13px] text-lc-chalk shadow-lc-pop"
    >
      <span className="min-w-0">
        <b className="font-bold text-lc-volt">DualSense found.</b> Pair it for adaptive triggers, haptics and rev lights
      </span>
      <button
        type="button"
        // requestDevice needs this click's user activation, so it runs inside the handler
        onClick={() => void dualSenseHid.connect()}
        className="shrink-0 cursor-pointer rounded-full border-0 bg-lc-volt px-4 py-2 font-bold text-lc-void"
      >
        Pair
      </button>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 cursor-pointer rounded-full border-0 bg-transparent px-3 py-2 text-lc-slate hover:text-lc-chalk"
      >
        Not now
      </button>
    </div>
  );
}
