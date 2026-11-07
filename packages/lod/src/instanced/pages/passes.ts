import { type ComputeNode, type IndirectStorageBufferAttribute, Matrix4, type Node, StorageBufferAttribute, type StorageInstancedBufferAttribute } from "three/webgpu";
import { Break, If, Loop, atomicAdd, atomicLoad, atomicStore, atomicSub, localId, mat4, storage, storageBarrier, uint, uvec4, workgroupId } from "three/tsl";
import type { Records } from "./records.js";
import { PAGE, least, rank, workgroups } from "./workgroup.js";

// The passes that take GPU chunks in, in the order they run (see index.ts).

/** The matrix of a place without an instance: scale 0 draws nothing. */
const nothing = new Matrix4().multiplyScalar(0);

/** A page pool's buffers, which its passes share. */
export interface Pool {
  readonly pages: number;
  readonly slots: number;
  /** The page ids a slot can hold, and the windows of `PAGE` records its chunk can have. */
  readonly perSlot: number;
  /** The most records a chunk holds. */
  readonly capacity: number;
  /** The free page count, then the free page ids. */
  readonly stack: StorageBufferAttribute;
  /** Per slot, the ids of the pages it holds. */
  readonly table: StorageBufferAttribute;
  /** Per slot and window of its records, the window's survivors, then where they start among the chunk's instances. */
  readonly windows: StorageBufferAttribute;
  /** Per slot, written by the CPU: whether it holds a chunk, the chunk's first record, its counter and generation. */
  readonly sources: StorageBufferAttribute;
  /** Per slot, written by the GPU: the generation it got to, its pages, its instances and the pages it needs. */
  readonly states: StorageBufferAttribute;
  /** The windows of records to take in this frame: first record, slot, records, window. */
  readonly jobs: StorageBufferAttribute;
  /** One workgroup per job. */
  readonly jobDispatch: IndirectStorageBufferAttribute;
  /** The pages handed out this frame. */
  readonly fresh: StorageBufferAttribute;
  /** One workgroup per fresh page. */
  readonly freshDispatch: IndirectStorageBufferAttribute;
  /** The pages chunks hold. */
  readonly occupied: StorageBufferAttribute;
  /** One workgroup per occupied page. */
  readonly occupiedDispatch: IndirectStorageBufferAttribute;
  /** The app's record counts. */
  readonly counts: StorageBufferAttribute | StorageInstancedBufferAttribute;
}

/** The selection's buffers the copy pass writes. */
export interface Targets {
  readonly matrices: StorageInstancedBufferAttribute;
  readonly keeps: StorageBufferAttribute;
  readonly colors: StorageInstancedBufferAttribute | null;
}

/** `pool`'s buffers as one pass uses them: a node each, since a pass may not bind a buffer it writes twice. */
function nodes(pool: Pool) {
  const { slots, perSlot, pages, counts } = pool;
  const first = (dispatch: IndirectStorageBufferAttribute) => storage(dispatch, "uint", 3).toAtomic().element(0);
  return {
    stack: storage(pool.stack, "uint", pages + 1).toAtomic(),
    table: storage(pool.table, "uint", slots * perSlot),
    windows: storage(pool.windows, "uint", slots * perSlot),
    sources: storage(pool.sources, "uvec4", slots).toReadOnly(),
    states: storage(pool.states, "uvec4", slots),
    jobs: storage(pool.jobs, "uvec4", slots * perSlot),
    jobCount: first(pool.jobDispatch),
    fresh: storage(pool.fresh, "uint", pages),
    freshCount: first(pool.freshDispatch),
    occupied: storage(pool.occupied, "uint", pages),
    occupiedCount: first(pool.occupiedDispatch),
    counts: storage(counts, "uint", counts.count).toReadOnly(),
  };
}

type Nodes = ReturnType<typeof nodes>;

/** `body` for every chunk slot, in a pass of one workgroup, its lanes taking every `PAGE`th slot. */
function eachSlot(pool: Pool, body: (slot: Node<"uint">) => void): void {
  Loop({ start: uint(0), end: uint(Math.ceil(pool.slots / PAGE)), type: "uint", condition: "<" }, ({ i }) => {
    const slot = i.mul(PAGE).add(localId.x).toVar();
    If(slot.lessThan(pool.slots), () => body(slot));
  });
}

/** `body` for `slot` if it holds a chunk added since the last run, with the chunk's source and record count. */
function ifNew(pool: Pool, n: Nodes, slot: Node<"uint">, body: (source: Node<"uvec4">, records: Node<"uint">) => void): void {
  const source = n.sources.element(slot).toVar();
  const state = n.states.element(slot).toVar();
  If(source.x.equal(1).and(state.x.notEqual(source.w)), () => body(source, least(n.counts.element(source.z), uint(pool.capacity)).toVar()));
}

/** The windows of `PAGE` records that `records` make. */
const windowsOf = (records: Node<"uint">) => records.add(PAGE - 1).div(PAGE);

/** Frees the pages of removed chunks, then lists new chunks' records as jobs: one workgroup. */
export function listPass(pool: Pool): ComputeNode {
  const { perSlot } = pool;
  const n = nodes(pool);
  const top = n.stack.element(0);
  return workgroups(() => {
    If(localId.x.equal(0), () => void atomicStore(n.jobCount, uint(0)));
    // A removed chunk, or one replaced since the last run, frees every page it held.
    eachSlot(pool, (slot) => {
      const source = n.sources.element(slot).toVar();
      const state = n.states.element(slot).toVar();
      If(source.x.equal(0).or(state.x.notEqual(source.w)), () => {
        Loop({ start: uint(0), end: state.y, type: "uint", condition: "<" }, ({ i }) => {
          atomicStore(n.stack.element(atomicAdd(top, uint(1)).add(1)), n.table.element(slot.mul(perSlot).add(i)));
        });
        n.states.element(slot).assign(uvec4(0));
      });
    });
    storageBarrier();
    eachSlot(pool, (slot) =>
      ifNew(pool, n, slot, (source, records) => {
        Loop({ start: uint(0), end: windowsOf(records), type: "uint", condition: "<" }, ({ i }) => {
          const window = uvec4(source.y.add(i.mul(PAGE)), slot, least(records.sub(i.mul(PAGE)), uint(PAGE)), i);
          n.jobs.element(atomicAdd(n.jobCount, uint(1))).assign(window);
        });
      }),
    );
  });
}

/** Counts each job's survivors: one workgroup per job. */
export function countPass(pool: Pool, records: Records): ComputeNode {
  const { jobs, windows } = nodes(pool);
  return workgroups(() => {
    const job = jobs.element(workgroupId.x).toVar();
    const { total } = rank(records.instanceAt(job).keep.lessThan(1));
    If(localId.x.equal(0), () => void windows.element(job.y.mul(pool.perSlot).add(job.w)).assign(total));
  });
}

/**
 * Gives new chunks the pages their survivors need, turning their window counts into where their survivors start, and
 * lists the pages handed out: one workgroup. Under a short stack, which chunks get its last pages is a race.
 */
export function allocatePass(pool: Pool): ComputeNode {
  const { perSlot, pages } = pool;
  const n = nodes(pool);
  const top = n.stack.element(0);
  return workgroups(() => {
    If(localId.x.equal(0), () => void atomicStore(n.freshCount, uint(0)));
    storageBarrier();
    eachSlot(pool, (slot) =>
      ifNew(pool, n, slot, (source, records) => {
        const survivors = uint(0).toVar();
        Loop({ start: uint(0), end: windowsOf(records), type: "uint", condition: "<" }, ({ i }) => {
          const window = n.windows.element(slot.mul(perSlot).add(i));
          const counted = window.toVar();
          window.assign(survivors);
          survivors.addAssign(counted);
        });
        const need = windowsOf(survivors).toVar();
        const held = uint(0).toVar();
        Loop({ start: uint(0), end: need, type: "uint", condition: "<" }, ({ i }) => {
          // The page under the top before taking it; none when the stack ran dry, its count wrapped past 0.
          const before = atomicSub(top, uint(1)).toVar();
          If(before.sub(1).greaterThanEqual(pages), () => {
            atomicAdd(top, uint(1));
            Break();
          });
          const page = atomicLoad(n.stack.element(before)).toVar();
          n.table.element(slot.mul(perSlot).add(i)).assign(page);
          n.fresh.element(atomicAdd(n.freshCount, uint(1))).assign(page);
          held.addAssign(1);
        });
        n.states.element(slot).assign(uvec4(source.w, held, least(survivors, held.mul(PAGE)), need));
      }),
    );
  });
}

/** Lists every page chunks hold, for the selection to visit: one workgroup. */
export function occupyPass(pool: Pool): ComputeNode {
  const n = nodes(pool);
  return workgroups(() => {
    If(localId.x.equal(0), () => void atomicStore(n.occupiedCount, uint(0)));
    storageBarrier();
    eachSlot(pool, (slot) => {
      Loop({ start: uint(0), end: n.states.element(slot).y, type: "uint", condition: "<" }, ({ i }) => {
        n.occupied.element(atomicAdd(n.occupiedCount, uint(1))).assign(n.table.element(slot.mul(pool.perSlot).add(i)));
      });
    });
  });
}

/**
 * Writes each job's survivors into their places in their chunk's pages, and clears the places past a chunk's last
 * instance on its pages, which then draw nothing: one workgroup per job.
 */
export function copyPass(pool: Pool, records: Records, targets: Targets): ComputeNode {
  const capacity = pool.pages * PAGE;
  const { jobs, windows, table, states } = nodes(pool);
  const matrices = storage(targets.matrices, "mat4", capacity);
  const keeps = storage(targets.keeps, "float", capacity);
  if (!targets.colors) throw new Error("InstancedLod: GPU chunks need the selection's colours");
  const colors = storage(targets.colors, "vec4", capacity);
  return workgroups(() => {
    const job = jobs.element(workgroupId.x).toVar();
    const base = job.y.mul(pool.perSlot);
    /** Where `place` among the chunk's instances lies in the pool. */
    const index = (place: Node<"uint">) => table.element(base.add(place.div(PAGE))).mul(PAGE).add(place.mod(PAGE)).toVar();
    const state = states.element(job.y).toVar();
    const instance = records.instanceAt(job);
    const survives = instance.keep.lessThan(1);
    const { before } = rank(survives);
    const place = windows.element(base.add(job.w)).add(before).toVar();
    // Survivors past the pages the chunk got are left out.
    If(survives.and(place.lessThan(state.y.mul(PAGE))), () => {
      const at = index(place);
      matrices.element(at).assign(instance.matrix);
      colors.element(at).assign(instance.color);
      keeps.element(at).assign(instance.keep);
    });
    If(job.w.equal(0), () => {
      const tail = state.z.add(localId.x).toVar();
      If(tail.lessThan(state.y.mul(PAGE)), () => void matrices.element(index(tail)).assign(mat4(nothing)));
    });
  });
}

/**
 * Clears what a view remembers drawing at the places on the pages handed out this frame, so that a new instance never
 * keeps drawing the level its place's last one showed: one workgroup per fresh page, for the view whose buffer `shown`
 * is set to.
 */
export function clearPass(pool: Pool) {
  const { fresh } = nodes(pool);
  const shown = storage(new StorageBufferAttribute(new Uint32Array(1), 1), "uint", 0);
  const pass = workgroups(() => void shown.element(fresh.element(workgroupId.x).mul(PAGE).add(localId.x)).assign(0));
  return { pass, shown };
}
