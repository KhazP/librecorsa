"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import type { MusicPool } from "@/lib/audio/music-catalog";
import { drsBeeps, kerbVolume, masterVolume, menuMusic, musicOn, musicTrackRows, mute, raceMusic, raceMusicOn, replayMusic, shiftBeep } from "../defs";
import { SettingsCard } from "../fields";

const POOLS: readonly MusicPool[] = ["menu", "race", "results"];
const TRACK_ROWS = Object.fromEntries(POOLS.map((p) => [p, musicTrackRows(p)])) as Record<MusicPool, ReturnType<typeof musicTrackRows>>;
const POOL_TITLE = { menu: "menuTracks", race: "raceTracks", results: "resultsTracks" } as const satisfies Record<MusicPool, string>;

/**
 * Settings > Audio: one master volume for every sound, the kerbs' own level, a saved mute, the music's level in each
 * part of the game (and, in Advanced, a switch per track), and the cockpit cues
 */
export function AudioPane() {
  const tx = useTranslations("settings.audio");
  return (
    <>
      <SettingsCard title={tx("sound")} rows={[masterVolume, kerbVolume, mute]} first />
      <SettingsCard title={tx("music")} rows={[musicOn, menuMusic, raceMusicOn, raceMusic, replayMusic]} />
      {POOLS.map((pool) => (
        <SettingsCard key={pool} title={tx(POOL_TITLE[pool])} rows={TRACK_ROWS[pool]} />
      ))}
      <SettingsCard title={tx("cockpitCues")} rows={[drsBeeps, shiftBeep]} />
    </>
  );
}
