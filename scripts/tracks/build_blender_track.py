"""
A circuit modelled in Blender → LibreCorsa track (public/tracks/<id>/track_data.json + <id>.glb), without Assetto Corsa.

    python -P scripts/tracks/build_blender_track.py <id> --glb path/to/circuit.glb [--settings circuit.json]
        [--no-glb] [--no-line-opt] [--no-compress]

The GLB is Blender's glTF export (File > Export > glTF 2.0, format .glb) with Data > Mesh > Loose Edges on and Draco
and Meshopt compression off. It needs:

- surface meshes named by what they are: Road, Kerb, Runoff, Gravel, Grass, Wall or PitLane, alone or followed by
  '.', '_', '-', a space or a digit (Road.001, Kerb_T1, Wall 3). Their triangles are what the cars drive on and hit.
  Every mesh is drawn as it is modelled; meshes with other names are scenery.
- Track_Centreline: a mesh of loose edges round the middle of the road, closed (a curve converted to a mesh)
- Track_Start: an empty on the start line whose arrow (Single Arrow display: its local Z in Blender) points the way
  the cars go
- optionally Track_PitLane: loose edges down the middle of the pit lane, from its entry to its exit

The circuit's settings (name, layout, country, city, baseAltitudeM, pitboxes, description, credit, and any setting
port_ac_track.py reads, such as minWidthM or wallCapM) are a JSON file, by default the GLB's name with .json.
Two more are for a circuit raced at night: "defaultTimeOfDay" ("night": sessions start at night until the player picks
a time) and "nightLighting" (floodlight masts and tunnel light, see night_lighting.py). "gridBoxes" (the corner points
of each painted grid box, in the model's coordinates) stands the start grid on the paint (painted_grid.py).
Closed circuits only. scripts/tracks/example_circuit.py builds a small circuit this way; see docs/PORTING-TRACKS.md.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from scipy import ndimage  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402

import build_track as bt  # noqa: E402
import centreline as cl  # noqa: E402
import glbio  # noqa: E402
import glbwrite  # noqa: E402
import night_lighting  # noqa: E402
import painted_grid  # noqa: E402
import port_ac_track as pat  # noqa: E402
import surface as srf  # noqa: E402

ROOT = pat.ROOT
log = pat.log
SURFACE_RE = re.compile(r'^(road|kerb|runoff|gravel|grass|wall|pitlane)(?=$|[._\- 0-9])', re.I)
SURFACES = {'road': 'road', 'kerb': 'kerb', 'runoff': 'runoff', 'gravel': 'gravel', 'grass': 'grass', 'wall': 'wall',
            'pitlane': 'pit'}
HELPERS = ('Track_Centreline', 'Track_Start', 'Track_PitLane')
# No mod folder: the data/ parsers find nothing here and fall back to their defaults
NO_DIR = os.path.join(os.devnull, 'none')
DEFAULTS = {'layout': 'Circuit', 'country': '', 'city': '', 'baseAltitudeM': 0, 'pitboxes': 20, 'description': ''}


def find_node(j, name):
    """The node called `name`, or Blender's renamed copy of it (`name.001`)"""
    hits = [i for i, n in enumerate(j['nodes']) if n.get('name') == name]
    hits = hits or [i for i, n in enumerate(j['nodes']) if n.get('name', '').startswith(name + '.')]
    if len(hits) > 1:
        raise SystemExit(f'more than one {name} in the model')
    return hits[0] if hits else None


def line_chain(j, b, W, ni):
    """A node's loose edges (LINES primitives) in world space, walked into one chain: (points (N, 3), closed)"""
    node = j['nodes'][ni]
    if 'mesh' not in node:
        raise SystemExit(f"{node.get('name')} has no mesh: convert the curve to a mesh (Object > Convert > Mesh)")
    verts, edges = [], []
    nv = 0
    for pr in j['meshes'][node['mesh']]['primitives']:
        if pr.get('mode', 4) != 1:
            continue
        v = glbio.acc(j, b, pr['attributes']['POSITION']).astype(float)
        e = glbio.acc(j, b, pr['indices']).reshape(-1, 2) if 'indices' in pr else np.arange(len(v)).reshape(-1, 2)
        verts.append(v)
        edges.append(e.astype(np.int64) + nv)
        nv += len(v)
    if not edges:
        raise SystemExit(f"{node.get('name')} has no loose edges: export with Data > Mesh > Loose Edges on")
    M = W[ni]
    V = np.concatenate(verts) @ M[:3, :3].T + M[:3, 3]
    E = np.concatenate(edges)
    # vertices within 1 mm are one
    _, first, inv = np.unique(np.round(V / 0.001).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    V = V[first]
    E = inv[E]
    E = E[E[:, 0] != E[:, 1]]
    E = np.unique(np.sort(E, axis=1), axis=0)
    adj = [[] for _ in range(len(V))]
    for a, c in E:
        adj[a].append(c)
        adj[c].append(a)
    deg = np.array([len(a) for a in adj])
    if (deg > 2).any():
        raise SystemExit(f"{node.get('name')} branches at {int((deg > 2).sum())} vertices: it must be one line")
    ends = np.nonzero(deg == 1)[0]
    closed = len(ends) == 0
    cur = 0 if closed else int(ends[0])
    order, prev = [cur], -1
    while True:
        nxt = [k for k in adj[cur] if k != prev]
        if not nxt or (closed and nxt[0] == order[0]):
            break
        prev, cur = cur, nxt[0]
        order.append(cur)
    if len(order) != len(V) - int((deg == 0).sum()):
        raise SystemExit(f"{node.get('name')} is in several pieces: it must be one line")
    return V[order], closed


def read_model(path):
    """The model's surfaces, centreline, start line and pit lane (see the module docstring)"""
    j, b = glbio.load(path)
    if j.get('extensionsRequired'):
        raise SystemExit(f"{path} needs {', '.join(j['extensionsRequired'])}: export it without compression")
    W = glbio.world_mats(j)
    phys = {k: [] for k in ('road', 'kerb', 'runoff', 'gravel', 'grass', 'wall', 'pit')}
    road_mats, road_mats_no_uv = set(), set()
    counts = {}
    for p in glbio.prims(j, b):
        m = SURFACE_RE.match(p.name)
        if not m:
            continue
        cat = SURFACES[m.group(1).lower()]
        phys[cat].append(p.v[p.f])
        counts[cat] = counts.get(cat, 0) + len(p.f)
        if cat == 'road' and p.mat >= 0:
            (road_mats if p.uv is not None else road_mats_no_uv).add(j['materials'][p.mat].get('name', ''))
    log('  surfaces:', ', '.join(f'{k} {v} tris' for k, v in counts.items()) or 'none')
    if not phys['road']:
        raise SystemExit('no Road meshes: name the road surface Road (or Road.001, Road_pit ...)')
    # The game draws the road materials with its asphalt shader, which needs the road's UVs
    if road_mats_no_uv - road_mats:
        log(f"  road materials without UVs, drawn as modelled: {', '.join(sorted(road_mats_no_uv - road_mats))}")

    ci, si = find_node(j, 'Track_Centreline'), find_node(j, 'Track_Start')
    if ci is None or si is None:
        raise SystemExit('the model needs a Track_Centreline (loose edges round the road) and a Track_Start empty')
    P, closed = line_chain(j, b, W, ci)
    if not closed:
        raise SystemExit('Track_Centreline is open: join its two ends (closed circuits only)')
    start = W[si][:3, 3]
    fwd = (W[si][:3, :3] @ np.array([0.0, 1.0, 0.0]))[[0, 2]]
    if np.linalg.norm(fwd) < 0.3:
        raise SystemExit("Track_Start's arrow points up or down: lay it flat, pointing the way the cars go")
    fwd /= np.linalg.norm(fwd)

    pit = None
    pi = find_node(j, 'Track_PitLane')
    if pi is not None:
        pit, pit_closed = line_chain(j, b, W, pi)
        if pit_closed:
            raise SystemExit('Track_PitLane is a loop: it runs from the pit entry to the exit')
    return j, b, phys, P, start, fwd, pit, road_mats


def model_sources(cfg, path):
    """The `src` for port_ac_track.build_from_sources from a Blender model"""
    j, b, phys, P, start, fwd, pit, road_mats = read_model(path)
    T_road = np.concatenate(phys['road'], 0)
    T_wall = np.concatenate(phys['wall'], 0) if phys['wall'] else np.zeros((0, 3, 3))

    # The centreline every metre, its heights from the road under it (the curve itself may float above it)
    xz0, _ = cl.resample_closed(P[:, [0, 2]], 1.0)
    _, near = cKDTree(P[:, [0, 2]]).query(xz0)
    y_line = P[near, 1]
    road_soup = srf.TriSoup(T_road, np.zeros(len(T_road), np.int32), np.zeros((len(T_road), 3), np.float32))
    y0 = np.array([
        min((h[0] for h in road_soup.hits(x, z)), key=lambda y: abs(y - yl), default=yl)
        for (x, z), yl in zip(xz0, y_line)
    ])
    log(f'  centreline: {len(xz0)} m, road under it at {y0.min():.1f}..{y0.max():.1f} m')

    # The road's width along it, from the road mesh (no AI lane carries one here)
    if cfg.get('fixedWidthM'):
        w0 = np.full(len(xz0), float(cfg['fixedWidthM']))
    else:
        R, trace, road = cl.build_masks(T_road, np.zeros(len(T_road), np.int32), [0], [])
        if len(T_wall):
            bt.cut_masks(R, trace, road, {}, 1.0, T_wall)
        ed = cl.edge_distances(R, road, xz0, cl.rights(cl.tangents(xz0)))
        w0 = ed.sum(1)
        w0[(ed >= 19.0).any(1) | (ed <= 0.5).any(1)] = np.nan
        if np.isnan(w0).all():
            raise SystemExit('Track_Centreline does not run over the Road meshes')
        w0 = ndimage.median_filter(bt.periodic_interp_nan(w0), 9, mode='wrap')

    # The start line: where the arrow stands, projected onto the centreline
    k = int(np.argmin(np.linalg.norm(xz0 - start[[0, 2]], axis=1)))
    start_pt = xz0[k].copy()
    ahead_pt = start_pt + fwd * 10.0

    pit_points = None
    if pit is not None:
        # entry first: the pit lane runs the way the cars go (the resampled centreline may run either way round)
        n0 = len(xz0)
        way = 1.0 if np.dot(xz0[(k + 3) % n0] - xz0[k - 3], fwd) > 0 else -1.0
        _, ki = cKDTree(xz0).query(pit[len(pit) // 2, [0, 2]])
        tan = way * (xz0[(ki + 3) % n0] - xz0[ki - 3])
        if np.dot(pit[-1, [0, 2]] - pit[0, [0, 2]], tan) < 0:
            pit = pit[::-1]
        pit_points = pit

    def write_glb(off, extra, out):
        jj = json.loads(json.dumps(j))
        for n in jj['nodes']:
            if n.get('name', '').split('.')[0] in HELPERS:
                n.pop('mesh', None)
        # Loose edges and points (exported with the centreline) are not drawn
        for m in jj.get('meshes', []):
            m['primitives'] = [pr for pr in m['primitives'] if pr.get('mode', 4) == 4]
        for n in jj['nodes']:
            if 'mesh' in n and not jj['meshes'][n['mesh']]['primitives']:
                n.pop('mesh')
        glbwrite.write_track_glb(jj, b, 1.0, off, extra, out, clip=cfg.get('clip', 4000.0), log=log)

    return {
        'kind': 'glb',
        'phys_tris': phys,
        'road_mat_names': road_mats,
        'xz0': xz0,
        'w_ai': w0,
        'y_ai': y0,
        'start_pt': start_pt,
        'ahead_pt': ahead_pt,
        'base': None,
        'layout_path': NO_DIR,
        'data_dir': NO_DIR,
        'pit_points': pit_points,
        'write_glb': write_glb,
    }


def load_settings(tid, path):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        cfg.update(json.load(open(path, encoding='utf-8')))
    else:
        log(f'  no settings file at {path}: using defaults')
    cfg.setdefault('name', tid.replace('_', ' ').title())
    if not cfg.get('credit'):
        log('  no credit in the settings: add {"credit": {"title", "author", "url", "license", "licenseUrl"}}')
    credit = {'title': cfg['name'], 'author': 'Unknown', 'url': None, 'short': None, 'license': 'Own work',
              'licenseUrl': None}
    credit.update(cfg.get('credit') or {})
    cfg['credit'] = credit
    if cfg.get('pointToPoint'):
        raise SystemExit('pointToPoint: a model in Blender can only be a closed circuit for now')
    return cfg


def update_index(tid, cfg, data):
    """Add or replace the circuit in public/tracks/index.json (the title menu's list)"""
    path = os.path.join(ROOT, 'public', 'tracks', 'index.json')
    idx = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else []
    entry = pat.index_entry(tid, cfg, data)
    if cfg.get('defaultTimeOfDay'):
        # before `unlisted`, which stays last
        unlisted = entry.pop('unlisted', None)
        entry['defaultTimeOfDay'] = cfg['defaultTimeOfDay']
        if unlisted:
            entry['unlisted'] = True
    at = next((i for i, e in enumerate(idx) if e['id'] == tid), None)
    if at is None:
        idx.append(entry)
    else:
        idx[at] = entry
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, indent=2, ensure_ascii=False)
        f.write('\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().split('\n')[0])
    ap.add_argument('id', help='the circuit id: lower case letters, digits and _')
    ap.add_argument('--glb', required=True, help="the model, Blender's glTF export (.glb)")
    ap.add_argument('--settings', help='settings JSON (default: the GLB path with .json)')
    ap.add_argument('--no-glb', action='store_true')
    ap.add_argument('--no-line-opt', action='store_true')
    ap.add_argument('--no-compress', action='store_true')
    args = ap.parse_args()
    if not re.fullmatch(r'[a-z0-9_]+', args.id):
        raise SystemExit('the id is lower case letters, digits and _ (it names the folder and the URL)')
    if args.id in pat.AC_TRACKS or args.id.startswith('rwanda_official'):
        raise SystemExit(f'{args.id} is taken by a circuit the game already has')

    settings = args.settings or os.path.splitext(args.glb)[0] + '.json'
    cfg = load_settings(args.id, settings)
    log(f"\n=== Building {args.id} ({cfg['name']}) from {args.glb} ===")
    src = model_sources(cfg, args.glb)
    data = pat.build_from_sources(args.id, cfg, args, src)
    update_index(args.id, cfg, data)
    if not args.no_glb and not args.no_line_opt:
        log(f'  optimising F1 and GT3 racing lines for {args.id}...')
        bt.optimise_lines(args.id, cfg.get('lineMarginM'))
    if cfg.get('gridBoxes') or cfg.get('nightLighting') is not None:
        finish_track_data(args.id, cfg, args.glb)


def finish_track_data(tid, cfg, glb_path):
    """What the written track data takes from the circuit's settings after the racing lines (which rewrite the file):
    the start grid on the painted grid boxes, and the floodlight masts and tunnels of a night circuit"""
    path = os.path.join(ROOT, 'public', 'tracks', tid, 'track_data.json')
    with open(path, encoding='utf-8') as f:
        text = f.read()
    data = json.loads(text)
    if cfg.get('gridBoxes'):
        grid = painted_grid.slots(data, cfg['gridBoxes'], log)
        if grid:
            data['spawnGrid'] = grid
    if cfg.get('nightLighting') is not None:
        j, b = glbio.load(glb_path)
        data['metadata']['nightLighting'] = night_lighting.place(data, cfg['nightLighting'], glbio.prims(j, b), log)
    with open(path, 'w', encoding='utf-8') as f:
        # as the file was written: compact when it has no line breaks
        json.dump(data, f, ensure_ascii=False, **({'indent': 2} if text.count('\n') > 10 else {'separators': (',', ':')}))


if __name__ == '__main__':
    main()
