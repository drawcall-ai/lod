// Realistic test cases as `.glts` files: CC0 Poly Haven scans and procedural ez-tree
// trees at game-realistic triangle budgets, instead of the low-poly Quaternius set.
// Downloads the 1k glTFs next to each script into public/cases/<id>/ (git-ignored).
//
//   npx tsx scripts/cases.ts
//
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const out = new URL("../public/cases/", import.meta.url);

interface Scan {
  /** Poly Haven asset id */
  asset: string;
  /** the one variant (root node) to keep when the file holds several */
  keep?: string;
}
/** A single GLB from elsewhere (Draco-compressed). */
interface Remote {
  url: string;
  file: string;
}
interface Tree {
  /** ez-tree preset */
  preset: string;
  seed: number;
}
export const CASES: Record<string, { why: string } & (Scan | Tree | Remote)> = {
  oak: { why: "broadleaf card tree, ~22k tris (ez-tree Oak Large)", preset: "Oak Large", seed: 3 },
  ash: { why: "broadleaf card tree, ~20k tris (ez-tree Ash Medium)", preset: "Ash Medium", seed: 5 },
  spruce: { why: "conifer card tree, ~19k tris (ez-tree Pine Large)", preset: "Pine Large", seed: 7 },
  quiver: { why: "scanned aloe tree, solid, 82k tris", asset: "quiver_tree_02" },
  shrub: { why: "scanned shrub, alpha cards, 7.6k tris", asset: "shrub_02", keep: "shrub_02_a" },
  rooibos: { why: "scanned bush, alpha cards, 13k tris", asset: "wild_rooibos_bush", keep: "wild_rooibos_bush_a" },
  fern02: { why: "scanned fern, 2.4k tris", asset: "fern_02", keep: "fern_02_b" },
  boulder: { why: "photoscanned boulder, 66k tris", asset: "boulder_01" },
  rock07: { why: "scanned rock, 15k tris", asset: "rock_07" },
  cliffstone: { why: "tall scanned boulder, 98k tris", asset: "namaqualand_boulder_02" },
  moonrock: { why: "scanned rock for the asteroid belt, 10k tris (its LOD0)", asset: "moon_rock_01", keep: "moon_rock_01_LOD0" },
  car: { why: "covered car, 12.6k tris: a non-uniform prop", asset: "covered_car" },
  barrel: { why: "barrel, 2.7k tris: a small solid prop", asset: "Barrel_01" },
  streetlamp: { why: "street lamp, 20k tris: tall, thin, glass", asset: "street_lamp_02" },
  grass: { why: "scanned grass clump, alpha cards, 6.4k tris", asset: "grass_medium_01", keep: "grass_medium_01_large_a_LOD0" },
  // Smithsonian 3D (the licence of this scan could not be confirmed; local benchmarking only).
  mansion: {
    why: "Carnegie Mansion exterior scan, 204k tris: a building",
    url: "https://3d-api.si.edu/content/document/3d_package:5010a19c-2f7f-4325-b43c-bebe6711b473/cooper-hewitt-exterior-med.glb",
    file: "cooper-hewitt-exterior-med.glb",
  },
};

const curl = async (url: string) => {
  const response = await fetch(url, { headers: { "User-Agent": "drawcall-impostor-lab" } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
};
const exists = (file: URL) => stat(file).then(() => true, () => false);

/** Shared by every case: foliage as cutout (games never blend it), meshes cast shadows. */
const PREPARE = `
function prepare(root) {
  root.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = node.receiveShadow = true;
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      if (material.transparent && material.map) {
        material.transparent = false;
        material.alphaTest = 0.5;
        material.depthWrite = true;
      }
  });
}
`;

function scanScript(id: string, file: string, keep?: string): string {
  return `// ${id}: Poly Haven ${file} (CC0), 1k textures.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadingManager, scene } from "@drawcall/glts";
${PREPARE}
const gltf = await new GLTFLoader(loadingManager).loadAsync(new URL("./${file}", import.meta.url).href);
let root = gltf.scene;
${keep ? `root = gltf.scene.getObjectByName(${JSON.stringify(keep)});
root.removeFromParent();
// Variants are laid out side by side; bring this one to the origin.
root.position.x = root.position.z = 0;` : ""}
prepare(root);
scene.add(root);
`;
}

function remoteScript(id: string, file: string): string {
  return `// ${id}: ${file} (Smithsonian 3D, Draco).
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadingManager, scene } from "@drawcall/glts";
${PREPARE}
const draco = new DRACOLoader(loadingManager).setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
const gltf = await new GLTFLoader(loadingManager).setDRACOLoader(draco).loadAsync(new URL("./${file}", import.meta.url).href);
draco.dispose();
prepare(gltf.scene);
scene.add(gltf.scene);
`;
}

function treeScript(id: string, preset: string, seed: number): string {
  return `// ${id}: ez-tree "${preset}" (MIT), seed ${seed}, generated at load.
import * as THREE from "three";
import { Tree } from "@dgreenheck/ez-tree@1.1.0";
import { scene } from "@drawcall/glts";
${PREPARE}
const tree = new Tree();
tree.loadPreset(${JSON.stringify(preset)});
tree.options.seed = ${seed};
tree.generate();
// Bundled textures decode asynchronously; the asset is ready when they are.
const maps = [];
tree.traverse((node) => {
  if (!node.isMesh) return;
  const phong = node.material;
  for (const key of ["map", "normalMap", "aoMap"]) if (phong[key]) maps.push(phong[key]);
  // The PBR pipeline a game would use: same maps on MeshStandardMaterial.
  node.material = new THREE.MeshStandardMaterial({
    color: phong.color, map: phong.map, normalMap: phong.normalMap, aoMap: phong.aoMap,
    roughness: 0.85, metalness: 0, alphaTest: phong.alphaTest, side: phong.side,
  });
  phong.dispose();
});
// TextureLoader sets texture.image only once the image has loaded.
const loaded = (t) => t.image && (t.image.complete ?? true);
await new Promise((done) => {
  const check = () => (maps.every(loaded) ? done() : setTimeout(check, 10));
  check();
});
// A plain Group: cloning a Tree runs its constructor, which adds empty placeholder meshes.
const root = new THREE.Group();
root.add(...tree.children);
prepare(root);
scene.add(root);
`;
}

for (const [id, c] of Object.entries(CASES)) {
  const dir = new URL(`${id}/`, out);
  await mkdir(dir, { recursive: true });
  if ("preset" in c) {
    await writeFile(new URL(`${id}.glts`, dir), treeScript(id, c.preset, c.seed));
  } else if ("url" in c) {
    if (!(await exists(new URL(c.file, dir)))) await writeFile(new URL(c.file, dir), await curl(c.url));
    await writeFile(new URL(`${id}.glts`, dir), remoteScript(id, c.file));
  } else {
    const info = (await (await fetch(`https://api.polyhaven.com/files/${c.asset}`, { headers: { "User-Agent": "drawcall-impostor-lab" } })).json()) as {
      gltf: Record<string, { gltf: { url: string; include: Record<string, { url: string }> } }>;
    };
    const entry = info.gltf["1k"]!.gltf;
    const file = `${c.asset}.gltf`;
    if (!(await exists(new URL(file, dir)))) {
      await writeFile(new URL(file, dir), await curl(entry.url));
      for (const [path, { url }] of Object.entries(entry.include)) {
        const target = new URL(path, dir);
        await mkdir(dirname(target.pathname), { recursive: true });
        await writeFile(target, await curl(url));
      }
    }
    await writeFile(new URL(`${id}.glts`, dir), scanScript(id, file, c.keep));
  }
  console.log(`${id.padEnd(11)} ${c.why}`);
}
