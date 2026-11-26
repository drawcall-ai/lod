import type { Object3D } from "three/webgpu";
import type { RenderItem } from "three/src/renderers/common/Renderer.js";

// A renderer and a .glts asset can import separate copies of the library.
export const levelOrder = Symbol.for("@drawcall/lod.levelOrder");

function order(object: (Object3D & { [levelOrder]?: number }) | null, id: number | null): number {
  return object?.[levelOrder] ?? Number(id);
}

/** Pass to renderer.setOpaqueSort to draw finer LOD levels first at equal group order, render order and depth. */
export function opaqueSort(a: RenderItem, b: RenderItem): number {
  return (
    Number(a.groupOrder) - Number(b.groupOrder) ||
    Number(a.renderOrder) - Number(b.renderOrder) ||
    Number(a.z) - Number(b.z) ||
    order(a.object, a.id) - order(b.object, b.id) ||
    Number(a.id) - Number(b.id)
  );
}
