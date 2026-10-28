import * as THREE from "three/webgpu";
import { foliageLevels } from "../../content/foliage.ts";
import { dryLeafMaterial, huskMaterial, leafMaterial, LEAF_FOLIAGE, LEAF_SIZE } from "../../content/corn/leaf.ts";
import { tissue } from "../../content/corn/tissue.ts";
import { bundle, file } from "../cache.ts";
import * as pixels from "../pixels.ts";

const leaves = { "corn-leaf": leafMaterial, "corn-leaf-dry": dryLeafMaterial, "corn-husk": huskMaterial };
const pending = new Map<string, Promise<THREE.Material>>();

/** Generated leaf maps are shared lossless pixel inputs, independent of every plant's geometry. */
export async function material(name: string): Promise<THREE.Material | undefined> {
  if (name === "corn-tissue") return tissue();
  const make = Object.entries(leaves).find(([key]) => key === name)?.[1];
  if (!make) return undefined;
  let loaded = pending.get(name);
  if (!loaded) {
    loaded = (async () => {
      let made: THREE.Material | undefined;
      const files = await bundle(
        "corn-leaf@1",
        {
          generator: { path: "src/content/corn/leaf.ts" },
          random: { path: "src/content/random.ts" },
          cache: { path: "src/world/corn/materials.ts" },
          name: { value: name },
        },
        async () => {
          const leaf = make();
          made = leaf;
          const color = leaf.map,
            normal = leaf.normalMap;
          if (!(color instanceof THREE.DataTexture) || !(normal instanceof THREE.DataTexture)) throw new Error("Corn leaf has no pixel maps");
          const [colorBytes, normalBytes] = await Promise.all([pixels.encode(bytes(color)), pixels.encode(bytes(normal))]);
          return { color: colorBytes, normal: normalBytes };
        },
      );
      if (made) return made;
      const size = LEAF_SIZE * LEAF_SIZE * 4;
      const [color, normal] = await Promise.all([pixels.decode(file(files, "color"), size), pixels.decode(file(files, "normal"), size)]);
      return make({ color, normal });
    })();
    pending.set(name, loaded);
  }
  return loaded;
}

export async function prepare(): Promise<void> {
  await Promise.all(Object.keys(leaves).map(material));
}

function bytes(texture: THREE.DataTexture): Uint8Array {
  const data: unknown = texture.image.data;
  if (!(data instanceof Uint8Array)) throw new Error("Corn leaf texture requires byte pixels");
  return data;
}

export function foliage(root: THREE.Object3D): void {
  foliageLevels(root, LEAF_FOLIAGE);
}
