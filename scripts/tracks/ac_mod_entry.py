"""
The settings of an Assetto Corsa circuit mod that has no entry in port_ac_track.py's AC_TRACKS, read from the mod
itself, so any circuit mod converts with no setup:

    python -P scripts/tracks/port_ac_track.py <id> --src <track folder> [--layout <name>] [--settings overrides.json]

What it reads (each value is printed with where it came from, and the guessed ones are marked):

- the layouts: folders holding `ai/fast_lane.ai` (the track folder itself for a mod with one layout)
- the models: the layout's `models_<layout>.ini` (or `models.ini`), the models placed where they were modelled;
  without one, `<folder>.kn5` as Assetto Corsa loads it, else every `.kn5` in the folder
- `ui/<layout>/ui_track.json` (or `ui/ui_track.json`): name, country, city, pitboxes, length, tags (street, hill
  climb, oval), author, version and URL
- `data/surfaces.ini`: the mod's own surface keys the porter's shared names miss, each read from its grip, whether it
  counts as track, its sound and its pit-lane flag (`physicsNodeOverrides`)
- a readme or licence file: the author, when ui_track.json has none

What it can't know is guessed: the altitude (0 m), a layout name for a mod with one layout, and a description when
the mod's is only its name. The licence isn't decided here: the credit's is "unknown", with the note that the circuit is
for personal use only, and the mod tool (scripts/mods/importers/ac-track.ts) reads the mod's statements and the
modder's settings with the one licence reader every importer uses (scripts/mods/lib/licences.ts) and credits the
package. A JSON file of overrides (`--settings`) is merged over the entry: any key AC_TRACKS takes, and `credit` key
by key.

Only the standard library: the mod tools and their checks read entries without the porter's packages.
"""
import configparser
import json
import os
import re

# The porter's own default (port_ac_track.build_from_sources): a mod that doesn't say how many pit boxes it has
DEFAULT_PITBOXES = 24
# The credit of a circuit read from a mod until the mod tool reads its licence (scripts/mods/lib/licences.ts, the same
# words)
PERSONAL_USE_NOTE = "For personal use only: the author's permission is needed to share it"
# Assetto Corsa's own pit crew, marshals and props, which mods borrow from the game, several with its logo: the
# hand-written entries leave them out one by one (`hideTextures`), an entry read from the mod leaves out all of them
AC_GAME_TEXTURES = r'^(ac_crew|props_pitlane|commissario\w*|marshal+\w*|sign_turn_kunosSim|DRIVER_Suit2|driver_face)\.dds$'
# Physics meshes a mod names for a barrier's collision box rather than by a surface key (Norisring's COLLISION, Le
# Mans's TWALLCOL, Borgloh's COLWALL): walls
COLLISION_NODES = r'^\d+_?(COLLISION|COL_?WALL|T?WALL_?COL)'
# The settings a hill climb needs that a closed circuit doesn't (Borgloh's and Goodwood's): a narrow country road, no
# kerbs where the mod has none, the line close to its edges
HILLCLIMB = {'laneMinWidthM': 3.0, 'minWidthM': 4.5, 'minHalfWidthM': 1.8, 'cornerKerbs': False, 'lineMarginM': 1.4}
# Country names as the game's region filter knows them (src/lib/track-registry.ts COUNTRY_REGION)
COUNTRIES = {
    'usa': 'United States', 'us': 'United States', 'u.s.a.': 'United States', 'u.s.a': 'United States',
    'u.s.': 'United States', 'united states of america': 'United States', 'america': 'United States',
    'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'gb': 'United Kingdom', 'great britain': 'United Kingdom',
    'britain': 'United Kingdom', 'uae': 'United Arab Emirates', 'korea': 'South Korea',
}
LAYOUT_FILE = os.path.join('ai', 'fast_lane.ai')
TEXT_FILE = re.compile(r'^(read[ _-]?me|licen[cs]e|copying|terms|credits?)\b.*\.(txt|md)$|^(licen[cs]e|copying)$', re.I)
AUTHOR_LINE = re.compile(
    r'^\s*(?:original\s+)?(?:authors?|created by|made by|track by|conversion(?: to ac)?(?: by)?|converted(?: to ac)? '
    r'by|ac conversion(?: by)?)\s*[:\-–]\s*(.+)$', re.I)
MADE_BY = re.compile(r'\b(?i:made|created|built|modell?ed)\b[^.\n]{0,30}?\b(?i:by)\s+([A-Z][\w.\'-]*(?: [A-Z][\w.\'-]*){0,3})')


class EntryError(SystemExit):
    """A mod the entry can't be read from, with a message a modder can act on"""


def read_ini(path):
    """An Assetto Corsa INI file as port_ac_track.parse_ac_ini reads it (a byte-order mark, a line before the first
    section), or an empty one"""
    cp = configparser.ConfigParser(strict=False, inline_comment_prefixes=(';', '//'), interpolation=None)
    cp.optionxform = str
    if os.path.exists(path):
        txt = open(path, 'r', encoding='utf-8-sig', errors='replace').read()
        head = re.search(r'^\s*\[', txt, re.M)
        try:
            cp.read_string(txt[head.start():] if head else '')
        except configparser.Error:
            pass
    return cp


def read_json(path):
    """A mod's JSON as Assetto Corsa and Content Manager take it: a byte-order mark, tabs and line breaks inside
    strings, trailing commas and // comments are all found in ui_track.json files. None when it can't be read"""
    try:
        txt = open(path, 'r', encoding='utf-8-sig', errors='replace').read()
    except OSError:
        return None
    txt = re.sub(r'^\s*//.*$', '', txt, flags=re.M)
    txt = re.sub(r',(\s*[}\]])', r'\1', txt)
    try:
        v = json.loads(txt, strict=False)
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


def text(v, max_len=None):
    """A ui_track.json value as one line of plain text: its HTML (Content Manager's <br>) taken out"""
    if v is None:
        return ''
    if isinstance(v, (list, tuple)):
        v = ', '.join(str(x) for x in v)
    s = re.sub(r'<br\s*/?>', ' ', str(v), flags=re.I)
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    if max_len and len(s) > max_len:
        cut = s[:max_len]
        # at the end of a sentence, else a word
        end = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '))
        s = cut[:end + 1] if end > max_len // 2 else cut[:cut.rfind(' ')].rstrip(',;:') + '…'
    return s


def length_m(v):
    """ui_track.json's length in metres: "3.696 m", "4.169m", "2.411km", "5338", "13633 m". A number under 100 is in
    kilometres whatever its unit says (the mods write 4.169 km as "4.169m")"""
    m = re.search(r'\d+(?:[.,]\d+)?', str(v or ''))
    if not m:
        return None
    x = float(m.group(0).replace(',', '.'))
    if 'km' in str(v).lower() or x < 100:
        x *= 1000
    return round(x) if 100 <= x <= 100000 else None


def as_int(v):
    m = re.search(r'\d+', str(v or ''))
    return int(m.group(0)) if m else None


def humanise(folder):
    s = re.sub(r'[_]+', ' ', folder).strip()
    return s[:1].upper() + s[1:]


def layouts(src):
    """The mod's layouts: the folders holding ai/fast_lane.ai, '' for the track folder itself"""
    out = [''] if os.path.exists(os.path.join(src, LAYOUT_FILE)) else []
    for d in sorted(os.listdir(src), key=str.lower):
        if os.path.isdir(os.path.join(src, d)) and os.path.exists(os.path.join(src, d, LAYOUT_FILE)):
            out.append(d)
    return out


def ui_file(src, layout):
    """The layout's ui_track.json: ui/<layout>/ for a layout in a folder of its own, else ui/"""
    for p in ([os.path.join(src, 'ui', layout, 'ui_track.json')] if layout else []) + [os.path.join(src, 'ui', 'ui_track.json')]:
        if os.path.exists(p):
            return p
    return None


def pick_layout(src, layout=None):
    """The layout to convert: the one named (its folder, or its name in ui_track.json), or the mod's only one"""
    found = layouts(src)
    if not found:
        raise EntryError(f'{src}: no ai/fast_lane.ai in the track folder or a layout folder. Is this the track folder '
                         '(the one holding the .kn5 models, data/ and ui/)? The converter needs the AI lane')
    names = {lay: text((read_json(ui_file(src, lay)) or {}).get('name')) if ui_file(src, lay) else '' for lay in found}
    if layout is not None:
        want = layout.strip().lower()
        hit = [lay for lay in found if lay.lower() == want or (names[lay] and names[lay].lower() == want)]
        if not hit:
            raise EntryError(f'no layout "{layout}" in {src}. ' + layout_list(found, names))
        return hit[0], found, names
    if len(found) > 1:
        raise EntryError(f'{src} has {len(found)} layouts: pick one with --layout <folder>. ' + layout_list(found, names))
    return found[0], found, names


def layout_list(found, names):
    rows = [f"  {(lay or '(the track folder)'):28s} {names[lay]}" for lay in found]
    return 'The layouts:\n' + '\n'.join(rows)


def model_path(src, name):
    """A model a models INI names (its FILE), as a path inside the track folder: '/' between its folders and no '.'
    steps. None for one outside the folder (an absolute path, a drive, a '..' step, or a link that leads out of it),
    which a mod has no reason to name and the converter never reads"""
    parts = [p for p in name.strip().replace('\\', '/').split('/')]
    if not name.strip() or parts[0] == '' or re.match(r'^[A-Za-z]:', parts[0]) or '..' in parts:
        return None
    parts = [p for p in parts if p not in ('', '.')]
    if not parts:
        return None
    root = os.path.realpath(src)
    if os.path.commonpath([root, os.path.realpath(os.path.join(root, *parts))]) != root:
        return None
    return '/'.join(parts)


def models(src, layout):
    """The KN5 models Assetto Corsa loads for the layout, and notes on those left out. From models_<layout>.ini (or
    models.ini): every MODEL_n placed where it was modelled (the porter draws each where its file puts it, so one the
    INI moves or turns, a helicopter in the sky, is left out), no DYNAMIC_OBJECT_n (balloons and planes AC moves
    about), none from extension/ (animated extension objects) and none outside the track folder
    (`model_path`). Without an INI, <folder>.kn5 as Assetto Corsa loads it, else every .kn5 in the folder"""
    notes = []
    ini = None
    for name in ([f'models_{layout}.ini'] if layout else []) + ['models.ini']:
        if os.path.exists(os.path.join(src, name)):
            ini = name
            break
    if ini:
        cp = read_ini(os.path.join(src, ini))
        out = []
        for sec in cp.sections():
            f = cp[sec].get('FILE', '').strip()
            if not f.lower().endswith('.kn5'):
                continue
            if sec.startswith('DYNAMIC_OBJECT_'):
                if f'{f}: a moving object, left out' not in notes:
                    notes.append(f'{f}: a moving object, left out')
                continue
            if not sec.startswith('MODEL_'):
                continue
            inside = model_path(src, f)
            if inside is None:
                notes.append(f'{f}: outside the track folder, left out')
                continue
            f = inside
            moved = [k for k in ('POSITION', 'ROTATION')
                     if any(abs(float(x or 0)) > 1e-6 for x in re.split(r'[,\s]+', cp[sec].get(k, '0,0,0').strip()) if re.fullmatch(r'-?[\d.]+', x or ''))]
            if moved:
                notes.append(f'{f}: placed by {ini} ({", ".join(k.lower() for k in moved)}), left out')
                continue
            if not os.path.exists(os.path.join(src, f)):
                notes.append(f'{f}: named in {ini} but not in the folder')
                continue
            # Extension animated objects (helicopters, drones, flag marshals)
            if re.match(r'extension/', f, re.I):
                notes.append(f'{f}: animated extension object, left out')
                continue
            if f not in out:
                out.append(f)
        if out:
            return out, ini, notes
        notes.append(f'{ini} names no model the converter can use')
    own = os.path.basename(os.path.normpath(src)) + '.kn5'
    if os.path.exists(os.path.join(src, own)):
        return [own], None, notes
    every = sorted((f for f in os.listdir(src) if f.lower().endswith('.kn5')), key=str.lower)
    if not every:
        raise EntryError(f'{src}: no .kn5 models in the track folder')
    return every, None, notes


# A circuit's country or city when the mod doesn't say
UNKNOWN_PLACE = 'Unknown'
# The base game's own circuits, by folder: Kunos's original release (its packs' circuits all start with "ks_")
KUNOS_TRACKS = {'drift', 'imola', 'magione', 'monza', 'mugello', 'spa', 'trento-bondone'}


def kunos_folder(src):
    """Why a track folder is one of Kunos's own circuits by its name ("ks_…", or one of the base game's), or None"""
    folder = os.path.basename(os.path.normpath(src)).lower()
    if folder.startswith('ks_'):
        return f'"{folder}" is one of Kunos\'s own circuits (a "ks_" circuit from the game or its packs)'
    if folder in KUNOS_TRACKS:
        return f'"{folder}" is one of the base game\'s own circuits'
    return None


def kunos_circuit(src, ui, kn5_files):
    """Why a circuit mod is Kunos's own content, or a copy of it, or None: its folder (`kunos_folder`), a model named
    "ks_…" in the folder or among the layout's, a ui_track.json whose author or link names Kunos, or an encrypted model
    among the ones the layout loads (Kunos's own are, and some paid mods'), which can't be read either"""
    why = kunos_folder(src)
    if why:
        return why
    names = [f for f in sorted(os.listdir(src)) if f.lower().endswith('.kn5')] + list(kn5_files)
    own = next((f for f in names if os.path.basename(f).lower().startswith('ks_')), None)
    if own:
        return f'its model "{own}" is one of Kunos\'s own'
    if re.search(r'kunos|assettocorsa\.net', f"{text(ui.get('author'))} {text(ui.get('url'))}", re.I):
        return 'its ui_track.json names Kunos Simulazioni as the author'
    for f in kn5_files:
        with open(os.path.join(src, f), 'rb') as fh:
            if fh.read(6) != b'sc6969':
                return f'its model "{f}" is encrypted, as Kunos\'s own circuits and some paid mods are: it can\'t be read'
    return None


def surface_kind(key, sec):
    """What one of the mod's surfaces.ini keys is to the game, from its own values: 'pit', 'kerb', 'gravel', 'grass',
    'wall', 'road' or 'runoff'"""
    def num(k, d):
        try:
            return float(re.split(r'[\s;]', sec.get(k, str(d)).strip())[0])
        except (ValueError, IndexError):
            return d
    wav = sec.get('WAV', '').strip().lower()
    valid = num('IS_VALID_TRACK', 1) >= 1
    fr = num('FRICTION', 1.0)
    if num('IS_PITLANE', 0) >= 1:
        return 'pit'
    if re.search(r'KERB|CURB|RUMBLE|CUBE', key) or (valid and 'kerb' in wav):
        return 'kerb'
    if re.search(r'SAND|GRAVEL', key) or 'sand' in wav or num('DAMPING', 0) >= 0.05:
        return 'gravel'
    if re.search(r'GRASS|ROCK|DIRT|FOREST|TERRAIN|MUD|SOIL', key) or 'grass' in wav:
        return 'grass'
    if re.search(r'WALL|FENCE|BARRIER|ARMCO', key):
        return 'wall'
    # Astroturf and dirt crossings sound as what they are: driven as run-off whatever their grip
    if 'extraturf' in wav or 'dirt' in wav:
        return 'runoff'
    if valid and fr >= 0.9:
        return 'road'
    # Paved ground off the lap (OFFTRACK, RESTRICTED), or a low-grip surface that still counts as track
    if fr >= 0.8 or valid:
        return 'runoff'
    return 'grass'


def surface_overrides(data_dir, classify):
    """`physicsNodeOverrides` for the mod's own surface keys: each key `classify` (the porter's shared names, which read
    a physics mesh named `1<KEY>...`) doesn't know, as its surfaces.ini values say. A key the shared names call a kerb
    but whose values say otherwise (astroturf painted past the kerbs, CARPET) is read the mod's way, before the shared
    names. Returns (overrides, read them first, notes)"""
    cp = read_ini(os.path.join(data_dir, 'surfaces.ini'))
    found = []
    first = False
    notes = []
    for sec in cp.sections():
        key = cp[sec].get('KEY', '').strip().upper()
        if not key or not re.fullmatch(r'[\w\-.]+', key):
            continue
        shared = classify('1' + key)
        own = surface_kind(key, cp[sec])
        why = (f"FRICTION {cp[sec].get('FRICTION', '1').split(';')[0].strip()}, "
               f"IS_VALID_TRACK {cp[sec].get('IS_VALID_TRACK', '1').split(';')[0].strip()}")
        if shared is None:
            found.append((key, own))
            notes.append(f'{key} → {own} ({why})')
        elif shared == 'kerb' and own != 'kerb':
            found.append((key, own))
            first = True
            notes.append(f'{key} → {own}, not kerb ({why})')
    # Longer keys first, so CONCRETE_OFF is matched before CONCRETE
    found.sort(key=lambda kv: -len(kv[0]))
    overrides = [[rf'^\d+_?{re.escape(k)}', c] for k, c in found]
    overrides.append([COLLISION_NODES, 'wall'])
    return overrides, first, notes


def text_files(src, layout):
    out = []
    for d in [src] + ([os.path.join(src, layout)] if layout else []):
        for f in sorted(os.listdir(d)):
            if TEXT_FILE.match(f) and os.path.isfile(os.path.join(d, f)) and os.path.getsize(os.path.join(d, f)) < 512_000:
                out.append(os.path.join(d, f))
    return out


def read_text(path):
    raw = open(path, 'rb').read()
    for enc in ('utf-8-sig', 'utf-16') if raw[:2] in (b'\xff\xfe', b'\xfe\xff') else ('utf-8-sig', 'cp1252'):
        try:
            return raw.decode(enc).replace('\r', '')
        except UnicodeDecodeError:
            continue
    return raw.decode('latin-1').replace('\r', '')


def readme_facts(paths):
    """From a mod's readme and licence files: the authors named on their own lines or as "made by …" (its licence and
    terms are the mod tool's to read)"""
    authors = []
    for p in paths:
        lines = read_text(p).split('\n')
        for i, line in enumerate(lines[:400]):
            s = line.strip()
            if not s:
                continue
            if i < 80:
                m = AUTHOR_LINE.match(s)
                names = [m.group(1)] if m else [mm.group(1) for mm in MADE_BY.finditer(s)]
                for n in names:
                    # The name alone: not its role, a note in brackets or what follows a comma
                    n = re.split(r'\s{2,}|\t|\s*[(\[,;]|\s[-–]\s', n.strip())[0].strip(' .:-')
                    if 2 <= len(n) <= 60 and n.lower() not in (a.lower() for a in authors):
                        authors.append(n)
    return authors


def hillclimb_markers(src):
    """The model holding a hill climb's start and finish gates (AC_AB_START_* / AC_AB_FINISH_*): AC.kn5 in most, else
    the smallest that has them"""
    cands = sorted((f for f in os.listdir(src) if f.lower().endswith('.kn5')),
                   key=lambda f: (f.lower() != 'ac.kn5', os.path.getsize(os.path.join(src, f))))
    for f in cands:
        if os.path.getsize(os.path.join(src, f)) > 200_000_000:
            continue
        data = open(os.path.join(src, f), 'rb').read()
        if b'AC_AB_START' in data and b'AC_AB_FINISH' in data:
            return f
    return None


def circuit_type(ui):
    words = ' '.join([text(ui.get('tags')), text(ui.get('run'))]).lower()
    if re.search(r'hill ?climb|\ba2b\b|point[- ]to[- ]point', words):
        return 'hillclimb'
    if re.search(r'\bstreet', words):
        return 'street'
    if re.search(r'\boval\b', words):
        return 'oval'
    return None


def common_prefix(names):
    """The words every layout's name starts with ("VIR" of "VIR Full Course" and "VIR North Course")"""
    split = [n.split() for n in names if n]
    if len(split) < 2:
        return ''
    out = []
    for words in zip(*split):
        if len({w.lower() for w in words}) != 1:
            break
        out.append(words[0])
    return ' '.join(out).strip(' -–:|')


def deep_merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def auto_entry(tid, src, layout=None, settings=None, classify=lambda name: None):
    """The AC_TRACKS entry of the mod in `src` (its track folder), read from the mod, with the overrides in `settings`
    (a JSON file) merged over it. `classify` is the porter's shared surface names (port_ac_track.classify_physics_node).
    The entry's `_auto` holds what the porter doesn't read: where each value came from, the layouts, the models"""
    src = os.path.abspath(os.path.expanduser(src))
    if not os.path.isdir(src):
        raise EntryError(f'{src}: not a folder')
    refused = 'Kunos\'s circuits are the game\'s own content, never converted or packaged.'
    if kunos_folder(src):
        raise EntryError(f'refused: {kunos_folder(src)}. {refused}')
    lay, found, ui_names = pick_layout(src, layout)
    folder = os.path.basename(os.path.normpath(src))
    layout_path = os.path.join(src, lay) if lay else src
    ui_path = ui_file(src, lay)
    ui = (read_json(ui_path) if ui_path else None) or {}
    ui_rel = os.path.relpath(ui_path, src) if ui_path else None
    facts = []

    def note(key, value, where):
        facts.append({'key': key, 'value': value, 'from': where})
        return value

    def from_ui(key, field, fallback, why, conv=text):
        v = conv(ui.get(field)) if ui.get(field) not in (None, '') else None
        if v:
            return note(key, v, ui_rel)
        return note(key, fallback, f'guessed: {why}')

    cfg = {'folder': folder, 'layout_dir': lay}
    kn5, ini, model_notes = models(src, lay)
    kunos = kunos_circuit(src, ui, kn5)
    if kunos:
        raise EntryError(f'refused: {kunos}. {refused}')
    cfg['models_ini'] = None
    cfg['kn5_files'] = note('kn5_files', kn5, ini or ('the folder\'s own model' if kn5 == [folder + '.kn5'] else 'every model in the folder'))

    # The name: the words every layout's name shares, and the rest of this one's its layout
    own_name = text(ui.get('name'), 80)
    shared = common_prefix([ui_names[x] for x in found]) if len(found) > 1 else ''
    if shared and own_name.lower().startswith(shared.lower()) and len(shared) >= 3:
        rest = own_name[len(shared):].strip(' -–:|')
        cfg['name'] = note('name', shared, f'{ui_rel}, the words every layout\'s name starts with')
        cfg['layout'] = (note('layout', rest, ui_rel) if rest
                         else note('layout', humanise(lay), 'guessed: the layout\'s folder'))
    else:
        cfg['name'] = (note('name', own_name, ui_rel) if own_name
                       else note('name', humanise(folder), 'guessed: the track folder\'s name'))
        cfg['layout'] = (note('layout', humanise(lay), 'guessed: the layout\'s folder') if lay and len(found) > 1
                         else note('layout', 'Full circuit', 'guessed: the mod has one layout'))
    country = text(ui.get('country'), 60)
    country = COUNTRIES.get(country.lower(), country)
    # A package's circuit must name both (mod-manifest.ts): "Unknown" when the mod doesn't, rather than a refusal at the
    # end of a build of several minutes
    cfg['country'] = (note('country', country, ui_rel) if country
                      else note('country', UNKNOWN_PLACE, 'guessed: the mod doesn\'t say'))
    cfg['city'] = from_ui('city', 'city', UNKNOWN_PLACE, 'the mod doesn\'t say', lambda v: text(v, 60))
    cfg['baseAltitudeM'] = note('baseAltitudeM', 0, 'guessed: the mod doesn\'t say (it sets the air density)')
    cfg['pitboxes'] = from_ui('pitboxes', 'pitboxes', DEFAULT_PITBOXES, 'the mod doesn\'t say', as_int)

    kind = circuit_type(ui)
    if kind:
        cfg['type'] = note('type', kind, f'{ui_rel} (tags)')
    if kind == 'hillclimb':
        markers = hillclimb_markers(src)
        if not markers:
            raise EntryError(f'{src}: tagged a hill climb, but no model holds its start and finish gates (AC_AB_START, '
                             'AC_AB_FINISH). Set "type" and "pointToPoint" in --settings if it is a closed circuit')
        cfg['pointToPoint'] = True
        cfg['markersKn5'] = note('markersKn5', markers, 'the model holding AC_AB_START and AC_AB_FINISH')
        for k, v in HILLCLIMB.items():
            cfg[k] = note(k, v, 'guessed: as the hill climbs the game has')

    overrides, first, surface_notes = surface_overrides(os.path.join(layout_path, 'data'), classify)
    cfg['physicsNodeOverrides'] = overrides
    if first:
        cfg['physicsOverridesFirst'] = True
    note('physicsNodeOverrides', surface_notes or ['the shared surface names'], os.path.join(lay, 'data', 'surfaces.ini') if lay else 'data/surfaces.ini')
    cfg['hideTextures'] = note('hideTextures', AC_GAME_TEXTURES, "guessed: Assetto Corsa's own crew, marshals and props")

    # The credit: ui_track.json's author, else the readme's. The licence is the mod tool's to decide (see above): until
    # it does, the circuit is for personal use only
    authors = readme_facts(text_files(src, lay))
    author = text(ui.get('author'), 80)
    if author:
        note('credit.author', author, ui_rel)
    elif authors:
        author = note('credit.author', text(', '.join(authors), 80), 'guessed: the readme')
    else:
        author = note('credit.author', 'Unknown', 'guessed: the mod doesn\'t say')
    url = text(ui.get('url')) or None
    if url and not re.match(r'^https?://', url):
        url = None
    version = text(ui.get('version'), 32) or None
    cfg['credit'] = {
        'title': text(ui.get('name'), 80) or cfg['name'],
        'author': author,
        'url': note('credit.url', url, ui_rel) if url else None,
        'short': None,
        'license': 'unknown',
        'licenseUrl': None,
        'note': PERSONAL_USE_NOTE,
    }
    if version:
        note('version', version, ui_rel)

    desc = text(ui.get('description'), 600)
    if len(desc.split()) >= 6 and desc.lower() != own_name.lower():
        cfg['description'] = note('description', desc, ui_rel)
    else:
        where = ', '.join(x for x in (cfg['city'], cfg['country']) if x and x != UNKNOWN_PLACE)
        by = f"{author}'s" if author != 'Unknown' else 'an'
        cfg['description'] = note('description', f"{cfg['name']}, {cfg['layout']}{f' ({where})' if where else ''}, "
                                                 f'converted from {by} Assetto Corsa mod.', 'guessed: the mod\'s is only its name')

    # A modder's overrides, merged over all of it
    overrides_json = {}
    if settings:
        try:
            overrides_json = json.load(open(settings, encoding='utf-8'))
        except (OSError, ValueError) as e:
            raise EntryError(f'{settings}: {e}')
        if not isinstance(overrides_json, dict):
            raise EntryError(f'{settings}: not a JSON object of settings')
        cfg = deep_merge(cfg, {k: v for k, v in overrides_json.items() if not k.startswith('_')})
    own_credit = overrides_json.get('credit') if isinstance(overrides_json.get('credit'), dict) else {}

    cfg['base_dir'] = src
    cfg['_auto'] = {
        'id': tid,
        'src': src,
        'layouts': found,
        'facts': facts,
        # What the modder's settings set, by key (`credit.<key>` for the credit's)
        'overridden': sorted([k for k in overrides_json if not k.startswith('_') and k != 'credit']
                             + [f'credit.{k}' for k in own_credit]),
        'models': model_notes,
        'uiLengthM': length_m(ui.get('length')),
        'version': version,
    }
    return cfg


def report(cfg, log=print):
    """Prints the entry read from the mod: each value with where it came from, the guessed ones marked"""
    a = cfg['_auto']
    over = list(a['overridden'])

    def value(key):
        v = cfg
        for part in key.split('.'):
            v = v.get(part) if isinstance(v, dict) else None
        return v

    def row(mark, key, v, where):
        shown = '; '.join(map(str, v)) if isinstance(v, list) else str(v)
        if len(shown) > 60:
            shown = shown[:57] + '...'
        log(f'    {mark:8s} {key:22s} {shown:60s} {where}')

    log(f"  the circuit's settings, read from the mod ({a['src']}):")
    for f in a['facts']:
        if f['key'] in over:
            continue
        guessed = f['from'].startswith('guessed: ')
        if f['key'] == 'physicsNodeOverrides':
            row('read', 'surfaces', '', f['from'])
            for n in f['value']:
                log(f'{"":34s}{n}')
            continue
        row('GUESSED' if guessed else 'read', f['key'], f['value'], f['from'].removeprefix('guessed: '))
    for key in over:
        row('yours', key, value(key), 'your settings')
    for n in a['models']:
        log(f'    models: {n}')
    log('    (override any of these: --settings <file.json>, e.g. {"baseAltitudeM": 120, "credit": {"license": "…"}})')
