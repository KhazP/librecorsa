#!/usr/bin/env python3
"""
Port MrMaukus's 2026 Pirelli tyre sidewall mod for F1 25 into the packed texture the 2026 cars' tyre shader reads
(`src/lib/render/pirelli-sidewall.ts`). Used with the author's permission; see CREDITS.md.

The mod ships one EGO resource package, `shader_package_2025/tyre_sidewall.nefx2.sm51.erp` (the `_amd` twin carries
the same textures). Inside are F1 25's compiled sidewall shaders and two 1024² BC7 texture arrays of two layers each:
  - sidewall_diffuse       L0: rubber albedo (sRGB, grey), L1: worn variant
  - sidewall_logo_surface  L0: logo masks, R = slick branding (P ZERO, chequers, PIRELLI), G = wet branding
                           (Cinturato); the game tints them with the compound colour. L1: surface detail
Both are planar discs centred on the axle: the rim seat sits at ~0.69 of the half-width, the logos span ~0.72-0.875
and the sidewall ends at ~0.89.

Output (lossless WebP, so the packed masks don't bleed into each other):
  R = rubber albedo (sRGB), G = slick logo mask, B = wet logo mask

Run with:
  python3 -I scripts/cars/port_f1_25_sidewall.py "<mod>/shader_package_2025/tyre_sidewall.nefx2.sm51.erp" \
    public/cars/shared/tyres/pirelli-2026-sidewall.webp

Dependencies: Python stdlib + numpy + Pillow (BC7 decoding) and the `zstd` CLI (the ERP fragments are zstd frames).
"""

import argparse
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SURFACE_BC7 = 0x46  # EGO surface format of both arrays (BC7)


def read_erp(path: Path) -> dict[str, list[bytes]]:
    """Resource id -> its fragments, decompressed. ERPK v3/v4 layout (EgoEngineLibrary's ErpFile)."""
    b = path.read_bytes()
    if b[:4] != b"ERPK":
        sys.exit(f"{path}: not an ERPK package")
    version = struct.unpack_from("<i", b, 4)[0]
    entry_off = struct.unpack_from("<Q", b, 32)[0]
    n_res = struct.unpack_from("<i", b, 48)[0]
    o = 56
    out: dict[str, list[bytes]] = {}
    for _ in range(n_res):
        o += 4  # entry info length
        name_len = struct.unpack_from("<h", b, o)[0]
        o += 2
        ident = b[o : o + name_len].split(b"\0")[0].decode()
        o += name_len + 16 + 4  # name, resource type, unknown
        n_frag = b[o]
        o += 1
        frags = []
        for _ in range(n_frag):
            o += 4  # fragment name
            off, size, _flags = struct.unpack_from("<QQi", b, o)
            o += 20
            packed = size
            if version > 2:
                o += 1  # compression id
                packed = struct.unpack_from("<Q", b, o)[0]
                o += 8
            raw = b[entry_off + off : entry_off + off + packed]
            if raw[:4] == b"\x28\xb5\x2f\xfd":
                raw = subprocess.run(["zstd", "-d", "-c"], input=raw, capture_output=True, check=True).stdout
            if len(raw) != size:
                sys.exit(f"{ident}: fragment is {len(raw)} bytes, expected {size}")
            frags.append(raw)
        if version > 2:
            o += 16  # hash
        out[ident] = frags
    return out


def texture_layers(frags: list[bytes], ident: str) -> list[Image.Image]:
    """Mip 0 of every layer of a GfxSurfaceRes texture array (header fragment + data fragment)."""
    header, data = frags
    fmt, width, height, _depth, mips, layers = struct.unpack_from("<6I", header, 8)
    if fmt != SURFACE_BC7:
        sys.exit(f"{ident}: surface format 0x{fmt:x}, expected BC7 (0x{SURFACE_BC7:x})")
    # Layer-major (D3D subresource order): each layer's full mip chain, BC7 = 1 byte per pixel, 4x4 blocks
    mip_bytes = [max(1, width >> m) // 4 * max(1, height >> m) // 4 * 16 for m in range(mips)]
    layer_bytes = sum(mip_bytes)
    if layer_bytes * layers != len(data):
        sys.exit(f"{ident}: {len(data)} data bytes, expected {layer_bytes * layers}")
    return [
        Image.frombytes("RGBA", (width, height), data[i * layer_bytes : i * layer_bytes + mip_bytes[0]], "bcn", 7)
        for i in range(layers)
    ]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("erp", type=Path, help="tyre_sidewall.nefx2.sm51.erp from the mod")
    ap.add_argument("out", type=Path, help="packed sidewall texture (.webp)")
    args = ap.parse_args()

    res = read_erp(args.erp)
    base = "eaid://f1_2025_vehicle_package/shared/tyres/texture_arrays/"
    diffuse = texture_layers(res[base + "sidewall_diffuse.texarray.image"], "sidewall_diffuse")
    logos = texture_layers(res[base + "sidewall_logo_surface.texarray.image"], "sidewall_logo_surface")

    rubber = np.asarray(diffuse[0])[..., :3].astype(np.int16)
    spread = int(np.abs(rubber - rubber[..., :1]).max())
    if spread > 8:
        sys.exit(f"sidewall_diffuse is not grey (channel spread {spread}): the R-only packing would lose colour")
    mask = np.asarray(logos[0])
    packed = np.stack([rubber[..., 0].astype(np.uint8), mask[..., 0], mask[..., 1]], axis=-1)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(packed, "RGB").save(args.out, lossless=True, quality=100, method=6)
    print(f"{args.out}: {packed.shape[1]}x{packed.shape[0]}, {args.out.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
