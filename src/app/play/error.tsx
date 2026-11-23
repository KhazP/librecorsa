"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { Button, Well } from "@/components/ui";
import { Icon } from "@/components/ui/icons";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("game.playError");
  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-lc-void text-lc-chalk">
      <main className="relative flex h-full max-w-[760px] flex-col justify-center gap-7 overflow-y-auto pt-[max(3rem,env(safe-area-inset-top))] pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(3rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))] sm:pr-[max(6vw,env(safe-area-inset-right))] sm:pl-[max(6vw,env(safe-area-inset-left))] lg:pl-[max(6rem,env(safe-area-inset-left))] short:gap-4 short:pt-[max(1.5rem,env(safe-area-inset-top))] short:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <LibreCorsaLogo variant="compact" size="md" />

        <div className="flex flex-col gap-4">
          <h1 className="lc-h1">{t("title")}</h1>
          <p className="m-0 max-w-[56ch] text-[16px] leading-[1.55] text-lc-fog">{t("body")}</p>
        </div>

        {error.message ? (
          <Well className="max-w-[600px] px-4 py-3.5">
            <p className="lc-mono m-0 text-[12px] leading-[1.6] break-words whitespace-pre-wrap text-lc-slate" aria-label={t("detail")}>
              {error.message}
            </p>
          </Well>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" icon={<Icon name="restart" />} onClick={reset}>
            {t("restart")}
          </Button>
        </div>
      </main>
    </div>
  );
}
