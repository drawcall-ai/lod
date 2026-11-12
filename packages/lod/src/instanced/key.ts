import type { Sphere, Vector3 } from "three/webgpu";
import type { d } from "typegpu";
import type { DrawLevels } from "../levels/draw.js";
import type { Cull } from "./cull.js";

// What a camera's sort or loading last ran with, so that it is skipped while nothing it reads changed.

/** The values something last ran with, written again in place each time it may run, telling whether any differs. */
export class Key {
  private readonly values: number[] = [];
  private length = 0;
  private changed = false;

  /** Starts writing the values anew. */
  start(): this {
    this.length = 0;
    this.changed = false;
    return this;
  }

  put(value: number): this {
    if (this.values[this.length] !== value) {
      this.values[this.length] = value;
      this.changed = true;
    }
    this.length++;
    return this;
  }

  /** Whether the values written since start differ from the last ones. */
  end(): boolean {
    if (this.values.length !== this.length) {
      this.values.length = this.length;
      this.changed = true;
    }
    return this.changed;
  }

  /** A camera's inputs, everything in the Lod's space: what sorting for it reads. */
  camera(eye: Vector3, scale: number, ortho: boolean, levels: d.Infer<typeof DrawLevels>, cull: Cull | null, source: Sphere): this {
    return this.put(eye.x).put(eye.y).put(eye.z).screen(scale, ortho, levels, cull, source);
  }

  /** A camera's inputs but where it looks from: all an orthographic camera measures heights by. */
  screen(scale: number, ortho: boolean, levels: d.Infer<typeof DrawLevels>, cull: Cull | null, source: Sphere): this {
    this.put(scale).put(Number(ortho));
    this.put(levels.count).put(levels.empty).put(levels.coarsest).put(levels.forced).put(levels.fades);
    for (const pixels of levels.maxPixels) this.put(pixels);
    this.put(Number(cull !== null));
    if (cull) this.put(cull.eye.x).put(cull.eye.y).put(cull.eye.z).put(cull.near).put(cull.far).put(Number(cull.survivors));
    return this.put(source.center.x).put(source.center.y).put(source.center.z).put(source.radius);
  }
}
