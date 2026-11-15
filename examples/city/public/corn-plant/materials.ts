import * as THREE from "three/webgpu";
import { dryLeafMaterial, huskMaterial, leafMaterial } from "./leaf.ts";

/** The materials of one script's corn plants, which every plant shares. */
export interface Materials {
  /** Plant tissue coloured by vertex colours: stalk, sheaths, tassel, silk, roots. */
  tissue: THREE.MeshStandardMaterial;
  leaf: THREE.Material;
  dryLeaf: THREE.Material;
  husk: THREE.Material;
}

export const materials = (): Materials => ({
  tissue: new THREE.MeshStandardMaterial({ name: "corn-tissue", vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }),
  leaf: leafMaterial(),
  dryLeaf: dryLeafMaterial(),
  husk: huskMaterial(),
});
