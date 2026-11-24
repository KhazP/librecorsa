"""
Site plan of the official Rwanda layout around the track: the lake's shore, the lagoon inside Turn 11, the marsh, the
level ground buildings stand on and the roads. Coordinates are metres in the design frame (X east, Y north), read off
the published aerial render after rectifying it through its fitted camera. Pure data, shared by prep_terrain.py
(heights, colours, trees) and the Blender build (roads, buildings).
"""
import numpy as np

import ro_design as rd

# ---- water ------------------------------------------------------------------------------------------------------------
LAGOON_Z = 5.5            # the lagoon inside Turn 11 is held above the lake by the causeway
LAGOON = [(-188, -203), (-148, -188), (-99, -181), (-39, -187), (12, -210), (46, -241), (81, -271), (88, -288), (42, -291), (4, -299), (-4, -317), (-58, -291), (-119, -257), (-167, -227)]
# Stone causeway and shore revetment: the west shore, the lagoon's dam, then the shore below the esses
# (x, y, height of its top above the lake)
CAUSEWAY = [(22, -486, 2.0), (13, -415, 2.4), (8, -349, 4.2), (2, -327, 6.6), (17, -305, 6.6), (52, -297, 6.6), (89, -294, 6.6), (162, -291, 5.0), (233, -296, 3.4)]
CAUSEWAY_W = 7.0
# Open water the satellite's lake outline misses: the pool between the causeway and the marsh
LAKE_ADD = [[(30, -315), (234, -306), (291, -324), (386, -344), (496, -365), (581, -386), (575, -445), (294, -445), (229, -407), (110, -388), (61, -449), (25, -405)]]
# Papyrus marsh: flat ground just above the water, inside the lake's outline
MARSH = [[(110, -391), (229, -409), (290, -448), (279, -509), (275, -585), (254, -715), (111, -722), (61, -612), (63, -463)], [(298, -447), (337, -438), (376, -463), (378, -512), (355, -547), (313, -545), (282, -500)]]
MARSH_Z = 0.35

# ---- level ground -----------------------------------------------------------------------------------------------------
# name: (centre x, centre y, half length, half width, yaw in degrees, height or None for the ground's own mean,
#        metres over which the pad eases into the terrain)
PADS = {
    'village': (361.0, -167.0, 52.0, 22.0, -12.0, None, 12.0),
    'gate': (781.0, 109.0, 30.0, 22.0, 42.0, None, 12.0),
    'carpark_n': (400.0, 223.0, 120.0, 22.0, -7.0, None, 14.0),
    'courts': (881.0, -252.0, 62.0, 16.0, 16.0, None, 10.0),
    'plaza_n': (585.0, 85.0, 48.0, 20.0, -12.0, None, 12.0),
    'kart': (-849.0, 52.0, 95.0, 58.0, 41.0, None, 18.0),
    'yard_w': (209.0, -105.0, 34.0, 16.0, -1.0, None, 10.0),
    'yard_e': (468.0, -129.0, 30.0, 16.0, -14.0, None, 10.0),
}

# ---- lakeside terraces: centre on the shore, radius of the top platform ------------------------------------------------
TERRACES = [(568.0, -370.0, 15.0), (734.0, -329.0, 16.0), (936.0, -296.0, 15.0)]

# ---- roads draped on the terrain: name, width, kind, points -------------------------------------------------------------
ROADS = [
    ('outer_north', 7.0, 'asphalt', [(73, 287), (149, 253), (278, 217), (400, 181), (531, 144), (649, 125), (755, 103), (823, 86)]),
    ('outer_east', 7.0, 'asphalt', [(823, 86), (841, 71), (857, 55), (870, 36), (880, 15), (888, -7), (894, -29), (897, -52), (903, -74), (905, -98), (902, -122), (894, -144), (885, -165), (875, -186), (861, -204), (846, -222)]),
    ('lake_road', 5.0, 'asphalt', [(846, -222), (824, -229), (802, -235), (781, -242), (759, -249), (738, -256), (716, -264), (695, -272), (674, -281), (654, -292), (635, -304), (615, -315), (595, -324), (573, -331), (551, -335), (528, -338), (505, -338), (483, -338), (460, -338), (438, -341), (416, -346), (392, -348), (369, -347), (345, -342), (323, -335), (302, -325), (283, -313), (262, -305), (241, -296)]),
    ('path_t1', 3.0, 'path', [(608, -322), (586, -352), (572, -366)]),
    ('path_t2', 3.0, 'path', [(759, -248), (747, -292), (738, -324)]),
    ('path_t3', 3.0, 'path', [(846, -222), (893, -242), (931, -277), (937, -293)]),
    ('infield_ring', 5.0, 'asphalt', [(-157, -57), (-135, -59), (-112, -61), (-90, -64), (-68, -67), (-46, -71), (-24, -76), (-3, -82), (18, -91), (38, -100), (59, -110), (78, -122), (96, -135), (115, -146), (136, -153), (158, -156), (181, -154), (202, -151), (226, -151), (249, -155), (272, -164), (292, -177), (311, -190), (327, -205), (335, -229), (355, -238), (378, -236), (397, -226), (412, -209), (429, -195), (448, -183), (467, -171), (487, -160), (507, -151), (527, -142), (548, -134), (570, -129), (592, -125), (614, -122), (637, -121), (659, -124)]),
    ('infield_west', 5.0, 'asphalt', [(136, -158), (139, -136), (143, -114), (150, -93), (161, -73), (176, -58), (196, -47), (218, -42), (236, -55), (257, -60)]),
    ('infield_east', 5.0, 'asphalt', [(519, -145), (507, -116), (493, -111)]),
    ('kart_access', 6.0, 'asphalt', [(-780, 151), (-746, 226), (-689, 311), (-597, 388), (-544, 434)]),
]
ALLEYS = ('infield_ring', 'infield_west', 'infield_east')      # roads with a row of trees down each side

# The road bridge over the track on the way out of Turn 17
BRIDGE_S = 5571
BRIDGE_CLEAR_M = 5.8          # under the deck, above the track's uphill edge
BRIDGE_DECK_M = 1.1           # deck thickness
BRIDGE_WIDTH_M = 11.0
BRIDGE_SETBACK_M = 10.0       # the abutments stand this far behind the corridor's edges
# The slim road bridge over the track at the Turn 1 end of the pit complex: its two ends (x, y), as the render shows it
T1_BRIDGE = ((110.0, 11.0), (61.0, 159.0))
TERRACE = (5653, 345)         # the grandstand terrace on the right of the main straight, from / to station


def bridge(T):
    """Where the bridge's deck is: its station, centre, the track's right and forward vectors there, the lateral
    offsets of its two ends (left, right; metres from the centreline) and the height of its top"""
    s = int(BRIDGE_S)
    hw = T.width[s] / 2
    c_l = hw + T.band_edges(0)[s, rd.EDGE] + BRIDGE_SETBACK_M
    c_r = hw + T.band_edges(1)[s, rd.EDGE] + BRIDGE_SETBACK_M
    top = float(T.z[(s + int(BRIDGE_WIDTH_M / 2)) % T.n]) + BRIDGE_CLEAR_M + BRIDGE_DECK_M
    return dict(s=s, p=np.array([T.x[s], T.y[s]]), r=np.array([T.rx[s], T.ry[s]]), t=np.array([T.tx[s], T.ty[s]]),
                c_l=float(c_l), c_r=float(c_r), top=top)


def chaikin(P, n=2):
    """Corner cutting of an open polyline (its ends stay)"""
    P = np.asarray(P, float)
    for _ in range(n):
        Q = [P[0]]
        for a, b in zip(P[:-1], P[1:]):
            Q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        Q.append(P[-1])
        P = np.array(Q)
    return P


def beds(T):
    """
    Graded strips the terrain is shaped to: the two roads off the bridge and the concourse behind the grandstands.
    Each: name, points (k, 3) with heights, half width, the distance it eases into the terrain over, and the road
    drawn on it (width, kind) or None.
    """
    b = bridge(T)
    out = []
    a_r = b['p'] + b['r'] * b['c_r']
    north = np.array([[*(a_r + b['r'] * d), b['top']] for d in (-2.0, 20.0, 44.0)])
    out.append(('bridge_north', north, 7.0, 14.0, (7.0, 'asphalt')))
    # south of the bridge the road turns to run beside the track up to the paddock
    a_l = b['p'] - b['r'] * b['c_l']
    pts = [a_l + b['r'] * 2.0, a_l - b['r'] * 12.0]
    s_end = 5734
    for s in range(b['s'] + 26, s_end + 1, 14):
        lat = T.width[s] / 2 + T.band_edges(0)[s, rd.EDGE] + 13.0
        pts.append([T.x[s] - T.rx[s] * lat, T.y[s] - T.ry[s] * lat])
    P = chaikin(pts, 2)
    seg = np.r_[0, np.cumsum(np.hypot(*np.diff(P, axis=0).T))]
    z_end = float(T.edge_z[0][s_end])
    z = b['top'] + (z_end - b['top']) * np.clip((seg - 16.0) / (seg[-1] - 16.0), 0, 1)
    out.append(('bridge_south', np.c_[P, z], 6.5, 15.0, (7.0, 'asphalt')))
    # the concourse behind the grandstand terrace, level with it
    n = T.n
    ss = [(TERRACE[0] + d) % n for d in range(0, (TERRACE[1] - TERRACE[0]) % n + 1, 20)]
    pts = []
    for s in ss:
        lat = T.width[s] / 2 + T.band_edges(1)[s, rd.EDGE] + 12.0
        pts.append([T.x[s] + T.rx[s] * lat, T.y[s] + T.ry[s] * lat, T.edge_z[1][s]])
    out.append(('concourse', np.array(pts), 12.0, 18.0, None))
    return out

# The rectified render (src/render_ortho.png, not shipped): its top-left corner in the design frame and pixels per metre
ORTHO = (-1150.0, 850.0, 1.0)

# TV cameras, one per twelfth of the lap: (station, side 0 left / 1 right, height above the ground). They stand just
# behind the service road (the first one on the pit building's roof); every other one has a scaffold tower.
CAMERAS = ((114, 0, 14.5), (770, 0, 9.0), (1228, 0, 9.0), (1761, 1, 9.0), (2285, 1, 10.0), (2775, 1, 9.0),
           (3194, 0, 9.0), (3781, 1, 9.0), (4108, 1, 9.0), (4668, 0, 10.0), (5152, 0, 10.0), (5482, 1, 10.0))
CAMERA_ROOF_BACK_M = 8.0      # the first camera: this far behind the pit building's front


_FOOT = []


def camera_lat(T, s, side):
    """Metres from the centreline of a trackside camera at station s (always positive): just behind the service road,
    or behind an add-on road where one passes there"""
    e = T.band_edges(side)[s]
    lat = float(T.width[s] / 2 + e[rd.BACK0] + 1.6)
    if not _FOOT:
        from ro_foot import Foot
        _FOOT.append(Foot())
    sg = rd.SIDE_SIGN[side]
    ring = np.array([(0, 0), (3, 0), (-3, 0), (0, 3), (0, -3)], float)
    while lat < 150 and _FOOT[0].at(np.array([T.x[s] + sg * T.rx[s] * lat, T.y[s] + sg * T.ry[s] * lat]) + ring)[0].any():
        lat += 1.0
    return lat


# Big screens: (station, side they stand on, facing the stand across the track)
SCREENS = ((919, 1), (1750, 0), (2921, 0), (3958, 0), (5169, 0))
# Stands on the ground outside the corners: (station, side, length, roofed)
OPEN_STANDS = ((890, 0, 80, False), (1407, 1, 50, False), (1721, 1, 80, True), (2867, 1, 90, False), (3946, 1, 70, False),
               (5154, 1, 130, False))

# Support buildings as the aerial shows them: (x, y, length, width, height, yaw in degrees, roof: white / solar / dark)
INFIELD = ((87, -51, 46, 20, 8.0, -11, 'white'), (-76, -18, 30, 14, 6.0, 7, 'white'), (53, -96, 22, 10, 4.5, 23, 'white'), (328, -149, 30, 16, 6.0, -12, 'solar'), (360, -175, 26, 14, 5.5, -12, 'white'), (420, -114, 36, 9, 4.5, -16, 'white'), (275, -144, 24, 10, 4.5, -9, 'solar'), (-521, -365, 40, 12, 6.0, 110, 'dark'), (-596, 306, 44, 18, 7.0, 51, 'white'))
# Rows of marquees in the fan zones: (x, y, yaw in degrees, how many, metres apart)
MARQUEES = ((-509, 470, 20, 6, 13), (-525, 440, 35, 5, 13), (99, 319, 82, 5, 13), (119, 417, 85, 4, 13), (601, 201, -14, 5, 13), (2, -9, -10, 4, 13), (348, -133, -10, 3, 13), (394, -158, -9, 3, 13), (-729, -540, 80, 9, 14), (-623, -551, 92, 9, 14), (-569, -555, 88, 8, 14), (-821, -367, 78, 4, 14), (-728, -311, 91, 3, 12), (-465, -368, 116, 3, 12))
# Thatched huts in three clusters along the inside of the lakeside esses: (x, y, radius)
HUTS = ((-127, -37, 3.6), (-98, -42, 4.4), (-73, -28, 3.4), (-50, -38, 4.0), (-27, -46, 3.2), (121, -120, 3.4), (140, -136, 4.4), (159, -119, 3.8), (191, -140, 4.2), (219, -144, 3.6), (343, -208, 4.2), (369, -213, 3.6), (392, -201, 4.4), (401, -178, 3.4), (432, -166, 3.8), (458, -151, 3.2))
# Transporters parked side by side on the two yards: (x, y, yaw of the row in degrees, how many, metres apart)
TRUCKS = ((183, -105, 5, 10, 5.0), (452, -118, -13, 9, 5.0))
# The kart circuit beside the back straight, in the frame of its pad (along the pad, to its right; metres)
KART_LOOP = ((-85, 40), (-40, 46), (10, 44), (36, 30), (30, 8), (5, 14), (-15, 28), (-35, 18), (-28, -2), (0, -8), (30, -14),
             (34, -26), (10, -30), (-30, -24), (-60, -28), (-84, -18), (-70, 0), (-52, 6), (-58, 22), (-86, 20))
KART_WIDTH_M = 8.0
KART_BUILDING = (-20.0, -48.0, 100.0, 14.0, 7.0)       # centre along / across, length, depth, height
KART_PARKING = (68.0, -22.0, 22.0, 30.0)               # centre along / across, half length, half width


def chaikin_closed(P, n=3):
    """Corner cutting of a closed polyline"""
    P = np.asarray(P, float)
    for _ in range(n):
        Q = np.roll(P, -1, axis=0)
        P = np.stack([0.75 * P + 0.25 * Q, 0.25 * P + 0.75 * Q], 1).reshape(-1, 2)
    return P


def pad_frame(name):
    """Centre and the unit vectors along / to the right of a level pad"""
    cx, cy, ha, hc, yaw = PADS[name][:5]
    ca, sa = np.cos(np.radians(yaw)), np.sin(np.radians(yaw))
    return np.array([cx, cy]), np.array([ca, sa]), np.array([sa, -ca])


def kart_loop():
    """The kart circuit's centreline in the design frame (closed, about 2 m between points)"""
    o, a, r = pad_frame('kart')
    L = chaikin_closed(KART_LOOP, 3)
    return o + L[:, :1] * a + L[:, 1:] * r
