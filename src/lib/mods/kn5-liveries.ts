import { albedoDds, rgbaTexture } from './ac-albedo';
import { colorKey, loadSkinMap, type AsyncDecode, type Kn5Appearance } from './kn5-appearance';
import type { CustomCarSkin } from './mod-store';

/** The ported rig only asks for a blob. Bake on demand, not an RGBA atlas for every skin at startup. */
class BakedAlbedo extends Blob {
  constructor(private readonly bake: () => Promise<ArrayBuffer>) {
    super([], { type: 'image/vnd-ms.dds' });
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.bake();
  }
}

/** Adapt a KN5 material's complete albedo to the ported rig's file-based skin contract. */
export function bindKn5Liveries(
  appearance: Kn5Appearance,
  skins: readonly CustomCarSkin[],
  files: string[][],
  revision: string,
  decode: AsyncDecode,
  baseSkinIndex = 0,
): { skinMaps: Record<string, string>; runtimeSkins: CustomCarSkin[] } {
  const skinMaps: Record<string, string> = Object.create(null);
  const runtimeSkins = skins.map((skin) => ({ ...skin, textures: Object.create(null) as Record<string, Blob> }));
  const recipes = new Map<string, string>();
  for (const { name, looks } of appearance.surfaces) {
    const keys = looks.map(colorKey);
    const baseKey = keys[baseSkinIndex] ?? keys[0];
    if (!keys.some((key) => key !== baseKey)) continue;
    const recipe = JSON.stringify(keys);
    let file = recipes.get(recipe);
    if (!file) {
      const fileName = `lc-skin-${revision}-${recipes.size}.dds`;
      file = fileName;
      recipes.set(recipe, fileName);
      for (let index = 0; index < looks.length; index++) {
        if (keys[index] === baseKey) continue; // The rig restores its template's map for unlisted files.
        const look = looks[index];
        const baseMode = looks[0].alphaMode;
        files[index].push(fileName);
        runtimeSkins[index].textures[fileName] = new BakedAlbedo(async () => {
          const map = await loadSkinMap(look, decode);
          const baked = map && albedoDds(map);
          if (baked) return baked;
          // A missing or invalid loose-only texture must not leave the last livery on the car.
          const fallback = baseMode === 'opaque' ? [36, 40, 49, 255] : [255, 255, 255, 0];
          return albedoDds(rgbaTexture('unmapped', new Uint8Array(fallback), 1, 1))!;
        });
      }
    }
    skinMaps[name] = file;
  }
  return { skinMaps, runtimeSkins };
}
