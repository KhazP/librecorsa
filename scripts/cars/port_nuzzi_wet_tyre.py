#!/usr/bin/env python3
"""
Port the full-wet tread from Nuzzi's F1 tyre pack with wet physics (OverTake, used with
permission; see CREDITS.md) into the full-wet rubber strip the F1 tyre shader reads (`src/lib/render/tyre-wrap.ts`).

Purple Sector's 2025 Pirelli pack provides the clean sidewalls (with no third-party markings) and the slick / intermediate
rubber (`pirelli-2025-ps-slick.webp`, `pirelli-2025-ps-intermediate.webp`), but its wet strip carries the slick tread.
Nuzzi's `W.dds` uses the same 4096 x 1024 UV strip layout (tread rows 190..836) and provides the deep-grooved Pirelli
Cinturato full-wet tread. This script composites only Nuzzi's tread band onto Purple Sector's clean slick sidewalls,
feathered across the shoulders, and brings the tread block tops up to the intermediate strip's rubber level while
keeping the water-evacuation grooves deep and legible:

  <out>/pirelli-2025-wet-nuzzi.webp   the clean 2025 sidewalls with Nuzzi's full-wet tread (sRGB)

Run with:
  python3 -I scripts/cars/port_nuzzi_wet_tyre.py \\
    "<pack>/extension/tyre_textures/W.dds" \\
    public/cars/shared/tyres/pirelli-2025-ps-slick.webp \\
    public/cars/shared/tyres/pirelli-2025-wet-nuzzi.webp

Dependencies: Python stdlib + numpy + Pillow (decodes DX10 BC7 DDS).
"""

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

W, H = 4096, 1024  # strip size; matches port_purple_sector_tyres.py

# The tread rows between the sidewalls' art and marks (matches port_purple_sector_tyres.py)
TREAD_TOP = 190
TREAD_BOTTOM = 836
# Rows feathered smoothly at the outer and inner shoulders (still outside the wet grooves, which start around row 225)
FEATHER = 18

# Subtle block-top lift anchored at the groove floor so the wet rubber matches the intermediate strip's albedo (~33-36)
# without washing out the dark water channels (~16-18).
GROOVE_FLOOR = 15.0
BLOCK_GAIN = 1.24


def load_rgb(path: Path) -> np.ndarray:
    im = Image.open(path)
    im.load()
    arr = np.asarray(im.convert("RGB"), dtype=np.float32)
    if arr.shape[:2] != (H, W):
        sys.exit(f"{path}: {arr.shape[1]}x{arr.shape[0]}, expected {W}x{H}")
    return arr


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("wet_dds", type=Path, help="Nuzzi's full-wet diffuse strip (W.dds)")
    ap.add_argument("slick_webp", type=Path, help="Clean 2025 slick strip (pirelli-2025-ps-slick.webp)")
    ap.add_argument("out", type=Path, help="Output WebP path (e.g. public/cars/shared/tyres/pirelli-2025-wet-nuzzi.webp)")
    ap.add_argument("--quality", type=int, default=92, help="WebP quality (default 92)")
    ap.add_argument("--preview", type=Path, help="Optional PNG preview path (prints blue Cinturato art if --art given)")
    ap.add_argument("--art", type=Path, help="Optional art mask (pirelli-2025-ps-art.webp) for --preview")
    args = ap.parse_args()

    wet = load_rgb(args.wet_dds)
    base = load_rgb(args.slick_webp)

    # Extract only Nuzzi's tread band and anchor groove contrast to match the intermediate strip's rubber level
    tread = wet[TREAD_TOP:TREAD_BOTTOM].copy()
    tread = GROOVE_FLOOR + np.maximum(0.0, tread - GROOVE_FLOOR) * BLOCK_GAIN

    # Smooth feather at both shoulders into Purple Sector's clean sidewalls
    rows = TREAD_BOTTOM - TREAD_TOP
    mask = np.ones((rows, 1, 1), dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, FEATHER, dtype=np.float32)[:, None, None]
    mask[:FEATHER] = ramp
    mask[-FEATHER:] = ramp[::-1]

    out_rgb = base.copy()
    out_rgb[TREAD_TOP:TREAD_BOTTOM] = base[TREAD_TOP:TREAD_BOTTOM] * (1.0 - mask) + tread * mask

    args.out.parent.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(np.clip(np.round(out_rgb), 0, 255).astype(np.uint8), "RGB")
    im.save(args.out, quality=args.quality, method=6)
    print(f"{args.out}: {im.size[0]}x{im.size[1]}, {args.out.stat().st_size / 1024:.0f} KiB")

    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        prev = out_rgb.copy()
        if args.art and args.art.exists():
            art = np.asarray(Image.open(args.art).convert("RGB"), dtype=np.float32) / 255.0
            cint = art[:, :, 1:2]  # G channel = Cinturato
            blue = np.array([0x00, 0x66, 0xB7], dtype=np.float32)
            prev[64:192] = prev[64:192] * (1.0 - cint) + blue * cint
        Image.fromarray(np.clip(np.round(prev), 0, 255).astype(np.uint8), "RGB").resize(
            (1024, 256), Image.Resampling.LANCZOS
        ).save(args.preview)
        print(f"preview: {args.preview}")


if __name__ == "__main__":
    main()
