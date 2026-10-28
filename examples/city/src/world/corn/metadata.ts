import * as THREE from "three/webgpu";
import type { InstancedLod, Lod } from "@drawcall/lod";

export interface CornMetadata {
  plantSize: number;
  boxes: number[][];
  hero: number[];
  ladybird: number[];
  spheres: { x: number; y: number; z: number; radius: number }[];
}

/** Rest-pose geometry measurements, cached alongside the covers to skip source generation. */
export function metadata(plants: InstancedLod[], hero: Lod, ladybird: Lod): CornMetadata {
  const boxes = plants.map((lod) => {
    const source = lod.levels[0];
    if (!source) throw new Error("Corn plant has no source");
    return new THREE.Box3().setFromObject(source.object);
  });
  const spheres = [hero, ladybird].map((lod) => {
    const source = lod.levels[0];
    if (!source) throw new Error("Corn hero has no source");
    lod.updateWorldMatrix(true, true);
    const sphere = new THREE.Box3().setFromObject(source.object).getBoundingSphere(new THREE.Sphere());
    return { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z, radius: sphere.radius };
  });
  const bug = ladybird.levels[0];
  if (!bug) throw new Error("Ladybird has no source");
  return {
    plantSize: Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())),
    boxes: boxes.map((box) => [...box.min.toArray(), ...box.max.toArray()]),
    hero: hero.position.toArray(),
    ladybird: bug.object.getWorldPosition(new THREE.Vector3()).toArray(),
    spheres,
  };
}

export function readMetadata(bytes: Uint8Array): CornMetadata {
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof data !== "object" ||
    data === null ||
    !("plantSize" in data) ||
    !("boxes" in data) ||
    !("hero" in data) ||
    !("ladybird" in data) ||
    !("spheres" in data)
  )
    throw new Error("Invalid cached corn metadata");
  const vector = (value: unknown, length: number): number[] => {
    if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === "number" && Number.isFinite(item)))
      throw new Error("Invalid cached corn vector");
    return value.map((item) => Number(item));
  };
  if (
    typeof data.plantSize !== "number" ||
    !Number.isFinite(data.plantSize) ||
    data.plantSize <= 0 ||
    !Array.isArray(data.boxes) ||
    !Array.isArray(data.spheres) ||
    data.spheres.length !== 2
  )
    throw new Error("Invalid cached corn bounds");
  const spheres = data.spheres.map((sphere: unknown) => {
    if (typeof sphere !== "object" || sphere === null || !("x" in sphere) || !("y" in sphere) || !("z" in sphere) || !("radius" in sphere))
      throw new Error("Invalid cached corn sphere");
    const values = vector([sphere.x, sphere.y, sphere.z, sphere.radius], 4);
    const [x, y, z, radius] = values;
    if (x === undefined || y === undefined || z === undefined || radius === undefined || radius < 0) throw new Error("Invalid cached corn sphere");
    return { x, y, z, radius };
  });
  return { plantSize: data.plantSize, boxes: data.boxes.map((box) => vector(box, 6)), hero: vector(data.hero, 3), ladybird: vector(data.ladybird, 3), spheres };
}
