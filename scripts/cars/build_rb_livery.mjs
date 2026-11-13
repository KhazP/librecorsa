/**
 * Builds the decal atlas of the 2026 Prototype's Oracle Red Bull Racing livery from an Assetto Corsa skin of it
 * (the `car-body.dds` of a "RB22" skin made for VRC's Formula Alpha 2026):
 *
 *   node scripts/cars/build_rb_livery.mjs <skin folder> [out folder]
 *
 * Its texture is laid out for that car's own UVs, which this body doesn't have, so the pictures are cut out of it one
 * by one (bulls, wordmarks, the number), keyed off the navy paint (the livery's own navy shows through), turned level
 * and packed into `public/cars/f12026/liveries/oracle_red_bull/decals.png`. `decals.json` beside it lists each
 * picture's rectangle (x, y, width, height, 0-1 from the top left) and aspect; the livery's placements in
 * `src/lib/track-data.ts` use them.
 */
import { mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const W = 9216;
const H = 3072;
const ATLAS = 2048;

/**
 * name: `box` [x0, y0, x1, y1] in the skin's texture (px); `level` turns it level (deg, clockwise); `noYellow` keys out
 * the yellow nose behind it; `erase` boxes clear neighbouring lettering
 */
const CUTS = {
  // The lower of the two nose bulls (the upper one is mirrored)
  bull: { box: [3690, 1560, 4110, 1820], noYellow: true, erase: [[3940, 1560, 4110, 1602]] },
  number: { box: [4510, 1410, 4770, 1680] },
  oracle: { box: [5660, 2560, 6700, 2940], level: -14.7 },
  redbull: { box: [6690, 2480, 7230, 2710], level: -6.6 },
};

/** The skin's navy and its pattern go transparent; colour (yellow, red, white) stays, yellow too unless `noYellow` */
function key(px, noYellow) {
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    let a = Math.min(1, Math.max(0, (Math.max(r, g) - 0.16) / 0.16));
    if (noYellow && g > 0.3 && b < 0.25 && g > 0.55 * r) a = 0;
    px[i + 3] = Math.round(a * 255);
  }
}

async function main() {
  const [skin, outArg] = process.argv.slice(2);
  if (!skin) {
    console.error("usage: node scripts/cars/build_rb_livery.mjs <skin folder> [out folder]");
    process.exit(1);
  }
  const out = outArg ?? path.join(ROOT, "public/cars/f12026/liveries/oracle_red_bull");
  mkdirSync(out, { recursive: true });
  // Uncompressed RGBA8 with mips: the top level follows the 128-byte header
  const fd = openSync(path.join(skin, "car-body.dds"), "r");
  const tex = Buffer.alloc(W * H * 4);
  readSync(fd, tex, 0, tex.length, 128);

  const pics = [];
  for (const [name, { box, level, noYellow, erase = [] }] of Object.entries(CUTS)) {
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    const h = y1 - y0;
    const px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) tex.copy(px, y * w * 4, ((y0 + y) * W + x0) * 4, ((y0 + y) * W + x1) * 4);
    key(px, noYellow);
    for (const [ex0, ey0, ex1, ey1] of erase) {
      for (let y = ey0 - y0; y < ey1 - y0; y++) for (let x = ex0 - x0; x < ex1 - x0; x++) px[(y * w + x) * 4 + 3] = 0;
    }
    let img = sharp(px, { raw: { width: w, height: h, channels: 4 } });
    if (level) img = sharp(await img.rotate(level, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer());
    const trimmed = await img.trim().png().toBuffer({ resolveWithObject: true });
    pics.push({ name, buf: trimmed.data, w: trimmed.info.width, h: trimmed.info.height });
  }

  // Shelf packing, tallest first, 8 px apart
  pics.sort((a, b) => b.h - a.h);
  let x = 0;
  let y = 0;
  let row = 0;
  const pad = 8;
  for (const p of pics) {
    if (x + p.w > ATLAS) {
      x = 0;
      y += row + pad;
      row = 0;
    }
    p.x = x;
    p.y = y;
    x += p.w + pad;
    row = Math.max(row, p.h);
  }
  // As tall as the rows need
  const height = Math.ceil((y + row) / 64) * 64;
  if (height > ATLAS) throw new Error("decals do not fit the atlas");
  await sharp({ create: { width: ATLAS, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(pics.map((p) => ({ input: p.buf, left: p.x, top: p.y })))
    .png({ compressionLevel: 9 })
    .toFile(path.join(out, "decals.png"));
  const rects = Object.fromEntries(
    pics.map((p) => [p.name, { rect: [p.x / ATLAS, p.y / height, p.w / ATLAS, p.h / height].map((v) => +v.toFixed(5)), aspect: +(p.w / p.h).toFixed(4) }])
  );
  writeFileSync(path.join(out, "decals.json"), JSON.stringify(rects, null, 2) + "\n");
  console.log(JSON.stringify(rects, null, 2));
}

await main();
