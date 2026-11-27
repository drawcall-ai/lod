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
  positionWorld,
  select,
  varyingProperty,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { affine, column, isOrthographic } from "../../tsl.js";
import { PAD, type ImpostorLayout } from "../impostor.js";
import { basisNode, decodeNode, encodeNode } from "../octahedral.js";

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
  /** half the edge of every frame */
  halfSize: Node<"float">;
  /** frames per atlas side */
  frames: Node<"float">;
  /** where the card sits within an instance's space; identity except under a Lod */
  placement: Node<"mat4">;
}

// Each frame carries a ray in the bake camera's coordinates. Its atlas cell and blend
// weight share the fourth lanes to fit all three views in nine interpolators.
function view(i: number) {
  const origin = varyingProperty("vec4", `vImpostorOrigin${i}`);
  const ray = varyingProperty("vec4", `vImpostorRay${i}`);
  const normal = varyingProperty("vec4", `vImpostorNormal${i}`);
  return { origin, ray, normal, frame: vec2(origin.w, ray.w), weight: normal.w };
}
const views = [view(0), view(1), view(2)] as const;

export const card = {
  views,
  worldPoint: positionWorld,
  worldRay: select(isOrthographic(cameraProjectionMatrix), column(cameraWorldMatrix, 2).xyz.negate(), positionWorld.sub(cameraPosition)),
  toView(normal: Node<"vec3">): Node<"vec3"> {
    const [a, b, c] = views;
    return normalize(cameraViewMatrix.mul(vec4(a.normal.xyz.mul(normal.x).add(b.normal.xyz.mul(normal.y)).add(c.normal.xyz.mul(normal.z)), 0)).xyz);
  },
} as const;

export type Card = typeof card;

/**
 * The card's vertex, in the mesh's space (after the instance matrix), for the instance
 * placed by `instance`, `deform` (wind) applied in its space. Call it while the vertex
 * stage builds the position: it writes the varyings `card` reads.
 */
export function buildCard(inputs: CardInputs, instance: Node<"mat4">, deform: Node<"mat4"> | null): Node<"vec3"> {
  const { layout, centre, extent, halfSize, frames, placement } = inputs;
  const local = (deform ? instance.mul(deform) : instance).mul(placement).toVar();
  const model = modelWorldMatrix.mul(local).toVar();
  const toWorld = affine(model);
  const eye = toWorld.unproject(cameraPosition).toVar();
  // Orthographic, read off the projection: shadow passes of directional lights land
  // here too, and the card faces the light.
  const ortho = isOrthographic(cameraProjectionMatrix);
  const back = toWorld.solve(column(cameraWorldMatrix, 2).xyz);
  const toEye = eye.sub(centre);
  const distance = length(toEye);
  const toCamera = select(ortho, normalize(back), toEye.div(distance)).toVar();
  // Up close, perspective spreads the near side of the object past the ortho frame.
  const nearExtent = dot(toCamera.abs(), extent);
  const grow = select(ortho, float(1), min(distance.div(max(distance.sub(nearExtent), 1e-4)), 4));
  const { tangent, bitangent } = basisNode(toCamera);
  // The card covers the box as seen from here, plus the frame's empty border (the bake's
  // PAD) for the filtered edge, and no more than the frame: every pixel of it runs the
  // whole surface, and a square frame is mostly empty for a tall plant.
  const box = vec2(dot(tangent.abs(), extent), dot(bitangent.abs(), extent)).add(halfSize.mul(PAD));
  const size = min(box, vec2(halfSize, halfSize)).mul(grow.mul(2));
  const point = centre
    .add(tangent.mul(positionGeometry.x.mul(size.x)))
    .add(bitangent.mul(positionGeometry.y.mul(size.y)))
    .toVar();

  const last = frames.sub(1);
  // Clamped: rounding can put a horizon direction a hair outside the grid.
  const grid = clamp(encodeNode(layout, toCamera).mul(last), vec2(0, 0), vec2(last, last));
  const cell = min(floor(grid), vec2(last.sub(1), last.sub(1)));
  const f = grid.sub(cell);
  const ray = select(ortho, back.negate(), point.sub(eye));
  const offset = point.sub(centre);
  const middle = select(f.x.greaterThan(f.y), vec2(1, 0), vec2(0, 1));
  const projectFrame = (i: 0 | 1 | 2, frame: Node<"vec2">, weight: Node<"float">) => {
    const view = views[i];
    const n = decodeNode(layout, frame.div(last));
    const { tangent, bitangent } = basisNode(n);
    const project = (v: Node<"vec3">) => vec3(dot(v, tangent), dot(v, bitangent), dot(v, n));
    view.origin.assign(vec4(project(offset), frame.x));
    view.ray.assign(vec4(project(ray), frame.y));
    view.normal.assign(vec4(toWorld.normalColumns[i], weight));
  };
  projectFrame(0, cell, min(f.x.oneMinus(), f.y.oneMinus()));
  projectFrame(1, cell.add(middle), f.x.sub(f.y).abs());
  projectFrame(2, cell.add(1), min(f.x, f.y));
  return local.mul(vec4(point, 1)).xyz;
}
