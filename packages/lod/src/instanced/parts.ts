import { type BufferGeometry, Matrix4, type Mesh, type Object3D } from "three/webgpu";
import { levelMaterial } from "../material.js";
import type { IndirectDraw } from "./select.js";
import { isImpostorMesh, isInstancedMesh, isLOD, isMesh, rejectSkinned } from "../three.js";

// A level template split into the parts an InstancedLod draws, placed in the instance's space.

const IDENTITY = new Matrix4();

export interface Part {
  template: Mesh;
  placement: Matrix4;
  group: number;
  draw: IndirectDraw;
}

/** Template meshes and material groups, placed once in the instance's space. */
export function parts(object: Object3D, level: number): Part[] {
  rejectSkinned(object, "InstancedLod");
  object.updateWorldMatrix(true, true);
  const outside = object.parent ? object.parent.matrixWorld.clone().invert() : new Matrix4();
  const found: Part[] = [];
  object.traverse((node) => {
    if (isLOD(node)) throw new Error("InstancedLod: levels cannot contain a Lod or InstancedLod; nest them with Lod");
    if (isInstancedMesh(node) && !isImpostorMesh(node)) throw new Error(`InstancedLod: levels cannot contain an InstancedMesh ("${node.name}")`);
    if (!isMesh(node)) return;
    const placement = outside.clone().multiply(node.matrixWorld);
    ranges(node).forEach((range, group) => found.push({ template: node, placement, group, draw: { level, ...range } }));
  });
  return found;
}

/** The index (or vertex) ranges `mesh` draws, clipped to its draw range; group order is preserved even for empty draws. */
function ranges(mesh: Mesh): Array<{ count: number; start: number; indexed: boolean }> {
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

/** Placed copies of geometries, shared by every InstancedLod drawing the same mesh the same way. */
const copies = new WeakMap<BufferGeometry, Array<{ placement: Matrix4; geometry: BufferGeometry }>>();

/** `geometry` moved by `placement`: itself for the identity, else a copy made once. */
export function placed(geometry: BufferGeometry, placement: Matrix4): BufferGeometry {
  if (placement.equals(IDENTITY)) return geometry;
  const known = copies.get(geometry) ?? [];
  copies.set(geometry, known);
  const hit = known.find((entry) => entry.placement.equals(placement));
  if (hit) return hit.geometry;
  const copy = geometry.clone();
  const box = copy.boundingBox;
  const sphere = copy.boundingSphere;
  // applyMatrix4 otherwise recomputes both bounds by walking the transformed vertices.
  copy.boundingBox = null;
  copy.boundingSphere = null;
  // Translations leave normals and tangents unchanged; scanning them stalls large source arrivals.
  if (placement.clone().setPosition(0, 0, 0).equals(IDENTITY)) {
    const position = copy.getAttribute("position");
    if (position) {
      position.applyMatrix4(placement);
      position.needsUpdate = true;
    }
  } else copy.applyMatrix4(placement);
  copy.boundingBox = box?.applyMatrix4(placement) ?? null;
  copy.boundingSphere = sphere?.applyMatrix4(placement) ?? null;
  geometry.addEventListener("dispose", () => copy.dispose());
  known.push({ placement: placement.clone(), geometry: copy });
  return copy;
}
