import { Matrix4, Vector2, type Node, type Object3D } from "three/webgpu";
import { Fn, dot, length, mat4, max, modelWorldMatrix, normalLocal, sin, uniform, vec2, vec3, vec4 } from "three/tsl";
import { instanceMatrixOf } from "../fade.js";
import { affine, column } from "../tsl.js";

// The breeze in the shaders: an affine sway, fixed at a base height and growing linearly
// above it, along the world's breeze direction expressed in the root's horizontal plane.
// Every value is read per object while it renders (see `setSway`), so the materials of
// every swaying object share one compiled shader.

/** A Wind's state, which every object it sways reads. */
export interface Breeze {
  time: number;
  /** oscillations per second */
  speed: number;
  /** amplitude multiplier in [0, 1] */
  strength: number;
  /** horizontal world direction, unit */
  direction: Vector2;
}

/** How one mesh sways. */
export interface Sway {
  breeze: Breeze;
  /** sideways displacement per unit of height at full swing, and the base's height, in the root's space */
  shape: Vector2;
  /** the mesh's space (before any instance matrix) in the root's, and back */
  placement: Matrix4;
  fromRoot: Matrix4;
}

const sways = new WeakMap<Object3D, Sway>();

/** Sway `mesh` as `sway` says. */
export const setSway = (mesh: Object3D, sway: Sway): void => void sways.set(mesh, sway);

const identity = new Matrix4();
const still = new Vector2();
const of = (object: Object3D | null) => (object ? sways.get(object) : undefined);
const time = uniform(0).onObjectUpdate(({ object }) => of(object)?.breeze.time ?? 0);
const speed = uniform(0).onObjectUpdate(({ object }) => of(object)?.breeze.speed ?? 0);
const strength = uniform(0).onObjectUpdate(({ object }) => of(object)?.breeze.strength ?? 0);
const direction = uniform(new Vector2(1, 0)).onObjectUpdate(({ object }) => of(object)?.breeze.direction);
const shape = uniform(new Vector2()).onObjectUpdate(({ object }) => of(object)?.shape ?? still);
const placement = uniform(new Matrix4()).onObjectUpdate(({ object }) => of(object)?.placement ?? identity);
const fromRoot = uniform(new Matrix4()).onObjectUpdate(({ object }) => of(object)?.fromRoot ?? identity);

/** The sideways displacement per unit of height of a root placed in the world by `root`, in the root's space. */
function slopeAt(root: Node<"mat4">): Node<"vec3"> {
  const breeze = vec3(direction.x, 0, direction.y);
  // The world breeze in the root's horizontal plane, instance scale and shear included.
  const x = column(root, 0).xyz;
  const z = column(root, 2).xyz;
  const shear = dot(x, z);
  const along = vec2(dot(x, breeze), dot(z, breeze));
  const local = vec2(dot(z, z).mul(along.x).sub(shear.mul(along.y)), dot(x, x).mul(along.y).sub(shear.mul(along.x)));
  const unit = local.div(max(length(local), 1e-12));
  // The phase follows the root's place in the world, so instances sway out of step.
  const phase = dot(column(root, 3).xz, vec2(0.73, 0.51));
  const swing = sin(
    time
      .mul(speed)
      .mul(2 * Math.PI)
      .add(phase),
  );
  return vec3(unit.x, 0, unit.y).mul(shape.x.mul(strength).mul(swing));
}

/**
 * The sway in the mesh's own space (before `instance`): a point p moves by `slope` ×
 * (dot(axis, p) + base), its height above the base.
 */
function swayIn(instance: Node<"mat4"> | null) {
  const root = (instance ? modelWorldMatrix.mul(instance) : modelWorldMatrix).mul(fromRoot);
  return {
    slope: affine(fromRoot).apply(slopeAt(root)),
    axis: vec3(column(placement, 0).y, column(placement, 1).y, column(placement, 2).y),
    base: column(placement, 3).y.sub(shape.y),
  };
}

/**
 * `position` (a mesh's, after its instance matrix) swayed, and its normal with it. three
 * applies instance matrices first: the sway is carried into the instanced space.
 */
export const sway = (position: Node<"vec3">): Node<"vec3"> =>
  Fn((builder) => {
    const instance = instanceMatrixOf(builder.object);
    const { slope, axis, base } = swayIn(instance);
    // In the instanced space the height's gradient is the axis through the inverse
    // transpose, and the slope goes through the instance's linear part.
    const placed = instance && affine(instance);
    const gradient = placed ? placed.normal(axis) : axis;
    const along = placed ? placed.apply(slope) : slope;
    const origin = instance ? column(instance, 3).xyz : vec3(0, 0, 0);
    // First order, as the sway is small: normals turn by the shear's inverse transpose.
    normalLocal.assign(normalLocal.sub(gradient.mul(dot(along, normalLocal))));
    return position.add(along.mul(dot(gradient, position.sub(origin)).add(base)));
  })();

/** The sway as a matrix in the mesh's own space, for an ImpostorMesh's card (which inverts it). */
export const swayMatrix = Fn((builder) => {
  const { slope, axis, base } = swayIn(instanceMatrixOf(builder.object));
  const column = (unit: Node<"vec3">, height: Node<"float">) => vec4(unit.add(slope.mul(height)), 0);
  return mat4(column(vec3(1, 0, 0), axis.x), column(vec3(0, 1, 0), axis.y), column(vec3(0, 0, 1), axis.z), vec4(slope.mul(base), 1));
});
