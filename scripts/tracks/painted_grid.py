"""
The start grid on a circuit's own painted grid boxes. The converter's grid stands two abreast about the centreline,
which is the middle of everything paved; where the paint is somewhere else (a road with a wide shoulder on one side,
a grid further back from the line) the cars would stand beside their boxes or on the edge line.

build_blender_track.py calls `slots` when the circuit's settings have `gridBoxes`: the corner points of each painted
box in the model's coordinates (any order; the pole's box is the one furthest round the lap). The result replaces
the track data's `spawnGrid`, in the same form.

A car stands with its front wheels just behind its box's front line, in the middle of the box.
"""
import math

import numpy as np
from scipy.spatial import cKDTree

# From a box's front line back to the car's own origin (mid wheelbase): the front wheels stop just short of the line
CAR_BEHIND_FRONT_LINE_M = 2.0
# The grid the game fills at most
MAX_SLOTS = 20
# As the converter seats a car on the road: this far above the surface (m)
RIDE_M = 0.11


def slots(data, boxes, log=print):
    """`spawnGrid` entries for the painted boxes, pole first; None when there are fewer than two usable boxes"""
    samples = data['samples']
    lap = float(data['metadata']['lengthMeters'])
    offset = np.array(data['metadata'].get('modelOffset', [0, 0, 0]), dtype=np.float64)
    P = np.array([smp['p'] for smp in samples], dtype=np.float64)
    T = np.array([smp['t'] for smp in samples], dtype=np.float64)
    S = np.array([smp['s'] for smp in samples], dtype=np.float64)
    bank = np.array([smp.get('b', 0.0) for smp in samples], dtype=np.float64)
    width = np.array([smp.get('w', 12.0) for smp in samples], dtype=np.float64)
    t2 = T[:, [0, 2]] / np.maximum(np.linalg.norm(T[:, [0, 2]], axis=1, keepdims=True), 1e-9)
    right = np.stack([-t2[:, 1], t2[:, 0]], axis=1)
    tree = cKDTree(P[:, [0, 2]])
    n = len(samples)

    found = []
    for box in boxes:
        pts = np.asarray(box, dtype=np.float64).reshape(-1, 3) + offset
        if len(pts) < 3:
            continue
        dist, idx = tree.query(pts[:, [0, 2]])
        if float(dist.min()) > 0.75 * float(width[idx[int(np.argmin(dist))]]):
            continue    # not on the road
        dp = pts[:, [0, 2]] - P[idx][:, [0, 2]]
        s = S[idx] + np.einsum('ij,ij->i', dp, t2[idx])
        lat = np.einsum('ij,ij->i', dp, right[idx])
        # one stretch of road even across the start line
        s = np.where(s - s[0] > lap / 2, s - lap, np.where(s[0] - s > lap / 2, s + lap, s))
        found.append((float(s.max()), 0.5 * float(lat.min() + lat.max())))
    # Pole first: the boxes run back from the start line, so the lap distance behind the line orders them
    found.sort(key=lambda b: (lap - b[0]) % lap)
    # One slot per box: a model can carry the same paint twice (a copy per level of detail)
    boxes_once = []
    for front, lat in found:
        if not any(abs(front - f) < 2.0 and abs(lat - l) < 1.5 for f, l in boxes_once[-4:]):
            boxes_once.append((front, lat))
    found = boxes_once
    if len(found) < 2:
        log(f'  painted grid: {len(found)} box(es) on the road, the grid stays as built')
        return None
    out = []
    for slot, (front, lat_raw) in enumerate(found[:MAX_SLOTS], start=1):
        ss = (front - CAR_BEHIND_FRONT_LINE_M) % lap
        i0 = int(np.searchsorted(S, ss, side='right') - 1) % n
        i1 = (i0 + 1) % n
        span = (S[i1] - S[i0]) % lap or lap / n
        a = ((ss - S[i0]) % lap) / span
        w_slot = float(width[i0] * (1 - a) + width[i1] * a)
        lat_limit = max(1.0, w_slot * 0.5 - 1.5)
        lat = round(float(np.clip(lat_raw, -lat_limit, lat_limit)), 2)
        c = P[i0] * (1 - a) + P[i1] * a
        rg = right[i0] * (1 - a) + right[i1] * a
        rg /= np.linalg.norm(rg)
        fw = T[i0] * (1 - a) + T[i1] * a
        fw /= np.linalg.norm(fw)
        bk = bank[i0] * (1 - a) + bank[i1] * a
        pos = c + np.array([rg[0] * lat, -math.sin(bk) * lat + RIDE_M, rg[1] * lat])
        out.append({
            'slot': slot,
            's': round(float(ss), 2),
            'lateral': lat,
            'position': [round(float(v), 3) for v in pos],
            'yawRad': round(math.atan2(fw[0], fw[2]), 4),
            'forward': [round(float(v), 5) for v in fw],
        })
    log(f'  painted grid: {len(out)} slots on {len(found)} painted boxes, pole {lap - out[0]["s"]:.1f} m before the line '
        f'at {out[0]["lateral"]:+.2f} m, second at {out[1]["lateral"]:+.2f} m')
    return out
