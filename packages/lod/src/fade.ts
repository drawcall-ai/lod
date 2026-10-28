import { Color, Matrix4, StorageBufferAttribute, StorageInstancedBufferAttribute, type Node, type Object3D } from "three/webgpu";
import {
  Fn,
  cameraProjectionMatrix,
  dot,
  float,
  fract,
  instanceIndex,
  modelWorldMatrix,
  screenCoordinate,
  screenSize,
  select,
  storage,
  uniform,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { isImpostorMesh, storageMatrices } from "./three.js";
import { column, instanceFades, instanceGroup, instanceMatrices, isOrthographic, maxScale } from "./tsl.js";

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
// A mesh no level draws is never too small to cast.
const objectDiameter = uniform(0).onObjectUpdate(({ object }) => {
  const draw = of(object);
  return draw?.kind === "object" ? draw.diameter : 3.4e38;
});
const instanceRadius = uniform(0).onObjectUpdate(({ object }) => {
  const draw = of(object);
  return draw?.kind === "instances" ? draw.radius : 0;
});

/** This draw's debug tint (see `Lod.debug`). */
export const tint = uniform(new Color(1, 1, 1)).onObjectUpdate(({ object }) => of(object)?.tint ?? WHITE);

/** Interleaved gradient noise over the pixels of the target being drawn. */
export const dither = (pixel: Node<"vec2">): Node<"float"> => fract(float(52.9829189).mul(fract(dot(pixel, vec2(0.06711056, 0.00583715)))));

const identity = new StorageInstancedBufferAttribute(new Float32Array(new Matrix4().elements), 16);
const cardMatrices = storage(identity, "mat4", 0)
  .setName("lodCardMatrices")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object }) => {
    if (!object || !isImpostorMesh(object)) throw new Error("ImpostorMesh: matrix draw has no impostor");
    return object.instanceMatrix;
  });
const zero = new StorageBufferAttribute(new Float32Array(1), 1);
const cardFades = storage(zero, "float", 0)
  .setName("lodCardFades")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object }) => {
    const draw = of(object);
    return draw?.kind === "instances" && draw.fades ? draw.fades : zero;
  });
const fadeIndex = uniform(0, "uint").onObjectUpdate(({ object }) => {
  const draw = of(object);
  return Number(draw?.kind === "instances" && draw.fades !== null);
});
const instanceCaster = uniform(false).onObjectUpdate(({ object }) => of(object)?.kind === "instances");

/** The instance matrix of this draw, for an InstancedMesh or ImpostorMesh with its matrices in a storage buffer; else null. */
export function instanceMatrixOf(object: Object3D): Node<"mat4"> | null {
  if (isImpostorMesh(object)) return cardMatrices.element(instanceIndex);
  const attribute = storageMatrices(object);
  return attribute && instanceMatrices(attribute).element(instanceIndex);
}

/** This draw's signed fade. */
export const fade = Fn((builder): Node<"float"> => {
  if (isImpostorMesh(builder.object))
    return varying(cardFades.element(instanceIndex.mul(fadeIndex)))
      .setInterpolation("flat")
      .add(objectFade);
  const draw = draws.get(builder.object);
  if (draw?.kind !== "instances" || !draw.fades) return objectFade;
  // Constant across the primitive: keep compute-written slots out of fragment bindings.
  return varying(instanceFades(draw.fades).element(instanceIndex)).setInterpolation("flat");
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
const tooSmallToCast = Fn((builder): Node<"bool"> => {
  const object = builder.object;
  const card = isImpostorMesh(object);
  const instance = card || draws.get(object)?.kind === "instances" ? instanceMatrixOf(object) : null;
  const instanced = instance ? maxScale(modelWorldMatrix.mul(instance)).mul(instanceRadius).mul(2) : objectDiameter;
  const diameter = card ? select(instanceCaster, instanced, objectDiameter) : instanced;
  // projection[1][1] is 2 × zoom / (top - bottom)
  const texel = float(2).div(column(cameraProjectionMatrix, 1).y.mul(screenSize.y));
  return isOrthographic(cameraProjectionMatrix).and(diameter.lessThan(texel));
});

/** `position` in shadow passes, or nothing (a point) when the draw is too small to cast. */
export const castPosition = (position: Node<"vec3">): Node<"vec3"> => select(tooSmallToCast(), vec3(0), position);
