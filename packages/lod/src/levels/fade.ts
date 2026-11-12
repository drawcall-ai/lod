import {
  type Camera,
  Color,
  type IndirectStorageBufferAttribute,
  Matrix4,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
  type Node,
  type NodeBuilder,
  type Object3D,
} from "three/webgpu";
import {
  Fn,
  NodeUpdateType,
  bool,
  cameraProjectionMatrix,
  dot,
  float,
  fract,
  instanceIndex,
  modelWorldMatrix,
  normalLocal,
  positionLocal,
  transformNormal,
  varyingProperty,
  screenCoordinate,
  screenSize,
  select,
  storage,
  uniform,
  uniformGroup,
  varying,
  vec2,
  vec3,
} from "three/tsl";
import { isImpostorMesh, isInstancedMesh, isStorageInstanced } from "../three.js";
import { column, isOrthographic, maxScale } from "../tsl.js";

// The dithered fade between neighbouring levels of one object.
//
// Each draw of a level (a mesh, or one instance of it) has a signed fade f: f >= 0 keeps
// the pixels whose dither is at least f, f < 0 those below -f, and f = 0 draws whole. In
// a fade of progress t in (0, 1) the coarser level draws with t and the finer with -t,
// so every pixel is drawn by exactly one of them. Shadow maps fade the same way, in
// their own pixels: a fading object casts one shadow, a dithered mix of both levels'.
//
// Each level mesh of a Lod draws a list of slots, which the instance pass fills for each camera with the index of the
// instance a slot draws and its fade (see `FadeSource`). Materials read them per object while it renders, so the copies
// of one material every level draws with share one compiled shader (see material.ts).

/**
 * For one camera, the instances a Lod's level meshes draw: per slot, the instance and its signed fade, and where the
 * camera's indirect draws of them lie, `DRAW_BYTES` apart in the order of the Lod's meshes.
 */
export interface InstanceSlots {
  /** the index of the instance each slot draws */
  readonly indices: StorageBufferAttribute;
  /** its signed fade */
  readonly fades: StorageBufferAttribute;
  /** Where the camera's indirect draws of the Lod's meshes start (see rows.ts). */
  readonly args: { readonly offset: number; readonly attribute: IndirectStorageBufferAttribute };
}

/** What a Lod's level meshes draw their instances from: every instance's matrix, and its colour (RGB and a pad). */
export interface DrawnInstances {
  matrices: StorageInstancedBufferAttribute;
  colors: StorageInstancedBufferAttribute;
}

/** How a mesh drawing instances is drawn: where its fade and shadow size come from. */
export interface FadeSource {
  /** per camera, the instance and signed fade of each slot; null for none (an ImpostorMesh of its own, drawing every instance) */
  slots: ((camera: Camera) => InstanceSlots | null) | null;
  /** one instance's bounding radius in its own space */
  radius: number;
  /** debug tint, white when off */
  tint: Color;
  /**
   * For a plain mesh of a Lod's level: the instances it draws, and `space`, where its geometry's space sits in the
   * source's (a Lod draws template geometry moved into the instance's space). An ImpostorMesh carries its own instances.
   */
  level?: { readonly instances: DrawnInstances; readonly space: Matrix4 };
}

/**
 * Per level mesh, where its fade comes from: a side table, as three's Object3D has no typed place for a package's state
 * (userData is the app's).
 */
const sources = new WeakMap<Object3D, FadeSource>();

/** Draw `mesh` as `source` says: its materials read it while it renders. */
export const setFadeSource = (mesh: Object3D, source: FadeSource): void => void sources.set(mesh, source);
export const fadeSourceOf = (mesh: Object3D): FadeSource | undefined => sources.get(mesh);

const WHITE = new Color(1, 1, 1);
const of = (object: Object3D | null) => (object ? sources.get(object) : undefined);

// Per-object values, shared by every material: each draw reads its own.
const instanceRadius = uniform(0).onObjectUpdate(({ object }) => of(object)?.radius ?? 0);

/** This draw's debug tint (see `Lod.debug`). */
export const tint = uniform(new Color(1, 1, 1)).onObjectUpdate(({ object }) => of(object)?.tint ?? WHITE);

/** Interleaved gradient noise over the pixels of the target being drawn. */
export const dither = (pixel: Node<"vec2">): Node<"float"> => fract(float(52.9829189).mul(fract(dot(pixel, vec2(0.06711056, 0.00583715)))));

/** The level mesh `object` is, when it is a Lod's plain one. */
const levelOf = (object: Object3D | null) => of(object)?.level ?? null;

/** The instances where `object` reads its matrices and colours from storage: its own, or its Lod's; else null. */
function instancesOf(object: Object3D): { matrices: StorageInstancedBufferAttribute; colors: StorageInstancedBufferAttribute | null } | null {
  if (isImpostorMesh(object)) return { matrices: object.instanceMatrix, colors: object.instanceColor };
  const level = levelOf(object);
  if (level) return level.instances;
  return isInstancedMesh(object) && isStorageInstanced(object.instanceMatrix) ? { matrices: object.instanceMatrix, colors: null } : null;
}

/** Where `object`'s geometry space sits in its source's: moved for a Lod's plain level mesh (see `FadeSource`). */
export const spaceOf = (object: Object3D | null): Matrix4 | null => levelOf(object)?.space ?? null;

// The draw buffers below are replaced per object, so they stay out of three's texture-keyed
// binding caches: each render object has its own bindings of this group, while its shader
// reads the shared nodes.
const instanceGroup = uniformGroup("lodInstances", 2, NodeUpdateType.OBJECT);

const identity = new StorageInstancedBufferAttribute(new Float32Array(new Matrix4().elements), 16);
const matrices = storage(identity, "mat4", 0)
  .setName("lodInstanceMatrices")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object }) => {
    const instances = object && instancesOf(object);
    if (!instances) throw new Error("Lod: instance draw has no matrices");
    return instances.matrices;
  });
/** `object`'s slots as `camera` draws it, when it draws slots. */
function slotsOf(object: Object3D | null, camera: Camera | null) {
  const draw = of(object);
  return draw?.slots && camera ? draw.slots(camera) : null;
}
const zero = new StorageBufferAttribute(new Float32Array(1), 1);
const fades = storage(zero, "float", 0)
  .setName("lodInstanceFades")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object, camera }) => slotsOf(object, camera)?.fades ?? zero);
const none = new StorageBufferAttribute(new Uint32Array(1), 1);
const indices = storage(none, "uint", 0)
  .setName("lodInstanceSlots")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object, camera }) => slotsOf(object, camera)?.indices ?? none);
/** 1 when the draw's instances are slots the instance pass for each camera fills, else 0. */
const slotted = uniform(0, "uint").onObjectUpdate(({ object }) => Number(!!of(object)?.slots));

/** The instance this draw's instance index stands for: the one in its slot, or itself. */
const instance = Fn(() => slotted.equal(1).select(indices.element(instanceIndex), instanceIndex));

/** This draw's instance matrix when its matrices live in storage, else null. */
export function instanceMatrixOf(object: Object3D): Node<"mat4"> | null {
  return instancesOf(object) ? matrices.element(instance()) : null;
}

/** The colour of a draw whose instances have none: given one from the start, a draw's shader stays the same once they do. */
export const white = new StorageInstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4);
const colors = storage(white, "vec4", 0)
  .setName("lodInstanceColors")
  .setGroup(instanceGroup)
  .toReadOnly()
  .onObjectUpdate(({ object }) => (object && instancesOf(object)?.colors) || white);
const colorIndex = uniform(0, "uint").onObjectUpdate(({ object }) => {
  const colors = object && instancesOf(object)?.colors;
  return Number(!!colors && colors !== white);
});

export const instanceColor = varying(colors.element(instance().mul(colorIndex)).xyz).setInterpolation("flat");

/** Apply the level's shared instance bindings before its own deformation, as Three does for InstancedMesh. */
export function placeInstances(builder: NodeBuilder): void {
  if (!levelOf(builder.object)) return;
  const matrix = matrices.element(instance());
  positionLocal.assign(matrix.mul(positionLocal).xyz);
  if (builder.geometry.hasAttribute("normal")) normalLocal.assign(transformNormal(normalLocal, matrix));
  varyingProperty("vec3", "vInstanceColor").assign(instanceColor);
}

/** This draw's signed fade. */
export const fade = Fn((builder): Node<"float"> => {
  if (isImpostorMesh(builder.object)) return varying(fades.element(instanceIndex.mul(slotted))).setInterpolation("flat");
  if (!sources.get(builder.object)?.slots) return float(0);
  // Constant across the primitive: keep compute-written slots out of fragment bindings.
  return varying(fades.element(instanceIndex)).setInterpolation("flat");
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
 * chance, flickering as it or the map moves. Only valid in a shadow map render.
 */
const tooSmallToCast = Fn((builder): Node<"bool"> => {
  const { object } = builder;
  const instance = sources.has(object) ? instanceMatrixOf(object) : null;
  // A mesh drawing no instances of a Lod's or an ImpostorMesh's is never too small to cast.
  if (!instance) return bool(false);
  const diameter = maxScale(modelWorldMatrix.mul(instance)).mul(instanceRadius).mul(2);
  // projection[1][1] is 2 × zoom / (top - bottom)
  const texel = float(2).div(column(cameraProjectionMatrix, 1).y.mul(screenSize.y));
  return isOrthographic(cameraProjectionMatrix).and(diameter.lessThan(texel));
});

/** `position` in a shadow map render, or nothing (a point) when the draw is too small to cast. */
export const castPosition = (position: Node<"vec3">): Node<"vec3"> => select(tooSmallToCast(), vec3(0), position);
