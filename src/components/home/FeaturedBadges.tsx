import React from "react";
import { useTranslations } from "use-intl/react";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { cx } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";

/*
 * The sites that featured LibreCorsa, as the badges they hand out (their dark versions, in their own colours). Plain
 * links; the pictures are served from this site, so opening About asks nothing of either site.
 */

// ui-allow: arbitrary-radius matches the third-party Product Hunt / Three.js Resources 250x54 badge spec
const BADGE = "relative inline-flex h-[54px] w-[250px] shrink-0 rounded-[10px] no-underline transition-opacity duration-200 hover:opacity-90";

/** Three.js Resources' mark, drawn in the text colour */
const ThreeJsResourcesMark = () => (
  <svg aria-hidden viewBox="0 0 333 375" fill="currentColor" className="h-7 w-auto shrink-0">
    <path d="M170.466 296.144L39.1112 370.654C21.5755 380.602 -0.152712 367.836 0.000808949 347.676L1.12386 200.085L170.466 296.144ZM180.657 290.362L180.6 290.395L1.55354 188.832L179.091 84.5215L180.657 290.362ZM319.234 166.591C336.617 176.804 336.425 202.004 318.889 211.951L190.615 284.714L189.134 90.1504L319.234 166.591ZM2.44905 26.0293C2.60262 5.86952 24.5214 -6.56507 41.9041 3.6475L169.452 78.587L1.29671 177.385L2.44905 26.0293Z" />
  </svg>
);

// The badges' own words stay as their sites hand them out; only what a screen reader adds is translated
export const FeaturedBadges: React.FC<{ className?: string }> = ({ className }) => {
  const tc = useTranslations("common");
  return (
    <div className={cx("flex flex-wrap gap-3", className)}>
      <a
        href="https://threejsresources.com/tool/librecorsa?ref=badge"
        target="_blank"
        rel="noopener noreferrer"
        onPointerEnter={focusOnHover}
        // ui-allow: hex-in-class third-party Three.js Resources badge border colour
        className={cx(BADGE, "items-center gap-3 border border-[#333] bg-black px-4 text-white")}
      >
        <ThreeJsResourcesMark />
        <span className="flex flex-col gap-0.5 leading-none">
          <span className="text-[11px] font-medium text-white/70">Featured on</span>
          <span className="text-[18px] font-bold">Three.js Resources</span>
        </span>
        <span className="sr-only">{tc("newTab")}</span>
      </a>
      <a
        href="https://www.producthunt.com/products/librecorsa?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-librecorsa"
        target="_blank"
        rel="noopener noreferrer"
        onPointerEnter={focusOnHover}
        className={BADGE}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={withBasePath("/press/featured/product-hunt-dark.svg")}
          alt="LibreCorsa - Free, open-source 500 Hz racing sim in a browser tab | Product Hunt"
          width={250}
          height={54}
          loading="lazy"
        />
        <span className="sr-only">{tc("newTab")}</span>
      </a>
    </div>
  );
};
