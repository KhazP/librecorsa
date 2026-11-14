import React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/icons";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { cx } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";

/*
 * The shell of the pages around the game (press and media, privacy, the owner's numbers, not found): the logo home,
 * one action on the right, a skip link, and the page's own scroll box (the body never scrolls: the game fills the
 * screen). Read pages set long text at 16 px and about 68 characters a line.
 */

/** A paragraph of a read page */
export const READ = "lc-body m-0 max-w-[68ch] text-[16px] leading-[1.6]";
/** The paragraph under a page's title */
export const LEAD = "lc-body m-0 max-w-[62ch] text-[18px] leading-[1.55]";
/** A link inside running text: chalk, underlined in a keyline that lights to chalk under the pointer */
export const TEXT_LINK =
  "font-medium text-lc-chalk underline decoration-lc-keyline decoration-1 underline-offset-4 transition-[text-decoration-color] duration-200 ease-lc hover:decoration-lc-chalk";

/** "Play now": the page's one main action, into the game (a full page load, as from the home page's Drive) */
export const PlayNow: React.FC = () => (
  <Button href={withBasePath("/play")} native variant="primary" size="md" icon={<Icon name="drive" />}>
    Play now
  </Button>
);

export function SitePage({
  action = <PlayNow />,
  children,
  scrollRef,
  id,
  className,
}: {
  /** Right of the logo (default "Play now"); null for none */
  action?: React.ReactNode;
  children: React.ReactNode;
  /** The scroll box, for a page that sets its scroll padding */
  scrollRef?: React.Ref<HTMLDivElement>;
  id?: string;
  /** Classes of the scroll box (smooth scrolling) */
  className?: string;
}) {
  return (
    <div
      ref={scrollRef}
      id={id}
      className={cx("h-dvh overflow-y-auto overscroll-contain bg-lc-void text-lc-chalk", className)}
    >
      <div className="sr-only focus-within:not-sr-only focus-within:fixed focus-within:top-3 focus-within:left-3 focus-within:z-(--z-lc-notice)">
        <Button href="#content" native variant="secondary" size="sm">
          Skip to content
        </Button>
      </div>
      <div className="mx-auto flex w-full max-w-[1040px] flex-col pt-[max(1.25rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(4rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))]">
        <header className="flex min-h-13 flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="LibreCorsa home" className="inline-flex rounded-lc-nub no-underline">
            <LibreCorsaLogo variant="compact" size="sm" />
          </Link>
          {action}
        </header>
        <main id="content" tabIndex={-1} className="flex flex-col gap-16 pt-12 outline-none phone:gap-12 phone:pt-8">
          {children}
        </main>
      </div>
    </div>
  );
}

/** The top of a page: its one `h1` and what the page is for */
export function SiteIntro({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h1 className="lc-h1 text-balance text-lc-chalk">{title}</h1>
      {children}
    </section>
  );
}

/** A part of a page under its `h2` */
export function SiteSection({
  id,
  title,
  children,
  gap = "gap-5",
}: {
  id: string;
  title: React.ReactNode;
  children: React.ReactNode;
  /** Space between the heading and the blocks under it */
  gap?: "gap-4" | "gap-5" | "gap-6";
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx("flex scroll-mt-6 flex-col", gap)}>
      <h2 id={`${id}-title`} className="lc-h2 text-balance text-lc-chalk">
        {title}
      </h2>
      {children}
    </section>
  );
}
