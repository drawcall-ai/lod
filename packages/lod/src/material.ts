import type { Material, Node, NodeBuilder, NodeMaterial } from "three/webgpu";
import { Fn, output, positionLocal, vec4 } from "three/tsl";
import { castPosition, keepsPixel, tint } from "./fade.js";
import { toNodeMaterial } from "./three.js";
import { isNodeOf } from "./tsl.js";
import { sway } from "./wind/sway.js";

/** Copy → the material it copies. */
const originals = new WeakMap<Material, Material>();
/** Original → its copies, still and swaying. */
const copies = new WeakMap<Material, { still?: NodeMaterial; swaying?: NodeMaterial }>();

/** A slot the original set, as the type it builds to. */
function slot<T extends "bool" | "vec3" | "vec4">(node: Node, type: T, builder: NodeBuilder): Node<T> {
  if (!isNodeOf(node, type, builder)) throw new Error(`@drawcall/lod: a material's ${type} slot builds to ${node.getNodeType(builder)}`);
  return node;
}

/**
 * The copy of `material` (or of the material it copies) a level of a Lod or
 * InstancedLod draws with: it keeps only the pixels of its draw (see fade.ts), tints by
 * its level, casts nothing into shadow maps too coarse for it and, `swaying`, sways in
 * the wind of whatever object draws it (see Wind). Made once per original and kind, and
 * shared by every level drawing it: what differs per object is read while it renders.
 * Freed with the original.
 */
export function levelMaterial(material: Material, swaying = false): NodeMaterial {
  const original = originalOf(material);
  let known = copies.get(original);
  if (!known) copies.set(original, (known = {}));
  const kind = swaying ? "swaying" : "still";
  const existing = known[kind];
  if (existing) return existing;
  const copy = toNodeMaterial(original);
  const { maskNode, outputNode, positionNode, castShadowPositionNode } = copy;
  copy.maskNode = Fn((builder) => (maskNode ? slot(maskNode, "bool", builder).and(keepsPixel()) : keepsPixel()))();
  // The tint goes on what the material outputs: its colour slot is left as it is.
  copy.outputNode = Fn((builder) => (outputNode ? slot(outputNode, "vec4", builder) : output).mul(vec4(tint, 1)))();
  const position = (builder: NodeBuilder) => {
    const own = positionNode ? slot(positionNode, "vec3", builder) : positionLocal;
    return swaying ? sway(own) : own;
  };
  if (swaying || positionNode) copy.positionNode = Fn(position)();
  copy.castShadowPositionNode = Fn((builder) => castPosition(castShadowPositionNode ? slot(castShadowPositionNode, "vec3", builder) : position(builder)))();
  known[kind] = copy;
  originals.set(copy, original);
  original.addEventListener("dispose", () => copy.dispose());
  return copy;
}

/** The material a level copy was made from, or `material` itself. */
export const originalOf = (material: Material): Material => originals.get(material) ?? material;
