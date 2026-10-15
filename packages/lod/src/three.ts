import type { BatchedMesh, Color, InstancedMesh, Material, Mesh, MeshStandardMaterial, Object3D, SkinnedMesh, Texture } from "three";
import type { InstancedLod } from "./instanced/index.js";
import type { ImpostorMesh } from "./impostor/mesh/index.js";

// Type guards on three's `isX` flags, which hold across copies of three (and of this
// package, as in .glts scripts) where `instanceof` does not, and small checks on objects.
const flag = (value: unknown, name: string) => typeof value === "object" && value !== null && Reflect.get(value, name) === true;

export const isObject3D = (value: unknown): value is Object3D => flag(value, "isObject3D");
export const isMesh = (node: Object3D): node is Mesh => flag(node, "isMesh");
export const isSkinnedMesh = (node: Object3D): node is SkinnedMesh => flag(node, "isSkinnedMesh");
export const isInstancedMesh = (node: Object3D): node is InstancedMesh => flag(node, "isInstancedMesh");
export const isBatchedMesh = (node: Object3D): node is BatchedMesh => flag(node, "isBatchedMesh");
export const isLight = (node: Object3D): boolean => flag(node, "isLight");
export const isImpostorMesh = (node: Object3D): node is ImpostorMesh => flag(node, "isImpostorMesh");
export const isInstancedLod = (node: Object3D): node is InstancedLod => flag(node, "isInstancedLod");
/** three's LOD and this package's Lod and InstancedLod. */
export const isLOD = (node: Object3D): node is Object3D & { isLOD: true; autoUpdate: boolean; readonly levels: ReadonlyArray<{ readonly object: Object3D }> } =>
  flag(node, "isLOD");
export const isStandard = (material: Material): material is MeshStandardMaterial => flag(material, "isMeshStandardMaterial");
export const isTexture = (value: unknown): value is Texture => flag(value, "isTexture");
export const isColor = (value: unknown): value is Color => flag(value, "isColor");

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
