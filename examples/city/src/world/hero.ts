import * as THREE from "three/webgpu";
import { Lod, LodLoader, type LodLevel } from "@drawcall/lod";
import { cornPlant } from "../content/corn/index.ts";
import { ladybird, ladybirdMaterial } from "../content/ladybird.ts";
import { bundle, file, proceduralFiles } from "./cache.ts";
import { prepare, material, foliage } from "./corn/materials.ts";
import * as pixels from "./pixels.ts";
import type { Terrain } from "./terrain.ts";

const UP = new THREE.Vector3(0, 1, 0);

/** The seat and source geometry are authored only on a cache miss; materials are reconstructed on demand. */
export async function heroPlant(
  spot: { at: THREE.Vector3; yaw: number; seed: number },
  far: readonly LodLevel[],
  terrain: Terrain,
): Promise<{ hero: Lod; ladybird: Lod; anchors: { hero: THREE.Vector3; ladybird: THREE.Vector3 } }> {
  const at = new THREE.Vector3(spot.at.x, terrain.height(spot.at.x, spot.at.z), spot.at.z);
  const key = {
    ...proceduralFiles("src/world/hero.ts", { seed: spot.seed, at: at.toArray(), yaw: spot.yaw }, []),
    materials: { path: "src/world/corn/materials.ts" },
  };
  let detail: THREE.Object3D | undefined;
  const plantRequest = {
    source: async () => {
      await prepare();
      return (detail ??= cornPlant(spot.seed, { leafSegments: [192, 24] }));
    },
    material,
    key: { ...key, kind: { value: "hero" } },
    levels: [],
    restore: foliage,
  };
  const bugRequest = {
    source: async () => {
      const seat = leafSeat(await plantRequest.source());
      await bugMaterial("ladybird-elytra");
      const bug = ladybird();
      const holder = new THREE.Group();
      holder.position.copy(seat.point);
      holder.quaternion.setFromUnitVectors(UP, seat.normal);
      holder.add(bug);
      bug.rotation.y = seat.heading;
      holder.applyMatrix4(new THREE.Matrix4().compose(at, new THREE.Quaternion().setFromAxisAngle(UP, spot.yaw), new THREE.Vector3(1, 1, 1)));
      return holder;
    },
    key: { ...key, kind: { value: "ladybird" } },
    material: bugMaterial,
    levels: [],
  };
  const loader = new LodLoader();
  const [plant, bug] = await Promise.all([loader.loadLevelsAsync(plantRequest), loader.loadLevelsAsync(bugRequest)]);
  const source = plant[0],
    insectSource = bug[0];
  if (!source || !insectSource) throw new Error("Hero assets have no source level");
  const distant = far.map((level) => {
    const object = level.object.clone();
    object.castShadow = object.receiveShadow = false;
    return { object, maxPixels: level.maxPixels };
  });
  const hero = new Lod([source, ...distant, { object: new THREE.Group(), maxPixels: 1 }]);
  hero.name = "hero corn plant";
  hero.position.copy(at);
  hero.rotation.y = spot.yaw;
  const insect = new Lod([insectSource, { object: new THREE.Group(), maxPixels: 2 }]);
  insect.name = "ladybird";
  return { hero, ladybird: insect, anchors: { hero: at, ladybird: insectSource.object.position.clone() } };
}

/**
 * Where on `plant` (in its own space) the ladybird sits: the leaf vertex that faces most
 * squarely up, between 1 and 1.6 m high, near the midrib and a third of the way out.
 */
function leafSeat(plant: THREE.Object3D): { point: THREE.Vector3; normal: THREE.Vector3; heading: number } {
  const leaves = plant.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && !Array.isArray(c.material) && c.material.name === "corn-leaf");
  if (!leaves) throw new Error("corn plant has no leaf mesh");
  const position = leaves.geometry.getAttribute("position");
  const normal = leaves.geometry.getAttribute("normal");
  const uv = leaves.geometry.getAttribute("uv");
  let best = -1;
  let score = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const across = Math.abs(uv.getX(i) - 0.5);
    const along = uv.getY(i);
    if (y < 1 || y > 1.6 || across > 0.2 || across < 0.08 || along < 0.25 || along > 0.45) continue;
    const s = normal.getY(i);
    if (s > score) {
      score = s;
      best = i;
    }
  }
  if (best < 0) throw new Error("no leaf of the hero plant can seat the ladybird");
  const point = new THREE.Vector3().fromBufferAttribute(position, best);
  const up = new THREE.Vector3().fromBufferAttribute(normal, best).normalize();
  // face along the blade: toward the next vertex outward
  const ahead = new THREE.Vector3().fromBufferAttribute(position, Math.min(best + 25, position.count - 1)).sub(point);
  return { point, normal: up, heading: Math.atan2(ahead.x, ahead.z) };
}

let shell: Promise<THREE.Material> | undefined;

async function bugMaterial(name: string): Promise<THREE.Material | undefined> {
  if (name !== "ladybird-elytra") return ladybirdMaterial(name);
  return (shell ??= (async () => {
    let made: THREE.Material | undefined;
    const files = await bundle("ladybird-normal@1", { generator: { path: "src/content/ladybird.ts" } }, async () => {
      const material = ladybirdMaterial(name);
      if (!(material instanceof THREE.MeshPhysicalMaterial) || !(material.clearcoatNormalMap instanceof THREE.DataTexture))
        throw new Error("Ladybird has no normal pixels");
      const data: unknown = material.clearcoatNormalMap.image.data;
      if (!(data instanceof Uint8Array)) throw new Error("Ladybird normal map requires byte pixels");
      made = material;
      return { normal: await pixels.encode(data) };
    });
    const material = made ?? ladybirdMaterial(name, await pixels.decode(file(files, "normal"), 2048 * 2048 * 4));
    if (!material) throw new Error("Ladybird has no shell material");
    return material;
  })());
}
