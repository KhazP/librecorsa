import { statSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { LEAD, READ, SiteIntro, SitePage, SiteSection, TEXT_LINK } from "@/components/home/SitePage";
import { Button } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { withBasePath } from "@/lib/base-path";
import {
  coverage,
  discussions,
  PRESS_KIT_ZIP,
  PRESS_SCREENSHOTS,
  RISE_OFFICIAL_RENDER,
  RISE_PRESS_KIT_ZIP,
  RISE_RENDERS,
} from "@/lib/press";
import { CONTACT_EMAIL, DOCS_URL, REPO_URL, SITE_NAME } from "@/lib/site";
import { CoverageList } from "./CoverageList";
import { PlayerNumbers } from "./PlayerNumbers";
import { CARD, CARD_ICON, CARD_LINK, day } from "./press-ui";

const DESCRIPTION = "Coverage of LibreCorsa, the free browser racing sim, plus a press kit: facts, logos, screenshots and the trailer.";
// The share card from src/app/opengraph-image.jpg: file-based images only cover the home page, so it's named here
const SHARE_IMAGE = {
  url: "/opengraph-image.jpg",
  width: 1200,
  height: 630,
  alt: "A LibreCorsa open-wheeler on the start-finish straight of RISE Motordrome",
};

export const metadata: Metadata = {
  title: "Press & media",
  description: DESCRIPTION,
  alternates: { canonical: "/press" },
  openGraph: {
    type: "website",
    url: "/press",
    siteName: SITE_NAME,
    title: `Press & media | ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: "en_US",
    images: [SHARE_IMAGE],
  },
  twitter: { card: "summary_large_image", title: `Press & media | ${SITE_NAME}`, description: DESCRIPTION, images: [SHARE_IMAGE] },
};

const TRAILER_URL = "/media/librecorsa-trailer.mp4";

const FACTS: [string, React.ReactNode][] = [
  ["Developer", "Alp Yalay, solo"],
  ["Released", "October 2026, free to play in the browser"],
  ["Plays on", "Any modern browser (computer, phone or tablet), plus desktop and Android apps"],
  ["Controls", "Keyboard, gamepad, touch or a force-feedback wheel"],
  ["Modes", "Career mode, time trials, hot laps, races against AI, multiplayer, online lap times"],
  ["Content", "15 cars across five classes (2026, 2025 and 2007 open-wheelers, GT3, prototypes, classics and road cars) on 20 circuits and two hill climbs"],
  ["Price", "Free. Tips are optional and unlock nothing"],
  [
    "Website",
    <Link key="site" href="/" translate="no" className={TEXT_LINK}>
      librecorsa.org
    </Link>,
  ],
  [
    "Source",
    <a key="src" href={REPO_URL} translate="no" className={TEXT_LINK}>
      github.com/librecorsa/librecorsa
    </a>,
  ],
  [
    "Docs",
    <a key="docs" href={DOCS_URL} translate="no" className={TEXT_LINK}>
      docs.librecorsa.org
    </a>,
  ],
];

/** A ZIP's size in MB, read when the page is built */
const zipMb = (path: string) => (statSync(join(process.cwd(), "public", path)).size / 1e6).toFixed(1);
const KIT_MB = zipMb(PRESS_KIT_ZIP);
const RISE_KIT_MB = zipMb(RISE_PRESS_KIT_ZIP);
const RISE_AERIAL = RISE_RENDERS.find((r) => r.file === "rise-aerial.jpg")!;

const BRAND_FILES = [
  { label: "Logo", detail: "SVG", href: "/branding/librecorsa-logo.svg" },
  { label: "Logo on light", detail: "SVG", href: "/branding/librecorsa-logo-on-light.svg" },
  { label: "Logo in one colour", detail: "SVG", href: "/branding/librecorsa-logo-mono.svg" },
  { label: "Emblem", detail: "SVG", href: "/branding/librecorsa-mark.svg" },
  { label: "App icon", detail: "PNG, 512 × 512", href: "/branding/icon-512.png" },
  { label: "Banner", detail: "PNG, 2560 × 720", href: "/press/banner.png" },
];

/** A ZIP to download: what is in it, and the button */
function KitDownload({ title, detail, href, mb }: { title: string; detail: string; href: string; mb: string }) {
  return (
    <div className={`${CARD} flex flex-wrap items-center justify-between gap-x-6 gap-y-4 p-4.5 sm:p-6`}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="lc-row-label m-0 text-[17px]">{title}</p>
        <p className="lc-body m-0 text-[15px]">{detail}</p>
      </div>
      <Button href={withBasePath(href)} download variant="secondary" icon={<Icon name="download" />}>
        {`ZIP, ${mb} MB`}
      </Button>
    </div>
  );
}


/** A picture to download: its thumbnail, what it shows and, when given, its size */
function ImageDownload({ href, thumb, caption, size }: { href: string; thumb: string; caption: string; size?: string }) {
  return (
    <a href={withBasePath(href)} download className={`${CARD_LINK} flex h-full flex-col overflow-hidden`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={withBasePath(thumb)}
        alt=""
        width={1024}
        height={576}
        loading="lazy"
        decoding="async"
        className="aspect-video w-full object-cover"
      />
      <span className="flex flex-1 items-start justify-between gap-2 px-3.5 py-3 text-[13px] leading-snug text-lc-fog transition-colors duration-200 group-hover:text-lc-chalk">
        <span className="min-w-0">
          {caption}
          {size ? <span className="lc-mono block pt-1 text-[12px] text-lc-slate">{size}</span> : null}
        </span>
        <Icon name="download" className={CARD_ICON} />
      </span>
    </a>
  );
}

/** The thumbnail of a full-size JPEG in the same folder's thumbs/ */
const thumbOf = (dir: string, file: string) => `${dir}/thumbs/${file.replace(/\.jpg$/, ".webp")}`;

export default function PressPage() {
  const articles = coverage();
  const threads = discussions();

  const parts = [
    { id: "coverage", name: "Coverage" },
    ...(threads.length ? [{ id: "discussion", name: "Mentions" }] : []),
    { id: "players", name: "Players" },
    { id: "kit", name: "Press kit" },
    { id: "rise", name: "RISE Motordrome" },
    { id: "contact", name: "Contact" },
  ];

  return (
    <SitePage wide className="motion-safe:scroll-smooth">
      <SiteIntro title="LibreCorsa in the press">
        <p className={LEAD}>
          LibreCorsa is a free racing simulator that runs in your browser. I make it on my own. Here is what other people have
          written and made about it, and everything you need to cover it yourself.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button href={withBasePath(PRESS_KIT_ZIP)} download variant="secondary" icon={<Icon name="download" />}>
            {`Press kit, ZIP ${KIT_MB} MB`}
          </Button>
          <Button href={withBasePath(TRAILER_URL)} native variant="secondary" icon={<Icon name="play" />}>
            Trailer
          </Button>
          <Button href={`mailto:${CONTACT_EMAIL}`} variant="ghost">
            Email me
          </Button>
        </div>
        <nav aria-label="Parts of the page" className="-mx-2 flex flex-wrap">
          {parts.map((p) => (
            <a
              key={p.id}
              href={`#${p.id}`}
              className="inline-flex min-h-8 items-center rounded-full px-2 text-[14px] font-medium text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk pointer-coarse:min-h-11"
            >
              {p.name}
            </a>
          ))}
        </nav>
      </SiteIntro>

      <SiteSection id="coverage" title="Coverage">
        {articles.length ? (
          <CoverageList items={articles} />
        ) : (
          <p className={READ}>Nothing yet. If you write about LibreCorsa or film it, tell me and I’ll add it here.</p>
        )}
      </SiteSection>

      {threads.length ? (
        <SiteSection id="discussion" title="Mentions">
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
            {threads.map((t) => (
              <li key={t.url} className="flex">
                <a href={t.url} target="_blank" rel="noopener" className={`${CARD_LINK} flex w-full items-start justify-between gap-4 px-4.5 py-4 sm:px-5`}>
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="m-0 text-[15px] leading-snug font-medium text-pretty text-lc-chalk">{t.title}</h3>
                    <p className="lc-body m-0 text-[14px] text-lc-slate">
                      {t.where} <span aria-hidden>·</span> <span className="lc-mono whitespace-nowrap">{day(t.date)}</span>
                      {t.engagement ? (
                        <>
                          {" "}
                          <span aria-hidden>·</span> {t.engagement}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <Icon name="externalLink" className={`mt-0.5 ${CARD_ICON}`} />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </SiteSection>
      ) : null}

      <SiteSection id="players" title="Players">
        <PlayerNumbers />
      </SiteSection>

      <SiteSection id="kit" title="Press kit" gap="gap-6">
        <div className="grid gap-3 lg:grid-cols-2">
          <a
            href={withBasePath(TRAILER_URL)}
            className={`${CARD_LINK} relative block self-start overflow-hidden`}
            aria-label="Watch the trailer (40 seconds, MP4)"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withBasePath("/press/trailer-poster.jpg")}
              alt=""
              width={1280}
              height={720}
              loading="lazy"
              decoding="async"
              className="aspect-video w-full object-cover"
            />
            <span className="absolute bottom-4 start-4">
              <Badge variant="solid" size="lg" icon="play">
                {"Trailer, 40 s, MP4"}
              </Badge>
            </span>
          </a>

          <div className="flex flex-col gap-3">
            <KitDownload
              title="Download the press kit"
              detail={`${PRESS_SCREENSHOTS.length} screenshots at 2560 × 1440, the logos and the banner, in one ZIP`}
              href={PRESS_KIT_ZIP}
              mb={KIT_MB}
            />
            <section aria-labelledby="logos" className="flex flex-col gap-3 pt-2">
              <h3 id="logos" className="lc-h3">
                Logos
              </h3>
              <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
                {BRAND_FILES.map((f) => (
                  <li key={f.href}>
                    <a href={withBasePath(f.href)} download className={`${CARD_LINK} flex h-full items-start justify-between gap-3 p-4`}>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="lc-row-label">{f.label}</span>
                        <span className="lc-mono text-[12px] text-lc-slate">{f.detail}</span>
                      </span>
                      <Icon name="download" className={`mt-0.5 ${CARD_ICON}`} />
                    </a>
                  </li>
                ))}
              </ul>
              <p className="lc-hint m-0 text-[13px]">Use these freely when writing about LibreCorsa. Please keep the logo’s colours as they are.</p>
            </section>
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <div className={`${CARD} flex flex-col gap-4 p-4.5 sm:p-6`}>
            <p className="lc-body m-0 text-[16px] leading-[1.6]">
              LibreCorsa is a free racing simulator that runs in a web browser, with nothing to install. You drive 15 cars across
              five classes (2026, 2025 and 2007 open-wheelers, GT3 cars, prototypes, classics and road cars) on 20 circuits and two hill
              climbs, in the dry or the rain, by day or at night. Work through a career ladder, take on weekly and permanent time
              trials, race AI drivers, set lap times against players around the world, or race friends online. It plays with a
              keyboard, a gamepad, a touch screen or a steering wheel with force feedback. I build it alone, and the code is open
              source.
            </p>
            <p className="lc-hint m-0 text-[13px]">
              LibreCorsa is an independent fan project. It is not affiliated with Formula 1, the FIA, any team or any circuit.
            </p>
          </div>

          <dl className={`${CARD} m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3.5 p-4.5 sm:p-6`}>
            {FACTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="lc-lbl pt-[3px]">{k}</dt>
                <dd className="lc-body m-0 text-[15px] [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        <section aria-labelledby="screenshots" className="flex flex-col gap-3 pt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 id="screenshots" className="lc-h3">
              Screenshots
            </h3>
            <p className="lc-hint m-0">{"2560 × 1440, JPEG"}</p>
          </div>
          <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-5">
            {PRESS_SCREENSHOTS.map((s) => (
              <li key={s.file}>
                <ImageDownload href={`/press/screenshots/${s.file}`} thumb={thumbOf("/press/screenshots", s.file)} caption={s.alt} />
              </li>
            ))}
          </ul>
        </section>
      </SiteSection>

      <SiteSection id="rise" title="RISE Motordrome" gap="gap-6">
        <div className="grid items-center gap-x-6 gap-y-4 lg:grid-cols-2">
          <p className={READ}>
            I built the circuit planned for Bugesera, Rwanda from scratch, from its published design and the real ground it
            sits on: 5.9 km, 17 corners and a 190 m climb beside Lake Kidogo. These are Cycles renders of the same model the
            game drives on.
          </p>
          <KitDownload
            title="Download the RISE Motordrome press kit"
            detail={`${RISE_RENDERS.length} renders of the circuit with open-wheel and GT3 cars, in one ZIP`}
            href={RISE_PRESS_KIT_ZIP}
            mb={RISE_KIT_MB}
          />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <figure className={`${CARD} m-0 flex flex-col overflow-hidden`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withBasePath(RISE_OFFICIAL_RENDER)}
              alt="The official design render of the circuit from above the lake"
              width={1024}
              height={683}
              loading="lazy"
              decoding="async"
              className="aspect-[3/2] w-full object-cover"
            />
            <figcaption className="lc-hint px-4.5 py-3 text-[14px]">The official design render, by Tilke</figcaption>
          </figure>
          <figure className={`${CARD} m-0 flex flex-col overflow-hidden`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withBasePath(`/press/rise/${RISE_AERIAL.file}`)}
              alt={`${RISE_AERIAL.alt}, from the same angle in LibreCorsa’s model`}
              width={3072}
              height={2048}
              loading="lazy"
              decoding="async"
              className="aspect-[3/2] w-full object-cover"
            />
            <figcaption className="lc-hint px-4.5 py-3 text-[14px]">The same view of my model, rendered in Blender Cycles</figcaption>
          </figure>
        </div>

        <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-3">
          {RISE_RENDERS.map((r) => (
            <li key={r.file}>
              <ImageDownload href={`/press/rise/${r.file}`} thumb={thumbOf("/press/rise", r.file)} caption={r.alt} size={r.size} />
            </li>
          ))}
        </ul>
      </SiteSection>

      <SiteSection id="contact" title="Contact">
        <p className={READ}>
          For interviews, questions or footage, email me at{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} translate="no" className={TEXT_LINK}>
            {CONTACT_EMAIL}
          </a>
          . Wrote something about LibreCorsa? Send me the link and I’ll add it to this page.
        </p>
      </SiteSection>
    </SitePage>
  );
}
