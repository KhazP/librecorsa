"use client";

/**
 * The owner's numbers page. Until a key opens the numbers it is one password field in the middle of the screen and
 * nothing else: no title, no words, nothing that says what the page is. The dashboard (Dashboard.tsx) is loaded only
 * once the key is accepted. The key lives in this tab's memory alone: never in storage or a URL (the field has no
 * `name`, so even a form sent before the script runs carries nothing), and it goes out only as `Authorization: Bearer`.
 */
import dynamic from "next/dynamic";
import { type FormEvent, useRef, useState } from "react";
import { IconButton, TextField } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import type { AdminStats as StatsBody } from "../../../cloudflare/api/admin";
import { readAdmin } from "./admin-fetch";

const loadDashboard = () => import("./Dashboard").then((m) => m.Dashboard);
const Dashboard = dynamic(loadDashboard, { ssr: false, loading: () => <div className="h-dvh bg-lc-void" /> });

/** The range the dashboard opens on */
const FIRST_DAYS = 30;

type GateState = "idle" | "checking" | "refused" | "busy" | "failed";
const PROBLEM: Partial<Record<GateState, string>> = {
  refused: "Not accepted.",
  busy: "Too many tries. Wait a minute.",
  failed: "No answer. Try again in a moment.",
};

export function AdminStats() {
  const [open, setOpen] = useState<{ key: string; stats: StatsBody } | null>(null);
  if (open) return <Dashboard adminKey={open.key} initial={open.stats} initialDays={FIRST_DAYS} onForget={() => setOpen(null)} />;
  return <Gate onOpen={(key, stats) => setOpen({ key, stats })} />;
}

function Gate({ onOpen }: { onOpen: (key: string, stats: StatsBody) => void }) {
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<GateState>("idle");
  const checking = state === "checking";
  const formRef = useRef<HTMLFormElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const key = draft.trim();
    if (!key || checking) return;
    setState("checking");
    const read = await readAdmin<StatsBody>(`/admin/stats?days=${FIRST_DAYS}`, key);
    if (read.state === "ok") {
      // The dashboard's code comes down only for a key that opened the numbers, never for a guess
      await loadDashboard().catch(() => {});
      setDraft("");
      onOpen(key, read.body);
      return;
    }
    setState(read.state);
  };

  return (
    <main className="grid h-dvh place-items-center bg-lc-void pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] pl-[max(1rem,env(safe-area-inset-left))]">
      {/* A lone field: Enter sends the form without a submit button, and the arrow sends it the same way */}
      <form ref={formRef} onSubmit={submit} className="w-full max-w-[340px]" aria-busy={checking}>
        <TextField
          hideLabel
          label="Key"
          type="password"
          autoComplete="current-password"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={draft}
          onChange={(v) => {
            setDraft(v);
            if (state !== "checking" && state !== "busy") setState("idle");
          }}
          error={PROBLEM[state]}
          trailing={
            <IconButton
              onClick={() => formRef.current?.requestSubmit()}
              size="sm"
              variant="ghost"
              aria-label="Open"
              disabled={checking || draft.trim() === ""}
              icon={<Icon name={checking ? "downloading" : "next"} />}
              className="-me-2"
            />
          }
        />
      </form>
    </main>
  );
}
