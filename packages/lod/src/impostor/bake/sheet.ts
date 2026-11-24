import {
  HalfFloatType,
  NearestFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  type Matrix4,
  type Node,
  type OrthographicCamera,
  type Renderer,
  type Scene,
  type Texture,
} from "three/webgpu";
import { Break, Fn, If, Loop, int, ivec2, mrt, screenCoordinate, select, textureLoad, uniform, vec4 } from "three/tsl";
import { at } from "../../at.js";
import { readBytes, readFloats, zeroes } from "../../bake.js";
import { nextTask } from "../../task.js";
import type { ImpostorMap } from "../impostor.js";
import type { Output } from "./materials.js";

// Rendering an atlas: its frames side by side in sheets, which the GPU averages into every mip of the atlas.

/** Edge of the largest target frames render into side by side, a sheet. */
const SHEET = 1024;

/**
 * Colour attachments one sheet target renders: four half-float targets fill the 32 bytes per sample WebGPU
 * guarantees.
 */
const PER_TARGET = 4;

/** One mip of a baked atlas, read back: RGBA8 rows bottom first, as the impostor stores them. */
export interface BakedMip {
  /** One per map. */
  layers: Uint8Array[];
  /** The normals turned toward the camera, the second way to store them (see `ImpostorAtlasMip`). */
  turned: Uint8Array;
}

/** What `bakeAtlas` reads back: every mip, top first, and at the top mip the specular if baked, F0 RGB then F90. */
export interface BakedAtlas {
  mips: BakedMip[];
  specular: Float32Array | null;
}

/**
 * Render every frame (`frameCameras`: camera matrices, in atlas order) at `cell` × `supersample` and average the
 * samples into each mip of the atlas, from `cell` down to one texel per frame. The bake materials write every output
 * multiplied by the sample's coverage (see `swapMaterials`), so a box average of the samples a texel covers, which the
 * sheets' GPU mips are, holds the texel's coverage and its coverage-weighted sums: each atlas texel is their quotient,
 * the mean of the samples that cover it, so the silhouette's colour is the object's rather than a mix with the cleared
 * background. Every mip averages the samples themselves, at the top mip's texture detail. Frames are power-of-two
 * squares on a power-of-two grid, so no GPU mip down to one texel per frame mixes two frames.
 */
export async function bakeAtlas(
  maps: readonly ImpostorMap[],
  specular: boolean,
  frames: number,
  cell: number,
  supersample: number,
  renderer: Renderer,
  scene: Scene,
  camera: OrthographicCamera,
  frameCameras: Matrix4[],
): Promise<BakedAtlas> {
  const side = cell * supersample;
  const buffer = renderer.getDrawingBufferSize(new Vector2());
  if (buffer.x === side && buffer.y === side)
    throw new Error(`bakeImpostor: the renderer's canvas is ${side} px square, a frame's size: three would draw that frame over the whole sheet`);
  const per = Math.max(1, Math.min(frames, Math.floor(SHEET / side)));
  const width = per * side;
  // one output per map, then the second way to store the normals, then the specular
  const names: Output[] = [...maps, "turned", ...(specular ? (["specular"] as const) : [])];
  const sheets = grouped(names).map((group) => ({ target: target(width, group, HalfFloatType, true), zero: zeroes(group) }));
  const resolve = resolver(renderer, new Map(sheets.flatMap(({ target }) => target.textures.map((texture) => [texture.name, texture] as const))));
  // The atlas: 8-bit targets of every mip for the maps and turned normals; one half-float target for the specular,
  // whose mean only the top mip gives.
  const levels = Array.from({ length: Math.log2(cell) + 1 }, (_, m) => m);
  const outputs: Output[] = [...maps, "turned"];
  const groups = grouped(outputs).map((group) => ({
    material: resolve.material(group),
    targets: levels.map((m) => target(frames * (cell >> m), group, UnsignedByteType)),
  }));
  const specularGroup = specular ? { material: resolve.material(["specular"]), targets: [target(frames * cell, ["specular"], HalfFloatType)] } : null;
  try {
    for (let row0 = 0; row0 < frames; row0 += per)
      for (let col0 = 0; col0 < frames; col0 += per) {
        const sheet: Array<{ matrix: Matrix4; x: number; y: number }> = [];
        for (let row = row0; row < Math.min(row0 + per, frames); row++)
          for (let col = col0; col < Math.min(col0 + per, frames); col++)
            sheet.push({ matrix: at(frameCameras, row * frames + col), x: (col - col0) * side, y: (row - row0) * side });
        for (const { target, zero } of sheets) renderSheet(renderer, target, zero, scene, camera, sheet, side);
        const placed = { col0, row0, cols: Math.min(per, frames - col0), rows: Math.min(per, frames - row0) };
        for (const { material, targets } of [...groups, ...(specularGroup ? [specularGroup] : [])])
          targets.forEach((atlas, m) => resolve.into(atlas, material, placed, cell >> m, Math.log2(supersample) + m, width));
        // Yield to the page between sheets, so that a long bake does not freeze it.
        await nextTask();
      }
    const mips = await Promise.all(
      levels.map(async (m) => {
        const read = (
          await Promise.all(groups.map(({ targets }) => Promise.all(at(targets, m).textures.map((_, i) => readBytes(renderer, at(targets, m), i)))))
        ).flat();
        return { layers: read.slice(0, maps.length), turned: at(read, maps.length) };
      }),
    );
    const specularTarget = specularGroup?.targets[0];
    return { mips, specular: specularTarget ? await readFloats(renderer, specularTarget, 0) : null };
  } finally {
    for (const t of [...sheets.map(({ target }) => target), ...groups.flatMap(({ targets }) => targets), ...(specularGroup?.targets ?? [])]) t.dispose();
    for (const { zero } of sheets) zero.material.dispose();
    for (const { material } of [...groups, ...(specularGroup ? [specularGroup] : [])]) material.dispose();
  }
}

/** `names` in groups that one target renders: at most PER_TARGET. */
const grouped = <T>(names: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(names.length / PER_TARGET) }, (_, p) => names.slice(p * PER_TARGET, (p + 1) * PER_TARGET));

/** A square render target `size` across with one texture per name, sRGB for colour maps when 8-bit; a sheet `mipmapped`. */
function target(size: number, names: readonly string[], type: typeof HalfFloatType | typeof UnsignedByteType, mipmapped = false): RenderTarget {
  const made = new RenderTarget(size, size, {
    count: names.length,
    type,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: mipmapped,
    generateMipmaps: mipmapped,
  });
  names.forEach((name, i) => {
    const texture = at(made.textures, i);
    texture.name = name;
    if (type === UnsignedByteType && (name === "base" || name === "emissive")) texture.colorSpace = SRGBColorSpace;
  });
  return made;
}

/** The frames of one sheet: from atlas frame (`col0`, `row0`), `cols` × `rows` of them. */
interface SheetFrames {
  col0: number;
  row0: number;
  cols: number;
  rows: number;
}

/**
 * The pass that divides a sheet's averaged sums by its coverage into the texels of its frames in an atlas mip, of
 * `cell` texels a frame, read from the sheet's GPU mip `from` (of a sheet `width` across at level 0), for the outputs
 * of one of its `material`s. A texel no sample covers takes the mean of the first coarser mip of its frame that a sample
 * covers (pull-push), so that filtering and mips only ever read the object's own colours, normals and depths near its
 * silhouette; its coverage stays zero.
 */
function resolver(renderer: Renderer, sheet: Map<string, Texture>) {
  const level = uniform(0, "int");
  // The sheet's height at `level`, the atlas mip's, and where the sheet's frames start in the atlas, bottom first.
  const sheetHeight = uniform(0, "int");
  const atlasHeight = uniform(0, "int");
  const origin = uniform(new Vector2(), "ivec2");
  // How many levels coarser than `level` a frame is one texel.
  const frameSteps = uniform(0, "int");
  const fragment = ivec2(screenCoordinate);
  // The atlas texel, bottom first.
  const local = ivec2(fragment.x, atlasHeight.sub(int(1)).sub(fragment.y)).sub(origin);
  // The sums `steps` levels coarser than `level` over the texel, read top first as the GPU stores them.
  const read = (name: Output, steps: Node<"int">): Node<"vec4"> => {
    const texture = sheet.get(name);
    if (!texture) throw new Error(`bakeImpostor: no sheet output ${name}`);
    const texel = ivec2(local.x.shiftRight(steps), sheetHeight.shiftRight(steps).sub(int(1)).sub(local.y.shiftRight(steps)));
    return textureLoad(texture, texel).level(level.add(steps));
  };
  const coverage = read("base", int(0)).a;
  const covered = Fn(() => {
    const steps = int(0).toVar();
    // At most a frame's levels: 2^12 texels is more than a sheet holds.
    Loop(12, () => {
      If(steps.greaterThanEqual(frameSteps).or(read("base", steps).a.greaterThan(0)), () => {
        Break();
      });
      steps.addAssign(1);
    });
    return steps;
  })();
  const mean = (name: Output) => {
    const sums = read(name, covered);
    const weight = read("base", covered).a;
    const value = select(weight.greaterThan(0), sums.div(weight), vec4(0));
    return name === "base" ? vec4(value.rgb, coverage) : value;
  };
  let quad: QuadMesh | undefined;
  return {
    material(names: readonly Output[]): NodeMaterial {
      const made = new NodeMaterial();
      made.depthTest = made.depthWrite = false;
      made.mrtNode = mrt(Object.fromEntries(names.map((name) => [name, mean(name)])));
      return made;
    },
    into(into: RenderTarget, material: NodeMaterial, frames: SheetFrames, cell: number, from: number, width: number): void {
      level.value = from;
      frameSteps.value = Math.log2(cell);
      sheetHeight.value = width >> from;
      atlasHeight.value = into.height;
      origin.value.set(frames.col0 * cell, frames.row0 * cell);
      quad ??= new QuadMesh(material);
      quad.material = material;
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(into);
      // WebGPU counts viewport rows from the top.
      into.viewport.set(frames.col0 * cell, into.height - (frames.row0 + frames.rows) * cell, frames.cols * cell, frames.rows * cell);
      quad.render(renderer);
      renderer.setRenderTarget(previous);
    },
  };
}

/**
 * Clear `target`, with `zero` for its colours, and render each frame, its camera at `matrix`, into its `side` square at
 * (x, y), counted from the bottom left as the atlas is. The GPU makes the target's mips after the last frame (and the
 * first, which allocates them), not after each one.
 */
function renderSheet(
  renderer: Renderer,
  target: RenderTarget,
  zero: { quad: QuadMesh },
  scene: Scene,
  camera: OrthographicCamera,
  frames: Array<{ matrix: Matrix4; x: number; y: number }>,
  side: number,
): void {
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  try {
    renderer.clear(false, true, true);
    target.viewport.set(0, 0, target.width, target.height);
    zero.quad.render(renderer);
    frames.forEach(({ matrix, x, y }, i) => {
      for (const texture of target.textures) texture.generateMipmaps = i === 0 || i === frames.length - 1;
      // WebGPU counts viewport rows from the top.
      target.viewport.set(x, target.height - y - side, side, side);
      camera.matrix.copy(matrix);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
    });
  } finally {
    renderer.setRenderTarget(previous);
  }
}
