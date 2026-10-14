import type { BatchedMesh, InstancedMesh, Material, Mesh, MeshStandardMaterial, Object3D } from "three";

// Type guards on three's `isX` flags, which hold across copies of three where
// `instanceof` does not.
const flag = (value: object, name: string) => name in value && Reflect.get(value, name) === true;

export const isMesh = (node: Object3D): node is Mesh => flag(node, "isMesh");
export const isInstancedMesh = (node: Object3D): node is InstancedMesh => flag(node, "isInstancedMesh");
export const isBatchedMesh = (node: Object3D): node is BatchedMesh => flag(node, "isBatchedMesh");
export const isStandard = (material: Material): material is MeshStandardMaterial => flag(material, "isMeshStandardMaterial");
