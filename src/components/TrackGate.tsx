"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { t as tr } from "@/i18n/runtime";
import { LibreCorsaSimulator } from "@/components/LibreCorsaSimulator";
import { RenderProfiler } from "@/components/dev/RenderProfiler";
import { activateTrack, getTrackInfo, loadStoredTrackId, DEFAULT_TRACK_ID } from "@/lib/track-registry";
import { registerAssetCache } from "@/lib/service-worker";
import { loadMods } from "@/lib/mods/mod-loader";
import { watchForUpdates } from "@/lib/build-update";
import { useLiveHeartbeat } from "@/lib/net/live-heartbeat";
import { Toast } from "@/components/ui";
import { browserStore, takeSafeStart } from "@/lib/render/gpu-health";
import { loadPlayerSettings, savePlayerSettings } from "@/lib/settings/player-settings";

/** How long the "couldn't load" notice stays up (ms) */
const ERROR_NOTICE_MS = 6000;
/** How long the safe-start line stays up (ms) */
const SAFE_START_NOTICE_MS = 9000;

/**
 * The first start after a WebGL context loss the player did not answer (they closed the page on the notice): the
 * saved preset goes to Low once, and the line says why. Null when there is nothing to say.
 */
function applySafeStart(): string | null {
  if (!takeSafeStart(browserStore(), Date.now()).switchToLow) return null;
  const saved = loadPlayerSettings();
  if (saved.graphics.quality === "low") return tr("game.trackGate.safeStart");
  savePlayerSettings({ ...saved, graphics: { ...saved.graphics, quality: "low" } });
  return tr("game.trackGate.graphicsLow");
}

/**
 * Activates the chosen circuit before the simulator mounts, and remounts it (fresh scene, physics and
 * menus) when the player picks another one from the title menu.
 */
export const TrackGate: React.FC = () => {
  // The live count on the title screen: a heartbeat a minute while this page is in view, across circuit reloads
  useLiveHeartbeat();
  const [trackId, setTrackId] = useState<string | null>(null);
  /** The circuit the simulator is mounted on (null before the first load lands) */
  const trackIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [safeStartNotice, setSafeStartNotice] = useState<string | null>(null);
  /** Bumped to mount the circuit again from scratch (a new canvas and WebGL context, after the old one was lost) */
  const [mount, setMount] = useState(0);
  const restart = useCallback(() => setMount((m) => m + 1), []);

  // Only the latest pick counts: a slower load of a circuit picked earlier must not land after it
  const requestRef = useRef(0);
  const select = useCallback(async (id: string) => {
    const req = ++requestRef.current;
    // A new pick replaces the last one's notice
    setError(null);
    try {
      const info = await activateTrack(id);
      if (req !== requestRef.current) return;
      trackIdRef.current = info.id;
      setTrackId(info.id);
    } catch (err) {
      if (req !== requestRef.current) return;
      const current = trackIdRef.current;
      if (current !== null) {
        // A failed load never replaces the active circuit: the one in use stays, as it is
        console.warn(`Track switch failed, staying on ${current}:`, err);
        setError(tr("game.trackGate.loadFailedStaying", { circuit: getTrackInfo(current).name }));
        return;
      }
      // The first load has nothing to stay on: the default circuit ships with the bundle
      console.warn("Track load failed, using the default circuit:", err);
      try {
        await activateTrack(DEFAULT_TRACK_ID);
      } catch (fallbackErr) {
        // This only fails if the bundled circuit is broken too
        console.error("Default circuit fallback failed:", fallbackErr);
      }
      if (req !== requestRef.current) return;
      trackIdRef.current = DEFAULT_TRACK_ID;
      setTrackId(DEFAULT_TRACK_ID);
      setError(tr("game.trackGate.loadFailedDefault", { circuit: getTrackInfo(DEFAULT_TRACK_ID).name }));
    }
  }, []);

  useEffect(() => {
    registerAssetCache();
    // Before the simulator reads the settings
    const notice = applySafeStart();
    if (notice) setSafeStartNotice(notice);
    // The installed mod packages' circuits and cars join the lists first: a stored choice may name one of them
    void loadMods().then(() => select(loadStoredTrackId()));
  }, [select]);

  useEffect(() => {
    if (!safeStartNotice) return;
    const id = window.setTimeout(() => setSafeStartNotice(null), SAFE_START_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [safeStartNotice]);

  // A newer build deployed while the game is open: the menus offer the reload (build-update.ts)
  useEffect(() => watchForUpdates(), []);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), ERROR_NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [error]);

  if (!trackId) return null;
  return (
    <>
      <RenderProfiler id="sim">
        <LibreCorsaSimulator key={`${trackId}:${mount}`} trackId={trackId} onSelectTrack={select} onRestart={restart} />
      </RenderProfiler>
      {/* Over the menus: a failed circuit load is said wherever the player is */}
      <div
        role="alert"
        className="lc-ui-zoom pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-[max(1rem,env(safe-area-inset-left))] z-(--z-lc-notice) mx-auto flex w-fit max-w-[calc(100%-2rem)] justify-center"
      >
        {error ? <Toast tone="bad">{error}</Toast> : null}
      </div>
      {/* At the top: the loading screen's own prompt sits along the bottom */}
      <div
        role="status"
        className="lc-ui-zoom pointer-events-none fixed top-[calc(env(safe-area-inset-top,0px)+1rem)] right-[max(1rem,env(safe-area-inset-right))] left-[max(1rem,env(safe-area-inset-left))] z-(--z-lc-notice) mx-auto flex w-fit max-w-[calc(100%-2rem)] justify-center"
      >
        {safeStartNotice ? <Toast tone="info">{safeStartNotice}</Toast> : null}
      </div>
    </>
  );
};
