import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardNodeMaterial,
  Matrix4,
  NoColorSpace,
  RGFormat,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  type Box3,
  type ColorSpace,
  type Material,
  type Object3D,
  type MeshStandardNodeMaterialParameters,
  type Renderer,
} from "three/webgpu";
import { checkBakeRenderer, inTurn } from "../bake.js";
import { boundingBox, forEachMesh } from "../source/detail.js";
import { area, merge } from "../source/surface.js";
import { mipmaps, type Mip } from "./mips.js";
import { isImpostorMesh, placeLike } from "../three.js";
import { renderFaces } from "./interior/faces.js";
import { InteriorMappingMaterial } from "./interior/material.js";
import { readBoxes } from "./interior/rooms.js";
import { layOut, simplified } from "./low.js";
import { project } from "./project.js";
import { preserveCoverage } from "./coverage.js";

export type BakeMeshOptions = {
  /** texels per side of each baked map; default 1024, or 512 when the source cuts out (foliage) */
  textureSize?: number;
  /** What renders the source, and the rooms of `interior`: one made for bakes (make one with `createBakeRenderer`; see `bakeImpostor`). */
  renderer: Renderer;
  /**
   * Rooms to show through the source's glass (interior mapping): each direct child is one
   * room, which fills its bounding box; lights are refused (lamps: emissive materials).
   * It sits in the source's space as a child of the source would, or where it is if it is
   * inside the source; either way it is hidden from the exterior's bake. Glass is a
   * surface that lets what is behind it show: transparent with opacity below 1, or
   * transmissive (texture alpha is not read). Each room is captured from its box's centre
   * as its colours and its glow; the baked material lights the colours by the indirect
   * light reaching each window.
   * Rooms must not overlap except at their walls. Put inward-facing walls, floors and
   * ceilings on the box faces, with the box beginning just behind its windows. Furniture
   * away from those faces appears flattened onto them. Glass with no nearby room stays
   * plain; the bake fails if none of the source's glass looks into a room.
   */
  interior?: Object3D;
} & (
  | {
      /**
       * The mesh to bake onto, in the source's own space, such as a hand-made or generated
       * low-poly shell of a building. Only its static geometry is used: materials are
       * ignored, and its UVs are used if they lie inside 0..1 without overlapping and
       * with a texel of border between charts, else it is unwrapped again.
       */
      low: Object3D;
      ratio?: undefined;
    }
  | {
      low?: undefined;
      /** share of the source's triangles the low mesh, simplified from it, has, in (0, 1]; default 0.05 */
      ratio?: number;
    }
);

/**
 * Bake `source` (in its own space, ignoring its own transform) onto one low-poly mesh with
 * its own textures: base colour (alpha: cut out or not), tangent-space normal and
 * occlusion/roughness/metalness, drawn with a MeshStandardNodeMaterial. The mesh is placed
 * like `source`. The source is drawn unlit with its own materials, as `bakeImpostor` draws
 * it; emissive, clearcoat and the like are not baked, and blended transparency bakes opaque:
 * glass in its own colour, or as windows into the rooms of `interior`.
 *
 * Nested LODs are baked at their level 0; InstancedMeshes, and the source level of a
 * Lod, once per instance: a field of plants bakes as a whole. Skinned meshes
 * and ImpostorMeshes (which have no surface to read) are refused.
 *
 * Each texel of the low mesh takes the outermost source surface along the low mesh's
 * normal, as the view of it that faces it best sees it (see `project`).
 */
export async function bakeMesh(source: Object3D, options: BakeMeshOptions): Promise<Mesh> {
  const { interior, renderer } = options;
  checkBakeRenderer(renderer, "bakeMesh");
  if (!interior) return bake(source, options, null);
  const placement = placementOf(interior, source);
  const boxes = readBoxes(interior, placement);
  // Hidden for the whole bake, which yields: a scene drawing it meanwhile shows it gone.
  const visible = interior.visible;
  interior.visible = false;
  try {
    return await bake(source, options, { object: interior, placement, boxes });
  } finally {
    interior.visible = visible;
  }
}

/** An interior to bake: its object, where it sits in the source's space, and its rooms' boxes there. */
interface Interior {
  object: Object3D;
  placement: Matrix4;
  boxes: Box3[];
}

async function bake(source: Object3D, options: BakeMeshOptions, interior: Interior | null): Promise<Mesh> {
  // The visible materials the source draws with.
  const materials: Material[] = [];
  forEachMesh(source, (mesh) => {
    if (isImpostorMesh(mesh)) throw new Error(`bakeMesh: cannot bake an ImpostorMesh ("${mesh.name}"); bake from its source instead`);
    for (const material of [mesh.material].flat()) if (material.visible) materials.push(material);
  });
  const cutout = materials.some((material) => material.alphaTest > 0 || (material.alphaToCoverage && !material.transparent));
  const size = options.textureSize ?? (cutout ? 512 : 1024);
  if (!Number.isInteger(size) || size < 16) throw new Error(`bakeMesh: textureSize must be an integer >= 16, got ${size}`);
  const ratio = options.ratio ?? 0.05;
  if (!(ratio > 0 && ratio <= 1)) throw new Error(`bakeMesh: ratio must be in (0, 1], got ${ratio}`);

  const low = await layOut(options.low ?? (await simplified(merge(source, "bakeMesh"), ratio)), size);
  if (low.raster.covered === 0) throw new Error("bakeMesh: the low mesh covers no texel");
  const texelSize = Math.sqrt(area(low) / low.raster.covered);
  const radius = boundingBox(source).getSize(new Vector3()).length() / 2;
  // How far in front of the low surface the source it takes may be: what the low mesh cut off, short of the other side
  // of thin parts.
  const reach = radius * 0.05;
  const { renderer } = options;
  const maps = await inTurn(renderer, () => project(source, low, size, texelSize, reach, cutout, interior && interior.boxes, renderer));

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(low.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(low.normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(low.uvs, 2));
  geometry.setIndex(new BufferAttribute(low.index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const orm = bakedTexture({ data: maps.orm, width: size, height: size }, NoColorSpace);
  const color = { data: new Uint8ClampedArray(maps.color.buffer), width: size, height: size };
  const parameters: MeshStandardNodeMaterialParameters = {
    // Cut-outs get mips that preserve their coverage; else the GPU's are as good.
    map: bakedTexture(color, SRGBColorSpace, cutout ? preserveCoverage(mipmaps(color, true)) : undefined),
    normalMap: bakedTexture({ data: maps.normal, width: size, height: size }, NoColorSpace),
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    alphaTest: cutout ? 0.5 : 0,
    side: materials.some((material) => material.side === DoubleSide) ? DoubleSide : FrontSide,
  };
  const material = interior ? await furnished(parameters, interior, maps.windows, size, renderer) : new MeshStandardNodeMaterial(parameters);
  const mesh = new Mesh(geometry, material);
  mesh.name = `${source.name || "object"} baked`;
  placeLike(mesh, source);
  return mesh;
}

/** A material of `parameters` that shows `interior`'s rooms through the glass texels of `windows`. */
async function furnished(
  parameters: MeshStandardNodeMaterialParameters,
  interior: Interior,
  windows: Uint8Array,
  size: number,
  renderer: Renderer,
): Promise<InteriorMappingMaterial> {
  if (!windows.some((value, i) => i % 2 === 0 && value > 0)) throw new Error("bakeMesh: no glass of the source looks into a room of the interior");
  const { object, placement, boxes } = interior;
  const faces = await inTurn(renderer, () => renderFaces(object, placement, boxes, faceSize(size, boxes.length), renderer));
  return new InteriorMappingMaterial(parameters).furnish({ ...faces, boxes, windows: windowTexture(windows, size) });
}

/**
 * Pixels per side of each room's cube faces: all of them together about as many as one
 * baked map of `size`², within 32..256.
 */
const faceSize = (size: number, rooms: number) => Math.min(256, Math.max(32, 2 ** Math.floor(Math.log2(size / Math.sqrt(6 * rooms)))));

/** Where `interior` sits in `source`'s own space: as a child of it, or where it is if inside it. */
function placementOf(interior: Object3D, source: Object3D): Matrix4 {
  let inside = false;
  interior.traverseAncestors((node) => (inside ||= node === source));
  if (!inside) {
    if (interior.matrixAutoUpdate) interior.updateMatrix();
    return interior.matrix.clone();
  }
  interior.updateWorldMatrix(true, false);
  return source.matrixWorld.clone().invert().multiply(interior.matrixWorld);
}

/** The windows of `project`, as a texture: its share is filtered, its rooms read texel by texel. */
function windowTexture(windows: Uint8Array, size: number): DataTexture {
  const texture = new DataTexture(windows, size, size, RGFormat, UnsignedByteType);
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** A texture of baked pixels, with `mips` as its mipmaps if given, else the GPU's. */
function bakedTexture(base: { data: Uint8Array | Uint8ClampedArray; width: number; height: number }, colorSpace: ColorSpace, mips?: Mip[]): DataTexture {
  const texture = new DataTexture(new Uint8Array(base.data.buffer), base.width, base.height, RGBAFormat, UnsignedByteType);
  texture.colorSpace = colorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  if (mips) {
    texture.mipmaps = mips.map(({ data, width, height }) => ({ data: new Uint8Array(data.buffer), width, height }));
    texture.generateMipmaps = false;
  } else texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
