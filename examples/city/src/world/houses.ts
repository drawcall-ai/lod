import { type InstancedLod, Lod } from "@drawcall/lod";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { house, houseInterior } from "../content/house/index.ts";
import { church } from "../content/church.ts";
import { Random } from "../content/random.ts";
import { hedge } from "../content/hedge.ts";
import { greenhouse, letterbox, patioSet, shed, swing, washingLine } from "../content/garden.ts";
import { downloaded, step } from "../loading.ts";
import { baked, culled, impostor, instanced, place, thresholds } from "./levels.ts";
import type { Plan } from "./plan.ts";
import { HEDGE } from "./gardens.ts";

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

export async function houses(plan: Plan): Promise<(InstancedLod | Lod)[]> {
  const lods: (InstancedLod | Lod)[] = [];
  for (const [variant, params] of plan.variants.entries()) {
    const spots = plan.houses.filter((h) => h.variant === variant).map((h) => h.spot);
    if (spots.length === 0) continue;
    const lod = await step(`house ${variant + 1}`, async () => {
      const { detail, low } = house(params);
      const rooms = houseInterior(params);
      // baking reads the textures on the CPU
      await downloaded();
      const source = new THREE.Group().add(detail, rooms);
      const levels = [await baked(source, low, 512, BAKED_PIXELS, rooms), await impostor(source, { maxPixels: IMPOSTOR_PIXELS })];
      return instanced(`house ${variant + 1}`, drawn(detail, rooms), levels, spots.length);
    });
    const color = new THREE.Color();
    spots.forEach((at, i) => {
      place(lod, i, at);
      // weathering differs from house to house: a little darker or warmer
      const r = new Random(i * 31 + variant);
      lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.88, 1.04)).lerp(WARMER, r.range(0, 0.4)));
    });
    lods.push(lod);
  }
  lods.push(...gardenThings(plan), ...hedges(plan), await churchLod(plan));
  return lods;
}

const WARMER = new THREE.Color(1.05, 0.98, 0.88);

/** Garden things, each the model up close and nothing below a few pixels; sheds come in a few paints. */
function gardenThings(plan: Plan): InstancedLod[] {
  const models: Record<string, () => THREE.Object3D> = {
    shed: () => shed("#d9d4c8"),
    letterbox,
    greenhouse,
    swing,
    "washing line": washingLine,
    "patio set": patioSet,
  };
  const paints = ["#ffffff", "#9fb0a0", "#b9a58c", "#8c9aa8", "#c9b9a0"];
  return [...plan.garden].map(([name, spots]) => {
    const make = models[name];
    if (!make) throw new Error(`no garden model "${name}"`);
    const lod = instanced(name, make(), [culled(3)], spots.length);
    const r = new Random(name.length);
    const color = new THREE.Color();
    spots.forEach((at, i) => {
      place(lod, i, at);
      if (name === "shed") lod.setColorAt(i, color.set(r.pick(paints)));
    });
    return lod;
  });
}

/** Clipped garden hedges: a few sections of different lumps, a box further out, nothing below a few pixels. */
function hedges(plan: Plan): InstancedLod[] {
  const designs = [1, 2, 3].map((seed) => [hedge(HEDGE, seed), hedge(HEDGE, seed, "box")] as const);
  return designs.map(([source, box], d) => {
    const mine = plan.hedges.filter((_, i) => i % designs.length === d);
    // the lumps show only up close: a plain box from where the hedge is under ~120 px
    const lod = instanced(`hedges ${d + 1}`, source, [{ object: box, maxPixels: 120 }, culled(3)], mine.length);
    const r = new Random(d + 7);
    const color = new THREE.Color();
    mine.forEach((at, i) => {
      place(lod, i, at);
      lod.setColorAt(i, color.setRGB(1, 1, 1).multiplyScalar(r.range(0.85, 1.1)));
    });
    return lod;
  });
}

/**
 * The house as level 0 draws it: its exterior (shared geometry) and its rooms merged by
 * material. The bake needs the rooms one child each; drawn, a hundred room meshes per
 * house would be a hundred draws.
 */
function drawn(detail: THREE.Object3D, rooms: THREE.Object3D): THREE.Group {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  rooms.updateMatrixWorld(true);
  rooms.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return;
    byMaterial.set(o.material, [...(byMaterial.get(o.material) ?? []), o.geometry.clone().applyMatrix4(o.matrixWorld)]);
  });
  const group = new THREE.Group().add(detail.clone());
  for (const [material, parts] of byMaterial) {
    const merged = mergeGeometries(parts);
    if (!merged) throw new Error("room geometries do not merge");
    const mesh = new THREE.Mesh(merged, material);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** The church: one copy, so a plain Lod of the same levels as a house. */
async function churchLod(plan: Plan): Promise<Lod> {
  return step("church", async () => {
    const { detail, interior, low } = church();
    await downloaded();
    const source = new THREE.Group().add(detail, interior);
    const levels = [await baked(source, low, 1024, BAKED_PIXELS * 1.6, interior), await impostor(source, { maxPixels: IMPOSTOR_PIXELS * 1.6 })];
    const lod = thresholds(new Lod([source, ...levels.map((l) => l.object)]), levels);
    lod.name = "church";
    lod.position.set(plan.church.x, plan.church.y, plan.church.z);
    lod.rotation.y = plan.church.angle;
    return lod;
  });
}
