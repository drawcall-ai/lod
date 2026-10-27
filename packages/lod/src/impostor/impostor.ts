/** Which part of the view sphere the atlas covers. */
export type ImpostorLayout = "hemi" | "full";

/**
 * The atlas maps, in the order they are stored. Each is one RGBA8 layer:
 *
 * - `base`: base colour (sRGB) in RGB, coverage in A.
 * - `normalDepth`: an object-space normal n in RGB (`n * 0.5 + 0.5`), depth in A. The
 *   surface shades with n on the share of it in orm.a and with -n on the rest; the
 *   length of n is how far the normals it averages agree (1: all one way).
 * - `orm`: occlusion, roughness, metalness in RGB (glTF / three order), and in A the
 *   share of the surface that shades with n.
 * - `emissive`: emissive colour (sRGB) in RGB, A unused. Only when something emits.
 */
export const MAPS = ["base", "normalDepth", "orm", "emissive"] as const;
export type ImpostorMap = (typeof MAPS)[number];

/**
 * A baked octahedral impostor: plain data, no GPU resources.
 *
 * The atlas is `frames x frames` cells of `size / frames` pixels each. Cell (col, row)
 * holds the view from `frameDirection(layout, frames, col, row)` and starts at pixel
 * `(col * cell, row * cell)`; row 0 is the first row in memory, which is the bottom row
 * of the texture (three's DataTexture convention).
 *
 * Depth is `0.5 + 0.5 * dot(p - centre, viewDirection) / boundingRadius(box)`, so 1 is
 * toward the camera that baked the frame and 0 is away from it.
 */
export interface Impostor {
  version: 3;
  layout: ImpostorLayout;
  /** frames per atlas side */
  frames: number;
  /** atlas edge in pixels: `frames` times a power of two */
  size: number;
  /** bounding box of the source in its own space: min xyz, max xyz */
  box: [number, number, number, number, number, number];
  /** half the edge of every frame's orthographic view, in source units, centred on the box centre */
  halfSize: number;
  /** `base`, `normalDepth`, `orm`, then `emissive` if it was baked */
  maps: ImpostorMap[];
  /**
   * The dielectric specular three lights the surface with, F0 (linear RGB) then F90,
   * averaged over the whole object as the frames show it. Only when a material changes
   * it from three's 0.04 and 1 (a MeshPhysicalMaterial's ior, specularIntensity,
   * specularColor or their maps).
   */
  specular?: [number, number, number, number];
  /**
   * One per entry in `maps`: its mip chain of RGBA8 arrays, `size >> level` square, from
   * `size` down to one texel per frame (`frames` square). The levels are baked, not
   * filtered from level 0. An ImpostorMesh's textures share these arrays, so they stay in
   * memory while the impostor is referenced, ready for `encodeImpostor`.
   */
  layers: Uint8Array[][];
}

export function boxCentre(b: Impostor["box"]): [number, number, number] {
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

/** Half the box's edges. */
export function boxExtent(b: Impostor["box"]): [number, number, number] {
  return [(b[3] - b[0]) / 2, (b[4] - b[1]) / 2, (b[5] - b[2]) / 2];
}

/** Radius of the sphere around the box: the depth channel's unit. */
export function boundingRadius(b: Impostor["box"]): number {
  return Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
}

/**
 * On-screen height of the object at which two atlas texels span one pixel: the default
 * `LodLevel.maxPixels` of an impostor. An impostor blends filtered reads of several
 * views, so it keeps the source's colour detail only down to about two texels per pixel.
 */
export function texelPixels(impostor: Pick<Impostor, "size" | "frames" | "box" | "halfSize">): number {
  const cell = impostor.size / impostor.frames;
  // A frame spans 2 × halfSize of the object; the height measured is its bounding diameter.
  return (cell * boundingRadius(impostor.box)) / (2 * impostor.halfSize);
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBox = (v: unknown): v is Impostor["box"] => Array.isArray(v) && v.length === 6 && v.every(isNumber);

/** Throws unless `value` is a usable impostor. */
export function validateImpostor(value: unknown): asserts value is Impostor {
  function fail(why: string): never {
    throw new Error(`Invalid impostor: ${why}`);
  }
  if (typeof value !== "object" || value === null) fail("not an object");
  const fields: Partial<Record<keyof Impostor, unknown>> = value;
  const { version, layout, frames, size, box, halfSize, maps, specular, layers } = fields;
  if (version !== 3) fail(`unsupported version ${String(version)}; bake it again`);
  if (layout !== "hemi" && layout !== "full") fail(`unknown layout "${String(layout)}"`);
  if (!isNumber(frames) || !Number.isInteger(frames) || frames < 2) fail("frames must be an integer >= 2");
  if (!isNumber(size) || !Number.isInteger(size) || size <= 0 || size % frames !== 0)
    fail(`size ${String(size)} is not a positive multiple of frames ${frames}`);
  if (!isBox(box)) fail("box must be 6 finite numbers");
  if (box[0] > box[3] || box[1] > box[4] || box[2] > box[5]) fail("box min must not exceed max");
  if (!isNumber(halfSize) || halfSize <= 0) fail("halfSize must be a positive number");
  if (!Array.isArray(maps) || maps.length < 3 || !maps.every((map, i) => map === MAPS[i]))
    fail(`maps must be base, normalDepth, orm, optionally followed by emissive; got ${String(maps)}`);
  if (specular !== undefined && !(Array.isArray(specular) && specular.length === 4 && specular.every((v) => isNumber(v) && v >= 0 && v <= 1)))
    fail("specular must be 4 numbers in [0, 1]");
  if (!Array.isArray(layers) || layers.length !== maps.length) fail("one layer per map");
  const cell = size / frames;
  if (!Number.isInteger(Math.log2(cell))) fail(`frame size ${cell} is not a power of two`);
  const levels = Math.log2(cell) + 1;
  for (const layer of layers) {
    if (!Array.isArray(layer) || layer.length !== levels) fail(`every layer must be a mip chain of ${levels} levels`);
    layer.forEach((level: unknown, m) => {
      const bytes = (size >> m) ** 2 * 4;
      if (!(level instanceof Uint8Array) || level.length !== bytes) fail(`mip level ${m} must be a Uint8Array of ${bytes} bytes`);
    });
  }
}
