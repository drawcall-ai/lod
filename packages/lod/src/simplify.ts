import { BufferAttribute, BufferGeometry, type InterleavedBufferAttribute, type Object3D } from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";
import { detailed } from "./bounds.js";
import { recordDeviation } from "./levels.js";
import { measureDeviation } from "./source/deviation.js";
import { readSource } from "./source/source.js";
import { merge } from "./source/surface.js";
import { isImpostorMesh, isInstancedLod, isMesh, isSkinnedMesh } from "./three.js";

export interface SimplifyOptions {
  /** share of each mesh's triangles to keep, in (0, 1]; default 0.5 */
  ratio?: number;
}

/**
 * A copy of `object` with the geometry of every mesh drawn at full detail decimated by
 * meshoptimizer to about `ratio` of its triangles: of a nested LOD only level 0 (its other
 * levels are kept), of an InstancedMesh the geometry its instances share. Materials (and
 * so textures) are the originals, shared with `object`. Meshes that share a geometry
 * share the simplified one. Morph targets are dropped. ImpostorMeshes and hidden meshes
 * are kept as they are. Skinned meshes and InstancedLods are refused: simplify an
 * InstancedLod's source and build a new InstancedLod of it.
 *
 * Per material group it keeps UV and normal seams; if that cannot reach the target it
 * lets seams collapse, and as a last resort ignores topology (meshopt's sloppy mode).
 *
 * How far the copy's surface is from `object`'s (the 99.9th percentile of the distance
 * between the two, by area, over the parts seen from outside; ImpostorMeshes left out)
 * sets its default maxPixels in a Lod.
 */
export async function simplify(object: Object3D, options: SimplifyOptions = {}): Promise<Object3D> {
  const copy = await decimate(object, options.ratio ?? 0.5);
  recordDeviation(copy, measureDeviation(readSource(object, "simplify", "measure"), merge(copy, "simplify")).deviation);
  return copy;
}

/** A copy of `object` decimated to `ratio`, as `simplify` makes it, without measuring it. */
export async function decimate(object: Object3D, ratio: number): Promise<Object3D> {
  if (!(ratio > 0 && ratio <= 1)) throw new Error(`simplify: ratio must be in (0, 1], got ${ratio}`);
  await MeshoptSimplifier.ready;
  // clone() also visits hidden children, whose crowd allocations must never be
  // created just to reject them (or skipped by the visible-detail walk below).
  object.traverse((node) => {
    if (isInstancedLod(node)) throw new Error(`simplify: cannot simplify an InstancedLod ("${node.name}"); simplify its source and build a new one`);
    if (isSkinnedMesh(node)) throw new Error(`simplify: skinned meshes are not supported ("${node.name}")`);
  });
  const copy = object.clone(true);
  decimateTree(copy, ratio, new Map());
  return copy;
}

/** Decimate the meshes of `node` drawn at full detail; `done` maps each geometry to its simplified one. */
function decimateTree(node: Object3D, ratio: number, done: Map<BufferGeometry, BufferGeometry>): void {
  if (isMesh(node) && !isImpostorMesh(node)) {
    let geometry = done.get(node.geometry);
    if (!geometry) done.set(node.geometry, (geometry = simplifyGeometry(node.geometry, ratio)));
    node.geometry = geometry;
  }
  for (const child of detailed(node)) decimateTree(child, ratio, done);
}

function simplifyGeometry(source: BufferGeometry, ratio: number): BufferGeometry {
  const geometry = source.index ? source : mergeVertices(source);
  const index = geometry.index;
  if (!index) throw new Error("simplify: geometry could not be indexed");
  const positions = toFloat32(geometry.getAttribute("position"));
  const { attributes, stride, weights } = simplifierAttributes(geometry);
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];

  const parts: Array<{ indices: Uint32Array; materialIndex: number }> = [];
  for (const group of groups) {
    const indices = new Uint32Array(Math.min(group.count, index.count - group.start));
    for (let i = 0; i < indices.length; i++) indices[i] = index.getX(group.start + i);
    const [simplified] = simplifyIndices(indices, positions, attributes, stride, weights, Math.floor((indices.length / 3) * ratio) * 3);
    parts.push({ indices: simplified, materialIndex: group.materialIndex ?? 0 });
  }

  const all = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
  const out = new BufferGeometry();
  let offset = 0;
  for (const part of parts) {
    all.set(part.indices, offset);
    if (source.groups.length > 0) out.addGroup(offset, part.indices.length, part.materialIndex);
    offset += part.indices.length;
  }
  const [remap, unique] = MeshoptSimplifier.compactMesh(all); // rewrites `all` in place
  for (const [name, attribute] of Object.entries(geometry.attributes)) out.setAttribute(name, compactAttribute(attribute, remap, unique));
  out.setIndex(new BufferAttribute(all, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function simplifyIndices(
  indices: Uint32Array,
  positions: Float32Array,
  attributes: Float32Array,
  stride: number,
  weights: number[],
  target: number,
): [Uint32Array, number] {
  const reached = (r: Uint32Array) => r.length <= target * 1.25 + 3;
  const strict = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, stride, weights, null, target, 1);
  if (reached(strict[0])) return strict;
  const permissive = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, stride, weights, null, target, 1, ["Permissive"]);
  if (reached(permissive[0])) return permissive;
  const sloppy = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 1);
  // Sloppy can collapse a tiny target to nothing; then keep the permissive result.
  return sloppy[0].length > 0 ? sloppy : permissive;
}

/** Normal (weight 0.5) and UV (weight 1) packed per vertex for simplifyWithAttributes. */
function simplifierAttributes(geometry: BufferGeometry) {
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const count = geometry.getAttribute("position").count;
  const weights = [...(normal ? [0.5, 0.5, 0.5] : []), ...(uv ? [1, 1] : [])];
  const stride = Math.max(weights.length, 1);
  const attributes = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    let o = i * stride;
    if (normal) for (let c = 0; c < 3; c++) attributes[o++] = normal.getComponent(i, c);
    if (uv) for (let c = 0; c < 2; c++) attributes[o++] = uv.getComponent(i, c);
  }
  if (weights.length === 0) weights.push(0);
  return { attributes, stride, weights };
}

function compactAttribute(attribute: BufferAttribute | InterleavedBufferAttribute, remap: Uint32Array, unique: number): BufferAttribute {
  const size = attribute.itemSize;
  // A slice keeps the array type, so normalized and integer attributes keep their encoding;
  // every element is written below (unique <= count, so it is long enough).
  const out = new BufferAttribute(attribute.array.slice(0, unique * size), size, attribute.normalized);
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i];
    if (j === undefined || j === 0xffffffff) continue;
    for (let c = 0; c < size; c++) out.setComponent(j, c, attribute.getComponent(i, c));
  }
  return out;
}

function toFloat32(attribute: BufferAttribute | InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.getY(i);
    out[i * 3 + 2] = attribute.getZ(i);
  }
  return out;
}
