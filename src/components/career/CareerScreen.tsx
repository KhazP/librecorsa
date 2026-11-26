"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useFormatter, useTranslations } from "use-intl/react";
import {
  chooseSeries,
  newCareer,
  nextRound,
  startSeason,
  updateRaceSettings,
  updateSeasonSettings,
  withRun,
  withoutRun,
  type CareerRun,
  type RaceSettings,
  type SeasonSettings,
} from "@/lib/career/career-state";
import type { CareerDisciplineId } from "@/lib/career/ladder";
import type { CareerScreenProps } from "./career-screen-types";
import { adjacentTab, Button, cx, IconButton, Tabs } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { KeyCap, PadGlyph, PromptBar, type Prompt } from "@/components/ui/prompts";
import { keyLabel } from "@/lib/input/bindings";
import { useKeyLayout } from "@/lib/input/use-key-layout";
import { focusables, tabStops, useFocusNav } from "@/components/menu/useFocusNav";
import { isMenuNavSuspended } from "@/components/menu/useMenuNav";
import { useInputMode } from "@/components/menu/input-mode";
import { CareerHomeView } from "./CareerHomeView";
import { CareerActiveView, type CareerTab } from "./CareerActiveView";
import { RaceSummaryModal, SeasonSummaryModal, UnfinishedRoundDialog } from "./CareerModals";

const CAREER_TABS: readonly CareerTab[] = ["season", "ladder", "history"];

/**
 * Full-screen Career Mode overlay (same shell as SettingsScreen): Careers home, single-career hub (Season / Ladder /
 * History), and priority modals for race/season summaries and unfinished rounds.
 */
export const CareerScreen: React.FC<CareerScreenProps> = ({
  save,
  content,
  playerCode,
  playerName,
  onSave,
  onClose,
  onRaceNext,
  onTestDay,
  summaries,
  onCloseSummary,
  unfinished,
  onResolveUnfinished,
}) => {
  useKeyLayout();
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const { mode, family } = useInputMode();
  const pad = mode === "pad";

  // Open on the active career if save.activeId resolves, otherwise Careers home
  const initialRunId = useMemo(() => {
    if (unfinished && save.runs.some((r) => r.id === unfinished.runId)) return unfinished.runId;
    if (summaries[0] && save.runs.some((r) => r.id === summaries[0].runId)) return summaries[0].runId;
    if (save.activeId && save.runs.some((r) => r.id === save.activeId)) return save.activeId;
    return null;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
  const [tab, setTab] = useState<CareerTab>("season");
  const [revealRunId, setRevealRunId] = useState<string | null>(null);

  const activeRun = useMemo(
    () => (selectedId ? save.runs.find((r) => r.id === selectedId) ?? null : null),
    [save.runs, selectedId],
  );
  const heading = activeRun ? tx(`discipline.${activeRun.discipline}`) : tx("title");

  // Keep selectedId valid if the active career was removed externally
  useEffect(() => {
    if (selectedId && !activeRun) setSelectedId(null);
  }, [selectedId, activeRun]);

  // If a summary or unfinished round arrives for a specific career, bring that career into view behind it
  const priorityRunId = unfinished?.runId ?? summaries[0]?.runId ?? null;
  useEffect(() => {
    if (priorityRunId && save.runs.some((r) => r.id === priorityRunId)) {
      setSelectedId(priorityRunId);
      setTab("season");
    }
  }, [priorityRunId, save.runs]);

  const topSummary = summaries[0] ?? null;
  const hasOverlayModal = Boolean(unfinished || topSummary);

  // Set <html data-career-open> while mounted and restore prior focus on unmount
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = document.documentElement;
    root.setAttribute("data-career-open", "");
    requestAnimationFrame(() => {
      const target =
        rootRef.current?.querySelector<HTMLElement>('[data-nav-zone="career-main"] [data-nav-default]') ??
        rootRef.current?.querySelector<HTMLElement>("[data-nav-default]") ??
        focusables(rootRef.current ?? document.body)[0];
      target?.focus({ preventScroll: true });
    });
    return () => {
      root.removeAttribute("data-career-open");
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  const handleBack = useCallback(() => {
    if (activeRun) {
      setSelectedId(null);
      requestAnimationFrame(() => {
        const target =
          rootRef.current?.querySelector<HTMLElement>('[data-nav-zone="career-main"] [data-nav-default]') ??
          rootRef.current?.querySelector<HTMLElement>("[data-nav-default]") ??
          focusables(rootRef.current ?? document.body)[0];
        target?.focus({ preventScroll: true });
      });
      return;
    }
    onClose();
  }, [activeRun, onClose]);

  const switchTab = useCallback(
    (dir: 1 | -1) => {
      if (!activeRun) return;
      flushSync(() => setTab((cur) => adjacentTab(CAREER_TABS.map((id) => ({ id })), cur, dir)));
    },
    [activeRun],
  );

  const canRaceNow = Boolean(
    activeRun &&
      tab === "season" &&
      activeRun.season &&
      activeRun.season.started &&
      nextRound(activeRun.season) !== null,
  );

  useFocusNav(rootRef, {
    enabled: !hasOverlayModal,
    onBack: handleBack,
    onPrevTab: () => switchTab(-1),
    onNextTab: () => switchTab(1),
    onStart: canRaceNow && activeRun ? () => onRaceNext(activeRun.id) : undefined,
    keyboardBack: false,
    autoFocus: false,
  });

  // Esc and Tab trap, mirroring SettingsScreen (respecting any portalled modal/dialog above us)
  const backRef = useRef(handleBack);
  backRef.current = handleBack;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMenuNavSuspended()) return;
      const holder = document.activeElement;
      if (e.key === "Tab") {
        if (e.defaultPrevented || (holder && holder !== document.body && !rootRef.current?.contains(holder))) return;
        const items = tabStops(rootRef.current ?? document.body);
        if (!items.length) return;
        e.preventDefault();
        let i = items.indexOf(holder as HTMLElement);
        if (i === -1 && holder && rootRef.current?.contains(holder)) {
          const after = items.findIndex((el) => holder.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
          i = after === -1 ? items.length : after;
          if (!e.shiftKey) i -= 1;
        }
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i >= items.length - 1 ? 0 : i + 1;
        items[next].focus();
        return;
      }
      if (e.key !== "Escape") return;
      // Leave Escape to any portalled dialog/modal/listbox mounted above this screen
      const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== rootRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      backRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // State mutations strictly via career-state.ts functions -> onSave
  const handleOpenRun = useCallback(
    (run: CareerRun) => {
      setSelectedId(run.id);
      setTab("season");
      onSave(withRun(save, run));
    },
    [onSave, save],
  );

  const handleStartCareer = useCallback(
    (discipline: CareerDisciplineId, seriesId: string) => {
      const created = newCareer(discipline, seriesId, content);
      if (!created) return;
      setSelectedId(created.id);
      setTab("season");
      onSave(withRun(save, created));
    },
    [content, onSave, save],
  );

  const handleDeleteRun = useCallback(
    (id: string) => {
      if (selectedId === id) setSelectedId(null);
      onSave(withoutRun(save, id));
    },
    [onSave, save, selectedId],
  );

  const handleUpdateSeasonSettings = useCallback(
    (patch: Partial<SeasonSettings>) => {
      if (!activeRun) return;
      onSave(withRun(save, updateSeasonSettings(activeRun, patch, content)));
    },
    [activeRun, content, onSave, save],
  );

  const handleUpdateRaceSettings = useCallback(
    (patch: Partial<RaceSettings>) => {
      if (!activeRun) return;
      onSave(withRun(save, updateRaceSettings(activeRun, patch)));
    },
    [activeRun, onSave, save],
  );

  const handleStartSeason = useCallback(() => {
    if (!activeRun) return;
    onSave(withRun(save, startSeason(activeRun)));
    setRevealRunId(activeRun.id);
  }, [activeRun, onSave, save]);

  const handleChooseSeries = useCallback(
    (seriesId: string) => {
      if (!activeRun) return;
      onSave(withRun(save, chooseSeries(activeRun, seriesId, content)));
    },
    [activeRun, content, onSave, save],
  );

  const prompts: Prompt[] = [
    { action: "move", label: tx("prompts.move") },
    { action: "select", label: tx("prompts.select") },
    ...(activeRun ? [{ action: "tabs" as const, label: tx("prompts.tabs") }] : []),
    ...(canRaceNow && pad ? [{ action: "start" as const, label: tx("prompts.race") }] : []),
    { action: "back", label: tx("prompts.back") },
  ];

  const unfinishedRun = unfinished ? save.runs.find((r) => r.id === unfinished.runId) : undefined;
  const unfinishedMulligansLeft = unfinishedRun?.season
    ? Math.max(0, unfinishedRun.season.settings.mulligans - unfinishedRun.season.mulligansUsed)
    : 0;

  const summaryRun = topSummary ? save.runs.find((r) => r.id === topSummary.runId) : undefined;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={tx("dialogLabel")}
      className="lc-menu-screen lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-menu) flex flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges] bg-lc-void/90 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] backdrop-blur-md sm:pr-[max(2.5rem,env(safe-area-inset-right))] sm:pl-[max(2.5rem,env(safe-area-inset-left))] short:pt-[max(0.5rem,env(safe-area-inset-top))] short:pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 short:gap-2">
        {/* One row on a wide screen in every language: a long discipline name takes a smaller size or a second line */}
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-lc-line pb-4 lg:flex-nowrap short:flex-nowrap short:gap-2 short:pb-2">
          <div className="flex min-w-0 items-center gap-3 short:gap-2">
            {activeRun ? (
              <>
                <span className="inline-flex short:hidden">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="back" />}
                    onClick={() => setSelectedId(null)}
                  >
                    {tx("backToCareers")}
                  </Button>
                </span>
                <span className="hidden short:inline-flex">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="back" />}
                    aria-label={tx("backToCareers")}
                    onClick={() => setSelectedId(null)}
                  />
                </span>
              </>
            ) : null}
            <h1
              className={cx(
                "lc-h1 m-0 min-w-0 break-words short:truncate short:text-[20px] short:leading-none",
                heading.length > 16 ? "text-[34px] lg:line-clamp-2" : "truncate",
              )}
            >
              {heading}
            </h1>
            {activeRun ? (
              <Badge tone="info" size="md" className="short:h-5 short:px-2">
                {tx("careerScoreShort", { score: format.number(activeRun.score) })}
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-3 short:gap-1.5">
            {activeRun ? (
              <Tabs
                aria-label={tx("tabsLabel")}
                navZone="career-tabs"
                panelId={panelId}
                size="sm"
                tabs={[
                  { id: "season", label: tx("tabSeason") },
                  { id: "ladder", label: tx("tabLadder") },
                  { id: "history", label: tx("tabHistory") },
                ]}
                value={tab}
                onChange={setTab}
                prevPrompt={
                  <span className="inline-flex short:hidden">
                    {pad ? <PadGlyph button="lb" family={family} /> : <KeyCap>{keyLabel("KeyQ")}</KeyCap>}
                  </span>
                }
                nextPrompt={
                  <span className="inline-flex short:hidden">
                    {pad ? <PadGlyph button="rb" family={family} /> : <KeyCap>{keyLabel("KeyE")}</KeyCap>}
                  </span>
                }
              />
            ) : null}

            <span className="inline-flex short:hidden">
              <Button
                size="sm"
                variant="ghost"
                icon={<Icon name="close" />}
                prompt={pad ? <PadGlyph button="b" family={family} /> : <KeyCap>Esc</KeyCap>}
                onClick={onClose}
              >
                {tx("close")}
              </Button>
            </span>
            <span className="hidden short:inline-flex">
              <IconButton
                size="sm"
                variant="ghost"
                icon={<Icon name="close" />}
                aria-label={tx("close")}
                onClick={onClose}
              />
            </span>
          </div>
        </header>

        <main id={panelId} data-nav-zone="career-main" className="flex min-w-0 flex-1 flex-col">
          {activeRun ? (
            <CareerActiveView
              run={activeRun}
              tab={tab}
              content={content}
              playerName={playerName}
              playerCode={playerCode}
              objectivesReveal={revealRunId === activeRun.id}
              onDismissObjectivesReveal={() => setRevealRunId(null)}
              onUpdateSeasonSettings={handleUpdateSeasonSettings}
              onUpdateRaceSettings={handleUpdateRaceSettings}
              onStartSeason={handleStartSeason}
              onChooseSeries={handleChooseSeries}
              onRaceNext={() => onRaceNext(activeRun.id)}
              onTestDay={() => onTestDay(activeRun.id)}
              onGoToTab={setTab}
              onBackToHome={() => setSelectedId(null)}
            />
          ) : (
            <CareerHomeView
              runs={save.runs}
              content={content}
              onOpenRun={handleOpenRun}
              onStartCareer={handleStartCareer}
              onDeleteRun={handleDeleteRun}
            />
          )}
        </main>

        <PromptBar prompts={prompts} className="phone:hidden" />
      </div>

      {/* Over-everything modals: unfinished round first, else first queued summary */}
      {unfinished ? (
        <UnfinishedRoundDialog
          mulligansLeft={unfinishedMulligansLeft}
          onResolve={onResolveUnfinished}
        />
      ) : topSummary ? (
        topSummary.kind === "race" ? (
          <RaceSummaryModal
            summary={topSummary}
            run={summaryRun}
            playerName={playerName}
            playerCode={playerCode}
            onContinue={onCloseSummary}
          />
        ) : (
          <SeasonSummaryModal
            summary={topSummary}
            run={summaryRun}
            playerName={playerName}
            playerCode={playerCode}
            onContinue={onCloseSummary}
          />
        )
      ) : null}
    </div>
  );
};
