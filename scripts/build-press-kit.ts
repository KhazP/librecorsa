/**
 * Remakes the press kit from the screenshots listed in src/lib/press.ts: `npm run press-kit`.
 *
 * Writes a 1024 × 576 WebP thumbnail of each screenshot for the press page (public/press/screenshots/thumbs/), and
 * public/press/librecorsa-press-kit.zip with the full-size screenshots and the logos.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { PRESS_KIT_ZIP, PRESS_SCREENSHOTS } from "../src/lib/press";

const PUBLIC = join(process.cwd(), "public");
const SHOTS = join(PUBLIC, "press/screenshots");
const THUMBS = join(SHOTS, "thumbs");
const LOGOS = ["branding/librecorsa-logo.svg", "branding/librecorsa-mark.svg", "branding/icon-512.png", "press/banner.png"];

async function main(): Promise<void> {
  const missing = PRESS_SCREENSHOTS.filter((s) => !existsSync(join(SHOTS, s.file))).map((s) => s.file);
  if (missing.length) throw new Error(`Missing from public/press/screenshots: ${missing.join(", ")}`);

  rmSync(THUMBS, { recursive: true, force: true });
  mkdirSync(THUMBS, { recursive: true });
  for (const s of PRESS_SCREENSHOTS) {
    await sharp(join(SHOTS, s.file))
      .resize(1024, 576, { fit: "cover" })
      .webp({ quality: 80 })
      .toFile(join(THUMBS, s.file.replace(/\.jpg$/, ".webp")));
  }

  const stage = mkdtempSync(join(tmpdir(), "press-kit-"));
  const kit = join(stage, "librecorsa-press-kit");
  mkdirSync(join(kit, "screenshots"), { recursive: true });
  mkdirSync(join(kit, "logos"), { recursive: true });
  for (const s of PRESS_SCREENSHOTS) copyFileSync(join(SHOTS, s.file), join(kit, "screenshots", s.file));
  for (const f of LOGOS) copyFileSync(join(PUBLIC, f), join(kit, "logos", f.split("/").pop()!));

  const zip = join(PUBLIC, PRESS_KIT_ZIP);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-r", "-X", "-q", zip, "librecorsa-press-kit"], { cwd: stage });
  rmSync(stage, { recursive: true, force: true });
  console.log(`${PRESS_SCREENSHOTS.length} thumbnails and ${PRESS_KIT_ZIP}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
