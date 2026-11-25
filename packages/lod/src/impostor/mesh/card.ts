import type { Node, Texture } from "three/webgpu";
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cameraWorldMatrix,
  clamp,
  dot,
  ivec2,
  mix,
  textureLoad,
  viewportSize,
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
import { PAD, RECT_PIXELS, type ImpostorLayout } from "../impostor.js";
import { basisNode, encodeNode } from "../octahedral.js";

// The impostor's card: a quad built in the vertex stage facing the camera (or the light,
// in shadow passes), in the object's own space. three's model, view and projection
// transforms then apply as to any mesh, which keeps fog, clipping and logarithmic depth
// working, and makes non-uniform scale exact: an affine map preserves a parallel
// projection. Every pass builds its own card from its own camera.

/** What every card of one impostor reads. */
export interface CardInputs {
  mipBias: Node<"float">;
  layout: ImpostorLayout;
  /** bounding box centre and half its edges, in the object's space */
  centre: Node<"vec3">;
  extent: Node<"vec3">;
  /** half the edge of every frame */
  halfSize: Node<"float">;
  /** frames per atlas side */
  frames: Node<"float">;
  /** where the card sits within an instance's space; identity except under a Lod */
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
  /** the three frames around the direction to the camera and their barycentric weights */
  frames: [first, first.add(vec2(neighbour, neighbour.oneMinus())), first.add(1)],
  weights: written.weights,
  /** the camera's ray through the fragment, in the object's space: from `point`, along `ray` */
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
export function buildCard(inputs: CardInputs, instance: Node<"mat4">, deform: Node<"mat4"> | null, rects: Texture | null): Node<"vec3"> {
  const { layout, centre, extent, halfSize, frames, placement } = inputs;
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
  const toCamera = select(ortho, normalize(toWorld.solve(back)), toEye.div(distance)).toVar();
  // Up close, perspective spreads the near side of the object past the ortho frame.
  const nearExtent = dot(toCamera.abs(), extent);
  const grow = select(ortho, float(1), min(distance.div(max(distance.sub(nearExtent), 1e-4)), 4));
  const { tangent, bitangent } = basisNode(toCamera);
  // The card covers the box as seen from here, plus the frame's empty border (the bake's
  // PAD) for the filtered edge, and no more than the frame: every pixel of it runs the
  // whole surface, and a square frame is mostly empty for a tall plant.
  const box = vec2(dot(tangent.abs(), extent), dot(bitangent.abs(), extent)).add(halfSize.mul(PAD));
  const half = min(box, vec2(halfSize)).mul(grow);
  const corner = positionGeometry.xy.mul(2);
  const last = frames.sub(1);
  // Clamped: rounding can put a horizon direction a hair outside the grid.
  const grid = clamp(encodeNode(layout, toCamera).mul(last), vec2(0, 0), vec2(last, last));
  const cell = min(floor(grid), vec2(last.sub(1), last.sub(1)));
  const f = grid.sub(cell);
  let offset = corner.mul(half);
  if (rects) {
    const rect = textureLoad(rects, ivec2(cell));
    const edge = mix(rect.xy, rect.zw, positionGeometry.xy.add(0.5)).mul(corner);
    // The projected full card axes, in viewport pixels at its centre. Their altitudes give the
    // distance between opposite edges even when a non-uniformly scaled instance skews the card.
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(model);
    const c = clip.mul(vec4(centre, 1));
    const axis = (v: Node<"vec3">) => {
      const d = clip.mul(vec4(v, 0));
      return d.xy.sub(c.xy.mul(d.w.div(c.w))).mul(viewportSize.div(c.w));
    };
    const x = axis(tangent.mul(half.x));
    const y = axis(bitangent.mul(half.y));
    const lengths = vec2(x.length(), y.length());
    const area = x.x.mul(y.y).sub(x.y.mul(y.x)).abs();
    // The atlas uses the coarser of its two gradients for both axes. A squashed card can
    // therefore filter across several screen pixels along its longer axis.
    const footprint = max(half.x.mul(lengths.y), half.y.mul(lengths.x)).mul(2).div(max(area, 1e-6));
    const pixel = footprint.div(half);
    // Leave a pixel for filtered edges. Return to full coverage as perspective spreads the
    // silhouette or a reference pixel is magnified enough to reveal finer details.
    const near = select(ortho, float(0), halfSize.mul(Math.SQRT2).div(distance));
    const zoom = max(lengths.x, lengths.y).div(RECT_PIXELS);
    const fitted = min(vec2(1), edge.add(pixel).add(near.mul(2)));
    const safeEdge = mix(fitted, vec2(1), clamp(zoom.sub(1), 0, 1));
    let use = near.lessThan(0.25).and(inputs.mipBias.equal(-0.5));
    if (layout === "hemi") use = use.and(toCamera.y.greaterThanEqual(0));
    offset = select(use, corner.mul(half).mul(safeEdge), offset);
  }
  const point = centre.add(tangent.mul(offset.x)).add(bitangent.mul(offset.y)).toVar();
  const ray = select(ortho, toCamera.negate(), point.sub(eye));

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
