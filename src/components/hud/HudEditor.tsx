"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { HudPart } from "@/lib/settings/player-settings";
import {
  DEFAULT_HUD_PART,
  HUD_PART_OFFSET_MAX,
  HUD_PART_SCALE_MAX,
  HUD_PART_SCALE_MIN,
} from "@/lib/settings/player-settings";
import { Button } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";

type PartDef = {
  id: string;
  label: string;
};

export const HUD_EDIT_PARTS: readonly PartDef[] = [
  { id: "timing-tower", label: "Top-left (Tower / Lap)" },
  { id: "start-lights", label: "Top-centre (Lights / Delta)" },
  { id: "minimap", label: "Top-right (Circuit map)" },
  { id: "launch-cue", label: "Centre-right (Start cue)" },
  { id: "proximity-radar", label: "Centre (Proximity radar)" },
  { id: "tyre-panel", label: "Bottom-left (Tyres / Timing)" },
  { id: "speed-cluster", label: "Bottom-centre (Speed / Dash)" },
  { id: "mfd", label: "Bottom-right (MFD / Tuner)" },
];

type Pointer = {
  id: number;
  partId: string;
  mode: "move" | "scale";
  startX: number;
  startY: number;
  partX: number;
  partY: number;
  partScale: number;
};

type MeasuredBox = { left: number; top: number; width: number; height: number };

export interface HudEditorProps {
  parts: Record<string, HudPart>;
  baseScale: number;
  hudRootRef?: React.RefObject<HTMLDivElement | null>;
  onChange: (id: string, patch: Partial<HudPart>) => void;
  onResetAll: () => void;
  onClose: () => void;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Computes the tight visual bounding box of a HUD panel container and its visible descendants */
function tightPanelRect(el: HTMLElement): MeasuredBox | null {
  const selfRect = el.getBoundingClientRect();
  let minL = Infinity;
  let minT = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;

  const consider = (r: DOMRect) => {
    if (r.width < 4 || r.height < 4) return;
    minL = Math.min(minL, r.left);
    minT = Math.min(minT, r.top);
    maxR = Math.max(maxR, r.right);
    maxB = Math.max(maxB, r.bottom);
  };

  if (el.children.length > 0) {
    Array.from(el.children).forEach((child) => {
      if (!(child instanceof HTMLElement)) return;
      const st = window.getComputedStyle(child);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) return;
      consider(child.getBoundingClientRect());
    });
  }
  if (!Number.isFinite(minL)) {
    consider(selfRect);
  }
  const width = Math.round(maxR - minL);
  const height = Math.round(maxB - minT);
  if (!Number.isFinite(minL) || width < 20 || height < 16) return null;
  return {
    left: Math.round(minL),
    top: Math.round(minT),
    width,
    height,
  };
}

export function HudEditor({ parts, baseScale, hudRootRef, onChange, onResetAll, onClose }: HudEditorProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [measured, setMeasured] = useState<Record<string, MeasuredBox>>({});
  const ptr = useRef<Pointer | null>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  const getPart = useCallback((id: string): HudPart => partsRef.current[id] ?? { ...DEFAULT_HUD_PART }, []);

  // Measure the live rendered HUD elements inside F1TelemetryHud via their `--lc-hud-part` style property
  const measurePanels = useCallback(() => {
    const root = hudRootRef?.current;
    const next: Record<string, MeasuredBox> = {};
    if (root) {
      const nodes = root.querySelectorAll<HTMLElement>("[style*='--lc-hud-part'], [data-hud-part]");
      nodes.forEach((el) => {
        const partId =
          el.getAttribute("data-hud-part") || el.style.getPropertyValue("--lc-hud-part").trim();
        if (!partId) return;
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") return;
        const box = tightPanelRect(el);
        if (!box) return;
        const prev = next[partId];
        if (!prev) {
          next[partId] = box;
        } else {
          const minL = Math.min(prev.left, box.left);
          const minT = Math.min(prev.top, box.top);
          const maxR = Math.max(prev.left + prev.width, box.left + box.width);
          const maxB = Math.max(prev.top + prev.height, box.top + box.height);
          next[partId] = { left: minL, top: minT, width: maxR - minL, height: maxB - minT };
        }
      });
    }
    setMeasured(next);
  }, [hudRootRef]);

  useEffect(() => {
    measurePanels();
    const raf = window.requestAnimationFrame(measurePanels);
    const interval = window.setInterval(measurePanels, 250);
    window.addEventListener("resize", measurePanels);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(interval);
      window.removeEventListener("resize", measurePanels);
    };
  }, [measurePanels, parts, baseScale]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent, id: string, mode: "move" | "scale") => {
    e.preventDefault();
    e.stopPropagation();
    const p = getPart(id);
    setActiveId(id);
    ptr.current = {
      id: e.pointerId,
      partId: id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      partX: p.x ?? 0,
      partY: p.y ?? 0,
      partScale: p.scale ?? 1,
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const cur = ptr.current;
      if (!cur || e.pointerId !== cur.id) return;
      const dx = e.clientX - cur.startX;
      const dy = e.clientY - cur.startY;
      if (cur.mode === "move") {
        onChange(cur.partId, {
          x: clamp(Math.round(cur.partX + dx), -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX),
          y: clamp(Math.round(cur.partY + dy), -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX),
        });
      } else {
        const delta = (dx + dy) * 0.004;
        const nextScale = Math.round(clamp(cur.partScale + delta, HUD_PART_SCALE_MIN, HUD_PART_SCALE_MAX) * 100) / 100;
        onChange(cur.partId, { scale: nextScale });
      }
    };
    const onUp = (e: PointerEvent) => {
      if (ptr.current && e.pointerId === ptr.current.id) {
        ptr.current = null;
        setActiveId(null);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onChange]);

  const onWheelPart = (e: React.WheelEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const p = getPart(id);
    const step = e.deltaY < 0 ? 0.05 : -0.05;
    const nextScale = Math.round(clamp((p.scale ?? 1) + step, HUD_PART_SCALE_MIN, HUD_PART_SCALE_MAX) * 100) / 100;
    onChange(id, { scale: nextScale });
  };

  const resetPart = (id: string) => onChange(id, { x: 0, y: 0, scale: 1 });

  return (
    <div className="pointer-events-auto fixed inset-0 z-[120] select-none" style={{ touchAction: "none" }}>
      {/* Top control bar */}
      <div className="pointer-events-auto absolute top-3 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lc-tile border border-lc-volt/60 bg-lc-void/92 px-4 py-2 shadow-lc-pop">
        <div className="flex flex-col">
          <span className="lc-title text-[13px] font-bold tracking-wider text-lc-volt uppercase">
            HUD Layout Editor
          </span>
          <span className="lc-hint text-[11px] text-lc-fog">
            Drag any panel to move · drag bottom-right corner or scroll wheel to scale · Esc when done
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="danger" onClick={onResetAll}>
            Reset all
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>

      {/* Interactive handles wrapped tightly around every visible in-game HUD panel */}
      {HUD_EDIT_PARTS.map((def) => {
        const box = measured[def.id];
        if (!box) return null;
        const p = parts[def.id] ?? DEFAULT_HUD_PART;
        const isActive = activeId === def.id;
        const scalePct = Math.round((p.scale ?? 1) * 100);
        const modified = (p.x ?? 0) !== 0 || (p.y ?? 0) !== 0 || (p.scale ?? 1) !== 1;
        return (
          <div
            key={def.id}
            onPointerDown={(e) => onPointerDown(e, def.id, "move")}
            onWheel={(e) => onWheelPart(e, def.id)}
            style={{
              position: "fixed",
              left: box.left - 4,
              top: box.top - 4,
              width: box.width + 8,
              height: box.height + 8,
            }}
            className={`group cursor-move rounded-lc-row border-2 transition-colors ${
              isActive
                ? "border-lc-volt bg-lc-volt/15 shadow-lc-focus"
                : modified
                  ? "border-lc-cyan/80 bg-lc-cyan/8 hover:border-lc-volt hover:bg-lc-volt/10"
                  : "border-white/35 bg-lc-void/10 hover:border-lc-volt hover:bg-lc-volt/10"
            }`}
          >
            {/* Header pill */}
            <div className="pointer-events-none absolute -top-6 left-0 flex items-center gap-1.5 rounded-t-md bg-lc-void/92 px-2 py-0.5 text-[10px] font-bold whitespace-nowrap text-lc-chalk shadow-sm">
              <Icon name="move" size="xs" className="text-lc-volt" />
              <span>{def.label}</span>
              <span className="lc-data text-lc-slate">
                ({Math.round(p.x ?? 0)}, {Math.round(p.y ?? 0)} · {scalePct}%)
              </span>
            </div>

            {/* Individual reset button when modified */}
            {modified ? (
              <button
                type="button"
                title="Reset this panel"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  resetPart(def.id);
                }}
                className="pointer-events-auto absolute top-1 right-1 rounded bg-lc-void/90 px-1.5 py-0.5 text-[10px] font-bold text-lc-fog hover:bg-lc-crimson hover:text-white"
              >
                Reset
              </button>
            ) : null}

            {/* Bottom-right scale handle */}
            <div
              title="Drag to rescale"
              onPointerDown={(e) => onPointerDown(e, def.id, "scale")}
              className="pointer-events-auto absolute -right-1.5 -bottom-1.5 flex size-5 cursor-nwse-resize items-center justify-center rounded-sm border border-lc-void bg-lc-volt text-lc-void shadow-sm hover:scale-110"
            >
              <svg viewBox="0 0 10 10" className="size-3" aria-hidden>
                <path d="M2 8 L8 2 M5 8 L8 5 M8 8 L8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
