import type { Camera, Object3D, Scene } from "three/webgpu";
import { inShadowPass, isRenderer, isScene } from "./three.js";
import { recordRender } from "./view.js";

type Hook = Scene["onBeforeRender"];

/** An owner whose updates a scene's renders count. */
export interface Member {
  /** A whole pass of renders went by without updating it: it no longer draws in the scene. */
  idle(): void;
}

const watches = new WeakMap<Scene, Watch>();

/** The scene render in progress, or else the last: the updates that follow its hook belong to it. */
let current: { watch: Watch; camera: Camera } | undefined;

/** The count of `renderer`'s renders so far, which tells one render's updates from the next's. */
const callOf = (renderer: unknown): number | undefined => (isRenderer(renderer) ? renderer.info.calls : undefined);

/**
 * A scene's renders, seen by one hook in front of the scene's own. Each render records its camera's render context and
 * viewport height. Renders are counted in passes: a pass ends when a camera renders the scene a second time, so a pass
 * holds one render by each camera that renders the scene once a frame, whatever their order. Shadow maps and compiles
 * of part of the scene do not count.
 */
export class Watch {
  /** The pass in progress. */
  pass = 0;
  /** What drew the last render, which an owner's update checks: nothing may throw here. */
  renderer: unknown;
  /** The cameras that rendered in the pass in progress. */
  private readonly cameras = new Set<Camera>();
  /** Each owner in the scene, with the pass it last updated in. */
  private readonly members = new Map<Member, number>();
  /** The hook installed, while it is, and the scene's own, put back once no owner is left. */
  private hook: Hook | undefined;
  private previous: Hook | undefined;
  /**
   * Calls of the hook, and their count when last checked, once per render: a hook not called since is no longer in
   * front. The renderer's render count at that check.
   */
  private calls = 0;
  private checked = -1;
  private checkedCall: number | undefined;
  /** Whether the hook is running: an app's hook that calls an earlier one of these sees it once. */
  private inside = false;

  private constructor(private readonly scene: Scene) {}

  /**
   * The watch of the render `camera` is in, when it renders a scene holding `owner`. Otherwise, before that render has
   * been seen, undefined: every Scene above `owner` is then watched, so its next render is. Null when no Scene holds it.
   */
  static of(owner: Object3D, camera: Camera): Watch | undefined | null {
    if (current?.camera === camera && holds(current.watch.scene, owner)) {
      // Renders since may have gone without the hook: an app replaced it.
      current.watch.check();
      return current.watch;
    }
    let found = false;
    for (let node = owner.parent; node; node = node.parent) {
      if (!isScene(node)) continue;
      found = true;
      let watch = watches.get(node);
      if (!watch) watches.set(node, (watch = new Watch(node)));
      watch.check();
    }
    return found ? undefined : null;
  }

  /** Count `member` as updated in the pass in progress. */
  join(member: Member): void {
    this.members.set(member, this.pass);
  }

  /** `member` left for good. */
  leave(member: Member): void {
    if (this.members.delete(member)) this.release();
  }

  /** Install the hook, unless it is in front or something in front still calls it. */
  private check(): void {
    if (this.scene.onBeforeRender === this.hook) return;
    if (this.hook) {
      const call = callOf(this.renderer);
      if (call !== undefined && call === this.checkedCall) return;
      this.checkedCall = call;
      if (this.calls !== this.checked) {
        this.checked = this.calls;
        return;
      }
    }
    const previous = (this.previous = this.scene.onBeforeRender);
    const watch = this;
    // three calls a scene's hook with (renderer, scene or compiled object, camera, target).
    this.hook = function (this: Scene, ...args: Parameters<Hook>) {
      const outer = !watch.inside;
      watch.inside = true;
      try {
        previous.apply(this, args);
      } finally {
        if (outer) watch.inside = false;
      }
      if (outer) watch.rendered(...args);
    };
    this.scene.onBeforeRender = this.hook;
    // Renders it missed end no pass: the owner installing it joins with the next.
    this.cameras.clear();
  }

  private rendered(...[renderer, object, camera]: Parameters<Hook>): void {
    this.calls++;
    // A compile of part of the scene, as of an arriving level's draws, tells nothing new.
    if (object !== this.scene) return;
    current = { watch: this, camera };
    this.renderer = renderer;
    if (!isRenderer(renderer)) return;
    recordRender(renderer, this.scene, camera);
    if (inShadowPass(this.scene)) return;
    if (this.cameras.has(camera)) this.next();
    this.cameras.add(camera);
  }

  /** End the pass: owners not updated in the one before no longer draw (hidden, removed, on a layer no camera tests). */
  private next(): void {
    this.pass++;
    this.cameras.clear();
    for (const [member, pass] of this.members)
      if (pass < this.pass - 1) {
        this.members.delete(member);
        member.idle();
      }
    this.release();
  }

  /** Put the scene's own hook back once no owner is left, unless an app has since put another in front. */
  private release(): void {
    if (this.members.size > 0 || this.scene.onBeforeRender !== this.hook || !this.previous) return;
    this.scene.onBeforeRender = this.previous;
    this.hook = this.previous = undefined;
  }
}

function holds(scene: Scene, owner: Object3D): boolean {
  for (let node = owner.parent; node; node = node.parent) if (node === scene) return true;
  return false;
}
