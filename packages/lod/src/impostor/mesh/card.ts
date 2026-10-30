import type { Node } from "three/webgpu";
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  dot,
  float,
  floor,
  length,
  max,
  min,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  select,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { affine, column, isOrthographic } from "../../tsl.js";
import type { ImpostorLayout } from "../impostor.js";
import { basisNode, encodeNode } from "../octahedral.js";

// The impostor's card: a quad built in the vertex stage facing the camera (or the light,
// in shadow passes), in the object's own space. three's model, view and projection
// transforms then apply as to any mesh, which keeps fog, clipping and logarithmic depth
// working, and makes non-uniform scale exact: an affine map preserves a parallel
// projection. Every pass builds its own card from its own camera.

/** What every card of one impostor reads. */
export interface CardInputs {
  layout: ImpostorLayout;
  /** bounding box centre and half its edges, in the object's space */
  centre: Node<"vec3">;
  extent: Node<"vec3">;
  /** bounding sphere radius: the depth channel's unit */
  radius: Node<"float">;
  /** half the edge of every frame's view */
  halfSize: Node<"float">;
  /** frames per atlas side */
  frames: Node<"float">;
  /** where the card sits within an instance's space; identity except under InstancedLod */
  placement: Node<"mat4">;
}

// What the surface reads of the card, interpolated across it: varyings the vertex stage
// writes (see `buildCard`). They are named once, so every stage and context that reads
// them shares them, whichever stage three builds first.
const written = {
  /** the first frame, and which neighbour (1: along x) the second is */
  frames: varyingProperty("vec3", "vImpostorFrames"),
  weights: varyingProperty("vec3", "vImpostorWeights"),
  point: varyingProperty("vec3", "vImpostorPoint"),
  ray: varyingProperty("vec3", "vImpostorRay"),
  worldPoint: varyingProperty("vec3", "vImpostorWorldPoint"),
  worldRay: varyingProperty("vec3", "vImpostorWorldRay"),
  normals: [varyingProperty("vec3", "vImpostorNormal0"), varyingProperty("vec3", "vImpostorNormal1"), varyingProperty("vec3", "vImpostorNormal2")] as const,
};

const first = written.frames.xy;
const neighbour = written.frames.z;

/** The card as the surface reads it. */
export const card = {
  /** the three frames around the view direction and their barycentric weights */
  frames: [first, first.add(vec2(neighbour, neighbour.oneMinus())), first.add(1)],
  weights: written.weights,
  /** the view ray through the fragment, in the object's space: from `point`, along `ray` */
  point: written.point,
  ray: written.ray,
  /** the same ray in world space: `ray` × s in object space is `worldRay` × s in the world */
  worldPoint: written.worldPoint,
  worldRay: written.worldRay,
  /** an object-space normal in view space, as three's normal matrix turns a mesh's */
  toView(normal: Node<"vec3">): Node<"vec3"> {
    const [n0, n1, n2] = written.normals;
    return normalize(cameraViewMatrix.mul(vec4(n0.mul(normal.x).add(n1.mul(normal.y)).add(n2.mul(normal.z)), 0)).xyz);
  },
} as const;

export type Card = typeof card;

/**
 * The card's vertex, in the mesh's space (after the instance matrix), for the instance
 * placed by `instance`, `deform` (wind) applied in its space. Call it while the vertex
 * stage builds the position: it writes the varyings `card` reads.
 */
export function buildCard(inputs: CardInputs, instance: Node<"mat4">, deform: Node<"mat4"> | null): Node<"vec3"> {
  const { layout, centre, extent, radius, halfSize, frames, placement } = inputs;
  const local = (deform ? instance.mul(deform) : instance).mul(placement).toVar();
  const model = modelWorldMatrix.mul(local).toVar();
  const toWorld = affine(model);
  const eye = toWorld.unproject(cameraPosition).toVar();
  // Orthographic, read off the projection: shadow passes of directional lights land
  // here too, and the card faces the light.
  const ortho = isOrthographic(cameraProjectionMatrix);
  const back = column(cameraWorldMatrix, 2).xyz;
  const toEye = eye.sub(centre);
  const distance = length(toEye);
  const view = select(ortho, normalize(toWorld.solve(back)), toEye.div(distance)).toVar();
  // Up close, perspective spreads the near side of the object past the ortho frame.
  const grow = select(ortho, float(1), min(distance.div(max(distance.sub(radius), 1e-4)), 4));
  const { tangent, bitangent } = basisNode(view);
  // The card covers the box as seen from here, plus the frame's empty border (the bake's
  // PAD) for the filtered edge, and no more than the frame: every pixel of it runs the
  // whole surface, and a square frame is mostly empty for a tall plant.
  const box = vec2(dot(tangent.abs(), extent), dot(bitangent.abs(), extent)).add(halfSize.mul(0.06));
  const size = min(box, vec2(halfSize, halfSize)).mul(grow.mul(2));
  const point = centre
    .add(tangent.mul(positionGeometry.x.mul(size.x)))
    .add(bitangent.mul(positionGeometry.y.mul(size.y)))
    .toVar();

  const last = frames.sub(1);
  // Clamped: rounding can put a horizon view a hair outside the grid.
  const grid = clamp(encodeNode(layout, view).mul(last), vec2(0, 0), vec2(last, last));
  const cell = min(floor(grid), vec2(last.sub(1), last.sub(1)));
  const f = grid.sub(cell);
  const ray = select(ortho, view.negate(), point.sub(eye));

  // Every vertex of a card holds the same frames and weights, so they interpolate to themselves.
  written.frames.assign(vec3(cell, select(f.x.greaterThan(f.y), float(1), float(0))));
  written.weights.assign(vec3(min(f.x.oneMinus(), f.y.oneMinus()), f.x.sub(f.y).abs(), min(f.x, f.y)));
  written.point.assign(point);
  written.ray.assign(ray);
  written.worldPoint.assign(model.mul(vec4(point, 1)).xyz);
  written.worldRay.assign(toWorld.apply(ray));
  toWorld.normalColumns.forEach((n, i) => written.normals[i]?.assign(n));
  return local.mul(vec4(point, 1)).xyz;
}
