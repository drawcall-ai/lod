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
import { showDetail } from "../../bounds.js";
import { pause } from "../../pause.js";
import { borrow, readBytes } from "../../renderer.js";
import { linearToSrgb, srgbToLinear } from "../../source/texels.js";

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
 * box's centre, six square `size`-pixel views, with the exterior hidden and the other
 * rooms shown, seen through doorways: once in white ambient light and once in none. The difference is how the room
 * responds to light, which the baked material scales by the light reaching its windows;
 * what shows without light is the room's glow. Layer room × 6 + face of each result,
 * sRGB, rows bottom-up: (u, v) = (0.5, 0.5) + 0.5 × (x, y) / (z × span), with x, y and z
 * along the face's right, up and forward. Each view reaches a texel past its edges, so
 * filtering at a face's border reads the neighbouring face's content.
 */
export async function renderFaces(interior: Object3D, placement: Matrix4, boxes: readonly Box3[], size: number, renderer: Renderer): Promise<Faces> {
  const copy = interior.clone();
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
  const target = new RenderTarget(size, size, { type: UnsignedByteType, colorSpace: SRGBColorSpace, depthBuffer: true });
  const face = size * size * 4;
  const lit = new Uint8Array(face * 6 * boxes.length);
  const glow = new Uint8Array(face * 6 * boxes.length);
  const right = new Vector3();
  const back = new Vector3();
  const centre = new Vector3();
  const extent = new Vector3();
  const shoot = async (into: Uint8Array) => {
    const restore = borrow(renderer, target);
    try {
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
    } finally {
      restore();
    }
    into.set(await readBytes(renderer, target, 0));
  };
  // Far enough to see through doorways into any other room.
  const reach =
    boxes
      .reduce((all, box) => all.union(box), new Box3())
      .getSize(extent)
      .length() * 2;
  try {
    for (const [i, box] of boxes.entries()) {
      camera.near = box.getSize(extent).length() * 1e-3;
      camera.far = reach;
      camera.updateProjectionMatrix();
      box.getCenter(centre);
      for (const [f, [forward, up]] of FACES.entries()) {
        camera.matrix.makeBasis(right.crossVectors(forward, up), up, back.copy(forward).negate()).setPosition(centre);
        camera.updateMatrixWorld(true);
        const at = (i * 6 + f) * face;
        ambient.visible = true;
        await shoot(lit.subarray(at, at + face));
        ambient.visible = false;
        await shoot(glow.subarray(at, at + face));
      }
      await pause();
    }
  } finally {
    target.dispose();
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
