"use client";

/**
 * The owner's numbers from the anonymous usage counter and the boards (GET <api>/admin/stats). The key is asked for
 * once and kept for this browser tab only (sessionStorage); it goes out only in the X-Admin-Key header.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { onlineUrl } from "@/lib/net/online-config";
import type { AdminStats as StatsBody, UsageGroup } from "../../../cloudflare/api/admin";

const KEY_STORE = "librecorsa.adminKey";
const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const MODE_NAMES: Record<string, string> = {
  practice: "Practice",
  time_trial: "Time trial",
  ai_race: "Race against AI",
  open_race: "Open race",
  room_race: "Room race",
};

const readKey = (): string => {
  try {
    return sessionStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
};
const keepKey = (key: string | null) => {
  try {
    if (key) sessionStorage.setItem(KEY_STORE, key);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    // Not kept: asked again on the next visit
  }
};

/** Hours from minutes: one decimal below ten hours, whole hours above */
const hours = (minutes: number) => {
  const h = minutes / 60;
  return h >= 10 ? Math.round(h).toLocaleString("en-GB") : h.toFixed(1);
};
const count = (n: number) => n.toLocaleString("en-GB");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-09" → "9 Nov" */
const dayLabel = (iso: string) => {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
};

/** Every UTC day from `from` to `to`, with the days nobody drove as zero */
function everyDay(stats: StatsBody): { day: string; sessions: number; minutes: number }[] {
  const byDay = new Map(stats.perDay.map((d) => [d.day, d]));
  const out = [];
  for (let t = Date.parse(`${stats.from}T00:00:00Z`); t <= Date.parse(`${stats.to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, sessions: 0, minutes: 0 });
  }
  return out;
}

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

/** Circuit and car names, loaded once there are numbers to name (the car list brings the sims with it) */
function useNames(active: boolean): { circuit: Namer; car: Namer } {
  const [names, setNames] = useState<{ circuit: Namer; car: Namer }>({ circuit: asIs, car: asIs });
  useEffect(() => {
    if (!active) return;
    let live = true;
    void Promise.all([import("@/lib/track-registry"), import("@/lib/cars/car-registry")])
      .then(([tracks, cars]) => {
        if (!live) return;
        const circuit: Namer = (id) => {
          const t = tracks.TRACKS.find((x) => x.id === id);
          if (!t) return id;
          const layouts = tracks.venueOf(id)?.layouts.length ?? 1;
          return layouts > 1 && t.layout ? `${t.name} · ${t.layout}` : t.name;
        };
        // The first car on that vehicle model, as the boards name it (not carForVehicle: it falls back to another car)
        const car: Namer = (id) => cars.CARS.find((c) => c.physics === id)?.title ?? id;
        setNames({ circuit, car });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active]);
  return names;
}

const CARD = "rounded-[18px] border border-[#262B3D] bg-[#11131A]";
const H2 = "lc-title text-[18px] text-[#F5F7FA]";

export function AdminStats() {
  const [key, setKey] = useState("");
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState<Range>(30);
  const [stats, setStats] = useState<StatsBody | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const names = useNames(stats !== null);

  useEffect(() => setKey(readKey()), []);

  const load = useCallback(async (adminKey: string, range: Range) => {
    const url = onlineUrl(`/admin/stats?days=${range}`);
    if (!url) {
      setState("error");
      setMessage("This build has no online side.");
      return;
    }
    setState("loading");
    setMessage(null);
    try {
      const res = await fetch(url, { headers: { "X-Admin-Key": adminKey }, credentials: "omit", cache: "no-store" });
      if (res.status === 404) {
        keepKey(null);
        setKey("");
        setStats(null);
        setState("error");
        setMessage("That key opens nothing here.");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setStats((await res.json()) as StatsBody);
      setState("idle");
    } catch {
      setState("error");
      setMessage("The numbers could not be read. Try again in a moment.");
    }
  }, []);

  useEffect(() => {
    if (key) void load(key, days);
  }, [key, days, load]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const k = draft.trim();
    if (!k) return;
    keepKey(k);
    setDraft("");
    setKey(k);
  };
  const forget = () => {
    keepKey(null);
    setKey("");
    setStats(null);
    setMessage(null);
  };

  return (
    // The body never scrolls (the game fills the screen), so this page scrolls itself
    <main className="h-dvh overflow-y-auto bg-[#08090D] text-[#F5F7FA]">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-8 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="LibreCorsa home" className="no-underline">
            <LibreCorsaLogo variant="compact" size="sm" />
          </Link>
          {key ? (
            <button type="button" onClick={forget} className="lc-lbl rounded-full border border-[#262B3D] px-4 py-2 text-[#8E96AA] transition-colors hover:border-[#3A4157] hover:text-[#F5F7FA]">
              Forget key
            </button>
          ) : null}
        </header>

        <section className="flex flex-col gap-3">
          <p className="lc-lbl">Private</p>
          <h1 className="lc-disp text-[clamp(36px,7vw,56px)] text-[#F5F7FA]">Numbers</h1>
          <p className="max-w-[640px] text-[15px] leading-relaxed text-[#C5CBD8]">
            Minutes driven per day, circuit, car, mode and country. Nothing here tells one player from another.
          </p>
        </section>

        {!key ? (
          <form onSubmit={submit} className={`${CARD} flex max-w-[480px] flex-col gap-3 p-5`}>
            <label htmlFor="admin-key" className="lc-lbl">
              Admin key
            </label>
            <div className="flex gap-2">
              <input
                id="admin-key"
                type="password"
                autoComplete="off"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="lc-data min-w-0 flex-1 rounded-[12px] border border-[#262B3D] bg-[#08090D] px-3 py-2.5 text-[15px] text-[#F5F7FA] outline-none focus:border-[#CCFF00]"
              />
              <button type="submit" className="lc-title rounded-full bg-[#CCFF00] px-5 py-2.5 text-[15px] text-[#08090D] transition-colors hover:bg-[#99BF00]">
                Open
              </button>
            </div>
            <p className="text-[13px] text-[#8E96AA]">Kept in this tab only.</p>
            {message ? <p className="text-[14px] text-[#FF6B6B]">{message}</p> : null}
          </form>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div role="radiogroup" aria-label="Range" className="inline-flex rounded-full border border-[#262B3D] bg-[#11131A] p-1">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={days === r}
                    onClick={() => setDays(r)}
                    className={`lc-lbl rounded-full px-4 py-1.5 transition-colors ${days === r ? "bg-[#CCFF00] !text-[#08090D]" : "text-[#8E96AA] hover:text-[#F5F7FA]"}`}
                  >
                    {r} days
                  </button>
                ))}
              </div>
              <p className="lc-lbl" aria-live="polite">
                {state === "loading" ? "Loading…" : stats ? `${dayLabel(stats.from)} – ${dayLabel(stats.to)} · UTC` : ""}
              </p>
            </div>
            {message ? <p className="text-[14px] text-[#FF6B6B]">{message}</p> : null}
            {stats ? <Dashboard stats={stats} names={names} /> : null}
          </>
        )}
      </div>
    </main>
  );
}

function Dashboard({ stats, names }: { stats: StatsBody; names: { circuit: Namer; car: Namer } }) {
  const perSession = stats.totals.sessions > 0 ? stats.totals.minutes / stats.totals.sessions : 0;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Sessions" value={count(stats.totals.sessions)} />
        <Tile label="Hours driven" value={hours(stats.totals.minutes)} />
        <Tile label="Minutes a session" value={perSession.toFixed(1)} />
        <Tile label="Countries" value={count(stats.byCountry.filter((c) => c.id !== "XX").length)} />
      </div>

      <section className={`${CARD} flex flex-col gap-4 p-5`} aria-labelledby="per-day">
        <h2 id="per-day" className={H2}>
          Hours per day
        </h2>
        <DayChart stats={stats} />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <TopList id="circuits" title="Circuits" rows={stats.byCircuit} name={names.circuit} />
        <TopList id="cars" title="Cars" rows={stats.byCar} name={names.car} />
        <TopList id="modes" title="Modes" rows={stats.byMode} name={(id) => MODE_NAMES[id] ?? id} />
        <TopList id="countries" title="Countries" rows={stats.byCountry} name={countryName} />
      </div>

      <section className={`${CARD} flex flex-col gap-4 p-5`} aria-labelledby="boards">
        <h2 id="boards" className={H2}>
          Boards and races
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Small label="Names claimed" value={count(stats.board.drivers)} />
          <Small label="Names seen in range" value={count(stats.board.driversActive)} />
          <Small label="Laps on the boards" value={count(stats.board.laps)} />
          <Small label="Laps set in range" value={count(stats.board.lapsInRange)} />
          {stats.races ? (
            <>
              <Small label="Open races" value={count(stats.races.open)} />
              <Small label="Room races" value={count(stats.races.room)} />
              <Small label="Cars classified" value={count(stats.races.cars)} />
            </>
          ) : null}
        </div>
        {stats.board.boards.length ? (
          <ul className="flex flex-col divide-y divide-[#262B3D]">
            {stats.board.boards.slice(0, 12).map((b) => (
              <li key={`${b.trackId}/${b.vehicle}/${b.physics}/${b.event}`} className="flex items-center justify-between gap-4 py-2 text-[14px]">
                <span className="min-w-0 text-[#C5CBD8]">
                  {names.circuit(b.trackId)} · {names.car(b.vehicle)}
                  <span className="text-[#8E96AA]">{b.event ? ` · ${b.event}` : ""} · rev {b.physics}</span>
                </span>
                <span className="lc-data shrink-0 text-[#F5F7FA]">{count(b.laps)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${CARD} flex flex-col gap-1.5 p-4`}>
      <p className="lc-lbl">{label}</p>
      <p className="lc-data text-[28px] leading-none text-[#F5F7FA]">{value}</p>
    </div>
  );
}

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="lc-lbl">{label}</p>
      <p className="lc-data text-[20px] text-[#F5F7FA]">{value}</p>
    </div>
  );
}

/** Hours per day as bars (inline SVG); each bar's tooltip has its sessions */
function DayChart({ stats }: { stats: StatsBody }) {
  const days = useMemo(() => everyDay(stats), [stats]);
  const max = Math.max(1, ...days.map((d) => d.minutes));
  const W = 1000;
  const H = 180;
  const step = W / days.length;
  const gap = Math.min(4, step * 0.25);
  const peak = days.reduce((a, b) => (b.minutes > a.minutes ? b : a), days[0]);
  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[180px] w-full"
        role="img"
        aria-label={`Hours driven per day, ${dayLabel(stats.from)} to ${dayLabel(stats.to)}; most on ${peak ? dayLabel(peak.day) : "no day"}, ${peak ? hours(peak.minutes) : 0} hours`}
      >
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="#262B3D" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {days.map((d, i) => {
          const h = (d.minutes / max) * (H - 8);
          return (
            <rect key={d.day} x={i * step + gap / 2} y={H - h} width={Math.max(1, step - gap)} height={h} rx={2} fill={d.minutes > 0 ? "#CCFF00" : "transparent"}>
              <title>{`${dayLabel(d.day)}: ${hours(d.minutes)} h, ${count(d.sessions)} sessions`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="lc-lbl flex justify-between">
        <span>{dayLabel(stats.from)}</span>
        <span>Peak {hours(peak.minutes)} h</span>
        <span>{dayLabel(stats.to)}</span>
      </div>
    </div>
  );
}

/** A top list: hours as a bar against the first row's, sessions beside it */
function TopList({ id, title, rows, name }: { id: string; title: string; rows: UsageGroup[]; name: Namer }) {
  const top = rows.slice(0, 10);
  const max = Math.max(1, ...top.map((r) => r.minutes));
  return (
    <section className={`${CARD} flex flex-col gap-3 p-5`} aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className={H2}>
          {title}
        </h2>
        <span className="lc-lbl">Hours · sessions</span>
      </div>
      {top.length ? (
        <ul className="flex flex-col gap-2.5">
          {top.map((r) => (
            <li key={r.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3 text-[14px]">
                <span className="min-w-0 truncate text-[#C5CBD8]" title={r.id}>
                  {name(r.id)}
                </span>
                <span className="lc-data shrink-0 text-[#F5F7FA]">
                  {hours(r.minutes)} <span className="text-[#8E96AA]">· {count(r.sessions)}</span>
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-[#1A1E2A]">
                <div className="h-full rounded-full bg-[#CCFF00]" style={{ width: `${(r.minutes / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[14px] text-[#8E96AA]">Nothing in this range.</p>
      )}
    </section>
  );
}
