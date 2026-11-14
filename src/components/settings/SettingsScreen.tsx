"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  adjacentTab,
  AdvancedPresenceProvider,
  Button,
  NavList,
  Segmented,
  SettingsDetailProvider,
  Tabs,
  Toast,
  useToasts,
} from "@/components/ui";
import { Icon, type IconName } from "@/components/ui/icons";
import { KeyCap, PadGlyph, PromptBar, type Prompt } from "@/components/ui/prompts";
import { focusables, tabStops, useFocusNav, useMoveHandler } from "@/components/menu/useFocusNav";
import { isMenuNavSuspended } from "@/components/menu/useMenuNav";
import { useInputMode } from "@/components/menu/input-mode";
import { SettingsEnvProvider, type SettingsEnv } from "./env";
import { AdvancedOnly } from "./fields";
import { AssistsTab, SteeringHelpTab } from "./panes/DrivingPane";
import { ControllerTab, DeviceTab, KeyboardTab, TouchTab, WheelTab } from "./panes/ControlsPane";
import { CameraTab, GraphicsTab, HudTab, InterfaceTab } from "./panes/DisplayPane";
import { AudioPane } from "./panes/AudioPane";
import { DataTab, DriverTab } from "./panes/ProfilePane";
import { ForceFeedbackSetup } from "@/components/menu/steps/WheelStep";

export type SettingsCategory = "driving" | "controls" | "ffb" | "display" | "audio" | "profile";

interface TabDef {
  id: string;
  label: string;
  /** Every row on it is advanced: Simple shows one line and the switch instead */
  advancedOnly?: string;
  render: () => React.ReactNode;
}

interface CategoryDef {
  id: SettingsCategory;
  label: string;
  icon: IconName;
  tabs: readonly TabDef[];
}

/** The six categories of settings-tree.md (Tree A), each with its tabs; a category of one page has one tab, not shown */
const CATEGORIES: readonly CategoryDef[] = [
  {
    id: "driving",
    label: "Driving",
    icon: "assists",
    tabs: [
      { id: "assists", label: "Assists", render: () => <AssistsTab /> },
      { id: "steering", label: "Steering help", advancedOnly: "The steering help settings", render: () => <SteeringHelpTab /> },
    ],
  },
  {
    id: "controls",
    label: "Controls",
    icon: "controls",
    tabs: [
      { id: "device", label: "Device", render: () => <DeviceTab /> },
      { id: "keyboard", label: "Keyboard", render: () => <KeyboardTab /> },
      { id: "controller", label: "Controller", render: () => <ControllerTab /> },
      { id: "wheel", label: "Wheel", render: () => <WheelTab /> },
      { id: "touch", label: "Touch", render: () => <TouchTab /> },
    ],
  },
  { id: "ffb", label: "Force feedback", icon: "forceFeedback", tabs: [{ id: "main", label: "Force feedback", render: () => <ForceFeedbackSetup first /> }] },
  {
    id: "display",
    label: "Display",
    icon: "display",
    tabs: [
      { id: "graphics", label: "Graphics", render: () => <GraphicsTab /> },
      { id: "hud", label: "HUD", render: () => <HudTab /> },
      { id: "camera", label: "Camera", render: () => <CameraTab /> },
      { id: "interface", label: "Interface", render: () => <InterfaceTab /> },
    ],
  },
  { id: "audio", label: "Audio", icon: "audio", tabs: [{ id: "main", label: "Audio", render: () => <AudioPane /> }] },
  {
    id: "profile",
    label: "Profile and data",
    icon: "profile",
    tabs: [
      { id: "driver", label: "Driver", render: () => <DriverTab /> },
      { id: "data", label: "Data", render: () => <DataTab /> },
    ],
  },
];

const PANE = "settings-pane";
const TABS = "settings-tabs";
const NAV = "settings-nav";

const isTextEntry = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "color"].includes(el.type));

export interface SettingsScreenProps {
  env: SettingsEnv;
  /** The category (and tab) it opens on */
  initialCategory?: SettingsCategory;
  initialTab?: string;
  onClose: () => void;
}

/**
 * The one Settings screen, the same from the title menu and from pause: categories on the left, the category's tabs
 * and rows on the right, a Simple / Advanced switch in the header. B / Esc steps back one level (row, tabs, category
 * list, close); it takes Esc before anything else hears it, since in a session Esc is also the pause key.
 */
export function SettingsScreen({ env, initialCategory = "driving", initialTab, onClose }: SettingsScreenProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const paneId = useId();
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [tabFor, setTabFor] = useState<Partial<Record<SettingsCategory, string>>>(() =>
    initialTab ? { [initialCategory]: initialTab } : {},
  );
  const cat = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];
  const tab = cat.tabs.find((t) => t.id === tabFor[category]) ?? cat.tabs[0];
  const hasTabs = cat.tabs.length > 1;
  const detail = env.settings.ui.detail;
  const { mode, family } = useInputMode();
  const pad = mode === "pad";

  // How many settings (or cards of them) on this page only Advanced shows: reported by the rows themselves, in either
  // mode, so the switch can always show what it did
  const [advancedHere, setAdvancedHere] = useState(0);
  const reportAdvanced = useCallback(() => {
    setAdvancedHere((n) => n + 1);
    return () => setAdvancedHere((n) => n - 1);
  }, []);
  const hasAdvanced = advancedHere > 0 || Boolean(tab.advancedOnly);
  const hasAdvancedRef = useRef(hasAdvanced);
  useEffect(() => {
    hasAdvancedRef.current = hasAdvanced;
  }, [hasAdvanced]);
  const { toasts, show: showToast, dismiss: dismissToast } = useToasts(2600);
  const noticeRef = useRef<number | null>(null);

  const setDetail = useCallback(
    (next: "simple" | "advanced") => {
      if (env.settings.ui.detail === next) return;
      env.update((s) => (s.ui.detail === next ? s : { ...s, ui: { ...s.ui, detail: next } }));
      // Nothing on this page changes with the switch: say so, or it looks broken
      if (noticeRef.current !== null) dismissToast(noticeRef.current);
      noticeRef.current = hasAdvancedRef.current ? null : showToast("No advanced settings on this page");
      requestAnimationFrame(() => {
        // A row that Simple hides took the cursor with it: back onto the pane's first row
        if (!rootRef.current?.contains(document.activeElement)) enterPaneRef.current();
        // The rows Advanced adds may be below the fold: bring the first one into view
        if (next !== "advanced") return;
        const row = rootRef.current?.querySelector<HTMLElement>(`[data-nav-zone="${PANE}"] [data-advanced]`);
        const view = rootRef.current?.getBoundingClientRect();
        const box = row?.getBoundingClientRect();
        if (!row || !view || !box || (box.top >= view.top && box.bottom <= view.bottom)) return;
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        row.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
      });
    },
    [env, showToast, dismissToast],
  );
  const toggleDetail = () => setDetail(detail === "simple" ? "advanced" : "simple");

  const zone = (name: string) => rootRef.current?.querySelector<HTMLElement>(`[data-nav-zone="${name}"]`) ?? null;
  const inZone = (name: string) => {
    const z = zone(name);
    return Boolean(z && document.activeElement && z.contains(document.activeElement));
  };
  const focusEl = (el: HTMLElement | null | undefined) => {
    if (!el) return false;
    (el.focus as (o?: object) => void)({ preventScroll: true, focusVisible: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  };
  const focusNav = () => focusEl(zone(NAV)?.querySelector<HTMLElement>('[aria-selected="true"]'));
  const focusTabs = () => focusEl(zone(TABS)?.querySelector<HTMLElement>('[aria-selected="true"]'));
  /** Into the pane on its first row (never a card's Reset); a choice row on the option it is set to */
  const enterPane = (): boolean => {
    const pane = zone(PANE);
    if (!pane) return false;
    const items = focusables(pane).filter((el) => !el.closest("[data-card-reset]"));
    const first = items.find((el) => el.hasAttribute("data-nav-default")) ?? items[0];
    const checked = first?.closest('[role="radiogroup"]')?.querySelector<HTMLElement>('[aria-checked="true"]');
    return focusEl(checked ?? first);
  };

  const enterPaneRef = useRef(enterPane);
  enterPaneRef.current = enterPane;

  /**
   * Up / down inside the pane stay inside it (row by row, never across to the category list beside it); up from the
   * top row goes to the tab strip
   */
  const moveInPane = (dir: "up" | "down"): boolean => {
    const pane = zone(PANE);
    const from = document.activeElement as HTMLElement | null;
    if (!pane || !from) return false;
    // A control alone in its row is seen as the row; a row of several (tiles, a key's slots) keeps each one's own box
    const boxOf = (el: HTMLElement) => {
      const row = el.closest("[data-setting-row]");
      return (row && focusables(row).length === 1 ? row : el).getBoundingClientRect();
    };
    const a = boxOf(from);
    const ax = a.left + a.width / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of focusables(pane)) {
      if (el === from || el.closest("[data-card-reset]")) continue;
      const b = boxOf(el);
      const ahead = dir === "down" ? b.top - (a.bottom - 4) : a.top + 4 - b.bottom;
      if (ahead < 0) continue;
      const side = Math.max(0, b.left - a.right, a.left - b.right) || Math.abs(b.left + b.width / 2 - ax) * 0.05;
      const score = ahead + side * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      // A choice row is entered on the option it is set to
      const group = best.closest('[role="radiogroup"]');
      const checked = group && !group.contains(from) ? group.querySelector<HTMLElement>('[aria-checked="true"]') : null;
      return focusEl(checked ?? best);
    }
    if (dir === "up") return hasTabs ? focusTabs() : true;
    return true;
  };

  // Right from the category list enters the pane at its first row; up / down in the pane stay in it
  useMoveHandler((dir) => {
    if (dir === "right" && inZone(NAV)) return enterPane();
    if ((dir === "up" || dir === "down") && inZone(PANE)) return moveInPane(dir);
    return false;
  });

  /** One level per press: row, tab strip, category list, close */
  const back = () => {
    if (inZone(PANE)) return void (hasTabs ? focusTabs() : focusNav());
    if (inZone(TABS)) return void focusNav();
    if (inZone(NAV)) return onClose();
    // The header (the switch, Close) or nowhere: to the categories first, if the cursor is not already there
    if (rootRef.current?.contains(document.activeElement) && focusNav()) return;
    onClose();
  };

  const switchTab = (dir: 1 | -1) => {
    if (!hasTabs) return;
    const wasInPane = inZone(PANE) || !rootRef.current?.contains(document.activeElement);
    flushSync(() => setTabFor((m) => ({ ...m, [category]: adjacentTab(cat.tabs, tab.id, dir) })));
    // From a row, the new tab starts on its first row; from the strip, the strip follows the choice itself
    if (wasInPane) enterPane();
  };

  useFocusNav(rootRef, {
    onBack: back,
    onPrevTab: () => switchTab(-1),
    onNextTab: () => switchTab(1),
    onAlt: toggleDetail,
    keyboardBack: false,
    autoFocus: false,
    // Delete / pad X reset the focused row here, and only here (the prompt bar shows it when the row can)
    rowReset: true,
  });

  // Esc, before anything else hears it: a dialog, a list or a key capture of this screen takes it first (they listen
  // on window, which comes before document); the pause key behind this screen never sees it
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && !isMenuNavSuspended()) {
        // An open list took it already (it closes and keeps the focus on its control), or something modal over
        // Settings holds the focus (a confirm dialog, a list): theirs, not ours
        const holder = document.activeElement;
        if (e.defaultPrevented || (holder && holder !== document.body && !rootRef.current?.contains(holder))) return;
        // Tab stays inside Settings: past its ends it would reach the menu behind, where Enter starts a drive. Only
        // what Tab itself stops on (a roving option or tab at -1 is not), and every press is ours, so no end leaks
        const items = tabStops(rootRef.current ?? document.body);
        if (!items.length) return;
        e.preventDefault();
        const active = holder;
        let i = items.indexOf(active as HTMLElement);
        // Focus on a part Tab skips (a roving option): count from where it sits
        if (i === -1 && active && rootRef.current?.contains(active)) {
          const after = items.findIndex((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
          i = after === -1 ? items.length : after;
          if (!e.shiftKey) i -= 1;
        }
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i >= items.length - 1 ? 0 : i + 1;
        items[next].focus();
        return;
      }
      if (e.key !== "Escape" || isMenuNavSuspended()) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as Element | null;
      if (isTextEntry(target)) {
        // Out of the field, onto the next control in the pane
        const list = focusables(rootRef.current ?? document.body);
        const next = list.slice(list.indexOf(target as HTMLElement) + 1).find((x) => !isTextEntry(x));
        (target as HTMLElement).blur();
        focusEl(next);
        return;
      }
      backRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // Opens on the category list; closing hands the focus back to where the player was
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => focusNav());
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
    // Mount only
  }, []);

  // Whether the focused row can be reset (Delete / X): the prompt bar says so
  const [rowResettable, setRowResettable] = useState(false);
  useEffect(() => {
    const check = () =>
      setRowResettable(Boolean(document.activeElement?.closest("[data-setting-row]")?.querySelector("[data-row-reset]")));
    check();
    document.addEventListener("focusin", check);
    return () => document.removeEventListener("focusin", check);
  }, [env.settings]);

  const prompts: Prompt[] = [
    { action: "move", label: "Move" },
    { action: "adjust", label: "Change" },
    ...(hasTabs ? [{ action: "tabs" as const, label: "Tabs" }] : []),
    ...(rowResettable ? [{ action: "select" as const, label: "Reset row", key: "Delete", pad: "x" as const }] : []),
    { action: "select", label: detail === "simple" ? "Show advanced" : "Show simple", key: "Y", pad: "y" },
    { action: "back", label: "Back" },
  ];

  const advancedOnly = detail === "simple" && tab.advancedOnly;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-menu) flex flex-col overflow-y-auto bg-lc-void/90 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] backdrop-blur-md sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.75rem,env(safe-area-inset-top))]"
    >
      <SettingsEnvProvider value={env}>
        <SettingsDetailProvider value={detail}>
          <AdvancedPresenceProvider value={reportAdvanced}>
          <div className="mx-auto flex w-full max-w-[1240px] flex-1 flex-col gap-5 short:gap-3">
            <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-lc-line pb-4 short:pb-2.5">
              <h2 className="lc-h1 m-0">Settings</h2>
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-2.5">
                  <span aria-hidden className="inline-flex pointer-coarse:hidden">
                    {pad ? <PadGlyph button="y" family={family} /> : <KeyCap>Y</KeyCap>}
                  </span>
                  <Segmented
                    size="sm"
                    aria-label="How many settings to show"
                    options={[
                      { id: "simple", label: "Simple" },
                      { id: "advanced", label: "Advanced" },
                    ]}
                    value={detail}
                    onChange={setDetail}
                  />
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Icon name="close" />}
                  prompt={pad ? <PadGlyph button="b" family={family} /> : <KeyCap>Esc</KeyCap>}
                  onClick={onClose}
                >
                  Close
                </Button>
              </div>
            </header>

            <div className="grid flex-1 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(220px,260px)_minmax(0,1fr)] short:gap-3">
              <div
                className="lg:sticky lg:top-0"
                onClickCapture={(e) => {
                  // A or Enter on a category goes into its pane (a click with the mouse just picks the category)
                  if (e.detail === 0 && (e.target as Element).closest('[role="tab"]')) requestAnimationFrame(() => enterPane());
                }}
              >
                <NavList
                  aria-label="Settings categories"
                  navZone={NAV}
                  panelId={paneId}
                  value={category}
                  onChange={(id) => setCategory(id)}
                  items={CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: <Icon name={c.icon} size="md" /> }))}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-3.5">
                {hasTabs ? (
                  <Tabs
                    aria-label={`${cat.label} sections`}
                    navZone={TABS}
                    panelId={paneId}
                    tabs={cat.tabs.map((t) => ({ id: t.id, label: t.label }))}
                    value={tab.id}
                    onChange={(id) => setTabFor((m) => ({ ...m, [category]: id }))}
                    prevPrompt={pad ? <PadGlyph button="lb" family={family} /> : <KeyCap>Q</KeyCap>}
                    nextPrompt={pad ? <PadGlyph button="rb" family={family} /> : <KeyCap>E</KeyCap>}
                  />
                ) : null}
                <section
                  id={paneId}
                  role="tabpanel"
                  aria-label={hasTabs ? `${cat.label}: ${tab.label}` : cat.label}
                  data-nav-zone={PANE}
                  className="flex min-w-0 flex-col gap-3"
                >
                  <div key={`${category}/${tab.id}`} className="lc-panel-in flex min-w-0 flex-col gap-3">
                    {advancedOnly ? <AdvancedOnly what={tab.advancedOnly!} onShowAdvanced={() => setDetail("advanced")} /> : tab.render()}
                    {detail === "simple" && !advancedOnly && advancedHere > 0 ? (
                      <AdvancedOnly more what="More settings on this page" onShowAdvanced={() => setDetail("advanced")} />
                    ) : null}
                  </div>
                </section>
              </div>
            </div>

            <PromptBar prompts={prompts} className="phone:hidden" />
          </div>
          </AdvancedPresenceProvider>
          {/* The screen scrolls as a whole and blurs what is behind it, so a fixed toast region would scroll with it:
              this one sticks to the bottom of the scroll box instead. Always mounted, so the first notice is read out */}
          <div aria-live="polite" className="pointer-events-none sticky bottom-16 z-10 flex h-0 flex-col items-center justify-end gap-2 phone:bottom-4">
            {toasts.map((t) => (
              <Toast key={t.id} tone={t.tone} icon={t.icon}>
                {t.message}
              </Toast>
            ))}
          </div>
        </SettingsDetailProvider>
      </SettingsEnvProvider>
    </div>
  );
}
