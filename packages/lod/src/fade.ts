import { Color, Matrix4, type Node, type Object3D, type StorageBufferAttribute } from "three/webgpu";
import { Fn, cameraProjectionMatrix, dot, float, fract, instanceIndex, modelWorldMatrix, screenCoordinate, screenSize, select, uniform, vec2, vec3 } from "three/tsl";
import { isImpostorMesh, storageMatrices } from "./three.js";
import { column, floats, isOrthographic, matrices, maxScale } from "./tsl.js";

// The dithered fade between neighbouring levels of one object.
//
// Each draw of a level (a mesh, or one instance of it) has a signed fade f: f >= 0 keeps
// the pixels whose dither is at least f, f < 0 those below -f, and f = 0 draws whole. In
// a fade of progress t in (0, 1) the coarser level draws with t and the finer with -t,
// so every pixel is drawn by exactly one of them. Shadow maps fade the same way, in
// their own pixels: a fading object casts one shadow, a dithered mix of both levels'.
//
// Where the fade comes from depends on how the level is drawn (see `Draw`): one value
// per mesh for a Lod, set by the CPU; one per instance for an InstancedLod, written by
// its selection pass. Materials read it per object while it renders, so the copies of
// one material every level draws with share one compiled shader (see material.ts).

/** How a mesh of a level is drawn, which says where its fade and shadow size come from. */
export type Draw =
  | {
      kind: "object";
      /** the signed fade */
      fade: number;
      /** the whole object's bounding diameter, world units */
      diameter: number;
      /** debug tint, white when off */
      tint: Color;
    }
  | {
      kind: "instances";
      /** one signed fade per instance slot; null for none (an ImpostorMesh of its own) */
      fades: StorageBufferAttribute | null;
      /** one instance's bounding radius in its own space */
      radius: number;
      tint: Color;
    };

const draws = new WeakMap<Object3D, Draw>();

/** Draw `mesh` as `draw` says: its materials read it while it renders. */
export const setDraw = (mesh: Object3D, draw: Draw): void => void draws.set(mesh, draw);
export const drawOf = (mesh: Object3D): Draw | undefined => draws.get(mesh);

const WHITE = new Color(1, 1, 1);
const of = (object: Object3D | null) => (object ? draws.get(object) : undefined);

// Per-object values, shared by every material: each draw reads its own.
const objectFade = uniform(0).onObjectUpdate(({ object }) => {
  const draw = of(object);
  return draw?.kind === "object" ? draw.fade : 0;
});
const placement = new Matrix4();
// A mesh no level draws is never too small to cast. An ImpostorMesh of one instance
// reads its own here too, however it is drawn: such meshes share one shader.
const objectDiameter = uniform(0).onObjectUpdate(({ object }) => {
  const draw = of(object);
  if (draw?.kind === "object") return draw.diameter;
  if (draw?.kind !== "instances" || !object || !isImpostorMesh(object) || !isSingle(object)) return 3.4e38;
  return 2 * draw.radius * placement.fromArray(object.instanceMatrix.array).premultiply(object.matrixWorld).getMaxScaleOnAxis();
});
const instanceRadius = uniform(0).onObjectUpdate(({ object }) => {
  const draw = of(object);
  return draw?.kind === "instances" ? draw.radius : 0;
});

/** This draw's debug tint (see `Lod.debug`). */
export const tint = uniform(new Color(1, 1, 1)).onObjectUpdate(({ object }) => of(object)?.tint ?? WHITE);

/** Interleaved gradient noise over the pixels of the target being drawn. */
export const dither = (pixel: Node<"vec2">): Node<"float"> => fract(float(52.9829189).mul(fract(dot(pixel, vec2(0.06711056, 0.00583715)))));

/** The matrix of an ImpostorMesh of one instance, read per object: such meshes share one shader. */
const singleMatrix = uniform(new Matrix4()).onObjectUpdate(({ object }, self) => (object && isImpostorMesh(object) ? self.value.fromArray(object.instanceMatrix.array) : undefined));

/**
 * Whether `object` is an ImpostorMesh of one instance, which reads it per object: more,
 * or slots the GPU writes (an InstancedLod's indirect draws), come from its storage buffer.
 */
export const isSingle = (object: Object3D): boolean => isImpostorMesh(object) && object.count === 1 && object.geometry.getIndirect() === null;

/** The instance matrix of this draw, for an InstancedMesh or ImpostorMesh with its matrices in a storage buffer; else null. */
export function instanceMatrixOf(object: Object3D): Node<"mat4"> | null {
  if (isSingle(object)) return singleMatrix;
  const attribute = storageMatrices(object);
  return attribute && matrices(attribute).element(instanceIndex);
}

/** This draw's signed fade. */
export const fade = Fn((builder): Node<"float"> => {
  const draw = draws.get(builder.object);
  if (draw?.kind !== "instances" || !draw.fades) return objectFade;
  return floats(draw.fades).element(instanceIndex);
});

/** Whether this pixel is this draw's, by its fade: false on the other level's pixels. */
export const keepsPixel = Fn((): Node<"bool"> => {
  const f = fade();
  const d = dither(screenCoordinate.xy);
  return select(f.greaterThanEqual(0), d.greaterThanEqual(f), d.lessThan(f.negate()));
});

/**
 * Whether this draw is too small for the shadow map being drawn: narrower than a texel
 * of an orthographic (directional light's) map, it would cover a texel centre only by
 * chance, flickering as it or the map moves. Only valid in shadow passes.
 */
export const tooSmallToCast = Fn((builder): Node<"bool"> => {
  const object = builder.object;
  const instance = draws.get(object)?.kind === "instances" && !isSingle(object) ? instanceMatrixOf(object) : null;
  const diameter = instance ? maxScale(modelWorldMatrix.mul(instance)).mul(instanceRadius).mul(2) : objectDiameter;
  // projection[1][1] is 2 × zoom / (top - bottom)
  const texel = float(2).div(column(cameraProjectionMatrix, 1).y.mul(screenSize.y));
  return isOrthographic(cameraProjectionMatrix).and(diameter.lessThan(texel));
});

/** `position` in shadow passes, or nothing (a point) when the draw is too small to cast. */
export const castPosition = (position: Node<"vec3">): Node<"vec3"> => select(tooSmallToCast(), vec3(0), position);
