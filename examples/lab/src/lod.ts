import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";
import { MeshBVH } from "three-mesh-bvh";
import { wrap, proxy, type Remote } from "comlink";
import xatlasWorkerUrl from "xatlasjs/dist/xatlas.js?url";
import xatlasWasmUrl from "xatlasjs/dist/xatlas.wasm?url";

// Mesh LODs, as the baseline that octahedral impostors are compared against.
//
// simplifyLod: the everyday three.js practice (gltfpack -si): decimate every mesh with
//   meshoptimizer and keep the original materials and textures.
// bakedLod: the fair, HLOD-proxy-like variant: one decimated mesh with a fresh UV atlas,
//   onto which base colour (+ cut-out coverage), object-space normals and ORM are baked
//   from the full-detail original.
//
// Await `lodReady` before calling simplifyLod (the meshoptimizer wasm must be loaded).

export const lodReady: Promise<void> = MeshoptSimplifier.ready;
let simplifierLoaded = false;
void MeshoptSimplifier.ready.then(() => (simplifierLoaded = true));

// ---------------------------------------------------------------------------------------
// simplifyLod

/**
 * Copy of `object` with every mesh's geometry decimated to ~`ratio` of its triangles.
 * Materials (and therefore textures) are the originals, shared with `object`.
 *
 * Per material group: attribute-aware simplification that keeps UV/normal seams; if that
 * cannot reach the target, retry allowing seams to collapse ("Permissive"), and as a last
 * resort `simplifySloppy` (ignores topology and attributes). Morph targets are dropped.
 */
export function simplifyLod(object: THREE.Object3D, ratio: number): THREE.Object3D {
  if (!simplifierLoaded) throw new Error("simplifyLod: await lodReady first");
  const copy = object.clone(true);
  const done = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  copy.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let geometry = done.get(mesh.geometry);
    if (!geometry) {
      geometry = simplifyGeometry(mesh.geometry, ratio);
      done.set(mesh.geometry, geometry);
    }
    mesh.geometry = geometry;
  });
  return copy;
}

/**
 * Error-driven mode: when > 0, simplification goes as far as it can while the geometric
 * error stays under this fraction of the mesh extent (the triangle target is ignored).
 * About 1 / (on-screen size in px) keeps the error near one pixel: how a real LOD chain
 * picks its level for a given distance.
 */
export const LOD_ERROR = { value: 0 };

/** Which method reached the target, for reporting. */
export const simplifyStats = { strict: 0, permissive: 0, sloppy: 0 };

function simplifyGeometry(source: THREE.BufferGeometry, ratio: number): THREE.BufferGeometry {
  const geometry = source.index ? source : mergeVertices(source);
  const index = geometry.index!;
  const positions = toFloat32(geometry.getAttribute("position"));
  const { attributes, stride, weights } = simplifierAttributes(geometry);
  const groups = geometry.groups.length > 0 ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];

  const parts: Array<{ indices: Uint32Array; materialIndex: number }> = [];
  for (const group of groups) {
    const indices = new Uint32Array(Math.min(group.count, index.count - group.start));
    for (let i = 0; i < indices.length; i++) indices[i] = index.getX(group.start + i);
    const target = Math.floor((indices.length / 3) * ratio) * 3;
    parts.push({ indices: simplifyIndices(indices, positions, attributes, stride, weights, target), materialIndex: group.materialIndex ?? 0 });
  }

  const total = parts.reduce((n, p) => n + p.indices.length, 0);
  const all = new Uint32Array(total);
  const out = new THREE.BufferGeometry();
  let offset = 0;
  for (const part of parts) {
    all.set(part.indices, offset);
    if (source.groups.length > 0) out.addGroup(offset, part.indices.length, part.materialIndex);
    offset += part.indices.length;
  }
  const [remap, unique] = MeshoptSimplifier.compactMesh(all); // rewrites `all` in place
  for (const [name, attribute] of Object.entries(geometry.attributes)) out.setAttribute(name, compactAttribute(attribute, remap, unique));
  out.setIndex(new THREE.BufferAttribute(all, 1));
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
): Uint32Array {
  if (LOD_ERROR.value > 0) {
    const [bounded] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, stride, weights, null, 3, LOD_ERROR.value);
    return bounded.length > 0 ? (simplifyStats.strict++, bounded) : indices;
  }
  const reached = (r: Uint32Array) => r.length <= target * 1.25 + 3;
  const [strict] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, stride, weights, null, target, 1);
  if (reached(strict)) return simplifyStats.strict++, strict;
  const [permissive] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, stride, weights, null, target, 1, ["Permissive"]);
  if (reached(permissive)) return simplifyStats.permissive++, permissive;
  const [sloppy] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 1);
  // Sloppy can collapse a tiny target to nothing; then keep the permissive result.
  if (sloppy.length === 0) return simplifyStats.permissive++, permissive;
  simplifyStats.sloppy++;
  return sloppy;
}

/** Normal (weight 0.5) and UV (weight 1) packed per vertex for simplifyWithAttributes. */
function simplifierAttributes(geometry: THREE.BufferGeometry) {
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

function compactAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, remap: Uint32Array, unique: number) {
  const size = attribute.itemSize;
  const Array = attribute.array.constructor as new (n: number) => THREE.TypedArray;
  const out = new THREE.BufferAttribute(new Array(unique * size), size, attribute.normalized);
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i]!;
    if (j === 0xffffffff) continue;
    for (let c = 0; c < size; c++) out.setComponent(j, c, attribute.getComponent(i, c));
  }
  return out;
}

function toFloat32(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attribute.count * 3);
  for (let i = 0; i < attribute.count; i++) {
    out[i * 3] = attribute.getX(i);
    out[i * 3 + 1] = attribute.getY(i);
    out[i * 3 + 2] = attribute.getZ(i);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// bakedLod

/**
 * One decimated mesh per object with a fresh xatlas UV atlas and textures baked from
 * the full-detail original: base colour (alpha = cut-out coverage), object-space normals
 * and ORM (R = material aoMap or 1, G = roughness, B = metalness).
 *
 * The returned Group carries `object`'s local transform; its single child mesh is in
 * `object`'s local space. `userData.lod` holds triangle count, timings and texture bytes.
 *
 * How it bakes: the low mesh is rasterised in atlas space on the GPU (vertex shader
 * outputs uv*2-1) into float targets holding each texel's low-poly position and smoothed
 * normal (+ face normal). For each covered texel the segment P ± maxDist·N is cast against
 * a BVH of the original (three-mesh-bvh); of all hits, the one nearest to P that is front
 * facing (or on a double-sided material) and opaque (alpha >= alphaTest) wins; if there is
 * none, the closest original surface point is used. The original material is then
 * evaluated at the hit on the CPU. Finally colours are dilated into the gutters.
 *
 * Limits (deliberately simple):
 * - Materials are read as MeshStandardMaterial-like: color, map, opacity, alphaTest,
 *   vertexColors, roughness(Map.g), metalness(Map.b), normalMap (+normalScale), aoMap.r.
 *   Other material types bake as rough dielectrics. Emissive, clearcoat, transmission,
 *   sheen etc. are not baked; blended transparency is treated as a cut-out at 0.5.
 * - All textures are sampled with the `uv` attribute (texture.channel is ignored), one
 *   trilinear sample per texel from a CPU box-filtered mip chain at the level whose texel
 *   matches the baked texel's footprint (so the bake looks like the original does on the
 *   GPU at the bake's resolution, mip colour bleed of undilated cut-out maps included).
 *   No supersampling; geometric detail below a texel can still alias.
 * - Normal maps use a per-triangle tangent frame from positions/UVs (like three's
 *   derivative-based frame when a mesh has no tangents); `tangent` attributes are ignored.
 * - Skinned/morphed/instanced meshes are baked in their bind pose / as one instance.
 * - xatlas (this build) takes 16-bit indices, so the low mesh is fed in chunks.
 * - The per-texel work runs on the main thread in JS: ~1 s per 1024² bake for solids, up to
 *   ~15 s for foliage, where long search segments cross many cards. A production baker
 *   would do this on the GPU or in workers.
 * - Search distance comes from meshopt's reported error; features that moved further
 *   than that fall back to the closest-point lookup and can smear.
 */
export async function bakedLod(object: THREE.Object3D, ratio: number, size = 1024): Promise<THREE.Object3D> {
  await lodReady;
  const t0 = performance.now();
  const high = gatherSource(object);
  const low = simplifyMerged(high, ratio);
  const t1 = performance.now();
  const atlased = await unwrap(low.positions, low.normals, low.index, size);
  const t2 = performance.now();
  const texels = rasterizeAtlas(atlased, size);
  const t3 = performance.now();
  const maxDist = THREE.MathUtils.clamp(low.error * 2, high.radius * 0.005, high.radius * 0.15);
  const baked = bakeTexels(high, texels, size, maxDist, surfaceArea(atlased));
  const t4 = performance.now();

  const textures = makeTextures(baked, size);
  const material = new THREE.MeshStandardMaterial({
    map: textures.color,
    normalMap: textures.normal,
    normalMapType: THREE.ObjectSpaceNormalMap,
    aoMap: textures.orm,
    roughnessMap: textures.orm,
    metalnessMap: textures.orm,
    roughness: 1,
    metalness: 1,
    alphaTest: high.cutout ? high.alphaTest : 0,
    side: high.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(atlased, material);
  mesh.name = `${object.name || "object"}-baked-lod`;
  const group = new THREE.Group();
  group.position.copy(object.position);
  group.quaternion.copy(object.quaternion);
  group.scale.copy(object.scale);
  group.add(mesh);
  group.userData.lod = {
    triangles: atlased.index!.count / 3,
    simplifyMs: t1 - t0,
    unwrapMs: t2 - t1,
    rasterMs: t3 - t2,
    bakeMs: t4 - t3,
    totalMs: performance.now() - t0,
    textureBytes: 3 * size * size * 4 * (4 / 3), // three RGBA8 textures with mips
    maxDist,
    simplifyError: low.error,
    covered: baked.covered,
    fallbacks: baked.fallbacks,
  };
  return group;
}

// --- source gathering ----------------------------------------------------------------

interface Level {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

interface Tex {
  /** Box-filtered mip chain of the raw (non-premultiplied) texels, like generateMipmap. */
  levels: Level[];
  w: number;
  h: number;
  /** |det| of the texture matrix: how much it scales UV area. */
  uvScale: number;
  flipY: boolean;
  matrix: THREE.Matrix3;
  wrapS: THREE.Wrapping;
  wrapT: THREE.Wrapping;
}

interface Mat {
  color: THREE.Color; // linear
  map: Tex | null;
  opacity: number;
  cutout: boolean;
  alphaTest: number;
  vertexColors: boolean;
  roughness: number;
  roughnessMap: Tex | null;
  metalness: number;
  metalnessMap: Tex | null;
  normalMap: Tex | null;
  normalScale: THREE.Vector2;
  aoMap: Tex | null;
  aoMapIntensity: number;
  doubleSided: boolean;
}

/** The original, merged into `object`'s local space, with per-triangle material slots. */
interface Source {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array; // rgb, 1 where absent
  index: Uint32Array;
  triMat: Uint16Array;
  mats: Mat[];
  bvh: MeshBVH;
  radius: number;
  cutout: boolean;
  alphaTest: number;
  doubleSided: boolean;
}

function gatherSource(object: THREE.Object3D): Source {
  object.updateWorldMatrix(true, true);
  const rootInverse = object.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  object.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  if (meshes.length === 0) throw new Error("bakedLod: no meshes");

  const mats: Mat[] = [];
  const matSlot = new Map<THREE.Material, number>();
  const texCache = new Map<THREE.Texture, Tex>();
  const slot = (m: THREE.Material) => {
    let s = matSlot.get(m);
    if (s === undefined) matSlot.set(m, (s = mats.push(readMaterial(m, texCache)) - 1));
    return s;
  };

  let vertexCount = 0;
  let indexCount = 0;
  for (const mesh of meshes) {
    vertexCount += mesh.geometry.getAttribute("position").count;
    indexCount += mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.getAttribute("position").count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 3).fill(1);
  const index = new Uint32Array(indexCount);
  const triMat = new Uint16Array(indexCount / 3);

  let vBase = 0;
  let iBase = 0;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    let geometry = mesh.geometry;
    if (!geometry.getAttribute("normal")) (geometry = geometry.clone()).computeVertexNormals();
    m.multiplyMatrices(rootInverse, mesh.matrixWorld);
    nm.getNormalMatrix(m);
    const flip = m.determinant() < 0;
    const p = geometry.getAttribute("position");
    const n = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const color = geometry.getAttribute("color");
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m).toArray(positions, (vBase + i) * 3);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize().toArray(normals, (vBase + i) * 3);
      if (uv) (uvs[(vBase + i) * 2] = uv.getX(i)), (uvs[(vBase + i) * 2 + 1] = uv.getY(i));
      if (color) for (let c = 0; c < 3; c++) colors[(vBase + i) * 3 + c] = color.getComponent(i, c);
    }
    const count = geometry.index ? geometry.index.count : p.count;
    const at = (i: number) => (geometry.index ? geometry.index.getX(i) : i);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.length > 0 && Array.isArray(mesh.material) ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    // Triangles not covered by any group are dropped (three does not draw them either).
    let written = 0;
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material) continue;
      const s = slot(material);
      const end = Math.min(group.start + group.count, count);
      for (let i = group.start; i + 2 < end; i += 3) {
        const o = iBase + written;
        index[o] = vBase + at(i);
        index[o + 1] = vBase + at(flip ? i + 2 : i + 1);
        index[o + 2] = vBase + at(flip ? i + 1 : i + 2);
        triMat[o / 3] = s;
        written += 3;
      }
    }
    vBase += p.count;
    iBase += written;
  }

  const finalIndex = index.slice(0, iBase);
  const bvhGeometry = new THREE.BufferGeometry();
  bvhGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  bvhGeometry.setIndex(new THREE.BufferAttribute(finalIndex, 1));
  // indirect: keep our index order so hit.faceIndex addresses triMat.
  const bvh = new MeshBVH(bvhGeometry, { indirect: true });
  bvhGeometry.computeBoundingSphere();

  const cutouts = mats.filter((x) => x.cutout);
  return {
    positions,
    normals,
    uvs,
    colors,
    index: finalIndex,
    triMat: triMat.slice(0, iBase / 3),
    mats,
    bvh,
    radius: bvhGeometry.boundingSphere!.radius,
    cutout: cutouts.length > 0,
    alphaTest: cutouts.length > 0 ? Math.max(...cutouts.map((x) => x.alphaTest)) : 0,
    doubleSided: mats.some((x) => x.doubleSided),
  };
}

function readMaterial(material: THREE.Material, cache: Map<THREE.Texture, Tex>): Mat {
  const s = material as THREE.MeshStandardMaterial;
  const tex = (t: THREE.Texture | null | undefined) => (t ? readTexture(t, cache) : null);
  const map = tex(s.map);
  const cutout = material.alphaTest > 0 || (material.transparent && (s.map != null || material.opacity < 1));
  return {
    color: s.color ? s.color.clone() : new THREE.Color(1, 1, 1),
    map,
    opacity: material.opacity,
    cutout,
    alphaTest: material.alphaTest > 0 ? material.alphaTest : cutout ? 0.5 : 0,
    vertexColors: material.vertexColors,
    roughness: "roughness" in s ? s.roughness : 1,
    roughnessMap: "roughness" in s ? tex(s.roughnessMap) : null,
    metalness: "metalness" in s ? s.metalness : 0,
    metalnessMap: "metalness" in s ? tex(s.metalnessMap) : null,
    normalMap: s.normalMap && s.normalMapType !== THREE.ObjectSpaceNormalMap ? tex(s.normalMap) : null,
    normalScale: s.normalScale ? s.normalScale.clone() : new THREE.Vector2(1, 1),
    aoMap: tex(s.aoMap),
    aoMapIntensity: s.aoMapIntensity ?? 1,
    doubleSided: material.side === THREE.DoubleSide,
  };
}

function readTexture(texture: THREE.Texture, cache: Map<THREE.Texture, Tex>): Tex {
  const cached = cache.get(texture);
  if (cached) return cached;
  const image = texture.image as (CanvasImageSource & { width: number; height: number }) | { data: ArrayLike<number>; width: number; height: number };
  let data: Uint8ClampedArray;
  const w = image.width;
  const h = image.height;
  if ("data" in image) {
    if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)) throw new Error("bakedLod: only 8-bit data textures");
    data = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, w * h * 4);
  } else {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(image, 0, 0);
    data = ctx.getImageData(0, 0, w, h, { colorSpace: "srgb" }).data;
  }
  if (texture.matrixAutoUpdate) texture.updateMatrix();
  // DataTextures (and ImageBitmaps, which ignore flipY) store row 0 at v=0.
  const flipY = texture.flipY && !("data" in image) && !(typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap);
  const e = texture.matrix.elements;
  const result: Tex = {
    levels: mipChain({ data, w, h }),
    w,
    h,
    uvScale: Math.abs(e[0]! * e[4]! - e[1]! * e[3]!),
    flipY,
    matrix: texture.matrix.clone(),
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
  };
  cache.set(texture, result);
  return result;
}

function mipChain(base: Level): Level[] {
  const levels = [base];
  let l = base;
  while (l.w > 1 || l.h > 1) {
    const w = Math.max(1, l.w >> 1);
    const h = Math.max(1, l.h >> 1);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(x * 2, l.w - 1);
        const x1 = Math.min(x * 2 + 1, l.w - 1);
        const y0 = Math.min(y * 2, l.h - 1);
        const y1 = Math.min(y * 2 + 1, l.h - 1);
        for (let k = 0; k < 4; k++)
          data[(y * w + x) * 4 + k] =
            (l.data[(y0 * l.w + x0) * 4 + k]! + l.data[(y0 * l.w + x1) * 4 + k]! + l.data[(y1 * l.w + x0) * 4 + k]! + l.data[(y1 * l.w + x1) * 4 + k]! + 2) >> 2;
      }
    levels.push((l = { data, w, h }));
  }
  return levels;
}

const _uv = new THREE.Vector3();
const _a = new Float32Array(4);
const _b = new Float32Array(4);

/**
 * Trilinear sample (channels 0..1) into `out`. `lod` is the mip level, chosen by the caller
 * so that one source texel matches one baked texel's footprint, which is what the GPU
 * would show of the original at the bake's resolution (including mip colour bleed).
 */
function sample(t: Tex, u: number, v: number, lod: number, out: Float32Array) {
  _uv.set(u, v, 1).applyMatrix3(t.matrix);
  const su = wrap1(_uv.x, t.wrapS);
  // Image row 0 is v=1 when the texture was uploaded flipped, v=0 otherwise.
  const sv = t.flipY ? 1 - wrap1(_uv.y, t.wrapT) : wrap1(_uv.y, t.wrapT);
  const top = t.levels.length - 1;
  const l = Math.min(Math.max(lod, 0), top);
  const l0 = Math.floor(l);
  const f = l - l0;
  bilinear(t, t.levels[l0]!, su, sv, f > 0 ? _a : out);
  if (f === 0) return;
  bilinear(t, t.levels[Math.min(l0 + 1, top)]!, su, sv, _b);
  for (let k = 0; k < 4; k++) out[k] = _a[k]! + (_b[k]! - _a[k]!) * f;
}

function bilinear(t: Tex, level: Level, su: number, sv: number, out: Float32Array) {
  const { w, h, data: D } = level;
  const x = su * w - 0.5;
  const y = sv * h - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const repeatX = t.wrapS !== THREE.ClampToEdgeWrapping;
  const repeatY = t.wrapT !== THREE.ClampToEdgeWrapping;
  const cx = (i: number) => (repeatX ? ((i % w) + w) % w : Math.min(Math.max(i, 0), w - 1));
  const cy = (i: number) => (repeatY ? ((i % h) + h) % h : Math.min(Math.max(i, 0), h - 1));
  const a = (cy(y0) * w + cx(x0)) * 4;
  const b = (cy(y0) * w + cx(x0 + 1)) * 4;
  const c = (cy(y0 + 1) * w + cx(x0)) * 4;
  const d = (cy(y0 + 1) * w + cx(x0 + 1)) * 4;
  for (let k = 0; k < 4; k++) {
    const top = D[a + k]! + (D[b + k]! - D[a + k]!) * fx;
    const bottom = D[c + k]! + (D[d + k]! - D[c + k]!) * fx;
    out[k] = (top + (bottom - top) * fy) / 255;
  }
}

function wrap1(x: number, mode: THREE.Wrapping) {
  if (mode === THREE.ClampToEdgeWrapping) return Math.min(Math.max(x, 0), 1);
  if (mode === THREE.MirroredRepeatWrapping) {
    const f = ((x % 2) + 2) % 2;
    return f > 1 ? 2 - f : f;
  }
  return x - Math.floor(x);
}

// --- decimation ------------------------------------------------------------------------

/** Welds by position (dropping seams), decimates, smooths normals. */
function simplifyMerged(high: Source, ratio: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(high.positions, 3));
  g.setIndex(new THREE.BufferAttribute(high.index, 1));
  const welded = mergeVertices(g, 1e-5);
  const positions = (welded.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const source = new Uint32Array(welded.index!.array);
  let target = LOD_ERROR.value > 0 ? 3 : Math.max(3, Math.floor((source.length / 3) * ratio) * 3);
  let [indices, error] = MeshoptSimplifier.simplify(source, positions, 3, target, LOD_ERROR.value > 0 ? LOD_ERROR.value : 1);
  // Disconnected parts can collapse away entirely; a proxy needs some surface to bake on.
  while (indices.length === 0 && target < source.length) {
    target = Math.min(source.length, target * 2);
    [indices, error] = MeshoptSimplifier.simplify(source, positions, 3, target, 1);
  }
  if (LOD_ERROR.value === 0 && indices.length > target * 1.25 + 3) {
    // Sloppy can collapse a tiny target to nothing; then keep the regular result.
    const [sloppy, sloppyError] = MeshoptSimplifier.simplifySloppy(source, positions, 3, null, target, 1);
    if (sloppy.length > 0) [indices, error] = [sloppy, sloppyError];
  }
  const [remap, unique] = MeshoptSimplifier.compactMesh(indices);
  const compact = new Float32Array(unique * 3);
  for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) compact.set(positions.subarray(i * 3, i * 3 + 3), remap[i]! * 3);
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(compact, 3));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeVertexNormals();
  const scale = MeshoptSimplifier.getScale(positions, 3);
  return { positions: compact, normals: (out.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array, index: indices, error: error * scale };
}

// --- UV atlas (xatlas in a worker) -----------------------------------------------------

interface XAtlasApi {
  loaded: boolean;
  createAtlas(): void;
  addMesh(indexes: Uint16Array, vertices: Float32Array, normals: Float32Array | null, coords: null, id: unknown, useNormals: boolean, useCoords: boolean, scale: number): unknown;
  generateAtlas(chart: object, pack: object, returnMeshes: boolean): {
    width: number;
    height: number;
    atlasCount: number;
    meshes: Array<{ index: Uint16Array; vertex: { vertices: Float32Array; normals?: Float32Array; coords1: Float32Array }; mesh: unknown; vertexCount: number }>;
  };
  destroyAtlas(): void;
}

let xatlas: Promise<Remote<XAtlasApi>> | null = null;
let xatlasQueue: Promise<unknown> = Promise.resolve();

function xatlasApi() {
  xatlas ??= (async () => {
    const Api = wrap<new (onLoad: () => void, locate: (path: string) => string, progress: () => void) => XAtlasApi>(new Worker(xatlasWorkerUrl));
    const wasm = new URL(xatlasWasmUrl, location.href).href;
    const api = await new Api(proxy(() => {}), proxy(() => wasm), proxy(() => {}));
    while (!(await api.loaded)) await new Promise((r) => setTimeout(r, 20));
    return api;
  })();
  return xatlas;
}

const CHUNK_TRIANGLES = 20000; // xatlas.js uses 16-bit indices in and out

async function unwrap(positions: Float32Array, normals: Float32Array, index: Uint32Array, size: number): Promise<THREE.BufferGeometry> {
  const api = await xatlasApi();
  const run = async () => {
    await api.createAtlas();
    for (let start = 0; start < index.length; start += CHUNK_TRIANGLES * 3) {
      const slice = index.subarray(start, Math.min(index.length, start + CHUNK_TRIANGLES * 3));
      const local = new Map<number, number>();
      const ids = new Uint16Array(slice.length);
      const order: number[] = [];
      for (let i = 0; i < slice.length; i++) {
        let l = local.get(slice[i]!);
        if (l === undefined) local.set(slice[i]!, (l = order.push(slice[i]!) - 1));
        ids[i] = l;
      }
      const p = new Float32Array(order.length * 3);
      const n = new Float32Array(order.length * 3);
      order.forEach((g, i) => (p.set(positions.subarray(g * 3, g * 3 + 3), i * 3), n.set(normals.subarray(g * 3, g * 3 + 3), i * 3)));
      const added = await api.addMesh(ids, p, n, null, start, false, false, 1);
      if (!added) throw new Error(`bakedLod: xatlas rejected chunk at ${start} (${slice.length / 3} triangles, ${order.length} vertices)`);
    }
    const atlas = await api.generateAtlas({}, { resolution: size, padding: 2, bilinear: true }, true);
    await api.destroyAtlas();
    return atlas;
  };
  const job = xatlasQueue.then(run);
  xatlasQueue = job.catch(() => {});
  const atlas = await job;
  if (atlas.atlasCount !== 1) throw new Error(`bakedLod: xatlas produced ${atlas.atlasCount} atlases`);

  const vertexCount = atlas.meshes.reduce((n, m) => n + m.vertexCount, 0);
  const indexCount = atlas.meshes.reduce((n, m) => n + m.index.length, 0);
  const pos = new Float32Array(vertexCount * 3);
  const nrm = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const idx = new Uint32Array(indexCount);
  let vb = 0;
  let ib = 0;
  // xatlas reports UVs in texels.
  const max = atlas.meshes.reduce((m, x) => x.vertex.coords1.reduce((a, b) => Math.max(a, b), m), 0);
  const sx = max > 1.5 ? 1 / atlas.width : 1;
  const sy = max > 1.5 ? 1 / atlas.height : 1;
  for (const mesh of atlas.meshes) {
    pos.set(mesh.vertex.vertices, vb * 3);
    nrm.set(mesh.vertex.normals!, vb * 3);
    for (let i = 0; i < mesh.vertexCount; i++) {
      uv[(vb + i) * 2] = mesh.vertex.coords1[i * 2]! * sx;
      uv[(vb + i) * 2 + 1] = mesh.vertex.coords1[i * 2 + 1]! * sy;
    }
    for (let i = 0; i < mesh.index.length; i++) idx[ib + i] = mesh.index[i]! + vb;
    vb += mesh.vertexCount;
    ib += mesh.index.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// --- atlas-space rasterisation ---------------------------------------------------------

let bakeRenderer: THREE.WebGLRenderer | null = null;

/** Per texel: low-poly position (xyz, w = covered), smoothed normal and face normal. */
function rasterizeAtlas(geometry: THREE.BufferGeometry, size: number) {
  bakeRenderer ??= new THREE.WebGLRenderer({ canvas: document.createElement("canvas"), antialias: false });
  const renderer = bakeRenderer;
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const material = new THREE.ShaderMaterial({
    uniforms: { mode: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vP;
      varying vec3 vN;
      void main() {
        vP = position;
        vN = normal;
        gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform int mode;
      varying vec3 vP;
      varying vec3 vN;
      void main() {
        // Geometric normal of the low triangle: uv maps to screen x/y, so the derivative
        // cross product is dP/du x dP/dv, which points along the face normal when the chart
        // keeps the triangle's winding (front facing here) and against it when mirrored.
        vec3 face = normalize(cross(dFdx(vP), dFdy(vP))) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 smoothN = length(vN) > 1e-4 ? normalize(vN) : face;
        gl_FragColor = vec4(mode == 0 ? vP : mode == 1 ? smoothN : face, 1.0);
      }`,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.Camera();
  const read = (mode: number) => {
    material.uniforms.mode!.value = mode;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const out = new Float32Array(size * size * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, out);
    return out;
  };
  const position = read(0);
  const normal = read(1);
  const face = read(2);
  renderer.setRenderTarget(null);
  target.dispose();
  material.dispose();
  return { position, normal, face };
}

function surfaceArea(geometry: THREE.BufferGeometry) {
  const p = geometry.getAttribute("position");
  const index = geometry.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let area = 0;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(p, index.getX(i));
    b.fromBufferAttribute(p, index.getX(i + 1)).sub(a);
    c.fromBufferAttribute(p, index.getX(i + 2)).sub(a);
    area += b.cross(c).length() / 2;
  }
  return area;
}

// --- per-texel bake ---------------------------------------------------------------------

function bakeTexels(high: Source, texels: { position: Float32Array; normal: Float32Array; face: Float32Array }, size: number, maxDist: number, lowArea: number) {
  const n = size * size;
  const color = new Uint8ClampedArray(n * 4);
  const normal = new Uint8ClampedArray(n * 4);
  const orm = new Uint8ClampedArray(n * 4);
  // 0 = not covered by the low mesh, 1 = surface baked, 2 = covered but cut out.
  const state = new Uint8Array(n);
  const ray = new THREE.Ray();
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const F = new THREE.Vector3();
  const s = new Shading();
  const closest = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let covered = 0;
  let fallbacks = 0;
  for (let t = 0; t < n; t++) if (texels.position[t * 4 + 3]! >= 0.5) covered++;
  s.texelSize = Math.sqrt(lowArea / Math.max(covered, 1));
  covered = 0;

  for (let t = 0; t < n; t++) {
    if (texels.position[t * 4 + 3]! < 0.5) continue;
    covered++;
    P.fromArray(texels.position, t * 4);
    N.fromArray(texels.normal, t * 4).normalize();
    F.fromArray(texels.face, t * 4).normalize();
    // Rays follow the smoothed normal (no gaps at creases) unless smoothing broke down,
    // e.g. at welded back-to-back cards. Facing decisions use the low triangle's side.
    if (!(N.dot(F) > 0.2)) N.copy(F);
    ray.origin.copy(P).addScaledVector(N, -maxDist);
    ray.direction.copy(N);
    const hits = high.bvh.raycast(ray, THREE.DoubleSide, 0, maxDist * 2);
    hits.sort((a, b) => Math.abs(a.distance - maxDist) - Math.abs(b.distance - maxDist));
    let result = 0; // 0 none, 1 opaque, 2 cut out
    for (const hit of hits) {
      const r = s.shade(high, hit.faceIndex!, hit.point, F, false);
      if (r === 0) continue;
      result = r;
      if (r === 1) break;
    }
    if (result === 0) {
      fallbacks++;
      high.bvh.closestPointToPoint(P, closest);
      result = s.shade(high, closest.faceIndex, closest.point, F, true);
    }
    if (result === 2) {
      state[t] = 2;
      continue;
    }
    state[t] = 1;
    const o = t * 4;
    color[o] = linearToSrgb(s.r) * 255 + 0.5;
    color[o + 1] = linearToSrgb(s.g) * 255 + 0.5;
    color[o + 2] = linearToSrgb(s.b) * 255 + 0.5;
    color[o + 3] = high.cutout ? s.a * 255 + 0.5 : 255;
    normal[o] = (s.n.x * 0.5 + 0.5) * 255 + 0.5;
    normal[o + 1] = (s.n.y * 0.5 + 0.5) * 255 + 0.5;
    normal[o + 2] = (s.n.z * 0.5 + 0.5) * 255 + 0.5;
    normal[o + 3] = 255;
    orm[o] = s.ao * 255 + 0.5;
    orm[o + 1] = s.roughness * 255 + 0.5;
    orm[o + 2] = s.metalness * 255 + 0.5;
    orm[o + 3] = 255;
  }
  dilate(state, [color, normal, orm], high.cutout ? color : null, size);
  return { color, normal, orm, covered, fallbacks };
}

/** Evaluates an original material at a surface point. */
class Shading {
  r = 0;
  g = 0;
  b = 0;
  a = 1;
  ao = 1;
  roughness = 1;
  metalness = 0;
  n = new THREE.Vector3();
  /** World size of one baked texel. */
  texelSize = 0;
  private bary = new THREE.Vector3();
  private A = new THREE.Vector3();
  private B = new THREE.Vector3();
  private C = new THREE.Vector3();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  private face = new THREE.Vector3();
  private T = new THREE.Vector3();
  private Bt = new THREE.Vector3();
  private texel = new Float32Array(4);

  /** 0 = rejected (back of a single-sided surface), 1 = opaque, 2 = cut out. */
  shade(high: Source, tri: number, point: THREE.Vector3, lowNormal: THREE.Vector3, force: boolean): number {
    const mat = high.mats[high.triMat[tri]!]!;
    const ia = high.index[tri * 3]!;
    const ib = high.index[tri * 3 + 1]!;
    const ic = high.index[tri * 3 + 2]!;
    const { A, B, C, e1, e2, face, bary, texel } = this;
    A.fromArray(high.positions, ia * 3);
    B.fromArray(high.positions, ib * 3);
    C.fromArray(high.positions, ic * 3);
    e1.subVectors(B, A);
    e2.subVectors(C, A);
    face.crossVectors(e1, e2).normalize();
    const back = face.dot(lowNormal) < 0;
    if (back && !mat.doubleSided && !force) return 0;
    THREE.Triangle.getBarycoord(point, A, B, C, bary);
    const w0 = bary.x;
    const w1 = bary.y;
    const w2 = bary.z;
    const lerp = (arr: Float32Array, k: number, c: number) => arr[ia * k + c]! * w0 + arr[ib * k + c]! * w1 + arr[ic * k + c]! * w2;
    const u = lerp(high.uvs, 2, 0);
    const v = lerp(high.uvs, 2, 1);
    // Mip selection: texels of a w x h texture per world unit on this triangle, against the
    // world size of one baked texel.
    const du1 = high.uvs[ib * 2]! - high.uvs[ia * 2]!;
    const dv1 = high.uvs[ib * 2 + 1]! - high.uvs[ia * 2 + 1]!;
    const du2 = high.uvs[ic * 2]! - high.uvs[ia * 2]!;
    const dv2 = high.uvs[ic * 2 + 1]! - high.uvs[ia * 2 + 1]!;
    const uvArea = Math.abs(du1 * dv2 - du2 * dv1);
    const worldArea = this.T.crossVectors(e1, e2).length();
    const ratio = worldArea > 0 ? uvArea / worldArea : 0;
    const lod = (t: Tex) => 0.5 * Math.log2(Math.max(ratio * t.uvScale * t.w * t.h * this.texelSize * this.texelSize, 1e-12));

    let alpha = mat.opacity;
    this.r = mat.color.r;
    this.g = mat.color.g;
    this.b = mat.color.b;
    if (mat.map) {
      sample(mat.map, u, v, lod(mat.map), texel);
      this.r *= srgbToLinear(texel[0]!);
      this.g *= srgbToLinear(texel[1]!);
      this.b *= srgbToLinear(texel[2]!);
      alpha *= texel[3]!;
    }
    if (mat.vertexColors) {
      this.r *= lerp(high.colors, 3, 0);
      this.g *= lerp(high.colors, 3, 1);
      this.b *= lerp(high.colors, 3, 2);
    }
    this.a = alpha;
    if (mat.cutout && alpha < mat.alphaTest) return 2;

    this.roughness = mat.roughness;
    if (mat.roughnessMap) this.roughness *= (sample(mat.roughnessMap, u, v, lod(mat.roughnessMap), texel), texel[1]!);
    this.metalness = mat.metalness;
    if (mat.metalnessMap) this.metalness *= (sample(mat.metalnessMap, u, v, lod(mat.metalnessMap), texel), texel[2]!);
    this.ao = 1;
    if (mat.aoMap) this.ao = 1 + ((sample(mat.aoMap, u, v, lod(mat.aoMap), texel), texel[0]!) - 1) * mat.aoMapIntensity;

    const n = this.n.set(lerp(high.normals, 3, 0), lerp(high.normals, 3, 1), lerp(high.normals, 3, 2)).normalize();
    if (mat.normalMap) {
      // Tangent frame from this triangle's UV gradients (dP/du, dP/dv).
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) > 1e-12) {
        const T = this.T.copy(e1).multiplyScalar(dv2).addScaledVector(e2, -dv1).divideScalar(det);
        const Bt = this.Bt.copy(e2).multiplyScalar(du1).addScaledVector(e1, -du2).divideScalar(det);
        T.addScaledVector(n, -T.dot(n)).normalize();
        Bt.addScaledVector(n, -Bt.dot(n)).normalize();
        sample(mat.normalMap, u, v, lod(mat.normalMap), texel);
        const x = (texel[0]! * 2 - 1) * mat.normalScale.x;
        const y = (texel[1]! * 2 - 1) * mat.normalScale.y;
        const z = texel[2]! * 2 - 1;
        n.multiplyScalar(z).addScaledVector(T, x).addScaledVector(Bt, y).normalize();
      }
    }
    // A double-sided surface seen from behind shades with the flipped normal (as three does).
    if (back && (mat.doubleSided || force)) n.negate();
    return 1;
  }
}

/**
 * Fills texels without a baked surface from their baked neighbours (8-neighbour mean,
 * repeated) so bilinear filtering and mips do not pull in garbage at chart borders.
 * Colour channels fill everything that is not state 1 (including cut-out texels, so
 * coverage edges do not fringe); alpha only fills uncovered texels (state 0).
 */
function dilate(state: Uint8Array, layers: Uint8ClampedArray[], alphaLayer: Uint8ClampedArray | null, size: number) {
  const known = new Uint8Array(state.length);
  const knownAlpha = new Uint8Array(state.length);
  for (let i = 0; i < state.length; i++) {
    known[i] = state[i] === 1 ? 1 : 0;
    knownAlpha[i] = state[i] !== 0 ? 1 : 0;
    if (alphaLayer && state[i] === 2) alphaLayer[i * 4 + 3] = 0;
  }
  const sum = new Float64Array(layers.length * 3);
  const filled: number[] = [];
  const filledAlpha: number[] = [];
  for (let it = 0; it < 16; it++) {
    filled.length = 0;
    filledAlpha.length = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        const needColor = !known[i];
        const needAlpha = alphaLayer !== null && !knownAlpha[i];
        if (!needColor && !needAlpha) continue;
        let count = 0;
        let countA = 0;
        let sumA = 0;
        sum.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= size || (dx === 0 && dy === 0)) continue;
            const j = yy * size + xx;
            if (needColor && known[j] === 1) {
              count++;
              for (let l = 0; l < layers.length; l++) for (let c = 0; c < 3; c++) sum[l * 3 + c]! += layers[l]![j * 4 + c]!;
            }
            if (needAlpha && knownAlpha[j] === 1) countA++, (sumA += alphaLayer![j * 4 + 3]!);
          }
        }
        if (needColor && count > 0) {
          for (let l = 0; l < layers.length; l++) {
            for (let c = 0; c < 3; c++) layers[l]![i * 4 + c] = sum[l * 3 + c]! / count;
            if (layers[l] !== alphaLayer) layers[l]![i * 4 + 3] = 255;
          }
          filled.push(i);
        }
        if (needAlpha && countA > 0) {
          alphaLayer![i * 4 + 3] = sumA / countA;
          filledAlpha.push(i);
        }
      }
    // Newly filled texels only become sources in the next round.
    for (const i of filled) known[i] = 1;
    for (const i of filledAlpha) knownAlpha[i] = 1;
  }
  if (!alphaLayer) for (let i = 0; i < state.length; i++) layers[0]![i * 4 + 3] = 255;
}

function makeTextures(baked: { color: Uint8ClampedArray; normal: Uint8ClampedArray; orm: Uint8ClampedArray }, size: number) {
  const make = (data: Uint8ClampedArray, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.DataTexture(new Uint8Array(data.buffer), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = colorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { color: make(baked.color, THREE.SRGBColorSpace), normal: make(baked.normal, THREE.NoColorSpace), orm: make(baked.orm, THREE.NoColorSpace) };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 1), 1 / 2.4) - 0.055);
