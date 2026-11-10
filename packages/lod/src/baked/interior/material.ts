import {
  InterpolationSamplingType,
  Matrix4,
  MeshStandardNodeMaterial,
  PhysicalLightingModel,
  StorageBufferAttribute,
  type Box3,
  type DataTexture,
  type Node,
  type NodeBuilder,
  type Object3D,
  type StorageBufferNode,
  type Texture,
  type Vector3,
} from "three/webgpu";
import {
  If,
  cameraPosition,
  cameraProjectionMatrix,
  cameraWorldMatrix,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  int,
  ivec2,
  length,
  log2,
  mat4,
  materialEnvIntensity,
  max,
  min,
  modelWorldMatrix,
  normalize,
  pmremTexture,
  positionGeometry,
  positionWorld,
  select,
  sign,
  step,
  storage,
  texture,
  textureLoad,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { instanceMatrixOf, spaceOf } from "../../levels/fade.js";
import { isScene, rootOf } from "../../three.js";
import { affine, column, contextNode, isNodeOf, isOrthographic } from "../../tsl.js";
import { FACES, type Faces } from "./faces.js";

// Interior mapping (Andrew Willmott's interior cubemaps): a window texel looks into the
// box of the room behind it. The view ray, in the source's space, leaves that box at a
// wall point; the room's cube, rendered from the box's centre, holds what the room shows
// there. Furniture flattens onto the walls; the walls themselves are exact.

/** What a baked material needs to look into its rooms. */
export interface Rooms extends Faces {
  boxes: readonly Box3[];
  /**
   * per baked texel: R the room of the nearest window + 1, read texel by texel; G the share
   * of the room that shows, filtered
   */
  windows: DataTexture;
}

const identity = new Matrix4();
/** Where the drawn mesh's geometry space sits in the source's: moved where an InstancedLod draws it (see `spaceOf`). */
const space = uniform(new Matrix4()).onObjectUpdate(({ object }) => spaceOf(object) ?? identity);

function flat<T>(node: Node<T>): Node<T> {
  return varying(node).setInterpolation(InterpolationSamplingType.FLAT);
}

/** `vectors[index]`, for an index known only in the shader. */
function pick(vectors: readonly Vector3[], index: Node<"int">): Node<"vec3"> {
  return vectors.reduceRight<Node<"vec3">>((rest, v, i) => select(index.equal(i), vec3(v.x, v.y, v.z), rest), vec3(0, 0, 0));
}

/**
 * A baked level's material that shows `rooms` through its windows. The rooms' textures
 * go with it.
 */
export class InteriorMappingMaterial extends MeshStandardNodeMaterial {
  readonly isInteriorMaterial = true;
  rooms: Rooms | null = null;
  /**
   * Each room's box, its min then its max, as the shader reads them: one node per set of rooms, named so that the
   * shaders of every building with as many rooms share one program.
   */
  private bounds: StorageBufferNode<"vec4"> | null = null;

  /** Show `rooms` through the windows. */
  furnish(rooms: Rooms): this {
    const boxes = new StorageBufferAttribute(Float32Array.from(rooms.boxes.flatMap((box) => [...box.min.toArray(), 0, ...box.max.toArray(), 0])), 4);
    this.rooms = rooms;
    this.bounds = storage(boxes, "vec4", 0).setName("lodRoomBounds");
    this.addEventListener("dispose", () => {
      rooms.response.dispose();
      rooms.glow?.dispose();
      rooms.windows.dispose();
      boxes.dispose();
    });
    return this;
  }

  override setupLightingModel(): PhysicalLightingModel {
    return this.rooms && this.bounds ? new InteriorLightingModel(this.rooms, this.bounds) : super.setupLightingModel();
  }

  override copy(source: InteriorMappingMaterial): this {
    super.copy(source);
    this.rooms = source.rooms;
    this.bounds = source.bounds;
    return this;
  }
}

/**
 * The room is lit by indirect light only: the sun's direct light, which walls and roof
 * would block, is left out. Ambient light, light probes and hemisphere lights are taken at
 * the window; the environment, as three lights the real room's walls, at the wall the
 * view ray meets. Its glow adds on top. Glass shows the room by its share, under its own
 * reflection: three's specular term carries the Fresnel.
 */
class InteriorLightingModel extends PhysicalLightingModel {
  constructor(
    private readonly rooms: Rooms,
    /** see `InteriorMappingMaterial.bounds` */
    private readonly boxes: StorageBufferNode<"vec4">,
  ) {
    super();
  }

  // After three's lights and before it sums them: by `finish` the sum is made.
  override start(builder: NodeBuilder): void {
    super.start(builder);
    const { rooms } = this;
    const irradiance = contextNode(builder, "irradiance");
    const directDiffuse = contextNode(builder, "reflectedLight", "directDiffuse");
    const indirectDiffuse = contextNode(builder, "reflectedLight", "indirectDiffuse");
    if (!isNodeOf(irradiance, "vec3", builder) || !isNodeOf(directDiffuse, "vec3", builder) || !isNodeOf(indirectDiffuse, "vec3", builder))
      throw new Error("bakeMesh: three's lighting is not made of vec3s");
    const count = rooms.boxes.length;
    const { boxes } = this;
    const faceSize = rooms.response.image.width;
    const [width, height] = [rooms.windows.image.width, rooms.windows.image.height];

    // The view ray in the source's space, and the source's space to world.
    const instance = instanceMatrixOf(builder.object);
    const toWorld = affine((instance ? modelWorldMatrix.mul(instance) : modelWorldMatrix).mul(affineInverse(space)));
    const back = column(cameraWorldMatrix, 2).xyz;
    const worldRay = select(isOrthographic(cameraProjectionMatrix), back.negate(), positionWorld.sub(cameraPosition));
    const point = varying(space.mul(vec4(positionGeometry, 1)).xyz);
    const ray = varying(toWorld.solve(worldRay));
    const [x, y, z] = toWorld.normalColumns.map(flat);
    if (!x || !y || !z) throw new Error("bakeMesh: a normal matrix has three columns");

    const share = texture(rooms.windows, uv()).g;
    const texel = ivec2(clamp(uv().mul(vec2(width, height)), vec2(0, 0), vec2(width - 1, height - 1)));
    // The room's number, 0 for none, as a float: the box's index is clamped to a room.
    const room = float(textureLoad(rooms.windows, texel).r.mul(255).add(0.5).floor()).toVar();
    const box = int(clamp(room.sub(1), 0, count - 1)).toVar();
    const low = boxes.element(box.mul(2)).xyz;
    const high = boxes.element(box.mul(2).add(1)).xyz;
    const unit = normalize(ray);
    // Nudged off zero, so each axis has a crossing.
    const direction = unit
      .add(
        vec3(1, 1, 1)
          .sub(step(vec3(1e-30, 1e-30, 1e-30), unit.abs()))
          .mul(1e-6),
      )
      .toVar();
    const far = low.sub(point).div(direction).max(high.sub(point).div(direction)).toVar();
    // The box is intersected for every texel, and the derivatives that pick the cube's mip level are taken here, before
    // the branch: inside it, at a window's edge, they would read neighbours that skipped it, which differ run to run.
    const exit = point.add(direction.mul(max(min(far.x, min(far.y, far.z)), 0))).toVar();
    const footprint = max(length(dFdx(exit)), length(dFdy(exit))).toVar();

    If(room.greaterThan(0).and(share.greaterThan(0)), () => {
      const wall = exit.sub(low.add(high).mul(0.5));
      const a = wall.abs();
      const face = select(
        a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z)),
        select(wall.x.greaterThanEqual(0), int(0), int(1)),
        select(a.y.greaterThanEqual(a.z), select(wall.y.greaterThanEqual(0), int(2), int(3)), select(wall.z.greaterThanEqual(0), int(4), int(5))),
      ).toVar();
      const forward = pick(
        FACES.map(([f]) => f),
        face,
      );
      const up = pick(
        FACES.map(([, u]) => u),
        face,
      );
      const depth = max(dot(wall, forward), 1e-6).mul(rooms.span);
      const at = vec2(dot(wall, cross(forward, up)), dot(wall, up))
        .div(depth)
        .mul(0.5)
        .add(0.5);
      const layer = box.mul(6).add(face);
      const level = log2(max(footprint.mul(0.5 * faceSize).div(depth), 1e-6));
      const inward = select(
        far.x.lessThanEqual(min(far.y, far.z)),
        vec3(sign(direction.x).negate(), 0, 0),
        select(far.y.lessThanEqual(far.z), vec3(0, sign(direction.y).negate(), 0), vec3(0, 0, sign(direction.z).negate())),
      );
      const wallNormal = normalize(x.mul(inward.x).add(y.mul(inward.y)).add(z.mul(inward.z)));
      const environment = environmentOf(builder.object);
      const ibl = environment ? pmremTexture(environment, wallNormal, float(1)).rgb.mul(Math.PI).mul(materialEnvIntensity) : vec3(0, 0, 0);
      const light = irradiance.add(ibl);
      let shown = texture(rooms.response, at).depth(layer).level(level).rgb.mul(light).div(Math.PI);
      if (rooms.glow) shown = shown.add(texture(rooms.glow, at).depth(layer).level(level).rgb);
      // What the glass shows of its own, where the room does not show.
      const rest = share.oneMinus();
      directDiffuse.assign(directDiffuse.mul(rest));
      indirectDiffuse.assign(indirectDiffuse.mul(rest).add(shown.mul(share)));
    });
  }
}

/** The environment of the scene `object` is in, if any. */
function environmentOf(object: Object3D): Texture | null {
  const root = rootOf(object);
  return isScene(root) ? root.environment : null;
}

/** The inverse of an affine `m`, as a matrix: the linear part's inverse and the translation undone. */
function affineInverse(m: Node<"mat4">): Node<"mat4"> {
  const inverse = affine(m);
  const solve = (v: Node<"vec3">) => vec4(inverse.solve(v), 0);
  return mat4(solve(vec3(1, 0, 0)), solve(vec3(0, 1, 0)), solve(vec3(0, 0, 1)), vec4(inverse.unproject(vec3(0, 0, 0)), 1));
}
