import { BufferAttribute, BufferGeometry, type Object3D, type Texture } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { readMaterial, type MaterialInputs } from "./shading.js";
import { merge, type Merged } from "./surface.js";
import type { Texels } from "./texels.js";

// The CPU model of a source object that simplify measures against and bakeMesh bakes from.

/** A source object as the CPU reads it: its merged surface, a BVH over it and its materials as inputs. */
export interface Source extends Merged {
  /** per entry of `materials` */
  inputs: MaterialInputs[];
  /** whether any material cuts out */
  cutout: boolean;
  bvh: MeshBVH;
  /** per triangle in BVH order: its triangle in `index` */
  order: Uint32Array;
  /** per triangle in BVH order: first corner, then the two edges from it (9 floats) */
  corners: Float32Array;
}

/**
 * `object` read for `who` (named in errors), to `bake` or only to `measure` the error of
 * a level against it. A measure needs only where the surface is cut out: a cut-out whose
 * textures the CPU cannot read (compressed ones) counts as opaque there, where a bake
 * fails on it.
 */
export function readSource(object: Object3D, who: string, purpose: "bake" | "measure"): Source {
  const merged = merge(object, who);
  const cache = new Map<Texture, Texels>();
  const inputs = merged.materials.map((material) => readMaterial(material, cache, purpose));
  const { positions, index } = merged;
  const count = index.length / 3;
  // Three vertices of its own per triangle: the BVH reorders triangles, and vertex 3t of
  // the reordered index still names triangle t. No indirection on every lookup.
  const own = new Float32Array(count * 9);
  for (let i = 0; i < index.length; i++) own.set(positions.subarray((index[i] ?? 0) * 3, (index[i] ?? 0) * 3 + 3), i * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(own, 3));
  geometry.setIndex(
    new BufferAttribute(
      Uint32Array.from({ length: count * 3 }, (_, i) => i),
      1,
    ),
  );
  const bvh = new MeshBVH(geometry);
  const reordered = geometry.index?.array;
  if (!reordered) throw new Error(`${who}: the BVH dropped its index`);
  const order = new Uint32Array(count);
  const corners = new Float32Array(count * 9);
  for (let j = 0; j < count; j++) {
    const t = (reordered[j * 3] ?? 0) / 3;
    order[j] = t;
    for (let c = 0; c < 3; c++) {
      const a = own[t * 9 + c] ?? 0;
      corners[j * 9 + c] = a;
      corners[j * 9 + 3 + c] = (own[t * 9 + 3 + c] ?? 0) - a;
      corners[j * 9 + 6 + c] = (own[t * 9 + 6 + c] ?? 0) - a;
    }
  }
  return {
    ...merged,
    inputs,
    cutout: inputs.some((input) => input.cutout),
    bvh,
    order,
    corners,
  };
}
