import * as THREE from 'three';
import { bakeAlbedo, rgbaTexture, texturePixels, type Rgba } from './ac-albedo';
import { parseCspAppearance, type AlphaMode, type AppearanceRule, type TextureSlot } from './csp-appearance';
import type { Kn5Material, Kn5Model } from './kn5-loader';
import type { CustomCarSkin } from './mod-store';
import { TextureFiles } from './texture-files';

type TextureData = Uint8Array | Blob;
type TextureResource =
  | { key: string; name: string; data: TextureData }
  | { key: string; color: Rgba };
type Slots = Record<TextureSlot, TextureResource[]>;

interface Look {
  slots: Slots;
  brightness: number;
  detailUv: number;
  detailEnabled: boolean;
  detailNormalBlend: number;
  roughness?: number;
  clearcoat?: number;
  alphaMode: AlphaMode;
  alphaRef: number;
}

export interface Kn5Surface {
  name: string;
  material: Kn5Material;
  looks: readonly Look[];
}

export interface Kn5Appearance {
  surfaces: readonly Kn5Surface[];
  /** Node index -> surface index; mesh-targeted rules can split an original KN5 material. */
  meshSurfaces: ReadonlyMap<number, number>;
}

export interface Kn5AppearanceOptions {
  appearanceConfig?: readonly string[];
  skins?: readonly CustomCarSkin[];
  skinFiles?: ReadonlyMap<string, Uint8Array>;
}

export function isGlassMaterial(material: Kn5Material): boolean {
  return /windscreen|glass/i.test(material.shader) || /glass|windshield|windscreen|visor|clearled/i.test(material.name);
}

/**
 * Some KN5s mark solid mechanical parts as blended even though the diffuse
 * alpha stores a specular/detail mask, not coverage. Keep actual cutouts,
 * glass and overlays separate; explicit CSP alpha rules still take priority.
 */
function isSolidMechanic(material: Kn5Material, nodeName: string): boolean {
  if (isGlassMaterial(material) || /logo|decal|badge|sponsor|overlay|foil|emblem|light|lens|visor|window/i.test(material.name)) {
    return false;
  }
  const mechanical = /(?:^|[_\W])(hub|brake|disc|disk|caliper|radiator|cables?|grips?|rims?)(?:[_\W\d]|$)/i;
  return /ksbrakedisc/i.test(material.shader) || mechanical.test(material.name) || mechanical.test(nodeName);
}

function createLook(
  material: Kn5Material,
  rules: readonly AppearanceRule[],
  findResource: (name: string | undefined) => TextureResource[],
  solidMechanic: boolean,
): Look {
  const maps = new Map(Object.entries(material.maps).map(([slot, name]) => [slot.toLowerCase(), name]));
  const props = new Map(Object.entries(material.props).map(([prop, value]) => [prop.toLowerCase(), value]));
  const isMultiMap = /multimap/i.test(material.shader);
  const alphaTested = material.alphaTested || /(?:pixelat|multimapat|_at)(?:_|$)/i.test(material.shader);
  const look: Look = {
    slots: {
      diffuse: findResource(maps.get('txdiffuse') || maps.get('txdiffuse0')),
      detail: findResource(maps.get('txdetail')),
      normal: findResource(maps.get('txnormal') || maps.get('txnormal0')),
      normalDetail: findResource(maps.get('txnormaldetail')),
    },
    brightness: 1,
    detailUv: props.get('detailuvmultiplier') ?? 1,
    detailEnabled: (props.get('usedetail') ?? (isMultiMap ? 1 : 0)) > 0,
    detailNormalBlend: props.get('detailnormalblend') ?? 0.1,
    alphaMode: alphaTested ? 'test' : isGlassMaterial(material) || (material.blend === 1 && !solidMechanic) ? 'blend' : 'opaque',
    alphaRef: props.get('ksalpharef') ?? 0,
  };
  for (const rule of rules) {
    for (const { slot, file, color } of rule.resources) {
      const replacements = findResource(file);
      if (color) replacements.push({ key: `rgba:${color}`, color });
      const all = [...replacements, ...look.slots[slot]];
      look.slots[slot] = all.filter((resource, i) => all.findIndex((candidate) => candidate.key === resource.key) === i);
    }
    look.brightness = rule.brightness ?? look.brightness;
    look.detailUv = rule.detailUv ?? look.detailUv;
    look.detailEnabled = rule.detailEnabled ?? look.detailEnabled;
    look.detailNormalBlend = rule.detailNormalBlend ?? look.detailNormalBlend;
    look.roughness = rule.roughness ?? look.roughness;
    look.clearcoat = rule.clearcoat ?? look.clearcoat;
    look.alphaMode = rule.alphaMode ?? look.alphaMode;
    look.alphaRef = rule.alphaRef ?? look.alphaRef;
  }
  return look;
}

export function planKn5Appearance(kn5: Kn5Model, options: Kn5AppearanceOptions = {}): Kn5Appearance {
  const resourceKeys = new WeakMap<TextureData, string>();
  let nextResource = 0;
  const resource = (name: string, data: TextureData): TextureResource => {
    const key = resourceKeys.get(data) ?? `texture:${nextResource++}`;
    resourceKeys.set(data, key);
    return { key, name, data };
  };
  const embedded = new TextureFiles([...kn5.textures.values()].map((entry) => [entry.name, resource(entry.name, entry.data)]));
  const common = parseCspAppearance(options.appearanceConfig ?? []);
  const variants = options.skins?.length ? options.skins : [undefined];
  const configs = variants.map((skin, i) => {
    const entries: [string, TextureData][] = Object.entries(skin?.textures ?? {});
    if (i === 0 && options.skinFiles) entries.push(...options.skinFiles);
    const files = new TextureFiles(entries.map(([name, data]) => [name, resource(name, data)]));
    return {
      rules: skin?.appearanceConfig ? [...common, ...parseCspAppearance([skin.appearanceConfig])] : common,
      findResource: (name: string | undefined) => {
        const loose = files.find(name), original = embedded.find(name);
        return loose ? (original ? [loose, original] : [loose]) : original ? [original] : [];
      },
    };
  });

  const surfaces: Kn5Surface[] = [];
  const meshSurfaces = new Map<number, number>();
  const groups = new Map<string, number>();
  const names = new Set<string>();
  for (const [index, node] of kn5.nodes.entries()) {
    if (!node.active || !node.mesh?.visible || !node.mesh.renderable) continue;
    const materialIndex = node.mesh.materialIndex;
    const material = kn5.materials[materialIndex];
    if (!material) continue;

    // Opaque KN5 materials do not need splitting when they are shared by body and wheel meshes.
    const solidMechanic = material.blend === 1 && isSolidMechanic(material, node.name);
    const matching = configs.map(({ rules }) => rules.flatMap((rule, id) => rule.matches(material.name, node.name) ? [id] : []));
    const group = `${materialIndex}/${solidMechanic}/${matching.map((ids) => ids.join(',')).join('/')}`;
    let surfaceId = groups.get(group);
    if (surfaceId === undefined) {
      surfaceId = surfaces.length;
      groups.set(group, surfaceId);
      let name = material.name || `material_${surfaceId}`;
      while (names.has(name) || name in Object.prototype) name += `@${surfaceId}`;
      names.add(name);
      const looks = configs.map(({ rules, findResource }, i) =>
        createLook(material, matching[i].map((id) => rules[id]), findResource, solidMechanic));
      surfaces.push({ name, material, looks });
    }
    meshSurfaces.set(index, surfaceId);
  }
  return { surfaces, meshSurfaces };
}

type SyncDecode = (name: string, bytes: Uint8Array) => THREE.Texture | null;
export type AsyncDecode = (name: string, bytes: Uint8Array) => Promise<THREE.Texture | null>;
type Texture = THREE.Texture | null;

function solidTexture(color: Rgba): THREE.DataTexture {
  return rgbaTexture('csp-color', new Uint8Array(color), 1, 1);
}

class TextureCache<T> {
  private readonly cache = new Map<string, T>();

  get(resource: TextureResource, create: (resource: TextureResource) => T): T {
    if (this.cache.has(resource.key)) return this.cache.get(resource.key)!;
    const texture = create(resource);
    this.cache.set(resource.key, texture);
    return texture;
  }
}

type AsyncResolve = (resources: readonly TextureResource[]) => Promise<Texture>;

function createAsyncResolver(decode: AsyncDecode): AsyncResolve {
  const cache = new TextureCache<Promise<Texture>>();
  const read = async (resource: TextureResource) => {
    if ('color' in resource) return solidTexture(resource.color);
    try {
      const bytes = resource.data instanceof Blob ? new Uint8Array(await resource.data.arrayBuffer()) : resource.data;
      return await decode(resource.name, bytes);
    } catch {
      return null;
    }
  };
  return async (resources) => {
    for (const resource of resources) {
      const texture = await cache.get(resource, read);
      if (texture) return texture;
    }
    return null;
  };
}

function usesDetail(look: Look): boolean {
  return look.detailEnabled || !look.slots.diffuse.length;
}

export function colorKey(look: Look): string {
  const detail = usesDetail(look) ? look.slots.detail : [];
  return JSON.stringify([
    look.slots.diffuse.map(({ key }) => key),
    detail.map(({ key }) => key),
    look.brightness, detail.length ? look.detailUv : 1, look.alphaMode,
  ]);
}

function composeMap(look: Look, diffuse: Texture, detail: Texture): Texture {
  return bakeAlbedo({
    diffuse,
    detail,
    detailUv: look.detailUv,
    brightness: look.brightness,
    preserveAlpha: look.alphaMode !== 'opaque',
  });
}

function normalMap(look: Look, base: Texture, detail: Texture): { texture: Texture; scale: number } {
  const image = base?.image as { width?: number; height?: number } | undefined;
  const pixels = detail && (image?.width ?? Infinity) * (image?.height ?? Infinity) <= 64 * 64 ? texturePixels(base) : null;
  // A flat placeholder doesn't deserve priority over a supplied weave/normal detail.
  const flat = pixels && pixels.data.every((value, i) => {
    const channel = i % 4;
    return channel > 2 || (channel === 2 ? value >= 240 : Math.abs(value - 128) < 14);
  });
  const useDetail = Boolean(detail && (!base || flat) && look.detailUv > 0 && look.detailNormalBlend !== 0);
  const chosen = useDetail ? detail : base;
  if (!chosen || (!useDetail && chosen.colorSpace === THREE.NoColorSpace)) return { texture: chosen, scale: 1 };
  const texture = chosen.clone();
  texture.colorSpace = THREE.NoColorSpace;
  if (useDetail) texture.repeat.setScalar(look.detailUv);
  texture.needsUpdate = true;
  return { texture, scale: useDetail ? THREE.MathUtils.clamp(look.detailNormalBlend, -1, 1) : 1 };
}

interface SurfaceTextures {
  map: Texture;
  normal: ReturnType<typeof normalMap>;
}

export function loadBaseTextures(appearance: Kn5Appearance, decode: SyncDecode): SurfaceTextures[] {
  const cache = new TextureCache<Texture>();
  const resolve = (resources: readonly TextureResource[]): Texture => {
    for (const resource of resources) {
      const texture = cache.get(resource, (entry) => {
        if ('color' in entry) return solidTexture(entry.color);
        return entry.data instanceof Uint8Array ? decode(entry.name, entry.data) : null;
      });
      if (texture) return texture;
    }
    return null;
  };
  return appearance.surfaces.map(({ looks: [look] }) => {
    const diffuse = resolve(look.slots.diffuse);
    const detail = usesDetail(look) ? resolve(look.slots.detail) : null;
    return {
      map: composeMap(look, diffuse, detail),
      normal: normalMap(look, resolve(look.slots.normal), resolve(look.slots.normalDetail)),
    };
  });
}

async function loadMap(look: Look, resolve: AsyncResolve): Promise<Texture> {
  const diffuse = await resolve(look.slots.diffuse);
  const detail = usesDetail(look) ? await resolve(look.slots.detail) : null;
  return composeMap(look, diffuse, detail);
}

export async function loadBaseTexturesAsync(
  appearance: Kn5Appearance, decode: AsyncDecode, baseSkinIndex = 0,
): Promise<SurfaceTextures[]> {
  const resolve = createAsyncResolver(decode);
  const maps = new Map<string, Texture>();
  const textures: SurfaceTextures[] = [];
  let sliceStart = performance.now();
  for (const { looks } of appearance.surfaces) {
    // A saved livery replaces the albedo only, just like a live skin swap.
    const look = looks[0];
    const paint = looks[baseSkinIndex] ?? look;
    const key = colorKey(paint);
    if (!maps.has(key)) maps.set(key, await loadMap(paint, resolve));
    textures.push({
      map: maps.get(key)!,
      normal: normalMap(look, await resolve(look.slots.normal), await resolve(look.slots.normalDetail)),
    });
    if (typeof window !== 'undefined' && performance.now() - sliceStart > 24) {
      await new Promise((resolveNext) => setTimeout(resolveNext, 0));
      sliceStart = performance.now();
    }
  }
  return textures;
}

export function loadSkinMap(look: Look, decode: AsyncDecode): Promise<Texture> {
  return loadMap(look, createAsyncResolver(decode));
}
