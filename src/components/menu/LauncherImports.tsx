"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, Disclosure, EmptyState, Meter, TONE_HAIRLINE, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import {
  cancelJob,
  LauncherError,
  launcherPresence,
  readImports,
  readJob,
  startConvert,
  startToolchain,
  type ConvertedPackage,
  type ImportFolder,
  type ImportKind,
  type LauncherCredit,
  type LauncherImports as ImportsState,
  type LauncherJob,
  type LauncherPresence,
} from "@/lib/mods/launcher-imports";

/** How often a running job's status is asked for */
const POLL_MS = 1000;
/** How many of the log's last lines show when it is open */
const SHOWN_LOG = 80;

/**
 * The jobs this page started or saw running (kept while the page lives, across the panel closing and opening): only
 * their results are shown and reported, so the last job of a launcher that ran before a restart isn't announced again
 */
const watchedJobs = new Set<number>();

const mb = (bytes: number): string => `${Math.max(0.1, bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

type Tx = ReturnType<typeof useTranslations<"menu.modConvert">>;

const kindLabel = (tx: Tx, kind: ImportKind): string => {
  switch (kind) {
    case "ac-track":
      return tx("kindAcTrack");
    case "ac-car":
      return tx("kindAcCar");
    case "sd-track":
      return tx("kindSdTrack");
    case "sd-car":
      return tx("kindSdCar");
    case "f1-track":
      return tx("kindF1Track");
    case "blender-track":
      return tx("kindBlenderTrack");
    case "archive":
      return tx("kindArchive");
    case "file":
      return tx("kindFile");
    case "link":
      return tx("kindLink");
    default:
      return tx("kindUnknown");
  }
};

/** Why a folder can't be converted, or null when it can */
const folderHint = (tx: Tx, f: ImportFolder): string | null => {
  switch (f.kind) {
    case "archive":
      return tx("hintArchive");
    case "file":
      return tx("hintFile");
    case "link":
      return tx("hintLink");
    case "unknown":
      return tx("hintUnknown");
    default:
      return f.available ? null : tx("hintNoImporter");
  }
};

/** A refused call, in the player's words */
const refusal = (tx: Tx, err: unknown): string => {
  if (err instanceof LauncherError) {
    switch (err.code) {
      case "busy":
        return tx("errorBusy");
      case "not-ready":
        return tx("errorNotReady");
      case "link":
        return tx("errorLink");
      case "no-importer":
        return tx("hintUnknown");
      case "bad-folder":
        return tx("errorGone");
      case "session":
        return tx("noSession");
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
};

/** A download's program by the name players know it */
const programName = (step: string | undefined): string => (step === "node" ? "Node.js" : (step ?? ""));

/**
 * A field of a converted package's credit as text, or undefined: the launcher passes text only, and the package's own
 * mod.json is the importer's output, so anything else (a number, an object) is left out rather than rendered
 */
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A credit as one line: who, and under what licence */
const creditLine = (c: LauncherCredit | undefined): string => [text(c?.author), text(c?.license)].filter(Boolean).join(" · ");

/** The licences a conversion brought in: the package's, and each circuit's or car's own when it differs */
const LicenceNotes: React.FC<{ tx: Tx; packages: ConvertedPackage[]; notes: string[] }> = ({ tx, packages, notes }) => {
  const credits: { what: string; credit: LauncherCredit }[] = [];
  for (const p of packages) {
    if (p.credit && typeof p.credit === "object") credits.push({ what: text(p.name) ?? text(p.id) ?? "?", credit: p.credit });
    for (const c of Array.isArray(p.content) ? p.content : []) {
      if (c.credit && typeof c.credit === "object" && creditLine(c.credit) !== creditLine(p.credit)) credits.push({ what: text(c.name) ?? text(c.id) ?? "?", credit: c.credit });
    }
  }
  if (!credits.length && !notes.length) return null;
  return (
    <Well className={cx("flex flex-col gap-1.5 px-3.5 py-2.5", TONE_HAIRLINE.warn)} role="note">
      <p className="lc-body m-0 flex items-center gap-2 font-semibold text-lc-caution">
        <Icon name="warning" />
        {tx("licenceTitle")}
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {credits.map(({ what, credit }, i) => (
          <li key={i} className="lc-body m-0">
            <span className="font-semibold text-lc-chalk">{what}</span>
            {": "}
            {tx("licenceLine", { author: text(credit.author) ?? "?", licence: text(credit.license) ?? "?" })}
            {text(credit.note) ? <span className="block text-lc-caution">{text(credit.note)}</span> : null}
          </li>
        ))}
        {notes.map((n, i) => (
          <li key={`n${i}`} className="lc-hint m-0 break-words">
            {n}
          </li>
        ))}
      </ul>
      <p className="lc-hint m-0">{tx("licenceHint")}</p>
    </Well>
  );
};

const JobLog: React.FC<{ tx: Tx; job: LauncherJob }> = ({ tx, job }) => {
  const shown = (job.log ?? []).slice(-SHOWN_LOG);
  const earlier = job.logLines - shown.length;
  return (
    <Disclosure moreLabel={tx("showLog")} lessLabel={tx("hideLog")}>
      <pre
        className="lc-mono m-0 max-h-72 overflow-auto rounded-lc-row bg-black/30 p-3 text-[12px] leading-snug whitespace-pre-wrap text-lc-fog"
        aria-label={tx("logLabel")}
      >
        {earlier > 0 ? `${tx("logEarlier", { count: earlier })}\n` : ""}
        {shown.join("\n")}
      </pre>
    </Disclosure>
  );
};

/** What a running job is doing, with its progress */
const JobProgress: React.FC<{ tx: Tx; job: LauncherJob; python?: string; onCancel: () => void; cancelling: boolean }> = ({
  tx,
  job,
  python,
  onCancel,
  cancelling,
}) => {
  let label: string;
  if (job.type === "toolchain") {
    label = job.step === "python" ? tx("fetchingPython", { version: python ?? "3" }) : tx("downloading", { name: programName(job.step) });
  } else {
    const name = job.folder ?? "";
    label = job.step === "check" ? tx("checking", { name }) : job.step === "copy" ? tx("copying", { name }) : tx("converting", { name });
  }
  const sized = job.total && job.total > 0;
  return (
    <Well className="flex flex-col gap-2.5 px-3.5 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Only the step is announced, when it changes: not the progress and log lines redrawn each second */}
        <p className="lc-body m-0 font-medium text-lc-chalk" role="status" aria-live="polite">
          {label}
        </p>
        <Button size="sm" variant="ghost" icon={<Icon name="close" />} loading={cancelling} onClick={onCancel}>
          {tx("stop")}
        </Button>
      </div>
      {sized ? (
        <Meter
          role="progressbar"
          stacked
          label={programName(job.step)}
          value={(job.done ?? 0) / (job.total ?? 1)}
          tone="info"
          detail={`${mb(job.done ?? 0)} / ${mb(job.total ?? 0)}`}
        />
      ) : (
        <p className="lc-hint m-0">{job.type === "convert" ? tx("convertingHint") : tx("fetchingHint")}</p>
      )}
      {job.log?.length ? <p className="lc-mono m-0 truncate text-[12px] text-lc-slate">{job.log[job.log.length - 1]}</p> : null}
      <JobLog tx={tx} job={job} />
    </Well>
  );
};

/** How the last job ended */
const JobResult: React.FC<{ tx: Tx; job: LauncherJob; onRestart: () => void; onDismiss: () => void }> = ({ tx, job, onRestart, onDismiss }) => {
  const packages = job.packages ?? [];
  const ok = job.state === "done";
  const title =
    job.type === "toolchain"
      ? ok
        ? tx("toolsReady")
        : job.state === "cancelled"
          ? tx("cancelled")
          : tx("toolsFailed")
      : ok
        ? tx("converted", { name: packages.map((p) => text(p.name) ?? p.id).join(", ") || (job.folder ?? "") })
        : job.state === "cancelled"
          ? tx("cancelled")
          : tx("failed", { name: job.folder ?? "" });
  return (
    <div className="flex flex-col gap-2.5">
      <Well
        className={cx("flex flex-col gap-1.5 px-3.5 py-2.5", ok ? TONE_HAIRLINE.good : job.state === "failed" ? TONE_HAIRLINE.bad : undefined)}
        role={job.state === "failed" ? "alert" : "status"}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={cx("lc-body m-0 font-medium", ok ? "text-lc-chalk" : job.state === "failed" ? "text-lc-caution" : "text-lc-slate")}>{title}</p>
          <span className="flex items-center gap-2">
            {ok && job.type === "convert" ? (
              <Button size="sm" variant="primary" icon={<Icon name="restart" />} onClick={onRestart}>
                {tx("restart")}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              {tx("dismiss")}
            </Button>
          </span>
        </div>
        {ok && job.type === "convert" ? <p className="lc-hint m-0">{tx("convertedHint")}</p> : null}
        {job.state === "failed" && job.error ? <p className="lc-hint m-0 break-words">{job.error}</p> : null}
        {job.problems?.length ? (
          <ul className="lc-hint m-0 list-disc ps-5">
            {job.problems.map((p, i) => (
              <li key={i} className="break-words">
                {p}
              </li>
            ))}
          </ul>
        ) : null}
      </Well>
      {job.type === "convert" ? <LicenceNotes tx={tx} packages={packages} notes={job.notes ?? []} /> : null}
      <JobLog tx={tx} job={job} />
    </div>
  );
};

export interface LauncherImportsProps {
  /** A conversion wrote a package: the game lists it once it restarts */
  onConverted?: () => void;
  onRestart: () => void;
}

/**
 * The launcher's import folder in the Mods panel: what a player copied there from another game, each folder with
 * what it was recognised as and a Convert button, the first-use download of the converter's tools, and a
 * conversion's progress, log and result. Shown only when the game runs under the launcher (launcher/api.go).
 */
export const LauncherImports: React.FC<LauncherImportsProps> = ({ onConverted, onRestart }) => {
  const tx = useTranslations("menu.modConvert");
  const [presence, setPresence] = useState<LauncherPresence>("none");
  const present = presence === "session";
  const [state, setState] = useState<ImportsState | null>(null);
  const [job, setJob] = useState<LauncherJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The tools' download asked for: the folder to convert once they are in */
  const [askTools, setAskTools] = useState<{ folder: string | null } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** A start (a conversion, the tools' download) is on its way to the launcher: a second press would only be refused */
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  /** The last job's result was put away */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const mounted = useRef(true);
  /** The folder to convert when the tools' download ends */
  const after = useRef<string | null>(null);
  /** Jobs already reported to the panel */
  const reported = useRef<Set<number>>(new Set());
  if (job?.state === "running") watchedJobs.add(job.id);

  const refresh = useCallback(async () => {
    try {
      const next = await readImports();
      if (!mounted.current) return;
      setState(next);
      setJob(next.job);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(refusal(tx, err));
    }
  }, [tx]);

  useEffect(() => {
    mounted.current = true;
    void launcherPresence().then((p) => {
      if (!mounted.current) return;
      setPresence(p);
      if (p === "session") void refresh();
    });
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // A folder copied in while the game was open shows up when the player comes back to it
  useEffect(() => {
    if (!present) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [present, refresh]);

  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void readJob()
        .then(({ job: next, toolchain }) => {
          if (!mounted.current) return;
          setJob(next);
          setState((s) => (s ? { ...s, toolchain } : s));
        })
        .catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  /**
   * Starts a job, one start at a time: a start that is still on its way holds off a second (a double click), and the
   * job started is watched whatever its answer says, so one that ended at once still shows how
   */
  const begin = useCallback(async (start: () => Promise<LauncherJob>): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const started = await start();
      watchedJobs.add(started.id);
      if (mounted.current) setJob(started);
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  }, []);

  const convert = useCallback(
    async (folder: string) => {
      setError(null);
      setDismissed(null);
      try {
        await begin(() => startConvert(folder));
      } catch (err) {
        if (!mounted.current) return;
        if (err instanceof LauncherError && err.code === "not-ready") {
          setAskTools({ folder });
          return;
        }
        setError(refusal(tx, err));
      }
    },
    [tx, begin],
  );

  // A job ended: the folder list again, the panel told of a new package, and a conversion that waited on the tools
  useEffect(() => {
    if (!job || job.state === "running" || reported.current.has(job.id) || !watchedJobs.has(job.id)) return;
    reported.current.add(job.id);
    setCancelling(false);
    void refresh();
    if (job.type === "convert" && job.packages?.length) onConverted?.();
    if (job.type === "toolchain" && job.state === "done" && after.current) {
      const folder = after.current;
      after.current = null;
      void convert(folder);
    }
  }, [job, refresh, onConverted, convert]);

  if (presence === "none") return null;
  if (!present) {
    return (
      <section className="flex flex-col gap-3 border-t border-lc-line pt-4" aria-labelledby="lc-launcher-imports">
        <h3 id="lc-launcher-imports" className="lc-h3 m-0">
          {tx("title")}
        </h3>
        <Well className="px-3.5 py-2.5">
          <p className="lc-body m-0 text-lc-caution">{tx("noSession")}</p>
        </Well>
      </section>
    );
  }

  const tools = state?.toolchain;
  const downloadBytes = (tools?.downloads ?? []).reduce((n, d) => n + d.bytes, 0);
  const totalBytes = downloadBytes + (tools?.pythonApproxBytes ?? 0);

  const onConvert = (folder: string) => {
    if (startingRef.current) return;
    if (tools?.state === "missing") {
      setAskTools({ folder });
      return;
    }
    void convert(folder);
  };

  const onDownload = async () => {
    after.current = askTools?.folder ?? null;
    setAskTools(null);
    setError(null);
    setDismissed(null);
    try {
      await begin(startToolchain);
    } catch (err) {
      after.current = null;
      if (mounted.current) setError(refusal(tx, err));
    }
  };

  const onCancel = async () => {
    setCancelling(true);
    after.current = null;
    try {
      await cancelJob();
    } catch {
      setCancelling(false);
    }
  };

  const folders = state?.folders ?? [];
  const showResult = job && job.state !== "running" && watchedJobs.has(job.id) && dismissed !== job.id;

  return (
    <section className="flex flex-col gap-3 border-t border-lc-line pt-4" aria-labelledby="lc-launcher-imports">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="lc-launcher-imports" className="lc-h3 m-0">
          {tx("title")}
        </h3>
        <Button size="sm" variant="ghost" icon={<Icon name="refresh" />} onClick={() => void refresh()}>
          {tx("refresh")}
        </Button>
      </div>
      <p className="lc-body m-0 max-w-[70ch]">{tx("intro")}</p>
      {state ? (
        <Well className="flex flex-col gap-1 px-3.5 py-2.5">
          <span className="lc-hint">{tx("folder")}</span>
          <span className="lc-mono text-[13px] break-all text-lc-chalk">{state.importDir}</span>
        </Well>
      ) : null}

      {state && !state.converter.available ? (
        <Well className="px-3.5 py-2.5">
          <p className="lc-body m-0 text-lc-caution">{tx("noConverter")}</p>
        </Well>
      ) : null}
      {tools?.state === "unsupported" ? (
        <Well className="px-3.5 py-2.5">
          <p className="lc-body m-0 text-lc-caution">{tx("toolsUnsupported")}</p>
        </Well>
      ) : null}

      {askTools && tools && !running ? (
        <Well className={cx("flex flex-col gap-2 px-3.5 py-3", TONE_HAIRLINE.info)} role="region" aria-labelledby="lc-tools-title">
          <p id="lc-tools-title" className="lc-body m-0 font-semibold text-lc-chalk">
            {tx("toolsTitle")}
          </p>
          <p className="lc-body m-0">{tx("toolsBody", { size: mb(totalBytes) })}</p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {(tools.downloads ?? []).map((d) => (
              <li key={d.name} className="lc-hint m-0">
                <span className="text-lc-chalk">
                  {programName(d.name)} {d.version}
                </span>
                {` · ${mb(d.bytes)} · `}
                <span className="lc-mono text-[12px] break-all">SHA-256 {d.sha256.slice(0, 16)}…</span>
              </li>
            ))}
            <li className="lc-hint m-0">
              <span className="text-lc-chalk">{tx("toolsPython", { version: tools.python ?? "3" })}</span>
              {` · ${tx("about", { size: mb(tools.pythonApproxBytes ?? 0) })}`}
            </li>
          </ul>
          <p className="lc-hint m-0 break-all">{tx("toolsWhere", { dir: tools.dir })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<Icon name="download" />} loading={starting} disabled={starting} onClick={() => void onDownload()}>
              {tx("toolsDownload", { size: mb(totalBytes) })}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAskTools(null)}>
              {tx("notNow")}
            </Button>
          </div>
        </Well>
      ) : null}

      {error ? (
        <Well className="px-3.5 py-2.5" role="alert">
          <p className="lc-body m-0 text-lc-caution">{error}</p>
        </Well>
      ) : null}

      {job && running ? <JobProgress tx={tx} job={job} python={tools?.python} onCancel={() => void onCancel()} cancelling={cancelling} /> : null}
      {job && showResult ? <JobResult tx={tx} job={job} onRestart={onRestart} onDismiss={() => setDismissed(job.id)} /> : null}

      {state && folders.length === 0 ? (
        <EmptyState icon={<Icon name="browse" />}>{tx("empty")}</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {folders.map((f) => {
            const hint = folderHint(tx, f);
            const convertible = hint === null && state?.converter.available && tools?.state !== "unsupported";
            return (
              <li key={f.name} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-lc-line py-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-lc-chalk">{f.name}</span>
                  {hint ? <span className="lc-hint">{hint}</span> : null}
                </span>
                <Badge size="sm" tone={f.available ? "info" : "neutral"} variant="outline">
                  {kindLabel(tx, f.kind)}
                </Badge>
                {convertible ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={tx("convertNamed", { name: f.name })}
                    loading={running && job?.type === "convert" && job.folder === f.name}
                    disabled={running || starting}
                    onClick={() => onConvert(f.name)}
                  >
                    {tx("convert")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
