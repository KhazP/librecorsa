/**
 * Renders scenic golden-hour (or floodlit night) Drive-tile hero stills for every venue:
 *   `npm run venue-heroes [-- <venueId> ...]`
 *
 * Mirrors `scripts/render-car-thumbs.ts`: bundles `scripts/venue-heroes/render.ts`, serves it next to `public/`,
 * renders each venue's primary layout once in headless Chrome with LibreCorsa's desktop-High renderer (no cars on
 * track), and writes responsive WebPs beside each venue's track folder:
 * - `public/tracks/<venueId>/hero-1600.webp` (1600 x 900)
 * - `public/tracks/<venueId>/hero-960.webp`  (960 x 540)
 *
 * RISE Motordrome (`rwanda_official_short`) is committed to the repository; hosted circuits are gitignored and
 * uploaded to R2 via `npm run upload-hosted`.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";
import type { HeroShotInfo } from "./venue-heroes/render";

const ROOT = process.cwd();
const PUBLIC = join(ROOT, "public");
const WIDTHS = [
  { w: 1600, h: 900, quality: 84 },
  { w: 960, h: 540, quality: 82 },
] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
};

interface TrackIndexEntry {
  id: string;
  name: string;
  country: string;
  defaultTimeOfDay?: string;
  unlisted?: boolean;
}

function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(process.env.VENUE_HEROES_CHROME ? { executablePath: process.env.VENUE_HEROES_CHROME } : { channel: "chrome" }),
    args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
}

function uniqueVenues(): TrackIndexEntry[] {
  const index = JSON.parse(readFileSync(join(PUBLIC, "tracks/index.json"), "utf8")) as TrackIndexEntry[];
  const seen = new Set<string>();
  const venues: TrackIndexEntry[] = [];
  for (const t of index) {
    const key = `${t.name}::${t.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    venues.push(t);
  }
  return venues;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const venues = uniqueVenues().filter((v) => !only.length || only.includes(v.id));
  if (!venues.length) {
    console.error(`No matching venues for: ${only.join(", ")}`);
    process.exit(1);
  }

  const work = mkdtempSync(join(tmpdir(), "venue-heroes-"));
  await build({
    entryPoints: [join(ROOT, "scripts/venue-heroes/render.ts")],
    bundle: true,
    format: "esm",
    outfile: join(work, "render.js"),
    tsconfig: join(ROOT, "tsconfig.json"),
    define: {
      "process.env.NEXT_PUBLIC_BASE_PATH": '""',
      "process.env.NEXT_PUBLIC_HOSTED_CONTENT": '"1"',
      "process.env.NODE_ENV": '"production"',
    },
    logLevel: "warning",
  });
  writeFileSync(
    join(work, "index.html"),
    '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#090b10;overflow:hidden"><script type="module" src="/__venue-heroes/render.js"></script>',
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const file = url.pathname.startsWith("/__venue-heroes/")
      ? join(work, url.pathname.slice("/__venue-heroes/".length) || "index.html")
      : normalize(join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(work) && !file.startsWith(PUBLIC)) return void res.writeHead(403).end();
    if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  let browser = await launchBrowser();
  let shotsInBrowser = 0;
  let failed = 0;
  let rendered = 0;

  try {
    for (const venue of venues) {
      const dataFile = join(PUBLIC, "tracks", venue.id, "track_data.json");
      if (!existsSync(dataFile)) {
        console.log(`  SKIP  ${venue.id}: no public/tracks/${venue.id}/track_data.json`);
        continue;
      }

      // Fresh Chrome per venue guarantees zero WebGL/VRAM carryover between 20-50 MB track GLBs
      if (!browser.isConnected() || shotsInBrowser >= 1) {
        await browser.close().catch(() => {});
        browser = await launchBrowser();
        shotsInBrowser = 0;
      }

      const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("crash", () => errors.push("renderer crashed"));
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      try {
        const qs = new URLSearchParams({ track: venue.id });
        if (venue.defaultTimeOfDay) qs.set("tod", venue.defaultTimeOfDay);
        await page.goto(`http://127.0.0.1:${port}/__venue-heroes/?${qs.toString()}`);

        const ready = await page
          .waitForFunction(() => (window.__heroReady ? "ready" : window.__heroError ? `error:${window.__heroError}` : null), undefined, {
            timeout: 150_000,
          })
          .then((h) => h.jsonValue() as Promise<string>)
          .catch((e: unknown) => `error:${e instanceof Error ? e.message : String(e)}`);

        if (ready.startsWith("error:")) {
          throw new Error(ready.slice(6));
        }

        const info = (await page.evaluate(() => window.__heroInfo)) as HeroShotInfo | undefined;
        const png = await page.screenshot({ type: "png" });
        shotsInBrowser++;

        const outDir = join(PUBLIC, "tracks", venue.id);
        mkdirSync(outDir, { recursive: true });
        const sizes: string[] = [];
        for (const spec of WIDTHS) {
          const webp = await sharp(png)
            .resize(spec.w, spec.h, { fit: "cover" })
            .webp({ quality: spec.quality, effort: 5 })
            .toBuffer();
          const outFile = join(outDir, `hero-${spec.w}.webp`);
          writeFileSync(outFile, webp);
          sizes.push(`${spec.w}w:${(webp.length / 1024).toFixed(0)}KB`);
        }

        rendered++;
        const meta = info
          ? `${info.source} u=${info.uFrac} side=${info.side} off=${info.offsetM}m h=${info.heightM}m look=${info.lookAheadM}m sun=${info.sunAzimuthDeg}°/${info.sunElevationDeg}° sky=${info.physicalSkyReady ? "phys" : "classic"}`
          : "";
        console.log(`  ok    ${venue.id.padEnd(22)} ${sizes.join(" ")}  (${meta})`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  FAIL  ${venue.id}: ${msg}${errors.length ? ` [${errors[0]}]` : ""}`);
        failed++;
      } finally {
        await page.evaluate(() => window.__heroDispose?.()).catch(() => {});
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`\n${rendered} venue(s) rendered, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
