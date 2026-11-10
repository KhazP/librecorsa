/**
 * Attribution for the third-party models in RISE Motordrome's trackside scenery
 * (public/tracks/rwanda_official/scenery/): the trees and shrubs in foliage.glb (scripts/rwanda-official/foliage.mjs).
 * The file embeds its own entries in its root extras; verify-scenery checks they match these and that CREDITS.md
 * names every model.
 */
export interface SceneryCredit {
  id: string;
  title: string;
  author: string;
  url: string;
  license: string;
  licenseUrl: string;
  changes: string;
}

export const SCENERY_CREDITS: readonly SceneryCredit[] = [
  {
    id: "acacia",
    title: "Acacia tree",
    author: "evolveduk",
    url: "https://sketchfab.com/3d-models/acacia-tree-bb14c2bb679b4d0bb1c578a27e2ddabf",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    changes: "bark simplified, normal maps dropped, leaves toned darker with crown-shaped normals, textures re-encoded to WebP, instanced at the circuit's tree spots",
  },
  {
    id: "shrub",
    title: "Cliff Shrub For Terrain",
    author: "Natural_Disbuster (lemedesign)",
    url: "https://sketchfab.com/3d-models/cliff-shrub-for-terrain-7a0f2bf2982c4ff8bacc67856fdbfae2",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    changes: "normal map dropped, leaves toned darker with crown-shaped normals, texture re-encoded to WebP, instanced at the circuit's bush spots",
  },
];
