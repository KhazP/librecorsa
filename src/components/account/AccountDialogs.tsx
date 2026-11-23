"use client";

import React, { useEffect, useState } from "react";
import { Button, Toast, Well } from "@/components/ui";
import { accountActions, useAccountState, type FirstSyncChoice, type SaveSummary } from "@/lib/account/account-store";
import { AccountDialog } from "./AccountDialog";
import { formatAgo, joinQuestion } from "./format";
import { accountUi, useAccountUi } from "./ui-state";

/** How long a sign-in's notice stays up (ms) */
const NOTICE_MS = 6000;

/**
 * A question about the account waits for a menu: the title menu or Settings, never the loading screen (which takes
 * any press as "start") or a lap. The title menu marks its root with `data-title-menu`; Settings marks <html> with
 * `data-settings-open` while it is open.
 */
function menuUp(): boolean {
  return document.documentElement.hasAttribute("data-settings-open") || document.querySelector("[data-title-menu]") !== null;
}

function useMenuUp(wanted: boolean): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    const check = () => setUp(menuUp());
    check();
    const id = window.setInterval(check, 400);
    return () => window.clearInterval(id);
  }, [wanted]);
  return wanted && up;
}

/**
 * The account's questions and notices in the game, mounted once by the /play page: it starts the account side, asks
 * "Join the account of ...?" after a sign-in, asks how to combine two saves on a first sync, and shows what a sign-in
 * coming back from the provider's page said. Nothing shows while accounts are off.
 */
export function AccountDialogs() {
  const state = useAccountState();
  const ui = useAccountUi();

  useEffect(() => {
    accountActions.start();
  }, []);

  // A join the player already answered in the code flow is made without asking again; if it fails, the question
  // comes up with what went wrong
  const [joinError, setJoinError] = useState<string | null>(null);
  const [autoJoining, setAutoJoining] = useState(false);
  // A later question starts clean
  useEffect(() => {
    if (!state.join) setJoinError(null);
  }, [state.join]);
  useEffect(() => {
    if (!state.join || autoJoining || !accountUi.codeJoinStands(ui)) return;
    accountUi.clearCodeJoin();
    setAutoJoining(true);
    void accountActions.confirmJoin().then((failed) => {
      setAutoJoining(false);
      setJoinError(failed);
    });
  }, [state.join, ui, autoJoining]);

  const asking = state.phase === "signed-in" && (state.join !== null || state.firstSync !== null);
  const menu = useMenuUp(asking);
  const showJoin = menu && state.join !== null && !autoJoining && !accountUi.codeJoinStands(ui);
  const showFirstSync = menu && state.join === null && state.firstSync !== null && !ui.firstSyncDeferred;

  return (
    <>
      {state.join ? (
        <JoinDialog
          open={showJoin}
          driverName={state.join.driverName}
          providers={state.join.providers}
          error={joinError}
          onError={setJoinError}
        />
      ) : null}
      {state.firstSync ? (
        <FirstSyncDialog open={showFirstSync} local={state.firstSync.local} cloud={state.firstSync.cloud} />
      ) : null}
      <AccountNotice />
    </>
  );
}

function JoinDialog({
  open,
  driverName,
  providers,
  error,
  onError,
}: {
  open: boolean;
  driverName: string | null;
  providers: Parameters<typeof joinQuestion>[1];
  error: string | null;
  onError: (error: string | null) => void;
}) {
  const [busy, setBusy] = useState<"join" | "decline" | null>(null);
  const join = async () => {
    if (busy) return;
    setBusy("join");
    onError(null);
    const failed = await accountActions.confirmJoin();
    setBusy(null);
    onError(failed);
  };
  const decline = async () => {
    if (busy) return;
    setBusy("decline");
    onError(null);
    await accountActions.declineJoin();
    setBusy(null);
  };
  return (
    <AccountDialog
      open={open}
      title={joinQuestion(driverName, providers)}
      onDismiss={() => void decline()}
      busy={busy !== null}
      error={error}
      actions={
        <>
          <Button variant="ghost" loading={busy === "decline"} onClick={() => void decline()}>
            Not now
          </Button>
          <Button variant="primary" loading={busy === "join"} onClick={() => void join()} data-nav-default="">
            Join
          </Button>
        </>
      }
    >
      <p className="m-0">This device&rsquo;s driver names and save become part of that account. Not now signs this device out.</p>
    </AccountDialog>
  );
}

/** One side of the first sync: what it holds */
function SaveSide({ title, summary }: { title: string; summary: SaveSummary }) {
  // Numbers in mono, words in the body face
  const count = (n: number, one: string, many: string) => (
    <>
      <span className="lc-data">{n}</span> {n === 1 ? one : many}
    </>
  );
  const when =
    summary.savedAt !== null
      ? `Saved ${formatAgo(summary.savedAt)}${summary.savedBy ? ` on ${summary.savedBy}` : ""}`
      : summary.savedBy
        ? `Saved on ${summary.savedBy}`
        : null;
  return (
    <Well className="flex min-w-0 flex-col gap-1.5 px-4 py-3 short:gap-1 short:py-2.5">
      <h3 className="lc-row-label m-0">{title}</h3>
      {/* One line on a short screen, so the choices stay in view */}
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[14px] leading-[1.45] text-lc-chalk short:flex-row short:flex-wrap short:gap-x-3">
        <li>{count(summary.bestLaps, "best lap", "best laps")}</li>
        <li>{count(summary.setups, "saved setup", "saved setups")}</li>
        <li>{count(summary.races, "race", "races")}</li>
      </ul>
      {when ? <span className="lc-hint">{when}</span> : null}
    </Well>
  );
}

function FirstSyncDialog({ open, local, cloud }: { open: boolean; local: SaveSummary; cloud: SaveSummary }) {
  const [busy, setBusy] = useState<FirstSyncChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (choice: FirstSyncChoice) => {
    if (busy) return;
    setBusy(choice);
    setError(null);
    const failed = await accountActions.chooseFirstSync(choice);
    setBusy(null);
    setError(failed);
  };
  const waiting = busy ? "Wait for it to finish" : undefined;
  return (
    <AccountDialog
      open={open}
      wide
      stackActions
      title="Combine the two saves?"
      // Putting it off loses nothing: it is asked again from the Account tab, or on the next start
      onDismiss={accountUi.deferFirstSync}
      busy={busy !== null}
      error={error}
      actions={
        <>
          <Button variant="primary" loading={busy === "combine"} disabledReason={busy && busy !== "combine" ? waiting : undefined} onClick={() => void choose("combine")} data-nav-default="">
            Combine
          </Button>
          <Button variant="secondary" loading={busy === "cloud"} disabledReason={busy && busy !== "cloud" ? waiting : undefined} onClick={() => void choose("cloud")}>
            Use the cloud save
          </Button>
          <Button variant="secondary" loading={busy === "local"} disabledReason={busy && busy !== "local" ? waiting : undefined} onClick={() => void choose("local")}>
            Keep this device&rsquo;s save
          </Button>
          <Button variant="ghost" disabledReason={waiting} onClick={accountUi.deferFirstSync}>
            Not now
          </Button>
        </>
      }
    >
      <p className="m-0">This device and the account both have a save.</p>
      <div className="grid grid-cols-2 gap-2.5 max-[24rem]:grid-cols-1">
        <SaveSide title="This device" summary={local} />
        <SaveSide title="Cloud save" summary={cloud} />
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        <li>
          <strong className="font-semibold text-lc-chalk">Combine.</strong> Keeps both. Where both changed the same thing,
          the newer change wins.
        </li>
        <li>
          <strong className="font-semibold text-lc-chalk">Use the cloud save.</strong> This device takes the account&rsquo;s
          settings, setups and race history. Its own are replaced.
        </li>
        <li>
          <strong className="font-semibold text-lc-chalk">Keep this device&rsquo;s save.</strong> The account takes this
          device&rsquo;s settings, setups and race history. Other devices get them at their next start.
        </li>
      </ul>
      <p className="m-0">Best laps from both are always kept.</p>
    </AccountDialog>
  );
}

/** What a sign-in or an account action said, for a few seconds at the foot of the screen (the game and /account) */
export function AccountNotice() {
  const { notice } = useAccountState();
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => accountActions.dismissNotice(), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);
  return (
    <div
      aria-live="polite"
      className="lc-ui-zoom pointer-events-none fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-[max(1rem,env(safe-area-inset-left))] z-(--z-lc-notice) mx-auto flex w-fit max-w-[calc(100%-2rem)] justify-center"
    >
      {notice ? <Toast tone={notice.kind === "ok" ? "good" : "bad"}>{notice.text}</Toast> : null}
    </div>
  );
}
