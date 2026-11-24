"""
Buildings and trackside objects of the official Rwanda layout, built in Blender after bl_track and bl_terrain: the
pit building, its tower and the medical centre, the main grandstands with their canopies, the paddock and the
hospitality village, the lakeside terraces, the road bridge over the exit of Turn 17, the causeway, the roads and car
parks around the venue, gantries, big screens, TV towers, banners, brake boards, marshal posts and flags.

    import bl_scenery; bl_scenery.build()
"""
import numpy as np
import bpy

import ro_design as rd
import ro_site as site
from ro_foot import Foot
import bl_common as bc
import bl_track as bt
import bl_terrain
from bl_common import Parts, at, mat
from bl_track import both, adv, rail, PIT_S0, PIT_LEN, BUILDING_U

UP = np.array([0.0, 0.0, 1.0])
TAU = 2 * np.pi
TERRACE_S0 = site.TERRACE[0]         # the grandstand terrace's along-coordinate starts here
# The main stand, in metres along the terrace: its groups of seat blocks (planted wedges between them), the stand's
# front (metres behind the terrace wall), and the clouds over it (centre, half length; their centres CANOPY_BACK behind the wall)
STAND_GROUPS = ((61.0, 213.0), (223.0, 343.0), (353.0, 463.0), (473.0, 528.0))
STAND_FRONT = 12.0
CANOPIES = ((148.0, 62.0), (283.0, 60.0), (408.0, 54.0), (515.0, 46.0))
CANOPY_BACK = 44.0
AISLE_PITCH = 25.0
# The pit building, in metres into the pit stretch: its three roof slabs, the wing off its north-west end (station,
# length), the cone tower and the helipad (station, metres behind the building's front)
PIT_SLABS = ((BUILDING_U[0], 305.0), (318.0, 450.0), (458.0, BUILDING_U[1]))
WING_U, WING_LEN = BUILDING_U[1] - 9.0, 70.0
SPIRE = (347.0, 33.0)
HELIPAD = (134.0, 44.0)
# Hospitality pavilions: (station into the pit stretch, metres behind the building's front, radii along / across, tiers)
PAVILIONS = ((455, 58, 13, 10, 3), (418, 42, 12, 9, 2), (392, 61, 12, 10, 2), (330, 60, 14, 10, 3), (312, 36, 11, 9, 2),
             (262, 57, 13, 10, 2), (222, 35, 11, 9, 2), (190, 60, 10, 8, 2))
GANTRY_S = 9.0                       # start lights gantry
SPANS = (687.0, 1561.0, 2222.0, 3542.0)              # the blue gantries over the track
FLAG = ((0.0, 0.63, 0.87), (0.98, 0.82, 0.09), (0.13, 0.38, 0.2))
# (corner entry station, side the boards stand on, distances)
BRAKE_BOARDS = ((790, 0, (200, 150, 100, 50)), (1362, 1, (100, 50)), (2808, 1, (200, 150, 100, 50)),
                (3180, 0, (100, 50)), (3889, 1, (200, 150, 100, 50)), (4169, 0, (100, 50)),
                (5438, 1, (200, 150, 100, 50)))


class Local:
    """A frame on the ground: a = along `yaw`, c = to its right, z = up"""

    def __init__(self, o, yaw):
        self.o = np.asarray(o, float)
        self.yaw = float(yaw)
        self.t = np.array([np.cos(yaw), np.sin(yaw), 0.0])
        self.r = np.array([np.sin(yaw), -np.cos(yaw), 0.0])

    @classmethod
    def on_track(cls, T, s, lat=0.0):
        _, t, _ = bc.frame(T, s)
        return cls(at(T, s, lat), np.arctan2(t[1], t[0]))

    @classmethod
    def on_ground(cls, x, y, yaw, default=0.0):
        z = bl_terrain.ground(float(x), float(y))
        return cls((x, y, default if z is None else z), yaw)

    def pt(self, a, c, z):
        a, c, z = np.broadcast_arrays(np.asarray(a, float), np.asarray(c, float), np.asarray(z, float))
        return self.o + a[..., None] * self.t + c[..., None] * self.r + z[..., None] * UP


def materials():
    m = bt.materials()
    m.update({
        'white': mat('Building_White', color=(0.93, 0.93, 0.91), rough=0.6),
        'glass': mat('Building_Glass', tex='glass', rough=0.15, metal=0.2),
        'garage': mat('Garage_Door', tex='garage', rough=0.6),
        'canopy': mat('Grandstand_Canopy', color=(0.95, 0.95, 0.93), rough=0.55),
        'crowd': mat('Stand_Crowd', tex='crowd', rough=0.9),
        'seats': mat('Stand_Seats', tex='seats', rough=0.9),
        'thatch': mat('Hut_Thatch', tex='thatch', rough=0.95),
        'timber': mat('Hut_Timber', tex='timber', rough=0.8),
        'blue': mat('Gantry_Blue', color=(0.07, 0.36, 0.72), rough=0.5),
        'metal': mat('Gantry_Metal', tex='gantry-metal', rough=0.45, metal=0.6),
        'steel': mat('Scaffold_Steel', color=(0.56, 0.58, 0.6), rough=0.4, metal=0.8),
        'scaff': mat('Stand_Scaffold', tex='scaffold', rough=0.6, metal=0.2),
        'panel': mat('StartLights_Panel', color=(0.03, 0.03, 0.035), rough=0.5),
        'lens': mat('StartLights_Lens', color=(0.16, 0.05, 0.05), rough=0.3),
        'b0': mat('Banner_Rwanda', tex='banner_rwanda', rough=0.7),
        'b1': mat('Banner_Bugesera', tex='banner_bugesera', rough=0.7),
        'b2': mat('Banner_Kigali', tex='banner_kigali', rough=0.7),
        'orange': mat('Marshal_Orange', color=(0.93, 0.45, 0.08), rough=0.7),
        'flag': mat('Flag_Cloth', rough=0.8, vcol=True, double=True),
        'terrace': mat('Terrace_White', color=(0.9, 0.89, 0.85), rough=0.75),
        'rock': mat('Causeway_Rock', tex='rock', rough=0.95),
        'path': mat('Path_Laterite', tex='path', rough=0.95),
        'court': mat('Court_Clay', tex='court', rough=0.9),
        'parking': mat('Parking_Asphalt', tex='parking', rough=0.9),
        'screen': mat('Screen_Live', tex='screen', rough=0.4),
        'truck': mat('Truck_White', tex='truck', rough=0.5),
        'helipad': mat('Helipad_Paint', tex='helipad', rough=0.8),
        'dark': mat('Camera_Dark', color=(0.08, 0.08, 0.09), rough=0.5),
        'bridge': mat('Bridge_Concrete', tex='concrete', color=(0.9, 0.9, 0.88), rough=0.85),
        'road': mat('Road_Asphalt', tex='road', rough=0.9),
        'yellow': mat('Plant_Yellow', color=(0.93, 0.68, 0.06), rough=0.55),
        'red': mat('Ambulance_Red', color=(0.78, 0.07, 0.07), rough=0.5),
        'tyre': mat('Tyre_Black', color=(0.045, 0.045, 0.05), rough=0.9),
        'solar': mat('Roof_Solar', color=(0.05, 0.09, 0.2), rough=0.25, metal=0.5),
        'shed': mat('Shed_Green', color=(0.1, 0.22, 0.17), rough=0.7),
        'palm': mat('Palm_Leaf', color=(0.16, 0.3, 0.1), rough=0.85, double=True),
    })
    nt = m['screen'].node_tree                                 # the screens glow with their own picture
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    nt.links.new(next(n for n in nt.nodes if n.type == 'TEX_IMAGE').outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 0.45
    for d in (50, 100, 150, 200):
        m[f'board{d}'] = mat(f'Board_{d}', tex=f'board_{d}', rough=0.6)
    return m


# ---- shapes -----------------------------------------------------------------------------------------------------------
def grid(p, P, want, closed=True, uv=None, uv_far=None, mi=0, col=None):
    """A swept grid whose faces are turned to look along `want`"""
    P = np.asarray(P, float)
    n0 = np.cross(P[0, 1] - P[0, 0], P[1, 0] - P[0, 0])
    V, F, L = bc.strip(P, None, bool(n0 @ np.asarray(want, float) < 0), uv, uv_far, closed)
    p.add(V, F, L, mi, col)


def quad(p, L, a0, a1, c0, c1, z, mi=0, uv=(1.0, 1.0)):
    """A level rectangle looking up, textured once across unless `uv` gives its repeats"""
    P = [[L.pt(a0, c0, z), L.pt(a0, c1, z)], [L.pt(a1, c0, z), L.pt(a1, c1, z)]]
    grid(p, P, UP, closed=False, uv=np.array([[[0, 0], [0, uv[1]]], [[uv[0], 0], [uv[0], uv[1]]]], float), mi=mi)


def pbox(p, L, a0, a1, c0, c1, z0, z1, mi=0, uv_scale=None):
    V, F, uv = bc.box(L.pt((a0 + a1) / 2, (c0 + c1) / 2, (z0 + z1) / 2),
                      ((a1 - a0) / 2, (c1 - c0) / 2, (z1 - z0) / 2), L.yaw, uv_scale)
    p.add(V, F, uv, mi)


def lathe(p, c, prof, n=20, mi=0, ku=1.0, kv=1.0, sharp=False):
    """A profile [(r, z)…] (bottom to top) turned about the vertical through c; u wraps ku times, v = length / kv"""
    th = np.linspace(0, TAU, n, endpoint=False)
    r = np.array([q[0] for q in prof], float)
    z = np.array([q[1] for q in prof], float)
    P = np.stack([c[0] + r[None] * np.cos(th)[:, None], c[1] + r[None] * np.sin(th)[:, None],
                  c[2] + z[None] + 0 * th[:, None]], -1)
    seg = np.r_[0, np.cumsum(np.hypot(np.diff(r), np.diff(z)))]
    uv = np.stack([np.broadcast_to((th / TAU * ku)[:, None], P.shape[:2]),
                   np.broadcast_to(seg[None] / kv, P.shape[:2])], -1)
    far = adv(uv, 0, ku / n)
    want = (1.0, 0.0, 0.35)
    if not sharp:
        grid(p, P, want, True, uv, far, mi)
        return
    for k in range(len(prof) - 1):
        if seg[k + 1] - seg[k] > 1e-6:
            grid(p, P[:, k:k + 2], want, True, uv[:, k:k + 2], far[:, k:k + 2], mi)


def blob(p, L, a, c, z, ra, rc, seed, thick=0.45, crown=1.0, n=44, mi=0, slope=0.0):
    """An organic flat roof: a wobbling outline around (a, c), slightly crowned. Returns its angles and wobble"""
    rng = np.random.default_rng(seed)
    th = np.linspace(0, TAU, n, endpoint=False)
    wob = (1 + 0.13 * np.sin(2 * th + rng.uniform(0, TAU)) + 0.10 * np.sin(3 * th + rng.uniform(0, TAU))
           + 0.06 * np.sin(5 * th + rng.uniform(0, TAU)))
    rho = np.array([0.03, 0.4, 0.75, 1.0])
    A = a + ra * wob[:, None] * rho[None] * np.cos(th)[:, None]
    C = c + rc * wob[:, None] * rho[None] * np.sin(th)[:, None]
    Zt = z + crown * (1 - rho[None] ** 2) + slope * (A - a)
    top = L.pt(A, C, Zt)
    bot = L.pt(A, C, Zt - thick - 0.5 * crown * (1 - rho[None] ** 2))
    grid(p, top, UP, mi=mi)
    grid(p, bot, -UP, mi=mi)
    grid(p, np.stack([bot[:, -1], top[:, -1]], 1), L.t, mi=mi)
    return th, wob


def column(p, L, a, c, z0, z1, r=0.35, n=8, mi=0):
    lathe(p, L.pt(a, c, 0.0), [(r, z0), (r, z1)], n=n, mi=mi, kv=4.0)


def dome(p, c, r, h0, mi_wall, mi_roof, squat=0.78):
    """A round hut under a thatched dome: wall to h0, then the dome"""
    lathe(p, c, [(r, -1.0), (r, h0)], n=18, mi=mi_wall, ku=round(TAU * r / 3.0), kv=3.0)
    ph = np.linspace(-0.12, np.pi / 2 - 0.03, 7)
    prof = [(1.16 * r * np.cos(a), h0 + 0.15 + squat * r * np.sin(a)) for a in ph]
    lathe(p, c, prof, n=18, mi=mi_roof, ku=round(TAU * 1.16 * r / 4.0), kv=4.0)


def tent(p, L, a, c, la=10.0, lc=6.0, h=2.6, hr=1.5, mi=0):
    pbox(p, L, a - la / 2, a + la / 2, c - lc / 2, c + lc / 2, -0.6, h, mi)
    e = 0.3
    for sg in (-1, 1):
        P = [[L.pt(a - la / 2 - e, c + sg * (lc / 2 + e), h - 0.1), L.pt(a - la / 2 - e, c, h + hr)],
             [L.pt(a + la / 2 + e, c + sg * (lc / 2 + e), h - 0.1), L.pt(a + la / 2 + e, c, h + hr)]]
        grid(p, P, UP, closed=False, mi=mi)
    for sg in (-1, 1):
        aa = a + sg * la / 2
        P = [[L.pt(aa, c - lc / 2, h), L.pt(aa, c + lc / 2, h)], [L.pt(aa, c - 0.01, h + hr), L.pt(aa, c + 0.01, h + hr)]]
        grid(p, P, sg * L.t, closed=False, mi=mi)


def resample(P, h):
    """An open polyline (k, d) resampled every h metres (its ends kept)"""
    P = np.asarray(P, float)
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]
    u = np.linspace(0, seg[-1], max(2, int(np.ceil(seg[-1] / h)) + 1))
    return np.stack([np.interp(u, seg, P[:, k]) for k in range(P.shape[1])], 1), u


def tube(p, A, B, r, mi=0):
    """A square bar from A to B"""
    A, B = np.asarray(A, float), np.asarray(B, float)
    d = (B - A) / np.linalg.norm(B - A)
    u = np.cross(d, UP)
    u = np.array([1.0, 0.0, 0.0]) if np.linalg.norm(u) < 1e-6 else u / np.linalg.norm(u)
    v = np.cross(d, u)
    offs = [r * (u + v), r * (v - u), r * (-u - v), r * (u - v)]
    grid(p, np.array([[A + o, B + o] for o in offs]), offs[0] + offs[1], closed=True, mi=mi)


def ribbon(p, pts, width, mi=0, shoulder=None, step=3.0, vlen=12.0, lift=0.1):
    """
    A road along a polyline, laid on the terrain: level across, a little above the highest ground under it, with
    shoulders (material `shoulder`) falling into the ground either side.
    """
    P, u = resample(np.asarray(pts, float)[:, :2], step)
    t = np.gradient(P, axis=0)
    t /= np.hypot(*t.T)[:, None]
    nrm = np.c_[t[:, 1], -t[:, 0]]

    def gz(off):
        z = [bl_terrain.ground(float(x), float(y)) for x, y in P + nrm * off]
        z = np.array([np.nan if v is None else v for v in z], float)
        ok = ~np.isnan(z)
        return np.interp(u, u[ok], z[ok]) if ok.any() else np.zeros(len(u))

    zc = np.stack([gz(o) for o in (-width / 2, 0.0, width / 2)], 1).max(1)
    zr = np.maximum(np.convolve(np.pad(zc, 2, mode='edge'), np.ones(5) / 5, mode='valid'), zc) + lift
    offs = np.linspace(-width / 2, width / 2, 3)
    G = np.stack([np.c_[P + nrm * o, zr] for o in offs], 1)
    uv = np.stack([np.broadcast_to(((offs + width / 2) / width)[None], G.shape[:2]),
                   np.broadcast_to((u / vlen)[:, None], G.shape[:2])], -1)
    grid(p, G, UP, closed=False, uv=uv, mi=mi)
    if shoulder is not None:
        for sg in (-1, 1):
            zo = np.clip(gz(sg * (width / 2 + 1.8)) - 0.25, zr - 2.5, zr)
            S = np.stack([np.c_[P + nrm * sg * width / 2, zr], np.c_[P + nrm * sg * (width / 2 + 1.8), zo]], 1)
            uvs = np.stack([np.stack([0 * u, u / 3.0], -1), np.stack([0 * u + 0.6, u / 3.0], -1)], 1)
            grid(p, S, UP, closed=False, uv=uvs, mi=shoulder)
    return np.c_[P, zr]


# ---- pit complex ------------------------------------------------------------------------------------------------------
def paddock_local(T, u, dd):
    """Frame on the paddock, u metres into the pit stretch and dd behind the pit building's front (c + = to the track)"""
    s = (PIT_S0 + u) % T.n
    i = int(round(s)) % T.n
    return Local.on_track(T, s, -(T.width[i] / 2 + T.be[0][i, rd.WALL] + dd))


def pit_building(T, m):
    """
    The pit building as the release render shows it: one long body under three white roof slabs with a timber deck
    along the track side and a lobed edge over the paddock, a wing off its north-west end, the technical annex and the
    helipad behind its south-east end, and the cone tower.
    """
    idx = T.idx
    u, _ = bt.pit_u(T)
    u = u.astype(float)
    ub = u - BUILDING_U[0]
    q = both((u >= BUILDING_U[0]) & (u <= BUILDING_U[1]))
    ins = np.zeros(len(u), bool)
    for a, b in PIT_SLABS:
        ins |= (u >= a) & (u <= b)
    qs = both(ins)
    qg = q & ~qs
    dw = T.be[0][idx][:, rd.WALL]
    G, F1, F2, D = 4.6, 8.4, 12.0, 16.0
    ef = -4.6
    deck = ef + 6.5
    eb = D + 4.6 + 3.0 * np.sin(TAU * ub / 46.0 + 0.9) + 1.1 * np.sin(TAU * ub / 19.0 + 0.4)
    p = Parts()
    W, GL, GA, CO, TI = 0, 1, 2, 3, 4

    def r(segs, mi, ulen=8.0, cap=None, mask=q):
        rail(p, T, 0, dw, segs, mask, mi=mi, ulen=ulen, cap=cap, along=ub)

    r([((0, -0.3, -0.3 / G), (0, G, 1.0))], GA, 7.25)                                   # garage doors
    r([((0, G, 0), (-3, G, 0.3)), ((-3, G, 0), (-3, G + 1.4, 1)), ((-3, G + 1.4, 0), (-2.85, G + 1.4, 1)),
       ((-2.85, G + 1.4, 1), (-2.85, G + 0.4, 0))], W)                                  # balcony and its parapet
    r([((-2.85, G + 0.4, 0), (0, G + 0.4, 0.95))], TI, 3.0)
    r([((0, G + 0.4, 0.0), (0, F1, 0.5))], GL)                                          # first floor
    r([((0, F1, 0), (0, F1 + 0.9, 1)), ((0, F1 + 0.9, 0), (0.15, F1 + 0.9, 1)), ((0.15, F1 + 0.9, 1), (0.15, F1, 0))], W,
      cap=[(0, -0.3), (0, F1), (D, F1), (D, -1.5)])
    r([((0.15, F1, 0), (2, F1, 0.6))], TI, 3.0)
    r([((D, F1, 0.5), (D, G + 0.4, 0.0))], GL)                                          # back
    r([((D, G + 0.4, 1), (D, -1.5, 0))], W)
    # under each slab: the second floor, set back, and the roof
    r([((2, F1, 0.5), (2, F2, 1.0))], GL, mask=qs)
    r([((2, F2, 0), (ef, F2, 1)), ((ef, F2, 0), (ef, F2 + 0.6, 1))], W, mask=qs,
      cap=[[(ef, F2), (ef, F2 + 0.6), (eb, F2 + 0.6), (eb, F2)], [(2, F1), (2, F2), (D, F2), (D, F1)]])
    r([((ef, F2 + 0.6, 0), (deck, F2 + 0.6, 2.0))], TI, 3.0, mask=qs)                    # the timber deck
    r([((deck, F2 + 0.6, 0), (eb, F2 + 0.6, 1)), ((eb, F2 + 0.6, 1), (eb, F2, 0)), ((eb, F2, 0), (D, F2, 1))], W, mask=qs)
    r([((D, F2, 1.0), (D, F1, 0.5))], GL, mask=qs)
    # between the slabs the first floor's roof is a terrace
    r([((2, F1, 0), (2, F1 + 1.0, 1)), ((2, F1 + 1.0, 0), (D, F1 + 1.0, 1)), ((D, F1 + 1.0, 1), (D, F1, 0))], W, mask=qg)

    # The wing off the north-west end: a glazed bar over a recessed ground floor, running back across the paddock
    L = paddock_local(T, WING_U, D)
    wl = WING_LEN
    pbox(p, L, -5.0, 5.0, -wl, 0.5, -3.0, 4.8, GL, uv_scale=(4, 3.5))
    pbox(p, L, -7.0, 7.0, -wl - 1.0, 1.0, 4.8, 9.0, W)
    for a0, a1 in ((-7.06, -6.98), (6.98, 7.06)):
        pbox(p, L, a0, a1, -wl + 2.0, -2.0, 5.6, 8.3, GL, uv_scale=(4, 3.5))
    pbox(p, L, -8.4, 8.4, -wl - 2.6, 2.0, 9.0, 9.55, W)
    pbox(p, L, -8.4, -3.4, -wl - 2.6, 2.0, 9.55, 9.6, TI, uv_scale=(3, 3))
    pbox(p, L, -12.0, 12.0, -wl - 16.0, -wl + 1.0, -3.0, 9.0, W)                          # its head building
    pbox(p, L, -13.5, 13.5, -wl - 17.5, -wl + 2.5, 9.0, 9.55, W)
    for c0, c1 in ((-wl - 16.06, -wl - 15.98),):
        pbox(p, L, -10.0, 10.0, c0, c1, 1.0, 8.0, GL, uv_scale=(4, 3.5))

    # The technical annex behind the building's south-east end
    L = paddock_local(T, BUILDING_U[0] + 26, 35)
    pbox(p, L, -24, 24, -12, 12, -3.0, 6.2, W)
    pbox(p, L, -25, 25, -13, 13, 6.2, 6.7, W)
    pbox(p, L, -20, 20, 11.98, 12.06, 1.0, 5.2, GL, uv_scale=(4, 3.5))
    pbox(p, L, -20, 20, -12.06, -11.98, 1.0, 5.2, GL, uv_scale=(4, 3.5))
    p.build('Prop_PitBuilding', [m['white'], m['glass'], m['garage'], m['slab'], m['timber']])
    h = Parts()
    quad(h, paddock_local(T, *HELIPAD), -9, 9, -9, 9, 0.05)
    h.build('Ground_Helipad', [m['helipad']], extras={'decal': True})

    # The tower behind it: a tall pale cone with a rounded top, the complex's landmark
    L = paddock_local(T, *SPIRE)
    H = 40.0
    prof = [(3.0 + 6.2 * (1 - max(z, 0) / H) ** 1.8, z) for z in (-1.5, 0, 3, 7, 12, 18, 24, 30, 36, H)]
    prof += [(2.6, H + 0.9), (1.6, H + 1.6), (0.06, H + 1.9)]
    p = Parts()
    lathe(p, L.o, prof, n=28)
    p.build('Env_Spire', [m['white']])


def t1_bridge(T, m):
    """
    The slim road bridge over the track at the Turn 1 end of the pit complex: a level deck from the infield to the
    north side, ramps falling to the ground beyond the corridor at both ends.
    """
    A, B = np.array(site.T1_BRIDGE[0], float), np.array(site.T1_BRIDGE[1], float)
    d = (B - A) / np.hypot(*(B - A))
    cor = np.c_[T.x, T.y]
    # where it crosses the centreline, and the corridor's two edges along its own line
    k = np.linspace(0, np.hypot(*(B - A)), 400)
    line = A + k[:, None] * d
    dist = np.array([np.hypot(*(cor - q).T).min() for q in line])
    kx = float(k[dist.argmin()])
    s = int(np.hypot(*(cor - (A + kx * d)).T).argmin())
    sk = abs(d @ np.array([T.rx[s], T.ry[s]]))                           # how square to the track it crosses
    hw = T.width[s] / 2
    k0 = kx - (hw + T.be[0][s, rd.EDGE] + 6.0) / sk
    k1 = kx + (hw + T.be[1][s, rd.EDGE] + 6.0) / sk
    if d @ np.array([T.rx[s], T.ry[s]]) < 0:
        k0, k1 = kx - (hw + T.be[1][s, rd.EDGE] + 6.0) / sk, kx + (hw + T.be[0][s, rd.EDGE] + 6.0) / sk
    top = float(T.z[s - 12:s + 13].max()) + site.BRIDGE_CLEAR_M + 0.9
    # the outer line of Turn 1 passes under it too: the deck spans it, as high above it, and no pier stands on it
    foot = Foot()
    f_in, f_z, _ = foot.at(line)
    if f_in.any():
        k0, k1 = min(k0, float(k[f_in].min()) - 3.0), max(k1, float(k[f_in].max()) + 3.0)
        top = max(top, float(f_z[f_in].max()) + site.BRIDGE_CLEAR_M + 0.9)
    L = Local((A[0], A[1], 0.0), np.arctan2(d[1], d[0]))
    hb = 3.4
    p = Parts()
    CO, RO = 0, 1
    pbox(p, L, k0, k1, -hb, hb, top - 0.9, top, CO, uv_scale=(8, 8))
    quad(p, L, k0, k1, -hb + 0.4, hb - 0.4, top + 0.03, RO, uv=((k1 - k0) / 12.0, 1.0))
    for c in (-hb, hb - 0.3):
        pbox(p, L, k0 - 4, k1 + 4, c, c + 0.3, top, top + 1.1, CO, uv_scale=(8, 8))
    keep = []
    for kk, sg in ((k0, -1), (k1, 1)):
        q = A + kk * d
        zg = bl_terrain.ground(float(q[0]), float(q[1]))
        zg = top - 8.0 if zg is None else zg
        pbox(p, L, kk - 1.2, kk + 1.2, -hb - 0.6, hb + 0.6, zg - 3.0, top - 0.9, CO, uv_scale=(8, 8))     # abutment
        keep.append([float(q[0]), float(q[1]), 10.0])
        # the ramp: down to the ground at 8 %
        n = 14
        run = np.linspace(0, max(20.0, (top - zg) / 0.08), n)
        P = q[None] + sg * run[:, None] * d[None]
        g = np.array([bl_terrain.ground(float(x), float(y)) or zg for x, y in P])
        zr = np.maximum(top - 0.08 * run, g + 0.12)
        nr = np.array([d[1], -d[0]])
        for c0, c1, mi in ((-hb + 0.4, hb - 0.4, RO),):
            G = np.stack([np.c_[P + nr * c0, zr], np.c_[P + nr * c1, zr]], 1)
            uv = np.stack([np.stack([run / 12.0, 0 * run], -1), np.stack([run / 12.0, 0 * run + 1], -1)], 1)
            grid(p, G, UP, closed=False, uv=uv, mi=mi)
        for c in (-hb + 0.4, hb - 0.4):                              # its retaining walls
            Wl = np.stack([np.c_[P + nr * c, np.minimum(g - 1.0, zr - 0.2)], np.c_[P + nr * c, zr + 0.9]], 1)
            grid(p, Wl, np.sign(c) * np.array([nr[0], nr[1], 0.0]), closed=False, mi=CO)
            grid(p, Wl, -np.sign(c) * np.array([nr[0], nr[1], 0.0]), closed=False, mi=CO)
        keep += [[float(x), float(y), 7.0] for x, y in P[::3]]
    # one pier each side of the road, behind the barriers
    for lat in (-(hw + T.be[0][s, rd.WALL] + 1.5), hw + T.be[1][s, rd.WALL] + 1.5):
        kk = kx + lat / (d @ np.array([T.rx[s], T.ry[s]]))
        zg = float(at(T, s, lat)[2])
        step = 0.5 if kk > kx else -0.5
        while foot.at((A + kk * d)[None])[0][0] and k0 < kk < k1:
            kk += step
        if not k0 + 2.0 < kk < k1 - 2.0:
            continue
        pbox(p, L, kk - 0.5, kk + 0.5, -hb + 0.8, hb - 0.8, zg - 1.5, top - 0.9, CO, uv_scale=(8, 8))
    p.build('Prop_Bridge_T1', [m['bridge'], m['road']])
    return keep, {'s': s, 'top': round(top, 2), 'clear': round(top - 0.9 - float(T.z[s - 12:s + 13].max()), 2),
                  'span': round(k1 - k0, 1)}


def pavilion(p, L, ra, rc, seed, tiers=2, W=0, GL=1, TI=3):
    """A hospitality pavilion: stacked organic white roofs, each smaller than the one below, around a glazed drum"""
    h = 4.4
    for t in range(tiers):
        f = 0.78 ** t
        a0, c0 = 1.6 * t, -1.2 * t
        z = h * (t + 1) + 0.5 * t
        th, wob = blob(p, L, a0, c0, z, ra * f, rc * f, seed=seed + 7 * t, crown=0.5, n=36, mi=W, thick=0.5)
        rdm = 0.52 * min(ra, rc) * f
        z0 = -0.8 if t == 0 else z - h
        lathe(p, L.pt(a0, c0, 0.0), [(rdm, z0), (rdm, z + 0.1)], n=18, mi=GL if t % 2 == 0 else TI,
              ku=round(TAU * rdm / 8.0) or 1, kv=(z + 0.1 - z0) / 0.5 if t % 2 == 0 else 3.0)
        if t == 0:
            for j in range(0, len(th), len(th) // 6):
                column(p, L, a0 + 0.8 * ra * wob[j] * np.cos(th[j]), c0 + 0.8 * rc * wob[j] * np.sin(th[j]), -0.8, z + 0.1,
                       r=0.22, mi=W)


def palm(p, base, h, seed, TI=3, PL=5):
    """A palm: a slim leaning trunk and a crown of arching fronds"""
    rng = np.random.default_rng(seed)
    base = np.asarray(base, float)
    top = base + np.array([rng.uniform(-0.07, 0.07) * h, rng.uniform(-0.07, 0.07) * h, h])
    th = np.linspace(0, TAU, 5, endpoint=False)
    ring = lambda c, r: c + np.c_[r * np.cos(th), r * np.sin(th), 0 * th]
    grid(p, np.stack([ring(base - [0, 0, 0.6], 0.3), ring(top, 0.17)], 1), (1.0, 0.0, 0.2), closed=True, mi=TI)
    for j in range(8):
        a = TAU * j / 8 + rng.uniform(0, 0.5)
        d = np.array([np.cos(a), np.sin(a), 0.0])
        sd = np.array([-d[1], d[0], 0.0])
        ln = h * 0.4 * rng.uniform(0.85, 1.12)
        mid = [top + [0, 0, 0.15], top + d * ln * 0.5 + [0, 0, 1.0], top + d * ln + [0, 0, -0.9]]
        P = np.array([[q - sd * w, q + sd * w] for q, w in zip(mid, (0.3, 0.75, 0.12))])
        grid(p, P, UP, closed=False, mi=PL)


def paddock(T, m):
    """The hospitality village behind the pit building: tiered pavilions in gardens, a palm promenade, tents, huts"""
    p = Parts()
    W, GL, TH, TI, TR, PL = 0, 1, 2, 3, 4, 5
    keep = []
    for k, (u, dd, ra, rc, tiers) in enumerate(PAVILIONS):
        L = paddock_local(T, u, dd)
        pavilion(p, L, ra, rc, 10 + k, tiers, W, GL, TI)
        keep.append([float(L.o[0]), float(L.o[1]), max(ra, rc) + 3.0])
    for u in (166, 179):                                 # hospitality tents behind the pit building
        tent(p, paddock_local(T, u, 22), 0, 0, mi=W)
    for u in (300, 313, 326):
        tent(p, paddock_local(T, u, 22.5), 0, 0, mi=W)
    for u, dd, r in ((428, 27, 4.2), (438, 37, 3.4), (372, 58, 3.6), (360, 62, 3.0), (283, 62, 4.0), (196, 52, 3.4),
                     (186, 47, 2.8)):
        dome(p, paddock_local(T, u, dd).o, r, 2.3, TI, TH)
    for row, dd in enumerate((44, 49, 54, 59, 64)):      # the teams' transporters, parked side by side
        L = paddock_local(T, 446, dd)
        if T.sl[0][int(PIT_S0 + 446) % T.n] < dd + 3:
            continue
        pbox(p, L, -8.2, 8.2, -1.3, 1.3, -0.3, 3.9, TR, uv_scale=(16.4, 4.2))
    # palms: two rows down the promenade across the paddock, and loose ones among the pavilions
    rng = np.random.default_rng(5)
    for u0, u1, dd in ((205, 395, 43.0), (205, 395, 49.0)):
        for u in np.arange(u0, u1, 11.0):
            L = paddock_local(T, float(u), dd)
            palm(p, L.o, rng.uniform(7.5, 10.5), int(u * 7 + dd), TI, PL)
    for u, dd in ((228, 27), (258, 28), (288, 26), (368, 27), (402, 28), (432, 52), (298, 66), (232, 66), (470, 40)):
        palm(p, paddock_local(T, u, dd).o, rng.uniform(8.0, 11.0), u * 3 + dd, TI, PL)
    p.build('Prop_Paddock_Village', [m['white'], m['glass'], m['thatch'], m['timber'], m['truck'], m['palm']])
    return keep


def lawns(T, m):
    """Grass laid over the paved terraces where the render shows gardens: the paddock village, the strip in front of
    the main stands and the planted wedges between their blocks"""
    idx = T.idx
    p = Parts()
    col = bt.TRACKSIDE * np.array([1.05, 1.1, 1.0])
    u, _ = bt.pit_u(T)
    u = u.astype(float)
    dw = T.be[0][idx][:, rd.WALL]
    out = T.be[0][idx][:, rd.WALL + 1]                                   # the slab's outer edge
    paths = np.zeros(len(u), bool)
    for uc in (203, 262, 334, 398, 452):
        paths |= np.abs(u - uc) < 3.0
    on = (u >= 172) & (u <= 476) & ~paths
    for d0, d1 in ((24.0, 40.5), (51.5, 68.0)):
        a = dw + d0
        b = np.minimum(dw + d1, out - 2.0)
        P = bc.pts(T, 0, np.stack([a, b], 1), dz=0.05)
        p.strip(P, mask=both(on & (b - a > 3.0)), flip=True, uv=P[..., :2] / 6, col=np.broadcast_to(col, P.shape))
    ur = ((idx - TERRACE_S0) % T.n).astype(float)
    dr = T.be[1][idx][:, rd.WALL]
    on = (ur >= STAND_GROUPS[0][0] - 8) & (ur <= STAND_GROUPS[-1][1] + 8)
    # ... which starts beyond the outer Turn 1 road's run-off where that has taken the front of the strip
    lat = np.linspace(1.2, STAND_FRONT - 1.6, 24)
    ins = Foot().at(bc.pts(T, 1, dr[:, None] + lat[None, :])[..., :2].reshape(-1, 2))[0].reshape(len(dr), len(lat))
    k = np.where(ins.any(1), len(lat) - np.argmax(ins[:, ::-1], 1), 0)             # the first column clear of it
    a = dr + np.where(k == 0, lat[0], np.where(k < len(lat), lat[np.minimum(k, len(lat) - 1)] + 1.0, 1e3))
    b = dr + STAND_FRONT - 1.6
    P = bc.pts(T, 1, np.stack([np.minimum(a, b), b], 1), dz=0.05)
    p.strip(P, mask=both(on & (b - a > 2.0)), flip=False, uv=P[..., :2] / 6, col=np.broadcast_to(col, P.shape))
    gap = np.zeros(len(ur), bool)
    for (a0, a1), (b0, b1) in zip(STAND_GROUPS[:-1], STAND_GROUPS[1:]):
        gap |= (ur >= a1) & (ur <= b0)
    F = STAND_FRONT
    rail(p, T, 1, dr, [((F, 0.3, 0), (F + 19.0, 9.5, 3.0))], both(gap), mi=0, ulen=6.0, along=ur, col=col)
    p.build('Ground_Lawns', [m['grass']], extras={'decal': True})


# ---- grandstands ------------------------------------------------------------------------------------------------------
def grandstands(T, m):
    """
    The main stand along the terrace: four groups of seat blocks split by stairs, planted wedges between the groups,
    a concourse behind, and over each group a white cloud of overlapping organic roofs on slim columns.
    """
    idx = T.idx
    ur = ((idx - TERRACE_S0) % T.n).astype(float)
    dw = T.be[1][idx][:, rd.WALL]
    st, can = Parts(), Parts()
    WH, SE = 0, 1
    F = STAND_FRONT
    keep = []
    for a0, a1 in STAND_GROUPS:
        q = both((ur >= a0) & (ur <= a1))
        al = ur - a0
        aisle = q & ((al % AISLE_PITCH) < 1.9)
        seat = q & ~aisle

        def r(segs, mi, mask=q, ulen=8.0, cap=None):
            rail(st, T, 1, dw, segs, mask, mi=mi, ulen=ulen, along=al, cap=cap)

        r([((F, -0.3, 0), (F, 2.2, 1))], WH,                                                         # front wall, ends
          cap=[[(F, -0.3), (F, 2.2), (F + 7.5, 6.0), (F + 7.5, -0.3)], [(F + 7.5, -0.3), (F + 7.5, 6.0), (F + 9.5, 6.0), (F + 9.5, -0.3)],
               [(F + 9.5, -0.3), (F + 9.5, 6.5), (F + 19, 12.4), (F + 19, -0.3)]])
        r([((F, 2.2, 0), (F + 0.3, 2.2, 1))], WH)
        for mask, mi in ((seat, SE), (aisle, WH)):
            r([((F + 0.3, 2.2, 0.0), (F + 7.5, 6.0, 10 / 16))], mi, mask, 32.0)                         # lower tier
            r([((F + 9.5, 6.5, 0.0), (F + 19, 12.4, 13 / 16))], mi, mask, 32.0)                         # upper tier
        r([((F + 7.5, 6.0, 0), (F + 9.5, 6.0, 1)), ((F + 9.5, 6.0, 0), (F + 9.5, 6.5, 1))], WH)       # the walkway between
        r([((F + 19, 12.4, 0), (F + 19, 13.5, 1)), ((F + 19, 13.5, 0), (F + 19.4, 13.5, 1)), ((F + 19.4, 13.5, 1), (F + 19.4, -1.5, 0))], WH,
          cap=[(F + 19, 12.4), (F + 19, 13.5), (F + 19.4, 13.5), (F + 19.4, -1.5)])
    for k, (uc, hl) in enumerate(CANOPIES):                  # the clouds
        sc = (TERRACE_S0 + uc) % T.n
        i = int(sc)
        lat = T.width[i] / 2 + dw[i // bc.STEP] + CANOPY_BACK
        L = Local.on_track(T, sc, lat)
        g = (at(T, sc + 40, lat)[2] - at(T, sc - 40, lat)[2]) / 80
        z = 17.8
        lobes = ((0.0, 0.0, 0.0, 0.62 * hl, 21.0, 56), (-0.56 * hl, 5.0, -0.45, 0.5 * hl, 17.0, 44),
                 (0.56 * hl, -5.0, -0.9, 0.5 * hl, 17.0, 44), (0.25 * hl * (-1) ** k, 27.0, -2.6, 10.0, 8.0, 28))
        for j, (a, c, dz, ra, rc, n) in enumerate(lobes):
            blob(can, L, a, c, z + dz + g * a, ra, rc, seed=10 * k + j + 1, thick=0.5, crown=1.6 if j < 3 else 0.7, n=n, slope=g)
        for a, c in ((-0.8 * hl, 6.0), (-0.4 * hl, -9.0), (0.0, 10.0), (0.4 * hl, -9.0), (0.8 * hl, -6.0), (-0.45 * hl, 12.0),
                     (0.45 * hl, 9.0), (0.0, -11.0), (0.25 * hl * (-1) ** k, 27.0)):
            zt = z + g * a - (2.9 if c > 20 else 1.2)
            q0 = L.pt(a, c, 0.0)
            zg = bl_terrain.ground(float(q0[0]), float(q0[1]))
            z0 = -3.0 if zg is None else min(zg - L.o[2], 0.0) - 1.5
            column(can, L, a, c, z0, zt, r=0.4, mi=1)
        keep += [[*L.pt(a, 6.0, 0)[:2].tolist(), 26.0] for a in np.linspace(-hl, hl, 5)]
    st.build('Prop_Grandstand_Main', [m['white'], m['crowd']])
    can.build('Env_Grandstand_Canopies', [m['canopy'], m['white']])
    return keep


def open_stands(T, m):
    """
    Temporary stands outside the corners: a raked deck of seats on scaffolding. The scaffold shows at the back and at
    both ends, a band of banners runs along the top of the back, and a guard panel follows the rake at each end.
    """
    p = Parts()
    done = []
    WH, SE, SC, B0 = 0, 1, 2, 3
    BAY, LIFT, BAND, BANNER = 5.0, 4.0, 1.1, 17.6           # the scaffold texture's tile; the banner band's half height, a banner's length
    for s, side, length, roofed in site.OPEN_STANDS:
        sg = rd.SIDE_SIGN[side]
        la = T.width[s] / 2 + T.be[side][s, rd.EDGE] + 6
        x0, y0 = T.x[s] + sg * T.rx[s] * la, T.y[s] + sg * T.ry[s] * la
        L0 = Local((x0, y0, 0.0), np.arctan2(T.ty[s], T.tx[s]))
        zs = np.array([[bl_terrain.ground(*L0.pt(a, sg * c, 0)[:2].tolist()) for c in (0, 7, 14)]
                       for a in (-length / 2, 0, length / 2)], object)
        if any(z is None for z in zs.ravel()):
            continue
        zs = zs.astype(float)
        L = Local((x0, y0, zs[:, 0].mean()), L0.yaw)
        lo = zs.min() - L.o[2] - 1.0
        h0, dp, h1 = 1.6, 13.0, 9.4
        a0, a1 = -length / 2, length / 2
        out = sg * L.r                                       # away from the track
        grid(p, [[L.pt(a0, 0, h0), L.pt(a0, sg * dp, h1)], [L.pt(a1, 0, h0), L.pt(a1, sg * dp, h1)]], UP, closed=False,
             uv=np.array([[[0, 0], [0, 1]], [[length / 32.0, 0], [length / 32.0, 1]]], float), mi=SE)
        grid(p, [[L.pt(a0, 0, lo), L.pt(a0, 0, h0)], [L.pt(a1, 0, lo), L.pt(a1, 0, h0)]], -out, closed=False, mi=WH)
        zb = h1 - BAND                                       # the back: scaffold up to the band of banners
        grid(p, [[L.pt(a0, sg * dp, lo), L.pt(a0, sg * dp, zb)], [L.pt(a1, sg * dp, lo), L.pt(a1, sg * dp, zb)]], out, closed=False,
             uv=np.array([[[0, (lo - zb) / LIFT], [0, 0]], [[length / BAY, (lo - zb) / LIFT], [length / BAY, 0]]], float), mi=SC)
        nb = max(1, int(round(length / BANNER)))
        flip = float(np.cross(-out, UP) @ L.t) < 0           # the banners read from behind the stand
        for k in range(nb):
            b0, b1 = a0 + length * k / nb, a0 + length * (k + 1) / nb
            u0, u1 = (1.0, 0.0) if flip else (0.0, 1.0)
            grid(p, [[L.pt(b0, sg * dp, zb), L.pt(b0, sg * dp, h1 + BAND)], [L.pt(b1, sg * dp, zb), L.pt(b1, sg * dp, h1 + BAND)]], out,
                 closed=False, uv=np.array([[[u0, 0], [u0, 1]], [[u1, 0], [u1, 1]]], float), mi=B0 + k % 3)
        grid(p, [[L.pt(a0, sg * dp, h1), L.pt(a0, sg * dp, h1 + BAND)], [L.pt(a1, sg * dp, h1), L.pt(a1, sg * dp, h1 + BAND)]], -out,
             closed=False, mi=WH)                            # the parapet's face towards the seats
        for a, e in ((a0, -1), (a1, 1)):                     # the ends: scaffold under the rake, a guard panel along it
            grid(p, [[L.pt(a, 0, lo), L.pt(a, 0, h0)], [L.pt(a, sg * dp, lo), L.pt(a, sg * dp, h1)]], e * L.t, closed=False,
                 uv=np.array([[[0, (lo - h1) / LIFT], [0, (h0 - h1) / LIFT]], [[dp / BAY, (lo - h1) / LIFT], [dp / BAY, 0]]], float), mi=SC)
            for want in (e * L.t, -e * L.t):
                grid(p, [[L.pt(a, 0, h0), L.pt(a, 0, h0 + BAND)], [L.pt(a, sg * dp, h1), L.pt(a, sg * dp, h1 + BAND)]], want,
                     closed=False, mi=WH)
        if roofed:                                           # a flat white roof on four posts
            P = [[L.pt(a0 - 1, sg * 3, h1 + 4.6), L.pt(a0 - 1, sg * (dp + 1.5), h1 + 3.6)],
                 [L.pt(a1 + 1, sg * 3, h1 + 4.6), L.pt(a1 + 1, sg * (dp + 1.5), h1 + 3.6)]]
            grid(p, P, UP, closed=False)
            grid(p, [[q - 0.3 * UP for q in row] for row in P], -UP, closed=False)
            for a in (a0, a0 + length / 3, a1 - length / 3, a1):
                pbox(p, L, a - 0.2, a + 0.2, sg * dp + 0.3 * sg - 0.2, sg * dp + 0.3 * sg + 0.2, lo, h1 + 3.7, 0)
        done += [L.pt(a, sg * 7, 0)[:2].tolist() + [13.0] for a in np.linspace(a0, a1, max(3, int(length / 16)))]
    p.build('Prop_Stands_Open', [m['white'], m['seats'], m['scaff'], m['b0'], m['b1'], m['b2']])
    return done


# ---- around the venue -------------------------------------------------------------------------------------------------
def lakeside(T, m):
    """Stepped white terraces with thatched domes on the shore, each with a jetty; the hut clusters on the infield"""
    p = Parts()
    sites = []
    for x, y, R in site.TERRACES:
        zg = bl_terrain.ground(x, y) or 0.5
        # the jetty runs out toward the deepest water around
        best, yaw = 1e9, 0.0
        for a in np.linspace(0, TAU, 24, endpoint=False):
            z = np.mean([bl_terrain.ground(x + d * np.cos(a), y + d * np.sin(a)) or 50.0 for d in (R + 14, R + 26, R + 38)])
            if z < best:
                best, yaw = z, a
        L = Local((x, y, 0.0), yaw)
        top = max(zg + 0.5, 2.0)
        prof = [(R + 6 * 1.3, -4.0)]
        for k in range(6, 0, -1):
            prof += [(R + k * 1.3, top - k * 0.45), (R + (k - 1) * 1.3, top - k * 0.45)]
        prof += [(R, top), (0.05, top)]
        lathe(p, L.o, prof, n=40, mi=0, sharp=True)
        for a, c, r in ((-4.0, -2.0, 5.2), (5.5, 1.0, 3.8), (0.5, 6.8, 3.0)):
            dome(p, L.pt(a, c, top), r, 2.2, 1, 2)
        pbox(p, L, R + 5, R + 30, -1.5, 1.5, -1.5, 0.75, mi=1, uv_scale=(3, 3))      # the jetty
        for a in np.arange(R + 6, R + 30, 4.0):
            for c in (-1.4, 1.4):
                column(p, L, a, c, -2.5, 1.2, r=0.12, n=6, mi=1)
        sites.append([x, y, R + 12.0])
    for x, y, r in site.HUTS:                                # the hut clusters inside the esses
        z = bl_terrain.ground(float(x), float(y))
        if z is None or z < 1.0:
            continue
        dome(p, np.array([x, y, z]), r, 2.1 + 0.12 * r, 1, 2)
        sites.append([x, y, r + 5.0])
    p.build('Prop_Lakeside', [m['terrace'], m['timber'], m['thatch']])
    return sites


def fan_zones(T, m):
    """Marquees behind the stands and along the concourse, the support buildings on the infield"""
    p = Parts()
    WH, GL, SO, SH, TR = 0, 1, 2, 3, 4
    keep = []
    cor = np.c_[T.x, T.y]

    def clear(x, y, r):
        """On dry ground, r metres clear of the track"""
        z = bl_terrain.ground(float(x), float(y))
        return z is not None and z > 1.0 and np.hypot(cor[:, 0] - x, cor[:, 1] - y).min() > r

    def marquee(x, y, yaw, la=10.0, lc=6.0):
        if not clear(x, y, 34.0):
            return
        tent(p, Local.on_ground(x, y, yaw), 0, 0, la=la, lc=lc, mi=WH)
        keep.append([float(x), float(y), 9.0])

    for s, side, length, roofed in site.OPEN_STANDS:        # behind each open stand
        sg = rd.SIDE_SIGN[side]
        la = T.width[s] / 2 + T.be[side][s, rd.EDGE] + 6 + 13 + 12
        yaw = np.arctan2(T.ty[s], T.tx[s])
        for a in np.arange(-length / 2 + 8, length / 2 - 7, 15.0):
            marquee(T.x[s] + sg * T.rx[s] * la + T.tx[s] * a, T.y[s] + sg * T.ry[s] * la + T.ty[s] * a, yaw)
    for a in np.arange(24.0, 540.0, 27.0):                   # along the concourse behind the main stands
        s = int(TERRACE_S0 + a) % T.n
        la = T.width[s] / 2 + T.be[1][s, rd.EDGE] + 15
        marquee(T.x[s] + T.rx[s] * la, T.y[s] + T.ry[s] * la, np.arctan2(T.ty[s], T.tx[s]), la=9.0, lc=5.0)
    for x, y, yaw, count, pitch in site.MARQUEES:
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        for k in range(count):
            marquee(x + ca * pitch * k, y + sa * pitch * k, np.radians(yaw), la=10.0, lc=8.0)
    for x, y, la, lc, h, yaw, roof in site.INFIELD:
        if not clear(x, y, 30.0 + la / 2):
            continue
        L = Local.on_ground(x, y, np.radians(yaw))
        pbox(p, L, -la / 2, la / 2, -lc / 2, lc / 2, -2.0, h, SH if roof == 'dark' else WH)
        pbox(p, L, -la / 2 - 0.5, la / 2 + 0.5, -lc / 2 - 0.5, lc / 2 + 0.5, h, h + 0.35, {'white': WH, 'solar': SO, 'dark': SH}[roof])
        for sg in (-1, 1) if roof != 'dark' else ():         # a band of glazing down each long side
            c0, c1 = sorted((sg * lc / 2, sg * (lc / 2 + 0.05)))
            pbox(p, L, -la / 2 + 1.5, la / 2 - 1.5, c0, c1, 1.0, h - 0.8, GL, uv_scale=(4, 3.5))
        keep.append([float(x), float(y), max(la, lc) / 2 + 5])
    for x, y, yaw, count, pitch in site.TRUCKS:              # transporters side by side on the yards
        ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
        for k in range(count):
            L = Local.on_ground(x + ca * pitch * k, y + sa * pitch * k, np.radians(yaw + 90.0))
            pbox(p, L, -8.2, 8.2, -1.3, 1.3, 0.0, 3.9, TR, uv_scale=(16.4, 4.2))
    p.build('Prop_FanZones', [m['white'], m['glass'], m['solar'], m['shed'], m['truck']])
    return keep


def kart(T, m):
    """The kart circuit beside the back straight: its long pit building and the marquees by its car park"""
    p = Parts()
    WH, GL = 0, 1
    o, a, r = site.pad_frame('kart')
    yaw = np.radians(site.PADS['kart'][4])
    ca, cc, la, lc, h = site.KART_BUILDING
    c = o + ca * a + cc * r
    L = Local.on_ground(c[0], c[1], yaw)
    pbox(p, L, -la / 2, la / 2, -lc / 2, lc / 2, -1.5, h, WH)
    pbox(p, L, -la / 2 - 0.8, la / 2 + 0.8, -lc / 2 - 0.8, lc / 2 + 3.2, h, h + 0.4, WH)      # the roof, over the pit apron
    pbox(p, L, -la / 2 + 2.0, la / 2 - 2.0, lc / 2, lc / 2 + 0.05, 0.9, h - 1.0, GL, uv_scale=(4, 3.5))
    for a_ in np.arange(-la / 2 + 6.0, la / 2 - 5.0, 12.0):
        column(p, L, a_, lc / 2 + 2.8, -1.0, h, r=0.18, mi=WH)
    pc, pcc, ha, hc = site.KART_PARKING
    for k in range(3):
        q = o + (pc - ha + 6.0 + 13.0 * k) * a + (pcc + hc + 9.0) * r
        tent(p, Local.on_ground(q[0], q[1], yaw), 0, 0, la=10.0, lc=7.0, mi=WH)
    p.build('Prop_Kart', [m['white'], m['glass']])
    return [[float(c[0]), float(c[1]), la / 2 + 6.0]]


def causeway(T, m):
    """The stone dam that holds the lagoon inside Turn 11: riprap laid over its banks, a footpath along its top"""
    P, _ = resample(site.chaikin(np.array(site.CAUSEWAY, float), 2), 4.0)
    t = np.gradient(P[:, :2], axis=0)
    t /= np.hypot(*t.T)[:, None]
    nrm = np.c_[t[:, 1], -t[:, 0]]
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(P[:, :2], axis=0).T))]
    offs = np.array([-15.0, -11.0, -7.5, -3.5, -1.3, 1.3, 3.5, 7.5, 11.0, 15.0])
    G = np.zeros((len(P), len(offs), 3))
    for j, o in enumerate(offs):
        xy = P[:, :2] + nrm * o
        z = [bl_terrain.ground(float(x), float(y)) for x, y in xy]
        G[:, j] = np.c_[xy, np.array([P[i, 2] - 3.0 if v is None else v for i, v in enumerate(z)]) + 0.1]
    uv = np.stack([np.stack([np.full(len(P), (o + 15.0) / 6.0), seg / 6.0], -1) for o in offs], 1)
    p = Parts()
    grid(p, G[:, 0:5], UP, closed=False, uv=uv[:, 0:5], mi=0)
    grid(p, G[:, 5:10], UP, closed=False, uv=uv[:, 5:10], mi=0)
    grid(p, G[:, 4:6], UP, closed=False, uv=np.stack([np.stack([0 * seg, seg / 3], -1), np.stack([0 * seg + 0.8, seg / 3], -1)], 1),
         mi=1)
    p.build('Ground_Causeway', [m['rock'], m['path']], extras={'decal': True})


def roads(T, m):
    """The roads, footpaths, car parks and courts around the venue, lying on the ground"""
    p = Parts()
    RO, PA, PK, CT, KT, KS = 0, 1, 2, 3, 4, 5
    for name, width, kind, pts in site.ROADS:
        P = site.chaikin(np.array(pts, float), 2)
        if kind == 'asphalt':
            ribbon(p, P, width, mi=RO, shoulder=PA)
        else:
            ribbon(p, P, width, mi=PA, vlen=3.0)
    for name, P3, hwid, blend, road in site.beds(T):
        if road:
            ribbon(p, P3, road[0], mi=RO, shoulder=PA, lift=0.06)
    for name, tex_m, mi in (('carpark_n', (10.0, 16.0), PK), ('gate', (10.0, 16.0), PK), ('yard_w', (10.0, 16.0), PK),
                            ('yard_e', (10.0, 16.0), PK), ('plaza_n', (10.0, 16.0), PK), ('courts', (30.0, 15.0), CT)):
        cx, cy, ha, hc, yaw = site.PADS[name][:5]
        L = Local.on_ground(cx, cy, np.radians(yaw))
        if mi == CT:                                         # three courts in a row, a strip of clay around
            for a in (-36.0, 0.0, 36.0):
                quad(p, L, a - 15, a + 15, -7.5, 7.5, 0.1, mi)
        else:
            na, nc = round((2 * ha - 4) / tex_m[0]), max(1, round((2 * hc - 4) / tex_m[1]))
            quad(p, L, -na * tex_m[0] / 2, na * tex_m[0] / 2, -nc * tex_m[1] / 2, nc * tex_m[1] / 2, 0.1, mi, uv=(na, nc))
    # the kart circuit: its asphalt with a white apron either side, and its car park
    loop = site.kart_loop()
    ribbon(p, np.vstack([loop, loop[:3]]), site.KART_WIDTH_M, mi=KT, shoulder=KS, step=2.0, lift=0.12)
    o, a, r = site.pad_frame('kart')
    pc, pcc, ha, hc = site.KART_PARKING
    q = o + pc * a + pcc * r
    quad(p, Local.on_ground(q[0], q[1], np.radians(site.PADS['kart'][4])), -ha, ha, -hc, hc, 0.1, PK,
         uv=(max(1, round(2 * ha / 10.0)), max(1, round(2 * hc / 16.0))))
    p.build('Ground_Roads', [m['road'], m['path'], m['parking'], m['court'], m['service'], m['paint']], extras={'decal': True})


def road_bridge(T, m):
    """The road bridge over the track on the way out of Turn 17: deck, parapets, piers behind the barriers, abutments"""
    b = site.bridge(T)
    s = b['s']
    L = Local((b['p'][0], b['p'][1], 0.0), np.arctan2(b['t'][1], b['t'][0]))
    top, th, hb = b['top'], site.BRIDGE_DECK_M, site.BRIDGE_WIDTH_M / 2
    cl, cr = -b['c_l'], b['c_r']
    p = Parts()
    CO, RO, BN = 0, 1, 2
    pbox(p, L, -hb, hb, cl, cr, top - th, top, CO, uv_scale=(8, 8))
    for a in (-hb, hb - 0.35):                               # parapets, running on over the abutments
        pbox(p, L, a, a + 0.35, cl - 5, cr + 5, top, top + 1.15, CO, uv_scale=(8, 8))
    for c in (cl, cr):                                       # abutments
        pbox(p, L, -hb - 0.8, hb + 0.8, c - 1.3, c + 1.3, top - 18.0, top - th, CO, uv_scale=(8, 8))
    hw = T.width[s] / 2
    for c in (-(hw + T.be[0][s, rd.WALL] + 1.3), hw + T.be[1][s, rd.WALL] + 1.3):
        zg = float(at(T, s, c)[2])
        pbox(p, L, -hb + 0.9, hb - 0.9, c - 0.45, c + 0.45, zg - 1.5, top - th, CO, uv_scale=(8, 8))
        pbox(p, L, -hb + 0.5, hb - 0.5, c - 0.7, c + 0.7, top - th - 0.5, top - th, CO, uv_scale=(8, 8))
    quad(p, L, -3.5, 3.5, cl - 2, cr + 2, top + 0.03, RO, uv=(1.0, (cr - cl + 4) / 12.0))
    for a in (-hb - 0.04, hb):                               # a banner over the track on both faces
        pbox(p, L, a, a + 0.04, -8.0, 8.0, top - 0.85, top + 1.15, BN)
    p.build('Prop_RoadBridge', [m['bridge'], m['road'], m['b0']])
    return [[*(b['p'] + b['r'] * c), 14.0] for c in (cl, cr)]


# ---- over and beside the track ----------------------------------------------------------------------------------------
def wall_lats(T, s, out=0.8):
    """Lateral offsets just behind the two barriers at a station"""
    i = int(s) % T.n
    hw = T.width[i] / 2
    return -(hw + T.be[0][i, rd.WALL] + out), hw + T.be[1][i, rd.WALL] + out


def span(p, T, s, lat0, lat1, z0=6.8, z1=8.3, depth=1.2, mi_beam=0, mi_post=1, mi_banner=2):
    """A beam across the track on two posts, a banner on both of its faces"""
    L = Local.on_track(T, s, 0.0)
    for lat in (lat0, lat1):
        zg = at(T, s, lat)[2] - L.o[2]
        pbox(p, L, -0.3, 0.3, lat - 0.3, lat + 0.3, zg - 0.4, z0, mi_post, uv_scale=(2, 4))
    pbox(p, L, -depth / 2, depth / 2, lat0 - 0.6, lat1 + 0.6, z0, z1, mi_beam)
    h = z1 - z0 - 0.3
    pbox(p, L, -depth / 2 - 0.03, depth / 2 + 0.03, -4 * h, 4 * h, z0 + 0.15, z1 - 0.15, mi_banner)
    return L


def gantries(T, m):
    i = int(GANTRY_S)
    hw = T.width[i] / 2
    p = Parts()
    L = span(p, T, GANTRY_S, -(hw + T.pw[0][i] + T.ga[0][i] / 2), hw + T.be[1][i, rd.WALL] + 0.8)   # pit wall to terrace
    pbox(p, L, -0.9, -0.6, -1.0, -0.8, 6.45, 6.85, 1)                        # the light panel's hangers
    pbox(p, L, -0.9, -0.6, 0.8, 1.0, 6.45, 6.85, 1)
    p.build('Prop_StartGantry', [m['blue'], m['metal'], m['b0']])
    # The light panel: five columns of four lamps facing the grid. The game hangs its own lit lamps on the third
    # row (1/8 of the panel's height below its centre), a fifth of its width apart.
    q = Parts()
    zc, H, W = 5.7, 1.6, 3.0
    pbox(q, L, -0.95, -0.7, -W / 2, W / 2, zc - H / 2, zc + H / 2, 0)
    th = np.linspace(0, TAU, 12, endpoint=False)
    rr = np.array([0.01, 0.16])
    for ci in range(5):
        for ri in range(4):
            P = L.pt(-0.97, (ci - 2) * W / 5 + rr[None] * np.cos(th)[:, None],
                     zc + (1.5 - ri) * H / 4 + rr[None] * np.sin(th)[:, None])
            grid(q, P, -L.t, mi=1)
    q.build('Prop_StartLights_0', [m['panel'], m['lens']])

    p = Parts()
    placed = []
    for k, s0 in enumerate(SPANS):                           # each stands where the track is narrowest near its spot
        cand = [(wall_lats(T, s)[1] - wall_lats(T, s)[0], s) for s in np.arange(s0 - 40, s0 + 41, 5.0)]
        w, s = min(cand)
        if w > 40.0:
            continue
        lat0, lat1 = wall_lats(T, s)
        span(p, T, s, lat0, lat1, mi_banner=2 + k % 3)
        placed.append((float(s), round(float(w), 1)))
    p.build('Prop_Bridges', [m['blue'], m['metal'], m['b1'], m['b2'], m['b0'], m['white']])
    return placed


def banners(T, m):
    idx = T.idx
    p = Parts()
    al = ((idx - TERRACE_S0) % T.n).astype(float)                            # the main straight's right-hand wall
    dw = T.be[1][idx][:, rd.WALL]
    conc = both(T.fence[1][idx] > 0.5)
    for k in range(3):
        rail(p, T, 1, dw, [((-0.03, 0.08, 0.0), (-0.03, 0.92, 1.0))], conc & ((al // 8).astype(int) % 3 == k), mi=k,
             ulen=-8.0, along=al)
    u, _ = bt.pit_u(T)                                                       # the pit wall, facing the track
    dref, pwm = bt.pit_wall_line(T)
    al = (u - 96).astype(float)
    for k in range(3):
        rail(p, T, 0, dref, [((-0.18, 0.08, 0.0), (-0.18, 0.92, 1.0))], both(pwm) & ((al // 8).astype(int) % 3 == k),
             mi=k, ulen=8.0, along=al)
    # Hoardings behind the barrier round the outside of the corners
    kap = np.gradient(np.unwrap(np.arctan2(T.ty, T.tx)))                     # + = turning left
    for side in (0, 1):
        tight = (kap < -1 / 350) if side == 0 else (kap > 1 / 350)
        near = np.convolve(np.r_[tight[-30:], tight, tight[:30]].astype(float), np.ones(61), mode='valid') > 0.5
        dw = T.be[side][idx][:, rd.WALL]
        q = both(near[idx] & (T.wallvis[side][idx] > 0.5) & (T.sl[side][idx] < 0.5) & (T.pr[side][idx] < 0.1)
                 & (T.fence[side][idx] < 0.5))
        al = idx.astype(float)
        for k in range(3):
            rail(p, T, side, dw, [((0.95, 0.55, 0.0), (0.95, 1.65, 1.0))], q & ((al // 8).astype(int) % 3 == k), mi=k,
                 ulen=8.0 if side == 0 else -8.0, along=al)
        rail(p, T, side, dw, [((1.0, 1.65, 1.0), (1.0, 0.55, 0.0))], q, mi=3, ulen=8.0)
    p.build('Prop_Banners', [m['b0'], m['b1'], m['b2'], m['white']])


def brake_boards(T, m):
    p = Parts()
    order = (50, 100, 150, 200)
    for s0, side, dists in BRAKE_BOARDS:
        sg = rd.SIDE_SIGN[side]
        for d in dists:
            s = (s0 - d) % T.n
            lat = sg * (T.width[s] / 2 + T.be[side][s, rd.WALL] - 1.6 - 0.75 * (T.tec[side][s] > 0.5))
            L = Local.on_track(T, s, lat)
            pbox(p, L, -0.04, 0.04, -0.75, 0.75, 0.75, 1.5, order.index(d))
            for c in (-0.6, 0.6):
                pbox(p, L, -0.03, 0.03, c - 0.03, c + 0.03, -0.3, 0.75, 4)
    p.build('Prop_BrakeBoards', [m[f'board{d}'] for d in order] + [m['post']])


def marshal_posts(T, m):
    p = Parts()
    for k, s in enumerate(range(290, 5565, 270)):
        side = k % 2
        if T.sl[side][s] > 0.5 or T.pr[side][s] > 0.1 or T.fence[side][s] > 0.5:
            continue
        L = Local.on_track(T, s, rd.SIDE_SIGN[side] * (T.width[s] / 2 + T.be[side][s, rd.WALL] + 1.25))
        pbox(p, L, -1.2, 1.2, -0.85, 0.85, -0.6, 2.3, 0)
        pbox(p, L, -1.5, 1.5, -1.1, 1.1, 2.3, 2.45, 1)
    p.build('Prop_MarshalPosts', [m['orange'], m['white']])


def tv_towers(T, m):
    """Scaffold towers under the trackside TV cameras (the first camera stands on the pit building's roof)"""
    p = Parts()
    spots = []
    w = 1.0
    for k, (s, side, h) in enumerate(site.CAMERAS):
        if k == 0:
            continue
        sg = rd.SIDE_SIGN[side]
        L = Local.on_track(T, s, sg * site.camera_lat(T, s, side))
        hp = h - 1.75                                        # the deck the operator stands on
        for a in (-w, w):
            for c in (-w, w):
                pbox(p, L, a - 0.05, a + 0.05, c - 0.05, c + 0.05, -0.8, hp + (0.0 if c * sg < 0 else 1.0), 0)
        lv = np.linspace(0.3, hp, max(2, int(round(hp / 2.1))) + 1)
        ring = (((-w, -w), (w, -w)), ((w, -w), (w, w)), ((w, w), (-w, w)), ((-w, w), (-w, -w)))
        for j, (z0, z1) in enumerate(zip(lv[:-1], lv[1:])):
            for (a0, c0), (a1, c1) in ring:
                tube(p, L.pt(a0, c0, z1), L.pt(a1, c1, z1), 0.03, 0)
                A, B = ((a0, c0), (a1, c1)) if j % 2 == 0 else ((a1, c1), (a0, c0))
                tube(p, L.pt(*A, z0), L.pt(*B, z1), 0.025, 0)
        pbox(p, L, -w - 0.2, w + 0.2, -w - 0.2, w + 0.2, hp - 0.08, hp, 1)
        back = sg * w                                        # guard rails on the three sides away from the track
        for z in (hp + 0.55, hp + 1.0):
            tube(p, L.pt(-w, back, z), L.pt(w, back, z), 0.025, 0)
            for a in (-w, w):
                tube(p, L.pt(a, back, z), L.pt(a, -back * 0.2, z), 0.025, 0)
        pbox(p, L, -w, w, -sg * w - 0.03 * (sg > 0), -sg * w + 0.03 * (sg < 0), hp - 2.3, hp - 0.3, 3)   # a banner wrap
        pbox(p, L, -0.04, 0.04, -0.04, 0.04, hp, hp + 1.15, 2)               # the camera on its stand
        pbox(p, L, -0.5, 0.2, -0.16, 0.16, hp + 1.15, hp + 1.47, 2)
        spots.append([float(L.o[0]), float(L.o[1]), 4.0])
    p.build('Prop_TVTowers', [m['steel'], m['timber'], m['dark'], m['blue']])
    return spots


def screens(T, m):
    """Big screens on two posts beside the track, showing their picture on both faces"""
    p = Parts()
    spots = []
    W, H, Z0 = 12.0, 6.75, 4.2
    for s, side in site.SCREENS:
        sg = rd.SIDE_SIGN[side]
        lat = T.width[s] / 2 + T.be[side][s, rd.EDGE] + 4.0
        x, y = float(T.x[s] + sg * T.rx[s] * lat), float(T.y[s] + sg * T.ry[s] * lat)
        L = Local.on_ground(x, y, np.arctan2(T.ty[s], T.tx[s]), default=float(T.edge_z[side][s]))
        c0, c1 = sorted((0.0, sg * 0.6))
        pbox(p, L, -W / 2 - 0.25, W / 2 + 0.25, c0, c1, Z0 - 0.25, Z0 + H + 0.25, 0)
        c = -sg * 0.03
        P = [[L.pt(-W / 2, c, Z0), L.pt(-W / 2, c, Z0 + H)], [L.pt(W / 2, c, Z0), L.pt(W / 2, c, Z0 + H)]]
        u0, u1 = (1.0, 0.0) if sg > 0 else (0.0, 1.0)                        # the picture reads from the track
        grid(p, P, -sg * L.r, closed=False, uv=np.array([[[u0, 0], [u0, 1]], [[u1, 0], [u1, 1]]], float), mi=1)
        c = sg * 0.63                                                         # and from behind
        P = [[L.pt(-W / 2, c, Z0), L.pt(-W / 2, c, Z0 + H)], [L.pt(W / 2, c, Z0), L.pt(W / 2, c, Z0 + H)]]
        grid(p, P, sg * L.r, closed=False, uv=np.array([[[u1, 0], [u1, 1]], [[u0, 0], [u0, 1]]], float), mi=1)
        c0, c1 = sorted((sg * 0.05, sg * 0.55))                               # two posts under the cabinet
        for a in (-W / 2 + 1.5, W / 2 - 1.5):
            pbox(p, L, a - 0.25, a + 0.25, c0, c1, -3.0, Z0 - 0.25, 2)
        spots.append([x, y, 9.0])
    p.build('Prop_Screens', [m['dark'], m['screen'], m['steel']])
    return spots


def wheel(p, L, a, c, r=0.5, w=0.35, mi=0):
    """A wheel standing on the ground at (a, c), its axle across the frame"""
    th = np.linspace(0, TAU, 12, endpoint=False)
    rim = [[L.pt(a + r * np.cos(x), c - w / 2, r + r * np.sin(x)), L.pt(a + r * np.cos(x), c + w / 2, r + r * np.sin(x))] for x in th]
    grid(p, np.array(rim), L.t, closed=True, mi=mi)
    for cc, sg in ((c - w / 2, -1), (c + w / 2, 1)):
        fan = [[L.pt(a, cc, r), L.pt(a + r * np.cos(x), cc, r + r * np.sin(x))] for x in th]
        grid(p, np.array(fan), sg * L.r, closed=True, mi=mi)


def vehicles(T, m):
    """Recovery telehandlers and ambulances waiting on the service road, medical cars by the medical centre"""
    p = Parts()
    YE, DK, WH, RE, TY = 0, 1, 2, 3, 4

    def telehandler(L):
        pbox(p, L, -2.3, 2.2, -1.05, 1.05, 0.55, 1.5, YE)
        pbox(p, L, -1.2, 0.3, -1.0, -0.05, 1.5, 2.6, DK)                    # the cab, to one side
        pbox(p, L, -1.25, 0.35, -1.05, 0.0, 2.6, 2.7, YE)
        tube(p, L.pt(-2.0, 0.5, 1.7), L.pt(3.6, 0.5, 3.4), 0.22, YE)        # the boom, half raised
        tube(p, L.pt(3.6, 0.5, 3.4), L.pt(4.1, 0.5, 2.6), 0.12, DK)
        for a in (-1.5, 1.5):
            for c in (-1.1, 1.1):
                wheel(p, L, a, c, r=0.62, w=0.42, mi=TY)

    def van(L):
        pbox(p, L, -2.6, 1.3, -1.0, 1.0, 0.45, 2.45, WH)
        pbox(p, L, 1.3, 2.6, -1.0, 1.0, 0.45, 1.45, WH)                      # the bonnet
        pbox(p, L, 1.25, 1.95, -0.95, 0.95, 1.45, 2.2, DK)                   # windscreen and cab glass
        pbox(p, L, -2.62, 1.32, -1.02, 1.02, 1.25, 1.55, RE)                 # a red band round the body
        pbox(p, L, -0.4, 0.4, -0.5, 0.5, 2.45, 2.6, RE)                      # the light bar
        for a in (-1.7, 1.8):
            for c in (-1.0, 1.0):
                wheel(p, L, a, c, r=0.36, w=0.26, mi=TY)

    def on_service(s, side, kind):
        if T.sr[side][s] < 3.0:
            return False
        lat = T.width[s] / 2 + T.be[side][s, rd.WALL] + T.sv[side][s] + T.sr[side][s] / 2
        L = Local.on_track(T, s, rd.SIDE_SIGN[side] * lat)
        kind(L)
        return True

    n = 0
    for s, side in ((919, 0), (1432, 1), (1742, 1), (2893, 1), (3255, 0), (3953, 1), (4329, 0), (5514, 1)):
        n += on_service(s, side, telehandler)
    for s, side in ((904, 0), (2919, 1), (3960, 1), (5102, 1)):
        n += on_service(s, side, van)
    for k in range(3):                                       # by the technical annex
        Lm = paddock_local(T, BUILDING_U[0] + 4 + 5.5 * k, 19.5)
        van(Local(Lm.o, Lm.yaw + np.pi / 2))

    def helicopter(L):
        pbox(p, L, -1.6, 2.4, -0.85, 0.85, 0.7, 2.3, RE)                     # cabin
        pbox(p, L, 1.5, 2.45, -0.8, 0.8, 1.3, 2.2, DK)                       # its glazing
        tube(p, L.pt(-1.6, 0, 1.9), L.pt(-6.4, 0, 2.3), 0.22, RE)            # tail boom
        pbox(p, L, -6.9, -6.2, -0.06, 0.06, 1.9, 3.4, RE)                    # fin
        pbox(p, L, -0.2, 0.2, -0.2, 0.2, 2.3, 2.85, DK)                      # mast
        for yaw in (0.4, 0.4 + np.pi / 2):                                   # rotor: two crossed blades
            ca, sa = np.cos(yaw), np.sin(yaw)
            tube(p, L.pt(-5.4 * ca, -5.4 * sa, 2.9), L.pt(5.4 * ca, 5.4 * sa, 2.9), 0.09, DK)
        for c in (-1.05, 1.05):                                              # skids
            tube(p, L.pt(-1.7, c, 0.12), L.pt(2.3, c, 0.12), 0.07, DK)
            for a in (-0.9, 1.5):
                tube(p, L.pt(a, c, 0.12), L.pt(a, 0.7 * np.sign(c), 0.75), 0.05, DK)

    Lh = paddock_local(T, *HELIPAD)
    helicopter(Local(Lh.o, Lh.yaw + 0.5))
    Lh = paddock_local(T, HELIPAD[0] + 3, HELIPAD[1] - 19)
    helicopter(Local(Lh.o, Lh.yaw - 0.7))
    p.build('Prop_Vehicles', [m['yellow'], m['dark'], m['white'], m['red'], m['tyre']])
    return n


def flags(T, m):
    """Rwanda's colours on poles along the grandstand terrace and the paddock front"""
    p = Parts()
    ends = [e for a0, a1 in STAND_GROUPS for e in (a0 - 3.0, a1 + 3.0)]
    spots = [((TERRACE_S0 + a) % T.n, 1) for a in ends]
    spots += [((PIT_S0 + u) % T.n, 0) for u in (122, 128, 434, 440)]
    for s, side in spots:
        i = int(s)
        L = Local.on_track(T, s, rd.SIDE_SIGN[side] * (T.width[i] / 2 + T.be[side][i, rd.WALL] + 1.5))
        lathe(p, L.o, [(0.07, -0.4), (0.05, 9.2)], n=6, mi=1)
        a = np.linspace(0.08, 2.6, 6)
        c = 0.14 * np.sin(a * 2.3)
        for (z0, z1), col in zip(((8.15, 9.0), (7.72, 8.15), (7.3, 7.72)), FLAG):
            P = np.stack([L.pt(a, c, z0), L.pt(a, c, z1)], 0)
            grid(p, P, L.r, closed=False, mi=0, col=np.array(col))
    p.build('Env_Flags', [m['flag'], m['post']])


OBJECTS = ('Prop_PitBuilding', 'Ground_Helipad', 'Env_Spire', 'Prop_Paddock_Village', 'Ground_Lawns', 'Prop_Bridge_T1', 'Prop_Grandstand_Main',
           'Env_Grandstand_Canopies', 'Prop_Stands_Open', 'Prop_Lakeside', 'Ground_Causeway', 'Ground_Roads',
           'Prop_RoadBridge', 'Prop_StartGantry', 'Prop_StartLights_0', 'Prop_Bridges', 'Prop_Banners',
           'Prop_BrakeBoards', 'Prop_MarshalPosts', 'Prop_TVTowers', 'Prop_Screens', 'Prop_Vehicles', 'Prop_FanZones',
           'Prop_Kart', 'Env_Flags')


def unsupported(P, foot, reach=12.0, hold=1.3):
    """Which points within `reach` of an add-on have no barrier within `hold` metres to hang on"""
    import bl_addon
    near = np.zeros(len(P), bool)
    for r in (reach / 2, reach):
        for a in np.linspace(0, 2 * np.pi, 8, endpoint=False):
            near |= foot.at(P + r * np.array([np.cos(a), np.sin(a)]))[0]
    out = np.zeros(len(P), bool)
    k = np.flatnonzero(near)
    if not len(k):
        return out
    rows = bl_addon.wall_segments()
    A = np.array([r[2:4] for r in rows])
    B = np.array([r[5:7] for r in rows])
    Q = P[k].astype(float)
    lo, hi = Q.min(0) - 5, Q.max(0) + 5
    use = (np.maximum(A, B) > lo).all(1) & (np.minimum(A, B) < hi).all(1)
    A, B = A[use], B[use]
    best = np.full(len(Q), 1e9)
    for a, b in zip(A, B):
        best = np.minimum(best, bl_addon.seg_dist(Q, a, b)[0])
    out[k] = best > hold
    return out


def give_way():
    """Nothing of the scenery stands on the add-on roads: banners end where the barriers were opened for them; posts,
    boards, towers and vehicles that would stand on one go"""
    import bmesh
    foot = Foot()
    out = {}
    for name, whole in (('Prop_Banners', False), ('Prop_Vehicles', True), ('Prop_MarshalPosts', True), ('Prop_BrakeBoards', True),
                        ('Prop_TVTowers', True), ('Prop_Screens', True), ('Prop_Stands_Open', True), ('Env_Flags', True)):
        ob = bpy.data.objects.get(name)
        if not ob:
            continue
        V = np.zeros(len(ob.data.vertices) * 3, np.float32)
        ob.data.vertices.foreach_get('co', V)
        ins = foot.at(V.reshape(-1, 3)[:, :2], inner=True)[0]
        if name == 'Prop_Banners':                  # and where the barrier they hung on is gone
            ins |= unsupported(V.reshape(-1, 3)[:, :2], foot)
        if not ins.any():
            continue
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.verts.ensure_lookup_table()
        if whole:                                   # every connected piece with a vertex on a road
            seen, gone = set(), []
            for v in bm.verts:
                if v.index in seen:
                    continue
                isle, stack = [], [v]
                seen.add(v.index)
                while stack:
                    a = stack.pop()
                    isle.append(a)
                    for e in a.link_edges:
                        b = e.other_vert(a)
                        if b.index not in seen:
                            seen.add(b.index)
                            stack.append(b)
                if any(ins[a.index] for a in isle):
                    gone += isle
            bmesh.ops.delete(bm, geom=gone, context='VERTS')
            out[name] = len(gone)
        else:
            gone = [f for f in bm.faces if any(ins[v.index] for v in f.verts)]
            bmesh.ops.delete(bm, geom=gone, context='FACES')
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
            out[name] = len(gone)
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
    return out


def build():
    T = bc.design()
    m = materials()
    pit_building(T, m)
    keep = paddock(T, m)
    keep += grandstands(T, m)
    lawns(T, m)
    kb, t1 = t1_bridge(T, m)
    keep += kb
    keep += open_stands(T, m)
    keep += lakeside(T, m)
    causeway(T, m)
    roads(T, m)
    keep += road_bridge(T, m)
    spans = gantries(T, m)
    banners(T, m)
    brake_boards(T, m)
    marshal_posts(T, m)
    keep += tv_towers(T, m)
    keep += screens(T, m)
    parked = vehicles(T, m)
    keep += fan_zones(T, m)
    keep += kart(T, m)
    flags(T, m)
    out = {'spans': spans, 'vehicles': parked, 't1_bridge': t1}
    for name in OBJECTS:
        ob = bpy.data.objects.get(name)
        out[name] = sum(len(f.vertices) - 2 for f in ob.data.polygons) if ob else None
    out['gave way'] = give_way()
    out['trees'] = bl_terrain.export_trees(keep)             # no trees through the stands, terraces and towers
    return out
