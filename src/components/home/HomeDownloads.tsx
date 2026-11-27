"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "use-intl/react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Button } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { cx } from "@/components/ui/styles";
import {
  PLATFORM_DOWNLOADS,
  RELEASE_LINKS,
  artifactHref,
  buttonArtifacts,
  detectVisitorPlatform,
  formatDownloadSize,
  isDirectDownload,
  orderPlatformsForVisitor,
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

function orderedArtifacts(platform: PlatformDownload, detected: DetectedPlatform): readonly DownloadArtifact[] {
  if (platform.id !== "macos" || detected !== "macos-x64") return platform.artifacts;
  return [...platform.artifacts].reverse();
}

/**
 * The apps' downloads as one list, a row per platform with the visitor's first: its files' buttons, and once the release
 * is out its version, date, sizes and how to install it. A release that isn't out yet says so and links nowhere (the
 * releases page would hand out an older app). On the home page's Download tab and the /download page.
 */
export const HomeDownloads: React.FC<{ variant: "hub" | "page" }> = ({ variant }) => {
  const tx = useTranslations("home.downloads");
  const tc = useTranslations("common");
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
  // On the home tab the pad starts on the first download button there is
  const navDefaultId =
    variant === "hub" ? platforms.find((p) => p.release.published && !(p.id === "android" && storeBuild))?.id : undefined;

  return (
    <div className="flex flex-col gap-8">
      {variant === "hub" ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pt-1">
          <p className="lc-body m-0 max-w-[66ch] text-[15px] text-lc-fog">{tx("introApps")}</p>
          <Link href="/download" onPointerEnter={focusOnHover} className={`inline-flex items-center text-[13px] pointer-coarse:min-h-11 ${TEXT_LINK}`}>
            {tx("directLink")}
          </Link>
        </div>
      ) : null}

      <section className="flex flex-col">
        <h2 className="sr-only">{tx("platforms")}</h2>
        <ul className="m-0 flex list-none flex-col p-0">
          {platforms.map((platform) => {
            const artifacts = orderedArtifacts(platform, detected);
            const { release } = platform;
            const out = release.published;
            const files = artifacts
              .map((a) => {
                const size = isDirectDownload(a, release) ? formatDownloadSize(a.sizeBytes) : null;
                return size ? tx("detailSized", { detail: a.detail, size }) : a.detail;
              })
              .join(" · ");
            return (
              <li
                key={platform.id}
                className={cx(
                  "grid gap-x-10 gap-y-3 border-t border-lc-line py-6 last:border-b",
                  // Not out yet: its name and "Coming soon" on one line, at every width. Out: the buttons under the version
                  // line on a phone, on the right of the row from md, with how to install it under them / beside them
                  out ? "md:grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto] items-baseline",
                )}
              >
                <div className="flex min-w-0 flex-col gap-2 md:col-start-1 md:row-start-1">
                  <h3 className="lc-h3 m-0">{platform.name}</h3>
                  {out ? (
                    <p className="lc-mono m-0 text-[12px] text-lc-slate">
                      {/* The version and the (English) date read left to right on an Arabic page too */}
                      <span dir="ltr">
                        v{release.version}
                        {release.date ? (
                          <>
                            <span aria-hidden> · </span>
                            {day(release.date)}
                          </>
                        ) : null}
                      </span>
                      <span aria-hidden> · </span>
                      {files}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2.5 md:col-start-2 md:row-span-2 md:row-start-1 md:justify-end md:self-start">
                  {platform.id === "android" && storeBuild ? (
                    <Badge tone="good" size="sm" icon="check">
                      {tx("installed")}
                    </Badge>
                  ) : out ? (
                    buttonArtifacts(artifacts, release).map(({ artifact, details }, i) => {
                      const isDirect = isDirectDownload(artifact, release);
                      const size = formatDownloadSize(artifact.sizeBytes);
                      const label = isDirect ? artifact.label : "GitHub Releases";
                      return (
                        <Button
                          key={artifact.id}
                          href={artifactHref(artifact, release)}
                          download={isDirect ? "" : undefined}
                          target={isDirect ? undefined : "_blank"}
                          rel={isDirect ? undefined : "noopener"}
                          variant="secondary"
                          size="md"
                          icon={<Icon name={isDirect ? "download" : "externalLink"} />}
                          aria-label={
                            isDirect && size
                              ? tx("artifactSized", { label, platform: platform.name, detail: artifact.detail, size })
                              : tx("artifact", { label, platform: platform.name, detail: details })
                          }
                          data-nav-default={navDefaultId === platform.id && i === 0 ? "" : undefined}
                        >
                          {label}
                        </Button>
                      );
                    })
                  ) : (
                    <span className="lc-hint">{tx("comingSoon")}</span>
                  )}
                </div>

                {out ? (
                  <div className="flex min-w-0 flex-col gap-2 md:col-start-1 md:row-start-2">
                    {platform.id === "android" && storeBuild ? null : (
                      <p className="lc-hint m-0 max-w-[68ch]">{platform.installNote}</p>
                    )}
                    {platform.installCommand ? (
                      <pre
                        role="region"
                        aria-label={tx("installCommand", { platform: platform.name })}
                        tabIndex={0}
                        className="m-0 max-w-[68ch] overflow-x-auto rounded-lc-nub border border-lc-line bg-lc-well px-3 py-2"
                      >
                        <code className="lc-mono text-[12px] text-lc-fog">{platform.installCommand}</code>
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="flex flex-wrap gap-x-6 gap-y-3 text-[14px]">
        {[
          [tx("allReleases"), RELEASE_LINKS.allReleasesUrl],
          [tx("signingPolicy"), RELEASE_LINKS.codeSigningPolicyUrl],
          [tx("appGuide"), RELEASE_LINKS.appGuideUrl],
        ].map(([label, href]) => (
          <a
            key={href}
            href={href}
            target="_blank"
            rel="noopener"
            onPointerEnter={focusOnHover}
            className={`inline-flex items-center gap-1 pointer-coarse:min-h-11 ${TEXT_LINK}`}
          >
            {label}
            <Icon name="externalLink" size="xs" />
            <span className="sr-only"> {tc("newTab")}</span>
          </a>
        ))}
      </div>
    </div>
  );
};
