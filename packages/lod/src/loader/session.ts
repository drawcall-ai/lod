import type { Object3D } from "three/webgpu";
import { disposeRejected, disposeTree } from "../dispose.js";
import type { Provenance } from "./provenance.js";

/**
 * What one ladder's loads share: the source loaded to measure or build the ladder with, handed to the first level load
 * (the source level draws it, a build uses it, a cached level disposes it; onLevel has not changed it), the levels built
 * with the ladder, each handed to its first load, and, until the ladder is described, every object loaded, freed if
 * describing it fails.
 */
export class Session {
  /** Level bytes built while describing the ladder, by index: a cached level is read again when it loads. */
  readonly built = new Map<number, Uint8Array>();
  private spare: Loaded | undefined;
  private owned: Set<Object3D> | undefined = new Set();

  constructor(
    private readonly load: () => Promise<Loaded>,
    private readonly onLevel: ((object: Object3D, index: number) => void | Promise<void>) | undefined,
  ) {}

  /** The spare source, loaded once. */
  async source(): Promise<Loaded> {
    this.spare ??= await this.load();
    this.owned?.add(this.spare.source);
    return this.spare;
  }

  /** The spare source, for the first level load to take. */
  take(): Loaded | undefined {
    const taken = this.spare;
    this.spare = undefined;
    return taken;
  }

  takeBuilt(index: number): Uint8Array | undefined {
    const bytes = this.built.get(index);
    this.built.delete(index);
    return bytes;
  }

  /** Apply onLevel to a level's arriving object, freeing it if that fails. */
  async arrive(object: Object3D, index: number): Promise<Object3D> {
    try {
      this.owned?.add(object);
      await this.onLevel?.(object, index);
      return object;
    } catch (error) {
      this.owned?.delete(object);
      disposeRejected(object);
      throw error;
    }
  }

  /** The ladder is described: what loads from now on belongs to the levels' owners. */
  described(): void {
    this.owned = undefined;
  }

  /** Describing the ladder failed: free what it loaded. */
  fail(): void {
    for (const object of this.owned ?? []) disposeRejected(object);
    this.owned = undefined;
  }

  /** An owner was disposed: free what no level took. */
  readonly dispose = (): void => {
    const taken = this.take();
    if (taken) disposeTree(taken.source);
    this.built.clear();
  };
}

/** A loaded source and what loading it read. */
export interface Loaded {
  source: Object3D;
  provenance: Provenance;
}
