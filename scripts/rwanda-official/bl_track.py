"""
Track surfaces of the official Rwanda layout, built in Blender from data/design.npz: road, markings, kerbs, painted
run-off, verges, gravel, pit lane, barriers, fences, pit walls and the physics colliders.

    import bl_track; bl_track.build()
"""
import os
import numpy as np
import bpy

import ro_design as rd
import bl_common as bc
from bl_common import Parts, pts, at, mat, STEP

TRACKSIDE = np.array([0.36, 0.48, 0.22])
SIGNATURE_TURNS = (2, 7, 10, 17)            # the corners with the flag-coloured kerbs
PIT_S0, PIT_LEN = 5606, 600
BUILDING_U = (150.0, 498.0)                 # the pit building along the pit stretch (metres from PIT_S0)
BAYS = 20
GRID_SLOTS = 20
BAND_IDX = {'ga': 1, 'pr': 2, 'gw': 3, 'gb': 4, 'sl': 5, 'sv': 6, 'sr': 7, 'bk': 8}
RUNOFF_SPAN_M, RUNOFF_NEG_M = 64.0, 4.0     # what the run-off texture covers across (prep_textures.py)


def both(m):
    """Quads whose two ends are inside a station mask"""
    return m & np.roll(m, -1)


def adv(uv, axis, step):
    """The uv of the next row as this row's quads see it: `axis` advances by `step` instead of wrapping"""
    far = np.roll(uv, -1, 0).copy()
    far[..., axis] = uv[..., axis] + step
    return far


def pit_u(T):
    """Metres into the pit stretch of every mesh station, and the distance to its nearer end (< 0 outside)"""
    u = (T.idx - PIT_S0) % T.n
    return u, np.minimum(u, PIT_LEN - u)


def materials():
    return {
        'asphalt': mat('Track_Asphalt', tex='asphalt', rough=0.86, vcol=True),
        'paint': mat('Paint_White', color=(0.95, 0.95, 0.95), rough=0.6),
        'kerb': mat('Kerb_RedWhite', tex='kerb', rough=0.5),
        'kerb_rw': mat('Kerb_Rwanda', tex='kerb_flag', rough=0.5),
        'kerb_base': mat('Kerb_Base', tex='concrete', rough=0.8),     # the hump under the blocks (bl_kerbs.py)
        'runoff': mat('Runoff_Paint', tex='runoff', rough=0.7),
        'grass': mat('Terrain_Grass', tex='grass', rough=0.95, vcol=True),
        'pit': mat('Track_Pitlane_Asphalt', tex='pit_asphalt', rough=0.85),
        'gravel': mat('Gravel_Trap', tex='gravel', rough=0.95),
        'slab': mat('Pit_Apron_Concrete', tex='concrete', rough=0.8),
        'armco': mat('Barrier_Armco', tex='armco', rough=0.35, metal=0.7),
        'tecpro': mat('Barrier_Tecpro', tex='tecpro', rough=0.6),
        'wall': mat('PitWall', tex='pit-wall', rough=0.7),
        'fence': mat('Fence_Debris', tex='debris-fence', rough=0.5, metal=0.6, alpha='MASK', double=True),
        'post': mat('Fence_Post', color=(0.45, 0.47, 0.5), rough=0.45, metal=0.8),
        'service': mat('Service_Asphalt', tex='service', rough=0.9),
        'hidden': mat('Collider_Hidden', color=(1, 0, 1), rough=1.0, a=0.25, double=True),
    }


# ---- road, paint ------------------------------------------------------------------------------------------------------
def road(T, m):
    idx = T.idx
    s = idx.astype(float)
    f = np.array([-1, -0.7, -0.35, 0, 0.35, 0.7, 1.0])
    lat = T.width[idx][:, None] / 2 * f
    P = T.world(idx, lat)
    uv = np.stack([lat / 8 + 0.5, np.broadcast_to(s[:, None] / 8, lat.shape)], -1)
    shade = np.array([1.0, 0.975, 0.96, 0.955, 0.96, 0.975, 1.0])       # a touch darker where the cars run
    col = np.broadcast_to(shade[None, :, None], P.shape)
    p = Parts()
    p.strip(P, uv=uv, uv_far=adv(uv, 1, STEP / 8), col=col)
    return p.build('Track_Asphalt_Road', [m['asphalt']], extras={'surface': 'road', 'grip': 1.0})


def patch(p, T, s0, s1, l0, l1, dz=0.008, nl=2, mi=0):
    """A painted rectangle between two stations and two lateral offsets (+ right)"""
    ns = max(2, int(np.ceil(abs(s1 - s0) / 2.0)) + 1)
    S = np.linspace(s0, s1, ns)[:, None]
    Lt = np.linspace(l0, l1, nl)[None, :]
    p.strip(at(T, S, Lt, dz), closed=False, flip=(l1 < l0) != (s1 < s0), mi=mi)


def markings(T, m):
    p = Parts()
    n = len(T.idx)
    for side in (0, 1):                                                  # the white lines of the track's edges
        d = np.broadcast_to(np.array([-0.25, -0.10]), (n, 2))
        p.strip(pts(T, side, d, dz=0.006), flip=side == 0)
    hw = T.width[0] / 2
    patch(p, T, -0.25, 0.25, -hw + 0.1, hw - 0.1, nl=7)                  # start / finish line
    for k in range(GRID_SLOTS):                                          # grid boxes, pole on the right
        c = 2.9 if k % 2 == 0 else -2.9
        f = -6.0 - 8.0 * k + 2.75
        patch(p, T, f, f + 0.15, c - 1.15, c + 1.15)
        for e in (-1.15, 1.03):
            patch(p, T, f - 1.2, f, c + e, c + e + 0.12)
    return p.build('Track_Markings', [m['paint']], uv=False)


def signature(T):
    """Per station: the kerbs there wear the flag's colours"""
    sig = np.zeros(T.n, bool)
    k0 = np.flatnonzero(np.isin(T.turn, SIGNATURE_TURNS))
    for off in range(-40, 51):
        sig[(k0 + off) % T.n] = True
    return sig


def kerbs(T, m):
    """What the cars drive on: a smooth hump. Its blocks, the kerb one sees, are laid over it by bl_kerbs.py"""
    idx = T.idx
    n = len(idx)
    s = idx.astype(float)
    dk = np.array([0.0, 0.25, 0.7, 1.15, 1.5])
    hk = np.array([0.0, 0.018, 0.032, 0.026, 0.0])
    sig = signature(T)[idx]
    p = Parts()
    for side in (0, 1):
        kf = T.kerb[side][idx]
        q = both(kf > 0.02)
        d = np.broadcast_to(dk, (n, len(dk)))
        P = pts(T, side, d)
        P[..., 2] += 0.004 + kf[:, None] * hk
        uv = np.stack([np.broadcast_to(s[:, None] / 6, d.shape), d / 1.5], -1)
        far = adv(uv, 0, STEP / 6)
        p.strip(P, mask=q & ~sig, flip=side == 0, uv=uv, uv_far=far, mi=0)
        p.strip(P, mask=q & sig, flip=side == 0, uv=uv, uv_far=far, mi=1)
    return p.build('Track_Kerbs', [m['kerb'], m['kerb_rw']], extras={'surface': 'kerb'})


def runoff(T, m):
    idx = T.idx
    s = idx.astype(float)
    p = Parts()
    for side in (0, 1):
        pw = T.pw[side][idx]
        d = np.minimum(rd.PAINT_COLS[None, :], pw[:, None])
        wq = d[:, 1:] - d[:, :-1]
        keep = (wq > 0.02) | (np.roll(wq, -1, 0) > 0.02)
        pu = T.pu0[side][idx][:, None]
        v = np.broadcast_to(s[:, None] / 12, d.shape)
        uv = np.stack([(pu + d + RUNOFF_NEG_M) / RUNOFF_SPAN_M, v], -1)
        far = np.stack([(pu + np.roll(d, -1, 0) + RUNOFF_NEG_M) / RUNOFF_SPAN_M, v + STEP / 12], -1)
        p.strip(pts(T, side, d), mask=keep, flip=side == 0, uv=uv, uv_far=far)
    return p.build('Track_Runoff_Paint', [m['runoff']], extras={'surface': 'runoff', 'grip': 0.75})


# ---- ground bands -----------------------------------------------------------------------------------------------------
def band(T, side, k):
    e = T.be[side][T.idx]
    b = BAND_IDX[k]
    d0, d1 = e[:, b], e[:, b + 1]
    d = d0[:, None] + (d1 - d0)[:, None] * np.linspace(0, 1, rd.BAND_COLS[k])
    w = d1 - d0
    return d, pts(T, side, d), (w > 0.02) | (np.roll(w, -1) > 0.02)


def grounds(T, m, bnd_col):
    idx = T.idx
    n = len(idx)
    s = idx.astype(float)
    verge, gravel, pit, slab, serv, lines = Parts(), Parts(), Parts(), Parts(), Parts(), Parts()
    for side in (0, 1):
        fl = side == 0
        bcol = bnd_col[side * n:(side + 1) * n]
        mid = TRACKSIDE * 0.65 + bcol * 0.35
        for k in BAND_IDX:
            d, P, keep = band(T, side, k)
            if not keep.any():
                continue
            if k in ('ga', 'gb', 'sv', 'bk'):
                t = np.linspace(0, 1, d.shape[1])[None, :, None]
                if k == 'ga':
                    col = np.broadcast_to(TRACKSIDE, P.shape)
                elif k == 'gb':
                    col = TRACKSIDE * (1 - t) + mid[:, None, :] * t
                elif k == 'sv':
                    col = np.broadcast_to(mid[:, None, :], P.shape)
                else:
                    col = mid[:, None, :] * (1 - t) + bcol[:, None, :] * t
                verge.strip(P, mask=keep, flip=fl, uv=P[..., :2] / 6, col=col)
            elif k == 'pr':
                uv = np.stack([(d - d[:, :1]) / 8, np.broadcast_to(s[:, None] / 8, d.shape)], -1)
                pit.strip(P, mask=keep, flip=fl, uv=uv, uv_far=adv(uv, 1, STEP / 8))
            elif k == 'gw':
                gravel.strip(P, mask=keep, flip=fl, uv=P[..., :2] / 4)
            elif k == 'sr':
                whole = (d[:, -1] - d[:, 0]) > 4.0
                uv = np.stack([(d - d[:, :1]) / 5, np.broadcast_to(s[:, None] / 5, d.shape)], -1)
                serv.strip(P, mask=keep, flip=fl, uv=uv, uv_far=adv(uv, 1, STEP / 5))
                for e0, e1 in ((0.15, 0.27), (-0.27, -0.15)):                       # its white edge lines
                    de = np.stack([(d[:, 0] if e0 > 0 else d[:, -1]) + e0, (d[:, 0] if e0 > 0 else d[:, -1]) + e1], 1)
                    lines.strip(pts(T, side, de, dz=0.012), mask=both(whole), flip=fl)
            else:
                slab.strip(P, mask=keep, flip=fl, uv=P[..., :2] / 6)
    verge.build('Ground_Verge', [m['grass']], extras={'surface': 'grass'})
    gravel.build('Ground_Gravel', [m['gravel']], extras={'surface': 'gravel'})
    pit.build('Track_Pitlane', [m['pit']], extras={'surface': 'pitlane'})
    slab.build('Ground_Paddock', [m['slab']])
    serv.build('Ground_ServiceRoad', [m['service']])
    lines.build('Ground_Road_Lines', [m['paint']], uv=False, extras={'decal': True})


# ---- barriers ---------------------------------------------------------------------------------------------------------
def rail(p, T, side, dref, segs, q, mi=0, ulen=4.0, cap=None, along=None, col=None):
    """
    A profile swept along the lap. dref (n,): the reference line's distance from the road edge, which also gives
    the ground height. segs: ((dd, dz, v), (dd, dz, v)) strips, ordered from the track side over the top to the
    back; dd and dz may be per-station arrays. q: the quads to keep. cap: four (dd, dz) corners (or a list of such
    quads) closing the ends of each run. along: the metres the texture's u counts (default: the station).
    """
    idx = T.idx
    n = len(idx)
    if not q.any():
        return
    base = pts(T, side, dref)

    def row(dd, dz):
        P = pts(T, side, dref + dd)
        P[:, 2] = base[:, 2] + dz
        return P

    u = (idx if along is None else along) / ulen
    for a, b in segs:
        P = np.stack([row(a[0], a[1]), row(b[0], b[1])], 1)
        uv = np.zeros((n, 2, 2))
        uv[..., 0] = u[:, None]
        uv[:, 0, 1], uv[:, 1, 1] = a[2], b[2]
        p.strip(P, mask=q, flip=side == 0, uv=uv, uv_far=uv + [STEP / ulen, 0], mi=mi,
                col=None if col is None else np.broadcast_to(col, P.shape))
    if not cap or q.all():
        return
    starts = np.flatnonzero(q & ~np.roll(q, 1))
    ends = (np.flatnonzero(q & ~np.roll(q, -1)) + 1) % n
    for quad in (cap if isinstance(cap[0][0], (tuple, list)) else [cap]):
        rows = [row(dd, dz) for dd, dz in quad]
        cuv = np.array([[float(np.mean(c[0])) / abs(ulen), 0.3 + 0.4 * (float(np.mean(c[1])) > 0)] for c in quad])
        for i, fwd in [(i, False) for i in starts] + [(i, True) for i in ends]:
            V = np.array([r[i] for r in rows])
            nrm = np.cross(V[1] - V[0], V[2] - V[0])
            t = np.array([T.tx[idx[i]], T.ty[idx[i]], 0.0])
            order = [0, 1, 2, 3] if ((nrm @ t) > 0) == fwd else [3, 2, 1, 0]
            p.add(V, [order], loop_uv=cuv[order], mi=mi)


def box_segs(d0, d1, h, vtop, skirt=0.3):
    v0 = -skirt / h
    segs = [((d0, -skirt, v0), (d0, h, 1.0)), ((d0, h, vtop[0]), (d1, h, vtop[1])), ((d1, h, 1.0), (d1, -skirt, v0))]
    return segs, [(d0, -skirt), (d0, h), (d1, h), (d1, -skirt)]


def fence(p, T, side, dref, dd, q, base=1.0, top=3.6):
    """Debris fence on top of a wall: mesh, an inward-leaning top and a post every 4 m"""
    idx = T.idx
    if not q.any():
        return
    h = top - base
    segs = [((dd, base, 0.0), (dd, top, 1.0)), ((dd, top, 0.0), (dd - 0.45, top + 0.5, 0.26))]
    rail(p, T, side, dref, segs, q, mi=0, ulen=2.5)
    zb = pts(T, side, dref)[:, 2]
    Pp = pts(T, side, dref + dd + 0.07)
    hz = (top + 0.15 - (base - 0.1)) / 2
    for i in np.flatnonzero((q | np.roll(q, 1)) & (idx % 4 == 0)):
        yaw = np.arctan2(T.ty[idx[i]], T.tx[idx[i]])
        V, F, uv = bc.box((Pp[i, 0], Pp[i, 1], zb[i] + base - 0.1 + hz), (0.05, 0.05, hz), yaw)
        p.add(V, F, uv, mi=1)


def barriers(T, m, fen):
    idx = T.idx
    n = len(idx)
    bar = Parts()
    for side in (0, 1):
        dw = T.be[side][idx][:, 5]
        vis = both(T.wallvis[side][idx] > 0.5)
        conc = both(T.fence[side][idx] > 0.5) & vis if side == 1 else np.zeros(n, bool)
        segs, cap = box_segs(0.0, 0.15, 1.0, (0.72, 0.78))
        rail(bar, T, side, dw, segs, vis & ~conc, mi=0, ulen=2.0, cap=cap)
        segs, cap = box_segs(0.0, 0.3, 1.0, (0.90, 0.97))
        rail(bar, T, side, dw, segs, conc, mi=2, ulen=16.0, cap=cap)
        segs, cap = box_segs(-0.75, -0.15, 1.2, (0.5, 0.58))
        rail(bar, T, side, dw, segs, both(T.tec[side][idx] > 0.5) & vis, mi=1, ulen=3.0, cap=cap)
        fence(fen, T, side, dw, 0.15, conc)
        fence(fen, T, side, dw, 0.55, both(T.cf[side][idx] > 0.5) & vis & ~conc, base=0.0, top=3.4)   # behind the Armco
    return bar.build('Track_Barriers', [m['armco'], m['tecpro'], m['wall']])


def pit_wall_line(T):
    """Distance from the left road edge of the pit wall's centre, and the stations it stands at"""
    idx = T.idx
    return T.pw[0][idx] + T.ga[0][idx] / 2, T.pitwall[idx] > 0.5


def outer_wall_mask(T):
    """Left wall line between the barrier's ends and the pit building"""
    u, _ = pit_u(T)
    return ((u >= 108) & (u <= BUILDING_U[0])) | ((u >= BUILDING_U[1]) & (u <= PIT_LEN - 108))


def pit_walls(T, m, fen):
    idx = T.idx
    dref, pwm = pit_wall_line(T)
    p = Parts()
    segs, cap = box_segs(-0.15, 0.15, 1.0, (0.90, 0.97))
    rail(p, T, 0, dref, segs, both(pwm), mi=0, ulen=16.0, cap=cap)
    p.build('Track_PitWall', [m['wall']])
    fence(fen, T, 0, dref, 0.0, both(pwm))

    dw = T.be[0][idx][:, 5]
    q = both(outer_wall_mask(T))
    p = Parts()
    segs, cap = box_segs(0.0, 0.3, 1.0, (0.90, 0.97))
    rail(p, T, 0, dw, segs, q, mi=0, ulen=16.0, cap=cap)
    p.build('Track_PitOuterWall', [m['wall']])
    fence(fen, T, 0, dw, 0.15, q)


def pit_markings(T, m):
    idx = T.idx
    e = T.be[0][idx]
    pr = T.pr[0][idx]
    p = Parts()
    q = both(pr > 3.0)
    for a, b in ((e[:, 2] + 0.10, e[:, 2] + 0.25), (e[:, 3] - 0.25, e[:, 3] - 0.10)):      # the pit road's edges
        p.strip(pts(T, 0, np.stack([a, b], 1), dz=0.006), mask=q, flip=True)
    d = np.stack([e[:, 2] + 5.44, e[:, 2] + 5.56], 1)                                      # fast lane | working lane
    p.strip(pts(T, 0, d, dz=0.006), mask=both(pr > 12.0), flip=True)

    def across(uu, a, b, w):
        """A line across the pit road at uu metres into the pit stretch; a, b: metres inside its two edges"""
        s = PIT_S0 + uu
        i = int(round(s)) % T.n
        hw, ee = T.width[i] / 2, T.be[0][i]
        patch(p, T, s - w / 2, s + w / 2, -(hw + ee[2] + a), -(hw + ee[3] - b), nl=3)

    bay = (BUILDING_U[1] - BUILDING_U[0]) / BAYS
    for k in range(BAYS + 1):
        across(BUILDING_U[0] + bay * k, 5.56, 0.3, 0.10)
    for uu in (100.0, PIT_LEN - 100.0):                                                    # speed limit lines
        across(uu, 0.25, 0.25, 0.30)
    return p.build('Track_Pit_Markings', [m['paint']], uv=False)


# ---- physics ----------------------------------------------------------------------------------------------------------
def colliders(T, m):
    idx = T.idx
    hid = [m['hidden']]
    lat = (T.width[idx] / 2 + 1.6)[:, None] * np.array([-1.0, 0.0, 1.0])
    V, F, _ = bc.strip(T.world(idx, lat))
    bc.make_mesh('Track_Collider_Road', V, F, hid, extras={'collider': 'road'})

    def wall(name, side, lines, tag):
        p = Parts()
        for d, q in lines:
            base = pts(T, side, d)
            P = np.stack([base + [0, 0, -0.5], base + [0, 0, 2.5]], 1)
            p.strip(P, mask=q, flip=side == 0)
        p.build(name, hid, extras={'collider': 'wall', 'side': tag}, uv=False)

    vis_q = []
    for side, name, tag in ((0, 'Track_Collider_Wall_Left', 'left'), (1, 'Track_Collider_Wall_Right', 'right')):
        dw = T.be[side][idx][:, 5]
        q = both(T.wallvis[side][idx] > 0.5)
        vis_q.append(q)
        wall(name, side, [(dw - 0.75 * (T.tec[side][idx] > 0.5), q)], tag)
    dref, pwm = pit_wall_line(T)
    wall('Track_Collider_Wall_Pit', 0, [(dref - 0.15, both(pwm)), (dref + 0.15, both(pwm))], 'pit')
    wall('Track_Collider_Wall_PitOuter', 0, [(T.be[0][idx][:, 5], ~vis_q[0])], 'pit_outer')


OBJECTS = ('Track_Asphalt_Road', 'Track_Markings', 'Track_Kerbs', 'Track_Runoff_Paint', 'Ground_Verge',
           'Ground_Gravel', 'Track_Pitlane', 'Ground_Paddock', 'Ground_ServiceRoad', 'Ground_Road_Lines', 'Track_Barriers', 'Track_Fences', 'Track_PitWall',
           'Track_PitOuterWall', 'Track_Pit_Markings', 'Track_Collider_Road', 'Track_Collider_Wall_Left',
           'Track_Collider_Wall_Right', 'Track_Collider_Wall_Pit', 'Track_Collider_Wall_PitOuter')


def build():
    T = bc.design(reload=True)
    m = materials()
    ter = np.load(os.path.join(rd.DATA, 'terrain.npz'))
    bc.remove('Cube')
    road(T, m)
    markings(T, m)
    kerbs(T, m)
    runoff(T, m)
    grounds(T, m, ter['bnd_col'])
    fen = Parts()
    barriers(T, m, fen)
    pit_walls(T, m, fen)
    fen.build('Track_Fences', [m['fence'], m['post']])
    pit_markings(T, m)
    colliders(T, m)
    for name in OBJECTS:
        ob = bpy.data.objects.get(name)
        if ob:
            ob.hide_viewport = ob.hide_render = name.startswith('Track_Collider')
    out = {}
    for name in OBJECTS:
        ob = bpy.data.objects.get(name)
        out[name] = sum(len(f.vertices) - 2 for f in ob.data.polygons) if ob else None
    return out
