import { HalfFloatType, Matrix4, NearestFilter, OrthographicCamera, RenderTarget, Scene, Vector3, type Object3D, type Renderer } from "three/webgpu";
import { uniform } from "three/tsl";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { MAPS, boundingRadius, texelPixels, validateImpostor, type Impostor, type ImpostorLayout, type ImpostorMap } from "../impostor.js";
import { frameBasis, frameDirection, type Vec3 } from "../octahedral.js";
import { boundingBox, forEachMesh, forEachVertex, showDetail } from "../../bounds.js";
import { pause } from "../../pause.js";
import { borrow, readFloats, sharedRenderer } from "../../renderer.js";
import { isImpostorMesh } from "../../three.js";
import { Atlas } from "./atlas.js";
import { OUTPUTS, swapMaterials, type BakeSettings, type Output } from "./materials.js";

export interface BakeImpostorOptions {
  /**
   * "full" (default): views from every side, so any orientation works. "hemi": views
   * from the horizon up only, for objects that always stand upright; the same quality
   * there with about 45% less memory.
   */
  layout?: ImpostorLayout;
  /** views per atlas side; default 16 for full, 12 for hemi */
  frames?: number;
  /**
   * pixels per view: the impostor stays sharp up to about this size on screen. Rounded
   * down to a power of two so mip levels never mix two views; default 128.
   */
  resolution?: number;
  /**
   * Largest on-screen height (CSS pixels, as `LodLevel.maxPixels`) the impostor will be
   * drawn at, when that is above the height where it is sharp (its default maxPixels).
   * Larger, it shows its top mip magnified, which then reads the source's textures as
   * sharp as they are at this height: alpha-tested leaves keep the coverage and colour
   * they show up close, not the denser, darker look of their texture's small mips.
   * Default: the height where it is sharp.
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
 * Empty border around the object in every frame, as a fraction of the frame's half
 * size. It keeps mip levels from blending a frame's silhouette into its neighbour.
 */
const PAD = 0.06;

/**
 * Bake `object` (in its own space, ignoring its own transform) into an impostor. Nested
 * LODs are baked at their level 0, an InstancedLod with every instance at its level 0.
 * ImpostorMeshes are refused: bake from their source instead.
 *
 * Each frame is an orthographic look at the bounding-box centre, rendered once per mip
 * level at that level's size. The object's materials are rendered unlit into one target
 * per map: base colour + coverage, object-space normal + depth,
 * occlusion/roughness/metalness and, if needed, emissive. A material that changes three's
 * default specular adds the object's mean specular (see `Impostor.specular`).
 */
export async function bakeImpostor(object: Object3D, options: BakeImpostorOptions = {}): Promise<Impostor> {
  const layout = options.layout ?? "full";
  const frames = options.frames ?? (layout === "hemi" ? 12 : 16);
  const resolution = options.resolution ?? 128;
  const supersample = options.supersample ?? 2;
  if (!Number.isInteger(frames) || frames < 2) throw new Error("bakeImpostor: frames must be an integer >= 2");
  if (!Number.isFinite(resolution) || resolution < 4) throw new Error("bakeImpostor: resolution must be a number >= 4");
  if (!Number.isInteger(supersample) || supersample < 1) throw new Error("bakeImpostor: supersample must be an integer >= 1");
  if (options.maxPixels !== undefined && !(options.maxPixels > 0)) throw new Error("bakeImpostor: maxPixels must be > 0");
  const cell = 2 ** Math.floor(Math.log2(resolution));

  // SkeletonUtils.clone rebinds skinned meshes to cloned bones; Object3D.clone would
  // keep the original skeleton, posed by the original's world transform.
  forEachMesh(object, (mesh) => {
    if (isImpostorMesh(mesh)) throw new Error(`bakeImpostor: cannot bake an ImpostorMesh ("${mesh.name}"); bake from its source instead`);
  });
  const source = clone(object);
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
  // Textures are read at the size of an atlas texel; the top mip's at the size of a pixel at maxPixels.
  const sharp = texelPixels({ size: cell * frames, frames, box, halfSize });
  const textureBias = (m: number) => Math.log2(supersample) - (m === 0 ? Math.log2(Math.max(1, (options.maxPixels ?? sharp) / sharp)) : 0);
  const settings: BakeSettings = { distance, radius, textureBias: uniform(0) };
  const swapped = swapMaterials(source, settings);
  const emissive = options.emissive ?? swapped.emits;
  const maps: ImpostorMap[] = emissive ? [...MAPS] : ["base", "normalDepth", "orm"];

  // Every mip level is rendered, not filtered from the one above: the source does not look
  // the same at every size (alpha-tested leaves whose texture mips mix in the dark texels
  // around them darken with distance), and filtering would freeze the look of the largest.
  const atlases = Array.from({ length: Math.log2(cell) + 1 }, (_, m) => new Atlas(maps, frames, cell >> m, swapped.specular));
  const renderer = await sharedRenderer();
  const scene = new Scene();
  scene.add(source);
  const camera = new OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0, 4 * radius + 1e-3);
  camera.matrixAutoUpdate = false;
  // Bounds count meshes on every layer, so the bake draws them all.
  camera.layers.enableAll();
  const views = directions.map((n) => {
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
      await bakeMip(atlas, supersample, renderer, scene, camera, views);
    }
  } finally {
    for (const material of swapped.materials) material.dispose();
  }
  if (!atlases.some((atlas) => atlas.covered())) throw new Error("bakeImpostor: nothing visible was baked");
  for (const atlas of atlases) atlas.fillGutters();
  const sum = (way: "own" | "turned") => atlases.reduce((total, atlas) => total + atlas.agreement[way], 0);
  if (sum("turned") > sum("own")) for (const atlas of atlases) atlas.useTurned();

  const layers = maps.map((map, i) =>
    atlases.map((atlas) => {
      const layer = atlas.layers[i];
      if (!layer) throw new Error(`bakeImpostor: no ${map} layer`);
      return layer;
    }),
  );
  const impostor: Impostor = { version: 3, layout, frames, size: cell * frames, box, halfSize, maps, layers };
  const [top] = atlases;
  if (!top) throw new Error("bakeImpostor: no mip levels");
  if (swapped.specular) impostor.specular = top.meanSpecular();
  validateImpostor(impostor);
  return impostor;
}

/** Edge of the largest target frames render into side by side, which is read back at once. */
const TILE = 1024;

/**
 * Colour attachments one pass renders: four half-float targets fill the 32 bytes per
 * sample WebGPU guarantees.
 */
const PER_PASS = 4;

/**
 * Render every frame (`views`: camera matrices, in atlas order) into `atlas`, at its cell
 * size × `supersample`. Frames render side by side into tiles of up to TILE square, so
 * that each map is read back once per tile, in passes of up to PER_PASS outputs.
 */
async function bakeMip(atlas: Atlas, supersample: number, renderer: Renderer, scene: Scene, camera: OrthographicCamera, views: Matrix4[]): Promise<void> {
  const { frames, maps } = atlas;
  const side = atlas.cell * supersample;
  const per = Math.max(1, Math.min(frames, Math.floor(TILE / side)));
  const width = per * side;
  // one output per map, then the second way to store the normals (see Atlas), then the specular
  const names: Output[] = OUTPUTS.filter((name) => (name === "emissive" ? maps.includes("emissive") : name !== "specular" || atlas.specular));
  const passes = Array.from({ length: Math.ceil(names.length / PER_PASS) }, (_, p) => {
    const outputs = names.slice(p * PER_PASS, (p + 1) * PER_PASS);
    const target = new RenderTarget(width, width, { count: outputs.length, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true });
    outputs.forEach((name, i) => {
      const texture = target.textures[i];
      if (!texture) throw new Error("bakeImpostor: a render target lacks a texture");
      texture.name = name;
    });
    return target;
  });
  try {
    for (let row0 = 0; row0 < frames; row0 += per)
      for (let col0 = 0; col0 < frames; col0 += per) {
        const tile: Array<{ col: number; row: number; x: number; y: number }> = [];
        for (let row = row0; row < Math.min(row0 + per, frames); row++)
          for (let col = col0; col < Math.min(col0 + per, frames); col++) tile.push({ col, row, x: (col - col0) * side, y: (row - row0) * side });
        const placed = tile.map(({ col, row, x, y }) => ({ view: views[row * frames + col], x, y }));
        for (const target of passes) renderTile(renderer, target, scene, camera, placed, side);
        const pixels = await Promise.all(passes.flatMap((target) => target.textures.map((_, i) => readFloats(renderer, target, i))));
        for (const { col, row, x, y } of tile) atlas.write(pixels, width, supersample, col, row, x, y);
        await pause();
      }
  } finally {
    for (const target of passes) target.dispose();
  }
}

/** Clear `target` and render each frame's view into its `side` square at (x, y), counted from the bottom left as the atlas is. */
function renderTile(
  renderer: Renderer,
  target: RenderTarget,
  scene: Scene,
  camera: OrthographicCamera,
  frames: Array<{ view: Matrix4 | undefined; x: number; y: number }>,
  side: number,
): void {
  const restore = borrow(renderer, target);
  try {
    renderer.clear(true, true, true);
    target.scissorTest = true;
    for (const { view, x, y } of frames) {
      if (!view) throw new Error("bakeImpostor: a frame has no view");
      // WebGPU counts viewport rows from the top; `readFloats` turns the image over.
      const top = target.height - y - side;
      target.viewport.set(x, top, side, side);
      target.scissor.set(x, top, side, side);
      camera.matrix.copy(view);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
    }
  } finally {
    // The next tile clears it whole.
    target.scissorTest = false;
    restore();
  }
}

/**
 * The smallest square half-size that holds the object in every frame: the largest
 * extent of any vertex along any frame's image axes. Tighter than the bounding
 * sphere, which wastes about a third of every frame on a tree.
 */
function fittedHalfSize(source: Object3D, centre: Vector3, directions: Vec3[]): number {
  const axes = directions.flatMap((n) => {
    const { tangent, bitangent } = frameBasis(n);
    return [tangent, bitangent];
  });
  let half = 0;
  forEachVertex(source, (p) => {
    p.sub(centre);
    for (const a of axes) half = Math.max(half, Math.abs(p.x * a[0] + p.y * a[1] + p.z * a[2]));
  });
  if (half === 0) throw new Error("bakeImpostor: object has no extent (every vertex is at one point)");
  return half;
}
