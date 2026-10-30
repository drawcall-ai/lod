import {
  type BufferGeometry,
  type Camera,
  type ComputeNode,
  InstancedBufferGeometry,
  type Matrix4,
  Mesh,
  type NodeMaterial,
  type Sphere,
  type StorageInstancedBufferAttribute,
} from "three/webgpu";
import { at } from "../at.js";
import { placeInterior } from "../baked/interior/material.js";
import { drawOf, setDraw } from "../fade.js";
import { impostorInstances, type ImpostorMesh } from "../impostor/mesh/index.js";
import type { Level } from "../levels.js";
import { gpuRenderer, inShadowPass, isImpostorMesh } from "../three.js";
import { inView, watchViewport } from "../view.js";
import { ARGS_BYTES } from "./args.js";
import { groupMaterial, placed, type Part } from "./parts.js";
import type { Selection } from "./select.js";

// The indirect draws of one Selection's levels, and the compute that selects for them.

/**
 * Selections due before the next draw of any InstancedLod: the first level mesh to draw
 * runs them all in one compute call (each call has a cost of its own: an encoder, a
 * pass, a submit). Each renderer runs those its own buffers are not current with.
 */
const due = new Set<Selection>();
const passes: ComputeNode[] = [];

/** An indirect level draw. Its material applies instance storage without Three's per-build nodes. */
export class Instances extends Mesh<BufferGeometry, NodeMaterial> {
  readonly isLodInstances = true;
  // Capacity is in the indirect draw; a stable count keeps Three's shader key shared.
  readonly count = 1;
  instanceMatrix: StorageInstancedBufferAttribute;
  instanceColor: StorageInstancedBufferAttribute | null;
  // The owner installs the aggregate bounds instead of scanning the instance slots.
  boundingSphere: Sphere | null = null;

  constructor(geometry: BufferGeometry, material: NodeMaterial, selection: Selection) {
    super(geometry, material);
    this.instanceMatrix = selection.slots.matrices;
    this.instanceColor = selection.slots.colors;
  }
}

/** A mesh drawing one level's slots: instanced, or an impostor's cards. */
export type LevelMesh = Instances | ImpostorMesh;

/** What the meshes ask of the InstancedLod they draw for. */
export interface Owner {
  /** False once it is disposed: its meshes stop selecting. */
  live(): boolean;
  /** A mesh finished drawing for `camera` outside a shadow pass. */
  drawn(camera: Camera, mesh: LevelMesh): void;
}

/** Every level's meshes for one Selection, each drawing from its indirect arguments. */
export class Meshes {
  /** Per level, the meshes drawing it. */
  readonly byLevel: LevelMesh[][] = [];
  /** Each mesh's byte offset in the indirect argument table. */
  private readonly offsets = new Map<LevelMesh, number>();

  /**
   * `reaches` are the per-level spheres the meshes are culled by; `radius` is the source
   * radius the level shaders cut shadow casters off at.
   */
  constructor(
    private readonly selection: Selection,
    private readonly reaches: readonly Sphere[],
    private radius: number,
    private readonly owner: Owner,
  ) {}

  setRadius(radius: number): void {
    this.radius = radius;
    for (const mesh of this.byLevel.flat()) {
      const draw = drawOf(mesh);
      if (draw?.kind === "instances") draw.radius = radius;
    }
  }

  /** `level`'s `parts`, drawn from consecutive indirect arguments starting at byte `offset`. */
  make(level: Level, parts: readonly Part[], offset: number): LevelMesh[] {
    return parts.map((part, i) => this.mesh(level, part, offset + i * ARGS_BYTES));
  }

  /** Re-point every mesh at the indirect argument table, which moves as deferred levels append to it. */
  relocate(): void {
    const { args, argsOffset } = this.selection;
    for (const [mesh, offset] of this.offsets) mesh.geometry.setIndirect(args, argsOffset + offset);
  }

  /** Release `mesh`, which may never have been added. */
  free(mesh: LevelMesh): void {
    this.offsets.delete(mesh);
    // ImpostorMesh.dispose also destroys instance buffers; the Selection owns ours.
    if (isImpostorMesh(mesh)) mesh.material.release();
    mesh.geometry.dispose();
  }

  /** Every level's meshes draw the instance colours the selection has begun to carry. */
  recolor(): void {
    for (const mesh of this.byLevel.flat()) {
      mesh.instanceColor = this.selection.slots.colors;
      // Instance colours change the shader.
      if (!isImpostorMesh(mesh)) for (const material of [mesh.material].flat()) material.needsUpdate = true;
    }
  }

  /** Show only levels whose conservative bounds contain a possible selected instance; whether any may draw for `camera`. */
  show(camera: Camera, matrixWorld: Matrix4): boolean {
    let shown = false;
    for (let level = 0; level < this.byLevel.length; level++) {
      const reach = at(this.reaches, level);
      const visible = !reach.isEmpty();
      const meshes = at(this.byLevel, level);
      for (const mesh of meshes) mesh.visible = visible;
      shown ||= visible && meshes.length > 0 && inView(camera, matrixWorld, reach);
    }
    return shown;
  }

  /** Whether the selection runs before the next draw of any InstancedLod. */
  schedule(selected: boolean): void {
    if (selected) due.add(this.selection);
    else due.delete(this.selection);
  }

  dispose(): void {
    // An ImpostorMesh frees its own material and geometry; the other meshes' faded
    // materials go with the levels' originals.
    for (const mesh of this.byLevel.flat()) {
      mesh.removeFromParent();
      this.free(mesh);
    }
    due.delete(this.selection);
    this.byLevel.length = 0;
    this.offsets.clear();
  }

  /** Material group `part.group` of `part.template` drawn for every instance in `level`'s slots. */
  private mesh(level: Level, { template, placement, group }: Part, offset: number): LevelMesh {
    const { selection, owner } = this;
    // An impostor card is placed in the shader; any other mesh draws its geometry moved
    // into the instance's space, so the instance matrix is all it needs.
    const mesh = isImpostorMesh(template)
      ? card(template, placement, selection)
      : new Instances(placed(template.geometry, placement), groupMaterial(template, group), selection);
    mesh.geometry = indirect(mesh.geometry, selection, offset);
    this.offsets.set(mesh, offset);
    setDraw(mesh, { kind: "instances", fades: selection.slots.fades, radius: this.radius, tint: level.tint });
    if (!isImpostorMesh(template)) placeInterior(mesh, placement);
    mesh.name = template.name;
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    mesh.boundingSphere = at(this.reaches, level.index);
    watchViewport(mesh);
    const previous = mesh.onBeforeRender;
    // Selected once per view, before the first level mesh draws: in the view, or in a
    // shadow pass that comes first. The GPU runs it before anything drawn after it.
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      if (!owner.live()) return;
      previous.call(mesh, renderer, scene, camera, geometry, material, group);
      const gpu = gpuRenderer(renderer);
      // A caster outside the viewing frustum still needs its selection in a shadow draw.
      due.add(selection);
      // Each level's draws start at its slots (see select.ts).
      if (!gpu.hasFeature("indirect-first-instance")) throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
      passes.length = 0;
      for (const each of due) passes.push(...each.take(gpu));
      due.clear();
      if (passes.length > 0) gpu.compute(passes);
    };
    const after = mesh.onAfterRender;
    mesh.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
      after.call(mesh, renderer, scene, camera, geometry, material, group);
      if (!inShadowPass(scene)) owner.drawn(camera, mesh);
    };
    return mesh;
  }
}

/** An impostor's cards for `selection`'s slots. */
function card(template: ImpostorMesh, placement: Matrix4, selection: Selection): ImpostorMesh {
  const mesh = impostorInstances(template, 0, placement);
  // Indirect arguments supply the actual count. A card's public count is otherwise
  // used by Three to specialize its shader for one object's storage bindings.
  mesh.count = 1;
  mesh.instanceMatrix = selection.slots.matrices;
  mesh.instanceColor = selection.slots.colors;
  return mesh;
}

/** A geometry drawing `geometry`'s buffers from the indirect arguments at byte `offset`. */
function indirect(geometry: BufferGeometry, selection: Selection, offset: number): BufferGeometry {
  const view = new InstancedBufferGeometry();
  // Capacity belongs to the geometry's statistics, not the object's shader cache key.
  view.instanceCount = selection.count;
  view.index = geometry.index;
  for (const [name, attribute] of Object.entries(geometry.attributes)) view.setAttribute(name, attribute);
  view.morphAttributes = geometry.morphAttributes;
  view.boundingBox = geometry.boundingBox;
  view.boundingSphere = geometry.boundingSphere;
  view.setIndirect(selection.args, selection.argsOffset + offset);
  return view;
}
