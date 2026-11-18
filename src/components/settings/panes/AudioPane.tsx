"use client";

import React from "react";
import { POOL_LABEL, type MusicPool } from "@/lib/audio/music-catalog";
import { drsBeeps, masterVolume, menuMusic, musicOn, musicTrackRows, mute, raceMusic, replayMusic, shiftBeep } from "../defs";
import { SettingsCard } from "../fields";

const POOLS: readonly MusicPool[] = ["menu", "race", "results"];
const TRACK_ROWS = Object.fromEntries(POOLS.map((p) => [p, musicTrackRows(p)])) as Record<MusicPool, ReturnType<typeof musicTrackRows>>;

/**
 * Settings > Audio: one master volume for every sound, a saved mute, the music's level in each part of the game (and,
 * in Advanced, a switch per track), and the cockpit cues
 */
export function AudioPane() {
  return (
    <>
      <SettingsCard title="Sound" rows={[masterVolume, mute]} first />
      <SettingsCard title="Music" rows={[musicOn, menuMusic, raceMusic, replayMusic]} />
      {POOLS.map((pool) => (
        <SettingsCard key={pool} title={`${POOL_LABEL[pool]} tracks`} rows={TRACK_ROWS[pool]} />
      ))}
      <SettingsCard title="Cockpit cues" rows={[drsBeeps, shiftBeep]} />
    </>
  );
}
