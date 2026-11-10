import type { Object3D, Renderer } from "three/webgpu";
import { bakeMesh } from "../baked/index.js";
import { bakeImpostor } from "../impostor/bake/index.js";
import { ImpostorMesh } from "../impostor/mesh/index.js";
import { simplify } from "../simplify/index.js";
import { placeLike } from "../three.js";
import type { Derived } from "./level.js";

/**
 * Build the level `request` asks for from `source`, with the baked level's `low` shell and `interior` rooms if it names
 * them. `renderer` answers the renderer to bake with, asked for only by a bake that draws.
 */
export async function buildLevel(
  source: Object3D,
  request: Derived,
  { low, interior }: { low: Object3D | undefined; interior: Object3D | undefined },
  renderer: () => Promise<Renderer>,
): Promise<Object3D> {
  switch (request.type) {
    case "simplify":
      return simplify(source, { ratio: request.ratio });
    case "impostor": {
      const { type: _, draw: __, ...options } = request;
      const object = new ImpostorMesh(await bakeImpostor(source, await renderer(), options));
      object.name = `${source.name || "object"} impostor`;
      placeLike(object, source);
      return object;
    }
    case "baked": {
      const shell = low ? { low } : { ratio: request.ratio };
      const rooms = interior ? { interior, renderer: await renderer() } : {};
      return bakeMesh(source, { textureSize: request.textureSize, ...shell, ...rooms });
    }
  }
}
