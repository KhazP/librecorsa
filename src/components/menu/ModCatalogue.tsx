"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, Meter, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { modDefinitions } from "@/lib/mods/mod-content";
import {
  catalogueStatus,
  CONFIGURED_CATALOGUE,
  downloadPackage,
  DownloadError,
  loadCatalogues,
  type CatalogueEntry,
  type CatalogueListing,
} from "@/lib/mods/mod-catalogue";
import type { LoadedPackage } from "@/lib/mods/mod-loader";
import { installPackage, modsStorageAvailable, zipSource } from "@/lib/mods/mod-store";

export interface ModCatalogueProps {
  /** The installed packages, to tell what is installed already and what would be an update */
  installed: readonly LoadedPackage[];
  /**
   * Takes the Mods panel's one-job-at-a-time hold for a download and its install: hands back a function that lets it
   * go, or null while an import or a removal has it
   */
  claim: () => (() => void) | null;
  /** Another of the panel's jobs runs: nothing can be got until it ends */
  blocked: boolean;
  /** A package went in: the panel lists it and asks for a restart */
  onInstalled: () => void;
}

/** A download under way, then its install */
type Job = { entry: CatalogueEntry; phase: "downloading" | "installing"; received: number };
/** What the last download said */
type Note = { tone: "good" | "bad" | "info"; text: string; errors?: string[] };

/** How many of an install's problems are shown */
const SHOWN_ERRORS = 8;

/** Sizes as the Mods panel shows them */
const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The packages a catalogue offers (src/lib/mods/mod-catalogue.ts), in the Mods panel: each with what it adds, its
 * author and licence, and a button that downloads it, checks it against the catalogue and installs it. The catalogues
 * are read when the panel opens. With none, or one that lists nothing, nothing shows here at all; only a catalogue the
 * build names and can't reach (offline) says so.
 */
export const ModCatalogue: React.FC<ModCatalogueProps> = ({ installed, claim, blocked, onInstalled }) => {
  const t = useTranslations("menu.modCatalogue");
  const tm = useTranslations("menu.mods");
  const headingId = useId();
  const [listing, setListing] = useState<CatalogueListing | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [job, setJob] = useState<Job | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const download = useRef<AbortController | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  /** Set when a download ends, so the outcome takes the focus once it is on screen */
  const focusOutcome = useRef(false);
  const mounted = useRef(true);
  const storage = modsStorageAvailable();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Closing the panel stops a download (an install under way finishes: it can't be cut short safely)
      download.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!storage) return;
    const abort = new AbortController();
    void loadCatalogues(CONFIGURED_CATALOGUE, { signal: abort.signal })
      .catch(() => ({ packages: [], unreachable: !!CONFIGURED_CATALOGUE }))
      .then((read) => {
        if (!abort.signal.aborted) setListing(read);
      });
    return () => abort.abort();
  }, [attempt, storage]);

  /** What a failed download or install says: a cancelled download is no error */
  const failure = (err: unknown, name: string): Note => {
    if (!(err instanceof DownloadError)) return { tone: "bad", text: tm("importFailed", { name }), errors: [err instanceof Error ? err.message : String(err)] };
    if (err.failure === "aborted") return { tone: "info", text: t("cancelled", { name }) };
    const why = {
      offline: () => t("errorOffline"),
      network: () => t("errorNetwork"),
      http: () => t("errorHttp", { status: String(err.status ?? "") }),
      insecure: () => t("errorInsecure"),
      size: () => t("errorSize"),
      checksum: () => t("errorChecksum"),
    }[err.failure]();
    return { tone: "bad", text: t("downloadFailed", { name }), errors: [why] };
  };

  const get = async (entry: CatalogueEntry) => {
    const release = claim();
    if (!release) return;
    const abort = new AbortController();
    download.current = abort;
    setNote(null);
    const started: Job = { entry, phase: "downloading", received: 0 };
    setJob(started);
    // One re-render per percent, or four a second, whichever comes first
    let shown = 0;
    let shownAt = 0;
    let result: Note;
    try {
      const blob = await downloadPackage(entry, {
        signal: abort.signal,
        onProgress: (received) => {
          const now = performance.now();
          if (received - shown < entry.bytes / 100 && now - shownAt < 250 && received < entry.bytes) return;
          shown = received;
          shownAt = now;
          if (mounted.current) setJob({ ...started, received });
        },
      });
      download.current = null;
      if (mounted.current) setJob({ ...started, phase: "installing", received: entry.bytes });
      const installedNow = await installPackage(await zipSource(blob), modDefinitions(), { id: entry.id, hash: entry.hash });
      if (installedNow.ok) {
        const values = { name: installedNow.manifest.name, version: installedNow.manifest.version };
        result = { tone: "good", text: tm(installedNow.replaced ? "replaced" : "imported", values) };
        onInstalled();
      } else result = { tone: "bad", text: tm("importFailed", { name: entry.name }), errors: installedNow.errors };
    } catch (err) {
      result = failure(err, entry.name);
    } finally {
      download.current = null;
      release();
    }
    if (!mounted.current) return;
    focusOutcome.current = true;
    setJob(null);
    setNote(result);
  };

  // The button pressed may be gone (an Installed badge in its place), taking the focus with it: the outcome takes it
  // then, so a keyboard or screen reader user lands on what happened rather than at the top of the page
  useEffect(() => {
    if (!note || !focusOutcome.current) return;
    focusOutcome.current = false;
    const at = document.activeElement;
    if (!at || at === document.body) noteRef.current?.focus();
  }, [note]);

  if (!storage) return null;
  // Nothing found: no section, unless the catalogue the build names is out of reach
  const packages = listing?.packages ?? [];
  if (listing && !packages.length && !listing.unreachable) return null;
  // Still looking: only a copy that names a catalogue says so (this copy's own is usually not there)
  if (!listing && !CONFIGURED_CATALOGUE) return null;

  const counts = (e: CatalogueEntry): string[] => {
    const parts: string[] = [];
    if (e.circuits) parts.push(tm("circuits", { count: e.circuits }));
    if (e.cars) parts.push(tm("cars", { count: e.cars }));
    if (e.liveries) parts.push(tm("liveries", { count: e.liveries }));
    return parts;
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 border-t border-lc-line pt-4">
      <h3 id={headingId} className="lc-row-label m-0">
        {t("title")}
      </h3>
      {!listing ? (
        <p className="lc-hint m-0" role="status">
          {t("loading")}
        </p>
      ) : null}
      {listing && packages.length ? <p className="lc-hint m-0 max-w-[70ch]">{t("intro")}</p> : null}
      {listing?.unreachable ? (
        <Well className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <span className="lc-body m-0 text-lc-caution">{t("unreachable")}</span>
          <Button size="sm" variant="secondary" icon={<Icon name="refresh" />} disabled={job !== null}
            onClick={() => {
              setListing(null);
              setAttempt((n) => n + 1);
            }}
          >
            {t("retry")}
          </Button>
        </Well>
      ) : null}

      <p className="lc-hint m-0" role="status">
        {job ? t(job.phase === "downloading" ? "downloading" : "installing", { name: job.entry.name }) : ""}
      </p>
      {note ? (
        <Well className="flex flex-col gap-1.5 px-3.5 py-2.5" role={note.tone === "bad" ? "alert" : "status"}>
          <p ref={noteRef} tabIndex={-1} className={cx("lc-body m-0 font-medium outline-none", note.tone === "bad" ? "text-lc-caution" : "text-lc-chalk")}>
            {note.text}
          </p>
          {note.errors?.length ? (
            <ul className="lc-hint m-0 list-disc ps-5">
              {note.errors.slice(0, SHOWN_ERRORS).map((e, i) => (
                <li key={i} className="break-words">
                  {e}
                </li>
              ))}
              {note.errors.length > SHOWN_ERRORS ? <li>{tm("moreProblems", { count: note.errors.length - SHOWN_ERRORS })}</li> : null}
            </ul>
          ) : null}
        </Well>
      ) : null}

      {packages.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {packages.map((e) => {
            const status = catalogueStatus(e, installed);
            const active = job?.entry.id === e.id ? job : null;
            const meta = [e.author, ...counts(e), formatSize(e.bytes)];
            return (
              <li key={e.id} className="flex flex-col gap-1.5 border-t border-lc-line py-3 first:border-t-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {e.preview ? (
                    // A picture from the catalogue's host: decorative, the name says what it is
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.preview} alt="" loading="lazy" decoding="async" className="h-10 w-16 shrink-0 rounded-lc-row bg-lc-well object-cover" />
                  ) : null}
                  <span className="flex min-w-0 flex-1 flex-col">
                    {/* A long name is cut short, never its version */}
                    <span className="flex min-w-0 items-baseline gap-1.5 font-semibold text-lc-chalk">
                      <span className="truncate">{e.name}</span>
                      <span className="max-w-[45%] shrink-0 truncate font-normal text-lc-slate">{e.version}</span>
                    </span>
                    <span className="lc-hint truncate">
                      {meta.join(" · ")}
                      {" · "}
                      {e.licenseUrl ? (
                        <a href={e.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          {t("licence", { licence: e.license })}
                        </a>
                      ) : (
                        t("licence", { licence: e.license })
                      )}
                    </span>
                  </span>
                  {status.kind === "installed" && !active ? (
                    <Badge size="sm" tone="good" variant="soft" icon="downloaded">
                      {t("installed")}
                    </Badge>
                  ) : active ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Icon name="close" />}
                      aria-label={t("cancelNamed", { name: e.name })}
                      // The install can't be cut short once the download is in
                      disabled={active.phase !== "downloading"}
                      onClick={() => download.current?.abort()}
                    >
                      {t("cancel")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={status.kind === "update" ? "secondary" : "primary"}
                      icon={<Icon name="download" />}
                      aria-label={status.kind === "update" ? t("updateNamed", { name: e.name, version: e.version }) : t("getNamed", { name: e.name })}
                      disabled={job !== null || blocked}
                      onClick={() => void get(e)}
                    >
                      {t(status.kind === "update" ? "update" : "get")}
                    </Button>
                  )}
                </div>
                {e.description ? <p className="lc-hint m-0 line-clamp-2 max-w-[70ch]">{e.description}</p> : null}
                {status.kind === "update" && !active ? <p className="lc-hint m-0">{t("youHave", { version: status.installedVersion || "?" })}</p> : null}
                {active ? (
                  <Meter
                    role="progressbar"
                    stacked
                    label={t("progressLabel", { name: e.name })}
                    value={active.received / e.bytes}
                    detail={t("progress", { done: formatSize(active.received), total: formatSize(e.bytes) })}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};
