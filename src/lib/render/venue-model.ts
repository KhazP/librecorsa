import * as THREE from "three";
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createGltfLoader } from "@/lib/render/gltf-loader";

/**
 * Loads a circuit layout from its venue's split model (venue-models.ts, scripts/tracks/split-venue-model.mjs): the layout's
 * own file and the venue's shared file, fetched in parallel. The result is the scene graph the layout's full GLB
 * gives, node for node: the shared scenery goes under the layout file's own `Track_Model` (which carries the layout's
 * offset), in the original order, with the names GLTFLoader would have given in one file. Materials and textures
 * from the shared file are the same objects for both files' meshes, so each texture is decoded and uploaded once.
 */

/** The glTF extension a layout file uses to point at the shared file's materials and textures */
export const VENUE_EXTENSION = "LC_venue_shared";

interface VenueRef {
  material?: number;
  texture?: number;
}

interface LayoutExtras {
  venue: string;
  shared: string;
  /** Track_Model's children in their original order: k ≥ 0 is the shared file's child k, ~k the layout file's child k */
  order: number[];
}

const refOf = (def: { extensions?: Record<string, unknown> } | undefined): VenueRef | undefined =>
  def?.extensions?.[VENUE_EXTENSION] as VenueRef | undefined;

/** Resolves the layout file's references into the shared file, through the shared file's own parser and caches */
class VenueLayoutPlugin implements GLTFLoaderPlugin {
  readonly name = VENUE_EXTENSION;

  constructor(
    private readonly parser: GLTFParser,
    private readonly shared: Promise<GLTFParser>
  ) {}

  loadMaterial(index: number): Promise<THREE.Material> | null {
    const def = this.parser.json.materials?.[index];
    const ref = refOf(def);
    if (ref?.material === undefined) return null;
    const sharedIndex = ref.material;
    return this.shared.then(async (shared) => {
      const material = (await shared.getDependency("material", sharedIndex)) as THREE.Material;
      // A stub keeps its material's name: a pair from two different builds would not line up
      if (def.name !== undefined && material.name !== def.name) {
        throw new Error(`venue model: layout material ${index} "${def.name}" is "${material.name}" in the shared file`);
      }
      this.parser.associations.set(material, { materials: index });
      return material;
    });
  }

  loadTexture(index: number): Promise<THREE.Texture> | null {
    const ref = refOf(this.parser.json.textures?.[index]);
    if (ref?.texture === undefined) return null;
    const sharedIndex = ref.texture;
    return this.shared.then((shared) => shared.getDependency("texture", sharedIndex) as Promise<THREE.Texture>);
  }
}

export interface LoadProgress {
  loaded: number;
  total: number;
  lengthComputable?: boolean;
}

/**
 * A loader for the shared file and one for the layout file, wired so the layout file's references resolve in the
 * shared file's parser: the layout's parse waits for the shared file's parser to start, not for its whole load. Pass
 * the shared file's load to `sharedLoaded` so a failed one fails the layout's parse too instead of leaving it waiting.
 */
export function createVenueLoaders() {
  let resolveParser!: (parser: GLTFParser) => void;
  let rejectParser!: (err: unknown) => void;
  const sharedParser = new Promise<GLTFParser>((resolve, reject) => {
    resolveParser = resolve;
    rejectParser = reject;
  });
  sharedParser.catch(() => {});
  const shared = createGltfLoader().register((parser) => {
    resolveParser(parser);
    return { name: "LC_venue_shared_source" };
  });
  const layout = createGltfLoader().register((parser) => new VenueLayoutPlugin(parser, sharedParser));
  const sharedLoaded = (load: Promise<GLTF>) => {
    load.catch(rejectParser);
    return load;
  };
  return { shared, layout, sharedLoaded };
}

/**
 * The layout's scene with the venue's shared scenery in place. `onProgress` gets both downloads as one (bytes summed).
 * Rejects if either file fails to load or the two are not a pair.
 */
export async function loadVenueLayout(layoutUrl: string, sharedUrl: string, onProgress?: (event: LoadProgress) => void): Promise<THREE.Group> {
  const parts = { layout: { loaded: 0, total: 0, known: false }, shared: { loaded: 0, total: 0, known: false } };
  const report = (part: keyof typeof parts) => (event: ProgressEvent) => {
    parts[part] = { loaded: event.loaded, total: event.total, known: event.lengthComputable !== false && event.total > 0 };
    if (!onProgress) return;
    const known = parts.layout.known && parts.shared.known;
    onProgress({ loaded: parts.layout.loaded + parts.shared.loaded, total: known ? parts.layout.total + parts.shared.total : 0, lengthComputable: known });
  };
  const loaders = createVenueLoaders();
  const sharedLoad = loaders.sharedLoaded(loaders.shared.loadAsync(sharedUrl, report("shared")));
  const layoutLoad = loaders.layout.loadAsync(layoutUrl, report("layout"));
  const [shared, layout] = await Promise.all([sharedLoad, layoutLoad]);
  return mergeVenueLayout(layout, shared);
}

/** Puts the shared file's scenery into the layout's scene (see the file header); returns the layout's scene */
export function mergeVenueLayout(layout: GLTF, shared: GLTF): THREE.Group {
  const extras = layout.userData?.lcVenueLayout as LayoutExtras | undefined;
  const sharedInfo = shared.userData?.lcVenueShared as { venue?: string } | undefined;
  if (!extras || !Array.isArray(extras.order)) throw new Error("venue model: the layout file has no venue data");
  if (sharedInfo?.venue !== extras.venue) throw new Error(`venue model: the shared file is not ${extras.venue}'s`);

  const root = layout.scene;
  const trackModel = root.children.find((o) => o.userData.name === "Track_Model");
  const sharedModel = shared.scene.children.find((o) => o.userData.name === "Track_Model");
  if (!trackModel || !sharedModel) throw new Error("venue model: Track_Model missing");

  unifySharedMaterials(layout, shared, sharedModel);

  const own = [...trackModel.children];
  const common = [...sharedModel.children];
  const used = new Set<number>();
  for (const k of extras.order) {
    const child = k >= 0 ? common[k] : own[~k];
    if (!child || used.has(k)) throw new Error("venue model: the layout file's order does not fit the shared file");
    used.add(k);
    trackModel.add(child);
  }
  if (trackModel.children.length !== own.length + common.length) throw new Error("venue model: the layout file's order leaves children out");

  nameLikeOneFile(root);
  return root;
}

/**
 * GLTFLoader gives each mesh its own copy of its material (a derivative-tangent or vertex-colour variant), one per
 * material and file. A layout-file mesh that uses a shared material gets the shared file's copy, so the two files'
 * meshes share one material object, as they did in one file.
 */
function unifySharedMaterials(layout: GLTF, shared: GLTF, sharedModel: THREE.Object3D): void {
  const variantKey = (mesh: THREE.Mesh, index: number) => {
    const a = mesh.geometry.attributes;
    return `${index}:${mesh.type}:${a.tangent === undefined}:${a.color !== undefined}:${a.normal === undefined}`;
  };
  const sharedVariants = new Map<string, THREE.Material>();
  sharedModel.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const index = shared.parser.associations.get(mesh.material)?.materials;
    if (index === undefined) return;
    const key = variantKey(mesh, index);
    if (!sharedVariants.has(key)) sharedVariants.set(key, mesh.material);
  });
  const materialDefs = layout.parser.json.materials ?? [];
  layout.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const index = layout.parser.associations.get(mesh.material)?.materials;
    const sharedIndex = index === undefined ? undefined : refOf(materialDefs[index])?.material;
    if (sharedIndex === undefined) return;
    const variant = sharedVariants.get(variantKey(mesh, sharedIndex));
    if (variant) mesh.material = variant;
  });
}

/**
 * Node names as GLTFLoader gives them in one file: each parser makes repeated names unique on its own
 * (`CONE_chunk0`, `CONE_chunk0_1`), in depth-first order, so the merged tree is renamed the way a single parse would
 */
function nameLikeOneFile(root: THREE.Object3D): void {
  const used = new Map<string, number>();
  const visit = (o: THREE.Object3D) => {
    const original = o.userData.name;
    if (typeof original === "string" && original) {
      const base = THREE.PropertyBinding.sanitizeNodeName(original);
      const n = used.get(base);
      o.name = n === undefined ? base : `${base}_${n + 1}`;
      used.set(base, n === undefined ? 0 : n + 1);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of root.children) visit(c);
}
