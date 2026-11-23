"""
Assetto Corsa circuit mod (KN5 + AI + INI data) → LibreCorsa track
(public/tracks/<id>/track_data.json + public/tracks/<id>/<id>.glb).

    python -P scripts/tracks/port_ac_track.py <id|id,id|all> [--src DIR] [--no-glb] [--no-line-opt] [--no-compress]
                                              [--extras-only]

Reads the KN5 models listed in the layout's models_*.ini, the binary AI lanes (fast_lane.ai and pit_lane.ai),
and the INI metadata (sections.ini, surfaces.ini, drs_zones.ini, cameras*.ini, groove.ini, crew.ini, lighting.ini),
builds the simulator track_data.json and GLB (with Track_Collider_* and Track_Surface_* physics nodes), runs the
lap-time racing-line optimiser for both F1 (`ro`) and GT3 (`roGt3`), and meshopt-compresses the GLB.

Each circuit's settings are in AC_TRACKS below. `folder` is the mod's track folder (the one holding models*.ini,
data/ and the layouts), found by the first of: --src DIR (porting a single folder), scripts/tracks/sources.local.json
({"<folder or id>": "<path>"}, git-ignored), or $LIBRECORSA_AC_TRACKS/<folder> (e.g. Assetto Corsa's content/tracks).
See docs/PORTING-TRACKS.md.
"""
import argparse
import configparser
import glob
import io
import json
import math
import os
import re
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
LOCAL_SOURCES = os.path.join(HERE, 'sources.local.json')
# The sibling modules (build_track, centreline, surface) import from here, also under `python -P`
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402

import build_track as bt  # noqa: E402
import centreline as cl  # noqa: E402
import surface as srf  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
MAX_TEX = 1024

MAT_ROAD = 0
MAT_KERB = 1
MAT_RUNOFF = 2
MAT_GRAVEL = 3
MAT_GRASS = 4

PHYS_COLOURS = {
    MAT_ROAD: np.array([80.0, 80.0, 80.0], np.float32),
    MAT_KERB: np.array([200.0, 30.0, 30.0], np.float32),
    MAT_RUNOFF: np.array([110.0, 110.0, 110.0], np.float32),
    MAT_GRAVEL: np.array([190.0, 165.0, 120.0], np.float32),
    MAT_GRASS: np.array([60.0, 130.0, 50.0], np.float32),
}

# Red Bull Ring props drawn with Assetto Corsa's own textures, left out (`hideTextures`): the pit wall panels with the
# Assetto Corsa logo, the marshals, the pit crew and pit props, and three prop atlases from Kunos's Monza, Magione and
# Silverstone. scripts/strip-track-props.mjs takes the same props out of built GLBs.
SPIELBERG_AC_TEXTURES = r'^(ac_crew|misc|misc1|misc_silver_2|commissario_NEW|DRIVER_Suit2|driver_face|props_pitlane)\.dds$'

AC_TRACKS = {
    'chang': {
        'folder': 'chang',
        'layout_dir': 'circuit_gp',
        'models_ini': 'models_circuit_gp.ini',
        'name': 'Chang International Circuit',
        'layout': 'Grand Prix layout',
        'country': 'Thailand',
        'city': 'Buriram',
        'baseAltitudeM': 165,
        'pitboxes': 40,
        # physical.kn5's 01ROAD is the GP circuit itself; 02ROAD (shortcut loops and pit-exit blend lane),
        # 03ROAD/04ROAD (service roads and paddock) and 05ROAD (off-circuit) are paved ground off the lap,
        # and 01CARPET (FRICTION 0.6, IS_VALID_TRACK=0) is the astroturf behind the kerbs
        'physicsNodeOverrides': [
            (r'^0[2345]ROAD', 'runoff'),
            (r'^\d+_?CARPET', 'runoff'),
        ],
        'physicsOverridesFirst': True,
        # Chang's drawn asphalt uses Material #31 and Material #924 (tarmac2.dds); 04ROAD's concrete.dds is paddock
        'roadMaterialsByTexture': True,
        # Turn 1 exit (~19.5 m) and Turn 3 entry (~25 m) widen to roughly twice the 12.8 m median width
        'maxWidthM': 26.0,
        'maxWidthRatio': 2.2,
        # Follow rapid tapers (T3/T5) and tight hairpins (T12) without smearing the road edges past the white lines
        'refinePasses': 3,
        'refineMedianSamples': 3,
        'refineSmoothSamples': 0.8,
        'refineShiftSmoothSamples': 0.8,
        'description': 'Chang International Circuit in Buriram, Thailand — 4.55 km FIA Grade 1 Grand Prix layout with long straights, technical stadium turns, 40 pitboxes, and full trackside detail.',
        'credit': {
            'title': 'Chang International Circuit',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/chang-international-circuit.20997/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/chang-international-circuit.20997/',
        },
    },
    'okayama': {
        'folder': 'okayama',
        'layout_dir': 'circuit_gp',
        'models_ini': 'models_circuit_gp.ini',
        'name': 'Okayama International Circuit',
        'layout': 'Grand Prix layout',
        'country': 'Japan',
        'city': 'Mimasaka, Okayama',
        'baseAltitudeM': 260,
        'pitboxes': 36,
        # The crew panels with the Assetto Corsa logo and Assetto Corsa's marshals: left out
        'hideTextures': r'^(ac_crew|marshall)\.dds$',
        'description': 'Okayama International Circuit (formerly TI Circuit Aida) — 3.70 km Grand Prix course in Okayama Prefecture, Japan, home of the Pacific Grand Prix.',
        'credit': {
            'title': 'Okayama International Circuit',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
        },
    },
    'okayama_piper': {
        'folder': 'okayama',
        'layout_dir': 'circuit_piper',
        'models_ini': 'models_circuit_piper.ini',
        'name': 'Okayama International Circuit',
        'layout': 'Piper course',
        'country': 'Japan',
        'city': 'Mimasaka, Okayama',
        'baseAltitudeM': 260,
        'pitboxes': 36,
        'closeBranches': True,
        # The crew panels with the Assetto Corsa logo and Assetto Corsa's marshals: left out
        'hideTextures': r'^(ac_crew|marshall)\.dds$',
        'description': 'Okayama International Circuit — 1.95 km Piper short layout bypassing the Moss S and back straight via the Piper link.',
        'credit': {
            'title': 'Okayama International Circuit',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
        },
    },
    'okayama_drift': {
        'folder': 'okayama',
        'layout_dir': 'circuit_piper_drift',
        'models_ini': 'models_circuit_piper_drift.ini',
        'name': 'Okayama International Circuit',
        'layout': 'Formula Drift layout',
        'country': 'Japan',
        'city': 'Mimasaka, Okayama',
        'baseAltitudeM': 260,
        'pitboxes': 24,
        'closeBranches': True,
        # Assetto Corsa's marshals: left out
        'hideTextures': r'^(ac_crew|marshall)\.dds$',
        'description': 'Okayama International Circuit — 1.95 km Formula Drift layout combining the main straight, First Corner, and the Piper course.',
        'credit': {
            'title': 'Okayama International Circuit',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/okayama-international-circuit.15846/',
        },
    },
    'spielberg': {
        'folder': 'spielberg_ver2',
        'layout_dir': 'circuit_full',
        'modelledKerbs': True,
        # Issue #113: the road and run-off outside Remus (s 1254-1324) laid on the mod's drawn ground, where this
        # build's lie up to 0.8 m under it (made on this build without the patch, which this source rebuilds vertex
        # for vertex)
        'physicsPatches': ('scripts/tracks/patches/spielberg-remus-v3.json',),
        'models_ini': 'models_circuit_full.ini',
        'name': 'Red Bull Ring',
        'layout': 'Grand Prix layout',
        'country': 'Austria',
        'city': 'Spielberg, Styria',
        'baseAltitudeM': 677,
        'pitboxes': 32,
        'hideTextures': SPIELBERG_AC_TEXTURES,
        'description': 'Red Bull Ring in Spielberg, Styria, Austria — 4.32 km Grand Prix circuit with 65 m of elevation change, heavy braking zones, and fast downhill sweeps.',
        'credit': {
            'title': 'Spielberg (Red Bull Ring)',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/spielberg.6437/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/spielberg.6437/',
        },
    },
    'spielberg_south': {
        'folder': 'spielberg_ver2',
        'layout_dir': 'circuit_south',
        'modelledKerbs': True,
        'models_ini': 'models_circuit_south.ini',
        'name': 'Red Bull Ring',
        'layout': 'South course',
        'country': 'Austria',
        'city': 'Spielberg, Styria',
        'baseAltitudeM': 677,
        'pitboxes': 32,
        'closeBranches': True,
        'hideTextures': SPIELBERG_AC_TEXTURES,
        'description': 'Red Bull Ring — 2.33 km South course (Südschleife) linking the Castrol Edge shortcut directly into the infield corners and Rindt / Red Bull Mobile.',
        'credit': {
            'title': 'Spielberg (Red Bull Ring)',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/spielberg.6437/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/spielberg.6437/',
        },
    },
    'spielberg_inner': {
        'folder': 'spielberg_ver2',
        'layout_dir': 'circuit_inner',
        'modelledKerbs': True,
        'models_ini': 'models_circuit_inner.ini',
        'name': 'Red Bull Ring',
        'layout': 'Inner skill course',
        'country': 'Austria',
        'city': 'Spielberg, Styria',
        'baseAltitudeM': 677,
        'pitboxes': 7,
        'fixedWidthM': 10.5,
        'wallCapM': 16.0,
        'refineEdges': False,
        'recentre': False,
        'hideTextures': SPIELBERG_AC_TEXTURES,
        'description': 'Red Bull Ring — 0.94 km Inner skill course in the driving-centre paddock.',
        'credit': {
            'title': 'Spielberg (Red Bull Ring)',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/spielberg.6437/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/spielberg.6437/',
        },
    },
    'monaco': {
        'folder': 'monaco_v101',
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['monaco.kn5'],
        'modelledKerbs': True,
        # The start straight crests sharply out of Anthony Noghès (mod R ~134 m over ~15 m at s ~2980): the default R 400 m
        # limit and 1.5-sample smoothing left the road 22 cm under the mod's at the centre and 43 cm at the left edge, past
        # the 0.32 m the drawn road is laid within, so the drawn road stood over the wheels there
        'crestMinRadiusM': 150,
        'profileSmoothSamples': 0.75,
        'name': 'Circuit de Monaco',
        'layout': 'Grand Prix layout',
        'country': 'Monaco',
        'city': 'Monte Carlo',
        'type': 'street',
        'baseAltitudeM': 15,
        'pitboxes': 24,
        'minWidthM': 7.2,
        'wallMinGapM': 0.0,
        'wallCapM': 32.0,
        'openWalls': False,
        'description': 'Circuit de Monaco in Monte Carlo — 3.34 km historic Formula 1 street circuit winding past Casino Square, Fairmont Hairpin, the Tunnel, Harbour Chicane, Swimming Pool, and La Rascasse.',
        'credit': {
            'title': 'Monaco',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/monaco.3340/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/monaco.3340/',
        },
        'turns_override': [
            (180, 'Sainte Dévote'),
            (450, 'Beau Rivage'),
            (630, 'Massenet'),
            (740, 'Casino'),
            (940, 'Mirabeau Haute'),
            (1070, 'Fairmont Hairpin'),
            (1180, 'Mirabeau Bas'),
            (1290, 'Portier'),
            (1550, 'Tunnel'),
            (1940, 'Nouvelle Chicane'),
            (2180, 'Tabac'),
            (2310, 'Louis Chiron'),
            (2480, 'Piscine'),
            (2670, 'La Rascasse'),
            (2830, 'Anthony Noghès'),
        ],
    },
    'dunsfold': {
        'folder': 'topgear',
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['topgear.kn5'],
        'name': 'Dunsfold Aerodrome',
        'layout': 'Full lap',
        'country': 'United Kingdom',
        'city': 'Dunsfold, Surrey',
        'baseAltitudeM': 50,
        'pitboxes': 10,
        # The mod names its surfaces by its own surfaces.ini keys: ASPH (the run to the line) and SHLDR (paved shoulder
        # the AI lane drives over) are IS_VALID_TRACK=1, OFFTRACK (the open runway past the edges) is 0
        'physicsNodeOverrides': [
            (r'^\d+_?(ASPH|SHLDR)', 'road'),
            (r'^\d+_?OFFTRACK', 'runoff'),
        ],
        # No kerbs in the model: painted lines and tyre stacks on an airfield, so no generated corner kerbs either
        'cornerKerbs': False,
        # The leg from Willson to the crossover and Chicago's exit are a 5-6 m marked lane (fast_lane.ai's own sides);
        # 7 m puts the edge on the visual grass line there instead of 0.75 m into the grass
        'minWidthM': 7.0,
        # The lap runs beside and across itself (the figure of eight through the crossover): the barriers capped at
        # 45 m where no tyre wall stands would cross the other leg's road here. The crossover's own tyre walls stay
        'openWallsAt': [
            (600, 735, 'L'),
            (865, 885, 'L'),
            (1980, 2010, 'L'),
            (580, 605, 'R'),
            (2218, 2260, 'R'),
        ],
        # ... and its run-off / grass bands would lie over the other leg's road: those faces read as road
        'offroadOverRoad': True,
        'description': 'Dunsfold Aerodrome in Surrey: a 2.8 km airfield lap with the Hammerhead, the Follow Through and Gambon.',
        'credit': {
            'title': 'Dunsfold Aerodrome',
            'author': 'ACU',
            'url': 'https://assettocorsa.club/',
            'short': None,
            'license': 'AC conversion v1.01, 2015',
            'licenseUrl': 'https://assettocorsa.club/',
        },
        # No sections.ini: the named corners in lap order (Wikipedia's list), on the detected turns. Turn 2 (the
        # left kink before the crossover) and Crooner Curves (kinks too gentle to count as turns) stay unnamed
        'turns_override': [
            (600, 'Willson'),
            (900, 'Chicago'),
            (1430, 'Hammerhead'),
            (1945, 'Follow Through'),
            (2250, 'Bentley'),
            (2690, 'Bacharach'),
            (2820, 'Gambon'),
        ],
    },
    'istanbul_park': {
        'folder': 'istanbul_park',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 4.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': '1',
        'models_ini': None,
        # models_1.ini also places the helicopters and the blimp (animated by CSP): the circuit, plus the brake boards
        # that the mod's ext_config inserts in place of the old ones. 1.kn5 has no meshes, only an older texture set
        'kn5_files': ['istanbul_park.kn5', 'brakemarkers.kn5'],
        # The mod's active skin ("Formula 1 2020", skins/default) replaces these textures by name in AC
        'skinDir': 'skins/default',
        # ext_config: HIDE=material:sponsor_brake? inside istanbul_park.kn5 (brakemarkers.kn5 replaces them, with
        # materials of the same names, so only the main model's are hidden)
        'hideMaterials': r'^sponsor_brake',
        'hideMaterialsIn': ['istanbul_park.kn5'],
        # ext_config: fences, garages, grandstands, gantries and parked cars drawn double-sided
        'doubleSidedMaterials': r'fence|greentaup|_pitlane_garages_|_grandstand_main_|_gantry_|^car_',
        'name': 'Istanbul Park',
        'layout': 'Grand Prix layout',
        'country': 'Turkey',
        'city': 'Tuzla, Istanbul',
        # Copernicus DEM over the circuit: 128-162 m
        'baseAltitudeM': 140,
        'pitboxes': 28,
        # The mod's own surface keys (surfaces.ini): OFFTRACK is the painted asphalt run-off and PEN-CNC-* the concrete
        # penalty strips (both IS_VALID_TRACK=0), PEN-GRS-* the grass beyond them. CARPET is the astroturf behind the
        # kerbs (FRICTION 0.7, not the kerb's 0.95): it drives as run-off, so it is mapped before the shared names
        'physicsNodeOverrides': [
            (r'^\d+_?(OFFTRACK|PEN-CNC)', 'runoff'),
            (r'^\d+_?PEN-GRS', 'grass'),
            (r'^\d+_?CARPET', 'runoff'),
        ],
        'physicsOverridesFirst': True,
        # Turn 8's four apexes are one numbered corner (the bends between them are R > 320 m for up to 100 m), and
        # Turns 5 and 6 are two lefts 25 m apart that the default 35 m gap joins: the 14 corners of sections.ini
        'turnMergeGapM': 120.0,
        'turnSplitAtM': [1525.0],
        # The crew panels with the Assetto Corsa logo and Assetto Corsa's pit props: left out
        'hideTextures': r'^(ac_crew|props_pitlane)\.dds$',
        # Istanbul Park's timing/finish line (AC_TIME_0, s=0) sits ~190 m behind the painted starting grid
        # boxes and overhead start gantry (AC_START_0..19 at s=179.7..27.3 m): place spawnGrid on AC_START_*
        'useAcStartGrid': True,
        'description': 'Istanbul Park in Tuzla, on the Asian side of Istanbul: a 5.34 km anticlockwise Grand Prix circuit over four levels, with the long, fast multi-apex Turn 8.',
        'credit': {
            'title': 'Intercity Istanbul Park',
            'author': 'Enver Bozkaya (SRTR)',
            'authorUrl': 'https://www.enverbozkaya.com/',
            'url': 'http://www.simracerstr.net/forum/viewtopic.php?t=903',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'http://www.simracerstr.net/forum/viewtopic.php?t=903',
        },
    },
    'grobnik': {
        'folder': 'grobnik',
        # Its kerb meshes are drawn and driven on (relief p90 7.1 cm): kept as modelled, not the generic hump. Their
        # 60 deg sides make 4.6-4.7 cm edges at 335 and 1140 m, as the mod's do
        'modelledKerbs': True,
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['grobnik.kn5'],
        'name': 'Automotodrom Grobnik',
        'layout': 'Full circuit',
        'country': 'Croatia',
        'city': 'Rijeka',
        # Copernicus DEM at the circuit (Open-Meteo): 300 m
        'baseAltitudeM': 300,
        'pitboxes': 28,
        # ROCK is one of the mod's surfaces.ini keys (rocky ground off the track, FRICTION 0.75, IS_VALID_TRACK=0): it
        # drives as grass. FOREST, ORANGE and GRAVE match no key, so they are scenery in AC too. CONCRET (FRICTION 0.80,
        # valid track) is the flat kerb stones on the track's edge (kerb_stone / kerb_red textures, where other corners
        # have KERB): kerb, not the run-off that counts as off the track. 01CONCRET03 is a pad by the pit wall
        'physicsNodeOverrides': [
            (r'^01CONCRET03', 'runoff'),
            (r'^\d+_?CONCRET', 'kerb'),
            (r'^\d+_?ROCK', 'grass'),
        ],
        'physicsOverridesFirst': True,
        'roadMaterialsByTexture': True,
        'hideTextures': r'^(monz_banbrg_0[12]|commissario)\.dds$',
        # sections.ini is in Croatian, without its diacritics: the two straights ("ravnina", "pravac") are not corners
        'sectionSkip': r'ravnina|pravac',
        'sectionNames': {
            'Treci': 'Treći',
            'Cetvrti': 'Četvrti',
            'Rijecki zavoj': 'Riječki zavoj',
            'Sikana': 'Šikana',
            'Zagrebacki zavoj 1. dio': 'Zagrebački zavoj 1. dio',
            'Zagrebacki zavoj 2. dio': 'Zagrebački zavoj 2. dio',
        },
        'description': 'Automotodrom Grobnik in the hills above Rijeka, Croatia: a 4.17 km anticlockwise circuit of long straights and fast left-right sweepers, home of the Yugoslav motorcycle Grand Prix from 1978 to 1990.',
        'credit': {
            'title': 'Automotodrom Grobnik',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/automotodrom-grobnik.4835/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/automotodrom-grobnik.4835/',
        },
    },
    'oschersleben': {
        'folder': 'oschersleben',
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['oschersleben.kn5'],
        # Its chicane kerb at 468 m stands 9-10 cm inside the road's width: the AI keeps off it (aiMaxKerbRiseM)
        'modelledKerbs': True,
        'name': 'Motorsport Arena Oschersleben',
        'layout': 'Grand Prix layout',
        'country': 'Germany',
        'city': 'Oschersleben, Saxony-Anhalt',
        # Copernicus DEM at the circuit (Open-Meteo): 86-90 m
        'baseAltitudeM': 88,
        'pitboxes': 24,
        # The mod's own surface keys: CUBE is the rumble strips (rmbl2a01, FRICTION 0.84, valid track) and CARPET (also
        # spelt CARPTET once) the green paint past the kerbs at FRICTION 0.72, which drives as run-off, not kerb.
        # 01pits is a tower's wall, not pit-lane ground
        'physicsNodeOverrides': [
            (r'^\d+_?CUBE', 'kerb'),
            (r'^\d+_?CARP', 'runoff'),
            (r'^\d+_?pits$', 'wall'),
        ],
        'physicsOverridesFirst': True,
        'hideTextures': r'^(sign_turn_kunosSim|flag_bmw[23])\.dds$',
        # bridge01c.dds: the Kunos Simulazioni and Assetto Corsa logos on the bridge's sides
        'texturePatches': {'bridge01c.dds': [(0.0, 0.0, 1.0, 1.0)]},
        'description': 'Motorsport Arena Oschersleben near Magdeburg, Germany: a flat 3.70 km clockwise Grand Prix circuit, where a hard left at the end of the main straight leads into the sweeping Hotel right-hander.',
        'credit': {
            'title': 'Oschersleben',
            'author': 'Mitja Bonca',
            'url': 'https://www.overtake.gg/downloads/oschersleben.4549/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/oschersleben.4549/',
        },
    },
    'barbagallo': {
        'folder': 'barbagallo',
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['barbagallo.kn5'],
        # Its 5-10 cm right-hander kerb at ~2150 m threw the LC26 at 145 km/h: the AI keeps off it (aiMaxKerbRiseM)
        'modelledKerbs': True,
        'name': 'Barbagallo Raceway',
        'layout': 'Long circuit',
        'country': 'Australia',
        'city': 'Wanneroo, Western Australia',
        # Copernicus DEM at the circuit (Open-Meteo): 78 m
        'baseAltitudeM': 78,
        'pitboxes': 30,
        # The mod's own surface keys (surfaces.ini): RACELINE is the rubbered line (FRICTION 0.965, valid track),
        # MXTRACK the crossing by the motocross course (valid track) and RESTRICTED paved ground off the lap
        # (IS_VALID_TRACK=0)
        'physicsNodeOverrides': [
            (r'^\d+_?RACELINE', 'road'),
            (r'^\d+_?MXTRACK', 'runoff'),
            (r'^\d+_?RESTRICTED', 'runoff'),
        ],
        # sections.ini numbers its corners: "T1: Cat Corner"
        'sectionStrip': r'^T\d+(&\d+)?:\s*',
        # The crew panels with the Assetto Corsa logo, Assetto Corsa's pit props and marshals, and the toolbox with the
        # Assetto Corsa logo: left out
        'hideTextures': r'^(ac_crew|Props_PITLANE|MarshallT2|marshallW|toolbox)\.dds$',
        'description': 'Barbagallo Raceway at Wanneroo, north of Perth in Western Australia: a 2.41 km clockwise circuit of seven corners over sandy hills, climbing to the blind crest at Skyline before the drop into the Basin.',
        'credit': {
            'title': 'Barbagallo Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/barbagallo-raceway.4407/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/barbagallo-raceway.4407/',
        },
    },
    'vir': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'full course',
        'models_ini': None,
        # models_full course.ini also lists the pit crews, the crowd, 3D grass, the DRS cones and two balloons
        'kn5_files': ['vir.kn5', 'vir_full.kn5', 'raceday_signage.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'Full course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        # Copernicus DEM at the circuit (Open-Meteo): 128 m
        'baseAltitudeM': 128,
        'pitboxes': 33,
        # SLIP is one of the mod's surfaces.ini keys: the slip road off the lap (FRICTION 0.97)
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'Virginia International Raceway at Alton, on the North Carolina border: the 5.26 km Full course, with the uphill Climbing Esses, Oak Tree and the plunge of the Roller Coaster.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_north': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'north course',
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_north.kn5', 'trackday_signage.kn5', 'patriot_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'North course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 3.6 km North course of Virginia International Raceway: the Full course with a shortcut from Oak Tree back towards the start.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_south': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'south course',
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_south.kn5', 'trackday_signage.kn5', 'south_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'South course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 2.6 km South course of Virginia International Raceway: its own paddock and the back half of the circuit, through the Roller Coaster and Hog Pen.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_grand_east': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'grand east course',
        # The Patriot course's crest (mod R ~130 m) was cut up to 0.41 m under the mod's road by the default R 400 m limit,
        # past the 0.32 m the drawn road is laid within, so the drawn road stood over the wheels there
        'crestMinRadiusM': 200,
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_grand_east.kn5', 'trackday_signage.kn5', 'patriot_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'Grand East course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 6.4 km Grand East course of Virginia International Raceway: the Full course joined to the Patriot course on its east side.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_grand_west': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'grand west course',
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_grand_west.kn5', 'trackday_signage.kn5', 'patriot_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'Grand West course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 6.6 km Grand West course of Virginia International Raceway: the Full course joined to the Patriot course on its west side.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_patriot': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'patriot course',
        # The Patriot course's crest (mod R ~130 m) was cut up to 0.41 m under the mod's road by the default R 400 m limit,
        # past the 0.32 m the drawn road is laid within, so the drawn road stood over the wheels there
        'crestMinRadiusM': 200,
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_patriot.kn5', 'trackday_signage.kn5', 'patriot_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'Patriot course',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 1.8 km Patriot course of Virginia International Raceway, run anticlockwise on its own beside the main circuit.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'vir_patriot_reverse': {
        'folder': 'vir',
        # Its kerb meshes are drawn and driven on (relief p90 11.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'patriot reverse course',
        # The Patriot course's crest (mod R ~130 m) was cut up to 0.41 m under the mod's road by the default R 400 m limit,
        # past the 0.32 m the drawn road is laid within, so the drawn road stood over the wheels there
        'crestMinRadiusM': 200,
        'models_ini': None,
        'kn5_files': ['vir.kn5', 'vir_patriot_reverse.kn5', 'trackday_signage.kn5', 'patriot_objects.kn5'],
        'name': 'Virginia International Raceway',
        'layout': 'Patriot course reversed',
        'country': 'United States',
        'city': 'Alton, Virginia',
        'baseAltitudeM': 128,
        'pitboxes': 33,
        'physicsNodeOverrides': [
            (r'^\d+_?SLIP', 'runoff'),
        ],
        'description': 'The 1.8 km Patriot course of Virginia International Raceway, run clockwise.',
        'credit': {
            'title': 'Virginia International Raceway',
            'author': 'dazzyb2k3',
            'url': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/virginia-international-raceway.11892/',
        },
    },
    'sachsenring': {
        'folder': 'g333_sachsenring_2022',
        # Its kerb meshes are drawn and driven on (relief p90 3.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'event',
        'models_ini': None,
        # models_event.ini also places helicopters, marshals, flag men and camera crews (animated by CSP). AC.kn5 holds
        # only the grid, pit and timing markers; roadmesh.kn5 and walls.kn5 are the physical road and barriers
        'kn5_files': ['g333_sachsenring_2022.kn5', 'event.kn5', 'GarageDoors.kn5', 'walls.kn5', 'roadmesh.kn5',
                      'trees.kn5', 'groove.kn5'],
        # The pit crews of event.kn5 (two levels of detail of each, one over the other)
        'hideNodes': r'^AC_CREW_',
        'name': 'Sachsenring',
        'layout': 'Grand Prix layout',
        'country': 'Germany',
        'city': 'Hohenstein-Ernstthal, Saxony',
        # Copernicus DEM at the circuit (Open-Meteo): 335 m
        'baseAltitudeM': 335,
        'pitboxes': 32,
        # The mod's own surface keys (surfaces.ini): PAINTED is the painted run-off (IS_VALID_TRACK=0) and SKID the skid
        # pad (FRICTION 0.60, IS_VALID_TRACK=0). The other names match no key: walls, a bridge, stairs and the kart hall
        # stand in the way as barriers, and GARAGENBODEN is the garage floor
        'physicsNodeOverrides': [
            (r'^\d+_?(CONCRETEWALL|GLADIOLWALL|BRUECKE|KARTHALLE|STAIR)', 'wall'),
            (r'^\d+_?(PAINTED|SKID)', 'runoff'),
            (r'^\d+_?GARAGENBODEN', 'pit'),
        ],
        'physicsOverridesFirst': True,
        # Assetto Corsa's pit props and marshals (and their flat stand-ins): left out
        'hideTextures': r'^(props_pitlane|Track-Marshall_HP|Marshall_LP2?)\.dds$',
        'description': 'The Sachsenring at Hohenstein-Ernstthal in Saxony: a 3.67 km anticlockwise circuit, tight through the Omega before a run of fast left-handers over the hill and the steep drop to the Sachsenkurve.',
        'credit': {
            'title': 'Sachsenring 2022',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/sachsenring-2022.41511/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/sachsenring-2022.41511/',
        },
    },
    'sachsenring_short': {
        'folder': 'g333_sachsenring_2022',
        # Its kerb meshes are drawn and driven on (relief p90 3.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'trackday_short',
        'models_ini': None,
        'kn5_files': ['g333_sachsenring_2022.kn5', 'trackday_short.kn5', 'walls.kn5', 'roadmesh.kn5', 'trees.kn5',
                      'groove.kn5'],
        'hideNodes': r'^AC_CREW_',
        'name': 'Sachsenring',
        'layout': 'Short course',
        'country': 'Germany',
        'city': 'Hohenstein-Ernstthal, Saxony',
        'baseAltitudeM': 335,
        'pitboxes': 32,
        'physicsNodeOverrides': [
            (r'^\d+_?(CONCRETEWALL|GLADIOLWALL|BRUECKE|KARTHALLE|STAIR)', 'wall'),
            (r'^\d+_?(PAINTED|SKID)', 'runoff'),
            (r'^\d+_?GARAGENBODEN', 'pit'),
        ],
        'physicsOverridesFirst': True,
        # Assetto Corsa's pit props and marshals (and their flat stand-ins): left out
        'hideTextures': r'^(props_pitlane|Track-Marshall_HP|Marshall_LP2?)\.dds$',
        'description': 'The Sachsenring at Hohenstein-Ernstthal in Saxony: the 1.52 km short course, which turns back to the start straight before the hill.',
        'credit': {
            'title': 'Sachsenring 2022',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/sachsenring-2022.41511/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/sachsenring-2022.41511/',
        },
    },
    'norisring': {
        'folder': 'norisring',
        # Its kerb meshes are drawn and driven on (relief p90 3.0 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': '',
        'models_ini': None,
        # AC.kn5 holds only the grid, pit and timing markers; norisring_RDMesh.kn5 is the physical road
        'kn5_files': ['norisring.kn5', 'norisring_RDMesh.kn5', 'groove.kn5', 'roadmarks.kn5'],
        'name': 'Norisring',
        'layout': 'Street circuit',
        'type': 'street',
        'country': 'Germany',
        'city': 'Nuremberg, Bavaria',
        # Copernicus DEM at the circuit (Open-Meteo): 323 m
        'baseAltitudeM': 323,
        'pitboxes': 36,
        # OUT is one of the mod's surfaces.ini keys: the paved ground off the lap (FRICTION 0.92, IS_VALID_TRACK=0).
        # COLLISION matches no key: the barriers' collision boxes
        'physicsNodeOverrides': [
            (r'^\d+_?COLLISION', 'wall'),
            (r'^\d+_?OUT', 'runoff'),
        ],
        'physicsOverridesFirst': True,
        'description': 'The Norisring in Nuremberg: a 2.3 km street circuit round the Zeppelin grandstand, two long straights joined by the Grundig hairpin, the Schöller S and the Dutzendteich hairpin, between concrete walls all the way.',
        'credit': {
            'title': 'Norisring 2009',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/norisring-2009.27646/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/norisring-2009.27646/',
        },
    },
    'le_mans_82': {
        'folder': 'le_mans_82',
        # Its kerb meshes are drawn and driven on (relief p90 5.4 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'regular',
        'models_ini': None,
        # models_regular.ini also places the airship, a helicopter and camera crews (animated by CSP). physical.kn5 is
        # the physical road and barriers
        'kn5_files': ['le_mans_82.kn5', 'trees.kn5', 'lights.kn5', 'trib_lights.kn5', 'timing.kn5', 'ferriswheel.kn5',
                      'physical.kn5'],
        'name': 'Circuit de la Sarthe 1982',
        'layout': 'Full circuit',
        'country': 'France',
        'city': 'Le Mans',
        # Copernicus DEM at the circuit (Open-Meteo): 66 m
        'baseAltitudeM': 66,
        'pitboxes': 56,
        # CARPET is one of the mod's surfaces.ini keys (FRICTION 0.91, IS_VALID_TRACK=0): it drives as run-off, not kerb.
        # TWALLCOL matches no key: a barrier's collision box
        'physicsNodeOverrides': [
            (r'^\d+_?CARPET', 'runoff'),
            (r'^\d+_?TWALLCOL', 'wall'),
        ],
        'physicsOverridesFirst': True,
        # The Hunaudières straight is no corner (the bend halfway along it is "Courbe des Hunaudières")
        'sectionSkip': r'^Hunaudières$',
        'sectionNames': {
            '´S´ du Tertre Rouge': 'S du Tertre Rouge',
            'Courbe d´Antares': "Courbe d'Antarès",
            'Esses d´Indianapolis': "Esses d'Indianapolis",
            'Virage d´Arnage': "Virage d'Arnage",
        },
        # Assetto Corsa's marshals (and their flat stand-ins): left out
        'hideTextures': r'^(Track-Marshall_LM_HP|Marshall_LP2)\.dds$',
        'description': 'The Circuit de la Sarthe as it was for the 1982 24 Hours of Le Mans: 13.6 km, most of it public road, with the Hunaudières straight unbroken for almost 6 km from Tertre Rouge to Mulsanne.',
        'credit': {
            'title': 'Le Mans 1982',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/le-mans-1982.52192/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/le-mans-1982.52192/',
        },
    },
    'borgloh': {
        'folder': 'g333_borgloh_2024',
        'layout_dir': '',
        'models_ini': None,
        # models.ini also places marshals, a TV camera crew, a plane and birds (animated by CSP). track_hp.kn5 is the
        # physical road and walls.kn5 the barriers
        'kn5_files': ['g333_borgloh_2024.kn5', 'track_hp.kn5', 'road_marks.kn5', 'road_edges.kn5', 'plants.kn5',
                      'borgloh_TSOs.kn5', 'tso_small_01.kn5', 'start_timing.kn5', 'timing_clock.kn5', '2d_crowd.kn5',
                      '3d_crowd.kn5', 'tyrewalls.kn5', 'walls.kn5'],
        # A hill climb: one run from the start gate to the finish gate (AC.kn5's AC_AB_START / AC_AB_FINISH)
        'pointToPoint': True,
        'markersKn5': 'AC.kn5',
        'type': 'hillclimb',
        'laneMinWidthM': 3.0,
        'minWidthM': 4.5,
        'minHalfWidthM': 1.8,
        # A country road: no kerbs where the mod has none, and barriers close to its edges
        'cornerKerbs': False,
        'lineMarginM': 1.4,
        'name': 'Borgloh',
        'layout': 'Osnabrück hill climb',
        'country': 'Germany',
        'city': 'Borgloh, Lower Saxony',
        # Copernicus DEM at the start (Open-Meteo): 91 m
        'baseAltitudeM': 91,
        'pitboxes': 30,
        # COLWALL is the mod's barrier collision mesh
        'physicsNodeOverrides': [
            (r'^\d+_?COLWALL', 'wall'),
        ],
        # sections.ini names the straights ("Gerade"), the start and the finish ("Ziel") too: not corners
        'sectionSkip': r'Gerade|Start$|Ziel$',
        'description': 'The Osnabrück hill climb at Borgloh in Lower Saxony: 2.0 km up the Uphöfener Berg on a narrow country road through the woods, from the village to the finish 75 m higher.',
        'credit': {
            'title': 'Borgloh 2024',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/borgloh-2024.18393/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/borgloh-2024.18393/',
        },
    },
    'goodwood': {
        'folder': 'g333_goodwood_hillclimb',
        # The LQ layout: the HQ one needs CSP's flow shader and animated objects. Its AI lane is the HQ one's
        'layout_dir': 'layout_b',
        'models_ini': None,
        # models_layout_b.ini also places a Ferris wheel and marshals at their own offsets and the 3D crowd.
        # RoadHP.kn5 is the physical road and walls.kn5 the barriers
        'kn5_files': ['g333_goodwood_hillclimb.kn5', 'trees.kn5', 'cars.kn5', 'walls.kn5', 'lights.kn5', 'Haybales.kn5',
                      'Haybales2.kn5', 'NoAnimations.kn5', 'RoadHP.kn5'],
        'pointToPoint': True,
        'markersKn5': 'AC.kn5',
        'type': 'hillclimb',
        'laneMinWidthM': 3.0,
        'minWidthM': 4.5,
        'minHalfWidthM': 1.8,
        # A country road: no kerbs where the mod has none, and barriers close to its edges
        'cornerKerbs': False,
        'lineMarginM': 1.4,
        'name': 'Goodwood',
        'layout': 'Festival of Speed hill climb',
        'country': 'United Kingdom',
        'city': 'Chichester, West Sussex',
        # Copernicus DEM at the start (Open-Meteo): 55 m
        'baseAltitudeM': 55,
        'pitboxes': 30,
        'description': 'The Festival of Speed hill climb in the grounds of Goodwood House, West Sussex: 1.86 km past the house, through Molecomb and along the flint wall to the finish 94 m up, between hay bales all the way.',
        'credit': {
            'title': 'Goodwood Festival of Speed 2017',
            'author': 'gunnar333',
            'url': 'https://www.overtake.gg/downloads/goodwood-festival-of-speed-2017.26839/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/goodwood-festival-of-speed-2017.26839/',
        },
    },
    'bridgehampton': {
        'folder': 'bridgehampton',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 1.7 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': '',
        'models_ini': None,
        # models.ini also lists 3D grass (grass.kn5) and the crowd (people.kn5, 314k triangles). phy.kn5 is the
        # physical road, kerbs and barriers
        'kn5_files': ['bridgehampton.kn5', 'phy.kn5', 'land.kn5', 'pb.kn5', 'trees.kn5', 'cones.kn5', 'groove.kn5'],
        'hideNodes': r'CREW',
        'texturePatches': {'signs.dds': [(0.30, 0.715, 0.545, 0.91)]},
        'name': 'Bridgehampton Race Circuit',
        'layout': 'Full circuit',
        'country': 'United States',
        'city': 'Bridgehampton, New York',
        # Copernicus DEM at the circuit (Open-Meteo): 70 m
        'baseAltitudeM': 70,
        'pitboxes': 24,
        # The mod's own surface keys (surfaces.ini): EXTEND is paved ground beside the lap that counts as track
        # (FRICTION 0.97, IS_VALID_TRACK=1), PADDOCK the paddock (FRICTION 0.85)
        'physicsNodeOverrides': [
            (r'^\d+_?EXTEND', 'road'),
            (r'^\d+_?PADDOCK', 'runoff'),
        ],
        # The terrain's materials are named ROAD_002__land-main*: the asphalt is told apart by its diffuse texture
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        # sections.ini numbers its corners: "Turn 1, Hansgen Turn"
        'sectionStrip': r'^Turn \d+(/\d+)?,\s*',
        'description': 'Bridgehampton Race Circuit on Long Island, New York, as it was in the late 1980s: a 4.5 km clockwise lap through the sand hills of the Hamptons, from Hansgen Turn at the end of the straight to the Valley of the Lefts. It closed in 1997 and is a golf course now.',
        'credit': {
            'title': 'Bridgehampton Race Circuit',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/bridgehampton-race-circuit.6604/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/bridgehampton-race-circuit.6604/',
        },
    },
    'watkins_glen': {
        'folder': 'lilski_watkins_glen',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 4.3 cm): kept as modelled, not the
        # generic hump.
        'modelledKerbs': True,
        'layout_dir': 'boot',
        'models_ini': None,
        # models_boot.ini also lists 3D grass, the parked tents and RVs (veh.kn5, 531k triangles) and the blimp and
        # scout plane (animated by CSP). lt.kn5 is the layout's timing gates, groove_b.kn5 its rubber, cones and two
        # blocking walls
        'kn5_files': ['lilski_watkins_glen.kn5', 'pb.kn5', 'phy.kn5', 'land.kn5', 'trees.kn5', 'lt.kn5', 'groove_b.kn5',
                      'cf.kn5', 'people.kn5', 'pitobjects.kn5', 'lights.kn5', 'endurance.kn5'],
        'hideNodes': r'^AC_CREW_',
        # pitwall.dds: the band of Assetto Corsa logos between the I Love NY and NASCAR bands
        'texturePatches': {'signs1.dds': [(0.71, 0.755, 0.99, 0.87)], 'signs3.dds': [(0.0, 0.50, 1.0, 0.60)],
                           'pitwall.dds': [(0.0, 0.3105, 1.0, 0.373)]},
        'name': 'Watkins Glen International',
        'layout': 'Grand Prix course',
        'country': 'United States',
        'city': 'Watkins Glen, New York',
        # Copernicus DEM at the circuit (Open-Meteo): 484 m
        'baseAltitudeM': 484,
        'pitboxes': 43,
        # The mod's own surface keys (surfaces.ini): CLASSIC is the old line through the Inner Loop (IS_VALID_TRACK=0
        # on the modern layouts), OUT paved ground off the lap and PADDOCK the paddock
        'physicsNodeOverrides': [
            (r'^\d+_?(CLASSIC|OUT|PADDOCK)', 'runoff'),
        ],
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        # sections.ini numbers its corners: "Turn 1, The 90"
        'sectionStrip': r'^Turn \d+,\s*',
        'description': 'Watkins Glen International in the Finger Lakes of New York: the 5.4 km Grand Prix course, with the Inner Loop on the back straight and the Boot, the Toe and the Heel, out in the woods. The Six Hours of the Glen is raced here.',
        'credit': {
            'title': 'Watkins Glen International',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/watkins-glen-international.20204/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/watkins-glen-international.20204/',
        },
    },
    'watkins_glen_short': {
        'folder': 'lilski_watkins_glen',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 4.3 cm): kept as modelled, not the
        # generic hump. The GT3's line was
        # re-optimised on them (the old one, tuned on the hump, spun it at 3.4 km)
        'modelledKerbs': True,
        'layout_dir': 'short',
        'models_ini': None,
        'kn5_files': ['lilski_watkins_glen.kn5', 'pb.kn5', 'phy.kn5', 'land.kn5', 'trees.kn5', 'st.kn5', 'groove_s.kn5',
                      'cf.kn5', 'people.kn5', 'pitobjects.kn5', 'lights.kn5', 'endurance.kn5'],
        'hideNodes': r'^AC_CREW_',
        # pitwall.dds: the band of Assetto Corsa logos between the I Love NY and NASCAR bands
        'texturePatches': {'signs1.dds': [(0.71, 0.755, 0.99, 0.87)], 'signs3.dds': [(0.0, 0.50, 1.0, 0.60)],
                           'pitwall.dds': [(0.0, 0.3105, 1.0, 0.373)]},
        'name': 'Watkins Glen International',
        'layout': 'Short course',
        'country': 'United States',
        'city': 'Watkins Glen, New York',
        'baseAltitudeM': 484,
        'pitboxes': 43,
        'physicsNodeOverrides': [
            (r'^\d+_?(CLASSIC|OUT|PADDOCK)', 'runoff'),
        ],
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        'sectionStrip': r'^Turn \d+,\s*',
        'description': 'Watkins Glen International: the 3.9 km short course, which leaves out the Boot and turns back from the Outer Loop to the start. NASCAR races on it.',
        'credit': {
            'title': 'Watkins Glen International',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/watkins-glen-international.20204/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/watkins-glen-international.20204/',
        },
    },
    'riverside': {
        'folder': 'riverside',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 6.6 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        # The run into Turn 7A crests at R ~280 m (s ~2010): the default R 400 m limit cut the road 0.34 m under the mod's,
        # past the 0.32 m the drawn road is laid within, so the drawn road stood 0.34 m over the wheels there
        'crestMinRadiusM': 250,
        'layout_dir': 'long',
        'models_ini': None,
        # models_long.ini also lists 3D grass, the parked cars and RVs (veh.kn5, 749k triangles) and the blimp.
        # long.kn5 is the layout's timing gates, rubber, cones and two blocking walls
        'kn5_files': ['riverside.kn5', 'phy.kn5', 'land.kn5', 'long.kn5', 'trees.kn5', 'crowd.kn5', 'misc.kn5'],
        'hideNodes': r'^AC_CREW_',
        'texturePatches': {'signs.dds': [(0.54, 0.43, 0.665, 0.545)]},
        'name': 'Riverside International Raceway',
        'layout': 'Long course',
        'country': 'United States',
        'city': 'Riverside, California',
        # Copernicus DEM at the circuit (Open-Meteo): 494 m
        'baseAltitudeM': 494,
        'pitboxes': 24,
        # The mod's own surface keys (surfaces.ini): one physical road for every layout, its branches valid or not
        # per layout. On the long course LONG (the run down the back straight to Turn 9) and CONFINE count as track;
        # SHORT, DRAG, EXTEND and CUT are paved ground off the lap, PADDOCK the paddock
        'physicsNodeOverrides': [
            (r'^\d+_?(LONG|CONFINE)', 'road'),
            (r'^\d+_?(SHORT|DRAG|EXTEND|CUT|PADDOCK)', 'runoff'),
        ],
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        'description': 'Riverside International Raceway in California, as it was in 1988 before it closed: the 5.3 km long course, its back straight running over a kilometre to the banked Turn 9. Formula 1, Can-Am, IndyCar and NASCAR all raced here.',
        'credit': {
            'title': 'Riverside International Raceway',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
        },
    },
    'riverside_short': {
        'folder': 'riverside',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 6.6 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        # The run into Turn 7A crests at R ~280 m (s ~2010): the default R 400 m limit cut the road 0.34 m under the mod's,
        # past the 0.32 m the drawn road is laid within, so the drawn road stood 0.34 m over the wheels there
        'crestMinRadiusM': 250,
        'layout_dir': 'short',
        'models_ini': None,
        'kn5_files': ['riverside.kn5', 'phy.kn5', 'land.kn5', 'short.kn5', 'trees.kn5', 'crowd.kn5', 'misc.kn5'],
        'hideNodes': r'^AC_CREW_',
        'texturePatches': {'signs.dds': [(0.54, 0.43, 0.665, 0.545)]},
        'name': 'Riverside International Raceway',
        'layout': 'Short course',
        'country': 'United States',
        'city': 'Riverside, California',
        'baseAltitudeM': 494,
        'pitboxes': 24,
        'physicsNodeOverrides': [
            (r'^\d+_?(LONG|SHORT|CONFINE)', 'road'),
            (r'^\d+_?(DRAG|EXTEND|CUT|PADDOCK)', 'runoff'),
        ],
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        'description': 'Riverside International Raceway: the 4.0 km short course, one of the three layouts raced there until it closed in 1989.',
        'credit': {
            'title': 'Riverside International Raceway',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
        },
    },
    'riverside_nascar': {
        'folder': 'riverside',
        # It drives on hidden kerb meshes and draws its kerbs apart (relief p90 6.6 cm): kept as modelled, not the generic hump
        'modelledKerbs': True,
        'layout_dir': 'nascar',
        'models_ini': None,
        'kn5_files': ['riverside.kn5', 'phy.kn5', 'land.kn5', 'nascar.kn5', 'trees.kn5', 'crowd.kn5', 'misc.kn5'],
        'hideNodes': r'^AC_CREW_',
        'texturePatches': {'signs.dds': [(0.54, 0.43, 0.665, 0.545)]},
        'name': 'Riverside International Raceway',
        'layout': 'NASCAR course',
        'country': 'United States',
        'city': 'Riverside, California',
        'baseAltitudeM': 494,
        'pitboxes': 24,
        'physicsNodeOverrides': [
            (r'^\d+_?CONFINE', 'road'),
            (r'^\d+_?(LONG|SHORT|DRAG|EXTEND|CUT|PADDOCK)', 'runoff'),
        ],
        'roadMaterialsByTexture': True,
        # LilSki's terrain is a mask blending detail textures over a blank carrier
        'bakeMultilayerMasks': True,
        'description': 'Riverside International Raceway: the 4.1 km course NASCAR raced on until 1988, through the Esses and round Turn 9.',
        'credit': {
            'title': 'Riverside International Raceway',
            'author': 'LilSki',
            'authorUrl': 'https://www.overtake.gg/members/lilski.218202/',
            'url': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/riverside-international-raceway.9492/',
        },
    },
    'speedvegas': {
        'folder': 'speedvegas',
        'layout_dir': '',
        'models_ini': None,
        'kn5_files': ['speedvegas.kn5', 'walls.kn5', 'models.kn5', 'models2.kn5', 'models3.kn5', 'models4.kn5',
                      'models5.kn5', 'objects.kn5'],
        'modelledKerbs': True,
        # walls.kn5 draws the tyre walls and fences as well as holding the barriers' physics meshes
        'physicsFiles': (),
        'name': 'SpeedVegas',
        'layout': 'Full circuit',
        'country': 'United States',
        'city': 'Las Vegas, Nevada',
        # Copernicus DEM at the circuit (Open-Meteo): 822 m
        'baseAltitudeM': 822,
        'pitboxes': 10,
        # The mod's own surface names: SURFACE_SAND is a sand patch and SURFACE the paved areas beside the lap
        'physicsNodeOverrides': [
            (r'^\d+_?SURFACE_SAND', 'gravel'),
            (r'^\d+_?SURFACE', 'runoff'),
        ],
        'description': 'SpeedVegas, the driving centre in the desert south of Las Vegas: a 1.8 km clockwise lap between tyre walls, two long straights joined by tight turns and kinks.',
        'credit': {
            'title': 'SpeedVegas',
            'author': 'Gogol',
            'authorUrl': 'https://www.overtake.gg/members/gogol-the-chaos.153450/',
            'url': 'https://www.overtake.gg/downloads/speedvegas-2025.86996/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/speedvegas-2025.86996/',
        },
    },
    'willow_springs': {
        'folder': 'willow_springs',
        # big_willow_real: the everyday circuit, the model the physics comes from. The other layout's event dressing and
        # its balloons and blimp (DYNAMIC_OBJECT_n, which get_kn5_list would bake in as static meshes) are added below
        # (`extraModels`, `driftingObjects`)
        'layout_dir': 'big_willow_real',
        'models_ini': None,
        'kn5_files': ['willow_springs_real.kn5'],
        'name': 'Willow Springs International Raceway',
        'layout': 'Big Willow',
        'country': 'United States',
        'city': 'Rosamond, California',
        # Copernicus DEM at the circuit (Open-Meteo): 735-745 m
        'baseAltitudeM': 740,
        'pitboxes': 40,
        # Background is the satellite-photo terrain, also drawn over some ROAD physics meshes off the lap; TRACK_LIGHT
        # the light towers; sml_rock_003 a rocky access path
        'notRoadMaterials': r'^(Background|TRACK_LIGHT|sml_rock_003)$',
        # The ROAD physics meshes off the circuit: the satellite-photo ground (1ROAD2, 17, 20, 22, 24, 25), the paddock's
        # cracked service roads (19, 21) and a rocky path (26). As road they widened the lap before Turn 1 onto the
        # ground beside it, and the racing lines ran there
        'physicsNodeOverrides': [(r'^1ROAD(2|17|19|20|21|22|24|25|26)$', 'runoff')],
        'physicsOverridesFirst': True,
        # Turn 4's crest is R 295 m (taken at ~120 km/h, a car goes light there only past ~190 km/h): the default
        # R 400 m limit cut the profile 0.73 m under it, and the drawn road, laid onto that within 0.32 m, came out
        # stepped
        'crestMinRadiusM': 250,
        # Its skidmark layer (Skidmark01, ksPerPixelAT set to blend) draws blended, not cut out
        'blendedCutouts': True,
        # Its kerbs (1_KERB0-5, drawn and driven on) are 0.45 m strips 1.9 cm proud with a slot every metre: kept as
        # modelled, not flattened into the generic hump
        'modelledKerbs': True,
        # The mod's other layout (big_willow) is this lap dressed for an event day. From its model: the camera truck
        # (OBJ133), the team transporters (OBJ45), a Ferris wheel (OBJ53), a canvas pavilion (OBJ15), tents (OBJ54), a
        # row of parked cars beside them (OBJ213), a light pole with Nukedrop's donation sign (OBJ42) and two banner
        # stands (OBJ9, OBJ154). Its other differences are this model's car parks and buses laid out again and two of
        # its banner rows in other panels, left out as they would stand in the same places
        'extraModels': [{
            'kn5': 'willow_springs.kn5',
            'nodes': r'^OBJ(9|15|42|45|53|54|133|154|213)(_SUB\d+)?$',
        }],
        # That layout's models ini also floats 31 hot-air balloons and a blimp over the circuit
        'driftingObjects': 'models_big_willow.ini',
        'description': 'Willow Springs in the Mojave Desert, California: Big Willow, a fast and open 4.0 km lap of nine turns that climbs over a hill and drops back down to the long front straight.',
        'credit': {
            'title': 'Willow Springs - Big Willow',
            'author': 'Nukedrop',
            'url': 'https://www.overtake.gg/downloads/willow-springs-big-willow.32338/',
            'short': None,
            'license': 'Used with permission',
            'licenseUrl': 'https://www.overtake.gg/downloads/willow-springs-big-willow.32338/',
        },
    },
}


def log(*a):
    print(*a, flush=True)


class _Reader:
    def __init__(self, data):
        self.b = memoryview(data)
        self.o = 0

    def take(self, n):
        v = self.b[self.o:self.o + n]
        self.o += n
        return v

    def i32(self):
        return struct.unpack('<i', self.take(4))[0]

    def u8(self):
        return self.take(1)[0]

    def f32(self, n=1):
        v = np.frombuffer(self.take(4 * n), '<f4').astype(np.float64)
        return v[0] if n == 1 else v

    def str(self):
        return bytes(self.take(self.i32())).decode('utf-8', 'replace')


def read_kn5_full(path):
    """Reads a KN5 file including mesh `renderable` flag and ancestor `active` state."""
    r = _Reader(open(path, 'rb').read())
    if bytes(r.take(6)) != b'sc6969':
        raise ValueError(f'{path}: not a kn5 file')
    version = r.i32()
    if version > 5:
        r.i32()
    textures = {}
    for _ in range(r.i32()):
        r.i32()
        tname = r.str()
        textures[tname] = bytes(r.take(r.i32()))
    materials = []
    for _ in range(r.i32()):
        mname, shader = r.str(), r.str()
        blend, tested = r.u8(), bool(r.u8())
        r.i32()
        props = {}
        for _ in range(r.i32()):
            pname = r.str()
            fval = float(r.f32())
            vec_vals = r.f32(9)
            props[pname] = fval
            props[pname + '_vec3'] = vec_vals[2:5].tolist()
        maps = {}
        for _ in range(r.i32()):
            slot = r.str()
            r.i32()
            maps[slot] = r.str()
        materials.append({
            'name': mname,
            'shader': shader,
            'blend': blend,
            'alpha_tested': tested,
            'props': props,
            'maps': maps,
        })

    nodes = []

    def parse_node(parent_mat, parent_active):
        kind = r.i32()
        name = r.str()
        nchild = r.i32()
        active = bool(r.u8()) and parent_active
        mat4 = parent_mat
        mesh = None
        if kind == 1:
            local = r.f32(16).reshape(4, 4).T
            mat4 = parent_mat @ local
        elif kind in (2, 3):
            cast_shadow = bool(r.u8())
            visible, transparent = bool(r.u8()), bool(r.u8())
            if kind == 3:
                for _ in range(r.i32()):
                    r.str()
                    r.take(64)
            n = r.i32()
            stride = 44 if kind == 2 else 76
            v = np.frombuffer(r.take(n * stride), '<f4').reshape(n, stride // 4).astype(np.float32)
            idx = np.frombuffer(r.take(r.i32() * 2), '<u2').copy()
            mat_idx = r.i32()
            r.i32()
            r.take(8)
            renderable = True
            if kind == 2:
                r.take(16)
                renderable = bool(r.u8())
            mesh = {
                'pos': v[:, 0:3],
                'nrm': v[:, 3:6],
                'uv': v[:, 6:8],
                'idx': idx,
                'mat': mat_idx,
                'visible': visible,
                'transparent': transparent,
                'renderable': renderable,
                'cast_shadow': cast_shadow,
            }
        nodes.append({
            'name': name,
            'kind': kind,
            'active': active,
            'world': mat4,
            'mesh': mesh,
        })
        for _ in range(nchild):
            parse_node(mat4, active)

    parse_node(np.eye(4), True)
    return textures, materials, nodes


def parse_ac_ini(path):
    cp = configparser.ConfigParser(strict=False, inline_comment_prefixes=(';', '//'))
    cp.optionxform = str
    if os.path.exists(path):
        # utf-8-sig: some mods' INI files start with a byte-order mark, which hides the first section header
        txt = open(path, 'r', encoding='utf-8-sig', errors='replace').read()
        # Some start with a line before the first section (Bridgehampton's surfaces.ini: a version number, "2.0")
        head = re.search(r'^\s*\[', txt, re.M)
        cp.read_string(txt[head.start():] if head else '')
    return cp


def get_kn5_list(cfg):
    base = cfg['base_dir']
    if cfg.get('kn5_files'):
        return cfg['kn5_files']
    ini_path = os.path.join(base, cfg['models_ini'])
    cp = parse_ac_ini(ini_path)
    out = []
    for sec in cp.sections():
        if sec.startswith('MODEL_') or sec.startswith('DYNAMIC_OBJECT_'):
            f = cp[sec].get('FILE', '').strip()
            if f and f.lower().endswith('.kn5') and os.path.exists(os.path.join(base, f)):
                if f not in out:
                    out.append(f)
    return out


# Slots in the drifting objects' table (src/lib/render/drifting-objects.ts, DRIFT_SLOTS): a vertex's `_DRIFT` value is
# (slot + 0.5) / DRIFT_SLOTS, which the GLB's 12-bit quantization keeps apart
DRIFT_SLOTS = 32
# Drifting objects that share one mesh are drawn over an atlas of their textures in tiles of DRIFT_TILE px, each image
# wrapped round into a DRIFT_GUTTER px border (AC wraps their UVs a little past 0..1, and the border keeps the mipmaps
# of the neighbouring tiles out)
DRIFT_TILE = 256
DRIFT_GUTTER = 8


def merge_kn5_assets(t_dict, mats, kf, tex_pool, materials, seen_mat_names):
    """Adds another KN5's textures and materials to the pools: a texture name already holding other bytes, and a
    material name already given to a different material, get the file's name added. Returns the offset of its
    materials in `materials`"""
    stem = os.path.splitext(os.path.basename(kf))[0].replace(' ', '_')
    renamed = {}
    for tname, raw in t_dict.items():
        if tname in tex_pool and tex_pool[tname] != raw:
            root_, ext = os.path.splitext(tname)
            renamed[tname] = f'{root_}@{stem}{ext}'
            tex_pool[renamed[tname]] = raw
        else:
            tex_pool[tname] = raw
    for m in mats:
        m['maps'] = {slot: renamed.get(t, t) for slot, t in m['maps'].items()}
        sig = (m['name'], m['shader'], m['blend'], m['alpha_tested'], m['maps'].get('txDiffuse'))
        if m['name'] in seen_mat_names and seen_mat_names[m['name']] != sig:
            m['name'] = f"{m['name']}_{stem}"
        seen_mat_names[m['name']] = sig
    offset = len(materials)
    materials.extend(mats)
    return offset


def world_mesh(nd):
    """A KN5 mesh node's positions and normals in the model's space"""
    m, w = nd['mesh'], nd['world']
    pos = (m['pos'] @ w[:3, :3].T) + w[:3, 3]
    nrm = m['nrm'] @ w[:3, :3].T
    nlen = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = np.where(nlen > 1e-9, nrm / np.maximum(nlen, 1e-9), np.array([0.0, 1.0, 0.0], np.float32))
    return pos.astype(np.float32), nrm.astype(np.float32)


def extra_model_items(cfg, tex_pool, materials, seen_mat_names):
    """`extraModels`: [{`kn5`, `nodes` (regex of node names), optional `hideTextures`}], meshes drawn from another of the
    mod's models (the props of a layout dressed for an event), never physics. Each mesh is tagged with its file
    (`fromModel`), which keeps it in nodes of its own"""
    items = []
    for spec in cfg.get('extraModels', ()):
        kf = spec['kn5']
        t_dict, mats, nodes = read_kn5_full(os.path.join(cfg['base_dir'], kf))
        moff = merge_kn5_assets(t_dict, mats, kf, tex_pool, materials, seen_mat_names)
        n_items = n_tris = 0
        for nd in nodes:
            m = nd['mesh']
            if m is None or not re.search(spec['nodes'], nd['name']):
                continue
            mat = mats[m['mat']]
            if not (nd['active'] and m['visible'] and m['renderable']) or mat['shader'].lower() == 'ksgrass':
                continue
            if spec.get('hideTextures') and re.search(spec['hideTextures'], mat['maps'].get('txDiffuse', ''), re.I):
                continue
            pos, nrm = world_mesh(nd)
            items.append({
                'name': nd['name'],
                'pos': pos,
                'nrm': nrm,
                'uv': m['uv'].astype(np.float32),
                'idx': m['idx'],
                'mat': m['mat'] + moff,
                'transparent': m['transparent'],
                'physics': None,
                'matName': mat['name'],
                'fromModel': kf,
            })
            n_items += 1
            n_tris += len(m['idx']) // 3
        log(f'  {kf}: {n_items} meshes ({n_tris} triangles) of its props drawn')
    return items


def drift_atlas(images):
    """One image of DRIFT_TILE px tiles, 8 to a row; returns it and each tile's (x, y) in px"""
    cols = min(8, len(images))
    rows = math.ceil(len(images) / cols)
    inner = DRIFT_TILE - 2 * DRIFT_GUTTER
    atlas = Image.new('RGB', (cols * DRIFT_TILE, rows * DRIFT_TILE))
    corners = []
    for k, im in enumerate(images):
        a = np.asarray(im.convert('RGB').resize((inner, inner), Image.LANCZOS))
        a = np.pad(a, ((DRIFT_GUTTER, DRIFT_GUTTER), (DRIFT_GUTTER, DRIFT_GUTTER), (0, 0)), mode='wrap')
        corners.append(((k % cols) * DRIFT_TILE, (k // cols) * DRIFT_TILE))
        atlas.paste(Image.fromarray(a), corners[-1])
    return atlas, corners


def drifting_object_items(cfg, tex_pool, materials, seen_mat_names):
    """`driftingObjects`: a models ini whose DYNAMIC_OBJECT_n sections float objects over the circuit. Assetto Corsa
    starts each at RND_POS_CENTER plus a random offset within +-RND_POS_RANGE, and moves it in a straight line for the
    whole session at RND_VEL_BASE plus a random +-RND_VEL_RANGE (m, m/s, x y z). Each is drawn at its centre with its
    vertices tagged with a slot (`_DRIFT`); the node's `drift` extras give every slot's ranges, and
    src/lib/render/drifting-objects.ts draws the random values and moves them. Objects with the same mesh (a fleet of
    balloons in their own liveries) become one mesh over an atlas of their diffuse textures, one draw call. Their ksFlags
    meshes (a balloon's burner flame, a few cm across) are left out, and they cast no shadow"""
    base = cfg['base_dir']
    cp = parse_ac_ini(os.path.join(base, cfg['driftingObjects']))
    secs = sorted((s for s in cp.sections() if re.match(r'^DYNAMIC_OBJECT_\d+$', s)), key=lambda s: int(s.rsplit('_', 1)[1]))
    kn5_cache = {}
    objects = []
    for sec in secs:
        c = cp[sec]
        f = c.get('FILE', '').strip()
        if not f or float(c.get('PROBABILITY', '100')) <= 0 or not os.path.exists(os.path.join(base, f)):
            continue

        def vec(key):
            return [float(x) for x in c.get(key, '0,0,0').split(',')]

        # Only the RANDOM modes are known (forum notes); any other mode is drawn still at its centre
        pos_random = c.get('POS_MODE', 'RANDOM').strip().upper() == 'RANDOM'
        vel_random = c.get('VEL_MODE', 'RANDOM').strip().upper() == 'RANDOM'
        if not (pos_random and vel_random):
            log(f'  {sec}: POS_MODE/VEL_MODE other than RANDOM, drawn still at RND_POS_CENTER')
        if f not in kn5_cache:
            t_dict, mats, nodes = read_kn5_full(os.path.join(base, f))
            meshes = []
            for nd in nodes:
                m = nd['mesh']
                if m is None or not (nd['active'] and m['visible'] and m['renderable']):
                    continue
                if mats[m['mat']]['shader'].lower() == 'ksflags':
                    continue
                pos, nrm = world_mesh(nd)
                meshes.append({'pos': pos, 'nrm': nrm, 'uv': m['uv'].astype(np.float32), 'idx': m['idx'],
                               'mat': mats[m['mat']], 'tex': t_dict})
            kn5_cache[f] = meshes
        objects.append({
            'file': f,
            'center': np.array(vec('RND_POS_CENTER'), np.float32),
            'drift': {
                'range': vec('RND_POS_RANGE') if pos_random else [0.0, 0.0, 0.0],
                'velBase': vec('RND_VEL_BASE') if vel_random else [0.0, 0.0, 0.0],
                'velRange': vec('RND_VEL_RANGE') if vel_random else [0.0, 0.0, 0.0],
            },
            'meshes': kn5_cache[f],
        })
    if len(objects) > DRIFT_SLOTS:
        raise SystemExit(f'driftingObjects: {len(objects)} objects, the game has {DRIFT_SLOTS} slots')

    # A fleet: one-mesh objects whose mesh is the same, each with its own diffuse texture
    def shape_key(o):
        if len(o['meshes']) != 1:
            return None
        ms = o['meshes'][0]
        return (len(ms['pos']), ms['pos'].tobytes(), ms['uv'].tobytes(), ms['idx'].tobytes())

    groups = {}
    for slot, o in enumerate(objects):
        key = shape_key(o)
        groups.setdefault(key if key is not None else ('one', slot), []).append(slot)

    items = []
    for key, slots in groups.items():
        fleet = key[0] != 'one' and len(slots) > 1
        if fleet:
            ms0 = objects[slots[0]]['meshes'][0]
            images = [decode_rgba(objects[s]['meshes'][0]['tex'][objects[s]['meshes'][0]['mat']['maps']['txDiffuse']])
                      for s in slots]
            atlas, corners = drift_atlas(images)
            stem = os.path.splitext(objects[slots[0]]['file'])[0]
            tname = f'drift_atlas_{stem}.png'
            buf = io.BytesIO()
            atlas.save(buf, 'PNG')
            tex_pool[tname] = buf.getvalue()
            materials.append({'name': f'Drift_{stem}_atlas', 'shader': 'ksPerPixel', 'blend': 0, 'alpha_tested': False,
                              'props': {}, 'maps': {'txDiffuse': tname}, 'maxTex': max(atlas.size)})
            mat_i = len(materials) - 1
            # Shift the UVs by whole tiles of the image (the same texels when wrapped) to sit around 0..1; the border
            # covers what is left past it
            uv = ms0['uv'].astype(np.float64)
            uv = uv - np.floor((uv.min(0) + uv.max(0)) / 2)
            inner = DRIFT_TILE - 2 * DRIFT_GUTTER
            over = max(float(-uv.min()), float(uv.max() - 1), 0.0) * inner
            if over > DRIFT_GUTTER:
                log(f'  driftingObjects: {stem} UVs run {over:.0f} px past their tile, clamped')
                uv = np.clip(uv, -DRIFT_GUTTER / inner, 1 + DRIFT_GUTTER / inner)
            W, H = atlas.size
            parts = []
            for k, s in enumerate(slots):
                x0, y0 = corners[k]
                uv_a = np.stack([(x0 + DRIFT_GUTTER + uv[:, 0] * inner) / W, (y0 + DRIFT_GUTTER + uv[:, 1] * inner) / H], 1)
                parts.append((s, ms0['pos'] + objects[s]['center'], ms0['nrm'], uv_a, ms0['idx']))
            pieces = [(f'Drift_{stem}_fleet', mat_i, parts)]
        else:
            pieces = []
            for s in slots:
                o = objects[s]
                stem = os.path.splitext(o['file'])[0]
                for j, ms in enumerate(o['meshes']):
                    mat = dict(ms['mat'], maps=dict(ms['mat']['maps']))
                    moff = merge_kn5_assets({t: ms['tex'][t] for t in mat['maps'].values() if t in ms['tex']}, [mat],
                                            o['file'], tex_pool, materials, seen_mat_names)
                    pieces.append((f'Drift_{stem}_{j}', moff, [(s, ms['pos'] + o['center'], ms['nrm'], ms['uv'], ms['idx'])]))
        for name, mat_i, parts in pieces:
            pos, nrm, uvs, idx, drift = [], [], [], [], []
            nv = 0
            for s, p, n, u, ix in parts:
                pos.append(p)
                nrm.append(n)
                uvs.append(u)
                idx.append(ix.astype(np.uint32) + nv)
                drift.append(np.full(len(p), (s + 0.5) / DRIFT_SLOTS, np.float32))
                nv += len(p)
            slot_list = sorted({s for s, *_ in parts})
            items.append({
                'name': name,
                'pos': np.concatenate(pos).astype(np.float32),
                'nrm': np.concatenate(nrm).astype(np.float32),
                'uv': np.concatenate(uvs).astype(np.float32),
                'idx': np.concatenate(idx),
                'mat': mat_i,
                'transparent': False,
                'physics': None,
                'matName': materials[mat_i]['name'],
                'drift': np.concatenate(drift),
                'ownNode': True,
                'nodeExtras': {
                    'castShadow': False,
                    'drift': [{'slot': s, 'file': objects[s]['file'], **objects[s]['drift']} for s in slot_list],
                },
            })
    n_fleet = sum(len(it['nodeExtras']['drift']) for it in items if it['name'].endswith('_fleet'))
    log(f"  {cfg['driftingObjects']}: {len(objects)} drifting objects ({n_fleet} drawn over one atlas), "
        f'{sum(len(it["idx"]) for it in items) // 3} triangles in {len(items)} meshes')
    return items


def parse_groove_ini(data_dir):
    cp = parse_ac_ini(os.path.join(data_dir, 'groove.ini'))
    grooves = {}
    for sec in cp.sections():
        if sec.startswith('GROOVE_'):
            mname = cp[sec].get('NAME', '').strip()
            if mname:
                grooves[mname] = {
                    'min': float(cp[sec].get('MIN', '0.0').split()[0]),
                    'max': float(cp[sec].get('MAX', '1.0').split()[0]),
                    'mult': float(cp[sec].get('MULT', '1.0').split()[0]),
                }
    return grooves


def classify_physics_node(name):
    """Returns physics category ('road'|'kerb'|'runoff'|'gravel'|'grass'|'wall'|'pit'|None) from AC node name."""
    if re.match(r'^\d+_?(CURB|KERB|CUBES|CARPET)', name, re.I):
        return 'kerb'
    if re.match(r'^\d+_?PIT', name, re.I):
        return 'pit'
    if re.match(r'^\d+_?(R[O0]AD|TARMAC|ASPHALT|TRACK|APRON|WHITELINES|BLACKLINES|LINES|2R\b)', name, re.I):
        return 'road'
    if re.match(r'^\d+_?(RUN[O0]FF|RUN\b|CONCRETE|CONCRET|DRAIN)', name, re.I):
        return 'runoff'
    if re.match(r'^\d+_?(GRAVEL|SAND)', name, re.I):
        return 'gravel'
    if re.match(r'^\d+_?(GRASS)', name, re.I):
        return 'grass'
    if re.match(r'^\d+_?(WALL|GUARDRAIL|SEEWALL|FENCE)', name, re.I):
        return 'wall'
    return None


def is_ac_editor_marker(name):
    # AC_REVERB_*: the boxes that mark AC's sound reverb zones (under a bridge), which a mod may leave visible
    return bool(re.match(r'^AC_(AB|AUDIO|CHECKPOINT|HOTLAP|OB|PIT|REVERB|START|TIME)', name, re.I))


def is_semaphore_node(name):
    return bool(re.match(r'^(AC_SEMAPHORE_(RED|GREEN)\d+|startlight_SUB1)$', name, re.I))


def read_ai_lane(path):
    data = open(path, 'rb').read()
    ver, n, _, _ = struct.unpack_from('<4i', data, 0)
    pts = np.frombuffer(data, [('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('s', '<f4'), ('id', '<i4')], count=n, offset=16)
    ex_off = 20 + n * 20
    ex = None
    if len(data) >= ex_off + n * 18 * 4:
        ex = np.frombuffer(data, '<f4', count=n * 18, offset=ex_off).reshape(n, 18)
    return pts, ex


def parse_surface_overrides(data_dir):
    """Map AC data/surfaces.ini onto LibreCorsa's metadata.surfaceTable overrides."""
    cp = parse_ac_ini(os.path.join(data_dir, 'surfaces.ini'))
    out = {}
    for sec in cp.sections():
        key = cp[sec].get('KEY', '').strip().upper()
        if not key:
            continue
        try:
            fric = float(cp[sec].get('FRICTION', '1.0').split()[0])
            sin_h = float(cp[sec].get('SIN_HEIGHT', '0.0').split()[0])
            sin_l = float(cp[sec].get('SIN_LENGTH', '0.0').split()[0])
            vib = float(cp[sec].get('VIBRATION_GAIN', '0.0').split()[0])
            valid = int(cp[sec].get('IS_VALID_TRACK', '1').split()[0]) == 1
        except Exception:
            continue
        if key in ('KERB', 'CURB') and 'kerb' not in out:
            out['kerb'] = {
                'friction': round(min(1.0, max(0.88, fric)), 3),
                # AC kerbs leave SIN_HEIGHT at 0 and the fitted kerb meshes are smooth: 2 mm keeps them felt. The old
                # 7-12 mm floor lifted the wheels off for a third of the time on every kerb
                'bumpHeightM': round(min(0.012, sin_h if sin_h > 0 else 0.002), 4),
                'bumpLengthM': round(min(1.2, max(0.4, sin_l if sin_l > 0 else 0.65)), 2),
                'vibration': round(min(1.5, max(1.0, vib if vib > 0 else 1.0)), 2),
                'validTrack': True,
            }
        elif key in ('SAND', 'GRAVEL') and 'gravel' not in out:
            out['gravel'] = {
                'friction': round(min(0.65, max(0.35, fric * 0.6)), 3),
                'validTrack': False,
            }
        elif key == 'GRASS' and 'grass' not in out:
            out['grass'] = {
                'friction': round(min(0.7, max(0.45, fric)), 3),
                'validTrack': valid and False,
            }
    if 'kerb' not in out:
        out['kerb'] = {
            'friction': 0.90,
            'bumpHeightM': 0.002,
            'bumpLengthM': 0.65,
            'vibration': 1.0,
            'validTrack': True,
        }
    return out


def parse_drs_zones(data_dir, s, k, L):
    cp = parse_ac_ini(os.path.join(data_dir, 'drs_zones.ini'))
    zones = []
    for sec in cp.sections():
        if sec.startswith('ZONE_'):
            try:
                det = float(cp[sec].get('DETECTION', '0').split()[0]) % 1.0
                st = float(cp[sec].get('START', '0').split()[0]) % 1.0
                en = float(cp[sec].get('END', '0').split()[0]) % 1.0
                zones.append({
                    'id': sec,
                    'detection': round(det, 4),
                    'start': round(st, 4),
                    'end': round(en, 4),
                })
            except Exception:
                pass
    return zones if zones else bt.drs_zones(s, k, L)


def parse_cameras(data_dir, P, rgt2, width, wall, off, L, frac_map=None):
    """Parse AC cameras.ini (choosing the main TV camera file) and convert into LibreCorsa world frame. `frac_map`: an AC
    lap fraction to one of the built loop (a point-to-point course's loop is not the AI lane)"""
    cams = []
    cam_file = os.path.join(data_dir, 'cameras.ini')
    if os.path.exists(cam_file):
        cp = parse_ac_ini(cam_file)
        for sec in cp.sections():
            if not sec.startswith('CAMERA_'):
                continue
            try:
                pos_s = [float(x) for x in cp[sec].get('POSITION', '').replace(',', ' ').split()[:3]]
                if len(pos_s) != 3:
                    continue
                pos = np.array(pos_s, float) - off
                fwd_s = [float(x) for x in cp[sec].get('FORWARD', '0,0,1').replace(',', ' ').split()[:3]]
                fwd = np.array(fwd_s if len(fwd_s) == 3 else [0.0, 0.0, 1.0], float)
                fn = np.linalg.norm(fwd)
                if fn < 1e-4:
                    d2 = np.linalg.norm(P[:, [0, 2]] - pos[[0, 2]], axis=1)
                    i_near = (int(np.argmin(d2)) + 4) % len(P)
                    fwd = P[i_near] - pos
                    fn = np.linalg.norm(fwd)
                fwd = fwd / max(fn, 1e-6)
                up_s = [float(x) for x in cp[sec].get('UP', '0,1,0').replace(',', ' ').split()[:3]]
                up = np.array(up_s if len(up_s) == 3 else [0.0, 1.0, 0.0], float)
                up = up / max(np.linalg.norm(up), 1e-6)
                min_fov = float(cp[sec].get('MIN_FOV', '12').split()[0])
                max_fov = float(cp[sec].get('MAX_FOV', '48').split()[0])
                in_p = float(cp[sec].get('IN_POINT', '0').split()[0])
                out_p = float(cp[sec].get('OUT_POINT', '1').split()[0])
                if frac_map is not None:
                    in_p, out_p = frac_map(in_p), frac_map(out_p)
                cname = cp[sec].get('NAME', '').strip() or f'TV {len(cams) + 1}'
                cams.append({
                    'name': cname,
                    'position': [round(float(v), 3) for v in pos],
                    'forward': [round(float(v), 5) for v in fwd],
                    'up': [round(float(v), 5) for v in up],
                    'minFov': round(max(5.0, min(min_fov, max_fov)), 1),
                    'maxFov': round(min(75.0, max(min_fov, max_fov, 25.0)), 1),
                    'inPoint': round(float(np.clip(in_p, 0.0, 1.0)), 4),
                    'outPoint': round(float(np.clip(out_p, 0.0, 1.0)), 4),
                })
            except Exception:
                continue
    n = len(P)
    if len(cams) < 6:
        need = 12 - len(cams)
        for c in range(need):
            i = int(round((c + 0.5) * n / need)) % n
            side = 1.0 if wall[i, 1] >= wall[i, 0] else -1.0
            lat_off = min(wall[i, 1 if side > 0 else 0] + 4.0, width[i] / 2 + 25.0)
            p = P[i] + np.array([rgt2[i, 0] * side * lat_off, 9.0, rgt2[i, 1] * side * lat_off])
            look = P[(i + 6) % n]
            f = look - p
            f /= max(np.linalg.norm(f), 1e-6)
            cams.append({
                'name': f'TV {len(cams) + 1}',
                'position': [round(float(v), 3) for v in p],
                'forward': [round(float(v), 5) for v in f],
                'up': [0, 1, 0],
                'minFov': 12,
                'maxFov': 48,
                'inPoint': round(c / need, 4),
                'outPoint': round((c + 1) / need, 4),
            })
    return cams


def apply_turn_names(turns, data_dir, L, cfg, to_s=None):
    """Apply corner / section names from AC data/sections.ini or cfg['turns_override']. `to_s`: an AC lap fraction
    to m along the built loop (a point-to-point course's loop is not the AI lane)"""
    to_s = to_s or (lambda f: f * L)
    named = []
    if cfg.get('turns_override'):
        named = [(float(s0), float(s0), text) for s0, text in cfg['turns_override']]
    else:
        cp = parse_ac_ini(os.path.join(data_dir, 'sections.ini'))
        for sec in cp.sections():
            if not sec.startswith('SECTION_'):
                continue
            text = cp[sec].get('TEXT', '').strip()
            if not text:
                continue
            try:
                inp = to_s(float(cp[sec].get('IN', '0').split()[0]))
                outp = to_s(float(cp[sec].get('OUT', '0').split()[0]))
                if re.search(r'\bstraight\b', text, re.I) and not re.search(r'corner|turn|curve|bend|hairpin|chicane|shoe', text, re.I):
                    continue
                # `sectionSkip`: a regex for the straights of a sections.ini in another language
                if cfg.get('sectionSkip') and re.search(cfg['sectionSkip'], text, re.I):
                    continue
                # `sectionStrip`: a regex cut from each name (a mod that numbers them: "T1: Cat Corner")
                if cfg.get('sectionStrip'):
                    text = re.sub(cfg['sectionStrip'], '', text).strip()
                # `sectionNames`: {text: name} for names the mod spells without their diacritics
                text = cfg.get('sectionNames', {}).get(text, text)
                named.append((inp, outp, text))
            except Exception:
                continue
    if not named or not turns:
        return turns
    for t in turns:
        sa = float(t['sApprox'])
        best = None
        for inp, outp, text in named:
            if outp < inp:
                # A section over the start line (or a point-to-point one that `to_s` wraps round the loop): it runs on
                # past L, so its end and middle are taken on that far side
                outp += L
                mid = 0.5 * (inp + outp)
                inside = sa >= inp or sa + L <= outp
                ends = (abs(sa - inp), abs(sa + L - outp))
            else:
                mid = 0.5 * (inp + outp)
                inside = inp <= sa <= outp
                ends = (abs(sa - inp), abs(sa - outp))
            if inside:
                d = 0.0
            else:
                d = min(*ends, abs(sa - mid), abs(sa - mid + L), abs(sa - mid - L))
            if d < 140.0 and (best is None or d < best[0]):
                best = (d, text)
        if best is not None:
            t['name'] = best[1]
            t['complexName'] = best[1]
    return turns


def read_ac_markers(path):
    """World positions of a layout's AC_* marker nodes: start and finish gates, split-time gates, grid and pit spots"""
    _, _, nodes = read_kn5_full(path)
    return {nd['name']: np.asarray(nd['world'][:3, 3], float) for nd in nodes if re.match(r'^AC_', nd['name'])}


def polyline_s(P, q):
    """Arc length along the open polyline P (n x 2) of its point nearest q"""
    d = np.diff(P, axis=0)
    l2 = np.maximum((d * d).sum(1), 1e-12)
    t = np.clip(((q - P[:-1]) * d).sum(1) / l2, 0.0, 1.0)
    foot = P[:-1] + d * t[:, None]
    k = int(np.argmin(np.linalg.norm(foot - q, axis=1)))
    seg = np.sqrt(l2)
    return float(np.concatenate([[0.0], np.cumsum(seg)])[k] + t[k] * seg[k])


def polyline_at(P, s_query):
    """Points at arc lengths `s_query` along the open polyline P"""
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    sc = np.concatenate([[0.0], np.cumsum(seg)])
    return np.stack([np.interp(s_query, sc, P[:, k]) for k in range(P.shape[1])], 1)


def trace_road_on(R, road, soup_road, p, t, y, length, step=2.0):
    """Follows the road raster from `p` (heading `t`, height `y`) for up to `length` m, centring on the road as it
    goes: the road on past the end of an AI lane that stops at a hill climb's finish line. Returns points, heights
    and widths"""
    pts, ys, ws = [], [], []
    t = t / np.linalg.norm(t)
    for _ in range(int(length / step)):
        # Straight on, else turned a little more each try either way (a bend sharper than the heading's smoothing)
        for turn in (0.0, 0.14, -0.14, 0.28, -0.28, 0.42, -0.42, 0.56, -0.56):
            c, sn = math.cos(turn), math.sin(turn)
            td = np.array([t[0] * c - t[1] * sn, t[0] * sn + t[1] * c])
            q = p + td * step
            rg = np.array([-td[1], td[0]])
            ed = cl.edge_distances(R, road, q[None], rg[None], max_m=15.0)[0]
            if ed[0] + ed[1] >= 3.0:
                break
        else:
            break
        q = q + rg * float(np.clip((ed[1] - ed[0]) / 2, -0.6, 0.6))
        h = soup_road.height_near(q[0], q[1], y, 3.0)
        if h is not None:
            y = h[0]
        tn = (q - p) / max(float(np.linalg.norm(q - p)), 1e-9)
        t = 0.6 * t + 0.4 * tn
        t /= np.linalg.norm(t)
        p = q
        pts.append(q)
        ys.append(y)
        ws.append(min(float(ed[0] + ed[1]), 22.0))
    return np.array(pts).reshape(-1, 2), np.array(ys), np.array(ws)


def dead_leg(road_xz, E, tE, S, tS, clear_m, lead_m, res=2.0):
    """The stretch with no road that closes a point-to-point course into a loop: on from the road's end E along its
    heading for `lead_m`, round the course `clear_m` from it, and in to the road's start S from behind. Away from its
    two ends it never comes nearer the road than that, so a car on the road is never placed on it. Returns the
    corners of the path from E to S, both left out"""
    E1 = E + tE * lead_m
    S1 = S - tS * lead_m
    lo = np.minimum(road_xz.min(0), np.minimum(E1, S1)) - clear_m - 60.0
    hi = np.maximum(road_xz.max(0), np.maximum(E1, S1)) + clear_m + 60.0
    W, H = (np.ceil((hi - lo) / res)).astype(int) + 1
    img = np.full((H, W), 255, np.uint8)
    cv2.polylines(img, [np.round((road_xz - lo) / res).astype(np.int32)], False, 0, 1)
    dist = cv2.distanceTransform(img, cv2.DIST_L2, 5) * res
    cs, _ = cv2.findContours((dist <= clear_m).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    C = max(cs, key=len)[:, 0, :].astype(float) * res + lo
    i1 = int(np.argmin(np.linalg.norm(C - E1, axis=1)))
    i2 = int(np.argmin(np.linalg.norm(C - S1, axis=1)))
    fwd = np.roll(C, -i1, 0)[: ((i2 - i1) % len(C)) + 1]
    bwd = np.roll(C[::-1], -(len(C) - 1 - i1), 0)[: ((i1 - i2) % len(C)) + 1]
    arc = fwd if len(fwd) <= len(bwd) else bwd
    return np.vstack([E1[None], arc, S1[None]])


def p2p_loop(cfg, base, lane_xz, lane_w, lane_y, R, road, T_road):
    """A point-to-point course (`pointToPoint`, a hill climb) as the loop the rest of the build and the game work on.
    The road runs from `preStartM` before the start gate (AC_AB_START_*) to `runOutM` past the finish gate
    (AC_AB_FINISH_*), traced on along the road raster where the AI lane stops short, and a dead stretch round the
    course (dead_leg) closes it. Returns the course's marks and the loop's points, widths and heights"""
    mk = read_ac_markers(os.path.join(base, cfg['markersKn5']))

    def gate(name):
        return 0.5 * (mk[name + '_L'] + mk[name + '_R'])[[0, 2]]

    start, finish = gate('AC_AB_START'), gate('AC_AB_FINISH')
    splits = [gate(f'AC_TIME_{k}') for k in range(1, 9) if f'AC_TIME_{k}_L' in mk and f'AC_TIME_{k}_R' in mk]
    seg = np.linalg.norm(np.diff(lane_xz, axis=0), axis=1)
    lane_s = np.concatenate([[0.0], np.cumsum(seg)])
    lane_len = float(lane_s[-1])
    sS, sF = polyline_s(lane_xz, start), polyline_s(lane_xz, finish)
    if sF <= sS + 100:
        raise SystemExit(f'finish gate {sF:.0f} m along the lane is not after the start gate {sS:.0f} m')
    pre, run_out = float(cfg.get('preStartM', 60.0)), float(cfg.get('runOutM', 250.0))
    s_lo, s_hi = max(0.0, sS - pre), min(lane_len, sF + run_out)
    q = np.arange(s_lo, s_hi, 1.0)
    xz = polyline_at(lane_xz, q)
    w = np.interp(q, lane_s, lane_w)
    y = np.interp(q, lane_s, lane_y)
    if sF + run_out > s_hi + 5.0:
        soup_road = srf.TriSoup(T_road, np.zeros(len(T_road), np.int32), np.zeros((len(T_road), 3), np.float32))
        # On the road as modelled, not as the barriers cut it: one may stand across the road past the finish, where
        # the car stops against it in the run-out
        R2, _, road2 = cl.build_masks(T_road, np.zeros(len(T_road), np.int32), [0], [])
        ex, ey, ew = trace_road_on(R2, road2, soup_road, xz[-1], xz[-1] - xz[-8], y[-1], sF + run_out - s_hi)
        log(f'  run-out: {len(ex) * 2.0:.0f} m traced along the road past the end of the AI lane')
        xz, y, w = np.vstack([xz, ex]), np.concatenate([y, ey]), np.concatenate([w, ew])
    road_len = float(np.sum(np.linalg.norm(np.diff(xz, axis=0), axis=1)))
    E, S = xz[-1], xz[0]
    tE = (xz[-1] - xz[-8]) / np.linalg.norm(xz[-1] - xz[-8])
    tS = (xz[7] - xz[0]) / np.linalg.norm(xz[7] - xz[0])
    lead = float(cfg.get('deadLegLeadM', 80.0))
    corners = np.vstack([E[None], dead_leg(xz, E, tE, S, tS, float(cfg.get('deadLegClearM', 150.0)), lead), S[None]])
    leg_len = float(np.sum(np.linalg.norm(np.diff(corners, axis=0), axis=1)))
    qq = np.arange(2.0, leg_len - 1.0, 2.0)
    leg = polyline_at(corners, qq)
    away = (qq > lead + 30.0) & (qq < leg_len - lead - 30.0)
    clear = float(cKDTree(xz).query(leg[away])[0].min()) if away.any() else 0.0
    log(f'  road {road_len:.0f} m ({sS - s_lo:.0f} m before the start, run {sF - sS:.0f} m), dead stretch {leg_len:.0f} m, '
        f'at least {clear:.0f} m from the road away from its ends')
    if clear < 40.0:
        raise SystemExit('the dead stretch passes too close to the road: raise deadLegClearM or deadLegLeadM')
    loop = np.vstack([xz, leg])
    loop_w = np.concatenate([w, np.full(len(leg), float(np.median(w)))])
    loop_y = np.concatenate([y, np.interp(qq, [0.0, leg_len], [y[-1], y[0]])])
    i_start = int(round(sS - s_lo))
    marks = {
        'start': start,
        'ahead': xz[min(i_start + 12, len(xz) - 1)],
        'finish': finish,
        'end': E,
        'roadStart': S,
        'finishS': sF - sS,
        'endS': road_len - (sS - s_lo),
        'preM': sS - s_lo,
        'splits': [(p, polyline_s(lane_xz, p) - sS) for p in splits],
        'laneS0': sS,
        'laneL': lane_len,
    }
    return marks, loop, loop_w, loop_y


def p2p_marks(p2p, xz, L):
    """Where the finish gate, the split gates, the road's end and its start are on the built loop (m), and the dead
    stretch's samples"""
    n = len(xz)
    sg = np.arange(n) * (L / n)
    tan = cl.tangents(xz)

    def at(pt, s_est, win=150.0):
        d = np.abs(((sg - s_est + L / 2) % L) - L / 2)
        cand = np.where(d < win)[0]
        i = int(cand[np.argmin(np.linalg.norm(xz[cand] - pt, axis=1))])
        return float((sg[i] + np.dot(pt - xz[i], tan[i])) % L)

    fin = at(p2p['finish'], p2p['finishS'])
    end = at(p2p['end'], p2p['endS'])
    st = at(p2p['roadStart'], L - p2p['preM'])
    splits = sorted(at(pt, e) for pt, e in p2p['splits'])
    dead = (sg > end) & (sg < st)
    return fin, end, st, splits, dead


def build_pit_lane(layout_path, xz, off, L, ds):
    pit_path = os.path.join(layout_path, 'ai', 'pit_lane.ai')
    if not os.path.exists(pit_path):
        return {'entryS': round(float(L - 300), 1), 'exitS': 250, 'widthM': 10, 'centerline': []}
    pts, _ = read_ai_lane(pit_path)
    p3 = np.stack([pts['x'], pts['y'], pts['z']], 1).astype(float)
    return pit_lane_from_points(p3, xz, off, L, ds)


def pit_lane_from_points(p3, xz, off, L, ds):
    """The pit lane from its centreline points (N, 3), entry first"""
    tree = cKDTree(xz)
    _, i_entry = tree.query(p3[0, [0, 2]])
    _, i_exit = tree.query(p3[-1, [0, 2]])
    step = max(1, int(round(len(p3) / 80)))
    cl_pts = [[round(float(v[0] - off[0]), 2), round(float(v[1] - off[1]), 2), round(float(v[2] - off[2]), 2)]
              for v in p3[::step]]
    return {
        'entryS': round(float(i_entry * ds), 1),
        'exitS': round(float(i_exit * ds), 1),
        'widthM': 10,
        'centerline': cl_pts,
    }


def decode_rgba(raw_bytes):
    im = Image.open(io.BytesIO(raw_bytes))
    im.load()
    return im.convert('RGBA')


def multilayer_tint(mat, tex_pool, img_cache):
    """For ksMultilayer* shaders whose txDiffuse is an uncoloured white carrier (like Spielberg's grass_base1.dds),
    compute the average detail colour weighted by txMask so the glTF PBR material renders in its true ground colour."""
    shader = mat['shader'].lower()
    if 'multilayer' not in shader:
        return None
    maps = mat['maps']
    td = maps.get('txDiffuse')
    if not td or td not in tex_pool:
        return None

    def get_small_rgb(tname):
        if tname not in img_cache:
            try:
                im = decode_rgba(tex_pool[tname]).resize((64, 64), Image.BILINEAR)
                img_cache[tname] = np.asarray(im, np.float32)[..., :3] / 255.0
            except Exception:
                img_cache[tname] = None
        return img_cache[tname]

    base_rgb = get_small_rgb(td)
    if base_rgb is None:
        return None
    mean_base = base_rgb.mean((0, 1))
    # Only tint when txDiffuse is a bright neutral carrier (white/grey heightmap/AO carrier)
    if mean_base.mean() < 0.72 or (mean_base.max() - mean_base.min()) > 0.12:
        return None
    slots = [maps.get(k) for k in ('txDetailR', 'txDetailG', 'txDetailB', 'txDetailA')]
    det_cols = []
    for s in slots:
        if s and s in tex_pool:
            rgb = get_small_rgb(s)
            det_cols.append(rgb.mean((0, 1)) if rgb is not None else np.array([0.5, 0.5, 0.5]))
        else:
            det_cols.append(None)
    if not any(c is not None for c in det_cols):
        return None
    weights = np.array([0.45, 0.25, 0.20, 0.10], float)
    tmask = maps.get('txMask')
    if tmask and tmask in tex_pool:
        try:
            m_im = decode_rgba(tex_pool[tmask]).resize((64, 64), Image.BILINEAR)
            mw = np.asarray(m_im, np.float32).mean((0, 1))
            if mw.sum() > 1e-3:
                weights = mw
        except Exception:
            pass
    num = np.zeros(3, float)
    den = 0.0
    for w, c in zip(weights, det_cols):
        if c is not None and w > 0:
            num += w * c
            den += w
    if den <= 1e-6:
        return None
    col = (num / den) * mean_base * float(mat['props'].get('magicMult', 1.0))
    col = np.clip(col, 0.08, 1.0)
    return [round(float(col[0]), 4), round(float(col[1]), 4), round(float(col[2]), 4), 1.0]


def bake_multilayer(mat, tex_pool, img_cache):
    """For a ksMultilayer* material whose look comes from a large txMask (LilSki's terrain: a blank `null.dds` carrier,
    a 4096 px mask blending sand, sand and grass details), the colour AC draws, baked into one texture: the carrier
    times the mask-weighted mean colour of each detail texture. The details' fine grain is lost, the mask's patches of
    sand, dirt and grass are kept. Returns PNG bytes, or None when the material has no such mask"""
    if 'multilayer' not in mat['shader'].lower():
        return None
    maps = mat['maps']
    td, tm = maps.get('txDiffuse'), maps.get('txMask')
    if not td or not tm or td not in tex_pool or tm not in tex_pool:
        return None
    try:
        mask_im = decode_rgba(tex_pool[tm])
    except Exception:
        return None
    if max(mask_im.size) < 512:
        return None
    # Colour and alpha are resized apart: Pillow premultiplies an RGBA image's colour by its alpha when resizing it, and
    # a mask's alpha is a fourth weight, mostly 0 (Riverside's), not a coverage
    k = max(mask_im.size) / MAX_TEX
    size = (max(1, round(mask_im.size[0] / k)), max(1, round(mask_im.size[1] / k))) if k > 1 else mask_im.size
    mask = np.concatenate([
        np.asarray(mask_im.convert('RGB').resize(size, Image.BILINEAR), np.float32),
        np.asarray(mask_im.getchannel('A').resize(size, Image.BILINEAR), np.float32)[..., None],
    ], -1) / 255.0
    det = []
    for slot in ('txDetailR', 'txDetailG', 'txDetailB', 'txDetailA'):
        t = maps.get(slot)
        if t and t in tex_pool:
            if t not in img_cache:
                try:
                    img_cache[t] = np.asarray(decode_rgba(tex_pool[t]).convert('RGB').resize((64, 64), Image.BILINEAR), np.float32) / 255.0
                except Exception:
                    img_cache[t] = None
            rgb = img_cache[t]
            det.append(rgb.mean((0, 1)) if rgb is not None else np.zeros(3))
        else:
            det.append(np.zeros(3))
    combined = sum(mask[..., c:c + 1] * det[c] for c in range(4))
    try:
        base_im = decode_rgba(tex_pool[td]).convert('RGB').resize((mask.shape[1], mask.shape[0]), Image.BILINEAR)
    except Exception:
        return None
    base = np.asarray(base_im, np.float32) / 255.0
    # Only a neutral base: there the colour is the details' (Watkins Glen's grass strips are a grey texture under green
    # details). A coloured base (its hills' 4k photo texture under grey grain details) is drawn as it is
    mean = base.reshape(-1, 3).mean(0)
    if (mean.max() - mean.min()) / max(mean.max(), 1e-3) > 0.15:
        return None
    # A 2x detail blend: carrier times details times two is what AC draws, as the mods' own preview shots show
    # (Riverside's dirt at about (190, 170, 130) from a 0.39 grey carrier and (228, 199, 168) sand)
    out = np.clip(2.0 * base * combined * float(mat['props'].get('magicMult', 1.0)), 0.0, 1.0)
    buf = io.BytesIO()
    Image.fromarray((out * 255.0 + 0.5).astype(np.uint8), 'RGB').save(buf, 'PNG')
    return buf.getvalue()


def ac_alpha_masked(mat, sh, cfg):
    """Whether an AC material draws as a cut-out (glTF MASK). An alpha-test shader (ksPerPixelAT…) is one, unless the
    track sets `blendedCutouts` and the material is set to blend without the alpha-test flag: Willow Springs lays its
    faint skidmarks that way, and cut out at 0.5 they drew as black blotches from afar and vanished up close"""
    if mat['alpha_tested'] or 'tree' in sh or 'grass' in sh:
        return True
    if 'perpixelat' in sh:
        return not (cfg and cfg.get('blendedCutouts') and mat['blend'] in (1, 2))
    return False


def encode_webp_tex(raw_bytes, keep_alpha, max_tex=MAX_TEX):
    im = Image.open(io.BytesIO(raw_bytes))
    im.load()
    if keep_alpha:
        im = im.convert('RGBA')
    else:
        im = im.convert('RGB')
    w, h = im.size
    k = max(w, h) / max_tex
    if k > 1:
        size = (max(1, round(w / k)), max(1, round(h / k)))
        if keep_alpha:
            # Colour and alpha apart: Pillow premultiplies colour by alpha when resizing RGBA, which blacks out the colour
            # under transparent texels (Watkins Glen's tso9.dds, mostly alpha 0, is also drawn opaque) and darkens the
            # edges of alpha-tested leaves
            rgb = im.convert('RGB').resize(size, Image.LANCZOS)
            im = Image.merge('RGBA', (*rgb.split(), im.getchannel('A').resize(size, Image.LANCZOS)))
        else:
            im = im.resize(size, Image.LANCZOS)
    out = io.BytesIO()
    # exact: keep the colour under transparent texels, which libwebp otherwise discards (same reason)
    im.save(out, 'WEBP', quality=82, method=4, alpha_quality=86, exact=keep_alpha)
    return out.getvalue()


def write_ac_glb(visual_items, tex_pool, materials, grooves, scale, off, extra_meshes, out_path, clip=4000.0,
                 double_sided_re=None, bake_masks=False, skip_bake=None, cfg=None):
    """Build a glTF 2.0 binary (GLB) directly from the AC visual meshes and generated physics colliders."""
    # 1. Group static visual meshes by (mat_idx, is_decal) while keeping semaphores and dynamic grooves separate
    special_nodes = []
    grouped = {}
    for item in visual_items:
        pos = item['pos']
        lo, hi = pos.min(0) * scale - off, pos.max(0) * scale - off
        if lo[0] > clip or hi[0] < -clip or lo[2] > clip or hi[2] < -clip:
            continue
        name = item['name']
        mat_idx = item['mat']
        mat = materials[mat_idx]
        sh = mat['shader'].lower()
        is_mask = ac_alpha_masked(mat, sh, cfg)
        is_decal = (mat['blend'] in (1, 2) or 'perpixelalpha' in sh) and not is_mask
        # `ownNode`: drawn as its own node, unmerged (the drifting objects, which carry a vertex attribute of their own)
        if is_semaphore_node(name) or name in grooves or item.get('ownNode'):
            special_nodes.append((name, item, mat_idx, is_decal, grooves.get(name)))
        else:
            # A mesh from another of the mod's models (`extraModels`) is merged only with others from it
            key = (mat_idx, is_decal, bool(item.get('keepShape')), item.get('fromModel'))
            grouped.setdefault(key, []).append(item)

    # Chunk grouped meshes into <= 65534 vertices per primitive
    merged_nodes = []
    for (mat_idx, is_decal, keep_shape, from_model), items in grouped.items():
        cur_p, cur_n, cur_uv, cur_idx = [], [], [], []
        v_count = 0
        chunk_id = 0

        def flush():
            nonlocal cur_p, cur_n, cur_uv, cur_idx, v_count, chunk_id
            if not cur_idx:
                return
            mname = (f"{materials[mat_idx]['name']}{'_shaped' if keep_shape else ''}"
                     f"{'_' + os.path.splitext(from_model)[0] if from_model else ''}_chunk{chunk_id}")
            chunk_id += 1
            merged_nodes.append((
                mname,
                {
                    'pos': np.concatenate(cur_p, 0),
                    'nrm': np.concatenate(cur_n, 0),
                    'uv': np.concatenate(cur_uv, 0),
                    'idx': np.concatenate(cur_idx, 0),
                    'keepShape': keep_shape,
                    'fromModel': from_model,
                },
                mat_idx,
                is_decal,
                None,
            ))
            cur_p, cur_n, cur_uv, cur_idx = [], [], [], []
            v_count = 0

        for it in items:
            nv = len(it['pos'])
            if nv > 65534:
                flush()
                merged_nodes.append((it['name'], it, mat_idx, is_decal, None))
                continue
            if v_count + nv > 65534:
                flush()
            cur_p.append(it['pos'])
            cur_n.append(it['nrm'])
            cur_uv.append(it['uv'])
            cur_idx.append(it['idx'].astype(np.uint32) + v_count)
            v_count += nv
        flush()

    all_visual = special_nodes + merged_nodes
    used_mats = sorted({m_idx for _, _, m_idx, _, _ in all_visual})
    mat_remap = {old: new for new, old in enumerate(used_mats)}

    # `bakeMultilayerMasks`: terrain drawn from a mask over a blank carrier gets the colour AC draws baked into its
    # diffuse (the road's materials are left alone: the game draws them with its own asphalt shader)
    if bake_masks:
        bake_cache = {}
        n_baked = 0
        for old_mi in used_mats:
            m = materials[old_mi]
            if m['name'] in (skip_bake or ()):
                continue
            png = bake_multilayer(m, tex_pool, bake_cache)
            if png is None:
                continue
            key = f"{m['name']}__baked.png"
            tex_pool[key] = png
            m['maps'] = {**m['maps'], 'txDiffuse': key}
            m['baked'] = True
            n_baked += 1
        log(f'  multilayer masks baked into {n_baked} materials')

    # Determine which textures are used and whether any user material requires alpha
    tex_alpha_need = {}
    # A material's `maxTex` lets its texture keep more than MAX_TEX px (the drifting objects' atlas)
    tex_max = {}
    for old_mi in used_mats:
        m = materials[old_mi]
        sh = m['shader'].lower()
        needs_alpha = (
            m['alpha_tested']
            or m['blend'] in (1, 2)
            or 'at' in sh
            or 'alpha' in sh
            or 'tree' in sh
            or 'grass' in sh
        )
        tname = m['maps'].get('txDiffuse')
        if tname and tname in tex_pool:
            tex_alpha_need[tname] = tex_alpha_need.get(tname, False) or needs_alpha
            tex_max[tname] = max(tex_max.get(tname, MAX_TEX), m.get('maxTex', MAX_TEX))

    chunks = []
    accessors = []

    def add_view(data, target=None, stride=None):
        chunks.append((data, target, stride))
        return len(chunks) - 1

    def put_acc(arr, comp, typ, target, normalized=False, minmax=False, stride=None):
        a = {
            'bufferView': add_view(arr.tobytes(), target, stride),
            'componentType': comp,
            'count': int(arr.shape[0]),
            'type': typ,
        }
        if normalized:
            a['normalized'] = True
        if minmax:
            a['min'] = arr.min(0).astype(float).tolist()
            a['max'] = arr.max(0).astype(float).tolist()
        accessors.append(a)
        return len(accessors) - 1

    # Encode textures to WebP
    img_cache = {}
    tex_to_gltf_idx = {}
    gltf_images = []
    gltf_textures = []
    gltf_samplers = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    raw_bytes_total = webp_bytes_total = 0
    for tname, needs_alpha in tex_alpha_need.items():
        raw = tex_pool[tname]
        raw_bytes_total += len(raw)
        try:
            webp = encode_webp_tex(raw, needs_alpha, tex_max[tname])
            mime = 'image/webp'
        except Exception as e:
            log(f'  tex {tname} fallback ({e})')
            webp, mime = raw, 'image/png'
        webp_bytes_total += len(webp)
        img_i = len(gltf_images)
        gltf_images.append({'bufferView': add_view(webp), 'mimeType': mime, 'name': tname})
        tex_i = len(gltf_textures)
        gltf_textures.append({'sampler': 0, 'extensions': {'EXT_texture_webp': {'source': img_i}}})
        tex_to_gltf_idx[tname] = tex_i
    log(f'  textures: {len(gltf_images)} used ({raw_bytes_total / 1e6:.1f} MB DDS/PNG -> {webp_bytes_total / 1e6:.1f} MB WebP)')

    # Build glTF materials
    gltf_materials = []
    for old_mi in used_mats:
        m = materials[old_mi]
        sh = m['shader'].lower()
        tname = m['maps'].get('txDiffuse')
        pbr = {'metallicFactor': 0.0, 'roughnessFactor': 0.78}
        if tname and tname in tex_to_gltf_idx:
            pbr['baseColorTexture'] = {'index': tex_to_gltf_idx[tname]}
        tint = None if m.get('baked') else multilayer_tint(m, tex_pool, img_cache)
        if tint is not None:
            pbr['baseColorFactor'] = tint
        is_mask = ac_alpha_masked(m, sh, cfg)
        is_blend = (m['blend'] in (1, 2) or 'perpixelalpha' in sh) and not is_mask
        gmat = {'name': m['name'], 'pbrMetallicRoughness': pbr}
        if is_mask:
            gmat['alphaMode'] = 'MASK'
            gmat['alphaCutoff'] = 0.45 if ('tree' in sh or 'grass' in sh) else 0.5
        elif is_blend:
            gmat['alphaMode'] = 'BLEND'
            bcf = list(pbr.get('baseColorFactor', [1.0, 1.0, 1.0, 1.0]))
            bcf[3] = 0.85
            pbr['baseColorFactor'] = bcf
        if 'tree' in sh or 'grass' in sh or is_mask:
            gmat['doubleSided'] = True
        elif double_sided_re and re.search(double_sided_re, m['name'], re.I):
            gmat['doubleSided'] = True
        gltf_materials.append(gmat)

    # Build visual meshes & child nodes under Track_Model
    gltf_meshes = []
    gltf_nodes = []
    model_children = []
    for name, item, old_mi, is_decal, groove_cfg in all_visual:
        pos = item['pos'].astype(np.float32)
        nrm = item['nrm'].astype(np.float32)
        uv = item['uv'].astype(np.float32)
        idx = item['idx']
        if len(idx) == 0 or len(pos) == 0:
            continue
        pa = put_acc(pos, 5126, 'VEC3', 34962, minmax=True)
        q = np.zeros((len(nrm), 4), np.int8)
        q[:, :3] = np.clip(np.round(nrm * 127.0), -127, 127)
        na = put_acc(q, 5120, 'VEC3', 34962, normalized=True, stride=4)
        accessors[na]['count'] = len(nrm)
        ua = put_acc(uv, 5126, 'VEC2', 34962)
        max_i = int(idx.max(initial=0))
        if max_i < 65535:
            ia = put_acc(idx.astype(np.uint16), 5123, 'SCALAR', 34963)
        else:
            ia = put_acc(idx.astype(np.uint32), 5125, 'SCALAR', 34963)
        attrs = {'POSITION': pa, 'NORMAL': na, 'TEXCOORD_0': ua}
        # A drifting object's slot (drifting_object_items)
        if item.get('drift') is not None:
            attrs['_DRIFT'] = put_acc(np.asarray(item['drift'], np.float32), 5126, 'SCALAR', 34962)
        prim = {
            'attributes': attrs,
            'indices': ia,
            'material': mat_remap[old_mi],
        }
        mesh_i = len(gltf_meshes)
        gltf_meshes.append({'name': name, 'primitives': [prim]})
        nd = {'name': name, 'mesh': mesh_i}
        extras = {}
        if is_decal:
            extras['decal'] = True
        if groove_cfg is not None:
            extras['decal'] = True
            extras['groove'] = groove_cfg
        # Laid on the colliders here (`modelledKerbs`): the load-time fit leaves it as built (render/fit-visual-road.ts)
        if item.get('keepShape'):
            extras['keepShape'] = True
        if item.get('fromModel'):
            extras['fromModel'] = item['fromModel']
        extras.update(item.get('nodeExtras', {}))
        if extras:
            nd['extras'] = extras
        node_i = len(gltf_nodes)
        gltf_nodes.append(nd)
        model_children.append(node_i)

    # Track_Model root node
    track_model_node = {
        'name': 'Track_Model',
        'children': model_children,
        'translation': [float(-v) for v in off],
        'scale': [float(scale)] * 3,
    }
    gltf_nodes.append(track_model_node)
    scene_roots = [len(gltf_nodes) - 1]

    # Append generated physics collider / surface meshes
    from glbwrite import _normals
    gen_materials = {}
    for name, pos, idx, extras in extra_meshes:
        if len(idx) == 0 or name == 'Track_Kerbs_Visual':
            continue
        pos = np.asarray(pos, np.float32)
        idx = np.asarray(idx, np.uint32)
        nrm = _normals(pos.astype(np.float64), idx).astype(np.float32)
        pa = put_acc(pos, 5126, 'VEC3', 34962, minmax=True)
        na = put_acc(nrm, 5126, 'VEC3', 34962)
        ia = put_acc(idx, 5125, 'SCALAR', 34963)
        attrs = {'POSITION': pa, 'NORMAL': na}
        if extras.get('_uv') is not None:
            uv = np.asarray(extras['_uv'], np.float32)
            attrs['TEXCOORD_0'] = put_acc(uv, 5126, 'VEC2', 34962)
        prim = {'attributes': attrs, 'indices': ia}
        mat_spec = extras.get('_material')
        if mat_spec is not None:
            if mat_spec['name'] not in gen_materials:
                webp_m = encode_webp_tex(mat_spec['png'], False)
                img_i = len(gltf_images)
                gltf_images.append({'bufferView': add_view(webp_m), 'mimeType': 'image/webp', 'name': mat_spec['name']})
                tex_i = len(gltf_textures)
                gltf_textures.append({'sampler': 0, 'extensions': {'EXT_texture_webp': {'source': img_i}}})
                gltf_materials.append({
                    'name': mat_spec['name'],
                    'pbrMetallicRoughness': {
                        'baseColorTexture': {'index': tex_i},
                        'metallicFactor': 0.0,
                        'roughnessFactor': mat_spec.get('roughness', 0.7),
                    },
                })
                gen_materials[mat_spec['name']] = len(gltf_materials) - 1
            prim['material'] = gen_materials[mat_spec['name']]
        gltf_meshes.append({'name': name, 'primitives': [prim]})
        node_extras = {k: v for k, v in extras.items() if not k.startswith('_')}
        if not extras.get('_visible'):
            node_extras['hidden'] = True
        gltf_nodes.append({'name': name, 'mesh': len(gltf_meshes) - 1, 'extras': node_extras})
        scene_roots.append(len(gltf_nodes) - 1)

    out_buf = bytearray()
    views = []
    for data, target, stride in chunks:
        while len(out_buf) % 4:
            out_buf += b'\0'
        v = {'buffer': 0, 'byteOffset': len(out_buf), 'byteLength': len(data)}
        if target:
            v['target'] = target
        if stride:
            v['byteStride'] = stride
        views.append(v)
        out_buf += data

    j = {
        'asset': {'version': '2.0', 'generator': 'scripts/tracks/port_ac_track.py'},
        'scene': 0,
        'scenes': [{'nodes': scene_roots}],
        'nodes': gltf_nodes,
        'meshes': gltf_meshes,
        'materials': gltf_materials,
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(out_buf)}],
        'extensionsUsed': ['EXT_texture_webp', 'KHR_mesh_quantization'],
        'extensionsRequired': ['EXT_texture_webp', 'KHR_mesh_quantization'],
    }
    if gltf_images:
        j['images'] = gltf_images
        j['textures'] = gltf_textures
        j['samplers'] = gltf_samplers

    def pad(b, ch=b'\0'):
        return b + ch * ((4 - len(b) % 4) % 4)

    js = pad(json.dumps(j, separators=(',', ':')).encode('utf-8'), b' ')
    bn = pad(bytes(out_buf))
    total = 12 + 8 + len(js) + 8 + len(bn)
    with open(out_path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(bn), 0x004E4942))
        f.write(bn)
    log(f'  wrote raw GLB {out_path} ({total / 1e6:.1f} MB, {len(all_visual)} visual mesh nodes)')


def index_entry(tid, cfg, data):
    """A circuit's entry in public/tracks/index.json, the list the title menu offers"""
    m = data['metadata']
    return {
        'id': tid,
        'name': cfg['name'],
        'layout': cfg['layout'],
        'country': cfg['country'],
        'city': cfg['city'],
        # A point-to-point course is as long as its run (its loop runs on round the dead stretch)
        'lengthM': m.get('pointToPoint', {}).get('finishS', m['lengthMeters']),
        'turns': len(data['turns']),
        'direction': m['direction'],
        'dataUrl': f'/tracks/{tid}/track_data.json',
        'credit': cfg['credit'],
        **({'type': cfg['type']} if cfg.get('type') else {}),
        'quality': 'sim',
        # `unlisted`: left out of the game's lists, opened by its link only (src/lib/track-registry.ts)
        **({'unlisted': True} if cfg.get('unlisted') else {}),
    }


def sync_track_configs(built_tracks):
    """Update scripts/tracks/tracks.json and public/tracks/index.json with the ported AC tracks."""
    tjson_path = os.path.join(HERE, 'tracks.json')
    cfgs = json.load(open(tjson_path, encoding='utf-8')) if os.path.exists(tjson_path) else {}
    for tid, (cfg, data) in built_tracks.items():
        cfgs[tid] = {
            'folder': cfg['folder'],
            'name': cfg['name'],
            'layout': cfg['layout'],
            'country': cfg['country'],
            'city': cfg['city'],
            'baseAltitudeM': cfg['baseAltitudeM'],
            'credit': cfg['credit'],
            **({'type': cfg['type']} if cfg.get('type') else {}),
        }
    with open(tjson_path, 'w', encoding='utf-8') as f:
        json.dump(cfgs, f, indent=2, ensure_ascii=False)
        f.write('\n')

    idx_path = os.path.join(ROOT, 'public', 'tracks', 'index.json')
    idx = json.load(open(idx_path, encoding='utf-8')) if os.path.exists(idx_path) else []
    for tid, (cfg, data) in built_tracks.items():
        idx = [e for e in idx if e['id'] != tid] + [index_entry(tid, cfg, data)]
    order = list(cfgs.keys())
    # Circuits this script does not know (RISE Motordrome, built by scripts/rwanda-official) keep their place on top
    idx.sort(key=lambda e: order.index(e['id']) if e['id'] in order else -1)
    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(idx, f, indent=2, ensure_ascii=False)
        f.write('\n')


def raycast_walls_3d(T_wall, xz, rgt, yc, bank, max_d, min_d=1.8):
    """Raycast horizontal lateral rays from each sample directly against 3D 1WALL* triangles (including subdivided
    W-beam guardrail and tyre-wall strips with dh in 0.05..0.35 m that 2D wall_raster drops)."""
    n = len(xz)
    out = np.full((n, 2), max_d)
    if len(T_wall) == 0:
        return out
    nrm = np.cross(T_wall[:, 1] - T_wall[:, 0], T_wall[:, 2] - T_wall[:, 0])
    nlen = np.linalg.norm(nrm, axis=1)
    ny = np.abs(nrm[:, 1]) / np.maximum(nlen, 1e-12)
    ymin_t = T_wall[:, :, 1].min(1)
    ymax_t = T_wall[:, :, 1].max(1)
    keep = (nlen > 1e-6) & (ny < 0.55) & ((ymax_t - ymin_t) > 0.05)
    Tw = T_wall[keep]
    ymin_w = ymin_t[keep]
    ymax_w = ymax_t[keep]
    if len(Tw) == 0:
        return out

    segs_p0, segs_p1, segs_ymin, segs_ymax = [], [], [], []
    for a, b in ((0, 1), (1, 2), (2, 0)):
        p0 = Tw[:, a, [0, 2]]
        p1 = Tw[:, b, [0, 2]]
        l2 = np.sum((p1 - p0) ** 2, axis=1)
        ok = l2 > 1e-4
        segs_p0.append(p0[ok])
        segs_p1.append(p1[ok])
        segs_ymin.append(ymin_w[ok])
        segs_ymax.append(ymax_w[ok])
    P0 = np.concatenate(segs_p0, 0)
    P1 = np.concatenate(segs_p1, 0)
    Y0 = np.concatenate(segs_ymin, 0)
    Y1 = np.concatenate(segs_ymax, 0)
    mid = 0.5 * (P0 + P1)
    seg_tree = cKDTree(mid)

    for i in range(n):
        idxs = seg_tree.query_ball_point(xz[i], max_d + 8.0)
        if not idxs:
            continue
        p0 = P0[idxs] - xz[i]
        p1 = P1[idxs] - xz[i]
        y0 = Y0[idxs]
        y1 = Y1[idxs]
        v = p1 - p0
        for si, side in enumerate((-1.0, 1.0)):
            d_vec = rgt[i] * side
            denom = d_vec[0] * (-v[:, 1]) - d_vec[1] * (-v[:, 0])
            ok = np.abs(denom) > 1e-8
            if not np.any(ok):
                continue
            p0_ok = p0[ok]
            v_ok = v[ok]
            den_ok = denom[ok]
            t_ray = (p0_ok[:, 0] * (-v_ok[:, 1]) - p0_ok[:, 1] * (-v_ok[:, 0])) / den_ok
            u_seg = (d_vec[0] * p0_ok[:, 1] - d_vec[1] * p0_ok[:, 0]) / den_ok
            hit = (u_seg >= -0.02) & (u_seg <= 1.02) & (t_ray >= min_d) & (t_ray < max_d)
            if not np.any(hit):
                continue
            t_hit = t_ray[hit]
            y0_h = y0[ok][hit]
            y1_h = y1[ok][hit]
            yb = yc[i] - side * math.sin(bank[i]) * t_hit
            vert_ok = (y1_h > yb + 0.15) & (y0_h < yb + 1.5)
            if np.any(vert_ok):
                out[i, si] = float(np.min(t_hit[vert_ok]))
    return out


def fill_short_wall_gaps(wall, wall_cap, max_gap=4):
    """Interpolate short (<= max_gap) raycast miss runs linearly between adjacent barrier hits."""
    n = len(wall)
    for si in range(2):
        hit = wall[:, si] < (wall_cap - 0.1)
        if not hit.any() or hit.all():
            continue
        i = 0
        while i < n:
            if not hit[i]:
                j = i
                while j < i + n and not hit[j % n]:
                    j += 1
                gap_len = j - i
                if gap_len <= max_gap:
                    i_prev = (i - 1) % n
                    i_next = j % n
                    v0 = wall[i_prev, si]
                    v1 = wall[i_next, si]
                    for k in range(gap_len):
                        a = (k + 1) / (gap_len + 1)
                        wall[(i + k) % n, si] = v0 * (1.0 - a) + v1 * a
                i = j
            else:
                i += 1


def offroad_over_road(extra, soup, road_set, off, xz, rgt, width, ds):
    """`offroadOverRoad`: run-off / gravel / grass faces lying on the mod's own track surface, or on the built road
    band (`width` about the centreline), move to `Track_Surface_Apron`, tagged as road. Where the lap passes close by
    or across another part of itself, one part's off-road bands otherwise lie over the other's road and the wheels
    there read run-off or grass."""
    kinds = ('Track_Surface_Runoff', 'Track_Surface_Gravel', 'Track_Surface_Grass')
    tree = cKDTree(xz)
    tan = np.stack([rgt[:, 1], -rgt[:, 0]], 1)
    reach = float(width.max()) / 2 + ds

    def over_road(q):
        q = q + off
        out = np.zeros(len(q), bool)
        for k, v in enumerate(q):
            h = soup.height_near(v[0], v[2], v[1], 0.5)
            if h is not None and h[1] in road_set:
                out[k] = True
                continue
            js = np.asarray(tree.query_ball_point(v[[0, 2]], reach), int)
            if len(js):
                rel = v[[0, 2]] - xz[js]
                lat = np.abs(np.einsum('ij,ij->i', rel, rgt[js]))
                along = np.abs(np.einsum('ij,ij->i', rel, tan[js]))
                out[k] = bool(np.any((along <= 0.5 * ds + 0.05) & (lat < width[js] / 2 - 0.05)))
        return out

    rest, moved = [], []
    for name, P, F, extras in extra:
        if name not in kinds:
            rest.append((name, P, F, extras))
            continue
        T = np.asarray(P)[np.asarray(F, np.int64).reshape(-1, 3)]
        keep, on = [], []
        # a band face can span 15 m: one lying partly over a road is quartered until its middle and corners agree
        for depth in range(5):
            if not len(T):
                break
            c = T.mean(1)
            votes = np.stack([over_road(c)] + [over_road(T[:, j] + 0.1 * (c - T[:, j])) for j in range(3)], 1)
            agree = votes.all(1) | ~votes.any(1)
            if depth == 4:
                agree[:] = True
            on.append(T[agree & votes[:, 0]])
            keep.append(T[agree & ~votes[:, 0]])
            T = T[~agree]
            a, b, cc = T[:, 0], T[:, 1], T[:, 2]
            ab, bc, ca = 0.5 * (a + b), 0.5 * (b + cc), 0.5 * (cc + a)
            T = np.concatenate([np.stack(q, 1) for q in ((a, ab, ca), (ab, b, bc), (ca, bc, cc), (ab, bc, ca))]) if len(T) else T
        K = np.concatenate(keep).reshape(-1, 3) if keep else np.zeros((0, 3))
        rest.append((name, K, np.arange(len(K), dtype=np.uint32), extras))
        moved.append(np.concatenate(on).reshape(-1, 3) if on else np.zeros((0, 3)))
    M = np.concatenate(moved) if moved else np.zeros((0, 3))
    if len(M):
        rest.append(('Track_Surface_Apron', M, np.arange(len(M), dtype=np.uint32), {'surface': 'road', 'grip': 1.0}))
    log(f'  off-road faces over the track surface: {len(M) // 3} moved to Track_Surface_Apron (road)')
    return rest


def build_ac_kerb_mesh(phys_kerb_tris, xz, tan2, rgt2, yc, width, ds, off, extra):
    """Build Track_Surface_Kerb directly from AC 1KERB* physics triangles within 5.0 m of the layout road edges,
    with continuous arc-length UVs (u = s / 2.0, v = 0.5) and seated +16..30 mm proud of all road/runoff colliders."""
    if not phys_kerb_tris:
        return
    T_k = np.concatenate(phys_kerb_tris, 0).astype(np.float64)
    c = T_k.mean(1)
    fn = np.cross(T_k[:, 1] - T_k[:, 0], T_k[:, 2] - T_k[:, 0])
    fn_len = np.linalg.norm(fn, axis=1)
    ny = np.abs(fn[:, 1]) / np.maximum(fn_len, 1e-12)
    tree_xz = cKDTree(xz)
    _, ic = tree_xz.query(c[:, [0, 2]])
    ec = np.abs(np.einsum('ij,ij->i', c[:, [0, 2]] - xz[ic], rgt2[ic])) - width[ic] / 2
    dy = np.abs(c[:, 1] - yc[ic])
    keep = (fn_len > 1e-6) & (ny > 0.35) & (ec < 5.0) & (dy < 1.5)
    if not np.any(keep):
        return
    Tk = T_k[keep].copy()
    for _ in range(8):
        e = np.stack([np.linalg.norm(Tk[:, a, [0, 2]] - Tk[:, b, [0, 2]], axis=1) for a, b in ((0, 1), (1, 2), (2, 0))], 1)
        big = e.max(1) > 1.5
        if not big.any():
            break
        Tb, k = Tk[big], e[big].argmax(1)
        a_, b_, c_ = [Tb[np.arange(len(Tb)), (k + j) % 3] for j in range(3)]
        m_ = 0.5 * (a_ + b_)
        Tk = np.concatenate([Tk[~big], np.stack([a_, m_, c_], 1), np.stack([m_, b_, c_], 1)])

    V = (Tk - off).reshape(-1, 3)
    F = np.arange(len(V), dtype=np.uint32).reshape(-1, 3)
    fn_sub = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    F[fn_sub[:, 1] < 0] = F[fn_sub[:, 1] < 0][:, ::-1]
    F = F.reshape(-1)

    # Seat every unique kerb vertex above the drivable surfaces under it (road, run-off), the ground the game takes
    # the wheel's height from, and above the road collider only where there is none. Seated on the collider, which past
    # the edge carries the road's camber on, a kerb behind Watkins Glen's steeply cambered first corner stood 6 cm over
    # the paved run-off it lies on: a ledge that threw the car up
    base_tris = []
    collider_tris = []
    for m_name, m_pos, m_idx, _ in extra:
        if not (len(m_idx) and len(m_pos)):
            continue
        tris = np.asarray(m_pos, np.float64)[np.asarray(m_idx, np.int32).reshape(-1, 3)]
        if m_name in ('Track_Surface_Road', 'Track_Surface_Runoff'):
            base_tris.append(tris)
        elif m_name == 'Track_Collider_Road':
            collider_tris.append(tris)
    collider_soup = None
    if not base_tris:
        base_tris, collider_tris = collider_tris, []
    if collider_tris:
        T_col = np.concatenate(collider_tris, 0)
        collider_soup = srf.TriSoup(T_col, np.zeros(len(T_col), np.int32), np.zeros((len(T_col), 3), np.uint8))

    q_xz = np.round(V[:, [0, 2]] * 1000.0).astype(np.int64)
    _, uniq_idx, inv_idx = np.unique(q_xz, axis=0, return_index=True, return_inverse=True)
    U_v = V[uniq_idx].copy()
    u_xz = U_v[:, [0, 2]] + off[[0, 2]]
    _, iu = tree_xz.query(u_xz)
    lat_signed = np.einsum('ij,ij->i', u_xz - xz[iu], rgt2[iu])
    lat_u = np.abs(lat_signed)
    # The hump rises from the kerb's own inner edge (the nearest of its vertices to the centreline, over ±1 sample), or
    # from 0.35 m inside the road's edge where the kerb starts further in. A kerb laid just outside the edge (Watkins
    # Glen's first corner) otherwise began 3 cm up, a step the wheels came back over
    n_c = len(xz)
    inner = np.full((n_c, 2), np.inf)
    np.minimum.at(inner, (iu, (lat_signed > 0).astype(int)), lat_u)
    reach = 1
    inner = np.stack([ndimage.minimum_filter1d(inner[:, k], 2 * reach + 1, mode='wrap') for k in range(2)], 1)
    start_u = np.maximum(width[iu] / 2 - 0.35, inner[iu, (lat_signed > 0).astype(int)])
    across_u = np.clip((lat_u - start_u) / 1.45, 0.0, 1.0)
    hump_u = 0.016 + 0.014 * np.sin(np.pi * across_u)

    if base_tris:
        T_base = np.concatenate(base_tris, 0)
        base_soup = srf.TriSoup(T_base, np.zeros(len(T_base), np.int32), np.zeros((len(T_base), 3), np.uint8))
        for k, v in enumerate(U_v):
            hs = [h for h, _, _ in base_soup.hits(v[0], v[2]) if abs(h - v[1]) <= 0.8]
            if not hs and collider_soup is not None:
                hs = [h for h, _, _ in collider_soup.hits(v[0], v[2]) if abs(h - v[1]) <= 0.8]
            if hs:
                U_v[k, 1] = max(hs) + hump_u[k]
            else:
                U_v[k, 1] += hump_u[k]
    else:
        U_v[:, 1] += hump_u
    V[:, 1] = U_v[inv_idx, 1]

    # Continuous arc-length UVs along the centreline tangent so u * uvScaleM (2.0 m) has no Voronoi step jumps
    L_m = ds * len(xz)
    s_u = (iu * ds + np.einsum('ij,ij->i', u_xz - xz[iu], tan2[iu])) % L_m
    u_tri = s_u[inv_idx].reshape(-1, 3)
    wrap = u_tri.max(1) - u_tri.min(1) > L_m / 2
    u_tri[wrap] = np.where(u_tri[wrap] < L_m / 2, u_tri[wrap] + L_m, u_tri[wrap])
    UV = np.column_stack([u_tri.reshape(-1) / bt.KERB_UV_M, np.full(len(V), 0.5)]).astype(np.float32)
    log(f'  ac scan kerbs: {len(F) // 3} triangles ({len(U_v)} unique vertices seated proud of road/runoff)')

    kerb_entry = ('Track_Surface_Kerb', V, F, {'surface': 'kerb', 'uvScaleM': bt.KERB_UV_M, '_uv': UV})
    replaced = False
    for idx_m, (m_name, _, _, _) in enumerate(extra):
        if m_name == 'Track_Surface_Kerb':
            extra[idx_m] = kerb_entry
            replaced = True
            break
    if not replaced:
        extra.append(kerb_entry)


# How far around a point the kerb's shift is averaged (m): enough to smooth the road-to-road difference, far less than
# a kerb's length, and the same for every vertex at one spot, so a modelled slot or ridge keeps its depth
KERB_SHIFT_SMOOTH_M = 1.0
# Most a modelled kerb may lift a wheel over the ground beside it (m): Oschersleben's stand 12-18 cm over the gravel
# beside them, Grobnik's 11-14 cm, and Assetto Corsa drives them at that height
MODELLED_KERB_MAX_RISE_M = 0.20
# Steepest face of a modelled kerb the wheels ride (deg). Steeper ones (the walls of Willow's slots and its edges,
# 30-90 deg) stay drawn but out of the physics mesh, where they are steps: their slope, smoothed into the flat tops
# beside them at load, tilted the ground under a wheel by up to 68 deg and threw the drawn tyres up off the kerb
MODELLED_KERB_MAX_FACE_DEG = 25.0
# A drawn mesh with this share of its area on the physics kerb (within 5 cm of it) is drawn kerb, moved with it:
# mods that drive on hidden 1KERB meshes draw their kerbs separately (Istanbul Park's rumble strips: all of them on it;
# Watkins Glen's CURB 0.83). Named as kerb, curb or rumble, from the lower share (Watkins Glen's curb grooves: 0.61)
DRAWN_KERB_SHARE = 0.75
# A kerb point the converted road or off-road bands cover (from just under it to this far over it, m) is lifted onto
# them, plus MODELLED_KERB_CLEAR_M: the converted road can run wider than the mod's and the bands, swept out from it,
# higher than the mod's ground, and a kerb under them drives as them (Norisring's at 1.5 km under the road, Grobnik's
# at 400 m 5-13 cm under the grass, both open kerb in the mod). Points above them keep their place
MODELLED_KERB_COVER_M = 0.3
MODELLED_KERB_CLEAR_M = 0.003
DRAWN_KERB_SHARE_NAMED = 0.55
DRAWN_KERB_NAME_RE = re.compile(r'kerb|curb|rumble|ripple', re.I)


# Physics nodes whose patch-table vertices may sit up to PATCH_NEAR_M off the table's height in a rebuild (the grass
# edge is re-seated on the walls' and run-off's edges, which can move it a little)
PATCH_NEAR_NODES = ('Track_Surface_Grass',)
PATCH_NEAR_M = 0.02


def apply_physics_patch(extra, path, skip=()):
    """A table of physics vertex heights made by a fix to a built GLB (scripts/tracks/patches/*.json: per physics node,
    each vertex's exact float32 position, its new height and how many copies it has), laid into this build's physics
    meshes. Refuses a build that does not hold each vertex exactly as often as the table says: the table was made for
    one build of one mod, and on any other ground it would move the wrong vertices."""
    with open(path, encoding='utf-8') as f:
        patch = json.load(f)
    moved = []
    for name, entries in patch['nodes'].items():
        if name in skip or not entries:
            continue
        at = [i for i, e in enumerate(extra) if e[0] == name]
        if len(at) != 1:
            raise RuntimeError(f'{os.path.basename(path)}: {len(at)} {name} meshes in this build, expected one')
        i = at[0]
        P = np.asarray(extra[i][1], np.float32).copy()
        index, by_xz = {}, {}
        for k, q in enumerate(map(tuple, P)):
            index.setdefault(q, []).append(k)
            by_xz.setdefault((q[0], q[2]), []).append(k)
        claimed, near = set(), 0
        todo = []
        for e in entries:
            hits = index.get(tuple(np.float32([e['x'], e['y'], e['z']])), [])
            if len(hits) == e['count']:
                todo.append((e, hits))
                claimed.update(hits)
            elif hits or name not in PATCH_NEAR_NODES:
                raise RuntimeError(f'{os.path.basename(path)}: {name} vertex ({e["x"]}, {e["y"]}, {e["z"]}) found '
                                   f'{len(hits)} times, expected {e["count"]}: not the build this patch was made for')
            else:
                todo.append((e, None))
        for n_e, (e, hits) in enumerate(todo):
            if hits is None:
                # A grass edge vertex this build seats a little differently: the same place, its height within
                # PATCH_NEAR_M of the table's
                cand = [k for k in by_xz.get((np.float32(e['x']), np.float32(e['z'])), [])
                        if k not in claimed and abs(float(P[k, 1]) - e['y']) <= PATCH_NEAR_M]
                if len(cand) != e['count']:
                    raise RuntimeError(f'{os.path.basename(path)}: {name} vertex ({e["x"]}, {e["y"]}, {e["z"]}) found '
                                       f'{len(cand)} times within {PATCH_NEAR_M} m, expected {e["count"]}')
                claimed.update(cand)
                hits = cand
                near += 1
                todo[n_e] = (e, hits)
        for e, hits in todo:
            P[hits, 1] = np.float32(e['newY'])
        extra[i] = (extra[i][0], P, *extra[i][2:])
        moved.append(f'{name} {len(entries)}' + (f' ({near} matched within {PATCH_NEAR_M * 100:.0f} cm)' if near else ''))
    log(f'  physics patch {os.path.basename(path)}: ' + ', '.join(moved) + (f' (left out: {", ".join(skip)})' if skip else ''))


def build_modelled_kerb_mesh(phys_kerb_tris, phys_road_tris, xz, tan2, rgt2, width, ds, off, extra, visual_items):
    """`modelledKerbs`: the mod's own kerbs, as modelled, moved with the road under them.

    The converted road is rebuilt from the mod's (smoothed, crests limited), so it lies a few centimetres above or
    below the mod's road. Each kerb vertex is moved up or down by that difference at its spot, averaged over
    KERB_SHIFT_SMOOTH_M: the kerb sits on the converted road as it sat on the mod's, keeping its height, ridges and slots.
    The kerb physics mesh (`Track_Surface_Kerb`) and the kerb meshes the mod also draws (1KERB nodes that are visible)
    get the same shift, so what is drawn is what the wheels touch, as in Assetto Corsa, and those drawn meshes are
    tagged `keepShape` for the load-time fit to leave alone. Returns whether it built them.
    """
    if not phys_kerb_tris or not phys_road_tris:
        return False
    T_k = np.concatenate(phys_kerb_tris, 0).astype(np.float64)
    c = T_k.mean(1)
    fn = np.cross(T_k[:, 1] - T_k[:, 0], T_k[:, 2] - T_k[:, 0])
    fn_len = np.linalg.norm(fn, axis=1)
    ny = np.abs(fn[:, 1]) / np.maximum(fn_len, 1e-12)
    tree_xz = cKDTree(xz)
    _, ic = tree_xz.query(c[:, [0, 2]])
    ec = np.abs(np.einsum('ij,ij->i', c[:, [0, 2]] - xz[ic], rgt2[ic])) - width[ic] / 2
    # Every face for now: which ones the wheels ride (MODELLED_KERB_MAX_FACE_DEG) is decided once they are moved, as the
    # drawn kerb's are, since lifting a wall's foot (lift_uncovered) can make it a ramp
    keep = (fn_len > 1e-6) & (ny > 0.05) & (ec < 5.0)
    if not np.any(keep):
        return False
    Tk = T_k[keep].copy()

    # The converted road (not moved at load) and the mod's, both in the mod's coordinates
    ours = [np.asarray(m_pos, np.float64)[np.asarray(m_idx, np.int64).reshape(-1, 3)] + off
            for m_name, m_pos, m_idx, _ in extra if m_name == 'Track_Surface_Road' and len(m_idx)]
    if not ours:
        log('  modelled kerbs: no Track_Surface_Road, kerbs left out')
        return False
    T_o = np.concatenate(ours, 0)
    soup_o = srf.TriSoup(T_o, np.zeros(len(T_o), np.int32), np.zeros((len(T_o), 3), np.uint8))
    T_m = np.concatenate(phys_road_tris, 0).astype(np.float64)
    soup_m = srf.TriSoup(T_m, np.zeros(len(T_m), np.int32), np.zeros((len(T_m), 3), np.uint8))

    def road_gap(x, z, y):
        """Converted road minus the mod's road at (x, z), the surfaces nearest height y; None where either is missing"""
        ho = [h for h, _, _ in soup_o.hits(x, z) if abs(h - y) < 1.5]
        hm = [h for h, _, _ in soup_m.hits(x, z) if abs(h - y) < 1.5]
        if not ho or not hm:
            return None
        return min(ho, key=lambda h: abs(h - y)) - min(hm, key=lambda h: abs(h - y))

    # The gap at each kerb vertex, or where the kerb lies off the road, at the road's edge beside it (0.3 m in)
    P = Tk.reshape(-1, 3)
    q_xz = np.round(P[:, [0, 2]] * 1000.0).astype(np.int64)
    _, uniq = np.unique(q_xz, axis=0, return_index=True)
    U = P[uniq]
    _, iu = tree_xz.query(U[:, [0, 2]])
    lat = np.einsum('ij,ij->i', U[:, [0, 2]] - xz[iu], rgt2[iu])
    gap = np.full(len(U), np.nan)
    for k, (x, y, z) in enumerate(U):
        g = road_gap(x, z, y)
        if g is None:
            half = max(width[iu[k]] / 2 - 0.3, 0.0)
            ex, ez = xz[iu[k]] + rgt2[iu[k]] * np.clip(lat[k], -half, half)
            g = road_gap(ex, ez, y)
        if g is not None:
            gap[k] = g
    ok = np.isfinite(gap)
    if not ok.any():
        log('  modelled kerbs: no road under or beside them, kerbs left out')
        return False
    if not ok.all():
        # Fill from the nearest vertex that has it
        _, j = cKDTree(U[ok][:, [0, 2]]).query(U[~ok][:, [0, 2]])
        gap[~ok] = gap[ok][j]
    pts = U[:, [0, 2]]
    pts_tree = cKDTree(pts)

    def shift_at(q):
        """The averaged gap at points q (n x 2)"""
        out = np.empty(len(q))
        for k, nb in enumerate(pts_tree.query_ball_point(q, KERB_SHIFT_SMOOTH_M)):
            if not nb:
                _, j = pts_tree.query(q[k])
                out[k] = gap[j]
                continue
            d = np.linalg.norm(pts[nb] - q[k], axis=1)
            w = (1.0 - d / KERB_SHIFT_SMOOTH_M) ** 2 + 1e-9
            out[k] = float(np.dot(w, gap[nb]) / w.sum())
        return out

    # The converted surfaces a kerb point may lie under (MODELLED_KERB_COVER_M), in the mod's coordinates
    cover = [np.asarray(m_pos, np.float64)[np.asarray(m_idx, np.int64).reshape(-1, 3)] + off
             for m_name, m_pos, m_idx, _ in extra
             if m_name in ('Track_Surface_Road', 'Track_Surface_Runoff', 'Track_Surface_Gravel', 'Track_Surface_Grass')
             and len(m_idx)]
    T_c = np.concatenate(cover, 0)
    soup_c = srf.TriSoup(T_c, np.zeros(len(T_c), np.int32), np.zeros((len(T_c), 3), np.uint8))
    n_lifted = [0]

    def lift_uncovered(P):
        """P (n x 3, the mod's coordinates, already shifted): each point under a converted surface lifted onto it"""
        for k in range(len(P)):
            x, y, z = P[k]
            hs = [h for h, _, _ in soup_c.hits(x, z) if y - 0.05 < h <= y + MODELLED_KERB_COVER_M]
            if hs and max(hs) + MODELLED_KERB_CLEAR_M > y:
                P[k, 1] = max(hs) + MODELLED_KERB_CLEAR_M
                n_lifted[0] += 1
        return P

    # Physics: the kept triangles as the mod has them, not split: the drawn kerb is moved vertex by vertex, and a physics
    # triangle split where the drawn one is not would bend between the same corners differently once a point is lifted
    V = Tk.reshape(-1, 3).copy()
    V[:, 1] += shift_at(V[:, [0, 2]])
    V = lift_uncovered(V)
    n_lifted_phys = n_lifted[0]
    T_moved = V.reshape(-1, 3, 3)
    n_moved = np.cross(T_moved[:, 1] - T_moved[:, 0], T_moved[:, 2] - T_moved[:, 0])
    ny_moved = np.abs(n_moved[:, 1]) / np.maximum(np.linalg.norm(n_moved, axis=1), 1e-12)
    V = T_moved[ny_moved > math.cos(math.radians(MODELLED_KERB_MAX_FACE_DEG))].reshape(-1, 3)
    V -= off
    F = np.arange(len(V), dtype=np.uint32).reshape(-1, 3)
    fn_sub = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    F[fn_sub[:, 1] < 0] = F[fn_sub[:, 1] < 0][:, ::-1]
    F = F.reshape(-1)

    # u: metres along the lap (the surface ripple's phase, none by default on these kerbs); v = 0.5
    s_xz = V[:, [0, 2]] + off[[0, 2]]
    _, iv = tree_xz.query(s_xz)
    L_m = ds * len(xz)
    s_u = (iv * ds + np.einsum('ij,ij->i', s_xz - xz[iv], tan2[iv])) % L_m
    u_tri = s_u.reshape(-1, 3)
    wrap = u_tri.max(1) - u_tri.min(1) > L_m / 2
    u_tri[wrap] = np.where(u_tri[wrap] < L_m / 2, u_tri[wrap] + L_m, u_tri[wrap])
    UV = np.column_stack([u_tri.reshape(-1) / bt.KERB_UV_M, np.full(len(V), 0.5)]).astype(np.float32)

    kerb_entry = ('Track_Surface_Kerb', V.astype(np.float32), F, {'surface': 'kerb', 'uvScaleM': bt.KERB_UV_M, '_uv': UV})
    extra[:] = [e for e in extra if e[0] != 'Track_Surface_Kerb'] + [kerb_entry]

    # Drawing: the mod's visible kerb meshes, and the drawn meshes lying on its kerbs (DRAWN_KERB_SHARE), moved the same
    # way
    soup_k = srf.TriSoup(T_k, np.zeros(len(T_k), np.int32), np.zeros((len(T_k), 3), np.uint8))
    k_lo = T_k.reshape(-1, 3).min(0) - 1.0
    k_hi = T_k.reshape(-1, 3).max(0) + 1.0

    def on_kerb_share(P, idx):
        """The share of the mesh's area lying on the physics kerb (its faces' centres within 5 cm of it)"""
        inside = (P[:, 0] > k_lo[0]) & (P[:, 0] < k_hi[0]) & (P[:, 2] > k_lo[2]) & (P[:, 2] < k_hi[2])
        if inside.sum() < max(3, 0.2 * len(P)):
            return 0.0
        T = P[np.asarray(idx, np.int64).reshape(-1, 3)]
        area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
        pick = np.arange(0, len(T), max(1, len(T) // 600))
        C = T[pick].mean(1)
        on = np.array([any(abs(h - y) < 0.05 for h, _, _ in soup_k.hits(x, z)) for x, y, z in C])
        a = area[pick]
        return float(a[on].sum() / a.sum()) if a.sum() > 0 else 0.0

    n_vis = 0
    n_drawn = 0
    for it in visual_items:
        if it.get('fromModel') or it.get('drift') is not None:
            continue
        if it.get('physics') == 'kerb':
            pass
        elif it.get('physics') is None:
            named = bool(DRAWN_KERB_NAME_RE.search(f"{it.get('name', '')} {it.get('matName', '')}"))
            share = on_kerb_share(it['pos'].astype(np.float64), it['idx'])
            if share < (DRAWN_KERB_SHARE_NAMED if named else DRAWN_KERB_SHARE):
                continue
            n_drawn += 1
        else:
            continue
        p = it['pos'].astype(np.float64)
        p[:, 1] += shift_at(p[:, [0, 2]])
        it['pos'] = lift_uncovered(p).astype(np.float32)
        it['keepShape'] = True
        n_vis += 1
    log(f'  modelled kerbs: {len(F) // 3} physics triangles, {n_vis} drawn meshes ({n_drawn} drawn apart from the physics '
        f'kerbs); {n_lifted_phys} physics points lifted out from under the converted surfaces; road gap under them '
        f'p10 {np.percentile(gap, 10) * 100:.1f} median {np.median(gap) * 100:.1f} p90 {np.percentile(gap, 90) * 100:.1f} cm '
        f'({int((~ok).sum())} of {len(ok)} vertices filled from neighbours)')
    return True


def sample_profile_and_bank(soup, road_set, xz, rgt2, width, y_ai_mapped, ds, fall_max=0.27, crest_r=400.0, sigma=1.5):
    """Sample centreline elevation, 9-point lateral profile yprof, and banking on xz. `crest_r`: the sharpest crest
    the profile keeps, `sigma` its smoothing along the lap in samples (build_track.smooth_road_profile)"""
    n = len(xz)
    yc = np.full(n, np.nan)
    y_prev = float(y_ai_mapped[0])
    for i in range(n):
        pred = float(y_ai_mapped[i]) if i == 0 else y_prev
        h = soup.height_near(xz[i, 0], xz[i, 1], pred, 2.0, prefer=road_set)
        if h is None:
            h = soup.height_near(xz[i, 0], xz[i, 1], float(y_ai_mapped[i]), 4.0, prefer=road_set)
        y = h[0] if h is not None else float(y_ai_mapped[i])
        yc[i] = y
        y_prev = y
    yc = ndimage.median_filter(yc, 3, mode='wrap')

    yprof = np.full((n, len(bt.LAT)), np.nan)
    order = [4, 5, 3, 6, 2, 7, 1, 8, 0]
    for i in range(n):
        row = yprof[i]
        row[4] = yc[i]
        for k in order[1:]:
            lat = bt.LAT[k]
            kin = k - 1 if k > 4 else k + 1
            fall = (yprof[i - 1, k] - yprof[i - 1, kin]) if i > 0 else 0.0
            pred = row[kin] + fall
            p = xz[i] + rgt2[i] * lat
            inside = abs(lat) <= (width[i] / 2 + 0.3)
            win = 0.6 if inside else 1.5
            h = soup.height_near(p[0], p[1], pred, win, prefer=road_set if inside else None)
            if h is not None:
                row[k] = h[0]
                continue
            # Nothing under this point (past the end of the mod's physical ground): the drop carried from the last
            # point measured eases back to the road's plane. Carried as it was, one ditch's 3 m held for kilometres
            # on LilSki's Watkins Glen, and the road edge, interpolated towards it, sank under the cars
            kin2 = kin - 1 if k > 4 else kin + 1
            if kin == 4:
                row[k] = pred
                continue
            plane = row[kin] + (row[kin] - row[kin2]) / (bt.LAT[kin] - bt.LAT[kin2]) * (lat - bt.LAT[kin])
            row[k] = plane + 0.8 * (pred - plane)
    for k, lat in enumerate(bt.LAT):
        dev = yprof[:, k] - yprof[:, 4]
        lim = np.where(np.abs(lat) <= width / 2, fall_max * abs(lat) + 0.1, 0.35 * abs(lat) + 0.5)
        yprof[:, k] = yprof[:, 4] + np.clip(dev, -lim, lim)
    yprof = bt.smooth_road_profile(yprof, width, ds, sigma=sigma, crest_r=crest_r)
    yc = yprof[:, 4].copy()
    bank = bt.bank_from_profile(yprof, fall_max)
    return yc, yprof, bank


def refine_ac_width(soup, road_set, kerb_mats, xz, rgt, yc, bank, width, min_w, max_w, w3d=None,
                    med_samples=7, smooth_sigma=1.8):
    """Find the true asphalt-to-kerb/verge boundary on each side of `xz` and return `(new_width, edge_shift)`."""
    n = len(xz)
    half = width / 2
    step = 0.25
    span = 4.0
    offs = np.arange(-span, span + 1e-9, step)
    eshift = np.zeros((n, 2))
    for i in range(n):
        for si, side in enumerate((-1.0, 1.0)):
            h0 = half[i]
            rd = np.zeros(len(offs), bool)
            kb = np.zeros(len(offs), bool)
            for k, d in enumerate(offs):
                lat = max(2.0, h0 + d)
                p = xz[i] + rgt[i] * side * lat
                pred = yc[i] - side * math.sin(bank[i]) * lat
                h = soup.height_near(p[0], p[1], pred, 0.9)
                if h is not None:
                    rd[k] = h[1] in road_set
                    kb[k] = h[1] in kerb_mats
            if kb.any():
                fk = int(np.argmax(kb))
                eshift[i, si] = offs[fk] - 0.5 * step
                continue
            rd_c = ndimage.binary_closing(rd, np.ones(2))
            non = ~rd_c
            best = None
            for k in range(2, len(offs) - 2):
                if rd_c[k - 2] and rd_c[k - 1] and non[k] and non[k + 1]:
                    s = abs(offs[k])
                    if best is None or s < best[0]:
                        best = (s, offs[k] - 0.5 * step)
            if best is not None:
                eshift[i, si] = best[1]
    for si in range(2):
        eshift[:, si] = ndimage.gaussian_filter1d(
            ndimage.median_filter(eshift[:, si], med_samples, mode='wrap'), smooth_sigma, mode='wrap'
        )
        eshift[:, si] = np.clip(eshift[:, si], -3.0, 3.0)
    hwL = np.clip(half + eshift[:, 0], 0.5 * min_w, 0.5 * max_w)
    hwR = np.clip(half + eshift[:, 1], 0.5 * min_w, 0.5 * max_w)
    if w3d is not None:
        hwL = np.minimum(hwL, np.maximum(0.5 * min_w, w3d[:, 0] - 0.12))
        hwR = np.minimum(hwR, np.maximum(0.5 * min_w, w3d[:, 1] - 0.12))
    eshift[:, 0] = hwL - half
    eshift[:, 1] = hwR - half
    new_w = np.clip(hwL + hwR, min_w, max_w)
    return new_w, eshift


def build_ac_track(tid, cfg, args):
    base = cfg['base_dir']
    layout_sub = cfg['layout_dir']
    layout_path = os.path.join(base, layout_sub) if layout_sub else base
    data_dir = os.path.join(layout_path, 'data')
    kn5_files = get_kn5_list(cfg)
    log(f'\n=== Building {tid} ({cfg["name"]} — {cfg["layout"]}) ===')
    log('  KN5 files:', kn5_files)

    # 1. Read KN5 files and separate physics vs visual geometry
    tex_pool = {}
    materials = []
    seen_mat_names = {}
    visual_items = []
    phys_tris = {k: [] for k in ('road', 'kerb', 'runoff', 'gravel', 'grass', 'wall', 'pit')}
    road_mat_names = set()
    # `notRoadMaterials`: a mod's own materials kept off the asphalt shader, e.g. terrain drawn over ROAD physics meshes
    non_road_mat_re = re.compile(
        r'grass|gravel|sand|wall|fence|kerb|curb|rmbl|rumble|line|stripe|skid|groove|sign|glass|water'
        + (f"|{cfg['notRoadMaterials']}" if cfg.get('notRoadMaterials') else ''),
        re.I,
    )

    for kf in kn5_files:
        kpath = os.path.join(base, kf)
        t_dict, mats, nodes = read_kn5_full(kpath)
        tex_pool.update(t_dict)
        kf_stem = os.path.splitext(os.path.basename(kf))[0].replace(' ', '_')
        # ksGrass is mostly 3D grass (small upright blade cards, left out below), but some mods also draw their grass
        # ground with it: Grobnik's verges between the road and the barriers (01GRASS..) and its terrain tiles. Left out,
        # that ground was invisible while still driving as grass. A ksGrass material whose faces lie flat in large
        # triangles is ground: it is drawn as a plain opaque material
        grass_stats = {}
        for nd in nodes:
            m = nd['mesh']
            if m is None or mats[m['mat']]['shader'].lower() != 'ksgrass':
                continue
            w = nd['world']
            t3 = ((m['pos'] @ w[:3, :3].T) + w[:3, 3])[m['idx'].reshape(-1, 3)]
            cr = np.cross(t3[:, 1] - t3[:, 0], t3[:, 2] - t3[:, 0])
            a2 = np.linalg.norm(cr, axis=1)
            st = grass_stats.setdefault(m['mat'], [0.0, 0.0, 0])
            st[0] += float(a2.sum()) / 2
            st[1] += float(np.abs(cr[:, 1]).sum()) / 2
            st[2] += len(a2)
        for mi, (area, flat_area, ntri) in grass_stats.items():
            if area > 0 and flat_area / area > 0.8 and area / max(ntri, 1) > 2.0:
                mats[mi].update(shader='ksPerPixel', alpha_tested=False, blend=0)
                log(f'  ksGrass ground drawn opaque: {mats[mi]["name"]} ({area:.0f} m2, {ntri} tris)')
        # An unblended ksGrass material on kerb meshes is a kerb, not grass blades: VIR draws its FIA kerbs (KERB2 and
        # FIA Kurb Blank on 01KERB..) with it, in small triangles, and they went undrawn while still driving as kerbs. A
        # blended one is an overlay (Norisring's dirt on 20CURB_curbe) and stays left out
        kerb_grass = {nd['mesh']['mat'] for nd in nodes
                      if nd['mesh'] is not None and classify_physics_node(nd['name']) == 'kerb'
                      and mats[nd['mesh']['mat']]['shader'].lower() == 'ksgrass'
                      and mats[nd['mesh']['mat']]['blend'] == 0}
        for mi in sorted(kerb_grass):
            mats[mi].update(shader='ksPerPixel', alpha_tested=False, blend=0)
            log(f'  ksGrass kerb drawn opaque: {mats[mi]["name"]}')
        for m_obj in mats:
            orig_name = m_obj['name']
            sig = (orig_name, m_obj['shader'], m_obj['blend'], m_obj['alpha_tested'], m_obj['maps'].get('txDiffuse'))
            if orig_name in seen_mat_names and seen_mat_names[orig_name] != sig:
                m_obj['name'] = f'{orig_name}_{kf_stem}'
            seen_mat_names[m_obj['name']] = sig
        mat_offset = len(materials)
        materials.extend(mats)
        # `physicsFiles`: the KN5 files that hold only physics meshes (SpeedVegas's walls.kn5 also draws its tyre walls)
        is_phys_file = kf.lower() in cfg.get('physicsFiles', ('physical.kn5', 'walls.kn5'))

        for nd in nodes:
            m = nd['mesh']
            if m is None:
                continue
            name = nd['name']
            w = nd['world']
            pos_w = (m['pos'] @ w[:3, :3].T) + w[:3, 3]
            nrm_w = m['nrm'] @ w[:3, :3].T
            nlen = np.linalg.norm(nrm_w, axis=1, keepdims=True)
            nrm_w = np.where(nlen > 1e-9, nrm_w / np.maximum(nlen, 1e-9), np.array([0.0, 1.0, 0.0], np.float32))
            tris = pos_w[m['idx'].reshape(-1, 3)]
            # `physicsNodeOverrides`: [(regex, category)] for a mod's own surface keys the shared names miss (or, with
            # `physicsOverridesFirst`, read differently from them)
            pover = next((c for rx, c in cfg.get('physicsNodeOverrides', ()) if re.match(rx, name, re.I)), None)
            if cfg.get('physicsOverridesFirst') and pover is not None:
                pcat = pover
            else:
                pcat = classify_physics_node(name)
                if pcat is None:
                    pcat = pover
            mat_info = mats[m['mat']]
            mat_name = mat_info['name']
            sh_name = mat_info['shader'].lower()
            is_opaque_mat = (
                not mat_info['alpha_tested']
                and mat_info['blend'] == 0
                and 'perpixelalpha' not in sh_name
                and 'perpixelat' not in sh_name
                and 'tree' not in sh_name
                and 'grass' not in sh_name
            )
            if pcat is not None:
                phys_tris[pcat].append(tris)
                if (
                    pcat == 'road'
                    and not is_phys_file
                    and nd['active']
                    and m['visible']
                    and m['renderable']
                    and is_opaque_mat
                    and not non_road_mat_re.search(mat_name)
                ):
                    road_mat_names.add(mat_name)

            is_vis = (
                not is_phys_file
                and nd['active']
                and m['visible']
                and m['renderable']
                and mat_name.lower() != 'node'
                and sh_name != 'ksgrass'
                and not is_ac_editor_marker(name)
                and not (
                    cfg.get('hideMaterials')
                    and kf in cfg.get('hideMaterialsIn', [kf])
                    and re.search(cfg['hideMaterials'], mat_name, re.I)
                )
                # `hideNodes`: meshes with these names are left out
                and not (cfg.get('hideNodes') and re.search(cfg['hideNodes'], name, re.I))
                # `hideTextures`: meshes drawn with these diffuse textures are left out
                and not (
                    cfg.get('hideTextures')
                    and re.search(cfg['hideTextures'], mat_info['maps'].get('txDiffuse', ''), re.I)
                )
            )
            if is_vis:
                # `roadMaterialsByTexture`: a mod whose material names don't say what they are (Grobnik names hundreds of
                # props `roada<n>`, cars and glass among them) is matched by its diffuse texture's name instead. With
                # the asphalt shader on those props the frame went black in blocks around the car (bloom spreading a
                # NaN, most likely from the shader's UV-derived tangents on the props' solid-colour `blank_*` textures,
                # whose UVs collapse to a point); taking them off the road list ended it
                road_key = mat_info['maps'].get('txDiffuse', '') if cfg.get('roadMaterialsByTexture') else mat_name
                if (
                    is_opaque_mat
                    and re.search(r'asph|road|track|tarmac', road_key, re.I)
                    and not non_road_mat_re.search(mat_name)
                    and not non_road_mat_re.search(road_key)
                ):
                    road_mat_names.add(mat_name)
                visual_items.append({
                    'name': name,
                    'pos': pos_w.astype(np.float32),
                    'nrm': nrm_w.astype(np.float32),
                    'uv': m['uv'].astype(np.float32),
                    'idx': m['idx'],
                    'mat': m['mat'] + mat_offset,
                    'transparent': m['transparent'],
                    'physics': pcat,
                    'matName': mat_name,
                })

    # Drawn only, never physics: props from another of the mod's models and the objects drifting over the circuit
    visual_items += extra_model_items(cfg, tex_pool, materials, seen_mat_names)
    if cfg.get('driftingObjects'):
        visual_items += drifting_object_items(cfg, tex_pool, materials, seen_mat_names)

    # `skinDir`: the mod's active track skin replaces KN5 textures by file name (case-insensitive, as AC reads it)
    if cfg.get('skinDir'):
        skin_dir = os.path.join(base, cfg['skinDir'])
        by_lower = {k.lower(): k for k in tex_pool}
        n_skin = 0
        for fn in sorted(os.listdir(skin_dir)):
            key = by_lower.get(fn.lower())
            if key and fn.lower().endswith(('.dds', '.png', '.jpg')):
                tex_pool[key] = open(os.path.join(skin_dir, fn), 'rb').read()
                n_skin += 1
        log(f'  skin {cfg["skinDir"]}: {n_skin} textures replaced')

    # `texturePatches`: {texture: [(x0, y0, x1, y1) as fractions of its width and height]}, each rectangle painted over
    # in its own median colour: a panel of a sign atlas that must not be drawn, where hiding by texture would take
    # every other sign on the atlas with it
    for tname, rects in cfg.get('texturePatches', {}).items():
        if tname not in tex_pool:
            log(f'  texture patch: {tname} not found')
            continue
        im = decode_rgba(tex_pool[tname])
        a = np.asarray(im).copy()
        h, w = a.shape[:2]
        for x0, y0, x1, y1 in rects:
            r = (slice(round(y0 * h), round(y1 * h)), slice(round(x0 * w), round(x1 * w)))
            a[r[0], r[1], :3] = np.median(a[r[0], r[1], :3].reshape(-1, 3), 0).astype(np.uint8)
        buf = io.BytesIO()
        Image.fromarray(a, 'RGBA').save(buf, 'PNG')
        tex_pool[tname] = buf.getvalue()
        log(f'  texture patch: {tname}, {len(rects)} rectangle(s) painted over')

    # 2. Extract centreline & AI racing line from fast_lane.ai
    ai_path = os.path.join(layout_path, 'ai', 'fast_lane.ai')
    pts_ai, ex_ai = read_ai_lane(ai_path)
    xz_ai = np.stack([pts_ai['x'], pts_ai['z']], 1).astype(float)
    y_ai = pts_ai['y'].astype(float)
    rgt_ai = cl.rights(cl.tangents(xz_ai))
    n_ai = len(xz_ai)
    min_w = float(cfg.get('minWidthM', 8.5))
    if cfg.get('fixedWidthM'):
        sh_ai = np.zeros(n_ai)
        w_ai = np.full(n_ai, float(cfg['fixedWidthM']))
    else:
        sl = ex_ai[:, 5].astype(float)
        sr = ex_ai[:, 6].astype(float)
        w_raw = sl + sr
        # `laneMinWidthM`: the narrowest believable lane width (a hill climb's road is 5-6 m)
        lane_min = float(cfg.get('laneMinWidthM', 6.0))
        # `maxWidthM` / `maxWidthRatio`: widen the road-width cap for circuits whose real track widens well past its
        # median (Chang's Turn 1 exit is ~19.5 m and Turn 3 entry ~25 m against a 12.8 m median)
        max_w = float(cfg.get('maxWidthM', 22.0))
        max_w_ratio = float(cfg.get('maxWidthRatio', 1.45))
        # A point-to-point course's lane is open: its ends do not wrap round to each other
        fmode, period = ('nearest', None) if cfg.get('pointToPoint') else ('wrap', n_ai)
        w_med = float(np.median(w_raw[(w_raw >= lane_min) & (w_raw <= max_w)]))
        valid = (sl >= 0.2) & (sr >= 0.2) & (w_raw >= lane_min) & (w_raw <= min(max_w, max_w_ratio * w_med))
        sh_ai = np.where(valid, 0.5 * (sr - sl), np.nan)
        w_ai = np.where(valid, w_raw, np.nan)
        idx_a = np.arange(n_ai)
        sh_ai = np.interp(idx_a, idx_a[valid], sh_ai[valid], period=period)
        w_ai = np.interp(idx_a, idx_a[valid], w_ai[valid], period=period)
        sh_ai = ndimage.gaussian_filter1d(ndimage.median_filter(sh_ai, 15, mode=fmode), 6.0, mode=fmode)
        w_ai = ndimage.gaussian_filter1d(ndimage.median_filter(w_ai, 15, mode=fmode), 4.0, mode=fmode)

    xz0 = xz_ai + rgt_ai * sh_ai[:, None]
    start_pt = xz0[0].copy()
    ahead_pt = xz0[min(12, len(xz0) - 1)].copy()

    src = {
        'kind': 'ac',
        'phys_tris': phys_tris,
        'road_mat_names': road_mat_names,
        'xz0': xz0,
        'w_ai': w_ai,
        'y_ai': y_ai,
        'start_pt': start_pt,
        'ahead_pt': ahead_pt,
        'base': base,
        'visual_items': visual_items,
        'layout_path': layout_path,
        'data_dir': data_dir,
        'write_glb': lambda off, extra, glb_out: write_ac_glb(
            visual_items, tex_pool, materials, parse_groove_ini(data_dir), 1.0, off, extra, glb_out,
            double_sided_re=cfg.get('doubleSidedMaterials'),
            bake_masks=bool(cfg.get('bakeMultilayerMasks')), skip_bake=road_mat_names, cfg=cfg,
        ),
    }
    return build_from_sources(tid, cfg, args, src)


def build_from_sources(tid, cfg, args, src):
    """From the physics triangles by surface and a centreline on: the road's width, profile, kerbs, run-off and walls,
    track_data.json and the GLB. `src`: `kind` ('ac' for a mod, 'glb' for a model built in Blender, see
    build_blender_track.py), `phys_tris` {surface: [triangles (N, 3, 3)]}, `road_mat_names`, the centreline `xz0`
    (N, 2) with its lane widths `w_ai` and heights `y_ai`, `start_pt` / `ahead_pt` (the start line and a point past it),
    `base` / `layout_path` / `data_dir` (the mod's folders; missing for a model), optional `pit_points` (N, 3), and
    `write_glb(off, extra_meshes, path)` for the visual model"""
    phys_tris = src['phys_tris']
    road_mat_names = src['road_mat_names']
    xz0, w_ai, y_ai = src['xz0'], src['w_ai'], src['y_ai']
    start_pt, ahead_pt = src['start_pt'], src['ahead_pt']
    base, layout_path, data_dir = src['base'], src['layout_path'], src['data_dir']
    from_mod = src['kind'] == 'ac'
    min_w = float(cfg.get('minWidthM', 8.5))
    max_w = float(cfg.get('maxWidthM', 22.0))

    # Build 2D road raster from physics road triangles and cut along 1WALL* barrier faces
    T_road = np.concatenate(phys_tris['road'], 0)
    T_wall = np.concatenate(phys_tris['wall'], 0) if phys_tris['wall'] else np.zeros((0, 3, 3))
    R, trace, road = cl.build_masks(T_road, np.zeros(len(T_road), np.int32), [0], [])
    if len(T_wall):
        bt.cut_masks(R, trace, road, {}, 1.0, T_wall)
    p2p = None
    if cfg.get('pointToPoint'):
        p2p, xz0, w_ai, y_ai = p2p_loop(cfg, base, xz0, w_ai, y_ai, R, road, T_road)
        start_pt, ahead_pt = p2p['start'], p2p['ahead']
    xz, _ = cl.resample_closed(xz0, 1.0)
    xz = cl.smooth_closed_keep_radius(xz, 4.0)
    xz, L = cl.resample_closed(xz, bt.DS)
    if cfg.get('recentre', True):
        rc_kw = {}
        if 'maxWidthRatio' in cfg:
            r = float(cfg['maxWidthRatio'])
            rc_kw = {'max_width_ratio': r, 'max_local_ratio': r}
        xz = cl.recentre(R, road, xz, bt.DS, iters=2, max_shift=1.5, keep_radius=True, **rc_kw)
    xz = bt.roll_to_start(xz, start_pt, ahead_pt)
    xz, L = cl.resample_closed(xz, bt.DS)
    xz = bt.roll_to_start(xz, start_pt, ahead_pt)
    n = len(xz)
    ds = L / n

    # Map w_ai onto the resampled centreline xz
    tree_ai = cKDTree(xz0)
    _, ia = tree_ai.query(xz)
    width_ai = ndimage.gaussian_filter1d(w_ai[ia], 1.5, mode='wrap')

    tan2 = cl.tangents(xz)
    rgt2 = cl.rights(tan2)
    if cfg.get('fixedWidthM'):
        width = np.full(n, float(cfg['fixedWidthM']))
    else:
        ed = cl.edge_distances(R, road, xz, rgt2)
        hwL, hwR = ed[:, 0].copy(), ed[:, 1].copy()
        # `minHalfWidthM`: the narrowest believable half width (a hill climb's road is 5-6 m)
        min_hw = float(cfg.get('minHalfWidthM', 2.5))
        hw_loc_r = float(cfg['maxWidthRatio']) if 'maxWidthRatio' in cfg else 1.25
        hw_med_r = float(cfg['maxWidthRatio']) if 'maxWidthRatio' in cfg else 1.35
        for a in (hwL, hwR):
            typ = ndimage.median_filter(a, max(9, int(250 / ds) | 1), mode='wrap')
            bad = (a >= 19) | (a < min_hw) | (a > hw_loc_r * typ + 1.0) | (a > hw_med_r * np.median(a) + 0.5)
            a[bad] = np.nan
        w_rast = bt.periodic_interp_nan(hwL) + bt.periodic_interp_nan(hwR)
        w_rast = ndimage.median_filter(w_rast, 9, mode='wrap')
        # Use raster width where valid, blended with fast_lane.ai width where the mesh is narrow
        width = np.where(np.abs(w_rast - width_ai) < 3.0, w_rast, width_ai)
        width = np.clip(ndimage.gaussian_filter1d(width, 2.0, mode='wrap'), min_w, max_w)

    log(f'  centreline: {L:.1f} m ({n} samples, ds={ds:.3f} m), width median={np.median(width):.1f} m ({width.min():.1f}..{width.max():.1f} m)')

    # 3. Assemble physics TriSoup from all horizontal physics meshes
    # Put 1KERB first with a +5 mm height bias so overlapping 1ROAD triangles beneath kerbs never hide MAT_KERB
    soup_tris, soup_mats, soup_cols = [], [], []
    for pcat, mat_id in (
        ('kerb', MAT_KERB),
        ('road', MAT_ROAD),
        ('runoff', MAT_RUNOFF),
        ('pit', MAT_RUNOFF),
        ('gravel', MAT_GRAVEL),
        ('grass', MAT_GRASS),
    ):
        if phys_tris[pcat]:
            t = np.concatenate(phys_tris[pcat], 0).copy()
            if pcat == 'kerb':
                t[:, :, 1] += 0.005
            soup_tris.append(t)
            soup_mats.append(np.full(len(t), mat_id, np.int32))
            soup_cols.append(np.tile(PHYS_COLOURS[mat_id], (len(t), 1)))
    T_soup = np.concatenate(soup_tris, 0)
    M_soup = np.concatenate(soup_mats, 0)
    C_soup = np.concatenate(soup_cols, 0)
    soup = srf.TriSoup(T_soup, M_soup, C_soup)
    road_set = {MAT_ROAD}
    kerb_mats = {MAT_KERB}
    paved_mats = {MAT_RUNOFF}
    grass_mats = {MAT_GRASS}

    # 4. Elevation, lateral profile & 2-pass kerb-aligned edge refinement + recentring
    yc, yprof, bank = sample_profile_and_bank(soup, road_set, xz, rgt2, width, y_ai[ia], ds,
                                                crest_r=float(cfg.get('crestMinRadiusM', 400.0)),
                                                sigma=float(cfg.get('profileSmoothSamples', 1.5)))
    wall_cap = float(cfg.get('wallCapM', bt.WALL_CAP_M))
    refine_wall_cap = min(wall_cap, max(11.5, 0.5 * max_w + 0.5))

    if cfg.get('refineEdges', True):
        r_passes = int(cfg.get('refinePasses', 2))
        r_med = int(cfg.get('refineMedianSamples', 7))
        r_sig = float(cfg.get('refineSmoothSamples', 1.8))
        r_sh_sig = float(cfg.get('refineShiftSmoothSamples', 1.5))
        for _ in range(r_passes):
            w3d_pass = raycast_walls_3d(T_wall, xz, rgt2, yc, bank, refine_wall_cap, min_d=1.8)
            width, eshift = refine_ac_width(
                soup, road_set, kerb_mats, xz, rgt2, yc, bank, width, min_w, max_w, w3d_pass,
                med_samples=r_med, smooth_sigma=r_sig,
            )
            if cfg.get('recentre', True):
                sh = ndimage.gaussian_filter1d(0.5 * (eshift[:, 1] - eshift[:, 0]), r_sh_sig, mode='wrap')
                if p2p:
                    sh[p2p_marks(p2p, xz, L)[4]] = 0.0
                xz = xz + rgt2 * sh[:, None]
                seg = np.linalg.norm(np.roll(xz, -1, 0) - xz, axis=1)
                s_cum = np.concatenate([[0.0], np.cumsum(seg)])
                L = float(s_cum[-1])
                u_s = np.linspace(0.0, L, n, endpoint=False)
                P_cl = np.vstack([xz, xz[:1]])
                xz = np.column_stack([np.interp(u_s, s_cum, P_cl[:, 0]), np.interp(u_s, s_cum, P_cl[:, 1])])
                xz = bt.roll_to_start(xz, start_pt, ahead_pt)
                ds = L / n
                tan2 = cl.tangents(xz)
                rgt2 = cl.rights(tan2)
                _, ia = tree_ai.query(xz)
            yc, yprof, bank = sample_profile_and_bank(soup, road_set, xz, rgt2, width, y_ai[ia], ds,
                                                crest_r=float(cfg.get('crestMinRadiusM', 400.0)),
                                                sigma=float(cfg.get('profileSmoothSamples', 1.5)))
        log(f'  refined width: median={np.median(width):.1f} m ({width.min():.1f}..{width.max():.1f} m)')
    log(f'  elevation: {yc.min():.1f}..{yc.max():.1f} m, closure={yc[-1] - yc[0]:+.2f} m')
    if p2p:
        # The dead stretch: the road's median width, flat, its height straight from the road's end to its start
        finS, endS, stS, splitS, dead = p2p_marks(p2p, xz, L)
        iE, iS = int(round(endS / ds)) % n, int(round(stS / ds)) % n
        k_dead = np.where(dead)[0]
        frac = (k_dead - iE) / max(1, iS - iE)
        yc[k_dead] = yc[iE] + (yc[iS] - yc[iE]) * frac
        yprof[k_dead] = yc[k_dead][:, None]
        bank[k_dead] = 0.0
        width[k_dead] = float(np.median(width[~dead]))
        log(f'  point to point: finish {finS:.0f} m, road to {endS:.0f} m and from {stS:.0f} m of {L:.0f} m, '
            f'splits {", ".join(f"{v:.0f}" for v in splitS) or "none"}')

    # 5. Kerbs, runoff, gravel, grass, walls
    walls = bt.wall_raster(R, T_wall, np.zeros(len(T_wall), np.int32), 0.35) if len(T_wall) else {
        'mask': np.zeros((R.H, R.W), bool),
        'ymin': np.full((R.H, R.W), np.inf),
        'ymax': np.full((R.H, R.W), -np.inf),
    }
    w3d = raycast_walls_3d(T_wall, xz, rgt2, yc, bank, wall_cap, min_d=0.8)
    kerbL = np.zeros(n, bool)
    kerbR = np.zeros(n, bool)
    run = np.zeros((n, 2))
    grav = np.zeros((n, 2))
    wall = w3d.copy()
    road_beyond = np.zeros((n, 2), bool)
    mouth = np.zeros((n, 2), bool)

    for i in range(n):
        for si, side in enumerate((-1.0, 1.0)):
            edge = width[i] / 2
            cls = []
            on_road = 0
            contig = 0
            contig_open = True
            y_follow = yc[i] - side * math.sin(bank[i]) * edge
            for d in np.arange(0.25, 40.0, 0.5):
                p = xz[i] + rgt2[i] * side * (edge + d)
                h = soup.height_near(p[0], p[1], y_follow, 1.5)
                if h is not None:
                    y_follow = h[0]
                cls.append(
                    'none' if h is None
                    else 'kerb' if h[1] in kerb_mats
                    else 'paved' if h[1] in paved_mats
                    else 'grass' if h[1] in grass_mats
                    else srf.classify_colour(h[2])
                )
                if d < 2.0 and h is not None and h[1] in road_set:
                    on_road += 1
                if contig_open:
                    if h is not None and h[1] in road_set:
                        contig += 1
                    elif d > 1.0:
                        contig_open = False
            road_beyond[i, si] = on_road >= 3
            mouth[i, si] = contig * 0.5 >= bt.BRANCH_MOUTH_M
            kh = 0
            for d in (-2.0, -1.4, -0.8, -0.3):
                p = xz[i] + rgt2[i] * side * (edge + d)
                h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * (edge + d), 0.6)
                kh += h is not None and h[1] in kerb_mats
            out_k = 0
            for d in np.arange(0.0, 2.76, 0.25):
                p = xz[i] + rgt2[i] * side * (edge + d)
                h = soup.height_near(p[0], p[1], yc[i] - side * math.sin(bank[i]) * (edge + d), 1.2)
                if h is None:
                    continue
                if h[1] in (MAT_GRASS, MAT_GRAVEL):
                    break
                out_k += h[1] in kerb_mats
            if si == 0:
                kerbL[i] = (kh + out_k) >= 2
            else:
                kerbR[i] = (kh + out_k) >= 2

            k = 0
            miss = 0
            while k < len(cls):
                if cls[k] in ('paved', 'kerb', 'other'):
                    miss = 0
                elif miss < 2:
                    miss += 1
                else:
                    break
                k += 1
            r_m = max(0.0, (k - miss) * 0.5)
            g0 = k - miss
            k = g0
            miss = 0
            while k < len(cls):
                if cls[k] == 'gravel':
                    miss = 0
                elif miss < 2:
                    miss += 1
                else:
                    break
                k += 1
            g_m = max(0.0, (k - miss - g0) * 0.5)
            run[i, si] = r_m
            grav[i, si] = g_m
            if wall[i, si] >= wall_cap - 0.05:
                for d in np.arange(max(2.0, edge - 0.6), wall_cap, 0.2):
                    p = xz[i] + rgt2[i] * side * d
                    q = np.round(R.to_px(p)).astype(int)
                    if not (0 <= q[0] < R.W and 0 <= q[1] < R.H):
                        break
                    if walls['mask'][q[1], q[0]]:
                        yb = yc[i] - side * math.sin(bank[i]) * d
                        if walls['ymax'][q[1], q[0]] > yb + 0.15 and walls['ymin'][q[1], q[0]] < yb + 1.5:
                            wall[i, si] = d
                            break

    for a in (run, grav):
        for si in range(2):
            a[:, si] = ndimage.median_filter(a[:, si], 5, mode='wrap')
    fill_short_wall_gaps(wall, wall_cap, max_gap=4)
    wall_gap = float(cfg.get('wallMinGapM', 1.2))
    wall_hit = wall < (wall_cap - 0.1)
    for si in range(2):
        w_med = ndimage.median_filter(wall[:, si], 3, mode='wrap')
        wall[:, si] = np.where(
            wall_hit[:, si],
            np.maximum(w_med, width / 2 - 0.05),
            np.maximum(w_med, width / 2 + wall_gap),
        )
    ks = ndimage.gaussian_filter1d(bt.curvature(xz, 2), 1.0, mode='wrap')
    wall_open = np.zeros((n, 2), bool)
    allow_open_walls = bool(cfg.get('openWalls', True))
    for si, sgn in ((0, -1.0), (1, 1.0)):
        k_in = ndimage.maximum_filter1d(np.clip(sgn * ks, 0, None), 17, mode='wrap')
        lim = np.maximum(0.85 / np.maximum(k_in, 1e-6), width / 2 + max(0.35, wall_gap))
        if allow_open_walls:
            wall_open[:, si] = (~wall_hit[:, si]) & (wall[:, si] > lim + 1.0)
        wall[:, si] = np.where(wall_hit[:, si], wall[:, si], np.minimum(wall[:, si], lim))
        run[:, si] = np.maximum(0.0, np.minimum(run[:, si], wall[:, si] - width / 2))
        grav[:, si] = np.maximum(0.0, np.minimum(grav[:, si], wall[:, si] - width / 2 - run[:, si]))

    closure = np.zeros((n, 2), bool)
    if cfg.get('closeBranches'):
        grow = max(1, int(round(bt.BRANCH_CLOSE_PAD_M / ds)))
        for si in range(2):
            m = ndimage.binary_opening(mouth[:, si], np.ones(max(2, int(round(2.0 / ds)))))
            closure[:, si] = ndimage.binary_dilation(m, np.ones(2 * grow + 1)) if m.any() else m
            wall[closure[:, si], si] = width[closure[:, si]] / 2 + bt.BRANCH_CLOSE_GAP_M
            run[:, si] = np.minimum(run[:, si], wall[:, si] - width / 2)
            grav[:, si] = np.minimum(grav[:, si], np.maximum(0, wall[:, si] - width / 2 - run[:, si]))
            wall_open[closure[:, si], si] = False
    # `openWallsAt`: [(s0, s1, 'L' | 'R')] stretches (m along the built line) with no barrier collider, for a lap that
    # passes close by another part of itself, where a barrier capped at `wallCapM` would stand across that road
    for s0, s1, side_ in cfg.get('openWallsAt', ()):
        si = 0 if side_ == 'L' else 1
        sm = np.arange(n) * ds
        sel = (sm >= s0) & (sm <= s1) if s0 <= s1 else (sm >= s0) | (sm <= s1)
        wall_open[sel, si] = True
        closure[sel, si] = False
        log(f'  walls opened {side_} {s0:.0f}..{s1:.0f} m ({int(sel.sum())} samples)')

    use_scan_kerbs =bool(phys_tris['kerb']) and bool(cfg.get('scanKerbs', True))
    kerbL = ndimage.binary_closing(kerbL, np.ones(3), border_value=0) & ndimage.binary_opening(kerbL | np.roll(kerbL, 1), np.ones(2))
    kerbR = ndimage.binary_closing(kerbR, np.ones(3), border_value=0) & ndimage.binary_opening(kerbR | np.roll(kerbR, 1), np.ones(2))
    road_beyond = ndimage.binary_opening(road_beyond, np.ones((3, 1)))
    if cfg.get('cornerKerbs', not use_scan_kerbs):
        kerbL, kerbR = bt.corner_kerbs(xz, ds, kerbL, kerbR, road_beyond, False)
    kerbL = bt.tidy_kerb_runs(kerbL, ds, road_beyond[:, 0])
    kerbR = bt.tidy_kerb_runs(kerbR, ds, road_beyond[:, 1])
    if p2p:
        # Nothing on the dead stretch: no kerbs, run-off or barriers, and no colliders (collider_meshes `skip`)
        kerbL[dead] = False
        kerbR[dead] = False
        run[dead] = 0.0
        grav[dead] = 0.0
        wall[dead] = (width[dead] / 2 + wall_cap)[:, None]
        wall_open[dead] = True
        closure[dead] = False
    log(f'  kerbs L={kerbL.mean():.2f} R={kerbR.mean():.2f} (scan_kerbs={use_scan_kerbs}), runoff med={np.median(run):.1f} m, gravel={np.mean(grav > 1):.2f}, wall med L={np.median(wall[:, 0]):.1f} R={np.median(wall[:, 1]):.1f} m')

    # 6. Assemble track_data.json
    off = np.array([
        0.5 * (xz[:, 0].min() + xz[:, 0].max()),
        float(yc.min()) - 5.0,
        0.5 * (xz[:, 1].min() + xz[:, 1].max()),
    ])
    pos3 = np.stack([xz[:, 0], yc, xz[:, 1]], 1) - off
    data = bt.assemble_track_json(tid, cfg, pos3, width, bank, yprof - off[1], kerbL, kerbR, run, grav, wall, L, 1.0)
    data['metadata']['modelOffset'] = [round(float(-v), 4) for v in off]
    data['metadata']['pitboxes'] = cfg.get('pitboxes', 24)
    data['metadata']['author'] = f"{cfg['credit']['author']} ({cfg['credit']['license']})"
    data['metadata']['credit'] = cfg['credit']
    data['metadata']['mesh']['roadMaterials'] = sorted(road_mat_names)
    # The sim fits these surfaces to the road at load and caps the block-modelled kerbs (TrackColliderQuery.ts)
    data['metadata']['mesh']['conformSurfaces'] = True
    if p2p:
        p2p_track_data(data, cfg, n, ds, L, finS, endS, stS, splitS, dead, pos3)
    surf_table = parse_surface_overrides(data_dir) or {}
    surf_table.setdefault('kerb', {})['maxRiseM'] = 0.026
    # The modelled kerbs' entry goes with the physics kerb build_modelled_kerb_mesh makes from the mod's kerb meshes: not
    # with the generated kerbs of a mod that has none (no use_scan_kerbs), nor once that build makes none (below)
    modelled_kerbs = use_scan_kerbs and bool(cfg.get('modelledKerbs'))
    kerb_surface = dict(surf_table['kerb'])
    if modelled_kerbs:
        # The kerbs keep the mod's modelled ridges and slots: no made-up ripple on top of them. They are driven as drawn,
        # so the rise cap (meant for block-modelled kerbs) only has to stop a wheel climbing something else: Willow's
        # stand 2.8-5.5 cm over the run-off and gravel at their outer edge, where the 2.6 cm cap sank the wheel into them
        surf_table['kerb']['bumpHeightM'] = 0.0
        surf_table['kerb']['maxRiseM'] = MODELLED_KERB_MAX_RISE_M
    data['metadata']['surfaceTable'] = surf_table

    # Ensure grid slots stay safely within narrow street/skill-course widths
    t3 = np.roll(pos3, -1, 0) - np.roll(pos3, 1, 0)
    t3 /= np.linalg.norm(t3, axis=1, keepdims=True)
    ac_slots = None
    if cfg.get('useAcStartGrid') and base and not p2p:
        mk_grid = {}
        kn5_candidates = ([cfg['markersKn5']] if cfg.get('markersKn5') else []) + list(cfg.get('kn5_files') or [])
        for kn5_name in kn5_candidates:
            kn5_path = os.path.join(base, kn5_name)
            if os.path.exists(kn5_path):
                mk_grid.update(read_ac_markers(kn5_path))
                if 'AC_START_0' in mk_grid:
                    break
        if 'AC_START_0' in mk_grid:
            ac_slots = []
            for k in range(20):
                key = f'AC_START_{k}'
                if key not in mk_grid:
                    break
                pt_xz = mk_grid[key][[0, 2]]
                idx_near = int(np.argmin(np.linalg.norm(xz - pt_xz, axis=1)))
                dp = pt_xz - xz[idx_near]
                ss_k = (idx_near * ds + float(np.dot(dp, tan2[idx_near]))) % L
                lat_k = float(np.dot(dp, rgt2[idx_near]))
                ac_slots.append((k + 1, ss_k, lat_k))
    spawn = []
    if ac_slots:
        for slot, ss, lat_raw in ac_slots:
            x = ss / ds
            i0 = int(math.floor(x)) % n
            i1 = (i0 + 1) % n
            a = x - math.floor(x)
            w_slot = float(width[i0] * (1 - a) + width[i1] * a)
            lat_limit = max(1.0, w_slot * 0.5 - 1.5)
            lat = round(float(np.clip(lat_raw, -lat_limit, lat_limit)), 2)
            c = pos3[i0] * (1 - a) + pos3[i1] * a
            rg = rgt2[i0] * (1 - a) + rgt2[i1] * a
            rg /= np.linalg.norm(rg)
            fw = t3[i0] * (1 - a) + t3[i1] * a
            fw /= np.linalg.norm(fw)
            bk = bank[i0] * (1 - a) + bank[i1] * a
            pos = c + np.array([rg[0] * lat, -math.sin(bk) * lat + 0.11, rg[1] * lat])
            spawn.append({
                'slot': slot,
                's': round(ss, 2),
                'lateral': lat,
                'position': [round(float(v), 3) for v in pos],
                'yawRad': round(math.atan2(fw[0], fw[2]), 4),
                'forward': [round(float(v), 5) for v in fw],
            })
    else:
        for slot in range(1, 21):
            ss = L - 11.6 - 8.0 * (slot - 1)
            if p2p:
                # One behind the other on the road before the start gate, the first 6 m short of it
                ss = L - 6.0 - 8.0 * (slot - 1)
                if ss < stS + 4.0:
                    break
            x = ss / ds
            i0 = int(math.floor(x)) % n
            i1 = (i0 + 1) % n
            a = x - math.floor(x)
            w_slot = float(width[i0] * (1 - a) + width[i1] * a)
            lat_mag = round(min(3.4, max(1.8, w_slot * 0.24)), 2)
            lat = 0.0 if p2p else lat_mag if slot % 2 == 1 else -lat_mag
            c = pos3[i0] * (1 - a) + pos3[i1] * a
            rg = rgt2[i0] * (1 - a) + rgt2[i1] * a
            rg /= np.linalg.norm(rg)
            fw = t3[i0] * (1 - a) + t3[i1] * a
            fw /= np.linalg.norm(fw)
            bk = bank[i0] * (1 - a) + bank[i1] * a
            pos = c + np.array([rg[0] * lat, -math.sin(bk) * lat + 0.11, rg[1] * lat])
            spawn.append({
                'slot': slot,
                's': round(ss, 2),
                'lateral': lat,
                'position': [round(float(v), 3) for v in pos],
                'yawRad': round(math.atan2(fw[0], fw[2]), 4),
                'forward': [round(float(v), 5) for v in fw],
            })
    data['spawnGrid'] = spawn

    # Populate turns, DRS zones, cameras, and pitLane from AC data
    s_arr = np.arange(n) * ds
    k_arr = ndimage.gaussian_filter1d(bt.curvature(xz, 3), 1.5, mode='wrap')
    # A point-to-point course's AC lap fractions are of its AI lane, which starts before the start gate
    to_s = (lambda f: (f * p2p['laneL'] - p2p['laneS0']) % L) if p2p else None
    data['turns'] = apply_turn_names(data['turns'], data_dir, L, cfg, to_s)
    drs = [] if p2p else parse_drs_zones(data_dir, s_arr, k_arr, L)
    # A model has no drs_zones.ini: it keeps the zones assemble_track_json finds on its straights
    data['drsZones'] = drs if from_mod or drs else data['drsZones']
    data['cameras'] = parse_cameras(data_dir, pos3, rgt2, width, wall, off, L, (lambda f: to_s(f) / L) if p2p else None)
    if src.get('pit_points') is not None:
        data['pitLane'] = pit_lane_from_points(src['pit_points'], xz, off, L, ds)
    else:
        data['pitLane'] = build_pit_lane(layout_path, xz, off, L, ds)

    out_dir = os.path.join(ROOT, 'public', 'tracks', tid)
    os.makedirs(out_dir, exist_ok=True)
    json_out = os.path.join(out_dir, 'track_data.json')
    # The optimiser runs after a full build only: not with --no-line-opt, nor with --no-glb (it checks the GT3's line
    # on the GLB, which this build doesn't write). Without it the previous build's lines stay
    keep_lines = args.no_line_opt or args.no_glb
    carried = keep_lines and carry_previous_lines(json_out, data)
    with open(json_out, 'w', encoding='utf-8') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    # Lines carried over already have the street hairpin margin: a second pass would blend and smooth them again
    if keep_lines and from_mod and not carried:
        apply_street_hairpin_margin(tid, cfg)
    log(f'  wrote {json_out} ({os.path.getsize(json_out) / 1e3:.0f} kB, {len(data["turns"])} turns, {len(data["cameras"])} cams, {len(data["pitLane"]["centerline"])} pit pts)')

    if not args.no_glb:
        rows = (xz, rgt2, yprof, width, bank, kerbL, kerbR, run, grav, wall, wall_open, closure)
        k_rows = int(cfg.get('colliderRowsPerSample', 1))
        if k_rows > 1 and not p2p:
            # the collider meshes from rows cut finer, their heights curved through the samples (upsample_rows)
            rows = bt.upsample_rows(k_rows, *rows)
            log(f'  collider rows: {len(xz)} -> {len(rows[0])}, heights curved between the samples')
        c_xz, c_rgt, c_yprof, c_width, c_bank, c_kL, c_kR, c_run, c_grav, c_wall, c_open, c_closure = rows
        extra = bt.collider_meshes(
            soup, road_set, kerb_mats, c_xz, c_rgt, c_yprof, c_width, c_bank,
            c_kL, c_kR, c_run, c_grav, c_wall, off,
            scan_kerbs=use_scan_kerbs,
            surface_mats=(paved_mats, grass_mats),
            edge_blend_m=(1.0, 4.0),
            wall_open=c_open,
            valid_runoff=None,
            closure=c_closure,
            skip=dead if p2p else None,
            road_twist_m=cfg.get('roadTwistM'),
        )
        if cfg.get('offroadOverRoad'):
            extra = offroad_over_road(extra, soup, road_set, off, xz, rgt2, width, ds)
        for rel in cfg.get('physicsPatches', ()):
            # Before the kerbs: modelled kerbs are seated on the patched road and run-off. Their own table entries
            # are left out, as the kerb is built afresh
            apply_physics_patch(extra, os.path.join(ROOT, rel),
                                skip=('Track_Surface_Kerb',) if modelled_kerbs else ())
        if modelled_kerbs:
            if not build_modelled_kerb_mesh(phys_tris['kerb'], phys_tris['road'], xz, tan2, rgt2, width, ds, off, extra,
                                            src.get('visual_items', ())):
                # No modelled kerb mesh after all: the kerb entry goes back to the one without the modelled kerbs'
                # settings, in the written file as it is now (apply_street_hairpin_margin may have rewritten it)
                data['metadata']['surfaceTable']['kerb'] = kerb_surface
                with open(json_out, encoding='utf-8') as f:
                    written = json.load(f)
                written['metadata']['surfaceTable']['kerb'] = kerb_surface
                with open(json_out, 'w', encoding='utf-8') as f:
                    json.dump(written, f, separators=(',', ':'), ensure_ascii=False)
                log('  modelled kerbs: none built, the kerb surface keeps its rise cap and ripple')
        elif use_scan_kerbs:
            build_ac_kerb_mesh(phys_tris['kerb'], xz, tan2, rgt2, yc, width, ds, off, extra)
        glb_out = os.path.join(out_dir, f'{tid}.glb')
        src['write_glb'](off, extra, glb_out)
        if not args.no_compress:
            r = subprocess.run(
                ['node', 'scripts/compress-track-glb.mjs', glb_out],
                cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
            )
            log('  compress:', (r.stdout.strip() or r.stderr.strip()))
            if r.returncode != 0:
                raise RuntimeError(f'compress-track-glb failed on {glb_out}: {r.stderr}')

    return data


def p2p_track_data(data, cfg, n, ds, L, finS, endS, stS, splitS, dead, pos3):
    """A point-to-point course's track data: its sectors from the split gates (else thirds of the run), its corners
    on the run only, the run's elevation and direction, and `metadata.pointToPoint` for the game (track-data.ts)"""
    s_arr = np.arange(n) * ds
    b1, b2 = (splitS[0], splitS[1]) if len(splitS) >= 2 else (finS / 3, 2 * finS / 3)
    sec = np.where(s_arr < b1, 1, np.where(s_arr < b2, 2, 3))
    keep = [t for t in data['turns'] if 0 <= t['sApprox'] <= finS + 20]
    renum = {t['number']: i + 1 for i, t in enumerate(keep)}
    for t in keep:
        old, new = t['number'], renum[t['number']]
        t['number'] = new
        if t['name'] == f'Turn {old}':
            t['name'] = t['complexName'] = f'Turn {new}'
        t['sector'] = 1 if t['sApprox'] < b1 else 2 if t['sApprox'] < b2 else 3
    data['turns'] = keep
    for smp, q in zip(data['samples'], sec):
        smp['sec'] = int(q)
        smp['turn'] = renum.get(smp['turn'], 0)
    data['sectors'] = [{'id': 1, 'startS': 0.0, 'endS': round(b1, 2)}, {'id': 2, 'startS': round(b1, 2), 'endS': round(b2, 2)},
                       {'id': 3, 'startS': round(b2, 2), 'endS': round(finS, 2)}]
    road = ~dead
    m = data['metadata']
    m['pointToPoint'] = {'finishS': round(finS, 2), 'endS': round(endS, 2), 'startS': round(stS, 2)}
    i_fin = int(round(finS / ds)) % n
    m['direction'] = 'uphill' if pos3[i_fin, 1] >= pos3[0, 1] else 'downhill'
    m['elevationRangeM'] = [round(float(pos3[road, 1].min()), 1), round(float(pos3[road, 1].max()), 1)]
    w = np.array([smp['w'] for smp in data['samples']])[road]
    m['widthMeters'] = f'{np.percentile(w, 10):.0f}m-{np.percentile(w, 90):.0f}m'
    log(f'  run: {finS:.0f} m, {len(keep)} corners, sectors at {b1:.0f} / {b2:.0f} m, '
        f'{pos3[i_fin, 1] - pos3[0, 1]:+.0f} m start to finish')


def carry_previous_lines(json_out, data):
    """A build that skips the racing-line optimiser keeps the previous build's lines: its F1 and GT3 offsets and
    speeds (`ro`, `roGt3`, `r`, `v`, `bL`, `t`) and lap time, copied into `data` when the centreline has as many
    samples. Returns whether they were; if not, `data` keeps the minimum-curvature line"""
    if not os.path.exists(json_out):
        log('  racing lines: no previous track_data.json, the minimum-curvature line')
        return False
    try:
        old_data = json.load(open(json_out, encoding='utf-8'))
    except (OSError, ValueError) as e:
        log(f'  racing lines: previous track_data.json unreadable ({e}), the minimum-curvature line')
        return False
    old_samples = old_data.get('samples', [])
    if len(old_samples) != len(data['samples']):
        log(f'  racing lines: the centreline has {len(data["samples"])} samples, the previous build {len(old_samples)}: '
            'the minimum-curvature line')
        return False
    for p_new, p_old in zip(data['samples'], old_samples):
        for k_opt in ('ro', 'roGt3', 'r', 'v', 'bL', 't'):
            if k_opt in p_old:
                p_new[k_opt] = p_old[k_opt]
    if 'lapTime' in old_data.get('metadata', {}):
        data['metadata']['lapTime'] = old_data['metadata']['lapTime']
    log("  racing lines: kept the previous build's")
    return True


def apply_street_hairpin_margin(tid, cfg):
    """For narrow street circuits with <10 m hairpins (e.g. Monaco), blend the optimised racing line with the
    author's fast_lane.ai line through tight hairpins and enforce a 2.15 m clearance from flush Armco barriers."""
    if cfg.get('type') != 'street':
        return
    json_path = os.path.join(ROOT, 'public', 'tracks', tid, 'track_data.json')
    d = json.load(open(json_path, encoding='utf-8'))
    off = -np.array(d['metadata']['modelOffset'])
    P = np.array([p['p'] for p in d['samples']])
    xz = P[:, [0, 2]] + off[[0, 2]]
    w = np.array([p['w'] for p in d['samples']])
    wL = np.array([p['wL'] for p in d['samples']])
    wR = np.array([p['wR'] for p in d['samples']])
    b = np.array([p['b'] for p in d['samples']])
    rgt = cl.rights(cl.tangents(xz))

    layout_path = os.path.join(cfg['base_dir'], cfg['layout_dir']) if cfg['layout_dir'] else cfg['base_dir']
    pts_ai, _ = read_ai_lane(os.path.join(layout_path, 'ai', 'fast_lane.ai'))
    xz_ai = np.stack([pts_ai['x'], pts_ai['z']], 1).astype(float)
    _, ia = cKDTree(xz_ai).query(xz)
    ro_ai = ndimage.gaussian_filter1d(np.einsum('ij,ij->i', xz_ai[ia] - xz, rgt), 1.5, mode='wrap')

    kc = np.abs(bt.curvature(xz, 2))
    hairpin_w = np.clip(ndimage.gaussian_filter1d((kc > 0.045).astype(float), 5.0, mode='wrap') * 2.5, 0.0, 1.0)
    lo = -np.minimum(w / 2 - 1.35, wL - 2.15)
    hi = np.minimum(w / 2 - 1.35, wR - 2.15)
    ro_f1 = np.array([p['ro'] for p in d['samples']])
    ro_gt3 = np.array([p.get('roGt3', p['ro']) for p in d['samples']])
    ro_f1 = ndimage.gaussian_filter1d(np.clip((1.0 - hairpin_w) * ro_f1 + hairpin_w * ro_ai, lo, hi), 1.2, mode='wrap')
    ro_gt3 = ndimage.gaussian_filter1d(np.clip((1.0 - hairpin_w) * ro_gt3 + hairpin_w * ro_ai, lo, hi), 1.2, mode='wrap')

    for i, p in enumerate(d['samples']):
        e_f1 = float(ro_f1[i])
        e_gt3 = float(ro_gt3[i])
        rp = P[i] + np.array([rgt[i, 0] * e_f1, -math.tan(b[i]) * e_f1, rgt[i, 1] * e_f1])
        p['ro'] = round(e_f1, 3)
        p['roGt3'] = round(e_gt3, 3)
        p['r'] = [round(float(v), 3) for v in rp]
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(d, f, separators=(',', ':'), ensure_ascii=False)


def graft_extras(tid, cfg):
    """--extras-only: builds just the circuit's `extraModels` and `driftingObjects` meshes and grafts them into its
    existing GLB with scripts/graft-track-extras.mjs, which keeps every other byte of it. For a circuit whose full
    rebuild would also change what it ships (converter changes since it was built). The track data and index.json are
    left alone"""
    out_dir = os.path.join(ROOT, 'public', 'tracks', tid)
    glb = os.path.join(out_dir, f'{tid}.glb')
    if not os.path.exists(glb):
        raise SystemExit(f'{tid}: no {glb} to graft onto')
    if not (cfg.get('extraModels') or cfg.get('driftingObjects')):
        raise SystemExit(f'{tid}: no extraModels or driftingObjects to graft')
    log(f'\n=== Grafting the extras of {tid} ===')
    # The add-on's Track_Model takes the circuit model's own offset and scale
    raw = open(glb, 'rb').read()
    head = json.loads(raw[20:20 + struct.unpack('<I', raw[12:16])[0]])
    tm = next(n for n in head['nodes'] if n.get('name') == 'Track_Model')
    off = -np.array(tm.get('translation', [0.0, 0.0, 0.0]), np.float64)
    scale = float(tm.get('scale', [1.0])[0])
    tex_pool, materials, seen_mat_names = {}, [], {}
    items = extra_model_items(cfg, tex_pool, materials, seen_mat_names)
    if cfg.get('driftingObjects'):
        items += drifting_object_items(cfg, tex_pool, materials, seen_mat_names)
    addon = os.path.join(out_dir, f'{tid}.extras.glb')
    write_ac_glb(items, tex_pool, materials, {}, scale, off, [], addon, cfg=cfg)
    try:
        for cmd in (['node', 'scripts/compress-track-glb.mjs', addon], ['node', 'scripts/graft-track-extras.mjs', glb, addon]):
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace')
            log(f'  {os.path.basename(cmd[1])}:', r.stdout.strip() or r.stderr.strip())
            if r.returncode != 0:
                raise RuntimeError(f'{cmd[1]} failed: {r.stderr}')
    finally:
        if os.path.exists(addon):
            os.remove(addon)


def resolve_sources(ids, src_arg):
    """Each circuit's `base_dir`: the mod's track folder on this machine (see the module docstring)"""
    local = json.load(open(LOCAL_SOURCES, encoding='utf-8')) if os.path.exists(LOCAL_SOURCES) else {}
    root = os.environ.get('LIBRECORSA_AC_TRACKS')
    folders = {AC_TRACKS[tid]['folder'] for tid in ids}
    if src_arg and len(folders) > 1:
        raise SystemExit('--src is one track folder: port the layouts of one folder at a time with it')
    for tid in ids:
        cfg = AC_TRACKS[tid]
        path = src_arg or local.get(tid) or local.get(cfg['folder'])
        if not path and root:
            path = os.path.join(root, cfg['folder'])
        if not path:
            raise SystemExit(
                f"{tid}: where is the '{cfg['folder']}' track folder? Pass --src DIR, add it to {LOCAL_SOURCES} "
                'or set LIBRECORSA_AC_TRACKS to the folder holding it'
            )
        path = os.path.expanduser(path)
        if not os.path.isdir(path):
            raise SystemExit(f'{tid}: no track folder at {path}')
        cfg['base_dir'] = path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('id', help='track id, comma-separated ids, or "all"')
    ap.add_argument('--src', help="the mod's track folder (the one holding models*.ini, data/ and the layouts)")
    ap.add_argument('--no-glb', action='store_true')
    ap.add_argument('--no-line-opt', action='store_true')
    ap.add_argument('--no-compress', action='store_true')
    ap.add_argument('--extras-only', action='store_true',
                    help="graft just the circuit's extraModels and driftingObjects into its existing GLB")
    args = ap.parse_args()

    ids = list(AC_TRACKS.keys()) if args.id == 'all' else [x.strip() for x in args.id.split(',')]
    for tid in ids:
        if tid not in AC_TRACKS:
            raise SystemExit(f'Unknown AC track id: {tid}')
    resolve_sources(ids, args.src)
    if args.extras_only:
        for tid in ids:
            graft_extras(tid, AC_TRACKS[tid])
        return
    built = {}
    for tid in ids:
        cfg = AC_TRACKS[tid]
        data = build_ac_track(tid, cfg, args)
        built[tid] = (cfg, data)

    sync_track_configs(built)

    if not args.no_glb and not args.no_line_opt:
        for tid in ids:
            log(f'  optimising F1 and GT3 racing lines for {tid}...')
            # A hill climb's run is timed from rest at the start line to the finish (the optimiser reads pointToPoint)
            bt.optimise_lines(tid, AC_TRACKS[tid].get('lineMarginM'))
            apply_street_hairpin_margin(tid, AC_TRACKS[tid])


if __name__ == '__main__':
    main()
