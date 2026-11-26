"use client";

/**
 * Shared pieces for the stats pages (src/app/stats/PublicStats.tsx and src/app/admin/Dashboard.tsx): cards, number
 * tiles, charts, ranked and share lists, tables, and the plain names and formats the numbers are shown with.
 *
 * The charts are HTML, not SVG: a column is at most 24 px wide whatever the range, rounded at its end and square on the
 * baseline, and the whole slot of a day answers the pointer. Every chart has a table of the same numbers under it.
 */
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { SiteSection } from "@/components/home/SitePage";
import { Card as KitCard, Meter } from "@/components/ui";
import { Trend } from "@/components/ui/icons";
import { cx } from "@/components/ui/styles";

/** A quiet sentence: an empty list, a footnote */
export const NOTE = "lc-body m-0 text-lc-slate";

/**
 * The modes in a fixed order, each with its name and colour. The colours are a data palette (which mode, not how it
 * went), so they come from the palette's hues and never volt, and never the crimson of an error.
 */
export const MODES = [
  { id: "practice", name: "Practice", swatch: "bg-lc-cyan" },
  { id: "time_trial", name: "Time trial", swatch: "bg-lc-purple" },
  { id: "ai_race", name: "Race against AI", swatch: "bg-lc-green" },
  { id: "open_race", name: "Open race", swatch: "bg-lc-amber" },
  { id: "room_race", name: "Room race", swatch: "bg-lc-pink" },
] as const;
export const modeName = (id: string) => MODES.find((m) => m.id === id)?.name ?? id;

/** Plain names of the settings the numbers are split by; an unknown value shows as it is */
const SETTING_NAMES: Record<string, string> = {
  keyboard: "Keyboard",
  controller: "Controller",
  wheel: "Wheel",
  touch: "Touch screen",
  desktop: "Desktop",
  tablet: "Tablet",
  phone: "Phone",
  dry: "Dry",
  wet: "Wet",
  pro: "Pro (no assists)",
  semi_pro: "Semi-pro",
  assisted: "Assisted",
  casual: "Casual",
  standard: "Standard",
  full: "Full",
  soft: "Soft",
  medium: "Medium",
  hard: "Hard",
  intermediate: "Intermediate",
};
export const settingName = (id: string) => SETTING_NAMES[id] ?? id;
/** An id the game no longer names ("yas_marina") as words ("Yas Marina") */
export const idWords = (id: string) => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export const count = (n: number) => Math.round(n).toLocaleString("en-GB");
/** Hours from minutes: one decimal below ten hours, whole hours above */
export const hours = (minutes: number) => {
  const h = minutes / 60;
  return h >= 10 ? Math.round(h).toLocaleString("en-GB") : h.toFixed(1);
};
/** Minutes a session, one decimal */
export const perSession = (minutes: number, sessions: number) => (sessions > 0 ? (minutes / sessions).toFixed(1) : "–");
/** A share as a whole percentage; a small one that is not nothing reads "<1%" */
export const percent = (part: number, whole: number) => {
  if (whole <= 0) return "–";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-09" → "9 Nov" */
export const dayLabel = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};
/** "2026-W46" → "Week 46" */
export const weekLabel = (week: string) => {
  const m = /^\d{4}-W(\d{1,2})$/.exec(week);
  return m ? `Week ${Number(m[1])}` : week;
};

/** Every UTC day from `from` to `to`, with the value of each (0 for the days not listed) */
export function everyDay<T extends { day: string }>(from: string, to: string, rows: T[], empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? empty(day));
  }
  return out;
}

/** A section of the page with its title and a sentence that says what it shows */
export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <SiteSection id={id} title={title} gap="gap-4">
      {intro ? <p className="lc-body m-0 -mt-1 mb-1 max-w-[72ch] text-[15px] leading-[1.55]">{intro}</p> : null}
      {children}
    </SiteSection>
  );
}

/** A card with its title and, under it, a word on what it counts */
export function Card({ title, aside, children, className }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <KitCard title={title} description={aside} bodyClassName="gap-3" className={className}>
      {children}
    </KitCard>
  );
}

/** One number, what it is, and how it compares or a word on it; `live` marks a number that is read again as it changes */
export function Tile({ label, value, note, trend, live }: { label: string; value: string; note?: ReactNode; trend?: { text: string; up: boolean } | null; live?: boolean }) {
  return (
    <KitCard bodyClassName="gap-1.5" className="justify-between">
      <p className="lc-data m-0 flex items-center gap-2.5 text-[30px] leading-none text-lc-chalk" aria-live={live ? "polite" : undefined}>
        {live ? (
          <span aria-hidden className="relative inline-flex size-2.5">
            <span className="lc-ping absolute inset-0 rounded-full bg-lc-gain motion-reduce:hidden" />
            <span className="relative size-2.5 rounded-full bg-lc-gain" />
          </span>
        ) : null}
        {value}
      </p>
      <p className="lc-row-label m-0 pt-1 text-[14px]">{label}</p>
      {trend ? (
        <p className="lc-hint m-0">
          <span className={cx("lc-data inline-flex items-center gap-1", trend.up ? "text-lc-gain" : "text-lc-loss")}>
            <Trend direction={trend.up ? "up" : "down"} />
            {trend.text}
          </span>{" "}
          on the days before
        </p>
      ) : note ? (
        <p className="lc-hint m-0">{note}</p>
      ) : null}
    </KitCard>
  );
}

export function Tiles({ children, three }: { children: ReactNode; three?: boolean }) {
  return <div className={cx("grid grid-cols-2 gap-3", three ? "lg:grid-cols-3" : "lg:grid-cols-4")}>{children}</div>;
}

// --- Charts ----------------------------------------------------------------------------------------------------------

/** The day (or bar) the pointer, a tap or the arrow keys are on; `span` ties it to the bars it was chosen among */
export function useCursor(span: string, length: number) {
  const [at, setAt] = useState<{ span: string; i: number } | null>(null);
  const i = at !== null && at.span === span && at.i < length ? at.i : null;
  const set = (n: number | null) => setAt(n === null ? null : { span, i: Math.max(0, Math.min(length - 1, n)) });
  const onKeyDown = (e: KeyboardEvent, fallback: number) => {
    const keys: Record<string, number | null> = { ArrowLeft: (i ?? fallback + 1) - 1, ArrowRight: (i ?? fallback - 1) + 1, Home: 0, End: length - 1, Escape: null };
    if (!(e.key in keys)) return;
    e.preventDefault();
    set(keys[e.key]);
  };
  return { i, set, onKeyDown };
}

/**
 * The day labels under a row of columns: every one when they fit, else the first, the middle and the last. On a phone
 * a week shows every other day, so the labels never touch.
 */
export function Axis({ labels }: { labels: string[] }) {
  const ticks = labels.length > 10 ? [0, Math.floor((labels.length - 1) / 2), labels.length - 1] : labels.map((_, i) => i);
  return (
    <div aria-hidden className="lc-mono relative h-4 text-[11px] text-lc-slate">
      {ticks.map((i) => (
        <span
          key={i}
          className={cx("absolute top-0 whitespace-nowrap", labels.length > 5 && labels.length <= 10 && i % 2 === 1 && "max-sm:hidden")}
          style={
            labels.length === 1 || (labels.length > 10 && i === 0)
              ? { left: 0 }
              : labels.length > 10 && i === labels.length - 1
                ? { right: 0 }
                : { left: `${((i + 0.5) / labels.length) * 100}%`, transform: "translateX(-50%)" }
          }
        >
          {labels[i]}
        </span>
      ))}
    </div>
  );
}

/** Column fills: the day in hand, a day still counting, any other */
export const INK = { on: "bg-lc-chalk", partial: "bg-lc-slate/35", off: "bg-lc-slate/60" } as const;
// ui-allow: arbitrary-radius a chart column's data end is a 4 px round and its baseline square (chart marks, not a surface)
export const COLUMN_END = "rounded-t-[4px]";
// ui-allow: arbitrary-radius a legend swatch mirrors the 4 px column end at its 10 px size
export const SWATCH_SHAPE = "rounded-[3px]";

/**
 * One row of columns over a hairline baseline, every slot a hit target for its day. Heights against `max`; the slot
 * `at` is drawn in chalk.
 */
function Columns({
  values,
  max,
  at,
  partialLast,
  height,
  onAt,
}: {
  values: number[];
  max: number;
  at: number | null;
  partialLast?: boolean;
  height: number;
  onAt: (i: number | null, touch: boolean) => void;
}) {
  return (
    <div
      className="flex touch-pan-y items-end gap-0.5 border-b border-lc-line"
      style={{ height }}
      onPointerLeave={(e) => {
        // A finger's tap ends with a pointerleave: a tapped day keeps its readout until another is tapped
        if (e.pointerType !== "touch") onAt(null, false);
      }}
    >
      {values.map((v, i) => {
        const h = max > 0 ? (v / max) * (height - 2) : 0;
        const ink = i === at ? INK.on : partialLast && i === values.length - 1 ? INK.partial : INK.off;
        return (
          <div
            key={i}
            className="flex h-full min-w-0 flex-1 items-end justify-center"
            onPointerEnter={(e) => onAt(i, e.pointerType === "touch")}
            onPointerDown={(e) => onAt(i, e.pointerType === "touch")}
          >
            {h > 0 ? <div className={cx("w-full max-w-6 transition-colors duration-200 ease-lc", COLUMN_END, ink)} style={{ height: Math.max(2, h) }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** "Show as a table": the same numbers as the chart above it */
export function TableView({ head, rows }: { head: string[]; rows: { key: string; cells: ReactNode[] }[] }) {
  return (
    <details className="text-[13px] text-lc-slate">
      <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-lc-nub select-none hover:text-lc-chalk pointer-coarse:min-h-11">Show as a table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[280px] text-start">
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={cx("lc-lbl py-1.5 pe-3 whitespace-nowrap last:pe-0", i > 0 && "text-end")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="lc-mono text-lc-fog">
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-lc-titanium">
                {r.cells.map((c, i) => (
                  <td key={i} className={cx("py-1 pe-3 font-normal whitespace-nowrap last:pe-0", i > 0 && "text-end")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface Bar {
  /** The x label ("9 Nov", "Mon") */
  label: string;
  value: number;
  /** What the readout says when this bar is hovered or tapped */
  readout: string;
}

/**
 * Columns of one series. Hovering, tapping or the arrow keys put a column's numbers above the chart; without one the
 * readout names the highest. A table of the same numbers sits under it.
 */
export function BarChart({ bars, label, unit, height = 140, partialLast }: { bars: Bar[]; label: string; unit: string; height?: number; partialLast?: boolean }) {
  const span = `${bars.length}|${bars[0]?.label ?? ""}|${bars[bars.length - 1]?.label ?? ""}`;
  const cursor = useCursor(span, bars.length);
  const max = Math.max(0, ...bars.map((b) => b.value));
  const peak = bars.reduce((best, b, i) => (b.value > bars[best].value ? i : best), 0);
  const shown = cursor.i ?? (max > 0 ? peak : null);
  return (
    <div className="flex flex-col gap-2">
      <p className="lc-body m-0 min-h-5 text-[14px]" aria-live="polite">
        {shown === null ? (
          "Nothing in this range."
        ) : (
          <>
            {cursor.i === null ? "Most: " : ""}
            <span className="lc-data text-lc-chalk">{bars[shown].readout}</span>
          </>
        )}
      </p>
      <div
        role="group"
        aria-label={`${label}. Arrow keys move between the bars.`}
        tabIndex={0}
        onKeyDown={(e) => cursor.onKeyDown(e, peak)}
        className="flex flex-col gap-1.5 rounded-lc-nub outline-none focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:ring-offset-4 focus-visible:ring-offset-lc-carbon"
      >
        <Columns values={bars.map((b) => b.value)} max={max} at={shown} partialLast={partialLast} height={height} onAt={(i) => cursor.set(i)} />
        <Axis labels={bars.map((b) => b.label)} />
      </div>
      <TableView head={["Day", unit]} rows={bars.map((b, i) => ({ key: `${b.label}-${i}`, cells: [b.label, b.readout.split(": ").pop()] }))} />
    </div>
  );
}

export interface TrendRow {
  id: string;
  name: string;
  values: number[];
  /** A value as shown ("1,204", "35 h") */
  format: (v: number) => string;
  /** What the row reads with no day in hand: the range's total, or its average */
  total: string;
}

/**
 * Small multiples: one row of columns per measure, each on its own scale (their units differ), over the same days.
 * A day in hand is drawn and read out in every row at once; with none, each row reads its total for the range.
 */
export function TrendChart({ days, rows, partialLast, label }: { days: string[]; rows: TrendRow[]; partialLast: boolean; label: string }) {
  const span = `${days.length}|${days[0] ?? ""}`;
  const cursor = useCursor(span, days.length);
  const last = days.length - 1;
  const dayName = (i: number) => `${dayLabel(days[i])}${partialLast && i === last ? ", so far" : ""}`;
  return (
    <div className="flex flex-col gap-3">
      <p className="lc-body m-0 min-h-5 text-[14px]" aria-live="polite">
        {cursor.i === null ? (
          <>
            {dayLabel(days[0])} – {dayLabel(days[last])}: totals for the range
          </>
        ) : (
          <span className="lc-data text-lc-chalk">{dayName(cursor.i)}</span>
        )}
      </p>
      <div
        role="group"
        aria-label={`${label}. Arrow keys move between the days.`}
        tabIndex={0}
        onKeyDown={(e) => cursor.onKeyDown(e, last)}
        className="flex flex-col gap-4 rounded-lc-nub outline-none focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:ring-offset-4 focus-visible:ring-offset-lc-carbon"
      >
        {rows.map((r) => {
          const max = Math.max(0, ...r.values);
          return (
            <div key={r.id} className="grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:items-end">
              <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-start sm:gap-0.5 sm:pb-0.5">
                <span className="text-[14px] leading-tight font-medium text-lc-fog">{r.name}</span>
                <span className="lc-data text-[18px] leading-tight text-lc-chalk">{cursor.i === null ? r.total : r.format(r.values[cursor.i])}</span>
              </div>
              <div className="relative pt-4">
                {/* The row's scale: its highest day, on a hairline at the top of the plot */}
                <span aria-hidden className="lc-mono absolute top-0 end-0 text-[11px] leading-none text-lc-dim">
                  {r.format(max)}
                </span>
                <Columns values={r.values} max={max} at={cursor.i} partialLast={partialLast} height={44} onAt={(i) => cursor.set(i)} />
              </div>
            </div>
          );
        })}
        <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
          <span aria-hidden className="max-sm:hidden" />
          <Axis labels={days.map(dayLabel)} />
        </div>
      </div>
      <TableView head={["Day", ...rows.map((r) => r.name)]} rows={days.map((d, i) => ({ key: d, cells: [dayName(i), ...rows.map((r) => r.format(r.values[i]))] }))} />
    </div>
  );
}

// --- Lists -----------------------------------------------------------------------------------------------------------

export interface Row {
  id: string;
  name: ReactNode;
  /** The bar's length and the main number */
  value: number;
  /** The main number as shown */
  shown: string;
  /** A second, quieter number beside it */
  extra?: string;
}

/** A ranked list: each row's name and number over a bar against the largest */
export function RankList({ rows, empty = "Nothing in this range.", limit = 10 }: { rows: (Row & { name: string })[]; empty?: string; limit?: number }) {
  const top = rows.slice(0, limit);
  const max = Math.max(1, ...top.map((r) => r.value));
  if (!top.length) return <p className={NOTE}>{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {top.map((r) => (
        <li key={r.id} title={r.id !== r.name ? r.id : undefined}>
          <Meter stacked tone="neutral" label={r.name} value={r.value / max} detail={r.extra ? `${r.shown} · ${r.extra}` : r.shown} />
        </li>
      ))}
    </ul>
  );
}

/** Shares of a whole: each value's name, its percentage and a bar of that percentage */
export function ShareList({ rows, total, unit, empty = "Nothing in this range." }: { rows: { id: string; value: number }[]; total: number; unit: (v: number) => string; empty?: string }) {
  if (!rows.length || total <= 0) return <p className={NOTE}>{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map((r) => (
        <li key={r.id}>
          <Meter stacked tone="neutral" label={settingName(r.id)} value={r.value / total} detail={`${percent(r.value, total)} · ${unit(r.value)}`} />
        </li>
      ))}
    </ul>
  );
}

/** A small table: a header row and rows of cells, the first column a name and the rest numbers */
export function NumberTable({ head, rows, empty = "Nothing in this range." }: { head?: string[]; rows: { key: string; cells: ReactNode[]; title?: string }[]; empty?: string }) {
  if (!rows.length) return <p className={NOTE}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[280px] text-start text-[14px]">
        {head ? (
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} scope="col" className={cx("lc-lbl pb-2 whitespace-nowrap", i > 0 && "ps-3 text-end")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-lc-titanium first:border-t-0">
              {r.cells.map((c, i) => (
                <td
                  key={i}
                  title={i === 0 ? (r.title ?? (typeof c === "string" ? c : undefined)) : undefined}
                  // The name takes the room the numbers leave, and is cut short before any number is pushed out
                  className={cx("py-2", i > 0 ? "lc-data ps-3 text-end whitespace-nowrap text-lc-chalk" : "w-full max-w-0 truncate pe-3 text-lc-fog")}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
