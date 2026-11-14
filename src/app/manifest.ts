import type { MetadataRoute } from "next";
import { withBasePath } from "@/lib/base-path";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export const dynamic = "force-static";

/** The icons come from `npm run brand` (scripts/build-brand.ts) */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: withBasePath("/play"),
    scope: withBasePath("/"),
    display: "fullscreen",
    orientation: "landscape",
    // ui-allow: hex-in-style the browser reads the manifest, which cannot hold a CSS token (lc-void)
    background_color: "#08090D",
    // ui-allow: hex-in-style as above
    theme_color: "#08090D",
    categories: ["games", "sports"],
    icons: [
      { src: withBasePath("/branding/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: withBasePath("/branding/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: withBasePath("/branding/librecorsa-mark.svg"), sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: withBasePath("/branding/icon-maskable-192.png"), sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: withBasePath("/branding/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: withBasePath("/branding/librecorsa-mark-mono.svg"), sizes: "any", type: "image/svg+xml", purpose: "monochrome" },
    ],
  };
}
