"""
Terrain, lake, land cover and tree positions around the official Rwanda layout. Run through prep.py.

The terrain is a set of free points (denser near the track) that Blender triangulates against the corridor's two
boundary loops. Heights are the public terrain model, warped near the track so the ground meets the corridor's edge.
Colours come from a land-cover reading of the satellite view (woodland / bare earth / savanna) mapped to my own
palette: no satellite pixels are shipped.
"""
import os

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter
from scipy.spatial import cKDTree

import ro_design as rd
import ro_site as site
from ro_foot import Foot, NAMES as ADDONS
from prep import DATA, SRC, SAT_M, E0, N0, LAKE_ASL, RELIEF, ground, sat_px, sstep

RNG = np.random.default_rng(20261109)

PALETTE = {                      # sRGB
    # (the game's light washes a khaki ground out to sand: the open land keeps to greens, as the published render has it)
    'savanna': (0.34, 0.44, 0.20), 'savanna_green': (0.30, 0.43, 0.18), 'savanna_dry': (0.42, 0.45, 0.23), 'trackside': (0.36, 0.48, 0.22),
    'wood': (0.21, 0.30, 0.14), 'laterite': (0.60, 0.29, 0.19), 'mud': (0.40, 0.35, 0.27), 'lakebed': (0.20, 0.24, 0.22),
    'marsh': (0.30, 0.43, 0.19), 'rock': (0.50, 0.48, 0.44), 'lawn': (0.38, 0.52, 0.22),
    'far_field': (0.33, 0.44, 0.19), 'far_crop': (0.28, 0.41, 0.16), 'far_fallow': (0.42, 0.44, 0.23), 'far_wood': (0.19, 0.29, 0.12)}
WATER_PPM = 0.5                  # the water raster: pixels per metre
ADDON_BED = 0.30                 # the ground lies this far under the add-on roads
# The skyline. The game draws 5.5 km, so the hills across the lakes (further away than that) would never show and the
# land would end at the water: beyond RIM_R0 of the site's centre the ground climbs to a ridge that stands inside the
# draw distance from anywhere on the lap. Where the real relief is higher it stays.
RIM_R0, RIM_R1 = 3350.0, 4150.0  # where the climb starts and where the crest is reached (m from the site's centre)
RIM_H, RIM_VAR = 150.0, 20.0     # the crest's height above the lake and how far it wanders (the lap tops out at 86 m)
RIM_RINGS = ((3450, 150), (3600, 140), (3750, 130), (3900, 110), (4030, 90), (4150, 75), (4280, 85), (4420, 110), (4600, 150))
FAR_FROM_M, FAR_FULL_M = 350.0, 850.0   # beyond the lap's box the ground takes the far country's colours over this span
FAR_CANOPY_CELL = 64.0           # the woodland sheet of the far country


def hexrgb(c):
    return np.array(c, float)


def prune(P, r, tree=None, rng=None):
    """Drop points within r of an accepted set, then thin the rest so no two are closer than r"""
    if len(P) == 0:
        return P
    if tree is not None:
        d, _ = tree.query(P)
        P = P[d >= r]
    if len(P) < 2:
        return P
    order = (rng or RNG).permutation(len(P))
    P = P[order]
    pairs = cKDTree(P).query_pairs(r, output_type='ndarray')
    alive = np.ones(len(P), bool)
    for a, b in pairs[np.argsort(pairs[:, 1])]:
        if alive[a] and alive[b]:
            alive[b] = False
    return P[alive]


def remap(img, px, py, mode, value=0.0):
    """cv2.remap for long point lists (it refuses more than 32k rows at once)"""
    out = []
    for a in range(0, len(px), 30000):
        out.append(cv2.remap(img, px[a:a + 30000].astype(np.float32).reshape(-1, 1), py[a:a + 30000].astype(np.float32).reshape(-1, 1),
                             cv2.INTER_LINEAR, borderMode=mode, borderValue=value))
    return np.concatenate(out, 0)


def resample_closed(P, h):
    seg = np.hypot(*(np.roll(P, -1, 0) - P).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.arange(0, cum[-1], h)
    j = np.clip(np.searchsorted(cum, t, side='right') - 1, 0, len(P) - 1)
    f = ((t - cum[j]) / np.maximum(seg[j], 1e-9))[:, None]
    return P[j] * (1 - f) + P[(j + 1) % len(P)] * f


def big_patches(mask, least):
    """The mask without its connected patches of fewer than `least` cells"""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=4)
    small = np.nonzero(stats[:, cv2.CC_STAT_AREA] < least)[0]
    out = mask.copy()
    out[np.isin(lab, small)] = 0
    return out


def terrain():
    T = rd.Design()
    n = T.n
    ADD = np.load(os.path.join(DATA, 'addons.npz'))
    FOOT = Foot(ADD)
    cloud = np.vstack([ADD[k + '_cloud'] for k in ADDONS]).astype(float)      # the add-on roads' surfaces
    ctree_add = cKDTree(cloud[:, :2])
    dem_raw = np.fromfile(os.path.join(SRC, 'dem14.f32'), np.float32).reshape(1280, 1280).astype(float)
    dem = gaussian_filter(np.maximum(dem_raw - LAKE_ASL, -2.0) * RELIEF, 2.4)

    # ---- corridor boundary (must match what the track builder makes) ----
    i2 = np.arange(0, n, rd.MESH_STEP)
    loops, nrm = [], []
    for side in (0, 1):
        sg = rd.SIDE_SIGN[side]
        P = T.world(i2, sg * T.corridor(side)[i2])
        P[:, 2] = FOOT.settle(P[:, :2], T.edge_z[side][i2])      # beside and under the add-on roads the edge moves with them
        loops.append(P)
        nrm.append(np.c_[sg * T.rx[i2], sg * T.ry[i2]])
    B = np.vstack(loops)
    nb = len(B)

    # ---- raster of the corridor ----
    ppm = 2.0
    x0, y1 = T.x.min() - 400, T.y.max() + 400
    W, H = int((T.x.max() - T.x.min() + 800) * ppm), int((T.y.max() - T.y.min() + 800) * ppm)

    def pix(P):
        return np.c_[(P[:, 0] - x0) * ppm, (y1 - P[:, 1]) * ppm]

    cor = np.zeros((H, W), np.uint8)
    cv2.fillPoly(cor, [np.int32(np.round(pix(loops[1])))], 255)
    cv2.fillPoly(cor, [np.int32(np.round(pix(loops[0])))], 0)
    cv2.polylines(cor, [np.int32(np.round(pix(loops[0]))), np.int32(np.round(pix(loops[1])))], True, 255, 1)
    dcor = cv2.distanceTransform(255 - cor, cv2.DIST_L2, 5) / ppm          # metres to the corridor (0 inside)

    def cor_dist(P):
        q = pix(P)
        inside = (q[:, 0] >= 1) & (q[:, 0] < W - 2) & (q[:, 1] >= 1) & (q[:, 1] < H - 2)
        d = np.full(len(P), 1e4)
        qi = np.int32(np.round(q[inside]))
        d[inside] = dcor[qi[:, 1], qi[:, 0]]
        return d

    # ---- water: the satellite's lake outline, the pool the render adds, less the marsh; and the lagoon ----
    cx, cy = (T.x.min() + T.x.max()) / 2, (T.y.min() + T.y.max()) / 2
    half = 4400
    wx0, wy1, wn = cx - half, cy + half, int(2 * half * WATER_PPM)

    def wpix(P):
        P = np.asarray(P, float)
        return np.c_[(P[:, 0] - wx0) * WATER_PPM, (wy1 - P[:, 1]) * WATER_PPM]

    def fill(polys):
        m = np.zeros((wn, wn), np.uint8)
        for poly in polys:
            cv2.fillPoly(m, [np.int32(np.round(wpix(poly)))], 1)
        return m

    def signed(mask):
        d = (cv2.distanceTransform(mask, cv2.DIST_L2, 5) - cv2.distanceTransform(1 - mask, cv2.DIST_L2, 5)) / WATER_PPM
        return cv2.GaussianBlur(d.astype(np.float32), (0, 0), 1.5)

    wm = cv2.imread(os.path.join(SRC, 'sat_water_clean.png'), 0)
    gx, gy = np.meshgrid(wx0 + (np.arange(wn) + 0.5) / WATER_PPM, wy1 - (np.arange(wn) + 0.5) / WATER_PPM)
    px, py = sat_px(gx, gy)
    lake = (cv2.remap(wm, px.astype(np.float32), py.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT) > 127).astype(np.uint8)
    del gx, gy, px, py
    marsh_m = fill(site.MARSH)
    lake = (lake | fill(site.LAKE_ADD)) & (1 - marsh_m)
    sdf = signed(lake)
    sdf_lag = signed(fill([site.LAGOON]))
    sdf_marsh = signed(marsh_m)

    def sample(R, P, value=-500.0):
        q = wpix(P) - 0.5
        return remap(R, q[:, 0], q[:, 1], cv2.BORDER_CONSTANT, value)[:, 0]

    def water_sdf(P):
        return sample(sdf, P)

    def lagoon_sdf(P):
        return sample(sdf_lag, P)

    cw = np.array(site.CAUSEWAY, float)
    cseg = np.hypot(*np.diff(cw[:, :2], axis=0).T)
    ct = np.r_[0, np.cumsum(cseg)]
    cu = np.arange(0, ct[-1], 1.0)
    cline = np.c_[np.interp(cu, ct, cw[:, 0]), np.interp(cu, ct, cw[:, 1]), np.interp(cu, ct, cw[:, 2])]
    ctree = cKDTree(cline[:, :2])

    def causeway(P):
        """Distance to the causeway's centre line and its top height there"""
        d, j = ctree.query(P)
        return d, cline[j, 2]

    # ---- free points ----
    acc = [B[:, :2]]

    def accept(P, r, rng=None):
        P = prune(P, r, cKDTree(np.vstack(acc)), rng)
        acc.append(P)
        return len(P)

    counts = {}
    ring = []
    for side in (0, 1):
        for d, h in ((3.0, 4.0), (7.5, 5.0), (14.0, 7.0), (24.0, 9.0), (38.0, 12.0)):
            P = resample_closed(loops[side][:, :2] + nrm[side] * d, h)
            P = P[cor_dist(P) >= 0.72 * d]
            ring.append((P, 0.62 * h))
    counts['rings'] = sum(accept(P, r) for P, r in ring)
    # shoreline: three contours so the water's edge is a clean line; the same for the lagoon and the marsh's edge
    shore = []
    for R, levels, h0, h1 in ((sdf, (-9.0, 0.0, 9.0), 9.0, 12.0), (sdf_lag, (-5.0, 0.0, 6.0), 6.0, 7.0), (sdf_marsh, (0.0, 12.0), 12.0, 14.0)):
        for lev in levels:
            cs = cv2.findContours((R > lev).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0]
            for c in cs:
                if len(c) < 12:
                    continue
                c = c[:, 0].astype(float)
                c = cv2.GaussianBlur(np.r_[c[-8:], c, c[:8]].astype(np.float32), (1, 0), 2.0)[8:-8] if len(c) > 30 else c
                P = np.c_[wx0 + (c[:, 0] + 0.5) / WATER_PPM, wy1 - (c[:, 1] + 0.5) / WATER_PPM]
                P = resample_closed(P, h0 if lev == 0 else h1)
                near = np.hypot(P[:, 0] - cx, P[:, 1] - cy) < 1500
                shore.append(P[near & (cor_dist(P) > 6)])
    # the causeway's crest and its two shoulders
    nrm_c = np.c_[-np.gradient(cline[:, 1]), np.gradient(cline[:, 0])]
    nrm_c /= np.hypot(*nrm_c.T)[:, None]
    for off in (0.0, -site.CAUSEWAY_W / 2, site.CAUSEWAY_W / 2):
        shore.append((cline[:, :2] + nrm_c * off)[::5])
    counts['shore'] = accept(np.vstack(shore), 4.5)
    # level ground under the buildings: an even 7 m grid across each pad
    pads = []
    for name, (px_, py_, ha, hc, yaw, z, blend) in site.PADS.items():
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        ga, gc = np.meshgrid(np.arange(-ha, ha + 1, 7.0), np.arange(-hc, hc + 1, 7.0))
        pads.append(np.c_[px_ + ga.ravel() * ca - gc.ravel() * sa, py_ + ga.ravel() * sa + gc.ravel() * ca])
    # and along the graded strips (the bridge's roads, the concourse)
    beds = []
    for name, bp, bhw, blend, road in site.beds(T):
        seg = np.r_[0, np.cumsum(np.hypot(*np.diff(bp[:, :2], axis=0).T))]
        u = np.arange(0, seg[-1], 1.0)
        line = np.c_[np.interp(u, seg, bp[:, 0]), np.interp(u, seg, bp[:, 1]), np.interp(u, seg, bp[:, 2])]
        nl = np.c_[-np.gradient(line[:, 1]), np.gradient(line[:, 0])]
        nl /= np.hypot(*nl.T)[:, None]
        beds.append((name, line, cKDTree(line[:, :2]), bhw, blend))
        for off in np.arange(-bhw, bhw + 0.1, bhw / 2):
            pads.append((line[:, :2] + nl * off)[::6])
    pads = np.vstack(pads)
    counts['pads'] = accept(pads[cor_dist(pads) > 6], 4.5)
    ca = cloud[::7, :2]
    counts['addons'] = accept(ca[cor_dist(ca) > 2.5], 3.2)

    def grid(h, half_x, half_y, jit):
        gx, gy = np.meshgrid(np.arange(cx - half_x, cx + half_x + 1, h), np.arange(cy - half_y, cy + half_y + 1, h))
        gx[1::2] += h / 2
        P = np.c_[gx.ravel(), gy.ravel()]
        return P + RNG.uniform(-jit, jit, P.shape)

    hx, hy = (T.x.max() - T.x.min()) / 2, (T.y.max() - T.y.min()) / 2
    P = grid(12, hx + 240, hy + 240, 2.5)
    dc = cor_dist(P)
    counts['near12'] = accept(P[(dc > 42) & (dc < 170)], 7.5)
    P = grid(22, hx + 240, hy + 240, 5)
    counts['near22'] = accept(P[cor_dist(P) >= 165], 13)
    for nm, h, ext, inner, jit, r in (('mid', 45, 750, 240, 9, 26), ('far', 120, 2600, 750, 25, 70), ('outer', 280, half, 2600, 0, 160)):
        P = grid(h, hx + ext, hy + ext, jit)
        out = (np.abs(P[:, 0] - cx) > hx + inner) | (np.abs(P[:, 1] - cy) > hy + inner)
        counts[nm] = accept(P[out], r)
    n_base = sum(len(a) for a in acc[1:])               # the points every earlier build had: the shared noise is drawn for them
    V_RNG = np.random.default_rng(4150)                  # the far country has its own generator, so nothing nearer in changes
    rim = []
    for r_, h_ in RIM_RINGS:
        a_ = np.arange(0, 2 * np.pi, h_ / r_) + V_RNG.uniform(0, 1)
        rim.append(np.c_[cx + r_ * np.cos(a_), cy + r_ * np.sin(a_)] + V_RNG.uniform(-0.2 * h_, 0.2 * h_, (len(a_), 2)))
    counts['rim'] = accept(np.vstack(rim), 48, V_RNG)
    waves = [(k, V_RNG.uniform(0.6, 1.0) / k ** 0.7, V_RNG.uniform(0, 2 * np.pi)) for k in range(2, 13)]
    wsum = sum(a for _, a, _ in waves)
    bumps = [(np.cos(t) * 2 * np.pi / w, np.sin(t) * 2 * np.pi / w, a, V_RNG.uniform(0, 2 * np.pi))
             for t, w, a in zip(V_RNG.uniform(0, np.pi, 7), V_RNG.uniform(380, 950, 7), V_RNG.uniform(3.5, 8.0, 7))]

    def rim_height(P):
        """The ridge that closes the view: nothing inside RIM_R0, the crest from RIM_R1 on, a little lower behind it"""
        d = P[:, :2] - np.array([cx, cy])
        r, th = np.hypot(d[:, 0], d[:, 1]), np.arctan2(d[:, 1], d[:, 0])
        h = RIM_H + np.clip(RIM_VAR * sum(a * np.sin(k * th + p) for k, a, p in waves) / wsum * 2.2, -18, 30)
        h = h + np.clip(sum(a * np.sin(P[:, 0] * kx + P[:, 1] * ky + p) for kx, ky, a, p in bumps), -12, 22)
        return h * sstep((r - RIM_R0) / (RIM_R1 - RIM_R0)) * (1 - 0.2 * sstep((r - RIM_R1 - 200) / 700))

    def patch(P, wave_m, seed, n=9):
        """Smooth noise in 0..1 with features about wave_m across (sums of plane waves: no generator of ours is drawn)"""
        g = np.random.default_rng(seed)
        v = np.zeros(len(P))
        for t, w, ph in zip(g.uniform(0, np.pi, n), g.uniform(0.6 * wave_m, 1.6 * wave_m, n), g.uniform(0, 2 * np.pi, n)):
            v += np.sin(P[:, 0] * np.cos(t) * 2 * np.pi / w + P[:, 1] * np.sin(t) * 2 * np.pi / w + ph)
        return 0.5 + 0.5 * np.tanh(v / np.sqrt(n / 2) * 0.9)

    F = np.vstack(acc[1:])
    print('terrain points:', counts, '=> %d free + %d boundary' % (len(F), nb))

    # ---- heights: terrain model, warped onto the corridor edge ----
    bs = B[::3]
    delta_b = bs[:, 2] - ground(dem, bs[:, 0], bs[:, 1])
    print('edge minus smoothed ground: %.1f..%.1f m' % (delta_b.min(), delta_b.max()))
    zf = ground(dem, F[:, 0], F[:, 1])
    dn, _ = cKDTree(bs[:, :2]).query(F)
    nearm = dn < 260
    Fn = F[nearm]
    dl = np.zeros(len(Fn))
    for a in range(0, len(Fn), 4000):
        d = np.hypot(Fn[a:a + 4000, None, 0] - bs[None, :, 0], Fn[a:a + 4000, None, 1] - bs[None, :, 1])
        w = 1 / np.maximum(d, 0.5) ** 3
        dl[a:a + 4000] = (w * delta_b[None]).sum(1) / w.sum(1)
    fade = sstep(1 - (dn[nearm] - 2.0) / np.maximum(48.0, 5.5 * np.abs(dl)))
    warp = np.zeros(len(F))
    warp[nearm] = fade * dl
    zf = zf + warp
    dcf = cor_dist(F)
    # level pads: each takes the mean of its own ground unless a height is given
    pad_w = np.zeros(len(F))
    for name, (px_, py_, ha, hc, yaw, z, blend) in site.PADS.items():
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        da, dc_ = (F[:, 0] - px_) * ca + (F[:, 1] - py_) * sa, -(F[:, 0] - px_) * sa + (F[:, 1] - py_) * ca
        out = np.hypot(np.maximum(np.abs(da) - ha, 0), np.maximum(np.abs(dc_) - hc, 0))
        w = sstep(1 - out / blend) * sstep((dcf - 1.0) / 8.0)             # never moves the corridor's edge
        zp = float(z) if z is not None else float(np.median(zf[out < 1e-6])) if (out < 1e-6).any() else None
        if zp is None:
            continue
        zf = zf * (1 - w) + zp * w
        pad_w = np.maximum(pad_w, w)
        print('pad %-10s at %.1f m' % (name, zp))
    for name, line, tree_, bhw, blend in beds:
        d, j = tree_.query(F)
        w = sstep(1 - (d - bhw) / blend) * sstep((dcf - 1.0) / 8.0)
        zf = zf * (1 - w) + (line[j, 2] - 0.12) * w
        pad_w = np.maximum(pad_w, w * (d < bhw + 2))
    # the add-on roads lie on the ground: under and beside them it takes their shape
    da, ja = ctree_add.query(F)
    w = sstep(1 - (da - 1.5) / 10.0)
    zf = zf * (1 - w) + (cloud[ja, 2] - ADDON_BED) * w
    pad_w = np.maximum(pad_w, w * (da < 3.0))
    ws = water_sdf(F)
    wl = lagoon_sdf(F)
    wmar = sample(sdf_marsh, F)
    # marsh: flat, just above the water
    zf = np.where(wmar > 0, site.MARSH_Z + 0.25 * sstep(wmar / 40.0), zf)
    # lagoon: its bed inside, and no ground lower than its banks around it
    zf = np.where(wl > 0, site.LAGOON_Z - np.minimum(2.2, 0.3 + 0.2 * wl),
                  np.where(wl > -45, np.maximum(zf, site.LAGOON_Z + 0.35 + np.clip(-wl, 0, 45) * 0.03), zf))
    # the causeway's crest
    dcw, ctop = causeway(F)
    kc = sstep(1 - (dcw - site.CAUSEWAY_W / 2) / 5.0)
    zf = zf * (1 - kc) + (ctop - 0.35) * kc
    # lake: its bed inside (the causeway's flank falls into it), a gentle shore outside
    on_cw = dcw < site.CAUSEWAY_W / 2 + 0.5
    zf = np.where(on_cw, zf, np.where(ws > 0, -np.minimum(2.6, 0.3 + 0.2 * ws), np.maximum(zf, 0.3 + np.clip(-ws, 0, 30) * 0.02)))
    rr = np.hypot(F[:, 0] - cx, F[:, 1] - cy)
    z_rim = rim_height(F)
    lifted = (rr > RIM_R0) & (z_rim > zf)
    zf = np.where(lifted, z_rim, zf)
    print('rim: %d points lifted (%d of them out of the lake), crest %.0f..%.0f m' % (
        lifted.sum(), (lifted & (ws > 0)).sum(), zf[(rr > RIM_R1) & (rr < RIM_R1 + 200)].min(), zf[(rr > RIM_R1) & (rr < RIM_R1 + 200)].max()))
    zb_w = water_sdf(B)
    zb_l = lagoon_sdf(B)
    print('boundary points in the lake: %d, in the lagoon: %d (nearest water %.0f m, lagoon %.0f m); free points in water: %d' % (
        (zb_w > 0).sum(), (zb_l > 0).sum(), -zb_w.max(), -zb_l.max(), ((ws > 0) | (wl > 0)).sum()))

    # ---- land cover ----
    sat = cv2.imread(os.path.join(SRC, 'sat15.jpg'))
    hsv = cv2.cvtColor(sat, cv2.COLOR_BGR2HSV).astype(np.float32)
    hh, ss, vv = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    wood = ((hh > 38) & (vv < 100)).astype(np.float32)
    green = ((hh > 34) & (vv >= 100)).astype(np.float32)
    bare = ((hh < 24) & (ss > 78) & (vv > 85)).astype(np.float32)
    wood_d = cv2.GaussianBlur(wood, (0, 0), 3.0)          # woodland as patches, not pixels
    cls = np.stack([cv2.GaussianBlur(c, (0, 0), 2.0) for c in (wood, green, bare)], -1)
    print('land cover: woodland %.0f%%, green %.0f%%, bare earth %.0f%%' % (wood.mean() * 100, green.mean() * 100, bare.mean() * 100))

    def cover(P):
        px, py = sat_px(P[:, 0], P[:, 1])
        return remap(cls, px, py, cv2.BORDER_REFLECT).reshape(len(P), 3)

    # The render's own cover where it reaches (trees, lawns), read from its rectified copy
    ortho = cv2.imread(os.path.join(SRC, 'render_ortho.png'))
    ox0, oy1, oppm = site.ORTHO
    oh = cv2.cvtColor(ortho, cv2.COLOR_BGR2HSV).astype(np.float32)
    ovalid = (ortho.sum(2) > 20).astype(np.float32)
    green = (oh[..., 0] > 28) & (oh[..., 0] < 95)
    otree = cv2.GaussianBlur((green & (oh[..., 1] > 55) & (oh[..., 2] < 118)).astype(np.float32) * ovalid, (0, 0), 5.0)
    olawn = cv2.GaussianBlur((green & (oh[..., 1] > 45) & (oh[..., 2] >= 118)).astype(np.float32) * ovalid, (0, 0), 6.0)
    ovalid = cv2.erode(ovalid, np.ones((41, 41), np.uint8))
    ocls = np.stack([otree, olawn, cv2.GaussianBlur(ovalid, (0, 0), 12.0)], -1)

    def render_cover(P):
        """Tree cover, lawn and how far the render's view can be trusted (0..1) at each point"""
        q = np.c_[(P[:, 0] - ox0) * oppm - 0.5, (oy1 - P[:, 1]) * oppm - 0.5]
        return remap(ocls, q[:, 0], q[:, 1], cv2.BORDER_CONSTANT, 0.0).reshape(len(P), 3)

    def colour(P, d_cor, wsd, extra_green=0.0, n_shared=None):
        m = cover(P)
        rc = render_cover(P)
        seen = rc[:, 2:3]
        n_shared = len(P) if n_shared is None else n_shared
        nz = np.r_[RNG.normal(0, 1, n_shared), V_RNG.normal(0, 1, len(P) - n_shared)]
        base = hexrgb(PALETTE['savanna'])[None] * (1 + 0.05 * nz[:, None])
        col = base + (hexrgb(PALETTE['savanna_dry'])[None] - base) * (0.55 * sstep((patch(P, 210.0, 14) - 0.55) / 0.25))[:, None]   # drier swathes
        col = col + (hexrgb(PALETTE['savanna_green']) - col) * np.clip(m[:, 1:2] * 1.3, 0, 1)
        col = col + (hexrgb(PALETTE['laterite']) - col) * np.clip(m[:, 2:3] * 0.9, 0, 0.16) * (1 - seen)
        wood = np.clip((m[:, 0:1] - 0.25) * 1.8, 0, 0.9) * (1 - seen) + np.clip((rc[:, 0:1] - 0.2) * 1.8, 0, 0.85) * seen
        col = col + (hexrgb(PALETTE['wood']) - col) * wood
        col = col + (hexrgb(PALETTE['lawn']) - col) * np.clip(rc[:, 1:2] * 1.6, 0, 0.8) * seen
        ts = np.clip(sstep(1 - d_cor / 32.0) * 0.85 + extra_green, 0, 1)[:, None]     # landscaped ground by the track
        col = col + (hexrgb(PALETTE['trackside']) * (1 + 0.04 * nz[:, None]) - col) * ts
        mar = sample(sdf_marsh, P)
        col = col + (hexrgb(PALETTE['marsh']) * (1 + 0.06 * nz[:, None]) - col) * sstep((mar + 6.0) / 10.0)[:, None]
        mud = (sstep(1 - np.abs(wsd) / 14.0) * (mar < -4))[:, None]
        col = col + (hexrgb(PALETTE['mud']) - col) * mud * 0.8
        lag = sample(sdf_lag, P)
        col = col + (hexrgb(PALETTE['mud']) - col) * sstep(1 - np.abs(lag) / 6.0)[:, None] * 0.7
        dcw_, _ = causeway(P)
        col = col + (hexrgb(PALETTE['rock']) * (1 + 0.08 * nz[:, None]) - col) * sstep(1 - (dcw_ - site.CAUSEWAY_W / 2 - 1.0) / 4.0)[:, None]
        col = np.where((wsd[:, None] > 3) | (lag[:, None] > 2), hexrgb(PALETTE['lakebed'])[None], col)
        return np.clip(col, 0, 1)

    cf = colour(F, dcf, ws, np.clip(np.abs(warp) / 6.0, 0, 0.6) * (1 - pad_w), n_shared=n_base)
    # the far country: fields and woodlots in deeper greens than the venue's savanna (the haze pales whatever lies there)
    box = np.maximum(np.abs(F[:, 0] - cx) - hx, np.abs(F[:, 1] - cy) - hy)
    p1, p2, p3 = patch(F, 520.0, 11), patch(F, 300.0, 12), patch(F, 700.0, 13)
    fc = hexrgb(PALETTE['far_field'])[None] + (hexrgb(PALETTE['far_crop']) - hexrgb(PALETTE['far_field']))[None] * p1[:, None]
    fc = fc + (hexrgb(PALETTE['far_fallow'])[None] - fc) * sstep((p3 - 0.70) / 0.15)[:, None] * 0.7
    fc = fc + (hexrgb(PALETTE['far_wood'])[None] - fc) * sstep((p2 - 0.56) / 0.12)[:, None] * 0.85
    wfar = sstep((box - FAR_FROM_M) / (FAR_FULL_M - FAR_FROM_M)) * (1 - render_cover(F)[:, 2]) * (ws < 1.0) * (wmar < 0)
    wfar = np.where(lifted, 1.0, 0.85 * wfar)
    cf = cf + (fc - cf) * wfar[:, None]
    shore = lifted & (zf < 3.0)                            # the new shore under the ridge: reeds and mud
    cf[shore] = cf[shore] + (hexrgb(PALETTE['marsh'])[None] - cf[shore]) * 0.6
    cb = colour(B[:, :2], np.zeros(nb), zb_w)

    # ---- lake surface: a 40 m grid kept where there is water ----
    def water_grid(h, x_lo, x_hi, y_lo, y_hi, field, level, margin):
        """Quads of an h-metre grid wherever `field` (a signed distance) says water, reaching `margin` under the banks"""
        GX, GY = np.meshgrid(np.arange(x_lo, x_hi + 1, h), np.arange(y_lo, y_hi + 1, h))
        wv = field(np.c_[GX.ravel(), GY.ravel()]).reshape(GX.shape)
        cell = (np.maximum.reduce([wv[:-1, :-1], wv[1:, :-1], wv[:-1, 1:], wv[1:, 1:]]) > -margin)
        vid = -np.ones(GX.shape, int)
        use = np.zeros(GX.shape, bool)
        for dy, dx in ((0, 0), (1, 0), (0, 1), (1, 1)):
            use[dy:GX.shape[0] - 1 + dy, dx:GX.shape[1] - 1 + dx] |= cell
        vid[use] = np.arange(use.sum())
        r, c = np.where(cell)
        return np.c_[GX[use], GY[use], np.full(use.sum(), level)], np.c_[vid[r, c], vid[r, c + 1], vid[r + 1, c + 1], vid[r + 1, c]]

    lake_v, lake_f = water_grid(40.0, cx - half, cx + half, cy - half, cy + half, water_sdf, 0.0, 6.0)
    lr = np.hypot(lake_v[:, 0] - cx, lake_v[:, 1] - cy)
    lake_f = lake_f[(lr[lake_f] < RIM_R0 + 90).any(1)]      # the ridge stands where the water ran on
    used = np.unique(lake_f)
    renum = np.zeros(len(lake_v), int)
    renum[used] = np.arange(len(used))
    lake_v, lake_f = lake_v[used], renum[lake_f]
    lg = np.array(site.LAGOON, float)
    lag_v, lag_f = water_grid(6.0, lg[:, 0].min() - 12, lg[:, 0].max() + 12, lg[:, 1].min() - 12, lg[:, 1].max() + 12,
                              lagoon_sdf, site.LAGOON_Z, 1.5)
    print('lake: %d quads, lagoon: %d quads' % (len(lake_f), len(lag_f)))
    lake_f = np.vstack([lake_f, lag_f + len(lake_v)])
    lake_v = np.vstack([lake_v, lag_v])

    # ---- trees ----
    def wood_at(P):
        px, py = sat_px(P[:, 0], P[:, 1])
        return remap(wood_d, px, py, cv2.BORDER_REFLECT)[:, 0]

    P = grid(8.5, hx + 900, hy + 900, 3.6)
    dc = cor_dist(P)
    far = np.maximum(np.abs(P[:, 0] - cx) - hx, np.abs(P[:, 1] - cy) - hy)
    wd = wood_at(P)
    rc = render_cover(P)
    seen = rc[:, 2]
    thin = np.clip(1.15 - far / 640.0, 0.20, 1.0)                 # full density by the track, sparse on the horizon
    p_sat = np.clip((wd - 0.40) * 2.4, 0, 0.80) * thin           # the satellite's woodland, beyond the render's view
    p_ren = np.clip((rc[:, 0] - 0.18) * 2.6, 0, 0.92)            # the render's groves, where it shows the ground
    p_wood = p_sat * (1 - seen) + p_ren * seen
    wd = wd * (1 - seen) + (0.35 + 0.5 * rc[:, 0]) * seen
    p_scat = 0.016 * thin
    p_shrub = 0.11 * np.clip(1.0 - dc / 260.0, 0, 1)            # low scrub in the near field only
    mar = sample(sdf_marsh, P)
    u = RNG.uniform(0, 1, len(P))
    dcw_, _ = causeway(P)
    in_pad = np.zeros(len(P), bool)
    for name, (px_, py_, ha, hc, yaw, z, blend) in site.PADS.items():
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        da, dc_ = (P[:, 0] - px_) * ca + (P[:, 1] - py_) * sa, -(P[:, 0] - px_) * sa + (P[:, 1] - py_) * ca
        in_pad |= (np.abs(da) < ha + 4) & (np.abs(dc_) < hc + 4)
    for name, line, tree_, bhw, blend in beds:
        in_pad |= tree_.query(P)[0] < bhw + 3
    rpts = []
    for name, wdt, kind, pl in site.ROADS:                      # nothing grows on the roads
        pl = np.array(pl, float)
        seg = np.r_[0, np.cumsum(np.hypot(*np.diff(pl, axis=0).T))]
        ur = np.arange(0, seg[-1], 2.0)
        rpts.append(np.c_[np.interp(ur, seg, pl[:, 0]), np.interp(ur, seg, pl[:, 1]), np.full(len(ur), wdt / 2 + 2.5)])
    rpts = np.vstack(rpts)
    dr, jr = cKDTree(rpts[:, :2]).query(P)
    in_pad |= dr < rpts[jr, 2]
    for tx_, ty_, tr_ in site.TERRACES:
        in_pad |= np.hypot(P[:, 0] - tx_, P[:, 1] - ty_) < tr_ + 14
    in_pad |= ctree_add.query(P)[0] < 6.0                       # nor on the add-on roads
    free = (dc > 7.0) & (water_sdf(P) < -5.0) & (lagoon_sdf(P) < -4.0) & (dcw_ > site.CAUSEWAY_W / 2 + 2) & ~in_pad
    reed = free & (mar > 2.0)                                    # papyrus across the marsh
    free &= mar < -3.0
    is_tree = free & (u < np.maximum(p_wood, p_scat))
    is_shrub = (free & ~is_tree & (u < np.maximum(p_wood, p_scat) + p_shrub)) | (reed & (u < 0.62))
    # a row of tall trees down each side of the infield's roads, as the render has its palm alleys
    rows = []
    for name, wdt, kind_, pl in site.ROADS:
        if name not in site.ALLEYS:
            continue
        pl = site.chaikin(np.array(pl, float), 2)
        seg = np.r_[0, np.cumsum(np.hypot(*np.diff(pl, axis=0).T))]
        ur = np.arange(6.0, seg[-1] - 4.0, 13.0)
        c = np.c_[np.interp(ur, seg, pl[:, 0]), np.interp(ur, seg, pl[:, 1])]
        c2 = np.c_[np.interp(ur + 1.0, seg, pl[:, 0]), np.interp(ur + 1.0, seg, pl[:, 1])]
        nrm_r = np.c_[-(c2 - c)[:, 1], (c2 - c)[:, 0]]
        nrm_r /= np.hypot(*nrm_r.T)[:, None]
        rows += [c + nrm_r * (wdt / 2 + 4.5), c - nrm_r * (wdt / 2 + 4.5)]
    rows = np.vstack(rows)
    rows = rows[(cor_dist(rows) > 9.0) & (water_sdf(rows) < -5.0) & (lagoon_sdf(rows) < -4.0)]
    TP = np.vstack([P[is_tree], rows, P[is_shrub]])
    nt = int(is_tree.sum()) + len(rows)
    dense = np.r_[wd[is_tree] > 0.58, np.ones(len(rows), bool), np.zeros(is_shrub.sum(), bool)]
    kind = np.where(dense, np.where(RNG.uniform(0, 1, len(TP)) < 0.5, 1, 0), 0)
    kind[int(is_tree.sum()):nt] = 1
    kind[nt:] = 2
    scale = np.where(kind == 1, RNG.uniform(1.25, 1.9, len(TP)), np.where(kind == 0, RNG.uniform(0.8, 1.35, len(TP)), RNG.uniform(0.8, 1.9, len(TP))))
    dct = np.r_[dc[is_tree], cor_dist(rows), dc[is_shrub]]
    print('trees: %d (acacia %d, tall %d, bush %d), within 60 m of the track %d' % (
        len(TP), (kind == 0).sum(), (kind == 1).sum(), (kind == 2).sum(), (dct < 60).sum()))

    # ---- canopy: where the woodland is closed and far from the track, one mesh stands in for the crowns ----
    ch = 18.0
    gxc, gyc = np.meshgrid(np.arange(cx - hx - 900, cx + hx + 901, ch), np.arange(cy - hy - 900, cy + hy + 901, ch))
    Pc = np.c_[gxc.ravel(), gyc.ravel()]
    rcc = render_cover(Pc)
    wc = wood_at(Pc) * (1 - rcc[:, 2]) + (0.35 + 0.5 * rcc[:, 0]) * rcc[:, 2]
    okc = (wc > 0.56) & (cor_dist(Pc) > 230.0) & (water_sdf(Pc) < -14.0) & (lagoon_sdf(Pc) < -14.0) & (sample(sdf_marsh, Pc) < -8.0)
    for name, (px_, py_, ha, hc, yaw, z, blend) in site.PADS.items():
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        da, dc_ = (Pc[:, 0] - px_) * ca + (Pc[:, 1] - py_) * sa, -(Pc[:, 0] - px_) * sa + (Pc[:, 1] - py_) * ca
        okc &= ~((np.abs(da) < ha + 24) & (np.abs(dc_) < hc + 24))
    drc, jrc = cKDTree(rpts[:, :2]).query(Pc)
    okc &= drc > rpts[jrc, 2] + 16
    cm = okc.reshape(gxc.shape).astype(np.uint8)
    cm = cv2.morphologyEx(cv2.morphologyEx(cm, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cm = big_patches(cm, 40)                                       # a handful of cells on their own reads as a boulder
    print('canopy: %d of %d cells (%.0f ha)' % (cm.sum(), cm.size, cm.sum() * ch * ch / 1e4))

    # ---- and the far country's woodland: the satellite's where it shows any, woodlots and wooded ridges beyond ----
    fh = FAR_CANOPY_CELL
    R_far = RIM_R1 + 420.0
    gxf, gyf = np.meshgrid(np.arange(cx - R_far, cx + R_far + 1, fh), np.arange(cy - R_far, cy + R_far + 1, fh))
    Pf = np.c_[gxf.ravel(), gyf.ravel()]
    rf = np.hypot(Pf[:, 0] - cx, Pf[:, 1] - cy)
    boxf = np.maximum(np.abs(Pf[:, 0] - cx) - hx, np.abs(Pf[:, 1] - cy) - hy)
    lots = patch(Pf, 300.0, 12)                                    # the same field that darkens the ground
    ridge = sstep((rf - RIM_R0 - 150) / 500.0)                     # the rim is wooded more than the plain
    wsf = water_sdf(Pf)
    okf = (lots * (0.75 + 0.5 * wood_at(Pf)) > 0.69 - 0.12 * ridge) & (boxf > 905.0) & (rf < R_far) & ((wsf < -40.0) | (rf > RIM_R0 + 200))
    okf &= ~((rf > RIM_R0 - 60) & (rf <= RIM_R0 + 200) & (wsf > -60.0))                # not on the new shore
    fm = okf.reshape(gxf.shape).astype(np.uint8)
    fm = cv2.morphologyEx(cv2.morphologyEx(fm, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    fm = big_patches(fm, 14)
    print('far canopy: %d of %d cells (%.0f ha), satellite woodland there %.2f' % (fm.sum(), fm.size, fm.sum() * fh * fh / 1e4, wood_at(Pf)[boxf > 905].mean()))

    np.savez(os.path.join(DATA, 'terrain.npz'), bnd=B, bnd_col=cb, free=np.c_[F, zf], free_col=cf, n_loop=len(i2),
             can_far=np.array([gxf[0, 0], gyf[0, 0], fh]), can_far_mask=fm,
             lake_v=lake_v, lake_f=lake_f, lagoon_z=site.LAGOON_Z, trees=np.c_[TP, kind, scale, RNG.uniform(0, 6.283, len(TP))],
             raster=np.array([x0, y1, ppm, W, H]),
             can=np.array([gxc[0, 0], gyc[0, 0], ch]), can_mask=cm)
    cv2.imwrite(os.path.join(DATA, 'corridor_mask.png'), cor)

    # ---- preview ----
    pp = 0.5
    X0, X1, Y0, Y1 = cx - hx - 700, cx + hx + 700, cy - hy - 700, cy + hy + 700
    Wp, Hp = int((X1 - X0) * pp), int((Y1 - Y0) * pp)
    img = np.zeros((Hp, Wp, 3), np.uint8)
    A = np.vstack([np.c_[F, zf], B])
    C = np.vstack([cf, cb])
    q = np.c_[(A[:, 0] - X0) * pp, (Y1 - A[:, 1]) * pp]
    m = (q[:, 0] > 0) & (q[:, 0] < Wp - 1) & (q[:, 1] > 0) & (q[:, 1] < Hp - 1)
    sub = cv2.Subdiv2D((0, 0, Wp, Hp))
    pts = q[m].astype(np.float32)
    cols = C[m]
    zz = A[m, 2]
    tr = cKDTree(pts)
    for p_ in pts:
        sub.insert((float(p_[0]), float(p_[1])))
    for t in sub.getTriangleList():
        tri = t.reshape(3, 2)
        if (tri < 0).any() or (tri[:, 0] > Wp).any() or (tri[:, 1] > Hp).any():
            continue
        _, j = tr.query(tri)
        a, b, c_ = np.c_[tri, zz[j]]
        nn = np.cross(b - a, c_ - a)
        nn = nn / (np.linalg.norm(nn) + 1e-9)
        if nn[2] < 0:
            nn = -nn
        sh = np.clip(0.45 + 0.75 * (nn @ np.array([-0.45, -0.45, 0.77])), 0.2, 1.3)      # image y is down
        col = np.clip(cols[j].mean(0) * sh, 0, 1)[::-1] * 255
        cv2.fillConvexPoly(img, np.int32(tri), col.tolist(), cv2.LINE_AA)
    qc = np.int32(np.c_[(loops[0][:, 0] - X0) * pp, (Y1 - loops[0][:, 1]) * pp])
    qd = np.int32(np.c_[(loops[1][:, 0] - X0) * pp, (Y1 - loops[1][:, 1]) * pp])
    cv2.fillPoly(img, [qd], (70, 70, 70))
    cv2.fillPoly(img, [qc], (0, 0, 0))
    # refill the infield (it was painted over by the outer loop fill)
    inf = np.zeros((Hp, Wp), np.uint8)
    cv2.fillPoly(inf, [qc], 255)
    img2 = img.copy()
    for t in sub.getTriangleList():
        tri = t.reshape(3, 2)
        cen = tri.mean(0)
        if not (0 <= cen[0] < Wp and 0 <= cen[1] < Hp) or not inf[int(cen[1]), int(cen[0])]:
            continue
        _, j = tr.query(tri)
        a, b, c_ = np.c_[tri, zz[j]]
        nn = np.cross(b - a, c_ - a)
        nn = nn / (np.linalg.norm(nn) + 1e-9)
        if nn[2] < 0:
            nn = -nn
        sh = np.clip(0.45 + 0.75 * (nn @ np.array([-0.45, -0.45, 0.77])), 0.2, 1.3)
        cv2.fillConvexPoly(img2, np.int32(tri), (np.clip(cols[j].mean(0) * sh, 0, 1)[::-1] * 255).tolist(), cv2.LINE_AA)
    for k, col in ((0, (40, 110, 40)), (1, (30, 70, 30)), (2, (60, 120, 80))):
        tq = np.int32(np.c_[(TP[kind == k, 0] - X0) * pp, (Y1 - TP[kind == k, 1]) * pp])
        for t in tq:
            cv2.circle(img2, (int(t[0]), int(t[1])), 2, col, -1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(DATA, 'debug_terrain.png'), img2)
    print('preview %dx%d' % (Wp, Hp))
