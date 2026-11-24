"""
A Speed Dreams circuit → the inputs of build_blender_track.py: an uncompressed GLB of named surface meshes (Road, Kerb,
Runoff, Gravel, Grass, Wall, PitLane) with Track_Centreline, Track_Start and Track_PitLane and the circuit's scenery,
and a settings JSON.

    uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
        python -P scripts/tracks/extract_sd_track.py <circuit folder> --out-glb <circuit.glb> --out-settings <circuit.json> \
        [--sd-data <folder>] [--needs-json <file.json>] [--geometry-json <file.json>] [--no-scenery]

`npm run mod -- import sd-track` (scripts/mods/importers/sd-track.ts) runs it, then build_blender_track.py.

The circuit folder is Speed Dreams' own: data/tracks/<category>/<name>/ in an install, or the folder of one of the
circuit archives its in-game downloader fetches. It holds the circuit's trackdef XML (<name>.xml) and the AC3D model
that XML names (Graphic > 3d description, an .ac or .acc).

- The road and everything beside it come from the XML, built the way Speed Dreams' own track loader builds them
  (speed-dreams-code, src/modules/track/trackv1/track4.cpp): the segments (straights, and arcs by radius and angle)
  cut into the same steps, the road's width, its elevation along them (z start and end, grade, the cubic profile and
  its tangents) and its banking, and on each side a border (a kerb, a wall, or a flat strip), a side (run-off, grass,
  sand and the like, by its surface) and a barrier (a fence or a wall). The centreline, the start line (where the
  first segment begins) and the pit lane (from the pit entry segment to the exit) come from the same geometry.
  Coordinates are moved to the loader's (its smallest x, y and z at 0), which is where the AC3D model sits.
- Each surface the XML names becomes one of the builder's (surface_role below), drawn with the surface's own texture
  at its own size when the texture is there (in the circuit's folder or in Speed Dreams' data/textures/). A texture
  that is only grain (small and near white) takes the surface's own colour.
- The scenery is the AC3D model without the road trackgen drew into it: the objects it names tkMn, tkRS, tkLS, t*RB,
  t*LB, B*Rt and B*Lt (the road, the sides, the borders and the barriers, all generated again here) are left out, so
  nothing lies in the generated road's plane. Everything else (terrain, buildings, trees, the pit buildings) is drawn as
  the model has it, grouped by texture into meshes named Scenery_*, which the builder never drives on. Each object
  keeps its base texture, except terrain whose base texture is only grain under a baked colour map (an .acc's tiled
  layer): that map is drawn instead. The shadow, skid and raceline layers of an .acc are left out.
- --sd-data: Speed Dreams' base data (the speed-dreams-data repository's data/ folder, or an install's data folder),
  for the surfaces most circuits include (data/tracks/surfaces.xml) and their textures (data/textures/). A circuit in
  an install finds them on its own.
- --needs-json: only lists the textures the circuit's folder lacks, so the importer fetches just those from the base
  data.
- --geometry-json: also writes what was built, for scripts/verify/verify-sd-track.ts: the lap's length, the centreline, the
  surfaces by role, the pit lane, and how far the AC3D road lies from the generated one.

Closed circuits only, as build_blender_track.py: Speed Dreams' own tracks all are.
"""
import argparse
import io
import json
import math
import os
import re
import struct
import sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

Image.MAX_IMAGE_PIXELS = None

# --------------------------------------------------------------------------------------------------------------------
# Speed Dreams' parameter files (src/libs/tgf/params.cpp): nested <section>s of <attnum> (a number in a unit) and
# <attstr>. Numbers are kept in SI units, as GfParmGetNum returns them.

UNITS = {
    'deg': math.pi / 180.0, '%': 0.01, 'percent': 0.01, 'mm': 0.001, 'cm': 0.01, 'km': 1000.0,
    'feet': 0.304801, 'ft': 0.304801, 'in': 0.0254, 'inch': 0.0254, 'inches': 0.0254,
    'lbs': 0.45359237, 'lb': 0.45359237, 'h': 3600.0, 'hour': 3600.0, 'hours': 3600.0,
    'kph': 0.277778, 'KPH': 0.277778, 'mph': 0.44704, 'MPH': 0.44704,
}


class Section:
    """One <section>: its numbers (SI), its strings and its sub-sections, in file order"""

    def __init__(self, name):
        self.name = name
        self.nums = {}
        self.strs = {}
        self.kids = {}

    def sub(self, path):
        s = self
        for part in path.split('/'):
            if part:
                s = s.kids.get(part) if s is not None else None
        return s

    def num(self, key, default=None):
        return self.nums.get(key, default)

    def str(self, key, default=None):
        return self.strs.get(key, default)


def _number(text):
    """A number as the XML writes it, or None for none; a value that isn't finite (nan, inf, 1e999) is refused"""
    if text is None:
        return None
    text = text.strip()
    try:
        v = float(text)
    except ValueError:
        try:
            v = float(int(text, 0))
        except (ValueError, OverflowError):
            return None
    if not math.isfinite(v):
        raise ValueError(f'"{text}" is not a finite number')
    return v


def _fill(el, sec, path=''):
    for ch in el:
        if ch.tag == 'section':
            name = ch.get('name', '')
            kid = sec.kids.get(name)
            if kid is None:
                kid = sec.kids[name] = Section(name)
            _fill(ch, kid, f'{path}/{name}' if path else name)
        elif ch.tag == 'attnum':
            key = ch.get('name', '')
            try:
                v = _number(ch.get('val'))
                if v is not None:
                    v *= UNITS.get(ch.get('unit') or '', 1.0)
                    if not math.isfinite(v):
                        raise ValueError(f'"{ch.get("val")} {ch.get("unit")}" is not a finite number')
            except ValueError as e:
                raise SystemExit(f'{path} > {key}: {e}')
            if v is not None:
                sec.nums[key] = v
        elif ch.tag == 'attstr':
            sec.strs[ch.get('name', '')] = ch.get('val', '')


def _decode(raw):
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('latin-1')


def sd_data_file(sd_data, *names):
    """A file of Speed Dreams' base data, by its path under data/ (`tracks/surfaces.xml`, `textures/x.png`)"""
    if not sd_data:
        return None
    for root in (os.path.join(sd_data, 'data'), sd_data, os.path.join(sd_data, 'data', 'data')):
        for name in names:
            p = os.path.join(root, name)
            if os.path.isfile(p):
                return p
    return None


# The shared files a trackdef may include (`<!ENTITY default-surfaces SYSTEM "../../../data/tracks/surfaces.xml">`):
# Speed Dreams' default surfaces and objects, in its data/tracks/ (scripts/mods/lib/sd-fetch.ts SHARED_TRACK_FILES)
SHARED_TRACK_FILES = ('surfaces.xml', 'objects.xml')


def _inside(path, root):
    """Whether `path` lies in `root`, links followed"""
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def include_path(rel, here, sd_data):
    """The file an <!ENTITY … SYSTEM "rel"> of the trackdef in `here` may include, or None: an XML file of the circuit's
    own folder, or one of Speed Dreams' shared track files (SHARED_TRACK_FILES) from the base data or from the install
    the circuit sits in (data/tracks/<category>/<name>/ beside data/data/tracks/). Never another file, wherever the
    entity points: a trackdef is the circuit author's, and an include outside these would put any file's text in the
    converted circuit"""
    base = os.path.basename(rel.replace('\\', '/'))
    if not base.lower().endswith('.xml'):
        return None
    own = os.path.join(here, rel)
    if _inside(own, here) and os.path.isfile(own):
        return own
    if base.lower() in SHARED_TRACK_FILES:
        install = os.path.join(here, '..', '..', '..', 'data', 'tracks', base.lower())
        for cand in (sd_data_file(sd_data, os.path.join('tracks', base.lower())), install):
            if cand and os.path.isfile(cand):
                return cand
    own = os.path.join(here, base)
    return own if _inside(own, here) and os.path.isfile(own) else None


def read_params(path, sd_data=None, log=print):
    """A parameter file as nested Sections, with the files its DOCTYPE includes (`&default-surfaces;`) put in place.
    An included file is taken only from the circuit's own folder or Speed Dreams' shared track files (include_path);
    one that isn't there is left out (the circuit then lacks Speed Dreams' default surfaces, and the generated road
    their textures)"""
    text = _decode(open(path, 'rb').read())
    here = os.path.dirname(os.path.abspath(path))
    entities = {}
    m = re.search(r'<!DOCTYPE\s+\w+[^\[>]*(?:\[(.*?)\])?\s*>', text, re.S)
    if m:
        for name, rel in re.findall(r'<!ENTITY\s+([\w.-]+)\s+SYSTEM\s+"([^"]+)"\s*>', m.group(1) or ''):
            entities[name] = rel
        text = text[:m.start()] + text[m.end():]
    for name, rel in entities.items():
        found = include_path(rel, here, sd_data)
        if found:
            inc = _decode(open(found, 'rb').read())
            inc = re.sub(r'<\?xml[^>]*\?>', '', inc)
            inc = re.sub(r'<!DOCTYPE[^\[>]*(?:\[.*?\])?\s*>', '', inc, flags=re.S)
        else:
            log(f'  {rel} (&{name};) not included: it is neither in the circuit\'s folder nor one of Speed Dreams\' shared '
                f'track files ({", ".join(SHARED_TRACK_FILES)}; give --sd-data, Speed Dreams\' base data)')
            inc = ''
        text = text.replace(f'&{name};', inc)
    text = re.sub(r'<\?xml[^>]*\?>', '', text, count=1)
    # entities other than XML's own would stop the parser
    text = re.sub(r'&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[\w.-]+;', '', text)
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise SystemExit(f'{path}: not well-formed XML ({e})')
    top = Section(root.get('name', ''))
    _fill(root, top)
    return top


# --------------------------------------------------------------------------------------------------------------------
# The track, as track4.cpp's CreateSegRing, AddSides and InitPits build it

def track_spline(p0, p1, t0, t1, t):
    """trackutil.cpp TrackSpline: the cubic Hermite curve of a segment's profile"""
    t2 = t * t
    t3 = t * t2
    h1 = 3 * t2 - 2 * t3
    h0 = 1 - h1
    h2 = t3 - 2 * t2 + t
    h3 = t3 - t2
    return h0 * p0 + h1 * p1 + h2 * t0 + h3 * t1


# What a trackdef may ask for and still be built: past these, an XML is malformed (or made to make the converter hang)
MAX_WIDTH_M = 200.0
MAX_SIDE_M = 1000.0
MAX_LAP_M = 100_000.0
MAX_BANKING = math.radians(80.0)
MAX_SEGMENT_STEPS = 10_000


class SideState:
    """One side's border, side and barrier as the loader carries them from segment to segment"""

    def __init__(self):
        self.sw = self.ew = 0.0
        self.side_surface = 'grass'
        self.bank = 0
        self.bw = self.bh = 0.0
        self.b_style = 'plan'
        self.b_surface = 'grass'
        self.bar_style = 'fence'
        self.bar_w = 0.0
        self.bar_h = 0.6
        self.bar_surface = 'barrier'


class Sub:
    """A step of a segment, the loader's tTrackSeg: its edges' ends and heights, its arc, and what lies beside it"""
    __slots__ = ('name', 'id', 'type', 'length', 'arc', 'radius', 'cx', 'cy', 'alf_s', 'alf_e', 'cs', 'width',
                 'surface', 'lg', 'sr', 'sl', 'er', 'el', 'xs', 'xe', 'sides', 'pit_role')


SIDE_NAMES = ('Right', 'Left')


def _side_width(sec, key, default, what):
    """A border's, side's or barrier's width: 0 (none) up to MAX_SIDE_M"""
    w = sec.num(key, default)
    if not 0.0 <= w <= MAX_SIDE_M:
        raise SystemExit(f'{what} > {key}: {w:g} m (0 to {MAX_SIDE_M:g} m)')
    return w


def _init_sides(main):
    states = []
    for name in SIDE_NAMES:
        st = SideState()
        s = main.sub(f'{name} Side') or Section('')
        st.side_surface = s.str('surface', 'grass')
        st.ew = _side_width(s, 'width', 0.0, f'{name} Side')
        st.bank = 0 if s.str('banking type', 'level') == 'level' else 1
        b = main.sub(f'{name} Border') or Section('')
        st.b_surface = b.str('surface', 'grass')
        st.bw = _side_width(b, 'width', 0.0, f'{name} Border')
        st.bh = b.num('height', 0.0)
        style = b.str('style', 'plan')
        st.b_style = style if style in ('plan', 'curb') else 'wall'
        if st.b_style == 'plan':
            st.bh = 0.0
        ba = main.sub(f'{name} Barrier') or Section('')
        st.bar_surface = ba.str('surface', 'barrier')
        st.bar_h = ba.num('height', 0.6)
        style = ba.str('style', 'fence')
        if style in ('fence', 'fence1', 'fence2'):
            st.bar_style, st.bar_w = style, 0.0
        else:
            st.bar_style, st.bar_w = 'wall', _side_width(ba, 'width', 0.5, f'{name} Barrier')
        states.append(st)
    return states


def _segment_sides(seg, states):
    """AddSides at a segment's first step: the segment's own border, side and barrier settings over the carried ones"""
    for name, st in zip(SIDE_NAMES, states):
        s = seg.sub(f'{name} Side') or Section('')
        what = f'segment {seg.name} > {name} Side'
        if 'width' in s.nums:
            sw = ew = _side_width(s, 'width', 0.0, what)
        else:
            sw = _side_width(s, 'start width', st.ew, what)
            ew = _side_width(s, 'end width', sw, what)
        st.sw, st.ew = sw, ew
        st.side_surface = s.str('surface', st.side_surface)
        b = seg.sub(f'{name} Border') or Section('')
        st.bw = _side_width(b, 'width', st.bw, f'segment {seg.name} > {name} Border')
        st.bh = b.num('height', st.bh)
        st.b_surface = b.str('surface', st.b_surface)
        style = b.str('style', st.b_style)
        st.b_style = style if style in ('plan', 'curb') else 'wall'
        if st.b_style == 'plan':
            st.bh = 0.0
        ba = seg.sub(f'{name} Barrier') or Section('')
        st.bar_surface = ba.str('surface', st.bar_surface)
        st.bar_h = ba.num('height', st.bar_h)
        style = ba.str('style', st.bar_style)
        if style in ('fence', 'fence1', 'fence2'):
            st.bar_style, st.bar_w = style, 0.0
        elif style == 'wall':
            st.bar_style, st.bar_w = 'wall', _side_width(ba, 'width', st.bar_w, f'segment {seg.name} > {name} Barrier')
        elif style == 'no barrier':
            st.bar_style, st.bar_w, st.bar_h = 'none', 0.0, 0.0


class Track:
    """What build_track makes: `subs` (the steps, in order), `length`, `width`, `offset` (the loader's smallest x,
    y and z, which it moves to 0), `seg_first` (each segment's first step), `pits` and `closure` (how far the lap's
    end lies from its start)"""


def lateral_xy(sub, f, d):
    """The point at a share `f` along a step and `d` metres left of its right edge (negative: right of it), in the
    loader's coordinates before they are moved"""
    if sub.type == 'str':
        c, s = math.cos(sub.alf_s), math.sin(sub.alf_s)
        x = sub.sr[0] + f * sub.length * c - d * s
        y = sub.sr[1] + f * sub.length * s + d * c
        return x, y
    ri = sub.radius - sub.width / 2.0
    if sub.type == 'lft':
        a = sub.cs + f * sub.arc
        r = max(0.25, ri + sub.width - d)
    else:
        a = sub.cs - f * sub.arc
        r = max(0.25, ri + d)
    return sub.cx + r * math.cos(a), sub.cy + r * math.sin(a)


def build_track(P):
    """The circuit's steps, its length, the loader's offset (xmin, ymin, zmin) and its pits"""
    main = P.sub('Main Track')
    if main is None or main.sub('Track Segments') is None:
        raise SystemExit('no Main Track > Track Segments in the XML: not a Speed Dreams trackdef')
    width = main.num('width', 15.0)
    if not 0.5 <= width <= MAX_WIDTH_M:
        raise SystemExit(f'Main Track > width: {width:g} m (a road is 0.5 to {MAX_WIDTH_M:g} m wide)')
    if not main.sub('Track Segments').kids:
        raise SystemExit('Main Track > Track Segments holds no segment')
    wi2 = width / 2.0
    global_step = main.num('profil steps length', 0.0)
    surface = main.str('surface', 'asphalt')
    states = _init_sides(main)

    lo = [0.0, 0.0, 0.0]

    def tst(i, v):
        if v < lo[i]:
            lo[i] = v

    xr = xl = 0.0
    yr = 0.0
    yl = width
    alf = 0.0
    zsl = zsr = zel = zer = 0.0
    etgtl = etgtr = 0.0
    grade = -100000.0
    radius = radiusend = arc = length = 0.0
    seg_type = None
    subs = []
    seg_first = {}
    tot = 0.0
    index = 0

    for name, seg in main.sub('Track Segments').kids.items():
        kind = seg.str('type')
        if kind is None:
            continue
        zsl, zsr = zel, zer
        tst(2, zsl)
        tst(2, zsr)
        surface = seg.str('surface', surface)
        if kind == 'str':
            length = seg.num('lg', 0.0)
            seg_type = 'str'
            radius = radiusend = 0.0
        elif kind in ('lft', 'rgt'):
            radius = seg.num('radius', 0.0)
            radiusend = seg.num('end radius', radius)
            arc = seg.num('arc', 0.0)
            seg_type = kind
            # a turn needs a radius at both ends and an angle: the loader divides by them
            if radius <= 0 or radiusend <= 0 or arc <= 0:
                raise SystemExit(f'segment {name}: a turn of radius {radius:g} m to {radiusend:g} m through '
                                 f'{math.degrees(arc):g}° (each must be more than 0)')
            length = (radius + radiusend) / 2.0 * arc
        else:
            raise SystemExit(f'segment {name}: unknown type "{kind}"')
        if length <= 0:
            raise SystemExit(f'segment {name}: no length')
        if tot + length > MAX_LAP_M:
            raise SystemExit(f'the lap runs past {MAX_LAP_M / 1000:g} km at segment {name}: not a circuit this can build')

        zsl = seg.num('z start left', zsl)
        zsr = seg.num('z start right', zsr)
        zel = seg.num('z end left', zel)
        zer = seg.num('z end right', zer)
        ze = seg.num('z end', -100000.0)
        zs = seg.num('z start', -100000.0)
        grade = seg.num('grade', grade)
        if zs != -100000.0:
            zsr = zsl = zs
        else:
            zs = (zsl + zsr) / 2.0
        if ze != -100000.0:
            zer = zel = ze
        elif grade != -100000.0:
            ze = zs + length * grade
        else:
            ze = (zel + zer) / 2.0
        bankings = seg.num('banking start', math.atan2(zsl - zsr, width))
        bankinge = seg.num('banking end', math.atan2(zel - zer, width))
        if max(abs(bankings), abs(bankinge)) > MAX_BANKING:
            raise SystemExit(f'segment {name}: banked {math.degrees(max(abs(bankings), abs(bankinge))):g}° '
                             f'(at most {math.degrees(MAX_BANKING):g}°)')
        dz = math.tan(bankings) * width / 2.0
        zsl, zsr = zs + dz, zs - dz
        dz = math.tan(bankinge) * width / 2.0
        zel, zer = ze + dz, ze - dz
        tst(2, zsl)
        tst(2, zsr)

        stgtl, stgtr = etgtl, etgtr
        if seg.str('profil', 'spline') == 'spline':
            steps = int(seg.num('profil steps', 1.0))
            if steps == 1:
                stepslg = seg.num('profil steps length', global_step)
                steps = int(length / stepslg) + 1 if stepslg else 1
            stgtl = seg.num('profil start tangent left', stgtl)
            etgtl = seg.num('profil end tangent left', etgtl)
            stgtr = seg.num('profil start tangent right', stgtr)
            etgtr = seg.num('profil end tangent right', etgtr)
            stgt = seg.num('profil start tangent', -100000.0)
            etgt = seg.num('profil end tangent', -100000.0)
            if stgt != -100000.0:
                stgtl = stgtr = stgt
            if etgt != -100000.0:
                etgtl = etgtr = etgt
        else:
            steps = 1
            stgtl = etgtl = (zel - zsl) / length
            stgtr = etgtr = (zer - zsr) / length
        steps = max(1, steps)
        if steps > MAX_SEGMENT_STEPS:
            raise SystemExit(f'segment {name}: {steps} profile steps (at most {MAX_SEGMENT_STEPS})')
        seg_first[name] = index

        t1l, t2l = stgtl * length, etgtl * length
        t1r, t2r = stgtr * length, etgtr * length
        tl = tr = 0.0
        dt = 1.0 / steps
        curzel, curzer = zsl, zsr
        cur_arc = arc / steps
        cur_len = length / steps
        dradius = (radiusend - radius) / steps
        if radiusend != radius and steps != 1:
            dradius = (radiusend - radius) / (steps - 1)
            tmp_angle, tmp_radius = 0.0, radius
            for _ in range(steps):
                tmp_angle += cur_len / tmp_radius
                tmp_radius += dradius
            cur_len *= arc / tmp_angle

        for step in range(steps):
            tl += dt
            tr += dt
            curzsl, curzel = curzel, track_spline(zsl, zel, t1l, t2l, tl)
            curzsr, curzer = curzer, track_spline(zsr, zer, t1r, t2r, tr)
            if dradius != 0:
                cur_arc = cur_len / radius
            sub = Sub()
            sub.name, sub.id, sub.type, sub.width, sub.surface, sub.lg = name, index, seg_type, width, surface, tot
            sub.length = cur_len
            sub.pit_role = None
            sub.alf_s = alf
            if seg_type == 'str':
                sub.arc = sub.radius = sub.cx = sub.cy = sub.cs = 0.0
                c, s = math.cos(alf), math.sin(alf)
                nxr, nyr = xr + cur_len * c, yr + cur_len * s
                nxl, nyl = xl + cur_len * c, yl + cur_len * s
                for v in (nxr, nxl):
                    tst(0, v)
                for v in (nyr, nyl):
                    tst(1, v)
            elif seg_type == 'lft':
                sub.radius, sub.arc = radius, cur_arc
                inner = radius - wi2
                sub.cx, sub.cy = xl - inner * math.sin(alf), yl + inner * math.cos(alf)
                sub.cs = alf - math.pi / 2.0
                alf += cur_arc
                nxl, nyl = sub.cx + inner * math.sin(alf), sub.cy - inner * math.cos(alf)
                nxr, nyr = sub.cx + (inner + width) * math.sin(alf), sub.cy - (inner + width) * math.cos(alf)
                for j in range(1, 37):
                    a = sub.cs + j * cur_arc / 36.0
                    for r in (inner, inner + width):
                        tst(0, sub.cx + r * math.cos(a))
                        tst(1, sub.cy + r * math.sin(a))
            else:
                sub.radius, sub.arc = radius, cur_arc
                inner = radius - wi2
                sub.cx, sub.cy = xr + inner * math.sin(alf), yr - inner * math.cos(alf)
                sub.cs = alf + math.pi / 2.0
                alf -= cur_arc
                nxl, nyl = sub.cx - (inner + width) * math.sin(alf), sub.cy + (inner + width) * math.cos(alf)
                nxr, nyr = sub.cx - inner * math.sin(alf), sub.cy + inner * math.cos(alf)
                for j in range(1, 37):
                    a = sub.cs - j * cur_arc / 36.0
                    for r in (inner + width, inner):
                        tst(0, sub.cx + r * math.cos(a))
                        tst(1, sub.cy + r * math.sin(a))
            sub.alf_e = alf
            sub.sr, sub.sl = (xr, yr, curzsr), (xl, yl, curzsl)
            sub.er, sub.el = (nxr, nyr, curzer), (nxl, nyl, curzel)
            sub.xs = math.atan2(curzsl - curzsr, width)
            sub.xe = math.atan2(curzel - curzer, width)

            # AddSides: the segment's own settings at its first step, each step its share of a side's widening
            if step == 0:
                _segment_sides(seg, states)
            sub.sides = []
            for side, st in enumerate(states):
                kew = (st.ew - st.sw) / steps
                sw, ew = st.sw + step * kew, st.sw + (step + 1) * kew
                sub.sides.append({
                    'bw': st.bw, 'bh': st.bh, 'b_style': st.b_style, 'b_surface': st.b_surface,
                    'sw': sw, 'ew': ew, 'side_surface': st.side_surface, 'bank': st.bank,
                    'bar_style': st.bar_style, 'bar_w': st.bar_w, 'bar_h': st.bar_h, 'bar_surface': st.bar_surface,
                })
                _tst_side(sub, side, sub.sides[-1], tst)

            subs.append(sub)
            tot += cur_len
            xr, yr, xl, yl = nxr, nyr, nxl, nyl
            index += 1
            if seg_type != 'str':
                radius += dradius

    if not subs:
        raise SystemExit('Main Track > Track Segments: no segment has a type (str, lft or rgt)')
    t = Track()
    t.subs, t.length, t.width = subs, tot, width
    t.offset = (lo[0], lo[1], lo[2])
    t.seg_first = seg_first
    t.pits = _pits(main, subs, t.length)
    t.closure = math.hypot(xr - subs[0].sr[0], yr - subs[0].sr[1])
    return t


def _tst_side(sub, side, sd, tst):
    """What AddSides adds to the loader's bounds for one side of a step: the outer end of its border, then of its side
    (on a curve, 36 points along the outer edge at the widest the side gets)"""
    tb_e = math.tan(sub.xe)
    sign = 1.0 if side == 1 else -1.0
    d0 = sub.width if side == 1 else 0.0
    z = sub.el[2] if side == 1 else sub.er[2]
    parts = []
    if sd['bw'] != 0.0:
        parts.append((sd['bw'], sd['bw']))
    if sd['sw'] != 0.0 or sd['ew'] != 0.0:
        parts.append((sd['ew'], max(sd['sw'], sd['ew'])))
    out = 0.0
    for w_end, w_max in parts:
        z += sign * sd['bank'] * w_end * tb_e
        if sub.type == 'str':
            x, y = lateral_xy(sub, 1.0, d0 + sign * (out + w_end))
            tst(0, x)
            tst(1, y)
        else:
            for j in range(1, 37):
                x, y = lateral_xy(sub, j / 36.0, d0 + sign * (out + w_max))
                tst(0, x)
                tst(1, y)
        tst(2, z)
        out += w_end


def _find_first(subs, name):
    """InitPits' search for the first step of the segment called `name`"""
    for s in subs:
        if s.name == name:
            return subs.index(s)
    return None


def _find_last(subs, name):
    for i in range(len(subs) - 1, -1, -1):
        if subs[i].name == name:
            return i
    return None


def _pits(main, subs, length):
    """The pit lane's steps (InitPits) and its boxes (AddPitDoors): None when the circuit has none"""
    pits = main.sub('Pits')
    if pits is None or pits.str('entry') is None:
        return None
    style = int(pits.num('pit style', 1))
    entry = _find_first(subs, pits.str('entry'))
    exit_ = _find_last(subs, pits.str('exit', ''))
    start = _find_first(subs, pits.str('start', ''))
    end = _find_last(subs, pits.str('end', ''))
    if None in (entry, exit_, start, end) or style == 0:
        return None
    b_start = _find_first(subs, pits.str('start buildings', '')) if pits.str('start buildings') else start
    b_end = _find_last(subs, pits.str('stop buildings', '')) if pits.str('stop buildings') else end
    b_start = start if b_start is None else b_start
    b_end = end if b_end is None else b_end
    pit_len = pits.num('length', 15.0)
    if pit_len <= 0 or pits.num('width', 5.0) <= 0:
        raise SystemExit(f'Pits: boxes {pit_len:g} m long and {pits.num("width", 5.0):g} m wide (each must be more than 0)')
    s0 = subs[b_start].lg
    s1 = subs[b_end].lg + subs[b_end].length
    span = s1 - s0 if s0 <= s1 else length - s0 + s1
    n_pits = int((span + pit_len / 2.0) / pit_len)
    n_pits = max(0, min(n_pits, int(pits.num('max pits', n_pits))))
    return {
        'side': 0 if pits.str('side', 'right') == 'right' else 1,
        'style': style,
        'entry': entry, 'exit': exit_, 'start': start, 'end': end,
        'len': pit_len, 'width': pits.num('width', 5.0),
        'speedLimit': pits.num('speed limit', 25.0),
        'boxes': n_pits,
    }


def _ring(i0, i1, n):
    """Step indices from i0 to i1 round the lap"""
    out = [i0]
    i = i0
    while i != i1:
        i = (i + 1) % n
        out.append(i)
    return out


# --------------------------------------------------------------------------------------------------------------------
# Surfaces: Speed Dreams' names → the builder's

KERB_KEYS = ('curb', 'kerb', 'rumble')
GRASS_KEYS = ('grass',)
GRAVEL_KEYS = ('sand', 'gravel', 'dirt', 'mud', 'snow', 'ice')
PAVED_KEYS = ('asphalt', 'concrete', 'road', 'tar', 'pit', 'tile', 'paved', 'cobble', 'brick', 'paving')


def surface_role(name, surfaces):
    """The builder's surface for a border's or a side's Speed Dreams surface: by its name (curb, grass, sand, gravel,
    asphalt…), then, for a circuit's own surfaces, by its grip: paved at 0.75 or more, gravel where the rolling
    resistance is a sand trap's. A transition strip (b-road1-grass6, tar-sand) is paved when it grips as the road"""
    n = (name or '').lower()
    sec = surfaces.sub(name) if surfaces is not None and name else None
    friction = sec.num('friction') if sec else None
    rr = sec.num('rolling resistance') if sec else None
    tex = (sec.str('texture name', '') if sec else '').lower()
    if any(k in n for k in KERB_KEYS):
        return 'Kerb'
    if 'pit' in n:
        return 'Runoff'
    mixed = n.startswith('b-') or 'tar-' in n
    grippy = friction is not None and friction >= 0.75
    if any(k in n for k in GRASS_KEYS) and not (mixed and grippy):
        return 'Grass'
    if any(k in n for k in GRAVEL_KEYS) and not (mixed and grippy):
        return 'Gravel'
    if any(k in n for k in PAVED_KEYS):
        return 'Runoff'
    if friction is not None:
        if friction >= 0.75:
            return 'Runoff'
        if rr is not None and rr >= 0.1:
            return 'Gravel'
        return 'Grass'
    if any(k in tex for k in KERB_KEYS):
        return 'Kerb'
    if any(k in tex for k in GRAVEL_KEYS):
        return 'Gravel'
    if any(k in tex for k in PAVED_KEYS):
        return 'Runoff'
    return 'Grass'


ROLE_COLOURS = {
    'Road': (0.32, 0.32, 0.33), 'Kerb': (0.75, 0.2, 0.18), 'Runoff': (0.45, 0.45, 0.46),
    'PitLane': (0.42, 0.42, 0.43), 'Gravel': (0.72, 0.64, 0.48), 'Grass': (0.3, 0.45, 0.2), 'Wall': (0.6, 0.6, 0.62),
}


# --------------------------------------------------------------------------------------------------------------------
# The generated surfaces

class MeshGroup:
    def __init__(self, role, surface):
        self.role, self.surface = role, surface
        self.pos, self.uv, self.idx = [], [], []
        self.n = 0

    def grid(self, P, UV, flip=False):
        """A rows × cols grid of points (and their UVs) as quads"""
        rows, cols = P.shape[:2]
        base = self.n
        self.pos.append(P.reshape(-1, 3))
        self.uv.append(UV.reshape(-1, 2))
        r, c = np.meshgrid(np.arange(rows - 1), np.arange(cols - 1), indexing='ij')
        a = base + r * cols + c
        b, cc, dd = a + 1, a + cols, a + cols + 1
        tris = np.stack([np.stack([a, cc, b], -1), np.stack([b, cc, dd], -1)], -2).reshape(-1, 3)
        if flip:
            tris = tris[:, ::-1]
        self.idx.append(tris)
        self.n += rows * cols

    def arrays(self):
        return (np.concatenate(self.pos).astype(np.float32), np.concatenate(self.uv).astype(np.float32),
                np.concatenate(self.idx).astype(np.uint32))


class Surfaces:
    """Every generated surface, grouped by role and Speed Dreams surface"""

    def __init__(self):
        self.groups = {}

    def group(self, role, surface):
        key = (role, surface)
        if key not in self.groups:
            self.groups[key] = MeshGroup(role, surface)
        return self.groups[key]


def tex_params(surfaces, name):
    """A surface's texture: its file name, its size in metres and whether it is laid continuously across"""
    sec = surfaces.sub(name) if surfaces is not None else None
    if sec is None:
        return None, 20.0, True
    return (sec.str('texture name') or None, max(0.1, sec.num('texture size', 20.0) or 20.0),
            sec.str('texture type', 'continuous') == 'continuous')


def z_at(sub, f, d):
    """The surface's height at a share `f` along a step and `d` metres left of its right edge, as RtTrackHeightL has
    it (curbs aside): the right edge's height along the step, the banking across the road, and beyond it the sides'
    banking type (level, or on at the road's slope)"""
    f = np.asarray(f, float)
    d = np.asarray(d, float)
    zr = sub.sr[2] + f * (sub.er[2] - sub.sr[2])
    tb = np.tan(sub.xs + f * (sub.xe - sub.xs))
    w = sub.width
    z = zr + np.clip(d, 0.0, w) * tb
    return z + sub.sides[1]['bank'] * np.clip(d - w, 0.0, None) * tb - sub.sides[0]['bank'] * np.clip(-d, 0.0, None) * tb


def xy_at(sub, f, d):
    """lateral_xy over arrays of the same shape"""
    f = np.broadcast_to(np.asarray(f, float), np.shape(d))
    d = np.asarray(d, float)
    if sub.type == 'str':
        c, s = math.cos(sub.alf_s), math.sin(sub.alf_s)
        return sub.sr[0] + f * sub.length * c - d * s, sub.sr[1] + f * sub.length * s + d * c
    ri = sub.radius - sub.width / 2.0
    if sub.type == 'lft':
        a = sub.cs + f * sub.arc
        r = np.maximum(0.25, ri + sub.width - d)
    else:
        a = sub.cs - f * sub.arc
        r = np.maximum(0.25, ri + d)
    return sub.cx + r * np.cos(a), sub.cy + r * np.sin(a)


def generate(track, surfaces):
    """The road, kerbs, run-off, grass, gravel, pit lane and walls along every step, in glTF's coordinates (Y up), and
    the centreline, start line and pit lane"""
    xo, yo, zo = track.offset
    out = Surfaces()
    centre = []
    pits = track.pits
    pit_steps = set(_ring(pits['entry'], pits['exit'], len(track.subs))) if pits else set()
    lane_steps = set(_ring(pits['start'], pits['end'], len(track.subs))) if pits else set()
    roles = {}

    def to_gltf(x, y, z):
        return np.stack([np.asarray(x) - xo, np.asarray(z) - zo, -(np.asarray(y) - yo)], -1)

    for k, sub in enumerate(track.subs):
        w = sub.width
        outer = w + max(s['bw'] + max(s['sw'], s['ew']) for s in sub.sides)
        # rows across the step: a straight is straight (10 m apart for its texture), an arc every 2 m of its outer edge
        n = max(1, int(math.ceil(sub.length / 10.0))) if sub.type == 'str' else \
            max(1, int(math.ceil(sub.arc * (sub.radius + outer) / 2.0)))
        f = np.linspace(0.0, 1.0, n + 1)[:, None]
        s_along = sub.lg + f * sub.length

        def band(d, role, surface, lift=None):
            """A strip of quads between rows along the step and columns at offsets d (rows × cols), `lift` metres up"""
            d = np.asarray(d, float)
            x, y = xy_at(sub, f, d)
            z = z_at(sub, f, d)
            lift = np.zeros_like(d) if lift is None else np.asarray(lift, float)
            P = to_gltf(x, y, z + lift)
            _tex, size, continuous = tex_params(surfaces, surface)
            # across: the distance from the strip's first column, or up a wall's face
            lat = np.abs(d - d[:, :1]) + np.abs(lift - lift[:, :1])
            width = max(1e-6, float(lat[0, -1]))
            v = lat / size if continuous else lat / width * (1.0 + math.floor(width / size))
            u = np.repeat(s_along, d.shape[1], 1) / size
            UV = np.stack([u, 1.0 - v], -1)
            # the strip faces up (a wall's material is two-sided)
            nrm = np.cross(P[1, 0] - P[0, 0], P[0, 1] - P[0, 0])
            out.group(role, surface).grid(P, UV, flip=nrm[1] < 0)
            roles.setdefault(surface, role)

        # the road, four strips across
        band(np.repeat(np.linspace(0.0, w, 5)[None, :], n + 1, 0), 'Road', sub.surface)
        cx, cy = xy_at(sub, f[:-1, 0], np.full(n, w / 2.0))
        centre.append(to_gltf(cx, cy, z_at(sub, f[:-1, 0], np.full(n, w / 2.0))))

        for side, sd in enumerate(sub.sides):
            sign = 1.0 if side == 1 else -1.0
            edge = w if side == 1 else 0.0
            on_pit_side = pits is not None and side == pits['side']
            off = 0.0
            if sd['bw'] > 0.0:
                d = np.repeat((edge + sign * np.array([0.0, sd['bw']]))[None, :], n + 1, 0)
                if sd['b_style'] == 'wall' and sd['bh'] >= 0.3:
                    _wall(band, d, sd['bh'], sd['b_surface'])
                elif sd['b_style'] in ('curb', 'wall') and sd['bh'] > 0.0:
                    # a raised kerb: up to its height at its outer edge (RtTrackHeightL), and its outer face down to
                    # the side beyond, drawn but not driven on
                    band(d, 'Kerb', sd['b_surface'], lift=np.repeat(np.array([[0.0, sd['bh']]]), n + 1, 0))
                    band(np.repeat(d[:, 1:], 2, 1), 'SceneryKerbFace', sd['b_surface'],
                         lift=np.repeat(np.array([[sd['bh'], 0.0]]), n + 1, 0))
                else:
                    role = surface_role(sd['b_surface'], surfaces)
                    band(d, 'PitLane' if role == 'Runoff' and on_pit_side and k in lane_steps else role, sd['b_surface'])
                off = sd['bw']
            sw = sd['sw'] + f[:, 0] * (sd['ew'] - sd['sw'])
            if sd['sw'] > 0.0 or sd['ew'] > 0.0:
                d = edge + sign * (off + sw[:, None] * np.linspace(0.0, 1.0, 3)[None, :])
                role = surface_role(sd['side_surface'], surfaces)
                band(d, 'PitLane' if role == 'Runoff' and on_pit_side and k in pit_steps else role, sd['side_surface'])
            if sd['bar_style'] != 'none' and sd['bar_h'] > 0.0:
                d_out = edge + sign * (off + sw)
                _wall(band, np.stack([d_out, d_out + sign * sd['bar_w']], 1), sd['bar_h'], sd['bar_surface'])

    centre = np.concatenate(centre, 0)
    first = track.subs[0]
    sx, sy = lateral_xy(first, 0.0, first.width / 2.0)
    start = to_gltf(sx, sy, z_at(first, 0.0, first.width / 2.0))
    fwd = np.array([math.cos(first.alf_s), 0.0, -math.sin(first.alf_s)])
    pit_line = _pit_line(track, to_gltf) if pits else None
    edges = _edge_samples(track, to_gltf)
    return out, centre, start, fwd, pit_line, roles, edges


def _wall(band, d, h, surface):
    """A barrier from offsets d (rows × 2: its inner and outer face) up `h` metres: a fence (both at one offset) is a
    single face, a wall its inner face, its top and its outer face"""
    rows = d.shape[0]
    up = np.repeat(np.array([[0.0, h]]), rows, 0)
    band(np.repeat(d[:, :1], 2, 1), 'Wall', surface, lift=up)
    if abs(d[0, 1] - d[0, 0]) > 1e-3:
        band(d, 'Wall', surface, lift=np.full(d.shape, h))
        band(np.repeat(d[:, 1:], 2, 1), 'Wall', surface, lift=up)


def _edge_samples(track, to_gltf, step=0.1):
    """The road's two edges every `step` metres, to measure how far the AC3D model's road lies from them"""
    pts = []
    for sub in track.subs:
        n = max(1, int(math.ceil(sub.length / step)))
        f = np.linspace(0.0, 1.0, n + 1)
        for d in (0.0, sub.width):
            dd = np.full_like(f, d)
            x, y = xy_at(sub, f, dd)
            pts.append(to_gltf(x, y, z_at(sub, f, dd)))
    return np.concatenate(pts, 0)


def _pit_line(track, to_gltf):
    """Down the middle of the pit lane, entry to exit: off the road's edge at the entry, out to the lane in front of
    the boxes by the pit start, back to the road's edge by the exit (the loader's pits stand at the outer edge of the
    pit side, `width` deep)"""
    p = track.pits
    subs = track.subs
    n = len(subs)
    steps = _ring(p['entry'], p['exit'], n)
    lane = set(_ring(p['start'], p['end'], n))
    side = p['side']
    pts = []
    # distances along the pit lane, for the run in and out
    s = 0.0
    marks = []
    for i in steps:
        marks.append(s)
        s += subs[i].length
    total = s
    s_in = next((m for i, m in zip(steps, marks) if i in lane), 0.0)
    last_lane = max((k for k, i in enumerate(steps) if i in lane), default=len(steps) - 1)
    s_out = marks[last_lane] + subs[steps[last_lane]].length
    for i, m in zip(steps, marks):
        sub = subs[i]
        sd = sub.sides[side]
        nst = max(1, int(math.ceil(sub.length / 4.0)))
        for j in range(nst):
            f = j / nst
            s_here = m + f * sub.length
            sw = sd['sw'] + f * (sd['ew'] - sd['sw'])
            lane_off = sd['bw'] + max(2.0, (sw - p['width']) / 2.0) if sw > 0 else sd['bw'] + 1.5
            if s_here < s_in:
                t = s_here / max(1e-6, s_in)
            elif s_here > s_out:
                t = (total - s_here) / max(1e-6, total - s_out)
            else:
                t = 1.0
            t = t * t * (3 - 2 * t)
            off = -1.5 + t * (lane_off + 1.5)
            d = sub.width + off if side == 1 else -off
            x, y = lateral_xy(sub, f, d)
            pts.append(to_gltf(x, y, float(z_at(sub, f, d))))
    return np.array(pts, float)


# --------------------------------------------------------------------------------------------------------------------
# The AC3D model (.ac, and Speed Dreams' .acc: normals with each vertex, up to four textures and their UVs per
# corner, triangle strips), as the game's loader reads it (src/modules/graphic/osggraph/Loader/ReaderWriterACC.cpp)

# trackgen's own objects: the road (tkMn), sides (tkRS, tkLS), borders (t<n>RB, t<n>LB) and barriers (B<n>Rt, B<n>Lt)
TRACKGEN_SURFACE_RE = re.compile(r'^(tkmn|tkrs|tkls|t\d+rb|t\d+lb|b\d+rt|b\d+lt)\d*$', re.I)


class AcPoly:
    """A poly object's triangles: its base texture and UVs, and an .acc's second ("tiled") layer and its UVs"""
    __slots__ = ('name', 'texture', 'texture2', 'mat', 'pos', 'nrm', 'uv', 'uv2', 'idx', 'double')


def _ac_tokens(line):
    return re.findall(r'"[^"]*"|\S+', line)


def _floats(tok, n, what):
    """`n` finite numbers from tokens"""
    if len(tok) < n:
        raise ValueError(f'{what} needs {n} numbers')
    v = [float(t) for t in tok[:n]]
    if not all(math.isfinite(x) for x in v):
        raise ValueError(f'{what} is not finite')
    return v


def read_ac(path, log=print):
    """Every poly object of an AC3D model with its world-space triangles (Y up, as glTF), base texture, material and
    whether it is two-sided. A model cut short, with a vertex index or material outside its lists, or with numbers that
    aren't finite is refused"""
    lines = _decode(open(path, 'rb').read()).splitlines()
    if not lines or not lines[0].startswith('AC3D'):
        raise SystemExit(f'{path}: not an AC3D model')
    try:
        return _read_ac(path, lines)
    except (ValueError, IndexError, RecursionError) as e:
        raise SystemExit(f'{path}: not a well-formed AC3D model ({e})')


def _read_ac(path, lines):
    materials = []
    polys = []
    i = 1

    def rows(i, n, what):
        """The `n` lines from `i`, which the file must have"""
        if n < 0 or i + n > len(lines):
            raise ValueError(f'{what}: {n} lines from line {i + 1}, past the end of the file')
        return lines[i:i + n]

    def read_object(i, parent):
        name, kind = '', 'poly'
        texture = texture2 = None
        texrep, texoff = (1.0, 1.0), (0.0, 0.0)
        local = np.eye(4)
        verts = None
        vnorm = None
        world = parent
        while i < len(lines):
            line = lines[i].strip()
            i += 1
            if not line:
                continue
            tok = _ac_tokens(line)
            key = tok[0]
            if key == 'OBJECT':
                kind = tok[1] if len(tok) > 1 else 'poly'
            elif key == 'name':
                name = tok[1].strip('"') if len(tok) > 1 else ''
            elif key == 'texture':
                tname = tok[1].strip('"') if len(tok) > 1 else ''
                layer = tok[2] if len(tok) > 2 else 'base'
                if tname != 'empty_texture_no_mapping':
                    if texture is None and layer == 'base':
                        texture = re.split(r'[\\/]', tname)[-1]
                    elif texture2 is None and layer == 'tiled':
                        texture2 = re.split(r'[\\/]', tname)[-1]
            elif key == 'texrep':
                texrep = tuple(_floats(tok[1:], 2, f'line {i}: texrep'))
            elif key == 'texoff':
                texoff = tuple(_floats(tok[1:], 2, f'line {i}: texoff'))
            elif key == 'rot':
                local[:3, :3] = np.array(_floats(tok[1:], 9, f'line {i}: rot')).reshape(3, 3)
            elif key == 'loc':
                local[:3, 3] = _floats(tok[1:], 3, f'line {i}: loc')
            elif key == 'data':
                n = int(tok[1])
                # the data runs over the next line(s): skip as many characters
                got = 0
                while got < n and i < len(lines):
                    got += len(lines[i]) + 1
                    i += 1
            elif key == 'numvert':
                world = parent @ local
                nv = int(tok[1])
                raw = [r.split() for r in rows(i, nv, f'object {name}: numvert')]
                i += nv
                arr = np.array([_floats(r, 3, f'object {name}: a vertex') for r in raw], float) if nv else np.zeros((0, 3))
                verts = arr @ world[:3, :3].T + world[:3, 3] if nv else arr
                if nv and all(len(r) >= 6 for r in raw):
                    nn = np.array([_floats(r[3:], 3, f'object {name}: a normal') for r in raw], float) @ world[:3, :3].T
                    ln = np.linalg.norm(nn, axis=1, keepdims=True)
                    vnorm = np.where(ln > 1e-9, nn / np.maximum(ln, 1e-9), np.array([0.0, 1.0, 0.0]))
            elif key == 'numsurf':
                ns = int(tok[1])
                by_mat = {}
                for _ in range(ns):
                    if i >= len(lines):
                        raise ValueError(f'object {name}: {ns} surfaces, the file ends first')
                    flags = mat = 0
                    refs = []
                    while i < len(lines):
                        t2 = _ac_tokens(lines[i].strip())
                        i += 1
                        if not t2:
                            continue
                        if t2[0] == 'SURF':
                            flags = int(t2[1], 0)
                        elif t2[0] == 'mat':
                            mat = int(t2[1])
                            if mat < 0:
                                raise ValueError(f'object {name}: material {mat}')
                        elif t2[0] == 'refs':
                            nr = int(t2[1])
                            for line in rows(i, nr, f'object {name}: refs'):
                                r = line.split()
                                if not r:
                                    raise ValueError(f'object {name}: an empty ref')
                                f = _floats(r[1:5], len(r[1:5]), f'object {name}: a ref') + [0.0] * max(0, 4 - len(r[1:5]))
                                refs.append((int(r[0]), f[0], f[1], f[2], f[3]))
                            i += nr
                            break
                    kind_s = flags & 0xF
                    if kind_s in (1, 2) or len(refs) < 3:
                        continue
                    if kind_s == 4:
                        tris = [(refs[k], refs[k + 1], refs[k + 2]) if k % 2 == 0 else (refs[k + 1], refs[k], refs[k + 2])
                                for k in range(len(refs) - 2)]
                    else:
                        tris = [(refs[0], refs[k], refs[k + 1]) for k in range(1, len(refs) - 1)]
                    by_mat.setdefault((mat, bool(flags & 0x20)), []).extend(tris)
                if verts is not None and kind == 'poly' and by_mat:
                    for (mat, double), tris in by_mat.items():
                        corners = {}
                        pos, nrm, uv, uv2, idx = [], [], [], [], []
                        for tri in tris:
                            for corner in tri:
                                vi, u, v, u2, v2 = corner
                                if not 0 <= vi < len(verts):
                                    raise ValueError(f'object {name} refers to vertex {vi} of {len(verts)}')
                                if corner not in corners:
                                    corners[corner] = len(pos)
                                    pos.append(verts[vi])
                                    nrm.append(vnorm[vi] if vnorm is not None else None)
                                    uv.append((texoff[0] + u * texrep[0], texoff[1] + v * texrep[1]))
                                    uv2.append((u2, v2))
                                idx.append(corners[corner])
                        p = AcPoly()
                        p.name, p.texture, p.texture2, p.mat, p.double = name, texture, texture2, mat, double
                        p.pos = np.array(pos, float)
                        p.nrm = None if vnorm is None else np.array(nrm, float)
                        p.uv = np.array(uv, float)
                        p.uv2 = np.array(uv2, float)
                        p.idx = np.array(idx, np.int64).reshape(-1, 3)
                        polys.append(p)
            elif key == 'kids':
                nk = int(tok[1])
                world = parent @ local
                for _ in range(nk):
                    while i < len(lines) and not lines[i].startswith('OBJECT'):
                        i += 1
                    if i >= len(lines):
                        break
                    i = read_object(i, world)
                return i
        return i

    while i < len(lines):
        line = lines[i].strip()
        if line.startswith('MATERIAL'):
            tok = _ac_tokens(line)
            rgb = (1.0, 1.0, 1.0)
            trans = 0.0
            for k, t in enumerate(tok):
                if t == 'rgb':
                    rgb = tuple(_floats(tok[k + 1:], 3, f'line {i + 1}: a material\'s rgb'))
                elif t == 'trans':
                    trans = _floats(tok[k + 1:], 1, f'line {i + 1}: a material\'s trans')[0]
            materials.append({'rgb': rgb, 'trans': trans})
            i += 1
        elif line.startswith('OBJECT'):
            i = read_object(i, np.eye(4))
        else:
            i += 1
    return polys, materials


# --------------------------------------------------------------------------------------------------------------------
# Textures

class Textures:
    """A circuit's textures by file name: found in its folder, then in the base data, any of the formats Speed Dreams
    reads (SGI .rgb, PNG, JPEG…) when the named one isn't there, and kept as PNG"""

    def __init__(self, dirs, max_px=2048, log=print):
        self.dirs = [d for d in dirs if d and os.path.isdir(d)]
        self.max_px = max_px
        self.cache = {}
        self.sizes = {}
        self.missing = set()
        self.log = log
        self.listing = {d: {f.lower(): f for f in os.listdir(d)} for d in self.dirs}

    def find(self, name):
        stem, ext = os.path.splitext(name.lower())
        tries = [name.lower()] + [stem + e for e in ('.png', '.rgb', '.jpg', '.jpeg', '.sgi', '.bmp', '.tga') if e != ext]
        for d in self.dirs:
            for t in tries:
                real = self.listing[d].get(t)
                if real:
                    return os.path.join(d, real)
        return None

    def get(self, name):
        """(png bytes, has alpha) or None"""
        if not name:
            return None
        if name in self.cache:
            return self.cache[name]
        path = self.find(name)
        res = None
        if path:
            try:
                im = Image.open(path)
                im.load()
                alpha = im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info)
                im = im.convert('RGBA' if alpha else 'RGB')
                if alpha and np.asarray(im)[..., 3].min() >= 250:
                    im, alpha = im.convert('RGB'), False
                self.sizes[name] = (max(im.size), float(np.asarray(im.convert('L'), np.float32).mean() / 255.0))
                k = max(im.size) / self.max_px
                if k > 1:
                    im = im.resize((max(1, round(im.size[0] / k)), max(1, round(im.size[1] / k))), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, 'PNG', optimize=False, compress_level=6)
                res = (buf.getvalue(), alpha)
            except Exception as e:  # an unreadable texture is drawn flat
                self.log(f'  texture {name}: {e}')
        if res is None:
            self.missing.add(name)
        self.cache[name] = res
        return res

    def is_grain(self, name):
        """A small, near-white texture that only adds grain: Speed Dreams draws a layer over it (an .acc's tiled
        layer) or the surface's colour under it, which hold the colour"""
        if not self.get(name):
            return False
        px, lum = self.sizes[name]
        return px <= 256 and lum >= 0.8


# --------------------------------------------------------------------------------------------------------------------
# The GLB

class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.views, self.accessors, self.images, self.textures = [], [], [], []
        self.materials, self.meshes, self.nodes, self.roots = [], [], [], []
        self.tex_index = {}

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin.extend(data)
        self.views.append(v)
        return len(self.views) - 1

    def _acc(self, arr, comp, typ, target=None, minmax=False):
        arr = np.ascontiguousarray(arr)
        a = {'bufferView': self._view(arr.tobytes(), target), 'componentType': comp, 'count': int(len(arr)), 'type': typ}
        if minmax and len(arr):
            a['min'] = [float(v) for v in arr.min(0)]
            a['max'] = [float(v) for v in arr.max(0)]
        self.accessors.append(a)
        return len(self.accessors) - 1

    def texture(self, key, png):
        if key not in self.tex_index:
            self.images.append({'bufferView': self._view(png), 'mimeType': 'image/png', 'name': key})
            self.textures.append({'sampler': 0, 'source': len(self.images) - 1})
            self.tex_index[key] = len(self.textures) - 1
        return self.tex_index[key]

    def material(self, mat):
        self.materials.append(mat)
        return len(self.materials) - 1

    def mesh(self, name, pos, nrm, uv, idx, mat):
        attrs = {'POSITION': self._acc(pos.astype(np.float32), 5126, 'VEC3', 34962, True),
                 'NORMAL': self._acc(nrm.astype(np.float32), 5126, 'VEC3', 34962)}
        if uv is not None:
            attrs['TEXCOORD_0'] = self._acc(uv.astype(np.float32), 5126, 'VEC2', 34962)
        prim = {'attributes': attrs, 'indices': self._acc(idx.reshape(-1).astype(np.uint32), 5125, 'SCALAR', 34963),
                'material': mat, 'mode': 4}
        self.meshes.append({'name': name, 'primitives': [prim]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1})
        self.roots.append(len(self.nodes) - 1)

    def line(self, name, pts, closed):
        pts = np.asarray(pts, np.float32)
        n = len(pts)
        e = [[k, k + 1] for k in range(n - 1)] + ([[n - 1, 0]] if closed else [])
        prim = {'attributes': {'POSITION': self._acc(pts, 5126, 'VEC3', 34962, True)},
                'indices': self._acc(np.array(e, np.uint32).reshape(-1), 5125, 'SCALAR', 34963), 'mode': 1}
        self.meshes.append({'name': name, 'primitives': [prim]})
        self.nodes.append({'name': name, 'mesh': len(self.meshes) - 1})
        self.roots.append(len(self.nodes) - 1)

    def empty(self, name, matrix):
        self.nodes.append({'name': name, 'matrix': [float(v) for v in matrix]})
        self.roots.append(len(self.nodes) - 1)

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        j = {
            'asset': {'version': '2.0', 'generator': 'LibreCorsa extract_sd_track.py'},
            'scene': 0, 'scenes': [{'nodes': self.roots}], 'nodes': self.nodes, 'meshes': self.meshes,
            'materials': self.materials, 'accessors': self.accessors, 'bufferViews': self.views,
            'buffers': [{'byteLength': len(self.bin)}],
        }
        if self.textures:
            j.update({'textures': self.textures, 'images': self.images,
                      'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]})
        js = json.dumps(j, separators=(',', ':')).encode('utf-8')
        while len(js) % 4:
            js += b' '
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(struct.pack('<4sII', b'glTF', 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)
        return total


def vertex_normals(pos, idx):
    fn = np.cross(pos[idx[:, 1]] - pos[idx[:, 0]], pos[idx[:, 2]] - pos[idx[:, 0]])
    vn = np.zeros_like(pos)
    for k in range(3):
        np.add.at(vn, idx[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True)
    return np.where(ln > 1e-12, vn / np.maximum(ln, 1e-12), np.array([0.0, 1.0, 0.0]))


def srgb_to_linear(c):
    return tuple((v / 12.92) if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


# --------------------------------------------------------------------------------------------------------------------

def model_file(folder, model):
    """The AC3D model the trackdef names (Graphic > 3d description), in the circuit's folder by its file name alone (as
    Speed Dreams looks for it), any case; None when the folder hasn't got it"""
    if not model:
        return None
    name = os.path.basename(model.replace('\\', '/'))
    if name in ('', '.', '..'):
        return None
    hits = [name] + [f for f in sorted(os.listdir(folder)) if f.lower() == name.lower() and f != name]
    return next((os.path.join(folder, f) for f in hits if os.path.isfile(os.path.join(folder, f)) and
                 _inside(os.path.join(folder, f), folder)), None)


def find_xml(folder):
    """The circuit's trackdef: <folder name>.xml, else the one XML in the folder with a Main Track"""
    name = os.path.basename(os.path.normpath(folder))
    own = os.path.join(folder, name + '.xml')
    if os.path.isfile(own):
        return own
    hits = []
    for f in sorted(os.listdir(folder)):
        if f.lower().endswith('.xml') and not f.lower().endswith('.prj.xml'):
            text = _decode(open(os.path.join(folder, f), 'rb').read(200000))
            if 'Main Track' in text and 'Track Segments' in text:
                hits.append(f)
    if len(hits) != 1:
        raise SystemExit(f'{folder}: no trackdef XML (<name>.xml with a Main Track)' if not hits
                         else f'{folder}: several trackdef XMLs ({", ".join(hits)})')
    return os.path.join(folder, hits[0])


# ICAO prefixes of the weather stations circuits name (Local Info > station), for the country they are set in
ICAO_COUNTRIES = {
    'EB': 'Belgium', 'ED': 'Germany', 'EF': 'Finland', 'EG': 'United Kingdom', 'EH': 'Netherlands', 'EI': 'Ireland',
    'EK': 'Denmark', 'EN': 'Norway', 'EP': 'Poland', 'ES': 'Sweden', 'ET': 'Germany', 'LA': 'Albania', 'LB': 'Bulgaria',
    'LD': 'Croatia', 'LE': 'Spain', 'LF': 'France', 'LG': 'Greece', 'LH': 'Hungary', 'LI': 'Italy', 'LJ': 'Slovenia',
    'LK': 'Czechia', 'LO': 'Austria', 'LP': 'Portugal', 'LR': 'Romania', 'LS': 'Switzerland', 'LT': 'Turkey',
    'LZ': 'Slovakia', 'SB': 'Brazil', 'SA': 'Argentina', 'RJ': 'Japan', 'YM': 'Australia', 'YS': 'Australia',
    'YB': 'Australia', 'CY': 'Canada', 'MM': 'Mexico', 'FA': 'South Africa', 'ZB': 'China', 'RK': 'South Korea',
}


COUNTRY_WORDS = {**{c.lower(): c for c in set(ICAO_COUNTRIES.values()) | {'United States'}},
                 'czech republic': 'Czechia', 'usa': 'United States', 'england': 'United Kingdom',
                 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'great britain': 'United Kingdom'}


def settings_for(P, track, folder):
    """The builder's settings from the trackdef's header and local info. A trackdef names no country or city: the
    country is the weather station's (Local Info > station), else one the description names; either way, and the
    city always, "Speed Dreams" stands in (the importer's --country and --city set them)"""
    head = P.sub('Header') or Section('')
    local = P.sub('Local Info') or Section('')
    station = (local.str('station') or '').upper()
    category = (head.str('category') or '').lower()
    widths = [s.width for s in track.subs]
    desc = (head.str('description') or '').strip()
    name = (head.str('name') or os.path.basename(os.path.normpath(folder))).strip()
    country = ICAO_COUNTRIES.get(station[:2], 'United States' if len(station) == 4 and station[0] == 'K' else '') or \
        next((c for w, c in COUNTRY_WORDS.items() if re.search(rf'\b{re.escape(w)}\b', desc.lower())), '')
    cfg = {
        'name': name,
        'layout': {'speedway': 'Oval', 'dirt': 'Dirt circuit', 'karting': 'Karting circuit'}.get(category, 'Circuit'),
        'country': country or 'Speed Dreams',
        'city': 'Speed Dreams',
        'baseAltitudeM': round(local.num('altitude', 0.0), 1),
        'pitboxes': track.pits['boxes'] if track.pits else 20,
        'description': (desc + ('.' if desc and not desc.endswith('.') else '') + ' A Speed Dreams circuit.').strip(),
        # A circuit modelled to the centimetre, not scanned: its crests and dips are the designer's, so the builder
        # smooths them as little as a modelled circuit needs
        'crestMinRadiusM': 40,
        'profileSmoothSamples': 0.6,
        'minWidthM': round(min(8.5, min(widths) - 0.2), 2),
        'maxWidthM': round(max(22.0, max(widths) + 0.2), 2),
    }
    if category == 'speedway':
        cfg['type'] = 'oval'
    # The licence is the importer's to find (scripts/mods/importers/sd-track.ts): on its own the extractor claims none
    cfg['credit'] = {'title': name, 'author': (head.str('author') or '').strip() or 'Unknown', 'license': ''}
    return cfg


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().split('\n')[0])
    ap.add_argument('folder', help="the circuit's folder (its trackdef XML and AC3D model)")
    ap.add_argument('--out-glb', required=True)
    ap.add_argument('--out-settings', required=True)
    ap.add_argument('--sd-data', help="Speed Dreams' base data (data/tracks/surfaces.xml, data/textures/)")
    ap.add_argument('--geometry-json', help='also write what was built (scripts/verify/verify-sd-track.ts reads it)')
    ap.add_argument('--no-scenery', action='store_true', help='leave the AC3D model out (only the generated surfaces)')
    ap.add_argument('--needs-json', help="only list the textures the circuit's folder lacks (to fetch from the base "
                                         'data), as {"textures": [...]}, and write nothing else')
    args = ap.parse_args()

    folder = os.path.abspath(args.folder)
    sd_data = os.path.abspath(args.sd_data) if args.sd_data else None
    xml = find_xml(folder)
    print(f'Reading {xml}')
    P = read_params(xml, sd_data)
    surfaces = P.sub('Surfaces')
    track = build_track(P)
    if track.closure > 1.0:
        print(f'  the lap ends {track.closure:.2f} m from where it starts (Speed Dreams closes it the same way)')
    print(f'  {len(P.sub("Main Track/Track Segments").kids)} segments, {len(track.subs)} steps, {track.length:.1f} m, '
          f'width {track.width:.1f} m, pits {"none" if not track.pits else ("right" if track.pits["side"] == 0 else "left")}')

    gen, centre, start, fwd, pit_line, roles, edges = generate(track, surfaces)
    if args.needs_json:
        own = Textures([folder])
        names = {tex_params(surfaces, s)[0] for (_r, s) in gen.groups}
        model_path = model_file(folder, (P.sub('Graphic') or Section('')).str('3d description'))
        if model_path and not args.no_scenery:
            names |= {t for p in read_ac(model_path)[0] if not TRACKGEN_SURFACE_RE.match(p.name)
                      for t in (p.texture, p.texture2)}
        needs = sorted(n for n in names if n and not own.find(n))
        with open(args.needs_json, 'w', encoding='utf-8') as f:
            json.dump({'textures': needs}, f)
        print(f'  {len(needs)} textures to take from the base data')
        return
    zs = centre[:, 1]
    print(f'  elevation {zs.min():.1f}..{zs.max():.1f} m')

    tex_root = None
    if sd_data:
        for cand in (os.path.join(sd_data, 'data', 'textures'), os.path.join(sd_data, 'textures'),
                     os.path.join(sd_data, 'data', 'data', 'textures')):
            if os.path.isdir(cand):
                tex_root = cand
                break
    # in an install the circuit sits in data/tracks/<category>/<name>/ and the shared textures in data/textures/
    install_tex = os.path.normpath(os.path.join(folder, '..', '..', '..', 'data', 'textures'))
    textures = Textures([folder, tex_root, install_tex])

    glb = Glb()
    mat_cache = {}

    def material_for(name, texname, rgb=(1, 1, 1), double=False, alpha_ok=True, trans=0.0, tint=None):
        key = (name, texname, rgb, double, trans, tint)
        if key in mat_cache:
            return mat_cache[key]
        t = textures.get(texname) if texname else None
        pbr = {'metallicFactor': 0.0, 'roughnessFactor': 0.85}
        mat = {'name': name, 'pbrMetallicRoughness': pbr}
        if t:
            pbr['baseColorTexture'] = {'index': glb.texture(texname, t[0])}
            lin = srgb_to_linear(tint) if tint else (1.0, 1.0, 1.0)
            pbr['baseColorFactor'] = [lin[0], lin[1], lin[2], 1.0]
            if t[1] and alpha_ok:
                mat['alphaMode'] = 'MASK'
                mat['alphaCutoff'] = 0.5
                double = True
        else:
            lin = srgb_to_linear(rgb)
            pbr['baseColorFactor'] = [lin[0], lin[1], lin[2], 1.0 - trans]
            if trans > 0.05:
                mat['alphaMode'] = 'BLEND'
        if double:
            mat['doubleSided'] = True
        mat_cache[key] = glb.material(mat)
        return mat_cache[key]

    # 1. the generated surfaces, named as the builder reads them (Road_001_<surface>…); a kerb's outer face is drawn
    # but never driven on, so it is scenery
    counts = {}
    role_tris = {}
    for (role, surface), g in sorted(gen.groups.items()):
        pos, uv, idx = g.arrays()
        tex, _size, _c = tex_params(surfaces, surface)
        sec = surfaces.sub(surface) if surfaces is not None else None
        kind = 'Kerb' if role == 'SceneryKerbFace' else role
        rgb = ROLE_COLOURS[kind]
        own = (sec.num('color R1'), sec.num('color G1', 0.5), sec.num('color B1', 0.5)) \
            if sec is not None and 'color R1' in sec.nums else None
        if own and not textures.get(tex):
            rgb = own
        # a grain texture takes the surface's colour (Speed Dreams' own lies in a layer the track model draws over it)
        tint = (own or rgb) if tex and textures.is_grain(tex) else None
        m = material_for(f'sd_{kind.lower()}_{surface}', tex, rgb=rgb, double=(kind == 'Wall' or kind != role),
                         alpha_ok=False, tint=tint)
        counts[role] = counts.get(role, 0) + 1
        role_tris[role] = role_tris.get(role, 0) + len(idx)
        stem = re.sub(r'[^A-Za-z0-9_]+', '_', surface).strip('_')[:40] or 'surface'
        name = f'Scenery_kerbface_{counts[role]:03d}_{stem}' if kind != role else f'{role}_{counts[role]:03d}_{stem}'
        glb.mesh(name, pos, vertex_normals(pos.astype(float), idx.astype(np.int64)), uv, idx, m)
    print('  surfaces: ' + ', '.join(f'{r} {role_tris[r]} tris'
                                     for r in ('Road', 'Kerb', 'Runoff', 'PitLane', 'Gravel', 'Grass', 'Wall')
                                     if r in role_tris))

    # 2. the scenery
    geometry = {}
    graphic = P.sub('Graphic') or Section('')
    model = graphic.str('3d description')
    model_path = model_file(folder, model)
    if args.no_scenery:
        print('  scenery: left out (--no-scenery)')
    elif not model_path:
        print(f'  scenery: none ({model or "the XML names no 3d description"} is not in the folder)')
    else:
        polys, acmats = read_ac(model_path)
        dropped = [p for p in polys if TRACKGEN_SURFACE_RE.match(p.name)]
        kept = [p for p in polys if not TRACKGEN_SURFACE_RE.match(p.name)]
        # how far the model's road lies from the generated one (both in the loader's coordinates)
        # trackgen's road vertices lie on its edges: how far they are from the generated edges says whether the
        # model and the generated road line up
        road_ac = np.concatenate([p.pos for p in dropped if p.name.lower().startswith('tkmn')] or [np.zeros((0, 3))])
        if len(road_ac):
            dist, _ = cKDTree(edges).query(road_ac)
            geometry['acRoadOffsetM'] = {'median': float(np.median(dist)), 'p95': float(np.percentile(dist, 95))}
            print(f'  the model\'s road lies {np.median(dist):.3f} m from the generated road\'s edges (95%: '
                  f'{np.percentile(dist, 95):.3f} m) over {len(road_ac)} vertices')
        groups = {}
        layered = 0
        for p in kept:
            mat = acmats[p.mat] if p.mat < len(acmats) else {'rgb': (0.8, 0.8, 0.8), 'trans': 0.0}
            # terrain in an .acc: a grain texture under a baked colour-and-shadow map (its tiled layer), which is the
            # one drawn here, on its own UVs
            if p.texture2 and textures.get(p.texture2) and p.texture and textures.is_grain(p.texture):
                p.texture, p.uv = p.texture2, p.uv2
                layered += 1
            key = (p.texture if p.texture and textures.get(p.texture) else None,
                   None if p.texture and textures.get(p.texture) else tuple(round(c, 3) for c in mat['rgb']),
                   p.double, round(mat['trans'], 2))
            groups.setdefault(key, []).append(p)
        if layered:
            print(f'  {layered} objects drawn with their tiled layer over a grain texture')
        tris = 0
        for k, ((tex, rgb, double, trans), ps) in enumerate(sorted(groups.items(), key=lambda kv: str(kv[0]))):
            pos = np.concatenate([p.pos for p in ps])
            uv = np.concatenate([p.uv for p in ps])
            uv = np.stack([uv[:, 0], 1.0 - uv[:, 1]], -1)
            offs = np.cumsum([0] + [len(p.pos) for p in ps[:-1]])
            idx = np.concatenate([p.idx + o for p, o in zip(ps, offs)])
            nrm_parts = []
            for p in ps:
                nrm_parts.append(p.nrm if p.nrm is not None and np.isfinite(p.nrm).all() and p.nrm.ndim == 2
                                 else vertex_normals(p.pos, p.idx))
            nrm = np.concatenate(nrm_parts)
            stem = re.sub(r'[^A-Za-z0-9_]+', '_', os.path.splitext(tex)[0] if tex else 'flat').strip('_')[:40]
            m = material_for(f'sd_scenery_{stem}', tex, rgb=rgb or (1, 1, 1), double=double, trans=trans)
            glb.mesh(f'Scenery_{k:03d}_{stem}', pos, nrm, uv if tex else None, idx, m)
            tris += len(idx)
        print(f'  scenery: {len(kept)} objects, {tris} tris in {len(groups)} meshes; left out {len(dropped)} '
              f'trackgen road, side, border and barrier objects')
        geometry['scenery'] = {'objects': len(kept), 'triangles': int(tris), 'dropped': len(dropped)}
    if textures.missing:
        print(f'  textures not found (drawn flat): {", ".join(sorted(textures.missing)[:12])}'
              f'{" …" if len(textures.missing) > 12 else ""}')

    # 3. the builder's helpers
    glb.line('Track_Centreline', centre, True)
    if pit_line is not None and len(pit_line) >= 4:
        glb.line('Track_PitLane', pit_line, False)
    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(fwd, up)
    glb.empty('Track_Start', [*right, 0.0, *fwd, 0.0, *up, 0.0, *start, 1.0])
    size = glb.write(args.out_glb)
    print(f'  wrote {args.out_glb} ({size / 1e6:.1f} MB)')

    cfg = settings_for(P, track, folder)
    with open(args.out_settings, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(f'  wrote {args.out_settings}')

    if args.geometry_json:
        geometry.update({
            'lengthM': track.length,
            'steps': len(track.subs),
            'closureM': track.closure,
            'offset': list(track.offset),
            'centreline': [[round(float(v), 4) for v in p] for p in centre],
            'start': [float(v) for v in start],
            'forward': [float(v) for v in fwd],
            'roles': roles,
            'roleTriangles': role_tris,
            'pits': track.pits,
            'pitLane': None if pit_line is None else [[round(float(v), 3) for v in p] for p in pit_line],
            'settings': cfg,
            'texturesMissing': sorted(textures.missing),
        })
        with open(args.geometry_json, 'w', encoding='utf-8') as f:
            json.dump(geometry, f)


if __name__ == '__main__':
    sys.exit(main())
