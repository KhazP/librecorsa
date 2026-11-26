// docs.librecorsa.org: Starlight over the Markdown in ../docs (copied in by scripts/sync-docs.mjs; see pages.mjs).
// `npm run build` writes ./dist, which the librecorsa-docs Worker serves (wrangler.jsonc).
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { PAGES } from "./pages.mjs";

const page = ({ slug }) => slug;
const groups = [...new Set(PAGES.flatMap((p) => (p.group ? [p.group] : [])))];

export default defineConfig({
  site: "https://docs.librecorsa.org",
  integrations: [
    starlight({
      title: "LibreCorsa docs",
      description:
        "Documentation for LibreCorsa: controls and wheels, driving and setups, triple screens, online racing, telemetry, downloads, modding, porting, translating, physics validation, and race AI.",
      logo: {
        dark: "./src/assets/brand/librecorsa-logo.svg",
        light: "./src/assets/brand/librecorsa-logo-on-light.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#08090d", media: "(prefers-color-scheme: dark)" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" } },
        { tag: "meta", attrs: { property: "og:image", content: "https://docs.librecorsa.org/opengraph-image.jpg" } },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        { tag: "meta", attrs: { property: "og:image:alt", content: "LibreCorsa racing simulator" } },
        { tag: "meta", attrs: { name: "twitter:image", content: "https://docs.librecorsa.org/opengraph-image.jpg" } },
      ],
      social: [{ icon: "github", label: "Source on GitHub", href: "https://github.com/librecorsa/librecorsa" }],
      sidebar: [
        { label: "Play LibreCorsa", link: "https://librecorsa.org/play" },
        { label: "Overview", link: "/" },
        ...PAGES.filter((p) => p.slug && !p.group).map(page),
        ...groups.map((label) => ({ label, items: PAGES.filter((p) => p.group === label).map(page) })),
      ],
      customCss: ["@fontsource-variable/geist", "@fontsource-variable/geist-mono", "./src/styles/theme.css"],
      lastUpdated: false,
      credits: false,
    }),
  ],
});
