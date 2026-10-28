import {
  InstancedLod,
  type Impostor,
  Lod,
  ImpostorMesh,
  bakeImpostor,
  encodeImpostor,
  decodeImpostorAsync,
  bakeMesh,
  encodeBakedMesh,
  decodeBakedMesh,
} from "@drawcall/lod";
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { house, houseInterior } from "../content/house/index.ts";
import { batch, surfaces } from "../content/house/atlas/geometry.ts";
import { HouseAtlas } from "../content/house/atlas/material.ts";
import { church } from "../content/church.ts";
import { Random } from "../content/random.ts";
import { downloaded } from "../loading.ts";
import { instanced, place, thresholds, type Level } from "./levels.ts";
import type { Plan } from "./plan.ts";
import { bundle, file, proceduralFiles, parameterKey } from "./cache.ts";
import { Stream, needed } from "./stream.ts";
import { Patches } from "./patches.ts";

/**
 * Houses: one InstancedLod per variant, placed along the streets turned to face them.
 * Levels: the full model (window frames, gutters and tiles as geometry, furnished rooms
 * behind see-through windows); then the outside baked onto its own low shell, built from
 * the same parameters (a few dozen triangles that keep eaves and chimney), its windows
 * showing the rooms by interior mapping; then a hemispherical impostor for the far view.
 * Each variant is baked once however often it stands in town.
 *
 * Switch heights are set for the frame budget rather than the levels' error: a town has
 * a hundred houses within a few hundred metres, and the full model can stand only where
 * a house fills a good part of the view.
 */
const BAKED_PIXELS = 350;
const IMPOSTOR_PIXELS = 90;

interface Authored {
  detail: THREE.Group;
  rooms: THREE.Group;
  low: THREE.Mesh;
  source: THREE.Group;
}

export async function houses(plan: Plan, renderer: THREE.Renderer): Promise<Stream> {
  const variants = plan.variants.map((params, variant) => ({ params, variant, spots: plan.houses.filter((h) => h.variant === variant).map((h) => h.spot) }));
  const dependencies = proceduralFiles("src/world/houses.ts", await parameterKey(plan.variants.map((params) => ({ ...params }))), [
    "white_stucco",
    "wood_table_001",
    "metal_plate_02",
    "gravel_road",
    "red_brick",
    "whitewashed_brick",
  ]);
  let built: Promise<Authored[]> | undefined;
  const authored = () =>
    (built ??= (async () => {
      const rows: Authored[] = [];
      for (const { params } of variants) {
        const { detail, low } = house(params);
        const rooms = houseInterior(params);
        rows.push({ detail, rooms, low, source: new THREE.Group().add(detail, rooms) });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const { detail, low, interior: rooms } = church();
      rows.push({ detail, rooms, low, source: new THREE.Group().add(detail, rooms) });
      await downloaded();
      return rows;
    })());
  const farFiles = await bundle("houses-far@1", dependencies, async () => {
    const files: Record<string, Uint8Array> = {};
    for (const [i, { source }] of (await authored()).entries()) {
      const maxPixels = i === variants.length ? IMPOSTOR_PIXELS * 1.6 : IMPOSTOR_PIXELS;
      files[`${i}.ktx2`] = encodeImpostor(await bakeImpostor(source, { layout: "hemi", maxPixels }));
    }
    return files;
  });
  const atlases = await Promise.all(Array.from({ length: variants.length + 1 }, (_, i) => decodeImpostorAsync(file(farFiles, `${i}.ktx2`))));
  const atlasAt = (i: number): Impostor => {
    const data = atlases[i];
    if (!data) throw new Error(`Missing house atlas ${i}`);
    return data;
  };
  const card = (i: number) => {
    const mesh = new ImpostorMesh(atlasAt(i));
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  };
  const placed = (variant: number, source: THREE.Object3D, levels: Level[]) => {
    const row = variants[variant];
    if (!row) throw new Error(`Missing house variant ${variant}`);
    const lod = instanced(`house ${variant + 1}`, source, levels, row.spots.length);
    const color = new THREE.Color();
    row.spots.forEach((at, i) => {
      place(lod, i, at);
      const r = new Random(i * 31 + variant);
      lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.88, 1.04)).lerp(WARMER, r.range(0, 0.4)));
    });
    return lod;
  };
  const churchAt = (source: THREE.Object3D, levels: Level[]) => {
    const lod = thresholds(new Lod([source, ...levels.map((level) => level.object)]), levels);
    lod.name = "church";
    lod.position.set(plan.church.x, plan.church.y, plan.church.z);
    lod.rotation.y = plan.church.angle;
    lod.updateMatrixWorld(true);
    return lod;
  };
  const far = [...variants.map(({ variant }) => placed(variant, card(variant), [])), churchAt(card(variants.length), [])];
  const spheres: Array<{ centre: THREE.Vector3; radius: number; pixels: number }> = [];
  for (const { variant, spots } of variants) {
    const local = new THREE.Box3().setFromArray(atlasAt(variant).box).getBoundingSphere(new THREE.Sphere());
    for (const spot of spots) {
      const centre = local.center
        .clone()
        .multiplyScalar(spot.scale)
        .applyAxisAngle(UP, spot.angle)
        .add(new THREE.Vector3(spot.x, spot.y, spot.z));
      spheres.push({ centre, radius: local.radius * spot.scale, pixels: IMPOSTOR_PIXELS * (1 - Lod.fade) });
    }
  }
  const churchSphere = new THREE.Box3().setFromArray(atlasAt(variants.length).box).getBoundingSphere(new THREE.Sphere());
  churchSphere.center.applyAxisAngle(UP, plan.church.angle).add(new THREE.Vector3(plan.church.x, plan.church.y, plan.church.z));
  spheres.push({ centre: churchSphere.center, radius: churchSphere.radius, pixels: IMPOSTOR_PIXELS * 1.6 * (1 - Lod.fade) });
  return new Stream(
    "houses",
    far,
    async () => {
      const files = await bundle("houses-baked@1", dependencies, async () => {
        const encoded: Record<string, Uint8Array> = {};
        for (const [i, row] of (await authored()).entries())
          encoded[`${i}.bin`] = encodeBakedMesh(
            await bakeMesh(row.source, { low: row.low, textureSize: i === variants.length ? 1024 : 512, interior: row.rooms }),
          );
        return encoded;
      });
      const rows = await authored();
      const sources = rows.map(({ detail, rooms }) => drawn(detail, rooms));
      const atlas = new HouseAtlas(
        renderer,
        variants.flatMap(({ params, variant }) => {
          const source = sources[variant];
          if (!source) throw new Error(`Missing authored house ${variant}`);
          return surfaces(source, params);
        }),
      );
      const levels = (i: number): Level[] => {
        const baked = decodeBakedMesh(file(files, `${i}.bin`));
        baked.castShadow = baked.receiveShadow = true;
        const factor = i === variants.length ? 1.6 : 1;
        return [
          { object: baked, maxPixels: BAKED_PIXELS * factor },
          { object: card(i), maxPixels: IMPOSTOR_PIXELS * factor },
        ];
      };
      const lods: (InstancedLod | Lod)[] = variants.map(({ params, variant }) => {
        const source = sources[variant];
        if (!source) throw new Error(`Missing authored house ${variant}`);
        return placed(variant, batch(source, params, atlas), levels(variant));
      });
      const churchSource = sources[variants.length];
      if (!churchSource) throw new Error("Missing authored church");
      lods.push(churchAt(churchSource, levels(variants.length)));
      // Live levels retain their shared geometry/materials; consumed rooms and low shells can leave memory.
      built = undefined;
      return lods;
    },
    (camera) => spheres.some(({ centre, radius, pixels }) => needed(camera, centre, radius, pixels, Patches.height * Lod.quality)),
    undefined,
    (old) => {
      for (const object of old) {
        if (!(object instanceof InstancedLod || object instanceof Lod)) throw new Error("Unexpected house far root");
        object.dispose();
      }
    },
  );
}

const UP = new THREE.Vector3(0, 1, 0);

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

/**
 * The house as level 0 draws it: its exterior (shared geometry) and its rooms merged by
 * material. The bake needs the rooms one child each; drawn, a hundred room meshes per
 * house would be a hundred draws. Consumes the rooms' geometry after both bakes:
 * their shared materials and textures stay alive in the merged meshes.
 */
function drawn(detail: THREE.Object3D, rooms: THREE.Object3D): THREE.Group {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const consumed = new Set<THREE.BufferGeometry>();
  rooms.updateMatrixWorld(true);
  rooms.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    byMaterial.set(o.material, [...(byMaterial.get(o.material) ?? []), o.geometry.clone().applyMatrix4(o.matrixWorld)]);
    consumed.add(o.geometry);
  });
  const group = new THREE.Group().add(detail.clone());
  for (const [material, parts] of byMaterial) {
    const merged = mergeGeometries(parts);
    if (!merged) throw new Error("room geometries do not merge");
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  for (const geometry of consumed) geometry.dispose();
  return group;
}
