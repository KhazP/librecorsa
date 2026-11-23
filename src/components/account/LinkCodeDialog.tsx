"use client";

import React, { useEffect, useState } from "react";
import { Button, TextField } from "@/components/ui";
import { accountActions } from "@/lib/account/account-store";
import { normaliseLinkCode, type AccountProvider } from "@/lib/account/api-types";
import { AccountDialog } from "./AccountDialog";
import { joinQuestion, typedLinkCode } from "./format";
import { accountUi } from "./ui-state";

type Step =
  | { at: "type" }
  | { at: "confirm"; code: string; driverName: string | null; providers: AccountProvider[] };

/**
 * "Use a code from another device": type the code a signed-in device shows, see whose account it is, then join it.
 * The question comes before the code is used, so a code from someone else never pulls this device's save into their
 * account without the player seeing whose it is.
 */
export function LinkCodeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ at: "type" });
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each opening starts on an empty field
  useEffect(() => {
    if (!open) return;
    setStep({ at: "type" });
    setTyped("");
    setError(null);
    setBusy(false);
  }, [open]);

  const code = normaliseLinkCode(typed);

  const check = async () => {
    if (busy) return;
    if (!code) {
      setError("A code is 8 letters and numbers, like ABCD-EFGH");
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await accountActions.previewLinkCode(code);
    setBusy(false);
    if (typeof answer === "string") {
      setError(answer);
      return;
    }
    setStep({ at: "confirm", code, driverName: answer.driverName, providers: answer.providers });
  };

  const join = async () => {
    if (step.at !== "confirm" || busy) return;
    setBusy(true);
    setError(null);
    // The player has just answered the join question: the sign-in that follows joins without asking it again
    accountUi.noteCodeJoin();
    const failed = await accountActions.redeemLinkCode(step.code);
    setBusy(false);
    if (failed) {
      accountUi.clearCodeJoin();
      setError(failed);
      return;
    }
    onClose();
  };

  if (step.at === "confirm") {
    return (
      <AccountDialog
        open={open}
        title={joinQuestion(step.driverName, step.providers)}
        step="confirm"
        onDismiss={onClose}
        busy={busy}
        error={error}
        actions={
          <>
            <Button variant="ghost" onClick={onClose} disabledReason={busy ? "Wait for it to finish" : undefined}>
              Not now
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void join()} data-nav-default="">
              Join
            </Button>
          </>
        }
      >
        <p className="m-0">This device&rsquo;s driver names and save become part of that account.</p>
      </AccountDialog>
    );
  }

  return (
    <AccountDialog
      open={open}
      title="Use a code from another device"
      step="type"
      onDismiss={onClose}
      busy={busy}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabledReason={busy ? "Wait for it to finish" : undefined}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void check()}>
            Continue
          </Button>
        </>
      }
    >
      <p className="m-0">
        On a device that is signed in, open Settings, then Profile and data, then Account, and choose Show a code.
      </p>
      <TextField
        label="Code"
        value={typed}
        onChange={(v) => {
          setTyped(typedLinkCode(v));
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void check();
        }}
        placeholder="ABCD-EFGH"
        maxLength={9}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        error={error ?? undefined}
        data-nav-default=""
        className="[&_input]:lc-mono [&_input]:text-[20px] [&_input]:tracking-[0.18em] [&_input]:uppercase"
      />
    </AccountDialog>
  );
}
