import { DefaultLoadingManager, type LoadingManager, type Object3D, type Renderer } from "three/webgpu";
import { hasLoadingManager } from "./renderer.js";

/** How long a held item waits between looks at its renderer's renders (see `look`): a frame's time. */
const LOOK_MS = 16;

/**
 * A Lod's item on a LoadingManager, held while it loads: the manager hears of it in a microtask, once the render that
 * changed it has returned, so what an app's callback does, such as throw or render, happens outside three's render.
 */
export class LoadingItem {
  /** The LoadingManager given; else the nearest Lod above's, else three's default (see `manager`). */
  given: LoadingManager | undefined;
  /** The LoadingManager the held item started on, which it ends on. */
  private holding: LoadingManager | undefined;
  /** Whether the Lod was updated since the item's last look at its renderer, the renders then, and whether a look is due. */
  private updated = false;
  private renders = 0;
  private looking = false;

  constructor(
    private readonly lod: Object3D,
    /** The item's name: the kind of Lod and its uuid. */
    private readonly name: string,
    private readonly renderer: Renderer,
  ) {}

  /** Where the item goes. */
  get manager(): LoadingManager {
    if (this.given) return this.given;
    for (let node = this.lod.parent; node; node = node.parent) if (hasLoadingManager(node)) return node.manager;
    return DefaultLoadingManager;
  }

  /** A render updated the Lod: the next look at the renderer's renders does not end the item. */
  touch(): void {
    this.updated = true;
  }

  /** Hold the item if `held`, else end it; while it is held, look at the renderer's renders (see `look`). */
  sync(held: boolean): void {
    this.hold(held);
    if (!this.holding || this.looking) return;
    // The first look only counts the renders: those still to come in this render are not without an update.
    this.updated = true;
    this.look();
  }

  /** Report a failure on the LoadingManager the item is held on, and end the item. */
  fail(): void {
    const manager = this.holding;
    const { name } = this;
    if (manager) queueMicrotask(() => manager.itemError(name));
    this.hold(false);
  }

  private hold(held: boolean): void {
    if (held === (this.holding !== undefined)) return;
    const { name } = this;
    if (held) {
      const manager = (this.holding = this.manager);
      queueMicrotask(() => manager.itemStart(name));
      return;
    }
    const manager = this.holding;
    this.holding = undefined;
    if (manager) queueMicrotask(() => manager.itemEnd(name));
  }

  /**
   * While the item is held, look a frame's time apart at the renderer's renders: a Lod its renderer rendered around for
   * a frame without updating it (hidden, on a layer no camera tests, out of the scene) ends its item; its next update
   * starts it again. Renders of other scenes in a separate task can end it early, and the next update reopens it; a
   * renderer that only compiles holds a hidden Lod's item.
   */
  private look(): void {
    const { renderer } = this;
    this.looking = true;
    const timer: unknown = setTimeout(() => {
      this.looking = false;
      if (!this.holding) return;
      const renders = renderer.info.render.calls;
      if (renders !== this.renders && !this.updated) return this.hold(false);
      this.renders = renders;
      this.updated = false;
      this.look();
    }, LOOK_MS);
    // A held item must not hold Node.js open.
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
  }
}
