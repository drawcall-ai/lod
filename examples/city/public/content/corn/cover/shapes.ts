import * as THREE from "three/webgpu";
import { BLOCK, ROWS, type Plant, plantTurn } from "../layout.ts";

/**
 * Mean height of the baked canopy: just under the tops of the leaves, so that where
 * plants stand over it their tops and tassels still rise above it.
 */
export const TOP = 1.95;
/** How far the canopy rises over each row and dips between rows: seen across the rows, the ridges hide the furrows. */
const RIDGE = 0.2;
/** How far a cover reaches into the soil: below the lowest ground of a sloping block. */
export const SINK = 0.3;
/**
 * Share of the plants baked with their tassel. The bake looks straight down, where tassels
 * cover far more of the canopy than in any view across the field; with every plant
 * tasselled the cover is sprinkled with pale blobs where the plants hand over to it.
 */
const TASSELLED = 0.35;

/**
 * `plants` as native instances of each variant at full detail: a source
 * to bake. A share of them (`TASSELLED`) carries its tassel.
 */
export function plantGroup(variants: { tasselled: THREE.Object3D[]; bare: THREE.Object3D[] }, plants: Plant[]): THREE.Group {
  const group = new THREE.Group();
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const [tassel, models] of [[true, variants.tasselled] as const, [false, variants.bare] as const])
    models.forEach((model, v) => {
      const mine = plants.filter((p) => p.variant === v && hash(p) < TASSELLED === tassel);
      model.updateMatrixWorld(true);
      model.traverse((mesh) => {
        if (!(mesh instanceof THREE.Mesh)) return;
        const instances = new THREE.InstancedMesh(mesh.geometry, mesh.material, mine.length);
        instances.castShadow = mesh.castShadow;
        instances.receiveShadow = mesh.receiveShadow;
        mine.forEach((p, i) => instances.setMatrixAt(i, matrix.compose(new THREE.Vector3(p.x, 0, p.z), plantTurn(p, 0, turn), one).multiply(mesh.matrixWorld)));
        group.add(instances);
      });
    });
  return group;
}

/** A 0–1 number fixed for a plant's place. */
function hash(p: Plant): number {
  const s = Math.sin(p.x * 127.1 + p.z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** The canopy a block bakes onto: ridged over the rows, `across` quads along them. */
export function canopy(across: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(BLOCK, BLOCK, across, ROWS * 4).rotateX(-Math.PI / 2);
  shape(g, (_, z) => ridge(z));
  return g;
}

/**
 * A field's outer wall on a block's +x side (across the rows' ends, its top following
 * the ridges) or +z side (along the outer row, as high as its ridge), from the soil up.
 */
export function side(axis: "x" | "z"): THREE.BufferGeometry {
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
