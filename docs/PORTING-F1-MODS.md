# Porting a circuit from an F1 25 mod

Qiddiya Speed Park in the game comes from a track mod for F1 25: circuit by Maxim555, scenery by Zhenix, used with their permission. F1 25 mods ship as an `.erp` archive. `scripts/tracks/extract_erp_track.py` reads one and writes a GLB and a settings file, which `scripts/tracks/build_blender_track.py` turns into the game's circuit, the same way it builds a circuit modelled in Blender ([Porting circuits](PORTING-TRACKS.md)).

I wrote the extractor for that one mod. Another mod will need its tables edited (see the end of this page), so expect to read the script.

## Personal use only

- A circuit you port this way is for your own machine. Don't host it anywhere its files can be reached: not in a repository or a fork, not on a file host, not on your own server.
- The Qiddiya files the game loads are hosted with Maxim555's and Zhenix's permission. That permission is for the game. It doesn't cover anyone else's copy.
- Only port a mod that is its authors' own work, and only with their permission. An `.erp` also carries files from the base game. The extractor reads only the mod's own folder (`tracks/<id>/`) and the mod's own materials; keep it that way.
- The [licence rules for circuits](PORTING-TRACKS.md#licences) apply as well.

## What you need

- What the circuits guide lists: Node.js with `npm install` done once (the GLB simplifier and compressor come from it) and [uv](https://docs.astral.sh/uv/) for the Python scripts.
- Python 3.14, which uv fetches. Its standard library reads the zstd compression the archive uses.
- The mod's `.erp` file.

## What the extractor reads

- **The lap and the pit lane**: the mod's AI spline, `ai/<id>_ai_track.trackspacespline`. Its main track becomes `Track_Centreline` and `Track_Start`, and its pit spline `Track_PitLane`.
- **Meshes**: those bound to materials whose names start with the mod's prefix (`--mat-prefix`), with their positions, normals and UVs. The positions are already in world space, Y up.
- **Textures**: diffuse maps only, decoded from BC1, BC3, BC5 or BC7, and only from the mod's own folder.
- **Surfaces by texture name**: road, run-off, kerbs, grass, gravel and walls, from the tables at the top of the script. Meshes that can be wall or run-off are split by the way their faces point, so a tunnel's ceiling isn't driven on.

It leaves out the mod's cameras and its own physics. The shared builder makes the colliders, kerbs, road widths and racing lines, as for every other circuit.

## Extracting

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt --with texture2ddecoder \
  python -P scripts/tracks/extract_erp_track.py --erp path/to/<id>.erp \
  --track <id> --mat-prefix <prefix> \
  --out-glb /tmp/<id>_raw.glb --out-settings /tmp/<id>_raw.json
```

`--track` and `--mat-prefix` default to Qiddiya's (`qiddiya`, `qdy_mat_`). The other options:

| Option | Default | What it does |
|---|---|---|
| `--max-road-tex` | 1024 | Largest texture size for the road, kerbs and other key surfaces |
| `--max-scenery-tex` | 512 | Largest texture size for scenery |
| `--foliage-dist` | 18 | Palm meshes further than this from the track (m) are left out |
| `--scenery-max-dist` | 200 | Small scenery further than this (m) is left out |
| `--tiny-scenery-min-tris` | 120 | Small, flat-coloured scenery under this many triangles is merged into vertex colours |
| `--skip-fence02` | on | Leaves out one very heavy Qiddiya fence |
| `--simplify` | on | Simplifies the meshes with their UVs and normals kept; the road, kerbs, pit lane and painted lines stay exact |

The GLB comes out uncompressed and the settings JSON next to it. If the circuit is already in `public/tracks/index.json`, the extractor takes the credit from there, so change a credit in `index.json` before you rebuild.

## Building

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py <id> --glb /tmp/<id>_raw.glb --settings /tmp/<id>_raw.json
```

Then list it and check it as the circuits guide says. `npm run venue-heroes -- <id>` renders its menu pictures.

Every problem in [Problems you're likely to hit](PORTING-TRACKS.md#problems-youre-likely-to-hit) came up on this port. Qiddiya's settings are in `main()` near the end of the script, with a comment on why each one is there.

## Adapting it to another mod

What is Qiddiya's own sits at the top of the script:

- **Surface tables** (`ROAD_KEYS`, `RUNOFF_KEYS`, `KERB_KEYS`, `GRASS_KEYS`, `GRAVEL_KEYS`, `WALL_OR_RUNOFF_KEYS`): parts of texture names. The road's texture should run the whole lap. If a run-off texture counts as road, the cars get a road as wide as the run-off.
- **Painted lines and kerbs** (`LINE_KEYS`): lines keep their own meshes, unsimplified, or they turn into wedges. Kerbs and lines get the `depthOffset` that keeps them drawn over the road.
- **Night** (`EMISSIVE_RULES`): which textures glow, and how strongly by day and at night.
- **Towers** (`TOWER_SKIN_KEYS`): facades the mod draws with see-through gaps are baked solid, with lit windows at night.
- **The grid** (`GRID_BOX_KEYS`): the painted grid boxes the start grid stands on.
- **Branding** (`BRAND_REPLACE_COLORS`): textures with real sponsors, photos of real people or real places, replaced with a flat colour. Make your own list by looking at every texture the mod uses: logos hide in textures with generic names.
- **Weight** (`HEAVY_FOLIAGE_KEYS`, `HEAVY_FENCE_KEYS`, `MICRO_DETAIL_SCENERY_KEYS`): dense meshes left out or thinned for phones.
- **Settings**: name, country, credit and the build settings, written near the end of `main()`.
