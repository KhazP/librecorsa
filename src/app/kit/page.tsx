import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { CoreSection } from "./sections/CoreSection";
import { LogoSection } from "./sections/LogoSection";
import { SymbolsSection } from "./sections/SymbolsSection";

export const metadata: Metadata = {
  title: "UI kit",
  robots: { index: false, follow: false },
};

const SECTIONS = [
  { id: "controls", label: "Controls" },
  { id: "symbols", label: "Symbols and badges" },
  { id: "logo", label: "Logo" },
] as const;

/** The UI standard as it is built: every part, size and state on one page. Development only. */
export default function KitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    // body is overflow: hidden for the game, so the page scrolls in its own container
    <div className="h-dvh overflow-y-auto bg-lc-void text-lc-chalk">
      <header className="sticky top-0 z-(--z-lc-menu) border-b border-white/7 bg-lc-void/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1320px] flex-wrap items-center gap-x-8 gap-y-3 px-[max(1.5rem,env(safe-area-inset-left))] py-3.5">
          <LibreCorsaLogo variant="compact" />
          <nav aria-label="Kit sections" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="lc-row-label text-lc-slate transition-colors duration-200 ease-lc hover:text-lc-chalk"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-[1320px] flex-col gap-20 px-[max(1.5rem,env(safe-area-inset-left))] pt-10 pb-24">
        <section id="controls" className="scroll-mt-20">
          <CoreSection />
        </section>
        <section id="symbols" className="scroll-mt-20">
          <SymbolsSection />
        </section>
        <section id="logo" className="scroll-mt-20">
          <LogoSection />
        </section>
      </main>
    </div>
  );
}
