"use client";

import { useState } from "react";
import { Segmented, Select } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { coverageGroup, type CoverageGroup, type CoverageItem } from "@/lib/press";
import { CARD_ICON, CARD_LINK, day, language } from "./press-ui";

type GroupFilter = "all" | CoverageGroup;

const GROUPS: { id: CoverageGroup; label: string }[] = [
  { id: "written", label: "Written" },
  { id: "video", label: "Videos" },
  { id: "podcast", label: "Podcasts" },
];

/** Entries with no language code are in English */
const langOf = (a: CoverageItem) => a.lang ?? "en";

/** A filter option's label with how many entries it holds */
const counted = (label: string, n: number) => (
  <>
    {label} <span className="lc-mono text-[12px] opacity-60">{n}</span>
  </>
);

/**
 * The coverage cards, filtered by kind (written or video) and language. The page renders every card on the server;
 * the filters only hide some.
 */
export function CoverageList({ items }: { items: CoverageItem[] }) {
  const [group, setGroup] = useState<GroupFilter>("all");
  const [lang, setLang] = useState("all");

  const groups = GROUPS.filter((g) => items.some((a) => coverageGroup(a.kind) === g.id));
  // Most-covered language first
  const counts = new Map<string, number>();
  for (const a of items) counts.set(langOf(a), (counts.get(langOf(a)) ?? 0) + 1);
  const langs = [...counts].sort((a, b) => b[1] - a[1]).map(([code]) => code);

  const shown = items.filter(
    (a) => (group === "all" || coverageGroup(a.kind) === group) && (lang === "all" || langOf(a) === lang),
  );

  const langOptions = [
    { id: "all", label: counted("All languages", items.length) },
    ...langs.map((code) => ({ id: code, label: counted(language(code), counts.get(code)!) })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {groups.length > 1 ? (
          <Segmented
            aria-label="Kind"
            size="sm"
            value={group}
            onChange={setGroup}
            options={[
              { id: "all", label: counted("All", items.length) },
              ...groups.map((g) => ({
                id: g.id,
                label: counted(g.label, items.filter((a) => coverageGroup(a.kind) === g.id).length),
              })),
            ]}
          />
        ) : null}
        {langs.length > 1 ? (
          // A segmented row holds five options at most; more languages go in a list
          langOptions.length <= 5 ? (
            <Segmented aria-label="Language" size="sm" value={lang} onChange={setLang} options={langOptions} />
          ) : (
            <Select
              aria-label="Language"
              value={lang}
              onChange={setLang}
              options={[
                { id: "all", label: "All languages" },
                ...langs.map((code) => ({ id: code, label: language(code) })),
              ]}
            />
          )
        ) : null}
        <p className="lc-data m-0 text-[13px] font-medium text-lc-slate sm:ml-auto" aria-live="polite">
          {shown.length === items.length ? `${items.length} pieces` : `${shown.length} of ${items.length}`}
        </p>
      </div>

      {shown.length ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((a) => (
            <li key={a.url} className="flex">
              <a href={a.url} target="_blank" rel="noopener" className={`${CARD_LINK} flex w-full flex-col gap-3 p-4.5 sm:px-5`}>
                <div className="flex items-start justify-between gap-4">
                  <h3 className="m-0 text-[17px] leading-snug font-semibold text-pretty text-lc-chalk">{a.title}</h3>
                  <Icon name={coverageGroup(a.kind) === "video" ? "play" : "externalLink"} className={`mt-1 ${CARD_ICON}`} />
                </div>
                <div className="mt-auto flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="lc-body m-0 text-[14px] text-lc-slate">
                    <span className="text-lc-fog">{a.outlet}</span> <span aria-hidden>·</span>{" "}
                    {a.lang ? `${a.kind} in ${language(a.lang)}` : a.kind}
                    {a.author ? (
                      <>
                        {" "}
                        <span aria-hidden>·</span> {a.author}
                      </>
                    ) : null}{" "}
                    <span aria-hidden>·</span> <span className="lc-mono whitespace-nowrap">{day(a.date)}</span>
                  </p>
                  {a.engagement ? (
                    <p className="lc-data m-0 shrink-0 text-[13px] font-medium text-lc-chalk">{a.engagement}</p>
                  ) : null}
                </div>
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="lc-body m-0 text-[16px]">
          Nothing like that yet.{" "}
          <button
            type="button"
            onClick={() => {
              setGroup("all");
              setLang("all");
            }}
            className="inline-flex cursor-pointer items-center font-medium text-lc-chalk underline decoration-lc-keyline underline-offset-4 hover:decoration-lc-chalk pointer-coarse:min-h-11"
          >
            Show everything
          </button>
        </p>
      )}
    </div>
  );
}
