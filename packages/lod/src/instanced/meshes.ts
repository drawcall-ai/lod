import {
  type BufferGeometry,
  type Camera,
  type ComputeNode,
  InstancedBufferGeometry,
  type Matrix4,
  Mesh,
  type NodeMaterial,
  Object3D,
  type Sphere,
  type StorageInstancedBufferAttribute,
} from "three/webgpu";
import { at } from "../at.js";
import { placeInterior } from "../baked/interior/material.js";
import { prepareBounds } from "../bounds.js";
import { disposeCopies } from "../dispose.js";
import { drawOf, setDraw, white } from "../fade.js";
import { impostorInstances, type ImpostorMesh } from "../impostor/mesh/index.js";
import type { Level } from "../levels.js";
import { gpuRenderer, inShadowPass, isImpostorMesh } from "../three.js";
import { inView } from "../view.js";
import { ARGS_BYTES } from "./args.js";
import { ContactMesh } from "./contact.js";
import { groupMaterial, parts, placed, type Part } from "./parts.js";
import type { Selection } from "./select.js";

// The indirect draws of one Selection's levels and contacts, and the compute that selects for them.

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
  /** Every instance's matrix: a draw reads those of the instances in its view's slots. */
  instanceMatrix: StorageInstancedBufferAttribute;
  instanceColor: StorageInstancedBufferAttribute;
  // The owner installs the aggregate bounds instead of scanning the instance slots.
  boundingSphere: Sphere | null = null;

  constructor(geometry: BufferGeometry, material: NodeMaterial, selection: Selection) {
    super(geometry, material);
    this.instanceMatrix = selection.drawn;
    this.instanceColor = selection.colors ?? white;
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
  /** Run a draw callback's `action`, reporting what it throws: nothing may throw while three renders. */
  guard(action: () => void): void;
}

/** Every level's meshes for one Selection, each drawing from its indirect arguments. */
export class Meshes {
  /** Per level, the meshes drawing it. */
  readonly byLevel: LevelMesh[][] = [];
  private contactMesh: ContactMesh | null = null;

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

  /** Every level's meshes from its `templates` parts, drawn in order from the selection's first indirect arguments. */
  fill(levels: readonly Level[], templates: readonly (readonly Part[])[]): LevelMesh[] {
    let offset = 0;
    templates.forEach((parts, i) => {
      this.byLevel[i] = this.make(at(levels, i), parts, offset);
      offset += parts.length * ARGS_BYTES;
    });
    return this.byLevel.flat();
  }

  /**
   * `level`'s meshes from a clone of `template`, staged and compiled by `compile`; they draw
   * once its caller adds them. Null if the owner died meanwhile, which frees them.
   */
  async load(
    level: Level,
    template: Object3D,
    compile: (staged: Object3D) => Promise<void>,
  ): Promise<{ object: Object3D; found: Part[]; made: LevelMesh[] } | null> {
    const staged = new Object3D();
    const object = template.clone();
    if (level.box) prepareBounds(object, level.box);
    const found = parts(object, level.index);
    const made = this.make(level, found, this.selection.append(found.map((part) => part.draw)));
    for (const mesh of made) staged.add(mesh);
    const abandon = () => {
      for (const mesh of made) this.free(mesh);
      disposeCopies(object);
    };
    try {
      await compile(staged);
    } catch (error) {
      abandon();
      throw error;
    }
    if (!this.owner.live()) {
      abandon();
      return null;
    }
    this.byLevel[level.index] = made;
    return { object, found, made };
  }

  /** `level`'s `parts`, drawn from consecutive indirect arguments starting at byte `offset`. */
  private make(level: Level, parts: readonly Part[], offset: number): LevelMesh[] {
    return parts.map((part, i) => this.mesh(level, part, offset + i * ARGS_BYTES));
  }

  /** Release `mesh`, which may never have been added. */
  private free(mesh: LevelMesh): void {
    // ImpostorMesh.dispose also destroys instance buffers; the Selection owns ours.
    if (isImpostorMesh(mesh)) mesh.material.release();
    mesh.geometry.dispose();
  }

  /** Every level's meshes draw the selection's current buffers, colours it has begun to carry included, with the shaders they have. */
  rebind(): void {
    for (const mesh of this.byLevel.flat()) {
      mesh.instanceMatrix = this.selection.drawn;
      mesh.instanceColor = this.selection.colors ?? white;
      if (mesh.geometry instanceof InstancedBufferGeometry) mesh.geometry.instanceCount = this.selection.capacity;
    }
    this.contactMesh?.rebind();
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

  /** The mesh drawing the instances' contacts while they have them, made when first asked for; null, freed, without. */
  useContacts(on: boolean): ContactMesh | null {
    if (!on) {
      this.contactMesh?.dispose();
      this.contactMesh = null;
      return null;
    }
    if (this.contactMesh) return this.contactMesh;
    const { selection, owner } = this;
    const mesh = new ContactMesh(selection);
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (!owner.live()) return;
      owner.guard(() => {
        runDue(renderer, camera, selection);
        mesh.aim(camera);
      });
    };
    this.contactMesh = mesh;
    return mesh;
  }

  dispose(): void {
    // An ImpostorMesh frees its own material and geometry; the other meshes' faded
    // materials go with the levels' originals.
    for (const mesh of this.byLevel.flat()) {
      mesh.removeFromParent();
      this.free(mesh);
    }
    this.contactMesh?.dispose();
    this.contactMesh = null;
    due.delete(this.selection);
    this.byLevel.length = 0;
  }

  /** Material group `part.group` of `part.template` drawn for every instance in `level`'s slots. */
  private mesh(level: Level, { template, placement, group }: Part, offset: number): LevelMesh {
    const { selection, owner } = this;
    // An impostor card is placed in the shader; any other mesh draws its geometry moved
    // into the instance's space, so the instance matrix is all it needs.
    const mesh = isImpostorMesh(template)
      ? card(template, placement, selection)
      : new Instances(placed(template.geometry, placement), groupMaterial(template, group), selection);
    mesh.geometry = instanced(mesh.geometry, selection);
    setDraw(mesh, { kind: "instances", slots: (camera) => selection.view(camera), radius: this.radius, tint: level.tint });
    if (!isImpostorMesh(template)) placeInterior(mesh, placement);
    mesh.name = template.name;
    mesh.castShadow = template.castShadow;
    mesh.receiveShadow = template.receiveShadow;
    mesh.boundingSphere = at(this.reaches, level.index);
    const previous = mesh.onBeforeRender;
    // Selected once per view, before the first level mesh draws in it: the GPU runs the
    // selection before the pass, which is submitted when it ends.
    mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      if (!owner.live()) return;
      previous.call(mesh, renderer, scene, camera, geometry, material, group);
      owner.guard(() => {
        runDue(renderer, camera, selection);
        const { args } = selection.view(camera);
        mesh.geometry.setIndirect(args.attribute, args.offset + offset);
      });
    };
    const after = mesh.onAfterRender;
    mesh.onAfterRender = (renderer, scene, camera, geometry, material, group) => {
      after.call(mesh, renderer, scene, camera, geometry, material, group);
      if (!inShadowPass(scene)) owner.drawn(camera, mesh);
    };
    return mesh;
  }
}

/**
 * Run the selections due, `selection`'s among them, that `renderer`'s buffers are not current with for `camera`,
 * before a draw of `selection`'s.
 */
function runDue(renderer: unknown, camera: Camera, selection: Selection): void {
  const gpu = gpuRenderer(renderer);
  due.add(selection);
  // Each level's draws start at its slots (see select.ts).
  if (!gpu.hasFeature("indirect-first-instance")) throw new Error("InstancedLod: needs the GPU feature indirect-first-instance, which this device lacks");
  passes.length = 0;
  for (const each of due) passes.push(...each.take(camera));
  due.clear();
  if (passes.length > 0) gpu.compute(passes);
}

/** An impostor's cards for `selection`'s slots. */
function card(template: ImpostorMesh, placement: Matrix4, selection: Selection): ImpostorMesh {
  const mesh = impostorInstances(template, 0, placement);
  // Indirect arguments supply the actual count. A card's public count is otherwise
  // used by Three to specialize its shader for one object's storage bindings.
  mesh.count = 1;
  mesh.instanceMatrix = selection.drawn;
  mesh.instanceColor = selection.colors ?? white;
  return mesh;
}

/** A geometry drawing `geometry`'s buffers for `selection`'s instances; each view's draw points it at its indirect arguments. */
function instanced(geometry: BufferGeometry, selection: Selection): BufferGeometry {
  const view = new InstancedBufferGeometry();
  // Capacity belongs to the geometry's statistics, not the object's shader cache key.
  view.instanceCount = selection.capacity;
  view.index = geometry.index;
  for (const [name, attribute] of Object.entries(geometry.attributes)) view.setAttribute(name, attribute);
  view.morphAttributes = geometry.morphAttributes;
  view.boundingBox = geometry.boundingBox;
  view.boundingSphere = geometry.boundingSphere;
  return view;
}
