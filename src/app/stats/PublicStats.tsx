"use client";

/**
 * Public aggregate stats page (/stats), backed by GET /api/stats/public (edge-cached 1 hour) and GET /api/stats
 * (live players online, edge-cached 30 seconds). Every breakdown comes from anonymous single-dimension totals or
 * public lap board / open race aggregates — nothing about any individual player.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { LEAD, SiteIntro, SitePage, TEXT_LINK } from "@/components/home/SitePage";
import {
  BarChart,
  Card,
  count,
  dayLabel,
  everyDay,
  hours,
  idWords,
  modeName,
  NOTE,
  NumberTable,
  percent,
  RankList,
  Section,
  ShareList,
  Tile,
  Tiles,
  TrendChart,
  type TrendRow,
  weekLabel,
} from "@/components/stats/stats-ui";
import { Card as KitCard, Skeleton } from "@/components/ui";
import { fetchPublicStats, type PublicCount, type PublicShareGroup, type PublicStatsData, type PublicUsageGroup } from "@/lib/net/board-client";
import { onlineUrl } from "@/lib/net/online-config";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

const countryName = (code: string) => {
  if (code === "XX") return "Unknown";
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};

type Namer = (id: string) => string;
const asIs: Namer = (id) => id;

/** Readable circuit and car names loaded dynamically so the static page shell stays light */
function useNames(): { circuit: Namer; car: Namer } {
  const [names, setNames] = useState<{ circuit: Namer; car: Namer }>({ circuit: idWords, car: asIs });
  useEffect(() => {
    let live = true;
    void Promise.all([import("@/lib/track-registry"), import("@/lib/cars/car-registry")])
      .then(([tracks, cars]) => {
        if (!live) return;
        const circuit: Namer = (id) => {
          const t = tracks.TRACKS.find((x) => x.id === id);
          if (!t) return idWords(id);
          const layouts = tracks.venueOf(id)?.layouts.length ?? 1;
          return layouts > 1 && t.layout ? `${t.name} · ${t.layout}` : t.name;
        };
        const car: Namer = (id) => cars.CARS.find((c) => c.physics === id)?.title ?? id;
        setNames({ circuit, car });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return names;
}

/** Tabs on /play in view right now (GET /api/stats, edge-cached 30 s), refreshed every 30 s while this tab is visible */
function useLiveCount(): number | null | undefined {
  const [live, setLive] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    const url = onlineUrl("/stats");
    if (!url) {
      setLive(null);
      return;
    }
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(url, { credentials: "omit" });
        const body = (await res.json()) as { live?: unknown };
        if (alive) setLive(typeof body.live === "number" ? body.live : null);
      } catch {
        if (alive) setLive(null);
      }
    };
    void read();
    const timer = setInterval(read, 30_000);
    const shown = () => void read();
    document.addEventListener("visibilitychange", shown);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, []);
  return live;
}

const fullDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

const minutesOf = (rows: PublicShareGroup[]) => rows.reduce((n, r) => n + r.minutes, 0);
const countsOf = (rows: PublicCount[]) => rows.reduce((n, r) => n + r.n, 0);

const SECTIONS = [
  { id: "overview", name: "Overview" },
  { id: "activity", name: "Daily activity" },
  { id: "driving", name: "Circuits & cars" },
  { id: "setup", name: "How people play" },
  { id: "online", name: "Boards & races" },
] as const;

export function PublicStats() {
  const [stats, setStats] = useState<PublicStatsData | null | undefined>(undefined);
  const live = useLiveCount();
  const names = useNames();

  useEffect(() => {
    let alive = true;
    void fetchPublicStats()
      .catch(() => null)
      .then((data) => {
        if (alive) setStats(data);
      });
    return () => {
      alive = false;
    };
  }, []);

  const hasOnline = Boolean(onlineUrl("/stats/public"));
  const sections = stats
    ? SECTIONS.filter((s) => {
        if (s.id === "setup") return stats.extras !== null;
        if (s.id === "online") return stats.boards !== null || stats.races !== null;
        return true;
      })
    : SECTIONS;

  return (
    <SitePage wide className="motion-safe:scroll-smooth">
      <SiteIntro title="Stats">
        <p className={LEAD}>
          Public driving, lap board and open race numbers from librecorsa.org. Counted from anonymous daily totals with no
          player tracking, updated hourly.{" "}
          <Link href="/privacy#online" className={TEXT_LINK}>
            How they’re counted
          </Link>
        </p>
        <nav aria-label="Parts of the page" className="-mx-2 flex flex-wrap">
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="inline-flex min-h-8 items-center rounded-full px-2 text-[14px] font-medium text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk pointer-coarse:min-h-11"
            >
              {s.name}
            </a>
          ))}
        </nav>
      </SiteIntro>

      {stats === undefined ? (
        <LoadingState />
      ) : stats === null ? (
        <Card>
          <p className={NOTE}>
            {hasOnline
              ? "The stats can’t be read right now. Try again in a moment."
              : "This copy of LibreCorsa has no online side, so there are no numbers to show."}
          </p>
        </Card>
      ) : (
        <StatsBody stats={stats} live={live} names={names} />
      )}
    </SitePage>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-12" aria-busy="true" aria-label="Loading stats">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-40" />
        <Tiles>
          {Array.from({ length: 4 }, (_, i) => (
            <KitCard key={i} bodyClassName="gap-2.5">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-3.5 w-28" />
            </KitCard>
          ))}
        </Tiles>
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-44" />
        <KitCard bodyClassName="gap-4">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-40 w-full" />
        </KitCard>
      </div>
    </div>
  );
}

function StatsBody({
  stats,
  live,
  names,
}: {
  stats: PublicStatsData;
  live: number | null | undefined;
  names: { circuit: Namer; car: Namer };
}) {
  const { allTime, totals, extras, boards, races } = stats;

  const dayRows = everyDay(stats.from, stats.to, stats.perDay, (day) => ({
    day,
    sessions: 0,
    minutes: 0,
    laps: 0,
    countries: 0,
  }));
  const days = dayRows.map((d) => d.day);

  const trendRows: TrendRow[] = [
    { id: "hours", name: "Hours driven", values: dayRows.map((d) => d.minutes), format: (m) => `${hours(m)} h`, total: `${hours(totals.minutes)} h` },
    { id: "sessions", name: "Sessions", values: dayRows.map((d) => d.sessions), format: count, total: count(totals.sessions) },
    ...(totals.lapsCounted ? [{ id: "laps", name: "Laps driven", values: dayRows.map((d) => d.laps), format: count, total: count(totals.laps) }] : []),
    { id: "countries", name: "Countries", values: dayRows.map((d) => d.countries), format: count, total: count(totals.countries) },
  ];

  const weekday = WEEKDAYS.map((name, i) => {
    const these = dayRows.filter((d) => (new Date(`${d.day}T00:00:00Z`).getUTCDay() + 6) % 7 === i);
    const minutes = these.length ? these.reduce((n, d) => n + d.minutes, 0) / these.length : 0;
    return { name, label: name.slice(0, 3), value: minutes, readout: `${name}: ${hours(minutes)} h on average` };
  });
  const busiest = weekday.reduce((a, b) => (b.value > a.value ? b : a), weekday[0]);

  const usageRows = (rows: PublicUsageGroup[], labelOf: Namer) =>
    rows.map((r) => ({
      id: r.id,
      name: labelOf(r.id),
      value: r.minutes,
      shown: `${hours(r.minutes)} h`,
      extra: totals.lapsCounted && r.laps > 0 ? `${count(r.laps)} laps` : `${count(r.sessions)} sessions`,
    }));

  const modeTotalMinutes = stats.byMode.reduce((n, r) => n + r.minutes, 0);
  const modeRows = stats.byMode.map((r) => ({
    id: r.id,
    name: modeName(r.id),
    value: r.minutes,
    shown: percent(r.minutes, modeTotalMinutes),
    extra: `${hours(r.minutes)} h`,
  }));

  const countryTotalMinutes = totals.minutes;
  const countryRows = stats.byCountry.map((r) => ({
    id: r.id,
    name: countryName(r.id),
    value: r.minutes,
    shown: `${hours(r.minutes)} h`,
    extra: percent(r.minutes, countryTotalMinutes),
  }));

  return (
    <div className="flex flex-col gap-16 phone:gap-12">
      <Section
        id="overview"
        title="Overview"
        intro={
          <>
            All-time totals{allTime.since ? ` since ${fullDay(allTime.since)}` : ""}, alongside the last {stats.days} days (
            {dayLabel(stats.from)} – {dayLabel(stats.to)} UTC).
            {stats.byCircuit[0] ? (
              <>
                {" "}Over the last {stats.days} days the most-driven circuit was{" "}
                <b className="text-lc-chalk">{names.circuit(stats.byCircuit[0].id)}</b>
                {stats.byCar[0] ? (
                  <>
                    {" "}and the most-driven car the <b className="text-lc-chalk">{names.car(stats.byCar[0].id)}</b>
                  </>
                ) : null}
                .
              </>
            ) : null}
          </>
        }
      >
        <Tiles>
          <Tile
            live={typeof live === "number"}
            label="Driving now"
            value={live === undefined ? "…" : live === null ? "–" : count(live)}
            note={live === null ? "Live count is off" : "Tabs in view, updated every 30 s"}
          />
          <Tile
            label="Hours driven"
            value={count(allTime.hours)}
            note={allTime.since ? `All time · ${hours(totals.minutes)} h in ${stats.days} days` : `${hours(totals.minutes)} h in ${stats.days} days`}
          />
          <Tile
            label="Laps driven"
            value={count(allTime.laps)}
            note={totals.lapsCounted && totals.laps > 0 ? `All time · ${count(totals.laps)} in ${stats.days} days` : "All time"}
          />
          {allTime.drivers !== null ? (
            <Tile
              label="Drivers on the boards"
              value={count(allTime.drivers)}
              note={`${count(allTime.countries)} countries all time`}
            />
          ) : (
            <Tile label="Countries" value={count(allTime.countries)} note={`${count(totals.countries)} in the last ${stats.days} days`} />
          )}
        </Tiles>
        <Tiles>
          <Tile label={`Hours (${stats.days} days)`} value={hours(totals.minutes)} note={`${count(totals.sessions)} driving sessions`} />
          <Tile
            label={totals.lapsCounted ? `Laps (${stats.days} days)` : `Sessions (${stats.days} days)`}
            value={totals.lapsCounted ? count(totals.laps) : count(totals.sessions)}
            note={totals.lapsCounted ? `${count(totals.sessions)} driving sessions` : "Stretches of driving"}
          />
          <Tile label={`Countries (${stats.days} days)`} value={count(totals.countries)} note="Where driving came from" />
          {races ? (
            <Tile
              label={`Open races (${stats.days} days)`}
              value={count(races.count)}
              note={races.count > 0 ? `${count(races.cars)} entries · peak grid ${races.fieldMax}` : "Scheduled multiplayer races"}
            />
          ) : boards ? (
            <Tile label={`Board times (${stats.days} days)`} value={count(boards.lapsInRange)} note={`${count(boards.lapsTotal)} standing all time`} />
          ) : (
            <Tile label="Drivers" value={allTime.drivers !== null ? count(allTime.drivers) : "–"} note="All time" />
          )}
        </Tiles>
      </Section>

      <Section
        id="activity"
        title="Daily activity"
        intro="Each row is on its own scale over the last 30 days. Point at a day, tap it or use the arrow keys for its numbers. Today is still counting."
      >
        <Card>
          <TrendChart days={days} rows={trendRows} partialLast label={`Daily activity, ${dayLabel(stats.from)} to ${dayLabel(stats.to)}`} />
        </Card>
        <Card title="Busiest day of the week" aside={busiest.value > 0 ? `${busiest.name}, on average over the last ${stats.days} days` : undefined}>
          <BarChart label="Average hours driven on each day of the week" unit="Hours" bars={weekday} height={110} />
        </Card>
      </Section>

      <Section
        id="driving"
        title="Circuits & cars"
        intro={`Where and in what people drove over the last ${stats.days} days. Only active circuits, cars and countries with at least 10 sessions are listed.`}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Most-driven circuits" aside="Hours · laps">
            <RankList rows={usageRows(stats.byCircuit, names.circuit)} limit={15} />
          </Card>
          <Card title="Most-driven cars" aside="Hours · laps">
            <RankList rows={usageRows(stats.byCar, names.car)} limit={15} />
          </Card>
          <Card title="Driving modes" aside="Share of hours driven">
            <RankList rows={modeRows} limit={10} />
          </Card>
          <Card title="Top countries" aside={`Hours · share of driving; ${count(totals.countries)} countries in all`}>
            <RankList rows={countryRows} limit={15} />
          </Card>
        </div>
      </Section>

      {extras ? (
        <Section
          id="setup"
          title="How people play"
          intro={`Share of driving hours over the last ${stats.days} days. Each category is counted on its own and never combined with another or with a country.`}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Input" aside="Share of hours driven">
              <ShareList rows={extras.input.map((r) => ({ id: r.id, value: r.minutes }))} total={minutesOf(extras.input)} unit={(m) => `${hours(m)} h`} />
            </Card>
            <Card title="Device" aside="Share of hours driven">
              <ShareList rows={extras.device.map((r) => ({ id: r.id, value: r.minutes }))} total={minutesOf(extras.device)} unit={(m) => `${hours(m)} h`} />
            </Card>
            <Card title="Assists" aside="Share of hours driven">
              <ShareList rows={extras.assists.map((r) => ({ id: r.id, value: r.minutes }))} total={minutesOf(extras.assists)} unit={(m) => `${hours(m)} h`} />
            </Card>
            <Card title="Weather" aside="Share of hours driven">
              <ShareList rows={extras.weather.map((r) => ({ id: r.id, value: r.minutes }))} total={minutesOf(extras.weather)} unit={(m) => `${hours(m)} h`} />
            </Card>
          </div>
        </Section>
      ) : null}

      {boards || races ? (
        <Section id="online" title="Boards & races" intro="Public lap board records, weekly challenges and scheduled open races.">
          {boards ? (
            <>
              <Tiles three>
                <Tile label="Times on the boards" value={count(boards.lapsTotal)} note="Standing best laps, all time" />
                <Tile label={`Times set (${stats.days} days)`} value={count(boards.lapsInRange)} note="Still standing on the boards" />
                <Tile label="Weekly challenges" value={count(boards.challenges.length)} note="Recent weeks with times" />
              </Tiles>
              <div className="grid gap-4 md:grid-cols-2">
                <Card title="Board realism" aside={`Times set in the last ${stats.days} days`}>
                  <ShareList rows={boards.lapsBy.realism.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(boards.lapsBy.realism)} unit={count} />
                </Card>
                <Card title="Board tyres" aside={`Times set in the last ${stats.days} days`}>
                  <ShareList rows={boards.lapsBy.compound.map((r) => ({ id: r.id, value: r.n }))} total={countsOf(boards.lapsBy.compound)} unit={count} />
                </Card>
              </div>
              {boards.challenges.length > 0 ? (
                <Card title="Weekly challenges" aside="Newest first">
                  <NumberTable
                    head={["Week", "Times", "Drivers"]}
                    rows={boards.challenges.map((c) => ({ key: c.event, cells: [weekLabel(c.event), count(c.laps), count(c.drivers)] }))}
                    empty="No challenge times yet."
                  />
                </Card>
              ) : null}
            </>
          ) : null}

          {races && races.count > 0 ? (
            <>
              <Tiles>
                <Tile label={`Open races (${stats.days} days)`} value={count(races.count)} note="Scheduled races, all players" />
                <Tile label="Cars a race" value={(races.cars / races.count).toFixed(1)} note={`Largest grid: ${races.fieldMax} cars`} />
                <Tile label="Finish rate" value={percent(races.finished, races.cars)} note={`${count(races.finished)} of ${count(races.cars)} finished`} />
                <Tile label="Race drivers" value={count(races.drivers)} note="Verified names on grids" />
              </Tiles>
              <Card title="Open races per day" aside={`Finished over the last ${stats.days} days`}>
                <BarChart
                  label="Open races finished per day"
                  unit="Races"
                  height={110}
                  partialLast
                  bars={everyDay(stats.from, stats.to, races.perDay, (day) => ({ day, races: 0, cars: 0 })).map((d) => ({
                    label: dayLabel(d.day),
                    value: d.races,
                    readout: `${dayLabel(d.day)}: ${count(d.races)} ${d.races === 1 ? "race" : "races"}, ${count(d.cars)} cars`,
                  }))}
                />
              </Card>
            </>
          ) : null}
        </Section>
      ) : null}

      <p className="lc-hint m-0 border-t border-lc-line pt-6 text-[13px]">
        These numbers are updated hourly from anonymous daily totals and public lap boards; no player is tracked across sessions.{" "}
        <Link href="/privacy#online" className={TEXT_LINK}>
          Read the privacy policy
        </Link>
        {" · "}
        <Link href="/press" className={TEXT_LINK}>
          Press &amp; media
        </Link>
      </p>
    </div>
  );
}
