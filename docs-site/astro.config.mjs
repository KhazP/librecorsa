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
      description: "How to port cars, circuits and wheels to LibreCorsa, and how its physics and race AI work.",
      logo: {
        dark: "./src/assets/brand/librecorsa-logo.svg",
        light: "./src/assets/brand/librecorsa-logo-on-light.svg",
        replacesTitle: true,
      },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "Source on GitHub", href: "https://github.com/librecorsa/librecorsa" }],
      sidebar: [
        { label: "Play LibreCorsa", link: "https://librecorsa.org/play" },
        ...PAGES.filter((p) => p.slug && !p.group).map(page),
        ...groups.map((label) => ({ label, items: PAGES.filter((p) => p.group === label).map(page) })),
      ],
      customCss: ["@fontsource-variable/geist", "@fontsource-variable/geist-mono", "./src/styles/theme.css"],
      lastUpdated: false,
      credits: false,
    }),
  ],
});
