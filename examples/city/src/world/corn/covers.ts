import * as THREE from "three/webgpu";
import { Fn, cameraPosition, distance, mix, modelWorldMatrix, positionLocal, smoothstep, uniform, vec3, vec4 } from "three/tsl";
import { InstancedLod } from "@drawcall/lod";
import { baked, diameter, instanced } from "../levels.ts";
import { BLOCK, type Plant, plantTurn, ROWS, type Tile, vigour } from "./field.ts";

/**
 * Mean height of the baked canopy: just under the tops of the leaves, so that where
 * plants stand over it their tops and tassels still rise above it.
 */
export const TOP = 1.95;
/** How far the canopy rises over each row and dips between rows: seen across the rows, the ridges hide the furrows. */
const RIDGE = 0.2;
/** How far a cover reaches into the soil: below the lowest ground of a sloping block. */
const SINK = 0.3;
/**
 * Share of the plants baked with their tassel. The bake looks straight down, where tassels
 * cover far more of the canopy than in any view across the field; with every plant
 * tasselled the cover is sprinkled with pale blobs where the plants hand over to it.
 */
const TASSELLED = 0.35;
/** The tint of the most vigorous patches of a field: a little yellower. */
const YELLOWER = new THREE.Color(1.05, 1, 0.85);

/** Distances (m) from the camera over which the covers rise out of the soil, shared by their shaders. */
export const skirt = () => uniform(new THREE.Vector2());
export type Skirt = ReturnType<typeof skirt>;

/** Baked levels over the tiles: a block's canopy (rising out of the soil near, ridged, flat far away) or a field's outer wall. */
export interface Cover {
  lod: InstancedLod;
  diameter: number;
}

/**
 * The baked covers: per design its canopy over the tiles of that design, and per axis
 * the walls of the fields' outer blocks. Canopies bake a design's plants; walls bake the
 * plants nearest the side, the outermost row or row ends. The plants are sown unevenly
 * (see `layout`), so even the bake's straight, parallel rays find leaves nearly everywhere.
 * `plants` are the variants with and without their tassel.
 */
export async function bakeCovers(
  designs: Plant[][],
  plants: { tasselled: THREE.Object3D[]; bare: THREE.Object3D[] },
  tiles: Tile[],
  skirt: Skirt,
): Promise<Cover[]> {
  const canopies = designs.map(async (design, d) => {
    const ridged = await bakeCover(plantGroup(plants, design), canopy(1));
    // near the camera it rises from the soil in front of the plants' fade: it needs vertices across
    const near = new THREE.Mesh(canopy(BLOCK * 2), rising(ridged.material, skirt));
    // far, the ridges are smaller than a pixel
    const flat = new THREE.Mesh(new THREE.PlaneGeometry(BLOCK, BLOCK).rotateX(-Math.PI / 2).translate(0, TOP, 0), ridged.material);
    const levels = [near, ridged, flat];
    for (const level of levels) {
      // the plants stand over it: their own shadows are not drawn either
      level.castShadow = false;
      level.receiveShadow = true;
    }
    const mine = tiles.filter((t) => t.design === d);
    const places = mine.map((t) => ({ matrix: t.matrix, at: t.centre }));
    return { lod: coverLod(`corn block ${d + 1}`, levels, places), diameter: diameter(ridged) };
  });
  const walls = (["x", "z"] as const).map(async (axis) => {
    const design = designs[0] ?? [];
    const outer = (p: Plant) => (axis === "x" ? p.x : p.z) > BLOCK / 2 - 1;
    const wall = await bakeCover(plantGroup(plants, design.filter(outer)), side(axis));
    wall.material = rising(wall.material, skirt);
    const turn = new THREE.Matrix4().makeRotationY(Math.PI);
    const places = tiles.flatMap((t) =>
      t.walls.filter((w) => w.axis === axis).map((w) => ({ matrix: w.turned ? t.matrix.clone().multiply(turn) : t.matrix, at: t.centre })),
    );
    return { lod: coverLod(`corn wall ${axis}`, [wall], places), diameter: diameter(wall) };
  });
  return Promise.all([...canopies, ...walls]);
}

/**
 * `plants` as InstancedLods of the variants with every instance at full detail: a source
 * to bake. A share of them (`TASSELLED`) carries its tassel.
 */
function plantGroup(variants: { tasselled: THREE.Object3D[]; bare: THREE.Object3D[] }, plants: Plant[]): THREE.Group {
  const group = new THREE.Group();
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const [tassel, models] of [[true, variants.tasselled] as const, [false, variants.bare] as const])
    models.forEach((model, v) => {
      const mine = plants.filter((p) => p.variant === v && hash(p) < TASSELLED === tassel);
      const lod = new InstancedLod([model], mine.length);
      mine.forEach((p, i) => lod.setMatrixAt(i, matrix.compose(new THREE.Vector3(p.x, 0, p.z), plantTurn(p, 0, turn), one)));
      group.add(lod);
    });
  return group;
}

/** A 0–1 number fixed for a plant's place. */
function hash(p: Plant): number {
  const s = Math.sin(p.x * 127.1 + p.z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** The canopy a block bakes onto: ridged over the rows, `across` quads along them. */
function canopy(across: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(BLOCK, BLOCK, across, ROWS * 4).rotateX(-Math.PI / 2);
  shape(g, (_, z) => ridge(z));
  return g;
}

/**
 * A field's outer wall on a block's +x side (across the rows' ends, its top following
 * the ridges) or +z side (along the outer row, as high as its ridge), from the soil up.
 */
function side(axis: "x" | "z"): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(BLOCK, 1, ROWS * 4, 1).translate(0, 0.5, BLOCK / 2);
  if (axis === "x") g.rotateY(Math.PI / 2);
  shape(g, (y, z) => (y > 0 ? (axis === "x" ? ridge(z) : TOP + RIDGE) : -SINK));
  return g;
}

/** Sets every vertex's height of `geometry` by `height(y, z)`, and its normals to match. */
function shape(geometry: THREE.BufferGeometry, height: (y: number, z: number) => number): void {
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) position.setY(i, height(position.getY(i), position.getZ(i)));
  geometry.computeVertexNormals();
}

/** The canopy's height across the rows (block frame z): highest over each row, lowest between. */
function ridge(z: number): number {
  const row = BLOCK / ROWS;
  return TOP + RIDGE * Math.cos(((2 * Math.PI) / row) * (z + BLOCK / 2 - row / 2));
}

/** `source` baked onto `low`. */
async function bakeCover(source: THREE.Object3D, low: THREE.BufferGeometry): Promise<THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>> {
  const { object } = await baked(source, new THREE.Mesh(low), 256);
  if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardNodeMaterial))
    throw new Error("a baked cover is one mesh with a standard material");
  const material = object.material;
  // the rows repeat every 0.75 m: filter them anisotropically, and keep their relief low,
  // or at a grazing view they shimmer into stripes and from above into a hatch across the rows
  for (const map of [material.map, material.normalMap]) if (map) map.anisotropy = 8;
  material.normalScale.set(0.6, 0.6);
  // a canopy of leaves is matte at this distance: the leaves' own sheen, baked flat, reads as a glint of sky
  material.roughnessMap = null;
  material.roughness = 0.9;
  const mesh = new THREE.Mesh(object.geometry, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/**
 * A copy of a cover's `material` that rises out of the soil with distance from the
 * camera: sunk below the ground nearer than `skirt.x`, whole from `skirt.y` on. Between
 * the plants hide it; the ramp it forms closes the canopy, so that past the plants no
 * view reaches under it.
 */
function rising(material: THREE.MeshStandardNodeMaterial, skirt: Skirt): THREE.MeshStandardNodeMaterial {
  const copy = material.clone();
  // after the instance matrix: the vertex in the cover's space, placed in the field
  copy.positionNode = Fn(() => {
    const world = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz;
    const up = smoothstep(skirt.x, skirt.y, distance(world, cameraPosition));
    return vec3(positionLocal.x, mix(-SINK, positionLocal.y, up), positionLocal.z);
  })();
  return copy;
}

/** `levels` of a baked cover over `places`, after an empty level 0 (the plants show there); thresholds are set by `Corn.update`. */
function coverLod(name: string, levels: THREE.Mesh[], places: { matrix: THREE.Matrix4; at: THREE.Vector3 }[]): InstancedLod {
  const lod = instanced(
    name,
    new THREE.Object3D(),
    levels.map((object) => ({ object })),
    places.length,
  );
  places.forEach(({ matrix, at }, i) => {
    lod.setMatrixAt(i, matrix);
    lod.setColorAt(i, tint(at));
  });
  // drawn before the plants, which then skip the pixels it hides
  lod.traverse((node) => (node.renderOrder = -1));
  return lod;
}

/**
 * A cover's tint at `at`: fields vary in vigour over tens of metres, a little lighter,
 * darker, yellower.
 */
function tint(at: THREE.Vector3): THREE.Color {
  return new THREE.Color(1, 1, 1).multiplyScalar(0.96 + 0.08 * vigour(at)).lerp(YELLOWER, 0.25 * vigour(at.clone().multiplyScalar(1.7)));
}
