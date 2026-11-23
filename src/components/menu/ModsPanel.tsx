"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button, ConfirmDialog, EmptyState, Toggle, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { REPO_URL } from "@/lib/site";
import { modDefinitions } from "@/lib/mods/mod-content";
import { modsState, readPackages, type LoadedPackage } from "@/lib/mods/mod-loader";
import {
  filesSource,
  installPackage,
  modsStorageAvailable,
  removePackage,
  setPackageEnabled,
  zipSource,
  type PackageSource,
} from "@/lib/mods/mod-store";
import { ZipError } from "@/lib/mods/zip-reader";

/** What the last import said */
type ImportNote = { tone: "good" | "bad"; text: string; errors?: string[] };

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
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ImportNote | null>(null);
  const [changed, setChanged] = useState(false);
  const [removing, setRemoving] = useState<LoadedPackage | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const storage = modsStorageAvailable();

  const refresh = useCallback(() => {
    void readPackages().then(setPackages).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  const install = async (name: string, source: () => PackageSource) => {
    setBusy(name);
    setNote(null);
    try {
      const result = await installPackage(source(), modDefinitions());
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
      setBusy(null);
      refresh();
    }
  };

  const onZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await install(file.name, () => zipSource(bytes));
  };

  const onFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? [...e.target.files] : [];
    e.target.value = "";
    if (!files.length) return;
    const name = files[0].webkitRelativePath.split("/")[0] || files[0].name;
    await install(name, () => filesSource(files));
  };

  const toggle = (p: LoadedPackage, on: boolean) => {
    setPackageEnabled(p.id, on);
    setPackages((list) => list.map((x) => (x.id === p.id ? { ...x, enabled: on } : x)));
    setChanged(true);
  };

  const remove = async (p: LoadedPackage) => {
    setRemoving(null);
    await removePackage(p.id);
    setChanged(true);
    refresh();
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
          <Button variant="primary" size="sm" icon={<Icon name="mods" />} loading={busy !== null} disabled={busy !== null} onClick={() => zipInput.current?.click()}>
            {tx("importZip")}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => folderInput.current?.click()}>
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

      {busy ? <p className="lc-hint m-0" role="status">{tx("importing", { name: busy })}</p> : null}
      {note ? (
        <Well className="flex flex-col gap-1.5 px-3.5 py-2.5" role={note.tone === "bad" ? "alert" : "status"}>
          <p className={cx("lc-body m-0 font-medium", note.tone === "bad" ? "text-lc-caution" : "text-lc-chalk")}>{note.text}</p>
          {note.errors?.length ? (
            <ul className="lc-hint m-0 list-disc ps-5">
              {note.errors.map((e) => (
                <li key={e} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          ) : null}
        </Well>
      ) : null}

      {changed ? (
        <Well className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5">
          <span className="lc-body m-0">{tx("restartNeeded")}</span>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
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
                  <Button size="sm" variant="ghost" icon={<Icon name="delete" />} onClick={() => setRemoving(p)}>
                    {tx("remove")}
                  </Button>
                ) : null}
              </div>
              {p.errors?.length ? (
                <div className="flex flex-col gap-1">
                  <span className="lc-hint font-medium text-lc-caution">{tx("broken")}</span>
                  <ul className="lc-hint m-0 list-disc ps-5">
                    {p.errors.slice(0, 8).map((e) => (
                      <li key={e} className="break-words">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {packages.some((p) => p.source === "folder") ? <p className="lc-hint m-0">{tx("folderNote")}</p> : null}

      <ConfirmDialog
        open={removing !== null}
        title={tx("removeTitle", { name: removing?.name ?? "" })}
        confirmLabel={tx("remove")}
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      >
        {tx("removeBody")}
      </ConfirmDialog>
    </div>
  );
};
