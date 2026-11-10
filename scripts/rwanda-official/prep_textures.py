"""
Every texture of the official Rwanda layout, generated from noise and shapes (nothing is photographed or borrowed).

    ~/.venvs/librecorsa-tracks/bin/python -I prep_textures.py

Writes data/tex/*.png. The Blender scripts load them and the exporter packs them as WebP.
"""
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'tex')
RNG = np.random.default_rng(1328)

# Run-off stripes, outward from the track edge (the published render: yellow, maroon, teal, ochre, then cream asphalt)
RUNOFF_SPAN_M = 64.0                 # the texture covers -4..60 m from the road edge
RUNOFF_NEG_M = 4.0
STRIPES = [(-4.0, (0.10, 0.36, 0.25)),          # inside-of-corner apron: painted green
           (0.0, (0.93, 0.74, 0.12)), (3.0, (0.45, 0.09, 0.11)), (6.0, (0.05, 0.47, 0.44)), (9.0, (0.85, 0.48, 0.13)),
           (12.0, (0.80, 0.77, 0.69))]


def noise(n, beta, seed=None, m=None):
    """Periodic noise with a 1/f^beta spectrum, normalised to zero mean and unit deviation"""
    m = m or n
    rng = np.random.default_rng(seed) if seed is not None else RNG
    f = np.fft.fft2(rng.normal(0, 1, (m, n)))
    fy, fx = np.meshgrid(np.fft.fftfreq(m) * m, np.fft.fftfreq(n) * n, indexing='ij')
    r = np.hypot(fx, fy)
    r[0, 0] = 1
    out = np.real(np.fft.ifft2(f / r ** beta))
    return (out - out.mean()) / out.std()


def blur_wrap(a, s):
    pad = int(s * 3) + 1
    b = np.pad(a, [(pad, pad), (pad, pad)] + [(0, 0)] * (a.ndim - 2), mode='wrap')
    b = cv2.GaussianBlur(b.astype(np.float32), (0, 0), s)
    return b[pad:-pad, pad:-pad]


def save(name, rgb, alpha=None):
    a = np.clip(rgb, 0, 1)
    img = (a * 255 + 0.5).astype(np.uint8)
    if alpha is not None:
        img = np.dstack([img, (np.clip(alpha, 0, 1) * 255 + 0.5).astype(np.uint8)])
    Image.fromarray(img).save(os.path.join(OUT, name + '.png'))
    print('  %-12s %dx%d' % (name, img.shape[1], img.shape[0]))


def grey(v, tint=(1, 1, 1)):
    return v[..., None] * np.array(tint)[None, None]


def asphalt():
    n = 1024                                             # 8 m tile
    fine = RNG.normal(0, 1, (n, n))
    stones = blur_wrap((RNG.uniform(0, 1, (n, n)) > 0.965).astype(np.float32), 0.8) * 9
    v = 0.235 + 0.022 * blur_wrap(fine, 0.7) * 3 + 0.05 * stones + 0.014 * noise(n, 1.6) + 0.006 * fine
    return grey(v, (1.0, 1.0, 1.03))


def pit_asphalt():
    n = 512
    fine = RNG.normal(0, 1, (n, n))
    v = 0.30 + 0.02 * blur_wrap(fine, 0.8) * 3 + 0.018 * noise(n, 1.7) + 0.006 * fine
    return grey(v, (1.0, 1.0, 1.02))


def service():
    """Service road: older, paler asphalt with a darker pair of wheel tracks (5 m across the texture)"""
    n = 512
    fine = RNG.normal(0, 1, (n, n))
    v = 0.33 + 0.02 * blur_wrap(fine, 0.8) * 3 + 0.02 * noise(n, 1.7) + 0.006 * fine
    u = (np.arange(n) + 0.5) / n * 5.0
    wheel = np.exp(-((u - 1.4) / 0.35) ** 2) + np.exp(-((u - 3.6) / 0.35) ** 2)
    return grey(v * (1 - 0.07 * wheel[None, :]), (1.0, 0.99, 0.97))


def runoff():
    w, h = 2048, 256
    d = (np.arange(w) + 0.5) / w * RUNOFF_SPAN_M - RUNOFF_NEG_M
    col = np.zeros((w, 3))
    for start, c in STRIPES:
        col[d >= start] = c
    img = np.repeat(col[None], h, 0)
    wear = 1 + 0.045 * noise(w, 1.5, m=h)[..., None] + 0.03 * blur_wrap(RNG.normal(0, 1, (h, w)), 0.8)[..., None]
    img = img * wear
    # the cream asphalt beyond the stripes: darker seams every 4 m where it was laid in lanes, and tyre scuffs
    cream = d >= STRIPES[-1][0]
    lane = ((d - STRIPES[-1][0]) % 4.0 < 0.06) & cream
    img[:, lane] *= 0.88
    scuff = np.clip(noise(w, 2.2, m=h) - 0.9, 0, 2)[..., None] * cream[None, :, None]
    img = img * (1 - 0.10 * scuff)
    # thin white separators between the stripes, like taped paint edges
    for start, _ in STRIPES[1:]:
        if start <= 0:
            continue
        j = int(round((start + RUNOFF_NEG_M) / RUNOFF_SPAN_M * w))
        img[:, j - 2:j + 2] = img[:, j - 2:j + 2] * 0.35 + 0.65 * 0.9
    return img


def kerb(c0, c1, cycles=2):
    w, h = 512, 128
    u = (np.arange(w) + 0.5) / w * cycles * 2
    k = (np.floor(u) % 2).astype(int)
    col = np.where(k[:, None] == 0, np.array(c0)[None], np.array(c1)[None])
    img = np.repeat(col[None], h, 0)
    dirt = 1 - 0.035 * np.clip(noise(w, 1.2, m=h), -1, 2)[..., None]
    rub = 1 - 0.18 * np.exp(-((np.arange(h) / h - 0.35) / 0.2) ** 2)[:, None, None] * (0.6 + 0.4 * blur_wrap(RNG.uniform(0, 1, (h, w)), 3))[..., None]
    return img * dirt * rub


def tecpro():
    n = 256
    img = np.zeros((n, n, 3))
    img[:] = (0.72, 0.07, 0.11)
    v = (np.arange(n) + 0.5) / n
    img[(v > 0.60) & (v < 0.80)] = (0.92, 0.92, 0.90)             # the white band (image row 0 is the top)
    u = (np.arange(n) + 0.5) / n
    seam = (np.abs(u - 0.0) < 0.012) | (np.abs(u - 1.0) < 0.012) | (np.abs(u - 0.5) < 0.008)
    img[:, seam] *= 0.45
    img[(v < 0.03) | (v > 0.97)] *= 0.6
    return img * (1 + 0.03 * noise(n, 1.4)[..., None])


def grass():
    n = 1024                                             # 6 m tile; neutral, the terrain's vertex colours carry the hue
    blades = blur_wrap(RNG.normal(0, 1, (n, n)), 0.6) * 2.2
    streak = cv2.GaussianBlur(np.pad(RNG.normal(0, 1, (n, n)), 16, mode='wrap').astype(np.float32), (1, 0), sigmaX=0.5, sigmaY=5)[16:-16, 16:-16] * 3
    v = 0.84 + 0.055 * blades + 0.05 * streak + 0.045 * noise(n, 1.8)
    v = v - blur_wrap(v, 24.0) + 0.84                     # nothing slower than a pace: it showed as a 6 m checker from afar
    t = noise(n, 2.0)
    tint = (t - blur_wrap(t, 24.0))[..., None] * np.array([0.012, 0.0, -0.016])[None, None]
    return np.clip(grey(v) + tint, 0, 1)


def gravel():
    n = 512                                              # 4 m tile
    peb = blur_wrap(RNG.normal(0, 1, (n, n)), 1.1) * 4
    v = 0.60 + 0.085 * np.clip(peb, -2, 2) + 0.03 * noise(n, 1.6) + 0.02 * RNG.normal(0, 1, (n, n))
    return grey(v, (1.0, 0.93, 0.80))


def concrete():
    n = 512                                              # 6 m tile, one slab joint each way
    v = 0.66 + 0.03 * noise(n, 1.8) + 0.012 * RNG.normal(0, 1, (n, n))
    v[:3] *= 0.72
    v[:, :3] *= 0.72
    stains = np.clip(noise(n, 2.4), 0.6, 3) - 0.6
    v = v * (1 - 0.05 * stains)
    return grey(v, (1.0, 0.985, 0.955))


def timber():
    n = 512
    lines = cv2.GaussianBlur(np.pad(RNG.normal(0, 1, (n, n)), 32, mode='wrap').astype(np.float32), (0, 0), sigmaX=0.6, sigmaY=22)[32:-32, 32:-32] * 6
    plank = (np.arange(n) % 64 < 2).astype(float)[None, :]
    shade = np.repeat(RNG.uniform(0.86, 1.08, n // 64), 64)[None, :]
    v = (0.50 + 0.07 * lines) * shade * (1 - 0.55 * plank)
    return grey(v, (1.0, 0.70, 0.44))


def thatch():
    n = 512
    straw = cv2.GaussianBlur(np.pad(RNG.normal(0, 1, (n, n)), 32, mode='wrap').astype(np.float32), (0, 0), sigmaX=0.5, sigmaY=14)[32:-32, 32:-32] * 5
    rows = 1 - 0.22 * (np.arange(n) % 64 < 6).astype(float)[:, None]
    v = (0.52 + 0.08 * straw + 0.03 * noise(n, 1.5)) * rows
    return grey(v, (1.0, 0.82, 0.52))


def crowd(occupancy=0.9, seat=(0.60, 0.31, 0.20)):
    """Seated spectators: rows of small coloured heads and shoulders; the empty seats show their terracotta"""
    w, h = 1024, 512
    img = np.zeros((h, w, 3))
    img[:] = (0.16, 0.15, 0.15)
    rows, cols = 16, 64
    palette = np.array([(0.85, 0.82, 0.78), (0.12, 0.35, 0.72), (0.90, 0.75, 0.15), (0.12, 0.50, 0.25), (0.75, 0.12, 0.12),
                        (0.92, 0.92, 0.92), (0.15, 0.15, 0.18), (0.85, 0.45, 0.12), (0.35, 0.60, 0.85)])
    skin = np.array([(0.36, 0.24, 0.17), (0.27, 0.18, 0.13), (0.50, 0.35, 0.25), (0.72, 0.55, 0.43)])
    ch, cw = h // rows, w // cols
    for r in range(rows):
        y0 = r * ch
        img[y0 + ch - 3:y0 + ch] = (0.30, 0.31, 0.33)                 # the step's edge
        for c in range(cols):
            if RNG.uniform() > occupancy:
                img[y0 + 10:y0 + ch - 4, c * cw + 2:c * cw + cw - 2] = np.array(seat) * RNG.uniform(0.9, 1.05)   # an empty seat
                img[y0 + 10:y0 + 14, c * cw + 2:c * cw + cw - 2] *= 1.25                                         # its backrest's top
                continue
            x0 = c * cw + int(RNG.integers(-1, 2))
            shirt = palette[RNG.integers(len(palette))] * RNG.uniform(0.8, 1.0)
            img[y0 + 14:y0 + ch - 3, x0 + 2:x0 + cw - 2] = shirt
            cv2.circle(img, (x0 + cw // 2, y0 + 10), 4, tuple(float(v) for v in skin[RNG.integers(len(skin))]), -1, cv2.LINE_AA)
    return cv2.GaussianBlur(img.astype(np.float32), (0, 0), 0.6)


def stones(n=512, count=420, seed=7):
    """Riprap: fitted stones of uneven grey with dark joints (tiles)"""
    from scipy.spatial import cKDTree
    rng = np.random.default_rng(seed)
    pts = rng.uniform(0, n, (count, 2))
    tiled = np.vstack([pts + (dx, dy) for dx in (-n, 0, n) for dy in (-n, 0, n)])
    gy, gx = np.mgrid[0:n, 0:n]
    d, j = cKDTree(tiled).query(np.c_[gx.ravel() + 0.5, gy.ravel() + 0.5], k=2)
    edge = np.clip((d[:, 1] - d[:, 0]) / 5.0, 0, 1).reshape(n, n)
    tone = rng.uniform(0.75, 1.1, count)[j[:, 0] % count].reshape(n, n)
    v = 0.50 * tone * (0.35 + 0.65 * edge) + 0.03 * noise(n, 1.4)
    return grey(v, (1.0, 0.97, 0.92))


def canopy():
    """Closed woodland from above: round crowns lit from one side, dark gaps between (32 m tile; the mesh's colours carry the hue)"""
    n, count = 512, 58
    rng = np.random.default_rng(31)
    pts = rng.uniform(0, n, (count, 2))
    rad = rng.uniform(44, 84, count)
    tone = rng.uniform(0.80, 1.10, count)
    gy, gx = np.mgrid[0:n, 0:n].astype(np.float32)
    v = np.full((n, n), 0.16, np.float32)
    for (px, py), r, t in zip(pts, rad, tone):
        for dx in (-n, 0, n):
            for dy in (-n, 0, n):
                ux, uy = (gx - px - dx) / r, (gy - py - dy) / r
                q = 1 - ux * ux - uy * uy
                dome = np.sqrt(np.clip(q, 0, 1))
                lit = np.clip(0.80 + 0.30 * (ux - uy), 0.45, 1.15)
                v = np.maximum(v, np.where(q > 0, t * (0.34 + 0.58 * dome) * lit, 0))
    leaf = blur_wrap(RNG.normal(0, 1, (n, n)), 1.1) * 2.6
    v = v * (1 + 0.10 * leaf + 0.07 * noise(n, 1.4))
    tint = noise(n, 2.0)[..., None] * np.array([0.02, 0.0, -0.02])[None, None]
    return np.clip(grey(v, (0.92, 1.0, 0.84)) + tint, 0, 1)


def road():
    """Public road: asphalt with white edge lines and a dashed centre line (7 m across, 12 m along the texture)"""
    w, h = 256, 512
    v = 0.31 + 0.02 * noise(w, 1.7, m=h) + 0.012 * RNG.normal(0, 1, (h, w))
    u = (np.arange(w) + 0.5) / w * 7.0
    wheel = sum(np.exp(-((u - c) / 0.3) ** 2) for c in (0.95, 2.6, 4.4, 6.05))
    img = grey(v * (1 - 0.06 * wheel[None, :]), (1.0, 0.99, 0.97))
    paint = np.array((0.88, 0.88, 0.85))
    for c in (0.3, 6.7):
        img[:, np.abs(u - c) < 0.075] = paint
    y = (np.arange(h) + 0.5) / h * 12.0
    img[np.ix_(y < 3.0, np.abs(u - 3.5) < 0.06)] = paint
    return img


def path():
    """Compacted laterite gravel of the footpaths"""
    n = 256
    v = 0.66 + 0.05 * noise(n, 1.5) + 0.03 * RNG.normal(0, 1, (n, n))
    return grey(v, (1.0, 0.80, 0.56))


def court():
    """A clay court with its lines (30 x 15 m across the texture)"""
    w, h = 512, 256
    v = 0.60 + 0.03 * noise(w, 1.6, m=h)
    img = grey(v, (1.0, 0.52, 0.34))
    sx, sy = w / 30.0, h / 15.0
    def line(x0, y0, x1, y1):
        cv2.line(img, (int(x0 * sx), int(y0 * sy)), (int(x1 * sx), int(y1 * sy)), (0.92, 0.9, 0.86), 2, cv2.LINE_AA)
    x0, x1, y0, y1 = 3.1, 26.9, 2.0, 13.0
    for a, b, c, d in ((x0, y0, x1, y0), (x0, y1, x1, y1), (x0, y0, x0, y1), (x1, y0, x1, y1), (x0, 3.37, x1, 3.37),
                       (x0, 11.63, x1, 11.63), (15, y0, 15, y1), (8.6, 3.37, 8.6, 11.63), (21.4, 3.37, 21.4, 11.63),
                       (8.6, 7.5, 21.4, 7.5)):
        line(a, b, c, d)
    return img


def parking():
    """Car park: bays 2.5 m wide either side of an aisle (10 x 16 m across the texture)"""
    w, h = 320, 512
    v = 0.36 + 0.02 * noise(w, 1.7, m=h) + 0.01 * RNG.normal(0, 1, (h, w))
    img = grey(v)
    paint = (0.86, 0.86, 0.84)
    for k in range(5):
        x = int(round(k * w / 4)) % w
        for y0, y1 in ((0, 5), (11, 16)):
            img[int(y0 / 16 * h):int(y1 / 16 * h), max(x - 1, 0):x + 2] = paint
    for y in (5, 11):
        img[int(y / 16 * h) - 1:int(y / 16 * h) + 1] = paint
    cars = [(0.75, 0.75, 0.78), (0.12, 0.13, 0.15), (0.55, 0.08, 0.08), (0.9, 0.9, 0.9), (0.15, 0.25, 0.45), (0.4, 0.42, 0.45)]
    for k in range(4):                                    # most bays are taken
        for y0, y1 in ((0.4, 4.6), (11.4, 15.6)):
            if RNG.uniform() < 0.72:
                c = np.array(cars[RNG.integers(len(cars))])
                xa, xb = int((k + 0.14) * w / 4), int((k + 0.86) * w / 4)
                ya, yb = int(y0 / 16 * h), int(y1 / 16 * h)
                img[ya:yb, xa:xb] = c
                img[ya + (yb - ya) // 4:ya + (yb - ya) // 4 + (yb - ya) // 6, xa + 3:xb - 3] = c * 0.35      # windscreen
                img[yb - (yb - ya) // 3:yb - (yb - ya) // 3 + (yb - ya) // 8, xa + 3:xb - 3] = c * 0.35
    return img


def screen():
    """A big screen showing a timing tower and a picture"""
    im = Image.new('RGB', (512, 288), (8, 12, 26))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 512, 34], fill=(0, 120, 190))
    d.text((12, 4), 'RWANDA  GRAND PRIX', font=font(22), fill=(255, 255, 255))
    d.rectangle([430, 6, 500, 28], fill=(210, 30, 30))
    d.text((440, 6), 'LIVE', font=font(18), fill=(255, 255, 255))
    cols = [(230, 40, 40), (30, 160, 150), (250, 150, 20), (30, 60, 200), (240, 240, 240), (20, 140, 60), (250, 210, 0),
            (200, 30, 120), (120, 190, 230), (90, 90, 100)]
    for k in range(10):
        y = 44 + k * 24
        d.rectangle([10, y, 150, y + 20], fill=(20, 26, 44))
        d.rectangle([10, y, 16, y + 20], fill=cols[k])
        d.text((22, y + 1), '%2d' % (k + 1), font=font(15), fill=(255, 255, 255))
        d.rectangle([50, y + 6, 50 + 70 - k * 3, y + 14], fill=(170, 175, 190))
    d.rectangle([164, 44, 502, 280], fill=(70, 95, 60))                   # the picture: a car on the track
    d.polygon([(164, 280), (502, 280), (502, 180), (164, 230)], fill=(52, 52, 56))
    d.polygon([(164, 44), (502, 44), (502, 120), (164, 110)], fill=(120, 160, 205))
    d.polygon([(300, 205), (390, 196), (402, 214), (310, 226)], fill=(200, 40, 40))
    d.ellipse([302, 216, 322, 234], fill=(15, 15, 15))
    d.ellipse([382, 206, 402, 224], fill=(15, 15, 15))
    return np.asarray(im).astype(float) / 255


def truck():
    """A race transporter's side: white trailer, a coloured band, dark running gear"""
    w, h = 256, 64
    img = np.full((h, w, 3), (0.9, 0.9, 0.9))
    img[20:30] = (0.05, 0.36, 0.60)
    img[30:33] = (0.96, 0.80, 0.08)
    img[52:] = (0.07, 0.07, 0.08)
    img[:, :2] = img[:, -2:] = (0.5, 0.5, 0.52)
    return img


def helipad():
    w = 256
    img = grey(0.50 + 0.02 * noise(w, 1.6))
    cv2.circle(img, (128, 128), 104, (0.93, 0.85, 0.2), 6, cv2.LINE_AA)
    for a, b in (((92, 72), (92, 184)), ((164, 72), (164, 184)), ((92, 128), (164, 128))):
        cv2.line(img, a, b, (0.93, 0.93, 0.93), 12, cv2.LINE_AA)
    return img


def scaffold():
    """
    The understructure of a temporary stand, seen from outside: galvanised standards, ledgers and braces in front of
    the shade under the deck, with a second row of tubes deeper in. One tile is two bays by two lifts (5 m x 4 m).
    """
    n = 512
    rng = np.random.default_rng(77)
    v = 0.13 + 0.025 * noise(n, 1.6, seed=78)                      # the shade behind
    yy = np.linspace(0, 1, n)[:, None]
    v = v + 0.05 * (1 - np.abs(2 * yy - 1)) ** 2                   # a little light gets in between the ledgers
    img = grey(np.clip(v, 0.06, 0.26), (0.95, 0.97, 1.0)).astype(np.float32)

    def tubes(shift, width, c, braces):
        for dx in (-n, 0, n):
            for dy in (-n, 0, n):
                for x in (0, n // 2):                             # standards
                    cv2.line(img, (x + shift + dx, -n + dy), (x + shift + dx, 2 * n + dy), c, width, cv2.LINE_AA)
                for y in (0, n // 2):                             # ledgers
                    cv2.line(img, (-n + dx, y + shift + dy), (2 * n + dx, y + shift + dy), c, width, cv2.LINE_AA)
                if braces:                                        # one brace per bay, leaning alternately
                    cv2.line(img, (dx, n // 2 + dy), (n // 2 + dx, dy), c, width - 1, cv2.LINE_AA)
                    cv2.line(img, (n // 2 + dx, n // 2 + dy), (n + dx, n + dy), c, width - 1, cv2.LINE_AA)

    tubes(n // 5, 4, (0.30, 0.31, 0.33), False)                   # the row behind, in shade
    img[:] = cv2.GaussianBlur(img, (0, 0), 1.0)
    tubes(0, 7, (0.50, 0.52, 0.55), True)                         # the row in front: its shaded side
    tubes(-1, 3, (0.74, 0.76, 0.78), True)                        # and its lit one
    for x in (0, n // 2, n):                                      # couplers
        for y in (0, n // 2, n):
            cv2.circle(img, (x, y), 7, (0.36, 0.37, 0.40), -1, cv2.LINE_AA)
    img *= (1 + 0.04 * rng.normal(0, 1, (n, n, 1))).astype(np.float32)
    return img


def font(size):
    for p in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc',
              '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def banner(text, bg, fg, w=1024, h=128, bands=True):
    im = Image.new('RGB', (w, h), tuple(int(c * 255) for c in bg))
    d = ImageDraw.Draw(im)
    if bands:                                             # the national colours as an end cap
        for k, c in enumerate(((0, 161, 222), (250, 210, 1), (32, 96, 61))):
            d.rectangle([k * 18, 0, k * 18 + 18, h], fill=c)
            d.rectangle([w - (k + 1) * 18, 0, w - k * 18, h], fill=c)
    f = font(int(h * 0.62))
    box = d.textbbox((0, 0), text, font=f)
    d.text(((w - (box[2] - box[0])) / 2 - box[0], (h - (box[3] - box[1])) / 2 - box[1]), text, font=f, fill=tuple(int(c * 255) for c in fg))
    return np.asarray(im).astype(float) / 255


def board(text, bg=(0.93, 0.93, 0.93), fg=(0.05, 0.05, 0.05)):
    return banner(text, bg, fg, 256, 128, bands=False)


def glass():
    """Curtain wall: dark glazing between pale mullions (one bay 4 m wide, one storey 3.5 m)"""
    n = 256
    v = np.full((n, n, 3), (0.07, 0.11, 0.15))
    refl = (0.5 + 0.5 * np.sin(np.arange(n) / n * 2 * np.pi))[None, :, None]
    v = v * (0.75 + 0.5 * refl) + np.array([0.03, 0.05, 0.07]) * ((np.arange(n) / n)[:, None, None] < 0.45)
    m = np.zeros((n, n), bool)
    m[:5] = m[-5:] = True
    m[:, :4] = m[:, -4:] = True
    m[:, n // 2 - 2:n // 2 + 2] = True
    v[m] = (0.80, 0.81, 0.82)
    return v


def garage():
    """Pit garage front, one bay: a dark open door under a white lintel with a number panel"""
    w, h = 256, 256
    v = np.full((h, w, 3), (0.86, 0.87, 0.88))
    v[70:, 22:w - 22] = (0.05, 0.055, 0.06)
    v[70:, 22:w - 22] += np.linspace(0.10, 0.0, h - 70)[:, None, None] * np.array([1, 1, 1.1])     # light falling on the floor inside
    v[14:54, 22:w - 22] = (0.10, 0.30, 0.55)
    v[:, :6] = v[:, -6:] = (0.55, 0.56, 0.58)
    return v


def main():
    os.makedirs(OUT, exist_ok=True)
    save('asphalt', asphalt())
    save('pit_asphalt', pit_asphalt())
    save('service', service())
    save('runoff', runoff())
    save('kerb', kerb((0.78, 0.08, 0.08), (0.92, 0.92, 0.90)))
    save('kerb_flag', kerb((0.0, 0.50, 0.78), (0.96, 0.80, 0.05), cycles=2))
    save('tecpro', tecpro())
    save('grass', grass())
    save('gravel', gravel())
    save('concrete', concrete())
    save('timber', timber())
    save('thatch', thatch())
    save('crowd', crowd())
    save('seats', crowd(0.4))
    save('rock', stones())
    save('path', path())
    save('court', court())
    save('parking', parking())
    save('screen', screen())
    save('truck', truck())
    save('helipad', helipad())
    save('glass', glass())
    save('garage', garage())
    save('banner_rwanda', banner('RWANDA', (0.96, 0.96, 0.95), (0.03, 0.25, 0.42)))
    save('banner_bugesera', banner('BUGESERA', (0.03, 0.30, 0.47), (0.97, 0.97, 0.95)))
    save('banner_kigali', banner('KIGALI', (0.10, 0.36, 0.25), (0.98, 0.84, 0.10)))
    for d in (50, 100, 150, 200):
        save('board_%d' % d, board(str(d)))
    save('road', road())
    save('canopy', canopy())
    save('scaffold', scaffold())                  # drawn last: it has its own random numbers


if __name__ == '__main__':
    main()
