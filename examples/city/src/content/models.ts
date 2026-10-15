import * as THREE from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { foliageModel } from "./foliage.ts";
import { assetUrl, manifest } from "./materials.ts";

const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/**
 * The variants of a fetched model (Poly Haven lays them side by side), each as its own
 * object standing at the origin: centred in x/z, its base where it was. Cut-out leaves
 * get the foliage shading. Each of `groups` lists the top-level nodes of one variant
 * (default: every node on its own).
 */
export async function variants(id: string, groups?: string[][]): Promise<THREE.Object3D[]> {
  const entry = manifest().models[id];
  if (!entry) throw new Error(`model ${id} is not in the manifest`);
  const { scene } = await gltf.loadAsync(assetUrl(entry.file));
  foliageModel(scene, { translucency: 0.6 });
  scene.updateMatrixWorld(true);
  return (groups ?? entry.variants.map((name) => [name])).map((names) => {
    const root = new THREE.Group();
    root.name = names[0] ?? id;
    for (const name of names) {
      const node = scene.getObjectByName(name);
      if (!node) throw new Error(`${id} has no node ${name}`);
      root.add(node);
    }
    const centre = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    for (const node of root.children) {
      node.position.x -= centre.x;
      node.position.z -= centre.z;
    }
    root.traverse((o) => (o.castShadow = o.receiveShadow = true));
    return root;
  });
}
