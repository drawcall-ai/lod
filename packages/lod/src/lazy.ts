import { Box3, Object3D } from "three/webgpu";
import { disposeTree } from "./dispose.js";
import { isObject3D, sameClass } from "./three.js";

export interface LazyLevelOptions {
  /** Known switch height; Infinity for the source level. */
  maxPixels: number;
  /** Bounds of the returned subtree in this level's space, excluding the placeholder's transform. */
  box: Box3;
}

type Factory = () => Promise<Object3D>;

interface Deferred {
  load: Factory;
  promise?: Promise<Object3D>;
  object?: Object3D;
  error?: Error;
}

/** A deferred level whose fetch and decode are shared across clones. */
export class LazyLevel extends Object3D {
  readonly isLazyLevel = true;
  readonly box: Box3;
  maxPixels: number;
  private source: Deferred;

  constructor(load: Factory, { maxPixels, box }: LazyLevelOptions) {
    super();
    if (!(maxPixels > 0)) throw new Error("LazyLevel: maxPixels must be positive (Infinity for the source)");
    if (box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) throw new Error("LazyLevel: box must be finite and nonempty");
    this.maxPixels = maxPixels;
    this.box = box.clone();
    this.source = { load };
  }

  /** @internal Owners share decoding while keeping separate residency. */
  get object(): Object3D | undefined {
    return this.source.object;
  }

  get promise(): Promise<Object3D> | undefined {
    return this.source.promise;
  }

  get error(): Error | undefined {
    return this.source.error;
  }

  /** Fetch and decode once, shared by every clone; a failed load remains failed. */
  load(): Promise<Object3D> {
    const source = this.source;
    source.promise ??= Promise.resolve()
      .then(source.load)
      .then((object) => {
        if (!isObject3D(object)) throw new Error("LazyLevel: load must return an Object3D");
        source.object = object;
        return object;
      })
      .catch((error: unknown) => {
        source.error = error instanceof Error ? error : new Error("LazyLevel: load failed", { cause: error });
        throw source.error;
      });
    return source.promise;
  }

  override copy(source: LazyLevel): this {
    super.copy(source, false);
    this.source = source.source;
    this.box.copy(source.box);
    this.maxPixels = source.maxPixels;
    return this;
  }

  override clone(): this {
    const clone = new LazyLevel(this.source.load, this).copy(this);
    if (!sameClass(this, clone)) throw new Error("LazyLevel.clone: a subclass must override clone");
    return clone;
  }

  /** Clones share resources; dispose only once no clone draws. */
  dispose(): void {
    if (this.source.object) disposeTree(this.source.object);
    else void this.source.promise?.then(disposeTree, () => {});
  }
}
