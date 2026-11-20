#!/usr/bin/env python3
"""
Port sagatron918's six RSS GT-M Tyre Extension packs into planar sidewall disc WebPs read by
`src/lib/render/gt-tyre-sidewall.ts`. Used with the author's permission; see CREDITS.md.

Each pack ships an inner zip (`extension/textures/cars/Sagatron918/RSS_*.zip`) containing 4096² BC7/DXT1
tyre strips laid out for Assetto Corsa's RSS GT-M tyre UVs:
  - Lower band (rows ~3540–3920): 180° arc of the outer sidewall, upright (letter tops face the shoulder/tread).
  - Upper band (rows ~1430–1820): the opposite 180° arc of the outer sidewall, rotated 180° (letter tops face
    the tread at the larger row index, and u runs right-to-left).

This script extracts textures ONLY (no `.ini` shader configs, no `data/` LUTs or third-party physics files),
re-projects both 180° bands onto a single full-colour sRGB planar disc centred on the axle, and writes lossless
WebPs into `public/cars/shared/tyres/gt/<name>-sidewall.webp`:
  - pirelli       (Pirelli P ZERO DHG)
  - michelin      (Michelin Pilot Sport N24)
  - goodyear      (Goodyear Eagle LMGT3 Medium + Wet)
  - bridgestone   (Bridgestone Potenza Post-2022 + Wet)
  - yokohama      (Yokohama ADVAN Super GT A005)
  - falken        (Falken Dry + Wet)

Disc geometry matches `src/lib/render/gt-tyre-sidewall.ts`:
  - rim seat at radius 0.66, sidewall shoulder at radius 0.90 (fraction of the disc's half-width)
  - logos centred around radius 0.78, scaled isotropically (~5.5e-4 half-widths per strip row)
  - angle clockwise from 12 o'clock; lower band spans the top half (-90°..+90°), upper band rotated 180°
    spans the bottom half (+90°..+270°), cross-faded across empty rubber at 3 and 9 o'clock.

Run with:
  python3 -I scripts/cars/port_sagatron_tyres.py /Users/alpyalay/Downloads public/cars/shared/tyres/gt

Dependencies: Python stdlib + numpy + Pillow (decodes DX10 BC7 and DXT1 DDS).
"""

from __future__ import annotations

import argparse
import io
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

STRIP = 4096  # source DDS strip dimensions (4096x4096)

# Disc radial geometry (fractions of the output half-width); mirrored in src/lib/render/gt-tyre-sidewall.ts
TEX_RIM = 0.66
TEX_SHOULDER = 0.90
R_MID = 0.78
R_PER_ROW = 5.5e-4

# Minimum rubber sRGB floor so pitch-black source rubber still reads as realistic dark vulcanised rubber under PBR
RUBBER_FLOOR = 18.0
# Angular half-width (turns) of the cross-fade between the lower and upper 180° bands at 3 and 9 o'clock
SEAM_FEATHER = 0.008


@dataclass(frozen=True)
class TyreSpec:
    output_stem: str
    outer_zip: str
    inner_zip: str
    dds_name: str
    upper_mid: float
    lower_mid: float
    upper_u_center: float
    lower_u_center: float
    upper_rows: tuple[int, int]
    lower_rows: tuple[int, int]


SPECS: tuple[TyreSpec, ...] = (
    TyreSpec(
        output_stem="pirelli",
        outer_zip="Sagatron_RSS_Pirelli_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_PIRELLI_PZERO.zip",
        dds_name="Pirelli_DHG.dds",
        upper_mid=1614.0,
        lower_mid=3738.0,
        upper_u_center=0.870,
        lower_u_center=0.140,
        upper_rows=(1460, 1780),
        lower_rows=(3580, 3900),
    ),
    TyreSpec(
        output_stem="michelin",
        outer_zip="Sagatron_RSS_Michelin_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_MICHELIN_TYRE.zip",
        dds_name="Michelin_N24.dds",
        upper_mid=1625.0,
        lower_mid=3747.0,
        upper_u_center=0.490,
        lower_u_center=0.420,
        upper_rows=(1430, 1820),
        lower_rows=(3570, 3920),
    ),
    TyreSpec(
        output_stem="goodyear",
        outer_zip="Sagatron_RSS_Goodyear_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_GOODYEAR_LMGT3.zip",
        dds_name="Goodyear_M.dds",
        upper_mid=1612.0,
        lower_mid=3718.0,
        upper_u_center=0.465,
        lower_u_center=0.500,
        upper_rows=(1450, 1780),
        lower_rows=(3555, 3895),
    ),
    TyreSpec(
        output_stem="goodyear-wet",
        outer_zip="Sagatron_RSS_Goodyear_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_GOODYEAR_LMGT3.zip",
        dds_name="Goodyear_W.dds",
        upper_mid=1608.0,
        lower_mid=3720.0,
        upper_u_center=0.465,
        lower_u_center=0.500,
        upper_rows=(1450, 1780),
        lower_rows=(3555, 3900),
    ),
    TyreSpec(
        output_stem="bridgestone",
        outer_zip="Sagatron_RSS_Bridgestone_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_BRIDGESTONE.zip",
        dds_name="Bridgestone_Post_2022.dds",
        upper_mid=1605.0,
        lower_mid=3715.0,
        upper_u_center=0.540,
        lower_u_center=0.460,
        upper_rows=(1445, 1775),
        lower_rows=(3555, 3885),
    ),
    TyreSpec(
        output_stem="bridgestone-wet",
        outer_zip="Sagatron_RSS_Bridgestone_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_BRIDGESTONE.zip",
        dds_name="Bridgestone_Post_2022_Wet.dds",
        upper_mid=1605.0,
        lower_mid=3715.0,
        upper_u_center=0.540,
        lower_u_center=0.460,
        upper_rows=(1445, 1775),
        lower_rows=(3555, 3885),
    ),
    TyreSpec(
        output_stem="yokohama",
        outer_zip="Sagatron_RSS_Yokohama_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_YOKOHAMA_ADVAN.zip",
        dds_name="Yokohama_ADVAN_SGT_A005.dds",
        upper_mid=1608.0,
        lower_mid=3702.0,
        upper_u_center=0.520,
        lower_u_center=0.490,
        upper_rows=(1450, 1780),
        lower_rows=(3545, 3880),
    ),
    TyreSpec(
        output_stem="falken",
        outer_zip="Sagatron_RSS_Falken_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_FALKEN.zip",
        dds_name="Falken_Dry.dds",
        upper_mid=1580.0,
        lower_mid=3720.0,
        upper_u_center=0.493,
        lower_u_center=0.493,
        upper_rows=(1430, 1750),
        lower_rows=(3560, 3890),
    ),
    TyreSpec(
        output_stem="falken-wet",
        outer_zip="Sagatron_RSS_Falken_Tyre_Extension.zip",
        inner_zip="extension/textures/cars/Sagatron918/RSS_FALKEN.zip",
        dds_name="Falken_Wet.dds",
        upper_mid=1592.0,
        lower_mid=3720.0,
        upper_u_center=0.493,
        lower_u_center=0.493,
        upper_rows=(1435, 1755),
        lower_rows=(3560, 3895),
    ),
)


def load_dds_from_packs(source_dir: Path, spec: TyreSpec) -> np.ndarray:
    """Reads a single diffuse DDS straight from the nested pack zips into an sRGB float32 array."""
    outer_path = source_dir / spec.outer_zip
    if not outer_path.is_file():
        sys.exit(f"Missing pack archive: {outer_path}")
    with zipfile.ZipFile(outer_path) as outer:
        with outer.open(spec.inner_zip) as inner_bytes:
            with zipfile.ZipFile(io.BytesIO(inner_bytes.read())) as inner:
                with inner.open(spec.dds_name) as dds_file:
                    im = Image.open(io.BytesIO(dds_file.read()))
                    im.load()
                    arr = np.asarray(im.convert("RGB"), dtype=np.float32)
    if arr.shape[:2] != (STRIP, STRIP):
        sys.exit(
            f"{spec.dds_name}: {arr.shape[1]}x{arr.shape[0]}, expected {STRIP}x{STRIP} "
            "(the row constants are calibrated for 4096x4096 strips)"
        )
    return arr


def sample_rgb(img: np.ndarray, u: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Bilinear sample of an RGB strip at u (wraps 0..1) and row y (clamped)."""
    h, w, _ = img.shape
    x = (u % 1.0) * w - 0.5
    y = np.clip(y - 0.5, 0.0, h - 1.0)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx = (x - x0)[..., None]
    fy = (y - y0)[..., None]
    x0 %= w
    x1 = (x0 + 1) % w
    y1 = np.minimum(y0 + 1, h - 1)
    top = img[y0, x0] * (1.0 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1.0 - fx) + img[y1, x1] * fx
    return top * (1.0 - fy) + bot * fy


def project_disc(img: np.ndarray, spec: TyreSpec, size: int) -> tuple[np.ndarray, np.ndarray]:
    """Re-projects both 180° sidewall bands onto an axle-centred planar disc (RGB uint8)."""
    c = (size - 1) / 2.0
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    r = np.hypot(xx - c, yy - c) / (size / 2.0)
    # Angle clockwise from 12 o'clock (-0.5..+0.5 turns)
    theta = np.arctan2(xx - c, c - yy) / (2.0 * np.pi)
    # phi: 0 at 9 o'clock, 0.25 at 12 o'clock, 0.5 at 3 o'clock, 0.75 at 6 o'clock
    phi = (theta + 0.25) % 1.0

    # Cross-fade weight for the lower (top-half) band across 3 and 9 o'clock
    w_lo = np.where(phi < 0.5, 1.0, 0.0).astype(np.float32)
    dist0 = np.minimum(phi, 1.0 - phi)
    dist5 = np.abs(phi - 0.5)
    w_lo = np.where(dist0 < SEAM_FEATHER, 0.5 + 0.5 * np.where(phi < 0.5, dist0, -dist0) / SEAM_FEATHER, w_lo)
    w_lo = np.where(dist5 < SEAM_FEATHER, 0.5 + 0.5 * (0.5 - phi) / SEAM_FEATHER, w_lo)

    u0, u1 = spec.upper_rows
    l0, l1 = spec.lower_rows

    # Estimate source sidewall rubber tone and lift ultra-dark rubber gently to RUBBER_FLOOR
    rubber_src = np.median(img[l0:l1:4, ::8].reshape(-1, 3), axis=0)
    src_luma = float(rubber_src.mean())
    lift = max(0.0, RUBBER_FLOOR - src_luma)
    if lift > 0.0:
        scale = (255.0 - lift) / 255.0
        img = lift + img * scale
        rubber_fill = lift + rubber_src * scale
    else:
        rubber_fill = rubber_src

    # Lower band -> top half (phi in [0, 0.5), logo centred at phi = 0.25 -> 12 o'clock)
    u_lo = spec.lower_u_center + (phi - 0.25) * 2.0
    row_lo = spec.lower_mid - (r - R_MID) / R_PER_ROW
    in_lo = np.clip(np.minimum((row_lo - l0) / 14.0, (l1 - row_lo) / 14.0), 0.0, 1.0)
    col_lo = sample_rgb(img, u_lo, np.clip(row_lo, l0, l1))
    col_lo = col_lo * in_lo[..., None] + rubber_fill * (1.0 - in_lo[..., None])

    # Upper band (rotated 180° in the source strip) -> bottom half (phi in [0.5, 1.0), centred at 6 o'clock)
    u_up = spec.upper_u_center - (phi - 0.75) * 2.0
    row_up = spec.upper_mid + (r - R_MID) / R_PER_ROW
    in_up = np.clip(np.minimum((row_up - u0) / 14.0, (u1 - row_up) / 14.0), 0.0, 1.0)
    col_up = sample_rgb(img, u_up, np.clip(row_up, u0, u1))
    col_up = col_up * in_up[..., None] + rubber_fill * (1.0 - in_up[..., None])

    disc = col_lo * w_lo[..., None] + col_up * (1.0 - w_lo[..., None])

    # Uniform rubber outside the sidewall band keeps the lossless WebP compact and prevents edge artefacts
    ring = np.clip(np.minimum((r - (TEX_RIM - 0.04)) / 0.03, ((TEX_SHOULDER + 0.04) - r) / 0.03), 0.0, 1.0)
    disc = disc * ring[..., None] + rubber_fill * (1.0 - ring[..., None])

    out = np.clip(np.round(disc), 0, 255).astype(np.uint8)
    return out, rubber_fill


def verify_disc(disc: np.ndarray, rubber_fill: np.ndarray, stem: str) -> str:
    """Numerically verifies the disc is centred, non-blank, and has artwork inside the sidewall ring."""
    n = disc.shape[0]
    c = (n - 1) / 2.0
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    r = np.hypot(xx - c, yy - c) / (n / 2.0)

    diff = np.abs(disc.astype(np.float32) - rubber_fill[None, None, :]).max(axis=-1)
    art = diff > 35.0
    in_band = (r >= TEX_RIM) & (r <= TEX_SHOULDER)
    in_center = r < (TEX_RIM - 0.05)

    band_art = float(art[in_band].mean())
    center_art = float(art[in_center].mean())
    if band_art < 0.02:
        sys.exit(f"Verification failed for {stem}: sidewall band looks blank ({band_art:.4f} art coverage)")
    if center_art > 0.001:
        sys.exit(f"Verification failed for {stem}: unexpected art leaked into rim hub ({center_art:.4f})")

    ys, xs = np.where(art & in_band)
    mean_r = float(r[ys, xs].mean())
    # Check artwork sits on both top and bottom halves (symmetric around the axle)
    top_art = float(art[in_band & (yy < c)].mean())
    bot_art = float(art[in_band & (yy >= c)].mean())
    if top_art < 0.01 or bot_art < 0.01:
        sys.exit(f"Verification failed for {stem}: artwork not balanced across halves (top={top_art:.3f}, bot={bot_art:.3f})")

    return f"art={band_art * 100:.1f}% (top={top_art * 100:.1f}%, bot={bot_art * 100:.1f}%), mean_r={mean_r:.3f}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source_dir", type=Path, help="folder containing the 6 Sagatron_RSS_*_Tyre_Extension.zip archives")
    ap.add_argument("out_dir", type=Path, help="output directory (e.g. public/cars/shared/tyres/gt)")
    ap.add_argument("--size", type=int, default=1024, help="output disc resolution in px (default: 1024)")
    ap.add_argument("--brands", nargs="*", help="optional subset of output stems to port (default: all)")
    ap.add_argument("--preview", type=Path, help="optional path to write a contact sheet with rim/shoulder guides")
    args = ap.parse_args()

    selected = [s for s in SPECS if not args.brands or s.output_stem in args.brands]
    if not selected:
        sys.exit(f"No matching brands in {args.brands}; available: {[s.output_stem for s in SPECS]}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    previews: list[Image.Image] = []

    n = args.size
    c = (n - 1) / 2.0
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    r = np.hypot(xx - c, yy - c) / (n / 2.0)

    for spec in selected:
        strip = load_dds_from_packs(args.source_dir, spec)
        disc, rubber_fill = project_disc(strip, spec, n)
        stats = verify_disc(disc, rubber_fill, spec.output_stem)

        out_path = args.out_dir / f"{spec.output_stem}-sidewall.webp"
        Image.fromarray(disc, "RGB").save(out_path, lossless=True, quality=100, method=6)
        kb = out_path.stat().st_size / 1024.0
        print(f"  {out_path.name:30s} {n}x{n}  {kb:6.1f} KiB  rubber={rubber_fill.mean():.1f}  {stats}")

        if args.preview:
            pv = np.clip(disc.astype(np.float32) * 1.3, 0, 255).astype(np.uint8)
            pv[np.abs(r - TEX_RIM) < 0.004] = [0, 220, 255]
            pv[np.abs(r - TEX_SHOULDER) < 0.004] = [255, 0, 200]
            previews.append(Image.fromarray(pv).resize((512, 512)))

    if args.preview and previews:
        cols = min(3, len(previews))
        rows = (len(previews) + cols - 1) // cols
        grid = Image.new("RGB", (cols * 512, rows * 512), (18, 18, 18))
        for idx, im in enumerate(previews):
            grid.paste(im, ((idx % cols) * 512, (idx // cols) * 512))
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        grid.save(args.preview)
        print(f"Preview written to {args.preview}")


if __name__ == "__main__":
    main()
