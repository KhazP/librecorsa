"use client";

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Button, ConfirmDialog, EmptyState, Toggle, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { LauncherImports } from "@/components/menu/LauncherImports";
import { launcherPresence, openLauncherFolder, type LauncherPresence } from "@/lib/mods/launcher-imports";
import { REPO_URL } from "@/lib/site";
import { modDefinitions } from "@/lib/mods/mod-content";
import { modsState, modsSwitchedOff, readPackages, type LoadedPackage } from "@/lib/mods/mod-loader";
import {
  filesSource,
  holdModsStore,
  installPackage,
  modsStorageAvailable,
  modsStoreHeld,
  onModsStoreHold,
  removePackage,
  setPackageEnabled,
  zipSource,
  type PackageSource,
} from "@/lib/mods/mod-store";
import { ZipError } from "@/lib/mods/zip-reader";
import { ModCatalogue } from "./ModCatalogue";

/** What the last import said */
type ImportNote = { tone: "good" | "bad"; text: string; errors?: string[] };
/** An import under way: which button started it, and the package's file or folder name */
type Busy = { kind: "zip" | "folder"; name: string };

/** How many of a list of problems are shown before "and N more" */
const SHOWN_ERRORS = 8;

/** The page again, with mods back on when `?mods=off` switched them off for this visit */
const restart = () => {
  const url = new URL(window.location.href);
  if (url.searchParams.get("mods") !== "off") {
    window.location.reload();
    return;
  }
  url.searchParams.delete("mods");
  window.location.assign(url.href);
};

const ErrorList: React.FC<{ errors: readonly string[]; more: (count: number) => string }> = ({ errors, more }) => (
  <ul className="lc-hint m-0 list-disc ps-5">
    {errors.slice(0, SHOWN_ERRORS).map((e, i) => (
      <li key={i} className="break-words">
        {e}
      </li>
    ))}
    {errors.length > SHOWN_ERRORS ? <li>{more(errors.length - SHOWN_ERRORS)}</li> : null}
  </ul>
);

const formatSize = (bytes: number | undefined): string | null => {
  if (!bytes) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

/**
 * The Mods panel: the installed packages (imported here, or in the launcher's mods folder), switched on and off,
 * imported from a zip or a folder, and removed. What a package adds joins the game's lists when it starts
 * (mod-loader.ts), so a change asks for a restart rather than reshuffling the menus under the player.
 */
export const ModsPanel: React.FC = () => {
  const tx = useTranslations("menu.mods");
  const [packages, setPackages] = useState<LoadedPackage[]>(() => modsState().packages);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [note, setNote] = useState<ImportNote | null>(null);
  const [changed, setChanged] = useState(false);
  const [removing, setRemoving] = useState<LoadedPackage | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  // One import, removal or download at a time, held from the click (state alone lets a quick second click through),
  // and kept in mod-store.ts, so a panel closed and opened again while one runs keeps its buttons off too
  const held = useSyncExternalStore(onModsStoreHold, modsStoreHeld, () => false);
  // Only the latest list read may land, and none after the panel closes
  const listReq = useRef(0);
  const mounted = useRef(true);
  const storage = modsStorageAvailable();
  // Under the launcher, in its own window: the mods folder is the player's (Documents/LibreCorsa/mods), opened from here
  const [launcher, setLauncher] = useState<LauncherPresence>("none");
  useEffect(() => {
    void launcherPresence().then((p) => {
      if (mounted.current) setLauncher(p);
    });
  }, []);
  const openFolder = async () => {
    try {
      await openLauncherFolder("mods");
    } catch (err) {
      if (mounted.current) setNote({ tone: "bad", text: tx("openFailed"), errors: [err instanceof Error ? err.message : String(err)] });
    }
  };

  const refresh = useCallback(() => {
    const req = ++listReq.current;
    void readPackages()
      .then((list) => {
        if (mounted.current && req === listReq.current) setPackages(list);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The list when the panel opens, and again whenever the hold is let go: what a job started before the panel was last
  // closed changed shows up when it ends
  useEffect(() => {
    if (!held) refresh();
  }, [held, refresh]);

  // A download from a catalogue (ModCatalogue.tsx) takes the same hold as an import
  const claim = holdModsStore;
  const packageAdded = useCallback(() => {
    setChanged(true);
    refresh();
  }, [refresh]);

  const install = async (next: Busy, source: () => PackageSource | Promise<PackageSource>) => {
    const release = holdModsStore();
    if (!release) return;
    setBusy(next);
    setNote(null);
    const name = next.name;
    try {
      const result = await installPackage(await source(), modDefinitions());
      if (result.ok) {
        const values = { name: result.manifest.name, version: result.manifest.version };
        setNote({ tone: "good", text: tx(result.replaced ? "replaced" : "imported", values) });
        setChanged(true);
      } else {
        setNote({ tone: "bad", text: tx("importFailed", { name }), errors: result.errors });
      }
    } catch (err) {
      setNote({ tone: "bad", text: tx("importFailed", { name }), errors: [err instanceof ZipError || err instanceof Error ? err.message : String(err)] });
    } finally {
      release();
      if (mounted.current) setBusy(null);
      refresh();
    }
  };

  const onZip = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared, so the same file can be picked again (after fixing it)
    e.target.value = "";
    if (!file) return;
    // Read from the file a piece at a time (zip-reader.ts), never whole
    void install({ kind: "zip", name: file.name }, () => zipSource(file));
  };

  const onFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? [...e.target.files] : [];
    e.target.value = "";
    if (!files.length) return;
    const name = files[0].webkitRelativePath.split("/")[0] || files[0].name;
    void install({ kind: "folder", name }, () => filesSource(files));
  };

  const toggle = (p: LoadedPackage, on: boolean) => {
    setPackageEnabled(p.id, on);
    setPackages((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: on } : x)));
    setChanged(true);
  };

  const remove = async (p: LoadedPackage) => {
    const release = holdModsStore();
    if (!release) return;
    setRemoveBusy(true);
    try {
      await removePackage(p.id);
      setChanged(true);
      // Gone from the list before the dialog closes, so the focus it hands back lands on a row that stays
      if (mounted.current) setPackages((list) => list.filter((x) => x.id !== p.id));
    } catch (err) {
      if (mounted.current) setNote({ tone: "bad", text: tx("removeFailed", { name: p.name }), errors: [err instanceof Error ? err.message : String(err)] });
    } finally {
      release();
      if (mounted.current) {
        setRemoveBusy(false);
        setRemoving(null);
      }
      refresh();
    }
  };

  const counts = (p: LoadedPackage): string => {
    const m = p.manifest;
    if (!m) return "";
    const parts: string[] = [];
    if (m.tracks?.length) parts.push(tx("circuits", { count: m.tracks.length }));
    if (m.cars?.length) parts.push(tx("cars", { count: m.cars.length }));
    if (m.skins?.length) parts.push(tx("liveries", { count: m.skins.length }));
    return parts.join(" · ");
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="lc-body m-0 max-w-[70ch]">{tx("intro")}</p>

      {storage ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Icon name="mods" />}
            loading={busy?.kind === "zip"}
            disabled={held}
            onClick={() => zipInput.current?.click()}
          >
            {tx("importZip")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={busy?.kind === "folder"}
            disabled={held}
            onClick={() => folderInput.current?.click()}
          >
            {tx("importFolder")}
          </Button>
          <a href={`${REPO_URL}/blob/main/docs/modding.md`} target="_blank" rel="noreferrer" className="lc-hint ms-auto underline underline-offset-2">
            {tx("howTo")}
          </a>
          <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={onZip} />
          <input
            ref={folderInput}
            type="file"
            hidden
            onChange={onFolder}
            // Not in React's typings; every browser the game runs in reads it
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          />
        </div>
      ) : (
        <Well className="px-3.5 py-2.5">
          <p className="lc-body m-0 text-lc-caution">{tx("storageUnavailable")}</p>
        </Well>
      )}

      {busy ? <p className="lc-hint m-0" role="status">{tx("importing", { name: busy.name })}</p> : null}
      {note ? (
        <Well className="flex flex-col gap-1.5 px-3.5 py-2.5" role={note.tone === "bad" ? "alert" : "status"}>
          <p className={cx("lc-body m-0 font-medium", note.tone === "bad" ? "text-lc-caution" : "text-lc-chalk")}>{note.text}</p>
          {note.errors?.length ? <ErrorList errors={note.errors} more={(count) => tx("moreProblems", { count })} /> : null}
        </Well>
      ) : null}

      {modsSwitchedOff() && !changed ? (
        <Well className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <span className="lc-body m-0 text-lc-caution">{tx("switchedOff")}</span>
          <Button size="sm" variant="secondary" onClick={restart}>
            {tx("restart")}
          </Button>
        </Well>
      ) : null}

      {changed ? (
        <Well className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <span className="lc-body m-0">{tx("restartNeeded")}</span>
          <Button size="sm" variant="secondary" onClick={restart}>
            {tx("restart")}
          </Button>
        </Well>
      ) : null}

      {packages.length === 0 ? (
        <EmptyState icon={<Icon name="mods" />}>{tx("empty")}</EmptyState>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {packages.map((p) => (
            <li key={p.id} className="flex flex-col gap-1.5 border-t border-lc-line py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-lc-chalk">
                    {p.name} {p.version ? <span className="font-normal text-lc-slate">{p.version}</span> : null}
                  </span>
                  <span className="lc-hint truncate">
                    {[p.manifest?.credit.author, p.id, counts(p), formatSize(p.bytes)].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <Badge size="sm" tone="neutral" variant="outline">
                  {tx(p.source === "browser" ? "sourceBrowser" : "sourceFolder")}
                </Badge>
                {p.manifest ? (
                  <Toggle checked={p.enabled} onChange={(on) => toggle(p, on)} aria-label={tx("use", { name: p.name })} />
                ) : null}
                {p.source === "browser" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Icon name="delete" />}
                    aria-label={tx("removeNamed", { name: p.name })}
                    disabled={held}
                    onClick={() => setRemoving(p)}
                  >
                    {tx("remove")}
                  </Button>
                ) : null}
              </div>
              {p.errors?.length ? (
                <div className="flex flex-col gap-1">
                  <span className="lc-hint font-medium text-lc-caution">{tx("broken")}</span>
                  <ErrorList errors={p.errors} more={(count) => tx("moreProblems", { count })} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {launcher === "session" ? (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="lc-hint m-0 max-w-[70ch]">{tx("launcherFolderNote")}</p>
          <Button size="sm" variant="secondary" icon={<Icon name="browse" />} onClick={() => void openFolder()}>
            {tx("openFolder")}
          </Button>
        </div>
      ) : packages.some((p) => p.source === "folder") ? (
        <p className="lc-hint m-0">{tx("folderNote")}</p>
      ) : null}

      <ModCatalogue installed={packages} claim={claim} blocked={held} onInstalled={packageAdded} />
      <LauncherImports onConverted={packageAdded} onRestart={restart} />

      <ConfirmDialog
        open={removing !== null}
        title={tx("removeTitle", { name: removing?.name ?? "" })}
        confirmLabel={tx("remove")}
        busy={removeBusy}
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      >
        {tx("removeBody")}
      </ConfirmDialog>
    </div>
  );
};
