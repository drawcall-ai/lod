import * as THREE from "three/webgpu";
import { Fn, cameraPosition, distance, mix, modelWorldMatrix, positionLocal, smoothstep, uniform, vec3, vec4 } from "three/tsl";
import { boundingBox, InstancedLod } from "@drawcall/lod";
import { type Tile, vigour } from "./field.ts";
import { BLOCK } from "../../../public/content/corn/layout.ts";
import { canopy, SINK, TOP } from "../../../public/content/corn/cover/shapes.ts";

const YELLOWER = new THREE.Color(1.05, 1, 0.85);

/** Distances (m) from the camera over which the covers rise out of the soil, shared by their shaders. */
export const skirt = () => uniform(new THREE.Vector2());
export type Skirt = ReturnType<typeof skirt>;

/**
 * Baked levels over the tiles, after an empty level 0. A block's canopy rises out of the
 * soil near, then is ridged, then flat far away; a field's outer wall only rises.
 */
export interface Cover {
  kind: "canopy" | "wall";
  lod: InstancedLod;
  diameter: number;
}

/** The raw bakeMesh results the covers are built from, freshly baked or decoded. */
export interface CoverBakes {
  /** Indexed by block design. */
  canopies: THREE.Mesh[];
  walls: Record<Axis, THREE.Mesh>;
}

type Axis = "x" | "z";

/** Every block design's canopy, then the walls along x and z. */
export function covers({ canopies, walls }: CoverBakes, tiles: Tile[], skirt: Skirt): Cover[] {
  return [
    ...canopies.map((bake, design) => canopyCover(bake, design, tiles, skirt)),
    wallCover(walls.x, "x", tiles, skirt),
    wallCover(walls.z, "z", tiles, skirt),
  ];
}

function canopyCover(bake: THREE.Mesh, design: number, tiles: Tile[], skirt: Skirt): Cover {
  const material = coverMaterial(bake);
  const ridged = new THREE.Mesh(bake.geometry, material);
  // Near the camera it rises in front of the plants' fade; far away the ridges are subpixel.
  const near = new THREE.Mesh(canopy(BLOCK * 2), rising(material, skirt));
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(BLOCK, BLOCK).rotateX(-Math.PI / 2).translate(0, TOP, 0), material);
  const levels = [near, ridged, flat];
  for (const level of levels) {
    level.castShadow = false;
    level.receiveShadow = true;
  }
  const places = tiles.filter((tile) => tile.design === design).map((tile) => ({ matrix: tile.matrix, at: tile.centre }));
  return { kind: "canopy", lod: coverLod(`corn block ${design}`, levels, places), diameter: boundingBox(ridged).getSize(new THREE.Vector3()).length() };
}

function wallCover(bake: THREE.Mesh, axis: Axis, tiles: Tile[], skirt: Skirt): Cover {
  const wall = new THREE.Mesh(bake.geometry, rising(coverMaterial(bake), skirt));
  wall.castShadow = wall.receiveShadow = true;
  const turn = new THREE.Matrix4().makeRotationY(Math.PI);
  const places = tiles.flatMap((tile) =>
    tile.walls
      .filter((side) => side.axis === axis)
      .map((side) => ({ matrix: side.turned ? tile.matrix.clone().multiply(turn) : tile.matrix, at: tile.centre })),
  );
  return { kind: "wall", lod: coverLod(`corn wall ${axis}`, [wall], places), diameter: boundingBox(wall).getSize(new THREE.Vector3()).length() };
}

function coverMaterial(bake: THREE.Mesh): THREE.MeshStandardNodeMaterial {
  if (!(bake.material instanceof THREE.MeshStandardNodeMaterial)) throw new Error("A baked corn cover needs a standard material");
  const material = bake.material;
  // Reapply these display choices after reading raw baked data from the cache.
  for (const map of [material.map, material.normalMap]) if (map) map.anisotropy = 8;
  material.normalScale.set(0.6, 0.6);
  material.roughnessMap = null;
  material.roughness = 0.9;
  return material;
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
  const lod = new InstancedLod(
    [new THREE.Object3D(), ...levels].map((object) => ({ object })),
    places.length,
  );
  lod.name = name;
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
