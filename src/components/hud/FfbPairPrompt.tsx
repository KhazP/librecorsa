"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
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
  const tx = useTranslations("hud.ffbPairPrompt");
  if (!wanted || dismissed || status.state !== "idle") return null;
  return (
    <div
      role="dialog"
      aria-label={tx("region")}
      className="lc-ui-zoom pointer-events-auto fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-(--z-lc-menu) mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-3 rounded-lc-row border border-white/10 bg-lc-carbon/95 py-2 pe-2 ps-4 text-lc-chalk shadow-lc-pop"
    >
      <span className="lc-body min-w-0 text-lc-chalk">{tx("text")}</span>
      {/* requestDevice needs this click's user activation, so it runs inside the handler */}
      <Button size="sm" variant="primary" onClick={() => void webHidFfb.connect()}>
        {tx("connect")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
        {tx("dismiss")}
      </Button>
    </div>
  );
}
