import { decodeMeshAsync, encodeMeshAsync } from "@drawcall/lod";
import type { CacheEntry } from "vitecache";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { Mesh, type Material, type Object3D } from "three/webgpu";
import type { Library } from "./materials.ts";

/** Asset-owned geometry; register its materials before either generating or decoding it. */
export async function cachedObject(
  entry: CacheEntry,
  library: Library,
  registered: readonly Material[],
  make: () => Object3D | Promise<Object3D>,
): Promise<Object3D> {
  const available = new Map(registered.map((material) => [library.key(material), material]));
  const requireMaterial = (key: string): Material => {
    const material = available.get(key);
    if (!material) throw new Error(`Asset did not register material ${key}`);
    return material;
  };
  let bytes = await entry.load();
  if (bytes === undefined) {
    const object = library.own(await make());
    const materials: Material[] = [];
    object.traverse((node) => {
      if (node instanceof Mesh) for (const material of [node.material].flat()) if (!materials.includes(material)) materials.push(material);
    });
    const keys = materials.map((material) => library.key(material));
    for (const key of keys) requireMaterial(key);
    bytes = zipSync({ keys: strToU8(JSON.stringify(keys)), geometry: await encodeMeshAsync(object, materials) }, { level: 0 });
    library.release(object);
    await entry.save(bytes);
  }
  // A computed object is drawn as it decodes, as a cached one is, so cold and warm runs draw alike.
  const files = unzipSync(bytes);
  if (!files.keys || !files.geometry) throw new Error("Incomplete geometry cache");
  const keys: unknown = JSON.parse(strFromU8(files.keys));
  if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string")) throw new Error("Invalid geometry material keys");
  return library.own(await decodeMeshAsync(files.geometry, keys.map(requireMaterial)));
}
