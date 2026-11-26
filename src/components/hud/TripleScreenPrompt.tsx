"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { looksLikeTriple } from "@/lib/display/screen-layout";
import { Button } from "@/components/ui";

const DISMISSED_KEY = "librecorsa.triple-prompt";

/**
 * On a window the shape of three screens side by side (NVIDIA Surround, AMD Eyefinity, or a window stretched across
 * three) while the game still draws one picture across them: offers Settings > Display > Screens once, where each
 * screen gets its own view. "Not now" is remembered; choosing three screens ends it too.
 */
export function TripleScreenPrompt({ wanted, onSetUp }: { wanted: boolean; onSetUp: () => void }) {
  const [dismissed, setDismissed] = useState(true);
  const [wide, setWide] = useState(false);
  const tx = useTranslations("hud.tripleScreenPrompt");
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      setDismissed(false);
    }
    const read = () => setWide(looksLikeTriple(window.innerWidth, window.innerHeight));
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  if (!wanted || dismissed || !wide) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Storage unavailable: offered again next visit
    }
  };
  return (
    <div
      role="dialog"
      aria-label={tx("label")}
      className="lc-ui-zoom pointer-events-auto fixed bottom-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] mx-auto z-50 flex w-fit items-center gap-3 rounded-lc-row border border-lc-line bg-lc-carbon/95 py-2 pe-2 ps-4 text-[13px] text-lc-chalk shadow-lc-pop"
    >
      <span className="min-w-0">{tx.rich("text", { b: (chunks) => <b className="font-semibold text-lc-volt">{chunks}</b> })}</span>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          dismiss();
          onSetUp();
        }}
      >
        {tx("setUp")}
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        {tx("dismiss")}
      </Button>
    </div>
  );
}
