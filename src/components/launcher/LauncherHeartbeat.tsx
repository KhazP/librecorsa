"use client";

import { useEffect } from "react";
import { startLauncherHeartbeat } from "@/lib/mods/launcher-imports";

/**
 * Tells the offline launcher (the desktop app) that this page of the game is open, so it quits once none is
 * (launcher/lifetime.go). Nothing anywhere else: the game on the web never asks.
 */
export function LauncherHeartbeat(): null {
  useEffect(() => startLauncherHeartbeat(), []);
  return null;
}
