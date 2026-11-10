"""
Shared geometry of the official Rwanda layout (RISE Motordrome, Bugesera): pure numpy, so it runs both in the prep
venv (prep.py) and inside Blender (bl_*.py).

Frame: Blender X = east, Y = north, Z = metres above Lake Kidogo (1328 m ASL), origin at the layout's centre.
Lateral offsets are + to the driver's right; `bank` (rad) is + when the left side is higher (a right-hander banked
inward). Side index 0 = left, 1 = right. The centreline is sampled every metre (5,860 stations, closed).
"""
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')

KERB_HINGE_M = 1.5                      # the banked plane runs this far past the road edge
RUNOFF_BANK_MAX = np.radians(2.0)       # beyond the hinge the ground keeps at most this cross slope
MESH_STEP = 2                           # metres between mesh stations
# paint, grass wedge, pit road, gravel, verge | wall | slab, verge behind the wall, service road, back
BANDS = ('pw', 'ga', 'pr', 'gw', 'gb', 'sl', 'sv', 'sr', 'bk')
WALL, BACK0, EDGE = 5, 8, 9              # columns of band_edges: the wall line, the start of the back band, the corridor's edge
SIDE_SIGN = (-1.0, 1.0)

# Columns of the paint band, metres from the road edge (capped at the band's width): dense over the kerb hinge
PAINT_COLS = np.array([0.0, 1.5, 3.5, 7.0, 12.0, 20.0, 30.0, 44.0, 60.0])
BAND_COLS = {'ga': 3, 'pr': 5, 'gw': 3, 'gb': 4, 'sl': 5, 'sv': 2, 'sr': 3, 'bk': 2}


class Design:
    def __init__(self, path=None):
        d = np.load(path or os.path.join(DATA, 'design.npz'), allow_pickle=False)
        for k in d.files:
            setattr(self, k, d[k])
        self.n = len(self.s)
        self.L = float(self.n)
        self.rx, self.ry = self.ty, -self.tx

    # ---- cross-section -------------------------------------------------------------------------------------------
    def cross_z(self, idx, lat):
        """Height of the ground relative to the centreline, `lat` metres to the right of station `idx`"""
        lat = np.asarray(lat, float)
        b = np.asarray(self.bank[idx], float)
        hw = np.asarray(self.width[idx], float) / 2 + KERB_HINGE_M
        while b.ndim < lat.ndim:
            b = b[..., None]
            hw = hw[..., None]
        tb = np.tan(b)
        tr = np.tan(RUNOFF_BANK_MAX * np.tanh(b / RUNOFF_BANK_MAX))
        u = np.maximum(0.0, np.abs(lat) - hw)
        ramp = u - 4.0 * (1 - np.exp(-u / 4.0))
        return -tb * lat + (tb - tr) * np.sign(lat) * ramp

    def world(self, idx, lat, dz=0.0):
        """World points (…, 3) of stations `idx` at lateral offsets `lat` (broadcast together)"""
        idx = np.asarray(idx)
        lat = np.asarray(lat, float)
        if lat.ndim > idx.ndim:
            ex = (...,) + (None,) * (lat.ndim - idx.ndim)
            X, Y, Z = self.x[idx][ex], self.y[idx][ex], self.z[idx][ex]
            RX, RY = self.rx[idx][ex], self.ry[idx][ex]
        else:
            X, Y, Z, RX, RY = self.x[idx], self.y[idx], self.z[idx], self.rx[idx], self.ry[idx]
        cz = self.cross_z(idx, lat)
        return np.stack(np.broadcast_arrays(X + RX * lat, Y + RY * lat, Z + cz + dz), -1)

    # ---- bands ---------------------------------------------------------------------------------------------------
    def band_edges(self, side):
        """(n, 10) distances from the road edge of the band boundaries of one side: 0, pw, ga, pr, gw, gb, sl, sv, sr, bk"""
        w = np.stack([getattr(self, k)[side] for k in BANDS], 1)
        return np.concatenate([np.zeros((self.n, 1)), np.cumsum(w, 1)], 1)

    def wall_offset(self, side):
        """Distance of the wall line from the centreline (the end of the verge band)"""
        e = self.band_edges(side)
        return self.width / 2 + e[:, WALL]

    def corridor(self, side):
        """Distance of the corridor's outer edge from the centreline"""
        return self.width / 2 + self.band_edges(side)[:, EDGE]

    def ground_z(self, idx, side, lat_abs):
        """
        Absolute ground height at |lateral| = lat_abs on one side: the design cross-section out to the wall line,
        then, across the back band, eased onto `edge_z` (the height the terrain takes over at).
        """
        idx = np.asarray(idx)
        lat_abs = np.asarray(lat_abs, float)
        sg = SIDE_SIGN[side]
        zc = self.z[idx] + self.cross_z(idx, sg * lat_abs)
        e = self.band_edges(side)[idx]
        hw = self.width[idx] / 2
        w0 = hw + e[..., BACK0]           # start of the back band
        w1 = hw + e[..., EDGE]
        z1 = self.edge_z[side][idx]
        zw = self.z[idx] + self.cross_z(idx, sg * w1)
        t = np.clip((lat_abs - w0) / np.maximum(w1 - w0, 1e-6), 0, 1)
        t = t * t * (3 - 2 * t)
        return zc + t * (z1 - zw)


def wrap_range(a, b, n):
    """Indices from a to b inclusive on a ring of n"""
    a %= n
    b %= n
    return np.arange(a, b + 1) if b >= a else np.concatenate([np.arange(a, n), np.arange(0, b + 1)])
