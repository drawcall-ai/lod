import { Matrix4, OrthographicCamera, RGBAFormat, Scene, Vector3, type Object3D, type Renderer } from "three/webgpu";
import { uniform } from "three/tsl";
import { MAPS, PAD, boundingRadius, texelPixels, validateImpostor, type Impostor, type ImpostorLayout, type ImpostorMap } from "../impostor.js";
import { frameBasis, frameDirection, type Vec3 } from "../octahedral.js";
import { checkBakeRenderer, inTurn } from "../../bake.js";
import { boundingBox, showDetail } from "../../source/detail.js";
import { ImpostorAtlasMip } from "./atlas.js";
import { swapMaterials, type BakeSettings } from "./materials.js";
import { bakeMip } from "./sheet.js";
import { sourceForBake } from "./source.js";
import { fittedHalfSize } from "./fit.js";

export interface BakeImpostorOptions {
  /**
   * "full" (default): frames from every side, so any orientation works. "hemi": frames
   * from the horizon up only, for objects that always stand upright; the same quality
   * there with about 45% less memory.
   */
  layout?: ImpostorLayout;
  /** frames per atlas side; default 16 for full, 12 for hemi */
  frames?: number;
  /**
   * pixels per frame: the impostor stays sharp up to about this size on screen. Rounded
   * down to a power of two so mip levels never mix two frames; default 128.
   */
  resolution?: number;
  /**
   * Largest on-screen height (CSS pixels, as `LodLevel.maxPixels`) the impostor will be
   * drawn at, when that is above the height where it is sharp (its default maxPixels).
   * Larger, it shows its top mip magnified, which then reads the source's textures as
   * sharp as they are at this height, not with the look of their small mips. Alpha-tested
   * materials are read at full detail at every size, which holds their cut-out's coverage.
   * Default: the height where it is sharp (see `texelPixels`, and `framePixels` for a
   * CachedLodLoader level).
   */
  maxPixels?: number;
  /**
   * bake an emissive layer; default: when any material emits. It is stored as 0..1
   * sRGB, so emissive * emissiveIntensity above 1 is clipped.
   */
  emissive?: boolean;
  /**
   * renders per output pixel per axis, for smooth edges; default 2. Textures are read at
   * the output pixel's size, as multisampling does.
   */
  supersample?: number;
}

/**
 * Bake `object` (in its own space, ignoring its own transform) into an impostor, drawing
 * with `renderer`, as three's PMREMGenerator does. Nested LODs are baked at their level 0,
 * an InstancedLod with every instance at its level 0. ImpostorMeshes are refused: bake
 * from their source instead.
 *
 * `renderer` must be one made for bakes: make one with `createBakeRenderer`, as CachedLodLoader
 * does for itself and a .glts script that bakes does too. Such a renderer is initialised,
 * clears to transparent black and only when told to (`autoClear = false`), and has no MRT
 * and no XR session; the bake throws otherwise. Nor may its canvas be a square of a frame's size (resolution ×
 * supersample): three r186 applies a target's viewport only when it differs from the
 * canvas's, and would draw that frame over the whole target. Bakes on one renderer run
 * one at a time.
 *
 * Each frame is an orthographic look at the bounding-box centre, rendered once per mip
 * level at that level's size. The object's materials are rendered unlit into one target
 * per map: base colour + coverage, object-space normal + depth,
 * occlusion/roughness/metalness and, if needed, emissive. A material that changes three's
 * default specular adds the object's mean specular (see `Impostor.specular`).
 * Custom lighting behavior is not baked; the resulting surface is lit at draw time.
 */
export function bakeImpostor(object: Object3D, renderer: Renderer, options: BakeImpostorOptions = {}): Promise<Impostor> {
  return inTurn(renderer, () => bake(object, renderer, options));
}

async function bake(object: Object3D, renderer: Renderer, options: BakeImpostorOptions): Promise<Impostor> {
  checkBakeRenderer(renderer, "bakeImpostor");
  const copy = sourceForBake(object);
  try {
    return await bakeSource(copy.root, renderer, options);
  } finally {
    copy.dispose();
  }
}

/** Bake `source`, a copy of the object that the bake may move and change. */
async function bakeSource(source: Object3D, renderer: Renderer, options: BakeImpostorOptions): Promise<Impostor> {
  const layout = options.layout ?? "full";
  const frames = options.frames ?? (layout === "hemi" ? 12 : 16);
  const resolution = options.resolution ?? 128;
  const supersample = options.supersample ?? 2;
  if (!Number.isInteger(frames) || frames < 2) throw new Error("bakeImpostor: frames must be an integer >= 2");
  if (!Number.isFinite(resolution) || resolution < 4) throw new Error("bakeImpostor: resolution must be a number >= 4");
  if (!Number.isInteger(supersample) || supersample < 1) throw new Error("bakeImpostor: supersample must be an integer >= 1");
  if (options.maxPixels !== undefined && !(options.maxPixels > 0)) throw new Error("bakeImpostor: maxPixels must be > 0");
  const cell = 2 ** Math.floor(Math.log2(resolution));

  source.matrix.identity();
  source.matrix.decompose(source.position, source.quaternion, source.scale);
  // Bones are descendants, so this also moves them; getVertexPosition reads bone.matrixWorld.
  source.updateMatrixWorld(true);
  // The object is baked whatever a parent LOD shows of it, and nested LODs at full detail.
  source.visible = true;
  showDetail(source);

  const bounds = boundingBox(source);
  if (bounds.isEmpty()) throw new Error("bakeImpostor: object has no visible geometry");
  const box: Impostor["box"] = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z];
  const centre = bounds.getCenter(new Vector3());
  const radius = boundingRadius(box);
  const directions: Vec3[] = [];
  for (let row = 0; row < frames; row++) for (let col = 0; col < frames; col++) directions.push(frameDirection(layout, frames, col, row));
  const halfSize = fittedHalfSize(source, centre, directions) * (1 + PAD);

  const distance = 2 * radius + 1e-3;
  // Textures are read at the size of an atlas texel; the top mip's at the size of a pixel at maxPixels. Alpha-tested
  // materials read theirs at full detail (see `swapMaterials`).
  const sharp = texelPixels({ size: cell * frames, frames, box, halfSize });
  const textureBias = (m: number) => Math.log2(supersample) - (m === 0 ? Math.log2(Math.max(1, (options.maxPixels ?? sharp) / sharp)) : 0);
  const settings: BakeSettings = { distance, radius, textureBias: uniform(0) };
  const swapped = swapMaterials(source, settings);
  const emissive = options.emissive ?? swapped.emits;
  const maps: ImpostorMap[] = emissive ? [...MAPS] : ["base", "normalDepth", "orm"];

  // Every mip level is rendered, not filtered from the one above: the source does not look
  // the same at every size (a texture whose small mips mix in dark texels darkens with
  // distance), and filtering would freeze the look of the largest.
  const atlases = Array.from({ length: Math.log2(cell) + 1 }, (_, m) => new ImpostorAtlasMip(maps, frames, cell >> m, swapped.specular));
  const scene = new Scene();
  scene.add(source);
  const camera = new OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0, 4 * radius + 1e-3);
  camera.matrixAutoUpdate = false;
  // Bounds count meshes on every layer, so the bake draws them all.
  camera.layers.enableAll();
  const frameCameras = directions.map((n) => {
    const { tangent: t, bitangent: b } = frameBasis(n);
    return new Matrix4().set(
      t[0],
      b[0],
      n[0],
      centre.x + n[0] * distance,
      t[1],
      b[1],
      n[1],
      centre.y + n[1] * distance,
      t[2],
      b[2],
      n[2],
      centre.z + n[2] * distance,
      0,
      0,
      0,
      1,
    );
  });
  try {
    for (const [m, atlas] of atlases.entries()) {
      settings.textureBias.value = textureBias(m);
      await bakeMip(atlas, supersample, renderer, scene, camera, frameCameras);
    }
  } finally {
    for (const material of swapped.materials) material.dispose();
  }
  if (!atlases.some((atlas) => atlas.covered())) throw new Error("bakeImpostor: nothing visible was baked");
  for (const atlas of atlases) atlas.fillGutters();
  const sum = (way: "own" | "turned") => atlases.reduce((total, atlas) => total + atlas.agreement[way], 0);
  if (sum("turned") > sum("own")) for (const atlas of atlases) atlas.useTurned();

  const layers = maps.map((map, i) => ({
    format: RGBAFormat,
    mipmaps: atlases.map((atlas) => {
      const layer = atlas.layers[i];
      if (!layer) throw new Error(`bakeImpostor: no ${map} layer`);
      return layer;
    }),
  }));
  const impostor: Impostor = { version: 4, layout, frames, size: cell * frames, box, halfSize, maps, layers };
  const [top] = atlases;
  if (!top) throw new Error("bakeImpostor: no mip levels");
  if (swapped.specular) impostor.specular = top.meanSpecular();
  validateImpostor(impostor);
  return impostor;
}
