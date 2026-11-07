import { DefaultLoadingManager, type LoadingManager, type Object3D } from "three/webgpu";
import { isOwner } from "./three.js";

/**
 * The LoadingManager item an owner holds while the levels it needs are pending. The manager hears of it in a microtask,
 * once the render that changed it has returned: what an app's callback does, such as throw or render, happens outside
 * three's render and is no owner's failure.
 */
export class Item {
  /** The manager given; else the nearest owner above's, else three's default. */
  manager: LoadingManager | undefined;
  /** The manager the held item started on, which it ends on. */
  private started: LoadingManager | undefined;

  constructor(
    private readonly owner: Object3D,
    private readonly name: string,
  ) {}

  /** The manager the owner reports to now. */
  get resolved(): LoadingManager {
    if (this.manager) return this.manager;
    for (let node = this.owner.parent; node; node = node.parent) if (isOwner(node)) return node.manager;
    return DefaultLoadingManager;
  }

  get held(): boolean {
    return this.started !== undefined;
  }

  set held(held: boolean) {
    if (held === this.held) return;
    const { name } = this;
    if (held) {
      const manager = (this.started = this.resolved);
      queueMicrotask(() => manager.itemStart(name));
      return;
    }
    const manager = this.started;
    this.started = undefined;
    if (manager) queueMicrotask(() => manager.itemEnd(name));
  }

  /** Report a failure on the manager, then end the item. */
  fail(): void {
    const manager = this.started ?? this.resolved;
    const { name } = this;
    queueMicrotask(() => manager.itemError(name));
    this.held = false;
  }
}
