"use client";
/**
 * Whether a visitor has read the latest What's new notes (src/lib/home/whats-new.json). The home page's What's new tab
 * and the title menu's What's new panel share one stored fingerprint, so reading the notes in either place clears the
 * mark in both.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { WhatsNewDay } from "@/components/home/home-data";

/** The What's new feed the visitor last opened (its fingerprint), so a new or updated day lights the mark again */
export const WHATS_NEW_SEEN_KEY = "librecorsa.whatsNewSeen";

/** A short fingerprint of the patch notes: any new or updated day changes it */
export function whatsNewFingerprint(days: readonly WhatsNewDay[]): string {
  if (days.length === 0) return "";
  const input = days.map((d) => `${d.date}:${d.lastSha}`).join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The notes behind this fingerprint have not been opened here (storage unavailable counts as not opened) */
export function whatsNewUnseen(token: string): boolean {
  if (!token) return false;
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY) !== token;
  } catch {
    return true;
  }
}

/** Marks the notes behind this fingerprint as read */
export function markWhatsNewSeen(token: string): void {
  if (!token) return;
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, token);
  } catch {
    // Storage unavailable: the mark stays off for this visit
  }
}

/**
 * The notes for a page that does not ship them in its HTML (the game's title menu): loaded after mount as a chunk of
 * their own, so the notes never delay the game. `days` is null until they arrive and empty if they can't load
 * (offline before the chunk was cached).
 */
export function useWhatsNewNotes(): { days: readonly WhatsNewDay[] | null; unseen: boolean; markSeen: () => void } {
  const [days, setDays] = useState<readonly WhatsNewDay[] | null>(null);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    let live = true;
    import("@/lib/home/whats-new.json")
      .then((m) => live && setDays(m.default as WhatsNewDay[]))
      .catch(() => live && setDays([]));
    return () => {
      live = false;
    };
  }, []);
  const token = useMemo(() => (days ? whatsNewFingerprint(days) : ""), [days]);
  useEffect(() => {
    setUnseen(whatsNewUnseen(token));
    // Read on the home page in another tab: the mark goes out here too
    const onStorage = (e: StorageEvent) => {
      if (e.key === WHATS_NEW_SEEN_KEY || e.key === null) setUnseen(whatsNewUnseen(token));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [token]);
  const markSeen = useCallback(() => {
    if (!token) return;
    setUnseen(false);
    markWhatsNewSeen(token);
  }, [token]);
  return { days, unseen, markSeen };
}
