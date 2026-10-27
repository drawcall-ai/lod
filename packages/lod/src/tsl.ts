import type { BufferAttribute, ContextNode, Node, NodeBuilder, StorageBufferNode, TextureNode } from "three/webgpu";
import { context, cross, dFdx, dFdy, dot, length, log2, max, storage, uniform, uv, vec2, vec3, vec4 } from "three/tsl";

// Matrix access for the shaders, in operations three's typings know: they type no
// columns, inverses or transposes of matrix nodes. A product with a unit vector picks a
// column out and compiles to the same read; an affine inverse is cofactors and a dot.

/** Column `i` (0..3) of `m`. */
export const column = (m: Node<"mat4">, i: 0 | 1 | 2 | 3): Node<"vec4"> => m.mul(vec4(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0, i === 3 ? 1 : 0));

/** The largest scale `m` applies along an axis. */
export const maxScale = (m: Node<"mat4">): Node<"float"> => max(column(m, 0).xyz.length(), max(column(m, 1).xyz.length(), column(m, 2).xyz.length()));

/** Whether projection `m` is orthographic: its bottom-right element is 1. */
export const isOrthographic = (m: Node<"mat4">): Node<"bool"> => column(m, 3).w.equal(1);

/** An affine matrix `m` and the inverse of its linear part, as cofactor columns over the determinant. */
export interface Affine {
  /** `m`'s linear part applied to direction `v` */
  apply(v: Node<"vec3">): Node<"vec3">;
  /** the inverse of the linear part applied to direction `v` */
  solve(v: Node<"vec3">): Node<"vec3">;
  /** point `p` through the inverse of `m`: into the space `m` maps from */
  unproject(p: Node<"vec3">): Node<"vec3">;
  /** the inverse transpose applied to `v`: how normals transform */
  normal(v: Node<"vec3">): Node<"vec3">;
  /** the columns of the inverse transpose */
  normalColumns: [Node<"vec3">, Node<"vec3">, Node<"vec3">];
}

export function affine(m: Node<"mat4">): Affine {
  const a0 = column(m, 0).xyz.toVar();
  const a1 = column(m, 1).xyz.toVar();
  const a2 = column(m, 2).xyz.toVar();
  const det = dot(a0, cross(a1, a2)).toVar();
  const c0 = cross(a1, a2).div(det).toVar();
  const c1 = cross(a2, a0).div(det).toVar();
  const c2 = cross(a0, a1).div(det).toVar();
  const solve = (v: Node<"vec3">) => vec3(dot(c0, v), dot(c1, v), dot(c2, v));
  return {
    apply: (v) => a0.mul(v.x).add(a1.mul(v.y)).add(a2.mul(v.z)),
    solve,
    unproject: (p) => solve(p.sub(column(m, 3).xyz)),
    normal: (v) => c0.mul(v.x).add(c1.mul(v.y)).add(c2.mul(v.z)),
    normalColumns: [c0, c1, c2],
  };
}

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && Reflect.get(value, "isNode") === true;

/** The node at `path` in the context `builder` builds with, which three's typings leave open. */
export function contextNode(builder: NodeBuilder, ...path: string[]): Node {
  const value = path.reduce<unknown>((at, key) => (typeof at === "object" && at !== null ? Reflect.get(at, key) : undefined), builder.context);
  if (!isNode(value)) throw new Error(`@drawcall/lod: the shader's context has no ${path.join(".")}`);
  return value;
}

/**
 * An object that stays the same throughout one build of a shader, to cache per build
 * what several of a material's slots read. Each slot is handed its own proxy of the
 * builder, and three's typings expose no handle of the build itself: this is what the
 * build keeps for `anchor`.
 */
export function buildKey(builder: NodeBuilder, anchor: Node): object {
  const properties: unknown = Reflect.apply(Reflect.get(builder, "getNodeProperties"), builder, [anchor]);
  if (typeof properties !== "object" || properties === null) throw new Error("@drawcall/lod: three's node builder keeps no properties");
  return properties;
}

/**
 * Whether `node` builds to a `type` value, which three's typings leave open for a
 * material's slots. Checked while a shader builds, so a slot of another type fails there.
 */
export function isNodeOf<T extends "bool" | "float" | "vec3" | "vec4" | "color">(node: Node, type: T, builder: NodeBuilder): node is Node<T> {
  return node.getNodeType(builder) === type;
}

/** One storage node per buffer, for buffers read as `type`: each node is a binding of its own, and a stage has few (8 storage buffers by default). */
function storageCache<T extends "float" | "vec4" | "mat4">(type: T): (attribute: BufferAttribute) => StorageBufferNode<T> {
  const nodes = new WeakMap<BufferAttribute, StorageBufferNode<T>>();
  return (attribute) => {
    let node = nodes.get(attribute);
    if (!node) nodes.set(attribute, (node = storage(attribute, type, attribute.count)));
    return node;
  };
}

/** `attribute`'s storage node, read as floats, vec4s or mat4s. */
export const floats = storageCache("float");
export const vectors = storageCache("vec4");
export const matrices = storageCache("mat4");

/** The size in texels of a texture's image, or null when it has none to read. */
function texelsOf(image: unknown): [number, number] | null {
  if (typeof image !== "object" || image === null || !("width" in image) || !("height" in image)) return null;
  const { width, height } = image;
  return typeof width === "number" && typeof height === "number" ? [width, height] : null;
}

/**
 * A context in which every texture read is `bias` mip levels above the level the
 * hardware would pick: the level from the read's own texel footprint, plus `bias`. Reads
 * with uv of their own making, or with an explicit level or gradients, keep theirs.
 */
export function biasedTextures(bias: Node<"float">): ContextNode<unknown> {
  return context({
    getTextureLevel: (node: TextureNode) => {
      const texture = node.value;
      const size = texelsOf(texture.image);
      if (node.uvNode || !size) return null;
      // The texture's offset, repeat and rotation, as three applies them.
      const at = uniform(texture.matrix).mul(vec3(uv(texture.channel), 1)).xy;
      const texels = at.mul(vec2(size[0], size[1]));
      return log2(max(max(length(dFdx(texels)), length(dFdy(texels))), 1e-6)).add(bias);
    },
  });
}
