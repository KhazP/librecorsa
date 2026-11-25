"""
Each circuit's pit lane, rebuilt from its Assetto Corsa source as the "v2" `pitLane` that src/lib/sim/pit/pit-lane.ts
reads, written to an output folder (never in place):

    python3 -I scripts/tracks/export_pit_lanes.py [id ...] [--tracks DIR] [--out DIR] [--sources FILE] [--search DIR]
    npx tsx scripts/verify-pit-lanes.ts --dir ~/Documents/GitHub/_track-pitlanes --verbose

It reads <tracks>/<id>/track_data.json (default public/tracks) and writes <out>/<id>/track_data.json (default
~/Documents/GitHub/_track-pitlanes) with only the `pitLane` value changed: every other byte of the file is copied as it
was. Upload those files to R2 by hand.

For each circuit of scripts/tracks/port_ac_track.py's AC_TRACKS (read with ast, nothing imported):
  - the lane is the mod's full-resolution <layout>/ai/pit_lane.ai in the track frame (raw + metadata.modelOffset),
    trimmed to 150 m before the point it leaves the road .. 150 m after it rejoins (or the spline's own ends), thinned
    to points at most 3 m apart that stay within 5 cm of the raw spline, x/y/z to 2 decimals. A spline that is a whole
    lap (Willow Springs) is turned to run entry -> exit; one that runs on past the exit is cut 150 m after it;
  - leaveM / rejoinM: the ends of its longest stretch more than 2 m past the road edge (segment projection on the
    centreline samples, |lateral| - w/2), in x/z metres along the exported centreline, as pit-lane.ts measures it.
    Where the exit runs along the road edge before it really merges (MERGE_AT: Monaco past Sainte Devote,
    Sachsenring), rejoinM is the real merge and the speed-limit zone ends where the lane first meets the road edge;
  - limitStartM = leaveM + 15, limitEndM = rejoinM - 15, limitKmh 60;
  - boxes: AC_PIT_0..N-1 in garage order (N = the layout's ui_track.json pitboxes, else the porter's count, else all),
    [x, y, z, heading]: the dummy's position + modelOffset and atan2(zx, zz) of its z axis (a car's nose). Where a
    dummy is turned more than YAW_TOL_DEG off the lane (Monaco's are square to it) the lane's heading at the box is
    used; where a circuit's dummies float (median more than BOX_Y_TOL_M over or under the lane: AC drops the car),
    all its boxes take the lane's height. A box that projects outside the speed-limit zone is dropped;
  - entryS / exitS / widthM stay as they were.
Layouts with no pit lane (NO_PIT_LANE) get {"none": true}. Qiddiya and the RISE layouts (EXTRA) keep their stored lane
and take the boxes of their AC build, if those sit beside it. A circuit with no source on disk is skipped (no file).

A mod folder (AC_TRACKS `folder`) is found by the first of: --sources FILE or scripts/tracks/sources.local.json
({"<folder or id>": "<path>"}), $LIBRECORSA_AC_TRACKS/<folder>, a folder of that name holding .kn5 files under the
--search roots (default ~/Downloads). numpy only; run with python3 -I.
"""
import argparse
import ast
import configparser
import glob
import json
import math
import os
import re
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PORTER = os.path.join(HERE, 'port_ac_track.py')
LOCAL_SOURCES = os.path.join(HERE, 'sources.local.json')
DEFAULT_OUT = os.path.expanduser('~/Documents/GitHub/_track-pitlanes')
DEFAULT_SEARCH = [os.path.expanduser('~/Downloads')]

# Layouts with no pit lane: hill climbs, Dunsfold's teardrop stub, Spielberg's inner loop (its lane rejoins behind)
NO_PIT_LANE = ('borgloh', 'goodwood', 'dunsfold', 'spielberg_inner')
# Circuits outside AC_TRACKS: the stored lane stays (the circuit's own data), the boxes come from an AC build of it
EXTRA = {
    # Maxim555's AC mod, the lane the game's was taken from (5.6 m apart at most); its ui_track.json counts 50 boxes,
    # the whole paddock: the circuit's 22 are AC_PIT_0..21
    'qiddiya': {'folder': 'qiddiya_2028', 'layout_dir': 'gp', 'pitboxes': 22},
    # The RISE Motordrome's own AC export (scripts/rwanda-official/bl_ac.py): its AC_PIT dummies were laid along this lane
    'rwanda_official': {'folder': 'rwanda_official', 'layout_dir': 'gp'},
    'rwanda_official_short': {'folder': 'rwanda_official', 'layout_dir': 'short'},
}
# Exits that run along the road edge before they merge: lap position (m) of the real merge. There the lane leaves the
# road a second time (the pit exit road past the corner) and rejoins at about this s
MERGE_AT = {'monaco': 225.0, 'sachsenring': 532.0}
MERGE_TOL_M = 40.0
# ... as long as the lane stays on its side and no deeper than this inside the road edge in between (m)
MERGE_MAX_INSIDE_M = 4.0

OFF_ROAD_M = 2.0          # past the road edge: off the road
MARGIN_M = 150.0          # lane kept before the leave point and after the rejoin point
MAX_GAP_M = 3.0           # kept points at most this far apart
THIN_TOL_M = 0.04         # thinning tolerance (+ rounding to 1 cm stays within 5 cm of the raw spline)
LIMIT_INSET_M = 15.0      # speed-limit zone inside the leave and rejoin points
LIMIT_KMH = 60
YAW_TOL_DEG = 10.0        # a dummy turned further than this off the lane takes the lane's heading
BOX_Y_TOL_M = 1.0         # dummies further than this (median) over or under the lane float: lane height for all
ZONE_SLACK_M = 0.5        # a box this close to a zone end counts as outside (pit-lane.ts keeps laneM in [start, end])
DENSE_M = 0.25            # the off-road test samples the lane this often
CLOSED_GAP_M = 10.0       # a spline whose ends are this close and that is over half a lap long is a whole lap
WIDTH_M = 10              # porter's placeholder width, kept


# ---------------------------------------------------------------- AC sources

def porter_configs():
    """AC_TRACKS of port_ac_track.py, literal values only"""
    tree = ast.parse(open(PORTER, encoding='utf-8').read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'AC_TRACKS' for t in node.targets):
            out = {}
            for k, v in zip(node.value.keys, node.value.values):
                cfg = {}
                for kk, vv in zip(v.keys, v.values):
                    try:
                        cfg[ast.literal_eval(kk)] = ast.literal_eval(vv)
                    except ValueError:
                        pass
                out[ast.literal_eval(k)] = cfg
            return out
    raise SystemExit(f'AC_TRACKS not found in {PORTER}')


class Sources:
    """Where each mod folder is on this machine"""

    def __init__(self, sources_file, search_roots):
        path = sources_file or LOCAL_SOURCES
        self.local = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
        self.env = os.environ.get('LIBRECORSA_AC_TRACKS')
        self.roots = search_roots
        self.found = None

    def _scan(self):
        """Every folder holding .kn5 files under the search roots, by name (not descending into one)"""
        self.found = {}
        skip = {'texture', 'textures', 'skins', 'cars', 'node_modules', '__pycache__', 'extension', 'ai', 'data', 'ui'}
        for root in self.roots:
            root = os.path.expanduser(root)
            base_depth = root.rstrip(os.sep).count(os.sep)
            for dirpath, dirnames, filenames in os.walk(root):
                if any(f.lower().endswith('.kn5') for f in filenames):
                    self.found.setdefault(os.path.basename(dirpath), []).append(dirpath)
                    dirnames[:] = []
                    continue
                if dirpath.count(os.sep) - base_depth >= 7:
                    dirnames[:] = []
                    continue
                dirnames[:] = sorted(d for d in dirnames if not d.startswith('.') and d.lower() not in skip)

    def resolve(self, tid, folder):
        for key in (tid, folder):
            p = self.local.get(key)
            if p and os.path.isdir(os.path.expanduser(p)):
                return os.path.expanduser(p)
        if self.env and os.path.isdir(os.path.join(self.env, folder)):
            return os.path.join(self.env, folder)
        if self.found is None:
            self._scan()
        cands = sorted(self.found.get(folder, []), key=lambda p: (p.count(os.sep), p))
        return cands[0] if cands else None


def read_ai_lane(path):
    """x, y, z of an AC .ai spline (AC's frame)"""
    data = open(path, 'rb').read()
    _, n, _, _ = struct.unpack_from('<4i', data, 0)
    pts = np.frombuffer(data, [('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('s', '<f4'), ('id', '<i4')], count=n, offset=16)
    return np.stack([pts['x'], pts['y'], pts['z']], 1).astype(float)


class KN5:
    """Node names and world matrices of a KN5; texture and vertex bytes are skipped with seeks"""

    def __init__(self, path):
        self.f = open(path, 'rb')

    def i32(self):
        return struct.unpack('<i', self.f.read(4))[0]

    def str(self):
        return self.f.read(self.i32()).decode('utf-8', 'replace')

    def skip(self, n):
        self.f.seek(n, 1)

    def markers(self, pattern):
        f = self.f
        try:
            if f.read(6) != b'sc6969':
                raise ValueError('not a kn5')
            ver = self.i32()
            if ver > 5:
                self.i32()
            for _ in range(self.i32()):          # textures
                self.i32()
                self.str()
                self.skip(self.i32())
            for _ in range(self.i32()):          # materials
                self.str()
                self.str()
                self.skip(2)
                self.i32()
                for _ in range(self.i32()):
                    self.str()
                    self.skip(40)
                for _ in range(self.i32()):
                    self.str()
                    self.i32()
                    self.str()
            out = {}
            rx = re.compile(pattern)

            def node(parent):
                kind = self.i32()
                name = self.str()
                nchild = self.i32()
                f.read(1)
                mat = parent
                if kind == 1:
                    local = np.frombuffer(f.read(64), '<f4').astype(float).reshape(4, 4).T
                    mat = parent @ local
                    if rx.match(name):
                        out[name] = mat
                elif kind in (2, 3):
                    self.skip(3)
                    if kind == 3:
                        for _ in range(self.i32()):
                            self.str()
                            self.skip(64)
                    n = self.i32()
                    self.skip(n * (44 if kind == 2 else 76))
                    self.skip(self.i32() * 2)
                    self.skip(4 + 4 + 8)
                    if kind == 2:
                        self.skip(17)
                else:
                    raise ValueError(f'unknown node kind {kind} ({name})')
                for _ in range(nchild):
                    node(mat)

            node(np.eye(4))
            return out
        finally:
            f.close()


def layout_kn5s(base, cfg):
    """The layout's KN5 files: kn5_files / markersKn5, then its models ini"""
    files = list(cfg.get('kn5_files') or [])
    if cfg.get('markersKn5'):
        files.append(cfg['markersKn5'])
    mi = cfg.get('models_ini')
    if not mi:
        lay = cfg.get('layout_dir') or ''
        mi = f'models_{lay}.ini' if lay else 'models.ini'
    ini = os.path.join(base, mi)
    if os.path.exists(ini):
        cp = configparser.ConfigParser(strict=False, inline_comment_prefixes=(';', '//'))
        txt = open(ini, encoding='utf-8-sig', errors='replace').read()
        head = re.search(r'^\s*\[', txt, re.M)
        cp.read_string(txt[head.start():] if head else '')
        for sec in cp.sections():
            fn = cp[sec].get('FILE', '').strip()
            if fn.lower().endswith('.kn5') and fn not in files:
                files.append(fn)
    if not files:
        stem = os.path.basename(base.rstrip('/'))
        files.append(stem + '.kn5')
    return [x for x in files if os.path.exists(os.path.join(base, x))]


def pit_dummies(base, cfg):
    """AC_PIT_n world matrices: the layout's KN5s, else any top-level KN5 that has them"""
    pat = r'^AC_PIT_\d+$'
    found, where = {}, {}
    files = layout_kn5s(base, cfg)
    for fn in files:
        try:
            m = KN5(os.path.join(base, fn)).markers(pat)
        except (ValueError, struct.error) as e:
            print(f'    {fn}: {e}')
            continue
        for k, v in m.items():
            if k not in found:
                found[k], where[k] = v, fn
    if not found:
        for fp in sorted(glob.glob(os.path.join(base, '*.kn5'))):
            if os.path.basename(fp) in files:
                continue
            try:
                m = KN5(fp).markers(pat)
            except (ValueError, struct.error):
                continue
            for k, v in m.items():
                if k not in found:
                    found[k], where[k] = v, os.path.basename(fp)
    return {int(k[7:]): v for k, v in found.items()}, sorted(set(where.values()))


def ui_pitboxes(base, layout):
    p = os.path.join(base, 'ui', layout, 'ui_track.json') if layout else os.path.join(base, 'ui', 'ui_track.json')
    if not os.path.exists(p):
        return None
    m = re.search(r'"pitboxes"\s*:\s*"?(\d+)', open(p, encoding='utf-8-sig', errors='replace').read())
    return int(m.group(1)) if m else None


# ---------------------------------------------------------------- geometry

class Road:
    """The lap's centreline samples (closed), for the off-road test: segment projection in x/z"""

    def __init__(self, td):
        S = td['samples']
        P = np.array([s['p'] for s in S], float)
        self.L = float(td['metadata']['lengthMeters'])
        self.A = P[:, [0, 2]]
        self.AB = np.roll(self.A, -1, 0) - self.A
        self.l2 = np.maximum((self.AB ** 2).sum(1), 1e-12)
        W = np.array([s['w'] for s in S], float)
        self.W0, self.W1 = W, np.roll(W, -1)
        s0 = np.array([s['s'] for s in S], float)
        self.S0, self.S1 = s0, np.r_[s0[1:], self.L]

    def project(self, Q):
        """Per x/z point: edge (m past the road edge), lateral (m, + right of the lap), lap position"""
        edge = np.empty(len(Q))
        lat = np.empty(len(Q))
        s = np.empty(len(Q))
        for a in range(0, len(Q), 256):
            q = Q[a:a + 256]
            AQ = q[:, None, :] - self.A[None]
            t = np.clip((AQ * self.AB[None]).sum(-1) / self.l2[None], 0, 1)
            D = AQ - self.AB[None] * t[..., None]
            d2 = (D ** 2).sum(-1)
            i = np.argmin(d2, 1)
            r = np.arange(len(q))
            ti = t[r, i]
            dist = np.sqrt(d2[r, i])
            half = 0.5 * (self.W0[i] * (1 - ti) + self.W1[i] * ti)
            ab = self.AB[i]
            right = (D[r, i, 0] * -ab[:, 1] + D[r, i, 1] * ab[:, 0]) / np.sqrt(self.l2[i])
            edge[a:a + 256] = dist - half
            lat[a:a + 256] = np.where(right >= 0, dist, -dist)
            s[a:a + 256] = (self.S0[i] + ti * (self.S1[i] - self.S0[i])) % self.L
        return edge, lat, s


def xz_cum(V):
    return np.r_[0.0, np.cumsum(np.hypot(np.diff(V[:, 0]), np.diff(V[:, 2])))]


def dedupe_xz(V, eps=1e-6):
    keep = np.r_[True, np.hypot(np.diff(V[:, 0]), np.diff(V[:, 2])) > eps]
    return V[keep]


def runs(mask):
    """[(i0, i1)] inclusive index ranges where mask holds"""
    out = []
    i, n = 0, len(mask)
    while i < n:
        if mask[i]:
            j = i
            while j + 1 < n and mask[j + 1]:
                j += 1
            out.append((i, j))
            i = j + 1
        else:
            i += 1
    return out


class Profile:
    """A lane polyline sampled every DENSE_M (x/z) against the road"""

    def __init__(self, V, road):
        self.V = V
        self.cum = xz_cum(V)
        m = np.unique(np.r_[np.arange(0.0, self.cum[-1], DENSE_M), self.cum[-1]])
        self.m = m
        Q = np.stack([np.interp(m, self.cum, V[:, 0]), np.interp(m, self.cum, V[:, 2])], 1)
        self.edge, self.lat, self.s = road.project(Q)
        self.runs = runs(self.edge > OFF_ROAD_M)

    def length(self, r):
        return self.m[r[1]] - self.m[r[0]]

    def start_of(self, i0):
        """Lane m where the edge crosses OFF_ROAD_M going off the road at dense index i0"""
        if i0 == 0:
            return float(self.m[0])
        e0, e1 = self.edge[i0 - 1], self.edge[i0]
        return float(self.m[i0 - 1] + (OFF_ROAD_M - e0) / (e1 - e0) * (self.m[i0] - self.m[i0 - 1]))

    def end_of(self, i1):
        if i1 == len(self.m) - 1:
            return float(self.m[-1])
        e0, e1 = self.edge[i1], self.edge[i1 + 1]
        return float(self.m[i1] + (e0 - OFF_ROAD_M) / (e0 - e1) * (self.m[i1 + 1] - self.m[i1]))

    def s_at(self, laneM):
        i = int(np.clip(np.searchsorted(self.m, laneM), 0, len(self.m) - 1))
        return float(self.s[i])


def wrap_half(d, L):
    return (d + L / 2) % L - L / 2


def lane_span(tid, prof, road, circular=False):
    """leave, rejoin, the end of the first stretch off the road, note. `circular`: the profile is of a closed lap whose
    first and last runs are one"""
    rs = list(prof.runs)
    if not rs:
        return None
    total = prof.m[-1]
    if circular and len(rs) > 1 and rs[0][0] == 0 and rs[-1][1] == len(prof.m) - 1:
        first, last = rs[0], rs[-1]
        lens = [prof.length(r) for r in rs[1:-1]]
        joined = prof.length(last) + prof.length(first)
        if not lens or joined >= max(lens):
            return prof.start_of(last[0]), prof.end_of(first[1]) + total, None, 'whole-lap spline, turned to run entry -> exit'
        rs = rs[1:-1]
    main = max(rs, key=prof.length)
    leave, rejoin = prof.start_of(main[0]), prof.end_of(main[1])
    if tid not in MERGE_AT:
        return leave, rejoin, None, ''
    # The exit runs along the road edge and merges further on
    target = MERGE_AT[tid]
    side = np.sign(np.median(prof.lat[main[0]:main[1] + 1]))
    later = [r for r in rs if r[0] > main[1] and abs(wrap_half(prof.s[r[1]] - target, road.L)) <= MERGE_TOL_M]
    if not later:
        return leave, rejoin, None, f'no off-road stretch ends near s {target:.0f}: rejoin kept at the first run end'
    cand = later[0]
    seg = slice(main[1], cand[1] + 1)
    if np.any(np.sign(prof.lat[seg]) != side):
        return leave, rejoin, None, 'the exit crosses to the other side of the road before the merge: rejoin kept'
    inside = float(-prof.edge[main[1]:cand[0] + 1].min())
    if inside > MERGE_MAX_INSIDE_M:
        return leave, rejoin, None, f'the exit runs {inside:.1f} m inside the road edge before the merge: rejoin kept'
    merge = prof.end_of(cand[1])
    return leave, merge, rejoin, (f'exit along the road edge (<= {inside:.1f} m inside it) from lane {rejoin:.0f} m '
                                  f'(s {prof.s[main[1]]:.0f}), merges at lane {merge:.0f} m (s {prof.s[cand[1]]:.0f})')


def cut(V, a, b):
    """The polyline V between x/z arc lengths a and b (with interpolated ends)"""
    cum = xz_cum(V)
    a, b = max(0.0, a), min(cum[-1], b)
    ia = int(np.searchsorted(cum, a, 'right'))
    ib = int(np.searchsorted(cum, b, 'left'))
    pa = np.array([np.interp(a, cum, V[:, k]) for k in range(3)])
    pb = np.array([np.interp(b, cum, V[:, k]) for k in range(3)])
    mid = V[ia:ib]
    out = np.vstack([pa, mid, pb])
    return dedupe_xz(out, 1e-4)


def densify(V, step):
    """Linear points added so no segment is longer than `step` (3D)"""
    out = [V[0]]
    for a, b in zip(V[:-1], V[1:]):
        k = int(math.ceil(np.linalg.norm(b - a) / step))
        for j in range(1, k):
            out.append(a + (b - a) * j / k)
        out.append(b)
    return np.array(out)


def seg_dist(P, A, B):
    """Distance of each point in P (m,3) to segment AB"""
    ab = B - A
    l2 = float(ab @ ab)
    if l2 < 1e-12:
        return np.linalg.norm(P - A, axis=1)
    t = np.clip(((P - A) @ ab) / l2, 0, 1)
    return np.linalg.norm(P - (A + t[:, None] * ab), axis=1)


def thin(V, tol=THIN_TOL_M, gap=MAX_GAP_M):
    """Douglas-Peucker with a cap on the distance between kept points"""
    n = len(V)
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    cum = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(V, axis=0), axis=1))]
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        d = seg_dist(V[i + 1:j], V[i], V[j])
        k = int(np.argmax(d))
        if d[k] <= tol:
            if np.linalg.norm(V[j] - V[i]) <= gap:
                continue
            k = int(np.argmin(np.abs(cum[i + 1:j] - (cum[i] + cum[j]) / 2)))
        mid = i + 1 + k
        keep[mid] = True
        stack += [(i, mid), (mid, j)]
    return V[keep]


def max_deviation(P, V):
    """Largest distance of the points P from the polyline V (3D)"""
    A, B = V[:-1], V[1:]
    AB = B - A
    l2 = np.maximum((AB ** 2).sum(1), 1e-12)
    worst = 0.0
    for a in range(0, len(P), 256):
        q = P[a:a + 256]
        AQ = q[:, None, :] - A[None]
        t = np.clip((AQ * AB[None]).sum(-1) / l2[None], 0, 1)
        d = np.linalg.norm(AQ - AB[None] * t[..., None], axis=-1).min(1)
        worst = max(worst, float(d.max()))
    return worst


def project_lane(V, x, z):
    """pit-lane.ts projectPolyline over the whole lane: lane m, offset (+ right), distance, segment, u"""
    cum = xz_cum(V)
    A = V[:-1][:, [0, 2]]
    AB = V[1:][:, [0, 2]] - A
    l2 = (AB ** 2).sum(1)
    ok = l2 >= 1e-9
    q = np.array([x, z])
    u = np.clip(((q - A) * AB).sum(1) / np.where(ok, l2, 1), 0, 1)
    C = A + AB * u[:, None]
    d2 = np.where(ok, ((q - C) ** 2).sum(1), np.inf)
    i = int(np.argmin(d2))
    ln = math.sqrt(l2[i])
    dx, dz = q - C[i]
    off = (dx * -AB[i, 1] + dz * AB[i, 0]) / ln
    return float(cum[i] + u[i] * ln), float(off), math.sqrt(d2[i]), i, float(u[i])


# ---------------------------------------------------------------- JSON

def num(v, nd):
    r = round(float(v), nd)
    if r == 0:
        return 0
    return int(r) if r.is_integer() else r


def pitlane_span(text):
    """Byte span of the top-level "pitLane" value in the file's text (None, insert point if it has none)"""
    dec = json.JSONDecoder()
    i = text.index('{') + 1
    n = len(text)

    def ws(j):
        while j < n and text[j] in ' \t\r\n':
            j += 1
        return j

    i = ws(i)
    while i < n and text[i] != '}':
        key, i = dec.raw_decode(text, i)
        i = ws(i)
        assert text[i] == ':'
        i = ws(i + 1)
        _, end = dec.raw_decode(text, i)
        if key == 'pitLane':
            return i, end
        i = ws(end)
        if text[i] == ',':
            i = ws(i + 1)
    return None, i


def dump_like(value, orig, text, start):
    """`value` serialised the way the file writes its pitLane"""
    if '\n' in orig:
        line_start = text.rfind('\n', 0, start) + 1
        pad = re.match(r'[ \t]*', text[line_start:]).group(0)
        inner = re.search(r'\n([ \t]+)', orig)
        unit = len(inner.group(1)) - len(pad) if inner else 2
        return json.dumps(value, indent=max(1, unit)).replace('\n', '\n' + pad)
    item = ', ' if re.search(r',\s', orig) else ','
    key = ': ' if re.search(r':\s', orig) else ':'
    return json.dumps(value, separators=(item, key))


def splice(text, value):
    start, end = pitlane_span(text)
    if start is None:
        raise SystemExit('no pitLane in the source file')
    orig = text[start:end]
    new = dump_like(value, orig, text, start)
    out = text[:start] + new + text[end:]
    assert out[:start] == text[:start] and out[start + len(new):] == text[end:]
    a, b = json.loads(text), json.loads(out)
    a.pop('pitLane', None)
    b.pop('pitLane', None)
    assert a == b, 'a key other than pitLane changed'
    return out


# ---------------------------------------------------------------- boxes

def boxes_from(dummies, ids, mo, V, limit_start, limit_end):
    """Pit boxes [x, y, z, heading] for AC_PIT_<ids> against the exported lane V; dropped and adjusted ones"""
    feet = []
    for k in ids:
        M = dummies[k]
        pos = M[:3, 3] + mo
        laneM, off, dist, i, u = project_lane(V, pos[0], pos[2])
        feet.append((k, M, pos, laneM, off, dist, i, V[i, 1] + (V[i + 1, 1] - V[i, 1]) * u))
    # The dummies' height over the lane, one call per circuit: AC's sit 0.3-0.8 m over the AI lane (kept), some mods
    # float them metres up (AC drops the car): those boxes all take the lane's height
    dy = [pos[1] - lane_y for _, _, pos, _, _, _, _, lane_y in feet]
    floating = bool(dy) and abs(float(np.median(dy))) > BOX_Y_TOL_M
    kept, dropped, yaw_fixed, offsets, dists = [], [], [], [], []
    for k, M, pos, laneM, off, dist, i, lane_y in feet:
        f = M[:3, 2]
        lane_yaw = math.atan2(V[i + 1, 0] - V[i, 0], V[i + 1, 2] - V[i, 2])
        yaw = math.atan2(f[0], f[2])
        dyaw = math.degrees(wrap_half(yaw - lane_yaw, 2 * math.pi))
        if abs(dyaw) > YAW_TOL_DEG:
            yaw_fixed.append((k, round(dyaw)))
            yaw = lane_yaw
        y = lane_y if floating else pos[1]
        if laneM < limit_start + ZONE_SLACK_M or laneM > limit_end - ZONE_SLACK_M:
            dropped.append((k, round(laneM, 1)))
            continue
        offsets.append(off)
        dists.append(dist)
        kept.append([num(pos[0], 2), num(y, 2), num(pos[2], 2), num(yaw, 4)])
    dy_range = (round(float(min(dy)), 2), round(float(np.median(dy)), 2), round(float(max(dy)), 2)) if dy else None
    return kept, dict(dropped=dropped, yaw_fixed=yaw_fixed, floating=floating, dy=dy_range, offsets=offsets, dists=dists)


# ---------------------------------------------------------------- per circuit

def build_ac(tid, cfg, base, td, road):
    """v2 pitLane of an AC_TRACKS circuit and its report"""
    lay = cfg.get('layout_dir') or ''
    lp = os.path.join(base, lay) if lay else base
    pa = os.path.join(lp, 'ai', 'pit_lane.ai')
    if not os.path.exists(pa):
        return None, f'no {os.path.relpath(pa, base)} in {base}'
    mo = np.array(td['metadata'].get('modelOffset') or [0, 0, 0], float)
    raw = dedupe_xz(read_ai_lane(pa) + mo)
    rep = {'source': base, 'rawPts': len(raw), 'rawLen': float(xz_cum(raw)[-1])}
    gap = float(np.hypot(*(raw[-1] - raw[0])[[0, 2]]))
    closed = gap < CLOSED_GAP_M and rep['rawLen'] > 0.5 * road.L
    if closed:
        # A whole lap: close it, find the lane across the seam, and run it from there
        loop = densify(np.vstack([raw, raw[:1]]), MAX_GAP_M)
        prof = Profile(loop, road)
        span = lane_span(tid, prof, road, circular=True)
        if span is None:
            return None, 'the pit spline never leaves the road'
        total = float(xz_cum(loop)[-1])
        a = span[0] - MARGIN_M
        b = min(span[1] + MARGIN_M, a + total)
        if a < 0:
            a, b = a + total, b + total
        thrice = np.vstack([loop, loop[1:], loop[1:]])
        trimmed = cut(thrice, a, b)
        rep['notes'] = [f'{span[3]} (seam at the spline\'s ends closed, {gap:.1f} m)']
    else:
        prof = Profile(raw, road)
        span = lane_span(tid, prof, road)
        if span is None:
            return None, 'the pit spline never leaves the road'
        trimmed = cut(densify(raw, MAX_GAP_M), span[0] - MARGIN_M, span[1] + MARGIN_M)
        rep['notes'] = []
        if span[1] + MARGIN_M < rep['rawLen'] - 1:
            rep['notes'].append(f'spline cut {rep["rawLen"] - span[1] - MARGIN_M:.0f} m before its end')
    trimmed = densify(trimmed, MAX_GAP_M)
    # 2 cm under the cap: rounding to 1 cm moves a point by up to 0.9 cm
    V = dedupe_xz(np.round(thin(trimmed, gap=MAX_GAP_M - 0.02), 2), 1e-6)
    rep['maxDevM'] = max(max_deviation(trimmed, V), max_deviation(V, trimmed))
    gaps = np.linalg.norm(np.diff(V, axis=0), axis=1)
    assert rep['maxDevM'] < 0.05 and gaps.max() <= MAX_GAP_M, (tid, rep['maxDevM'], gaps.max())
    # leave / rejoin again along the exported lane
    pv = Profile(V, road)
    leave, rejoin, first_end, note = lane_span(tid, pv, road)
    if note:
        rep['notes'].append(note)
    rep['leaveS'], rep['rejoinS'] = pv.s_at(leave), pv.s_at(rejoin)
    limit_start = leave + LIMIT_INSET_M
    limit_end = (first_end if first_end is not None else rejoin) - LIMIT_INSET_M
    if first_end is not None:
        # pit-lane.ts keeps a car in the lane only off the road: the zone ends before the lane meets the road edge
        rep['notes'].append(f'speed-limit zone ends {LIMIT_INSET_M:.0f} m before lane {first_end:.0f} m, where the exit '
                            'first meets the road edge')
    rep['laneLen'] = float(xz_cum(V)[-1])
    # Boxes
    dummies, files = pit_dummies(base, cfg)
    n_ui = ui_pitboxes(base, lay)
    want = n_ui or cfg.get('pitboxes') or len(dummies)
    ids = [k for k in range(want) if k in dummies]
    rep['boxSrc'] = f'{len(dummies)} AC_PIT in {",".join(files) or "-"}, N {want} ({"ui_track.json" if n_ui else "porter" if cfg.get("pitboxes") else "all"})'
    boxes, brep = boxes_from(dummies, ids, mo, V, limit_start, limit_end)
    rep.update(brep, boxesTotal=len(ids), boxesKept=len(boxes))
    pl = dict(td['pitLane'])
    pl = {
        'entryS': pl.get('entryS'),
        'exitS': pl.get('exitS'),
        'widthM': pl.get('widthM', WIDTH_M),
        'centerline': [[num(v, 2) for v in p] for p in V],
        'v': 2,
        'leaveM': num(leave, 2),
        'rejoinM': num(rejoin, 2),
        'limitStartM': num(limit_start, 2),
        'limitEndM': num(limit_end, 2),
    }
    if boxes:
        pl['boxes'] = boxes
    pl['limitKmh'] = LIMIT_KMH
    rep.update(leaveM=leave, rejoinM=rejoin, limitStartM=limit_start, limitEndM=limit_end, pts=len(V))
    return pl, rep


def build_extra(tid, ex, base, td, road):
    """v2 pitLane of a circuit that keeps its stored lane, with the boxes of its AC build"""
    stored = td['pitLane']
    V = np.array(stored['centerline'], float)
    pv = Profile(V, road)
    span = lane_span(tid, pv, road)
    if span is None:
        return None, 'the stored lane never leaves the road'
    leave, rejoin, first_end, note = span
    limit_start, limit_end = leave + LIMIT_INSET_M, rejoin - LIMIT_INSET_M
    rep = {'source': base or '-', 'rawPts': len(V), 'laneLen': float(xz_cum(V)[-1]), 'maxDevM': 0.0, 'notes': ['stored lane kept'],
           'leaveS': pv.s_at(leave), 'rejoinS': pv.s_at(rejoin), 'pts': len(V)}
    if note:
        rep['notes'].append(note)
    boxes = []
    rep.update(boxesTotal=0, boxesKept=0, dropped=[], yaw_fixed=[], floating=False, dy=None, offsets=[], dists=[])
    if base:
        mo = np.array(td['metadata'].get('modelOffset') or [0, 0, 0], float)
        cfg = {'layout_dir': ex['layout_dir']}
        pa = os.path.join(base, ex['layout_dir'], 'ai', 'pit_lane.ai')
        if os.path.exists(pa):
            P = read_ai_lane(pa) + mo
            d = [float(np.min(np.hypot(P[:, 0] - c[0], P[:, 2] - c[2]))) for c in V]
            rep['notes'].append(f'frame check: the mod\'s pit_lane.ai is within {max(d):.1f} m of the stored lane')
        dummies, files = pit_dummies(base, cfg)
        n_ui = ui_pitboxes(base, ex['layout_dir'])
        want = ex.get('pitboxes') or n_ui or len(dummies)
        ids = [k for k in range(want) if k in dummies]
        rep['boxSrc'] = f'{len(dummies)} AC_PIT in {",".join(files) or "-"}, N {want} ({"set here" if ex.get("pitboxes") else "ui_track.json" if n_ui else "all"})'
        cand, brep = boxes_from(dummies, ids, mo, V, limit_start, limit_end)
        offs = np.array(brep['offsets'])
        # They sit beside the lane: one side, a garage's distance away
        if len(offs) >= 4 and (np.all(offs > 0) or np.all(offs < 0)) and np.max(brep['dists']) < 20:
            boxes = cand
            rep.update(brep, boxesTotal=len(ids), boxesKept=len(boxes))
        else:
            rep['notes'].append(f'boxes skipped: they do not sit beside the lane (offsets {np.round(offs, 1).tolist()[:8]})')
            rep['boxesTotal'] = len(ids)
    else:
        rep['notes'].append(f'no AC build ({ex["folder"]}) on disk: boxes laid out by the game')
        rep['boxSrc'] = '-'
    pl = {k: stored[k] for k in ('entryS', 'exitS', 'widthM', 'centerline') if k in stored}
    pl.update({'v': 2, 'leaveM': num(leave, 2), 'rejoinM': num(rejoin, 2), 'limitStartM': num(limit_start, 2),
               'limitEndM': num(limit_end, 2)})
    if boxes:
        pl['boxes'] = boxes
    pl['limitKmh'] = LIMIT_KMH
    rep.update(leaveM=leave, rejoinM=rejoin, limitStartM=limit_start, limitEndM=limit_end)
    return pl, rep


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ids', nargs='*', help='circuit ids (default: every one under --tracks)')
    ap.add_argument('--tracks', default=os.path.join(ROOT, 'public', 'tracks'), help='folder of <id>/track_data.json')
    ap.add_argument('--out', default=DEFAULT_OUT, help='output folder (default %(default)s)')
    ap.add_argument('--sources', default='', help='JSON {"<folder or id>": "<path>"} (default scripts/tracks/sources.local.json)')
    ap.add_argument('--search', action='append', default=None, help='folder searched for mod folders (default ~/Downloads)')
    a = ap.parse_args()
    tracks, out = os.path.abspath(os.path.expanduser(a.tracks)), os.path.abspath(os.path.expanduser(a.out))
    if os.path.realpath(tracks) == os.path.realpath(out):
        raise SystemExit('--out is the input folder: this script never writes track data in place')
    cfgs = porter_configs()
    srcs = Sources(a.sources, a.search or DEFAULT_SEARCH)
    ids = a.ids or sorted(d for d in os.listdir(tracks) if os.path.exists(os.path.join(tracks, d, 'track_data.json')))
    rows, written, skipped = [], [], []
    for tid in ids:
        path = os.path.join(tracks, tid, 'track_data.json')
        if not os.path.exists(path):
            skipped.append((tid, f'no {path}'))
            continue
        text = open(path, encoding='utf-8').read()
        td = json.loads(text)
        if tid in NO_PIT_LANE:
            pl, rep = {'none': True}, {'notes': ['no pit lane']}
        elif tid in EXTRA:
            ex = EXTRA[tid]
            base = srcs.resolve(tid, ex['folder'])
            pl, rep = build_extra(tid, ex, base, td, Road(td))
        elif tid in cfgs:
            base = srcs.resolve(tid, cfgs[tid]['folder'])
            if not base:
                skipped.append((tid, f"AC source folder '{cfgs[tid]['folder']}' not on disk"))
                print(f'SKIP  {tid}: AC source folder {cfgs[tid]["folder"]!r} not on disk')
                continue
            pl, rep = build_ac(tid, cfgs[tid], base, td, Road(td))
        else:
            skipped.append((tid, 'not an AC_TRACKS circuit nor in EXTRA'))
            print(f'SKIP  {tid}: not an AC_TRACKS circuit nor in EXTRA')
            continue
        if pl is None:
            skipped.append((tid, rep))
            print(f'SKIP  {tid}: {rep}')
            continue
        new = splice(text, pl)
        dst = os.path.join(out, tid, 'track_data.json')
        # public/tracks/<id> may be a link into another checkout: compare the files themselves
        if os.path.exists(dst) and os.path.realpath(dst) == os.path.realpath(path):
            raise SystemExit(f'{dst} is the source file: this script never writes track data in place')
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'w', encoding='utf-8', newline='') as f:
            f.write(new)
        size0, size1 = len(text.encode('utf-8')), len(new.encode('utf-8'))
        written.append((dst, size1))
        rep['size'] = (size0, size1)
        rows.append((tid, rep))
        if 'none' in pl:
            print(f'ok    {tid}: {{"none": true}}, {size0} -> {size1} B ({size1 - size0:+d})')
            continue
        drop = ', '.join(f'AC_PIT_{k}@{m}' for k, m in rep['dropped'])
        print(f"ok    {tid}: lane {rep['laneLen']:.1f} m, {rep['pts']} pts (raw {rep['rawPts']} pts / "
              f"{rep.get('rawLen', rep['laneLen']):.0f} m), leave {rep['leaveM']:.1f} m (s {rep['leaveS']:.1f}) -> rejoin "
              f"{rep['rejoinM']:.1f} m (s {rep['rejoinS']:.1f}), zone {rep['limitStartM']:.1f}..{rep['limitEndM']:.1f} m, "
              f"max dev {rep['maxDevM'] * 100:.1f} cm, {size0} -> {size1} B ({size1 - size0:+d})")
        print(f"        boxes {rep['boxesKept']}/{rep['boxesTotal']} kept [{rep.get('boxSrc', '-')}]"
              + (f", dropped {drop}" if drop else '')
              + (f", lane heading for {len(rep['yaw_fixed'])} (dummies off by {min(d for _, d in rep['yaw_fixed'])}.."
                 f"{max(d for _, d in rep['yaw_fixed'])} deg)" if rep['yaw_fixed'] else '')
              + (f", dummies {rep['dy'][0]}..{rep['dy'][2]} m over the lane"
                 + (' (floating: lane height used)' if rep['floating'] else '') if rep['dy'] else '')
              + (f", |offset| {min(abs(o) for o in rep['offsets']):.1f}..{max(abs(o) for o in rep['offsets']):.1f} m" if rep['offsets'] else ''))
        for n in rep['notes']:
            if n:
                print(f'        {n}')
        print(f"        source {rep['source']}")
    print(f'\n{len(written)} written to {out}')
    for tid, why in skipped:
        print(f'skipped {tid}: {why}')
    return rows


if __name__ == '__main__':
    sys.exit(0 if main() is not None else 1)
