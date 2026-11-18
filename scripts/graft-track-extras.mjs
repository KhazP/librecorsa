/**
 * Grafts a small add-on GLB into a circuit's GLB, in place: the meshes `scripts/tracks/port_ac_track.py --extras-only`
 * builds (props from another of a mod's models, the objects drifting over the circuit) join a model whose full rebuild
 * would also change what it ships. Every byte the circuit had stays (scripts/lib/graft-glb.mjs says how).
 *
 *   node scripts/graft-track-extras.mjs <circuit.glb> <add-on.glb>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { graftGlb } from "./lib/graft-glb.mjs";

const [circuitPath, addonPath] = process.argv.slice(2);
if (!circuitPath || !addonPath) {
  console.error("usage: node scripts/graft-track-extras.mjs <circuit.glb> <add-on.glb>");
  process.exit(1);
}
const label = path.basename(circuitPath);
const before = readFileSync(circuitPath);
const out = graftGlb(before, readFileSync(addonPath), label);
writeFileSync(circuitPath, out.glb);
console.log(
  `${label}: grafted ${out.meshes} meshes, ${out.nodes} nodes and ${out.images} images (${out.shared} more were the circuit's own) ` +
    `(${(before.length / 1e6).toFixed(2)} MB -> ${(out.glb.length / 1e6).toFixed(2)} MB)`
);
