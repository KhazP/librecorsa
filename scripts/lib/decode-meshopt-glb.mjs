/**
 * Writes a copy of a meshopt-compressed GLB without EXT_meshopt_compression (KHR_mesh_quantization data is
 * kept), so glb-geometry.ts can read it synchronously:  node scripts/lib/decode-meshopt-glb.mjs <in.glb> <out.glb>
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { unpartition } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/lib/decode-meshopt-glb.mjs <in.glb> <out.glb>");
  process.exit(1);
}

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const doc = await io.read(input);
for (const ext of doc.getRoot().listExtensionsUsed()) {
  if (ext.extensionName === "EXT_meshopt_compression") ext.dispose();
}
await doc.transform(unpartition());
await io.write(output, doc);
