/* eslint-disable @next/next/no-img-element -- the kit shows the exact icon files at their real pixel sizes */
import React from "react";
import { LibreCorsaLogo, LibreCorsaMark, type LogoTone } from "@/components/ui/LibreCorsaLogo";
import { LOGO_TAGLINE } from "@/components/ui/logo/geometry";
import { withBasePath } from "@/lib/base-path";

const CARD = "rounded-lc-card border border-white/7 bg-lc-carbon/80 p-4.5";

const BACKGROUNDS = [
  { id: "dark", label: "On void", surface: "bg-lc-void border border-lc-line", mono: "text-lc-chalk" },
  { id: "light", label: "On white", surface: "bg-lc-chalk", mono: "text-lc-void" },
  {
    id: "photo",
    label: "On a mid-tone picture",
    surface: "bg-radial-[at_25%_20%] from-lc-slate via-lc-keyline to-lc-titanium",
    mono: "text-lc-chalk",
  },
] as const;

const TONES: { tone: LogoTone; title: string; hint: string }[] = [
  { tone: "on-dark", title: "On dark", hint: "The default: LIBRE in chalk, CORSA in volt. For the game, the site and dark pictures." },
  { tone: "on-light", title: "On light", hint: "LIBRE in void for white paper and light pages. CORSA stays volt, which is faint on white." },
  { tone: "mono", title: "One colour", hint: "Everything in the current text colour, the emblem as a cut-out badge. For one-colour print and engraving." },
];

const SIZES = [
  { px: 16, cls: "size-4" },
  { px: 24, cls: "size-6" },
  { px: 32, cls: "size-8" },
  { px: 48, cls: "size-12" },
  { px: 64, cls: "size-16" },
  { px: 128, cls: "size-32" },
];

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="lc-hint">{children}</p>;
}

function LockupRow({ tone }: { tone: LogoTone }) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {BACKGROUNDS.map((bg) => (
        <div key={bg.id} className="flex flex-col gap-1">
          <div
            className={`flex min-h-56 flex-col items-start justify-center gap-5 overflow-hidden rounded-lc-tile p-4.5 ${bg.surface} ${
              tone === "mono" ? bg.mono : ""
            }`}
          >
            <LibreCorsaLogo variant="mark" tone={tone} className="size-12" />
            <LibreCorsaLogo variant="compact" size="sm" tone={tone} />
            <LibreCorsaLogo variant="full" tone={tone} />
          </div>
          <Caption>{bg.label}</Caption>
        </div>
      ))}
    </div>
  );
}

/** One favicon pairing, today's file beside the new drawing, at the size a browser tab shows */
function FaviconPair({ px }: { px: 16 | 32 }) {
  return (
    <div className="flex flex-col gap-3">
      <h4 className="lc-h3">{px} px</h4>
      <div className="flex flex-wrap gap-3">
        {(["bg-lc-titanium", "bg-lc-chalk"] as const).map((strip) => (
          <div key={strip} className={`flex items-center gap-6 rounded-lc-row px-4 py-3 ${strip}`}>
            <figure className="flex flex-col items-center gap-1">
              <img src={withBasePath(`/branding/legacy/favicon-before-${px}.png`)} width={px} height={px} alt="Today's favicon" />
              <figcaption className="lc-hint">Today</figcaption>
            </figure>
            <figure className="flex flex-col items-center gap-1">
              <img src={withBasePath(`/branding/favicon-${px}.png`)} width={px} height={px} alt="New favicon" />
              <figcaption className="lc-hint">New</figcaption>
            </figure>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The maskable icon under a launcher mask, with the 80 % safe circle drawn over it */
function MaskPreview({ shape, label }: { shape: string; label: string }) {
  return (
    <figure className="flex flex-col items-center gap-2">
      <div className="relative size-40">
        <img
          src={withBasePath("/branding/icon-maskable-512.png")}
          width={160}
          height={160}
          alt={`Maskable icon in a ${label.toLowerCase()}`}
          className={`size-40 ${shape}`}
        />
        <span aria-hidden className="pointer-events-none absolute inset-[10%] rounded-full border border-dashed border-lc-fog/70" />
      </div>
      <figcaption className="lc-hint">{label}</figcaption>
    </figure>
  );
}

export function LogoSection() {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="kit-logo">
      <div className="flex flex-col gap-2">
        <h2 id="kit-logo" className="lc-h2 text-lc-chalk">
          Logo
        </h2>
        <p className="lc-hint max-w-2xl">
          One drawing, one slant (12 degrees for the emblem, the wordmark and the bars) and one tagline. The wordmark is
          outlined from Orbitron 900, so it never waits for a webfont. Every file in public/branding and the favicon is
          written from the same geometry by npm run brand.
        </p>
      </div>

      {TONES.map((t) => (
        <div key={t.tone} className={`${CARD} flex flex-col gap-3`}>
          <div className="flex flex-col gap-1">
            <h3 className="lc-h3">{t.title}</h3>
            <Caption>{t.hint}</Caption>
          </div>
          <LockupRow tone={t.tone} />
        </div>
      ))}

      <div className={`${CARD} flex flex-col gap-4`}>
        <div className="flex flex-col gap-1">
          <h3 className="lc-h3">Emblem sizes</h3>
          <Caption>
            Under 32 px the emblem switches by itself to the small drawing: no kerb, no exit streaks, a heavier L and C
            with clear space between them, so it stays sharp in a browser tab and on the HUD.
          </Caption>
        </div>
        {(["on-dark", "mono"] as const).map((tone) => (
          <div key={tone} className={`flex flex-wrap items-end gap-6 ${tone === "mono" ? "text-lc-chalk" : ""}`}>
            {SIZES.map((s) => (
              <figure key={s.px} className="flex flex-col items-center gap-2">
                <LibreCorsaMark className={s.cls} tone={tone} title={`Emblem at ${s.px} px`} />
                <figcaption className={`lc-hint ${s.px < 32 ? "text-lc-chalk" : ""}`}>
                  {s.px} px{s.px < 32 ? ", small" : ""}
                </figcaption>
              </figure>
            ))}
          </div>
        ))}
      </div>

      <div className={`${CARD} flex flex-col gap-4`}>
        <div className="flex flex-col gap-1">
          <h3 className="lc-h3">Favicon, today and new</h3>
          <Caption>At the real size of a tab icon, on a dark and a light tab strip. Today's file is a downsample of the full emblem.</Caption>
        </div>
        <div className="flex flex-wrap gap-8">
          <FaviconPair px={16} />
          <FaviconPair px={32} />
        </div>
      </div>

      <div className={`${CARD} flex flex-col gap-4`}>
        <div className="flex flex-col gap-1">
          <h3 className="lc-h3">App icons</h3>
          <Caption>
            The maskable icon is a full-bleed void square with the emblem inside the safe circle (dashed, 80 % of the side), so no
            launcher mask cuts into it. The plain icon is the emblem edge to edge on transparency.
          </Caption>
        </div>
        <div className="flex flex-wrap items-end gap-8">
          <MaskPreview shape="rounded-full" label="Circle mask" />
          <MaskPreview shape="rounded-[22%]" label="Rounded square mask" />
          <figure className="flex flex-col items-center gap-2">
            <img src={withBasePath("/branding/icon-192.png")} width={96} height={96} alt="App icon" className="size-24" />
            <figcaption className="lc-hint">Any purpose, 192 px</figcaption>
          </figure>
          <figure className="flex flex-col items-center gap-2">
            <img src={withBasePath("/branding/apple-touch-icon.png")} width={90} height={90} alt="Apple touch icon" className="size-[90px] rounded-[22%]" />
            <figcaption className="lc-hint">Apple touch, 180 px</figcaption>
          </figure>
          <figure className="flex flex-col items-center gap-2 text-lc-chalk">
            <img src={withBasePath("/branding/librecorsa-mark-mono.svg")} width={64} height={64} alt="Monochrome icon" className="size-16 rounded-lc-nub bg-lc-chalk p-1" />
            <figcaption className="lc-hint">Monochrome</figcaption>
          </figure>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className={`${CARD} flex flex-col gap-4`}>
          <div className="flex flex-col gap-1">
            <h3 className="lc-h3">Clear space</h3>
            <Caption>Keep half the emblem&apos;s width clear on every side (dashed). Nothing else enters that space.</Caption>
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <span className="inline-flex border border-dashed border-lc-fog/60 p-4">
              <LibreCorsaLogo variant="compact" size="sm" />
            </span>
            <span className="inline-flex border border-dashed border-lc-fog/60 p-6">
              <LibreCorsaMark className="size-12" title="" />
            </span>
          </div>
        </div>
        <div className={`${CARD} flex flex-col gap-4`}>
          <div className="flex flex-col gap-1">
            <h3 className="lc-h3">Smallest sizes</h3>
            <Caption>The emblem no smaller than 16 px; the compact lock-up no narrower than 96 px. Below that, use the emblem alone.</Caption>
          </div>
          <div className="flex flex-wrap items-end gap-8">
            <figure className="flex flex-col items-center gap-2">
              <LibreCorsaMark className="size-4" title="Emblem at 16 px" />
              <figcaption className="lc-hint">Emblem, 16 px</figcaption>
            </figure>
            <figure className="flex flex-col items-start gap-2">
              {/* the small lock-up drawn at 96 px wide (it is 187 px at its small size) */}
              <span className="inline-flex [zoom:0.513]">
                <LibreCorsaLogo variant="compact" size="sm" />
              </span>
              <figcaption className="lc-hint">Compact lock-up, 96 px</figcaption>
            </figure>
          </div>
        </div>
      </div>

      <div className={`${CARD} flex flex-col gap-2`}>
        <h3 className="lc-h3">Tagline</h3>
        <p className="lc-row-label">{LOGO_TAGLINE}</p>
        <Caption>The one tagline, under the full lock-up and anywhere the name needs a line of explanation.</Caption>
      </div>
    </section>
  );
}
