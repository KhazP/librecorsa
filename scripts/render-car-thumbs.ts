/**
 * Renders pictures of every car (and every livery / mod skin) for the car browser:
 *   `npm run car-thumbs [-- --no-variants] [-- <car id> ...]`
 *
 * Bundles scripts/car-thumbs/render.ts, serves it next to `public/` (the cars' models load from their usual paths),
 * loads each car's GLB ONCE per batch in headless Chromium with the game's own rig code, switches liveries/skins in
 * place, and writes 480 x 270 transparent WebPs beside each car:
 * - Default car picture: `public/lc26/thumb.webp` or `public/cars/<folder>/thumb.webp`
 * - Per-livery pictures (`lc26`): `public/lc26/thumbs/<liveryId>.webp` (committed to the repository)
 * - Per-skin pictures (skinned ported cars): `public/cars/<folder>/thumbs/<skinId>.webp` (uploaded to R2 via `upload-hosted`)
 *
 * Cars whose model files this copy doesn't have are skipped.
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import type { CarId } from "../src/lib/cars/car-registry";
import type { ThumbRenderApi } from "./car-thumbs/render";

const ROOT = process.cwd();
const PUBLIC = join(ROOT, "public");
/** Recycle the WebGL page after this many skins so large mod packs (50-67 skins) never exhaust Chromium's GPU process */
const MAX_SKINS_PER_PAGE = 24;

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

async function encodeThumbWebp(dataUrl: string): Promise<Buffer> {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return sharp(png)
    .trim({ threshold: 1 })
    .resize(480, 270, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 82, alphaQuality: 90 })
    .toBuffer();
}

function saveThumb(relPath: string, webp: Buffer): void {
  const target = join(PUBLIC, relPath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, webp);
}

function launchBrowser(): Promise<Browser> {
  // The installed Google Chrome (real GPU, nothing to download); CAR_THUMBS_CHROME points at another Chromium
  return chromium.launch({
    headless: true,
    ...(process.env.CAR_THUMBS_CHROME ? { executablePath: process.env.CAR_THUMBS_CHROME } : { channel: "chrome" }),
    args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
}

async function openCarPage(browser: Browser, port: number, carId: CarId): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on("pageerror", (e) => console.log(`        ${carId} page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/__thumbs/?car=${encodeURIComponent(carId)}`);
  const ready = await page
    .waitForFunction(() => (window.__thumbReady ? "ready" : window.__thumbError ? `error:${window.__thumbError}` : null), undefined, {
      timeout: 120_000,
    })
    .then((h) => h.jsonValue() as Promise<string>)
    .catch((e: unknown) => `error:${e instanceof Error ? e.message : String(e)}`);
  if (ready.startsWith("error:")) {
    await page.close().catch(() => {});
    throw new Error(ready.slice(6));
  }
  return page;
}

async function closeCarPage(page: Page): Promise<void> {
  await page.evaluate(() => window.__thumbApi?.dispose()).catch(() => {});
  await page.close().catch(() => {});
}

async function main(): Promise<void> {
  // Every car, hosted ones too (a clone lists only its own): the registry reads this flag as it loads
  // (imported only now, after the flag: a static import would load the list before it is set)
  process.env.NEXT_PUBLIC_HOSTED_CONTENT = "1";
  const { CARS, carLiveryThumbUrl, carSkinThumbUrl, carTakesLivery, carThumbUrl } = await import("../src/lib/cars/car-registry");
  const { LIVERIES } = await import("../src/lib/track-data");

  /** Where a picture goes under public/ (the same path the car browser loads it from) */
  const toRel = (url: string) => url.replace(/^\//, "");

  const rawArgs = process.argv.slice(2);
  const includeVariants = !rawArgs.includes("--no-variants");
  const only = rawArgs.filter((a) => !a.startsWith("--"));
  const cars = CARS.filter((c) => !only.length || only.includes(c.id));

  const work = mkdtempSync(join(tmpdir(), "car-thumbs-"));
  await build({
    entryPoints: [join(ROOT, "scripts/car-thumbs/render.ts")],
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
    '<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent"><script type="module" src="/__thumbs/render.js"></script>',
  );

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const file = url.pathname.startsWith("/__thumbs/")
      ? join(work, url.pathname.slice("/__thumbs/".length) || "index.html")
      : normalize(join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(work) && !file.startsWith(PUBLIC)) return void res.writeHead(403).end();
    if (!existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  let browser = await launchBrowser();
  let shotsInBrowser = 0;
  const ensureFreshBrowser = async (upcomingShots: number) => {
    if (!browser.isConnected() || (shotsInBrowser > 0 && shotsInBrowser + upcomingShots > 60)) {
      await browser.close().catch(() => {});
      browser = await launchBrowser();
      shotsInBrowser = 0;
    }
  };

  const doneBase = new Set<string>();
  let failed = 0;
  let totalWritten = 0;
  try {
    for (const car of cars) {
      const baseOut = toRel(carThumbUrl(car.id));
      if (doneBase.has(baseOut)) continue;
      if (car.modelUrl && !existsSync(join(PUBLIC, car.modelUrl))) {
        console.log(`  SKIP  ${car.id}: no ${car.modelUrl} in this copy`);
        continue;
      }

      const upcoming = !includeVariants
        ? 1
        : carTakesLivery(car.id)
          ? LIVERIES.filter((l) => l.id !== "custom").length
          : Math.max(1, car.skins?.length ?? 1);
      await ensureFreshBrowser(upcoming);

      try {
        if (carTakesLivery(car.id)) {
          const liveries = LIVERIES.filter((l) => l.id !== "custom");
          const page = await openCarPage(browser, port, car.id);
          try {
            const first = liveries[0];
            const firstPng = await page.evaluate((id) => window.__thumbApi!.snapLivery(id), first.id);
            shotsInBrowser++;
            const firstWebp = await encodeThumbWebp(firstPng);
            saveThumb(baseOut, firstWebp);
            totalWritten++;
            doneBase.add(baseOut);
            console.log(`  ok    ${car.id} → public/${baseOut} (${(firstWebp.length / 1024).toFixed(1)} KB)`);

            if (includeVariants) {
              saveThumb(toRel(carLiveryThumbUrl(car.id, first.id)), firstWebp);
              totalWritten++;
              let totalKb = firstWebp.length / 1024;
              for (const liv of liveries.slice(1)) {
                const png = await page.evaluate((id) => window.__thumbApi!.snapLivery(id), liv.id);
                shotsInBrowser++;
                const webp = await encodeThumbWebp(png);
                saveThumb(toRel(carLiveryThumbUrl(car.id, liv.id)), webp);
                totalWritten++;
                totalKb += webp.length / 1024;
              }
              console.log(`  ok    ${car.id} liveries: ${liveries.length} thumbs → public/lc26/thumbs/ (${totalKb.toFixed(0)} KB total)`);
            }
          } finally {
            await closeCarPage(page);
          }
        } else if (car.skins?.length) {
          const skins = car.skins;
          let totalKb = 0;
          const totalToRender = includeVariants ? skins.length : 1;
          for (let offset = 0; offset < totalToRender; offset += MAX_SKINS_PER_PAGE) {
            const batch = skins.slice(offset, Math.min(offset + MAX_SKINS_PER_PAGE, totalToRender));
            await ensureFreshBrowser(batch.length);
            const page = await openCarPage(browser, port, car.id);
            try {
              for (let i = 0; i < batch.length; i++) {
                const skin = batch[i];
                const isFirst = offset === 0 && i === 0;
                const png = await page.evaluate((id) => window.__thumbApi!.snapSkin(id), skin.id);
                shotsInBrowser++;
                const webp = await encodeThumbWebp(png);
                if (isFirst) {
                  saveThumb(baseOut, webp);
                  totalWritten++;
                  doneBase.add(baseOut);
                  console.log(`  ok    ${car.id} → public/${baseOut} (${(webp.length / 1024).toFixed(1)} KB)`);
                }
                if (includeVariants) {
                  saveThumb(toRel(carSkinThumbUrl(car.id, skin.id)), webp);
                  totalWritten++;
                  totalKb += webp.length / 1024;
                }
              }
            } finally {
              await closeCarPage(page);
            }
          }
          if (includeVariants) {
            const dir = toRel(carSkinThumbUrl(car.id, skins[0].id)).replace(/\/[^/]+$/, "/");
            console.log(`  ok    ${car.id} skins: ${skins.length} thumbs → public/${dir} (${totalKb.toFixed(0)} KB total)`);
          }
        } else {
          const page = await openCarPage(browser, port, car.id);
          try {
            const png = await page.evaluate(() => window.__thumbApi!.snap());
            shotsInBrowser++;
            const webp = await encodeThumbWebp(png);
            saveThumb(baseOut, webp);
            totalWritten++;
            doneBase.add(baseOut);
            console.log(`  ok    ${car.id} → public/${baseOut} (${(webp.length / 1024).toFixed(1)} KB)`);
          } finally {
            await closeCarPage(page);
          }
        }
      } catch (err: unknown) {
        console.log(`  FAIL  ${car.id}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\nDone: ${totalWritten} thumbnail file(s) written${failed ? `, ${failed} failed` : ""}.`);
  if (failed) process.exit(1);
}

declare global {
  interface Window {
    __thumb?: string;
    __thumbReady?: boolean;
    __thumbApi?: ThumbRenderApi;
    __thumbError?: string;
  }
}

void main();
