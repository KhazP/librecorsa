"""
Rasters of the baked add-on road sections (data/addons.npz, written by ro_addon.py): is a point under one, how high is
its surface there, and how far the built lap's ground beside it moves to meet it. Pure numpy, so it runs in Blender.
"""
import os
import numpy as np

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
NAMES = ('t1o', 't8o', 'link')
SINK = 0.25               # the built lap's ground lies this far under an add-on that covers it
EDGE_UNDER = 0.03         # ... and meets its edge this far under the add-on's surface


class Foot:
    def __init__(self, A=None):
        A = A if A is not None else np.load(os.path.join(DATA, 'addons.npz'))
        self.r = [(A[n + '_foot'], A[n + '_foot_in'], A[n + '_roadfoot'], A[n + '_zr'], A[n + '_warp'], A[n + '_org']) for n in NAMES]
        self.near = [(A[n + '_near_w'], A[n + '_near_z'], A[n + '_org']) for n in NAMES]

    def at(self, P, inner=False, road=False):
        """(inside, surface height, warp) of points (m, 2); `inner`: at least half a metre inside the footprint; `road`:
        the footprint of the roads alone (asphalt and kerbs)"""
        P = np.asarray(P, float)
        ins = np.zeros(len(P), bool)
        z = np.full(len(P), -1e9)
        wp = np.zeros(len(P))
        for foot, foot_in, rfoot, zr, warp, (x0, y1, ppm) in self.r:
            mk = rfoot if road else foot_in if inner else foot
            px, py = np.int32(np.round((P[:, 0] - x0) * ppm)), np.int32(np.round((y1 - P[:, 1]) * ppm))
            ok = (px >= 0) & (px < mk.shape[1]) & (py >= 0) & (py < mk.shape[0])
            hit = np.zeros(len(P), bool)
            hit[ok] = mk[py[ok], px[ok]] > 0
            z[hit] = np.maximum(z[hit], zr[py[hit], px[hit]])
            ins |= hit
            w = np.zeros(len(P))
            w[ok] = warp[py[ok], px[ok]]
            wp = np.where(np.abs(w) > np.abs(wp), w, wp)
        return ins, z, wp

    def settle(self, P, z):
        """Heights of the built lap's ground at points P (m, 2) once the add-ons are in: sunk under them, warped beside"""
        ins, zr, wp = self.at(P)
        zo = z + wp
        return np.where(ins, np.minimum(z, zr - SINK), zo + self.pull(P, zo))

    def pull(self, P, z):
        """How far ground at height z beside an add-on comes down so that it does not stand above the add-on's edge (<= 0)"""
        P = np.asarray(P, float)
        out = np.zeros(len(P))
        for near_w, near_z, (x0, y1, ppm) in self.near:
            px, py = np.int32(np.round((P[:, 0] - x0) * ppm)), np.int32(np.round((y1 - P[:, 1]) * ppm))
            ok = (px >= 0) & (px < near_w.shape[1]) & (py >= 0) & (py < near_w.shape[0])
            c = np.zeros(len(P))
            c[ok] = np.minimum(0.0, near_z[py[ok], px[ok]] - EDGE_UNDER - z[ok]) * near_w[py[ok], px[ok]]
            out = np.minimum(out, c)
        return out
