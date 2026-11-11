"use client";

import React from "react";
import { Play } from "lucide-react";
import { PLAY_HREF, rememberPicks } from "./play";

/**
 * The volt control in the home page's header: a link into the game. The circuit and car picked on the page are
 * remembered just before the link is followed, so the game opens on them.
 */
export const PlayLink: React.FC<
  {
    label: string;
    picks?: { trackId?: string; carId?: string };
    ref?: React.Ref<HTMLAnchorElement>;
  } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">
> = ({ label, picks, className = "", onClick, ...rest }) => (
  <a
    {...rest}
    href={PLAY_HREF}
    onClick={(e) => {
      if (picks) rememberPicks(picks);
      onClick?.(e);
    }}
    className={`lc-disp inline-flex h-12 shrink-0 items-center justify-center gap-2.5 rounded-full bg-[#CCFF00] px-6 text-[18px] whitespace-nowrap text-[#08090D] no-underline transition-[transform,background-color] duration-150 ease-out hover:bg-[#B5E300] active:scale-[0.97] motion-reduce:active:scale-100 ${className}`}
  >
    <Play aria-hidden className="h-4 w-4 shrink-0" fill="currentColor" strokeWidth={0} />
    {label}
  </a>
);
