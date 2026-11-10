import type { Camera } from "three/webgpu";
import { nextTask } from "../task.js";
import type { RenderContext } from "./compile/contexts.js";
import type { CameraRequests } from "./requests.js";

/**
 * A Lod's background compiles of its loaded levels, per render context: which levels each context's compile has
 * started for, so that each compiles once per context, and the compiles still running.
 */
export class ContextCompiles {
  /** Per render context, the bits of the levels whose compile for it has started: a context dropped drops its bits. */
  private readonly claimed = new WeakMap<RenderContext, number>();
  /** The compiles running, each with the camera whose context it compiles for. */
  private readonly runs = new Map<Promise<void>, Camera>();

  constructor(
    /** Compile the loaded levels of `bits` for `context`. */
    private readonly run: (context: RenderContext, bits: number) => Promise<void>,
    /** Called with what a compile throws. */
    private readonly failed: (error: unknown) => void,
  ) {}

  /** Mark the levels of `bits` as compiling for `context`, and answer those that were not yet. */
  claim(context: RenderContext, bits: number): number {
    const claimed = this.claimed.get(context) ?? 0;
    this.claimed.set(context, claimed | bits);
    return bits & ~claimed;
  }

  /** Compile the loaded levels of `bits` for `context` in the background, once the render that asked for them has ended. */
  compile(context: RenderContext, bits: number): void {
    if (bits === 0) return;
    // A render runs within one task: the next starts after it has ended.
    const done = nextTask()
      .then(() => this.run(context, bits))
      .catch((error: unknown) => this.failed(error))
      .finally(() => this.runs.delete(done));
    this.runs.set(done, context.camera);
  }

  /** Whether a compile runs for a camera still rendering the Lod: one for a camera that stopped holds nothing up. */
  running(requests: CameraRequests): boolean {
    for (const camera of this.runs.values()) if (requests.rendering(camera)) return true;
    return false;
  }

  /** The compiles running, each settling once its compile has ended. */
  tasks(): Iterable<Promise<void>> {
    return this.runs.keys();
  }
}
