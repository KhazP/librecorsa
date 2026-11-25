"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import {
  deleteSavedReplay,
  importLcrFileToStore,
  listSavedReplays,
  loadSavedReplay,
  loadSavedReplayBytes,
  renameSavedReplay,
  subscribeReplays,
} from "@/lib/sim/replay-store";
import { checkReplayCompatibility } from "@/lib/sim/replay-format";
import { REPLAY_FILE_EXTENSION, type ReplayRecordingPayload, type StoredReplaySummary } from "@/lib/sim/replay-types";
import type { ReplaySaveResult } from "@/lib/sim/replay-store";
import { Button, Card, IconButton } from "@/components/ui";
import { Select } from "@/components/ui/Select";
import { Icon } from "@/components/ui/icons/Icon";

export interface ReplayLibraryPanelProps {
  hasLiveReplay?: boolean;
  onSaveCurrentReplay?: () => Promise<ReplaySaveResult>;
  onLoadReplay: (payload: ReplayRecordingPayload) => void;
}

type SortKey = "date" | "track" | "duration";
type FilterKind = "all" | "practice" | "ai" | "mp";

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? "0" : ""}${rem}`;
}

export const ReplayLibraryPanel: React.FC<ReplayLibraryPanelProps> = ({
  hasLiveReplay,
  onSaveCurrentReplay,
  onLoadReplay,
}) => {
  const tx = useTranslations("menu.replays");
  const [items, setItems] = useState<StoredReplaySummary[]>([]);
  const [query, setQuery] = useState("");
  const [filterKind, setFilterKind] = useState<FilterKind>("all");
  const [sortBy, setSortBy] = useState<SortKey>("date");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const list = await listSavedReplays();
    setItems(list);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeReplays(() => {
      void refresh();
    });
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = items.filter((item) => {
      if (filterKind !== "all" && item.raceKind !== filterKind) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.trackName.toLowerCase().includes(q) ||
        item.vehicle.toLowerCase().includes(q)
      );
    });
    out.sort((a, b) => {
      if (sortBy === "track") return a.trackName.localeCompare(b.trackName) || b.recordedAt - a.recordedAt;
      if (sortBy === "duration") return b.durationS - a.durationS;
      return b.recordedAt - a.recordedAt;
    });
    return out;
  }, [items, query, filterKind, sortBy]);

  const handleSaveCurrent = async () => {
    if (!onSaveCurrentReplay) return;
    setStatusError(null);
    const res = await onSaveCurrentReplay();
    if (!res.ok) {
      setStatusError(res.error === "quota" ? tx("quotaError") : tx("importError"));
    }
  };

  const handleImportFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setStatusError(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await importLcrFileToStore(buf);
      if (!res.ok) {
        setStatusError(res.error === "quota" ? tx("quotaError") : tx("importError"));
      }
    } catch {
      setStatusError(tx("importError"));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleOpen = async (id: string) => {
    setBusyId(id);
    setStatusError(null);
    try {
      const payload = await loadSavedReplay(id);
      if (!payload) {
        setStatusError(tx("importError"));
        return;
      }
      onLoadReplay(payload);
    } finally {
      setBusyId(null);
    }
  };

  const handleExport = async (item: StoredReplaySummary) => {
    const bytes = await loadSavedReplayBytes(item.id);
    if (!bytes) return;
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const blob = new Blob([copy], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = item.name.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_+|_+$/g, "") || item.id;
    a.download = `${safeName}${REPLAY_FILE_EXTENSION}`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleCommitRename = async (id: string) => {
    if (draftName.trim()) {
      await renameSavedReplay(id, draftName.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="space-y-3">
      <Card title={tx("title")}>
        <p className="lc-hint mb-3">{tx("subtitle")}</p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx("searchPlaceholder")}
            className="min-w-[200px] flex-1 rounded-lc-row border border-lc-line bg-lc-well px-3 py-2 text-[13px] text-lc-chalk placeholder:text-lc-dim focus:border-lc-volt focus:outline-none"
          />
          <div className="w-[140px]">
            <Select
              aria-label={tx("filterAll")}
              className="h-9 w-[140px] text-[12px]"
              value={filterKind}
              options={[
                { id: "all", label: tx("filterAll") },
                { id: "practice", label: tx("filterPractice") },
                { id: "ai", label: tx("filterAi") },
                { id: "mp", label: tx("filterMp") },
              ]}
              onChange={(v) => setFilterKind(v as FilterKind)}
            />
          </div>
          <div className="w-[125px]">
            <Select
              aria-label={tx("sortDate")}
              className="h-9 w-[125px] text-[12px]"
              value={sortBy}
              options={[
                { id: "date", label: tx("sortDate") },
                { id: "track", label: tx("sortTrack") },
                { id: "duration", label: tx("sortDuration") },
              ]}
              onChange={(v) => setSortBy(v as SortKey)}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {hasLiveReplay && onSaveCurrentReplay ? (
            <Button size="sm" variant="primary" icon={<Icon name="add" size="xs" />} onClick={() => void handleSaveCurrent()}>
              {tx("saveCurrent")}
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" icon={<Icon name="replay" size="xs" />} onClick={() => fileInputRef.current?.click()}>
            {tx("importLcr")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".lcr,application/octet-stream"
            className="hidden"
            onChange={(e) => void handleImportFiles(e.target.files)}
          />
        </div>

        {statusError ? (
          <div className="mt-3 rounded-lc-row border border-lc-loss/40 bg-lc-loss/10 px-3 py-2 text-[12px] text-lc-loss">
            {statusError}
          </div>
        ) : null}
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <p className="lc-body text-center text-lc-slate">{tx("empty")}</p>
        </Card>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {filtered.map((item) => {
            const compat = checkReplayCompatibility({
              trackId: item.trackId,
              vehicle: item.vehicle,
              physicsVersion: item.physicsVersion,
            });
            const previewPath =
              item.trackPreview && item.trackPreview.length >= 2
                ? item.trackPreview
                    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x * 52 + 4).toFixed(1)},${(y * 34 + 4).toFixed(1)}`)
                    .join(" ")
                : null;

            return (
              <div
                key={item.id}
                className="flex items-center gap-3 rounded-lc-card border border-lc-line bg-lc-carbon/85 p-3"
              >
                <div className="flex h-[44px] w-[60px] shrink-0 items-center justify-center rounded-lc-row border border-lc-line bg-lc-well">
                  {previewPath ? (
                    <svg viewBox="0 0 60 42" className="h-[38px] w-[54px]" aria-hidden="true">
                      <path d={previewPath} fill="none" stroke="var(--color-lc-volt)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <Icon name="play" size="sm" className="text-lc-slate" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {editingId === item.id ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleCommitRename(item.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="min-w-0 flex-1 rounded-lc-nub border border-lc-volt bg-lc-well px-2 py-1 text-[13px] text-lc-chalk focus:outline-none"
                        autoFocus
                      />
                      <Button size="sm" variant="primary" onClick={() => void handleCommitRename(item.id)}>
                        {tx("saveName")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>
                        {tx("cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="truncate text-[14px] font-semibold text-lc-chalk">{item.name}</div>
                  )}

                  <div className="lc-mono mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-lc-slate">
                    <span>{item.trackName}</span>
                    <span>{formatDuration(item.durationS)}</span>
                    <span>{tx("participants", { count: item.participantCount })}</span>
                    <span>{new Date(item.recordedAt).toLocaleDateString()}</span>
                    <span>{tx("sizeKb", { kb: Math.max(1, Math.round(item.byteSize / 1024)) })}</span>
                    {!compat.physicsMatch ? (
                      <span className="text-lc-caution">{tx("physicsMismatch", { version: item.physicsVersion })}</span>
                    ) : null}
                    {!compat.trackKnown ? (
                      <span className="text-lc-caution">{tx("trackMismatch")}</span>
                    ) : null}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Icon name="play" size="xs" />}
                    disabled={busyId === item.id}
                    onClick={() => void handleOpen(item.id)}
                  >
                    {tx("openStudio")}
                  </Button>
                  <IconButton
                    size="sm"
                    icon={<Icon name="edit" size="xs" />}
                    aria-label={tx("rename")}
                    title={tx("rename")}
                    onClick={() => {
                      setEditingId(item.id);
                      setDraftName(item.name);
                    }}
                  />
                  <IconButton
                    size="sm"
                    icon={<Icon name="download" size="xs" />}
                    aria-label={tx("exportLcr")}
                    title={tx("exportLcr")}
                    onClick={() => void handleExport(item)}
                  />
                  <IconButton
                    size="sm"
                    icon={<Icon name="delete" size="xs" />}
                    aria-label={tx("delete")}
                    title={tx("delete")}
                    onClick={() => void deleteSavedReplay(item.id)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
