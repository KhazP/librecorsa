"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { isDualSensePadId } from "@/lib/input/dualsense-protocol";
import { dualSenseHid } from "@/lib/input/webhid-dualsense";
import { useGamepads } from "@/components/menu/useMenuNav";
import { Button } from "@/components/ui";

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
  const tx = useTranslations("hud.dualSensePairPrompt");
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
      className="lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-50 flex w-fit items-center gap-3 rounded-lc-row border border-lc-line bg-lc-carbon/95 py-2 pe-2 ps-4 text-[13px] text-lc-chalk shadow-lc-pop"
    >
      <span className="min-w-0">
        {tx.rich("text", { b: (chunks) => <b className="font-semibold text-lc-volt">{chunks}</b> })}
      </span>
      <Button
        size="sm"
        variant="primary"
        // requestDevice needs this click's user activation, so it runs inside the handler
        onClick={() => void dualSenseHid.connect()}
      >
        {tx("pair")}
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        {tx("dismiss")}
      </Button>
    </div>
  );
}
