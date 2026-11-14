"use client";

import React from "react";
import { drsBeeps, masterVolume, mute, shiftBeep } from "../defs";
import { SettingsCard } from "../fields";

/** Settings > Audio: one master volume for every sound, a saved mute, and the cockpit cues */
export function AudioPane() {
  return (
    <>
      <SettingsCard title="Sound" rows={[masterVolume, mute]} first />
      <SettingsCard title="Cockpit cues" rows={[drsBeeps, shiftBeep]} />
    </>
  );
}
