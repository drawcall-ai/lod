import type { ComputeNode, Node } from "three/webgpu";
import { Break, If, Loop, atomicAdd, atomicLoad, atomicStore, atomicSub, localId, storage, storageBarrier, uint, uvec4 } from "three/tsl";
import { PAGE_BITS, nodes, type PoolBuffers } from "./buffers.js";
import { PAGE, least, workgroups } from "./workgroup.js";

// The passes that walk every chunk slot of a page pool in one workgroup: freeing pages, handing them out, and listing
// those held (see index.ts for the order they run in).

type Nodes = ReturnType<typeof nodes>;

/** `body` for every chunk slot of `pool`, in a pass of one workgroup, its lanes taking every `PAGE`th slot. */
function eachSlot(pool: PoolBuffers, body: (slot: Node<"uint">) => void): void {
  Loop({ start: uint(0), end: uint(Math.ceil(pool.slots / PAGE)), type: "uint", condition: "<" }, ({ i }) => {
    const slot = i.mul(PAGE).add(localId.x).toVar();
    If(slot.lessThan(pool.slots), () => body(slot));
  });
}

/** Slot `slot`'s state, the generation, pages, instances and needed pages, and the first window its pages are listed from. */
function stateOf(n: Nodes, slot: Node<"uint">) {
  return { state: n.states.element(slot.mul(2)).toVar(), first: n.states.element(slot.mul(2).add(1)).x.toVar() };
}

/** Frees the pages of every chunk removed or changed since the last run: one workgroup. */
export function freePass(pool: PoolBuffers): ComputeNode {
  const n = nodes(pool);
  const top = n.stack.element(0);
  return workgroups(() => {
    eachSlot(pool, (slot) => {
      const source = n.sources.element(slot).toVar();
      const { state, first } = stateOf(n, slot);
      If(source.w.equal(0).or(state.x.notEqual(source.z)), () => {
        Loop({ start: uint(0), end: state.y, type: "uint", condition: "<" }, ({ i }) => {
          atomicStore(n.stack.element(atomicAdd(top, uint(1)).add(1)), n.table.element(first.add(i)));
        });
        n.states.element(slot.mul(2)).assign(uvec4(0));
      });
    });
  });
}

/**
 * Gives new chunks the pages their instances need, turning their window counts into where their instances start: one
 * workgroup. Under a short stack, which chunks get its last pages is a race.
 */
export function allocatePass(pool: PoolBuffers): ComputeNode {
  const n = nodes(pool);
  const top = n.stack.element(0);
  return workgroups(() => {
    eachSlot(pool, (slot) => {
      const source = n.sources.element(slot).toVar();
      const state = n.states.element(slot.mul(2)).toVar();
      If(source.w.notEqual(0).and(state.x.notEqual(source.z)), () => {
        const first = source.x;
        const instances = uint(0).toVar();
        Loop({ start: uint(0), end: source.y, type: "uint", condition: "<" }, ({ i }) => {
          const window = n.windows.element(first.add(i));
          const counted = window.toVar();
          window.assign(instances);
          instances.addAssign(counted);
        });
        const need = instances
          .add(PAGE - 1)
          .div(PAGE)
          .toVar();
        const held = uint(0).toVar();
        Loop({ start: uint(0), end: need, type: "uint", condition: "<" }, ({ i }) => {
          // The page under the top before taking it; none when the stack ran dry, its count wrapped past 0.
          const before = atomicSub(top, uint(1)).toVar();
          If(before.sub(1).greaterThanEqual(pool.pages), () => {
            atomicAdd(top, uint(1));
            Break();
          });
          n.table.element(first.add(i)).assign(atomicLoad(n.stack.element(before)));
          held.addAssign(1);
        });
        n.states.element(slot.mul(2)).assign(uvec4(source.z, held, least(instances, held.mul(PAGE)), need));
        n.states.element(slot.mul(2).add(1)).assign(uvec4(first, 0, 0, 0));
      });
    });
  });
}

/** Lists every page chunks hold, with its InstancedLod's row, for updateInstance to visit: one workgroup. */
export function occupyPass(pool: PoolBuffers): ComputeNode {
  const n = nodes(pool);
  const occupied = storage(pool.occupied, "uint", 0).toAtomic();
  return workgroups(() => {
    If(localId.x.equal(0), () => void atomicStore(occupied.element(0), uint(0)));
    storageBarrier();
    eachSlot(pool, (slot) => {
      const row = n.sources.element(slot).w.sub(1).toVar();
      const { state, first } = stateOf(n, slot);
      Loop({ start: uint(0), end: state.y, type: "uint", condition: "<" }, ({ i }) => {
        const entry = n.table.element(first.add(i)).bitOr(row.shiftLeft(PAGE_BITS));
        atomicStore(occupied.element(atomicAdd(occupied.element(0), uint(1)).add(1)), entry);
      });
    });
  });
}
