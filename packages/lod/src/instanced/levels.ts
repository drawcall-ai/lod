import { Color, Object3D, type Box3, type Camera, type Mesh, type Sphere } from "three/webgpu";
import { at } from "../at.js";
import { prepareBounds } from "../levels/bounds.js";
import { disposeCopies } from "../dispose.js";
import { tintOf, type ThresholdedLevel } from "../levels/index.js";
import { has } from "../levels/draw.js";
import type { DrawnInstances } from "../levels/fade.js";
import type { PreparedLevel } from "../levels/manager.js";
import { refreshWind } from "../wind/index.js";
import type { InstanceLists } from "./lists.js";
import { freeMesh, levelMeshes, partsOf, type LevelMeshes, type Part } from "./meshes.js";
import type { InstanceShape } from "./shape.js";

/** What a Lod's level meshes draw with: its shape, lists and the instances they draw. */
export interface Drawing {
  readonly shape: InstanceShape;
  readonly lists: InstanceLists;
  /** What the level meshes draw: the Lod's instances, or while survivors scale, their scaled matrices. */
  readonly drawn: DrawnInstances;
}

/**
 * A Lod's level meshes: per level, the meshes drawing it with its debug tint, made from the level's object once there
 * is one and added to the Lod, and the source level's parts, which a raycast hits.
 */
export class MeshesByLevel {
  private readonly tints: Color[];
  private readonly byLevel: Mesh[][] = [];
  private sourceParts: readonly Part[] = [];

  constructor(
    /** The Lod, which holds the meshes. */
    private readonly parent: Object3D,
    /** Its levels: a level that joins gets its object. */
    private readonly levels: readonly ThresholdedLevel[],
    private readonly drawing: Drawing,
    /** Around every instance, survivors grown: what every level mesh is culled and boxed by. */
    private readonly bounds: { readonly sphere: Sphere; readonly box: Box3 },
    /** Sorts `camera`'s lists as `renderer` draws a mesh for it. */
    private readonly drawFor: (renderer: unknown, camera: Camera) => void,
  ) {
    this.tints = levels.map(() => new Color(1, 1, 1));
    levels.forEach(({ object }, i) => {
      const parts = object ? partsOf(object, i) : [];
      if (i === 0) this.sourceParts = parts;
      const made = this.meshesOf(parts, i);
      drawInto(drawing.lists, made);
      this.byLevel.push(made.meshes);
      for (const mesh of made.meshes) parent.add(mesh);
    });
  }

  /** The source level's parts, which a raycast hits. */
  get source(): readonly Part[] {
    return this.sourceParts;
  }

  /** The meshes drawing level `level`. */
  of(level: number): readonly Mesh[] {
    return at(this.byLevel, level);
  }

  /** Every level's meshes. */
  all(): Mesh[] {
    return this.byLevel.flat();
  }

  /** Tint each level as Lod.debug, `debug`, has it. */
  tint(debug: boolean): void {
    this.levels.forEach((_, i) => at(this.tints, i).copy(tintOf(i, debug)));
  }

  /** Show the meshes of the levels of the bits `levels`, and hide the others. */
  show(levels: number): void {
    this.byLevel.forEach((meshes, level) => {
      for (const mesh of meshes) mesh.visible = has(levels, level);
    });
  }

  /** The meshes drawing `parts` of level `level` for the cameras of the lists. */
  private meshesOf(parts: readonly Part[], level: number): LevelMeshes {
    const { lists, drawn, shape } = this.drawing;
    return levelMeshes(parts, at(this.tints, level), {
      instances: drawn,
      bounds: this.bounds.sphere,
      box: this.bounds.box,
      slots: (camera) => lists.slots(camera),
      radius: shape.fadeRadius,
      drawFor: (renderer, camera) => {
        this.drawFor(renderer, camera);
        return lists.slots(camera)?.args ?? null;
      },
    });
  }

  /** Level meshes of `loaded`, level `index`'s object, staged for wind and compiling. */
  prepare(index: number, loaded: Object3D): PreparedLevel {
    const level = at(this.levels, index);
    const object = loaded.clone();
    if (level.box) prepareBounds(object, level.box);
    const parts = partsOf(object, index);
    const made = this.meshesOf(parts, index);
    const staged = new Object3D();
    for (const mesh of made.meshes) staged.add(mesh);
    refreshWind(this.parent, staged);
    return {
      object: staged,
      join: () => {
        level.object = object;
        drawInto(this.drawing.lists, made);
        this.byLevel[index] = made.meshes;
        if (index === 0) this.sourceParts = parts;
        for (const mesh of made.meshes) this.parent.add(mesh);
      },
      discard: () => {
        for (const mesh of made.meshes) freeMesh(mesh);
        disposeCopies(object);
      },
    };
  }

  /** Take every mesh out of the Lod and free it. */
  dispose(): void {
    for (const mesh of this.byLevel.flat()) {
      mesh.removeFromParent();
      freeMesh(mesh);
    }
    this.byLevel.length = 0;
  }
}

/** Let `made` draw for the cameras of `lists`, its draws appended to theirs. */
function drawInto(lists: InstanceLists, made: LevelMeshes): void {
  if (made.draws.length > 0) made.drawFrom(lists.appendDraws(made.draws));
}
