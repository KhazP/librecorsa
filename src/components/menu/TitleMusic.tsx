"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import type { NowPlaying } from "@/lib/audio/bgm-controller";
import { IconButton } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";

export interface TitleMusicProps {
  nowPlaying: NowPlaying | null;
  musicMuted: boolean;
  onSkip?: () => void;
  onToggleMute: () => void;
}

/**
 * The title screen's music, at the right of its footer: the track playing (title, composer), the skip, and the music's
 * own switch (every other sound plays on). Hidden until there is a track, or while the music is switched off.
 */
export function TitleMusic({ nowPlaying, musicMuted, onSkip, onToggleMute }: TitleMusicProps) {
  const tx = useTranslations("menu.music");
  if (!nowPlaying && !musicMuted) return null;
  return (
    <div className="flex min-w-0 items-center gap-1" data-nav-zone="music" role="group" aria-label={tx("group")}>
      <span aria-hidden className="me-1 inline-flex shrink-0 text-lc-slate">
        <Icon name="music" size="sm" />
      </span>
      <span className="me-1.5 flex min-w-0 max-w-[340px] items-baseline gap-2 text-[13px] leading-snug" aria-live="polite">
        {musicMuted || !nowPlaying ? (
          <span className="text-lc-slate">{tx("off")}</span>
        ) : (
          <>
            <span className="truncate font-semibold text-lc-fog" title={`${nowPlaying.title}, ${nowPlaying.composer}`}>
              {nowPlaying.title}
            </span>
            <span className="shrink-0 text-lc-slate max-sm:hidden">{nowPlaying.composer}</span>
          </>
        )}
      </span>
      {onSkip && nowPlaying && !musicMuted ? (
        <IconButton size="sm" aria-label={tx("next")} title={tx("next")} icon={<Icon name="skip" />} onClick={onSkip} />
      ) : null}
      <IconButton
        size="sm"
        aria-label={musicMuted ? tx("turnOn") : tx("turnOff")}
        aria-pressed={musicMuted}
        title={musicMuted ? tx("titleOn") : tx("titleOff")}
        icon={<Icon name={musicMuted ? "mute" : "volume"} />}
        onClick={onToggleMute}
      />
    </div>
  );
}
