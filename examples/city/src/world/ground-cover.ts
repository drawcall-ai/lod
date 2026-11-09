import * as THREE from "three/webgpu";
import { cameraPosition, distance, float, positionWorld, vec4 } from "three/tsl";
import { ImpostorMesh, InstancedLod, Lod, type LodLevel, type Wind } from "@drawcall/lod";
import { sourceBox } from "./bounds.ts";
import { plantInstance, stands } from "./ground-records.ts";
import { GROUND_COVER, grassLadder, groundPlantLadder, type GroundKind, type Habitat } from "../../public/content/ladders.ts";
import { loader } from "../loading.ts";
import { foliageLevels, foliageModel, MODEL_FOLIAGE } from "../../public/content/foliage.ts";
import type { Library } from "../../public/content/materials.ts";
import type { Zones } from "./zones.ts";
import { groundShading, type Ground } from "../render/ground/shading.ts";
import { Use } from "./land.ts";
import { reachFor } from "./patches.ts";
import { type Plan, TOWN } from "./plan.ts";

/** Edge of a ground-cover tile (m). */
const TILE = 6;

/** Ground cover, streamed on the GPU around `camera`: `Stream.update` it before each frame. */
export async function groundCover(library: Library, plan: Plan, zones: Zones, camera: THREE.Camera, renderer: THREE.WebGPURenderer, wind?: Wind): Promise<THREE.Group> {
  // Grass samples ground in the vertex stage, where pixel derivatives are unavailable.
  const ground = groundShading(library, zones, float(0));
  const root = new THREE.Group();
  root.name = "ground cover";
  const reference = new THREE.PerspectiveCamera(50);
  const stand = stands(plan, renderer);
  const loaded = await Promise.all(
    GROUND_COVER.map(async (kind) => {
      const models = await ("grass" in kind ? grassModels(kind, ground) : plantModels(kind));
      const boxes = models.map(sourceBox);
      const size = Math.max(...boxes.map((box) => box.getSize(new THREE.Vector3()).length())) * kind.scale[1];
      const cull = reachFor(reference, size, kind.reach, 800, 1);
      // on a view 1080 pixels tall, where the levels end
      const radius = reachFor(reference, size, cull, 1080, Lod.quality);
      return stand({ name: kind.name, tile: TILE, density: kind.density, radius, grows: where(plan, kind.ground) }, (records) =>
        models.map((model, variant) => {
          const lod = new InstancedLod(model, {
            gpuRecords: records(plantInstance(variant / models.length, (variant + 1) / models.length, kind.scale), kind.scale, 1 / models.length),
          });
          const middle = lod.levels[1];
          const empty = lod.levels.at(-1);
          const box = boxes[variant];
          if (!middle || !empty || !box) throw new Error(`${kind.name}: incomplete ground cover levels`);
          // The cull size follows from the loaded bounds, so the requested empty threshold is a stand-in.
          if ("grass" in kind) middle.maxPixels = cull * 4;
          empty.maxPixels = cull;

          lod.name = `${kind.name} ${variant}`;
          lod.range = { camera, radius, ramp: radius * 0.4 };
          wind?.apply(lod, { amplitude: (box.max.y - box.min.y) * 0.07 });
          return lod;
        }),
      );
    }),
  );
  root.add(...loaded);
  return root;
}

async function plantModels(kind: GroundKind & { id: string; variants: string[] }): Promise<LodLevel[][]> {
  return Promise.all(
    kind.variants.map(async (variant) => {
      const levels = await loader.loadAsync({
        ...groundPlantLadder(kind.id, variant),
        onLevel: (object) => {
          foliageModel(object, MODEL_FOLIAGE);
          foliageLevels(object, MODEL_FOLIAGE);
          object.traverse((node) => {
            node.castShadow = false;
            node.receiveShadow = true;
          });
        },
      });
      return levels;
    }),
  );
}

async function grassModels(kind: GroundKind & { grass: true; variants: number }, ground: Ground): Promise<LodLevel[][]> {
  const base = ground(positionWorld.xz, distance(cameraPosition.xz, positionWorld.xz));
  const carried = base.toVarying("vGrassGround");
  return Promise.all(
    Array.from({ length: kind.variants }, async (_, variant) => {
      const levels = await loader.loadAsync({
        ...grassLadder(kind.name, variant),
        onLevel: (object) => {
          foliageLevels(object, { translucency: 0.5 });
          object.traverse((node) => {
            if (!(node instanceof THREE.Mesh)) return;
            const material = node.material;
            if (!(material instanceof THREE.MeshStandardNodeMaterial) || !material.colorNode) throw new Error("Grass levels need their authored colour node");
            // Both representations contain the same neutral blade shading; ground colour is applied after baking.
            const original = material.colorNode;
            // An impostor already uses all the varyings WebGPU allows; it covers few pixels, so it reads the ground per pixel.
            material.colorNode = new THREE.ConvertNode<"vec4">(original, "vec4").mul(vec4(node instanceof ImpostorMesh ? base : carried, 1));
            node.castShadow = false;
            node.receiveShadow = true;
          });
        },
      });
      return levels;
    }),
  );
}

/** Which ground a kind grows on, as a test on x, z. */
function where(plan: Plan, ground: Habitat): (x: number, z: number) => boolean {
  const inTown = (x: number, z: number) => Math.hypot(x - TOWN.x, z - TOWN.z) < TOWN.radius + 40;
  if (ground === "forest") return (x, z) => plan.land.at(x, z) === Use.Forest;
  if (ground === "garden") return (x, z) => plan.land.at(x, z) === Use.Lawn && inTown(x, z);
  return (x, z) => plan.land.at(x, z) === Use.Lawn && !inTown(x, z);
}
