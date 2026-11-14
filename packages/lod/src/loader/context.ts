import type { Object3D } from "three/webgpu";
import { disposeRejected, disposeRecursive, type DisposeOptions } from "../dispose.js";

/**
 * What one ladder's loads share: the source loaded to measure or build the ladder with, handed to the first level
 * load (the source level draws it, a build uses it, a stored level disposes it; onLevel has not changed it), the bytes
 * of the levels read or built while describing the ladder, each handed to its first load, and every level object
 * loaded. Those are freed if describing the ladder fails, else when the last Lod holding the levels is disposed (see
 * `hold`), which spends them.
 */
export class LodLoadContext {
  /** Level bytes read or built while describing the ladder, by index: undefined where a read missed. */
  private readonly described = new Map<number, Promise<Uint8Array | undefined>>();
  private spare: Object3D | undefined;
  /** Every level object loaded, and what freeing it frees: a simplified level draws with its source's materials. */
  private readonly loaded = new Map<Object3D, DisposeOptions>();
  /** How many Lods hold the levels, and whether the last has let go, which freed them. */
  private holders = 0;
  private spent = false;

  constructor(
    private readonly load: () => Promise<Object3D>,
    private readonly onLevel: ((object: Object3D, index: number) => void | Promise<void>) | undefined,
    /** Called once what the ladder loaded is freed. */
    private readonly onFree: () => void,
  ) {}

  /** The spare source, loaded once. */
  async source(): Promise<Object3D> {
    this.spare ??= await this.load();
    return this.spare;
  }

  /** The spare source, for the first level load to take. */
  take(): Object3D | undefined {
    const taken = this.spare;
    this.spare = undefined;
    return taken;
  }

  /** Hold the bytes of level `index`, read or built while describing the ladder, for its first load to take. */
  setDescribed(index: number, bytes: Promise<Uint8Array | undefined>): void {
    this.described.set(index, bytes);
  }

  /** The bytes of level `index` read or built while describing the ladder, once: undefined if none were, or once taken. */
  takeDescribed(index: number): Promise<Uint8Array | undefined> | undefined {
    const bytes = this.described.get(index);
    this.described.delete(index);
    return bytes;
  }

  /** Apply onLevel to a level's arriving object, freeing it as `options` say if that fails. */
  async arrive(object: Object3D, index: number, options: DisposeOptions): Promise<Object3D> {
    try {
      this.loaded.set(object, options);
      await this.onLevel?.(object, index);
      return object;
    } catch (error) {
      this.loaded.delete(object);
      disposeRejected(object, options);
      throw error;
    }
  }

  /** Describing the ladder failed: free what it loaded. */
  fail(): void {
    this.free(disposeRejected);
  }

  /**
   * A Lod made from the levels holds them; the release it answers lets go, and the last frees what was loaded. Levels
   * no Lod ever held are never freed. Freed levels are spent: a Lod made from them later throws.
   */
  readonly hold = (): (() => void) => {
    if (this.spent) throw new Error("CachedLodLoader: these levels were freed with the last Lod that held them; call loadAsync again");
    this.holders++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--this.holders > 0) return;
      this.spent = true;
      this.free(disposeRecursive);
    };
  };

  /** Free the spare source and every level object loaded with `dispose`. */
  private free(dispose: (object: Object3D, options: DisposeOptions) => void): void {
    const taken = this.take();
    if (taken) dispose(taken, { materials: true });
    for (const [object, options] of this.loaded) dispose(object, options);
    this.loaded.clear();
    this.described.clear();
    this.onFree();
  }
}
