"use client";
/**
 * The title menu's What's new panel: the home page's patch notes (src/lib/home/whats-new.json, loaded by
 * useWhatsNewNotes after the menu is up), newest day first. Each day's commit link is a stop for the arrows and the pad,
 * and between stops up / down scroll through the day's notes at reading pace; the frame around it names the panel.
 */
import React, { useRef } from "react";
import { useTranslations } from "use-intl/react";
import { day, type WhatsNewDay } from "@/components/home/home-data";
import { EmptyState } from "@/components/ui";
import { Icon } from "@/components/ui/icons/Icon";
import { REPO_URL } from "@/lib/site";
import { focusOnHover, scrollPast, useMoveHandler } from "./useFocusNav";

const linkClass = "text-lc-chalk underline decoration-lc-keyline underline-offset-2 hover:decoration-lc-chalk";

export const WhatsNewPanel: React.FC<{ days: readonly WhatsNewDay[] | null }> = ({ days }) => {
  const tx = useTranslations("home.hub.whatsNew");
  const topRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  // A day's notes run far taller than the screen: plain spatial moves would jump from one day's link past its notes (or
  // out to the rail, which is nearer). Up / down go day to day instead, scrolling until the next day's link is in view
  useMoveHandler((dir) => {
    if (dir !== "up" && dir !== "down") return false;
    const list = listRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!list || !active) return false;
    const stops = Array.from(list.querySelectorAll<HTMLElement>("[data-day-link]"));
    const i = stops.indexOf(active);
    if (i < 0) return false;
    const inView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    };
    const next = stops[dir === "down" ? i + 1 : i - 1];
    if (next && inView(next)) {
      next.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
      next.scrollIntoView({ block: "nearest" });
      return true;
    }
    // Up from the newest day: the panel's top back in view first, then on up as anywhere else
    if (!next && dir === "up" && topRef.current && inView(topRef.current)) return false;
    // Past the last day the notes read on to their end, then the cursor holds
    scrollPast(active, dir);
    return true;
  });
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div ref={topRef} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="lc-body m-0 text-lc-slate">{tx("intro")}</p>
        <a
          href={`${REPO_URL}/commits/main`}
          target="_blank"
          rel="noopener"
          onPointerEnter={focusOnHover}
          className={`inline-flex items-center gap-1 rounded-lc-nub text-[14px] ${linkClass}`}
        >
          {tx("commitLog")}
          <Icon name="externalLink" />
        </a>
      </div>
      {days === null ? null : days.length === 0 ? (
        <EmptyState icon={<Icon name="info" size="lg" />}>{tx("empty")}</EmptyState>
      ) : (
        <ol ref={listRef} className="m-0 flex list-none flex-col p-0">
          {days.map((entry, index) => (
            <li
              key={entry.date}
              className="grid gap-x-7 gap-y-2 border-t border-lc-line py-4.5 last:border-b sm:grid-cols-[132px_minmax(0,1fr)]"
            >
              <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5">
                {/* The notes are English in every language: they read left to right under a right-to-left page too */}
                <span lang="en" dir="ltr" className="lc-data text-[14px] text-lc-chalk">
                  {day(entry.date)}
                </span>
                <a
                  href={
                    entry.commits === 1
                      ? `${REPO_URL}/commit/${entry.lastSha.slice(0, 7)}`
                      : `${REPO_URL}/commits/main/?since=${entry.date}&until=${entry.date}`
                  }
                  target="_blank"
                  rel="noopener"
                  onPointerEnter={focusOnHover}
                  data-nav-default={index === 0 ? "" : undefined}
                  data-day-link=""
                  className="inline-flex items-center gap-1 rounded-lc-nub text-[12px] text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk focus-visible:text-lc-chalk pointer-coarse:min-h-11"
                >
                  <span className="lc-data">{tx("commits", { count: entry.commits })}</span>
                  <Icon name="externalLink" size="sm" />
                </a>
              </div>
              <div lang="en" dir="ltr" className="flex min-w-0 flex-col gap-2">
                <h3 className="lc-title m-0 text-[17px] leading-snug text-lc-chalk">{entry.title}</h3>
                <ul className="m-0 -mb-1.5 list-none p-0">
                  {entry.items.map((item) => (
                    <li key={item} className="relative pb-1.5 ps-4 text-[14px] leading-relaxed text-lc-fog">
                      <span aria-hidden className="absolute top-[9px] start-0 size-1 rounded-full bg-lc-slate" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
