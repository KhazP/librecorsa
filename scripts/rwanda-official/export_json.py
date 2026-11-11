"""
Writes the game's track data of the official Rwanda circuit, one file per lap of the one built scene:

    long   public/tracks/rwanda_official/track_data.json         outer Turn 1, the north-east loop, the outer Turn 8 hairpin
    short  public/tracks/rwanda_official_short/track_data.json   inner Turn 1, the link instead of the loop, the inner Turn 8

Each is the built lap (data/design.npz) with the road sections of ro_addon.py spliced in: centreline samples every
5 m with the surface heights across, corners, sectors, grid, cameras, pit lane, boundaries. The racing lines are
filled in afterwards by scripts/optimize-racing-line.ts.

    ~/.venvs/librecorsa-tracks/bin/python scripts/rwanda-official/export_json.py [long|short]
"""
import json
import os
import sys

import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prep  # noqa: E402
import ro_addon as ra  # noqa: E402
import ro_design as rd  # noqa: E402
import ro_site as site  # noqa: E402
from prep import CORNERS, PIT_LEN, PIT_S0  # noqa: E402
from ro_foot import Foot  # noqa: E402

TRACKS = os.path.abspath(os.path.join(HERE, '..', '..', 'public', 'tracks'))
GLB = '/tracks/rwanda_official/rwanda_official.glb'
FOLIAGE = '/tracks/rwanda_official/scenery/foliage.glb'
LAT = [-12, -8, -5, -2.5, 0, 2.5, 5, 8, 12]
STEP = 5
BASE_ALTITUDE_M = 1328
GRID_SLOTS, GRID_FIRST_M, GRID_PITCH_M, GRID_LAT_M = 20, 6.0, 8.0, 2.9
ZONES = {1: 'rwandair_blue_yellow', 2: 'hills_yellow_green', 3: 'bugesera_cyan'}
GEAR_KMH = (95, 130, 165, 200, 240, 280, 315)
ESSES = 'Kidogo Esses'
NAMES = {num: name for num, a, b, d, name in CORNERS if num}

# What each lap is: the add-ons it runs on, its corners in order (a built corner by its number, an add-on's tightest
# bend by (add-on, name)), where its first sector ends and its second activation zone (built stations, or metres
# before / after the end of an add-on)
LAYOUTS = {
    'long': dict(
        id='rwanda_official', layout='Grand Prix', short='RISE GP', use=('t1o', 't8o'),
        turns=(('t1o', 'Plateau Sweep'), 2, 3, 4, 5, 6, 7, ('t8o', 'Forest Hairpin'), 9, 10, 11, 12, 13, 14, 15, 16, 17),
        sector1=('built', 1805), drs2=(('built', 1792), ('built', 1855), ('built', 2650)),
        blurb='the Grand Prix lap: the outer line through Turn 1, the loop over the ridge and the outer hairpin at Turn 8'),
    'short': dict(
        id='rwanda_official_short', layout='Short', short='RISE short', use=('link',),
        turns=(1, 2, ('link', 'Link Hairpin'), 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17),
        sector1=('link', 0.0), drs2=(('link', -150.0), ('link', 40.0), ('built', 2650)),
        blurb='the short lap: the link road cuts out the loop over the ridge'),
}
DRS1 = (5453, 5627, 330)


def r3(v, k=3):
    return [round(float(x), k) for x in v]


WALL_FAR_M = 250.0          # a barrier farther than this from the lap counts as none

class Lap:
    """One lap as dense rows about a metre apart: built stations and add-on stations in driving order"""

    def __init__(self, T, ads, foot, cfg, speed):
        self.T, self.ads, self.foot, self.cfg = T, ads, foot, cfg
        blocks = sorted((ads[nm].sa, ads[nm].sb, nm) for nm in cfg['use'])
        kind, idx, at = [], [], 0
        for sa, sb, nm in blocks:
            kind += [''] * (sa - at)
            idx += list(range(at, sa))
            kind += [nm] * (ads[nm].n - 1)              # from its first station (the built one it leaves at) to one short of its last
            idx += list(range(ads[nm].n - 1))
            at = sb
        kind += [''] * (T.n - at)
        idx += list(range(at, T.n))
        self.kind, self.idx = np.array(kind), np.array(idx)
        m = len(idx)
        built = self.kind == ''
        f = {k: np.zeros(m) for k in ('x', 'y', 'z', 'tx', 'ty', 'w', 'b', 'kap', 'rL', 'rR', 'gL', 'gR', 'wL', 'wR')}
        f['kL'], f['kR'] = np.zeros(m, bool), np.zeros(m, bool)
        yp = np.zeros((m, len(LAT)))
        lat = np.array(LAT, float)
        # ---- built stations ----
        i = self.idx[built]
        hw = T.width[i] / 2
        be = [T.band_edges(0)[i], T.band_edges(1)[i]]
        f['x'][built], f['y'][built], f['z'][built], f['tx'][built], f['ty'][built] = T.x[i], T.y[i], T.z[i], T.tx[i], T.ty[i]
        f['w'][built], f['b'][built], f['kap'][built] = T.width[i], T.bank[i], T.kap[i]
        for side, t in ((0, 'L'), (1, 'R')):
            sg = rd.SIDE_SIGN[side]
            kp = np.c_[T.x[i] + sg * T.rx[i] * (hw + 0.7), T.y[i] + sg * T.ry[i] * (hw + 0.7)]
            f['k' + t][built] = (T.kerb[side][i] > 0.5) & ~foot.at(kp)[0]          # not where an add-on road lies over it
            f['r' + t][built] = T.pw[side][i]
            f['g' + t][built] = np.where(T.ga[side][i] + T.pr[side][i] < 0.05, T.gw[side][i], 0.0)
            f['w' + t][built] = self.built_wall(i, side, hw, be[side])
        P = np.stack([T.x[i][:, None] + T.rx[i][:, None] * lat, T.y[i][:, None] + T.ry[i][:, None] * lat], -1)
        zg = np.where(lat[None] >= 0, T.ground_z(i[:, None], 1, np.abs(lat)[None]), T.ground_z(i[:, None], 0, np.abs(lat)[None]))
        ins, zr, wp = foot.at(P.reshape(-1, 2))
        ins, zr, wp = ins.reshape(zg.shape), zr.reshape(zg.shape), wp.reshape(zg.shape)
        on_road = np.abs(lat)[None] <= hw[:, None]
        yp[built] = np.where(on_road, zg, np.where(ins, zr, zg + wp))
        # ---- add-on stations ----
        for nm in cfg['use']:
            ad = ads[nm]
            sel = self.kind == nm
            j = self.idx[sel]
            Pa, za, q = ad.surf(j, np.broadcast_to(lat, (len(j), len(lat))))
            ins, zr, wp = foot.at(Pa.reshape(-1, 2))
            ins, wp = ins.reshape(za.shape), wp.reshape(za.shape)
            in_cor = (np.abs(q['ls']) < q['cor']) & (q['d'] < 70)
            on_built = q['d'] < q['hws']
            yp[sel] = np.where(on_built, q['zs'], np.where(ins, za, np.where(in_cor, q['zg'] + wp, za)))
            f['x'][sel], f['y'][sel], f['z'][sel], f['tx'][sel], f['ty'][sel] = ad.x[j], ad.y[j], yp[sel][:, 4], ad.tx[j], ad.ty[j]
            f['w'][sel], f['kap'][sel] = 2 * ad.hw[j], ad.kap[j]
            _, ze, _ = ad.surf(j, np.stack([-ad.hw[j], ad.hw[j]], 1))
            f['b'][sel] = np.arctan((ze[:, 0] - ze[:, 1]) / (2 * ad.hw[j]))
            for side, t in ((0, 'L'), (1, 'R')):
                sg = rd.SIDE_SIGN[side]
                kq = ad.spine.at(np.c_[ad.x[j] + sg * ad.rx[j] * (ad.hw[j] + 0.7), ad.y[j] + sg * ad.ry[j] * (ad.hw[j] + 0.7)])
                f['k' + t][sel] = (ad.kerb[side][j] > 0.5) & (kq['d'] > kq['hws'] + 0.3)      # not where it lies under the built road
                f['r' + t][sel] = ad.pa[side][j]
                f['w' + t][sel] = self.addon_wall(ad, j, side)
        self.f, self.yp = f, yp
        P2 = np.c_[f['x'], f['y']]
        seg = np.hypot(*(np.roll(P2, -1, 0) - P2).T)
        self.u = np.r_[0, np.cumsum(seg)[:-1]]
        self.L = float(seg.sum())
        self.g = (np.roll(f['z'], -1) - np.roll(f['z'], 1)) / (np.roll(seg, 1) + seg)
        self.v = speed(f['x'], f['y'])
        self.n5 = int(round(self.L / STEP))
        self.tree = cKDTree(P2)

    # ---- barriers -----------------------------------------------------------------------------------------------
    def scan(self, x, y, ox, oy, d0, on_wall=None):
        """From d0 metres out along (ox, oy), the first distance that is clear of every add-on's footprint"""
        d = np.asarray(d0, float).copy()
        live = np.ones(len(d), bool)
        for _ in range(240):
            ins = self.foot.at(np.c_[x + ox * d, y + oy * d])[0] & live
            if not ins.any():
                break
            d[ins] += 0.5
            live = ins
        return d

    def built_wall(self, i, side, hw, be):
        """The barrier beside built stations: the pit wall or the barrier (or its TecPro), or, where that was opened
        for an add-on, the add-on's own beyond it"""
        T = self.T
        sg = rd.SIDE_SIGN[side]
        d = hw + be[:, rd.WALL] - 0.75 * (T.tec[side][i] > 0.5)
        if side == 0:
            pit = (T.pitwall[i - i % 2] > 0.5) & (T.pitwall[(i + i % 2) % T.n] > 0.5)
            d = np.where(pit, hw + T.pw[0][i] + T.ga[0][i] / 2 - 0.15, d)
        ox, oy = sg * T.rx[i], sg * T.ry[i]
        opened = self.foot.at(np.c_[T.x[i] + ox * d, T.y[i] + oy * d], inner=True)[0]
        far = self.scan(T.x[i], T.y[i], ox, oy, d)
        return np.where(opened, far, d)

    def addon_wall(self, ad, j, side):
        """The barrier beside add-on stations: its own, or the first one beyond the built road it runs beside"""
        T = self.T
        sg = rd.SIDE_SIGN[side]
        own = ad.hw[j] + ad.pa[side][j] + ad.gv[side][j]
        ox, oy = sg * ad.rx[j], sg * ad.ry[j]
        d = own.copy()
        for k in range(len(j)):                       # walk out until past the built lap's barrier line on its far side
            for _ in range(200):
                q = ad.spine.at(np.array([[ad.x[j[k]] + ox[k] * d[k], ad.y[j[k]] + oy[k] * d[k]]]))
                if q['d'][0] > 70 or abs(q['ls'][0]) >= q['wl'][0] - 0.2:
                    break
                d[k] += 0.5
        return np.where(ad.wall[side][j], own, d)

    # ---- lookups ------------------------------------------------------------------------------------------------
    def u_built(self, s):
        """Metres into this lap of a built station (the nearest point of the lap if it does not use that station)"""
        s = int(s) % self.T.n
        k = np.flatnonzero((self.kind == '') & (self.idx == s))
        if len(k):
            return float(self.u[k[0]])
        return float(self.u[self.tree.query([self.T.x[s], self.T.y[s]])[1]])

    def u_end(self, nm, off=0.0):
        return (self.u_built(self.ads[nm].sb) + off) % self.L

    def where(self, spec):
        return self.u_built(spec[1]) if spec[0] == 'built' else self.u_end(*spec)

    def nominal(self, u):
        """Metres as the game counts them (5 m a sample)"""
        return int(round(u / self.L * self.n5 * STEP)) % (self.n5 * STEP)

    def row(self, u):
        return int(np.argmin(np.abs((self.u - u + self.L / 2) % self.L - self.L / 2)))

    def sample(self, u):
        """Everything about the lap at `u` metres into it (an array), interpolated between its rows"""
        u = np.atleast_1d(np.asarray(u, float)) % self.L
        m = len(self.u)
        k0 = np.clip(np.searchsorted(self.u, u, 'right') - 1, 0, m - 1)
        k1 = (k0 + 1) % m
        seg = np.where(k1 > k0, self.u[k1] - self.u[k0], self.L - self.u[k0])
        t = np.clip((u - self.u[k0]) / np.maximum(seg, 1e-9), 0, 1)
        near = np.where(t < 0.5, k0, k1)
        out = {k: a[near] if a.dtype == bool else (1 - t) * a[k0] + t * a[k1] for k, a in self.f.items()}
        out['yp'] = (1 - t)[:, None] * self.yp[k0] + t[:, None] * self.yp[k1]
        out['g'] = (1 - t) * self.g[k0] + t * self.g[k1]
        out['v'] = (1 - t) * self.v[k0] + t * self.v[k1]
        ln = np.hypot(out['tx'], out['ty'])
        out['tx'], out['ty'] = out['tx'] / ln, out['ty'] / ln
        out['near'] = near
        return out


def export(name):
    cfg = LAYOUTS[name]
    T = rd.Design()
    dem = prep.load_dem()
    ads = ra.load(T, lambda x, y: prep.ground(dem, x, y))
    foot = Foot()
    cl = np.load(os.path.join(HERE, 'src', 'cl_%s.npz' % name))
    ctree = cKDTree(np.c_[cl['E'] - prep.E0, cl['N'] - prep.N0])
    lap = Lap(T, ads, foot, cfg, lambda x, y: cl['v'][ctree.query(np.c_[x, y])[1]])
    f, m = lap.f, len(lap.u)
    n5, n = lap.n5, lap.n5 * STEP
    lat = np.array(LAT, float)
    S = lap.sample(np.arange(n5) * lap.L / n5)          # the samples the game gets, 5 m apart
    # the barrier each side: the first one a line straight out from the sample meets in the built scene
    W = np.load(os.path.join(HERE, 'data', 'walls.npz'))['seg']
    ax, ay, ex, ey = W[:, 0], W[:, 1], W[:, 2] - W[:, 0], W[:, 3] - W[:, 1]
    gaps = {}
    for t, sg in (('L', -1.0), ('R', 1.0)):
        dx, dy = sg * S['ty'], -sg * S['tx']
        bx, by = ax[None] - S['x'][:, None], ay[None] - S['y'][:, None]
        den = dx[:, None] * ey[None] - dy[:, None] * ex[None]
        den = np.where(np.abs(den) < 1e-9, np.nan, den)
        along = (bx * ey[None] - by * ex[None]) / den
        on = (bx * dy[:, None] - by * dx[:, None]) / den
        along = np.where((along > 0) & (on >= -0.02) & (on <= 1.02), along, np.inf)
        first = along.min(1)
        gaps[t] = int((first > WALL_FAR_M).sum())
        S['w' + t] = np.minimum(first, WALL_FAR_M)

    def pt(D, q, la):
        """Game-frame point (x, y up, z = -north) on the ground `la` metres right of entry q of a sampled set"""
        return [float(D['x'][q] + D['ty'][q] * la), float(np.interp(la, lat, D['yp'][q])), float(-(D['y'][q] - D['tx'][q] * la))]

    def tangent(D, q):
        t = np.array([D['tx'][q], D['g'][q], -D['ty'][q]])
        return t / np.linalg.norm(t)

    # ---- corners ----
    turn = np.zeros(m, int)
    names = {}
    for num, item in enumerate(cfg['turns'], 1):
        if isinstance(item, tuple):
            nm, names[num] = item
            ad = ads[nm]
            apex = int(np.argmax(np.abs(ad.kap)))
            a, b = next((a, b) for a, b in ra.runs((np.abs(ad.kap) > 1 / 650) & (np.sign(ad.kap) == np.sign(ad.kap[apex]))) if a <= apex < b)
            turn[(lap.kind == nm) & (lap.idx >= a) & (lap.idx < b)] = num
        else:
            names[num] = NAMES[item]
            a, b = next((a, b) for o, a, b, d, _ in CORNERS if o == item)
            sel = (lap.kind == '') & (lap.idx >= a) & (lap.idx <= b)
            assert sel.sum() == b - a + 1, (name, item, 'is not whole on this lap')
            turn[sel] = num
    esses = [k for k, v_ in names.items() if v_ == ESSES]
    v_kmh = S['v'] * 3.6
    acc = S['v'] * (np.roll(S['v'], -1) - np.roll(S['v'], 1)) / (2 * lap.L / n5)
    s1 = lap.nominal(lap.where(cfg['sector1']))
    s2 = lap.nominal(lap.u_built(prep.SECTOR_ENDS[1]))
    bounds = (0, s1, s2, n)

    samples = []
    for q in range(n5):
        p = pt(S, q, 0.0)
        s_ = q * STEP
        sec = 1 if s_ < s1 else 2 if s_ < s2 else 3
        tn = int(turn[S['near'][q]])
        samples.append({
            's': s_, 'p': r3(p), 'r': r3(p), 't': r3(tangent(S, q), 5), 'yProf': r3(S['yp'][q]),
            'ro': 0.0, 'w': round(float(S['w'][q]), 2), 'b': round(float(S['b'][q]), 4), 'g': 1.0,
            'v': round(float(v_kmh[q]), 1), 'gas': 0.0 if acc[q] < -1.0 else 1.0,
            'brk': round(float(np.clip(-acc[q] / 45.0, 0, 1)), 2), 'sec': sec, 'turn': tn,
            'zone': ZONES[sec] if tn else 'main_straight',
            'kL': int(S['kL'][q]), 'kR': int(S['kR'][q]), 'rL': round(float(S['rL'][q]), 2), 'rR': round(float(S['rR'][q]), 2),
            'gL': round(float(S['gL'][q]), 2), 'gR': round(float(S['gR'][q]), 2),
            'wL': round(float(S['wL'][q]), 2), 'wR': round(float(S['wR'][q]), 2),
        })

    ds = np.hypot(*(np.roll(np.c_[f['x'], f['y']], -1, 0) - np.c_[f['x'], f['y']]).T)
    turns = []
    for num in sorted(names):
        rows = np.flatnonzero(turn == num)
        kk = np.abs(f['kap'][rows])
        apex = int(rows[int(np.argmax(kk))])
        radius = int(round(1.0 / kk.max()))
        angle = int(round(np.degrees((kk * ds[rows]).sum())))
        v = int(round(lap.v[apex] * 3.6))
        gear = 1 + sum(v >= g for g in GEAR_KMH)
        side = 'left' if f['kap'][apex] > 0 else 'right'
        s_apex = lap.nominal(lap.u[apex])
        sec = 1 if s_apex < s1 else 2 if s_apex < s2 else 3
        nm = names[num]
        turns.append({
            'number': num, 'name': f'Turn {num} — {nm}',
            'complexName': f'{ESSES} (T{esses[0]}–T{esses[-1]})' if nm == ESSES else nm,
            'sector': sec, 'elevationM': round(float(f['z'][apex]), 1), 'bankingDeg': round(abs(float(np.degrees(f['b'][apex]))), 1),
            'apexSpeedKmh': v, 'gear': gear, 'direction': side, 'radiusM': radius, 'angleDeg': angle,
            'description': f'{side.capitalize()}-hander, {angle}° at R≈{radius} m, apex {v} km/h in gear {gear}.',
            'sApprox': s_apex,
        })

    def gate(s_):
        D = lap.sample(s_ / n * lap.L)
        hw = D['w'][0] / 2
        return {'s': s_, 'left': r3(pt(D, 0, -hw)), 'right': r3(pt(D, 0, hw)), 'normal': r3(tangent(D, 0), 5)}

    sectors = [{'id': k + 1, 'startS': bounds[k], 'endS': bounds[k + 1], 'gate': gate(bounds[k] % n)} for k in range(3)]
    checkpoints = [dict(id=k, **gate(s_)) for k, s_ in enumerate(range(0, n, 250))]

    grid = []
    for k in range(GRID_SLOTS):
        u = lap.L - GRID_FIRST_M - GRID_PITCH_M * k
        D = lap.sample(u)
        la = GRID_LAT_M if k % 2 == 0 else -GRID_LAT_M        # pole on the right
        fw = tangent(D, 0)
        grid.append({'slot': k + 1, 's': lap.nominal(u), 'lateral': la, 'position': r3(pt(D, 0, la)),
                     'yawRad': round(float(np.arctan2(fw[0], fw[2])), 4), 'forward': r3(fw, 5)})

    # ---- built things the lap passes: the cameras and the pit lane, placed on the built lap ----
    be = [T.band_edges(0), T.band_edges(1)]
    thw = T.width / 2

    def built_pt(i, la):
        side = 1 if la >= 0 else 0
        return [float(T.x[i] + T.rx[i] * la), float(T.ground_z(np.array(i), side, np.array(abs(la)))), float(-(T.y[i] + T.ry[i] * la))]

    cameras = []
    cams = [(k, s, side, h) for k, (s, side, h) in enumerate(site.CAMERAS)
            if lap.tree.query([T.x[s], T.y[s]])[0] < 60.0]              # those on a stretch this lap leaves out go
    edge = [lap.u_built(k * T.n // 12) / lap.L for k, _, _, _ in cams] + [1.0]
    edge[0] = 0.0
    for c, (k, s, side, height) in enumerate(cams):
        sg = rd.SIDE_SIGN[side]
        la = sg * (thw[s] + be[side][s, 5] + site.CAMERA_ROOF_BACK_M if k == 0 else site.camera_lat(T, s, side))
        pos = np.array(built_pt(s, la)) + [0, height, 0]
        aim = np.array(built_pt((s - 70) % T.n, 0.0)) + [0, 1.0, 0]
        fw = aim - pos
        fw /= np.linalg.norm(fw)
        cameras.append({'name': f'TV {c + 1}', 'position': r3(pos), 'forward': r3(fw, 5), 'up': [0, 1, 0],
                        'minFov': 12, 'maxFov': 48, 'inPoint': round(edge[c], 4), 'outPoint': round(edge[c + 1], 4)})

    pit = []
    for u in range(0, PIT_LEN + 1, STEP):
        i = (PIT_S0 + u) % T.n
        d = be[0][i, 2] + min(T.pr[0][i] / 2, 2.75)
        pit.append(r3(built_pt(i, -(thw[i] + d)), 2))

    hw5 = S['w'] / 2
    every = range(0, n5, 2)
    boundaries = {
        'spacingM': 10,
        'left': [r3(pt(S, q, -hw5[q]), 2) for q in every], 'right': [r3(pt(S, q, hw5[q]), 2) for q in every],
        'wallLeft': [r3(pt(S, q, -S['wL'][q]), 2) for q in every], 'wallRight': [r3(pt(S, q, S['wR'][q]), 2) for q in every],
    }
    drs = [tuple(lap.u_built(s) for s in DRS1), tuple(lap.where(w) for w in cfg['drs2'])]

    z = f['z']
    dz = np.diff(np.r_[z, z[0]])
    climb = float(dz[dz > 0].sum())
    zmin, zmax = float(z.min()), float(z.max())
    meta = {
        'name': f"RISE Motordrome — {cfg['layout']} layout",
        'shortName': cfg['short'],
        'description': (
            f"Anticlockwise {n / 1000:.2f} km circuit with {len(turns)} corners beside Lake Kidogo at Bugesera, {cfg['blurb']}. "
            'My reading of the official design from its published renders and figures, set on the site\'s real ground: '
            'plateau pit straight, the banked Bowl, the long descent to the West Hill hairpin and the esses along the '
            f'lake. {zmax - zmin:.0f} m elevation range, {climb:.0f} m climbed per lap.'),
        'country': 'Rwanda', 'city': 'Bugesera', 'lengthMeters': float(n), 'widthMeters': '12m-15m', 'pitboxes': 20,
        'direction': 'anticlockwise', 'geotags': ['lat -2.1712', 'lon 30.2210'],
        'author': 'built in Blender from the official renders (scripts/rwanda-official)',
        'originOffset': [0, 0, 0], 'latProfileOffsets': LAT, 'sampleSpacingM': STEP,
        'elevationRangeM': [round(zmin, 1), round(zmax, 1)], 'baseAltitudeM': BASE_ALTITUDE_M,
        'surfaces': {'roadGrip': 1.0, 'tarmacGrip': 0.75, 'kerbGrip': 0.96},
        # the kerbs' blocks under the wheels, where bl_kerbs.py lays the ones one sees (src/lib/sim/track-surfaces.ts)
        'surfaceTable': {'kerb': {'bumpHeightM': rd.KERB_BLOCK_RISE_M, 'bumpLengthM': rd.KERB_BLOCK_M, 'bumpRise': rd.KERB_BLOCK_RISE_SHARE}},
        'mesh': {
            'url': GLB, 'scenery': [FOLIAGE],
            'road': 'Track_Asphalt_Road', 'kerbs': 'Track_Kerbs', 'runoff': 'Track_Runoff_Paint',
            'startLights': ['Prop_StartLights_0'],
            'colliders': ['Track_Collider_Road', 'Track_Collider_Wall_Left', 'Track_Collider_Wall_Right',
                          'Track_Collider_Wall_Pit', 'Track_Collider_Wall_PitOuter', 'Track_Collider_Wall_Alt', 'Track_Collider_Wall_Join'],
            'water': 'Lake',
        },
    }
    data = {
        'metadata': meta,
        'drsZones': [{'id': f'ZONE_{k}', 'detection': round(a / lap.L, 4), 'start': round(b / lap.L, 4), 'end': round(c / lap.L, 4)}
                     for k, (a, b, c) in enumerate(drs)],
        'cameras': cameras, 'turns': turns, 'sectors': sectors, 'checkpoints': checkpoints, 'spawnGrid': grid,
        'pitLane': {'entryS': lap.nominal(lap.u_built(PIT_S0)), 'exitS': lap.nominal(lap.u_built(PIT_S0 + PIT_LEN)), 'widthM': 5.5,
                    'centerline': pit},
        'boundaries': boundaries, 'samples': samples,
    }
    out = os.path.join(TRACKS, cfg['id'], 'track_data.json')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
    step = np.hypot(*np.diff(np.array([s['p'] for s in samples])[:, [0, 2]], axis=0).T)
    print(f'Wrote {out}: {os.path.getsize(out) / 1024:.0f} KB; lap {lap.L:.1f} m in {len(samples)} samples ({step.min():.2f}..{step.max():.2f} m apart), '
          f'{len(turns)} turns, {zmin:.1f}..{zmax:.1f} m, {climb:.1f} m climbed; sectors end {s1} / {s2}; {len(cameras)} cameras; '
          f'walls L {S["wL"].min():.1f}..{S["wL"].max():.1f} R {S["wR"].min():.1f}..{S["wR"].max():.1f} m, none within {WALL_FAR_M:.0f} m at {gaps["L"]} + {gaps["R"]} samples; '
          f'over 60 m at {int((S["wL"] > 60).sum())} + {int((S["wR"] > 60).sum())}')
    for t in turns:
        print(f"  T{t['number']:<2} s={t['sApprox']:<5} {t['direction']:<5} R{t['radiusM']:<4} {t['angleDeg']:>3}° "
              f"{t['apexSpeedKmh']} km/h gear {t['gear']}  bank {t['bankingDeg']}°  {t['name']}")
    return {'id': cfg['id'], 'lengthM': n, 'turns': len(turns)}


if __name__ == '__main__':
    for nm in ([sys.argv[1]] if len(sys.argv) > 1 else list(LAYOUTS)):
        export(nm)
