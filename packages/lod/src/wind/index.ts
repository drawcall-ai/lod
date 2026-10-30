import { Box3, Matrix4, ObjectSpaceNormalMap, Vector2, type Mesh, type Object3D } from "three/webgpu";
import { boundingBox, levelBox } from "../bounds.js";
import { levelMaterial } from "../material.js";
import { isBatchedMesh, isImpostorMesh, isInstancedLod, isInstancedMesh, isLOD, isMesh, isSkinnedMesh, isStorageInstanced } from "../three.js";
import { WIND_BOUNDS, type WindBounds } from "./hooks.js";
import { windBounds } from "./bounds.js";
import { setSway, swayMatrix, type Breeze } from "./sway.js";

export interface WindOptions {
  /** Horizontal world-space X/Z direction; normalized on assignment. Default [1, 0]. */
  direction?: readonly [number, number];
  /** Oscillations per second; default 0.25. */
  speed?: number;
}

export interface SwayOptions {
  /** Maximum sideways displacement at baseY + height, in the root's units. */
  amplitude: number;
  /** Fixed base in the root's space; defaults to the source's lowest point. */
  baseY?: number;
  /** Height above the fixed base; defaults to the source's top minus baseY. */
  height?: number;
}

const bindings = new WeakMap<Object3D, { wind: Wind; options: SwayOptions; refresh: (added: Object3D) => void }>();
const attached = new WeakSet<Mesh>();
const identity = new Matrix4();
// Every wind's values are read per object. Sharing this node keeps attachments from
// invalidating the same material when another region starts drawing its impostor.
const impostorSway = swayMatrix();

/**
 * A shared GPU breeze: an affine sway, fixed at the base and linear with height.
 * Bake/build levels first, apply once to the completed Lod, InstancedLod, mesh or
 * mesh group, then set time once before rendering each frame. All levels and shadow
 * passes share the motion. Simplified and baked meshes need no special preparation.
 *
 * Instances derive their phase from the undeformed root's world position, so slot
 * sorting never changes it. The breeze follows the root's horizontal plane; upright
 * trees with different rotations still follow the same world direction.
 *
 * Bounds cover strength 0..1. Geometry, instance matrices and LOD lists are not updated
 * by the clock. CPU raycasts still hit the rest pose. Mesh placements within a root
 * must stay fixed after applying; move/rotate/scale the root or its instances instead.
 * Nested LODs and nested instance batches must be applied individually; an
 * InstancedMesh sways only with its matrices in a storage buffer (an ImpostorMesh's are).
 * Lod, InstancedLod and ImpostorMesh clones retain the shared breeze. For ordinary
 * Mesh/Group clones, apply to each clone too: the material is shared but the sway is
 * the mesh's. Tangent-space normal maps are supported (tangents do not sway);
 * object-space normal maps are not.
 */
export class Wind {
  private readonly breeze: Breeze = { time: 0, speed: 0.25, strength: 1, direction: new Vector2(1, 0) };

  constructor({ direction = [1, 0], speed = 0.25 }: WindOptions = {}) {
    this.direction = direction;
    this.speed = speed;
  }

  /** Shared animation time in seconds; update once per frame, before any render pass. */
  get time(): number {
    return this.breeze.time;
  }
  set time(value: number) {
    finite(value, "time");
    this.breeze.time = value;
  }

  /** Oscillations per second; zero freezes the time-dependent part of the phase. */
  get speed(): number {
    return this.breeze.speed;
  }
  set speed(value: number) {
    nonnegative(value, "speed");
    this.breeze.speed = value;
  }

  /** Global amplitude multiplier in [0, 1]. Zero keeps the wind shader but draws the rest pose. */
  get strength(): number {
    return this.breeze.strength;
  }
  set strength(value: number) {
    nonnegative(value, "strength");
    if (value > 1) throw new Error("Wind: strength must be in [0, 1]");
    this.breeze.strength = value;
  }

  get direction(): readonly [number, number] {
    const { x, y } = this.breeze.direction;
    return [x, y];
  }
  set direction([x, z]: readonly [number, number]) {
    finite(x, "direction.x");
    finite(z, "direction.z");
    if (Math.hypot(x, z) === 0) throw new Error("Wind: direction must be nonzero");
    this.breeze.direction.set(x, z).normalize();
  }

  /** Attach once, after constructing all levels. Objects without this call keep their original shaders. */
  apply(root: Object3D, { amplitude, baseY, height }: SwayOptions): void {
    if (bindings.has(root)) throw new Error("Wind: already applied to this object");
    this.attach(root, { amplitude, baseY, height }, false);
  }

  /** Attach meshes arriving with a deferred level; existing meshes retain their bounds. */
  private attach(root: Object3D, { amplitude, baseY, height }: SwayOptions, refreshing: boolean, added = root, knownBox?: Box3): void {
    nonnegative(amplitude, "amplitude");
    const meshes: Mesh[] = [];
    added.traverse((node) => {
      if (node !== root && isLOD(node)) throw new Error("Wind: apply to nested LODs individually");
      if (!isMesh(node)) return;
      if (refreshing && attached.has(node)) return;
      if (attached.has(node)) throw new Error("Wind: a mesh already belongs to a wind root");
      if (isSkinnedMesh(node) || isBatchedMesh(node)) throw new Error("Wind: skinned and batched meshes are not supported");
      if (node !== root && !isInstancedLod(root) && (isInstancedMesh(node) || (isImpostorMesh(node) && node.count > 1)))
        throw new Error("Wind: apply to nested instance batches individually");
      if (isInstancedMesh(node) && !isStorageInstanced(node.instanceMatrix))
        throw new Error(`Wind: InstancedMesh "${node.name}" needs its instance matrices in a StorageInstancedBufferAttribute`);
      if (
        [node.material]
          .flat()
          .some((material) => "normalMapType" in material && material.normalMapType === ObjectSpaceNormalMap && "normalMap" in material && material.normalMap)
      )
        throw new Error("Wind: use tangent-space normal maps");
      meshes.push(node);
    });
    if (meshes.length === 0) {
      if (refreshing) return;
      if (!isLOD(root)) throw new Error("Wind: object has no meshes");
    }
    added.updateWorldMatrix(true, true);
    invertible(root.matrixWorld);
    const inverse = root.matrixWorld.clone().invert();
    const placed = meshes.map((mesh) => {
      // InstancedLod has already placed ordinary geometry in instance space; its
      // impostors carry placement separately. Avoid roundoff defeating the fast path.
      const placement = mesh === root || isInstancedLod(root) ? identity.clone() : inverse.clone().multiply(mesh.matrixWorld);
      invertible(placement);
      return { mesh, placement };
    });
    const box = knownBox ?? sourceBox(root);
    if (box.isEmpty()) throw new Error("Wind: object has no geometry");
    const base = baseY ?? box.min.y;
    const size = height ?? box.max.y - base;
    finite(base, "baseY");
    finite(size, "height");
    if (size <= 0) throw new Error("Wind: height must be positive");
    const shape = new Vector2(amplitude / size, base);
    const padding = (amplitude * Math.max(Math.abs(box.min.y - base), Math.abs(box.max.y - base))) / size;
    if (hasBounds(root) && !refreshing) root[WIND_BOUNDS](padding, amplitude / size, base);
    for (const { mesh, placement } of placed) {
      if (!isInstancedLod(root)) windBounds(mesh, placement, amplitude, base, size);
      setSway(mesh, { breeze: this.breeze, shape, placement, fromRoot: placement.clone().invert() });
      if (isImpostorMesh(mesh)) {
        if (mesh.material.deformNode !== impostorSway) {
          mesh.material.deformNode = impostorSway;
          mesh.material.needsUpdate = true;
        }
      } else mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => levelMaterial(m, true)) : levelMaterial(mesh.material, true);
      attached.add(mesh);
    }
    const options = { amplitude, baseY: base, height: size };
    bindings.set(root, { wind: this, options, refresh: (next) => this.attach(root, options, true, next, box) });
  }
}

function hasBounds(root: Object3D): root is Object3D & WindBounds {
  return WIND_BOUNDS in root;
}

function sourceBox(root: Object3D): Box3 {
  if (isLOD(root)) {
    for (const level of root.levels) {
      const box = levelBox(level);
      if (!box.isEmpty()) return box;
    }
    return new Box3();
  }
  if (isImpostorMesh(root)) return new Box3().setFromArray(root.impostor.box);
  if (isInstancedMesh(root)) {
    root.geometry.computeBoundingBox();
    return root.geometry.boundingBox?.clone() ?? new Box3();
  }
  return boundingBox(root);
}

function invertible(matrix: Matrix4): void {
  const determinant = matrix.determinant();
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error("Wind: root and mesh placements must be finite and invertible");
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`Wind: ${name} must be finite`);
}

function nonnegative(value: number, name: string): void {
  finite(value, name);
  if (value < 0) throw new Error(`Wind: ${name} must be nonnegative`);
}

/** Rebuilt LODs and impostors share the clock, with their own placements and bounds. */
export function copyWind(source: Object3D, target: Object3D): void {
  const binding = bindings.get(source);
  if (binding) binding.wind.apply(target, binding.options);
}

export function refreshWind(root: Object3D, added: Object3D = root): void {
  const binding = bindings.get(root);
  binding?.refresh(added);
}
