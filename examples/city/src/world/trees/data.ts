import * as THREE from "three/webgpu";
import { cachedImpostor, decodeImpostorAsync, encodeImpostor, simplify, type Impostor } from "@drawcall/lod";
import { variants } from "../../content/models.ts";
import { bundle, file, model, modelFamily } from "../cache.ts";

export interface Species {
  id: string;
  groups?: string[][];
  ratio?: number;
  maxPixels: number;
  resolution?: number;
  frames?: number;
  cull?: number;
  /** Start with the terminal empty level; load the complete family before it can draw. */
  defer?: boolean;
}

export interface Tree {
  name: string;
  amplitude: number;
  impostor: Impostor;
}

/** The atlas and wind envelope are enough to draw the far tree without parsing its GLB. */
export async function trees(species: Species): Promise<{ trees: Tree[]; sources: () => Promise<THREE.Object3D[]> }> {
  const { id, groups, ratio, maxPixels, resolution, frames, cull } = species;
  let pending: Promise<THREE.Object3D[]> | undefined;
  const sources = () => {
    pending ??= variants(id, groups)
      .then((scans) => (ratio === undefined ? scans : Promise.all(scans.map((scan) => simplify(scan, { ratio })))))
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
  const files = await bundle(
    "trees@1",
    {
      ...modelFamily(id, groups, ratio),
      trees: { path: "src/world/trees.ts" },
      data: { path: "src/world/trees/data.ts" },
      settings: { value: { maxPixels, resolution: resolution ?? null, frames: frames ?? null, cull: cull ?? null } },
    },
    async () => {
      const files: Record<string, Uint8Array> = {};
      const metadata: { name: string; amplitude: number }[] = [];
      for (const [index, source] of (await sources()).entries()) {
        const impostor = await cachedImpostor(source, { layout: "hemi", maxPixels, resolution, frames }, model(id, index, groups, ratio));
        const box = new THREE.Box3().setFromObject(source);
        metadata.push({ name: source.name, amplitude: (box.max.y - box.min.y) * 0.025 });
        files[`${index}.ktx2`] = encodeImpostor(impostor);
      }
      files["trees.json"] = new TextEncoder().encode(JSON.stringify(metadata));
      return files;
    },
  );
  const value: unknown = JSON.parse(new TextDecoder().decode(file(files, "trees.json")));
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${id}: invalid cached tree variants`);
  const metadata = value.map((row: unknown) => {
    if (
      typeof row !== "object" ||
      row === null ||
      !("name" in row) ||
      typeof row.name !== "string" ||
      !("amplitude" in row) ||
      typeof row.amplitude !== "number" ||
      !Number.isFinite(row.amplitude) ||
      row.amplitude < 0
    )
      throw new Error(`${id}: invalid cached tree metadata`);
    return { name: row.name, amplitude: row.amplitude };
  });
  const trees = await Promise.all(metadata.map(async (row, index) => ({ ...row, impostor: await decodeImpostorAsync(file(files, `${index}.ktx2`)) })));
  return { trees, sources };
}
