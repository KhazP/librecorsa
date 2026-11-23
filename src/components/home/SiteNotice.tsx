"use client";

import React, { useRef } from "react";
import { useTranslations } from "use-intl/react";
import { focusables, useFocusNav } from "@/components/menu/useFocusNav";
import { Button } from "@/components/ui/Button";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";

/**
 * A page that only has something to say (not found, an error): the logo, a title, one line, and the way home. A
 * controller or the keys reach the button as in the game's menus; Start presses it. Its words come from the messages,
 * so a server page (not found) can show it too.
 */
export function SiteNotice({ notice }: { notice: "notFound" | "error" }) {
  const tx = useTranslations("home.notice");
  const rootRef = useRef<HTMLElement | null>(null);
  useFocusNav(rootRef, {
    onStart: () => {
      const root = rootRef.current;
      if (root) focusables(root)[0]?.click();
    },
    // Nothing is focused until a controller or the keys are used
    autoFocus: false,
  });
  return (
    <main
      ref={rootRef}
      className="flex h-dvh flex-col items-center justify-center gap-10 overflow-y-auto bg-lc-void px-[max(1.5rem,env(safe-area-inset-left))] py-[max(2rem,env(safe-area-inset-top))] text-center text-lc-chalk phone:gap-6"
    >
      <LibreCorsaLogo variant="compact" size="md" />
      <div className="flex max-w-[36rem] flex-col items-center gap-4">
        <h1 className="lc-h1 text-balance">{tx(`${notice}.title`)}</h1>
        <p className="lc-body m-0 text-[16px] leading-[1.55] text-balance">{tx(`${notice}.body`)}</p>
      </div>
      <Button href="/" variant="primary" size="lg" data-nav-default>
        {tx("back")}
      </Button>
    </main>
  );
}
