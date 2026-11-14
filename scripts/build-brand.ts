/**
 * Writes every logo file from the one geometry (src/components/ui/logo/geometry.ts): `npm run brand`.
 *
 * public/branding/
 *   librecorsa-mark.svg          the emblem; switches to the small drawing below 32 px (favicon use)
 *   librecorsa-mark-mono.svg     the emblem in one colour (currentColor, black on its own); the manifest's monochrome icon
 *   librecorsa-logo.svg          full lock-up for dark backgrounds, wordmark and tagline as outlines
 *   librecorsa-logo-on-light.svg full lock-up for light backgrounds (LIBRE in void)
 *   librecorsa-logo-mono.svg     full lock-up in one colour
 *   icon-192.png, icon-512.png   "any" app icons: the emblem edge to edge on transparency
 *   icon-maskable-192.png, icon-maskable-512.png
 *                                full-bleed void square, emblem inside the 80 % safe circle
 *   apple-touch-icon.png         180 px, composed like the maskable icon (iOS rounds it and has no transparency)
 *   favicon-16.png, favicon-32.png the favicon's two small frames as PNG files
 * public/favicon.ico             16 and 32 px from the small emblem, 48 px from the full one
 *
 * Run it after changing the geometry. The wordmark and tagline outlines come from scripts/brand/outline-text.py.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import {
  EMBLEM_TIGHT_VIEWBOX,
  LOGO_COLORS,
} from "../src/components/ui/logo/geometry";
import {
  emblemMarkup,
  fullLockup,
  svgDoc,
  type EmblemDetail,
  type EmblemKind,
} from "./brand/svg";

const PUBLIC = join(process.cwd(), "public");
const BRANDING = join(PUBLIC, "branding");
const TITLE = "LibreCorsa";
/** The emblem's drawn extent in the tight view box, 118 units */
const TIGHT = Number(EMBLEM_TIGHT_VIEWBOX.split(" ")[2]);

const emblemSvg = (kind: EmblemKind, detail: EmblemDetail, px?: number) =>
  svgDoc(emblemMarkup(kind, detail), {
    viewBox: EMBLEM_TIGHT_VIEWBOX,
    width: px ?? TIGHT,
    title: TITLE,
    color: kind === "mono" ? "#000000" : undefined,
  });

const png = (svg: string) =>
  sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

/** The emblem drawn edge to edge at `px` */
const emblemPng = (detail: "full" | "small", px: number) =>
  png(emblemSvg("color", detail, px));

/**
 * A full-bleed void square with the emblem centred and scaled so its farthest drawn pixel stays inside the safe
 * circle (radius 40 % of the side), measured on the rendered emblem rather than assumed from the path.
 */
async function maskableIcon(size: number): Promise<Buffer> {
  const probe = 1024;
  const { data, info } = await sharp(await emblemPng("full", probe))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let far = 0;
  const c = (probe - 1) / 2;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3] > 0)
        far = Math.max(far, Math.hypot(x - c, y - c) + 0.5);
  const safe = size * 0.4 - 1;
  const px = Math.floor((probe * safe) / far);
  const emblem = await emblemPng("full", px);
  const offset = Math.round((size - px) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: LOGO_COLORS.void,
    },
  })
    .composite([{ input: emblem, left: offset, top: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** An ICO holding PNG images (the format Windows Vista introduced and every browser reads) */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(img.size >= 256 ? 0 : img.size, e); // width, 0 means 256
    header.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1); // height
    header.writeUInt8(0, e + 2); // palette size
    header.writeUInt8(0, e + 3); // reserved
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(img.data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

async function main(): Promise<void> {
  const written: string[] = [];
  const put = (path: string, data: string | Buffer) => {
    writeFileSync(path, data);
    written.push(
      `${path.replace(`${PUBLIC}/`, "public/")} (${(Buffer.byteLength(data) / 1024).toFixed(1)} KB)`,
    );
  };

  put(join(BRANDING, "librecorsa-mark.svg"), emblemSvg("color", "adaptive"));
  put(
    join(BRANDING, "librecorsa-mark-mono.svg"),
    emblemSvg("mono", "adaptive"),
  );

  for (const [tone, file] of [
    ["on-dark", "librecorsa-logo.svg"],
    ["on-light", "librecorsa-logo-on-light.svg"],
    ["mono", "librecorsa-logo-mono.svg"],
  ] as const) {
    const l = fullLockup(tone);
    put(
      join(BRANDING, file),
      svgDoc(l.inner, {
        viewBox: l.viewBox,
        title: TITLE,
        color: tone === "mono" ? "#000000" : undefined,
      }),
    );
  }

  for (const size of [192, 512]) {
    put(join(BRANDING, `icon-${size}.png`), await emblemPng("full", size));
    put(join(BRANDING, `icon-maskable-${size}.png`), await maskableIcon(size));
  }
  put(join(BRANDING, "apple-touch-icon.png"), await maskableIcon(180));

  const fav16 = await emblemPng("small", 16);
  const fav32 = await emblemPng("small", 32);
  put(
    join(PUBLIC, "favicon.ico"),
    ico([
      { size: 16, data: fav16 },
      { size: 32, data: fav32 },
      { size: 48, data: await emblemPng("full", 48) },
    ]),
  );
  // the same frames as PNG files, for the UI kit's comparison and for anything that wants a PNG favicon
  put(join(BRANDING, "favicon-16.png"), fav16);
  put(join(BRANDING, "favicon-32.png"), fav32);

  console.log(written.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
