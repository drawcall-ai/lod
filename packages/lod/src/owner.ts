import { Object3D, type Camera, type LoadingManager } from "three/webgpu";
import type { Level, LevelView } from "./levels.js";
import { Residency, type LevelsEventMap } from "./residency.js";
import type { RenderContext } from "./view.js";
import { WIND } from "./wind/hooks.js";
import { copyWind } from "./wind/index.js";

export interface LodOptions {
  /**
   * Gets an item while the levels the views need load, install, compile or fade in, ended once they are complete. Without
   * one, an owner nested in another's level reports to that owner's, any other to three's `DefaultLoadingManager`. Wait
   * for it to go idle, rendering (or compiling) the Scene that holds the owner a frame apart meanwhile, to capture a
   * view complete. An owner that its renderer renders around for a frame's time without an update ends its item, and
   * starts it again on its next update.
   */
  manager?: LoadingManager;
}

/**
 * What a Lod and an InstancedLod share: levels picked per camera, prepared while their item is held. Each draws with one
 * renderer, the first that draws it; another that draws it is reported as its error.
 */
export abstract class Owner extends Object3D<LevelsEventMap> {
  readonly isLOD = true;
  /** Let the renderer call `update` with its camera every frame. */
  autoUpdate = true;
  /** Draw only this level, without fades. */
  forceLevel: number | null = null;
  readonly levels: readonly LevelView[];

  protected readonly entries: Level[] = [];
  protected readonly residency: Residency;
  protected disposed = false;

  constructor(
    private readonly kind: string,
    options: LodOptions,
  ) {
    super();
    this.residency = new Residency(
      this,
      `${kind} ${this.uuid}`,
      this.entries,
      (level, object, context) => this.install(level, object, context),
      () => this.arrived(),
      (error) => this.dispatchEvent({ type: "levelserror", error }),
    );
    this.residency.item.manager = options.manager;
    this.levels = this.entries;
  }

  get pending(): boolean {
    return this.residency.pending;
  }
  get error(): Error | undefined {
    return this.residency.error;
  }

  /** Where the item of pending levels goes (see `LodOptions.manager`). */
  get manager(): LoadingManager {
    return this.residency.item.resolved;
  }
  set manager(manager: LoadingManager | undefined) {
    this.residency.item.manager = manager;
  }

  /** Pick levels for `camera`. What fails is reported (see `Residency.report`): three is rendering. */
  update(camera: Camera): void {
    this.residency.guard(() => {
      this.residency.view(camera);
      this.pick(camera);
    });
  }

  [WIND](padding: number, slope: number, baseY: number): void {
    if (this.residency.started) throw new Error(`${this.kind}: apply wind before the first render`);
    this.sway(padding, slope, baseY);
  }

  /** Release drawables and templates only after every owner sharing their geometry, materials and textures has stopped drawing. */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    super.dispose();
    this.residency.dispose(() => this.release());
  }

  protected abstract pick(camera: Camera): void;
  /** Make a clone of `template`, the object `level` loaded, the level's once its draws are prepared for `context`. */
  protected abstract install(level: Level, template: Object3D, context: RenderContext): Promise<void>;
  /** Pad culling and casters for a wind's sway: see `WindOwner`. */
  protected abstract sway(padding: number, slope: number, baseY: number): void;
  /** Free what the levels' copies hold. */
  protected abstract release(): void;

  /** A level arrived and draws. */
  protected arrived(): void {
    this.dispatchEvent({ type: "levelschange" });
  }

  /** Take `source`'s settings, its manager and its wind, once its levels are copied. */
  protected copySettings(source: Owner): void {
    this.forceLevel = source.forceLevel;
    this.autoUpdate = source.autoUpdate;
    this.residency.item.manager = source.residency.item.manager;
    copyWind(source, this);
  }
}
