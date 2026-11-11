import { Box3, InstancedBufferAttribute, type Sphere, type Vector3 } from "three/webgpu";
import {
  InstancedLodCpuChunk,
  InstancedLodGpuChunk,
  measureChunk,
  type ChunkState,
  type InstancedLodChunk,
  type InstancedLodChunkParameters,
  type InstancedLodCpuChunkParameters,
  type LevelAt,
} from "./chunk.js";
import type { Cull } from "./cull.js";
import { Mirror } from "./mirror.js";
import type { InstancePagePool } from "./pages/index.js";
import type { ChunkSource } from "./pages/chunk.js";
import { MAX_SURVIVOR_SCALE } from "./measure.js";

/** One chunk the set holds: its pool slot and its state. */
interface Held {
  slot: number;
  state: ChunkState;
}

/** A CPU attribute's mirror, shared by every chunk reading the attribute. */
interface Shared {
  mirror: Mirror;
  users: Set<InstancedLodCpuChunk>;
}

const grown = new Box3();

/**
 * The chunks of one InstancedLod: their pool slots, the mirrors the pool reads CPU attributes through, and their
 * bounds, which load levels and cull the level meshes.
 */
export class ChunkSet {
  private readonly held = new Map<InstancedLodChunk, Held>();
  private readonly mirrors = new Map<InstancedBufferAttribute, Shared>();
  /** Bumped whenever a chunk was added, removed or re-measured: what `heights` reads changed. */
  version = 0;

  /**
   * Chunks over `pool`, for the InstancedLod sorting as row `row`, whose instances `bounds` bounds in the InstancedLod's
   * space; `reach` tells how far from an instance's origin, in its space, every level and its sway reach, and `levelAt`
   * is what a CPU chunk's getLevelAt asks.
   */
  constructor(
    private readonly pool: InstancePagePool,
    private readonly row: number,
    private readonly bounds: { readonly sphere: Sphere; readonly box: Box3 },
    private readonly reach: () => number,
    private readonly levelAt: LevelAt,
  ) {}

  get size(): number {
    return this.held.size;
  }

  /** The chunks, in the order they were added. */
  keys(): IterableIterator<InstancedLodChunk> {
    return this.held.keys();
  }

  /** The pool slots of the chunks. */
  slots(): number[] {
    return [...this.held.values()].map(({ slot }) => slot);
  }

  /**
   * What makes chunks of their own with every chunk's instances, their attributes copied (see `InstancedLod.copy`). A
   * GPU chunk cannot be copied: its instances live on the GPU.
   */
  copies(): InstancedLodCpuChunkParameters[] {
    return [...this.held.keys()].map((chunk) => {
      if (!(chunk instanceof InstancedLodCpuChunk)) throw new Error("InstancedLod.copy: a GPU chunk's instances live on the GPU and cannot be copied");
      const { instanceMatrix, instanceColor, start, count } = chunk;
      return { instanceMatrix: copyOf(instanceMatrix), instanceColor: instanceColor ? copyOf(instanceColor) : undefined, start, count };
    });
  }

  /** Hold `parameters`' instances as a chunk, copied into the pool at its next run. */
  add(parameters: InstancedLodChunkParameters): InstancedLodChunk {
    const state: ChunkState = { originBox: new Box3(), minScale: 0, maxScale: 0, boundingBox: new Box3(), held: false };
    const chunk = parameters.instance !== undefined ? new InstancedLodGpuChunk(parameters, state) : new InstancedLodCpuChunk(parameters, state, this.levelAt);
    const slot = this.pool.add({ source: this.sourceOf(chunk), start: chunk.start, count: chunk.count, row: this.row });
    state.held = true;
    this.held.set(chunk, { slot, state });
    this.version++;
    return chunk;
  }

  /** Let go of `chunk`; its pages return to the pool at its next run. */
  remove(chunk: InstancedLodChunk): void {
    const held = this.held.get(chunk);
    if (!held) throw new Error("InstancedLod: the chunk is not one of its chunks");
    this.pool.remove(held.slot);
    held.state.held = false;
    this.held.delete(chunk);
    this.version++;
    if (!(chunk instanceof InstancedLodCpuChunk)) return;
    for (const attribute of [chunk.instanceMatrix, chunk.instanceColor]) {
      const shared = attribute && this.mirrors.get(attribute);
      if (!shared) continue;
      shared.users.delete(chunk);
      if (shared.users.size > 0) continue;
      shared.mirror.dispose();
      this.mirrors.delete(shared.mirror.source);
    }
  }

  /**
   * Take in the CPU attributes' edits, those whose versions moved, for every chunk reading them: re-measured, and
   * copied into the pool again at its next run. Whether any changed.
   */
  refresh(): boolean {
    const changed = new Set<InstancedLodChunk>();
    for (const { mirror, users } of this.mirrors.values()) {
      if (!mirror.refresh()) continue;
      for (const chunk of users) {
        if (chunk.instanceMatrix === mirror.source) measureChunk(chunk, this.heldOf(chunk).state);
        changed.add(chunk);
      }
    }
    for (const chunk of changed) this.pool.change(this.heldOf(chunk).slot);
    if (changed.size > 0) this.version++;
    return changed.size > 0;
  }

  /** Bound every chunk, its box (see `InstancedLodChunk.boundingBox`), and all of them, survivors grown by up to `grow`. */
  bound(grow: number): void {
    const { sphere, box } = this.bounds;
    const reach = this.reach();
    box.makeEmpty();
    for (const { state } of this.held.values()) {
      if (state.originBox.isEmpty()) {
        state.boundingBox.makeEmpty();
        continue;
      }
      state.boundingBox.copy(state.originBox).expandByScalar(reach * state.maxScale);
      box.union(grown.copy(state.originBox).expandByScalar(reach * state.maxScale * grow));
    }
    if (box.isEmpty()) sphere.makeEmpty();
    else box.getBoundingSphere(sphere);
  }

  /**
   * The heights on a screen of `scale` from `eye`, both in the InstancedLod's space, that each chunk's instances can
   * have, `source` an instance's source sphere: its shortest instance at its farthest, its tallest at its nearest.
   */
  *heights(source: Sphere, eye: Vector3, scale: number, ortho: boolean, cull: Cull | null): Generator<[number, number]> {
    const grow = cull?.survivors ? MAX_SURVIVOR_SCALE : 1;
    const diameter = 2 * source.radius * scale;
    for (const { state } of this.held.values()) {
      const { originBox, minScale, maxScale } = state;
      if (originBox.isEmpty() || maxScale === 0) continue;
      if (cull && originBox.distanceToPoint(cull.eye) >= cull.far) continue;
      const shortest = diameter * minScale;
      const tallest = diameter * maxScale * grow;
      if (ortho) {
        yield [shortest, tallest];
        continue;
      }
      // An instance's centre lies this far from its origin.
      const offset = source.center.length() * maxScale * grow;
      const near = Math.max(originBox.distanceToPoint(eye) - offset, 1e-6);
      const far = farthest(originBox, eye) + offset;
      yield [shortest / far, tallest / near];
    }
  }

  /** Free the chunks' slots and release the mirrors; the chunks no longer find their levels. */
  dispose(): void {
    for (const { slot, state } of this.held.values()) {
      this.pool.remove(slot);
      state.held = false;
    }
    this.held.clear();
    this.version++;
    for (const { mirror } of this.mirrors.values()) mirror.dispose();
    this.mirrors.clear();
  }

  /** What the pool reads `chunk`'s instances from: the app's function, or mirrors of its attributes. */
  private sourceOf(chunk: InstancedLodCpuChunk | InstancedLodGpuChunk): ChunkSource {
    if (chunk instanceof InstancedLodGpuChunk) return chunk.instance;
    const { instanceMatrix, instanceColor } = chunk;
    return { matrices: this.mirror(instanceMatrix, chunk).attribute, colors: instanceColor && this.mirror(instanceColor, chunk).attribute };
  }

  /** The mirror of `attribute`, which `chunk` reads too. */
  private mirror(attribute: InstancedBufferAttribute, chunk: InstancedLodCpuChunk): Mirror {
    const shared = this.mirrors.get(attribute) ?? { mirror: new Mirror(attribute), users: new Set() };
    this.mirrors.set(attribute, shared);
    shared.users.add(chunk);
    return shared.mirror;
  }

  private heldOf(chunk: InstancedLodChunk): Held {
    const held = this.held.get(chunk);
    if (!held) throw new Error("InstancedLod: a mirror's chunk is not one of its chunks");
    return held;
  }
}

/** The distance from `point` to the farthest point of `box`. */
function farthest(box: Box3, point: Vector3): number {
  const { min, max } = box;
  return Math.hypot(
    Math.max(Math.abs(point.x - min.x), Math.abs(point.x - max.x)),
    Math.max(Math.abs(point.y - min.y), Math.abs(point.y - max.y)),
    Math.max(Math.abs(point.z - min.z), Math.abs(point.z - max.z)),
  );
}

/** A CPU attribute of its own with `attribute`'s instances. */
function copyOf(attribute: InstancedBufferAttribute): InstancedBufferAttribute {
  return new InstancedBufferAttribute(attribute.array.slice(), attribute.itemSize);
}
