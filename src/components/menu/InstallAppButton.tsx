"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons";
import { isTouchDevice } from "@/lib/input/touch-input";
import { installStore, isAppleTouch, isInstalledApp, promptInstall } from "@/lib/install-app";
import { isFramed } from "./EmbeddedBadge";

const HIDDEN_KEY = "librecorsa.install-hint";

const APPLE_STEPS = {
  title: "Add LibreCorsa to your Home Screen",
  body: "Opened from there, it runs full screen without the browser's bars. Tap Share, then Add to Home Screen. If you can't see Share, it's in the menu behind the three dots. The Home Screen app keeps its own settings and laps, apart from the browser's.",
};
const OTHER_STEPS = {
  title: "Install LibreCorsa",
  body: "Installed, it opens full screen without the browser's bars. Open the browser's menu and choose Install app or Add to Home screen.",
};

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
  const steps = apple ? APPLE_STEPS : OTHER_STEPS;

  return (
    <>
      <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={install}>
        Install app
      </Button>
      <ConfirmDialog
        open={explaining}
        tone="info"
        title={steps.title}
        confirmLabel="Got it"
        cancelLabel="Don't show again"
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
