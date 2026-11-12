import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  type BatchedMesh,
  type Box3,
  type BufferAttribute,
  type Color,
  type CompressedTexture,
  type InstancedMesh,
  type Material,
  type Matrix4,
  type Mesh,
  type MeshPhysicalMaterial,
  type MeshStandardMaterial,
  type Node,
  type NodeMaterial,
  type Object3D,
  type Renderer,
  type Scene,
  type SkinnedMesh,
  type StorageBufferAttribute,
  type StorageInstancedBufferAttribute,
  type Texture,
} from "three/webgpu";
import type { GLTSScene } from "@drawcall/glts";
import type { Lod } from "./lod.js";
import type { ImpostorMesh } from "./impostor/mesh/index.js";

// Type guards on three's `isX` flags, which hold across copies of three (and of this
// package, as in .glts scripts) where `instanceof` does not, and small checks on objects.
const flag = (value: unknown, name: string) => typeof value === "object" && value !== null && Reflect.get(value, name) === true;

export const isObject3D = (value: unknown): value is Object3D => flag(value, "isObject3D");
export const isNode = (value: unknown): value is Node => flag(value, "isNode");
export const isMesh = (node: Object3D): node is Mesh => flag(node, "isMesh");
export const isSkinnedMesh = (node: Object3D): node is SkinnedMesh => flag(node, "isSkinnedMesh");
export const isInstancedMesh = (node: Object3D): node is InstancedMesh => flag(node, "isInstancedMesh");
export const isBatchedMesh = (node: Object3D): node is BatchedMesh => flag(node, "isBatchedMesh");
export const isLight = (node: Object3D): boolean => flag(node, "isLight");
export const isScene = (node: Object3D): node is Scene => flag(node, "isScene");
export const isLine = (node: Object3D): boolean => flag(node, "isLine");
export const isPoints = (node: Object3D): boolean => flag(node, "isPoints");
export const isSprite = (node: Object3D): boolean => flag(node, "isSprite");
/** A scene a GLTSLoader loaded: its loader gives it a dispose of its own, which a clone, a plain Scene, lacks. */
export const isGLTSScene = (node: Object3D): node is GLTSScene => isScene(node) && "source" in node && Object.hasOwn(node, "dispose");
export const isImpostorMesh = (node: Object3D): node is ImpostorMesh => flag(node, "isImpostorMesh");
export const isLod = (node: Object3D): node is Lod => flag(node, "isLod");
/** three's LOD and this package's Lod. */
export const isLOD = (
  node: Object3D,
): node is Object3D & { isLOD: true; autoUpdate: boolean; readonly levels: ReadonlyArray<{ readonly object?: Object3D; readonly box?: Box3 }> } =>
  flag(node, "isLOD");
export const isStandard = (material: Material): material is MeshStandardMaterial => flag(material, "isMeshStandardMaterial");
export const isPhysical = (material: Material): material is MeshPhysicalMaterial => flag(material, "isMeshPhysicalMaterial");
export const isNodeMaterial = (material: Material): material is NodeMaterial => flag(material, "isNodeMaterial");
export const isStandardNode = (material: Material): material is MeshStandardNodeMaterial => flag(material, "isMeshStandardNodeMaterial");
export const isStorageInstanced = (attribute: BufferAttribute): attribute is StorageInstancedBufferAttribute =>
  flag(attribute, "isStorageInstancedBufferAttribute");
export const isStorageBuffer = (value: unknown): value is StorageBufferAttribute => flag(value, "isStorageBufferAttribute");

/** The node material each built-in mesh material draws as with WebGPU. */
const NODE_MATERIALS: Record<string, new () => NodeMaterial> = {
  MeshBasicMaterial: MeshBasicNodeMaterial,
  MeshLambertMaterial: MeshLambertNodeMaterial,
  MeshPhongMaterial: MeshPhongNodeMaterial,
  MeshStandardMaterial: MeshStandardNodeMaterial,
  MeshPhysicalMaterial: MeshPhysicalNodeMaterial,
  MeshToonMaterial: MeshToonNodeMaterial,
  MeshMatcapMaterial: MeshMatcapNodeMaterial,
  MeshNormalMaterial: MeshNormalNodeMaterial,
};

/**
 * A node material that renders like `material`: a clone when it is one, else the node material of its type with its
 * values, as three converts it for WebGPU itself. NodeMaterial.copy skips accessors of Material itself, alphaTest among
 * them.
 */
export function toNodeMaterial(material: Material): NodeMaterial {
  const copy = isNodeMaterial(material) ? material.clone() : new (nodeMaterialOf(material))().copy(material);
  copy.alphaTest = material.alphaTest;
  return copy;
}

function nodeMaterialOf(material: Material): new () => NodeMaterial {
  const Type = NODE_MATERIALS[material.type];
  if (!Type) throw new Error(`@drawcall/lod: ${material.type} has no node material to draw with WebGPU`);
  return Type;
}
export const isBox3 = (value: unknown): value is Box3 => flag(value, "isBox3");
export const isTexture = (value: unknown): value is Texture => flag(value, "isTexture");
export const isCompressedTexture = (value: unknown): value is CompressedTexture => flag(value, "isCompressedTexture");
export const isColor = (value: unknown): value is Color => flag(value, "isColor");

export const isRenderer = (value: unknown): value is Renderer => flag(value, "isRenderer");

/** The root of the tree `node` is in: its scene, once added to one. */
export function rootOf(node: Object3D): Object3D {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

/** Whether `material` is the one three draws shadow maps with (a node material building for a shadow pass has it). */
export const isShadowPass = (material: unknown): boolean => flag(material, "isShadowPassMaterial");

/** Whether `value` is of exactly `like`'s class: a guard for clone() overrides. */
export const sameClass = <T extends object>(like: T, value: object): value is T => Object.getPrototypeOf(value) === Object.getPrototypeOf(like);

/** Throws if anything under `root` is skinned; `who` names the caller in the message. */
export function rejectSkinned(root: Object3D, who: string): void {
  root.traverse((node) => {
    if (isSkinnedMesh(node)) throw new Error(`${who}: skinned meshes are not supported ("${node.name}")`);
  });
}

/** Give `level` the transform of `source`, and its shadows: cast or receive if any mesh of it does. */
export function placeLike(level: Object3D, source: Object3D): void {
  level.position.copy(source.position);
  level.quaternion.copy(source.quaternion);
  level.scale.copy(source.scale);
  source.traverse((node) => {
    if (!isMesh(node)) return;
    level.castShadow ||= node.castShadow;
    level.receiveShadow ||= node.receiveShadow;
  });
}

/** Upper bound on the largest singular value, exact for orthogonal matrix axes. */
export function stretch(matrix: Matrix4): number {
  const e = matrix.elements;
  const xy = Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]);
  const xz = Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]);
  const yz = Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]);
  return Math.sqrt(
    Math.max(e[0] ** 2 + e[1] ** 2 + e[2] ** 2 + xy + xz, e[4] ** 2 + e[5] ** 2 + e[6] ** 2 + xy + yz, e[8] ** 2 + e[9] ** 2 + e[10] ** 2 + xz + yz),
  );
}
