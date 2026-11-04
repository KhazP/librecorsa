import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

/**
 * A GLTFLoader that also reads meshopt-compressed files: the Pages deploy compresses the car models
 * (scripts/compress-car-glb.mjs) while the repository keeps them raw, so the same loader has to take both.
 */
export function createGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}
