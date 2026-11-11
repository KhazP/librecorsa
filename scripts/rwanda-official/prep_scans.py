"""
Scanned surfaces for the road, the pit lane and the gravel: assets/textures/scan-*.webp from Poly Haven's CC0 scans
(https://polyhaven.com, 2 m tiles), one colour and one normal map each.

    python prep_scans.py <folder with the scans' 2k jpgs>        # after prep_textures.py

A scan keeps its grain and loses everything else: what varies slower than a third of its tile is taken out (repeated
every 2 m it showed as a checker from the air), and its colour becomes the drawn texture's it stands in for
(data/tex/<name>.png), in linear light, so the circuit keeps the tones it was tuned to. The files it reads are named
as Poly Haven names them: <id>_diff_2k.jpg or <id>_Diffuse.jpg, <id>_nor_gl_2k.jpg or <id>_nor_gl.jpg.
"""
import os
import sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'data', 'tex')
OUT = os.path.join(HERE, 'assets', 'textures')
# scan id, the drawn texture whose colour it takes, pixels of the colour map and of the normal map
SCANS = (('asphalt_track', 'asphalt', 1024, 1024),
         ('asphalt_pit_lane', 'pit_asphalt', 1024, 512),
         ('gravel_floor_02', 'gravel', 1024, 512))


def srgb2lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def find(folder, scan, kinds):
    for k in kinds:
        for name in ('%s_%s_2k.jpg' % (scan, k), '%s_%s.jpg' % (scan, k)):
            p = os.path.join(folder, name)
            if os.path.exists(p):
                return p
    raise SystemExit('no %s map of %s in %s' % (kinds[0], scan, folder))


def blur_wrap(a, sigma):
    pad = int(3 * sigma) + 1
    return cv2.GaussianBlur(np.pad(a, ((pad, pad), (pad, pad), (0, 0)), mode='wrap'), (0, 0), sigma)[pad:-pad, pad:-pad]


def main(folder):
    os.makedirs(OUT, exist_ok=True)
    for scan, drawn, n, nn in SCANS:
        rgb = cv2.imread(find(folder, scan, ('diff', 'Diffuse')), cv2.IMREAD_COLOR)[..., ::-1].astype(np.float32) / 255
        lin = srgb2lin(cv2.resize(rgb, (n, n), interpolation=cv2.INTER_AREA))
        mean = lin.mean((0, 1))
        lin = lin - blur_wrap(lin, n / 6.0) + mean
        want = srgb2lin(cv2.imread(os.path.join(TEX, drawn + '.png'), cv2.IMREAD_COLOR)[..., ::-1].astype(np.float32) / 255).mean((0, 1))
        lin = np.clip(lin, 0, None) * (want / mean)
        out = (lin2srgb(lin) * 255 + 0.5).astype(np.uint8)
        name = 'scan-' + scan.replace('_', '-')
        cv2.imwrite(os.path.join(OUT, name + '.webp'), out[..., ::-1], [cv2.IMWRITE_WEBP_QUALITY, 92])
        nor = cv2.imread(find(folder, scan, ('nor_gl',)), cv2.IMREAD_COLOR)[..., ::-1].astype(np.float32) / 255 * 2 - 1
        nor = cv2.resize(nor, (nn, nn), interpolation=cv2.INTER_AREA)
        nor /= np.maximum(np.linalg.norm(nor, axis=-1, keepdims=True), 1e-6)
        cv2.imwrite(os.path.join(OUT, name + '-nor.webp'), ((nor * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)[..., ::-1], [cv2.IMWRITE_WEBP_QUALITY, 92])
        slope = np.degrees(np.arccos(np.clip(nor[..., 2], -1, 1)))
        print('%-18s colour %s -> %s (linear), contrast %.3f; normal %d px, mean tilt %.1f deg' % (
            name, np.round(mean, 3), np.round(want, 3), float(lin.std() / lin.mean()), nn, float(slope.mean())))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
