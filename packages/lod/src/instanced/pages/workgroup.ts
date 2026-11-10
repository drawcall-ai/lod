import type { ComputeNode, Node } from "three/webgpu";
import { Fn, code, computeKernel, localId, uint, uvec2, wgslFn } from "three/tsl";

// What the page passes share: workgroups of `PAGE` lanes, and ranking lanes within one.

/** Instances per page, and lanes per workgroup of the passes over pages: updateInstance runs one workgroup per page. */
export const PAGE = 256;

/**
 * A pass of workgroups of `PAGE` lanes: one, unless dispatched indirectly. A dispatch size rather than a count: a count
 * adds an early return, which a barrier may not follow.
 */
export function workgroups(body: () => void): ComputeNode {
  const node = computeKernel(Fn(body)(), [PAGE]);
  node.dispatchSize = [1, 1, 1];
  return node;
}

/** The lesser of two uints. */
export const least = (a: Node<"uint">, b: Node<"uint">) => a.lessThan(b).select(a, b);

/**
 * Across a workgroup of `PAGE` lanes: how many lanes before this one are `chosen`, and how many are in all. Every lane
 * calls it, outside any branch: it waits for the others. Hillis–Steele: after the step of width w, each lane holds the
 * sum of the 2w lanes up to it.
 */
const rankOf = wgslFn(
  `fn lodRank(lane: u32, chosen: u32) -> vec2u {
  lodRankSums[lane] = chosen;
  for (var width = 1u; width < ${PAGE}u; width *= 2u) {
    workgroupBarrier();
    var sum = lodRankSums[lane];
    if (lane >= width) { sum += lodRankSums[lane - width]; }
    workgroupBarrier();
    lodRankSums[lane] = sum;
  }
  workgroupBarrier();
  return vec2u(lodRankSums[lane] - chosen, lodRankSums[${PAGE - 1}]);
}`,
  [code(`var<workgroup> lodRankSums: array<u32, ${PAGE}>;`)],
);

export function rank(chosen: Node<"bool">) {
  const ranked = uvec2(0).toVar();
  ranked.assign(rankOf({ lane: localId.x, chosen: chosen.select(uint(1), uint(0)) }));
  return { before: ranked.x, total: ranked.y };
}
