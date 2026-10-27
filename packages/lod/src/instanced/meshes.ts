import { BufferGeometry, Matrix4, type Mesh } from "three/webgpu";
import { levelMaterial } from "../material.js";
import type { Selection } from "./select.js";

// The meshes an InstancedLod draws its levels with, made from the levels' templates.

const IDENTITY = new Matrix4();

/** The index (or vertex) ranges `mesh` draws, clipped to its draw range; group order is preserved even for empty draws. */
export function ranges(mesh: Mesh): Array<{ count: number; start: number; indexed: boolean }> {
  const { geometry } = mesh;
  const indexed = geometry.index !== null;
  const total = geometry.index?.count ?? geometry.getAttribute("position").count;
  const groups = Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count: total }];
  return groups.map(({ start, count }) => {
    const first = Math.min(total, Math.max(0, start, geometry.drawRange.start));
    const end = Math.min(total, start + count, geometry.drawRange.start + geometry.drawRange.count);
    return { count: Math.max(0, end - first), start: first, indexed };
  });
}

/** The faded material of `mesh`'s material group `group`. */
export function groupMaterial(mesh: Mesh, group: number) {
  if (!Array.isArray(mesh.material)) return levelMaterial(mesh.material);
  const index = mesh.geometry.groups[group]?.materialIndex ?? 0;
  const material = mesh.material[index];
  if (!material) throw new Error(`InstancedLod: "${mesh.name}" has no material ${index}`);
  return levelMaterial(material);
}

/** A geometry drawing `geometry`'s buffers from the indirect arguments at byte `offset`. */
export function indirect(geometry: BufferGeometry, selection: Selection, offset: number): BufferGeometry {
  const view = new BufferGeometry();
  view.index = geometry.index;
  for (const [name, attribute] of Object.entries(geometry.attributes)) view.setAttribute(name, attribute);
  view.morphAttributes = geometry.morphAttributes;
  view.boundingBox = geometry.boundingBox;
  view.boundingSphere = geometry.boundingSphere;
  view.setIndirect(selection.args, offset);
  return view;
}

/** Placed copies of geometries, shared by every InstancedLod drawing the same mesh the same way. */
const copies = new WeakMap<BufferGeometry, Array<{ placement: Matrix4; geometry: BufferGeometry }>>();

/** `geometry` moved by `placement`: itself for the identity, else a copy made once. */
export function placed(geometry: BufferGeometry, placement: Matrix4): BufferGeometry {
  if (placement.equals(IDENTITY)) return geometry;
  const known = copies.get(geometry) ?? [];
  copies.set(geometry, known);
  const hit = known.find((entry) => entry.placement.equals(placement));
  if (hit) return hit.geometry;
  const copy = geometry.clone().applyMatrix4(placement);
  known.push({ placement: placement.clone(), geometry: copy });
  return copy;
}
