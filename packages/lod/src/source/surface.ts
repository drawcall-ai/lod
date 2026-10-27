import { Matrix3, Vector3, type BufferGeometry, type Material, type Matrix4, type Mesh, type Object3D } from "three/webgpu";
import { forEachMesh } from "../bounds.js";
import { isImpostorMesh, rejectSkinned } from "../three.js";

/** Indexed triangles as flat arrays, in one space. */
export interface Surface {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;
}

/** A surface merged from meshes, with what each triangle is drawn with. */
export interface Merged extends Surface {
  /** uv per vertex, 0 where a mesh has none */
  uvs: Float32Array;
  /** whether every mesh has UVs: only then are they a layout of the whole surface */
  hasUvs: boolean;
  /** rgb per vertex, 1 where a mesh has no colours */
  colors: Float32Array;
  materials: Material[];
  /** per triangle, its index into `materials` */
  slots: Uint16Array;
}

/**
 * Every triangle drawn at full detail under `root` (see `forEachMesh`: nested LODs at
 * level 0, every instance) in `root`'s own space (its own transform not applied), merged
 * into one surface; errors name `who` asked. Triangles of a hidden material, or outside
 * every group of a multi-material mesh, are left out, as three draws neither; so is an
 * ImpostorMesh, which has no triangles of its own.
 */
export function merge(root: Object3D, who: string): Merged {
  rejectSkinned(root, who);
  const meshes: Array<{ mesh: Mesh; matrix: Matrix4 }> = [];
  forEachMesh(root, (mesh, placement) => {
    if (!isImpostorMesh(mesh)) meshes.push({ mesh, matrix: placement.clone() });
  });

  let vertexCount = 0;
  let indexCount = 0;
  for (const { mesh } of meshes) {
    const count = mesh.geometry.getAttribute("position").count;
    vertexCount += count;
    indexCount += mesh.geometry.index?.count ?? count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3).fill(1);
  const index = new Uint32Array(indexCount);
  const slots = new Uint16Array(indexCount / 3);
  const materials: Material[] = [];
  let hasUvs = true;

  const normalMatrix = new Matrix3();
  const v = new Vector3();
  // Geometries without normals get them once, however many instances share them.
  const withNormals = new Map<BufferGeometry, BufferGeometry>();
  let base = 0;
  let written = 0;
  for (const { mesh, matrix } of meshes) {
    let geometry = withNormals.get(mesh.geometry) ?? mesh.geometry;
    if (!geometry.getAttribute("normal")) {
      withNormals.set(mesh.geometry, (geometry = geometry.clone()));
      geometry.computeVertexNormals();
    }
    normalMatrix.getNormalMatrix(matrix);
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const color = geometry.getAttribute("color");
    hasUvs &&= uv !== undefined;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i)
        .applyMatrix4(matrix)
        .toArray(positions, (base + i) * 3);
      v.fromBufferAttribute(normal, i)
        .applyMatrix3(normalMatrix)
        .normalize()
        .toArray(normals, (base + i) * 3);
      if (uv) ((uvs[(base + i) * 2] = uv.getX(i)), (uvs[(base + i) * 2 + 1] = uv.getY(i)));
      if (color) for (let c = 0; c < 3; c++) colors[(base + i) * 3 + c] = color.getComponent(i, c);
    }
    const count = geometry.index?.count ?? position.count;
    const at = (i: number) => geometry.index?.getX(i) ?? i;
    // A mirroring transform turns the triangles inside out: swap two corners.
    const flip = matrix.determinant() < 0;
    const list = [mesh.material].flat();
    const groups = geometry.groups.length > 0 && Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    for (const group of groups) {
      const material = list[group.materialIndex ?? 0];
      if (!material?.visible) continue;
      let slot = materials.indexOf(material);
      if (slot < 0) slot = materials.push(material) - 1;
      const end = Math.min(group.start + group.count, count);
      for (let i = group.start; i + 2 < end; i += 3) {
        index[written] = base + at(i);
        index[written + 1] = base + at(flip ? i + 2 : i + 1);
        index[written + 2] = base + at(flip ? i + 1 : i + 2);
        slots[written / 3] = slot;
        written += 3;
      }
    }
    base += position.count;
  }
  if (written === 0) throw new Error(`${who}: no visible triangles`);
  return { positions, normals, uvs, hasUvs, colors, index: index.slice(0, written), materials, slots: slots.slice(0, written / 3) };
}

/** Total area of `surface`'s triangles. */
export function area({ positions, index }: Surface): number {
  let sum = 0;
  for (let i = 0; i < index.length; i += 3) sum += triangleArea(positions, 3, index, i);
  return sum;
}

/** Area of triangle `i` (its first index) of points with `size` components (2 or 3). */
export function triangleArea(points: Float32Array, size: 2 | 3, index: Uint32Array, i: number): number {
  const a = (index[i] ?? 0) * size;
  const b = (index[i + 1] ?? 0) * size;
  const c = (index[i + 2] ?? 0) * size;
  const at = (k: number) => points[k] ?? 0;
  const [ux, uy, uz] = [at(b) - at(a), at(b + 1) - at(a + 1), size === 3 ? at(b + 2) - at(a + 2) : 0];
  const [vx, vy, vz] = [at(c) - at(a), at(c + 1) - at(a + 1), size === 3 ? at(c + 2) - at(a + 2) : 0];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
