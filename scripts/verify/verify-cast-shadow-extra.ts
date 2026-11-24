/**
 * A circuit GLB may set a `castShadow` extra (true or false) on a node or a mesh; the scene builder takes it over its
 * size and naming rules (scene-builder.ts, castShadowExtra). Checked on a synthetic graph, as GLTFLoader builds one:
 * node and mesh extras in `userData`.
 *
 *   npx tsx scripts/verify/verify-cast-shadow-extra.ts
 */
import * as THREE from 'three';
import { castShadowExtra } from '../../src/lib/scene-builder';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

const mesh = (extras?: Record<string, unknown>) => Object.assign(new THREE.Mesh(), { userData: { ...extras } });
const node = (extras: Record<string, unknown> | undefined, ...children: THREE.Object3D[]) => {
  const g = new THREE.Group();
  Object.assign(g.userData, extras);
  g.add(...children);
  return g;
};

const plain = mesh();
const offByNode = mesh();
const onByMesh = mesh({ castShadow: true });
const offByMesh = mesh({ castShadow: false });
const notBoolean = mesh({ castShadow: 'yes' });
const deep = mesh();
const root = node({ castShadow: true }, // the scene root's own extras are not the meshes'
  node(undefined, plain),
  node({ castShadow: false }, offByNode, onByMesh),
  node({ castShadow: true }, offByMesh, notBoolean),
  node({ castShadow: false }, node({ decal: true }, node(undefined, deep)))
);

check('no extra: the rules decide', castShadowExtra(plain, root) === undefined);
check('a node set to false turns its mesh off (false is not "unset")', castShadowExtra(offByNode, root) === false);
check("the mesh's own extra wins over its node's", castShadowExtra(onByMesh, root) === true && castShadowExtra(offByMesh, root) === false);
check('a value that is not a boolean is ignored (the node above decides)', castShadowExtra(notBoolean, root) === true);
check('found through several levels of nodes', castShadowExtra(deep, root) === false);
check("the root's own extras are left out", castShadowExtra(root.children[0], root) === undefined);

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll castShadow extra checks passed.');
