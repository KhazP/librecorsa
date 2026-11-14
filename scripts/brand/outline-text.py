"""
Outlines the LIBRECORSA wordmark and the tagline from the fonts the app ships, so no rendition of the logo needs a
webfont. Run it with the system Python (fontTools 4.62) after changing the wordmark's face, tracking or slant:

    python3 -I scripts/brand/outline-text.py

- The wordmark (Orbitron at weight 900, tracked 0.05em, slanted 12 degrees) is written between the
  `<wordmark:generated>` markers in src/components/ui/logo/geometry.ts.
- The tagline (Geist Mono at weight 700, capitals, tracked 0.24em, upright) is written to
  scripts/brand/tagline-outline.ts, which only the brand script reads.

Coordinates are font units (1000 to the em). Each text is drawn in a box one em tall with its baseline where a CSS
line box of `line-height: 1` puts it, so the outlines sit exactly where the live text sat. Each letter is followed
by the tracking, the last one too, as CSS letter-spacing does. Kerning pairs (GPOS `kern`) are applied.

WOFF2 needs a Brotli decoder, which this Python lacks; Node's zlib has one, so it is borrowed through a subprocess.
"""

import math
import os
import re
import subprocess
import sys
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
FONTS = os.path.join(ROOT, "src", "app", "fonts")
GEOMETRY = os.path.join(ROOT, "src", "components", "ui", "logo", "geometry.ts")
TAGLINE_OUT = os.path.join(ROOT, "scripts", "brand", "tagline-outline.ts")

SLANT_DEG = 12  # the one slant of the logo: emblem, wordmark and bars
WORD_TRACKING = 0.05  # em, as `.font-f1-display` sets it in the app
TAGLINE = "Open-source 500 Hz motorsport sim"
TAGLINE_TRACKING = 0.24  # em


def _brotli_decompress(data: bytes) -> bytes:
    js = (
        "const z=require('zlib');const c=[];process.stdin.on('data',d=>c.push(d));"
        "process.stdin.on('end',()=>process.stdout.write(z.brotliDecompressSync(Buffer.concat(c))))"
    )
    return subprocess.run(["node", "-e", js], input=data, capture_output=True, check=True).stdout


_brotli = types.ModuleType("brotli")
_brotli.decompress = _brotli_decompress  # type: ignore[attr-defined]
sys.modules.setdefault("brotli", _brotli)

from fontTools.pens.svgPathPen import SVGPathPen  # noqa: E402
from fontTools.pens.transformPen import TransformPen  # noqa: E402
from fontTools.ttLib import TTFont  # noqa: E402
from fontTools.varLib.instancer import instantiateVariableFont  # noqa: E402


def load(file: str, wght: float) -> TTFont:
    font = TTFont(os.path.join(FONTS, file))
    return instantiateVariableFont(font, {"wght": wght})


def kern_pairs(font: TTFont) -> dict:
    """Pair adjustments (x advance of the first glyph) from every GPOS `kern` lookup, formats 1 and 2."""
    pairs: dict = {}
    if "GPOS" not in font:
        return pairs
    gpos = font["GPOS"].table
    lookups = set()
    for fr in gpos.FeatureList.FeatureRecord:
        if fr.FeatureTag == "kern":
            lookups.update(fr.Feature.LookupListIndex)
    for li in sorted(lookups):
        lookup = gpos.LookupList.Lookup[li]
        subtables = lookup.SubTable
        if lookup.LookupType == 9:
            subtables = [s.ExtSubTable for s in subtables]
        for st in subtables:
            if getattr(st, "LookupType", 2) != 2 and lookup.LookupType != 9:
                continue
            firsts = st.Coverage.glyphs
            if st.Format == 1:
                for i, g1 in enumerate(firsts):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v = getattr(pvr.Value1, "XAdvance", 0) if pvr.Value1 else 0
                        if v:
                            pairs.setdefault((g1, pvr.SecondGlyph), v)
            elif st.Format == 2:
                cd1 = st.ClassDef1.classDefs
                cd2 = st.ClassDef2.classDefs
                for g1 in firsts:
                    c1 = cd1.get(g1, 0)
                    rec = st.Class1Record[c1]
                    for g2 in font.getGlyphOrder():
                        c2 = cd2.get(g2, 0)
                        v1 = rec.Class2Record[c2].Value1
                        v = getattr(v1, "XAdvance", 0) if v1 else 0
                        if v:
                            pairs.setdefault((g1, g2), v)
    return pairs


def fmt(v: float) -> str:
    s = f"{v:.1f}"
    s = s.rstrip("0").rstrip(".") if "." in s else s
    return "0" if s in ("-0", "") else s


def compact(d: str) -> str:
    """SVGPathPen output with numbers rounded to 0.1 unit."""
    return re.sub(r"-?\d+(?:\.\d+)?(?:e-?\d+)?", lambda m: fmt(float(m.group(0))), d)


def outline(font: TTFont, text: str, tracking_em: float, slant_deg: float, x0: float = 0.0):
    """Path data for `text` set from x0, plus the pen position after its last letter's tracking."""
    upm = font["head"].unitsPerEm
    ascent = font["hhea"].ascent
    descent = font["hhea"].descent
    # CSS line box of line-height 1: the content area (ascent - descent) is centred on the em box
    baseline = (upm - (ascent - descent)) / 2 + ascent
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    pairs = kern_pairs(font)
    tan = math.tan(math.radians(slant_deg))
    track = tracking_em * upm
    x = x0
    pen = SVGPathPen(glyphs)
    names = [cmap[ord(c)] for c in text]
    for i, name in enumerate(names):
        # font y points up; the SVG's points down from the top of the em box. Slant about the baseline.
        t = TransformPen(pen, (1, 0, tan, -1, x, baseline))
        glyphs[name].draw(t)
        x += hmtx[name][0] + track
        if i + 1 < len(names):
            x += pairs.get((name, names[i + 1]), 0)
    return compact(pen.getCommands()), x, baseline, upm


def main() -> None:
    orbitron = load("orbitron-variable.woff2", 900)
    libre, x_libre, base, upm = outline(orbitron, "LIBRE", WORD_TRACKING, SLANT_DEG)
    # the browser kerns across the colour change too, so the pair E C counts
    pairs = kern_pairs(orbitron)
    cmap = orbitron.getBestCmap()
    x_corsa = x_libre + pairs.get((cmap[ord("E")], cmap[ord("C")]), 0)
    corsa, width, _, _ = outline(orbitron, "CORSA", WORD_TRACKING, SLANT_DEG, x_corsa)
    cap = orbitron["OS/2"].sCapHeight
    overhang = cap * math.tan(math.radians(SLANT_DEG))

    block = "\n".join(
        [
            "// <wordmark:generated> by scripts/brand/outline-text.py from Orbitron 900, do not edit by hand",
            "export const WORDMARK = {",
            f"  /** One em, in font units; the box is one em tall with the baseline where `line-height: 1` puts it */",
            f"  em: {upm},",
            f"  /** Advance of the ten letters with their tracking ({WORD_TRACKING} em after each, the last one too) */",
            f"  width: {fmt(width)},",
            f"  baseline: {fmt(base)},",
            f"  capHeight: {cap},",
            f"  /** How far the slanted capitals reach right of the advance box at cap height */",
            f"  overhang: {fmt(overhang)},",
            f"  libre: \"{libre}\",",
            f"  corsa: \"{corsa}\",",
            "} as const;",
            "// </wordmark:generated>",
        ]
    )
    src = open(GEOMETRY, encoding="utf-8").read()
    new, n = re.subn(
        r"// <wordmark:generated>.*?// </wordmark:generated>", lambda _m: block, src, flags=re.S
    )
    if n != 1:
        raise SystemExit(f"{GEOMETRY}: wordmark markers not found")
    open(GEOMETRY, "w", encoding="utf-8").write(new)

    mono = load("geist-mono-variable.woff2", 700)
    tag, tag_width, tag_base, tag_upm = outline(mono, TAGLINE.upper(), TAGLINE_TRACKING, 0)
    tag_cap = mono["OS/2"].sCapHeight
    with open(TAGLINE_OUT, "w", encoding="utf-8") as f:
        f.write(
            "\n".join(
                [
                    "// Generated by scripts/brand/outline-text.py from Geist Mono 700, do not edit by hand.",
                    f"/** \"{TAGLINE}\" in capitals, tracked {TAGLINE_TRACKING} em, in a box one em tall (font units) */",
                    "export const TAGLINE_OUTLINE = {",
                    f"  text: \"{TAGLINE}\",",
                    f"  em: {tag_upm},",
                    f"  width: {fmt(tag_width)},",
                    f"  baseline: {fmt(tag_base)},",
                    f"  capHeight: {tag_cap},",
                    f"  d: \"{tag}\",",
                    "} as const;",
                    "",
                ]
            )
        )
    print(f"wordmark {fmt(width)} x {upm} units, kerned E-C {pairs.get((cmap[ord('E')], cmap[ord('C')]), 0)}")
    print(f"tagline {fmt(tag_width)} x {tag_upm} units")


if __name__ == "__main__":
    main()
