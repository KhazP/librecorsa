"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons/Icon";
import { Toast } from "@/components/ui/Toast";
import { launcherPresence, readLauncherUpdate, restartLauncherForUpdate, type LauncherUpdate as UpdateState } from "@/lib/mods/launcher-imports";

/** How often the title screen asks the launcher again (it checks GitHub itself, every few hours) */
const READ_EVERY_MS = 5 * 60_000;
/** How long the page waits for the launcher to come back after "Restart to update" before it says so */
const BACK_WITHIN_MS = 90_000;

/** Only the repository's own releases page is linked to */
const RELEASES = "https://github.com/librecorsa/librecorsa/releases";
const releaseLink = (u: UpdateState): string => (u.releaseUrl.startsWith(`${RELEASES}/`) ? u.releaseUrl : RELEASES);

/**
 * The offline launcher's own update, on the title screen beside the game's (UpdateReady): "LibreCorsa 0.3.0 is
 * ready" with "Restart to update" once the launcher has downloaded and checked it (launcher/update.go), or a link to
 * download it when this launcher can't install it itself. The restart keeps this window: the page waits for the new
 * launcher and reloads. Shown only in the launcher's own window (it holds the session); never on the web.
 * `endsSession` says what the restart ends (a room, a race): it then asks first.
 */
export function LauncherUpdate({ endsSession }: { endsSession?: string }) {
  const tx = useTranslations("menu.launcherUpdate");
  const [info, setInfo] = useState<UpdateState | null>(null);
  const [restarting, setRestarting] = useState<"waiting" | "slow" | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const read = () =>
      void launcherPresence()
        .then((p) => (p === "session" ? readLauncherUpdate() : null))
        .then((next) => {
          if (live && next) setInfo(next);
        })
        .catch(() => {});
    read();
    const timer = window.setInterval(read, READ_EVERY_MS);
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.clearInterval(poll.current);
      window.removeEventListener("focus", read);
    };
  }, []);

  const restart = useCallback(async () => {
    setAsking(false);
    if (!info) return;
    setError(null);
    try {
      await restartLauncherForUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setRestarting("waiting");
    const before = info.run;
    const started = Date.now();
    // The launcher goes away and a new one takes its place: once it answers (another run), this page loads from it
    poll.current = window.setInterval(() => {
      void readLauncherUpdate()
        .then((next) => {
          if (next.run !== before) {
            window.clearInterval(poll.current);
            window.location.reload();
          }
        })
        .catch(() => {});
      if (Date.now() - started > BACK_WITHIN_MS) setRestarting("slow");
    }, 1000);
  }, [info]);

  if (!info) return null;
  if (restarting) {
    return (
      <div role="status" className="flex min-w-0">
        <Toast tone={restarting === "slow" ? "warn" : "info"} icon={<Icon name="restart" size="md" />}>
          {restarting === "slow" ? tx("notBack") : tx("restarting")}
        </Toast>
      </div>
    );
  }
  const version = info.latest ?? "";
  if (info.state === "ready") {
    return (
      <div role={error ? "alert" : "status"} className="flex min-w-0">
        <Toast
          tone={error ? "bad" : "info"}
          icon={<Icon name="download" size="md" />}
          action={
            <Button size="sm" variant="ghost" onClick={endsSession ? () => setAsking(true) : () => void restart()}>
              {tx("restart")}
            </Button>
          }
        >
          {error ? tx("restartFailed", { error }) : tx("ready", { version })}
        </Toast>
        {endsSession ? (
          <ConfirmDialog
            open={asking}
            title={tx("confirmTitle")}
            confirmLabel={tx("confirmRestart")}
            cancelLabel={tx("notNow")}
            icon={<Icon name="restart" size="lg" />}
            onConfirm={() => void restart()}
            onCancel={() => setAsking(false)}
          >
            {endsSession}
          </ConfirmDialog>
        ) : null}
      </div>
    );
  }
  if (info.state === "available" || info.state === "failed") {
    return (
      <div role="status" className="flex min-w-0">
        <Toast
          tone={info.state === "failed" ? "warn" : "info"}
          icon={<Icon name="download" size="md" />}
          action={
            <Button size="sm" variant="ghost" href={releaseLink(info)} target="_blank" rel="noreferrer">
              {tx("download")}
            </Button>
          }
        >
          {info.state === "failed" ? tx("failed", { version }) : tx("available", { version })}
        </Toast>
      </div>
    );
  }
  return null;
}
