"use client";

import React, { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { CameraMode } from "@/types/f1";
import { CAMERA_MODES } from "@/lib/render/camera-modes";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_GLASS } from "./hud-format";

const SHOW_MS = 2200;
const FREE_SHOW_MS = 4600;
const LEAVE_MS = 220;

export interface CameraToastProps {
  cameraMode: CameraMode;
  /** Only announce changes while on track or watching a replay (hidden in title/pause menus) */
  active: boolean;
  /** Printed label of the Free camera toggle key (e.g. "F7") */
  freeCameraKey?: string;
}

/**
 * Brief Racing Line glass pill announcing camera mode changes on track and in replays,
 * plus flight control hints when entering Free camera. Uses a persistent `role="status"`
 * live region so assistive technology reliably announces each view switch.
 */
export function CameraToast({ cameraMode, active, freeCameraKey = "F7" }: CameraToastProps) {
  const [shown, setShown] = useState<{ mode: CameraMode; seq: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const prevMode = useRef<CameraMode>(cameraMode);
  const seqRef = useRef(0);
  const tx = useTranslations("hud.cameraToast");

  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = cameraMode;
    if (prev === cameraMode || !active) return;
    seqRef.current += 1;
    setShown({ mode: cameraMode, seq: seqRef.current });
    setLeaving(false);
  }, [cameraMode, active]);

  // Clear immediately when leaving track into a menu
  useEffect(() => {
    if (!active && shown) setShown(null);
  }, [active, shown]);

  const shownSeq = shown?.seq;
  const shownMode = shown?.mode;
  useEffect(() => {
    if (shownSeq === undefined || !shownMode) return;
    const duration = shownMode === "free" ? FREE_SHOW_MS : SHOW_MS;
    const leave = window.setTimeout(() => setLeaving(true), duration - LEAVE_MS);
    const gone = window.setTimeout(() => setShown(null), duration);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(gone);
    };
  }, [shownSeq, shownMode]);

  const spec = shown ? CAMERA_MODES[shown.mode] : null;
  const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  const freeHint =
    shown?.mode === "free"
      ? coarsePointer
        ? tx("freeHintTouch")
        : tx("freeHintKeys", { key: freeCameraKey })
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed top-[max(4.75rem,calc(env(safe-area-inset-top)+3.75rem))] left-1/2 z-30 flex -translate-x-1/2 justify-center short:top-[max(3rem,calc(env(safe-area-inset-top)+2.25rem))]"
    >
      {shown && spec ? (
        <div
          key={shown.seq}
          className={`${leaving ? "lc-np-out" : "lc-np-in"} flex max-w-[calc(100vw-2rem)] flex-col items-center gap-0.5 rounded-lc-tile px-4 py-2 text-center shadow-lc-pop ${HUD_GLASS}`}
        >
          <span className="inline-flex items-center gap-2 text-[13px] font-semibold tracking-[0.04em] text-lc-chalk">
            <Icon name="camera" size="sm" className="text-lc-fog" />
            <span>{spec.label}</span>
          </span>
          {freeHint ? (
            <span className="lc-mono text-[11px] text-lc-slate">{freeHint}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
