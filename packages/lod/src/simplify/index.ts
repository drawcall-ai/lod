import { BufferAttribute, BufferGeometry, type InterleavedBufferAttribute, type Object3D } from "three/webgpu";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";
import { detailed } from "../source/detail.js";
import { isImpostorMesh, isLod, isMesh, isSkinnedMesh } from "../three.js";
import { cardMaterials, decimateCards } from "./cards.js";

// The simplified level: a copy of a source with its geometry decimated, drawn with the source's materials.

export interface SimplifyOptions {
  /** share of each mesh's triangles that remains, in (0, 1]; default 0.5 */
  ratio?: number;
  /** Largest screen height of this level, in CSS pixels. A foliage card can shed interior triangles at this scale. */
  maxPixels?: number;
}

/**
 * A copy of `object` with the geometry of every mesh drawn at full detail decimated by
 * meshoptimizer to about `ratio` of its triangles: of a nested LOD only level 0 (its other
 * levels stay as they are), of an InstancedMesh the geometry its instances share. Materials (and
 * so textures) are the originals, shared with `object`. Meshes that share a geometry
 * share the simplified one. Morph targets are dropped. ImpostorMeshes and hidden meshes
 * stay as they are. Skinned meshes and Lods are refused: simplify a Lod's source and
 * build a new Lod of it.
 *
 * Per material group it preserves UV and normal seams; if that cannot reach the target it
 * lets seams collapse, and as a last resort ignores topology (meshopt's sloppy mode).
 * A group drawn with an alpha-tested texture (foliage cards) is decimated card by card
 * instead: about `ratio` of its cards remain, whole, spread evenly and enlarged to cover
 * what all covered (see `decimateCards`). At a finite `maxPixels`, their interior tessellation can simplify with the border locked.
 */
export async function simplify(object: Object3D, { ratio = 0.5, maxPixels = Infinity }: SimplifyOptions = {}): Promise<Object3D> {
  if (!(ratio > 0 && ratio <= 1)) throw new Error(`simplify: ratio must be in (0, 1], got ${ratio}`);
  if (!(maxPixels > 0)) throw new Error(`simplify: maxPixels must be > 0, got ${maxPixels}`);
  await MeshoptSimplifier.ready;
  // clone() also visits hidden children, whose Lod copies must never be made just to
  // reject them (or skipped by the visible-detail walk below).
  object.traverse((node) => {
    if (isLod(node)) throw new Error(`simplify: cannot simplify a Lod ("${node.name}"); simplify its source and build a new one`);
    if (isSkinnedMesh(node)) throw new Error(`simplify: skinned meshes are not supported ("${node.name}")`);
  });
  const copy = object.clone(true);
  decimateTree(copy, ratio, Math.min(1, 1 / maxPixels), new Map());
  return copy;
}

/**
 * Decimate the meshes of `node` drawn at full detail; `done` maps each geometry, with
 * which of its material indices are cards, to its simplified one.
 */
function decimateTree(node: Object3D, ratio: number, error: number, done: Map<string, BufferGeometry>): void {
  if (isMesh(node) && !isImpostorMesh(node)) {
    const cards = cardMaterials(node);
    const key = `${node.geometry.uuid} ${cards.join()}`;
    let geometry = done.get(key);
    if (!geometry) done.set(key, (geometry = simplifyGeometry(node.geometry, ratio, cards, error)));
    node.geometry = geometry;
  }
  for (const child of detailed(node)) decimateTree(child, ratio, error, done);
}

function simplifyGeometry(source: BufferGeometry, ratio: number, cards: boolean[], error: number): BufferGeometry {
  const geometry = source.index ? source : mergeVertices(source);
  const index = geometry.index;
  if (!index) throw new Error("simplify: geometry could not be indexed");
  const positions = toFloat32(geometry.getAttribute("position"));
  const { attributes, stride, weights } = simplifierAttributes(geometry);
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];

  // Only these attributes participate in the error metric. Additional channels can carry arbitrary effects.
  const reduceCards = ratio < 1 && error > 0 && Object.keys(geometry.attributes).every((name) => ["position", "normal", "uv"].includes(name));
  const parts: Array<{ indices: Uint32Array; materialIndex: number }> = [];
  let decimatedCards = false;
  for (const group of groups) {
    const indices = new Uint32Array(Math.min(group.count, index.count - group.start));
    for (let i = 0; i < indices.length; i++) indices[i] = index.getX(group.start + i);
    const materialIndex = group.materialIndex ?? 0;
    // A single material draws every group.
    const card = (cards.length === 1 ? cards[0] : cards[materialIndex]) ?? false;
    if (card) decimatedCards = true;
    let simplified = card
      ? decimateCards(indices, positions, ratio)
      : simplifyIndices(indices, positions, attributes, stride, weights, Math.floor((indices.length / 3) * ratio) * 3)[0];
    // Keep the selected cards and their outlines. Meshopt bounds the interior position, normal and UV error.
    if (card && reduceCards) {
      const [interior] = MeshoptSimplifier.simplifyWithAttributes(simplified, positions, 3, attributes, stride, weights, null, 0, error, ["LockBorder"]);
      if (interior.length) simplified = interior;
    }
    parts.push({ indices: simplified, materialIndex });
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
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    // decimateCards moved the remaining cards' vertices, past the range a quantized position may hold.
    const from = name === "position" && decimatedCards ? new BufferAttribute(positions, 3) : attribute;
    out.setAttribute(name, compactAttribute(from, remap, unique));
  }
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
  // Sloppy can collapse a tiny target to nothing; then use the permissive result.
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
  // A slice has the array's type, so normalized and integer attributes hold their encoding;
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
