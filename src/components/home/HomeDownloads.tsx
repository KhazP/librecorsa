"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Button } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import {
  APP_RELEASE,
  PLATFORM_DOWNLOADS,
  artifactHref,
  detectVisitorPlatform,
  formatDownloadSize,
  orderPlatformsForVisitor,
  platformIdOf,
  type DetectedPlatform,
  type DownloadArtifact,
  type PlatformDownload,
} from "@/lib/downloads";
import { useStoreBuild } from "@/lib/use-store-build";
import { day } from "./home-data";
import { TEXT_LINK } from "./SitePage";

interface NavigatorUAData {
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; platform?: string }>;
}

const APP_HIGHLIGHTS: readonly [string, string][] = [
  [
    "Desktop",
    "Requests the discrete GPU on multi-GPU laptops, grants WebHID silently for racing wheels and DualSense, disables background throttling, and checks GitHub Releases for updates.",
  ],
  [
    "Android",
    "Fullscreen Trusted Web Activity with no browser URL bar, sticky-immersive edge swipes, Android Game Mode, and Drive / Boards launcher shortcuts.",
  ],
  [
    "Always current",
    "Every wrapper opens librecorsa.org directly instead of bundling tracks or cars, so physics, circuits and multiplayer updates arrive immediately.",
  ],
  [
    "Browser & iOS",
    "Nothing to install if you prefer playing straight in a tab. On iPhone and iPad, use Safari's Share > Add to Home Screen.",
  ],
];

function orderedArtifacts(platform: PlatformDownload, detected: DetectedPlatform): readonly DownloadArtifact[] {
  if (platform.id !== "macos" || detected !== "macos-x64") return platform.artifacts;
  return [...platform.artifacts].reverse();
}

export const HomeDownloads: React.FC<{ variant: "hub" | "page" }> = ({ variant }) => {
  const [detected, setDetected] = useState<DetectedPlatform>(null);
  const storeBuild = useStoreBuild();

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as Navigator & { userAgentData?: NavigatorUAData };
    const ua = nav.userAgent ?? "";
    const uaPlatform = nav.userAgentData?.platform;

    setDetected(detectVisitorPlatform(ua, uaPlatform));

    if (nav.userAgentData?.getHighEntropyValues) {
      nav.userAgentData
        .getHighEntropyValues(["architecture", "platform"])
        .then((values) => {
          if (cancelled) return;
          setDetected(detectVisitorPlatform(ua, values.platform ?? uaPlatform, values.architecture));
        })
        .catch(() => {
          // Low-entropy UA detection above remains in place
        });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  const platforms = useMemo(() => orderPlatformsForVisitor(PLATFORM_DOWNLOADS, detected), [detected]);
  const matchedPlatformId = platformIdOf(detected);

  return (
    <div className="flex flex-col gap-10">
      {variant === "hub" ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pt-1">
          <p className="lc-body m-0 max-w-[66ch] text-[15px] text-lc-fog">
            Optional native wrappers for Windows, macOS, Linux and Android. They open librecorsa.org directly, so game updates
            arrive without reinstalling.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
            <span className="lc-mono text-lc-slate">
              v{APP_RELEASE.version} <span aria-hidden>·</span> {day(APP_RELEASE.date)}
            </span>
            <Link href="/download" onPointerEnter={focusOnHover} className={`inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
              Direct link
            </Link>
            <a
              href={APP_RELEASE.allReleasesUrl}
              target="_blank"
              rel="noopener"
              onPointerEnter={focusOnHover}
              className={`inline-flex items-center gap-1 pointer-coarse:min-h-11 ${TEXT_LINK}`}
            >
              GitHub Releases
              <Icon name="externalLink" size="xs" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className={variant === "page" ? "lc-h2" : "sr-only"}>
          Platforms
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          {platforms.map((platform, platformIdx) => {
            const isMatch = matchedPlatformId === platform.id;
            const artifacts = orderedArtifacts(platform, detected);
            return (
              <article
                key={platform.id}
                className={`flex min-w-0 flex-col gap-4 rounded-lc-card border bg-lc-carbon p-5 sm:p-6 ${
                  isMatch ? "border-lc-keyline" : "border-lc-line"
                }`}
              >
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="lc-h3 m-0">{platform.name}</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isMatch ? (
                      <Badge tone="info" size="sm">
                        This device
                      </Badge>
                    ) : null}
                    {platform.id === "android" && storeBuild ? (
                      <Badge tone="good" size="sm" icon="check">
                        Installed
                      </Badge>
                    ) : null}
                    <Badge tone={platform.signed ? "good" : "neutral"} size="sm">
                      {platform.statusLabel}
                    </Badge>
                  </div>
                </header>

                <p className="lc-body m-0">{platform.summary}</p>

                <footer className="mt-auto flex flex-col gap-3 pt-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    {artifacts.map((artifact, artifactIdx) => {
                      const href = artifactHref(artifact);
                      const size = formatDownloadSize(artifact.sizeBytes);
                      const isDirect = artifact.file !== null;
                      const isNavDefault = variant === "hub" && platformIdx === 0 && artifactIdx === 0;
                      const buttonLabel = isDirect ? artifact.label : "GitHub Releases";
                      const ariaLabel = isDirect
                        ? `${buttonLabel} — ${platform.name} (${artifact.detail}${size ? `, ${size}` : ""})`
                        : `${buttonLabel} — ${platform.name} (${artifact.detail})`;

                      return (
                        <Button
                          key={artifact.id}
                          href={href}
                          download={isDirect ? "" : undefined}
                          target={isDirect ? undefined : "_blank"}
                          rel={isDirect ? undefined : "noopener"}
                          variant="secondary"
                          size="md"
                          icon={<Icon name={isDirect ? "download" : "externalLink"} />}
                          aria-label={ariaLabel}
                          data-nav-default={isNavDefault ? "" : undefined}
                        >
                          {buttonLabel}
                        </Button>
                      );
                    })}
                  </div>

                  <p className="lc-mono m-0 text-[12px] text-lc-slate">
                    {artifacts.map((artifact, i) => {
                      const size = formatDownloadSize(artifact.sizeBytes);
                      const part = size ? `${artifact.detail}, ${size}` : `${artifact.detail} (published on the next release tag)`;
                      return (
                        <React.Fragment key={artifact.id}>
                          {i > 0 ? <span aria-hidden> · </span> : null}
                          {part}
                        </React.Fragment>
                      );
                    })}
                  </p>

                  <p className="lc-hint m-0">{platform.installNote}</p>

                  {platform.installCommand ? (
                    <pre
                      role="region"
                      aria-label={`${platform.name} install command`}
                      tabIndex={0}
                      className="m-0 overflow-x-auto rounded-lc-nub border border-lc-line bg-lc-well px-3 py-2"
                    >
                      <code className="lc-mono text-[12px] text-lc-fog">{platform.installCommand}</code>
                    </pre>
                  ) : null}
                </footer>
              </article>
            );
          })}
        </div>
      </section>

      <div className="grid gap-x-16 gap-y-10 border-t border-lc-line pt-8 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="lc-h2">
            Why install the app
          </h2>
          <dl className="m-0 flex flex-col">
            {APP_HIGHLIGHTS.map(([label, text]) => (
              <div
                key={label}
                className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-5 border-t border-lc-line py-3.5 max-sm:grid-cols-1 max-sm:gap-y-1"
              >
                <dt className="lc-lbl pt-0.5">{label}</dt>
                <dd className="lc-body m-0 text-[15px] text-lc-chalk">{text}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="flex min-w-0 flex-col gap-4">
          <h2 className="lc-h2">
            Builds & signing
          </h2>
          <p className="lc-body m-0 max-w-[60ch] text-[15px] leading-[1.6]">
            All installers and APKs are built from this repository’s source by GitHub Actions and published on GitHub Releases
            with SHA-256 digests. Free Windows code signing through SignPath Foundation is being set up; macOS builds are
            currently unsigned; the Android APK is signed with the upload key verified by{" "}
            <code className="lc-mono text-[13px] text-lc-chalk">.well-known/assetlinks.json</code>.
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1 text-[14px]">
            {[
              ["All releases on GitHub", APP_RELEASE.allReleasesUrl],
              ["Code signing policy", APP_RELEASE.codeSigningPolicyUrl],
            ].map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener"
                onPointerEnter={focusOnHover}
                className={`inline-flex items-center gap-1 pointer-coarse:min-h-11 ${TEXT_LINK}`}
              >
                {label}
                <Icon name="externalLink" size="xs" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
