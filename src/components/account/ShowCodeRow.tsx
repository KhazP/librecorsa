"use client";

import React, { useEffect, useRef, useState } from "react";
import { Button, SettingRow, Well } from "@/components/ui";
import { cx } from "@/components/ui/styles";
import { accountActions } from "@/lib/account/account-store";
import { ErrorLine } from "./AccountDialog";
import { formatTimeLeft } from "./format";

/** The time now, ticking every `everyMs` while `on` (a countdown) */
function useNow(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [on, everyMs]);
  return now;
}

/**
 * "Show a code for another device": a one-use code, 10 minutes long, that signs another device in to this account
 * (the desktop app and an iPhone home-screen app sign in this way). Shown large, in two groups of four, with the
 * minutes it has left; New code replaces it.
 */
export function ShowCodeRow() {
  const [shown, setShown] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(shown !== null);
  const left = shown ? formatTimeLeft(shown.expiresAt, now) : null;
  // The code opens below its row: on a short screen it would be out of sight
  const wellRef = useRef<HTMLDivElement | null>(null);
  const code = shown?.code;
  useEffect(() => {
    if (!code) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    wellRef.current?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }, [code]);

  const make = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await accountActions.createLinkCode();
    setBusy(false);
    if (typeof answer === "string") {
      setError(answer);
      return;
    }
    setShown(answer);
  };

  return (
    <>
      <SettingRow
        label="Show a code for another device"
        hint="Signs another device in to this account, such as the desktop app"
      >
        {shown ? (
          <Button size="sm" variant="ghost" onClick={() => setShown(null)}>
            Hide
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void make()}>
          {shown ? "New code" : "Show a code"}
        </Button>
      </SettingRow>
      {shown ? (
        <div ref={wellRef} className="mt-1 mb-2 scroll-my-4">
          <Well className="flex flex-col items-center gap-2.5 px-4 py-5 text-center phone:py-4">
            <span
              role="img"
              aria-label={`Code ${[...shown.code].join(" ")}`}
              className={cx(
                "lc-mono flex items-center gap-3 text-[44px] leading-none font-semibold tracking-[0.14em] text-lc-chalk phone:text-[32px]",
                left ? undefined : "opacity-40",
              )}
            >
              <span>{shown.code.slice(0, 4)}</span>
              <span aria-hidden className="text-lc-slate">
                -
              </span>
              <span>{shown.code.slice(4)}</span>
            </span>
            <span className={cx("lc-hint", left ? undefined : "text-lc-caution")}>
              {left ? `${left}. It works once.` : "This code has run out. Choose New code for another."}
            </span>
            <p className="lc-body m-0 max-w-[46ch] text-balance">
              On the other device, open Settings, then Profile and data, then Account. Choose Use a code from another
              device and type this code.
            </p>
          </Well>
        </div>
      ) : null}
      <ErrorLine error={error} className="pb-1" />
    </>
  );
}
