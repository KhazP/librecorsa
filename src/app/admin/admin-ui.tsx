"use client";

/**
 * Pieces used only by the owner's numbers page (Dashboard.tsx), plus re-exports of the shared stats UI primitives
 * from src/components/stats/stats-ui.tsx.
 */
import { type ReactNode } from "react";
import { Icon } from "@/components/ui/icons";
import { cx } from "@/components/ui/styles";
import {
  Axis,
  COLUMN_END,
  count,
  dayLabel,
  hours,
  INK,
  MODES,
  NOTE,
  percent,
  SWATCH_SHAPE,
  TableView,
  useCursor,
} from "@/components/stats/stats-ui";

export {
  BarChart,
  Card,
  count,
  dayLabel,
  everyDay,
  hours,
  idWords,
  modeName,
  MODES,
  NOTE,
  NumberTable,
  percent,
  perSession,
  RankList,
  Section,
  settingName,
  ShareList,
  Tile,
  Tiles,
  TrendChart,
  weekLabel,
  type Bar,
  type Row,
  type TrendRow,
} from "@/components/stats/stats-ui";

export const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
};

/** "+12% on the 30 days before", or null when there is nothing to compare with */
export function change(current: number, before: number): { text: string; up: boolean } | null {
  if (before <= 0) return null;
  const p = Math.round(((current - before) / before) * 100);
  return { text: `${p > 0 ? "+" : ""}${p}%`, up: p >= 0 };
}

/** A line saying something needs a look: the caution icon and the words, never the colour alone */
export function Caution({ children }: { children: ReactNode }) {
  return (
    <p className="lc-body m-0 flex items-start gap-2 text-[14px] text-lc-fog">
      <Icon name="warning" className="mt-0.5 shrink-0 text-lc-caution" />
      <span>{children}</span>
    </p>
  );
}

export interface SplitDay {
  day: string;
  /** Sessions on builds current that day, and on builds replaced before it; both 0 for a day no build was sent */
  fresh: number;
  stale: number;
  readout: string;
}

/**
 * Each day's sessions as one column of 100 %: those on a build replaced before that day from the baseline in caution
 * amber, the rest above in neutral ink, a 2 px gap between them. The readout gives the day's builds; a legend names
 * the two parts.
 */
export function SplitChart({ days, partialLast, label, defaultDay }: { days: SplitDay[]; partialLast: boolean; label: string; defaultDay: number | null }) {
  const span = `${days.length}|${days[0]?.day ?? ""}`;
  const cursor = useCursor(span, days.length);
  const shown = cursor.i ?? defaultDay;
  const H = 120;
  return (
    <div className="flex flex-col gap-2">
      <ul className="lc-hint m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-[13px] text-lc-fog" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cx("inline-block size-2.5 bg-lc-caution", SWATCH_SHAPE)} />
          On a replaced build
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className={cx("inline-block size-2.5 bg-lc-slate/60", SWATCH_SHAPE)} />
          On a current build
        </li>
      </ul>
      <p className="lc-body m-0 min-h-10 text-[14px] sm:min-h-5" aria-live="polite">
        {shown === null ? "No builds were sent in this range." : <span className="lc-data text-lc-chalk">{days[shown].readout}</span>}
      </p>
      <div
        role="group"
        aria-label={`${label}. Arrow keys move between the days.`}
        tabIndex={0}
        onKeyDown={(e) => cursor.onKeyDown(e, defaultDay ?? days.length - 1)}
        className="flex flex-col gap-1.5 rounded-lc-nub outline-none focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:ring-offset-4 focus-visible:ring-offset-lc-carbon"
      >
        <div
          className="flex touch-pan-y items-end gap-0.5 border-b border-lc-line"
          style={{ height: H }}
          onPointerLeave={(e) => {
            if (e.pointerType !== "touch") cursor.set(null);
          }}
        >
          {days.map((d, i) => {
            const all = d.fresh + d.stale;
            const partial = partialLast && i === days.length - 1;
            const on = i === shown;
            const staleH = all > 0 ? (d.stale / all) * (H - 2) : 0;
            return (
              <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col-reverse items-center" onPointerEnter={() => cursor.set(i)} onPointerDown={() => cursor.set(i)}>
                {all > 0 ? (
                  <div className={cx("flex h-full w-full max-w-6 flex-col-reverse gap-0.5", partial && !on && "opacity-60")}>
                    {d.stale > 0 ? <div className={cx("w-full shrink-0 bg-lc-caution transition-opacity duration-200", d.fresh > 0 ? "rounded-none" : COLUMN_END, on ? "opacity-100" : "opacity-80")} style={{ height: Math.max(2, staleH) }} /> : null}
                    {d.fresh > 0 ? <div className={cx("w-full flex-1 transition-colors duration-200", COLUMN_END, on ? INK.on : INK.off)} /> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <Axis labels={days.map((d) => dayLabel(d.day))} />
      </div>
      <TableView
        head={["Day", "Sessions", "Replaced build"]}
        rows={days
          .filter((d) => d.fresh + d.stale > 0)
          .map((d) => ({ key: d.day, cells: [dayLabel(d.day), count(d.fresh + d.stale), `${percent(d.stale, d.fresh + d.stale)} (${count(d.stale)})`] }))}
      />
    </div>
  );
}

export interface AverageRow {
  id: string;
  name: string;
  sessions: number;
  minutes: number;
}

/**
 * Minutes a session for each value, as bars against `scale` (shared by the lists that sit side by side), with a
 * chalk tick at `overall`, the average over every session. Each row also says its sessions and their share.
 */
export function AverageList({ rows, scale, overall, empty = "Nothing sent in this range." }: { rows: AverageRow[]; scale: number; overall: number; empty?: string }) {
  const sessions = rows.reduce((n, r) => n + r.sessions, 0);
  if (!rows.length || sessions <= 0) return <p className={NOTE}>{empty}</p>;
  const at = (v: number) => `${Math.max(0, Math.min(1, scale > 0 ? v / scale : 0)) * 100}%`;
  return (
    <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
      {[...rows]
        .sort((a, b) => b.sessions - a.sessions)
        .map((r) => {
          const avg = r.sessions > 0 ? r.minutes / r.sessions : 0;
          return (
            <li key={r.id} className="flex min-w-0 flex-col gap-1.5" aria-label={`${r.name}: ${avg.toFixed(1)} minutes a session, ${count(r.sessions)} sessions (${percent(r.sessions, sessions)})`}>
              <span aria-hidden className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] leading-tight font-medium text-lc-chalk">{r.name}</span>
                <span className="lc-data shrink-0 text-[12px] text-lc-fog">
                  <span className="text-[14px] text-lc-chalk">{avg.toFixed(1)} min</span> · {count(r.sessions)} ({percent(r.sessions, sessions)})
                </span>
              </span>
              <span aria-hidden className="relative block h-2 rounded-full bg-lc-titanium">
                <span className="absolute inset-y-0 start-0 rounded-full bg-lc-fog" style={{ width: at(avg) }} />
                <span className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 rounded-full bg-lc-chalk ring-2 ring-lc-carbon" style={{ left: at(overall) }} />
              </span>
            </li>
          );
        })}
    </ul>
  );
}

/** The mode colours with their names, above a chart that uses them */
export function ModeLegend({ present }: { present: string[] }) {
  return (
    <ul className="lc-hint m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-[13px] text-lc-fog" aria-label="Modes">
      {MODES.filter((m) => present.includes(m.id)).map((m) => (
        <li key={m.id} className="flex items-center gap-1.5">
          <span aria-hidden className={cx("inline-block size-2.5 rounded-full", m.swatch)} />
          {m.name}
        </li>
      ))}
    </ul>
  );
}

/** Circuits ranked by hours, each bar split into its modes (a legend above names the colours) */
export function ModeSplitList({ rows }: { rows: { id: string; name: ReactNode; minutes: number; sessions: number; modes: { mode: string; minutes: number }[] }[] }) {
  const top = rows.slice(0, 10);
  const max = Math.max(1, ...top.map((r) => r.minutes));
  const present = [...new Set(top.flatMap((r) => r.modes.filter((m) => m.minutes > 0).map((m) => m.mode)))];
  if (!top.length) return <p className={NOTE}>Nothing in this range.</p>;
  return (
    <div className="flex flex-col gap-3">
      <ModeLegend present={present} />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {top.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 truncate text-[14px] leading-tight font-medium text-lc-chalk" title={r.id}>
                {r.name}
              </span>
              <span className="lc-data shrink-0 text-[12px] text-lc-fog">
                {hours(r.minutes)} h · {count(r.sessions)} sessions
              </span>
            </div>
            <div className="h-2 rounded-full bg-lc-titanium">
              <div className="flex h-full gap-0.5" style={{ width: `${(r.minutes / max) * 100}%` }}>
                {MODES.map((m) => {
                  const part = r.modes.find((x) => x.mode === m.id)?.minutes ?? 0;
                  if (part <= 0) return null;
                  return (
                    <div key={m.id} className={cx("h-full min-w-[3px] rounded-full", m.swatch)} style={{ flexGrow: part, flexBasis: 0 }} title={`${m.name}: ${hours(part)} h`} />
                  );
                })}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
