import * as THREE from "three/webgpu";

/**
 * The scene's shadow casters by size, so a cascade draws only those whose shadow is at
 * least a few of its texels across: grass and plants only into the fine maps near the
 * camera, props into the middle ones, houses and trees into all. A caster's size is its
 * own mesh's bounding diameter in the world: a house's gutter counts as small even where
 * its walls are large, and an InstancedLod's mesh measures one instance (at scale 1), not
 * the whole crowd its bounds cover.
 *
 * Casters draw both sides of their faces into the maps. three's default, back faces
 * only, leaks light wherever a model is open: under eaves, through window reveals into
 * the rooms, as thin lit lines across the shadows of houses.
 */
export class Casters {
  /** Meshes that cast, with their size in metres. */
  private readonly meshes: { mesh: THREE.Mesh; size: number }[] = [];

  private readonly seen = new WeakSet<THREE.Mesh>();

  /** Takes over every mesh under `root` that casts a shadow now. */
  constructor(root: THREE.Object3D) {
    this.add(root);
  }

  /** Register only new draws beneath an arriving level or crowd. */
  add(root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || this.seen.has(node)) return;
      this.seen.add(node);
      if (!node.castShadow) return;
      for (const material of [node.material].flat()) material.shadowSide = THREE.DoubleSide;
      const geometry: THREE.BufferGeometry = node.geometry;
      const scale = node.matrixWorld.getMaxScaleOnAxis();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere;
      if (!sphere) throw new Error(`${node.name}: no bounding sphere`);
      this.meshes.push({ mesh: node, size: 2 * sphere.radius * scale });
    });
  }

  /** Lets only casters at least `size` metres across cast; returns how many of those draw now. */
  castFrom(size: number): number {
    let drawn = 0;
    for (const { mesh, size: own } of this.meshes) {
      mesh.castShadow = own >= size;
      if (mesh.castShadow && shown(mesh)) drawn++;
    }
    return drawn;
  }
}

/** Whether `mesh` draws at all now: it and its parents visible, and an instanced mesh with instances. */
function shown(mesh: THREE.Mesh): boolean {
  if (mesh instanceof THREE.InstancedMesh && mesh.count === 0) return false;
  for (let node: THREE.Object3D | null = mesh; node; node = node.parent) if (!node.visible) return false;
  return true;
}
