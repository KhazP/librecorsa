# Porting a circuit from an F1 25 mod

Qiddiya Speed Park in LibreCorsa originates from an F1 25 track mod (circuit by Maxim555, scenery by Zhenix, hosted with their permission). F1 25 track mods are distributed as `.erp` archives. `scripts/tracks/extract_erp_track.py` unpacks an `.erp` archive into a raw `.glb` and settings `.json`, which `scripts/tracks/build_blender_track.py` then builds into a playable circuit using the standard pipeline (see [Porting circuits](PORTING-TRACKS.md)).

Because the extractor was written specifically for Qiddiya, porting a different F1 25 mod requires editing the material and texture classification tables at the top of the script.

## Personal use only

> Any circuit you extract with this tool is strictly for local, personal use on your own machine. Do not commit it to a repository or fork, upload it to a file host, or serve it publicly.

- Permission granted by Maxim555 and Zhenix covers the official Qiddiya files hosted by LibreCorsa only—it does not extend to third-party copies.
- Only extract mods that are their authors' original creations, and only with their permission. Because `.erp` archives can also bundle base-game assets, the extractor intentionally reads only the mod's own `tracks/<id>/` directory and prefixed materials; preserve that boundary.
- All [circuit licensing rules](PORTING-TRACKS.md#licences) apply equally here.

## Prerequisites

- Everything listed in [Porting circuits](PORTING-TRACKS.md): **Node.js** with `npm install` completed (for mesh simplification and GLB compression) and **[uv](https://docs.astral.sh/uv/)**.
- **Python 3.14** (fetched automatically by `uv`), whose standard library handles the archive's `zstd` compression.
- The mod's `.erp` archive.

## What the extractor reads

- **Track and pit splines:** Reads `ai/<id>_ai_track.trackspacespline`, converting the main path into `Track_Centreline` and `Track_Start` and the pit path into `Track_PitLane`.
- **Geometry:** Extracts meshes bound to materials matching `--mat-prefix`, preserving world-space (`Y`-up) positions, normals, and UVs.
- **Textures:** Decodes diffuse maps only (`BC1`, `BC3`, `BC5`, or `BC7`) restricted strictly to the mod's own folder.
- **Surface classification:** Maps textures to road, run-off, kerb, grass, gravel, and wall surfaces using the lookup tables at the top of the script. Dual-purpose wall/run-off meshes are split by face normal so tunnel ceilings are never treated as drivable ground.

The mod's own cameras and physics definitions are ignored; `build_blender_track.py` generates colliders, kerbs, track widths, and racing lines using LibreCorsa's shared builder.

## Extracting the archive

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt --with texture2ddecoder \
  python -P scripts/tracks/extract_erp_track.py --erp path/to/<id>.erp \
  --track <id> --mat-prefix <prefix> \
  --out-glb /tmp/<id>_raw.glb --out-settings /tmp/<id>_raw.json
```

`--track` and `--mat-prefix` default to Qiddiya's values (`qiddiya` and `qdy_mat_`). Available options:

| Option | Default | Description |
| :-- | :-- | :-- |
| `--max-road-tex` | `1024` | Max texture dimension (px) for road, kerbs, and key driving surfaces |
| `--max-scenery-tex` | `512` | Max texture dimension (px) for scenery textures |
| `--foliage-dist` | `18` | Excludes palm/foliage meshes farther than this distance (m) from the track |
| `--scenery-max-dist` | `200` | Excludes small scenery props farther than this distance (m) from the track |
| `--tiny-scenery-min-tris` | `120` | Merges small, flat-coloured props under this triangle count into vertex colours |
| `--skip-fence02` | On | Drops one exceptionally dense Qiddiya fence mesh |
| `--simplify` | On | Simplifies scenery with UV and normal preservation while keeping road, kerbs, pit lane, and painted lines untouched |

The extractor outputs an uncompressed `.glb` and matching settings `.json`. If the circuit ID already exists in `public/tracks/index.json`, the script copies its existing `credit` block—so update credits in `index.json` before re-running if needed.

## Building the circuit

Feed the extracted files directly into the Blender circuit builder:

```bash
uv run --python 3.14 --no-project --with-requirements scripts/tracks/requirements.txt \
  python -P scripts/tracks/build_blender_track.py <id> --glb /tmp/<id>_raw.glb --settings /tmp/<id>_raw.json
```

Register and verify the circuit as described in [Porting circuits](PORTING-TRACKS.md). To render menu preview images for the venue, run `npm run venue-heroes -- <id>`.

Every geometry and lighting issue documented under [Common issues and fixes](PORTING-TRACKS.md#common-issues-and-fixes) originally surfaced during the Qiddiya port—see the commented settings block inside `main()` near the bottom of `extract_erp_track.py` for concrete reference values.

## Adapting the extractor to another mod

All Qiddiya-specific rules live in configuration tables at the top of `scripts/tracks/extract_erp_track.py`:

- **Surface classification** (`ROAD_KEYS`, `RUNOFF_KEYS`, `KERB_KEYS`, `GRASS_KEYS`, `GRAVEL_KEYS`, `WALL_OR_RUNOFF_KEYS`): Substrings matched against texture names. Ensure road textures span the entire lap and exclude run-off textures from `ROAD_KEYS` so track widths remain accurate.
- **Painted lines and kerbs** (`LINE_KEYS`): Preserves lines as dedicated, unsimplified meshes (preventing wedge artifacts) and applies `depthOffset` so paint and kerbs render cleanly over asphalt.
- **Night illumination** (`EMISSIVE_RULES`): Controls which textures emit light and their daytime vs. nighttime intensity.
- **Buildings and towers** (`TOWER_SKIN_KEYS`): Bakes translucent architectural facades solid with illuminated nighttime windows.
- **Starting grid** (`GRID_BOX_KEYS`): Identifies painted grid-box geometry used to align spawn positions.
- **Branding removal** (`BRAND_REPLACE_COLORS`): Replaces textures containing real sponsors, people, or recognizable locations with flat colours. Inspect every extracted texture manually, as logos frequently use generic filenames.
- **Performance pruning** (`HEAVY_FOLIAGE_KEYS`, `HEAVY_FENCE_KEYS`, `MICRO_DETAIL_SCENERY_KEYS`): Identifies ultra-dense scenery meshes to drop or thin out for mobile GPUs.
- **Circuit metadata and build settings:** Name, country, credits, and builder flags configured near the end of `main()`.
