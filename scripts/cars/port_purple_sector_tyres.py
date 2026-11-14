#!/usr/bin/env python3
"""
Port Purple Sector's "2025 Pirelli tyres" (OverTake) into the tyre wraps the 2026 car's tyre shader reads
(`src/lib/render/tyre-wrap.ts`). Used with the author's permission; see CREDITS.md.

The pack's compound textures are 4096 x 1024 strips: u runs once round the tyre, rows cross it from the outer bead
(row 0) over the outer sidewall, the tread (rows ~195-832) and the inner sidewall to the inner bead. The five
compounds are the same picture except for the printed art of the outer sidewall (rows ~81-179: the stripe, PIRELLI,
P ZERO or Cinturato), and the intermediate, which has its own tread.

So the art is split from the rubber. Two strips of one family differ only where the art is printed, by the art's
coverage times the difference of their two colours, which gives the coverage exactly (the chalk marks and the rubber
cancel). The rubber under the art is what is left once the art is taken out. The shader then prints the art back in
the compound's colour:
  <out>/pirelli-2025-ps-slick.webp          the rubber and its marks (sRGB): the slicks, and the pack's wet, which
                                            has the slick's tread
  <out>/pirelli-2025-ps-intermediate.webp   the same with the intermediate's tread
  <out>/pirelli-2025-ps-art.webp            the art's coverage, rows ART_BAND of the strip only, lossless:
                                            R = P ZERO (soft, medium, hard), G = Cinturato (intermediate, wet)

Painted out, filled from clean rubber of the same strip: the maker's lines moulded into both sidewalls, and the
handwritten team mark with its barcode sticker on both sidewalls. The pack's normal maps and blurred (spinning)
textures are not used.

Run with:
  python3 -I scripts/cars/port_purple_sector_tyres.py "<pack>/tyre_textures" public/cars/shared/tyres

Dependencies: Python stdlib + numpy + Pillow (decodes DX10 BC7 DDS).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 4096, 1024  # the pack's strip size; the row and column constants below are in its pixels

# The rows the compounds' art is printed in (with a margin)
ART_TOP = 76
ART_BOTTOM = 184
# The rows the art texture holds (the shader's ART_V0 / ART_V1 in tyre-wrap.ts)
ART_BAND = (64, 192)
# The intermediate's own rows: everything between the sidewalls' art and marks
TREAD_TOP = 190
TREAD_BOTTOM = 836

# Paint-outs: (row0, row1, col0, col1, row shift, column shift) of the clean rubber each is filled from
PAINT_OUT = (
    (98, 182, 3562, 3830, 0, -2974),  # outer sidewall: handwritten mark and barcode sticker
    (838, 925, 266, 506, 0, 260),  # inner sidewall: the same
    (78, 99, 1175, 1535, -22, 0),  # outer sidewall: the maker's moulded line
    (920, 946, 2540, 2925, -28, 0),  # inner sidewall: the same
)
# Columns with nothing printed or moulded in any of the paint-outs' rows: the rubber's level per row is read here
CLEAN_COLS = slice(1700, 2300)
FEATHER = 5


def load(folder: Path, colour: str) -> np.ndarray:
    found = sorted(p for p in folder.glob(f"*_{colour}.dds"))
    if len(found) != 1:
        sys.exit(f"{folder}: expected one *_{colour}.dds, found {len(found)}")
    im = Image.open(found[0])
    im.load()
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    if a.shape[:2] != (H, W):
        sys.exit(f"{found[0]}: {a.shape[1]}x{a.shape[0]}, expected {W}x{H} (the row constants are for that size)")
    return a


def art_colour(strip: np.ndarray, other: np.ndarray) -> np.ndarray:
    """The art's full-coverage colour: the median of the pixels that differ most from the other compound's"""
    rows = slice(ART_TOP, ART_BOTTOM)
    diff = np.abs(strip[rows] - other[rows]).sum(-1)
    strong = diff >= np.percentile(diff[diff > 30], 90)
    return np.median(strip[rows][strong], axis=0)


def coverage(a: np.ndarray, b: np.ndarray, ca: np.ndarray, cb: np.ndarray) -> np.ndarray:
    """The art's coverage from two compounds of one family: (a - b) = m (ca - cb), least squares over the channels"""
    d = ca - cb
    m = ((a - b) @ d) / float(d @ d)
    m[:ART_TOP] = 0
    m[ART_BOTTOM:] = 0
    m = np.clip(m, 0.0, 1.0)
    m[m < 0.03] = 0.0  # BC7 noise
    return m.astype(np.float32)


def box_blur(img: np.ndarray, radius: int) -> np.ndarray:
    """Three box passes per axis (about a Gaussian); wraps along u, clamps across rows"""
    out = img.astype(np.float64)
    k = 2 * radius + 1
    for _ in range(3):
        padded = np.concatenate([out[:, -radius - 1 :], out, out[:, :radius]], axis=1)
        cs = np.cumsum(padded, axis=1)
        out = (cs[:, k:] - cs[:, :-k]) / k
        pad = ((radius + 1, radius), (0, 0)) + ((0, 0),) * (out.ndim - 2)
        cs = np.cumsum(np.pad(out, pad, mode="edge"), axis=0)
        out = (cs[k:] - cs[:-k]) / k
    return out.astype(np.float32)


def rubber_under(strip: np.ndarray, colour: np.ndarray, m: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The picture with the art taken out, and how far each pixel can be trusted (1 = no art there)"""
    keep = 1.0 - m
    under = (strip - m[..., None] * colour) / np.maximum(keep, 0.15)[..., None]
    return under, keep


def paint_out(img: np.ndarray, level: np.ndarray) -> None:
    """Fills each PAINT_OUT box from its clean source, moved to the box's own rubber level per row, feathered in"""
    for r0, r1, c0, c1, dr, dc in PAINT_OUT:
        src = img[r0 + dr : r1 + dr, c0 + dc : c1 + dc].copy()
        src += (level[r0:r1] - level[r0 + dr : r1 + dr])[:, None, :]
        yy, xx = np.mgrid[0 : r1 - r0, 0 : c1 - c0].astype(np.float32)
        edge = np.minimum(np.minimum(yy, r1 - r0 - 1 - yy), np.minimum(xx, c1 - c0 - 1 - xx))
        a = np.clip((edge + 1) / FEATHER, 0.0, 1.0)[..., None]
        img[r0:r1, c0:c1] = img[r0:r1, c0:c1] * (1 - a) + src * a


def close_holes(m: np.ndarray, r0: int, r1: int, c0: int, c1: int, radius: int = 3) -> None:
    """Morphological closing of the coverage in a box: the marks written across the art left gaps in it"""
    box = m[r0 - radius : r1 + radius, c0 - radius : c1 + radius]
    k = 2 * radius + 1
    win = np.lib.stride_tricks.sliding_window_view(np.pad(box, radius, mode="edge"), (k, k))
    grown = win.max((-1, -2))
    win = np.lib.stride_tricks.sliding_window_view(np.pad(grown, radius, mode="edge"), (k, k))
    closed = win.min((-1, -2))
    m[r0:r1, c0:c1] = np.maximum(m[r0:r1, c0:c1], closed[radius:-radius, radius:-radius])


def save(path: Path, rgb: np.ndarray, quality: int | None) -> None:
    im = Image.fromarray(np.clip(np.round(rgb), 0, 255).astype(np.uint8), "RGB")
    if quality is None:
        im.save(path, lossless=True, quality=100, method=6)
    else:
        im.save(path, quality=quality, method=6)
    print(f"{path}: {im.size[0]}x{im.size[1]}, {path.stat().st_size / 1024:.0f} KiB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("textures", type=Path, help="the pack's texture folder")
    ap.add_argument("out", type=Path, help="folder for the three textures")
    ap.add_argument("--quality", type=int, default=92, help="WebP quality of the rubber (the art is lossless)")
    ap.add_argument("--preview", type=Path, help="also write the five compounds printed back, as a check, here")
    args = ap.parse_args()

    red, yellow, white, green, blue = (load(args.textures, c) for c in ("red", "yellow", "white", "green", "blue"))

    c_red, c_white = art_colour(red, white), art_colour(white, red)
    c_yellow = art_colour(yellow, red)
    c_green, c_blue = art_colour(green, blue), art_colour(blue, green)
    slick_m = coverage(white, red, c_white, c_red)
    cint_m = coverage(green, blue, c_green, c_blue)

    # The rubber: from whichever family has less art on the pixel, and from the rubber around where both print
    under_s, keep_s = rubber_under(red, c_red, slick_m)
    under_c, keep_c = rubber_under(blue, c_blue, cint_m)
    use_s = (keep_s >= keep_c)[..., None]
    rubber = np.where(use_s, under_s, under_c)
    trust = np.maximum(keep_s, keep_c)
    solid = (trust > 0.5).astype(np.float32)
    # The art's edges leave a dark fringe of its colour in the rubber (the red strip's, here): rubber is grey, so a
    # dim coloured pixel in the art's rows is fringe, and is filled like the rubber under the art
    fringe = (rubber.max(-1) - rubber.min(-1) > 24) & (rubber.mean(-1) < 90)
    fringe[:ART_TOP] = False
    fringe[ART_BOTTOM:] = False
    solid[fringe] = 0.0
    rows = slice(ART_TOP - 40, ART_BOTTOM + 40)
    fill = box_blur(rubber[rows] * solid[rows, :, None], 10) / np.maximum(box_blur(solid[rows], 10), 1e-3)[..., None]
    rubber[rows] = np.where(solid[rows, :, None] > 0, rubber[rows], fill)

    level = np.median(rubber[:, CLEAN_COLS], axis=1)
    paint_out(rubber, level)
    for r0, r1, c0, c1, _, _ in PAINT_OUT[:1]:
        close_holes(slick_m, r0, r1, c0 - 40, c1)
        close_holes(cint_m, r0, r1, c0 - 40, c1)

    tread = rubber.copy()
    tread[TREAD_TOP:TREAD_BOTTOM] = green[TREAD_TOP:TREAD_BOTTOM]

    args.out.mkdir(parents=True, exist_ok=True)
    save(args.out / "pirelli-2025-ps-slick.webp", rubber, args.quality)
    save(args.out / "pirelli-2025-ps-intermediate.webp", tread, args.quality)
    band = slice(*ART_BAND)
    art = np.stack([slick_m[band], cint_m[band], np.zeros_like(slick_m[band])], axis=-1) * 255
    save(args.out / "pirelli-2025-ps-art.webp", art, None)

    # How close the printed-back compounds come to the pack's own (outside the paint-outs)
    def printed(base: np.ndarray, m: np.ndarray, colour: np.ndarray) -> np.ndarray:
        return base * (1 - m[..., None]) + colour * m[..., None]

    checks = (
        ("soft", printed(rubber, slick_m, c_red), red),
        ("medium", printed(rubber, slick_m, c_yellow), yellow),
        ("hard", printed(rubber, slick_m, c_white), white),
        ("intermediate", printed(tread, cint_m, c_green), green),
        ("wet", printed(rubber, cint_m, c_blue), blue),
    )
    clean = np.ones((H, W), bool)
    for r0, r1, c0, c1, _, _ in PAINT_OUT:
        clean[r0:r1, c0:c1] = False
    for name, got, want in checks:
        err = np.abs(got - want).max(-1)[clean]
        print(f"  {name}: mean error {err.mean():.2f}, 99.9th percentile {np.percentile(err, 99.9):.0f} of 255")
    hexes = {n: "#%02x%02x%02x" % tuple(int(round(v)) for v in c) for n, c in (("soft", c_red), ("medium", c_yellow), ("hard", c_white), ("intermediate", c_green), ("wet", c_blue))}
    print("  art colours (sRGB):", hexes)

    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
        for name, got, _ in checks:
            Image.fromarray(np.clip(got, 0, 255).astype(np.uint8)).save(args.preview / f"{name}.png")


if __name__ == "__main__":
    main()
