"""
Rasters of the baked add-on road sections (data/addons.npz, written by ro_addon.py): is a point under one, how high is
its surface there, and how far the built lap's ground beside it moves to meet it. Pure numpy, so it runs in Blender.
"""
import os
import numpy as np

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
NAMES = ('t1o', 't8o', 'link')
SINK = 0.25               # the built lap's ground lies this far under an add-on that covers it
EDGE_UNDER = 0.012        # ... and meets its edge this far under the add-on's surface
SINK_OVER_M = 3.0         # it reaches its full depth this far in from the edge of what the add-on draws
HUG_R = 3.0               # ... and outside that edge it comes to the edge's height over this distance
HUG_FLAT = 0.8            # (all the way within this distance: the first vertex outside is the seam)
LIFT_M = 1.0              # ground lying lower than the add-on comes up to its edge over this distance inside it


def sstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


class Foot:
    def __init__(self, A=None):
        A = A if A is not None else np.load(os.path.join(DATA, 'addons.npz'))
        self.r = [(A[n + '_foot'], A[n + '_foot_in'], A[n + '_roadfoot'], A[n + '_zr'], A[n + '_warp'], A[n + '_org']) for n in NAMES]
        # what each add-on draws (its asphalt, kerbs, paint and verge), finer than the outline rasters: metres inside
        # (+) or outside (-) its edge, its surface height there (outside: at the nearest point of the edge), and how far
        # ground outside it follows that edge
        self.cov = [(A[n + '_cov_d'], A[n + '_cov_z'], A[n + '_cov_g'], A[n + '_cov_org']) for n in NAMES]

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

    def cover(self, P):
        """Metres inside (+) or outside (-) what the add-ons draw, their surface height there, how far ground follows it"""
        P = np.asarray(P, float)
        d = np.full(len(P), -1e3)
        zc = np.zeros(len(P))
        g = np.zeros(len(P))
        for cd, cz, cg, (x0, y1, ppm) in self.cov:
            fx, fy = (P[:, 0] - x0) * ppm, (y1 - P[:, 1]) * ppm
            ok = (fx >= 0) & (fx <= cd.shape[1] - 1) & (fy >= 0) & (fy <= cd.shape[0] - 1)
            ix = np.clip(np.int32(np.floor(fx)), 0, cd.shape[1] - 2)
            iy = np.clip(np.int32(np.floor(fy)), 0, cd.shape[0] - 2)
            u, v = np.clip(fx - ix, 0, 1), np.clip(fy - iy, 0, 1)

            def lerp(R):                                        # between the four pixels around: at the nearest one a
                return (R[iy, ix] * (1 - u) + R[iy, ix + 1] * u) * (1 - v) + (R[iy + 1, ix] * (1 - u) + R[iy + 1, ix + 1] * u) * v   # height is off by the grade times the pixel

            dd = np.where(ok, lerp(cd), -1e3)
            take = dd > d
            d = np.where(take, dd, d)
            zc = np.where(take, lerp(cz), zc)
            g = np.where(take, lerp(cg), g)
        return d, zc, g

    def covered(self, P):
        """Which points lie under what an add-on draws"""
        return self.cover(P)[0] > 0

    def ceiling(self, P):
        """(metres inside what the add-ons draw, the height the built lap's ground stays under there)"""
        d, zc, _ = self.cover(P)
        return d, zc - (EDGE_UNDER + (SINK - EDGE_UNDER) * sstep(d / SINK_OVER_M))

    def settle(self, P, z):
        """
        Heights of the built lap's ground at points P (m, 2) once the add-ons are in. Beside one it is warped towards
        it; under what the add-on draws it lies beneath that, by a hair at the edge and by SINK further in; and just
        outside that edge it comes up or down to the edge's height. The depth and the meeting go by what is drawn, not
        by the add-on's outline: sunk under the outline, the ground stood open as a trench wherever the outline was
        wider than the surface over it, and it met the edge as a step wherever the warp's idea of it was off.
        """
        zo = np.asarray(z, float) + self.at(P)[2]
        d, zc, g = self.cover(P)
        under = zc - (EDGE_UNDER + (SINK - EDGE_UNDER) * sstep(d / SINK_OVER_M))
        # ground already lower than that comes up to the edge from inside as it does from outside: left where it lay,
        # it showed as a notch between the add-on's last triangle and the ground beside it
        inside = np.where(zo > under, under, zo + g * (1 - sstep(d / LIFT_M)) * (under - zo))
        hug = sstep((HUG_R + d) / (HUG_R - HUG_FLAT)) * g
        return np.where(d > 0, inside, zo + hug * (zc - EDGE_UNDER - zo))
