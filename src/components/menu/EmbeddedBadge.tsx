"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { SITE_URL } from "@/lib/site";

const SITE_HOST = new URL(SITE_URL).host;

// Being framed never changes while the page is open
const subscribe = () => () => {};

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Shown only when another site has put the game in a frame: there, full screen and wheels are usually blocked and
 * saves are kept apart from the real site, so it points players to the full game.
 */
export const EmbeddedBadge: React.FC = () => {
  const framed = useSyncExternalStore(subscribe, isFramed, () => false);
  if (!framed) return null;
  return (
    <Button
      href={`${SITE_URL}/play`}
      native
      target="_blank"
      rel="noopener noreferrer"
      size="sm"
      variant="secondary"
      icon={<Icon name="externalLink" />}
      title={`Full screen, wheels and your saves work best on ${SITE_HOST}`}
      className="max-w-full"
    >
      <span className="truncate">Play full screen on {SITE_HOST}</span>
    </Button>
  );
};
