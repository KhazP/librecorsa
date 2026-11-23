"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";
import { isTouchDevice } from "@/lib/input/touch-input";
import { installStore, isAppleTouch, isInstalledApp, promptInstall } from "@/lib/install-app";
import { isFramed } from "./EmbeddedBadge";

const HIDDEN_KEY = "librecorsa.install-hint";

/**
 * Offers to install the game on a phone or tablet, where a browser tab gives a good part of the screen to the address
 * bar and tabs. Android Chrome shows its own install prompt; Safari has none, so it explains the Home Screen steps,
 * as it does in any browser whose prompt isn't available. Hidden once installed, inside another site's frame, and for
 * good after "Don't show again".
 */
export const InstallAppButton: React.FC = () => {
  const { canPrompt, installed } = useSyncExternalStore(
    installStore.subscribe,
    installStore.getSnapshot,
    installStore.getServerSnapshot,
  );
  // Read after mount: the page is prerendered without a device, and the button stays out until it's known
  const [offered, setOffered] = useState(false);
  const [apple, setApple] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const tx = useTranslations("menu.install");
  useEffect(() => {
    let hidden = false;
    try {
      hidden = localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      // Storage unavailable: offered again next visit
    }
    setApple(isAppleTouch());
    setOffered(!hidden && isTouchDevice() && !isInstalledApp() && !isFramed());
  }, []);
  if (!offered || installed) return null;

  const install = () => {
    if (canPrompt && !apple) {
      // The browser's prompt needs this tap's user activation, so it is asked for here, before anything is awaited
      void promptInstall();
      return;
    }
    setExplaining(true);
  };
  const hideForGood = () => {
    setExplaining(false);
    setOffered(false);
    try {
      localStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      // Storage unavailable: offered again next visit
    }
  };
  const steps = apple ? { title: tx("appleTitle"), body: tx("appleBody") } : { title: tx("otherTitle"), body: tx("otherBody") };

  return (
    <>
      <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={install}>
        {tx("button")}
      </Button>
      <ConfirmDialog
        open={explaining}
        tone="info"
        title={steps.title}
        confirmLabel={tx("gotIt")}
        cancelLabel={tx("hide")}
        icon={<Icon name="touch" size="lg" />}
        onConfirm={() => setExplaining(false)}
        onCancel={hideForGood}
        // Esc, B and a tap beside the sheet only close it: hiding the button for good takes its own press
        onDismiss={() => setExplaining(false)}
      >
        {steps.body}
      </ConfirmDialog>
    </>
  );
};
