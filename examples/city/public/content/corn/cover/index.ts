import type { GLTSSource } from "@drawcall/glts";
import { InstancedMesh, Mesh } from "three/webgpu";
import { bakeMesh, decodeBakedMeshAsync, encodeBakedMesh } from "@drawcall/lod";
import type { Library } from "../../materials.ts";
import { assetEntry } from "../../cache.ts";
import { dispose } from "../../dispose.ts";
import { plant } from "../plant.ts";
import { canopy, plantGroup, side } from "./shapes.ts";
import { BLOCK, layout, VARIANTS } from "../layout.ts";

/** The field's reusable canopy and walls own their bake, independent of the display ladder. */
export async function cover(source: GLTSSource, library: Library, design: number, axis: "" | "x" | "z"): Promise<Mesh> {
  const entry = assetEntry(source, "corn-cover@1", { design, axis });
  const bytes = await entry.load();
  if (bytes !== undefined) return decodeBakedMeshAsync(bytes);
  const [tasselled, bare] = await Promise.all([
    Promise.all(Array.from({ length: VARIANTS }, (_, variant) => plant(source, library, variant))),
    Promise.all(Array.from({ length: VARIANTS }, (_, variant) => plant(source, library, variant, false, false))),
  ]);
  const places = layout(design).filter((p) => !axis || (axis === "x" ? p.x : p.z) > BLOCK / 2 - 1);
  const plants = plantGroup({ tasselled, bare }, places);
  const low = new Mesh(axis ? side(axis) : canopy(1));
  try {
    const baked = await bakeMesh(plants, { low, textureSize: 256 });
    await entry.save(encodeBakedMesh(baked));
    return baked;
  } finally {
    plants.traverse((object) => {
      if (object instanceof InstancedMesh) object.dispose();
    });
    for (const plant of [...tasselled, ...bare]) library.release(plant);
    dispose(low);
  }
}
