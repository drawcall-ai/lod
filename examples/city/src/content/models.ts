import * as THREE from "three/webgpu";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { FoliageOptions } from "./foliage.ts";
import { assetUrl, manifest } from "./materials.ts";

const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
let workers = false;

/** The foliage shading of the models' cut-out leaves. */
export const MODEL_FOLIAGE: FoliageOptions = { translucency: 0.6 };

/** Variants share one original GLB fetch, deferred until a mesh level needs its materials or source. */
export function variants(id: string, groups?: string[][]): (() => Promise<THREE.Object3D>)[] {
  const entry = manifest().models[id];
  if (!entry) throw new Error(`model ${id} is not in the manifest`);
  const names = groups ?? entry.variants.map((name) => [name]);
  let pending: Promise<THREE.Object3D[]> | undefined;
  const load = () => (pending ??= loadVariants(id, entry.file, names));
  return names.map((_, index) => async () => {
    const object = (await load())[index];
    if (!object) throw new Error(`${id} has no variant ${index}`);
    return object;
  });
}

async function loadVariants(id: string, file: string, groups: string[][]): Promise<THREE.Object3D[]> {
  if (!workers && MeshoptDecoder.supported) {
    MeshoptDecoder.useWorkers(2);
    workers = true;
  }
  const { scene } = await gltf.loadAsync(assetUrl(file));
  scene.updateMatrixWorld(true);
  return groups.map((names) => {
    const root = new THREE.Group();
    root.name = names[0] ?? id;
    for (const name of names) {
      const node = scene.getObjectByName(name);
      if (!node) throw new Error(`${id} has no node ${name}`);
      const copy = node.clone();
      // Retain the whole authored placement, including shear from scaled parents.
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(node.matrixWorld);
      root.add(copy);
    }
    const centre = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    root.position.set(-centre.x, 0, -centre.z);
    root.traverse((o) => (o.castShadow = o.receiveShadow = true));
    return root;
  });
}
