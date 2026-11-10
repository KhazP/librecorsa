import { statSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Download, Play } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { withBasePath } from "@/lib/base-path";
import { coverage, discussions, PRESS_KIT_ZIP, PRESS_SCREENSHOTS } from "@/lib/press";
import { REPO_URL, SITE_NAME } from "@/lib/site";

const DESCRIPTION = "Coverage of LibreCorsa, the free browser racing sim, plus a press kit: facts, logos, screenshots and the trailer.";
// The share card from src/app/opengraph-image.jpg: file-based images only cover the home page, so it's named here
const SHARE_IMAGE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "A LibreCorsa open-wheeler on the start-finish straight of the Rwanda International Circuit",
};

export const metadata: Metadata = {
  title: "Press",
  description: DESCRIPTION,
  alternates: { canonical: "/press" },
  openGraph: {
    type: "website",
    url: "/press",
    siteName: SITE_NAME,
    title: `Press | ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: "en_US",
    images: [SHARE_IMAGE],
  },
  twitter: { card: "summary_large_image", title: `Press | ${SITE_NAME}`, description: DESCRIPTION, images: [SHARE_IMAGE] },
};

const CONTACT_EMAIL = "alpyalay@gmail.com";
const TRAILER_URL = "/media/librecorsa-trailer.mp4";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-11-09 → 9 Nov 2026 (the same on every machine, unlike toLocaleDateString) */
const day = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

const FACTS: [string, React.ReactNode][] = [
  ["Developer", "Alp Yalay, solo"],
  ["Released", "October 2026, free to play in the browser"],
  ["Plays on", "Any modern browser: computer, phone or tablet"],
  ["Controls", "Keyboard, gamepad, touch or a force-feedback wheel"],
  ["Modes", "Hot laps, races against AI, multiplayer, online lap times"],
  ["Content", "Open-wheelers built to the 2026 rules, GT3 cars, a road car, more than a dozen circuits"],
  ["Price", "Free. Tips are optional and unlock nothing"],
  [
    "Website",
    <Link key="site" href="/" className="text-[#F5F7FA] underline decoration-[#3A4157] underline-offset-4 hover:decoration-[#CCFF00]">
      librecorsa.org
    </Link>,
  ],
  [
    "Source",
    <a key="src" href={REPO_URL} className="text-[#F5F7FA] underline decoration-[#3A4157] underline-offset-4 hover:decoration-[#CCFF00]">
      github.com/KhazP/librecorsa
    </a>,
  ],
];

/** The press kit ZIP's size, read when the page is built */
const KIT_MB = (statSync(join(process.cwd(), "public", PRESS_KIT_ZIP)).size / 1e6).toFixed(1);

const BRAND_FILES = [
  { label: "Logo", detail: "SVG", href: "/branding/librecorsa-logo.svg" },
  { label: "Emblem", detail: "SVG", href: "/branding/librecorsa-mark.svg" },
  { label: "App icon", detail: "PNG · 512 × 512", href: "/branding/icon-512.png" },
  { label: "Banner", detail: "PNG · 2560 × 720", href: "/press/banner.png" },
];

const SECTION = "flex flex-col gap-5 border-t border-[#262B3D] pt-8";
const H2 = "lc-disp text-[28px] text-[#F5F7FA]";
const CARD = "rounded-[18px] border border-[#262B3D] bg-[#11131A]";

export default function PressPage() {
  const articles = coverage();
  const threads = discussions();

  return (
    // The body never scrolls (the game fills the screen), so this page scrolls itself
    <main className="h-dvh overflow-y-auto bg-[#08090D] text-[#F5F7FA]">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-10 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <Link href="/" aria-label="LibreCorsa home" className="no-underline">
            <LibreCorsaLogo variant="compact" size="sm" />
          </Link>
          <Link
            href="/"
            className="lc-title inline-flex items-center gap-2 rounded-full bg-[#CCFF00] px-5 py-2.5 text-[15px] text-[#08090D] no-underline transition-colors hover:bg-[#99BF00]"
          >
            <Play aria-hidden className="h-4 w-4" strokeWidth={2.5} />
            Play now
          </Link>
        </header>

        <section className="flex flex-col gap-4">
          <p className="lc-lbl">Press</p>
          <h1 className="lc-disp text-[clamp(44px,9vw,72px)] text-[#F5F7FA]">LibreCorsa in the press</h1>
          <p className="max-w-[640px] text-[17px] leading-relaxed text-[#C5CBD8]">
            LibreCorsa is a free racing simulator that runs in your browser. I make it on my own. Here is what other people have
            written and made about it, and everything you need to cover it yourself.
          </p>
        </section>

        <section className={SECTION} aria-labelledby="coverage">
          <h2 id="coverage" className={H2}>
            Coverage
          </h2>
          {articles.length ? (
            <ul className="flex flex-col gap-2">
              {articles.map((a) => (
                <li key={a.url}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener"
                    className={`${CARD} group flex items-start justify-between gap-4 p-4 no-underline transition-colors hover:border-[#3A4157] sm:p-5`}
                  >
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <p className="lc-lbl">
                        {a.outlet} · {a.kind}
                        {a.lang ? ` · ${a.lang.toUpperCase()}` : ""}
                      </p>
                      <p className="text-[17px] font-semibold text-[#F5F7FA] group-hover:text-[#CCFF00]">{a.title}</p>
                      <p className="text-[14px] text-[#8E96AA]">
                        {a.author ? `${a.author} · ` : ""}
                        <span className="lc-data font-semibold">{day(a.date)}</span>
                      </p>
                    </div>
                    <ArrowUpRight aria-hidden className="mt-1 h-5 w-5 shrink-0 text-[#8E96AA] group-hover:text-[#CCFF00]" />
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[15px] text-[#C5CBD8]">Nothing yet. If you write about LibreCorsa or film it, tell me and I&apos;ll add it here.</p>
          )}
        </section>

        {threads.length ? (
          <section className={SECTION} aria-labelledby="discussion">
            <h2 id="discussion" className={H2}>
              Mentions
            </h2>
            <ul className="flex flex-col divide-y divide-[#262B3D] overflow-hidden rounded-[18px] border border-[#262B3D] bg-[#11131A]">
              {threads.map((t) => (
                <li key={t.url}>
                  <a href={t.url} target="_blank" rel="noopener" className="group flex items-center justify-between gap-4 px-4 py-3.5 no-underline sm:px-5">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="lc-lbl">
                        {t.where} · {day(t.date)}
                      </p>
                      <p className="text-[15px] font-medium text-[#F5F7FA] group-hover:text-[#CCFF00]">{t.title}</p>
                    </div>
                    {t.engagement ? <p className="lc-data shrink-0 text-[13px] text-[#8E96AA] max-sm:hidden">{t.engagement}</p> : null}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className={SECTION} aria-labelledby="kit">
          <h2 id="kit" className={H2}>
            Press kit
          </h2>

          <a
            href={withBasePath(PRESS_KIT_ZIP)}
            download
            className={`${CARD} group flex flex-wrap items-center justify-between gap-4 p-5 no-underline transition-colors hover:border-[#CCFF00] sm:p-6`}
          >
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-[17px] font-semibold text-[#F5F7FA]">Download the press kit</span>
              <span className="text-[14px] text-[#8E96AA]">
                {PRESS_SCREENSHOTS.length} screenshots at 2560 × 1440, the logos and the banner, in one ZIP
              </span>
            </span>
            <span className="lc-title inline-flex shrink-0 items-center gap-2 rounded-full bg-[#CCFF00] px-5 py-2.5 text-[15px] text-[#08090D] transition-colors group-hover:bg-[#99BF00]">
              <Download aria-hidden className="h-4 w-4" strokeWidth={2.5} />
              ZIP · {KIT_MB} MB
            </span>
          </a>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className={`${CARD} flex flex-col gap-4 p-5 sm:p-6`}>
              <p className="lc-lbl">About</p>
              <p className="text-[15px] leading-relaxed text-[#C5CBD8]">
                LibreCorsa is a free racing simulator that runs in a web browser, with nothing to install. You drive open-wheel race
                cars built to the 2026 rules, GT3 cars and a small road car on more than a dozen circuits, in the dry or the rain,
                by day or at night. Race AI drivers, set lap times against players around the world, or race friends online. It
                plays with a keyboard, a gamepad, a touch screen or a steering wheel with force feedback. I build it alone, and
                the code is open source.
              </p>
              <p className="text-[13px] leading-relaxed text-[#8E96AA]">
                LibreCorsa is an independent fan project. It is not affiliated with Formula 1, the FIA, any team or any circuit.
              </p>
            </div>

            <dl className={`${CARD} grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 p-5 sm:p-6`}>
              {FACTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="lc-lbl pt-[3px]">{k}</dt>
                  <dd className="text-[15px] text-[#C5CBD8]">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <a
            href={withBasePath(TRAILER_URL)}
            className={`${CARD} group relative block overflow-hidden no-underline`}
            aria-label="Watch the trailer (40 seconds, MP4)"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withBasePath("/press/trailer-poster.jpg")}
              alt=""
              width={1280}
              height={720}
              className="aspect-video w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
            />
            <span className="lc-title absolute bottom-4 left-4 inline-flex items-center gap-2 rounded-full bg-[#CCFF00] px-4 py-2 text-[14px] text-[#08090D]">
              <Play aria-hidden className="h-4 w-4" strokeWidth={2.5} />
              Trailer · 40 s · MP4
            </span>
          </a>

          <div className="flex flex-col gap-3">
            <p className="lc-lbl">Screenshots · 2560 × 1440</p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {PRESS_SCREENSHOTS.map((s) => (
                <li key={s.file}>
                  <a
                    href={withBasePath(`/press/screenshots/${s.file}`)}
                    download
                    className={`${CARD} group flex flex-col overflow-hidden no-underline`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={withBasePath(`/press/screenshots/thumbs/${s.file.replace(/\.jpg$/, ".webp")}`)}
                      alt={s.alt}
                      width={1024}
                      height={576}
                      loading="lazy"
                      className="aspect-video w-full object-cover"
                    />
                    <span className="flex items-center justify-between gap-3 px-4 py-3 text-[14px] text-[#C5CBD8] group-hover:text-[#F5F7FA]">
                      {s.alt}
                      <Download aria-hidden className="h-4 w-4 shrink-0 text-[#8E96AA] group-hover:text-[#CCFF00]" />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-col gap-3">
            <p className="lc-lbl">Logos</p>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {BRAND_FILES.map((f) => (
                <li key={f.href}>
                  <a
                    href={withBasePath(f.href)}
                    download
                    className={`${CARD} group flex h-full flex-col gap-1 p-4 no-underline transition-colors hover:border-[#3A4157]`}
                  >
                    <span className="flex items-center justify-between gap-2 text-[15px] font-semibold text-[#F5F7FA] group-hover:text-[#CCFF00]">
                      {f.label}
                      <Download aria-hidden className="h-4 w-4 shrink-0 text-[#8E96AA] group-hover:text-[#CCFF00]" />
                    </span>
                    <span className="lc-data text-[12px] font-semibold text-[#8E96AA]">{f.detail}</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-[13px] text-[#8E96AA]">Use these freely when writing about LibreCorsa. Please keep the logo&apos;s colours as they are.</p>
          </div>
        </section>

        <section className={SECTION} aria-labelledby="contact">
          <h2 id="contact" className={H2}>
            Contact
          </h2>
          <p className="max-w-[640px] text-[15px] leading-relaxed text-[#C5CBD8]">
            For interviews, questions or footage, email me at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-[#F5F7FA] underline decoration-[#3A4157] underline-offset-4 hover:decoration-[#CCFF00]">
              {CONTACT_EMAIL}
            </a>
            . Wrote something about LibreCorsa? Send me the link and I&apos;ll add it to this page.
          </p>
        </section>
      </div>
    </main>
  );
}
