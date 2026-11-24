import {
  AmbientLight,
  Box3,
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MathUtils,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  RenderTarget,
  UnsignedByteType,
  Vector3,
  type Matrix4,
  type Object3D,
  type Renderer,
} from "three/webgpu";
import { bakeCopy, readBytes } from "../../bake.js";
import { showDetail } from "../../source/detail.js";
import { nextTask } from "../../task.js";
import { linearToSrgb, srgbToLinear } from "../mips.js";

/**
 * The six faces of a room's cube, in layer order: the direction each looks and its up.
 * Its right is forward × up. The baked material's shader (material.ts) reads this table.
 */
export const FACES: ReadonlyArray<readonly [forward: Vector3, up: Vector3]> = [
  [new Vector3(1, 0, 0), new Vector3(0, 1, 0)],
  [new Vector3(-1, 0, 0), new Vector3(0, 1, 0)],
  [new Vector3(0, 1, 0), new Vector3(0, 0, -1)],
  [new Vector3(0, -1, 0), new Vector3(0, 0, 1)],
  [new Vector3(0, 0, 1), new Vector3(0, 1, 0)],
  [new Vector3(0, 0, -1), new Vector3(0, 1, 0)],
];

/** What each room shows, per cube face: see `renderFaces`. */
export interface Faces {
  /** the light each room reflects under white ambient light of irradiance π: its colours */
  response: DataArrayTexture;
  /** the light each room gives off itself (emissive and unlit materials); null when none does */
  glow: DataArrayTexture | null;
  /** how far each face's view reaches past its edges: tan of half its field of view */
  span: number;
}

/**
 * Render each room of `interior` (placed in the source's space by `placement`) from its
 * box's centre, six square `size`-pixel images, with the exterior hidden and the other
 * rooms shown, seen through doorways: once in white ambient light and once in none. The difference is how the room
 * responds to light, which the baked material scales by the light reaching its windows;
 * what shows without light is the room's glow. Layer room × 6 + face of each result,
 * sRGB, rows bottom-up: (u, v) = (0.5, 0.5) + 0.5 × (x, y) / (z × span), with x, y and z
 * along the face's right, up and forward. Each image reaches a texel past its edges, so
 * filtering at a face's border reads the neighbouring face's content. `renderer` is set
 * up for bakes (see `checkBakeRenderer`).
 */
export async function renderFaces(interior: Object3D, placement: Matrix4, boxes: readonly Box3[], size: number, renderer: Renderer): Promise<Faces> {
  const baked = await bakeCopy(interior);
  const copy = baked.root;
  copy.matrixAutoUpdate = false;
  copy.matrix.copy(placement);
  copy.visible = true;
  showDetail(copy);
  // At π, three's Lambert (albedo / π) shows a surface in its own colour.
  const ambient = new AmbientLight(0xffffff, Math.PI);
  const scene = new Scene().add(copy, ambient);
  scene.updateMatrixWorld(true);
  const span = 1 + 2 / size;
  const camera = new PerspectiveCamera(MathUtils.radToDeg(2 * Math.atan(span)), 1);
  camera.matrixAutoUpdate = false;
  camera.layers.enableAll();
  // Every image side by side, read back at once: a row of six faces lit, then a row of them in no light, per room.
  const target = new RenderTarget(size * 6, size * 2 * boxes.length, { type: UnsignedByteType, colorSpace: SRGBColorSpace, depthBuffer: true });
  const right = new Vector3();
  const back = new Vector3();
  const centre = new Vector3();
  const extent = new Vector3();
  /** Render the image of face `f` in row `row`, counted from the bottom; the images' squares and depths never meet. */
  const shoot = (f: number, row: number) => {
    // WebGPU counts viewport rows from the top.
    target.viewport.set(f * size, target.height - (row + 1) * size, size, size);
    renderer.render(scene, camera);
  };
  // Far enough to see through doorways into any other room.
  const reach =
    boxes
      .reduce((all, box) => all.union(box), new Box3())
      .getSize(extent)
      .length() * 2;
  const previous = renderer.getRenderTarget();
  let read: Uint8Array;
  try {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    // Every image lit, then every one in no light: switching the light changes the scene's lights, which costs every
    // material drawn after the switch a rebuild of its lighting.
    for (const lit of [true, false]) {
      ambient.visible = lit;
      for (const [i, box] of boxes.entries()) {
        camera.near = box.getSize(extent).length() * 1e-3;
        camera.far = reach;
        camera.updateProjectionMatrix();
        box.getCenter(centre);
        for (const [f, [forward, up]] of FACES.entries()) {
          camera.matrix.makeBasis(right.crossVectors(forward, up), up, back.copy(forward).negate()).setPosition(centre);
          camera.updateMatrixWorld(true);
          shoot(f, i * 2 + (lit ? 0 : 1));
        }
        // Yield to the page between rooms, so that a long bake does not freeze it.
        await nextTask();
      }
    }
    read = await readBytes(renderer, target, 0);
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    baked.dispose();
  }
  // Each image as a layer of its own, rows bottom first, as `read` is.
  const face = size * size * 4;
  const lit = new Uint8Array(face * 6 * boxes.length);
  const glow = new Uint8Array(face * 6 * boxes.length);
  const row = size * 6 * 4;
  for (let i = 0; i < boxes.length; i++)
    for (let f = 0; f < 6; f++)
      for (let y = 0; y < size; y++)
        for (const [into, image] of [
          [lit, i * 2],
          [glow, i * 2 + 1],
        ] as const) {
          const from = (image * size + y) * row + f * size * 4;
          into.set(read.subarray(from, from + size * 4), (i * 6 + f) * face + y * size * 4);
        }
  // Light adds up in linear values: response = lit - glow.
  for (let i = 0; i < lit.length; i++) {
    if (i % 4 === 3) continue;
    lit[i] = linearToSrgb(Math.max(0, (SRGB_TO_LINEAR[lit[i] ?? 0] ?? 0) - (SRGB_TO_LINEAR[glow[i] ?? 0] ?? 0))) * 255 + 0.5;
  }
  return { response: layers(lit, size, boxes.length), glow: glow.some((v, i) => i % 4 !== 3 && v > 0) ? layers(glow, size, boxes.length) : null, span };
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

function layers(data: Uint8Array, size: number, rooms: number): DataArrayTexture {
  const texture = new DataArrayTexture(data, size, size, rooms * 6);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
