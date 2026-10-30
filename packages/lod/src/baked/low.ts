import { BufferAttribute, BufferGeometry, Mesh, type Object3D } from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { decimate } from "../simplify.js";
import { measureDeviation } from "../source/deviation.js";
import type { Source } from "../source/source.js";
import { merge, type Surface } from "../source/surface.js";
import { rasterize, type Raster } from "./raster.js";
import { unwrap } from "./unwrap.js";

/** The surface a bake writes onto, laid out in its UVs. */
export interface Low extends Surface {
  uvs: Float32Array;
  raster: Raster;
  /** How far the low surface is from the source's, in the source's units: see `measureDeviation`. */
  deviation: number;
  widest: number;
}

/** The source simplified to `ratio` of its triangles, welded first: seams and materials do not matter to a bake. */
export function simplified(source: Source, ratio: number): Promise<Object3D> {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(source.positions, 3));
  geometry.setIndex(new BufferAttribute(source.index, 1));
  return decimate(new Mesh(mergeVertices(geometry)), ratio);
}

/**
 * `object`'s triangles (in its own space, which must be the source's) with UVs to bake
 * into: its own when they are usable — inside 0..1, no two triangles on one texel and a
 * texel of free border between charts — else a fresh xatlas atlas.
 */
export async function layOut(object: Object3D, source: Source, size: number): Promise<Low> {
  const surface = merge(object, "bakeMesh");
  const { deviation, widest } = measureDeviation(source, surface);
  const { uvs, index } = surface;
  if (surface.hasUvs && uvs.every((x) => x >= 0 && x <= 1)) {
    const raster = rasterize(uvs, index, size);
    if (raster.overlaps === 0 && raster.covered > 0 && separated(raster, charts(uvs, index))) return { ...surface, raster, deviation, widest };
  }
  const atlas = await unwrap(surface, size);
  return { ...atlas, raster: rasterize(atlas.uvs, atlas.index, size), deviation, widest };
}

/** Per triangle, its chart: triangles that share a UV point are in one. */
function charts(uvs: Float32Array, index: Uint32Array): Int32Array {
  const parent = Int32Array.from({ length: index.length / 3 }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] ?? i] ?? i;
    return i;
  };
  const owner = new Map<string, number>();
  for (let i = 0; i < index.length; i++) {
    const v = index[i] ?? 0;
    const key = `${uvs[v * 2]},${uvs[v * 2 + 1]}`;
    const triangle = Math.floor(i / 3);
    const other = owner.get(key);
    if (other === undefined) owner.set(key, triangle);
    else parent[root(triangle)] = root(other);
  }
  return parent.map((_, i) => root(i));
}

/** Whether no texel of one chart touches a texel of another (8 neighbours). */
function separated({ size, triangles }: Raster, chart: Int32Array): boolean {
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const t = triangles[y * size + x] ?? -1;
      if (t < 0) continue;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx <= 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= size || ny >= size) continue;
          const u = triangles[ny * size + nx] ?? -1;
          if (u >= 0 && chart[u] !== chart[t]) return false;
        }
    }
  return true;
}
