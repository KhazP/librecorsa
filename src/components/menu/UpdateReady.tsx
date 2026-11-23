"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Icon } from "@/components/ui/icons/Icon";
import { Toast } from "@/components/ui/Toast";
import {
  autoReload,
  autoReloadNow,
  autoReloadTriedFor,
  checkForUpdate,
  pageAgeMs,
  reloadForUpdate,
  updateStore,
  type UpdateMoment,
  type UpdateState,
} from "@/lib/build-update";

/**
 * "Update ready" with a Reload button, once a newer build is out than the one this page runs (src/lib/build-update.ts).
 * It sits in the title and pause menus' headers, so it never shows while driving, and every input reaches it.
 * `endsSession` says what a reload ends (a session, a race, a room): the reload then asks first.
 */
export function UpdateReady({ endsSession }: { endsSession?: string }) {
  const { ready } = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot, updateStore.getServerSnapshot);
  const [asking, setAsking] = useState(false);
  const tx = useTranslations("menu.update");
  if (!ready) return null;
  return (
    <div role="status" className="flex min-w-0">
      <Toast
        tone="info"
        icon={<Icon name="refresh" size="md" />}
        action={
          <Button size="sm" variant="ghost" onClick={endsSession ? () => setAsking(true) : reloadForUpdate}>
            {tx("reload")}
          </Button>
        }
      >
        {tx("ready")}
      </Toast>
      {endsSession ? (
        <ConfirmDialog
          open={asking}
          title={tx("confirmTitle")}
          confirmLabel={tx("confirmReload")}
          cancelLabel={tx("notNow")}
          icon={<Icon name="refresh" size="lg" />}
          onConfirm={reloadForUpdate}
          onCancel={() => setAsking(false)}
        >
          {endsSession}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** Set once the player has left the page's first loading screen; circuit reloads after that are not a fresh start */
let leftFirstLoading = false;

/** A text field has the focus: a half-typed request would be lost */
function typing(): boolean {
  const el = document.activeElement;
  return Boolean(el?.matches('textarea, [contenteditable="true"], input:not([type="range"], [type="checkbox"], [type="radio"], [type="button"])'));
}

/**
 * Reloads onto a newer build by itself where that loses nothing (`autoReloadNow`): on the page's first loading screen
 * as soon as one is known, and on the idle title screen as the player leaves the tab. `moment` is where the player is
 * now.
 */
export function useUpdateAutoReload(moment: UpdateMoment): void {
  const update = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot, updateStore.getServerSnapshot);
  const momentRef = useRef(moment);
  useEffect(() => {
    momentRef.current = moment;
    if (moment !== "loading") leftFirstLoading = true;
  }, [moment]);

  const reloadIfDue = useCallback((now: UpdateState) => {
    const due = autoReloadNow({
      moment: momentRef.current,
      update: now,
      boot: !leftFirstLoading,
      pageAgeMs: pageAgeMs(),
      hidden: document.visibilityState === "hidden",
      typing: typing(),
      triedFor: autoReloadTriedFor(),
    });
    if (due) autoReload(now.latest);
  }, []);

  useEffect(() => {
    if (moment === "loading") reloadIfDue(update);
  }, [moment, update, reloadIfDue]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== "hidden" || momentRef.current !== "idle") return;
      const known = updateStore.getSnapshot();
      if (known.ready) reloadIfDue(known);
      else void checkForUpdate().then(reloadIfDue);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [reloadIfDue]);
}
