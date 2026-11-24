"""
Numeric design of the official Rwanda layout: reads the surveyed centreline (src/cl.npz), the terrain model and the
lake mask, and writes everything the Blender scripts need into data/.

    ~/.venvs/librecorsa-tracks/bin/python -I prep.py [design|terrain|all]

Nothing here comes from a game mod: the centreline is my own reconstruction of the published renders, the ground is
the public terrain model, and every texture is generated.
"""
import json
import os
import sys

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d, map_coordinates, minimum_filter1d
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
DATA = os.path.join(HERE, 'data')
sys.path.insert(0, HERE)
import ro_design as rd  # noqa: E402
import ro_site as site  # noqa: E402

E0, N0 = -86.0, 391.0          # Blender origin in the survey frame (east, north)
LAKE_ASL = 1328.0
RELIEF = 1.0
SAT_M = 4.774                   # metres per satellite pixel
N_ST = 5860                    # stations, one metre apart (the lap is 5,858.5 m: 0.9997 m a station)

# name, start, end, direction, descriptive name
# (number 0: a kink that gets kerbs and run-off but no number)
CORNERS = [
    (1, 379, 512, 'L', 'Plateau Kink'), (2, 719, 925, 'R', 'The Bowl'), (3, 1169, 1271, 'R', 'Climb'),
    (4, 1362, 1479, 'L', 'Ridge Hairpin'), (5, 1531, 1631, 'R', 'Ridge Kink'), (6, 1670, 1762, 'L', 'Summit'),
    (7, 2808, 2942, 'L', 'West Hill Hairpin'), (8, 3068, 3305, 'R', 'Forest Crest'), (0, 3402, 3454, 'R', 'Forest Kink'),
    (9, 3687, 3902, 'L', 'Savanna'), (10, 3902, 3996, 'L', 'South Hairpin'), (11, 4169, 4403, 'R', 'Lakeside'),
    (12, 4403, 4621, 'R', 'Kidogo Esses'), (13, 4625, 4761, 'L', 'Kidogo Esses'), (14, 4768, 4847, 'R', 'Kidogo Esses'),
    (15, 4865, 5096, 'L', 'Kidogo Esses'), (16, 5105, 5190, 'R', 'Kidogo Esses'),
    (0, 5251, 5376, 'L', 'Grandstand Kink'), (17, 5438, 5533, 'L', 'Grandstand Hairpin')]

PIT_S0, PIT_LEN = 5606, 600     # the pit lane leaves the track here and rejoins PIT_LEN metres on
# Where the published render shows more paved run-off than the approach speed alone asks for
T2_APEX = 890                   # where Turn 2's banking peaks
SECTOR_ENDS = (1805, 4013)
RUNOFF_SCALE = {11: 3.1, 12: 2.4, 13: 1.7, 14: 2.2, 15: 2.4, 16: 2.4, 17: 1.5}
RUNOFF_END = {17: 5522}          # Turn 17's run-off closes before the road bridge over its exit


# ---- ring helpers ---------------------------------------------------------------------------------------------------
S = np.arange(N_ST, dtype=float)


def sstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def win(a, b, ramp):
    """1 inside [a, b] on the ring (b may wrap past the start), easing to 0 over `ramp` metres outside"""
    length = (b - a) % N_ST
    u = (S - a) % N_ST
    out = np.where(u <= length, 0.0, np.minimum(u - length, N_ST - u))
    return sstep(1 - out / max(ramp, 1e-6))


def gs(a, sigma):
    return gaussian_filter1d(a, sigma, mode='wrap')


def cone_dilate(a, rate):
    """Grey dilation with a cone: every value spreads outward, falling `rate` per metre"""
    out = a.copy()
    for _ in range(2):
        for i in range(N_ST):
            out[i] = max(out[i], out[i - 1] - rate)
        for i in range(N_ST - 1, -1, -1):
            out[i] = max(out[i], out[(i + 1) % N_ST] - rate)
    return out


def inside_dist(mask):
    """How far each True station is from the nearest False one (0 where False), along the ring"""
    d = np.where(mask, 1e9, 0.0)
    for _ in range(2):
        for i in range(N_ST):
            d[i] = min(d[i], d[i - 1] + 1)
        for i in range(N_ST - 1, -1, -1):
            d[i] = min(d[i], d[(i + 1) % N_ST] + 1)
    return d


# ---- terrain model --------------------------------------------------------------------------------------------------
def load_dem():
    dem = np.fromfile(os.path.join(SRC, 'dem14.f32'), np.float32).reshape(1280, 1280).astype(float)
    rel = np.maximum(dem - LAKE_ASL, -2.0) * RELIEF
    return gaussian_filter(rel, 1.3)


def dem_rc(X, Y):
    sx = 1093 + (np.asarray(X) + E0) / SAT_M
    sy = 878 - (np.asarray(Y) + N0) / SAT_M
    return sy / 2 + 256, sx / 2 + 256


def ground(dem, X, Y):
    r, c = dem_rc(X, Y)
    return map_coordinates(dem, [r, c], order=1, mode='nearest')


def sat_px(X, Y):
    return 1093 + (np.asarray(X) + E0) / SAT_M, 878 - (np.asarray(Y) + N0) / SAT_M


# =====================================================================================================================
def design():
    cl = np.load(os.path.join(SRC, 'cl.npz'))
    x, y, z = cl['E'] - E0, cl['N'] - N0, cl['z'].copy()
    kap, v, g = cl['kap'].copy(), cl['v'].copy(), cl['g'].copy()
    # Tangent from the points themselves (periodic central difference), so that offsets are exactly normal
    dx, dy = np.roll(x, -1) - np.roll(x, 1), np.roll(y, -1) - np.roll(y, 1)
    ln = np.hypot(dx, dy)
    tx, ty = dx / ln, dy / ln
    th = np.unwrap(np.arctan2(ty, tx))
    rx, ry = ty, -tx
    print('heading vs survey: max diff %.4f rad' % np.max(np.abs(np.angle(np.exp(1j * (th - cl['th']))))))
    dem = load_dem()
    zd = ground(dem, x, y)
    print('ground under the centreline: mine %.1f..%.1f, survey %.1f..%.1f, rms diff %.2f' % (
        zd.min(), zd.max(), cl['zd'].min(), cl['zd'].max(), np.sqrt(np.mean((zd - cl['zd']) ** 2))))
    print('design minus ground: %.1f..%.1f m (rms %.1f)' % ((z - zd).min(), (z - zd).max(), np.sqrt(np.mean((z - zd) ** 2))))

    # ---- width ----
    width = 12 + 3 * win(PIT_S0, 545, 80) + 2 * win(1792, 2844, 80)
    hw = width / 2

    # ---- banking: signed cross slope e, + = left side higher ----
    for num, a, b, d, _ in CORNERS:
        idx = rd.wrap_range(a, b, N_ST)
        assert np.sign(np.mean(kap[idx])) == (1 if d == 'L' else -1), (num, a, b, d)
    ks = gs(kap, 4)
    R = 1 / np.maximum(np.abs(ks), 1e-6)
    corner = np.abs(ks) > 1 / 650
    mag = np.where(corner, 0.04 + 0.02 * np.clip((120 - R) / 75, 0, 1), 0.0)
    d2 = np.minimum((S - T2_APEX) % N_ST, (T2_APEX - S) % N_ST)
    t2 = np.interp(d2, [0, 25, 60, 90, 140], [0.125, 0.125, 0.06, 0.04, 0.0])
    mag = np.where(win(CORNERS[1][1] - 70, CORNERS[1][2] + 70, 1) > 0.5, np.maximum(mag, t2), mag)
    e0 = -np.sign(ks) * mag
    lp = cone_dilate(np.maximum(e0, 0), 0.00175)
    lneg = cone_dilate(np.maximum(-e0, 0), 0.00175)
    ed = lp - lneg
    # Straights keep a 2 % crossfall, falling the way the nearer corner is banked
    far_p, far_n = cone_dilate(np.maximum(e0, 0), 1e-5), cone_dilate(np.maximum(-e0, 0), 1e-5)
    cidx = np.where(corner)[0]
    near = cidx[np.argmin(np.minimum((S[:, None] - cidx[None]) % N_ST, (cidx[None] - S[:, None]) % N_ST), 1)]
    sgn_near = np.sign(e0[near])
    del far_p, far_n
    e = np.where(np.abs(ed) > 0.02, ed, np.where(np.abs(ed) > 1e-4, np.sign(ed) * 0.02, 0.02 * sgn_near))
    e = gs(e, 9)
    # No corner is ever off-camber: from R 400 down the inward fall is at least what the radius asks for (4 % by R 200)
    req = 0.04 * sstep((np.abs(ks) - 1 / 400) / (1 / 200 - 1 / 400))
    inw = np.maximum(e * -np.sign(ks), req)
    e = gs(np.where(req > 0, -np.sign(ks) * inw, e), 3)
    bank = np.arctan(e)
    tight = np.abs(ks) > 1 / 190
    inward = e * -np.sign(ks)
    print('banking: %.1f%%..%.1f%%, twist max %.4f/m (%.3f deg/m), least inward camber in corners %.1f%%' % (
        e.min() * 100, e.max() * 100, np.max(np.abs(np.gradient(e))), np.degrees(np.max(np.abs(np.gradient(bank)))),
        inward[tight].min() * 100))

    # ---- run-off, gravel, verge ----
    pw, gw = np.zeros((2, N_ST)), np.zeros((2, N_ST))
    w_in, tec, cf = np.zeros((2, N_ST)), np.zeros((2, N_ST)), np.zeros((2, N_ST))
    turn = np.zeros(N_ST, int)
    rows = []
    for num, a, b, d, name in CORNERS:
        out = 1 if d == 'L' else 0
        idx = rd.wrap_range(a, b, N_ST)
        v_app = v[rd.wrap_range(a - 150, a, N_ST)].max()
        v_c = v[idx].min()
        D = float(np.clip(0.0075 * (v_app ** 2 - v_c ** 2), 10, 56) * RUNOFF_SCALE.get(num, 1.0))    # wide, paved and painted
        G = 10.0 if D >= 40 else 0.0
        end = RUNOFF_END.get(num, b + 30)
        wo = win(a - 60, end, 45 if num not in RUNOFF_END else 34)
        pw[out] = np.maximum(pw[out], D * wo)
        gw[out] = np.maximum(gw[out], G * wo)
        if D >= 20:
            tec[out] = np.maximum(tec[out], win(a - 40, min(b + 10, end + 16) if num in RUNOFF_END else b + 10, 1))
        if D >= 34:                                  # debris fence behind the barrier of the big stops
            cf[out] = np.maximum(cf[out], win(a - 30, min(b + 20, end + 16) if num in RUNOFF_END else b + 20, 1))
        wi = win(a - 15, b + 15, 20)
        w_in[1 - out] = np.maximum(w_in[1 - out], wi)
        if num:
            turn[idx] = num
        apex = idx[np.argmax(np.abs(ks[idx]))]
        rows.append((num, name, d, int(apex), 1 / abs(ks[apex]), v_app * 3.6, v_c * 3.6, D, G))
    print('corner  apex   R    v_app v_c   paint gravel')
    for r in rows:
        print('  T%-2d %s %5d %5.0f  %4.0f %4.0f  %4.1f %4.1f  %s' % (r[0], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[1]))
    apron = 2.2 * w_in > pw                 # the strip inside a corner: painted green, not striped
    pw = np.maximum(pw, 2.2 * w_in)
    gb = np.maximum(6.0 - pw - gw, 2.5) + 4.0 * w_in
    pw, gw, gb = gs(pw, 6), gs(gw, 6), gs(gb, 6)
    ga, pr, sl = np.zeros((2, N_ST)), np.zeros((2, N_ST)), np.zeros((2, N_ST))
    sv, sr = np.zeros((2, N_ST)), np.zeros((2, N_ST))
    bk = np.full((2, N_ST), 4.0)
    pu0 = np.where(apron, -4.0, 0.0)        # where the stripe pattern starts (-4 = green apron, 14 = straight into the cream)
    wallvis = np.ones((2, N_ST))
    fence = np.zeros((2, N_ST))

    # ---- pit lane (left of the main straight) ----
    u = (S - PIT_S0) % N_ST
    inpit = u <= PIT_LEN
    um = np.minimum(u, PIT_LEN - u)         # distance to the nearer end
    k_ramp = sstep(um / 30)                 # the pit road opens out of the track edge
    k_wedge = sstep((um - 25) / 70)         # then eases away from it behind a grass wedge
    k_box = sstep((um - 95) / 15)           # then widens to the full pit lane in front of the garages
    k_wall = sstep((um - 95) / 10)          # the apron between the track and the pit wall takes over from the wedge
    L = 0
    keep = np.where(inpit, 1 - sstep(um / 20), 1.0)       # what is left of the generic left-side bands
    pw[L] = pw[L] * keep + np.where(inpit, 3.0 * k_wall, 0)
    ga[L] = np.where(inpit, 3.5 * k_wedge - 3.0 * k_wall, 0)
    pr[L] = np.where(inpit, 5.5 * k_ramp + 10.5 * k_box, 0)
    gw[L] = gw[L] * keep
    gb[L] = gb[L] * keep + np.where(inpit, 1.5 * (1 - sstep(um / 20)) * 0 + 1.5 * sstep(um / 20) * (1 - k_box), 0)
    pu0[L] = np.where(inpit, np.where(k_wall > 0, 14.0, 0.0), pu0[L])
    sl[L] = np.where(inpit, 70.0 * sstep((um - 100) / 30), 0)
    wallvis[L] = np.where(inpit & (um > 108), 0.0, 1.0)
    pitwall = np.where(inpit, (um >= 95).astype(float), 0.0)
    # ---- grandstand terrace on the right of the main straight ----
    Rr = 1
    stand = win(site.TERRACE[0], site.TERRACE[1], 30)
    sl[Rr] = np.maximum(sl[Rr], 34.0 * stand)
    gb[Rr] = np.where(stand > 0, gb[Rr] * (1 - stand) + np.minimum(gb[Rr], 4.5) * stand, gb[Rr])
    fence[Rr] = (win(PIT_S0, 400, 1) > 0.5).astype(float)
    fence[L] = pitwall
    # ---- service road behind the barrier, both sides, except along the pits and the grandstand terrace ----
    road_on = [1 - win(PIT_S0 - 50, PIT_S0 + PIT_LEN + 50, 30), 1 - win(site.TERRACE[0] - 50, site.TERRACE[1] + 50, 30)]
    for side in (0, 1):
        sv[side] = 2.5 * road_on[side]
        sr[side] = 5.0 * road_on[side]

    # ---- room: never reach past the midline to the next piece of track, nor past a corner's centre ----
    tree = cKDTree(np.c_[x, y])
    kmax = np.array([np.abs(ks[rd.wrap_range(i - 15, i + 15, N_ST)]).max() for i in range(N_ST)])
    lim = np.zeros((2, N_ST))
    for side in (0, 1):
        sg = rd.SIDE_SIGN[side]
        cmax = np.full(N_ST, 160.0)
        alive = np.ones(N_ST, bool)
        for c in np.arange(3.0, 160.0, 1.0):
            dd, _ = tree.query(np.c_[x + sg * rx * c, y + sg * ry * c])
            bad = alive & (dd < c - 0.6)
            cmax[bad] = c - 1.0
            alive &= ~bad
        cl_ = cmax - 3.0
        inside = (np.sign(ks) == -sg) & (np.abs(ks) > 1 / 400)      # this side is the inside of a bend
        cl_ = np.where(inside, np.minimum(cl_, 0.62 / np.maximum(kmax, 1e-6)), cl_)
        cl_ = minimum_filter1d(cl_, 25, mode='wrap')
        lim[side] = np.minimum(gs(cl_, 6), cl_ + 1.0)
    short = 0
    for side in (0, 1):
        for it in range(3):
            tot = hw + pw[side] + ga[side] + pr[side] + gw[side] + gb[side] + sl[side] + sv[side] + sr[side] + bk[side]
            ex = np.maximum(tot - lim[side], 0)
            for arr, mn in ((sr, 0.0), (sv, 0.0), (sl, 0.0), (gw, 0.0), (pw, 0.0), (gb, 1.5), (bk, 2.0)):
                cut = np.minimum(ex, np.maximum(arr[side] - mn, 0))
                arr[side] -= cut
                ex -= cut
            short = max(short, ex.max())
        # a service road is whole or absent: where the room squeezed it, it ends (tapering over a few metres)
        whole = cone_dilate((sr[side] < 4.6).astype(float), 1 / 12.0) < 0.01
        sr[side] = np.where(whole, 5.0, 0.0)
        sv[side] = np.where(whole, np.maximum(sv[side], 1.0), 0.0)
        for arr in (sl, gw, pw, gb, bk, sv, sr):
            arr[side] = np.maximum(gs(arr[side], 3), 0)
        for it in range(2):                         # the smoothing must not push the corridor past its room
            tot = hw + pw[side] + ga[side] + pr[side] + gw[side] + gb[side] + sl[side] + sv[side] + sr[side] + bk[side]
            ex = np.maximum(tot - lim[side], 0)
            for arr, mn in ((sv, 0.0), (gw, 0.0), (pw, 0.0), (gb, 1.5), (bk, 2.0)):
                cut = np.minimum(ex, np.maximum(arr[side] - mn, 0))
                arr[side] -= cut
                ex -= cut
    print('room: left %.0f..%.0f m, right %.0f..%.0f m; worst shortfall %.2f m' % (
        lim[0].min(), lim[0].max(), lim[1].min(), lim[1].max(), short))
    for nm, arr in (('paint', pw), ('gravel', gw), ('verge', gb), ('slab', sl), ('road', sr)):
        print('  %-6s left %.1f..%.1f  right %.1f..%.1f' % (nm, arr[0].min(), arr[0].max(), arr[1].min(), arr[1].max()))
    pi = np.where(inpit)[0]
    print('pit stretch: slab %.0f..%.0f m, left corridor %.0f..%.0f m, room %.0f..%.0f m' % (
        sl[0][pi].min(), sl[0][pi].max(), (hw + pw[0] + ga[0] + pr[0] + gw[0] + gb[0] + sl[0] + sv[0] + sr[0] + bk[0])[pi].min(),
        (hw + pw[0] + ga[0] + pr[0] + gw[0] + gb[0] + sl[0] + sv[0] + sr[0] + bk[0])[pi].max(), lim[0][pi].min(), lim[0][pi].max()))
    for side in (0, 1):
        print('  service road %s: %d m of the lap' % ('LR'[side], (sr[side] > 2.5).sum()))

    # ---- kerbs ----
    kerb = np.zeros((2, N_ST))
    kin = gs((np.abs(ks) >= 1 / 230).astype(float), 1) > 0.01
    kin = cone_dilate(kin.astype(float), 1 / 8.0) > 0.01
    for side in (0, 1):
        sg = rd.SIDE_SIGN[side]
        m = kin & (np.sign(ks) == -sg)
        for num, a, b, d, _ in CORNERS:
            out = 1 if d == 'L' else 0
            if out != side:
                continue
            idx = rd.wrap_range(a, b, N_ST)
            rmin = 1 / np.abs(ks[idx]).max()
            m[rd.wrap_range(b - 25, b + 40, N_ST)] = True
            if rmin < 150:
                m[rd.wrap_range(a - 30, a + 6, N_ST)] = True
        if side == 0:
            m[rd.wrap_range(PIT_S0 - 2, PIT_S0 + PIT_LEN + 2, N_ST)] = False
        kerb[side] = np.clip(inside_dist(m) / 14.0, 0, 1)
    print('kerbs: left %d m, right %d m' % ((kerb[0] > 0).sum(), (kerb[1] > 0).sum()))

    # ---- sectors, zones ----
    sec = np.where(S < SECTOR_ENDS[0], 1, np.where(S < SECTOR_ENDS[1], 2, 3))

    np.savez(os.path.join(DATA, 'design.npz'), s=S, x=x, y=y, z=z, th=th, kap=ks, tx=tx, ty=ty, bank=bank, width=width,
             v=v, g=g, pw=pw, ga=ga, pr=pr, gw=gw, gb=gb, sl=sl, sv=sv, sr=sr, bk=bk, pu0=pu0, kerb=kerb, wallvis=wallvis,
             fence=fence, cf=cf, tec=tec, pitwall=pitwall, turn=turn, sec=sec, lim=lim, edge_z=np.zeros((2, N_ST)))
    T = rd.Design()
    # The height the terrain takes over at: the design cross-section, pulled at most 1.5 m toward the real ground
    edge_z = np.zeros((2, N_ST))
    for side in (0, 1):
        c = T.corridor(side)
        P = T.world(np.arange(N_ST), rd.SIDE_SIGN[side] * c)
        gz = ground(dem, P[:, 0], P[:, 1])
        edge_z[side] = gs(P[:, 2] + np.clip(gz - P[:, 2], -1.5, 1.5), 4)
        print('corridor edge %s: ground minus design %.1f..%.1f m' % ('LR'[side], (gz - P[:, 2]).min(), (gz - P[:, 2]).max()))
    d = dict(np.load(os.path.join(DATA, 'design.npz')))
    d['edge_z'] = edge_z
    np.savez(os.path.join(DATA, 'design.npz'), **d)
    T = rd.Design()

    # ---- boundary loops must not touch themselves or each other ----
    loops = []
    for side in (0, 1):
        i = np.arange(0, N_ST, 2)
        P = T.world(i, rd.SIDE_SIGN[side] * T.corridor(side)[i])[:, :2]
        loops.append(P)
        t2_ = cKDTree(P)
        pairs = t2_.query_pairs(1.2, output_type='ndarray')
        gap = np.abs(pairs[:, 0] - pairs[:, 1])
        gap = np.minimum(gap, len(P) - gap)
        bad = pairs[gap > 12]
        step = np.hypot(*(np.roll(P, -1, 0) - P).T)
        print('loop %s: %d pts, step %.2f..%.2f m, %d near-touching pairs %s' % (
            'LR'[side], len(P), step.min(), step.max(), len(bad), (bad[:6] * 2).tolist()))
    dd, _ = cKDTree(loops[0]).query(loops[1])
    print('left/right loops: closest approach %.1f m' % dd.min())
    debug_png(T, dem)
    # ---- the road sections off the built lap: outer Turn 1, outer Turn 8, the link ----
    import ro_addon
    ro_addon.build(T, lambda px, py: ground(dem, px, py))
    ro_addon.plan_png(T, os.path.join(DATA, 'debug_addon_%s.png'))


BAND_BGR = {'road': (52, 50, 48), 'pw': (150, 205, 225), 'ga': (70, 140, 90), 'pr': (95, 95, 95), 'gw': (140, 180, 200),
            'gb': (70, 150, 100), 'sl': (200, 200, 205), 'sv': (66, 135, 100), 'sr': (110, 108, 106), 'bk': (60, 120, 110)}


def debug_png(T, dem, path=None, ppm=1.0):
    x0, x1, y0, y1 = T.x.min() - 260, T.x.max() + 260, T.y.min() - 260, T.y.max() + 260
    W, H = int((x1 - x0) * ppm), int((y1 - y0) * ppm)
    gx, gy = np.meshgrid(x0 + (np.arange(W) + 0.5) / ppm, y1 - (np.arange(H) + 0.5) / ppm)
    zg = ground(dem, gx, gy)
    sx, sy = np.gradient(zg)
    shade = np.clip(0.75 - 2.2 * (sx * 0.7 + sy * 0.7) * ppm, 0.35, 1.0)
    img = (np.stack([shade * 120, shade * 160, shade * 150], -1)).astype(np.uint8)
    wm = cv2.imread(os.path.join(SRC, 'sat_water_clean.png'), 0)
    px, py = sat_px(gx, gy)
    wat = cv2.remap(wm, px.astype(np.float32), py.astype(np.float32), cv2.INTER_LINEAR) > 127
    img[wat] = (150, 110, 60)
    for lev in range(10, 120, 10):
        cs = cv2.findContours(((zg > lev) * 255).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)[0]
        cv2.drawContours(img, cs, -1, (90, 120, 110), 1)

    def pix(P):
        return np.stack([(P[..., 0] - x0) * ppm, (y1 - P[..., 1]) * ppm], -1)

    i = np.arange(0, T.n + 1, 4) % T.n
    for side in (0, 1):
        sg = rd.SIDE_SIGN[side]
        e = T.band_edges(side)[i] + T.width[i][:, None] / 2
        for k, nm in enumerate(rd.BANDS):
            A = pix(T.world(i, sg * e[:, k])[:, :2])
            B = pix(T.world(i, sg * e[:, k + 1])[:, :2])
            for j in range(len(i) - 1):
                if e[j, k + 1] - e[j, k] < 0.05 and e[j + 1, k + 1] - e[j + 1, k] < 0.05:
                    continue
                cv2.fillConvexPoly(img, np.int32([A[j], A[j + 1], B[j + 1], B[j]]), BAND_BGR[nm], cv2.LINE_AA)
        Wl = pix(T.world(i, sg * T.wall_offset(side)[i])[:, :2])
        cv2.polylines(img, [np.int32(Wl)], False, (30, 30, 200), 1, cv2.LINE_AA)
        K = pix(T.world(i, sg * (T.width[i] / 2 + 0.6))[:, :2])
        for j in range(len(i) - 1):
            if T.kerb[side][i[j]] > 0.5:
                cv2.line(img, tuple(np.int32(K[j])), tuple(np.int32(K[j + 1])), (40, 40, 230), 2, cv2.LINE_AA)
    A = pix(T.world(i, -T.width[i] / 2)[:, :2])
    B = pix(T.world(i, T.width[i] / 2)[:, :2])
    for j in range(len(i) - 1):
        cv2.fillConvexPoly(img, np.int32([A[j], A[j + 1], B[j + 1], B[j]]), BAND_BGR['road'], cv2.LINE_AA)
    for num, a, b, d, name in CORNERS:
        if not num:
            continue
        idx = rd.wrap_range(a, b, T.n)
        ap = idx[np.argmax(np.abs(T.kap[idx]))]
        sg = 1 if d == 'L' else -1          # label on the outside
        p = pix(T.world(ap, sg * 40.0)[:2])
        cv2.putText(img, 'T%d' % num, (int(p[0]) - 12, int(p[1]) + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2, cv2.LINE_AA)
    p = pix(np.stack([T.world(0, -9.0)[:2], T.world(0, 9.0)[:2]]))
    cv2.line(img, tuple(np.int32(p[0])), tuple(np.int32(p[1])), (255, 255, 255), 2)
    cv2.imwrite(path or os.path.join(DATA, 'debug_design.png'), img)
    print('debug image %dx%d' % (W, H))


if __name__ == '__main__':
    what = sys.argv[1] if len(sys.argv) > 1 else 'all'
    os.makedirs(DATA, exist_ok=True)
    if what in ('design', 'all'):
        design()
    if what in ('terrain', 'all'):
        from prep_terrain import terrain
        terrain()
