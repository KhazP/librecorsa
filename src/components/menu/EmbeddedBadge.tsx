"use client";

import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";
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
    <a
      href={`${SITE_URL}/play`}
      target="_blank"
      rel="noopener noreferrer"
      title={`Full screen, wheels and your saves work best on ${SITE_HOST}`}
      className="inline-flex h-8 max-w-full min-w-0 items-center gap-2 rounded-full border border-[#00E5FF]/45 bg-[#00E5FF]/10 px-3.5 text-[12px] font-bold text-[#F5F7FA] no-underline outline-none backdrop-blur transition-[background-color,border-color,color] duration-200 hover:border-[#CCFF00] hover:bg-[#CCFF00] hover:text-[#08090D] focus:border-[#CCFF00] focus:bg-[#CCFF00] focus:text-[#08090D]"
    >
      <span className="truncate">Play full screen on {SITE_HOST}</span>
      <ExternalLink aria-hidden className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
    </a>
  );
};
