#!/usr/bin/env python3
"""
Port Cxjovich's 2026 Pirelli Tire Pack (OverTake, for the Formula Hybrid X 2026 in Assetto Corsa) into the packed
sidewall disc the 2018+ cars' tyre shader reads (`src/lib/render/pirelli-sidewall.ts`). Used with the author's
permission under CC BY-NC-SA 4.0; see CREDITS.md.

The pack's `extension/tyres/<compound>.dds` are 4096² BC7 strips laid out for that car's tyre UVs: u runs once round
the tyre, rows cross it (sidewall, tread, sidewall), the compound colour is baked into the logos and alpha holds a
gloss mask. One upright logo row (rows ~1267-1509: chequered stripe, PIRELLI, stripe, P ZERO / Cinturato) is the
outer sidewall; letter tops face the shoulder.

This script re-projects that row into the shader's disc, centred on the axle (the same layout as before):
  - angle: clockwise from the top, reading direction; P ZERO centred at the top, PIRELLI at the bottom
  - radius (fraction of the half-width): the rim seat sits at 0.69 and the sidewall edge at 0.89; the logo row
    spans ~0.73-0.87, scaled so the letters keep the proportions of the real tyre
Output (lossless WebP, so the packed masks don't bleed into each other):
  R = rubber albedo (sRGB), G = slick logo mask (from the white C2, the art with the chequers), B = wet logo mask
  (from the blue Wet, Cinturato). The shader tints the masks with the compound colour.

The `data/` LUTs in the pack are left out: they carry Race Sim Studio's copyright.

Run with:
  python3 -I scripts/cars/port_cxjovich_sidewall.py \
    "<pack>/rss_formula_hybrid_x_2026/extension/tyres" public/cars/shared/tyres/pirelli-2026-sidewall-cx.webp

Dependencies: Python stdlib + numpy + Pillow (decodes DX10 BC7 DDS).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

STRIP = 4096  # the pack's strip size; row and column constants below are in its pixels

# The upright logo row on the strip (PIRELLI's top and bottom: the tallest logo) and its sidewall rubber margins
ROW_TOP = 1267
ROW_BOTTOM = 1509
RUBBER_TOP = 1180  # above: still sidewall rubber, before the tread scuffs
RUBBER_BOTTOM = 1680
# u of P ZERO's centre (0.766-0.964), put at the top of the disc
U_TOP = 0.865

# Where PIRELLI's top lands in the disc (fraction of the half-width) and the radial scale (half-widths per strip
# row). Fitted to the real 2026 sidewall: PIRELLI spans ~0.73-0.87 and P ZERO is about 13x as long as it is tall.
R_TOP = 0.867
R_PER_ROW = 5.6e-4

# Logo colours in the source art: the white of C2 and the blue of Wet (sRGB)
WHITE_MIN = 241  # min channel of C2's white
WET_BLUE = 189  # blue channel of Wet's blue


def load_strip(path: Path) -> np.ndarray:
    im = Image.open(path)
    im.load()
    a = np.asarray(im.convert("RGB")).astype(np.float32)
    if a.shape[:2] != (STRIP, STRIP):
        sys.exit(f"{path}: {a.shape[1]}x{a.shape[0]}, expected {STRIP}x{STRIP} (the row constants are for that size)")
    return a


def logo_alpha(value: np.ndarray, rubber: float, full: float) -> np.ndarray:
    return np.clip((value - rubber) / (full - rubber), 0.0, 1.0)


def blur(img: np.ndarray, radius: int) -> np.ndarray:
    """Three box passes per axis (about a Gaussian); wraps along u, clamps across rows"""
    out = img.astype(np.float64)
    k = 2 * radius + 1
    for _ in range(3):
        padded = np.concatenate([out[:, -radius - 1 :], out, out[:, :radius]], axis=1)
        cs = np.cumsum(padded, axis=1)
        out = (cs[:, k:] - cs[:, :-k]) / k
        padded = np.pad(out, ((radius + 1, radius), (0, 0)), mode="edge")
        cs = np.cumsum(padded, axis=0)
        out = (cs[k:] - cs[:-k]) / k
    return out.astype(np.float32)


def sample(img: np.ndarray, u: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample of a single-channel strip at u (wraps, 0..1) and row y (clamped)"""
    h, w = img.shape
    x = (u % 1.0) * w - 0.5
    y = np.clip(y - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = x - x0
    fy = y - y0
    x0 %= w
    x1 = (x0 + 1) % w
    y1 = np.minimum(y0 + 1, h - 1)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tyres", type=Path, help="the pack's extension/tyres folder")
    ap.add_argument("out", type=Path, help="packed sidewall texture (.webp)")
    ap.add_argument("--size", type=int, default=2048, help="output size (px)")
    ap.add_argument("--preview", type=Path, help="also write a tinted preview (medium slick | wet) here")
    args = ap.parse_args()

    slick = load_strip(args.tyres / "C2.dds")
    wet = load_strip(args.tyres / "Wet.dds")

    # Rubber level: the median of the sidewall rows around the logo row (no logos there)
    band = np.r_[RUBBER_TOP:ROW_TOP - 8, ROW_BOTTOM + 8 : RUBBER_BOTTOM]
    rubber_luma = float(np.median(slick[band].mean(-1)))
    # The masks start above the rubber's own grain (its 99.5th percentile), so plain rubber takes no tint
    slick_floor = float(np.percentile(slick[band].min(-1), 99.5))
    wet_floor = float(np.percentile(wet[band].max(-1), 99.5))

    slick_a = logo_alpha(slick.min(-1), slick_floor, WHITE_MIN)
    wet_a = logo_alpha(wet.max(-1), wet_floor, WET_BLUE)
    # A pixel is clean rubber when neither art has a logo there
    clean = 1.0 - np.maximum(slick_a, wet_a)
    clean = np.where(clean > 0.98, 1.0, 0.0).astype(np.float32)

    # Rubber albedo with the logos filled from the rubber around them (normalised blur), so no halo shows at the
    # logos' edges when the shader blends in the compound colour
    luma = slick.mean(-1)
    rows = slice(RUBBER_TOP - 64, RUBBER_BOTTOM + 64)
    num = blur(luma[rows] * clean[rows], 24)
    den = blur(clean[rows], 24)
    fill = num / np.maximum(den, 1e-3)
    rubber = luma.copy()
    rubber[rows] = luma[rows] * clean[rows] + fill * (1 - clean[rows])

    # Disc coordinates: radius in half-widths, angle clockwise from the top (image y points down)
    n = args.size
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    r = np.hypot(xx - c, yy - c) / (n / 2)
    theta = np.arctan2(xx - c, c - yy) / (2 * np.pi)
    u = U_TOP + theta
    row = ROW_TOP + (R_TOP - r) / R_PER_ROW
    # Past the rubber rows (the bead, the shoulder) the rows mirror back, so the grain stays concentric
    span = RUBBER_BOTTOM - RUBBER_TOP
    t = np.mod(row - RUBBER_TOP, 2 * span)
    row_rubber = RUBBER_TOP + np.where(t > span, 2 * span - t, t)
    in_row = ((row >= ROW_TOP - 16) & (row <= ROW_BOTTOM + 16)).astype(np.float32)

    out_r = sample(rubber, u, row_rubber)
    out_g = sample(slick_a, u, row) * in_row
    out_b = sample(wet_a, u, row) * in_row
    packed = np.stack([out_r, out_g * 255, out_b * 255], axis=-1)
    packed = np.clip(np.round(packed), 0, 255).astype(np.uint8)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(packed, "RGB").save(args.out, lossless=True, quality=100, method=6)
    print(f"{args.out}: {n}x{n}, {args.out.stat().st_size / 1024:.0f} KiB (rubber sRGB {rubber_luma:.1f}, mask floors {slick_floor:.0f} / {wet_floor:.0f})")

    if args.preview:
        lin = (packed[..., 0] / 255.0)[..., None]
        yellow = np.array([1.0, 0.843, 0.0])
        blue = np.array([0.18, 0.48, 1.0])
        slick_view = lin * (1 - packed[..., 1:2] / 255.0) + yellow * (packed[..., 1:2] / 255.0)
        wet_view = lin * (1 - packed[..., 2:3] / 255.0) + blue * (packed[..., 2:3] / 255.0)
        view = np.concatenate([slick_view, wet_view], axis=1)
        Image.fromarray((np.clip(view * 2.5, 0, 1) * 255).astype(np.uint8)).resize((2 * 768, 768)).save(args.preview)


if __name__ == "__main__":
    main()
