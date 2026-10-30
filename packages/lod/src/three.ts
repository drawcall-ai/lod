import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  type Backend,
  type BatchedMesh,
  type Box3,
  type BufferAttribute,
  type Color,
  type InstancedMesh,
  type Loader,
  type Material,
  type Mesh,
  type MeshPhysicalMaterial,
  type MeshStandardMaterial,
  type Node,
  type NodeMaterial,
  type Object3D,
  type Renderer,
  type Scene,
  type SkinnedMesh,
  type StorageInstancedBufferAttribute,
  type Texture,
  type WebGPUBackend,
} from "three/webgpu";
import type { GLTSLoader, GLTSScene } from "@drawcall/glts";
import type { Instances } from "./instanced/meshes.js";
import type { InstancedLod } from "./instanced/index.js";
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
export const isGLTSScene = (node: Object3D): node is GLTSScene => isScene(node) && "source" in node && "dispose" in node && typeof node.dispose === "function";
/** A GLTSLoader, recognized by the bundled module provenance it publishes. */
export const isGLTSLoader = (loader: Loader): loader is GLTSLoader =>
  "moduleSources" in loader && typeof loader.moduleSources === "object" && loader.moduleSources !== null;
export const isImpostorMesh = (node: Object3D): node is ImpostorMesh => flag(node, "isImpostorMesh");
export const isLodInstances = (node: Object3D): node is Instances => flag(node, "isLodInstances");
export const isInstancedLod = (node: Object3D): node is InstancedLod => flag(node, "isInstancedLod");
/** three's LOD and this package's Lod and InstancedLod. */
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
 * A node material that renders like `material`: a clone when it is one, else the node
 * material of its type with its values, as three converts it for WebGPU itself.
 */
export function toNodeMaterial(material: Material): NodeMaterial {
  if (isNodeMaterial(material)) {
    const copy = material.clone();
    // three's NodeMaterial.copy skips accessors of Material itself, alphaTest among them.
    copy.alphaTest = material.alphaTest;
    return copy;
  }
  const Type = NODE_MATERIALS[material.type];
  if (!Type) throw new Error(`@drawcall/lod: ${material.type} has no node material to draw with WebGPU`);
  // Every own value but the source's identity and its event listeners.
  const values = Object.fromEntries(Object.entries(material).filter(([key]) => key !== "uuid" && key !== "_listeners"));
  return Object.assign(new Type(), values);
}
export const isTexture = (value: unknown): value is Texture => flag(value, "isTexture");
export const isColor = (value: unknown): value is Color => flag(value, "isColor");

/**
 * `renderer` as the WebGPU renderer it is: three's typings give render callbacks a
 * WebGLRenderer, which this package does not draw with.
 */
export function gpuRenderer(renderer: unknown): Renderer {
  if (!isRenderer(renderer)) throw new Error("@drawcall/lod: draws with three's WebGPURenderer only");
  return renderer;
}
const isRenderer = (value: unknown): value is Renderer => flag(value, "isRenderer");

/** The queue of `renderer`'s WebGPU device; throws until the backend has one. */
export function gpuQueue(renderer: Renderer): GPUQueueLike {
  const { backend } = renderer;
  // three's typings declare WebGPUBackend but not its device.
  const device = isWebGPUBackend(backend) && "device" in backend ? backend.device : undefined;
  if (!hasQueue(device)) throw new Error("@drawcall/lod: level preparation requires an initialized WebGPU device");
  return device.queue;
}
interface GPUQueueLike {
  onSubmittedWorkDone(): Promise<void>;
}
const hasQueue = (value: unknown): value is { queue: GPUQueueLike } =>
  typeof value === "object" &&
  value !== null &&
  "queue" in value &&
  typeof value.queue === "object" &&
  value.queue !== null &&
  "onSubmittedWorkDone" in value.queue &&
  typeof value.queue.onSubmittedWorkDone === "function";
const isWebGPUBackend = (backend: Backend): backend is WebGPUBackend => flag(backend, "isWebGPUBackend");

/**
 * Whether the scene `node` is in is being drawn into a shadow map: three's shadow pass
 * draws it with its own override material, and calls `update` on every LOD with the
 * light's camera, which must not switch the levels the view chose.
 */
export function inShadowPass(node: Object3D): boolean {
  let root = node;
  while (root.parent) root = root.parent;
  return "overrideMaterial" in root && isShadowPass(root.overrideMaterial);
}

/** Whether `material` is the one three draws shadow maps with (a node material building for a shadow pass has it). */
export const isShadowPass = (material: unknown): boolean => flag(material, "isShadowPassMaterial");

/** The storage matrices of a level draw, an ImpostorMesh, or a storage-backed InstancedMesh; else null. */
export function storageMatrices(object: Object3D): StorageInstancedBufferAttribute | null {
  if (isImpostorMesh(object) || isLodInstances(object)) return object.instanceMatrix;
  return isInstancedMesh(object) && isStorageInstanced(object.instanceMatrix) ? object.instanceMatrix : null;
}

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
