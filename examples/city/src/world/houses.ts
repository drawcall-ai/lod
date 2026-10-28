import { InstancedLod, Lod, LodLoader, ImpostorMesh, bakeImpostor, bakeMesh } from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Dependencies } from "vitecache";
import { house, houseInterior, type HouseParams } from "../content/house/index.ts";
import { batch, surfaces } from "../content/house/atlas/geometry.ts";
import { furnishingMaterial } from "../content/house/furnishings.ts";
import { brass, glass } from "../content/house/materials.ts";
import { HouseAtlas } from "../content/house/atlas/material.ts";
import { church } from "../content/church.ts";
import { Random } from "../content/random.ts";
import { texturesReady, restoreSurface } from "../content/materials.ts";
import { register } from "../render/sun/casters.ts";
import { place } from "./place.ts";
import type { Plan } from "./plan.ts";
import { proceduralFiles, parameterKey } from "./cache.ts";
import { houseAtlas } from "./house-atlas.ts";
import { record } from "./data.ts";

const BAKED_PIXELS = 350;
const IMPOSTOR_PIXELS = 90;
const WARMER = new THREE.Color(1.05, 0.98, 0.88);

interface Authored {
  detail: THREE.Group;
  rooms: THREE.Group;
  low: THREE.Mesh;
  params: HouseParams;
}

/** Per-variant coarse entries are eager; baked windows and atlas geometry arrive independently. */
export async function houses(plan: Plan): Promise<THREE.Group> {
  const root = new THREE.Group();
  root.name = "houses";
  const textures = ["white_stucco", "wood_table_001", "metal_plate_02", "gravel_road", "red_brick", "whitewashed_brick"];
  for (const [variant, params] of plan.variants.entries()) {
    const dependencies = proceduralFiles("src/world/houses.ts", await parameterKey({ ...params }), textures);
    const levels = await loadHouse(dependencies, () => ({ ...house(params), rooms: houseInterior(params), params }));
    const spots = plan.houses.filter((house) => house.variant === variant).map((house) => house.spot);
    const lod = new InstancedLod(levels, spots.length);
    lod.name = `house ${variant + 1}`;
    const color = new THREE.Color();
    spots.forEach((at, index) => {
      place(lod, index, at);
      const random = new Random(index * 31 + variant);
      lod.setColorAt(index, color.setRGB(1, 1, 1).multiplyScalar(random.range(0.88, 1.04)).lerp(WARMER, random.range(0, 0.4)));
    });
    root.add(lod);
  }
  const building = await loadHouse(
    proceduralFiles("src/world/houses.ts", { church: true }, textures),
    () => {
      const { detail, low, interior: rooms, params } = church();
      return { detail, low, rooms, params };
    },
    1.6,
  );
  building.name = "church";
  building.position.set(plan.church.x, plan.church.y, plan.church.z);
  building.rotation.y = plan.church.angle;
  root.add(building);
  return root;
}

async function loadHouse(dependencies: Dependencies, make: () => Authored, factor = 1): Promise<Lod> {
  let built: Promise<{ source: THREE.Group; baked: THREE.Mesh; coarse: ImpostorMesh }> | undefined;
  const build = () =>
    (built ??= (async () => {
      const { detail, rooms, low, params } = make();
      const original = new THREE.Group().add(detail, rooms);
      await texturesReady(original);
      const coarse = new ImpostorMesh(
        await bakeImpostor(original, { layout: "hemi", maxPixels: IMPOSTOR_PIXELS * factor, resolution: factor === 1 ? 64 : 128, frames: 8 }),
      );
      const baked = await bakeMesh(original, { low, interior: rooms, textureSize: factor === 1 ? 512 : 1024 });
      const displayed = drawn(detail, rooms);
      const rows = factor === 1 ? surfaces(displayed, params) : [];
      const atlas = rows.length ? await houseAtlas(rows, true) : undefined;
      if (atlas) {
        for (const side of ["outside", "inside"] as const)
          atlas[side].userData.houseAtlas = { side, rows: rows.map(({ name, userData }) => ({ name, data: userData })) };
      }
      const source = atlas ? batch(displayed, params, atlas) : displayed;
      return { source, baked, coarse };
    })());
  const atlases = new Map<string, Promise<HouseAtlas>>();
  const material = async (name: string, data: Record<string, unknown>): Promise<THREE.Material | undefined> => {
    if (data.houseAtlas === undefined)
      return name === "glass" ? glass() : name === "brass" ? brass() : (furnishingMaterial(name) ?? restoreSurface(name, data));
    const { side, rows } = record(data.houseAtlas);
    if ((side !== "outside" && side !== "inside") || !Array.isArray(rows)) throw new Error("Invalid house atlas rows");
    const key = JSON.stringify(rows);
    let atlas = atlases.get(key);
    if (!atlas) {
      atlas = houseAtlas(
        rows.map((row: unknown) => {
          const { name, data } = record(row);
          if (typeof name !== "string") throw new Error("Invalid house surface name");
          const surface = name === "brass" ? brass() : restoreSurface(name, record(data), "metadata");
          if (!surface) throw new Error(`Unknown house surface ${name}`);
          return surface;
        }),
      );
      atlases.set(key, atlas);
    }
    return (await atlas)[side];
  };
  return new LodLoader().loadAsync({
    source: async () => (await build()).source,
    key: { ...dependencies, atlas: { path: "src/world/house-atlas.ts" } },
    material,
    levels: [
      { type: "baked", source: async () => (await build()).baked, maxPixels: BAKED_PIXELS * factor },
      { type: "impostor", source: async () => (await build()).coarse, maxPixels: IMPOSTOR_PIXELS * factor },
    ],
    restore: async (object, index) => {
      if (index === 0)
        object.traverse((node) => {
          if (!(node instanceof THREE.Mesh) || !node.geometry.hasAttribute("cityShadowPart")) return;
          if (!(node.material instanceof THREE.MeshStandardNodeMaterial)) throw new Error("Invalid house atlas material");
          const diameters: unknown = node.geometry.userData.cityShadowDiameters;
          if (!Array.isArray(diameters) || !diameters.every((value): value is number => typeof value === "number"))
            throw new Error("Invalid house shadow parts");
          node.material = register(node.geometry, node.material, diameters);
        });
      else object.castShadow = object.receiveShadow = true;
      await texturesReady(object);
    },
  });
}

/** Rooms retain individual boxes for baking; their displayed geometry is merged once on a cache miss. */
function drawn(detail: THREE.Object3D, rooms: THREE.Object3D): THREE.Group {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  rooms.updateMatrixWorld(true);
  rooms.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const parts = byMaterial.get(object.material) ?? [];
    if (!byMaterial.has(object.material)) byMaterial.set(object.material, parts);
    parts.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
  });
  const group = new THREE.Group().add(detail.clone());
  for (const [material, parts] of byMaterial) {
    const merged = mergeGeometries(parts);
    if (!merged) throw new Error("Room geometries do not merge");
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    group.add(mesh);
    for (const part of parts) part.dispose();
  }
  return group;
}
