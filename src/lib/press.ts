/**
 * What has been written, filmed or discussed about LibreCorsa, for the press page (src/app/press/page.tsx).
 * Add an entry here and it shows up on librecorsa.org/press, newest first. Only list pages that are live and
 * actually mention LibreCorsa; the developer's own posts don't count as coverage.
 */

export type CoverageKind = "Article" | "Review" | "News" | "Newsletter" | "Blog" | "Video" | "Podcast" | "Listing";

/** Editorial coverage and videos by other people */
export interface CoverageItem {
  outlet: string;
  title: string;
  url: string;
  /** YYYY-MM-DD */
  date: string;
  kind: CoverageKind;
  /** Writer, host or channel, when shown */
  author?: string;
  /** Two-letter language code, when not English */
  lang?: string;
}

/** Smaller mentions by other people: social posts, threads, projects built on it */
export interface DiscussionItem {
  /** Platform and who, e.g. "X · Jeremy Morgan", "Hacker News" */
  where: string;
  title: string;
  url: string;
  /** YYYY-MM-DD */
  date: string;
  /** e.g. "312 points · 140 comments", as the site showed it when added */
  engagement?: string;
}

export const COVERAGE: CoverageItem[] = [
  {
    outlet: "simRacer.es",
    title: "LibreCorsa: el simulador gratis en navegador con físicas a 500 Hz, clima dinámico y Force Feedback",
    url: "https://simracer.es/librecorsa-el-simulador-gratis-en-navegador-con-fisicas-a-500-hz-clima-dinamico-y-force-feedback/",
    date: "2026-11-05",
    kind: "Article",
    lang: "es",
  },
  {
    outlet: "Tech Insider",
    title: "LibreCorsa: F1 Open Source nel Browser, 500 Hz",
    url: "https://tech-insider.org/it/librecorsa-f1-open-source-browser-500-hz-2026/",
    date: "2026-11-03",
    kind: "Article",
    author: "Lorenzo Ferrari",
    lang: "it",
  },
  {
    outlet: "Punto Informatico",
    title: "LibreCorsa: la F1 open source nel browser, senza download",
    url: "https://www.punto-informatico.it/librecorsa-corse-f1-browser-senza-download/",
    date: "2026-11-02",
    kind: "Article",
    author: "Davide Tommasi",
    lang: "it",
  },
  {
    outlet: "Q-Gin",
    title: "LibreCorsa, il simulatore di guida gratis nel browser: F1, GT3 e fisica a 500 Hz senza installare nulla",
    url: "https://www.q-gin.info/librecorsa-simulatore-guida-gratis-browser-f1-gt3/",
    date: "2026-11-02",
    kind: "Article",
    author: "Flavio Lavoratori",
    lang: "it",
  },
  {
    outlet: "Automoto.it",
    title: "L'anno di Le Mans Ultimate, LibreCorsa un sim nel browser, nuovo Asetek DD10 e Gran Turismo 7",
    url: "https://www.automoto.it/news/l-anno-di-le-mans-ultimate-librecorsa-un-sim-nel-browser-nuovo-asetek-dd10-e-gran-turismo-7.html",
    date: "2026-11-02",
    kind: "News",
    author: "Daniele Pascucci",
    lang: "it",
  },
  {
    outlet: "Computer Flash",
    title: "LibreCorsa porta le corse di F1 nel browser, senza download",
    url: "https://www.computerflash.net/librecorsa-porta-le-corse-di-f1-nel-browser-senza-download/",
    date: "2026-11-02",
    kind: "News",
    lang: "it",
  },
  {
    outlet: "SIGNAL news",
    title: "LibreCorsa, il simulatore di guida gratis che gira nel browser",
    url: "https://signalnews.it/articoli/librecorsa-simulatore-guida-browser-2026-11-01",
    date: "2026-11-01",
    kind: "Article",
    lang: "it",
  },
  {
    outlet: "Sim Racing Nation",
    title: "LibreCorsa Brings 500 Hz Sim Physics to Browsers",
    url: "https://www.simracingnation.com/articles/librecorsa-brings-500-hz-sim-physics-to-browsers-3847",
    date: "2026-11-01",
    kind: "News",
  },
  {
    outlet: "TuttoXAndroid",
    title: "LibreCorsa: il simulatore di guida open source nel browser",
    url: "https://www.tuttoxandroid.com/2026/11/librecorsa-il-simulatore-di-guida-open.html",
    date: "2026-11-01",
    kind: "Article",
    lang: "it",
  },
  {
    outlet: "Hardware Upgrade",
    title: "Da zero al tracciato in secondi: LibreCorsa gira in qualsiasi browser",
    url: "https://gaming.hwupgrade.it/news/videogames/da-zero-al-tracciato-in-secondi-librecorsa-gira-in-qualsiasi-browser_161375.html",
    date: "2026-10-31",
    kind: "Review",
    lang: "it",
  },
  {
    outlet: "Computer Flash",
    title: "Da zero al tracciato in secondi: LibreCorsa gira in qualsiasi browser",
    url: "https://www.computerflash.net/da-zero-al-tracciato-in-secondi-librecorsa-gira-in-qualsiasi-browser/",
    date: "2026-10-31",
    kind: "News",
    lang: "it",
  },
  {
    outlet: "SimRacing Underground",
    title: "LibreCorsa: un SIMULATORE nel browser, fatto con l'IA!",
    url: "https://www.youtube.com/watch?v=jb6DIh6-2wg",
    date: "2026-10-31",
    kind: "Video",
    lang: "it",
  },
  {
    outlet: "The Epoch Times Italia",
    title: "Simulatore di guida F1 creato con l'intelligenza artificiale",
    url: "https://www.epochtimes.it/simulatore-di-guida-f1-creato-con-lintelligenza-artificiale-256827.html",
    date: "2026-10-30",
    kind: "Review",
    author: "Lorenzo Tassi",
    lang: "it",
  },
  {
    outlet: "Automoto.it",
    title: "LibreCorsa: Simulatore gratis ed open source direttamente nel vostro browser",
    url: "https://www.automoto.it/news/librecorsa-simulatore-gratis-ed-open-source-direttamente-nel-vostro-browser.html",
    date: "2026-10-29",
    kind: "Review",
    author: "Daniele Pascucci",
    lang: "it",
  },
  {
    outlet: "Eventi e News",
    title: "LibreCorsa: Simulatore gratis ed open source direttamente nel vostro browser",
    url: "https://www.eventi.news/librecorsa-simulatore-gratis-ed-open-source-direttamente-nel-vostro-browser",
    date: "2026-10-29",
    kind: "News",
    lang: "it",
  },
  {
    outlet: "BoxThisLap",
    title: "LibreCorsa: Free Browser Racing Sim With 500 Hz Physics",
    url: "https://boxthislap.org/librecorsa-free-browser-racing-simulator/",
    date: "2026-10-29",
    kind: "Article",
    author: "Alberto C.",
  },
];

export const DISCUSSIONS: DiscussionItem[] = [
  {
    // A plain repost has no page of its own: this links the trailer post it shared
    where: "X · three.js",
    title: "The official three.js account reposted the LibreCorsa trailer",
    url: "https://x.com/alpyalay/status/2119537946831343645",
    date: "2026-11-08",
  },
  {
    where: "X · Rikype Racing",
    title: "Spanish post: a free browser sim with rain and force feedback, worth a try",
    url: "https://x.com/RikypeRacing/status/2119054303109525893",
    date: "2026-11-07",
  },
  {
    where: "X · Jeremy Morgan",
    title: "On the tyre model and wheel force feedback",
    url: "https://x.com/JeremyCMorgan/status/2117814413147160684",
    date: "2026-11-04",
  },
  {
    where: "GitHub · Game Night Access Adapter",
    title: "An accessibility hackathon project that lets players drive LibreCorsa by camera, voice or phone",
    url: "https://github.com/Isomkevin/game-night-access-adapter",
    date: "2026-11-03",
  },
];

/**
 * The press kit's screenshots, in the order the press page shows them: full size (2560 × 1440) in
 * public/press/screenshots/. After changing this list or a picture, `npm run press-kit` remakes the page's thumbnails
 * and the press kit ZIP.
 */
export const PRESS_SCREENSHOTS: { file: string; alt: string }[] = [
  { file: "monaco-hairpin.jpg", alt: "The field through the hairpin at Monaco" },
  { file: "rise-side-by-side.jpg", alt: "Side by side through a corner at RISE Motordrome, Rwanda" },
  { file: "rise-aerial.jpg", alt: "The field through the esses at RISE Motordrome, from above" },
  { file: "suzuka-ferris-wheel.jpg", alt: "Suzuka, with the Ferris wheel behind" },
  { file: "rise-onboard.jpg", alt: "Onboard in a race at RISE Motordrome, with the race HUD" },
  { file: "title-menu.jpg", alt: "The title menu" },
  { file: "silverstone-rain.jpg", alt: "Three cars through a wet corner at Silverstone" },
  { file: "suzuka-kerb.jpg", alt: "Riding the kerb at Suzuka" },
  { file: "monaco-harbour.jpg", alt: "The field along the harbour at Monaco, from above" },
  { file: "rise-grandstand.jpg", alt: "Three cars below the grandstand at RISE Motordrome" },
];

/** The press kit download: every screenshot plus the logos (made by `npm run press-kit`) */
export const PRESS_KIT_ZIP = "/press/librecorsa-press-kit.zip";

/**
 * RISE Motordrome's own kit: Cycles renders of the Blender model the game's circuit is built from, in public/press/rise/.
 * `npm run press-kit` makes their thumbnails and the ZIP too.
 */
export const RISE_RENDERS: { file: string; alt: string; size: string }[] = [
  { file: "rise-main-straight.jpg", alt: "The field down the main straight", size: "2560 × 1440" },
  { file: "rise-close-up.jpg", alt: "The 2026 prototype in Visit Rwanda colours on the grid", size: "2560 × 1440" },
  { file: "rise-gt3-bowl.jpg", alt: "Two GT3 cars through The Bowl", size: "2560 × 1440" },
  { file: "rise-esses.jpg", alt: "Open-wheelers through the Kidogo Esses", size: "2560 × 1440" },
  { file: "rise-layout.jpg", alt: "The whole circuit from above", size: "2560 × 1440" },
  { file: "rise-aerial.jpg", alt: "The circuit and Lake Kidogo from the air", size: "3072 × 2048" },
];

export const RISE_PRESS_KIT_ZIP = "/press/rise/rise-motordrome-press-kit.zip";

/** The official design render the aerial is set up to match, shown beside it on the press page (not in the ZIP) */
export const RISE_OFFICIAL_RENDER = "/press/rise/official-render.jpg";

const newestFirst =<T extends { date: string }>(items: T[]) => [...items].sort((a, b) => b.date.localeCompare(a.date));

export const coverage = () => newestFirst(COVERAGE);
export const discussions = () => newestFirst(DISCUSSIONS);
