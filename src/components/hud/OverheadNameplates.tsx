"use client";

import React, { useEffect, useRef, type MutableRefObject } from "react";
import type { OverheadNameplateEntry, OverheadNameplatesSink } from "@/lib/render/overhead-nameplates";
import { t as tr } from "@/i18n/runtime";
import { perLanguage } from "./hud-format";

const INITIAL_POOL_SIZE = 24;
const MAX_POOL_SIZE = 64;
const ANCHOR_LIFT_PX = 6;

/** The fastest-lap chip and each place's "P3", built once per language: the pool writes them every frame */
const words = perLanguage(() => ({ fastestLap: tr("hud.overheadNameplates.fastestLap"), ranks: new Map<number, string>() }));

function rankLabel(rank: number): string {
  const ranks = words().ranks;
  let text = ranks.get(rank);
  if (text === undefined) {
    text = tr("hud.overheadNameplates.rank", { rank });
    ranks.set(rank, text);
  }
  return text;
}

interface NameplateSlot {
  root: HTMLDivElement;
  rankEl: HTMLSpanElement;
  nameEl: HTMLSpanElement;
  flEl: HTMLSpanElement;
  badgesEl: HTMLSpanElement;
  peerId: string | null;
  visible: boolean;
  seen: boolean;
  transform: string;
  opacity: string;
  zIndex: string;
  podium: string;
  rankText: string;
  rankVisible: boolean;
  label: string;
  fastestLap: boolean;
  fastestLapText: string;
  badgesKey: string;
}

function createSlot(container: HTMLDivElement): NameplateSlot {
  const root = document.createElement("div");
  root.className = "lc-nameplate";
  root.dataset.podium = "none";
  root.style.display = "none";

  const rankEl = document.createElement("span");
  rankEl.className = "lc-nameplate-rank";
  rankEl.style.display = "none";

  const nameEl = document.createElement("span");
  nameEl.className = "lc-nameplate-name";

  const flEl = document.createElement("span");
  flEl.className = "lc-nameplate-fl";
  const fastestLapText = words().fastestLap;
  flEl.textContent = fastestLapText;
  flEl.style.display = "none";

  const badgesEl = document.createElement("span");
  badgesEl.className = "lc-nameplate-badges";
  badgesEl.style.display = "none";

  root.append(rankEl, nameEl, flEl, badgesEl);
  container.appendChild(root);

  return {
    root,
    rankEl,
    nameEl,
    flEl,
    badgesEl,
    peerId: null,
    visible: false,
    seen: false,
    transform: "",
    opacity: "",
    zIndex: "",
    podium: "none",
    rankText: "",
    rankVisible: false,
    label: "",
    fastestLap: false,
    fastestLapText,
    badgesKey: "",
  };
}

function applySlot(slot: NameplateSlot, entry: OverheadNameplateEntry): void {
  if (!slot.visible) {
    slot.root.style.display = "inline-flex";
    slot.visible = true;
  }

  const rx = Math.round(entry.x * 2) / 2;
  const ry = Math.round((entry.y - ANCHOR_LIFT_PX) * 2) / 2;
  const transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -100%)`;
  if (slot.transform !== transform) {
    slot.root.style.transform = transform;
    slot.transform = transform;
  }

  const opacity = entry.opacity >= 0.995 ? "1" : entry.opacity.toFixed(2);
  if (slot.opacity !== opacity) {
    slot.root.style.opacity = opacity;
    slot.opacity = opacity;
  }

  // Closer cars paint on top of farther cars
  const zIndex = String(Math.max(1, 200 - Math.round(entry.distanceM)));
  if (slot.zIndex !== zIndex) {
    slot.root.style.zIndex = zIndex;
    slot.zIndex = zIndex;
  }

  const podium = entry.podium === null ? "none" : String(entry.podium);
  if (slot.podium !== podium) {
    slot.root.dataset.podium = podium;
    slot.podium = podium;
  }

  const rankVisible = entry.rank !== null;
  if (slot.rankVisible !== rankVisible) {
    slot.rankEl.style.display = rankVisible ? "" : "none";
    slot.rankVisible = rankVisible;
  }
  if (entry.rank !== null) {
    const rankText = rankLabel(entry.rank);
    if (slot.rankText !== rankText) {
      slot.rankEl.textContent = rankText;
      slot.rankText = rankText;
    }
  }

  if (slot.label !== entry.label) {
    slot.nameEl.textContent = entry.label;
    slot.label = entry.label;
  }

  if (slot.fastestLap !== entry.fastestLap) {
    slot.flEl.style.display = entry.fastestLap ? "" : "none";
    slot.fastestLap = entry.fastestLap;
  }
  // A change of language reaches a chip already made
  const fastestLapText = words().fastestLap;
  if (slot.fastestLapText !== fastestLapText) {
    slot.flEl.textContent = fastestLapText;
    slot.fastestLapText = fastestLapText;
  }

  const badges = entry.badges;
  const badgesKey = badges && badges.length > 0 ? badges.join("\u001f") : "";
  if (slot.badgesKey !== badgesKey) {
    slot.badgesKey = badgesKey;
    slot.badgesEl.textContent = "";
    if (badges && badges.length > 0) {
      for (let i = 0; i < badges.length; i++) {
        const chip = document.createElement("span");
        chip.className = "lc-nameplate-badge";
        chip.textContent = badges[i];
        slot.badgesEl.appendChild(chip);
      }
      slot.badgesEl.style.display = "";
    } else {
      slot.badgesEl.style.display = "none";
    }
  }
}

function createNameplatePool(container: HTMLDivElement): OverheadNameplatesSink & { dispose(): void } {
  const slots: NameplateSlot[] = [];
  const peerToSlot = new Map<string, number>();
  const unassigned: OverheadNameplateEntry[] = [];
  let activeCount = 0;

  for (let i = 0; i < INITIAL_POOL_SIZE; i++) {
    slots.push(createSlot(container));
  }

  const hideAll = () => {
    if (activeCount === 0) return;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s.visible) {
        s.root.style.display = "none";
        s.visible = false;
      }
      s.seen = false;
      s.peerId = null;
    }
    peerToSlot.clear();
    activeCount = 0;
  };

  const update = (entries: readonly OverheadNameplateEntry[]) => {
    if (entries.length === 0) {
      hideAll();
      return;
    }

    for (let i = 0; i < slots.length; i++) {
      slots[i].seen = false;
    }
    unassigned.length = 0;

    // Pass 1: reuse each peer's sticky slot so textContent/attributes stay untouched across frames
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const existingIdx = peerToSlot.get(entry.peerId);
      if (existingIdx !== undefined) {
        const slot = slots[existingIdx];
        if (!slot.seen) {
          slot.seen = true;
          applySlot(slot, entry);
          continue;
        }
      }
      unassigned.push(entry);
    }

    // Pass 2: assign newly visible peers to free slots (growing lazily up to MAX_POOL_SIZE)
    let searchIdx = 0;
    for (let i = 0; i < unassigned.length; i++) {
      const entry = unassigned[i];
      while (searchIdx < slots.length && slots[searchIdx].seen) searchIdx++;
      let slotIdx = searchIdx;
      if (slotIdx >= slots.length) {
        if (slots.length >= MAX_POOL_SIZE) break;
        slots.push(createSlot(container));
      }
      const slot = slots[slotIdx];
      if (slot.peerId !== null && peerToSlot.get(slot.peerId) === slotIdx) {
        peerToSlot.delete(slot.peerId);
      }
      slot.peerId = entry.peerId;
      slot.seen = true;
      peerToSlot.set(entry.peerId, slotIdx);
      applySlot(slot, entry);
      searchIdx = slotIdx + 1;
    }

    // Pass 3: hide any slots whose peers are no longer visible
    let visibleNow = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.seen) {
        visibleNow++;
      } else if (slot.visible) {
        slot.root.style.display = "none";
        slot.visible = false;
        if (slot.peerId !== null && peerToSlot.get(slot.peerId) === i) {
          peerToSlot.delete(slot.peerId);
        }
        slot.peerId = null;
      }
    }
    activeCount = visibleNow;
  };

  const dispose = () => {
    hideAll();
    slots.length = 0;
    container.textContent = "";
  };

  return { update, hideAll, dispose };
}

/**
 * Mounts the overhead player nameplate layer once; every per-frame update mutates pooled DOM nodes directly
 * through `overlayRef` with zero React re-renders.
 */
export const OverheadNameplates = React.memo(function OverheadNameplates({
  overlayRef,
}: {
  overlayRef: MutableRefObject<OverheadNameplatesSink | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pool = createNameplatePool(container);
    overlayRef.current = pool;
    return () => {
      if (overlayRef.current === pool) overlayRef.current = null;
      pool.dispose();
    };
  }, [overlayRef]);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-(--z-lc-hud) overflow-hidden select-none"
    />
  );
});
