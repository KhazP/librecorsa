// The published pages: repository file → page on docs.librecorsa.org, in sidebar order within each group.
// scripts/sync-docs.mjs builds them; astro.config.mjs lays out the sidebar from the same list.
export const PAGES = [
  { source: "docs/README.md", slug: "" },
  { source: "docs/FAQ.md", slug: "faq" },
  { source: "docs/CONTROLS.md", slug: "playing/controls", group: "Playing" },
  { source: "docs/DRIVING.md", slug: "playing/driving", group: "Playing" },
  { source: "docs/ONLINE.md", slug: "playing/online", group: "Playing" },
  { source: "docs/TELEMETRY.md", slug: "playing/telemetry", group: "Playing" },
  { source: "docs/PERFORMANCE.md", slug: "playing/performance", group: "Playing" },
  { source: "docs/DOWNLOADS.md", slug: "playing/downloads", group: "Playing" },
  { source: "docs/modding.md", slug: "modding", group: "Modding" },
  { source: "docs/importing-mods.md", slug: "modding/importing", group: "Modding" },
  { source: "docs/PORTING-CARS.md", slug: "porting/cars", group: "Porting" },
  { source: "docs/PORTING-TRACKS.md", slug: "porting/circuits", group: "Porting" },
  { source: "docs/PORTING-F1-MODS.md", slug: "porting/f1-mods", group: "Porting" },
  { source: "docs/PORTING-WHEELS.md", slug: "porting/wheels", group: "Porting" },
  { source: "docs/GET-INVOLVED.md", slug: "contributing/get-involved", group: "Contributing" },
  { source: "docs/TRANSLATING.md", slug: "contributing/translating", group: "Contributing" },
  { source: "docs/SELF-HOSTING.md", slug: "contributing/self-hosting", group: "Contributing" },
  { source: "docs/ARCHITECTURE.md", slug: "how-it-works/architecture", group: "How it works" },
  { source: "docs/physics/README.md", slug: "how-it-works/physics", group: "How it works" },
  { source: "docs/race-ai.md", slug: "how-it-works/race-ai", group: "How it works" },
];
