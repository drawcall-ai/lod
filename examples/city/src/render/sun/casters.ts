import * as THREE from "three/webgpu";
import { attribute, positionLocal, renderGroup, uint, uniform, vec3 } from "three/tsl";

interface Batch {
  sizes: readonly number[];
  mask: number;
}

// InstancedLod's indirect geometry views share the source's attributes, but not its
// geometry identity. The house source has identity placements, so these survive.
const batches = new WeakMap<THREE.BufferAttribute | THREE.InterleavedBufferAttribute, Batch>();

/**
 * Keeps the original parts' shadow cutoffs when a static house mesh is merged.
 * `cityShadowPart` holds each vertex's part index; register after packing attributes,
 * before constructing its LOD. Each returned material owns this batch's mask.
 */
export function register(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshStandardNodeMaterial,
  diameters: readonly number[],
): THREE.MeshStandardNodeMaterial {
  const part = geometry.getAttribute("cityShadowPart");
  if (!part || part.itemSize !== 1 || part.normalized || part.count !== geometry.getAttribute("position").count)
    throw new Error("Invalid house shadow part attribute");
  if (diameters.length === 0 || diameters.length > 32 || diameters.some((size) => !Number.isFinite(size) || size < 0))
    throw new Error("House shadow batch needs 1–32 finite part diameters");
  if (batches.has(part)) throw new Error("House shadow parts already registered");
  if (material.positionNode || material.castShadowPositionNode) throw new Error("House shadow batching requires static positions");
  const batch: Batch = { sizes: [...diameters], mask: 0 };
  batches.set(part, batch);
  const mask = uniform(0, "uint")
    .onRenderUpdate(() => batch.mask)
    .setGroup(renderGroup);
  const keep = mask
    .shiftRight(uint(attribute<"float">("cityShadowPart", "float")))
    .bitAnd(uint(1))
    .notEqual(uint(0));
  const copy = material.clone();
  // Collapse all vertices of an ineligible part before rasterization. The LOD's
  // normal shadow fade still wraps this position when it copies the material.
  copy.castShadowPositionNode = keep.select(positionLocal, vec3(0));
  return copy;
}

/**
 * The scene's shadow casters by size, so a cascade draws only those whose shadow is at
 * least a few of its texels across: grass and plants only into the fine maps near the
 * camera, props into the middle ones, houses and trees into all. A caster's size is its
 * own mesh's bounding diameter in the world: a house's gutter counts as small even where
 * its walls are large, and an InstancedLod's mesh measures one instance (at scale 1), not
 * the whole crowd its bounds cover. Merged houses retain each original part's diameter;
 * rejected parts collapse in the shadow vertex shader instead of drawing larger shadows.
 *
 * Casters draw both sides of their faces into the maps. three's default, back faces
 * only, leaks light wherever a model is open: under eaves, through window reveals into
 * the rooms, as thin lit lines across the shadows of houses.
 */
export class Casters {
  /** Meshes that cast, largest first, with their size (m). */
  private readonly meshes: { mesh: THREE.Mesh; size: number; scale: number; batch?: Batch }[] = [];

  private readonly intent = new WeakMap<THREE.Mesh, boolean>();

  /** Takes over every mesh under `root` that casts a shadow now. */
  constructor(root: THREE.Object3D) {
    this.refresh(root);
  }

  /** Rebuild after lazy levels replace their draws, retaining original caster intent. */
  refresh(root: THREE.Object3D): void {
    this.meshes.length = 0;
    root.updateMatrixWorld(true);
    const scales = new Map<Batch, number>();
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const casts = this.intent.get(node) ?? node.castShadow;
      this.intent.set(node, casts);
      if (!casts) return;
      for (const material of [node.material].flat()) material.shadowSide = THREE.DoubleSide;
      const geometry: THREE.BufferGeometry = node.geometry;
      const part = geometry.getAttribute("cityShadowPart");
      const batch = part ? batches.get(part) : undefined;
      if (part && !batch) throw new Error(`${node.name}: house shadow part attributes changed after registration`);
      const scale = node.matrixWorld.getMaxScaleOnAxis();
      if (batch) {
        const previous = scales.get(batch);
        if (previous !== undefined && previous !== scale) throw new Error(`${node.name}: shared house shadow batch has different world scales`);
        scales.set(batch, scale);
        this.meshes.push({ mesh: node, size: Math.max(...batch.sizes) * scale, scale, batch });
        return;
      }
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const sphere = geometry.boundingSphere;
      if (!sphere) throw new Error(`${node.name}: no bounding sphere`);
      this.meshes.push({ mesh: node, size: 2 * sphere.radius * scale, scale });
    });
    this.meshes.sort((a, b) => b.size - a.size);
  }

  /** Lets only casters at least `size` metres across cast; returns how many of those draw now. */
  castFrom(size: number): number {
    let drawn = 0;
    for (const { mesh, size: own, scale, batch } of this.meshes) {
      if (batch) {
        let mask = 0;
        batch.sizes.forEach((diameter, part) => {
          if (diameter * scale >= size) mask |= 1 << part;
        });
        batch.mask = mask >>> 0;
      }
      mesh.castShadow = batch ? batch.mask !== 0 : own >= size;
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
