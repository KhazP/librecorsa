/**
 * Renders a picture of every car for the car browser: `npm run car-thumbs [-- <car id> ...]`.
 *
 * Bundles scripts/car-thumbs/render.ts, serves it next to `public/` (the cars' models load from their usual paths),
 * renders each car in headless Chromium with the game's own rig code and writes a 480 x 270 WebP beside the car:
 * `public/cars/<id>/thumb.webp` (the repository's 2026 prototype, which both repo cars drive: `public/amr26/thumb.webp`).
 * A hosted car's picture then goes up with it: `npm run upload-hosted -- public/cars/<id>/thumb.webp`.
 * Cars whose model files this copy doesn't have are skipped.
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import sharp from "sharp";
import type { CarId } from "../src/lib/cars/car-registry";

const ROOT = process.cwd();
const PUBLIC = join(ROOT, "public");


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

async function main(): Promise<void> {
  // Every car, hosted ones too (a clone lists only its own): the registry reads this flag as it loads
  // (imported only now, after the flag: a static import would load the list before it is set)
  process.env.NEXT_PUBLIC_HOSTED_CONTENT = "1";
  const { CARS, carThumbUrl } = await import("../src/lib/cars/car-registry");
  /** Where a car's picture goes under public/ (the same path the car browser loads it from) */
  const thumbPath = (id: CarId) => carThumbUrl(id).replace(/^\//, "");
  const only = process.argv.slice(2);
  const cars = CARS.filter((c) => !only.length || only.includes(c.id));
  const work = mkdtempSync(join(tmpdir(), "car-thumbs-"));
  await build({
    entryPoints: [join(ROOT, "scripts/car-thumbs/render.ts")],
    bundle: true,
    format: "esm",
    outfile: join(work, "render.js"),
    tsconfig: join(ROOT, "tsconfig.json"),
    define: { "process.env.NEXT_PUBLIC_BASE_PATH": '""', "process.env.NEXT_PUBLIC_HOSTED_CONTENT": '"1"', "process.env.NODE_ENV": '"production"' },
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

  // The installed Google Chrome (real GPU, nothing to download); CAR_THUMBS_CHROME points at another Chromium
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CAR_THUMBS_CHROME ? { executablePath: process.env.CAR_THUMBS_CHROME } : { channel: "chrome" }),
    args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"],
  });
  const done = new Set<string>();
  let failed = 0;
  try {
    for (const car of cars) {
      const out = thumbPath(car.id);
      if (done.has(out)) continue;
      if (car.modelUrl && !existsSync(join(PUBLIC, car.modelUrl))) {
        console.log(`  SKIP  ${car.id}: no ${car.modelUrl} in this copy`);
        continue;
      }
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      page.on("pageerror", (e) => console.log(`        ${car.id} page error: ${e.message}`));
      await page.goto(`http://127.0.0.1:${port}/__thumbs/?car=${encodeURIComponent(car.id as CarId)}`);
      const result = await page
        .waitForFunction(() => window.__thumb ?? (window.__thumbError ? `error:${window.__thumbError}` : null), undefined, { timeout: 120_000 })
        .then((h) => h.jsonValue() as Promise<string>)
        .catch((e: unknown) => `error:${e instanceof Error ? e.message : String(e)}`);
      await page.close();
      if (result.startsWith("error:")) {
        console.log(`  FAIL  ${car.id}: ${result.slice(6)}`);
        failed++;
        continue;
      }
      const png = Buffer.from(result.slice(result.indexOf(",") + 1), "base64");
      const target = join(PUBLIC, out);
      mkdirSync(join(target, ".."), { recursive: true });
      const webp = await sharp(png).trim({ threshold: 1 }).resize(480, 270, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82, alphaQuality: 90 }).toBuffer();
      writeFileSync(target, webp);
      done.add(out);
      console.log(`  ok    ${car.id} → public/${out} (${(webp.length / 1024).toFixed(1)} KB)`);
    }
  } finally {
    await browser.close();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

declare global {
  interface Window {
    __thumb?: string;
    __thumbError?: string;
  }
}

void main();
