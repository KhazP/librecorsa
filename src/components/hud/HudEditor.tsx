"use client";

import React, { useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";
import { padPressTracker, suspendMenuNav } from "@/components/menu/useMenuNav";
import { connectedPads } from "@/lib/input/device-input";
import {
  HUD_PART_IDS,
  HUD_PART_OFFSET_MAX,
  HUD_PART_SCALE_MAX,
  HUD_PART_SCALE_MIN,
  NO_HUD_PART,
  cleanHudPart,
  isHudPartId,
  type HudLayoutParts,
  type HudPart,
  type HudPartId,
} from "@/lib/settings/hud-parts";

type Box = { left: number; top: number; width: number; height: number };

/** The corner a part's resize handle sits on (the one away from its anchor) and which way is bigger from there */
const HANDLE: Record<HudPartId, { x: -1 | 1; y: -1 | 1 }> = {
  "top-left": { x: 1, y: 1 },
  "top-center": { x: 1, y: 1 },
  "top-right": { x: -1, y: 1 },
  "center-right": { x: -1, y: 1 },
  center: { x: 1, y: 1 },
  "bottom-left": { x: 1, y: -1 },
  "bottom-center": { x: 1, y: -1 },
  "bottom-right": { x: -1, y: -1 },
};

type Drag = {
  pointerId: number;
  id: HudPartId;
  mode: "move" | "scale";
  startX: number;
  startY: number;
  part: HudPart;
  box: Box;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The visible extent of a corner group: its shown children, not its own box (a column can be wider than its panels) */
function panelBox(el: HTMLElement): Box | null {
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  const take = (rect: DOMRect) => {
    if (rect.width < 4 || rect.height < 4) return;
    l = Math.min(l, rect.left);
    t = Math.min(t, rect.top);
    r = Math.max(r, rect.right);
    b = Math.max(b, rect.bottom);
  };
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const st = getComputedStyle(child);
    if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
    take(child.getBoundingClientRect());
  }
  if (!Number.isFinite(l)) take(el.getBoundingClientRect());
  if (!Number.isFinite(l) || r - l < 20 || b - t < 16) return null;
  return { left: Math.round(l), top: Math.round(t), width: Math.round(r - l), height: Math.round(b - t) };
}

/** Every corner group on screen, by part (a layout may anchor more than one block to a corner: their union) */
function measure(root: HTMLElement): Partial<Record<HudPartId, Box>> {
  const out: Partial<Record<HudPartId, Box>> = {};
  root.querySelectorAll<HTMLElement>("[style*='--lc-hud-part']").forEach((el) => {
    const id = el.style.getPropertyValue("--lc-hud-part").trim();
    if (!isHudPartId(id)) return;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return;
    const box = panelBox(el);
    if (!box) return;
    const prev = out[id];
    if (!prev) {
      out[id] = box;
      return;
    }
    const left = Math.min(prev.left, box.left);
    const top = Math.min(prev.top, box.top);
    const right = Math.max(prev.left + prev.width, box.left + box.width);
    const bottom = Math.max(prev.top + prev.height, box.top + box.height);
    out[id] = { left, top, width: right - left, height: bottom - top };
  });
  return out;
}

const sameBoxes = (a: Partial<Record<HudPartId, Box>>, b: Partial<Record<HudPartId, Box>>) =>
  HUD_PART_IDS.every((id) => {
    const p = a[id];
    const q = b[id];
    return p === q || (p !== undefined && q !== undefined && p.left === q.left && p.top === q.top && p.width === q.width && p.height === q.height);
  });

export interface HudEditorProps {
  /** The layout's parts as they stand in the editor (the HUD draws with these) */
  parts: HudLayoutParts;
  /** The HUD's frame, whose corner groups carry `--lc-hud-part` (hud-style-parts.tsx `anchor`) */
  hudRootRef: React.RefObject<HTMLDivElement | null>;
  onChange: (parts: HudLayoutParts) => void;
  /** Keep the layout as it stands (Done, Esc, a controller's B) */
  onDone: () => void;
  /** Put back the layout as it was when the editor opened */
  onCancel: () => void;
}

/**
 * Settings > Display > HUD > Edit layout: the live HUD with a frame around each corner group. Drag a frame to move
 * it, its handle or the scroll wheel to resize it. The editor works on a copy: Done keeps it, Cancel drops it.
 */
export function HudEditor({ parts, hudRootRef, onChange, onDone, onCancel }: HudEditorProps) {
  const tx = useTranslations("hud.hudEditor");
  const [boxes, setBoxes] = useState<Partial<Record<HudPartId, Box>>>({});
  const [active, setActive] = useState<HudPartId | null>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef({ parts, onChange, onDone });
  latest.current = { parts, onChange, onDone };

  const partOf = (id: HudPartId): HudPart => latest.current.parts[id] ?? NO_HUD_PART;
  const setPart = (id: HudPartId, next: HudPart) => {
    const kept = cleanHudPart(next);
    const out: HudLayoutParts = { ...latest.current.parts };
    if (kept) out[id] = kept;
    else delete out[id];
    latest.current.onChange(out);
  };

  // Follow the panels every frame: they move under a drag, and fold, grow and come and go with the race
  useEffect(() => {
    let raf = 0;
    let last: Partial<Record<HudPartId, Box>> = {};
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const root = hudRootRef.current;
      if (!root) return;
      const next = measure(root);
      if (sameBoxes(last, next)) return;
      last = next;
      setBoxes(next);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [hudRootRef]);

  // The menus keep still while the editor is up; Esc and a controller's B or Start finish
  useEffect(() => {
    const resume = suspendMenuNav();
    const finish = padPressTracker([1, 9]);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) latest.current.onDone();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (finish(connectedPads().filter((p) => p.mapping === "standard"))) latest.current.onDone();
    };
    raf = requestAnimationFrame(tick);
    return () => {
      resume();
      window.removeEventListener("keydown", onKey, { capture: true });
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === "move") {
        // The whole panel stays on screen
        const mx = clamp(dx, -d.box.left, vw - d.box.left - d.box.width);
        const my = clamp(dy, -d.box.top, vh - d.box.top - d.box.height);
        setPart(d.id, {
          ...d.part,
          x: clamp(d.part.x + (mx / vw) * 100, -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX),
          y: clamp(d.part.y + (my / vh) * 100, -HUD_PART_OFFSET_MAX, HUD_PART_OFFSET_MAX),
        });
      } else {
        // Out along the handle's diagonal is bigger: the handle stays about under the pointer
        const h = HANDLE[d.id];
        const grow = (h.x * dx + h.y * dy) / Math.max(1, d.box.width + d.box.height);
        setPart(d.id, { ...d.part, scale: clamp(d.part.scale * (1 + grow), HUD_PART_SCALE_MIN, HUD_PART_SCALE_MAX) });
      }
    };
    const onUp = (e: PointerEvent) => {
      if (drag.current?.pointerId !== e.pointerId) return;
      drag.current = null;
      setActive(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // setPart reads everything through `latest`
  }, []);

  const startDrag = (e: React.PointerEvent, id: HudPartId, mode: Drag["mode"]) => {
    const box = boxes[id];
    if (!box || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { pointerId: e.pointerId, id, mode, startX: e.clientX, startY: e.clientY, part: partOf(id), box };
    setActive(id);
  };

  const onWheel = (e: React.WheelEvent, id: HudPartId) => {
    // A mouse notch is about 100; a trackpad sends many small ones
    const step = clamp(-e.deltaY / 1000, -0.1, 0.1);
    if (step === 0) return;
    const p = partOf(id);
    setPart(id, { ...p, scale: clamp(p.scale * (1 + step), HUD_PART_SCALE_MIN, HUD_PART_SCALE_MAX) });
  };

  const moved = Object.keys(parts).length > 0;
  return (
    <div className="pointer-events-auto fixed inset-0 z-[120] touch-none select-none">
      {/* Each frame sits on its panel in window pixels: the layer keeps left as left whatever the language */}
      <div dir="ltr" className="absolute inset-0">
        {HUD_PART_IDS.map((id) => {
          const box = boxes[id];
          if (!box) return null;
          const part = parts[id] ?? NO_HUD_PART;
          const isHidden = Boolean(part.hidden);
          const changed = parts[id] !== undefined;
          const h = HANDLE[id];
          const live = active === id;
          // The name tab goes under the frame when the panel is against the top of the window
          const tabBelow = box.top < 28;
          return (
            <div
              key={id}
              onPointerDown={(e) => startDrag(e, id, "move")}
              onWheel={(e) => onWheel(e, id)}
              style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }}
              className={`fixed cursor-move rounded-lc-row border-2 transition-colors duration-150 ${
                live
                  ? "border-lc-volt bg-lc-volt/15"
                  : isHidden
                    ? "border-dashed border-amber-400/75 bg-lc-void/40 hover:border-lc-volt"
                    : changed
                      ? "border-lc-cyan/80 bg-lc-cyan/10 hover:border-lc-volt hover:bg-lc-volt/10"
                      : "border-lc-chalk/40 bg-lc-void/10 hover:border-lc-volt hover:bg-lc-volt/10"
              }`}
            >
              <div
                className={`pointer-events-none absolute start-0 flex items-center gap-1.5 rounded-lc-nub bg-lc-void/90 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-lc-chalk ${tabBelow ? "top-full mt-1" : "-top-6"}`}
              >
                <Icon name="move" size="xs" className="text-lc-volt" />
                <span>{tx(`parts.${id}`)}</span>
                {part.scale !== 1 ? <span className="lc-data text-lc-fog">{Math.round(part.scale * 100)}%</span> : null}
                {isHidden ? <span className="text-amber-400">Hidden</span> : null}
              </div>
              <div className="pointer-events-auto absolute end-1 top-1 flex items-center gap-1">
                <button
                  type="button"
                  title={isHidden ? "Show this panel" : "Hide this panel"}
                  aria-label={isHidden ? `Show ${id}` : `Hide ${id}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPart(id, { ...part, hidden: !isHidden });
                  }}
                  className={`flex size-5 items-center justify-center rounded-lc-nub bg-lc-void/90 transition-colors ${
                    isHidden ? "text-amber-400 hover:text-lc-chalk" : "text-lc-fog hover:text-lc-volt"
                  }`}
                >
                  {isHidden ? (
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M2 2l12 12M6.5 6.5a2 2 0 002.8 2.8M4.3 4.4C2.9 5.3 1.8 6.6 1.2 8c1.4 2.9 4 4.5 6.8 4.5 1.3 0 2.5-.3 3.6-1M9.9 3.8A7.6 7.6 0 008 3.5c-2.8 0-5.4 1.6-6.8 4.5" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M1.2 8C2.6 5.1 5.2 3.5 8 3.5s5.4 1.6 6.8 4.5c-1.4 2.9-4 4.5-6.8 4.5S2.6 10.9 1.2 8z" />
                      <circle cx="8" cy="8" r="2.1" />
                    </svg>
                  )}
                </button>
                {changed ? (
                  <button
                    type="button"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPart(id, NO_HUD_PART);
                    }}
                    className="rounded-lc-nub bg-lc-void/90 px-2 py-0.5 text-[11px] font-semibold text-lc-fog hover:bg-lc-crimson hover:text-lc-chalk"
                  >
                    {tx("resetPart")}
                  </button>
                ) : null}
              </div>
              <div
                title={tx("resize")}
                onPointerDown={(e) => startDrag(e, id, "scale")}
                className={`absolute flex size-5 items-center justify-center rounded-lc-nub border border-lc-void bg-lc-volt text-lc-void ${
                  h.x > 0 ? "-end-2" : "-start-2"
                } ${h.y > 0 ? "-bottom-2" : "-top-2"} ${h.x === h.y ? "cursor-nwse-resize" : "cursor-nesw-resize"}`}
              >
                {/* Grip lines in the corner it pulls */}
                <svg viewBox="0 0 10 10" className={`size-3 ${h.x < 0 ? "-scale-x-100" : ""} ${h.y < 0 ? "-scale-y-100" : ""}`} aria-hidden>
                  <path d="M2 8 L8 2 M5 8 L8 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
            </div>
          );
        })}
      </div>

      {/* The bar sits mid-screen, where no layout puts a panel (a phone's: between its top row and the touch pads),
          and steps aside while a panel is dragged */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-[34%] flex -translate-y-1/2 justify-center px-4 transition-opacity duration-150 short:top-1/2 ${active ? "opacity-0" : ""}`}
      >
      {/* The menus' big-screen zoom (the frames stay in window pixels) */}
      <div className={`lc-ui-zoom flex w-full max-w-[560px] flex-col gap-3 rounded-lc-tile border border-lc-line bg-lc-void/90 p-4 shadow-lc-pop sm:flex-row sm:items-center short:p-3 ${active ? "" : "pointer-events-auto"}`}>
        <div className="min-w-0 flex-1">
          <h2 className="lc-title text-[15px] text-lc-chalk">{tx("title")}</h2>
          <p className="mt-1 text-[12px] leading-snug text-lc-fog short:hidden">{tx("hint")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" disabled={!moved} onClick={() => onChange({})}>
            {tx("resetAll")}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            {tx("cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={onDone}>
            {tx("done")}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
